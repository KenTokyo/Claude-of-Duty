#!/usr/bin/env node
/**
 * GPU time per render phase, measured with EXT_disjoint_timer_query_webgl2.
 *
 * The whole-frame timer in src/render/adaptive.js is disabled for the run
 * (nested TIME_ELAPSED queries are illegal) and one query is opened around each
 * top-level phase call instead. Results are averaged over N frames of scripted
 * gameplay, which is the only way to see whether a frame is shadow-bound,
 * raster-bound or post-bound rather than guessing from totals.
 *
 *   node tools/gpu-pass-profile.mjs --query=q=ultra --frames=240
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 240);
const QUERY = String(args.query ?? 'q=ultra');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

await page.evaluate(() => {
  const e = window.__ENGINE__;
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  e.ctx.peek('ai')?.debugStage?.('firefight');
});

const out = await page.evaluate((FRAMES) => new Promise((done) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const gl = r.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return done({ error: 'no timer extension' });

  // The whole-frame timer would enclose ours; TIME_ELAPSED cannot nest.
  if (r.gpuTimer) { r.gpuTimer.begin = () => false; r.gpuTimer.end = () => {}; r.gpuTimer.poll = () => 0; }

  const totals = {};   // phase -> accumulated ms
  const counts = {};   // phase -> resolved query count
  const inflight = []; // {q, phase}
  let open = false;

  const drain = () => {
    for (let i = inflight.length - 1; i >= 0; i--) {
      const s = inflight[i];
      if (!gl.getQueryParameter(s.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(s.q, gl.QUERY_RESULT);
      gl.deleteQuery(s.q);
      inflight.splice(i, 1);
      if (!Number.isFinite(ns)) continue;
      totals[s.phase] = (totals[s.phase] ?? 0) + ns / 1e6;
      counts[s.phase] = (counts[s.phase] ?? 0) + 1;
    }
  };

  // Wrap one method so its GPU work is enclosed by a TIME_ELAPSED query.
  const timePhase = (obj, name, phase) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function timed(...a) {
      if (open || inflight.length > 64) return orig.apply(this, a);
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      open = true;
      try { return orig.apply(this, a); }
      finally { gl.endQuery(ext.TIME_ELAPSED_EXT); open = false; inflight.push({ q, phase }); }
    };
  };

  timePhase(r.csm, 'render', 'csm');
  timePhase(r.gbuffer, 'render', 'prepass');
  if (r.gtao) timePhase(r.gtao, 'render', 'gtao');
  if (r.contact) timePhase(r.contact, 'render', 'contact');
  if (r.ssr) timePhase(r.ssr, 'render', 'ssr');
  if (r.taa) timePhase(r.taa, 'render', 'taa');
  if (r.motionBlur) timePhase(r.motionBlur, 'render', 'motionBlur');
  if (r.dof) timePhase(r.dof, 'render', 'dof');
  if (r.bloom) timePhase(r.bloom, 'render', 'bloom');
  timePhase(r.exposure, 'update', 'exposure');
  timePhase(r.composite, 'render', 'composite');
  timePhase(r.viewComposite, 'render', 'viewComposite');

  // The two renderer.render() calls (forward world, viewmodel) share one method;
  // distinguish them by which scene is passed.
  const rawRender = r.renderer.render.bind(r.renderer);
  r.renderer.render = (scene, cam) => {
    const phase = scene === e.viewScene ? 'viewmodel' : (r.csm.__inCsm ? 'csm-inner' : 'forward');
    if (open || inflight.length > 64) return rawRender(scene, cam);
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    open = true;
    try { return rawRender(scene, cam); }
    finally { gl.endQuery(ext.TIME_ELAPSED_EXT); open = false; inflight.push({ q, phase }); }
  };

  const frameSamples = [];
  let i = 0, last = performance.now(), measured = 0;
  const tick = () => {
    const now = performance.now();
    frameSamples.push(now - last); last = now;
    drain();
    e.camera.rotation.y += 0.006;
    try { e.input.down.add('KeyW'); } catch {}
    if (i % 90 < 30) e.input.down.add('Mouse0'); else e.input.down.delete('Mouse0');
    if (i > 60) measured++;
    if (++i >= FRAMES) {
      // let the tail of the queries land
      let spins = 0;
      const settle = () => {
        drain();
        if (inflight.length && ++spins < 240) return requestAnimationFrame(settle);
        done({
          measuredFrames: measured,
          totals, counts,
          calls: r.renderer.info.render.calls,
          tris: r.renderer.info.render.triangles,
          casterCounts: Array.from(r.csm.casterCounts ?? []),
          cascades: r.csm.cascades,
          mapSize: r.csm.mapSize,
          maxDistance: r.csm.maxDistance,
          internal: [r.screenSize.width, r.screenSize.height],
          frameSamples,
        });
      };
      return requestAnimationFrame(settle);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), FRAMES);

if (out.error) {
  console.log(JSON.stringify({ error: out.error, errs }, null, 2));
} else {
  const rows = Object.entries(out.totals)
    .map(([k, v]) => ({ phase: k, msPerFrame: +(v / Math.max(1, out.counts[k] / (out.counts[k] / Math.max(1, out.counts[k])))).toFixed(2), queries: out.counts[k], msPerQuery: +(v / out.counts[k]).toFixed(2), totalMs: +v.toFixed(1) }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const nFrames = Math.max(...Object.values(out.counts).map((c) => c));
  for (const r of rows) r.msPerFrame = +(r.totalMs / nFrames).toFixed(2);
  const dts = out.frameSamples.slice(60).sort((a, b) => a - b);
  console.log(JSON.stringify({
    cascades: out.cascades, mapSize: out.mapSize, shadowDistance: out.maxDistance,
    internal: out.internal, calls: out.calls, tris: out.tris,
    casterCountsPerCascade: out.casterCounts,
    frameMs: { p50: +dts[dts.length >> 1].toFixed(1), p90: +dts[Math.floor(dts.length * 0.9)].toFixed(1) },
    gpuFramesTimed: nFrames,
    phases: rows,
    gpuMsPerFrameTotal: +rows.reduce((s, r) => s + r.msPerFrame, 0).toFixed(2),
    errs: errs.slice(0, 5),
  }, null, 2));
}

await browser.close();

#!/usr/bin/env node
/**
 * Ablation harness — the only trustworthy way to attribute frame cost here.
 *
 * EXT_disjoint_timer_query on ANGLE/Metal over-reports wildly once queries are
 * nested or issued back-to-back (measured: per-pass queries summing to 1170 ms
 * on an 88 ms frame). So instead of timing passes, this boots ONE page and
 * measures whole-frame pacing with a feature switched off, then switches it
 * back on. Every row is a real A/B against the same process, same world, same
 * camera path.
 *
 *   node tools/ablate.mjs --query=q=ultra --frames=90
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 90);
const QUERY = String(args.query ?? 'q=ultra');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}&adaptive=0`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

const out = await page.evaluate(async ({ FRAMES }) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const ai = e.ctx.peek('ai');
  const world = e.ctx.peek('world');
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  ai?.debugStage?.('firefight');

  // Freeze gameplay so every ablation sees the same scene; the renderer and the
  // rAF loop keep running at full rate.
  e.time.scale = 0;

  const measure = (n) => new Promise((done) => {
    const ts = []; let last = performance.now(), i = 0;
    const tick = () => {
      const now = performance.now(); ts.push(now - last); last = now;
      if (++i >= n) { ts.sort((a, b) => a - b); return done(ts); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const warm = (n) => new Promise((done) => {
    let i = 0; const tick = () => (++i >= n ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  const run = async (label) => {
    await warm(20);
    const ts = await measure(FRAMES);
    return {
      label,
      p50: +ts[ts.length >> 1].toFixed(2),
      p90: +ts[Math.floor(ts.length * 0.9)].toFixed(2),
      fps: +(1000 / ts[ts.length >> 1]).toFixed(1),
      calls: r.renderer.info.render.calls,
      tris: r.renderer.info.render.triangles,
    };
  };

  const rows = [];
  rows.push(await run('baseline'));

  const ablations = [
    ['no-shadows(csm)', () => { const v = r.csm.enabled; r.csm.enabled = false; return () => { r.csm.enabled = v; }; }],
    ['csm-1-cascade', () => { const v = r.csm.cascades; r.csm.cascades = 1; return () => { r.csm.cascades = v; }; }],
    ['csm-dist-70m', () => { const v = r.csm.maxDistance; r.csm.maxDistance = 70; return () => { r.csm.maxDistance = v; }; }],
    ['no-gtao', () => { const v = r.gtao; r.gtao = null; return () => { r.gtao = v; }; }],
    ['no-ssr', () => { const v = r.ssr; r.ssr = null; return () => { r.ssr = v; }; }],
    ['no-contact', () => { const v = r.contact; r.contact = null; return () => { r.contact = v; }; }],
    ['no-taa', () => { const v = r.taa; r.taa = null; return () => { r.taa = v; }; }],
    ['no-motionblur', () => { const v = r.motionBlur; r.motionBlur = null; return () => { r.motionBlur = v; }; }],
    ['no-bloom', () => { const v = r.bloom; r.bloom = null; return () => { r.bloom = v; }; }],
    ['no-prepass', () => { const v = r.needsPrepass; r.needsPrepass = false; return () => { r.needsPrepass = v; }; }],
    ['no-viewmodel', () => { const v = e.viewScene.visible; e.viewScene.visible = false;
      const kids = e.viewScene.children.filter((c) => !c.isLight && !c.isObject3D === false);
      const saved = kids.map((c) => [c, c.visible]); for (const [c] of saved) c.visible = false;
      return () => { e.viewScene.visible = v; for (const [c, s] of saved) c.visible = s; }; }],
    ['no-world', () => { const v = world?.root?.visible; if (world?.root) world.root.visible = false; return () => { if (world?.root) world.root.visible = v; }; }],
    ['no-ai-actors', () => { const v = ai?.root?.visible; if (ai?.root) ai.root.visible = false; return () => { if (ai?.root) ai.root.visible = v; }; }],
    ['no-sky', () => { const s = e.ctx.peek('sky'); const v = s?.root?.visible; if (s?.root) s.root.visible = false; return () => { if (s?.root) s.root.visible = v; }; }],
    ['no-post-at-all', () => {
      const saved = { gtao: r.gtao, ssr: r.ssr, contact: r.contact, taa: r.taa, motionBlur: r.motionBlur, bloom: r.bloom, dof: r.dof };
      r.gtao = r.ssr = r.contact = r.taa = r.motionBlur = r.bloom = r.dof = null;
      return () => Object.assign(r, saved); }],
    ['scale-0.7', () => { const v = r.renderScale; r.renderScale = 0.7; r.resize(r._cssWidth, r._cssHeight, e.ctx, true);
      return () => { r.renderScale = v; r.resize(r._cssWidth, r._cssHeight, e.ctx, true); }; }],
    ['scale-0.5', () => { const v = r.renderScale; r.renderScale = 0.5; r.resize(r._cssWidth, r._cssHeight, e.ctx, true);
      return () => { r.renderScale = v; r.resize(r._cssWidth, r._cssHeight, e.ctx, true); }; }],
  ];

  for (const [label, apply] of ablations) {
    let restore = null;
    try { restore = apply(); rows.push(await run(label)); }
    catch (err) { rows.push({ label, error: String(err && err.message || err) }); }
    finally { try { restore?.(); } catch {} }
    await warm(10);
  }

  rows.push(await run('baseline-again'));

  return {
    quality: e.config.quality,
    internal: [r.screenSize.width, r.screenSize.height],
    megapixels: +((r.screenSize.width * r.screenSize.height) / 1e6).toFixed(2),
    csm: { cascades: r.csm.cascades, mapSize: r.csm.mapSize, maxDistance: r.csm.maxDistance,
           casterCounts: Array.from(r.csm.casterCounts ?? []) },
    world: { ...(world?.stats ?? {}) },
    agents: ai?.agents?.length ?? 0,
    rows,
  };
}, { FRAMES });

const base = out.rows.find((r) => r.label === 'baseline');
for (const r of out.rows) {
  if (r.p50 && base) { r.savedMs = +(base.p50 - r.p50).toFixed(2); r.savedPct = +(((base.p50 - r.p50) / base.p50) * 100).toFixed(1); }
}
out.rows.sort((a, b) => (b.savedMs ?? -1) - (a.savedMs ?? -1));
console.log(JSON.stringify({ ...out, errs: errs.slice(0, 5) }, null, 2));
await browser.close();

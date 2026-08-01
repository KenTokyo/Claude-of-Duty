#!/usr/bin/env node
/**
 * Subsystem-resolution profiler: wraps every registered system's
 * fixedUpdate/update/lateUpdate plus the render sub-phases, runs a scripted
 * gameplay sequence, and reports where the frame actually goes.
 */
import { chromium } from 'playwright';
import { launchBrowser } from "./launch.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 420);
const QUERY = String(args.query ?? 'q=ultra');

const browser = await launchBrowser(chromium, args, ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync']);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
const logs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (logs.length < 400) logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
page.on('crash', () => errs.push('PAGE CRASHED'));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) logs.push('NAVIGATED ' + f.url()); });

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });
const bootMs = Date.now() - t0;

const info = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const gl = r.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    quality: e.config.quality,
    pixelRatio: r.renderer.getPixelRatio(),
    internal: [r.screenSize.width, r.screenSize.height],
    display: [r.displaySize.width, r.displaySize.height],
    megapixels: +((r.screenSize.width * r.screenSize.height) / 1e6).toFixed(2),
    renderScale: r.renderScale,
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
    systems: e.registry.ordered.map((s) => s.constructor.id),
    programs: r.renderer.info.programs?.length ?? 0,
    world: { ...(e.ctx.peek('world')?.stats ?? {}) },
  };
});

// Instrument every subsystem hook + the render() call.
await page.evaluate(() => {
  const e = window.__ENGINE__;
  const acc = (window.__PROF__ = { hooks: {}, frames: 0 });
  const wrap = (sys, name) => {
    const id = sys.constructor.id + '.' + name;
    const orig = sys[name];
    if (typeof orig !== 'function') return;
    acc.hooks[id] = 0;
    sys[name] = function profiled(...a) {
      const s = performance.now();
      try { return orig.apply(this, a); }
      finally { acc.hooks[id] += performance.now() - s; }
    };
  };
  for (const sys of e.registry.ordered) {
    for (const n of ['fixedUpdate', 'update', 'lateUpdate', 'render']) wrap(sys, n);
  }
  const r = e.ctx.peek('render');
  // Render sub-phases: patch the internal helpers we care about.
  const sub = ['_collect', '_cullLights', '_updateBounceFill', '_updateViewRig', '_collectViewScene'];
  for (const n of sub) {
    const orig = r[n];
    if (typeof orig !== 'function') continue;
    const id = 'render' + n;
    acc.hooks[id] = 0;
    r[n] = function profiled(...a) {
      const s = performance.now();
      try { return orig.apply(this, a); }
      finally { acc.hooks[id] += performance.now() - s; }
    };
  }
  const csmR = r.csm.render.bind(r.csm);
  acc.hooks['csm.render'] = 0;
  r.csm.render = (...a) => { const s = performance.now(); try { return csmR(...a); } finally { acc.hooks['csm.render'] += performance.now() - s; } };
  const gbR = r.gbuffer.render.bind(r.gbuffer);
  acc.hooks['gbuffer.render'] = 0;
  r.gbuffer.render = (...a) => { const s = performance.now(); try { return gbR(...a); } finally { acc.hooks['gbuffer.render'] += performance.now() - s; } };
});

await page.evaluate(() => {
  const e = window.__ENGINE__;
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  e.ctx.peek('ai')?.debugStage?.('firefight');
});

const result = await page.evaluate((FRAMES) => new Promise((done) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const P = window.__PROF__;
  const samples = [];
  let last = performance.now(), i = 0;
  const tick = () => {
    const now = performance.now();
    const dt = now - last; last = now;
    e.camera.rotation.y += 0.006;
    try { e.input.down.add('KeyW'); } catch {}
    if (i % 90 < 30) e.input.down.add('Mouse0'); else e.input.down.delete('Mouse0');
    samples.push({
      i, dt,
      gpuMs: r.performance.gpuMs,
      scale: r.performance.scale,
      progs: r.renderer.info.programs?.length ?? 0,
      calls: r.renderer.info.render.calls,
      tris: r.renderer.info.render.triangles,
      geos: r.renderer.info.memory.geometries,
      texs: r.renderer.info.memory.textures,
      heap: performance.memory ? performance.memory.usedJSHeapSize >> 20 : 0,
    });
    P.frames++;
    if (++i >= FRAMES) return done({ samples, hooks: P.hooks, frames: P.frames });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), FRAMES);

const WARM = Number(args.warmup ?? 60);
const warm = result.samples.slice(WARM);
const dts = warm.map((s) => s.dt).sort((a, b) => a - b);
const q = (p) => +dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(2);
const med = q(0.5);
const gpus = warm.map((s) => s.gpuMs).filter((v) => v > 0).sort((a, b) => a - b);
const gq = (p) => gpus.length ? +gpus[Math.min(gpus.length - 1, Math.floor(gpus.length * p))].toFixed(2) : 0;

const hooks = Object.entries(result.hooks)
  .map(([k, v]) => [k, +(v / result.frames).toFixed(3)])
  .filter(([, v]) => v > 0.01)
  .sort((a, b) => b[1] - a[1]);

const first = warm[0], lastS = warm.at(-1);
console.log(JSON.stringify({
  bootMs, info,
  frames: warm.length,
  frameTimeMs: { p1: q(0.01), p50: med, p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) },
  fps: { p50: +(1000 / med).toFixed(0), p95: +(1000 / q(0.95)).toFixed(0), p99: +(1000 / q(0.99)).toFixed(0) },
  gpuMs: { p50: gq(0.5), p90: gq(0.9), p99: gq(0.99), samples: gpus.length },
  msPerFrameByHook: Object.fromEntries(hooks),
  cpuHookTotal: +hooks.reduce((s, [, v]) => s + v, 0).toFixed(2),
  scale: { start: first.scale, end: lastS.scale },
  drawCalls: { min: Math.min(...warm.map((s) => s.calls)), p50: warm.map(s=>s.calls).sort((a,b)=>a-b)[warm.length>>1], max: Math.max(...warm.map((s) => s.calls)) },
  triangles: { p50: warm.map(s=>s.tris).sort((a,b)=>a-b)[warm.length>>1], max: Math.max(...warm.map((s) => s.tris)) },
  programs: { start: first.progs, end: lastS.progs },
  resources: { geos: [first.geos, lastS.geos], texs: [first.texs, lastS.texs] },
  heapMb: { start: first.heap, end: lastS.heap, growth: lastS.heap - first.heap },
  errors: errs.slice(0, 10),
  logs: logs.filter((l) => /NAVIGATED|error|warn|WARN/i.test(l)).slice(0, 25),
}, null, 2));

await browser.close();

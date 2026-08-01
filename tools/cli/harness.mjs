/**
 * Boots the REAL engine -- same Engine, same systems, same config, same world
 * generation -- inside Node, against the recording GL mock. No browser.
 *
 * Frames are pumped by hand through engine.step(t) with synthetic timestamps,
 * so the simulation is deterministic and two runs are directly comparable. The
 * wall-clock cost of each step is still measured for real, because that is
 * genuine JS work: culling, physics, AI, animation, scene-graph traversal and
 * every per-frame allocation.
 */
import { performance } from 'node:perf_hooks';

const FIXED_STEP_MS = 1000 / 60;

/** Systems in the same registration order main.js uses. */
async function loadSystems() {
  const [
    { Engine }, { createConfig },
    { RenderSystem }, { MaterialSystem }, { SkySystem }, { WorldSystem },
    { PhysicsSystem }, { PlayerSystem }, { WeaponSystem }, { FxSystem },
    { AiSystem }, { UiSystem }, { AudioSystem },
  ] = await Promise.all([
    import('../../src/core/engine.js'), import('../../src/core/config.js'),
    import('../../src/render/index.js'), import('../../src/materials/index.js'),
    import('../../src/sky/index.js'), import('../../src/world/index.js'),
    import('../../src/physics/index.js'), import('../../src/player/index.js'),
    import('../../src/weapons/index.js'), import('../../src/fx/index.js'),
    import('../../src/ai/index.js'), import('../../src/ui/index.js'),
    import('../../src/audio/index.js'),
  ]);
  return { Engine, createConfig, systems: [RenderSystem, MaterialSystem, SkySystem, WorldSystem, PhysicsSystem, PlayerSystem, WeaponSystem, FxSystem, AiSystem, UiSystem, AudioSystem] };
}

/**
 * @param quality  'low' | 'medium' | 'high' | 'ultra'
 * @param width/height/dpr  logical size; the render target ends up w*dpr x h*dpr
 * @param qset  ablation overrides merged into cfg.q, e.g. { prepassDepthReuse: false }.
 *              Re-applied after any setQuality() call so the adaptive scaler cannot
 *              silently restore the preset value mid-run and invalidate an A/B.
 */
export async function boot({ quality = 'ultra', width = 1512, height = 982, dpr = 2, deterministic = true, onProgress = null, qset = null } = {}) {
  const { installDom } = await import('./dom-shim.mjs');
  const { createGLMock } = await import('./gl-mock.mjs');

  const dom = installDom({ width, height, dpr });
  const { gl, rec } = createGLMock({ width: width * dpr, height: height * dpr });
  dom.canvas._gl = gl;
  dom.canvas.width = width * dpr;
  dom.canvas.height = height * dpr;

  const { Engine, createConfig, systems } = await loadSystems();
  const config = createConfig({ quality, deterministic });

  if (qset && Object.keys(qset).length) {
    for (const k of Object.keys(qset)) {
      if (!(k in config.q)) throw new Error(`qset: "${k}" is not a quality key -- typo would silently measure nothing`);
    }
    Object.assign(config.q, qset);
    const setQuality = config.setQuality;
    config.setQuality = (name) => { setQuality(name); Object.assign(config.q, qset); };
  }

  const engine = new Engine({ canvas: dom.canvas, config });
  for (const S of systems) engine.add(S);

  const t0 = performance.now();
  await engine.init({ yieldBetween: false, onProgress });
  const bootMs = performance.now() - t0;

  // The engine sizes itself off the canvas/window; make sure it has done so.
  engine.resize?.(width, height);

  return { engine, config, gl, rec, dom, bootMs };
}

/**
 * Pump `frames` frames and return per-frame CPU timings plus GL stream stats.
 *
 * `warm` frames run first and are discarded: the first frames after boot pay
 * for lazy material compiles, pool growth and first-touch allocation, which are
 * real costs but not steady-state ones.
 */
export function run(engine, rec, { frames = 300, warm = 60, stepMs = FIXED_STEP_MS, onFrame = null } = {}) {
  const dom = globalThis.__COD_DOM__;
  const cpuMs = [];
  const drawCalls = [];
  const triangles = [];
  const programSwitches = [];

  let now = 1000;
  const total = frames + warm;

  for (let i = 0; i < total; i++) {
    rec.beginFrame();
    now += stepMs;

    const a = performance.now();
    engine.step(now);
    // Anything the engine scheduled for "next frame" runs here, inside the
    // frame it belongs to, so its cost is attributed rather than lost.
    dom.pumpRaf(now);
    const ms = performance.now() - a;

    if (i >= warm) {
      cpuMs.push(ms);
      drawCalls.push(rec.drawCalls);
      triangles.push(rec.triangles);
      programSwitches.push(rec.programSwitches);
      onFrame?.(i - warm, rec, ms);
    }
  }

  return { cpuMs, drawCalls, triangles, programSwitches };
}

export function stats(a) {
  if (!a?.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q1 = s[Math.floor((s.length - 1) * 0.25)];
  const q3 = s[Math.floor((s.length - 1) * 0.75)];
  const mean = s.reduce((p, c) => p + c, 0) / s.length;
  return {
    n: s.length,
    mean: +mean.toFixed(3),
    median: +s[s.length >> 1].toFixed(3),
    p05: +s[Math.floor(s.length * 0.05)].toFixed(3),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    iqr: +(q3 - q1).toFixed(3),
  };
}

export { FIXED_STEP_MS };

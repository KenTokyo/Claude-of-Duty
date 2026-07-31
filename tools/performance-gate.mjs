#!/usr/bin/env node
/**
 * Real-time Edge A/B gate for adaptive resolution and batching.
 *
 * Unlike the pixel gates this deliberately does not use capture/lockstep mode:
 * the engine free-runs, EXT_disjoint_timer_query_webgl2 measures whole GPU
 * frames, and the adaptive-resolution controller is active. Math.random is
 * seeded before application code loads so every mode builds the same world.
 *
 *   node tools/performance-gate.mjs
 *   node tools/performance-gate.mjs --modes=off,default --runs=3 --frames=72
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [arg, true];
}));

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(args.port ?? 5173);
const WIDTH = Number(args.w ?? 1280);
const HEIGHT = Number(args.h ?? 720);
const QUALITY = String(args.quality ?? 'high');
const TARGET_FPS = Number(args.fps ?? 60);
const RUNS = Math.max(1, Number(args.runs ?? 3));
const FRAMES = Math.max(24, Number(args.frames ?? 72));
const SETTLE = Math.max(1, Number(args.settle ?? 12));
const WARMUP = Math.max(24, Number(args.warmup ?? 120));
const CULL_FRAMES = Math.max(0, Number(args.cullFrames ?? 24));
const TIMEOUT = Number(args.timeout ?? 240000);
const SEED = Number(args.seed ?? 0x5eed1234) >>> 0;
const OUT = resolve(args.out ?? 'performance-gate.json');
const SHOTS = String(args.shots ?? 'hero,interior,detail,ads,combat')
  .split(',').map((value) => value.trim()).filter(Boolean);

const MODE_QUERY = {
  off: 'staticBatch=0&viewBatch=0',
  default: '',
  static: 'staticBatch=1&viewBatch=0',
  view: 'staticBatch=0&viewBatch=1',
  both: 'staticBatch=1&viewBatch=1',
};
const modes = String(args.modes ?? 'off,default')
  .split(',').map((value) => value.trim()).filter(Boolean);
for (const mode of modes) {
  if (!(mode in MODE_QUERY)) throw new Error(`unknown mode "${mode}"`);
}

const portOpen = (port) => new Promise((done) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => {
    socket.destroy();
    done(true);
  });
  socket.on('error', () => done(false));
  socket.setTimeout(400, () => {
    socket.destroy();
    done(false);
  });
});

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const server = spawn(
    resolve(ROOT, 'node_modules/.bin/vite'),
    ['--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' } }
  );
  for (let i = 0; i < 160; i++) {
    await new Promise((done) => setTimeout(done, 250));
    if (await portOpen(PORT)) return server;
  }
  server.kill();
  throw new Error('vite failed to start');
}

function findExecutable() {
  const requested = args.executable || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (requested) return resolve(String(requested));
  if (process.platform !== 'win32') return null;
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return candidates.find(existsSync) ?? null;
}

function percentile(values, amount) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))];
}

const fixed = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : value;

function numericSummary(values, digits = 3) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { count: 0, min: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };
  return {
    count: finite.length,
    min: fixed(Math.min(...finite), digits),
    p50: fixed(percentile(finite, 0.5), digits),
    p90: fixed(percentile(finite, 0.9), digits),
    p99: fixed(percentile(finite, 0.99), digits),
    max: fixed(Math.max(...finite), digits),
    mean: fixed(finite.reduce((sum, value) => sum + value, 0) / finite.length, digits),
  };
}

function summarizeSamples(samples) {
  const gpuBySequence = new Map();
  for (const sample of samples) {
    if (sample.gpuSequence > 0 && sample.gpuMs > 0) {
      gpuBySequence.set(sample.gpuSequence, sample.gpuMs);
    }
  }
  const first = samples[0];
  const last = samples.at(-1);
  return {
    frames: samples.length,
    frameMs: numericSummary(samples.map((sample) => sample.frameMs)),
    cpuRenderMs: numericSummary(samples.map((sample) => sample.cpuRenderMs)),
    gpuMs: numericSummary([...gpuBySequence.values()]),
    scale: {
      start: fixed(first?.scale ?? 0),
      end: fixed(last?.scale ?? 0),
      min: fixed(Math.min(...samples.map((sample) => sample.scale))),
      max: fixed(Math.max(...samples.map((sample) => sample.scale))),
    },
    controller: {
      p50: fixed(last?.adaptiveP50 ?? 0),
      p90: fixed(last?.adaptiveP90 ?? 0),
      changesStart: first?.changes ?? 0,
      changesEnd: last?.changes ?? 0,
      changes: (last?.changes ?? 0) - (first?.changes ?? 0),
    },
    calls: numericSummary(samples.map((sample) => sample.calls), 0),
    triangles: numericSummary(samples.map((sample) => sample.triangles), 0),
    internalSize: last?.internalSize ?? null,
  };
}

function summarizeRun(run) {
  const samples = run.shots.flatMap((shot) => shot.samples);
  return {
    run: run.run,
    aggregate: summarizeSamples(samples),
    shots: run.shots.map((shot) => ({
      shot: shot.shot,
      ...summarizeSamples(shot.samples),
    })),
  };
}

function summarizeMode(raw) {
  const runs = raw.runs.map(summarizeRun);
  const all = raw.runs.flatMap((run) => run.shots.flatMap((shot) => shot.samples));
  return {
    errors: raw.errors,
    bootMs: raw.bootMs,
    browser: raw.browser,
    adaptive: raw.adaptive,
    world: raw.world,
    batches: raw.batches,
    resources: raw.resources,
    culling: raw.culling,
    aggregate: summarizeSamples(all),
    runs,
  };
}

function ratio(candidate, reference) {
  return reference > 0 ? fixed(candidate / reference, 4) : 0;
}

function compareModes(reference, candidate) {
  const rows = [];
  for (let runIndex = 0; runIndex < Math.min(reference.runs.length, candidate.runs.length); runIndex++) {
    const aRun = reference.runs[runIndex];
    const bRun = candidate.runs[runIndex];
    for (let shotIndex = 0; shotIndex < Math.min(aRun.shots.length, bRun.shots.length); shotIndex++) {
      const a = aRun.shots[shotIndex];
      const b = bRun.shots[shotIndex];
      rows.push({
        run: runIndex + 1,
        shot: a.shot,
        gpuP50Ratio: ratio(b.gpuMs.p50, a.gpuMs.p50),
        cpuP50Ratio: ratio(b.cpuRenderMs.p50, a.cpuRenderMs.p50),
        frameP50Ratio: ratio(b.frameMs.p50, a.frameMs.p50),
        callsSaved: a.calls.p50 - b.calls.p50,
        trianglesSaved: a.triangles.p50 - b.triangles.p50,
        scale: `${a.scale.end}->${b.scale.end}`,
      });
    }
  }
  return {
    gpuP50Ratio: ratio(candidate.aggregate.gpuMs.p50, reference.aggregate.gpuMs.p50),
    cpuP50Ratio: ratio(candidate.aggregate.cpuRenderMs.p50, reference.aggregate.cpuRenderMs.p50),
    frameP50Ratio: ratio(candidate.aggregate.frameMs.p50, reference.aggregate.frameMs.p50),
    callsSavedP50: reference.aggregate.calls.p50 - candidate.aggregate.calls.p50,
    trianglesSavedP50: reference.aggregate.triangles.p50 - candidate.aggregate.triangles.p50,
    rows,
  };
}

const server = await ensureServer();
const executablePath = findExecutable();
const launch = {
  headless: true,
  args: [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
  ],
};
if (executablePath) launch.executablePath = executablePath;

let browser;
const report = {
  ok: true,
  realTime: true,
  captureMode: false,
  adaptiveRequested: true,
  seed: SEED,
  quality: QUALITY,
  targetFps: TARGET_FPS,
  viewport: `${WIDTH}x${HEIGHT}`,
  shots: SHOTS,
  warmupFramesPerShot: WARMUP,
  settleFramesPerShot: SETTLE,
  measuredFramesPerShot: FRAMES,
  runs: RUNS,
  modes: {},
  comparisons: {},
};

try {
  browser = await chromium.launch(launch);

  for (const mode of modes) {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    // Engine uses Math.random once to seed its deterministic Rng tree. Override
    // it before any module executes so non-capture pages remain A/B-identical
    // while adaptive resolution stays enabled.
    await context.addInitScript(({ seed }) => {
      let state = seed >>> 0;
      Math.random = () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }, { seed: SEED });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) {
        errors.push(`[error] ${message.text()}`);
      }
    });

    const query = new URLSearchParams({
      q: QUALITY,
      prewarm: '0',
      fps: String(TARGET_FPS),
    });
    const modeQuery = MODE_QUERY[mode];
    if (modeQuery) {
      for (const [key, value] of new URLSearchParams(modeQuery)) query.set(key, value);
    }

    const bootStart = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/?${query}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
    const bootMs = Date.now() - bootStart;

    const raw = await page.evaluate(async ({ shots, runs, frames, settle, warmup, cullFrames }) => {
      const engine = window.__ENGINE__;
      const render = engine.ctx.peek('render');
      const gl = render.renderer.getContext();
      const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');

      // Keep simulation state identical across A/B modes. The real rAF loop,
      // renderer and GPU timer continue to run; only gameplay time is frozen.
      engine.time.scale = 0;

      const originalRender = render.render;
      render.__perfCpuMs = 0;
      render.render = function measuredRender(ctx) {
        const start = performance.now();
        try {
          return originalRender.call(this, ctx);
        } finally {
          this.__perfCpuMs = performance.now() - start;
        }
      };

      const snapshot = () => ({
        geometries: render.renderer.info.memory.geometries,
        textures: render.renderer.info.memory.textures,
        programs: render.renderer.info.programs?.length ?? 0,
        heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
        sceneObjects: (() => { let count = 0; engine.scene.traverse(() => count++); return count; })(),
        viewObjects: (() => { let count = 0; engine.viewScene.traverse(() => count++); return count; })(),
      });

      const waitFrames = (count) => new Promise((done) => {
        let index = 0;
        const tick = () => {
          if (++index >= count) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      const sampleFrames = (count) => new Promise((done) => {
        const samples = [];
        let index = 0;
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          samples.push({
            frameMs: now - last,
            cpuRenderMs: render.__perfCpuMs,
            gpuMs: render.performance.gpuMs,
            gpuSequence: render.gpuTimer?.sequence ?? 0,
            scale: render.performance.scale,
            adaptiveP50: render.performance.p50,
            adaptiveP90: render.performance.p90,
            changes: render.performance.changes,
            calls: render.renderer.info.render.calls,
            triangles: render.renderer.info.render.triangles,
            internalSize: [render.screenSize.width, render.screenSize.height],
          });
          last = now;
          if (++index >= count) done(samples);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      // `combat` stages six debug agents and their effects. Reapplying that
      // shot used to append another tableau on every run, making the resource
      // gate report a render leak that was actually harness-created content.
      // Stage it once, then restore the exact post-stage camera/time and cheap
      // debug state without calling AI.debugStage() again.
      let combatPose = null;
      const applyShot = (name) => {
        if (name !== 'combat' || combatPose === null) {
          window.__APPLY_SHOT__(name);
          if (name === 'combat') {
            combatPose = {
              position: engine.camera.position.toArray(),
              quaternion: engine.camera.quaternion.toArray(),
              fov: engine.camera.fov,
              time: engine.ctx.peek('sky')?.timeOfDay,
            };
          }
          return;
        }

        engine.input.frozen = true;
        engine.input.enabled = false;
        const player = engine.ctx.peek('player');
        player?.setControlEnabled?.(false);
        engine.camera.position.fromArray(combatPose.position);
        engine.camera.quaternion.fromArray(combatPose.quaternion);
        engine.camera.fov = combatPose.fov;
        engine.camera.updateProjectionMatrix();
        player?.teleport?.(engine.camera.position, engine.camera.rotation);
        engine.ctx.peek('weapons')?.debugPose?.('idle');
        engine.ctx.peek('fx')?.debugBurst?.('none');
        engine.ctx.peek('ui')?.debugState?.('clean');
        if (combatPose.time !== undefined) {
          engine.ctx.peek('sky')?.setTimeOfDay?.(combatPose.time);
        }
      };

      const initialResources = snapshot();
      // Stage combat before the regular camera warmup so the already-created
      // agents and their materials are exercised from every measured view.
      // The later combat entries use the allocation-free restore path above.
      if (shots.includes('combat')) {
        applyShot('combat');
        await waitFrames(warmup);
      }
      for (const shot of shots) {
        applyShot(shot);
        await waitFrames(warmup);
      }
      const warmResources = snapshot();

      const measuredRuns = [];
      for (let run = 1; run <= runs; run++) {
        const shotRows = [];
        for (const shot of shots) {
          applyShot(shot);
          await waitFrames(settle);
          shotRows.push({ shot, samples: await sampleFrames(frames) });
        }
        measuredRuns.push({ run, shots: shotRows });
      }
      const measuredResources = snapshot();

      // Diagnostic only, after primary timings: count the actual per-pass
      // BatchedMesh range tests and visible multi-draw ranges. Timing wrappers
      // are intentionally not present during the A/B measurements above.
      const spatial = [];
      engine.scene.traverse((object) => {
        if (object.isBatchedMesh && object.userData.owSpatialChunks) spatial.push(object);
      });
      const cullRows = [];
      if (cullFrames > 0 && spatial.length > 0) {
        const counter = { calls: 0, candidates: 0, visible: 0, ms: 0 };
        for (const mesh of spatial) {
          const original = mesh.onBeforeRender;
          mesh.onBeforeRender = function measuredCull(...callArgs) {
            const start = performance.now();
            const result = original.apply(this, callArgs);
            counter.ms += performance.now() - start;
            counter.calls++;
            counter.candidates += this._instanceInfo.length;
            counter.visible += this._multiDrawCount;
            return result;
          };
        }
        for (const shot of shots) {
          applyShot(shot);
          await waitFrames(settle);
          counter.calls = 0;
          counter.candidates = 0;
          counter.visible = 0;
          counter.ms = 0;
          await waitFrames(cullFrames);
          cullRows.push({
            shot,
            frames: cullFrames,
            calls: counter.calls,
            candidates: counter.candidates,
            visible: counter.visible,
            ms: counter.ms,
          });
        }
      }

      return {
        browser: {
          userAgent: navigator.userAgent,
          gpu: debugRenderer
            ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
          multiDraw: !!gl.getExtension('WEBGL_multi_draw'),
        },
        adaptive: { ...render.performance },
        world: { ...engine.ctx.peek('world')?.stats },
        batches: { ...engine.ctx.peek('weapons')?.batchStats },
        resources: {
          initial: initialResources,
          afterWarmup: warmResources,
          afterMeasured: measuredResources,
          growthDuringMeasured: {
            geometries: measuredResources.geometries - warmResources.geometries,
            textures: measuredResources.textures - warmResources.textures,
            programs: measuredResources.programs - warmResources.programs,
            heapMb: measuredResources.heapMb - warmResources.heapMb,
            sceneObjects: measuredResources.sceneObjects - warmResources.sceneObjects,
            viewObjects: measuredResources.viewObjects - warmResources.viewObjects,
          },
        },
        runs: measuredRuns,
        culling: {
          batches: spatial.length,
          ranges: spatial.reduce((sum, mesh) => sum + mesh.userData.owSpatialChunks, 0),
          rows: cullRows.map((row) => ({
            shot: row.shot,
            frames: row.frames,
            callsPerFrame: row.calls / row.frames,
            candidatesPerFrame: row.candidates / row.frames,
            visiblePerFrame: row.visible / row.frames,
            visiblePct: row.candidates > 0 ? (row.visible / row.candidates) * 100 : 0,
            measuredMsPerFrame: row.ms / row.frames,
          })),
        },
      };
    }, {
      shots: SHOTS,
      runs: RUNS,
      frames: FRAMES,
      settle: SETTLE,
      warmup: WARMUP,
      cullFrames: CULL_FRAMES,
    });

    report.modes[mode] = summarizeMode({ ...raw, errors, bootMs });
    await context.close();
  }

  if (report.modes.off) {
    for (const mode of modes) {
      if (mode !== 'off') {
        report.comparisons[`off:${mode}`] = compareModes(report.modes.off, report.modes[mode]);
      }
    }
  }

  const worlds = Object.values(report.modes).map((mode) => mode.world);
  const sameWorld = worlds.every((world) =>
    world?.staticTris === worlds[0]?.staticTris &&
    world?.instTris === worlds[0]?.instTris &&
    world?.instances === worlds[0]?.instances &&
    world?.collideTris === worlds[0]?.collideTris
  );
  report.sameSeededWorld = sameWorld;
  report.ok = sameWorld && Object.values(report.modes).every((mode) => {
    const growth = mode.resources.growthDuringMeasured;
    return mode.errors.length === 0 &&
      mode.adaptive.adaptive === true &&
      mode.adaptive.timer === 'gpu' &&
      growth.geometries <= 1 &&
      growth.textures <= 1 &&
      growth.programs === 0 &&
      growth.sceneObjects <= 1 &&
      growth.viewObjects <= 1;
  });
} catch (error) {
  report.ok = false;
  report.error = error.stack ?? error.message;
} finally {
  await browser?.close();
  if (server) server.kill();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

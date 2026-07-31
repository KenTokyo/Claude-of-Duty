#!/usr/bin/env node
/**
 * Deterministic gameplay/pixel gate for rigid viewmodel batches.
 *
 * Unlike the static pose set in batch-gate.mjs, this scrubs every moving
 * viewmodel assembly through trigger, bolt/slide, tactical and empty reload,
 * inspect and all three weapon roots. Captures come directly from the WebGL
 * canvas in the same task as the final lockstep render.
 *
 *   node tools/viewmodel-gate.mjs
 *   node tools/viewmodel-gate.mjs --modes=off,safe,cavity,control
 *   node tools/viewmodel-gate.mjs --states=rifle-idle,rifle-empty-action
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [arg, true];
}));

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(args.port ?? 5173);
const WIDTH = Number(args.w ?? 960);
const HEIGHT = Number(args.h ?? 540);
const TIMEOUT = Number(args.timeout ?? 240000);
const OUT = resolve(args.out ?? 'shots/viewmodel-gate');

const MODE_QUERY = {
  off: 'staticBatch=0&viewBatch=0',
  safe: 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=safe',
  identity: 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=identity',
  cavity: 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=cavity',
  rubber: 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=rubber',
  brass: 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=brass',
  default: '',
  control: 'staticBatch=0&viewBatch=0',
};
const modes = String(args.modes ?? 'off,safe,cavity,rubber,brass,control')
  .split(',').map((value) => value.trim()).filter(Boolean);
for (const mode of modes) {
  if (!(mode in MODE_QUERY)) throw new Error(`unknown mode "${mode}"`);
}

const STATES = [
  { name: 'rifle-idle', weapon: 'rifle', kind: 'idle' },
  { name: 'rifle-ads', weapon: 'rifle', kind: 'ads' },
  { name: 'rifle-trigger', weapon: 'rifle', kind: 'trigger' },
  { name: 'rifle-bolt-cycle', weapon: 'rifle', kind: 'cycle' },
  { name: 'rifle-bolt-hold', weapon: 'rifle', kind: 'hold' },
  { name: 'rifle-tac-out', weapon: 'rifle', kind: 'reloadTac', at: 0.25 },
  { name: 'rifle-tac-hidden', weapon: 'rifle', kind: 'reloadTac', at: 0.5 },
  { name: 'rifle-tac-in', weapon: 'rifle', kind: 'reloadTac', at: 0.75 },
  { name: 'rifle-empty-out', weapon: 'rifle', kind: 'reloadEmpty', at: 0.22 },
  { name: 'rifle-empty-hidden', weapon: 'rifle', kind: 'reloadEmpty', at: 0.45 },
  { name: 'rifle-empty-in', weapon: 'rifle', kind: 'reloadEmpty', at: 0.65 },
  { name: 'rifle-empty-action', weapon: 'rifle', kind: 'reloadEmpty', at: 0.9 },
  { name: 'rifle-inspect', weapon: 'rifle', kind: 'inspect', at: 0.55 },

  { name: 'smg-idle', weapon: 'smg', kind: 'idle' },
  { name: 'smg-ads', weapon: 'smg', kind: 'ads' },
  { name: 'smg-trigger', weapon: 'smg', kind: 'trigger' },
  { name: 'smg-bolt-cycle', weapon: 'smg', kind: 'cycle' },
  { name: 'smg-bolt-hold', weapon: 'smg', kind: 'hold' },
  { name: 'smg-tac-out', weapon: 'smg', kind: 'reloadTac', at: 0.25 },
  { name: 'smg-tac-hidden', weapon: 'smg', kind: 'reloadTac', at: 0.5 },
  { name: 'smg-tac-in', weapon: 'smg', kind: 'reloadTac', at: 0.75 },
  { name: 'smg-empty-hidden', weapon: 'smg', kind: 'reloadEmpty', at: 0.45 },
  { name: 'smg-empty-in', weapon: 'smg', kind: 'reloadEmpty', at: 0.65 },
  { name: 'smg-empty-action', weapon: 'smg', kind: 'reloadEmpty', at: 0.9 },

  { name: 'pistol-idle', weapon: 'pistol', kind: 'idle' },
  { name: 'pistol-ads', weapon: 'pistol', kind: 'ads' },
  { name: 'pistol-trigger', weapon: 'pistol', kind: 'trigger' },
  { name: 'pistol-slide-cycle', weapon: 'pistol', kind: 'cycle' },
  { name: 'pistol-slide-hold', weapon: 'pistol', kind: 'hold' },
  { name: 'pistol-tac-out', weapon: 'pistol', kind: 'reloadTac', at: 0.25 },
  { name: 'pistol-tac-hidden', weapon: 'pistol', kind: 'reloadTac', at: 0.5 },
  { name: 'pistol-tac-in', weapon: 'pistol', kind: 'reloadTac', at: 0.75 },
  { name: 'pistol-empty-hidden', weapon: 'pistol', kind: 'reloadEmpty', at: 0.45 },
  { name: 'pistol-empty-in', weapon: 'pistol', kind: 'reloadEmpty', at: 0.65 },
  { name: 'pistol-empty-action', weapon: 'pistol', kind: 'reloadEmpty', at: 0.9 },
];
const requestedStates = args.states
  ? new Set(String(args.states).split(',').map((value) => value.trim()).filter(Boolean))
  : null;
const states = requestedStates ? STATES.filter((state) => requestedStates.has(state.name)) : STATES;
if (requestedStates) {
  for (const name of requestedStates) {
    if (!states.some((state) => state.name === name)) throw new Error(`unknown state "${name}"`);
  }
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

function compare(referenceDir, candidateDir) {
  const rows = [];
  for (const state of states) {
    const a = PNG.sync.read(readFileSync(join(referenceDir, `${state.name}.png`)));
    const b = PNG.sync.read(readFileSync(join(candidateDir, `${state.name}.png`)));
    let changed = 0;
    let maxDelta = 0;
    let sum = 0;
    const pixels = a.width * a.height;
    for (let i = 0; i < a.data.length; i += 4) {
      const delta = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2])
      );
      if (delta !== 0) changed++;
      if (delta > maxDelta) maxDelta = delta;
      sum += delta;
    }
    rows.push({
      state: state.name,
      changedPct: +((changed / pixels) * 100).toFixed(4),
      maxDelta,
      meanDelta: +(sum / pixels).toFixed(4),
    });
  }
  return { identical: rows.every((row) => row.changedPct === 0), rows };
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
  canvasCapture: true,
  size: `${WIDTH}x${HEIGHT}`,
  states: states.map((state) => state.name),
  modes: {},
  comparisons: {},
};

try {
  browser = await chromium.launch(launch);
  mkdirSync(OUT, { recursive: true });

  for (const mode of modes) {
    const dir = join(OUT, mode);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) {
        errors.push(`[error] ${message.text()}`);
      }
    });

    await page.goto(
      `http://127.0.0.1:${PORT}/?capture=1&lockstep=1&q=low&prewarm=0&adaptive=0&${MODE_QUERY[mode]}`,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
    );
    await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
    const frames = [];

    for (const state of states) {
      await page.evaluate((spec) => {
        const engine = window.__ENGINE__;
        window.__APPLY_SHOT__('weapon');
        const weapons = engine.ctx.peek('weapons');
        const vm = weapons.viewmodel;
        weapons.setWeaponImmediate(spec.weapon);

        const live = weapons.state;
        live.mag = live.def.magSize;
        live.chambered = true;
        live.reserve = live.def.reserve;
        weapons._fireTimer = 0;
        weapons._burstLeft = 0;
        weapons._burstCooldown = 0;
        weapons._sinceShot = 10;
        weapons._scriptFrames = null;
        weapons._debugFrame = 0;
        weapons.debugMode = spec.kind === 'ads' ? 'ads' : 'idle';

        vm.stopClip();
        vm.adsT = spec.kind === 'ads' ? 1 : 0;
        vm.adsTarget = vm.adsT;
        vm.triggerT = spec.kind === 'trigger' || spec.kind === 'cycle' ? 1 : 0;
        vm.triggerTarget = vm.triggerT;
        vm.boltCycle = spec.kind === 'cycle' ? 0.72 : 0;
        vm.boltHold = spec.kind === 'hold' ? 1 : 0;
        vm.magVisible = true;
        weapons._state.ads = spec.kind === 'ads';
        weapons._state.trigger = spec.kind === 'trigger' || spec.kind === 'cycle';
        weapons._state.sprint = false;
        weapons._state.speed = 0;
        weapons._state.empty = false;

        if (spec.kind === 'trigger' || spec.kind === 'cycle') weapons._sinceShot = 0;
        if (spec.kind === 'reloadTac' || spec.kind === 'reloadEmpty' || spec.kind === 'inspect') {
          if (spec.kind === 'reloadTac') live.mag = Math.max(1, Math.floor(live.def.magSize * 0.45));
          if (spec.kind === 'reloadEmpty') {
            live.mag = 0;
            live.chambered = false;
            vm.boltHold = 1;
            weapons._state.empty = true;
          }
          vm.play(spec.kind);
          const target = vm.clip.duration * spec.at;
          vm.clipT = Math.max(0, target - 1 / 60);
          // Scrubbing is visual-only. Do not replay earlier gameplay events such
          // as dropped-mag spawning while landing on the requested pose.
          vm.clipPrevT = Number.POSITIVE_INFINITY;
        }
      }, state);

      const captured = await page.evaluate(() => {
        const engine = window.__ENGINE__;
        engine.step();
        const render = engine.ctx.peek('render');
        const weapons = engine.ctx.peek('weapons');
        const vm = weapons.viewmodel;
        const sets = [
          vm.armR._gloveBatchSet,
          vm.armR._sleeveBatchSet,
          vm.armL._gloveBatchSet,
          vm.armL._sleeveBatchSet,
          ...[...vm.weapons.values()].map((weapon) => weapon.batchSet),
        ].filter(Boolean);
        let matrixMaxDelta = 0;
        let visibilityErrors = 0;
        let visibleSources = 0;
        let entries = 0;
        for (const set of sets) {
          set.root.updateWorldMatrix(true, true);
          const inverse = set.root.matrixWorld.clone().invert();
          for (const { batch, entries: list } of set.batches) {
            for (const entry of list) {
              entries++;
              if (entry.source.visible) visibleSources++;
              const expected = entry.source.matrixWorld.clone().premultiply(inverse);
              const actual = expected.clone();
              batch.getMatrixAt(entry.instanceId, actual);
              for (let i = 0; i < 16; i++) {
                matrixMaxDelta = Math.max(
                  matrixMaxDelta,
                  Math.abs(expected.elements[i] - actual.elements[i])
                );
              }
              let expectedVisible = entry.visible;
              for (
                let parent = entry.source.parent;
                expectedVisible && parent && parent !== set.root;
                parent = parent.parent
              ) {
                expectedVisible = parent.visible;
              }
              if (batch.getVisibleAt(entry.instanceId) !== expectedVisible) visibilityErrors++;
            }
          }
        }
        return {
          png: engine.canvas.toDataURL('image/png'),
          frame: engine.time.frame,
          calls: render.renderer.info.render.calls,
          tris: render.renderer.info.render.triangles,
          active: weapons.activeId,
          clip: vm.clipName,
          clipT: +vm.clipT.toFixed(4),
          triggerT: +vm.triggerT.toFixed(4),
          boltCycle: +vm.boltCycle.toFixed(4),
          boltHold: vm.boltHold,
          magazineVisible: vm.active.parts.magazine?.visible ?? null,
          entries,
          visibleSources,
          visibilityErrors,
          matrixMaxDelta,
        };
      });
      const comma = captured.png.indexOf(',');
      if (comma < 0) throw new Error(`canvas PNG capture failed for ${mode}/${state.name}`);
      writeFileSync(
        join(dir, `${state.name}.png`),
        Buffer.from(captured.png.slice(comma + 1), 'base64')
      );
      delete captured.png;
      frames.push({ state: state.name, ...captured });
    }

    const batches = await page.evaluate(() => ({
      ...window.__ENGINE__.ctx.peek('weapons')?.batchStats,
    }));
    const disposal = await page.evaluate(() => {
      const weapons = window.__ENGINE__.ctx.peek('weapons');
      const vm = weapons.viewmodel;
      const sets = [
        vm.armR._gloveBatchSet,
        vm.armR._sleeveBatchSet,
        vm.armL._gloveBatchSet,
        vm.armL._sleeveBatchSet,
        ...[...vm.weapons.values()].map((weapon) => weapon.batchSet),
      ].filter(Boolean);
      const records = [];
      const tracked = new Set();
      const track = (resource, type) => {
        if (!resource || tracked.has(resource)) return;
        tracked.add(resource);
        const record = { type, count: 0 };
        resource.addEventListener('dispose', () => record.count++);
        records.push(record);
      };
      for (const weapon of vm.weapons.values()) {
        for (const mesh of weapon.meshes) track(mesh.geometry, 'source-geometry');
      }
      vm.armL.root.traverse((object) => {
        if (object.isMesh && !object.isBatchedMesh) track(object.geometry, 'source-geometry');
      });
      vm.armR.root.traverse((object) => {
        if (object.isMesh && !object.isBatchedMesh) track(object.geometry, 'source-geometry');
      });
      const batches = [];
      for (const set of sets) {
        for (const record of set.batches) {
          const batch = record.batch;
          batches.push(batch);
          track(batch.geometry, 'batch-geometry');
          track(batch._matricesTexture, 'batch-matrix-texture');
          track(batch._indirectTexture, 'batch-id-texture');
          track(batch._colorsTexture, 'batch-color-texture');
        }
      }
      weapons.dispose();
      return {
        tracked: records.length,
        duplicateDisposals: records.filter((record) => record.count !== 1),
        attachedBatches: batches.filter((batch) => batch.parent !== null).length,
        liveBatchTextures: batches.filter(
          (batch) => batch._matricesTexture !== null || batch._indirectTexture !== null
        ).length,
      };
    });

    report.modes[mode] = { errors, batches, frames, disposal };
    await context.close();
  }

  if (modes.includes('off')) {
    for (const mode of modes) {
      if (mode === 'off') continue;
      report.comparisons[`off:${mode}`] = compare(join(OUT, 'off'), join(OUT, mode));
    }
  }
  report.ok =
    Object.values(report.comparisons).every((result) => result.identical) &&
    Object.values(report.modes).every((mode) =>
      mode.errors.length === 0 &&
      mode.frames.every((frame) =>
        frame.visibleSources === 0 && frame.visibilityErrors === 0 && frame.matrixMaxDelta < 1e-5
      ) &&
      mode.disposal.duplicateDisposals.length === 0 &&
      mode.disposal.attachedBatches === 0 &&
      mode.disposal.liveBatchTextures === 0
    );
} catch (error) {
  report.ok = false;
  report.error = error.stack ?? error.message;
} finally {
  await browser?.close();
  if (server) server.kill();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

#!/usr/bin/env node
/**
 * Deterministic public-API gate for firing, reloading and weapon switching.
 *
 * This complements viewmodel-gate.mjs: clips are not scrubbed. Every pose and
 * gameplay transition is reached through tryFire(), reload() or setWeapon(),
 * stepped at 60 Hz, checked frame-by-frame, and captured from the WebGL canvas
 * on the event frame.
 *
 *   node tools/weapon-gameplay-gate.mjs
 *   node tools/weapon-gameplay-gate.mjs --modes=off,default,view,control
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
const OUT = resolve(args.out ?? 'shots/weapon-gameplay-gate');
const MODE_QUERY = {
  off: 'staticBatch=0&viewBatch=0',
  default: '',
  view: 'staticBatch=0&viewBatch=1',
  control: 'staticBatch=0&viewBatch=0',
};
const modes = String(args.modes ?? 'off,default,view,control')
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

function compare(referenceDir, candidateDir, names) {
  const rows = [];
  for (const name of names) {
    const a = PNG.sync.read(readFileSync(join(referenceDir, `${name}.png`)));
    const b = PNG.sync.read(readFileSync(join(candidateDir, `${name}.png`)));
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
      capture: name,
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
  framewise: true,
  publicApi: ['tryFire', 'reload', 'setWeapon'],
  size: `${WIDTH}x${HEIGHT}`,
  modes: {},
  stateComparisons: {},
  pixelComparisons: {},
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

    const gameplay = await page.evaluate(() => {
      const engine = window.__ENGINE__;
      const weapons = engine.ctx.peek('weapons');
      const vm = weapons.viewmodel;
      const DT = 1 / 60;
      const captures = [];
      const sequences = [];
      const checks = [];
      const invariant = {
        frames: 0,
        matrixMaxDelta: 0,
        visibilityErrors: 0,
        maxVisibleSources: 0,
      };
      let activeLog = null;
      let localFrame = 0;

      window.__APPLY_SHOT__('weapon');
      weapons.debugMode = null;

      const originalClipEvent = vm.onClipEvent;
      vm.onClipEvent = (name, clip) => {
        activeLog?.clipEvents.push({ frame: localFrame, name, clip });
        originalClipEvent?.(name, clip);
      };
      const offReload = engine.ctx.events.on('weapon:reload', (event) => {
        activeLog?.reloadEvents.push({
          frame: localFrame,
          phase: event.phase,
          weapon: event.weapon?.id ?? null,
        });
      });
      const offFire = engine.ctx.events.on('weapon:fire', (event) => {
        activeLog?.fireEvents.push({ frame: localFrame, weapon: event.weapon?.id ?? null });
      });
      const offShell = engine.ctx.events.on('weapon:shell', (event) => {
        activeLog?.shellEvents.push({ frame: localFrame, weapon: event.weapon?.id ?? null });
      });

      const round = (value) => Number.isFinite(value) ? +value.toFixed(6) : value;
      const pass = (sequence, name, ok, details = undefined) => {
        const row = { sequence: sequence.name, name, ok: Boolean(ok) };
        if (!row.ok && details !== undefined) row.details = details;
        sequence.checks.push(row);
        checks.push(row);
      };
      const sameNames = (actual, expected) =>
        JSON.stringify(actual) === JSON.stringify(expected);

      function allBatchSets() {
        return [
          vm.armR._gloveBatchSet,
          vm.armR._sleeveBatchSet,
          vm.armL._gloveBatchSet,
          vm.armL._sleeveBatchSet,
          ...[...vm.weapons.values()].map((weapon) => weapon.batchSet),
        ].filter(Boolean);
      }

      function checkBatchMatrices() {
        let visibleSources = 0;
        let visibilityErrors = 0;
        let matrixMaxDelta = 0;
        for (const set of allBatchSets()) {
          set.root.updateWorldMatrix(true, true);
          const inverse = set.root.matrixWorld.clone().invert();
          for (const { batch, entries } of set.batches) {
            for (const entry of entries) {
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
        invariant.frames++;
        invariant.matrixMaxDelta = Math.max(invariant.matrixMaxDelta, matrixMaxDelta);
        invariant.visibilityErrors += visibilityErrors;
        invariant.maxVisibleSources = Math.max(invariant.maxVisibleSources, visibleSources);
      }

      function actionRatio() {
        const weapon = vm.active;
        if (!weapon) return null;
        const isSlide = Boolean(weapon.parts.slide);
        const part = isSlide ? weapon.parts.slide : weapon.parts.bolt;
        const rest = isSlide ? weapon.model.nodes.slideRest : weapon.model.nodes.boltRest;
        const travel = isSlide ? weapon.slideTravel : weapon.boltTravel;
        if (!part || !rest?.pos || travel.lengthSq() < 1e-12) return null;
        const dx = part.position.x - rest.pos[0];
        const dy = part.position.y - rest.pos[1];
        const dz = part.position.z - rest.pos[2];
        return round((dx * travel.x + dy * travel.y + dz * travel.z) / travel.lengthSq());
      }

      function frameState(newClipEvents, newReloadEvents) {
        const state = weapons.state;
        return {
          frame: localFrame,
          active: weapons.activeId,
          clip: vm.clipName,
          clipT: round(vm.clipT),
          switching: weapons.switching,
          mag: state.mag,
          chambered: state.chambered,
          reserve: state.reserve,
          boltHold: round(vm.boltHold),
          action: actionRatio(),
          magazineVisible: vm.active.parts.magazine?.visible ?? null,
          droppedVisible: weapons._droppedMags.filter((entry) => entry.group.visible).length,
          visibleRoots: [...vm.weapons.values()]
            .filter((weapon) => weapon.group.visible)
            .map((weapon) => weapon.id),
          clipEvents: newClipEvents,
          reloadEvents: newReloadEvents,
        };
      }

      function capture(name) {
        captures.push({ name, png: engine.canvas.toDataURL('image/png') });
      }

      function step(sequence, captureEvents = null) {
        const clipStart = sequence.clipEvents.length;
        const reloadStart = sequence.reloadEvents.length;
        localFrame++;
        engine.step();
        const clipEvents = sequence.clipEvents.slice(clipStart);
        const reloadEvents = sequence.reloadEvents.slice(reloadStart);
        sequence.trace.push(frameState(clipEvents.map((event) => event.name), reloadEvents.map((event) => event.phase)));
        checkBatchMatrices();
        if (captureEvents) {
          for (const event of clipEvents) {
            if (captureEvents.has(event.name)) {
              capture(`${sequence.name}-${event.clip}-${event.name}`);
            }
          }
        }
      }

      function cleanReset(id, { mag, chambered, reserve, boltHold = 0 } = {}) {
        activeLog = null;
        weapons.setWeaponImmediate(id);
        weapons.debugMode = null;
        weapons._switchTo = null;
        weapons._switchTimer = 0;
        weapons._reloadPhase = null;
        weapons._fireTimer = 0;
        weapons._burstLeft = 0;
        weapons._burstCooldown = 0;
        weapons._semiLatch = false;
        weapons._spread = 0;
        weapons._shotIndex = 0;
        weapons._sinceShot = 10;
        weapons._pendingShots = 0;
        weapons._pendingFirst = false;
        weapons._scriptFrames = null;
        for (const shell of weapons._shellQueue) shell.t = -1;
        weapons.sim.clear();
        for (const dropped of weapons._droppedMags) {
          dropped.group.visible = false;
          if (dropped.body && weapons.physics?.removeRigidBody) {
            weapons.physics.removeRigidBody(dropped.body);
          }
          dropped.body = null;
          dropped.until = 0;
        }

        const state = weapons.state;
        state.mag = mag ?? state.def.magSize;
        state.chambered = chambered ?? true;
        state.reserve = reserve ?? state.def.reserve;
        vm.stopClip();
        vm.adsT = 0;
        vm.adsTarget = 0;
        vm.sprintT = 0;
        vm.lowReadyT = 0;
        vm.triggerT = 0;
        vm.triggerTarget = 0;
        vm.bobPhase = 0;
        vm.noiseT = 12.37;
        vm.boltCycle = 0;
        vm.boltHold = boltHold;
        vm.magInHand = 0;
        vm.magVisible = true;
        vm.recPos.reset();
        vm.recRot.reset();
        vm.settle.reset();
        vm.lag.reset();
        vm.lagRot.reset();
        vm.jumpSpring.set(0);
        vm.landSpring.set(0);
        vm._angVel.yaw = 0;
        vm._angVel.pitch = 0;
        vm._hasPrev = false;
        weapons._state.ads = false;
        weapons._state.sprint = false;
        weapons._state.lowReady = false;
        weapons._state.speed = 0;
        weapons._state.crouch = false;
        weapons._state.airborne = false;
        weapons._state.trigger = false;
        weapons._state.empty = state.mag === 0 && !state.chambered;
        engine.step();
        checkBatchMatrices();
      }

      function makeSequence(name) {
        const sequence = {
          name,
          actionAccepted: false,
          clipEvents: [],
          reloadEvents: [],
          fireEvents: [],
          shellEvents: [],
          trace: [],
          checks: [],
        };
        sequences.push(sequence);
        activeLog = sequence;
        localFrame = 0;
        return sequence;
      }

      function runReload(id, empty) {
        const name = `${id}-${empty ? 'empty' : 'tactical'}-reload`;
        const previewState = weapons.states.get(id);
        const size = previewState.def.magSize;
        const initialMag = empty ? 0 : Math.max(1, Math.floor(size * 0.4));
        const initialReserve = size + 11;
        cleanReset(id, {
          mag: initialMag,
          chambered: !empty,
          reserve: initialReserve,
          boltHold: empty ? 1 : 0,
        });
        const sequence = makeSequence(name);
        sequence.initial = { mag: initialMag, chambered: !empty, reserve: initialReserve };
        sequence.actionAccepted = weapons.reload();
        const duration = vm.clip?.duration ?? 0;
        const captureEvents = new Set(['magout', 'magdrop', 'magin', 'boltrelease', 'end']);
        const limit = Math.ceil(duration / DT) + 12;
        for (let i = 0; i < limit && (vm.clipPlaying || i === 0); i++) {
          step(sequence, captureEvents);
        }
        activeLog = null;

        const expectedClipEvents = empty
          ? ['start', 'magout', 'magdrop', 'magin', 'charge', 'boltrelease', 'end']
          : ['start', 'magout', 'magdrop', 'magin', 'slap', 'end'];
        const clipNames = sequence.clipEvents.map((event) => event.name);
        const reloadNames = sequence.reloadEvents.map((event) => event.phase);
        const maginFrame = sequence.clipEvents.find((event) => event.name === 'magin')?.frame;
        const dropFrame = sequence.clipEvents.find((event) => event.name === 'magdrop')?.frame;
        const releaseFrame = sequence.clipEvents.find((event) => event.name === 'boltrelease')?.frame;
        const final = sequence.trace.at(-1);
        const expectedMag = empty ? size - 1 : size;
        const expectedReserve = initialReserve - (size - initialMag);

        pass(sequence, 'reload() accepted', sequence.actionAccepted);
        pass(sequence, 'clip event order', sameNames(clipNames, expectedClipEvents), { actual: clipNames, expected: expectedClipEvents });
        pass(sequence, 'public reload event order', sameNames(reloadNames, ['start', 'magout', 'magin', 'end']), { actual: reloadNames });
        pass(sequence, 'magazine unchanged before magin', sequence.trace
          .filter((frame) => frame.frame < maginFrame)
          .every((frame) => frame.mag === initialMag && frame.chambered === !empty));
        pass(sequence, 'magazine completed on magin', sequence.trace
          .filter((frame) => frame.frame >= maginFrame)
          .every((frame) => frame.mag === expectedMag && frame.chambered));
        pass(sequence, 'reserve accounting', final.reserve === expectedReserve, { actual: final.reserve, expected: expectedReserve });
        pass(sequence, 'drop appears on magdrop only', sequence.trace
          .filter((frame) => frame.frame < dropFrame).every((frame) => frame.droppedVisible === 0) &&
          sequence.trace.filter((frame) => frame.frame >= dropFrame).every((frame) => frame.droppedVisible === 1));
        pass(sequence, 'view magazine hides and returns', sequence.trace.some((frame) => !frame.magazineVisible) && final.magazineVisible === true);
        pass(sequence, 'one active weapon root', sequence.trace.every((frame) =>
          frame.visibleRoots.length === 1 && frame.visibleRoots[0] === id));
        pass(sequence, 'clip completed', final.clip === null);
        if (empty) {
          pass(sequence, 'bolt/slide held until boltrelease', sequence.trace
            .filter((frame) => frame.frame < releaseFrame)
            .every((frame) => frame.boltHold === 1 && frame.action !== null && frame.action > 0.999));
          pass(sequence, 'bolt/slide released on event', sequence.trace
            .filter((frame) => frame.frame >= releaseFrame)
            .every((frame) => frame.boltHold === 0 && (frame.action === null || Math.abs(frame.action) < 1e-5)));
        } else {
          pass(sequence, 'tactical reload never locks action', sequence.trace.every((frame) => frame.boltHold === 0));
        }
        return sequence;
      }

      function runSwitch(from, to) {
        cleanReset(from);
        const sequence = makeSequence(`${from}-to-${to}`);
        sequence.actionAccepted = weapons.setWeapon(to);
        const limit = 180;
        for (let i = 0; i < limit && (weapons.switching || vm.clipPlaying || i === 0); i++) {
          step(sequence, new Set(['end']));
        }
        activeLog = null;
        const events = sequence.clipEvents.map((event) => `${event.clip}:${event.name}`);
        const holsterEnd = sequence.clipEvents.find((event) => event.clip === 'holster' && event.name === 'end')?.frame;
        const final = sequence.trace.at(-1);
        pass(sequence, 'setWeapon() accepted', sequence.actionAccepted);
        pass(sequence, 'holster then draw end', sameNames(events, ['holster:end', 'draw:end']), { actual: events });
        pass(sequence, 'source active through holster', sequence.trace
          .filter((frame) => frame.frame < holsterEnd).every((frame) => frame.active === from && frame.switching));
        pass(sequence, 'target active after holster', sequence.trace
          .filter((frame) => frame.frame >= holsterEnd).every((frame) => frame.active === to && !frame.switching));
        pass(sequence, 'one matching visible root', sequence.trace.every((frame) =>
          frame.visibleRoots.length === 1 && frame.visibleRoots[0] === frame.active));
        pass(sequence, 'switch fully completed', final.active === to && !final.switching && final.clip === null);
        return sequence;
      }

      function runFire(id) {
        cleanReset(id, { mag: 1, chambered: true });
        const sequence = makeSequence(`${id}-fire-cycle`);
        const state = weapons.state;
        const initialReserve = state.reserve;
        sequence.actionAccepted = weapons.tryFire();
        sequence.afterFirstCall = {
          mag: state.mag,
          chambered: state.chambered,
          boltHold: vm.boltHold,
        };
        const firstStart = sequence.trace.length;
        for (let i = 0; i < 14; i++) {
          step(sequence);
          if (i === 0) capture(`${sequence.name}-cycling`);
        }
        const firstFrames = sequence.trace.slice(firstStart);
        const secondAccepted = weapons.tryFire();
        sequence.afterSecondCall = {
          accepted: secondAccepted,
          mag: state.mag,
          chambered: state.chambered,
          boltHold: vm.boltHold,
        };
        step(sequence);
        capture(`${sequence.name}-held-open`);
        for (let i = 0; i < 14; i++) step(sequence);
        const dryAccepted = weapons.tryFire();
        sequence.dryAccepted = dryAccepted;
        step(sequence);
        activeLog = null;
        const final = sequence.trace.at(-1);
        const cyclePeak = Math.max(...firstFrames.map((frame) => frame.action ?? 0));

        pass(sequence, 'first tryFire() accepted', sequence.actionAccepted);
        pass(sequence, 'first round feeds chamber', sequence.afterFirstCall.mag === 0 && sequence.afterFirstCall.chambered && sequence.afterFirstCall.boltHold === 0, sequence.afterFirstCall);
        pass(sequence, 'bolt/slide visibly cycles', cyclePeak > 0.5, { cyclePeak });
        pass(sequence, 'bolt/slide cycle returns', Math.abs(firstFrames.at(-1).action ?? 0) < 1e-5, { action: firstFrames.at(-1).action });
        pass(sequence, 'last tryFire() accepted', secondAccepted);
        pass(sequence, 'last round locks action', !sequence.afterSecondCall.chambered && sequence.afterSecondCall.mag === 0 && sequence.afterSecondCall.boltHold === 1, sequence.afterSecondCall);
        pass(sequence, 'held action stays fully open', sequence.trace
          .slice(firstFrames.length)
          .every((frame) => frame.boltHold === 1 && frame.action !== null && frame.action > 0.999));
        pass(sequence, 'dry tryFire() rejected', dryAccepted === false);
        pass(sequence, 'two fire events', sequence.fireEvents.length === 2, { events: sequence.fireEvents });
        pass(sequence, 'two shell events', sequence.shellEvents.length === 2, { events: sequence.shellEvents });
        pass(sequence, 'ammo/reserve final invariant', final.mag === 0 && !final.chambered && final.reserve === initialReserve);
        return sequence;
      }

      runReload('rifle', false);
      runReload('rifle', true);
      runReload('pistol', true);
      runSwitch('rifle', 'smg');
      runSwitch('smg', 'pistol');
      runFire('rifle');
      runFire('pistol');

      offReload();
      offFire();
      offShell();
      vm.onClipEvent = originalClipEvent;

      return {
        ok: checks.every((check) => check.ok),
        checks,
        sequences,
        invariant,
        captures,
      };
    });

    const captureNames = [];
    for (const capture of gameplay.captures) {
      const comma = capture.png.indexOf(',');
      if (comma < 0) throw new Error(`canvas PNG capture failed for ${mode}/${capture.name}`);
      writeFileSync(join(dir, `${capture.name}.png`), Buffer.from(capture.png.slice(comma + 1), 'base64'));
      captureNames.push(capture.name);
    }
    delete gameplay.captures;

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

    report.modes[mode] = { errors, batches, gameplay, captureNames, disposal };
    await context.close();
  }

  if (modes.includes('off')) {
    const reference = report.modes.off;
    for (const mode of modes) {
      if (mode === 'off') continue;
      const candidate = report.modes[mode];
      report.stateComparisons[`off:${mode}`] = {
        identical: isDeepStrictEqual(reference.gameplay.sequences, candidate.gameplay.sequences),
      };
      const sameCaptureNames = isDeepStrictEqual(reference.captureNames, candidate.captureNames);
      report.pixelComparisons[`off:${mode}`] = sameCaptureNames
        ? compare(join(OUT, 'off'), join(OUT, mode), reference.captureNames)
        : { identical: false, captureNameMismatch: true };
    }
  }

  report.ok =
    Object.values(report.stateComparisons).every((result) => result.identical) &&
    Object.values(report.pixelComparisons).every((result) => result.identical) &&
    Object.values(report.modes).every((mode) =>
      mode.errors.length === 0 &&
      mode.gameplay.ok &&
      mode.gameplay.invariant.maxVisibleSources === 0 &&
      mode.gameplay.invariant.visibilityErrors === 0 &&
      mode.gameplay.invariant.matrixMaxDelta < 1e-5 &&
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

#!/usr/bin/env node
/**
 * Deterministic CLI gate for the static-world and viewmodel batch paths.
 *
 * The PNG is read directly from the game's WebGL canvas in the same JavaScript
 * task as the final lockstep render. It deliberately does not use Playwright's
 * browser-screenshot or a desktop-screenshot API, so window chrome, compositor
 * timing and overlays cannot leak into the image.
 *
 *   node tools/batch-gate.mjs --shots=hero,interior,weapon,ads,muzzle
 *   node tools/batch-gate.mjs --modes=off,control --settle=30
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
const SETTLE = Math.max(1, Number(args.settle ?? 45));
const TIMEOUT = Number(args.timeout ?? 240000);
const OUT = resolve(args.out ?? 'shots/batch-gate-cli');
const SHOTS = String(args.shots ?? 'hero,interior,detail,sunset,night,weapon,ads,muzzle,combat,impacts')
  .split(',').map((value) => value.trim()).filter(Boolean);

const MODE_QUERY = {
  off: 'staticBatch=0&viewBatch=0',
  default: '',
  static: 'staticBatch=1&viewBatch=0',
  view: 'staticBatch=0&viewBatch=1',
  'view-arms': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchGloves=1&viewBatchSleeves=1',
  'view-gloves': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=1',
  'view-gloves-direct': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=direct',
  'view-gloves-identity': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=identity',
  'view-gloves-nested': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=nested',
  'view-gloves-safe': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchSleeves=0&viewBatchGloves=safe',
  'view-sleeves': 'staticBatch=0&viewBatch=1&viewBatchWeapons=0&viewBatchGloves=0&viewBatchSleeves=1',
  'view-weapons': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=all',
  'view-weapon-fixed': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=all&viewBatchWeaponMoving=0',
  'view-weapon-moving': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=all&viewBatchWeaponFixed=0',
  'view-weapon-alu': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=alu',
  'view-weapon-cavity': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=cavity',
  'view-weapon-polymer': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=polymer',
  'view-weapon-rubber': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=rubber',
  'view-weapon-brass': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=brass',
  'view-weapon-steel': 'staticBatch=0&viewBatch=1&viewBatchArms=0&viewBatchWeapons=1&viewBatchWeaponMaterial=steel_bright',
  both: 'staticBatch=1&viewBatch=1',
  control: 'staticBatch=0&viewBatch=0',
};
const modes = String(args.modes ?? 'off,default,static,view,both,control')
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

function compare(referenceDir, candidateDir) {
  const rows = [];
  for (const shot of SHOTS) {
    const a = PNG.sync.read(readFileSync(join(referenceDir, `${shot}.png`)));
    const b = PNG.sync.read(readFileSync(join(candidateDir, `${shot}.png`)));
    if (a.width !== b.width || a.height !== b.height) {
      rows.push({ shot, sizeMismatch: true });
      continue;
    }
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
      shot,
      changedPct: +((changed / pixels) * 100).toFixed(4),
      maxDelta,
      meanDelta: +(sum / pixels).toFixed(4),
    });
  }
  return {
    identical: rows.every((row) => row.changedPct === 0),
    withinEpsilon: rows.every((row) => row.changedPct < 0.05 && row.maxDelta <= 2),
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
  canvasCapture: true,
  size: `${WIDTH}x${HEIGHT}`,
  settle: SETTLE,
  shots: SHOTS,
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

    const extra = MODE_QUERY[mode] ? `&${MODE_QUERY[mode]}` : '';
    await page.goto(
      `http://127.0.0.1:${PORT}/?capture=1&lockstep=1&q=low&prewarm=0&adaptive=0${extra}`,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
    );
    await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
    const available = await page.evaluate(() => Object.keys(window.__SHOTS__ ?? {}));
    for (const shot of SHOTS) {
      if (!available.includes(shot)) throw new Error(`unknown shot "${shot}"`);
    }

    const frames = [];
    for (const shot of SHOTS) {
      await page.evaluate(
        ({ name, settle }) => window.__APPLY_SHOT__(name, { grabFrame: settle }),
        { name: shot, settle: SETTLE }
      );
      if (SETTLE > 1) await page.evaluate((count) => window.__PUMP__(count), SETTLE - 1);

      // Render and read in one task. With preserveDrawingBuffer=false, waiting
      // for a compositor screenshot would make the default framebuffer timing-
      // dependent; this synchronous canvas read is deterministic.
      const captured = await page.evaluate(() => {
        const engine = window.__ENGINE__;
        engine.step();
        const render = engine.ctx.peek('render');
        const gl = render.renderer.getContext();
        return {
          png: engine.canvas.toDataURL('image/png'),
          frame: engine.time.frame,
          calls: render.renderer.info.render.calls,
          tris: render.renderer.info.render.triangles,
          programs: render.renderer.info.programs?.length ?? 0,
          performance: { ...render.performance },
          gpu: (() => {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          })(),
        };
      });
      const comma = captured.png.indexOf(',');
      if (comma < 0) throw new Error(`canvas PNG capture failed for ${mode}/${shot}`);
      writeFileSync(join(dir, `${shot}.png`), Buffer.from(captured.png.slice(comma + 1), 'base64'));
      delete captured.png;
      frames.push({ shot, ...captured });
    }

    report.modes[mode] = {
      errors,
      world: await page.evaluate(() => ({ ...window.__ENGINE__.ctx.peek('world')?.stats })),
      batches: await page.evaluate(() => ({ ...window.__ENGINE__.ctx.peek('weapons')?.batchStats })),
      frames,
    };
    await context.close();
  }

  if (modes.includes('off')) {
    for (const mode of modes) {
      if (mode === 'off') continue;
      report.comparisons[`off:${mode}`] = compare(join(OUT, 'off'), join(OUT, mode));
    }
  }
  const exact = new Set(['off:default', 'off:static', 'off:control']);
  report.ok = Object.entries(report.comparisons).every(([name, result]) =>
    exact.has(name) ? result.identical : result.withinEpsilon
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

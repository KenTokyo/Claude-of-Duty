#!/usr/bin/env node
/**
 * How many point lights are ACTUALLY lit at once, anywhere on the map?
 *
 * `world._stabiliseLightCount` pads the visible point-light count up to
 * `pointLightSlots` with black ballast lights so Three's NUM_POINT_LIGHTS
 * permutation key never changes. The padding cannot move a pixel, but the
 * unrolled forward loop still runs a full physical BRDF per dead slot --
 * MEASURED at 4.6 ms of a 63 ms frame for 20 slots.
 *
 * So the slot count wants to be the smallest number that is never exceeded in
 * play. Guessing it is how you buy a permutation stall back. This tool answers
 * it exhaustively instead: it replicates the renderer's own cull test
 * (fade = 1 - smoothstep(d, .75r, 1.15r), visible = fade > 0.002) at every node
 * of a dense grid over the world's walkable extent and reports the maximum
 * concurrent count, plus the histogram and the worst positions.
 *
 * A grid beats walking the player around: it cannot miss the one balcony where
 * five bulbs overlap just because the scripted path never went there.
 *
 *   node tools/lightcount.mjs --query=q=ultra --step=1
 */
import { chromium } from 'playwright';
import { launchBrowser } from "./launch.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const QUERY = String(args.query ?? 'q=ultra');
const STEP = Number(args.step ?? 1);

const browser = await launchBrowser(chromium, args, ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio']);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

const out = await page.evaluate(async ({ STEP }) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const world = e.ctx.peek('world');

  // Let every pool that appears after boot exist before we scan. The FX light
  // pool and the viewmodel rig are built during the first frames.
  await new Promise((done) => { let i = 0; const t = () => (++i >= 120 ? done() : requestAnimationFrame(t)); requestAnimationFrame(t); });

  // Same collection the world itself does: every point light in the scene that
  // is not ballast.
  const lights = [];
  e.ctx.scene.traverse((o) => {
    if (o.isPointLight === true && o.userData.owBallast !== true) lights.push(o);
  });

  // The cull radius the renderer gave each one. Unregistered lights are driven
  // by their owner's `visible` flag instead, so they count whenever they are on.
  const ranges = new Map();
  for (const l of r.lights ?? []) {
    if (l.light?.isPointLight === true) ranges.set(l.light, l.range);
  }

  const smoothstep = (x, a, b) => {
    if (x <= a) return 0; if (x >= b) return 1;
    const t = (x - a) / (b - a); return t * t * (3 - 2 * t);
  };

  const culled = [];   // registered: {x,y,z,rOn} where rOn = distance at which it switches off
  let always = 0;      // unregistered but currently visible: an unconditional +1
  const alwaysNames = [];
  for (const l of lights) {
    const range = ranges.get(l);
    const p = l.getWorldPosition(new (l.position.constructor)());
    if (range === undefined) {
      if (l.visible === true) { always++; alwaysNames.push(l.name || l.type); }
      continue;
    }
    // fade > 0.002  <=>  smoothstep(d, .75r, 1.15r) < 0.998. Solve for d.
    let lo = range * 0.75, hi = range * 1.15;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (1 - smoothstep(mid, range * 0.75, range * 1.15) > 0.002) lo = mid; else hi = mid;
    }
    culled.push({ x: p.x, y: p.y, z: p.z, rOn: hi, range, name: l.name || l.type });
  }

  // Grid over the union of the lights' influence, which is the only region
  // where the count can be anything but `always`. Sampling outside it is waste.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of culled) {
    minX = Math.min(minX, c.x - c.rOn); maxX = Math.max(maxX, c.x + c.rOn);
    minZ = Math.min(minZ, c.z - c.rOn); maxZ = Math.max(maxZ, c.z + c.rOn);
    minY = Math.min(minY, c.y - c.rOn); maxY = Math.max(maxY, c.y + c.rOn);
  }

  // Camera heights that matter: crouch, stand, and a couple of storeys up, so a
  // balcony or roof stack is not missed.
  const ys = [];
  for (let y = Math.max(minY, -2); y <= Math.min(maxY, 40); y += 1) ys.push(y);
  if (!ys.length) ys.push(1.7);

  const hist = new Map();
  let best = { n: -1, at: null };
  let samples = 0;
  // Per-height peak as well as the global one. The global maximum is often at a
  // y the player can never occupy (under the terrain, or above every roof), and
  // sizing the slot count off an unreachable spot buys back dead slots for
  // nothing. `perY` is what the decision is actually made on.
  const perY = [];
  for (const y of ys) {
    let bestY = { n: -1, at: null };
    for (let x = minX; x <= maxX; x += STEP) {
      for (let z = minZ; z <= maxZ; z += STEP) {
        let n = 0;
        for (let i = 0; i < culled.length; i++) {
          const c = culled[i];
          const dx = c.x - x, dy = c.y - y, dz = c.z - z;
          if (dx * dx + dy * dy + dz * dz <= c.rOn * c.rOn) n++;
        }
        samples++;
        hist.set(n, (hist.get(n) ?? 0) + 1);
        if (n > bestY.n) bestY = { n, at: [+x.toFixed(1), +y.toFixed(1), +z.toFixed(1)] };
        if (n > best.n) best = { n, at: [+x.toFixed(1), +y.toFixed(1), +z.toFixed(1)] };
      }
    }
    perY.push({ y: +y.toFixed(1), peakCulled: bestY.n, peakTotal: bestY.n + always, at: bestY.at });
  }

  // Percentiles over the sampled volume: how much of the map ever needs how many.
  const counts = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  let acc = 0; const cum = counts.map(([n, c]) => { acc += c; return [n, c, acc / samples]; });

  return {
    totalPointLights: lights.length,
    distanceCulled: culled.length,
    alwaysOn: always,
    alwaysOnNames: alwaysNames,
    // The number the shader actually has to carry at the worst spot on the map.
    peakConcurrent: best.n + always,
    peakAt: best.at,
    peakCulledOnly: best.n,
    bounds: { x: [+minX.toFixed(1), +maxX.toFixed(1)], z: [+minZ.toFixed(1), +maxZ.toFixed(1)], ys },
    perY,
    samples,
    histogram: cum.map(([n, c, p]) => ({ culledLit: n, total: n + always, samples: c, cumFraction: +p.toFixed(4) })),
    lightTargetNow: world?._lightTarget,
    slotsConfigured: e.config.q.pointLightSlots,
    ballastPool: world?._ballast?.length ?? 0,
    lightList: culled.map((c) => ({ name: c.name, range: c.range, rOn: +c.rOn.toFixed(1), pos: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)] })),
  };
}, { STEP });

console.log(JSON.stringify({ ...out, pageErrors: errs.slice(0, 5) }, null, 2));
await browser.close();

#!/usr/bin/env node
/**
 * Paired A/B harness.
 *
 * A straight list of ablations measured back to back is worthless on this
 * machine: MEASURED, the baseline drifted from 86 ms to 132 ms over one 19-row
 * run, so every late row looked like a win and three rows that REMOVED work
 * came out slower than the baseline they were compared against.
 *
 * So each feature is measured as interleaved PAIRS — on, off, on, off, ... —
 * and the reported number is the median of the per-pair deltas. Thermal drift,
 * background load and GPU clock changes are common to both halves of a pair and
 * cancel out.
 *
 * Pairing alone was NOT enough. MEASURED over an 18-row run: the rows scheduled
 * first and last came back with a pair-to-pair spread of 90-127 ms on an 88 ms
 * frame, and two rows that REMOVED work scored negative (`gtao-off` -18 ms,
 * `csm-1-cascade` -42 ms), while the rows in the middle of the run agreed to
 * within 1-11 ms. Pairing cancels drift that is linear across ~9 s; it cannot
 * cancel the GPU clock ramp at the head of a run or the throttle at the tail,
 * because those bend within a single pair.
 *
 * So the loop is ROUND-major, not row-major: every row is sampled once per
 * round, and the rounds are spread across the whole run. Each row's pairs
 * therefore straddle the entire thermal envelope instead of sitting inside one
 * corner of it, and the median across rounds throws out the corner. Plus a long
 * unmeasured warm-up before round 0.
 *
 *   node tools/ab.mjs --query=q=ultra --pairs=3 --frames=40
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
const FRAMES = Number(args.frames ?? 40);
const PAIRS = Number(args.pairs ?? 3);
const QUERY = String(args.query ?? 'q=ultra');
const ONLY = args.only ? String(args.only).split(',') : null;

const browser = await launchBrowser(chromium, args, ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync']);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}&adaptive=0`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

const out = await page.evaluate(async ({ FRAMES, PAIRS, ONLY }) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const ai = e.ctx.peek('ai');
  const world = e.ctx.peek('world');
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  ai?.debugStage?.('firefight');
  e.time.scale = 0; // identical scene for every sample

  const measure = (n) => new Promise((done) => {
    const ts = []; let last = performance.now(), i = 0;
    const tick = () => {
      const now = performance.now(); ts.push(now - last); last = now;
      if (++i >= n) { ts.sort((a, b) => a - b); return done(ts[ts.length >> 1]); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const warm = (n) => new Promise((done) => {
    let i = 0; const tick = () => (++i >= n ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  const resize = () => r.resize(r._cssWidth, r._cssHeight, e.ctx, true);
  const hide = (obj) => { if (!obj) return () => {}; const v = obj.visible; obj.visible = false; return () => { obj.visible = v; }; };
  const nullOut = (keys) => () => {
    const saved = {}; for (const k of keys) { saved[k] = r[k]; r[k] = null; }
    return () => Object.assign(r, saved);
  };

  const ABLATIONS = {
    'csm-off': () => { const v = r.csm.enabled; r.csm.enabled = false; return () => { r.csm.enabled = v; }; },
    'csm-1-cascade': () => { const v = r.csm.cascades; r.csm.cascades = 1; return () => { r.csm.cascades = v; }; },
    'csm-shader-off': () => { const v = r.csm.uniforms.owCsmParams.value.x; r.csm.uniforms.owCsmParams.value.x = 0;
      return () => { r.csm.uniforms.owCsmParams.value.x = v; }; },
    // Resolution ablations for the scaled screen-space chains. `costMs` here is
    // NEGATIVE when the shipped (scaled) size is the faster one — the "off"
    // half of the pair is the full-res build, so a negative delta is the win.
    'gtao-fullres': () => {
      const w = r.screenSize.width, h = r.screenSize.height;
      const s = Math.max(0.25, r._aoScale);
      r.gtao.setSize(w, h);
      return () => r.gtao.setSize(Math.floor(w * s), Math.floor(h * s));
    },
    'contact-fullres': () => {
      const w = r.screenSize.width, h = r.screenSize.height;
      const s = Math.max(0.25, r._contactScale);
      r.contact.setSize(w, h, 1);
      return () => r.contact.setSize(Math.floor(w * s), Math.floor(h * s), s);
    },
    // What the point-light BALLAST costs. world/index.js pads the visible point
    // light count up to `pointLightSlots` with black lights so that Three's
    // NUM_POINT_LIGHTS permutation key never changes. The padding cannot move a
    // pixel, but the unrolled loop still evaluates a full physical BRDF for
    // every dead slot. Disabling the top-up drops the count to however many real
    // practicals are in range, so this row is the cost of the dead slots alone.
    // Needs a long settle: the count IS the program cache key, so the first
    // apply recompiles every lit material in the frame.
    'ballast-off': () => {
      const prev = world._stabiliseLightCount;
      world._stabiliseLightCount = () => {};
      for (const l of world._ballast ?? []) l.visible = false;
      return () => { world._stabiliseLightCount = prev; };
    },
    // What the point-light early-out is worth (materialpatch.js
    // `withPointLightSkip`). three computes `directLight.visible` and then never
    // reads it on the physical path, so stock forward shading runs a full BRDF
    // for all NUM_POINT_LIGHTS slots on every fragment -- including the black
    // ballast slots and every practical the fragment is out of range of.
    // Flipping the uniform to 0 forces the stock behaviour back WITHOUT a
    // recompile, so both halves of the pair measure the same program and the
    // row needs no extra settle.
    'pointskip-off': () => {
      const u = r.patcher.uniforms.owLightSkip.value;
      const v = u.x; u.x = 0;
      return () => { u.x = v; };
    },
    'gtao-off': nullOut(['gtao']),
    'ssr-off': nullOut(['ssr']),
    'contact-off': nullOut(['contact']),
    'taa-off': nullOut(['taa']),
    'motionblur-off': nullOut(['motionBlur']),
    'bloom-off': nullOut(['bloom']),
    'post-off': nullOut(['gtao', 'ssr', 'contact', 'taa', 'motionBlur', 'bloom', 'dof']),
    'prepass-off': () => { const v = r.needsPrepass; r.needsPrepass = false; return () => { r.needsPrepass = v; }; },
    'world-hidden': () => hide(world?.root),
    'ai-hidden': () => hide(ai?.root),
    'sky-hidden': () => hide(e.ctx.peek('sky')?.root),
    'viewmodel-hidden': () => { const saved = e.viewScene.children.map((c) => [c, c.visible]);
      for (const [c] of saved) if (!c.isLight) c.visible = false;
      return () => { for (const [c, s] of saved) c.visible = s; }; },
    'scale-0.8': () => { const v = r.renderScale; r.renderScale = 0.8; resize(); return () => { r.renderScale = v; resize(); }; },
    'scale-0.65': () => { const v = r.renderScale; r.renderScale = 0.65; resize(); return () => { r.renderScale = v; resize(); }; },
    'scale-0.5': () => { const v = r.renderScale; r.renderScale = 0.5; resize(); return () => { r.renderScale = v; resize(); }; },
  };

  // Frames to let the driver settle AFTER applying and after restoring, before
  // anything is measured. 12 is plenty for flipping a uniform or nulling a
  // pass, and nowhere near enough for a row that reallocates render targets:
  // MEASURED, the three `scale-*` rows at 12 frames came back with baselines of
  // 109-123 ms against the 63 ms every non-reallocating row saw in the same
  // build, and spreads (52-79 ms) as large as the costs they reported. The
  // allocation storm lands inside the very next measurement window -- including
  // the ON half of the next round, which is why it corrupts the baseline too.
  const SETTLE = {
    'scale-0.8': 90, 'scale-0.65': 90, 'scale-0.5': 90,
    'gtao-fullres': 60, 'contact-fullres': 60,
    'ballast-off': 120,
  };

  const names = ONLY ? ONLY.filter((n) => n in ABLATIONS) : Object.keys(ABLATIONS);
  const acc = new Map(names.map((n) => [n, { deltas: [], onMs: [], offMs: [], error: null }]));

  // Let the GPU clocks come up before anything is recorded. Round 0 is
  // otherwise measured on a cold device and lands ~40% off the steady state.
  await warm(240);

  for (let p = 0; p < PAIRS; p++) {
    for (const name of names) {
      const a4 = acc.get(name);
      if (a4.error) continue;
      const settle = SETTLE[name] ?? 12;
      await warm(settle);
      const a = await measure(FRAMES);          // feature ON (baseline)
      let restore = null;
      try {
        restore = ABLATIONS[name]();
        await warm(settle);
        const b = await measure(FRAMES);        // feature OFF
        a4.onMs.push(a); a4.offMs.push(b); a4.deltas.push(a - b);
      } catch (err) {
        a4.error = String(err && err.message || err);
      } finally {
        try { restore?.(); } catch {}
        // Settle AFTER the restore too, not just after the apply. Undoing a row
        // costs exactly what applying it cost -- the same target reallocation,
        // the same shader recompile -- and the row's own measuring is already
        // over by then, so the storm lands in the NEXT row's ON half instead.
        // MEASURED: with `ballast-off` (which changes NUM_POINT_LIGHTS and so
        // recompiles every lit material in the frame) sharing a run, the row
        // scheduled after it came back with a baseline of 114.8 ms against the
        // 63 ms it sees alone, a spread of 109.9 ms, and a negative cost.
        await warm(settle);
      }
    }
  }

  /** Linear-interpolated quantile of an already-sorted array. */
  const q = (sorted, p) => {
    if (sorted.length === 1) return sorted[0];
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  const rows = [];
  for (const name of names) {
    const { deltas, onMs, offMs, error } = acc.get(name);
    if (error) { rows.push({ name, error }); continue; }
    if (!deltas.length) continue;
    deltas.sort((x, y) => x - y);
    onMs.sort((x, y) => x - y);
    offMs.sort((x, y) => x - y);
    const base = onMs[onMs.length >> 1];
    const dv = deltas[deltas.length >> 1];
    rows.push({
      name,
      baselineMs: +base.toFixed(2),
      withoutMs: +offMs[offMs.length >> 1].toFixed(2),
      costMs: +dv.toFixed(2),
      costPct: +((dv / base) * 100).toFixed(1),
      // Kept in the output on purpose: a row whose spread rivals its cost is
      // not a measurement, and reading the table without this column is how the
      // negative-cost rows above got believed the first time.
      spreadMs: +(deltas[deltas.length - 1] - deltas[0]).toFixed(2),
      // ...but the full range is itself destroyed by a SINGLE stalled pair, and
      // then it condemns a row that is otherwise perfectly repeatable. The IQR
      // is the same statistic with the outliers cut off: read `spreadIqrMs`
      // against `costMs` to judge the row, and the gap between `spreadMs` and
      // `spreadIqrMs` to see how many pairs got hit by something external.
      // Both are needed -- a row is only trustworthy if the IQR is small AND
      // the raw deltas below agree in sign.
      spreadIqrMs: +(q(deltas, 0.75) - q(deltas, 0.25)).toFixed(2),
      // The raw ladder, so a spread can be diagnosed instead of just distrusted.
      deltasMs: deltas.map((d) => +d.toFixed(1)),
      onMsRaw: onMs.map((d) => +d.toFixed(1)),
      offMsRaw: offMs.map((d) => +d.toFixed(1)),
    });
  }
  rows.sort((a, b) => (b.costMs ?? -1e9) - (a.costMs ?? -1e9));
  return {
    quality: e.config.quality,
    megapixels: +((r.screenSize.width * r.screenSize.height) / 1e6).toFixed(2),
    internal: [r.screenSize.width, r.screenSize.height],
    rows,
  };
}, { FRAMES, PAIRS, ONLY });

console.log(JSON.stringify({ ...out, errs: errs.slice(0, 5) }, null, 2));
await browser.close();

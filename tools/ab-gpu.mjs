#!/usr/bin/env node
/**
 * Frame-alternating A/B on real GPU time (EXT_disjoint_timer_query_webgl2).
 *
 * WHY THIS EXISTS, on top of tools/ab.mjs:
 *
 * ab.mjs measures wall clock across blocks of 40 frames and pairs the blocks to
 * cancel drift. That works, but the pairing window is seconds wide, so anything
 * that hiccups once -- a Metal pipeline-cache eviction, a GC, the compositor --
 * lands wholly inside one half of a pair and shows up as tens of milliseconds of
 * spread. MEASURED on a pure uniform flip, which cannot possibly cost anything
 * to switch: median cost -3.8 ms with a spread of 109.8 ms over 7 pairs, and a
 * GPU-process crash at 9 pairs.
 *
 * So for ablations that are ONLY a uniform write -- no reallocation, no shader
 * permutation change, nothing that has to settle -- flip the state every single
 * frame instead and time the GPU directly:
 *
 *   - The two states are then interleaved at frame granularity, so thermal
 *     drift, clock ramp and background load are common-mode to within one
 *     frame instead of within one multi-second block.
 *   - TIME_ELAPSED counts GPU work only. CPU stalls, compositor jitter and
 *     rAF scheduling -- most of what wall clock was picking up -- are excluded
 *     by construction.
 *   - A one-off stall pollutes exactly one sample of one state out of hundreds,
 *     and the median throws it out, instead of poisoning a whole 40-frame block.
 *
 * ONLY valid for zero-side-effect flips. A row that reallocates a target or
 * changes NUM_POINT_LIGHTS must go through ab.mjs and its SETTLE map: alternating
 * those every frame would measure nothing but the reallocation storm.
 *
 *   node tools/ab-gpu.mjs --query=q=ultra --ablate=pointskip --frames=600
 */
import { chromium } from 'playwright';
import { launchBrowser } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 600);
const WARM = Number(args.warm ?? 240);
const QUERY = String(args.query ?? 'q=ultra');
const ABLATE = String(args.ablate ?? 'pointskip');

const browser = await launchBrowser(chromium, args,
  ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
   '--disable-frame-rate-limit', '--disable-gpu-vsync']);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}&adaptive=0`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

const out = await page.evaluate(({ FRAMES, WARM, ABLATE }) => new Promise((done) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const gl = r.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return done({ error: 'no EXT_disjoint_timer_query_webgl2' });

  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  e.ctx.peek('ai')?.debugStage?.('firefight');
  // Identical scene on every frame: the only thing allowed to differ between
  // two consecutive frames is the uniform under test.
  e.time.scale = 0;

  // Our queries cannot nest inside the adaptive-resolution whole-frame timer.
  if (r.gpuTimer) { r.gpuTimer.begin = () => false; r.gpuTimer.end = () => {}; r.gpuTimer.poll = () => 0; }

  // Each entry sets the ablation to `on` (shipped) or off, by uniform ONLY.
  const ABLATIONS = {
    // The point-light early-out in materialpatch.js (withPointLightSkip).
    pointskip: {
      set: (on) => { r.patcher.uniforms.owLightSkip.value.x = on ? 1 : 0; },
      phase: 'forward',
    },
  };
  const ab = ABLATIONS[ABLATE];
  if (!ab) return done({ error: `unknown ablation ${ABLATE}`, known: Object.keys(ABLATIONS) });

  const samples = { on: [], off: [] };
  const inflight = [];
  let open = false;

  const drain = () => {
    for (let i = inflight.length - 1; i >= 0; i--) {
      const s = inflight[i];
      if (!gl.getQueryParameter(s.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(s.q, gl.QUERY_RESULT);
      gl.deleteQuery(s.q);
      inflight.splice(i, 1);
      // A disjoint event means the timer is untrustworthy for that sample.
      if (!Number.isFinite(ns) || gl.getParameter(ext.GPU_DISJOINT_EXT)) continue;
      if (s.record) samples[s.state].push({ frame: s.frame, ms: ns / 1e6 });
    }
  };

  // Time the forward world pass -- the one that runs the point-light loop.
  // The viewmodel and every shadow cascade go through this same method, so the
  // pass is identified by the target that is BOUND when it is called: only
  // render/index.js:1519 draws the world scene into hdrRt. (Identifying it by
  // an `r.csm.__inCsm` marker, as tools/gpu-pass-profile.mjs does, silently
  // fails -- no such flag exists, so that tool's `forward` figure is really the
  // cascades and the forward pass averaged together.)
  const rawRender = r.renderer.render.bind(r.renderer);
  let state = 'on', record = false;
  r.renderer.render = (scene, cam) => {
    const isForward = scene !== e.viewScene && r.renderer.getRenderTarget() === r.hdrRt;
    if (!isForward || open || inflight.length > 48) return rawRender(scene, cam);
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    open = true;
    try { return rawRender(scene, cam); }
    finally {
      gl.endQuery(ext.TIME_ELAPSED_EXT); open = false;
      inflight.push({ q, state, record, frame: i });
    }
  };

  let i = 0;
  const tick = () => {
    // Flip BEFORE the frame is drawn, so the query opened during this frame is
    // tagged with the state that frame actually rendered in.
    state = i % 2 === 0 ? 'on' : 'off';
    ab.set(state === 'on');
    record = i >= WARM;
    drain();
    if (++i >= FRAMES + WARM) {
      // The run is over, but the engine keeps drawing while we wait for the
      // last queries to resolve. Stop tagging those frames: `state`/`record`
      // still hold the last tick's values, so every settle frame would be
      // recorded as another sample of whichever state happened to be last and
      // swamp it (MEASURED: off.n = 294 against on.n = 60 for a 120-frame run).
      record = false;
      let spins = 0;
      const settle = () => {
        drain();
        if (inflight.length && ++spins < 240) return requestAnimationFrame(settle);
        r.renderer.render = rawRender; // stop intercepting before we report
        ab.set(true); // leave the build in its shipped state
        const stat = (a) => {
          if (!a.length) return null;
          const s = a.map((x) => x.ms).sort((x, y) => x - y);
          const q1 = s[Math.floor((s.length - 1) * 0.25)], q3 = s[Math.floor((s.length - 1) * 0.75)];
          return {
            n: s.length,
            medianMs: +s[s.length >> 1].toFixed(3),
            p05Ms: +s[Math.floor(s.length * 0.05)].toFixed(3),
            p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(3),
            iqrMs: +(q3 - q1).toFixed(3),
          };
        };
        const on = stat(samples.on), off = stat(samples.off);

        // THE statistic for this design. Comparing the two medians against the
        // IQR of the raw samples is the wrong test: the IQR is how much one
        // FRAME varies, not how well the median is pinned down, and it is
        // dominated by occasional stalls that the median already discards.
        //
        // Because the states alternate, off-frame f+1 is the immediate
        // neighbour of on-frame f -- same thermal state, same clock, same
        // background load, one frame apart. Differencing those neighbours
        // cancels all of it and leaves the effect of the flip. The sign test
        // then answers the only question that matters: does the shipped state
        // win MORE OFTEN than chance, not just on average?
        const byFrame = new Map();
        for (const s of samples.on) byFrame.set(s.frame, s.ms);
        const deltas = [];
        for (const s of samples.off) {
          const prev = byFrame.get(s.frame - 1);
          if (prev !== undefined) deltas.push(s.ms - prev); // >0 = on is faster
        }
        deltas.sort((a, b) => a - b);
        const wins = deltas.filter((d) => d > 0).length;
        const dq1 = deltas[Math.floor((deltas.length - 1) * 0.25)];
        const dq3 = deltas[Math.floor((deltas.length - 1) * 0.75)];
        const paired = deltas.length ? {
          pairs: deltas.length,
          medianDeltaMs: +deltas[deltas.length >> 1].toFixed(3),
          iqrMs: +(dq3 - dq1).toFixed(3),
          // Fraction of adjacent frame pairs in which the early-out was faster.
          // 0.5 is pure chance; the run is only meaningful well away from it.
          winRate: +(wins / deltas.length).toFixed(3),
          // Binomial z against p=0.5. |z| > 3 is decisive.
          signTestZ: +((wins - deltas.length / 2) / (Math.sqrt(deltas.length) / 2)).toFixed(2),
        } : null;
        done({
          ablation: ABLATE,
          phase: ab.phase,
          on, off,
          // Positive = the shipped state (on) is FASTER by this much.
          savedMs: on && off ? +(off.medianMs - on.medianMs).toFixed(3) : null,
          savedPct: on && off ? +(((off.medianMs - on.medianMs) / off.medianMs) * 100).toFixed(2) : null,
          // Read THIS, not savedMs, to decide whether the row is real.
          paired,
          megapixels: +((r.screenSize.width * r.screenSize.height) / 1e6).toFixed(2),
          internal: [r.screenSize.width, r.screenSize.height],
          slots: e.config.q.pointLightSlots,
        });
      };
      return requestAnimationFrame(settle);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), { FRAMES, WARM, ABLATE });

console.log(JSON.stringify({ ...out, pageErrors: errs.slice(0, 5) }, null, 2));
await browser.close();

/**
 * crsim — what TAA's five-tap Catmull-Rom history resample costs, tap by tap,
 * and what dropping the ones whose weight is already negligible does to the
 * picture.
 *
 * WHY THIS EXISTS
 *   `ow-taa` is the largest single item in the post chain -- 64.5 M of 343.5 M
 *   fetches, 18.8 %, at 19.3 real fetches per fragment with essentially no
 *   early-out left (`boundOverstatesBy 1.09`). Five of those nineteen are
 *   `sampleCatmullRom`, and four of the five are the filter's negative lobes.
 *
 *   The lobes have the one property that made `SK_VOL_TAP_TIER` work in
 *   volumetrics.js: THEIR WEIGHT IS KNOWN BEFORE THE FETCH. `sampleCatmullRom`
 *   computes wa..we from the fractional sample position alone, several lines
 *   before it touches the texture. So the question "is this tap worth its
 *   fetch" is answerable at zero cost, per pixel, per tap.
 *
 * THE ARITHMETIC THAT MAKES THE LOBES SMALL, and why the threshold has a
 * natural scale rather than a taste
 *   Writing the cubic weights in factored form:
 *
 *     w0  = -0.5 * f * ( 1 - f )^2        w3  = -0.5 * f^2 * ( 1 - f )
 *     w12 =  1 + 0.5 * f * ( 1 - f )      w0 + w12 + w3 = 1  exactly
 *
 *   so w0 and w3 are NON-POSITIVE everywhere on f in [0,1), each peaks at
 *   0.07407 (at f = 1/3 and f = 2/3), and both are exactly zero at f = 0 and
 *   f = 1. The four lobe weights are wa = w12x*w0y, wb = w0x*w12y,
 *   wd = w3x*w12y, we = w12x*w3y, and w12 is in [1, 1.125], so a lobe carries at
 *   most 0.0833 of the filter.
 *
 *   THE SHIPPED FILTER IS ALREADY A RENORMALISED SUBSET. A full bicubic is 16
 *   taps; the five-tap form drops the four CORNERS, whose weights are products
 *   of two lobes -- up to 0.0055 each and up to 0.0156 together -- and divides
 *   by the surviving `wsum` to put the mass back. That is not incidental, it is
 *   the same mechanism this study proposes to use once more, and it is why the
 *   division by `wsum` is already in the shader rather than being added by it.
 *   It also fixes the scale of the question: a lobe dropped at a threshold
 *   comparable to 0.0156 is dropped at the accuracy the filter already has.
 *
 * WHAT IS MEASURED, AND WHY IT IS TWO DIFFERENT THINGS
 *   The SAVING is pure geometry and is computed exactly. `f` comes from the
 *   history sample position `huv`, which taasim.mjs reproduces from depth,
 *   coverage and the two camera matrices -- colour never enters it. So "how
 *   many taps fall under the threshold on this frame" is a count, not a model.
 *
 *   The COST is a picture question and is measured the way upsim.mjs measures
 *   the upscaler, against a supersampled reference:
 *     source     render at ss x display, box down to display. A converged TAA
 *                history IS an accumulating supersampler, so this is what the
 *                filter reads on every frame but the first after a cut.
 *     truth      the SAME supersampled render, box-averaged at the warped
 *                position instead of at the pixel grid. That is what an ideal
 *                resampler would return, so both filters can be scored against
 *                something neither of them is.
 *     candidates the shipped 5-tap, the tiered 5-tap at each threshold, the
 *                centre tap alone, and a plain bilinear tap at huv.
 *
 *   THE WARP IS A SOURCE OF REALISTIC FRACTIONAL OFFSETS, NOT A SIMULATION OF
 *   ACCUMULATION. One frame is rendered and resampled by the frame's own
 *   velocity field; nothing here iterates a history over time. What that buys
 *   over sweeping f on a grid is the real joint distribution of (fx, fy) and
 *   the real spatial coherence of it, which is what decides both how often the
 *   branch is taken and whether the error lands in flat regions or on edges.
 *
 * WHAT IT CANNOT TELL YOU
 *   Nothing in ms, as ever. And the flat-shaded rasteriser has no textures, so
 *   the source carries hard geometric edges on smooth interiors and nothing in
 *   between -- which for a RECONSTRUCTION filter is the hard case, the same
 *   argument upsim.mjs makes for itself, but it is an argument and not a proof.
 */
import * as THREE from 'three';
import { renderShot } from './raster.mjs';
import { buildTaaField, PATTERNS } from './taasim.mjs';
import { boxDown, bl, displayEncode, toLuma, sobel, metrics } from './upsim.mjs';

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ---------------------------------------------------------------------------
//  the filter, in the shader's own form
// ---------------------------------------------------------------------------

/**
 * The four lobe weights and the centre weight, exactly as sampleCatmullRom
 * computes them, plus the offset that turns texels 1 and 2 into one bilinear
 * tap.
 *
 * Written as the shader writes it -- the polynomials, not the factored form in
 * the header -- so that a change to one is visible as a difference from the
 * other rather than hidden behind an algebraic identity.
 */
function crWeights(f) {
  const w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  const w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  const w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  const w3 = f * f * (-0.5 + 0.5 * f);
  const w12 = w1 + w2;
  return { w0, w3, w12, offset12: w2 / Math.max(w12, 1e-5) };
}

/**
 * `sampleCatmullRom( tex, uv )` with the tier.
 *
 * `theta` 0 keeps every tap and must reproduce the shipped filter to the last
 * bit -- that is the harness anchor, checked in the result as `anchorTheta0`.
 * `theta` above 0.0834 drops all four lobes on every pixel and leaves the
 * centre tap alone, which is NOT the same thing as a bilinear tap at `uv`: the
 * centre tap sits at texPos12, offset from uv by w2/w12 - f texels. Both are
 * reported, and they are different filters.
 */
function sampleCR(img, u, v, theta, out, counts, corners = false) {
  const texW = img.w, texH = img.h;
  const spx = u * texW, spy = v * texH;
  const tp1x = Math.floor(spx - 0.5) + 0.5, tp1y = Math.floor(spy - 0.5) + 0.5;
  const fx = spx - tp1x, fy = spy - tp1y;
  const X = crWeights(fx), Y = crWeights(fy);

  const p0x = (tp1x - 1.0) / texW, p0y = (tp1y - 1.0) / texH;
  const p3x = (tp1x + 2.0) / texW, p3y = (tp1y + 2.0) / texH;
  const p12x = (tp1x + X.offset12) / texW, p12y = (tp1y + Y.offset12) / texH;

  const wa = X.w12 * Y.w0, wb = X.w0 * Y.w12;
  const wc = X.w12 * Y.w12;
  const wd = X.w3 * Y.w12, we = X.w12 * Y.w3;

  let r = 0, g = 0, b = 0, wsum = 0;
  const t = [0, 0, 0];
  const add = (uu, vv, w) => {
    if (Math.abs(w) <= theta) { if (counts) counts.dropped++; return; }
    if (counts) counts.kept++;
    bl(img, uu, vv, t);
    r += t[0] * w; g += t[1] * w; b += t[2] * w; wsum += w;
  };
  // Same order as the shader, so the float accumulation matches at theta 0.
  add(p12x, p0y, wa);
  add(p0x, p12y, wb);
  // The centre is never a candidate: w12 >= 1 on both axes, so wc >= 1.
  bl(img, p12x, p12y, t);
  r += t[0] * wc; g += t[1] * wc; b += t[2] * wc; wsum += wc;
  if (counts) counts.kept++;
  add(p3x, p12y, wd);
  add(p12x, p3y, we);

  // The four taps the SHIPPED filter drops, kept, which makes this the whole
  // sixteen-tap Catmull-Rom -- the middle pairs are bilinear-combined on both
  // axes, which is exact, so nine fetches carry all sixteen weights and they sum
  // to ( w0 + w12 + w3 )^2 = 1 with nothing to renormalise.
  if (corners) {
    add(p0x, p0y, X.w0 * Y.w0);
    add(p3x, p0y, X.w3 * Y.w0);
    add(p0x, p3y, X.w0 * Y.w3);
    add(p3x, p3y, X.w3 * Y.w3);
  }

  const inv = 1 / Math.max(wsum, 1e-5);
  out[0] = r * inv; out[1] = g * inv; out[2] = b * inv;
}

/**
 * The true image content at an arbitrary sub-pixel position: a box of one
 * DISPLAY pixel, laid over the supersampled render at `u, v` instead of on the
 * pixel grid.
 *
 * This is the same filter `boxDown` applies to build the source, moved off the
 * grid. Using anything wider would prefilter the truth and flatter every
 * candidate; using a point sample would compare a reconstruction against an
 * aliased sample and flatter none of them fairly.
 */
function boxAt(hi, u, v, ssx, ssy, out) {
  const cx = u * hi.w, cy = v * hi.h;
  const x0 = cx - ssx * 0.5, x1 = cx + ssx * 0.5;
  const y0 = cy - ssy * 0.5, y1 = cy + ssy * 0.5;
  const ix0 = Math.floor(x0), ix1 = Math.ceil(x1);
  const iy0 = Math.floor(y0), iy1 = Math.ceil(y1);
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let y = iy0; y < iy1; y++) {
    const wy = Math.min(y + 1, y1) - Math.max(y, y0);
    if (wy <= 0) continue;
    const yy = y < 0 ? 0 : y > hi.h - 1 ? hi.h - 1 : y;
    for (let x = ix0; x < ix1; x++) {
      const wx = Math.min(x + 1, x1) - Math.max(x, x0);
      if (wx <= 0) continue;
      const xx = x < 0 ? 0 : x > hi.w - 1 ? hi.w - 1 : x;
      const w = wx * wy, s = (yy * hi.w + xx) * 3;
      r += hi.c[s] * w; g += hi.c[s + 1] * w; b += hi.c[s + 2] * w; wsum += w;
    }
  }
  const inv = 1 / Math.max(wsum, 1e-9);
  out[0] = r * inv; out[1] = g * inv; out[2] = b * inv;
}

// ---------------------------------------------------------------------------
//  part one: how many taps fall under the threshold, exactly
// ---------------------------------------------------------------------------

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * sorted.length) - 1));
  return sorted[k];
}

/**
 * The saving, counted rather than modelled.
 *
 * ON WHICH GRID `f` IS EVALUATED, because getting this wrong would be invisible
 * and wrong by a factor. The off-screen band taa.js early-outs on is a region in
 * UV SPACE and is therefore the same fraction at any simulation resolution --
 * fillsim.mjs says so and relies on it. `f` is not: it is
 * `fract( huv * uResolution - 0.5 )`, so it lives on the PASS's texel grid and
 * has to be taken against the pass's own width and height whatever grid the
 * `huv` field was sampled on. The coarse grid still gives an unbiased sample of
 * the DISTRIBUTION of f, because neighbouring coarse samples are several pass
 * texels apart and f has cycled in between; what it must not do is supply the
 * texel size.
 */
function measureTierFrequency(field, { resW, resH, thetas }) {
  const { n, width, height, dilate, resolve } = field;
  const { hx, hy } = resolve(dilate(PATTERNS.x5));

  const counters = thetas.map(() => ({ dropped: 0, all4: 0, none: 0, mass: 0 }));
  let onScreen = 0;
  const fxHist = new Float64Array(20), fyHist = new Float64Array(20);
  let lobeMassSum = 0, cornerMassSum = 0;

  for (let i = 0; i < n; i++) {
    // The shader returns before sampleCatmullRom on these, so they are not part
    // of the population the threshold can save anything on.
    if (hx[i] < 0 || hx[i] > 1 || hy[i] < 0 || hy[i] > 1) continue;
    onScreen++;

    const spx = hx[i] * resW, spy = hy[i] * resH;
    const fx = spx - (Math.floor(spx - 0.5) + 0.5);
    const fy = spy - (Math.floor(spy - 0.5) + 0.5);
    fxHist[Math.min(19, (fx * 20) | 0)]++;
    fyHist[Math.min(19, (fy * 20) | 0)]++;

    const X = crWeights(fx), Y = crWeights(fy);
    const w = [
      Math.abs(X.w12 * Y.w0), Math.abs(X.w0 * Y.w12),
      Math.abs(X.w3 * Y.w12), Math.abs(X.w12 * Y.w3),
    ];
    lobeMassSum += w[0] + w[1] + w[2] + w[3];
    // What the five-tap form already throws away: the four corners of the full
    // bicubic, whose weights are the products of the two axes' lobes.
    cornerMassSum += (Math.abs(X.w0) + Math.abs(X.w3)) * (Math.abs(Y.w0) + Math.abs(Y.w3));

    for (let k = 0; k < thetas.length; k++) {
      const th = thetas[k], c = counters[k];
      let d = 0, m = 0;
      for (let j = 0; j < 4; j++) if (w[j] <= th) { d++; m += w[j]; }
      c.dropped += d; c.mass += m;
      if (d === 4) c.all4++;
      if (d === 0) c.none++;
    }
  }

  const norm = (h) => Array.from(h, (v) => +(v / Math.max(1, onScreen)).toFixed(4));
  return {
    note: 'Counted over the pixels that REACH sampleCatmullRom, i.e. with the off-screen '
      + 'early-out already applied. fetchesSavedPerFragment is therefore per FRAME pixel, '
      + 'directly comparable with the pass\'s realFetchesPerFragment.',
    passResolution: `${resW}x${resH}`,
    simulated: `${width}x${height}`,
    reachedCatmullRomPct: +(100 * onScreen / n).toFixed(3),
    meanLobeMassPerPixel: +(lobeMassSum / Math.max(1, onScreen)).toFixed(5),
    meanCornerMassAlreadyDropped: +(cornerMassSum / Math.max(1, onScreen)).toFixed(5),
    fxHistogram20: norm(fxHist),
    fyHistogram20: norm(fyHist),
    thresholds: thetas.map((th, k) => {
      const c = counters[k];
      const perReached = c.dropped / Math.max(1, onScreen);
      return {
        theta: th,
        tapsDroppedPerReachedPixel: +perReached.toFixed(4),
        fetchesSavedPerFragment: +(perReached * onScreen / n).toFixed(4),
        pctOfLobeMassDropped: +(100 * c.mass / Math.max(1e-9, lobeMassSum)).toFixed(2),
        meanMassDroppedPerPixel: +(c.mass / Math.max(1, onScreen)).toFixed(5),
        allFourDroppedPct: +(100 * c.all4 / Math.max(1, onScreen)).toFixed(3),
        noneDroppedPct: +(100 * c.none / Math.max(1, onScreen)).toFixed(3),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
//  part two: what REPEATED application does, which is the actual risk
// ---------------------------------------------------------------------------

/**
 * TAA resamples its OWN OUTPUT every frame, so a filter that loses a little
 * sharpness per application loses it again on what it lost. A single-resample
 * score cannot see that, and it is the one way this change could be wrong in a
 * way that only shows up after ten seconds of walking.
 *
 * The test is a closed chain: apply the candidate K times at sub-texel
 * displacements drawn uniformly -- which the measured fx/fy histograms say is
 * the real distribution -- and CONSTRAINED TO SUM TO ZERO, so the image ends up
 * back where it started and can be compared with itself. No net translation
 * means the whole difference is the filter's own attenuation.
 *
 * WHAT THIS IS NOT. It is not the feedback loop: there is no `current` term and
 * no variance clip, so it is the pure worst case in which history is resampled
 * K times and re-injected with nothing fresh. The real pass mixes in
 * ( 1 - feedback ) of a newly rendered frame every iteration, which resets the
 * attenuation; at the shipped 0.92, and 0.66 while the camera is turning fast
 * enough for f to be uniform at all, the effective chain length is 12.5 and 3.
 * So K is quoted, and the number that matters is the RATIO between two
 * candidates at the same K, not either one alone.
 *
 * The displacements are integer-plus-fraction on purpose. A pure fractional
 * walk would keep re-sampling the same two texels; the frame's real velocity is
 * tens of texels per frame, so the chain has to move through the image the way
 * the pass does.
 *
 * WHY IT IS AVERAGED OVER SEEDS, and it is not a smoothing of taste. A chain
 * iteration translates the WHOLE image by one displacement, so every pixel in
 * that iteration shares one ( fx, fy ) and therefore one drop decision -- unlike
 * the real warp, where the velocity varies across the frame and f sweeps its
 * whole range within a single frame. A K-iteration chain is thus K samples of
 * the weight distribution, not K x pixels of it, and at K = 8 that is far too
 * few: the first version of this test scored theta 0.020 and 0.025 IDENTICALLY,
 * because none of its eight offsets happened to put a lobe weight between them.
 * S independent seeds make it S*K samples and the spread across seeds is
 * reported so the reader can see whether it converged.
 */
function chainTest(src, K, seed, apply) {
  const disp = [];
  // A deterministic LCG: Math.random would make two runs of the same threshold
  // disagree and the difference would look like a result.
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let sx = 0, sy = 0;
  for (let k = 0; k < K - 1; k++) {
    const dx = (rnd() * 2 - 1) * 12, dy = (rnd() * 2 - 1) * 12;
    disp.push([dx, dy]); sx += dx; sy += dy;
  }
  disp.push([-sx, -sy]);

  let cur = src;
  const o = [0, 0, 0];
  for (let k = 0; k < K; k++) {
    const [dx, dy] = disp[k];
    const next = { w: src.w, h: src.h, c: new Float32Array(src.c.length) };
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const u = (x + 0.5 + dx) / src.w, v = (y + 0.5 + dy) / src.h;
        apply(cur, u, v, o);
        const d = (y * src.w + x) * 3;
        next.c[d] = o[0]; next.c[d + 1] = o[1]; next.c[d + 2] = o[2];
      }
    }
    cur = next;
  }
  return cur;
}

// ---------------------------------------------------------------------------
//  part three: what one application does to the picture
// ---------------------------------------------------------------------------

/**
 * @param engine   a booted engine, already stepped to the frame under test
 * @param opts.W,H display resolution of the study image
 * @param opts.ss  supersample factor; the source and the truth share it
 * @param opts.currVP/prevVP  the matrix pair captured while TAA ran
 */
export function measureCatmullRomTier(engine, opts = {}) {
  const {
    W = 640, H = 416, ss = 3, pre = 0.5,
    thetas = [0.005, 0.01, 0.02, 0.03, 0.04, 0.06],
    resW, resH, freqW = 760, freqH = 494, currVP, prevVP,
  } = opts;

  // ---- the saving: exact, colour-free, on the pass's own texel grid --------
  const t0 = performance.now();
  const freqField = buildTaaField(engine, { width: freqW, height: freqH, currVP, prevVP });
  const frequency = measureTierFrequency(freqField, { resW, resH, thetas });
  const freqMs = performance.now() - t0;

  // ---- the cost: supersampled reference, warped by the same velocity field -
  const t1 = performance.now();
  const hiRaw = renderShot(engine, { width: W * ss, height: H * ss });
  const hi0 = { w: W * ss, h: H * ss, c: hiRaw.rt.color };
  const src0 = boxDown(hi0, ss);

  // Normalise into the range the shader's own thresholds are written for, the
  // same way upsim.mjs does, so displayEncode's tone curve lands where it lands
  // on GPU instead of wherever the flat shader happened to emit.
  const lums = new Float64Array(src0.w * src0.h);
  for (let i = 0; i < lums.length; i++) {
    lums[i] = lum(src0.c[i * 3], src0.c[i * 3 + 1], src0.c[i * 3 + 2]);
  }
  const sorted = Array.from(lums).sort((a, b) => a - b);
  const norm = pre / (sorted[Math.floor(sorted.length * 0.9)] || 1);
  const scaleImg = (img) => {
    const c = new Float32Array(img.c.length);
    for (let i = 0; i < c.length; i++) c[i] = img.c[i] * norm;
    return { w: img.w, h: img.h, c };
  };
  const hi = scaleImg(hi0), src = scaleImg(src0);
  const renderMs = performance.now() - t1;

  // The warp, from the frame's own reprojection at the study resolution.
  const field = buildTaaField(engine, { width: W, height: H, currVP, prevVP });
  const { hx, hy } = field.resolve(field.dilate(PATTERNS.x5));

  const mk = () => ({ w: W, h: H, c: new Float32Array(W * H * 3) });
  const truth = mk(), shipped = mk(), centreOnly = mk(), bilin = mk(), bicubic9 = mk();
  const tiered = thetas.map(() => mk());
  const tapCounts = thetas.map(() => ({ kept: 0, dropped: 0 }));
  const shippedCount = { kept: 0, dropped: 0 };

  const o = [0, 0, 0];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  for (let i = 0; i < W * H; i++) {
    // Clamped, not skipped: a pixel whose history left the frame is one the
    // shader never asks this filter about, and the band is 2.3 % of it. Clamping
    // keeps every pixel a valid resample question and asks the same one of every
    // candidate. The SAVING above is the number that honours the early-out.
    const u = clamp01(hx[i]), v = clamp01(hy[i]);
    const d = i * 3;
    boxAt(hi, u, v, ss, ss, o); truth.c[d] = o[0]; truth.c[d + 1] = o[1]; truth.c[d + 2] = o[2];
    sampleCR(src, u, v, 0, o, shippedCount);
    shipped.c[d] = o[0]; shipped.c[d + 1] = o[1]; shipped.c[d + 2] = o[2];
    sampleCR(src, u, v, 0, o, null, true);
    bicubic9.c[d] = o[0]; bicubic9.c[d + 1] = o[1]; bicubic9.c[d + 2] = o[2];
    sampleCR(src, u, v, 1, o, null);
    centreOnly.c[d] = o[0]; centreOnly.c[d + 1] = o[1]; centreOnly.c[d + 2] = o[2];
    bl(src, u, v, o);
    bilin.c[d] = o[0]; bilin.c[d + 1] = o[1]; bilin.c[d + 2] = o[2];
    for (let k = 0; k < thetas.length; k++) {
      sampleCR(src, u, v, thetas[k], o, tapCounts[k]);
      tiered[k].c[d] = o[0]; tiered[k].c[d + 1] = o[1]; tiered[k].c[d + 2] = o[2];
    }
  }

  // ---- scoring -------------------------------------------------------------
  const truthD = displayEncode(truth);
  const refL = toLuma(truthD);
  const refEdge = sobel(refL, W, H);
  let refEdgeSum = 0;
  for (let i = 0; i < refEdge.length; i++) refEdgeSum += refEdge[i];

  const shippedD = displayEncode(shipped);

  /** How far a candidate moves the frame the shipped filter would have drawn. */
  const vsShipped = (candD) => {
    const n = W * H * 3;
    const diffs = new Float64Array(W * H);
    let sum = 0, mx = 0, over1 = 0, over2 = 0;
    for (let i = 0; i < W * H; i++) {
      let dm = 0;
      for (let k = 0; k < 3; k++) dm = Math.max(dm, Math.abs(candD.c[i * 3 + k] - shippedD.c[i * 3 + k]));
      diffs[i] = dm; sum += dm;
      if (dm > mx) mx = dm;
      if (dm * 255 > 1) over1++;
      if (dm * 255 > 2) over2++;
    }
    diffs.sort();
    void n;
    return {
      meanCodeValues: +(255 * sum / (W * H)).toFixed(4),
      p99CodeValues: +(255 * pct(diffs, 99)).toFixed(3),
      maxCodeValues: +(255 * mx).toFixed(3),
      pctOverOneCodeValue: +(100 * over1 / (W * H)).toFixed(3),
      pctOverTwoCodeValues: +(100 * over2 / (W * H)).toFixed(3),
    };
  };

  const arm = (label, img, extra = {}) => {
    const d = displayEncode(img);
    return { label, ...metrics(d, truthD, refEdge, refEdgeSum), vsShipped: vsShipped(d), ...extra };
  };

  const arms = [
    // The scale anchor, and it has to be read the right way round: this arm's
    // `vsShipped` row is the error the SHIPPED five-tap already accepts by
    // dropping the four bicubic corners. A threshold whose row is comparable is
    // a threshold inside the accuracy the filter already has.
    arm('bicubic 9 (corners kept)', bicubic9),
    arm('catmull-rom 5 (shipped)', shipped),
    ...thetas.map((th, k) => arm(`tiered theta=${th}`, tiered[k], {
      tapsPerPixel: +((tapCounts[k].kept) / (W * H)).toFixed(4),
      lobesDroppedPerPixel: +((tapCounts[k].dropped) / (W * H)).toFixed(4),
    })),
    arm('centre tap only (theta=inf)', centreOnly),
    arm('plain bilinear at huv', bilin),
  ];

  // ---- the chain: what K resamples of its own output do to each candidate --
  const chainK = opts.chainK ?? 8;
  const srcD = displayEncode(src);
  const srcL = toLuma(srcD);
  const srcEdge = sobel(srcL, W, H);
  let srcEdgeSum = 0;
  for (let i = 0; i < srcEdge.length; i++) srcEdgeSum += srcEdge[i];
  const chainSeeds = opts.chainSeeds ?? 6;
  const chainArm = (label, apply) => {
    const acc = [];
    for (let s = 0; s < chainSeeds; s++) {
      const d = displayEncode(chainTest(src, chainK, 0x5eed + s * 0x9e3779b9, apply));
      acc.push(metrics(d, srcD, srcEdge, srcEdgeSum));
    }
    const mean = (k) => acc.reduce((a, m) => a + m[k], 0) / acc.length;
    const sh = acc.map((m) => m.sharpness);
    return {
      label,
      psnr: +mean('psnr').toFixed(3),
      edgePsnr: +mean('edgePsnr').toFixed(3),
      ssim: +mean('ssim').toFixed(5),
      sharpness: +mean('sharpness').toFixed(4),
      sharpnessSpread: +(Math.max(...sh) - Math.min(...sh)).toFixed(4),
    };
  };
  const chain = chainK > 0 ? {
    note: `Each candidate applied ${chainK} times to its own output, at sub-texel `
      + 'displacements summing to zero so there is no net translation to confuse the '
      + 'comparison, averaged over independent seeds. Scored against the UNRESAMPLED '
      + 'source, so sharpness is the surviving fraction of the frame\'s edge energy. No '
      + '`current` term and no variance clip: this is history with nothing fresh mixed in, '
      + 'which is strictly worse than the pass. Read the RATIO between candidates, and '
      + 'read sharpnessSpread before believing a gap smaller than it.',
    iterations: chainK,
    seeds: chainSeeds,
    arms: [
      chainArm('bicubic 9 (corners kept)', (im, u, v, o) => sampleCR(im, u, v, 0, o, null, true)),
      chainArm('catmull-rom 5 (shipped)', (im, u, v, o) => sampleCR(im, u, v, 0, o, null)),
      ...thetas.map((th) => chainArm(`tiered theta=${th}`, (im, u, v, o) => sampleCR(im, u, v, th, o, null))),
      chainArm('centre tap only (theta=inf)', (im, u, v, o) => sampleCR(im, u, v, 1, o, null)),
      chainArm('plain bilinear', (im, u, v, o) => bl(im, u, v, o)),
    ],
  } : null;

  // Anchors. The first must be exact or the harness is measuring itself; the
  // second states plainly that the last two arms are different filters, because
  // "drop every lobe" leaves a tap at texPos12 and not at huv.
  const zero = arms.find((a) => a.label === 'catmull-rom 5 (shipped)');
  return {
    display: `${W}x${H}`, supersample: ss, preExposureP90: pre,
    freqMs: +freqMs.toFixed(0), renderMs: +renderMs.toFixed(0),
    anchors: {
      theta0IsShipped: zero.vsShipped.maxCodeValues === 0,
      note: 'theta = 0 keeps every tap and must be bit-identical to the shipped filter; if '
        + 'theta0IsShipped is false the harness is not running the shader\'s filter. '
        + 'The centre-tap-only arm is NOT the bilinear arm: dropping every lobe leaves the '
        + 'tap at texPos12, which is offset from huv by w2/w12 - f texels, so the two are '
        + 'different filters and the gap between them is the offset, not the lobes.',
      shippedTapsPerPixel: +(shippedCount.kept / (W * H)).toFixed(3),
    },
    frequency,
    arms,
    chain,
  };
}

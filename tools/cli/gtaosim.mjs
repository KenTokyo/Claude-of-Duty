/**
 * gtaosim — what GTAO's eight steps per slice actually reach on the depth
 * texture, and therefore whether skipping the ones that land on a texel already
 * read is worth anything.
 *
 * WHY THIS EXISTS
 *   `ow-gtao` is 24.9 M of 340.2 M fetches, 7.3 %, at 29.8 real fetches per
 *   fragment, and 48 of the 50 a covered pixel pays are the sample loop:
 *   3 slices x 8 steps x 2 directions. There is no early-out left in it -- the
 *   two bounds tests inside the loop skip arithmetic, not fetches -- so the
 *   only lever is the step count, and the only honest way to pull it is to find
 *   a step that provably reads something already in hand.
 *
 * THE IDEA UNDER TEST, stated so it can fail
 *   The step offset is
 *
 *     ft  = ( t + noise2 ) / 8            off = radiusPx * ft^2 + 1
 *
 *   which is quadratic, so the first steps are packed towards the origin: at
 *   radiusPx = 6 they sit at 1.02, 1.21, 1.59, 2.15 px and the first three span
 *   0.6 px. tDepth is NearestFilter, so two taps inside one texel return the
 *   same number and the second one buys a slightly different reconstruction of
 *   a depth sample already held. Skipping it would save 6 fetches -- one step is
 *   2 directions x 3 slices, since `off` does not depend on the slice.
 *
 *   THIS IS NOT THE `offMax` EARLY-OUT REJECTED IN 2016 AND RECORDED IN
 *   gtao.js. That was a world-radius argument -- can this tap possibly land
 *   inside the AO radius -- and it fired on 0.00 % because the clamp keeps the
 *   disc well inside the radius at every depth. This is a texel-grid argument
 *   and has nothing to do with the radius; it fails or succeeds on the
 *   distribution of radiusPx alone.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID
 *   `off` is measured in the PASS's texels -- duv = dir2 * off * uTexel and
 *   uTexel is 1/1134, 1/736 -- but tDepth is the FULL-RESOLUTION gbuffer depth,
 *   2268 x 1473, because aoScale is 0.5 and only the AO chain is downsampled.
 *   One pass texel is therefore TWO depth texels, and a gap that looks
 *   sub-texel in the pass's own units is a full texel on the texture being
 *   fetched. Thresholds here are quoted in DEPTH texels for that reason, and
 *   the ratio is read off the two live uniforms rather than assumed to be 2.
 *
 * WHAT IS EXACT HERE AND WHAT IS NOT
 *   Exact: radiusPx, the eight offsets, the per-pixel dither `noise2` (the
 *          engine's own owHash12, ported, evaluated at the pass's fragcoord),
 *          the clamp, and the skip decision. All of these are closed-form
 *          functions of depth and uniforms read off the running engine.
 *   Not:   the depth field is rasterised at the requested grid and the pass
 *          runs at 1134 x 736. radiusPx depends on depth only, so its
 *          distribution is sampled rather than reproduced pixel for pixel --
 *          which is what a distribution needs. The TEXEL SIZE never comes from
 *          this grid; it comes from the uniforms.
 *   Absent: what skipping does to the picture. That is a separate question and
 *          is only worth asking if the saving here is not zero.
 */
import * as THREE from 'three';
import { renderGBuffer } from './fillsim.mjs';

const fract = (x) => x - Math.floor(x);

/** `owHash12` from src/render/glsl.js, the dither that jitters the step ladder. */
function owHash12(px, py) {
  // p3 = fract( vec3( p.xyx ) * 0.1031 ), so the third component IS the first.
  let x = fract(px * 0.1031); let y = fract(py * 0.1031); let z = x;
  // dot( p3, p3.yzx + 33.33 ), added to every component WITHOUT a second fract.
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}

/**
 * How many of the eight steps land within `gap` DEPTH texels of the last step
 * that was kept, for one value of radiusPx and one dither.
 *
 * The ladder is monotone in t, so "the last kept step" is the only thing a
 * candidate has to be compared against -- there is no earlier step it could be
 * closer to. `keep` is therefore a single running value and the rule is a
 * `continue`, which is what makes it cheap enough to put in the inner loop of
 * the hottest shader in the frame.
 */
function skipCount(radiusPx, noise2, gapPx, steps, pxPerDepthTexel) {
  let lastF2 = -1e9, skipped = 0;
  for (let t = 0; t < steps; t++) {
    const ft = (t + noise2) / steps;
    const f2 = ft * ft;
    // The gap between two steps in DEPTH texels: the offsets differ by
    // radiusPx * ( f2 - lastF2 ) pass texels, and one pass texel spans
    // `pxPerDepthTexel` of them.
    if (radiusPx * (f2 - lastF2) * pxPerDepthTexel < gapPx) { skipped++; continue; }
    lastF2 = f2;
  }
  return skipped;
}

/**
 * The saving, counted over the real depth field.
 *
 * Reported per GTAO FRAGMENT rather than per covered pixel, so that it
 * subtracts directly from the pass's realFetchesPerFragment -- which is what
 * `fill --real` quotes and what any claim about the chain has to be made in.
 */
export function measureGtaoSteps(engine, {
  width = 480, height = 300, gaps = [0.5, 1, 1.5, 2],
} = {}) {
  const render = engine.ctx.peek('render');
  const gtao = render?.gtao;
  if (!gtao) return { unavailable: 'GTAO is off in this preset' };

  const cu = gtao.core.uniforms;
  const radius = cu.uParams.value.x;
  const frame = cu.uParams.value.z;
  const p11 = cu.uP11.value;
  const passW = cu.uResolution.value.x, passH = cu.uResolution.value.y;
  const SLICES = 3, STEPS = 8;

  // The depth texture the loop actually fetches, and how many of its texels one
  // pass texel spans. Read off the bound texture rather than derived from
  // aoScale: the two can disagree, and the one that decides the answer is the
  // one that is bound.
  const dTex = cu.tDepth.value;
  const depthW = dTex?.image?.width ?? 0, depthH = dTex?.image?.height ?? 0;
  const ratioX = depthW > 0 ? depthW / passW : 1;
  const ratioY = depthH > 0 ? depthH / passH : 1;
  // The step runs along dir2, a unit vector, so its footprint on the depth grid
  // is between ratioX and ratioY. The SMALLER one is the conservative choice:
  // it is the direction in which a given gap covers the fewest depth texels, so
  // using it never claims two taps share a texel when they might not.
  const pxPerDepthTexel = Math.min(ratioX, ratioY);

  const g = renderGBuffer(engine, width, height);
  const n = width * height;

  const rHist = new Float64Array(16);   // radiusPx, log-ish buckets
  const dHist = new Float64Array(16);   // depth, metres
  let covered = 0, rSum = 0, atFloor = 0, atCeil = 0;
  const skipped = gaps.map(() => 0);
  const allEight = gaps.map(() => 0);

  const sx = passW / width, sy = passH / height;
  for (let i = 0; i < n; i++) {
    if (!g.covered[i] || !(g.depth[i] > 0)) continue;
    covered++;
    const depth = g.depth[i];
    // radiusPx uses the PASS's height, never this grid's.
    let radiusPx = radius * p11 * 0.5 * passH / Math.max(0.2, depth);
    if (radiusPx < 6) { radiusPx = 6; atFloor++; } else if (radiusPx > 128) { radiusPx = 128; atCeil++; }
    rSum += radiusPx;
    rHist[Math.min(15, Math.max(0, Math.floor(Math.log2(radiusPx) * 2)))]++;
    dHist[Math.min(15, Math.floor(depth / 10))]++;

    // gl_FragCoord in the PASS's pixels, which is what the dither is evaluated
    // against in the shader; a fragcoord taken from this grid would give the
    // hash the wrong statistics.
    const x = (i % width) + 0.5, y = ((i / width) | 0) + 0.5;
    const noise2 = owHash12(x * sx * 0.371 + frame, y * sy * 0.371 + frame);

    for (let k = 0; k < gaps.length; k++) {
      const s = skipCount(radiusPx, noise2, gaps[k], STEPS, pxPerDepthTexel);
      skipped[k] += s;
      if (s === STEPS - 1) allEight[k]++;
    }
  }

  const norm = (h) => Array.from(h, (v) => +(v / Math.max(1, covered)).toFixed(4));
  return {
    note: 'Steps whose offset lands within `gapDepthTexels` of the last kept step, counted '
      + 'over the covered pixels of the real depth field. One skipped step is 6 fetches '
      + `(${SLICES} slices x 2 directions), because \`off\` does not depend on the slice.`,
    passResolution: `${passW}x${passH}`,
    depthTextureResolution: `${depthW}x${depthH}`,
    passTexelsPerDepthTexel: +pxPerDepthTexel.toFixed(4),
    simulated: `${width}x${height}`,
    aoRadiusM: radius,
    coveredPct: +(100 * covered / n).toFixed(2),
    meanRadiusPx: +(rSum / Math.max(1, covered)).toFixed(2),
    pctAtClampFloor6: +(100 * atFloor / Math.max(1, covered)).toFixed(3),
    pctAtClampCeil128: +(100 * atCeil / Math.max(1, covered)).toFixed(3),
    radiusPxHistogramLog2Half: norm(rHist),
    depthHistogram10m: norm(dHist),
    gaps: gaps.map((gp, k) => ({
      gapDepthTexels: gp,
      stepsSkippedPerCoveredPixel: +(skipped[k] / Math.max(1, covered)).toFixed(4),
      fetchesSavedPerFragment: +(6 * skipped[k] / n).toFixed(4),
      pctOfLoopSaved: +(100 * skipped[k] / Math.max(1, covered * STEPS)).toFixed(3),
      sevenOfEightSkippedPct: +(100 * allEight[k] / Math.max(1, covered)).toFixed(3),
    })),
  };
}

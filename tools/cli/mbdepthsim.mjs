/**
 * What motion blur's depth weight does when the depth arrives through a
 * LINEAR filter instead of a NEAREST one.
 *
 * src/render/taa.js publishes 1/viewDepth in the resolve target's alpha, and
 * src/render/motionblur.js reads it there instead of taking a second
 * full-resolution fetch off the depth attachment per tap. That is worth 29 M
 * fetches a frame, and it is only worth taking if the weight it feeds does not
 * move. The depth attachment is NearestFilter, the resolve target is
 * LinearFilter, and the sample loop reads at arbitrary sub-texel offsets, so
 * the two are NOT the same number and no amount of prose settles by how much.
 * This walks the pass's real tap set and measures it.
 *
 * WHAT IS EXACT HERE
 *   The weight function, the tap positions, the streak-length tap rule and the
 *   jitter are the shader's own, read off the compiled source where they are
 *   numbers the shader could change. Both arms are evaluated at the same uv
 *   from the same rasterised depth buffer, so the difference reported is the
 *   filter and nothing else. The alpha arm quantises 1/d to half float first,
 *   because that is what the target stores.
 *
 * WHAT IS NOT
 *   The depth buffer is rasterised at the simulation resolution, not the pass
 *   resolution, so a sub-texel offset here spans more world than it does in
 *   the real pass. That makes discontinuities LARGER relative to a texel and
 *   therefore over-states the disagreement -- run the resolution study
 *   (--study) and watch it fall. Velocity is camera reprojection of static
 *   geometry, the same limitation fillsim.mjs carries; and the tap direction
 *   is the pixel's OWN velocity rather than the tile-dilated one, because the
 *   dilated vector is a bracket (see the ow-mb note in fillsim.mjs) and this
 *   measurement needs a definite direction rather than a range.
 *
 * THE HEADLINE NUMBER IS THE WEIGHT MASS THAT MOVES, not a mean error.
 * The blur output is a convex combination sum( w_i c_i ) / sum( w_i ), so
 * rewriting the weights moves the result inside the convex hull of the colours
 * under the streak. If p and q are the two normalised weightings, the output
 * cannot move further than
 *     0.5 * sum | p_i - q_i |   times   ( brightest - darkest colour on the streak )
 * which is the total-variation distance between them. It needs no colour to
 * compute, it is a real bound rather than an average, and 0.004 means "at most
 * 0.4 % of the local contrast".
 */
import * as THREE from 'three';
import { renderGBuffer } from './fillsim.mjs';

/** Interleaved gradient noise, exactly as owIGN in src/render/glsl.js. */
const ign = (x, y) => {
  const t = (x * 0.06711056 + y * 0.00583715) % 1;
  const v = (52.9829189 * t) % 1;
  return v < 0 ? v + 1 : v;
};

const gsmooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// The target is HalfFloatType, so what the texture unit filters is the rounded
// value, not the float the shader wrote. Float16Array does the rounding the
// hardware does, which is nearer than any hand-rolled bit twiddle.
const _h = new Float16Array(1);
const half = (x) => { _h[0] = x; return _h[0]; };

const quantile = (sorted, q) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const pct = (a, b) => +(100 * a / Math.max(1, b)).toFixed(3);

/**
 * @param mb  the snapshot cmdFill/cmdFillcost take while MotionBlur.render is
 *   on the stack: { shutter, currVP, prevVP }.
 */
export function measureMbDepth(engine, { width = 760, height = 476, mb } = {}) {
  const render = engine.ctx.peek('render');
  const blur = render?.motionBlur?.blurPass;
  if (!blur || !mb) return { unavailable: 'motion blur is off in this preset, or its matrices were not captured' };

  const src = blur.material.fragmentShader;
  const MB_TAPS = Number(/#define\s+OW_MB_TAPS\s+(\d+)/.exec(src)?.[1] ?? 12);
  const res = blur.uniforms.uResolution.value;
  const maxPx = blur.uniforms.uParams.value.y;
  // The frame counter the pass had when the snapshot was taken drives the
  // jitter; uParams.z is that value already reduced mod 64 by the caller.
  const frameSeed = blur.uniforms.uParams.value.z;

  const camera = engine.camera;
  const { depth, covered } = renderGBuffer(engine, width, height);
  const n = width * height;

  // 1 / d as the alpha channel holds it, half-rounded, sky exactly 0.
  const inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = depth[i] > 0 ? half(1 / depth[i]) : 0;

  const clampi = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  const nearestDepth = (u, v) => {
    const x = clampi(Math.floor(u * width), width - 1);
    const y = clampi(Math.floor(v * height), height - 1);
    return depth[y * width + x];
  };
  // texture2D on a LinearFilter, ClampToEdge target, written out rather than
  // approximated: the offsets this pass uses are sub-texel by construction and
  // rounding them to a texel here would measure the wrong thing.
  const bilinearInv = (u, v) => {
    const px = u * width - 0.5, py = v * height - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const xa = clampi(x0, width - 1), xb = clampi(x0 + 1, width - 1);
    const ya = clampi(y0, height - 1), yb = clampi(y0 + 1, height - 1);
    const a = inv[ya * width + xa], b = inv[ya * width + xb];
    const c = inv[yb * width + xa], d = inv[yb * width + xb];
    const top = a + (b - a) * fx, bot = c + (d - c) * fx;
    // The four texels the blend is a convex combination of, kept alongside so
    // the monotonicity claim below can be checked rather than assumed.
    return {
      value: top + (bot - top) * fy,
      lo: Math.min(a, b, c, d),
      hi: Math.max(a, b, c, d),
    };
  };

  // The shader's weight, given a depth and the centre depth.
  const weightOf = (d, cd, t) => {
    const dd = d <= 0 ? 1e5 : d;
    const w0 = 1 - gsmooth(0, 1.5, (dd - cd) / Math.max(1, cd));
    return (0.15 + 0.85 * Math.min(1, Math.max(0, w0))) * (1 - t * 0.35);
  };

  // Per-pixel screen velocity in UV, from camera reprojection -- the same
  // reconstruction fillsim.mjs uses, kept in UV so it is resolution-free.
  // Same ray construction as fillsim.mjs: z = -1 so dir * depth is the
  // view-space position without a second reconstruction.
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = camera.aspect;
  const wp = new THREE.Vector4();
  const dir = new THREE.Vector3();
  const cvec = new THREE.Vector4(), pvec = new THREE.Vector4();

  const tvAll = [];
  let blurred = 0, taps = 0, tapsMoved = 0, tapsBothSaturated = 0;
  let sumAbsDw = 0, maxAbsDw = 0;
  let tapsOppositeSide = 0;
  const dwMoved = [];

  for (let i = 0; i < n; i++) {
    if (!covered[i] || depth[i] <= 0) continue;
    const px = i % width, py = (i / width) | 0;
    const u = (px + 0.5) / width, v = (py + 0.5) / height;

    // View ray through this pixel, then world, then both frames' clip space.
    dir.set((u * 2 - 1) * tanY * aspect, (v * 2 - 1) * tanY, -1);
    wp.set(dir.x * depth[i], dir.y * depth[i], -depth[i], 1).applyMatrix4(camera.matrixWorld);
    cvec.copy(wp).applyMatrix4(mb.currVP);
    pvec.copy(wp).applyMatrix4(mb.prevVP);
    const cw = Math.max(1e-6, cvec.w), pw = Math.max(1e-6, pvec.w);
    let velU = (cvec.x / cw - pvec.x / pw) * 0.5 * mb.shutter;
    let velV = (cvec.y / cw - pvec.y / pw) * 0.5 * mb.shutter;

    // `pixels` is the shader's, so it uses the REAL pass resolution.
    let pixels = Math.hypot(velU * res.x, velV * res.y);
    if (pixels < 1) continue;
    if (pixels > maxPx) { const s = maxPx / pixels; velU *= s; velV *= s; pixels = maxPx; }

    const radius = Math.min(pixels, maxPx);
    const nTaps = Math.min(Math.max(Math.ceil(radius * 0.5), 2), MB_TAPS);

    // gl_FragCoord is in the PASS's pixels, which is what the jitter is keyed
    // to; the simulation grid only decides where the taps land, not the seed.
    const jitter = ign(
      (px + 0.5) * res.x / width + frameSeed * 2.717,
      (py + 0.5) * res.y / height
    ) - 0.5;

    const cd = depth[i];
    let wN = 1, wB = 1;
    const listN = [], listB = [];
    for (let k = 1; k <= nTaps; k++) {
      const t = (k + jitter) / nTaps;
      const ox = velU * (t - 0.5), oy = velV * (t - 0.5);
      for (let s = 0; s < 2; s++) {
        const su = u + (s === 0 ? ox : -ox);
        const sv = v + (s === 0 ? oy : -oy);
        if (su < 0 || su > 1 || sv < 0 || sv > 1) continue;

        const dN = nearestDepth(su, sv);
        const bi = bilinearInv(su, sv);
        const dB = bi.value > 0 ? 1 / bi.value : 0;

        const a = weightOf(dN, cd, t);
        const b = weightOf(dB, cd, t);
        listN.push(a); listB.push(b);
        wN += a; wB += b;
        taps++;

        const dw = Math.abs(a - b);
        if (dw <= 1e-6) tapsBothSaturated++;
        else {
          tapsMoved++; sumAbsDw += dw; dwMoved.push(dw);
          if (dw > maxAbsDw) maxAbsDw = dw;
        }
        // The claim 1/d is stored FOR: the blend is a convex combination of
        // the four texels it reads, so the depth it resolves to has to lie
        // between the nearest and the furthest of them and can never decide
        // the opposite of what all four decide. Counted against the four
        // values themselves, not assumed. Sky is 1/d == 0, i.e. infinitely
        // far, which is the correct upper end of that interval.
        const dLo = bi.hi > 0 ? 1 / bi.hi : Infinity;
        const dHi = bi.lo > 0 ? 1 / bi.lo : Infinity;
        const tol = 1e-3 * Math.max(1, dHi === Infinity ? dLo : dHi);
        if (dB < dLo - tol || (dHi !== Infinity && dB > dHi + tol)) tapsOppositeSide++;
      }
    }
    if (listN.length === 0) continue;
    blurred++;

    let tv = Math.abs(1 / wB - 1 / wN);
    for (let k = 0; k < listN.length; k++) tv += Math.abs(listB[k] / wB - listN[k] / wN);
    tvAll.push(0.5 * tv);
  }

  dwMoved.sort((a, b) => a - b);
  tvAll.sort((a, b) => a - b);
  let tvOver1 = 0, tvOver5 = 0;
  for (const t of tvAll) { if (t > 0.01) tvOver1++; if (t > 0.05) tvOver5++; }

  return {
    simulatedAt: `${width}x${height}`,
    passResolution: `${res.x}x${res.y}`,
    tapRule: { maxTaps: MB_TAPS, maxRadiusPx: maxPx, shutter: +mb.shutter.toFixed(4) },
    blurredPixels: blurred,
    taps,
    tapsWhoseWeightIsIdentical: taps - tapsMoved,
    pctOfTapsIdentical: pct(taps - tapsMoved, taps),
    meanAbsWeightDeltaOverMovedTaps: +(sumAbsDw / Math.max(1, tapsMoved)).toFixed(5),
    p99AbsWeightDeltaOverMovedTaps: +quantile(dwMoved, 0.99).toFixed(5),
    maxAbsWeightDelta: +maxAbsDw.toFixed(5),
    // The one number that decides whether this was worth doing.
    weightMassMoved: {
      note: 'Total-variation distance between the two normalised weightings. The blurred '
        + 'colour cannot move by more than this times the contrast under the streak, so '
        + '0.004 reads as "at most 0.4 % of the local contrast, worst case".',
      mean: +(tvAll.reduce((a, b) => a + b, 0) / Math.max(1, tvAll.length)).toFixed(5),
      median: +quantile(tvAll, 0.5).toFixed(5),
      p99: +quantile(tvAll, 0.99).toFixed(5),
      max: +quantile(tvAll, 1).toFixed(5),
      pctOfBlurredPixelsOver1Pct: pct(tvOver1, tvAll.length),
      pctOfBlurredPixelsOver5Pct: pct(tvOver5, tvAll.length),
    },
    monotonicityViolations: {
      note: 'Taps where the bilinear reciprocal resolved OUTSIDE the interval spanned by '
        + 'the point sample and itself, which is the failure mode storing linear depth has '
        + 'and storing 1/d does not. Must be 0.',
      count: tapsOppositeSide,
    },
  };
}

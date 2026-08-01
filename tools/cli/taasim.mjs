/**
 * What TAA's nine-tap velocity dilation is actually worth.
 *
 * WHY THIS EXISTS
 *   With `sky-vol-march` down from 146.8 M to 74.7 M fetches, `ow-taa` is the
 *   largest single item left in the frame: 26 fetches on every one of 3.34 M
 *   full-resolution pixels, and unlike SSR or contact shadows it has no
 *   early-out at all, so its static bound and its real cost are the same number.
 *   Nine of those 26 are the depth taps that dilate the velocity to the
 *   closest-depth neighbour. Cutting the pattern to five is the one lever there
 *   worth more than a rounding error, and the only honest way to pull it is to
 *   find out what the frame loses.
 *
 * WHY THE ANSWER IS COMPUTABLE WITHOUT A GPU
 *   The dilation is a pure function of the DEPTH buffer:
 *
 *     bestUv = argmin over the pattern of  ( d <= 0 ? 1e8 : d )
 *
 *   and nothing else in the shader feeds back into it. Its two consumers are
 *   equally closed-form: `cb`, the coverage at bestUv, and `vel`, the velocity
 *   at bestUv. So the entire question -- does a smaller pattern pick a different
 *   neighbour, and does the history then land somewhere else -- is decided by
 *   depth, coverage and the two camera matrices. All four are quantities this
 *   reproduces exactly: depth and coverage come out of the software raster's own
 *   z-buffer, and the velocity is the same camera reprojection the prepass
 *   writes, which is `( currNDC - prevNDC ) * 0.5` of the world position the
 *   pixel already fixes.
 *
 *   Colour never enters it. The variance clip, the Catmull-Rom resample and the
 *   feedback weighting all sit DOWNSTREAM of `huv`, and they are byte-identical
 *   functions of it, so a pattern that reproduces `huv` reproduces the frame.
 *   That is why the reported quantity is the shift of `huv` in pixels and not
 *   some colour proxy: it is the whole difference, not a correlate of it.
 *
 * WHAT IS EXACT HERE AND WHAT IS NOT
 *   Exact: the dilation itself. Same nine offsets in the same order, same
 *          `d <= 0.0 -> 1e8` substitution, same strict `<` so ties go to the
 *          earliest index exactly as the GLSL loop does. This is the quantity
 *          under test and it is computed, not modelled.
 *   Exact: the coverage channel, including the 0.7 the prepass writes for
 *          skinned and morphed geometry, so the `cb > 0.5` branch and the
 *          `dynamic` term are both evaluated rather than assumed.
 *   Not:   object motion. The velocity here is the camera's own reprojection of
 *          STATIC geometry, which is what `fillsim` also assumes and what the
 *          prepass writes for everything whose model matrix did not change.
 *          A moving object's velocity differs between two neighbours by more
 *          than a static one's, so this UNDERSTATES the shift on moving pixels.
 *          `dilationOnDynamicCoverage` reports how much of the frame that is.
 *   Not:   the raster carries no alpha cut, so a masked leaf's silhouette is its
 *          triangle, not its texture. Foliage silhouettes are where dilation
 *          matters most, so this understates the disagreement there too.
 */
import * as THREE from 'three';
import { collectDrawables, createTarget, drawItem } from './raster.mjs';

/** The engine's own dilation offsets, in the engine's own loop order. */
const P9 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * Candidate patterns. Each keeps the nine-tap loop's relative ORDER, because the
 * comparison is a strict `<` and ties therefore go to the earliest index: a
 * pattern that reordered its taps would differ from the reference on every
 * flat-depth run for a reason that has nothing to do with how many taps it has.
 *
 * `x5` is the SHIPPED one -- four corners and the centre, see the derivation in
 * taa.js. crsim.mjs imports this table rather than restating the offsets, so a
 * change to the shader that lands here cannot leave a second copy behind.
 */
export const PATTERNS = {
  cross5: [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]],
  x5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  x4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  cross3v: [[0, -1], [0, 0], [0, 1]],
  cross3h: [[-1, 0], [0, 0], [1, 0]],
  centre1: [[0, 0]],
};

/**
 * Fetches the rest of the pass pays, on top of the dilation pattern.
 *
 * 1 tCurrent + 8 for the 3x3 variance neighbourhood + 5 Catmull-Rom + 1
 * conditional tVelocity. There are no separate coverage or depth fetches any
 * more: 1/depth rides in the gbuffer normal's alpha, so each dilation tap
 * returns the coverage at that texel too, and the winner's is the `cb` this file
 * evaluates. That is what makes a tap here cost one fetch rather than two, and it
 * is why the numbers below are not comparable with the ones taken before it.
 */
const TAA_OTHER_FETCHES = 15;

/**
 * Linear view depth + prepass coverage per pixel.
 *
 * Depth is read back out of the rasteriser's own z-buffer rather than being
 * interpolated a second time, so it cannot disagree with the coverage mask
 * beside it, and coverage is written from the same object the prepass would
 * have tested -- `isSkinnedMesh` / `morphTargetInfluences`, see prepass.js.
 */
function renderDepthCoverage(engine, width, height) {
  const camera = engine.camera;
  const rt = createTarget(width, height);
  const n = width * height;
  const cov = new Float32Array(n);

  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const { opaque, culled } = collectDrawables(engine.scene, camera, { includeTransparent: false });
  const shadeFor = (mat, obj) => {
    // OW_COVERAGE_DYNAMIC, decided per OBJECT exactly as prepass.js decides it.
    const c = obj.isSkinnedMesh === true
      || (obj.morphTargetInfluences !== undefined && obj.morphTargetInfluences !== null)
      ? 0.7 : 1;
    return (color, i) => { cov[i / 3] = c; };
  };
  for (const item of opaque) drawItem(rt, item, vp, shadeFor);

  const near = camera.near, far = camera.far;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = rt.depth[i];
    // Uncovered pixels keep the prepass's black clear, which is depth 0 -- the
    // exact value the shader's `d <= 0.0` test is looking for.
    depth[i] = rt.shaded[i] !== 0 && Number.isFinite(z)
      ? (2 * near * far) / (far + near - z * (far - near))
      : 0;
  }
  return { depth, cov, culled, opaqueItems: opaque.length };
}

/** p-th percentile of a Float64Array slice, nearest-rank. */
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * sorted.length) - 1));
  return sorted[k];
}

/**
 * @param engine        the booted engine, one frame after `run()`
 * @param opts.currVP   world -> clip of THIS frame, captured while TAA ran
 * @param opts.prevVP   world -> clip of the previous frame, same capture
 */
export function measureTaaDilation(engine, opts = {}) {
  const f = buildTaaField(engine, opts);
  return measureDilationOver(f, opts.patterns ?? null);
}

/**
 * Everything both measurements below need: the depth and coverage fields, the
 * velocity the prepass would have written, the far-plane reprojection the
 * uncovered branch takes, and the two closures that turn a tap pattern into a
 * history sample position.
 *
 * Extracted so the pattern study and the half-precision study run against
 * identical inputs. They are asking different questions about the same shader
 * and a second copy of this setup is how the two would drift apart. crsim.mjs
 * -- the Catmull-Rom tap study -- is the third caller and needs only `resolve`
 * of the shipped dilation, because the history sample position is the entire
 * input to the filter it is asking about.
 */
export function buildTaaField(engine, { width, height, currVP, prevVP } = {}) {
  const camera = engine.camera;
  const n = width * height;
  const { depth, cov, culled, opaqueItems } = renderDepthCoverage(engine, width, height);

  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = camera.aspect;
  const camWorld = camera.matrixWorld;

  // ---- velocity, exactly as prepass.js writes it --------------------------
  // gVelocity = ( currNDC - prevNDC ) * 0.5, i.e. a UV delta, of the pixel's own
  // world position. For static geometry owPrevModelMatrix == modelMatrix, so the
  // world position is shared between the two projections and this is the whole
  // of it.
  const velX = new Float32Array(n), velY = new Float32Array(n);
  const wp = new THREE.Vector4();
  for (let i = 0; i < n; i++) {
    if (depth[i] <= 0) continue;
    const x = i % width, y = (i / width) | 0;
    const ndcX = ((x + 0.5) / width) * 2 - 1;
    const ndcY = 1 - ((y + 0.5) / height) * 2;
    const d = depth[i];
    wp.set(ndcX * tanY * aspect * d, ndcY * tanY * d, -d, 1).applyMatrix4(camWorld);
    const wx = wp.x, wy = wp.y, wz = wp.z;
    const ce = currVP.elements, pe = prevVP.elements;
    const cxx = ce[0] * wx + ce[4] * wy + ce[8] * wz + ce[12];
    const cyy = ce[1] * wx + ce[5] * wy + ce[9] * wz + ce[13];
    const cww = ce[3] * wx + ce[7] * wy + ce[11] * wz + ce[15];
    const pxx = pe[0] * wx + pe[4] * wy + pe[8] * wz + pe[12];
    const pyy = pe[1] * wx + pe[5] * wy + pe[9] * wz + pe[13];
    const pww = pe[3] * wx + pe[7] * wy + pe[11] * wz + pe[15];
    const cw = Math.max(1e-6, cww), pw = Math.max(1e-6, pww);
    velX[i] = (cxx / cw - pxx / pw) * 0.5;
    velY[i] = (cyy / cw - pyy / pw) * 0.5;
  }

  // ---- background reprojection, the shader's `else` branch ----------------
  // When the dilated neighbour is not covered the shader does not read the
  // velocity buffer at all: it unprojects the FAR plane through uInvVP and
  // pushes it back through uPrevVP. That branch does not depend on bestUv, so it
  // is the same value for every pattern -- but WHICH branch runs does depend on
  // it, which is the whole point of tracking it separately.
  const invVP = new THREE.Matrix4().copy(currVP).invert();
  const bgX = new Float32Array(n), bgY = new Float32Array(n);
  const h4 = new THREE.Vector4();
  for (let i = 0; i < n; i++) {
    const x = i % width, y = (i / width) | 0;
    const u = (x + 0.5) / width, v = 1 - (y + 0.5) / height;
    h4.set(u * 2 - 1, v * 2 - 1, 1, 1).applyMatrix4(invVP);
    const iw = 1 / (h4.w || 1e-6);
    const wx = h4.x * iw, wy = h4.y * iw, wz = h4.z * iw;
    const pe = prevVP.elements;
    const pxx = pe[0] * wx + pe[4] * wy + pe[8] * wz + pe[12];
    const pyy = pe[1] * wx + pe[5] * wy + pe[9] * wz + pe[13];
    const pww = pe[3] * wx + pe[7] * wy + pe[11] * wz + pe[15];
    const pw = pww || 1e-6;
    bgX[i] = u - ((pxx / pw) * 0.5 + 0.5);
    bgY[i] = v - ((pyy / pw) * 0.5 + 0.5);
  }

  /**
   * The engine's dilation, run over an arbitrary tap pattern.
   *
   * Reproduces the loop literally: `d <= 0.0` becomes 1e8, `bestDepth` starts at
   * 1e9, the comparison is strict so the earliest tap wins a tie, and a tap that
   * leaves the texture is left to the sampler's clamp -- which is what the GPU
   * does at the frame border and which is reproduced here by clamping the index.
   */
  const dilate = (pattern) => {
    const bi = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i % width, y = (i / width) | 0;
      let bestDepth = 1e9, best = i;
      for (let k = 0; k < pattern.length; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + pattern[k][0]));
        const sy = Math.min(height - 1, Math.max(0, y + pattern[k][1]));
        const j = sy * width + sx;
        const d = depth[j] <= 0 ? 1e8 : depth[j];
        if (d < bestDepth) { bestDepth = d; best = j; }
      }
      bi[i] = best;
    }
    return bi;
  };

  /** huv, the history sample position, and the `dynamic` weight, for a dilation. */
  const resolve = (bi) => {
    const hx = new Float32Array(n), hy = new Float32Array(n), dyn = new Float32Array(n);
    const smoothstep = (a, b, t) => {
      const s = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return s * s * (3 - 2 * s);
    };
    for (let i = 0; i < n; i++) {
      const b = bi[i];
      const ca = cov[i], cb = cov[b];
      dyn[i] = Math.max(
        (ca >= 0.5 ? 1 : 0) * (1 - smoothstep(0.72, 0.92, ca)),
        (cb >= 0.5 ? 1 : 0) * (1 - smoothstep(0.72, 0.92, cb)));
      const x = i % width, y = (i / width) | 0;
      const u = (x + 0.5) / width, v = 1 - (y + 0.5) / height;
      if (cb > 0.5) { hx[i] = u - velX[b]; hy[i] = v - velY[b]; }
      else { hx[i] = u - bgX[i]; hy[i] = v - bgY[i]; }
    }
    return { hx, hy, dyn };
  };

  /**
   * The dilation as the SHIPPED shader runs it: argmax of 1/depth read out of the
   * gbuffer normal's alpha, which is a half.
   *
   * Half rounding is applied to the reciprocal, not to the depth, because that is
   * where it happens on the GPU -- the prepass computes 1.0/vViewDepth at full
   * precision and the store to RGBA16F rounds the result. Rounding the depth
   * first and inverting after would model a different shader and, being a
   * strictly smaller error, would flatter this one.
   *
   * Uncovered texels are 0 by the prepass's black clear rather than the old 1e8
   * sentinel, and 0 loses every comparison to real geometry, so the substitution
   * is not needed here either.
   */
  const invHalf = new Float16Array(n);
  for (let i = 0; i < n; i++) invHalf[i] = depth[i] > 0 ? 1 / depth[i] : 0;
  const dilateHalfInv = (pattern) => {
    const bi = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i % width, y = (i / width) | 0;
      let bestInv = -1, best = i;
      for (let k = 0; k < pattern.length; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + pattern[k][0]));
        const sy = Math.min(height - 1, Math.max(0, y + pattern[k][1]));
        const j = sy * width + sx;
        if (invHalf[j] > bestInv) { bestInv = invHalf[j]; best = j; }
      }
      bi[i] = best;
    }
    return bi;
  };

  return { n, width, height, depth, cov, culled, opaqueItems, dilate, dilateHalfInv, resolve };
}

function measureDilationOver(field, patterns) {
  const { n, cov, culled, opaqueItems, depth, width, height, dilate, resolve } = field;
  const ref = resolve(dilate(P9));
  const refBi = dilate(P9);

  const want = patterns ?? Object.keys(PATTERNS);
  const results = [];
  for (const name of want) {
    const pat = PATTERNS[name];
    if (!pat) continue;
    const bi = dilate(pat);
    const alt = resolve(bi);

    let differs = 0, branchFlips = 0, dynDiffers = 0, dynSum = 0, dynMax = 0;
    let onDynamicCov = 0;
    // Typed, not a JS array: at the pass's own 3.34 M pixels a boxed array of
    // shifts is several hundred megabytes of pointers before it is ever sorted.
    const shifts = new Float64Array(n);
    let shiftSum = 0, shiftMax = 0, over1px = 0, over025 = 0, moved = 0;
    for (let i = 0; i < n; i++) {
      if (bi[i] !== refBi[i]) differs++;
      const cbRef = cov[refBi[i]] > 0.5, cbAlt = cov[bi[i]] > 0.5;
      if (cbRef !== cbAlt) branchFlips++;
      const dd = Math.abs(alt.dyn[i] - ref.dyn[i]);
      if (dd > 1e-6) { dynDiffers++; dynSum += dd; if (dd > dynMax) dynMax = dd; }
      if (ref.dyn[i] > 1e-6) onDynamicCov++;
      const sx = (alt.hx[i] - ref.hx[i]) * width;
      const sy = (alt.hy[i] - ref.hy[i]) * height;
      const s = Math.hypot(sx, sy);
      shiftSum += s;
      if (s > shiftMax) shiftMax = s;
      if (s > 1) over1px++;
      if (s > 0.25) over025++;
      if (s > 1e-7) { shifts[moved++] = s; }
    }
    const movedShifts = shifts.subarray(0, moved).sort();

    results.push({
      pattern: name,
      taps: pat.length,
      dilationFetchesSaved: P9.length - pat.length,
      fetchesPerFragment: TAA_OTHER_FETCHES + pat.length,
      // How often the smaller pattern picks a DIFFERENT neighbour at all. This
      // is not yet a defect: two neighbours of the same flat wall carry almost
      // the same velocity, so most of these cost nothing.
      pickedDifferentNeighbourPct: +(100 * differs / n).toFixed(3),
      // How often it picks one on the other side of the coverage test, which
      // swaps the velocity branch outright. This is the one that can be visible.
      velocityBranchFlippedPct: +(100 * branchFlips / n).toFixed(4),
      historyShiftPx: {
        note: 'Distance the history sample position huv moves, in FULL-RESOLUTION '
          + 'pixels. Everything downstream -- Catmull-Rom, variance clip, feedback -- '
          + 'is a fixed function of huv, so this is the whole difference between the '
          + 'two shaders, not a proxy for it.',
        meanOverFrame: +(shiftSum / n).toFixed(5),
        pixelsThatMovedPct: +(100 * moved / n).toFixed(3),
        p50OfMoved: +pct(movedShifts, 50).toFixed(4),
        p99OfMoved: +pct(movedShifts, 99).toFixed(4),
        max: +shiftMax.toFixed(4),
        // A shift under a quarter of a pixel lands inside the same Catmull-Rom
        // footprint and is absorbed by the filter; over a pixel is a different
        // texel and therefore a genuinely different history sample.
        pctOfFrameOver025px: +(100 * over025 / n).toFixed(4),
        pctOfFrameOver1px: +(100 * over1px / n).toFixed(4),
      },
      clipTightnessChanged: {
        note: '`dynamic` drives both the variance-clip gamma and the feedback cap. It '
          + 'only moves where the dilation crosses onto or off skinned geometry.',
        pixelsChangedPct: +(100 * dynDiffers / n).toFixed(4),
        meanChangeWhereChanged: +(dynSum / Math.max(1, dynDiffers)).toFixed(4),
        maxChange: +dynMax.toFixed(4),
      },
      dilationOnDynamicCoverage: +(100 * onDynamicCov / n).toFixed(3),
    });
  }

  let covered = 0;
  for (let i = 0; i < n; i++) if (depth[i] > 0) covered++;
  return {
    simulated: { width, height, pixels: n, opaqueItems, culledByFrustum: culled },
    coverage: { coveredPixels: covered, coveredPct: +(100 * covered / n).toFixed(2) },
    reference: {
      pattern: 'full3x3', taps: 9, fetchesPerFragment: TAA_OTHER_FETCHES + 9,
      note: 'taa.js RESOLVE: 1 tCurrent + 9 tNormal for the dilation (coverage and 1/depth '
        + 'together) + 1 tVelocity + 8 tCurrent + 5 tHistory. The tVelocity fetch is '
        + 'conditional and so is everything after the off-screen early-out, so a pixel costs '
        + '23, 24, or 10 if its history reprojects out of the frame.',
    },
    patterns: results,
  };
}

/**
 * What moving the dilation off an R32F depth and onto a half 1/depth costs.
 *
 * THE ONE THING THAT CAN GO WRONG, and it is worth naming precisely. The
 * ordering itself is safe: 1/d is monotonic in d and half rounding is monotonic,
 * so argmin(depth) IS argmax(alpha) -- there is no way for the reciprocal to
 * reverse two neighbours. What it CAN do is make them equal. Half has 11 bits of
 * mantissa, so two depths within 2^-11 of each other collapse to one value, the
 * strict comparison then keeps the earlier tap, and the dilation picks a
 * different neighbour than it used to.
 *
 * WHY THAT IS THE RIGHT THING TO MEASURE AND NOT THE OBVIOUS PROXY. The obvious
 * proxy is "how many pixels changed neighbour", and it is almost meaningless
 * here: two samples 0.05% apart in depth are two samples of ONE surface, and a
 * surface carries one velocity. Swapping between them costs nothing. So the
 * quantity reported is the one PH19 learned to insist on -- how far the history
 * sample position `huv` actually moves -- broken down by whether the pixel sits
 * on a silhouette, because the silhouette is the entire population the dilation
 * exists to serve and a frame-wide mean would drown it.
 */
export function measureTaaHalfDepth(engine, opts = {}) {
  const f = buildTaaField(engine, opts);
  const { n, width, height, depth, cov, dilate, dilateHalfInv, resolve } = f;
  const pattern = opts.pattern ?? PATTERNS.x5;

  const refBi = dilate(pattern);
  const altBi = dilateHalfInv(pattern);
  const ref = resolve(refBi);
  const alt = resolve(altBi);

  // A pixel is on a silhouette if the pattern spans a real depth discontinuity --
  // the case the dilation was built for. 10% of the centre depth is far wider
  // than half's 0.05% step and far narrower than a crate against a street.
  const isSilhouette = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % width, y = (i / width) | 0;
    const d0 = depth[i];
    for (let k = 0; k < pattern.length && !isSilhouette[i]; k++) {
      const sx = Math.min(width - 1, Math.max(0, x + pattern[k][0]));
      const sy = Math.min(height - 1, Math.max(0, y + pattern[k][1]));
      const d1 = depth[sy * width + sx];
      if ((d0 > 0) !== (d1 > 0)) isSilhouette[i] = 1;
      else if (d0 > 0 && Math.abs(d1 - d0) > 0.1 * d0) isSilhouette[i] = 1;
    }
  }

  const bucket = (keep) => {
    let px = 0, differs = 0, flips = 0, sum = 0, max = 0, over025 = 0, over1 = 0;
    for (let i = 0; i < n; i++) {
      if (!keep(i)) continue;
      px++;
      if (altBi[i] !== refBi[i]) differs++;
      if ((cov[refBi[i]] > 0.5) !== (cov[altBi[i]] > 0.5)) flips++;
      const sx = (alt.hx[i] - ref.hx[i]) * width;
      const sy = (alt.hy[i] - ref.hy[i]) * height;
      const s = Math.hypot(sx, sy);
      sum += s;
      if (s > max) max = s;
      if (s > 0.25) over025++;
      if (s > 1) over1++;
    }
    return {
      pixels: px, pctOfFrame: +(100 * px / n).toFixed(3),
      pickedDifferentNeighbourPct: +(100 * differs / Math.max(1, px)).toFixed(4),
      velocityBranchFlippedPct: +(100 * flips / Math.max(1, px)).toFixed(5),
      meanHistoryShiftPx: +(sum / Math.max(1, px)).toFixed(6),
      maxHistoryShiftPx: +max.toFixed(4),
      pctOver025px: +(100 * over025 / Math.max(1, px)).toFixed(5),
      pctOver1px: +(100 * over1 / Math.max(1, px)).toFixed(5),
    };
  };

  return {
    simulated: { width, height, pixels: n },
    note: 'Reference is the dilation as it ran on the R32F depth target; the alternative is '
      + 'the shipped one, argmax over a half 1/depth out of the gbuffer normal alpha. '
      + 'historyShiftPx is the whole difference between the two shaders -- everything '
      + 'downstream of huv is a fixed function of it.',
    halfStepRelative: 2 ** -11,
    wholeFrame: bucket(() => true),
    // The population the dilation exists for. If the change is harmless anywhere
    // it is harmless on flat geometry; this is where it would show.
    onSilhouettes: bucket((i) => isSilhouette[i] === 1),
    offSilhouettes: bucket((i) => isSilhouette[i] === 0),
  };
}

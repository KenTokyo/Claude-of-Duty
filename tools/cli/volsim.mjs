/**
 * What the volumetric march's four shadow taps per step are actually worth.
 *
 * WHY THIS EXISTS
 *   `fillcost` established that `sky-vol-march` is the largest single item in
 *   the frame at ~146.8 M texture fetches, and that 172.7 of its 175.7 fetches
 *   per fragment are the four Vogel taps inside `skSunVisibility`. Nothing else
 *   in the pass is close. So the only lever that matters there is the tap count,
 *   and the only honest way to pull it is to find out what the frame loses.
 *
 * WHY THE ANSWER IS COMPUTABLE WITHOUT A GPU
 *   The march accumulates
 *
 *     L = SUM_i  w_i * [ keyIrr * phase * vis_i  +  ambient * ( 0.42 + 0.58 * vis_i ) ]
 *
 *   and every factor in w_i -- transmittance T, sigmaS, sigmaE, dt -- is a
 *   function of density and distance ONLY. None of them reads the shadow term.
 *   L is therefore exactly affine in the sequence of per-step visibilities, and
 *   the change caused by sampling the shadow disc differently is
 *
 *     dL = SUM_i w_i * K_i * dvis_i ,      K_i = keyIrr*phase + 0.58*ambient >= 0
 *
 *   with the same w_i on both sides. Writing V for the w-weighted mean
 *   visibility along a ray, the relative error of the in-scatter obeys
 *
 *     |dL| / L  <=  |SUM w_i dvis_i| / ( SUM w_i vis_i )  =  |dV| / V
 *
 *   because the ambient floor ( SUM w_i * ambient * 0.42 ) is non-negative and
 *   only ever enlarges the denominator. So |dV|/V is an UPPER BOUND on the
 *   relative change in the shaft, and it needs neither the phase function, nor
 *   the ambient LUT, nor the cloud deck -- all of which cancel or only help.
 *
 * WHAT IS EXACT HERE AND WHAT IS NOT
 *   Exact: `skSunVisibility` itself. The cascade maps are rasterised at their
 *          real 2048^2 from the real caster list, the cascade selection, the
 *          projection, the depth bias, the Vogel disc and the NearestFilter tap
 *          are line-for-line reproductions, and the per-pixel dither that
 *          rotates the disc is the engine's own `skIGN`. This is the quantity
 *          under test and it is computed, not modelled.
 *   Exact: the step distribution, the density (the engine's own `skVal3` value
 *          noise, ported), the extinction, and therefore the weights w_i.
 *   Not:   the cloud deck. `vis` is multiplied by mix(cloudNear, cloudFar, f),
 *          a smooth per-ray factor in [0,1] COMMON to both variants. It is
 *          taken as 1 here, which changes how the per-step errors are weighted
 *          against each other, not whether they cancel.
 *   Not:   the raster is 480x300 while the pass runs at 1134x737, so the dither
 *          field is sampled rather than reproduced pixel for pixel. The
 *          fragcoord is scaled to the real viewport so the field has the right
 *          statistics.
 */
import * as THREE from 'three';
import { collectDrawables, drawItem } from './raster.mjs';
import { renderCascade } from './shadowsim.mjs';

const fract = (x) => x - Math.floor(x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** `skIGN` from src/sky/noise.js. */
export function skIGN(x, y) {
  return fract(52.9829189 * fract(x * 0.06711056 + y * 0.00583715));
}

/** `skHash13` from src/sky/noise.js. */
export function skHash13(x, y, z) {
  x = fract(x * 0.1031); y = fract(y * 0.1031); z = fract(z * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}

/** `skVal3` from src/sky/noise.js. */
export function skVal3(px, py, pz) {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let fx = px - ix, fy = py - iy, fz = pz - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => skHash13(ix + a, iy + b, iz + c);
  const mix = (a, b, t) => a + (b - a) * t;
  const z0 = mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy);
  const z1 = mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy);
  return mix(z0, z1, fz);
}

/** `skVogel( i, n, phi )` split into radius and base angle, as in shadowsim. */
export function vogelDisc(n) {
  const r = new Float64Array(n), c = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = Math.sqrt((i + 0.5) / n);
    const t = i * 2.39996323;
    c[i] = Math.cos(t); s[i] = Math.sin(t);
  }
  return { r, c, s };
}

/**
 * Linear view depth per pixel, from the rasteriser's own z-buffer.
 *
 * Same reconstruction fillsim uses: the buffer holds clip z/w, so inverting the
 * camera's own projection cannot disagree with the coverage beside it.
 */
export function renderDepth(engine, width, height) {
  const camera = engine.camera;
  const n = width * height;
  const rt = {
    width, height, color: null,
    depth: new Float32Array(n).fill(Infinity),
    shaded: new Uint32Array(n), covered: new Uint32Array(n),
    tris: 0, trisDrawn: 0, meshes: 0, instances: 0,
  };
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const { opaque } = collectDrawables(engine.scene, camera, { includeTransparent: false });
  for (const item of opaque) drawItem(rt, item, vp, null);

  const near = camera.near, far = camera.far;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = rt.depth[i];
    // The prepass clears to zero and no drawn fragment can have view depth 0,
    // so 0 IS the sky sentinel the march tests with `depth <= 0.0`.
    out[i] = Number.isFinite(z) ? (2 * near * far) / (far + near - z * (far - near)) : 0;
  }
  return out;
}

/** Percentiles of a Float64Array, sorted in place. */
export function stats(a, count) {
  if (count === 0) return { n: 0 };
  const v = a.subarray(0, count);
  v.sort();
  const at = (p) => +v[Math.min(count - 1, Math.floor(p * count))].toFixed(5);
  let sum = 0;
  for (let i = 0; i < count; i++) sum += v[i];
  return {
    n: count, mean: +(sum / count).toFixed(5),
    p50: at(0.5), p90: at(0.9), p99: at(0.99), p999: at(0.999),
    max: +v[count - 1].toFixed(5),
  };
}

/**
 * @param engine     booted engine, already run to the sample frame
 * @param casters    the caster list `csm.render()` was called with
 * @param variants   tap counts to price against the shipped 4, e.g. [1, 2, 3]
 */
export function measureVolTaps(engine, casters, nCasters, {
  width = 480, height = 300, shadowRes = 0, variants = [1, 2, 3], marchSrc = '', converge = 1,
  theta = null,
} = {}) {
  const ROT = Math.max(1, converge | 0);
  const render = engine.ctx.peek('render');
  const csm = render.csm;
  const vol = engine.ctx.peek('sky')?.volumetrics ?? null;
  const march = vol?.marchPass;
  if (!csm || !march) return { unavailable: 'no CSM or no volumetric march in this preset' };

  const u = march.uniforms;
  const defines = march.material?.defines ?? {};
  const STEPS = Number(defines.VOL_STEPS ?? 0);
  const NC = Number(defines.OW_CASCADES ?? csm.cascades);
  if (!STEPS) return { unavailable: 'VOL_STEPS is not defined on the march material' };

  // The shipped tap count comes from the shader the engine compiled, never from
  // a second copy of the number here -- a table that drifts would price the
  // wrong shader and read exactly as convincing.
  const src = marchSrc || march.material?.fragmentShader || '';
  const SHIPPED = Number(/#define\s+SK_VOL_SHADOW_TAPS\s+(\d+)/.exec(src)?.[1] ?? 0)
    || Number(/for\s*\(\s*int i = 0; i <\s*(\d+)\s*; i \+\+ \)\s*\{\s*\n\s*vec2 o = skVogel/.exec(src)?.[1] ?? 4);

  const res = shadowRes || csm.mapSize;
  const t0 = Date.now();
  const maps = [];
  for (let i = 0; i < NC; i++) maps.push(renderCascade(csm, i, casters, nCasters, res).map);
  const tShadow = Date.now() - t0;

  const t1 = Date.now();
  const depth = renderDepth(engine, width, height);
  const tCam = Date.now() - t1;

  // ---- uniforms, exactly as the march sees them ---------------------------
  const cu = csm.uniforms;
  const comp = ['x', 'y', 'z', 'w'];
  const split = comp.map((k) => cu.owCsmSplit.value[k]);
  const texelW = comp.map((k) => cu.owCsmTexel.value[k]);
  const rangeW = comp.map((k) => cu.owCsmRange.value[k]);
  const csmMats = cu.owCsmMatrix.value;
  const strength = cu.owCsmParams.value.x;
  const discR = cu.owCsmMapSize.value.y * 1.6;

  const uFog = u.uFog.value, uFog2 = u.uFog2.value, uPhase = u.uPhase.value;
  const camPos = u.uCamPos.value;
  const drift = u.uFogDrift.value;
  const frame = u.uFrame?.value ?? 0;
  const invProj = u.uInvProj.value, camWorld = u.uCamWorld.value;
  const camRot = new THREE.Matrix3().setFromMatrix4(camWorld);

  // The march runs at half resolution; sampling its dither field at the sim's
  // coarser raster needs the fragcoord it would have had, not the sim's own.
  const realW = vol.rtMarch?.width ?? width;
  const realH = vol.rtMarch?.height ?? height;
  const fx = realW / width, fy = realH / height;

  const nTaps = [SHIPPED, ...variants];
  const discs = nTaps.map((k) => vogelDisc(k));
  const centreDisc = { r: new Float64Array([0]), c: new Float64Array([1]), s: new Float64Array([0]) };

  const sc = new THREE.Vector4();
  const wdir = new THREE.Vector3();
  const h = new THREE.Vector4();

  // Set by sunVis: did this call get past every pre-fetch return and actually
  // pay for its taps? Every variant shares the same answer, since the returns
  // are all decided before the tap count is ever used.
  let reachedTaps = false;
  let lastDistinct = 0, lastC = 0;
  const tapAddr = new Int32Array(64);
  const distinctHist = new Float64Array(9);
  const perCascadeCalls = new Float64Array(NC);
  const perCascadeDistinct = new Float64Array(NC);

  /**
   * One `skSunVisibility` call, with an arbitrary tap set.
   *
   * `nRot` > 1 averages the call over that many evenly spaced rotations of the
   * Vogel disc. That is not something the shader does in one frame -- it is the
   * FIXED POINT the `sky-vol-resolve` accumulator converges to, because the
   * dither that sets the rotation is advanced by uFrame every frame and the
   * resolve is a 0.9 exponential average over the result. Comparing two
   * variants at nRot = 1 measures a single frame; comparing them at nRot = M
   * measures what survives the accumulation, which is the part a temporal
   * filter cannot remove.
   */
  function sunVis(wx, wy, wz, viewDepth, rot, disc, k, nRot = 1) {
    reachedTaps = false;
    if (strength <= 0) return 1;
    if (viewDepth >= split[NC - 1]) return 1;
    let c = NC - 1;
    for (let i = 0; i < NC; i++) if (viewDepth < split[i]) { c = i; break; }

    sc.set(wx, wy, wz, 1).applyMatrix4(csmMats[c]);
    const iw = 1 / (sc.w || 1e-6);
    const pz = sc.z * iw * 0.5 + 0.5;
    if (pz >= 1 || pz <= 0) return 1;
    const px = sc.x * iw * 0.5 + 0.5, py = sc.y * iw * 0.5 + 0.5;
    if (Math.min(Math.min(px, 1 - px), Math.min(py, 1 - py)) <= 0) return 1;

    reachedTaps = true;
    lastC = c;
    const recv = pz - (texelW[c] * 2.2) / rangeW[c];
    const map = maps[c];
    let acc = 0;
    for (let m = 0; m < nRot; m++) {
    const phi = (rot + m / nRot) * 6.2831853;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    let s = 0;
    for (let i = 0; i < k; i++) {
      // skVogel(i,k,phi) rotated: the base angle's sin/cos are precomputed, so
      // the per-tap rotation is one complex multiply, as in shadowsim.
      const ox = (disc.c[i] * cp - disc.s[i] * sp) * disc.r[i] * discR;
      const oy = (disc.s[i] * cp + disc.c[i] * sp) * disc.r[i] * discR;
      let tx = Math.floor((px + ox) * res);
      let ty = Math.floor((1 - (py + oy)) * res);
      if (tx < 0) tx = 0; else if (tx >= res) tx = res - 1;
      if (ty < 0) ty = 0; else if (ty >= res) ty = res - 1;
      tapAddr[i] = ty * res + tx;
      s += recv <= map[tapAddr[i]] ? 1 : 0;
    }
    // How many DISTINCT texels the k taps landed on. The disc is 1.6 texels in
    // radius, so taps at 0.57, 0.98, 1.27 and 1.50 texels from the centre can
    // and do collide under NearestFilter -- a collision is a fetch that cost
    // bandwidth and returned a value the call already had.
    if (k > 1) {
      let d = 1;
      for (let i = 1; i < k; i++) {
        let dup = false;
        for (let j = 0; j < i; j++) if (tapAddr[j] === tapAddr[i]) { dup = true; break; }
        if (!dup) d++;
      }
      lastDistinct = d;
    } else lastDistinct = 1;
    acc += s / k;
    }
    return 1 + (acc / nRot - 1) * strength;
  }

  // ---- the march, once per pixel, with every variant side by side ---------
  const nV = nTaps.length;
  const centreIdx = nV;                    // one extra variant: a single CENTRE tap
  const acc = new Float64Array(nV + 1);
  const relErr = variants.map(() => new Float64Array(width * height));
  const relErrCentre = new Float64Array(width * height);
  const absErr = variants.map(() => new Float64Array(width * height));
  const absErrCentre = new Float64Array(width * height);
  let nRays = 0, nShadowed = 0, nRel = 0, tappedSteps = 0, marchedSteps = 0;
  let sumV0 = 0;

  // ---- candidate: skip the shadow call on steps that barely contribute ------
  // A DIFFERENT axis from the tap count. Fewer taps makes every step's estimate
  // noisier; this leaves every estimate alone and drops the calls whose answer
  // is multiplied by a weight near zero before it reaches the image.
  //
  // The weight is not a heuristic: the in-scatter is exactly affine in the
  // per-step visibilities, and w = T * sigmaS * (1 - aT) / sigmaE is precisely
  // that step's coefficient -- the same w this file already accumulates. So
  // forcing vis = 1 on a step moves the ray's weighted visibility by exactly
  // w * (1 - vis) / sumW, which lands in the SAME absoluteVisibilityError
  // statistic the tap variants are judged by, and the two are directly
  // comparable rather than merely analogous.
  //
  // Where it fires is the point. skFogNearRamp is smoothstep(0, 12, t), so the
  // first twelve metres carry a sigmaS scaled to nearly nothing on purpose --
  // and by cod voltaps those same near steps are cascade 0, which is 69.6% of
  // every shadow call the pass makes. The expensive region and the weightless
  // region are the same region.
  //
  // The threshold is measured against wRef = uFog.x * WBASE / VOL_STEPS, the
  // weight a step would carry at unit density with the ramp fully in. That
  // makes epsilon dimensionless and independent of fog tuning, so the number
  // chosen here does not silently change meaning when uFog is retuned.
  // The SHIPPED threshold is read off the compiled shader for the same reason
  // SHIPPED taps is: a second copy of the number here would keep pricing a skip
  // the pass no longer performs. Zero (or no define) means the candidate is not
  // in the build, and then every row below is a proposal rather than a report.
  const SHIPPED_EPS = Number(/#define\s+SK_VIS_SKIP\s+([\d.eE+-]+)/.exec(src)?.[1] ?? 0);
  // WBASE, and it is read off the source for a harder reason than the defines
  // are. wRef is a local rather than a define, so nothing in a #define sweep can
  // see it -- and it changed: it used to be the ray's own maxT and is now the
  // frame constant uFog.w. Every threshold this file sweeps is a FRACTION of it,
  // so getting it wrong does not shift a row, it re-bases the entire ladder and
  // every theta below would be answering a question about a shader that is not
  // running. On a near-field ray the two bases differ by up to sixty times.
  const WREF_BASE = /\bfloat\s+wRef\s*=\s*uFog\.x\s*\*\s*(uFog\.w|maxT)\s*\/\s*float\(\s*VOL_STEPS\s*\)/
    .exec(src)?.[1] ?? null;
  if (WREF_BASE === null) {
    throw new Error(
      'volsim: no "float wRef = uFog.x * (uFog.w|maxT) / float( VOL_STEPS )" in volumetrics.js, so the '
      + 'base of SK_VIS_SKIP and SK_VOL_TAP_TIER is unknown and no threshold below can be interpreted');
  }
  // true: one reference for the whole frame. false: per ray, equal only on sky.
  const WREF_FRAME = WREF_BASE === 'uFog.w';
  const SKIP_EPS = [...new Set([0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, SHIPPED_EPS])]
    .filter((e) => e > 0).sort((a, b) => a - b);
  const nEps = SKIP_EPS.length;
  const accSkip = new Float64Array(nEps);
  const skipTapSteps = new Float64Array(nEps);
  const absErrSkip = SKIP_EPS.map(() => new Float64Array(width * height));
  const relErrSkip = SKIP_EPS.map(() => new Float64Array(width * height));

  // ---- candidate: one tap on the steps between the two thresholds ----------
  // The THIRD point on the line the other two candidates already sit on, and
  // the one neither of them can reach.
  //
  // Both existing axes are all-or-nothing per step. The tap count is a single
  // global number, so making the cheap steps cheaper makes the expensive ones
  // cheaper too -- which is why 1 tap was rejected: it degrades the steps that
  // carry the ray. The weight skip is per step and therefore targeted, but its
  // only cheaper option is charging FULL SUN, an error of w * (1 - vis), the
  // largest a step can have. So the shipped shader is forced to choose, per
  // step, between the best estimate it can make and the worst one.
  //
  // A 1-tap tier in between is strictly dominant over raising the skip, and it
  // is arithmetic rather than a hope: on a step where the skip would charge
  // w * (1 - vis), one tap charges w * |vOne - vis|, and |vOne - vis| <= (1 -
  // vis) whenever vOne lies between vis and 1 -- which it does by construction,
  // since vOne is an unbiased sample of the same filter disc vis averages. So
  // for the SAME step and the SAME fetch budget the tiered variant cannot be
  // further from the truth than the skip, and it is the same fetch budget only
  // in the limit: one tap costs 1 where the skip costs 0 and the shipped taps
  // cost SHIPPED. Hence the ladder is priced, not assumed.
  //
  // theta is in the same wRef units as SK_VIS_SKIP, so the two are directly
  // comparable and the tier is [skip below eps] [1 tap below theta] [SHIPPED
  // above]. Both ends of the ladder are anchors that must reproduce a row that
  // already exists, and `anchors` below checks them rather than trusting them:
  //   theta == eps       -> no step is ever demoted, so this row must equal the
  //                         weightSkip row at the shipped epsilon, exactly.
  //   theta == Infinity  -> every step above the skip is demoted, so this row
  //                         is 1 tap PLUS the shipped skip. It is NOT the bare
  //                         1-tap variant row, which carries no skip at all, and
  //                         reading it as that row would credit the tier with a
  //                         saving the skip already books.
  // A tiered row that fails an anchor is measuring something other than what it
  // says it is.
  // The tier the build actually ships, read off the compiled shader for the same
  // reason SHIPPED and SHIPPED_EPS are. It is forced into the ladder so there is
  // always a row describing what the frame costs today rather than only rows
  // describing what it could cost.
  const SHIPPED_TIER = Number(/#define\s+SK_VOL_TAP_TIER\s+([\d.eE+-]+)/.exec(src)?.[1] ?? 0);
  const TIER_EPS = SHIPPED_EPS > 0 ? SHIPPED_EPS : 0;
  const TIER_THETA = theta != null
    ? [TIER_EPS, ...String(theta).split(',').map(Number), Infinity]
    : [...new Set([TIER_EPS, 0.01, 0.03, 0.1, 0.3, 1, 3, SHIPPED_TIER].filter((t) => t > 0)
      .sort((a, b) => a - b)), Infinity];
  const nTh = TIER_THETA.length;
  const oneDisc = vogelDisc(1);
  const accTier = new Float64Array(nTh);
  const tierOneSteps = new Float64Array(nTh);
  const tierTwoSteps = new Float64Array(nTh);
  const absErrTier = TIER_THETA.map(() => new Float64Array(width * height));
  const relErrTier = TIER_THETA.map(() => new Float64Array(width * height));

  // A ray that never leaves shadow has V = 0, so |dV|/V is undefined there --
  // and those are exactly the rays a coarser sampling hurts most, so dropping
  // them would flatter the answer. The absolute statistic keeps every ray; the
  // relative one is reported over the rays where it means something, with the
  // excluded count stated.
  const REL_FLOOR = 0.02;

  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = (p / width) | 0;
    const uvx = (x + 0.5) / width, uvy = 1 - (y + 0.5) / height;

    // skRayFor
    h.set(uvx * 2 - 1, uvy * 2 - 1, 1, 1).applyMatrix4(invProj);
    const iw = 1 / h.w;
    let vx = h.x * iw, vy = h.y * iw, vz = h.z * iw;
    const s = 1 / Math.max(1e-6, -vz);
    wdir.set(vx * s, vy * s, vz * s).applyMatrix3(camRot);
    const rayLen = wdir.length();
    wdir.multiplyScalar(1 / rayLen);

    const d = depth[p];
    const maxT = d <= 0 ? uFog.w : Math.min(d * rayLen, uFog.w);
    if (maxT <= 0.02) continue;

    // gl_FragCoord in the pass's own viewport, so the dither field matches.
    const dith = skIGN((x + 0.5) * fx + frame * 5.588238, (y + 0.5) * fy);

    acc.fill(0);
    accSkip.fill(0);
    accTier.fill(0);
    // Whichever base the shader compiled: uFog.w is one number for the frame,
    // maxT is this pixel's own and equals it only where the ray reaches the fog
    // distance. See WREF_BASE -- this line is the whole reason it is detected.
    const wRef = uFog.x * (WREF_FRAME ? uFog.w : maxT) / STEPS;
    let sumW = 0, T = 1, prev = 0;
    for (let i = 0; i < STEPS; i++) {
      const f = (i + dith) / STEPS;
      const t = maxT * f * f * (3 - 2 * f) * 0.35 + maxT * f * f * f * 0.65;
      const dt = t - prev;
      prev = t;
      if (dt <= 1e-5) continue;

      const wx = camPos.x + wdir.x * t, wy = camPos.y + wdir.y * t, wz = camPos.z + wdir.z * t;
      // skFogDensity, including the wind-torn value noise
      let dens = Math.exp(-(wy - uFog.z) * uFog.y);
      if (uFog2.w > 0.001) {
        const qx = wx * uPhase.w + drift.x, qy = wy * uPhase.w + drift.y, qz = wz * uPhase.w + drift.z;
        const nz = skVal3(qx, qy, qz) * 0.63
          + skVal3(qx * 2.71 + 5.1, qy * 2.71 + 5.1, qz * 2.71 + 5.1) * 0.37;
        dens *= 1 + uFog2.w * (0.30 + 1.55 * nz - 1);
      }
      if (dens <= 1e-4) continue;

      const ramp = t <= 0 ? 0 : t >= 12 ? 1 : (() => { const q = t / 12; return q * q * (3 - 2 * q); })();
      const sigmaS = uFog.x * dens * ramp;
      const sigmaE = Math.max(1e-7, uFog2.x * dens);
      const aT = Math.exp(-sigmaE * dt);
      const w = T * sigmaS * (1 - aT) / sigmaE;

      if (w > 0) {
        const vd = t / rayLen;
        let vShipped = 1, tappedShipped = false;
        for (let k = 0; k < nV; k++) {
          const v = sunVis(wx, wy, wz, vd, dith, discs[k], nTaps[k], ROT);
          acc[k] += w * v;
          // The shipped variant runs first, so its collision census is the one
          // that describes what the frame is paying for today -- and its value
          // is what the skip candidate below replaces, so both are captured
          // here rather than by calling sunVis a second time.
          if (k === 0) {
            vShipped = v;
            tappedShipped = reachedTaps;
            if (reachedTaps) {
              distinctHist[lastDistinct]++;
              perCascadeCalls[lastC]++; perCascadeDistinct[lastC] += lastDistinct;
            }
          }
        }
        // Same shipped estimator, minus the calls whose weight is negligible.
        for (let e = 0; e < nEps; e++) {
          if (w < SKIP_EPS[e] * wRef) {
            accSkip[e] += w;                        // vis forced to 1: no call
            if (tappedShipped) skipTapSteps[e]++;   // only a call that would
          } else {                                  // have fetched is a saving
            accSkip[e] += w * vShipped;
          }
        }

        // The tiered candidate. vOne is evaluated once and shared by every
        // theta, at the same dither and the same rotation count as the shipped
        // call above, so the only thing that differs between the rows is where
        // the threshold sits.
        let vOne = 1;
        if (w >= TIER_EPS * wRef && tappedShipped) {
          vOne = sunVis(wx, wy, wz, vd, dith, oneDisc, 1, ROT);
        }
        for (let e = 0; e < nTh; e++) {
          if (w < TIER_EPS * wRef) {
            accTier[e] += w;                        // skipped, exactly as shipped
          } else if (w < TIER_THETA[e] * wRef) {
            accTier[e] += w * vOne;
            if (tappedShipped) tierOneSteps[e]++;
          } else {
            accTier[e] += w * vShipped;
            if (tappedShipped) tierTwoSteps[e]++;
          }
        }
        acc[centreIdx] += w * sunVis(wx, wy, wz, vd, dith, centreDisc, 1, ROT);
        sumW += w;
        marchedSteps++;
        // Only a step that gets past every one of skSunVisibility's pre-fetch
        // returns costs anything, so the fetch arithmetic below counts those,
        // not the steps that merely ran.
        if (reachedTaps) tappedSteps++;
      }

      T *= aT;
      if (T < 0.004) break;
    }

    if (sumW <= 0) continue;
    const v0 = acc[0] / sumW;
    sumV0 += v0;
    if (v0 < 0.999) nShadowed++;
    for (let k = 1; k < nV; k++) absErr[k - 1][nRays] = Math.abs(acc[k] / sumW - v0);
    absErrCentre[nRays] = Math.abs(acc[centreIdx] / sumW - v0);
    for (let e = 0; e < nEps; e++) absErrSkip[e][nRays] = Math.abs(accSkip[e] / sumW - v0);
    for (let e = 0; e < nTh; e++) absErrTier[e][nRays] = Math.abs(accTier[e] / sumW - v0);
    if (v0 >= REL_FLOOR) {
      for (let k = 1; k < nV; k++) relErr[k - 1][nRel] = absErr[k - 1][nRays] / v0;
      relErrCentre[nRel] = absErrCentre[nRays] / v0;
      for (let e = 0; e < nEps; e++) relErrSkip[e][nRel] = absErrSkip[e][nRays] / v0;
      for (let e = 0; e < nTh; e++) relErrTier[e][nRel] = absErrTier[e][nRays] / v0;
      nRel++;
    }
    nRays++;
  }

  const perFragment = (k) => +(k * (tappedSteps / Math.max(1, nRays)) + 3).toFixed(1);
  const shippedPer = perFragment(SHIPPED);

  // The low anchor, computed HERE and not in the return object, because stats()
  // sorts its input in place: once the weightSkip rows have been formatted the
  // per-ray correspondence between these two arrays is gone and the comparison
  // would silently degrade from "same value on every ray" to "same histogram".
  const shippedEpsIdx = SHIPPED_EPS > 0 ? SKIP_EPS.indexOf(SHIPPED_EPS) : -1;
  let anchorLow = null;
  if (shippedEpsIdx >= 0) {
    const a = absErrTier[0], b = absErrSkip[shippedEpsIdx];
    let m = 0;
    for (let i = 0; i < nRays; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
    anchorLow = m;
  }

  return {
    simulated: {
      width, height, marchViewport: `${realW}x${realH}`, shadowMapRes: res,
      cascades: NC, steps: STEPS, shippedTaps: SHIPPED,
      ditherRotationsAveraged: ROT,
      what: ROT === 1
        ? 'ONE FRAME: every variant evaluated at the frame\'s own dither, so this is what a '
          + 'single marched frame differs by, before sky-vol-resolve accumulates anything.'
        : 'CONVERGED: each variant averaged over ' + ROT + ' evenly spaced dither rotations, '
          + 'which is the fixed point sky-vol-resolve\'s 0.9 exponential average walks to. What '
          + 'is left here is the part no temporal filter can remove.',
      rasterMs: { cascades: tShadow, camera: tCam },
    },
    rays: {
      marching: nRays,
      withAnyShadowAlongThem: nShadowed,
      pctShadowed: +(100 * nShadowed / Math.max(1, nRays)).toFixed(2),
      meanWeightedVisibility: +(sumV0 / Math.max(1, nRays)).toFixed(4),
      marchedStepsPerRay: +(marchedSteps / Math.max(1, nRays)).toFixed(2),
      tappingStepsPerRay: +(tappedSteps / Math.max(1, nRays)).toFixed(2),
      raysAboveRelativeFloor: nRel,
      relativeFloor: REL_FLOOR,
    },
    note: 'absoluteVisibilityError is |dV| for the w-weighted mean visibility along a ray. '
      + 'The in-scatter is exactly affine in the per-step visibilities with IDENTICAL weights '
      + 'on both sides -- transmittance, sigmaS and sigmaE never read the shadow term -- so '
      + 'the shaft radiance moves by a fixed positive factor times dV, and dV is directly the '
      + 'fraction of full-sun-along-the-ray that changes hands. relativeError is |dV|/V, which '
      + 'BOUNDS the relative change of that ray\'s in-scatter from above because the ambient '
      + 'floor only enlarges the denominator; it is reported over the rays with V >= the floor, '
      + 'since a ray that never leaves shadow has V = 0 and no relative error to speak of. A ray '
      + 'lit along its whole length has V = 1 in every variant and contributes exactly zero.',
    variants: variants.map((k, i) => ({
      taps: k,
      fetchesPerFragment: perFragment(k),
      fetchesPerFragmentSaved: +(shippedPer - perFragment(k)).toFixed(1),
      pctOfPassSaved: +(100 * (shippedPer - perFragment(k)) / shippedPer).toFixed(1),
      absoluteVisibilityError: stats(absErr[i], nRays),
      relativeError: stats(relErr[i], nRel),
    })),
    singleCentreTap: {
      taps: 1,
      note: 'One tap at the disc CENTRE instead of at Vogel radius sqrt(0.5). Same cost as '
        + 'the 1-tap Vogel variant, different estimator: unfiltered hard shadow rather than '
        + 'an unbiased sample of the filter disc.',
      fetchesPerFragment: perFragment(1),
      absoluteVisibilityError: stats(absErrCentre, nRays),
      relativeError: stats(relErrCentre, nRel),
    },
    // `variants` and the error columns are all measured against a march that
    // takes EVERY shadow call, which is the ground truth whether or not the
    // build skips any -- so `shipped` has to say which of the two it means.
    shipped: {
      taps: SHIPPED,
      weightSkipEpsilon: SHIPPED_EPS,
      fetchesPerFragmentWithoutSkip: shippedPer,
      fetchesPerFragment: SHIPPED_EPS > 0
        ? +(SHIPPED * ((tappedSteps - skipTapSteps[SKIP_EPS.indexOf(SHIPPED_EPS)])
          / Math.max(1, nRays)) + 3).toFixed(1)
        : shippedPer,
      note: SHIPPED_EPS > 0
        ? 'The build skips the shadow call on negligible-weight steps (SK_VIS_SKIP in '
          + 'volumetrics.js), so the pass costs fetchesPerFragment, not the without-skip '
          + 'figure. Every error column here is measured against the without-skip march, '
          + 'which is the right reference: it is what the image would be if nothing were '
          + 'skipped. Find the shipped epsilon in weightSkip.variants for its error.'
        : 'No SK_VIS_SKIP in the shipped shader: every step that reaches the taps pays.',
    },
    // The other axis: keep all SHIPPED taps, drop the CALLS that cannot matter.
    // Comparable to `variants` above by construction -- same statistic, same
    // rays, same dither -- so the two can be read against each other directly.
    weightSkip: {
      note: 'Skip skSunVisibility entirely on a step whose own weight w = T * sigmaS * '
        + '(1 - aT) / sigmaE is below epsilon * wRef, with wRef = uFog.x * ' + WREF_BASE + ' / VOL_STEPS. '
        + 'Every factor of w is known in the shader BEFORE the call -- aT only needs hoisting '
        + 'above it -- so this is implementable as written. The skipped step keeps the same '
        + 'transmittance and the same sigmaS; it is charged full sun instead of a sampled '
        + 'visibility, which is why the error is bounded by w * (1 - vis) / sumW and shows up '
        + 'in the identical statistic used for the tap variants. NOT bit-exact: read the error '
        + 'columns against the 1-tap row, which was measured at 0.047 converged and rejected.',
      referenceWeight: 'uFog.x * ' + WREF_BASE + ' / VOL_STEPS',
      shippedTapCallsPerRay: +(tappedSteps / Math.max(1, nRays)).toFixed(2),
      variants: SKIP_EPS.map((eps, e) => {
        const savedPerRay = skipTapSteps[e] / Math.max(1, nRays);
        const per = +(SHIPPED * ((tappedSteps / Math.max(1, nRays)) - savedPerRay) + 3).toFixed(1);
        return {
          epsilon: eps,
          tapCallsSkippedPerRay: +savedPerRay.toFixed(2),
          tapCallsSkippedPct: +(100 * skipTapSteps[e] / Math.max(1, tappedSteps)).toFixed(1),
          fetchesPerFragment: per,
          fetchesPerFragmentSaved: +(shippedPer - per).toFixed(1),
          pctOfPassSaved: +(100 * (shippedPer - per) / shippedPer).toFixed(1),
          absoluteVisibilityError: stats(absErrSkip[e], nRays),
          relativeError: stats(relErrSkip[e], nRel),
        };
      }),
    },
    // The third axis: keep every CALL, but spend the shipped tap budget only on
    // the steps whose weight can pay for it. Same statistic, same rays, same
    // dither as both axes above, so all three read against each other directly.
    tieredTaps: {
      note: 'Three tiers per step, by the step\'s own weight w against wRef = uFog.x * ' + WREF_BASE + ' / '
        + 'VOL_STEPS: below SK_VIS_SKIP the call is skipped and charged full sun (shipped '
        + 'behaviour, unchanged); below theta it takes ONE Vogel tap; above theta it takes the '
        + 'shipped ' + SHIPPED + '. Implementable as written -- w is already known before the '
        + 'call, which is what SK_VIS_SKIP established -- and the tap count is a loop bound the '
        + 'shader can pick per step. Read against weightSkip at equal fetchesPerFragment: the '
        + 'tier spends its budget where the ray is, the skip spends it where the ray is not.',
      tierBelowEpsilon: TIER_EPS,
      shippedTheta: SHIPPED_TIER || 'no SK_VOL_TAP_TIER in the build: every row is a proposal',
      variants: TIER_THETA.map((th, e) => {
        const one = tierOneSteps[e] / Math.max(1, nRays);
        const two = tierTwoSteps[e] / Math.max(1, nRays);
        const per = +(SHIPPED * two + one + 3).toFixed(1);
        return {
          theta: th === Infinity ? 'inf' : th,
          shipped: SHIPPED_TIER > 0 && th === SHIPPED_TIER ? true : undefined,
          oneTapStepsPerRay: +one.toFixed(2),
          shippedTapStepsPerRay: +two.toFixed(2),
          fetchesPerFragment: per,
          fetchesPerFragmentSaved: +(shippedPer - per).toFixed(1),
          pctOfPassSaved: +(100 * (shippedPer - per) / shippedPer).toFixed(1),
          absoluteVisibilityError: stats(absErrTier[e], nRays),
          relativeError: stats(relErrTier[e], nRel),
        };
      }),
      // Both ends of the ladder have to reproduce a row that already exists.
      // Reported as numbers rather than asserted so a drift shows up as a value
      // to read instead of a crash in a measurement run.
      anchors: {
        note: 'theta == epsilon must equal the weightSkip row at the shipped epsilon; '
          + 'theta == inf must equal one tap PLUS that same skip (not the bare 1-tap variant, '
          + 'which carries no skip). Both are max |difference| over the per-ray statistic.',
        lowVsShippedSkip: anchorLow === null
          ? 'no SK_VIS_SKIP in the build: the low anchor is not defined'
          : anchorLow.toExponential(2),
        highIsOneTapPlusSkip: 'compare fetchesPerFragment ' + (
          TIER_THETA[nTh - 1] === Infinity
            ? +(tierOneSteps[nTh - 1] / Math.max(1, nRays) + 3).toFixed(1)
            : 'n/a'
        ) + ' against the 1-tap variant at ' + perFragment(1)
          + ', which is higher by exactly the calls the skip removes',
      },
    },
    // How much of the shipped tap budget is spent re-reading a texel the call
    // already read. This is not an argument that fewer taps look the same -- it
    // is a count of fetches that provably carried no new information.
    tapCollisions: {
      note: 'Distinct texels reached by the shipped taps, per call. The Vogel disc has radius '
        + '1.6 shadow texels and the filter is NearestFilter, so taps land on the same texel '
        + 'often; those fetches cost bandwidth and return a value already in hand.',
      discRadiusInTexels: +(discR * res).toFixed(2),
      callsByDistinctTexels: Array.from(distinctHist.slice(0, SHIPPED + 1), (v) => v),
      meanDistinctTexels: +(
        distinctHist.reduce((p, c, i) => p + c * i, 0) / Math.max(1, distinctHist.reduce((p, c) => p + c, 0))
      ).toFixed(3),
      byCascade: Array.from(perCascadeCalls, (calls, i) => ({
        cascade: i, calls,
        meanDistinctTexels: +(perCascadeDistinct[i] / Math.max(1, calls)).toFixed(3),
      })),
    },
  };
}

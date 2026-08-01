/**
 * What VOL_STEPS is worth, and whether 56 of them belong on every ray.
 *
 * WHAT IS BEING QUESTIONED
 *   `sky-vol-march` is 46.9 M fetches, 14.3 % of the frame and the second
 *   largest row in it. fillcost says 55.1 of its 56.1 fetches per fragment are
 *   shadow taps issued from inside the step loop, so the loop LENGTH is a
 *   first-class lever, and it is the only one in this pass that has never been
 *   measured. Three thresholds INSIDE the loop have been -- SK_VOL_SHADOW_TAPS,
 *   SK_VIS_SKIP and SK_VOL_TAP_TIER all carry their measurements in
 *   volumetrics.js -- but the number of iterations they run inside has not.
 *
 * THE ASYMMETRY THAT MAKES IT A CANDIDATE
 *   Every ray marches VOL_STEPS times, and the step positions are
 *
 *       t( f ) = maxT * [ 0.35 * f^2 ( 3 - 2f ) + 0.65 * f^3 ],   f = ( i + d ) / N
 *
 *   a pure function of the ray's OWN length. Differentiating, the spacing is
 *
 *       near field   t'(f) / N ~ 2.1 * maxT * f / N   ->  first step ~1.05 maxT / N^2
 *       far field    t'(1) / N  =  1.95 * maxT / N
 *
 *   and maxT is min( depth * rayLen, uFog.w ) with uFog.w = 900 m. So a ray that
 *   ends on a wall 20 m away is sampled 45x more finely, IN METRES, than the sky
 *   ray next to it -- and the sky ray is the one 56 was chosen for. Everything
 *   being resolved here has a world-space scale: the density noise cells, the
 *   cascade texel grid, the shaft edges. A budget denominated in fractions of
 *   the ray therefore over-resolves every short ray by the ratio of its length
 *   to the longest one, and by the measurement below HALF THIS FRAME is under
 *   16 m.
 *
 *   Same shape as `ow-mb`'s tap rule and `ow-taa`'s neighbourhood: a constant
 *   that is right at the design point and wrong everywhere else, because the
 *   design point was the only place it was ever checked.
 *
 * WHAT THE TRUTH IS HERE
 *   The SAME march at a much higher step count with the shipped tap ladder
 *   intact, which isolates quadrature error of the step count and nothing else.
 *   SK_VIS_SKIP and SK_VOL_TAP_TIER are thresholds on w / wRef and wRef carries
 *   a 1/N that cancels the 1/N in w, so the ladder is scale invariant and the
 *   reference applies exactly the rule the shipped shader does. A ladder-free
 *   reference would fold the ladder's own already-measured, already-accepted
 *   error into every row and make all of them look worse by the same amount.
 *
 * WHY THE ERROR IS NORMALISED BY THE FRAME AND NOT BY THE RAY
 *   The first version of this file divided each ray's error by that ray's own
 *   in-scatter, and reported a mean relative error of 44 % for the SHIPPED
 *   step count against itself at 2x. That number was real arithmetic and
 *   completely meaningless: skFogNearRamp is smoothstep( 0, 12, t ), so a ray
 *   that ends at 15 m -- half of them -- spends its whole length inside the ramp
 *   and carries almost no in-scatter at all. Dividing by almost nothing produced
 *   almost anything, and the rays it flattered into dominating the statistic
 *   were exactly the ones that cannot be seen.
 *
 *   So the divisor is the FRAME's mean, once, for every ray. That makes each row
 *   an error in units of the image's own typical fog brightness, which is what
 *   an artefact is measured in, and a ray that contributes nothing can no longer
 *   contribute a large error. The per-ray ratio is still reported as
 *   `meanVisibilityErr`, because V = S1/S0 is bounded in [0,1] and is the exact
 *   statistic volsim.mjs prices the tap ladder in -- so the two files' numbers
 *   can be read against each other.
 *
 * WHY TWO SUMS AND NOT ONE
 *   Writing the in-scatter out,
 *
 *       L = SUM_i w_i [ A * vis_i + B * ( 0.42 + 0.58 vis_i ) ]
 *         = ( A + 0.58 B ) * S1  +  0.42 B * S0
 *
 *   with A = uKeyIrr * phase >= 0 and B = ambient >= 0, both constant along a ray
 *   and IDENTICAL between two variants of it. L is therefore a non-negative
 *   combination of exactly two scalars, and
 *
 *       | dL |  <=  max( |dS1| , |dS0| ) * ( A + 0.58B + 0.42B )
 *
 *   so normalising both by their own frame means and taking the larger bounds
 *   the relative change in the shaft for every sun angle and every ambient tint,
 *   without needing the phase function or the LUT. S0 alone is the fog's own
 *   opacity -- the part that survives with the sun straight overhead -- so a rule
 *   that keeps S1 and loses S0 is not acceptable, and only a two-column
 *   statistic can say so. `inscatterBound` is that larger of the two.
 *
 * THE DITHER CONVERGES, AND GETTING THAT WRONG WOULD HAVE SUNK THIS
 *   The step offset is `dith = skIGN( gl_FragCoord.xy + uFrame * 5.588238 )`, so
 *   it ADVANCES EVERY FRAME, and `sky-vol-resolve` is a 0.9 exponential average
 *   with a widened 3x3 clamp. Step-position noise is therefore temporally
 *   averaged exactly the way the Vogel disc's rotation is, and a single-frame
 *   measurement charges every candidate for noise the frame does not keep. What
 *   survives the accumulator is the BIAS of the N-point rule averaged over
 *   dither offsets, which is what `--dith=M` computes: reference and candidate
 *   are averaged over the same M evenly spaced offsets before they are compared.
 *
 *   Both columns are reported anyway, and the single-frame one is not decoration:
 *   a region the resolve has just disoccluded has no history to average, which is
 *   the same argument that held SK_VOL_SHADOW_TAPS at two. A rule is only
 *   acceptable if it is inside the noise the pass already carries on BOTH.
 *
 * WHAT IT CANNOT TELL YOU
 *   The three things volsim.mjs cannot. The cloud deck is taken as 1 -- it is a
 *   smooth per-ray factor common to both variants, so it reweights the per-step
 *   errors against each other but cannot change whether they cancel. The raster
 *   is coarser than the pass, so the dither field is sampled rather than
 *   reproduced pixel for pixel, with the fragcoord scaled so its statistics are
 *   right. And nothing here is in milliseconds; fetches are the currency.
 */
import * as THREE from 'three';
import { renderCascade } from './shadowsim.mjs';
import { skIGN, skVal3, vogelDisc, renderDepth, stats } from './volsim.mjs';

/**
 * The step-count rules under test.
 *
 * Three SHAPES rather than a fine sweep of one, because the near and far
 * spacings scale differently in N and the question is which of them the image is
 * actually made of. Each is parameterised by the spacing it holds constant, so
 * the knob means something physical rather than being a scale factor:
 *
 *   fixed( N )    what ships, at N = 56. Included at lower counts so every
 *                 adaptive row has a same-COST fixed row to beat. An adaptive
 *                 rule that only wins by being cheaper is not a finding, it is a
 *                 roundabout way of writing fixed( fewer ).
 *   nearM( m )    N = ceil( sqrt( 1.05 * maxT / m ) ), holding the FIRST step at
 *                 m metres. Expect this to win if what the eye reads is shaft
 *                 detail close to the camera. Shipped is m = 0.30 m at 900 m.
 *   farM( m )     N = ceil( 1.95 * maxT / m ), holding the LAST step's spacing at
 *                 m metres. Expect this if the far end is what breaks. Shipped
 *                 is m = 31.3 m at 900 m.
 *
 * The shipped values of m are computed from the shipped N at fogFar, so the m
 * that reproduces 56 steps on a sky ray is in the sweep by construction and each
 * family passes exactly through the design point. That is what makes the
 * comparison about extrapolation DOWN from it rather than about the tuning.
 */
export function stepRules(shipped, fogFar, minSteps) {
  const clampN = (v) => Math.max(minSteps, Math.min(shipped, Math.ceil(v)));
  const rules = [];
  rules.push({ id: `fixed(${shipped})`, family: 'fixed', shipped: true, n: () => shipped });
  for (const f of [0.75, 0.6, 0.45, 0.3]) {
    const N = Math.max(minSteps, Math.round(shipped * f));
    rules.push({ id: `fixed(${N})`, family: 'fixed', n: () => N });
  }
  // The spacings the shipped count produces on the longest ray, which is the one
  // the tuning was chosen for.
  const nearShipped = 1.05 * fogFar / (shipped * shipped);
  const farShipped = 1.95 * fogFar / shipped;
  for (const mul of [1, 2, 4, 8, 16]) {
    const m = nearShipped * mul;
    rules.push({
      id: `nearM(${+m.toFixed(3)})`, family: 'nearM', param: +m.toFixed(4),
      n: (maxT) => clampN(Math.sqrt(1.05 * maxT / m)),
    });
  }
  for (const mul of [1, 1.5, 2, 3, 4]) {
    const m = farShipped * mul;
    rules.push({
      id: `farM(${+m.toFixed(2)})`, family: 'farM', param: +m.toFixed(3),
      n: (maxT) => clampN(1.95 * maxT / m),
    });
  }
  return rules;
}

/**
 * The OTHER axis, and by the bucket table the one that matters: what the two
 * weight thresholds are measured AGAINST.
 *
 * WHAT THE BUCKET TABLE FOUND. In the frame `fill --look=1` prices, rays shorter
 * than 400 m are 58.8 % of the pixels and carry 1.3 % of the in-scatter, while
 * fillcost -- a completely separate model, built from the compiled shader --
 * puts 72.5 % of every shadow tap the pass issues on exactly those pixels. The
 * pass spends nearly three quarters of its fetches producing about one
 * hundredth of its output. That is not a tuning question, it is a sign that the
 * thing deciding which steps are worth a lookup is asking the wrong question.
 *
 * STATUS: ACTED ON. The shader now computes wRef from uFog.w, which is the p = 1
 * row of the family below, and the -49.9% this file predicted came in at -52.0%
 * measured two ways (fill --real: sky-vol-march 46.89 M -> 22.48 M, -7.44% of
 * the frame; fillcost: 56.1 -> 26.9 f/frag). fillcost also confirmed the
 * prediction that made the change safe: the sky column is BIT-IDENTICAL
 * (22.56 -> 22.56 tapping steps/px) and the entire saving is geometry
 * (41.64 -> 18.18). Everything below is kept in the present tense as the
 * derivation; `shipped` is now decided by wRefRules() from the source, so this
 * file reports p = 1 as the baseline and p = 0 as the thing that was replaced.
 *
 * WHY IT HAPPENED, IN ONE LINE. The shader used to compute
 *
 *     float wRef = uFog.x * maxT / float( VOL_STEPS );
 *
 * and SK_VIS_SKIP and SK_VOL_TAP_TIER are both fractions of it. maxT is the
 * ray's OWN length, so "negligible" is defined relative to how much in-scatter
 * THIS ray could possibly carry -- and a 15 m ray could not carry much. Its
 * threshold is 60x smaller than that of the sky ray in the pixel beside it, so
 * steps carrying an absolutely trivial amount of light clear it easily and buy
 * two shadow taps each. Both pixels end up in the same image, where light is
 * light; nothing in the frame is normalised per ray.
 *
 * That is the same shape as the two findings before it -- a constant that is
 * correct at the design point and wrong in proportion to the distance from it --
 * except that here the design point is literally `maxT == uFog.w`.
 *
 * THE FAMILY. Interpolating geometrically between the two denominators,
 *
 *     wRef( p ) = uFog.x * maxT^( 1 - p ) * fogFar^p / VOL_STEPS
 *
 * gives p = 0 for the shipped per-ray reference and p = 1 for a frame constant.
 * Two properties make p = 1 the natural candidate rather than merely the
 * cheapest one:
 *
 *   - On a ray at maxT == fogFar it is BIT-IDENTICAL to what ships. So the whole
 *     family is a no-op on the population carrying 98.7 % of the output, and
 *     every saving it books comes from rays that carry the other 1.3 %.
 *   - It moves only `vis`. The weights, the transmittance and the quadrature are
 *     untouched, so S0 cannot move at all and the entire error lands in S1 --
 *     the axis SK_VIS_SKIP was already measured on. It is the same trade the
 *     file already accepted, applied where it was never being applied.
 *
 * Intermediate p is swept because a cliff at p = 1 with nothing behind it would
 * be a coincidence rather than a mechanism, and because the frame's own
 * bimodality (58.8 % short, 41.2 % sky, nothing in between) means a single frame
 * cannot distinguish p = 0.75 from p = 1 on its own.
 */
export function wRefRules(fogFar, shippedBase = 'maxT') {
  // WHICH ROW IS THE BASELINE is read from the shader rather than asserted here,
  // and this function is the reason the rule exists. It was written while the
  // shipped line was uFog.x * maxT, so p = 0 carried `shipped: true` as a
  // literal -- and then the finding above was ACTED ON and the shader moved to
  // uFog.x * uFog.w, which is p = 1. A hardcoded flag would now call the
  // candidate the baseline and the baseline a candidate, and go on offering a
  // -49.9% saving that has already been banked. The flag follows the source.
  const shippedP = shippedBase === 'uFog.w' ? 1 : 0;
  const rules = [{ id: 'wRef=ray', p: 0, shipped: shippedP === 0, w: (maxT) => maxT }];
  for (const p of [0.25, 0.5, 0.75, 1]) {
    rules.push({
      id: `wRef=p${p}`, p, shipped: shippedP === p,
      w: (maxT) => Math.pow(maxT, 1 - p) * Math.pow(fogFar, p),
    });
  }
  return rules;
}

/**
 * @param engine     booted engine, already run to the sample frame
 * @param casters    the caster list `csm.render()` was called with
 * @param width,height  the ray grid
 * @param refMul     reference step count as a multiple of the shipped count
 * @param dith       dither offsets to average over; 1 is a single frame, and
 *                   >1 is the fixed point sky-vol-resolve accumulates to
 * @param rot        Vogel rotations per visibility call, as in volsim
 * @param minSteps   floor for the adaptive rules
 */
export function measureVolSteps(engine, casters, nCasters, {
  width = 480, height = 300, shadowRes = 0, refMul = 4, dith = 1, rot = 1, minSteps = 4,
  marchSrc = '',
} = {}) {
  const NDITH = Math.max(1, dith | 0);
  const ROT = Math.max(1, rot | 0);
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

  // Every constant of the estimator comes off the compiled shader, never from a
  // copy here. Same rule as the rest of this toolchain, and the one that caught
  // fillsim pricing a TAA neighbourhood the shader no longer had.
  const src = marchSrc || march.material?.fragmentShader || '';
  const TAPS = Number(/#define\s+SK_VOL_SHADOW_TAPS\s+(\d+)/.exec(src)?.[1] ?? 0);
  const EPS = Number(/#define\s+SK_VIS_SKIP\s+([\d.eE+-]+)/.exec(src)?.[1] ?? 0);
  const TIER = Number(/#define\s+SK_VOL_TAP_TIER\s+([\d.eE+-]+)/.exec(src)?.[1] ?? 0);
  // The base of wRef, which is the axis this whole file exists to sweep, so of
  // every constant here it is the one that must not be assumed. It is a local in
  // the shader rather than a define, so the sweep above cannot see it.
  const wRefBase = /\bfloat\s+wRef\s*=\s*uFog\.x\s*\*\s*(uFog\.w|maxT)\s*\/\s*float\(\s*VOL_STEPS\s*\)/
    .exec(src)?.[1] ?? null;
  if (wRefBase === null) {
    throw new Error(
      'volstepsim: no "float wRef = uFog.x * (uFog.w|maxT) / float( VOL_STEPS )" in the compiled march '
      + 'shader, so which row of the wRef family ships is unknown and no row can be called a baseline');
  }
  if (!TAPS) {
    throw new Error('volstepsim: SK_VOL_SHADOW_TAPS not found in the compiled march shader');
  }
  // The step warp is the curve every rule here extrapolates along, so a change
  // to it must not be able to leave this sim pricing the old one. Anchored on the
  // two literal coefficients rather than the whole line, which carries names.
  if (!/f \* f \* \( 3\.0 - 2\.0 \* f \) \* 0\.35/.test(src) || !/f \* f \* f \* 0\.65/.test(src)) {
    throw new Error(
      'volstepsim: the march no longer uses the 0.35/0.65 step warp this sim reproduces');
  }
  // The loop must still divide by the SAME count it iterates, or the adaptive
  // rules below describe a shader that does not exist.
  if (!/float\( VOL_STEPS \)/.test(src)) {
    throw new Error('volstepsim: the march no longer derives its step positions from VOL_STEPS');
  }

  const res = shadowRes || csm.mapSize;
  const maps = [];
  for (let i = 0; i < NC; i++) maps.push(renderCascade(csm, i, casters, nCasters, res).map);
  const depth = renderDepth(engine, width, height);

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

  const realW = vol.rtMarch?.width ?? width;
  const realH = vol.rtMarch?.height ?? height;
  const fx = realW / width, fy = realH / height;

  const discFull = vogelDisc(TAPS);
  const discOne = vogelDisc(1);

  const sc = new THREE.Vector4();
  const wdir = new THREE.Vector3();
  const h = new THREE.Vector4();

  let reachedTaps = false;

  /** `skSunVisibility`, line for line, with the tap count left open. */
  function sunVis(wx, wy, wz, viewDepth, r, disc, k) {
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
    const recv = pz - (texelW[c] * 2.2) / rangeW[c];
    const map = maps[c];
    let acc = 0;
    for (let m = 0; m < ROT; m++) {
      const phi = (r + m / ROT) * 6.2831853;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      let s = 0;
      for (let i = 0; i < k; i++) {
        const ox = (disc.c[i] * cp - disc.s[i] * sp) * disc.r[i] * discR;
        const oy = (disc.s[i] * cp + disc.c[i] * sp) * disc.r[i] * discR;
        let tx = Math.floor((px + ox) * res);
        let ty = Math.floor((1 - (py + oy)) * res);
        if (tx < 0) tx = 0; else if (tx >= res) tx = res - 1;
        if (ty < 0) ty = 0; else if (ty >= res) ty = res - 1;
        s += recv <= map[ty * res + tx] ? 1 : 0;
      }
      acc += s / k;
    }
    return 1 + (acc / ROT - 1) * strength;
  }

  /**
   * One ray at one step count and one dither offset, returning S0, S1 and the
   * taps it issued.
   *
   * Everything but `N` is the shader's: the warp, the dt guard, the density with
   * its wind-torn value noise, the near ramp, the extinction, the affine weight,
   * the three-rung ladder in the shader's own order, and the transmittance
   * break. wRef divides by the SAME N the loop runs, which is what makes both
   * thresholds scale invariant and the comparison across N fair.
   */
  function marchRay(N, maxT, wRefLen, d0, ox, oy, oz, dx, dy, dz, rayLen, out) {
    // wRefLen is what the two thresholds are measured against, in the same units
    // as maxT. Passing maxT reproduces the shipped line exactly; see wRefRules.
    const wRef = uFog.x * wRefLen / N;
    const wSkip = EPS * wRef, wTier = TIER * wRef;
    let S0 = 0, S1 = 0, taps = 0, tapping = 0, T = 1, prev = 0;
    for (let i = 0; i < N; i++) {
      const f = (i + d0) / N;
      const t = maxT * f * f * (3 - 2 * f) * 0.35 + maxT * f * f * f * 0.65;
      const dt = t - prev;
      prev = t;
      if (dt <= 1e-5) continue;

      const wx = ox + dx * t, wy = oy + dy * t, wz = oz + dz * t;
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
        let vis;
        if (w < wSkip) {
          vis = 1;                                       // no call at all
        } else {
          const k = w < wTier ? 1 : TAPS;
          vis = sunVis(wx, wy, wz, t / rayLen, d0, k === 1 ? discOne : discFull, k);
          if (reachedTaps) { taps += k; tapping++; }     // only a call that fetched
        }
        S0 += w;
        S1 += w * vis;
      }

      T *= aT;
      if (T < 0.004) break;
    }
    out.S0 = S0; out.S1 = S1; out.taps = taps; out.tapping = tapping;
  }

  const REF_N = Math.max(STEPS + 1, Math.round(STEPS * refMul));

  // The variant grid: every step rule at the shipped reference weight, every
  // reference weight at the shipped step count, and the CROSS of the two best
  // families. Kept as one flat list so a single loop prices all of them on
  // identical rays and identical dither offsets -- the two axes are not
  // independent (a shorter ray gets fewer steps AND a stricter threshold, and
  // both act on the same steps), so a cross term has to be measured rather than
  // multiplied out of the two margins.
  const sRules = stepRules(STEPS, uFog.w, minSteps);
  const wRules = wRefRules(uFog.w, wRefBase);
  // The reference weight the build actually ships, as a LOOKUP and not as the
  // literal `maxT` it used to be spelled. That literal was the shipped rule only
  // while the shader said maxT; when the shader moved to uFog.w it silently put
  // the entire step axis -- including the fixed(STEPS) baseline that every saving
  // on this grid is measured against -- on the reference that was replaced, and
  // left the shipped one measured under no name at all. It is the same drift the
  // three regexes above exist to prevent, in the one place a regex could not see.
  const wShipped = wRules.find((w) => w.shipped);
  const rules = [];
  for (const s of sRules) {
    rules.push({
      id: s.id, axis: 'steps', family: s.family, param: s.param,
      shipped: !!s.shipped, n: s.n, w: wShipped.w,
    });
  }
  for (const w of wRules) {
    if (w.shipped) continue;                       // already in as fixed(STEPS)
    rules.push({
      id: w.id, axis: 'wref', family: 'wref', param: w.p,
      n: () => STEPS, w: w.w,
    });
  }
  // The cross, at the far endpoint of the wRef family only. Once p = 1 IS the
  // shipped reference this loop is correctly empty: every step row above already
  // marches with it, so a cross row would be a duplicate under a longer name.
  for (const s of sRules) {
    if (s.family !== 'nearM' && s.family !== 'farM') continue;
    for (const w of wRules) {
      if (w.shipped || w.p !== 1) continue;
      rules.push({
        id: `${s.id}+${w.id}`, axis: 'both', family: `${s.family}+wref`, param: s.param,
        n: s.n, w: w.w,
      });
    }
  }
  const nR = rules.length;
  const n = width * height;

  // Pass 1: the ray set, its lengths, and the frame means the errors are
  // normalised by. Computed from the REFERENCE, so the divisor is a property of
  // the frame rather than of any candidate -- including the shipped one, which
  // would otherwise be scoring itself against its own scale.
  const rayIdx = new Int32Array(n);
  const rayMaxT = new Float64Array(n);
  const rayDith = new Float64Array(n);
  const refS0 = new Float64Array(n);
  const refS1 = new Float64Array(n);
  let nRays = 0;

  const out = { S0: 0, S1: 0, taps: 0, tapping: 0 };
  const setupRay = (p) => {
    const x = p % width, y = (p / width) | 0;
    const uvx = (x + 0.5) / width, uvy = 1 - (y + 0.5) / height;
    h.set(uvx * 2 - 1, uvy * 2 - 1, 1, 1).applyMatrix4(invProj);
    const iw = 1 / h.w;
    const s = 1 / Math.max(1e-6, -(h.z * iw));
    wdir.set(h.x * iw * s, h.y * iw * s, h.z * iw * s).applyMatrix3(camRot);
    const rayLen = wdir.length();
    wdir.multiplyScalar(1 / rayLen);
    const d = depth[p];
    const maxT = d <= 0 ? uFog.w : Math.min(d * rayLen, uFog.w);
    return { maxT, rayLen, dith: skIGN((x + 0.5) * fx + frame * 5.588238, (y + 0.5) * fy) };
  };

  // The dither offsets. The shader's own value is the phase; the M offsets step
  // evenly around it, which is the same construction volsim uses for the Vogel
  // rotation and for the same reason -- it is the fixed point of an exponential
  // average over a value that advances every frame, not a resampling of it.
  const dOff = (base, m) => {
    const v = base + m / NDITH;
    return v - Math.floor(v);
  };

  for (let p = 0; p < n; p++) {
    const r = setupRay(p);
    if (r.maxT <= 0.02) continue;
    let a0 = 0, a1 = 0;
    for (let m = 0; m < NDITH; m++) {
      marchRay(REF_N, r.maxT, r.maxT, dOff(r.dith, m), camPos.x, camPos.y, camPos.z,
        wdir.x, wdir.y, wdir.z, r.rayLen, out);
      a0 += out.S0; a1 += out.S1;
    }
    rayIdx[nRays] = p;
    rayMaxT[nRays] = r.maxT;
    rayDith[nRays] = r.dith;
    refS0[nRays] = a0 / NDITH;
    refS1[nRays] = a1 / NDITH;
    nRays++;
  }
  if (!nRays) return { unavailable: 'no ray in this frame reaches the fog' };

  let mean0 = 0, mean1 = 0;
  for (let i = 0; i < nRays; i++) { mean0 += refS0[i]; mean1 += refS1[i]; }
  mean0 /= nRays; mean1 /= nRays;
  const inv0 = mean0 > 0 ? 1 / mean0 : 0, inv1 = mean1 > 0 ? 1 / mean1 : 0;

  // Pass 2: every rule over the same rays, against the reference already held.
  const errS0 = rules.map(() => new Float64Array(nRays));
  const errS1 = rules.map(() => new Float64Array(nRays));
  const errB = rules.map(() => new Float64Array(nRays));
  const errV = rules.map(() => new Float64Array(nRays));
  const sumTaps = new Float64Array(nR);
  const sumTapping = new Float64Array(nR);
  const sumN = new Float64Array(nR);

  for (let i = 0; i < nRays; i++) {
    const p = rayIdx[i];
    const r = setupRay(p);
    const maxT = rayMaxT[i], base = rayDith[i];
    const R0 = refS0[i], R1 = refS1[i];
    const vR = R0 > 0 ? R1 / R0 : 1;
    for (let k = 0; k < nR; k++) {
      const N = Math.max(1, rules[k].n(maxT) | 0);
      const wLen = rules[k].w(maxT);
      let a0 = 0, a1 = 0, tp = 0, tg = 0;
      for (let m = 0; m < NDITH; m++) {
        marchRay(N, maxT, wLen, dOff(base, m), camPos.x, camPos.y, camPos.z,
          wdir.x, wdir.y, wdir.z, r.rayLen, out);
        a0 += out.S0; a1 += out.S1; tp += out.taps; tg += out.tapping;
      }
      a0 /= NDITH; a1 /= NDITH;
      sumTaps[k] += tp / NDITH;
      sumTapping[k] += tg / NDITH;
      sumN[k] += N;
      const e0 = Math.abs(a0 - R0) * inv0;
      const e1 = Math.abs(a1 - R1) * inv1;
      errS0[k][i] = e0;
      errS1[k][i] = e1;
      errB[k][i] = e0 > e1 ? e0 : e1;
      errV[k][i] = Math.abs((a0 > 0 ? a1 / a0 : 1) - vR);
    }
  }

  // Where the saving and the error each come from, by ray length.
  //
  // This is the check that stops the headline being believed for the wrong
  // reason. Two very different mechanisms would both produce a large saving at a
  // small mean error, and only one of them is a finding:
  //
  //   OVER-RESOLUTION  short rays are sampled 45x more finely in metres than the
  //                    sky ray the count was tuned for, so cutting them costs
  //                    nothing. That is the argument in the header.
  //   IRRELEVANCE      skFogNearRamp is smoothstep( 0, 12, t ), so a ray ending
  //                    at 15 m carries almost no in-scatter whatever is done to
  //                    it, and the saving is real but the error is small only
  //                    because the bucket is invisible.
  //
  // They are told apart by the MIDDLE buckets: 50-150 m rays are well outside the
  // ramp and carry real in-scatter, so if the rule holds there it is the first
  // mechanism. `shareOfFrameS1` says how much of the image each bucket is, so a
  // bucket's error can be read against what it can actually affect.
  // Does normalising by a FRAME mean smuggle in an assumption?
  //
  // The composite is `color * trans + inscatter`, so the march's L is purely
  // ADDITIVE, and because the wRef axis leaves every weight untouched, S0 cannot
  // move and dL is exactly ( A + 0.58 B ) * dS1 with A = uKeyIrr * phase( cosKey )
  // and B = ambient. Both are per-ray gains. Dividing dS1 by a frame mean of S1
  // therefore reports dL/L correctly ONLY IF those gains do not differ
  // systematically between the rays a candidate changes and the rays it does
  // not -- and this candidate is defined by exactly that split, so it is
  // precisely the assumption that has to be checked rather than stated.
  //
  // phase is computable here without the ambient LUT: uPhase and uKeyDir are
  // plain uniforms and skFogPhase is two Henyey-Greenstein lobes. It carries the
  // shaft gain on its anisotropic part, so it is also the term with by far the
  // largest dynamic range -- a forward peak aimed at the sun. B's per-ray
  // variation is the scalar f = 0.5 + 0.5 cosKey squared, interpolating two
  // frame-constant LUT colours, so it is bounded by their ratio and is reported
  // beside it. If the short buckets' mean gain is NOT above the sky bucket's,
  // the frame normalisation is conservative and the headline stands.
  const HG = (c, g) => {
    const gg = g * g;
    const d = 1 + gg - 2 * g * c;
    return (1 - gg) / (4 * Math.PI * Math.max(1e-6, d * Math.sqrt(Math.max(1e-6, d))));
  };
  const keyDir = u.uKeyDir?.value ?? { x: 0, y: 1, z: 0 };
  const phaseOf = (dx, dy, dz) => {
    const c = dx * keyDir.x + dy * keyDir.y + dz * keyDir.z;
    const p = HG(c, uPhase.x) * (1 - uPhase.z) + HG(c, uPhase.y) * uPhase.z;
    const iso = 1 / (4 * Math.PI);
    return { phase: p + Math.max(0, p - iso) * (uFog2.y - 1), f2: Math.pow(0.5 + 0.5 * c, 2) };
  };

  const BUCKETS = [[0, 12], [12, 25], [25, 50], [50, 150], [150, 400], [400, 1e9]];
  const bucketOf = (v) => {
    for (let b = 0; b < BUCKETS.length; b++) if (v >= BUCKETS[b][0] && v < BUCKETS[b][1]) return b;
    return BUCKETS.length - 1;
  };
  const bCount = new Float64Array(BUCKETS.length);
  const bS1 = new Float64Array(BUCKETS.length);
  const bPhase = new Float64Array(BUCKETS.length);
  const bF2 = new Float64Array(BUCKETS.length);
  let totS1 = 0;
  for (let i = 0; i < nRays; i++) {
    const b = bucketOf(rayMaxT[i]);
    const r = setupRay(rayIdx[i]);
    const g = phaseOf(wdir.x, wdir.y, wdir.z);
    bCount[b]++; bS1[b] += refS1[i]; totS1 += refS1[i];
    bPhase[b] += g.phase; bF2[b] += g.f2;
  }

  const byLength = rules.map((r, k) => {
    const sumErr = new Float64Array(BUCKETS.length);
    const maxErr = new Float64Array(BUCKETS.length);
    const sumSteps = new Float64Array(BUCKETS.length);
    for (let i = 0; i < nRays; i++) {
      const b = bucketOf(rayMaxT[i]);
      sumErr[b] += errB[k][i];
      if (errB[k][i] > maxErr[b]) maxErr[b] = errB[k][i];
      sumSteps[b] += Math.max(1, r.n(rayMaxT[i]) | 0);
    }
    return {
      rule: r.id,
      buckets: BUCKETS.map((rng, b) => ({
        rayLenM: rng[1] > 1e8 ? `${rng[0]}+` : `${rng[0]}-${rng[1]}`,
        pctOfRays: +(100 * bCount[b] / nRays).toFixed(1),
        shareOfFrameS1: +(100 * bS1[b] / Math.max(1e-12, totS1)).toFixed(1),
        meanSteps: bCount[b] ? +(sumSteps[b] / bCount[b]).toFixed(1) : 0,
        meanBound: bCount[b] ? +(sumErr[b] / bCount[b]).toFixed(5) : 0,
        maxBound: +maxErr[b].toFixed(5),
        // The per-ray gains dL is proportional to. Read them ACROSS buckets: if
        // the buckets a candidate changes do not carry a higher gain than the
        // ones it leaves alone, normalising by a frame mean is conservative.
        meanPhase: bCount[b] ? +(bPhase[b] / bCount[b]).toFixed(5) : 0,
        meanAmbientF2: bCount[b] ? +(bF2[b] / bCount[b]).toFixed(4) : 0,
      })),
    };
  });

  const mt = rayMaxT.subarray(0, nRays).slice().sort();
  const q = (f) => +mt[Math.min(nRays - 1, Math.floor(f * nRays))].toFixed(1);
  const pctOf = (fn) => {
    let c = 0;
    for (let i = 0; i < nRays; i++) if (fn(mt[i])) c++;
    return +(100 * c / nRays).toFixed(1);
  };

  // Fetches per fragment the way fillcost counts them: taps actually issued plus
  // the pass's fixed reads (tDepth and the two cloud-shadow calls).
  const perFrag = (k) => +(sumTaps[k] / nRays + 3).toFixed(2);
  const shippedIdx = rules.findIndex((r) => r.shipped);
  const baseF = perFrag(shippedIdx);

  const rows = rules.map((r, k) => ({
    rule: r.id,
    axis: r.axis,
    family: r.family,
    shipped: !!r.shipped,
    param: r.param,
    meanSteps: +(sumN[k] / nRays).toFixed(2),
    tappingStepsPerRay: +(sumTapping[k] / nRays).toFixed(2),
    fetchesPerFragment: perFrag(k),
    savedPerFragment: +(baseF - perFrag(k)).toFixed(2),
    savedPct: +(100 * (baseF - perFrag(k)) / baseF).toFixed(1),
    inscatterBound: stats(errB[k], nRays),
    fogOpacityErrS0: stats(errS0[k], nRays),
    shaftErrS1: stats(errS1[k], nRays),
    meanVisibilityErr: stats(errV[k], nRays),
  }));

  return {
    note: 'Quadrature error of the sky-vol-march step count against the SAME march at '
      + `${REF_N} steps with the shipped tap ladder intact, so the ladder cancels and this is `
      + 'the step count alone. Errors are absolute, normalised ONCE by the frame mean of the '
      + 'quantity -- not per ray, which would let rays that carry no in-scatter dominate. '
      + `inscatterBound is max( |dS0|, |dS1| ) / frame mean and bounds |dL|/L for every sun `
      + 'angle and ambient tint. meanVisibilityErr is V = S1/S0, the same statistic '
      + `volsim.mjs prices the tap ladder in, so the two are directly comparable. `
      + `Averaged over ${NDITH} dither offset${NDITH === 1 ? '' : 's'}: 1 is a single frame, `
      + 'more is the fixed point sky-vol-resolve accumulates to. Compare rows at equal '
      + 'fetchesPerFragment, never at equal rule parameter.',
    grid: `${width}x${height}`,
    referenceSteps: REF_N,
    ditherOffsets: NDITH,
    vogelRotations: ROT,
    shippedSteps: STEPS,
    shippedTaps: TAPS,
    visSkipEps: EPS,
    tapTier: TIER,
    minSteps,
    fogFarM: uFog.w,
    lastCascadeSplitM: +split[NC - 1].toFixed(1),
    shippedNearStepM: +(1.05 * uFog.w / (STEPS * STEPS)).toFixed(4),
    shippedFarStepM: +(1.95 * uFog.w / STEPS).toFixed(2),
    rays: nRays,
    shippedFetchesPerFragment: baseF,
    frameMeanS0: +mean0.toFixed(6),
    frameMeanS1: +mean1.toFixed(6),
    rayLengthM: {
      note: 'maxT = min( depth * rayLen, fogFar ) per ray, and the whole independent variable '
        + 'of this measurement: an adaptive rule is worth exactly the share of the frame whose '
        + 'rays are short.',
      p1: q(0.01), p10: q(0.10), p25: q(0.25), p50: q(0.50),
      p75: q(0.75), p90: q(0.90), p99: q(0.99),
      pctAtFogFar: pctOf((v) => v >= uFog.w - 0.5),
      pctUnder100m: pctOf((v) => v < 100),
      pctUnder50m: pctOf((v) => v < 50),
      pctUnder25m: pctOf((v) => v < 25),
    },
    rows,
    byLength,
  };
}

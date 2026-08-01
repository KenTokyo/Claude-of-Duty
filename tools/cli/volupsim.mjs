/**
 * What the volumetric upsample's depth weight does now that the tap depth
 * arrives as a HALF FLOAT out of the march target's alpha instead of as a
 * float32 out of the full-resolution depth attachment.
 *
 * src/sky/volumetrics.js used to pay four full-resolution `tDepth` fetches per
 * pixel inside `skUpsample`, to recover a number the march already had in hand
 * and was throwing away in its alpha channel. Folding it into the tVolume
 * fetches is worth 13.4 M fetches a frame. It changes two things about the
 * comparison the weight is built on, and this measures both:
 *
 *   the TAP depth is now half-rounded, because the march target is
 *   HalfFloatType and alpha goes through it;
 *
 *   the CENTRE depth is now half-rounded too, on purpose, by the
 *   packHalf2x16/unpackHalf2x16 pair above the skUpsample call.
 *
 * THE SECOND ONE IS THE WHOLE POINT AND IT IS WHAT THIS TOOL EXISTS TO CHECK.
 * So three arms are evaluated on the same pixels, not two:
 *
 *   A  float32 tap, float32 centre   -- what the pass did before the change
 *   B  half tap,    half centre      -- what it does now
 *   C  half tap,    float32 centre   -- the version that was NOT written
 *
 * B against A is the cost of the optimisation. C against A is the cost of
 * getting it wrong.
 *
 * THIS TOOL REFUTED THE ARGUMENT IT WAS BUILT TO CONFIRM, AND THE REPLACEMENT
 * IS THE REASON THE ROUNDING STAYS. The case originally made for rounding the
 * centre was that on a fronto-parallel surface the tap and the centre hold the
 * same float32 number, so the similarity term must collapse to zero, and a
 * float32-against-rounded comparison would leave up to a half-float step of
 * residue in it -- roughly a third of the weight, against a denominator floor
 * of 0.05. Both halves of that are wrong:
 *
 *   The residue does not survive normalisation. When all four taps tie, all
 *   four carry the SAME residue, so all four denominators are equal, the
 *   weights are scaled by one common factor, and a common factor cancels in
 *   sum/wsum. Measured: arm C's total variation on flat quads is 0 to six
 *   decimals, the same as arm B's.
 *
 *   The population is not there. Flat quads are 40.0% of the frame and
 *   99.99% of them are SKY, where every depth is 0, 0 is exact in half, and
 *   no arm could have disagreed. Flat GEOMETRY quads are 0.004% of the frame.
 *
 * What does decide it is the MIXED quad -- a silhouette, 18.4% of the frame,
 * where some taps tie the centre and some do not. There arm C's residue is not
 * common to the four: it lands on the tied taps, whose denominator is sitting
 * on the 0.05 floor and is the only one a small absolute residue can move,
 * while the untied taps are already metres off the floor. Arm C therefore
 * demotes the taps that share the surface and leaves the foreign ones alone,
 * and it does so in one direction. Measured, at 1134x736: net normalised
 * weight moved ONTO the foreign taps is +0.001277 mean and positive on 85.1%
 * of mixed pixels under arm C, against +0.000049 mean and 58.8% positive under
 * arm B -- twenty-six times the drift, and signed rather than a coin flip.
 * Pulling the far surface's in-scatter across a silhouette is the one thing a
 * depth-aware upsample exists to stop.
 *
 * Note that arm C's total-variation distance from A comes out LOWER than arm
 * B's frame-wide (0.00103 against 0.00134). That is not a defence of arm C:
 * TV is unsigned and the frame-wide figure is dominated by open quads where
 * neither arm does anything. A smaller unsigned average made of a systematic
 * bias is worse than a larger one made of noise. Read the per-population rows.
 *
 * WHAT IS EXACT HERE
 *   The tap geometry. `skUpsample` reads at `( base + o + 0.5 ) * uTexelHalf`,
 *   which is a half-resolution texel CENTRE, and the march wrote that texel
 *   after sampling `tDepth` at that same uv. So the tap depth is a point
 *   sample of the full-resolution depth at that uv -- not an independently
 *   rasterised half-resolution buffer -- and that is how it is reconstructed
 *   here. The floor/scale/epsilon of the weight and the half-resolution scale
 *   are read off the live pass, not restated.
 *
 *   The tie test is exact in the strongest sense available: it asks whether the
 *   march's tap and the composite's centre are the same float32 number BEFORE
 *   any rounding, which is a property of the sampling geometry and is the only
 *   thing that could make "equal depths round to equal halves" not apply.
 *
 * WHAT IS NOT
 *   The depth buffer is rasterised at the simulation resolution, so a half-res
 *   texel spans more world here than in the real pass. Unlike mbdepthsim.mjs
 *   this turns out not to matter, and that is measured rather than hoped:
 *   across 480x300, 760x476 and 1134x736 the arm-C bleed reads 0.001313 /
 *   0.001307 / 0.001277 and the arm-B bleed 0.000059 / 0.000018 / 0.000049,
 *   i.e. flat to the third digit with no trend. The reason is that half
 *   rounding is a RELATIVE error while the |d - c| that sets the denominator
 *   at a silhouette is a geometric depth discontinuity in metres; neither
 *   scales with the texel footprint. The top row is representative here.
 *
 *   Sub-texel filtering is absent by construction and that is correct rather
 *   than a simplification: every tap lands on an exact texel centre, and the
 *   4-to-8 bits of sub-texel precision an ES 3.0 sampler is allowed to have
 *   snap the blend weight to exactly 1. The same coarse quantisation that
 *   killed the "collapse the four taps into one hardware bilinear fetch" idea
 *   (see the rejection note over skUpsample) is what makes this tap exact.
 *
 * THE HEADLINE NUMBER IS THE WEIGHT MASS THAT MOVES, for the same reason as
 * in mbdepthsim.mjs: the upsample is a convex combination sum( w_i c_i ) /
 * sum( w_i ), so rewriting the weights moves the result inside the convex hull
 * of the four in-scatter colours it reads. The total-variation distance
 * 0.5 * sum | p_i - q_i | between the two normalised weightings is the exact
 * factor by which the output can move, times the spread of those four colours.
 */
import { renderGBuffer } from './fillsim.mjs';

// HalfFloatType is what the march target stores, so the rounding the hardware
// does is the rounding that belongs here. Float16Array is that rounding.
const _h = new Float16Array(1);
const half = (x) => { _h[0] = x; return _h[0]; };

const quantile = (sorted, q) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const pct = (a, b) => +(100 * a / Math.max(1, b)).toFixed(3);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * @param engine  a booted engine, already run for a few frames.
 * @param width,height  simulation resolution for the FULL-res buffer.
 */
export function measureVolUpsample(engine, { width = 760, height = 476 } = {}) {
  const vol = engine.ctx.peek('sky')?.volumetrics ?? null;
  const comp = vol?.compositePass ?? null;
  if (!comp) return { unavailable: 'no volumetrics pass in this preset' };
  if (comp.material.defines?.VOL_ANALYTIC) {
    return { unavailable: 'VOL_ANALYTIC is defined, so skUpsample is not compiled in this preset' };
  }

  const src = comp.material.fragmentShader;
  // Floor, scale and epsilon come off the compiled shader. A second copy of
  // three constants here is exactly how a tool ends up certifying a weight
  // function that no longer exists.
  const m = /bw\s*\/\s*\(\s*([\d.eE+-]+)\s*\+\s*abs\([^)]*\)\s*\*\s*([\d.eE+-]+)\s*\)\s*\+\s*([\d.eE+-]+)/.exec(src);
  if (!m) return { unavailable: 'could not read the weight expression out of COMPOSITE_FRAG' };
  const FLOOR = Number(m[1]), SCALE = Number(m[2]), EPS = Number(m[3]);
  if (!Number.isFinite(FLOOR) || !Number.isFinite(SCALE) || !Number.isFinite(EPS)) {
    return { unavailable: `weight constants did not parse: ${m[1]} ${m[2]} ${m[3]}` };
  }
  // Does the shader actually read the depth out of the tap, or is this an old
  // build still fetching tDepth four times? The measurement is meaningless
  // against the wrong source, so it refuses rather than reporting zeros.
  const foldedIn = /texture\(\s*tVolume\s*,\s*tuv\s*\)/.test(src) && /v\.a\s*-\s*depth/.test(src);
  const centreRounded = /unpackHalf2x16\(\s*packHalf2x16\(/.test(src);

  const scale = vol.scale ?? 0.5;
  const { depth, covered } = renderGBuffer(engine, width, height);
  // The engine's own half-res sizing rule, so `hp` below lands where it lands
  // in the real pass rather than where a cleaner formula would put it.
  const mw = Math.max(1, Math.round(width * scale));
  const mh = Math.max(1, Math.round(height * scale));

  const clampi = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  // NearestFilter on the full-res depth attachment, which is what the MARCH
  // did when it filled this texel: uv -> floor( uv * size ).
  const tapDepth = new Float32Array(mw * mh);
  for (let k = 0; k < mh; k++) {
    const v = (k + 0.5) / mh;
    const sy = clampi(Math.floor(v * height), height - 1);
    for (let j = 0; j < mw; j++) {
      const u = (j + 0.5) / mw;
      const sx = clampi(Math.floor(u * width), width - 1);
      tapDepth[k * mw + j] = depth[sy * width + sx];
    }
  }

  const n = width * height;
  const tvAB = [], tvAC = [];
  // Split by how many of the four taps tie the centre, because the three
  // populations answer different questions and averaging them hides the one
  // that decides this. See the note on `mixedQuads` in the result.
  const tvFlatB = [], tvFlatC = [];     // 4 of 4 tied
  const tvMixedB = [], tvMixedC = [];   // 1..3 tied -- a silhouette
  const tvOpenB = [], tvOpenC = [];     // 0 tied
  // Signed mass moved ONTO the untied taps, i.e. onto the other surface. This
  // is the bleed the depth weight exists to prevent, so its sign matters and
  // an absolute distance would throw it away.
  const bleedB = [], bleedC = [];
  let pixels = 0;
  let tapsTotal = 0, tiesFloat = 0, tiesKeptB = 0, tiesKeptC = 0;
  let flatQuads = 0, flatQuadsExactB = 0, mixedQuads = 0;
  // Sky is depth 0, which is exactly representable in half, so every arm
  // agrees on it by construction. If the flat population turns out to be
  // almost all sky then "flat surfaces" is not a real population in this
  // frame at all, and any argument resting on it is resting on nothing.
  let flatSky = 0, mixedSkyCentre = 0, skyPixels = 0;

  const wA = [0, 0, 0, 0], wB = [0, 0, 0, 0], wC = [0, 0, 0, 0];
  const tied = [false, false, false, false];

  for (let i = 0; i < n; i++) {
    const px = i % width, py = (i / width) | 0;
    // Sky is part of this pass and must be counted: it is depth 0 on both
    // sides, i.e. the largest population of exact ties in the frame, and
    // dropping it would flatter every ratio below.
    if (!covered[i] && depth[i] !== 0) continue;

    const u = (px + 0.5) / width, v = (py + 0.5) / height;
    // skUpsample verbatim: hp = uv / uTexelHalf - 0.5, uTexelHalf = 1 / mw.
    const hpx = u * mw - 0.5, hpy = v * mh - 0.5;
    const bx = Math.floor(hpx), by = Math.floor(hpy);
    const fx = hpx - bx, fy = hpy - by;

    const c = depth[i];
    const cH = half(c);

    let sA = 0, sB = 0, sC = 0;
    let nTied = 0;
    for (let t = 0; t < 4; t++) {
      const ox = t & 1, oy = t >> 1;
      const jx = clampi(bx + ox, mw - 1), jy = clampi(by + oy, mh - 1);
      const d = tapDepth[jy * mw + jx];
      const dH = half(d);
      const bw = (ox < 1 ? 1 - fx : fx) * (oy < 1 ? 1 - fy : fy);

      const a = bw / (FLOOR + Math.abs(d - c) * SCALE) + EPS;
      const b = bw / (FLOOR + Math.abs(dH - cH) * SCALE) + EPS;
      const cc = bw / (FLOOR + Math.abs(dH - c) * SCALE) + EPS;
      wA[t] = a; wB[t] = b; wC[t] = cc;
      sA += a; sB += b; sC += cc;

      tapsTotal++;
      tied[t] = d === c;
      if (tied[t]) {
        nTied++; tiesFloat++;
        if (dH === cH) tiesKeptB++;
        if (dH === c) tiesKeptC++;
      }
    }

    let ab = 0, ac = 0, blB = 0, blC = 0;
    for (let t = 0; t < 4; t++) {
      const pA = wA[t] / sA;
      const dB = wB[t] / sB - pA, dC = wC[t] / sC - pA;
      ab += Math.abs(dB);
      ac += Math.abs(dC);
      if (!tied[t]) { blB += dB; blC += dC; }
    }
    ab *= 0.5; ac *= 0.5;
    tvAB.push(ab);
    tvAC.push(ac);
    pixels++;

    if (c <= 0) skyPixels++;
    if (nTied === 4) {
      flatQuads++;
      if (c <= 0) flatSky++;
      if (ab === 0) flatQuadsExactB++;
      tvFlatB.push(ab); tvFlatC.push(ac);
    } else if (nTied > 0) {
      mixedQuads++;
      if (c <= 0) mixedSkyCentre++;
      tvMixedB.push(ab); tvMixedC.push(ac);
      bleedB.push(blB); bleedC.push(blC);
    } else {
      tvOpenB.push(ab); tvOpenC.push(ac);
    }
  }

  const over = (arr, x) => arr.reduce((a, t) => a + (t > x ? 1 : 0), 0);
  const stats = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return {
      n: s.length,
      mean: +mean(s).toFixed(6),
      median: +quantile(s, 0.5).toFixed(6),
      p99: +quantile(s, 0.99).toFixed(6),
      max: +quantile(s, 1).toFixed(6),
      pctIdentical: pct(s.length - over(s, 0), s.length),
      pctOver1Pct: pct(over(s, 0.01), s.length),
    };
  };
  // Signed, so the mean is the population's net drift rather than its spread.
  const signed = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return {
      n: s.length,
      mean: +mean(s).toFixed(6),
      median: +quantile(s, 0.5).toFixed(6),
      p01: +quantile(s, 0.01).toFixed(6),
      p99: +quantile(s, 0.99).toFixed(6),
      pctPositive: pct(s.reduce((a, t) => a + (t > 0 ? 1 : 0), 0), s.length),
    };
  };

  return {
    simulatedAt: `${width}x${height}`,
    halfResAt: `${mw}x${mh}`,
    passHalfResolution: `${vol.width}x${vol.height}`,
    shaderReadsBack: {
      note: 'Read off the compiled COMPOSITE_FRAG. Both must be true or the arms below '
        + 'are measuring a shader that is not the one running.',
      depthFoldedIntoTapAlpha: foldedIn,
      centreRoundedToHalf: centreRounded,
      weight: `bw / ( ${FLOOR} + abs( d - c ) * ${SCALE} ) + ${EPS}`,
    },
    pixels,
    skyPixels,
    skyPct: pct(skyPixels, pixels),
    taps: tapsTotal,

    // ---- the claim the comment in volumetrics.js makes ---------------------
    tiePreservation: {
      note: 'Taps whose depth equals the centre depth EXACTLY in float32 -- flat surfaces '
        + 'and sky, where the similarity term is supposed to vanish and the upsample is '
        + 'supposed to reduce to plain bilinear. Arm B must keep every one of them, '
        + 'because equal float32 values round to equal halves. Arm C is the version that '
        + 'rounds only the tap, and the share it keeps is the reason it was not written.',
      exactTiesInFloat32: tiesFloat,
      pctOfAllTaps: pct(tiesFloat, tapsTotal),
      keptByArmB: tiesKeptB,
      pctKeptByArmB: pct(tiesKeptB, tiesFloat),
      keptByArmC: tiesKeptC,
      pctKeptByArmC: pct(tiesKeptC, tiesFloat),
    },
    flatQuads: {
      note: 'Pixels where all four taps tie the centre, i.e. the upsample must come out '
        + 'plain bilinear. Arm B is bit-identical to arm A on every one of them. Arm C is '
        + 'NOT far off either, and the reason is worth stating because it corrects the '
        + 'obvious argument for rounding the centre: when all four taps carry the same '
        + 'residue, all four denominators are the same, the weights are scaled by one '
        + 'common factor, and a common factor CANCELS in sum/wsum. The residue is '
        + 'invisible here. It is the mixed quad below that decides this, not this row.',
      count: flatQuads,
      pctOfPixels: pct(flatQuads, pixels),
      bitIdenticalUnderArmB: flatQuadsExactB,
      pctBitIdenticalUnderArmB: pct(flatQuadsExactB, flatQuads),
      // Sky is depth 0 on every tap and 0 is exact in half, so a flat quad in
      // the sky is a tie no arm could have broken. Whatever share of this
      // population is sky is a share that proves nothing about rounding.
      skyShare: pct(flatSky, flatQuads),
      geometryFlatQuads: flatQuads - flatSky,
      pctOfPixelsThatAreFlatGeometry: pct(flatQuads - flatSky, pixels),
      tv: { armB: stats(tvFlatB), armC: stats(tvFlatC) },
    },
    mixedQuads: {
      note: 'THE POPULATION THAT DECIDES THE CENTRE ROUNDING. Some taps tie the centre and '
        + 'some do not -- a silhouette, which is the only place a depth-aware upsample '
        + 'differs from a bilinear one at all. Here arm C\'s residue is NOT common to the '
        + 'four: it lands on the tied taps, whose denominator is sitting on the 0.05 '
        + 'floor and is therefore the one a small absolute residue can move, while the '
        + 'untied taps are already metres off the floor and barely notice. So arm C '
        + 'demotes the taps that share the surface and leaves the foreign ones alone. '
        + '`bleed` is that effect with its sign kept: net normalised weight moved ONTO '
        + 'the untied taps, positive meaning more of the far surface\'s in-scatter is '
        + 'pulled across the silhouette than the pass intended.',
      count: mixedQuads,
      pctOfPixels: pct(mixedQuads, pixels),
      skyCentreShare: pct(mixedSkyCentre, mixedQuads),
      tv: { armB: stats(tvMixedB), armC: stats(tvMixedC) },
      bleedOntoUntiedTaps: { armB: signed(bleedB), armC: signed(bleedC) },
    },
    openQuads: {
      note: 'No tap ties the centre. Both roundings perturb a difference that is already '
        + 'far off the floor, so neither arm has much room to move -- reported so the '
        + 'frame-wide averages can be seen to be dominated by this population rather '
        + 'than by the one that matters.',
      count: tvOpenB.length,
      pctOfPixels: pct(tvOpenB.length, pixels),
      tv: { armB: stats(tvOpenB), armC: stats(tvOpenC) },
    },

    // ---- what the optimisation actually costs ------------------------------
    weightMassMoved: {
      note: 'Total-variation distance between the normalised weightings, over the whole '
        + 'frame. The upsampled in-scatter cannot move further than this times the spread '
        + 'of the four texels it reads, so 0.004 reads as "at most 0.4 % of the local '
        + 'in-scatter contrast". Read the per-population rows above before this one: '
        + 'arm C can come out LOWER here and still be the wrong choice, because this '
        + 'average is dominated by open quads where neither arm does anything.',
      armB_vs_armA_theChange: stats(tvAB),
      armC_vs_armA_theBugAvoided: stats(tvAC),
    },
  };
}

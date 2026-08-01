import * as THREE from 'three';
import { SkyPass, hdrTarget } from './fullscreen.js';
import { ATMOSPHERE_GLSL } from './atmosphere.js';
import { NOISE_GLSL } from './noise.js';
import { CLOUDS_GLSL } from './clouds.js';

/**
 * Volumetric fog, light shafts and aerial perspective.
 *
 * Three steps, registered as one pass with the renderer:
 *
 *   1  march     half resolution, 24-56 exponentially distributed steps,
 *                interleaved-gradient dithered start offset, dual-lobe
 *                Henyey-Greenstein phase, shadowed by the renderer's cascade
 *                array *and* by the cumulus deck overhead
 *   2  resolve   temporal accumulation with velocity reprojection and a 3x3
 *                neighbourhood clamp — this is what turns 32 dithered samples
 *                into a clean shaft instead of a noise field
 *   3  composite full resolution: analytic per-channel transmittance from the
 *                closed-form exponential-height integral (so the haze on
 *                distant geometry is crisp and noise-free) plus a depth-aware
 *                bilateral upsample of the inscatter
 *
 * When `config.q.volumetrics` is off, step 1 and 2 are skipped and the
 * composite falls back to a fully analytic single-scattering approximation:
 * no shafts, but the aerial perspective is identical, so a low-end machine
 * still gets the correct distance falloff rather than a different-looking scene.
 *
 * SCATTERING vs EXTINCTION. These are separate uniforms and deliberately not
 * tied by a single-scattering albedo. Extinction is set by the visibility we
 * want down the street (that is what makes the far end desaturate correctly);
 * the inscatter gain is set by how readable the shafts need to be. Every
 * shipping engine's exponential height fog exposes exactly this pair, for
 * exactly this reason — a physically closed system either has invisible shafts
 * outdoors or milk at 200 m, and no single density gives both.
 */

const SHARED = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
${CLOUDS_GLSL}

uniform sampler2D uSkyAmbientLut;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec4 uFog;      // x sigmaS, y 1/heightScale, z baseY, w maxDistance
uniform vec4 uFog2;     // x sigmaE, y key boost, z ambient boost, w noise amount
uniform vec3 uFogExt;   // per-channel extinction, for the analytic transmittance
uniform vec4 uPhase;    // x g fwd, y g back, z back weight, w noise scale
uniform vec3 uKeyDir;
uniform vec3 uKeyIrr;
uniform vec3 uFogDrift;

/**
 * Colour of the haze, as a function of the angle to the key.
 *
 * A single ambient colour for the whole frame is what "grey fog at sunset" is:
 * one number cannot be both the amber the air takes on when you look into a low
 * sun and the blue it takes on when you look away from it, so it ends up neither
 * and every facade past 40 m converges on the same neutral value as the sky.
 *
 * The two texels of the ambient LUT are exactly the two ends of that axis — the
 * cosine-weighted whole-sky average (cool, Rayleigh dominated) and the horizon
 * band average (warm, aerosol dominated, and at 19h it *is* the sunset) — so the
 * split costs one extra tap and no new tuning. On top of that the forward lobe
 * carries the key's own transmitted spectrum, because the aerosol that produces
 * it is being lit by the beam, not by the sky. Result: distance separates by hue.
 *
 * cool and hor ARRIVE AS ARGUMENTS rather than being fetched here, because they
 * are the same two texels on every fragment of the frame — this function used to
 * spend 1.67 M fetches a frame at half resolution re-reading a 2x1 texture.
 * AMBIENT_VERT reads them once per vertex and hands them over flat, which is
 * three reads a draw and not an approximation of anything: a flat varying is
 * delivered unchanged from the provoking vertex, so the values here are bit for
 * bit the ones the texture unit returned.
 */
vec3 skFogAmbient( float cosKey, vec3 cool, vec3 hor ) {
  vec3 keyHue = uKeyIrr / max( 1.0e-4, max( uKeyIrr.x, max( uKeyIrr.y, uKeyIrr.z ) ) );
  // Squared so the warm half is genuinely centred on the sun rather than
  // covering the whole sunward hemisphere.
  float f = 0.5 + 0.5 * clamp( cosKey, -1.0, 1.0 );
  vec3 warm = hor * mix( vec3( 1.0 ), keyHue, 0.55 ) * 1.3;
  return mix( cool, warm, f * f );
}

/** Dual-lobe HG: a forward peak for the shafts, a broad back lobe so the fog
 *  is still visible when the sun is behind you. Real aerosol does both. */
float skFogPhase( float cosTheta ) {
  return mix( skHG( cosTheta, uPhase.x ), skHG( cosTheta, uPhase.y ), uPhase.z );
}

/**
 * The shaft gain (uFog2.y) applied to the *anisotropic excess only*.
 *
 * Multiplying the whole phase function by 2.6 also multiplies its isotropic
 * floor, and that floor covers every pixel in the frame regardless of where the
 * sun is — so the knob that was supposed to make shafts readable was really a
 * 2.6x blue-grey veil over the whole image. Lifting only the part of the phase
 * function that rises above 1/4pi leaves the forward peak (where a shaft
 * actually is) within a percent of what it was, and drops the 90°-off-sun
 * inscatter that produces the veil by the full gain.
 *
 *   iso + ( p - iso ) * g   ==   p + max( 0, p - iso ) * ( g - 1 )
 *
 * written the second way because the first goes *negative* in the side lobes,
 * where this dual-lobe phase dips under 1/4pi.
 */
float skFogInscatterPhase( float cosTheta ) {
  const float iso = 1.0 / ( 4.0 * SK_PI );
  float p = skFogPhase( cosTheta );
  return p + max( 0.0, p - iso ) * ( uFog2.y - 1.0 );
}

/**
 * Near-field scattering ramp. Twelve metres of real air scatters nothing you
 * could measure: with sigmaS at 4.4e-3 the honest contribution of the first
 * 20 m was ~10% of a sunlit surface's radiance, laid flat over the near
 * geometry — a wash on the weapon, the hands and every wall inside arm's reach.
 * It exists because an exponential-height fog tuned for 200 m of street has to
 * start somewhere; ramping it in over the first few metres removes it without
 * touching the distance falloff that the tuning was for.
 */
float skFogNearRamp( float t ) {
  return smoothstep( 0.0, 12.0, t );
}

/** Normalised density: 1 at the fog base, exponential above, wind-torn. */
float skFogDensity( vec3 p ) {
  float h = exp( -( p.y - uFog.z ) * uFog.y );
  if ( uFog2.w <= 0.001 ) return h;
  vec3 q = p * uPhase.w + uFogDrift;
  float n = skVal3( q ) * 0.63 + skVal3( q * 2.71 + 5.1 ) * 0.37;
  return h * mix( 1.0, 0.30 + 1.55 * n, uFog2.w );
}

/**
 * Closed form of integral(0..t) exp(-(y-b)/H) ds along a ray. Exact, so the
 * transmittance applied to geometry is smooth at full resolution — none of the
 * banding you get from reusing a low-resolution marched alpha.
 */
float skHeightIntegral( float y0, float dy, float t ) {
  float d0 = exp( -( y0 - uFog.z ) * uFog.y );
  float x = dy * uFog.y * t;
  if ( abs( x ) < 1.0e-4 ) return d0 * t;
  return d0 * ( 1.0 - exp( -x ) ) / ( dy * uFog.y );
}

/** World ray through a uv, normalised onto the z = -1 plane before rotation. */
void skRayFor( vec2 uv, out vec3 dir, out float rayLen ) {
  vec4 h = uInvProj * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
  vec3 vd = h.xyz / h.w;
  vd /= max( 1.0e-6, -vd.z );
  vec3 w = mat3( uCamWorld ) * vd;
  rayLen = length( w );
  dir = w / rayLen;
}
`;

const CSM_GLSL = /* glsl */ `
uniform highp sampler2DArray owCsmMaps;
uniform mat4 owCsmMatrix[ OW_CASCADES ];
uniform vec4 owCsmSplit;
uniform vec4 owCsmRange;
uniform vec4 owCsmTexel;
uniform vec4 owCsmParams;
uniform vec2 owCsmMapSize;

vec2 skVogel( int i, int n, float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
  float theta = float( i ) * 2.39996323 + phi;
  return vec2( cos( theta ), sin( theta ) ) * r;
}

/**
 * Sun/moon visibility at a world point.
 *
 * TAP COUNT. This is the most expensive thing in the frame by a wide margin:
 * at 56 steps it is 98% of sky-vol-march, which fillcost puts at 146.8 M
 * texture fetches, ahead of every other pass. The voltaps command prices the
 * count against the real cascade maps, rasterised at their real 2048^2 from the
 * real caster list, by marching every pixel with this engine's own step
 * distribution, dither, density noise and cascade projection and evaluating
 * the visibility with each tap count on the SAME steps. What it found:
 *
 *   - The taps are not redundant. Over 2.76 M calls the four of them landed on
 *     3.998 distinct texels on average, so this is a real trade, not the
 *     removal of oversampling.
 *   - In ONE frame, two taps instead of four move the ray's weighted mean
 *     visibility by 0.16 percentage points on average (p99 2.9, max 8.9).
 *   - Averaged over the dither rotations -- which is the fixed point that
 *     sky-vol-resolve's 0.9 exponential accumulation walks to, since uFrame
 *     advances the dither every frame -- that falls to 0.026 points (p99 0.47,
 *     max 1.4). The accumulator recovers roughly six sevenths of the
 *     difference, because rotating the disc sweeps what the extra taps were
 *     covering.
 *
 * The taps stay on the VOGEL RADII and are not collapsed onto the disc centre,
 * even though a centre tap costs exactly the same. Measured: a single centre
 * tap is the one variant that does NOT converge -- rotating it returns the same
 * texel every frame, so it stays 0.22 points out (p99 3.5, max 9.0), an order
 * of magnitude worse than a single tap placed on the disc. The rotation is what
 * makes the accumulation work, and it only has something to sweep if the tap
 * sits off centre.
 *
 * One tap is measured too and is defensible at 0.047 points converged; it is
 * left at two so the estimate still holds up inside a single frame -- in a
 * region the resolve has just disoccluded there is no history to average.
 *
 * That last sentence is why this is a CEILING and not a constant any more. It
 * is an argument about the steps that carry the ray, and a global tap count
 * applies it to every step whether it carries anything or not. See
 * SK_VOL_TAP_TIER, which spends this budget only where that argument holds.
 */
#define SK_VOL_SHADOW_TAPS 2

/**
 * Skip the shadow lookup on a step whose weight is under this fraction of
 * uFog.x * uFog.w / VOL_STEPS -- the weight a step carries at unit density with
 * the near ramp fully in, on the longest ray the fog admits. A skipped step
 * keeps its transmittance and its sigmaS; only its visibility is charged as
 * full sun.
 *
 * That reference is the FRAME's scale, not the ray's; the numbers below were
 * measured before it became one, on rays where the two coincide. See the note
 * at wRef in main() for why the denominator moved and what it cost.
 *
 * WHY IT IS SOUND RATHER THAN CHEAP. The in-scatter is exactly affine in the
 * per-step visibilities: transmittance, sigmaS and sigmaE never read the shadow
 * term, so a step contributes w * vis with w = T * sigmaS * (1 - aT) / sigmaE
 * and forcing vis = 1 moves the ray's weighted visibility by exactly
 * w * (1 - vis) / sum(w). That is a bound, not an estimate, and every factor of
 * w is known before the call once aT is hoisted above it.
 *
 * WHERE IT FIRES, which is the whole reason it is worth anything. skFogNearRamp
 * is smoothstep( 0, 12, t ), so the first twelve metres are deliberately scaled
 * to almost nothing -- and by cod voltaps those same near steps are cascade 0,
 * which is 69.6% of every shadow call this pass makes. The expensive region and
 * the weightless region are the same region.
 *
 * MEASURED against the tap count, which is the other way to make this pass
 * cheaper and the one that was rejected. cod voltaps --converge=8, 144k rays,
 * absolute error on a ray's weighted visibility:
 *
 *            saves f/frag   mean      p99       max
 *   1 tap        43.1     0.00048   0.00877   0.03149   (rejected)
 *   eps 0.001    14.5     0.00014   0.00084   0.00133   (this)
 *   eps 0.003    18.4     0.00051   0.00309   0.00502   (measured reserve)
 *
 * Better than the rejected variant in every column while saving a third as
 * much, and the comparison is harsher than it looks: this error is
 * DETERMINISTIC, so its single-frame numbers are identical to the converged
 * ones above, while one tap degrades to mean 0.0028 / max 0.220 in a frame with
 * no history. That -- not the average -- is why the taps stayed at two.
 *
 * WHY 0.003 AND NOT 0.001, and why not 0.01 either. The yardstick is the
 * sampling error the SHIPPED estimator already carries: two Vogel taps against
 * three is mean 0.00027 / p99 0.00463 / max 0.01775 on the same statistic. At
 * 0.003 every column of this skip lands below that -- max 0.00502 against a
 * p99 the image already lives with -- so it is provably inside the noise the
 * pass is already made of. 0.01 is the next rung (65.1 f/frag, 8.1 M more) and
 * its max 0.02042 is comparable to the 2-vs-3-tap figure, but comparable is not
 * the same as smaller once the error is deterministic: tap noise is what the
 * 0.9 exponential average in sky-vol-resolve exists to remove, and a fixed bias
 * survives it untouched. Rejected on that asymmetry, not on the number.
 *
 * Worth 15.4 M fetches a frame against no skip at all; 3.3 M of that came from
 * this step. Re-run cod voltaps --converge=8 after touching the fog tuning, the
 * step count or the near ramp.
 */
#define SK_VIS_SKIP 0.003

/**
 * Weight below which a step gets ONE tap instead of SK_VOL_SHADOW_TAPS. Same
 * wRef units as SK_VIS_SKIP, so the two thresholds are directly comparable and
 * the ladder reads [skip below 0.003] [one tap below 0.1] [two taps above].
 *
 * 0.1 was tuned when wRef was the ray's own length; it now rides the frame
 * constant, which on a short ray demotes steps this rung used to give two taps.
 * The -49.9% measured at wRef INCLUDES that -- both thresholds moved together in
 * the measurement -- but whether 0.1 is still the best point afterwards is not
 * measured. cod voltaps --theta is the tool for it.
 *
 * WHY THERE IS A MIDDLE RUNG AT ALL. The two knobs that existed before this one
 * are both all-or-nothing. The tap count is global, so making the cheap steps
 * cheaper makes the steps that carry the ray cheaper too -- that is exactly why
 * one tap was rejected above. The weight skip is per step and therefore
 * targeted, but the only cheaper thing it can do is charge FULL SUN, which is
 * the largest error a step can have. So the shader was choosing per step
 * between its best estimate and its worst one, with nothing in between.
 *
 * The middle rung dominates raising the skip, and it is arithmetic rather than
 * a hope. On a step where the skip charges w * (1 - vis), one tap charges
 * w * |vOne - vis|, and vOne is an unbiased sample of the same filter disc that
 * vis averages -- so it lies between vis and 1 and the error cannot be larger.
 * Measured at MATCHED cost with cod voltaps, absolute error on a ray's weighted
 * visibility (single frame / converged over 8 dither rotations):
 *
 *                       f/frag    mean               p99               max
 *   shipped, no tier      70.9   0.00051            0.00309           0.00502
 *   skip eps 0.03         58.0   0.00733            0.05184           0.07510
 *   THIS, theta 0.1       59.0   0.00057 / 0.00052  0.00327 / 0.00310  0.04093 / 0.00714
 *
 * Fourteen times better in the mean at the same price, and the gap widens after
 * the accumulator: the skip's error is a DETERMINISTIC bias and survives
 * sky-vol-resolve's 0.9 exponential average untouched, while this one is tap
 * noise on a disc whose rotation advances with uFrame, so the resolve sweeps it
 * the same way it sweeps the two-tap noise the pass is already made of. The
 * asymmetry that argued against raising the skip argues FOR this.
 *
 * WHY 0.1 AND NOT 0.3. The yardstick is the sampling error the shipped
 * estimator already carries -- two Vogel taps against three, on this same
 * statistic: mean 0.00163 / p99 0.02840 / max 0.10790 in a single frame,
 * mean 0.00027 / p99 0.00463 / max 0.01775 converged. At 0.1 every column of
 * this tier lands below both rows, and the single-frame max has 2.6x of headroom
 * -- which matters because the single frame is the disoccluded case, the one the
 * tap count was held at two for. 0.3 is the next rung (52.2 f/frag, 6.8 more)
 * and it is defensible on the converged columns alone, but its single-frame max
 * of 0.11389 is the first rung to cross the 0.10790 the pass already lives with.
 * Rejected for being outside the existing noise rather than inside it.
 *
 * Worth 11.9 f/frag, 16.8% of sky-vol-march. Re-run cod voltaps (both
 * --converge=1 and --converge=8) after touching the fog tuning, the step count,
 * the near ramp or SK_VOL_SHADOW_TAPS.
 */
#define SK_VOL_TAP_TIER 0.1

/**
 * taps is a runtime count in [1, SK_VOL_SHADOW_TAPS], not a define. The loop
 * bound stays the define so the compiler can still unroll to a fixed maximum;
 * the break is what makes the work dynamic.
 *
 * skVogel receives taps, NOT the define. The disc radius is sqrt((i+0.5)/n),
 * so the count is what places the tap: at n = 1 the single tap sits at
 * sqrt(0.5) of the disc, which is the unbiased position cod voltaps measured
 * and the one the file's own note above calls "a single tap placed on the disc".
 * Passing the define instead would put it at sqrt(0.25) and quietly measure a
 * different estimator -- closer to the centre tap that was measured and
 * rejected for not converging under rotation.
 */
float skSunVisibility( vec3 wPos, float viewDepth, float rot, int taps ) {
  if ( owCsmParams.x <= 0.0 ) return 1.0;
  if ( viewDepth >= owCsmSplit[ OW_CASCADES - 1 ] ) return 1.0;

  int c = OW_CASCADES - 1;
  for ( int i = 0; i < OW_CASCADES; i ++ ) {
    if ( viewDepth < owCsmSplit[ i ] ) { c = i; break; }
  }

  vec4 sc = owCsmMatrix[ c ] * vec4( wPos, 1.0 );
  vec3 proj = sc.xyz / sc.w * 0.5 + 0.5;
  if ( proj.z >= 1.0 || proj.z <= 0.0 ) return 1.0;
  vec2 edge = min( proj.xy, 1.0 - proj.xy );
  if ( min( edge.x, edge.y ) <= 0.0 ) return 1.0;

  // No surface normal out here, so the bias is purely depth based; two texels
  // of the cascade's own range is enough to stop shafts self-shadowing.
  float recv = proj.z - ( owCsmTexel[ c ] * 2.2 ) / owCsmRange[ c ];
  float r = owCsmMapSize.y * 1.6;
  float s = 0.0;
  for ( int i = 0; i < SK_VOL_SHADOW_TAPS; i ++ ) {
    if ( i >= taps ) break;
    vec2 o = skVogel( i, taps, rot * 6.2831853 ) * r;
    s += step( recv, texture( owCsmMaps, vec3( proj.xy + o, float( c ) ) ).r );
  }
  return mix( 1.0, s / float( taps ), owCsmParams.x );
}
`;

/**
 * SKY_VERT plus the two ambient-LUT texels, read once per vertex.
 *
 * The only thing a full-screen triangle's vertex stage is good for. Both texels
 * are frame constants -- the LUT is 2x1 and the coordinates are literals -- so
 * every fragment was fetching the same two values out of the same two texels.
 * Three vertices instead of a million pixels, and `flat` means no interpolation
 * happens at all, so the fragment sees exactly the bits the texture unit
 * produced rather than a blend that would only be a constant in exact
 * arithmetic.
 *
 * Both passes that include SHARED get this, not just the march: the composite's
 * VOL_ANALYTIC arm calls skFogAmbient too, and one vertex shader for both is
 * cheaper to keep honest than a define. On the marched path the composite reads
 * neither varying and the compiler drops them.
 */
const AMBIENT_VERT = /* glsl */ `
uniform sampler2D uSkyAmbientLut;
out vec2 vUv;
flat out vec3 vAmbCool;
flat out vec3 vAmbHor;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vAmbCool = texture( uSkyAmbientLut, vec2( 0.25, 0.5 ) ).rgb;
  vAmbHor = texture( uSkyAmbientLut, vec2( 0.75, 0.5 ) ).rgb;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const MARCH_FRAG = /* glsl */ `
precision highp float;
${SHARED}
${CSM_GLSL}
uniform sampler2D tDepth;
uniform float uFrame;
in vec2 vUv;
// The ambient LUT, read once per vertex. See AMBIENT_VERT.
flat in vec3 vAmbCool;
flat in vec3 vAmbHor;
layout(location = 0) out vec4 fragColor;

void main() {
  vec3 dir;
  float rayLen;
  skRayFor( vUv, dir, rayLen );

  // THE ALPHA OF THIS TARGET IS THE VIEW DEPTH, not the transmittance it used
  // to be. T was written, temporally resolved and then never read: the
  // composite computes its own analytic transmittance from skHeightIntegral
  // and only ever took .rgb from here. The channel was dead, and the composite
  // was paying four full-resolution tDepth fetches per pixel to recover
  // exactly the number this pass already has in hand -- see skUpsample below.
  float depth = texture( tDepth, vUv ).r;
  bool sky = depth <= 0.0;
  float maxT = sky ? uFog.w : min( depth * rayLen, uFog.w );
  if ( maxT <= 0.02 ) { fragColor = vec4( 0.0, 0.0, 0.0, depth ); return; }

  float dith = skIGN( gl_FragCoord.xy + uFrame * 5.588238 );
  float cosKey = dot( dir, uKeyDir );
  float phase = skFogInscatterPhase( cosKey );
  vec3 ambient = skFogAmbient( cosKey, vAmbCool, vAmbHor ) * uFog2.z;

  // Cloud shadow, twice per ray rather than once per step. skCloudShadow runs a
  // four-octave fbm plus a three-octave ridge; at 56 steps that was over half
  // the cost of the whole pass, to resolve a field whose features are hundreds
  // of metres across along a ray at most 900 m long. Two taps and a lerp are
  // visually indistinguishable and about 25x cheaper.
  float cloudNear = skCloudShadow( uCamPos.xz, uKeyDir );
  float cloudFar = skCloudShadow( ( uCamPos + dir * maxT ).xz, uKeyDir );

  vec3 L = vec3( 0.0 );
  float T = 1.0;
  float prev = 0.0;

  // The two weight thresholds, both as pure ratios of wRef -- the weight a step
  // would carry at unit density with the near ramp fully in, on the LONGEST ray
  // the fog admits -- so neither changes meaning when the fog is retuned. See
  // SK_VIS_SKIP and SK_VOL_TAP_TIER.
  //
  // WHY uFog.w AND NOT maxT. This used to be the ray's OWN length, which made
  // "negligible" mean something different in every pixel: on a 15 m ray the skip
  // threshold was sixty times smaller than on the sky ray beside it, in the same
  // image, under the same sun. A step's contribution to the picture does not
  // know how far its own ray happens to reach, so the scale it is judged against
  // must not either. uFog.w is the one scale the whole frame shares.
  //
  // Two tools found the same thing from opposite ends. cod fillcost: 72.5% of
  // every shadow tap this pass makes goes to a GEOMETRY pixel (84,662 px at
  // 41.64 tapping steps against sky's 59,338 at 22.56). cod volsteps: rays under
  // 400 m carry 1.3% of the frame's in-scatter. Three quarters of the fetches
  // for a hundredth of the output.
  //
  // It can only ever skip MORE, and on the rays that matter it changes nothing:
  // maxT = min( depth * rayLen, uFog.w ) <= uFog.w, so the new wRef is >= the old
  // one everywhere, with EQUALITY exactly on sky rays. Bit-identical on the 41.2%
  // of pixels that carry 98.7% of the in-scatter, and -49.9% of the pass.
  //
  // DO NOT JUDGE THIS BY cod voltaps' |dV|, which reports mean 0.1436 / p99
  // 0.9983 for it and does not converge. That statistic is a ray's weighted
  // visibility error divided by ITS OWN weight, and this change touches only
  // rays whose denominator is near zero -- it is the right yardstick for
  // comparing taps at equal weights and the wrong one here. Read cod volsteps'
  // inscatterBound, which divides by the FRAME mean once: 0.02556 -> 0.02681
  // (+4.9%) with p99 0.31078 and max 0.64088 bit-identical, and the fog's own
  // opacity -- the S0 column, which no sun angle switches off -- bit-identical at
  // 0.00393. Converged over 8 dithers and 4 rotations: 0.01392 -> 0.01522, p99
  // and max again bit-identical. In absolute terms the short buckets move
  // 0.24-0.32% of the frame's mean fog (max 3.3%) where this pass already carries
  // 6.1% on the sky rays. The normalisation was checked rather than assumed:
  // meanPhase on the short buckets is 0.0636 / 0.0480 / 0.0516 against sky's
  // 0.0522, so the population this touches carries no gain premium over the one
  // it leaves alone.
  //
  // Measured on two grids (128x80, 240x150) plus the converged run, agreeing to
  // three figures. Re-run cod volsteps and cod voltaps --converge=8 after
  // touching uFog.w (f.maxDistance in sky/index.js), the step count or the ramp.
  float wRef = uFog.x * uFog.w / float( VOL_STEPS );
  float wSkip = SK_VIS_SKIP * wRef;
  float wTier = SK_VOL_TAP_TIER * wRef;

  for ( int i = 0; i < VOL_STEPS; i ++ ) {
    // Exponential distribution: shafts need centimetres near the camera and
    // tens of metres out at the far plane.
    float f = ( float( i ) + dith ) / float( VOL_STEPS );
    float t = maxT * f * f * ( 3.0 - 2.0 * f ) * 0.35 + maxT * f * f * f * 0.65;
    float dt = t - prev;
    prev = t;
    if ( dt <= 1.0e-5 ) continue;

    vec3 wp = uCamPos + dir * t;
    float dens = skFogDensity( wp );
    if ( dens <= 1.0e-4 ) continue;

    float sigmaS = uFog.x * dens * skFogNearRamp( t );
    float sigmaE = max( 1.0e-7, uFog2.x * dens );

    // This step's coefficient, hoisted above the shadow call. Nothing in it
    // depends on visibility -- transmittance, sigmaS and sigmaE never read the
    // shadow term -- so the in-scatter is exactly affine in vis with w as the
    // weight, and a step whose w is negligible cannot move the image no matter
    // what its lookup would have returned.
    float aT = exp( -sigmaE * dt );
    float w = T * sigmaS * ( 1.0 - aT ) / sigmaE;

    // Three tiers by this step's own weight: no call, one tap, or the full
    // budget. w is already in hand and costs nothing to test -- that is what
    // SK_VIS_SKIP established and this reuses.
    float vis = w < wSkip ? 1.0
      : skSunVisibility( wp, t / rayLen, dith, w < wTier ? 1 : SK_VOL_SHADOW_TAPS );
    vis *= mix( cloudNear, cloudFar, f );

    // Ambient occlusion proxy: a shadowed sample is either inside a building or
    // behind one, and in both cases it sees far less sky than a lit sample. It
    // is an approximation, but it is the difference between an interior reading
    // as an interior and reading as a foggy field.
    float ambOcc = 0.42 + 0.58 * vis;

    // phase already carries the shaft gain on its anisotropic part only, so
    // this is the forward lobe lifted and nothing else.
    vec3 j = uKeyIrr * ( vis * phase ) + ambient * ambOcc;

    L += w * j;
    T *= aT;
    if ( T < 0.004 ) break;
  }

  fragColor = vec4( L, depth );
}
`;

const RESOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform float uBlend;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
  vec4 cur = texture( tCurrent, vUv );
  vec2 vel = texture( tVelocity, vUv ).rg;
  vec2 huv = vUv - vel;

  vec4 lo = cur, hi = cur;
  for ( int i = 0; i < 9; i ++ ) {
    if ( i == 4 ) continue;
    vec2 o = vec2( float( i % 3 ) - 1.0, float( i / 3 ) - 1.0 ) * uTexel;
    vec4 n = texture( tCurrent, vUv + o );
    lo = min( lo, n );
    hi = max( hi, n );
  }
  // Widen slightly: clamping hard to the 3x3 range throws away the very
  // convergence the accumulation exists to buy.
  vec4 c = 0.5 * ( lo + hi );
  vec4 e = 0.5 * ( hi - lo ) * 1.6 + 1.0e-5;
  vec4 his = clamp( texture( tHistory, huv ), c - e, c + e );

  float w = uBlend;
  if ( huv.x < 0.0 || huv.x > 1.0 || huv.y < 0.0 || huv.y > 1.0 ) w = 0.0;
  // COLOUR ONLY. Alpha carries this frame's view depth (see the march), and
  // the composite compares it against this frame's centre depth, so blending
  // it with a reprojected older one would hand the upsample a depth that
  // belongs to neither pixel. The clamp above still runs on all four channels
  // because it costs nothing -- the alpha lane of it is dead code the
  // compiler drops, and splitting the vec4 would only make the min/max loop
  // read worse than it does.
  fragColor = vec4( mix( cur.rgb, his.rgb, w ), cur.a );
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
${SHARED}
uniform sampler2D tColor;
uniform sampler2D tVolume;
uniform sampler2D tDepth;
uniform vec2 uTexelHalf;
in vec2 vUv;
// Only the VOL_ANALYTIC arm reads these; on the marched path the compiler drops
// them and the vertex stage's two reads go nowhere. See AMBIENT_VERT.
flat in vec3 vAmbCool;
flat in vec3 vAmbHor;
layout(location = 0) out vec4 fragColor;

#ifndef VOL_ANALYTIC
/** Depth-aware 4-tap upsample: bilinear weights times a depth-similarity
 *  weight, which stops a bright shaft bleeding across a foreground silhouette.
 *
 * MEASURED AND REJECTED -- collapsing the four tVolume taps to one bilinear
 * fetch on flat depth. Do not re-attempt without a GPU to verify on.
 *
 * The idea. Where all four tap depths equal the centre depth -- sky interior,
 * and sky is 41.2% of the frame at the measured 1 deg/frame turn (cod fill
 * --real puts sky-dome at 4.12 of its 10 fetches per fragment, and that ratio
 * IS the uncovered share) -- every depth-similarity weight is the same 1/0.05,
 * so w is proportional to bw, the bw sum to 1, and sum/wsum reduces to the
 * plain bilinear interpolation of the four texels. tVolume is a LinearFilter
 * target, so one hardware fetch would return that. Worth 3 fetches on the
 * inside of the sky, about 3.8 M: 0.9% of the frame.
 *
 * Two reasons it does not happen, and the second one is fatal.
 *
 *   1. The + 1.0e-5 below breaks the proportionality. It is dead weight -- bw
 *      max is at least 0.25 and the denominator is at most 0.05 + 1200 * 0.35,
 *      so wsum cannot reach zero without it -- and dropping it shifts the
 *      result by 5.0e-7 * ( sum of the four minus four times the interpolated
 *      value ), which is under the half-float step everywhere and therefore
 *      free after the store. So this one is only a first step, not a wall.
 *   2. Hardware bilinear does not compute the same weights this loop does.
 *      ES 3.0 requires only 4 bits of subtexel precision and desktop parts
 *      typically give 8, against the float32 f above. A weight quantised to
 *      1/256 puts up to 2^-9 of the four taps' SPREAD into the result, and on
 *      a shaft edge the spread is the order of the value itself -- roughly
 *      2e-3 relative, four times the half-float step of 4.88e-4. It is not
 *      bit-identical on any hardware, the size of the error is a property of
 *      the driver rather than of this code, and there is no GPU in this
 *      toolchain to bound it on.
 *
 * That buys a data-dependent, unverifiable difference on the main colour path
 * for 0.83%. The reserve worth spending instead is SK_VOL_SHADOW_TAPS above:
 * measured at 36 M, ten times this, for one line.
 */
vec3 skUpsample( vec2 uv, float depth ) {
  vec2 hp = uv / uTexelHalf - 0.5;
  vec2 base = floor( hp );
  vec2 f = hp - base;
  vec3 sum = vec3( 0.0 );
  float wsum = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 o = vec2( float( i & 1 ), float( i >> 1 ) );
    vec2 tuv = ( base + o + 0.5 ) * uTexelHalf;
    float bw = ( o.x < 0.5 ? 1.0 - f.x : f.x ) * ( o.y < 0.5 ? 1.0 - f.y : f.y );
    // ONE fetch per tap. The march writes its own view depth into alpha, and
    // tuv is a half-res texel CENTRE by construction, so the bilinear tap
    // resolves to that single texel and this is the same depth the separate
    // tDepth fetch was reading -- the march sampled tDepth at this very uv.
    // It is in fact better defined: a half-res texel centre lands on a
    // full-res texel BOUNDARY, where NearestFilter is implementation-defined,
    // and now only one pass makes that choice instead of two.
    vec4 v = texture( tVolume, tuv );
    float w = bw / ( 0.05 + abs( v.a - depth ) * 0.35 ) + 1.0e-5;
    sum += v.rgb * w;
    wsum += w;
  }
  return sum / wsum;
}
#endif

void main() {
  vec3 color = texture( tColor, vUv ).rgb;
  vec3 dir;
  float rayLen;
  skRayFor( vUv, dir, rayLen );

  float depth = texture( tDepth, vUv ).r;
  bool sky = depth <= 0.0;
  float dist = sky ? uFog.w : min( depth * rayLen, uFog.w );

  // Analytic per-channel transmittance.
  //
  // This IS applied to sky pixels. The dome carries the full Rayleigh/Mie
  // integral out to space, but this layer is the *ground haze* — dust, exhaust,
  // the bottom 40 m of a hot street — and that layer is between the camera and
  // the sky just as much as it is between the camera and a wall. Skipping it
  // while still ADDING the in-scatter of a 900 m column made the fog a pure
  // emitter over every sky pixel: at 2 degrees of elevation the optical depth
  // through an 18 m-scale-height layer is ~1.9, so the horizon sky was being
  // handed roughly its own radiance again in neutral in-scatter and no
  // extinction to pay for it. That is the cream void the sunset sky reads as,
  // and it is why the daylight zenith gradient stops dead a third of the way
  // up the frame.
  float od = skHeightIntegral( uCamPos.y, dir.y, dist );
  vec3 trans = exp( -uFogExt * od );

  #ifdef VOL_ANALYTIC
    // No raymarch available: single scattering with a uniform visibility term.
    // Same phase split and the same near-field ramp as the marched path, so the
    // two quality levels agree instead of grading the scene differently. The
    // ramp is folded in analytically: smoothstep(0,12,t) averages 0.5 over
    // [0,12] and 1 past it, so subtracting half the optical depth of the first
    // twelve metres reproduces the marched integral to within a few percent.
    float odNear = skHeightIntegral( uCamPos.y, dir.y, min( dist, 12.0 ) );
    float odS = max( 0.0, od - odNear * 0.5 );
    float mono = 1.0 - exp( -uFog2.x * odS );
    float cosKey = dot( dir, uKeyDir );
    vec3 inscatter = ( uKeyIrr * ( skFogInscatterPhase( cosKey ) * 0.55 )
                     + skFogAmbient( cosKey, vAmbCool, vAmbHor ) * uFog2.z )
                     * ( uFog.x / max( 1.0e-6, uFog2.x ) ) * mono;
  #else
    // The centre depth is rounded to half precision before the comparison,
    // because the four tap depths come out of a HalfFloatType target and have
    // been rounded already. Mixing the two precisions is the one way this
    // could have gone wrong, and "cod volupsample --q=ultra --study" measures
    // all three arms -- float32/float32 as the pass was before the change,
    // half/half as it is now, and half-tap/float32-centre as the version that
    // was not written.
    //
    // IT IS NOT THE REASON THIS COMMENT ORIGINALLY GAVE, which was that a
    // one-sided rounding leaves a residue where the tap ties the centre and so
    // invents weight on flat, fronto-parallel surfaces. That argument does not
    // survive the measurement, twice over: when all four taps tie, they all
    // carry the SAME residue, so the four denominators stay equal, the weights
    // are scaled by a common factor and the factor cancels in sum/wsum (arm C
    // measures 0 total variation on flat quads, same as arm B); and flat quads
    // are 40.0% of the frame but 99.99% of them are SKY, where the depth is 0
    // on every tap and 0 is exact in half. Flat GEOMETRY quads are 0.004% of
    // the frame. The premise was a population that is not there.
    //
    // The real reason is the SILHOUETTE, 18.4% of the frame, where some taps
    // tie the centre and some do not. There the residue is not common to the
    // four: it lands on the tied taps, whose denominator is sitting on the
    // 0.05 floor and is the only one a sub-metre residue can move, while the
    // untied taps are already metres off it. One-sided rounding therefore
    // demotes the taps that share the surface and leaves the foreign ones
    // alone -- it pulls the far surface's in-scatter across the silhouette,
    // which is the single thing a depth-aware upsample exists to prevent.
    // Measured at 1134x736: net normalised weight moved onto the foreign taps
    // is +0.001277 mean and one-directional on 85.1% of mixed pixels with a
    // float32 centre, against +0.000049 and 58.8% -- a coin flip -- with a
    // rounded one. Twenty-six times the drift, and biased rather than noisy.
    // Flat across all three simulated resolutions, because half rounding is a
    // relative error and a silhouette gap is metres of geometry; neither
    // scales with the texel footprint.
    //
    // The cost of the whole change, arm B against arm A frame-wide: 0.00134
    // mean total variation, 0.00019 median, 0.0103 at p99, and 40.0% of pixels
    // bit-identical -- i.e. at most about 0.1% of the local in-scatter
    // contrast on average, on a term that is itself additive over an already
    // fogged colour.
    float depthQ = unpackHalf2x16( packHalf2x16( vec2( depth, 0.0 ) ) ).x;
    vec3 inscatter = skUpsample( vUv, depthQ );
  #endif

  fragColor = vec4( color * trans + inscatter, 1.0 );
}
`;

export class Volumetrics {
  constructor(shared, renderSystem, opts = {}) {
    this.order = -70; // before anything fx/ui might register
    this.enabled = true;

    const csm = renderSystem.csm;
    this.marchEnabled = opts.volumetrics !== false && !!csm;
    const steps = opts.steps ?? 40;

    this.shared = shared;
    this.scale = opts.scale ?? 0.5;
    this.width = 1;
    this.height = 1;
    this.rtMarch = null;
    this.rtHistory = [null, null];
    this._flip = 0;
    this._reset = true;

    const base = {
      uMieScale: shared.uMieScale,
      uViewPos: shared.uViewPos,
      uSkyAmbientLut: shared.uSkyAmbientLut,
      uCloudParams: shared.uCloudParams,
      uCloudParams2: shared.uCloudParams2,
      uInvProj: shared.uInvProj,
      uCamWorld: shared.uCamWorld,
      uCamPos: shared.uCamPos,
      uFog: shared.uFog,
      uFog2: shared.uFog2,
      uFogExt: shared.uFogExt,
      uPhase: shared.uPhase,
      uKeyDir: shared.uKeyDir,
      uKeyIrr: shared.uKeyIrr,
      uFogDrift: shared.uFogDrift,
    };

    if (this.marchEnabled) {
      this.marchPass = new SkyPass(
        'sky-vol-march',
        MARCH_FRAG,
        {
          ...base,
          ...csm.uniforms, // shared by reference: always the live cascade fit
          tDepth: { value: null },
          uFrame: { value: 0 },
        },
        { VOL_STEPS: steps, OW_CASCADES: csm.cascades },
        AMBIENT_VERT
      );
      this.resolvePass = new SkyPass('sky-vol-resolve', RESOLVE_FRAG, {
        tCurrent: { value: null },
        tHistory: { value: null },
        tVelocity: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uBlend: { value: 0.9 },
      });
    }

    this.compositePass = new SkyPass(
      'sky-vol-composite',
      COMPOSITE_FRAG,
      {
        ...base,
        tColor: { value: null },
        tVolume: { value: null },
        tDepth: { value: null },
        uTexelHalf: { value: new THREE.Vector2() },
      },
      this.marchEnabled ? {} : { VOL_ANALYTIC: 1 },
      AMBIENT_VERT
    );
  }

  resize(w, h) {
    if (!this.marchEnabled) {
      this.width = w;
      this.height = h;
      return;
    }
    const mw = Math.max(1, Math.round(w * this.scale));
    const mh = Math.max(1, Math.round(h * this.scale));
    if (this.rtMarch && this.width === mw && this.height === mh) return;
    this.width = mw;
    this.height = mh;
    this.rtMarch?.dispose();
    this.rtHistory[0]?.dispose();
    this.rtHistory[1]?.dispose();
    this.rtMarch = hdrTarget(mw, mh, { name: 'sky-vol' });
    this.rtHistory[0] = hdrTarget(mw, mh, { name: 'sky-vol-h0' });
    this.rtHistory[1] = hdrTarget(mw, mh, { name: 'sky-vol-h1' });
    this.resolvePass.uniforms.uTexel.value.set(1 / mw, 1 / mh);
    this.compositePass.uniforms.uTexelHalf.value.set(1 / mw, 1 / mh);
    this._reset = true;
  }

  render(renderer, inTexture, outTarget, r) {
    let volume = null;

    if (this.marchEnabled) {
      if (!this.rtMarch) this.resize(r.screenSize.width, r.screenSize.height);
      const mu = this.marchPass.uniforms;
      mu.tDepth.value = r.depthTexture;
      mu.uFrame.value = r.frame % 64;
      this.marchPass.render(renderer, this.rtMarch);

      const ru = this.resolvePass.uniforms;
      const prev = this.rtHistory[this._flip ^ 1];
      const next = this.rtHistory[this._flip];
      ru.tCurrent.value = this.rtMarch.texture;
      ru.tHistory.value = prev.texture;
      ru.tVelocity.value = r.velocityTexture;
      ru.uBlend.value = this._reset ? 0 : 0.9;
      this.resolvePass.render(renderer, next);
      this._reset = false;
      this._flip ^= 1;
      volume = next.texture;
    }

    const cu = this.compositePass.uniforms;
    cu.tColor.value = inTexture;
    cu.tVolume.value = volume;
    cu.tDepth.value = r.depthTexture;
    this.compositePass.render(renderer, outTarget);
  }

  reset() {
    this._reset = true;
  }

  dispose() {
    this.rtMarch?.dispose();
    this.rtHistory[0]?.dispose();
    this.rtHistory[1]?.dispose();
    this.marchPass?.dispose();
    this.resolvePass?.dispose();
    this.compositePass.dispose();
  }
}

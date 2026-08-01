import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Per-object motion blur driven by the velocity buffer.
 *
 * Velocity is dilated over a tile so a fast object bleeds *outside* its own
 * silhouette (a blur that stops at the object's edge is the giveaway of a
 * naive implementation), samples are depth-weighted so the background does
 * not smear over a foreground object, and the shutter is expressed as a real
 * fraction of the frame time so the amount of blur is frame-rate independent.
 */

const TILE_MAX = /* glsl */ `
precision highp float;
uniform sampler2D tVelocity;
uniform vec2 uTexel;      // texel size of the full-res velocity buffer
varying vec2 vUv;
// 8x8 taps spread over the 16x16 source tile centred on this output texel.
void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = 0.0;
  for ( int y = 0; y < 8; y ++ ) {
    for ( int x = 0; x < 8; x ++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 3.5 ) * 2.0 * uTexel;
      vec2 v = texture2D( tVelocity, vUv + o ).rg;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

/**
 * @param depthInAlpha  true when tColor carries the INVERSE view depth in its
 *   alpha channel, which is what the TAA resolve publishes (see taa.js). The
 *   two variants are separate SOURCES rather than one source behind a #define,
 *   so the shader string handed to the compiler is also the one tools/cli
 *   reads: fragcost counts texture2D call sites in it and would otherwise
 *   charge this pass for both arms of a branch only one of which is compiled.
 *
 * WHAT THE TWO VERSIONS DIFFER BY, stated plainly rather than claimed away.
 * The depth attachment is NearestFilter and the resolve target is
 * LinearFilter, so the alpha path gets a BILINEAR BLEND of four reciprocals
 * where the tDepth path gets a point sample. Three things bound that:
 *
 *   1. The colour was ALREADY bilinear -- the loop has always sampled tColor
 *      at these same sub-texel offsets. So the point-sampled depth was
 *      weighting a blended colour with one texel's depth; the blend weights it
 *      with the depth of the same mixture. The new pairing is the consistent
 *      one, which is why this is not simply "less exact".
 *   2. Blending reciprocals is monotone between the two texels either side, so
 *      a blend can never decide the OPPOSITE of what both its endpoints decide.
 *      Blending depth can, which is the whole reason taa.js stores 1/d.
 *   3. The term is
 *        1 - smoothstep( 0.0, 1.5, ( d - centreDepth ) / max( 1.0, centreDepth ) )
 *      which saturates past 2.5x the centre distance. A real
 *      background-over-foreground silhouette -- a prop at 5 m against a street
 *      at 30 m -- is 6x, and 1/d puts every blend of the two past 2.5x for any
 *      mixture above 29%. The down-weight that stops the background smearing
 *      over the object is therefore the same one on all but a sliver of the
 *      edge.
 *
 * That leaves the shallow middle, a background at most 2.5x the centre depth,
 * where the term is already a smooth ramp and the blend widens it by a texel.
 *
 * MEASURED, NOT ASSERTED. cod mbdepth --q=ultra --study walks the pass's real
 * tap set over a rasterised depth buffer, evaluates both arms at the same uv,
 * and reports the TOTAL-VARIATION distance between the two normalised
 * weightings -- the exact factor the blurred colour can move by, times the
 * contrast under the streak. Over a 1 deg turn at three resolutions:
 *
 *      sim res     taps identical   mass moved: mean   p99     >1% of contrast
 *      480x300         66.3 %             0.00112    0.0448        2.55 %
 *      760x476         68.2 %             0.00086    0.0316        2.14 %
 *      1134x736        70.6 %             0.00064    0.0192        1.52 %
 *
 * The median is 0 at every resolution: more than half of all blurred pixels
 * come out bit-identical. It converges DOWNWARD with resolution, because a
 * coarser texel spans more world and makes every discontinuity look bigger
 * than it is, so the real 2268x1473 sits below the last row. The worst single
 * pixel is around 0.2 -- a long streak crossing a roofline at exactly the
 * half-texel where the two filters disagree most -- and it is inside a motion
 * blur streak, which is the one place in the frame nothing is expected to be
 * sharp. Monotonicity violations: 0 at all three, which is the 1/d decision
 * above holding rather than being hoped for.
 */
const BLUR = (depthInAlpha) => /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tTile;
${depthInAlpha ? '' : 'uniform sampler2D tDepth;'}
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uParams;   // x shutter, y maxRadiusPx, z frame, w intensity
varying vec2 vUv;

#define OW_MB_TAPS 12

// Streak pixels per TAP, and each tap is 2 fetches -- so the sample spacing is
// half this. Read out of the compiled shader by tools/cli/fillsim.mjs, which
// used to carry its own copy of the divisor; see the note over the tap rule in
// main() for what fixed it at 2.5 rather than the 2 it shipped with.
#define OW_MB_PX_PER_TAP 2.5

// The shutter profile, which is flat.
//
// It reads as though it were a taper, because the line it replaces was
// 1.0 - t * 0.35 and t runs 0..1 across the loop. It never was one. The old
// loop applied that factor to a sample AND to its mirror image, so position p
// was weighted 0.825 - 0.35p by one arm and 0.825 + 0.35p by the other, and the
// union of the two is flat at 0.825 -- the tilt only ever described the
// difference between the two interleaved combs, not the shutter. A box over the
// shutter interval is also what a real shutter integrates, so this is the
// profile the pass always had, now written as the constant it always was. The
// VALUE matters and is not a free choice: sum starts at the centre tap with
// wsum 1.0, so the samples' weight relative to that centre is what 0.825
// preserves.
#define OW_MB_SHUTTER 0.825

void main() {
  vec4 centre = texture2D( tColor, vUv );
  vec2 tileVel = texture2D( tTile, vUv ).rg;
  vec2 ownVel = texture2D( tVelocity, vUv ).rg;

  vec2 vel = length( tileVel ) > length( ownVel ) ? tileVel : ownVel;
  vel *= uParams.x;

  float pixels = length( vel * uResolution );
  if ( pixels < 1.0 ) { gl_FragColor = centre; return; }

  float maxPx = uParams.y;
  if ( pixels > maxPx ) vel *= maxPx / pixels;

  // Tap count follows the blur LENGTH instead of being fixed at 12.
  //
  // The loop lays 2 * OW_MB_TAPS samples over a line of radius pixels, so at
  // the pass's design point -- a 24 px streak, which is roughly a 2 deg/frame
  // turn at this resolution and shutter -- the spacing at the ORIGINAL divisor
  // of 2 was 24/24 = one sample per pixel. Below that length the spacing keeps
  // shrinking while the number of samples does not: a 6 px streak sampled 24
  // times at a quarter-pixel spacing resamples the same three texels over and
  // over for 48 of the pass's 52 fetches. Solving radius / ( 2 * taps ) = 1 for
  // taps removed that oversampling.
  //
  // WHAT MOVED THE DIVISOR FROM 2 TO 2.5. The density-1 rule was asserted and
  // never measured. tools/cli/mbsim.mjs measures it, against the same filter --
  // same depth weight, same shutter -- evaluated at 256 uniform samples, so
  // what comes out is the loop's own sampling error and nothing else. Read with
  // the banding/grain split rather than the PSNR: this pass runs AFTER the TAA
  // resolve, so nothing downstream resolves a dithered sample set, and the two
  // failure modes do not look alike.
  //
  // The rule below is a STRICT improvement on what shipped -- better on all
  // five measures, at four streak lengths, on both simulation grids, while
  // fetching the same or less. At 760x492, PSNR / edge / banding / grain / p99
  // in code values:
  //
  //   radius  shipped: 2 px/tap, mirrored    this: 2.5 px/tap, one comb
  //      6 px  6 f  43.4 37.2 0.70 1.40 8.19   6 f  45.7 38.5 0.61 1.11 6.47
  //   11.4 px 12 f  46.3 40.9 0.74 0.87 5.43  10 f  47.1 41.1 0.65 0.85 5.05
  //     20 px 20 f  48.5 44.0 0.65 0.64 3.94  16 f  48.9 44.0 0.60 0.63 3.65
  //     32 px 24 f  48.2 44.4 0.69 0.64 3.95  24 f  50.8 46.7 0.52 0.47 2.81
  //
  // Almost all of that is the GEOMETRY and not the count -- see the loop below.
  // 2.5 is where the divisor stops being free: at 3 px/tap the same comb falls
  // to 45.1 dB at 11.4 px, which is BELOW the shipped 46.3, so it is buying
  // fetches with quality rather than reclaiming waste. 2.5 is not tuned to a
  // frame either; it is the largest of the swept values that wins at every
  // radius, and the 6 px row shows it changing nothing there at all.
  float radius = min( pixels, maxPx );
  int taps = int( clamp( ceil( radius / OW_MB_PX_PER_TAP ), 2.0, float( OW_MB_TAPS ) ) );

  // Coverage comes off the DEPTH value, not off normal.z. The prepass clears
  // to zero and no drawn fragment can have a view depth of 0 (it would sit
  // behind the near plane), so d == 0.0 is EXACTLY the old cov < 0.5 test for
  // no fetch instead of two -- the same trade gtao.js and ssr.js already make
  // in their marches. See the contract note in prepass.js.
  //
  // The centre reads it out of the colour fetch already in hand. vUv lands on
  // a texel centre for a full-screen pass, so the bilinear tap there resolves
  // to the single texel and this is the same number tDepth would have given,
  // reciprocal and back.
  ${depthInAlpha
    ? 'float centreDepth = centre.a > 0.0 ? 1.0 / centre.a : 0.0;'
    : 'float centreDepth = texture2D( tDepth, vUv ).r;'}
  if ( centreDepth <= 0.0 ) centreDepth = 1e5;

  float jitter = owIGN( gl_FragCoord.xy + uParams.z * 2.717 ) - 0.5;

  vec3 sum = centre.rgb;
  float wsum = 1.0;

  // ONE uniform comb over the shutter interval, not two mirrored ones.
  //
  // The loop this replaces computed an offset and sampled at BOTH o and -o. In
  // units of the streak that puts arm s=0 at p_i = ( i + j ) / T - 0.5 and arm
  // s=1 at -p_i, and the mirror image of an arithmetic comb is the SAME comb
  // whenever 2j is an integer. So at j = 0 every sample was fetched exactly
  // twice and the effective density was half of what the tap rule intended; at
  // j = +-0.25 the two combs interleaved and it was what the rule said. j is
  // uniform on [-0.5, 0.5), so the pass paid for density 1 and received
  // somewhere between 0.5 and 1, differently in every pixel -- which is also
  // why the residue looked like grain rather than like undersampling.
  //
  // MEASURED, NOT ARGUED. Same fetch count, same everything else, mbsim.mjs
  // scoring both against the 256-sample integral: the comb is 2.4 to 3.0 dB
  // ahead at every streak length on both grids, with LOWER banding and LOWER
  // grain -- it is not trading one for the other. The mechanism is confirmed by
  // running both geometries at 114 taps, where sampling error should vanish:
  // the comb reaches 87.6 dB and the mirrored pair stalls at 75.6, because the
  // collision is a property of the jitter and does not go away with tap count.
  //
  // That control is also what makes the comparison fair, since the reference is
  // itself a comb: both geometries converge to the same integral, to within a
  // third of a code value, so the reference does not favour its own family.
  float nSamples = float( 2 * taps );
  // Constant bound with a dynamic break: the loop count stays compile-time so
  // the unroll is unaffected, and ESSL 1.00's constant-bound rule is honoured.
  for ( int i = 0; i < OW_MB_TAPS; i ++ ) {
    if ( i >= taps ) break;
    for ( int s = 0; s < 2; s ++ ) {
      // Cell centre of a uniform partition of the shutter interval, dithered by
      // the pixel's own jitter -- stratified rather than merely dense, and
      // unable to land on itself.
      float p = ( float( 2 * i + s ) + 0.5 + jitter ) / nSamples - 0.5;
      vec2 uv = vUv + vel * p;
      if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;
      // ONE fetch per sample. Colour and depth are wanted at the same uv, and
      // the resolve target carries both, so the loop no longer pays a second
      // full-resolution read for a coordinate it has already sampled. This is
      // the whole point of the alpha contract in taa.js.
      ${depthInAlpha
        ? `vec4 s0 = texture2D( tColor, uv );
      float d = s0.a > 0.0 ? 1.0 / s0.a : 0.0;`
        : `vec4 s0 = texture2D( tColor, uv );
      float d = texture2D( tDepth, uv ).r;`}
      if ( d <= 0.0 ) d = 1e5;
      // a sample that is much further away than the centre is background
      // leaking in — down-weight it
      float w = 1.0 - smoothstep( 0.0, 1.5, ( d - centreDepth ) / max( 1.0, centreDepth ) );
      w = mix( 0.15, 1.0, clamp( w, 0.0, 1.0 ) ) * OW_MB_SHUTTER;
      sum += s0.rgb * w;
      wsum += w;
    }
  }

  vec3 blurred = sum / wsum;
  // The alpha passes straight through, so the depth this pass consumed is
  // still there for anything downstream that wants it. Nothing does today --
  // dof, the registered passes, the view composite, bloom and metering all
  // read .rgb -- and the view composite writes 1.0, so the channel is clean
  // again before the tonemap.
  gl_FragColor = vec4( mix( centre.rgb, blurred, uParams.w ), centre.a );
}
`;

export class MotionBlur {
  /**
   * @param depthInAlpha  true when the colour handed to render() carries the
   *   view depth in alpha. That is the TAA resolve and only the TAA resolve --
   *   without TAA this pass reads the forward HDR target, whose alpha is the
   *   material's, so the flag has to follow the TAA setting and not be assumed
   *   from the quality name. Wrong here would not crash; it would weight every
   *   sample off surface opacity and look like a mysteriously soft blur.
   */
  constructor(depthInAlpha = false) {
    this.depthInAlpha = !!depthInAlpha;
    this.tilePass = new Pass('ow-mb-tile', TILE_MAX, {
      tVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.blurPass = new Pass('ow-mb', BLUR(this.depthInAlpha), {
      tColor: { value: null },
      tVelocity: { value: null },
      tTile: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0.5, 48, 0, 1) },
    });
    this.tileRt = null;
    this.outRt = null;
  }

  setSize(w, h) {
    this.tileRt?.dispose();
    this.outRt?.dispose();
    const tw = Math.max(1, Math.ceil(w / 16));
    const th = Math.max(1, Math.ceil(h / 16));
    this.tileRt = hdrTarget(tw, th, { format: THREE.RGFormat, name: 'mb-tile' });
    this.outRt = hdrTarget(w, h, { name: 'mb' });
    this.tilePass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blurPass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blurPass.uniforms.uResolution.value.set(w, h);
  }

  render(renderer, colorTexture, gbuffer, frame, shutter) {
    this.tilePass.uniforms.tVelocity.value = gbuffer.velocityTexture;
    this.tilePass.render(renderer, this.tileRt);

    const u = this.blurPass.uniforms;
    u.tColor.value = colorTexture;
    u.tVelocity.value = gbuffer.velocityTexture;
    u.tTile.value = this.tileRt.texture;
    u.tDepth.value = gbuffer.depthTexture;
    u.uParams.value.x = shutter;
    u.uParams.value.z = frame % 64;
    this.blurPass.render(renderer, this.outRt);
    return this.outRt.texture;
  }

  dispose() {
    this.tileRt?.dispose();
    this.outRt?.dispose();
    this.tilePass.dispose();
    this.blurPass.dispose();
  }
}

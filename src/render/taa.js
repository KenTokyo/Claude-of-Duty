import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Temporal antialiasing.
 *
 * The three things that make browser TAA smear, and what is done about them:
 *
 *  1. *Velocity that includes the jitter.* Motion vectors here come from
 *     unjittered matrices (see prepass.js), and the jitter is only ever
 *     applied to the rasterisation matrix.
 *  2. *Bilinear history.* History is resampled with a 5-tap Catmull-Rom
 *     filter, which keeps the high frequencies the accumulation is supposed
 *     to be building up.
 *  3. *Geometry no velocity buffer can describe.* Anything that deforms inside
 *     its own transform — skinned characters, morph targets — has pixels that
 *     move while its matrix difference says zero, and the viewmodel moves in
 *     VIEW space, which camera matrices cannot express at all. The viewmodel is
 *     therefore composited after this pass entirely (see composite.js), and
 *     skinned geometry is tagged with a reduced coverage by the prepass so the
 *     variance clip tightens and the history tail is capped on exactly those
 *     pixels. Both were "the background is visible through the character".
 *  4. *Weak rejection.* The history is variance-clipped against the 3x3
 *     neighbourhood in YCoCg (chroma-aware, so coloured edges reject
 *     properly), the velocity is dilated to the closest-depth neighbour so
 *     silhouettes take their own motion vector, and the feedback drops with
 *     screen-space speed.
 *
 * Blending happens in a tonemapped ("reinhard weighted") space so a single
 * bright sample cannot bleed a firefly across eight frames.
 */

const HALTON = (() => {
  const h = (i, b) => {
    let f = 1;
    let r = 0;
    while (i > 0) {
      f /= b;
      r += f * (i % b);
      i = Math.floor(i / b);
    }
    return r;
  };
  const out = [];
  for (let i = 1; i <= 16; i++) out.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
  return out;
})();

const RESOLVE = /* glsl */ `
precision highp float;
${COMMON}

// Taps in the velocity dilation below. Read by tools/cli/fillsim.mjs so the
// cost model cannot go on quoting a pattern this shader no longer has.
#define OW_TAA_DILATE_TAPS 5

// Weight below which sampleCatmullRom stops paying for a lobe. Read out of the
// compiled shader by tools/cli/fillsim.mjs for the same reason as the line
// above -- a number copied into the cost model would keep reporting the old
// saving after this one moves. The measurements that fixed it at 0.02 are in
// the header of tools/cli/crsim.mjs; the short form is in sampleCatmullRom.
#define OW_TAA_CR_EPS 0.02

// Fetches in the colour-box neighbourhood -- the plus plus one rotating
// diagonal, centre held rather than fetched. Read by tools/cli/fillsim.mjs for
// the third time for the same reason as the two lines above: the neighbourhood
// is the largest single block in this pass, and a cost model quoting 8 here
// after the loop moved to 6 would report a saving of exactly zero and look like
// the change had failed. The measurements are over the loop itself.
#define OW_TAA_NB_TAPS 6

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform mat4 uInvVP;
uniform mat4 uPrevVP;
uniform vec4 uParams;   // x feedback  y clipGamma  z first-frame  w diagonal parity
varying vec2 vUv;

vec3 tonemapW( vec3 c ) { return c / ( 1.0 + owLum( c ) ); }
vec3 tonemapWInv( vec3 c ) { return c / max( 1e-4, 1.0 - owLum( c ) ); }

/**
 * One tap of the velocity dilation. See the call sites in main().
 *
 * ONE FETCH ANSWERS BOTH QUESTIONS. The gbuffer normal carries coverage in z and
 * 1/depth in w (see prepass.js), so a tap that is testing "which neighbour is
 * nearest" also comes back with that neighbour's coverage — which is the very
 * value the velocity branch below needs at the winner, and which used to be a
 * second full-resolution fetch of this same texture at that same texel.
 *
 * NEAREST IS THE LARGEST ALPHA, because the channel is a reciprocal. The old
 * 'd <= 0.0 -> 1e8' substitution is gone with it: an uncovered texel reads 0 here
 * by the prepass's black clear, and 0 already loses to every real surface. The
 * comparison stays strict, so a tie still goes to the earliest tap.
 */
void owDilate( vec2 uv, inout float bestInv, inout vec2 bestUv, inout float bestCov ) {
  vec2 cd = texture2D( tNormal, uv ).zw;
  if ( cd.y > bestInv ) { bestInv = cd.y; bestUv = uv; bestCov = cd.x; }
}

/**
 * THE WEIGHT IS KNOWN BEFORE THE FETCH. Every one of wa..we below is a product
 * of two cubic weights that come out of the fractional sample position alone,
 * several lines before this function touches the texture. So "is this tap worth
 * a fetch" is answerable per pixel at zero cost -- the same property that made
 * the tap tier in volumetrics.js work, on a filter that runs on every pixel of
 * the largest pass in the chain.
 *
 * THE FOUR LOBES ARE NON-POSITIVE, the centre never is. In factored form
 * w0 = -0.5*f*(1-f)^2 and w3 = -0.5*f^2*(1-f), both zero at f = 0 and f = 1 and
 * peaking at 0.07407, while w12 = 1 + 0.5*f*(1-f) sits in [1, 1.125]. So the
 * four lobes carry at most 0.0833 each and wc = w12.x*w12.y is at least 1 and
 * can never be a candidate. The test is written with abs() rather than the
 * cheaper -w > eps so that it stays honest if the polynomials are ever
 * rearranged -- the sign is a property of THIS filter, not of the mechanism.
 *
 * THE DIVISION AT THE END IS THE MECHANISM, and it was already here. The
 * shipped five-tap form is itself a renormalised subset of the 16-tap bicubic:
 * it throws away the four corners, whose weights are products of two lobes, and
 * divides by the surviving wsum to put their mass back. Dropping a lobe uses
 * that same path, which is why nothing below the taps had to change and why the
 * threshold has a scale rather than a taste -- 0.02 discards 0.0077 of the
 * filter on average, against the 0.0071 of corner mass this form discards
 * anyway.
 *
 * IT LANDS CLOSER TO A REAL BICUBIC THAN THE SHIPPED FILTER DOES, which reads
 * like luck and is arithmetic: the corners carry POSITIVE weight, so dropping
 * them sharpens, and the lobes carry NEGATIVE weight, so dropping them softens.
 * Under eight accumulation steps the true 16-tap scores 0.9708 edge energy, the
 * shipped five-tap 1.0110 (+4.14 %), this 0.9758 (+0.51 %). Measured over three
 * frames and two grids by tools/cli/crsim.mjs, whose header carries the rest.
 *
 * AT A STANDING CAMERA f IS EXACTLY ZERO, every lobe weighs exactly zero, and
 * the tier is exact and free. The worst real case is a slow pan, where the
 * history chain is longest -- about 3.8 % of edge energy at the fixed point.
 */
vec3 sampleCatmullRom( sampler2D tex, vec2 uv ) {
  vec2 texSize = uResolution;
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor( samplePos - 0.5 ) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max( w12, vec2( 1e-5 ) );

  vec2 texPos0 = ( texPos1 - 1.0 ) / texSize;
  vec2 texPos3 = ( texPos1 + 2.0 ) / texSize;
  vec2 texPos12 = ( texPos1 + offset12 ) / texSize;

  vec3 result = vec3( 0.0 );
  float wsum = 0.0;
  float wa = w12.x * w0.y;  if ( abs( wa ) > OW_TAA_CR_EPS ) { result += texture2D( tex, vec2( texPos12.x, texPos0.y ) ).rgb * wa; wsum += wa; }
  float wb = w0.x * w12.y;  if ( abs( wb ) > OW_TAA_CR_EPS ) { result += texture2D( tex, vec2( texPos0.x, texPos12.y ) ).rgb * wb; wsum += wb; }
  float wc = w12.x * w12.y; result += texture2D( tex, vec2( texPos12.x, texPos12.y ) ).rgb * wc; wsum += wc;
  float wd = w3.x * w12.y;  if ( abs( wd ) > OW_TAA_CR_EPS ) { result += texture2D( tex, vec2( texPos3.x, texPos12.y ) ).rgb * wd; wsum += wd; }
  float we = w12.x * w3.y;  if ( abs( we ) > OW_TAA_CR_EPS ) { result += texture2D( tex, vec2( texPos12.x, texPos3.y ) ).rgb * we; wsum += we; }
  return result / max( wsum, 1e-5 );
}

void main() {
  vec3 current = texture2D( tCurrent, vUv ).rgb;

  // INVERSE VIEW DEPTH IS PUBLISHED IN THIS TARGET'S ALPHA. Nothing downstream
  // ever read the resolve alpha -- it was a constant 1.0, and every consumer
  // (motionblur, dof, composite, bloom, exposure, ssr, the view composite)
  // takes .rgb -- so the channel was free, and motion blur is the pass that
  // needed it: it samples tColor and tDepth at the SAME uv, twice per tap, and
  // was paying two full-resolution fetches for one point in the frame's third
  // most expensive shader. Carrying it here collapses that to one.
  //
  // ONE FETCH, THREE ANSWERS. This single tap of the gbuffer normal returns the
  // coverage this pixel needs for 'dynamic', the 1/depth it republishes below,
  // AND the centre tap of the velocity dilation -- which is why the dilation
  // reads no depth texture at all any more and this pass no longer binds one.
  // The prepass puts the reciprocal in alpha for exactly this reason; the
  // arithmetic behind that layout is in its header.
  //
  // NO ROUNDING WAS ADDED. This value arrives already rounded to half and is
  // written straight back out to a half target, so it survives bit for bit;
  // before, an R32F depth was read and its reciprocal rounded once on the way
  // out. Motion blur receives the identical number either way.
  //
  // ONE OVER DEPTH, NOT DEPTH, and the reason is that this target is
  // LinearFilter while the depth attachment is NearestFilter. Motion blur
  // samples at arbitrary sub-texel offsets, so whatever goes in this channel
  // gets BILINEARLY BLENDED across depth discontinuities, and the two
  // candidates behave completely differently at the one edge that matters --
  // a roofline, geometry against sky, where the prepass wrote 0:
  //   depth      a tap 75% into the sky reads 0.25 * 40 m = 10 m, i.e. NEARER
  //              than the 40 m surface it came from. The weight in motionblur.js
  //              exists to stop background smearing over foreground, and this
  //              inverts it precisely where it is needed.
  //   1 / depth  the same tap reads 0.25 / 40, i.e. 160 m -- further, which
  //              saturates the same down-weight the point sample produced.
  // Blending reciprocals is also the perspective-correct interpolation for a
  // planar surface in screen space, so away from discontinuities it is closer
  // to the truth than the point sample, not merely close to it.
  //
  // Sky stays exactly 0 and is therefore still an exact test downstream, which
  // is what keeps the prepass's "depth == 0 means no geometry" contract alive
  // through this target -- the black clear writes this channel too, so the zero
  // is the clear's own and not a reconstruction of it. Half float holds the rest
  // with room to spare: 1/d spans about 20 (near plane) down to 5e-4 (far plane)
  // against a smallest normal of 6.1e-5, and its relative step of 2^-11 lands in
  // a smoothstep over a distance RATIO, never in a comparison.
  vec2 ownCd = texture2D( tNormal, vUv ).zw;
  float ca = ownCd.x;
  float ownInvDepth = ownCd.y;

  if ( uParams.z > 0.5 ) { gl_FragColor = vec4( current, ownInvDepth ); return; }

  // --- velocity, dilated to the closest-depth neighbour ---------------------
  // Every tap reads the gbuffer normal's zw: coverage and 1/depth together. The
  // ordering question and the coverage question are answered by the same fetch,
  // so the winner's coverage -- 'cb' below, formerly its own full-resolution
  // fetch of this texture at this texel -- simply falls out of the tap that won.
  // The graded 0.7 for skinned geometry survives it, which the old depth-texture
  // formulation could not carry at all.
  //
  // FOUR CORNERS AND THE CENTRE, not the full 3x3. Over a locally planar depth
  // field d = d0 + gx*x + gy*y the minimum of the nine is at the corner
  // ( -sign gx, -sign gy ): the corners are where both gradients are extreme, so
  // an edge-midpoint can only win where the gradient is exactly axis-aligned or
  // where a genuine discontinuity cuts through. Dropping the four midpoints
  // therefore keeps almost every argmin the 3x3 would have found, and dropping
  // the four CORNERS instead -- the obvious "+" cross -- throws most of them
  // away. Measured with cod taataps at the pass's own 2268x1473 over a translating
  // camera, as the share of the frame whose history sample lands more than a
  // pixel away from where the 3x3 put it:
  //
  //     no dilation at all   0.796 %      <- what the dilation exists to prevent
  //     "+" cross, 5 taps    0.179 %      <- same cost as below, 62x worse
  //     THIS, 5 taps         0.0029 %     <- keeps 99.6 % of the 3x3's benefit
  //     4 corners, no centre 0.0051 %
  //
  // The centre stays because it is the thin-geometry case: on a one-pixel wire
  // all four diagonals are sky, and without its own depth the pixel would take
  // the background reprojection instead of the wire's velocity -- which is the
  // "power lines legible straight through" failure this pass already fixed once.
  // bestInv starts below zero so the first tap always wins, exactly as the 1e9
  // sentinel guaranteed for the depth formulation: an uncovered texel reads 0,
  // and 0 beats -1. cb therefore never keeps this initial value.
  vec2 bestUv = vUv;
  float bestInv = -1.0;
  float cb = ca;
  owDilate( vUv + vec2( -1.0, -1.0 ) * uTexel, bestInv, bestUv, cb );
  owDilate( vUv + vec2(  1.0, -1.0 ) * uTexel, bestInv, bestUv, cb );
  // The centre tap, inlined against the fetch already held from the top of
  // main(). Same value, same test, same position in the sequence, so the
  // argmin is the one the five-fetch version picked -- bit-identical, not
  // merely equivalent. Texture fetches have no side effects, so hoisting this
  // one above the two corners before it cannot change what any of them read.
  {
    if ( ownInvDepth > bestInv ) { bestInv = ownInvDepth; bestUv = vUv; cb = ca; }
  }
  owDilate( vUv + vec2( -1.0,  1.0 ) * uTexel, bestInv, bestUv, cb );
  owDilate( vUv + vec2(  1.0,  1.0 ) * uTexel, bestInv, bestUv, cb );

  // cb -- the coverage at bestUv -- is already in hand: the dilation tap that
  // won carried it. Geometry that deforms inside its own transform (skinned
  // characters, morphed meshes) is tagged with a reduced coverage by the prepass,
  // because a matrix-difference velocity buffer cannot describe a moving elbow.
  // Those pixels get a much tighter variance clip and a much shorter history
  // tail: slightly noisier, but no background dragged through the silhouette.
  // The step() against 0.5 further down keeps the sky out of it: uncovered pixels
  // are coverage 0, which is "no surface", not "a deforming surface".
  vec2 vel;
  if ( cb > 0.5 ) {
    vel = texture2D( tVelocity, bestUv ).rg;
  } else {
    // background: reproject the far plane with the previous camera
    vec4 h = uInvVP * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
    vec3 wpos = h.xyz / h.w;
    vec4 pc = uPrevVP * vec4( wpos, 1.0 );
    vec2 prevUv = ( pc.xy / pc.w ) * 0.5 + 0.5;
    vel = vUv - prevUv;
  }

  vec2 huv = vUv - vel;

  // --- history off screen: everything below is multiplied by zero -----------
  //
  // A pixel whose reprojection leaves the frame has no history, and the pass
  // already knew that -- it set 'feedback = 0.0' AFTER spending 13 fetches on
  // a neighbourhood clip and a Catmull-Rom history sample that the zero then
  // deleted. Taking the test here is the same decision made before the work
  // instead of after it: 8 tCurrent for the 3x3 and 5 tHistory for the bicubic.
  // Nothing below this line survives feedback = 0:
  //   sum    = mix( wc, wh, 0 )     = wc
  //   outY   = ( curY * wc * 1 + clipped * wh * 0 ) / max( wc, 1e-5 )
  // and wc = 1 / ( 1 + curY.x ) is greater than 0.5, because tonemapW divides
  // by 1 + owLum and so caps the luma it returns below 1. The max() therefore
  // never binds and outY is exactly curY. The three later 'feedback *=' and
  // the 'min' cannot revive it either -- zero absorbs all of them.
  //
  // NOT BIT-IDENTICAL, and it is the round trip that moves rather than the
  // logic: the old path returned tonemapWInv( owYCoCgToRgb( owRgbToYCoCg(
  // tonemapW( current ) ) ) ), which is the identity only in exact arithmetic.
  // Returning 'current' is the MORE accurate of the two, not a concession, and
  // it is exactly what the first-frame exit twenty lines above already does.
  //
  // Worth 13 of 19.3 fetches on the band of the frame that reprojects off the
  // edge. That band is 2.30% of the frame at the 1 deg/frame this project
  // measures at -- measured, not assumed, by 'cod fillcost --look=1' and
  // confirmed to three figures by the independent closed form in
  // tools/cli/taabandcheck.mjs. It GROWS with the turn rate, so it pays most
  // during the flick where the frame is already worst, and a still camera gets
  // nothing from it. Divergence is mild: the band is a screen edge, so warps are
  // almost all wholly inside it or wholly outside.
  //
  // The first estimate of this band was 1.5%, and both ways of getting there
  // were wrong. Dividing the turn by the field of view gives 0.96% -- that is
  // the gain at the CENTRE of the frame, and pixels leave at the EDGE, where
  // perspective stretches the same rotation by 2.7x. And yaw alone throws pixels
  // out through the TOP and BOTTOM as well: turning makes the ray more oblique
  // on the side the camera turns away from, the w divide shrinks there, and that
  // half of the frame is magnified away from the horizon line. That vertical
  // strip is 0.53% of the frame with no pitch in the motion at all.
  if ( huv.x < 0.0 || huv.x > 1.0 || huv.y < 0.0 || huv.y > 1.0 ) {
    gl_FragColor = vec4( max( current, vec3( 0.0 ) ), ownInvDepth );
    return;
  }

  // 'ca' is the coverage from the centre fetch at the top of main(), and 'cb' the
  // coverage the winning dilation tap carried. Neither is a fetch of its own any
  // more, so there is nothing left here to defer past the early-out above.
  float dynamic = max(
    step( 0.5, ca ) * ( 1.0 - smoothstep( 0.72, 0.92, ca ) ),
    step( 0.5, cb ) * ( 1.0 - smoothstep( 0.72, 0.92, cb ) ) );

  // --- neighbourhood statistics in YCoCg ------------------------------------
  // Tap 4 of the 3x3 is offset ( 0, 0 ), so it is tCurrent at vUv -- the texel
  // already sitting in the current variable from the top of main(), and the one
  // converted again further down as curY. Substituting the held value keeps the
  // order, so m1 and m2 accumulate in exactly the same sequence and the result
  // is bit-identical, not merely equivalent; the offset is added to vUv either
  // way and x + 0.0 is exact. Worth one full-resolution fetch and one redundant
  // tonemap+YCoCg per pixel.
  //
  // THE NEIGHBOURHOOD IS SIX FETCHES, NOT EIGHT: the plus, plus ONE diagonal,
  // swapped every frame. What follows is why that specific cut and not the
  // obvious one, because the obvious one was measured and is worse than useless.
  //
  // The scale every arm here has to be read against is not a PSNR in isolation
  // but the price the box ALREADY charges: an unclamped accumulation converges
  // to the supersampled truth, so the gap between it and a clamped arm is the
  // whole cost of having a colour box at all. tools/cli/nbsim.mjs measures both
  // halves on the same arms -- CONVERGENCE, a still camera accumulating jitter
  // against the supersampled render, and GHOST, the camera slid sideways with
  // NO reprojection so every pixel is handed history that no longer belongs to
  // it. Edge PSNR against the shipped 3x3, over three grids:
  //
  //                            384x250    640x416    896x580
  //   anchor: the box's own cost  0.954      0.318      0.366   dB
  //   5-tap plus        4 fetch  -1.05      -0.304     -0.379   dB
  //   plus + 1 diagonal 6 fetch  -0.608     +0.017     -0.047   dB
  //   plus + 1 corner   5 fetch  -1.04      -0.243     -0.190   dB
  //
  // THE FOUR-FETCH PLUS IS REJECTED. At the coarse grid it costs more than the
  // entire clamp budget, and it never converges toward the shipped filter the
  // way the six-fetch arm does -- it is still spending a full dB of the anchor
  // at 896. Nor is it a subset box, which was the fallback argument for the
  // corners being droppable: the mean +- gamma*sigma half reaches OUTSIDE the
  // 3x3 box on 4.0 % of channels with a peak excursion of 0.093 in YCoCg,
  // because a five-sample sigma is not a nine-sample sigma. Raising gamma to
  // compensate recovers 0.16 dB and widens that to 14 %. The single-corner
  // rotor is rejected on the same grounds, one fetch cheaper and no better.
  //
  // THE SIX-FETCH ROTOR IS WHAT SHIPS, and the three grids are why. Every
  // number that matters converges as the grid refines -- SSIM -0.0034 ->
  // -0.0010 -> -0.0008, sharpness -0.0041 -> -0.0026 -> -0.0021, box wider
  // than the 3x3 on 14.7 % -> 10.3 % -> 8.2 % of channels -- while edge PSNR
  // settles into a +-0.05 dB band around zero against a 0.37 dB anchor. That is
  // the physics and not luck: a finer grid correlates neighbours more strongly,
  // so a seven-sample sigma approaches a nine-sample sigma, and the real pass
  // runs at 2268x1473, two and a half times finer than the last column. The
  // 384x250 row is a coarse-grid artefact, kept because it is what a naive
  // single-resolution study would have concluded.
  //
  // And the one axis a smaller box could actually break -- ghosting -- moves
  // the RIGHT way, monotonically: the rotor beats the shipped 3x3 by 0.144 ->
  // 0.473 -> 0.490 dB on the disocclusion half, with a lower error the frame
  // after the step (3.66 against 4.06 code values at 896). A subset box has a
  // higher min and a lower max, so it rejects stale history harder; that is the
  // benefit side, and it is the reason the containment count above is tracked
  // separately, since the mean +- gamma*sigma half is the ONLY way this could
  // admit a ghost the nine-tap rejects.
  //
  // Rotating is load-bearing. The static five-tap plus and the static-per-frame
  // single corner both sit a full dB down; what rescues the pattern is that the
  // accumulator sees the other diagonal next frame, which is the same trade the
  // jitter, GTAO's noise and the volumetric march's step offset already make.
  // The parity is locked to the jitter phase exactly as nbsim measured it --
  // HALTON[k % 16] and the diagonal both come off the same frame counter.
  //
  // Do not re-derive any of this from the fetch count. The numbers that decide
  // it are the anchor and the three-grid trend, in the header of nbsim.mjs.
  vec3 curY = owRgbToYCoCg( tonemapW( current ) );
  vec3 m1 = vec3( 0.0 );
  vec3 m2 = vec3( 0.0 );
  vec3 nmin = vec3( 1e9 );
  vec3 nmax = vec3( -1e9 );
  // Which diagonal this frame carries. Compared against 0.5 rather than
  // truncated, like the first-frame flag above, so no float that ever reaches
  // this uniform can land between the two cases.
  int par = uParams.w > 0.5 ? 1 : 0;
  for ( int i = 0; i < 7; i ++ ) {
    // k is the raster index into the 3x3 the offsets are still derived from, so
    // the offset line below is the one the nine-tap loop used, unchanged:
    //   i 0..3 -> 1, 3, 5, 7        the plus
    //   i 4    -> 4                 the centre, substituted rather than fetched
    //   i 5, 6 -> 2*par, 8 - 2*par  0 and 8 on even frames, 2 and 6 on odd
    int k = i < 4 ? 2 * i + 1 : ( i == 4 ? 4 : ( i == 5 ? 2 * par : 8 - 2 * par ) );
    vec2 o = vec2( float( k % 3 ) - 1.0, float( k / 3 ) - 1.0 ) * uTexel;
    vec3 c = k == 4 ? curY : owRgbToYCoCg( tonemapW( texture2D( tCurrent, vUv + o ).rgb ) );
    m1 += c;
    m2 += c * c;
    nmin = min( nmin, c );
    nmax = max( nmax, c );
  }
  vec3 mean = m1 / 7.0;
  vec3 sigma = sqrt( max( m2 / 7.0 - mean * mean, vec3( 0.0 ) ) );
  float gamma = uParams.y * mix( 1.0, 0.38, dynamic );
  vec3 lo = max( mean - gamma * sigma, nmin );
  vec3 hi = min( mean + gamma * sigma, nmax );

  vec3 historyRgb = sampleCatmullRom( tHistory, huv );
  historyRgb = max( historyRgb, vec3( 0.0 ) );
  vec3 hist = owRgbToYCoCg( tonemapW( historyRgb ) );

  // clip toward the neighbourhood centre rather than clamping per channel:
  // clamping kills sub-pixel detail, clipping keeps it.
  vec3 centre = 0.5 * ( lo + hi );
  vec3 extent = 0.5 * ( hi - lo ) + 1e-5;
  vec3 dir = hist - centre;
  vec3 ts = abs( extent / max( abs( dir ), vec3( 1e-5 ) ) );
  float clipT = clamp( min( ts.x, min( ts.y, ts.z ) ), 0.0, 1.0 );
  vec3 clipped = centre + dir * clipT;

  // The off-screen test that used to sit here is now the early exit above; by
  // this line huv is inside [0,1] on every surviving pixel.
  float feedback = uParams.x;

  // fast motion -> trust the history less
  float speed = length( vel * uResolution );
  feedback *= mix( 1.0, 0.72, clamp( speed / 24.0, 0.0, 1.0 ) );
  // heavy clipping means we were rejecting: shorten the tail
  feedback *= mix( 0.82, 1.0, clipT );
  // deforming geometry: cap the tail outright, no velocity describes it
  feedback = min( feedback, mix( 1.0, 0.55, dynamic ) );

  // luminance weighting (Karis) — suppresses the shimmer that a plain lerp
  // leaves on specular highlights
  float wc = 1.0 / ( 1.0 + curY.x );
  float wh = 1.0 / ( 1.0 + clipped.x );
  float sum = mix( wc, wh, feedback );
  vec3 outY = ( curY * wc * ( 1.0 - feedback ) + clipped * wh * feedback ) / max( sum, 1e-5 );

  vec3 result = tonemapWInv( owYCoCgToRgb( outY ) );
  gl_FragColor = vec4( max( result, vec3( 0.0 ) ), ownInvDepth );
}
`;

export class Taa {
  constructor() {
    this.pass = new Pass('ow-taa', RESOLVE, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tVelocity: { value: null },
      tNormal: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uInvVP: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uParams: { value: new THREE.Vector4(0.92, 1.25, 1, 0) },
    });
    this.history = [null, null];
    this._flip = 0;
    this.index = 0;
    // Which diagonal the colour box carries this frame. Counted here rather
    // than taken from `index` so it flips exactly once per resolve: index is
    // advanced by nextJitter(), which the caller owns and which a frame that
    // skips the resolve would still move.
    this._parity = 0;
    this.jitter = new THREE.Vector2();
    this.texture = null;
    this._needsReset = true;
  }

  setSize(w, h) {
    this.history[0]?.dispose();
    this.history[1]?.dispose();
    this.history[0] = hdrTarget(w, h, { name: 'taa-a' });
    this.history[1] = hdrTarget(w, h, { name: 'taa-b' });
    this.pass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.pass.uniforms.uResolution.value.set(w, h);
    this._needsReset = true;
  }

  /** Advance the jitter sequence; returns the sub-pixel offset in pixels. */
  nextJitter() {
    const s = HALTON[this.index % HALTON.length];
    this.index++;
    this.jitter.set(s[0], s[1]);
    return this.jitter;
  }

  reset() {
    this._needsReset = true;
  }

  /** @returns the resolved texture */
  render(renderer, colorTexture, gbuffer, invVP, prevVP) {
    const u = this.pass.uniforms;
    u.tCurrent.value = colorTexture;
    u.tHistory.value = this.history[this._flip].texture;
    u.tVelocity.value = gbuffer.velocityTexture;
    // No depth texture: the dilation and the republished 1/depth both come out
    // of the normal target's alpha now. See prepass.js's attachment table.
    u.tNormal.value = gbuffer.normalTexture;
    u.uInvVP.value.copy(invVP);
    u.uPrevVP.value.copy(prevVP);
    u.uParams.value.z = this._needsReset ? 1 : 0;
    u.uParams.value.w = this._parity;
    this._parity ^= 1;
    this._needsReset = false;

    const dst = this.history[this._flip ^ 1];
    this.pass.render(renderer, dst);
    this._flip ^= 1;
    this.texture = dst.texture;
    return this.texture;
  }

  /** Previous resolved frame — the right source for SSR. */
  get previousTexture() {
    return this.history[this._flip].texture;
  }

  dispose() {
    this.history[0]?.dispose();
    this.history[1]?.dispose();
    this.pass.dispose();
  }
}

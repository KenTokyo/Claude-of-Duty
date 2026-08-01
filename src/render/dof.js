import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Gather depth of field, engaged only while the sights are up.
 *
 * ADS in a modern shooter is not "hipfire with the gun raised": the optic is the
 * focal plane, the street behind it goes soft, the vignette closes in and the
 * whole frame tells you your eye is behind a tube. Without any of that, an ADS
 * frame is indistinguishable from a hipfire frame at a narrower FOV, which is
 * exactly what the critiques said about `ads.png`.
 *
 * Three passes, the blur at half resolution:
 *
 *   1  PREFILTER  full -> half. 4-tap box of the colour, plus the circle of
 *      confusion in FULL-RES PIXELS packed into alpha. The focal distance is
 *      read from the depth buffer at the screen centre — literally the reticle
 *      plane — so it tracks whatever the player is actually aiming at.
 *   2  GATHER     half res, 32 taps on a golden-angle spiral over the MAXIMUM
 *      CoC, weighted `clamp(tapCoC - dist + 1)`. That is scatter-as-gather: a
 *      blurred foreground fragment spreads onto its neighbours instead of being
 *      sampled only by pixels that are themselves blurred, so there is no hard
 *      edge where a near object meets a far one.
 *   3  COMBINE    full res. Blends the sharp image toward the gathered one by
 *      the full-res CoC, dilated by the half-res neighbourhood so the
 *      transition never shows the half-res grid.
 *
 * The viewmodel is composited AFTER this pass, so the optic, the reticle and the
 * hands are untouched and stay pin sharp for free.
 */

/**
 * The focal distance, hoisted to the three vertices of the full-screen triangle.
 *
 * It is one texel at the screen centre and the same texel for every pixel of the
 * draw, so reading it per fragment was a texture instruction per pixel to fetch
 * a number the whole frame shares. PREFILTER and COMBINE each paid it once per
 * fragment; both now take it as a `flat` varying, which is bit-identical rather
 * than merely equal because the provoking vertex's value arrives uninterpolated.
 * (`flat` is legal despite the ESSL 1.00 spellings around it -- see Pass in
 * pass.js for why every ShaderMaterial here compiles as `#version 300 es`.)
 *
 * The vec2( 0.5 ) sample point is deliberate and survives the move unchanged.
 * On a LinearFilter target of even width it lands at texel coordinate w/2 - 0.5,
 * i.e. exactly on the boundary between two texels, so the fetch returns their
 * mean with weight 0.5 each and nothing snaps it back. Where the reticle crosses
 * a silhouette that mean is the harmonic mean of the two depths -- a 3 m
 * foreground against a 100 m background focuses at 5.8 m, a plane no surface is
 * on, and it moves continuously as the player sweeps the aim across the edge.
 * NearestFilter picks one of the two surfaces and snaps once. A focal plane that
 * hunts through empty space is worse than one that picks a side, so this keeps
 * the point sample.
 *
 * Vertex-stage sampling is level 0 with no implicit derivative, which is what
 * this fetch already was: the depth target has no mips.
 */
const FOCUS_VERT = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uFocus;
varying vec2 vUv;
flat out float vFocus;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  float c = texture2D( tDepth, vec2( 0.5 ) ).r;
  if ( c <= 0.0 ) c = 1e4;                       // aiming at the sky
  vFocus = clamp( c, uFocus.z, uFocus.w );
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// Shared CoC evaluation. Depth is POSITIVE linear metres; the prepass clears to
// zero, so 0 means "sky" and takes the far blur outright.
//
// `tDepth` is NOT declared here: the focal read moved to FOCUS_VERT, and the
// only other reader is the !depthInAlpha arm of the two templates below, which
// declares it itself. A stage that does not fetch it should not name it.
const COC = /* glsl */ `
// x maxCoC(px)  y nearRatio  z focusMin  w focusMax
uniform vec4 uFocus;
// x farStartScale  y farRange  z nearScale  w unused
uniform vec4 uRange;
flat in float vFocus;

// View depth back out of the colour target's alpha, where the TAA resolve
// parked 1 / viewDepth and motion blur passed it through untouched. Sky is
// exactly 0 there by construction, which is the same "no geometry" flag depth
// 0 is in the gbuffer, so it lands on owCoC's own sky case below instead of
// dividing by zero. No fetch: the caller already has the texel in hand.
float owDepthFromAlpha( float a ) {
  return a > 0.0 ? 1.0 / a : 0.0;
}

float owCoC( float depth, float focus ) {
  float d = depth <= 0.0 ? 1e4 : depth;
  float farStart = focus * uRange.x + 1.0;
  float far = smoothstep( farStart, farStart + uRange.y, d );
  float nearEnd = focus * uRange.z;
  float near = 1.0 - smoothstep( nearEnd * 0.35, nearEnd, d );
  return uFocus.x * max( far, near * uFocus.y );
}
`;

/**
 * @param depthInAlpha  true when tColor carries 1 / viewDepth in its alpha,
 *   which is the case whenever the TAA resolve is in the chain (motion blur
 *   forwards the channel untouched, and nothing else runs between them).
 *
 * TWO SOURCES RATHER THAN ONE WITH A #define, deliberately: fragcost counts
 * fetch call sites in the string it is handed, so a single source carrying
 * both arms would be priced as if it took every fetch of both. The same
 * arrangement, for the same reason, as BLUR in motionblur.js.
 *
 * THE FOUR TAPS LAND ON EXACT FULL-RES TEXEL CENTRES, which is what makes the
 * alpha read the same number the tDepth fetch was returning rather than merely
 * a close one. A half-res fragment j has vUv = ( j + 0.5 ) / ( w / 2 ), i.e.
 * full-res coordinate 2j + 1, and the offsets are +-0.5 of a full-res texel,
 * so the taps sit at 2j + 0.5 and 2j + 1.5 -- the centres of texels 2j and
 * 2j + 1. Where the axis is odd -- 1473 at ultra, halved to 736 -- the mapping
 * drifts by at most 7e-4 of a texel, which is below the 1/16 an ES 3.0 sampler
 * is allowed to quantise its sub-texel weight to and far below the 1/256
 * desktop parts actually use, so the bilinear weight snaps to exactly 1 and
 * the tap is still a point sample.
 */
const PREFILTER = (depthInAlpha) => /* glsl */ `
precision highp float;
${COMMON}
${COC}
uniform sampler2D tColor;
${depthInAlpha ? '' : 'uniform sampler2D tDepth;'}
uniform vec2 uSrcTexel;
varying vec2 vUv;

void main() {
  float focus = vFocus;

  vec2 o = uSrcTexel * 0.5;
  vec4 t0 = texture2D( tColor, vUv + vec2( -o.x, -o.y ) );
  vec4 t1 = texture2D( tColor, vUv + vec2(  o.x, -o.y ) );
  vec4 t2 = texture2D( tColor, vUv + vec2( -o.x,  o.y ) );
  vec4 t3 = texture2D( tColor, vUv + vec2(  o.x,  o.y ) );

  vec3 c0 = max( t0.rgb, vec3( 0.0 ) );
  vec3 c1 = max( t1.rgb, vec3( 0.0 ) );
  vec3 c2 = max( t2.rgb, vec3( 0.0 ) );
  vec3 c3 = max( t3.rgb, vec3( 0.0 ) );

  ${depthInAlpha
    ? `float d0 = owDepthFromAlpha( t0.a );
  float d1 = owDepthFromAlpha( t1.a );
  float d2 = owDepthFromAlpha( t2.a );
  float d3 = owDepthFromAlpha( t3.a );`
    : `float d0 = texture2D( tDepth, vUv + vec2( -o.x, -o.y ) ).r;
  float d1 = texture2D( tDepth, vUv + vec2(  o.x, -o.y ) ).r;
  float d2 = texture2D( tDepth, vUv + vec2( -o.x,  o.y ) ).r;
  float d3 = texture2D( tDepth, vUv + vec2(  o.x,  o.y ) ).r;`}

  // Weight the colour toward the MORE blurred taps: averaging a sharp
  // background into a blurred foreground is what makes cheap DOF look like a
  // halo around every silhouette.
  float k0 = owCoC( d0, focus ), k1 = owCoC( d1, focus );
  float k2 = owCoC( d2, focus ), k3 = owCoC( d3, focus );
  float w0 = k0 + 0.05, w1 = k1 + 0.05, w2 = k2 + 0.05, w3 = k3 + 0.05;
  vec3 col = ( c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 ) / ( w0 + w1 + w2 + w3 );

  gl_FragColor = vec4( col, max( max( k0, k1 ), max( k2, k3 ) ) );
}
`;

const GATHER = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;       // HALF-res texel
uniform vec2 uParams;      // x maxCoC(px, full res), y frame
varying vec2 vUv;

#define OW_DOF_TAPS 32

void main() {
  vec4 centre = texture2D( tSrc, vUv );
  // Radius in half-res pixels. Always the maximum: in-focus taps contribute a
  // weight of zero, so a fixed loop is both correct and branch free.
  float radius = max( uParams.x * 0.5, 1.0 );

  float rot = owIGN( gl_FragCoord.xy + uParams.y * 5.371 ) * 6.2831853;
  float cr = cos( rot );
  float sr = sin( rot );

  vec3 sum = centre.rgb;
  float wsum = 1.0;
  float maxCoc = centre.a;

  for ( int i = 0; i < OW_DOF_TAPS; i ++ ) {
    float t = ( float( i ) + 0.5 ) / float( OW_DOF_TAPS );
    float ang = float( i ) * 2.39996323 + rot;
    vec2 dir = vec2( cos( ang ), sin( ang ) );
    vec2 off = dir * sqrt( t ) * radius;
    vec4 s = texture2D( tSrc, vUv + off * uTexel );
    float dist = length( off );
    // scatter-as-gather: this tap only reaches us if its own CoC is wide enough
    float w = clamp( s.a * 0.5 - dist + 1.0, 0.0, 1.0 );
    sum += s.rgb * w;
    wsum += w;
    maxCoc = max( maxCoc, s.a );
  }

  gl_FragColor = vec4( sum / max( wsum, 1e-4 ), maxCoc );
}
`;

/** @param depthInAlpha  as PREFILTER above. Here vUv is a full-res texel
 *  centre outright, so the alpha read is the same texel the tDepth fetch was
 *  returning with no offset argument to make at all. */
const COMBINE = (depthInAlpha) => /* glsl */ `
precision highp float;
${COMMON}
${COC}
uniform sampler2D tColor;
uniform sampler2D tBlur;
${depthInAlpha ? '' : 'uniform sampler2D tDepth;'}
varying vec2 vUv;

void main() {
  vec4 src = texture2D( tColor, vUv );
  vec3 sharp = max( src.rgb, vec3( 0.0 ) );
  vec4 blur = texture2D( tBlur, vUv );
  float focus = vFocus;
  float coc = owCoC( ${depthInAlpha
    ? 'owDepthFromAlpha( src.a )'
    : 'texture2D( tDepth, vUv ).r'}, focus );
  // Dilate with the gathered neighbourhood maximum so a blurred foreground
  // actually bleeds over the sharp thing behind it.
  coc = max( coc, blur.a * 0.85 );
  float m = smoothstep( 0.35, 1.45, coc );
  // THIS IS WHERE THE 1 / viewDepth ALPHA CHAIN ENDS, and it ends CONDITIONALLY
  // -- the pass only runs while the sights are up. Every registered pass after
  // this one therefore sees 1 / d in its colour input's alpha in hipfire and a
  // constant 1.0 in ADS. Nothing downstream reads it today (sky-vol-composite
  // takes its centre depth from tDepth on purpose, ow-view-composite's alpha
  // reads are all on tView), and nothing downstream may start: a pass that
  // took the cheap channel would be correct until the player aimed, which is
  // the worst shape a bug can have. Reconstructing 1 / d here instead of
  // writing 1.0 is not the fix either -- the blurred colour is a mix of many
  // depths and the alpha would be a number no pixel has.
  gl_FragColor = vec4( mix( sharp, max( blur.rgb, vec3( 0.0 ) ), m ), 1.0 );
}
`;

export class DepthOfField {
  /**
   * @param depthInAlpha  true when the colour handed to render() carries
   *   1 / viewDepth in its alpha. That is exactly "the TAA resolve is on",
   *   because TAA is the only pass that publishes the channel and motion blur
   *   -- the only thing that can sit between it and here -- forwards centre.a
   *   unchanged on both of its exits. Passed as the flag rather than read off
   *   the preset name because `--qset dof=true,taa=false` is reachable from
   *   the capture harness, and there the alpha is surface opacity: every
   *   circle of confusion in the frame would be computed at a depth of 1 m.
   */
  constructor(depthInAlpha = false) {
    this.depthInAlpha = !!depthInAlpha;
    const focus = new THREE.Vector4(5.0, 0.6, 3.0, 20.0);
    const range = new THREE.Vector4(1.2, 20.0, 0.55, 0);

    this.pre = new Pass('ow-dof-pre', PREFILTER(this.depthInAlpha), {
      tColor: { value: null },
      tDepth: { value: null },
      uSrcTexel: { value: new THREE.Vector2() },
      uFocus: { value: focus },
      uRange: { value: range },
    }, { vertexShader: FOCUS_VERT });
    this.gather = new Pass('ow-dof-gather', GATHER, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector2(5.0, 0) },
    });
    this.combine = new Pass('ow-dof-combine', COMBINE(this.depthInAlpha), {
      tColor: { value: null },
      tBlur: { value: null },
      tDepth: { value: null },
      uFocus: { value: focus },
      uRange: { value: range },
    }, { vertexShader: FOCUS_VERT });

    // One Vector4 shared by prefilter and combine so the focal plane can never
    // disagree between the two.
    this._focus = focus;
    this._range = range;
    this.rtA = null;
    this.rtB = null;
    this.width = 1;
    this.height = 1;
  }

  setSize(w, h) {
    this.rtA?.dispose();
    this.rtB?.dispose();
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.rtA = hdrTarget(hw, hh, { name: 'dof-a' });
    this.rtB = hdrTarget(hw, hh, { name: 'dof-b' });
    this.width = w;
    this.height = h;
    this.pre.uniforms.uSrcTexel.value.set(1 / w, 1 / h);
    this.gather.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  /**
   * @param amount 0..1 ADS engagement; the CoC scales with it so the blur ramps
   *               in with the sight picture instead of popping.
   * @param out    full-res target to write the recombined image into
   * @returns the resolved texture
   */
  render(renderer, colorTexture, gbuffer, out, amount, settings, frame) {
    // 1080p-referred CoC, scaled to the internal resolution so the blur is the
    // same fraction of the frame at every render scale.
    const maxCoc = settings.dofMaxCoc * (this.height / 1080) * amount;
    this._focus.set(maxCoc, settings.dofNearRatio, settings.dofFocusMin, settings.dofFocusMax);
    this._range.set(settings.dofFarStart, settings.dofFarRange, settings.dofNearScale, 0);

    const pu = this.pre.uniforms;
    pu.tColor.value = colorTexture;
    pu.tDepth.value = gbuffer.depthTexture;
    this.pre.render(renderer, this.rtA);

    const gu = this.gather.uniforms;
    gu.tSrc.value = this.rtA.texture;
    gu.uParams.value.set(maxCoc, frame % 64);
    this.gather.render(renderer, this.rtB);

    const cu = this.combine.uniforms;
    cu.tColor.value = colorTexture;
    cu.tBlur.value = this.rtB.texture;
    cu.tDepth.value = gbuffer.depthTexture;
    this.combine.render(renderer, out);
    return out.texture;
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.pre.dispose();
    this.gather.dispose();
    this.combine.dispose();
  }
}

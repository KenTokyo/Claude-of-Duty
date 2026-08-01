import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Screen-space contact shadows.
 *
 * A cascaded shadow map, however well filtered, always loses the last few
 * centimetres: the texel is bigger than the gap between a crate and the floor.
 * This marches a short ray through the depth buffer toward the sun and puts
 * that contact back, which is what stops props looking like stickers.
 *
 * Consumed inside the material, multiplied onto the sun term only.
 */

const CONTACT = /* glsl */ `
precision highp float;
${COMMON}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec3 uSunDirView;
uniform vec4 uParams;   // x length(m)  y thickness(m)  z frame  w strength
varying vec2 vUv;

#define OW_CS_STEPS 14

void main() {
  vec4 nrm = texture2D( tNormal, vUv );
  if ( nrm.z < 0.5 ) { gl_FragColor = vec4( 1.0, 1e4, 0.0, 1.0 ); return; }

  float depth = texture2D( tDepth, vUv ).r;
  vec3 P = owViewPos( vUv, depth, uProjInv );
  vec3 N = owDecodeNormal( nrm.xy );
  vec3 L = uSunDirView;

  // A pixel whose surface is turned away from the sun receives no sun term to
  // shadow, so the march is skipped -- and the NEGATED depth marks it for the
  // bilateral below, which would otherwise blur 30% of the frame to produce a
  // value nothing multiplies by anything. RG16F carries the sign for free, the
  // blur takes abs() everywhere it compares depths, and the only reader outside
  // this file (materialpatch.js, owContactShadow) takes .r and never .g.
  float NdL = dot( N, L );
  if ( NdL <= 0.02 ) { gl_FragColor = vec4( 1.0, -depth, 0.0, 1.0 ); return; }

  float len = uParams.x * clamp( depth * 0.08 + 0.75, 0.75, 2.5 );
  float jitter = owIGN( gl_FragCoord.xy + uParams.z * 3.1717 );

  vec3 origin = P + N * ( 0.012 + depth * 0.0015 );
  vec3 stepV = L * ( len / float( OW_CS_STEPS ) );

  float occ = 0.0;
  for ( int i = 0; i < OW_CS_STEPS; i ++ ) {
    vec3 sp = origin + stepV * ( float( i ) + jitter );
    vec4 clip = uProj * vec4( sp, 1.0 );
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if ( suv.x <= 0.0 || suv.x >= 1.0 || suv.y <= 0.0 || suv.y >= 1.0 ) break;

    // A depth of 0 is the prepass's "no geometry" clear (see prepass.js), so
    // this is the old normal.z < 0.5 coverage test for one fetch instead of
    // two.
    float sceneDepth = texture2D( tDepth, suv ).r;
    if ( sceneDepth <= 0.0 ) continue;

    float diff = -sp.z - sceneDepth;
    float bias = 0.004 + sceneDepth * 0.0025;
    if ( diff > bias && diff < uParams.y ) {
      // fade with distance travelled so the shadow dissolves rather than ends
      float t = ( float( i ) + jitter ) / float( OW_CS_STEPS );
      occ = max( occ, 1.0 - t * t );
      break;
    }
  }

  float shadow = 1.0 - occ * uParams.w;
  gl_FragColor = vec4( shadow, depth, 0.0, 1.0 );
}
`;

const BILATERAL = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uDirection;
uniform float uFinal;   // 1.0 on the second (vertical) direction, 0.0 on the first
varying vec2 vUv;
void main() {
  vec2 c = texture2D( tSrc, vUv ).rg;

  // Sky carries the 1e4 depth sentinel the contact pass writes for uncovered
  // pixels, and it is 41% of the frame at full resolution across BOTH blur
  // directions. Running the four side taps there computes a value that is
  // already known: every neighbour weight is exp( -|a.g - 1e4| * 40.0 / 1e4 ),
  // which is exp( -40 ) or smaller for any real depth, so a sky pixel resolves
  // to its own r -- 1.0, the pass's no-occlusion value -- to within 1e-17.
  // Nothing downstream reads it in any case: the term is multiplied onto the
  // sun contribution inside the material, and sky has none. The .g sentinel is
  // forwarded unchanged so the second direction sees the same mask.
  if ( c.g >= 1.0e4 ) { gl_FragColor = vec4( c.r, c.g, 0.0, 1.0 ); return; }

  // A NEGATIVE depth is the contact pass's "this surface is turned away from
  // the sun" mark (N.L <= 0.02, see above). 30.2% of this frame is such pixels
  // -- measured, not assumed: "cod fwd" reports backfacingPctOfScreen off the
  // same normals the G-buffer holds, and shadowsim independently puts 51.3% of
  // covered pixels there.
  //
  // ONLY THE SECOND DIRECTION MAY SKIP THEM, and the asymmetry is the whole
  // design. This pass's output is read by exactly one thing, owContactShadow in
  // materialpatch.js, multiplied onto a sun term those pixels do not have; the
  // FIRST direction's output, by contrast, is read again here, by the
  // front-facing neighbours two texels above and below. Skipping the horizontal
  // pass as well would save twice as much and would change the value those
  // neighbours read -- taking real occlusion off lit geometry, which is a
  // visible loss rather than an invisible one.
  //
  // The precedent is already in the frame: csm.js:579 returns 1.0 at NdL <= 0
  // and this file returns 1.0 at NdL <= 0.02, so a geometrically sun-averted
  // pixel is ALREADY treated as unshadowed everywhere except in this blur.
  if ( uFinal > 0.5 && c.g < 0.0 ) { gl_FragColor = vec4( c.r, c.g, 0.0, 1.0 ); return; }

  // abs() on every depth read, so a marked neighbour still weighs exactly what
  // it weighed before the mark existed. Both directions are therefore bit-
  // identical to the unmarked version on every pixel they still process:
  // abs() of a positive float is that float, and abs(-d) is d.
  float cg = max( 0.1, abs( c.g ) );
  float sum = c.r * 0.5;
  float wsum = 0.5;
  for ( int i = 1; i <= 2; i ++ ) {
    vec2 o = uDirection * float( i );
    vec2 a = texture2D( tSrc, vUv + o ).rg;
    vec2 b = texture2D( tSrc, vUv - o ).rg;
    float w = 0.3 / float( i );
    float wa = w * exp( -abs( abs( a.g ) - abs( c.g ) ) * 40.0 / cg );
    float wb = w * exp( -abs( abs( b.g ) - abs( c.g ) ) * 40.0 / cg );
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  gl_FragColor = vec4( sum / wsum, c.g, 0.0, 1.0 );
}
`;

export class ContactShadows {
  constructor() {
    this.pass = new Pass('ow-contact', CONTACT, {
      tDepth: { value: null },
      tNormal: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      // x ray length (m) at 1x, y thickness (m), z frame, w strength.
      // 0.40 m with the distance ramp below spans roughly 0.30..1.0 m of world
      // travel, which is what puts the last few centimetres of occlusion back:
      // a cascade texel at 40 m is wider than the gap between a crate and the
      // ground, so without this every prop is a sticker on the floor.
      uParams: { value: new THREE.Vector4(0.4, 0.42, 0, 1.0) },
    });
    this.blur = new Pass('ow-contact-blur', BILATERAL, {
      tSrc: { value: null },
      uDirection: { value: new THREE.Vector2() },
      // An explicit flag rather than `uDirection.x == 0.0`. The horizontal pass
      // happens to be the one with a zero y today, so the implicit test would
      // work and would break silently the day the order is swapped.
      uFinal: { value: 0 },
    });
    this.rtA = null;
    this.rtB = null;
    this.texture = null;
  }

  /** @param m world-space ray length in metres at 1x distance scaling. */
  setLength(m) {
    this.pass.uniforms.uParams.value.x = m;
  }

  /** @param s 0..1 how much of the sun term a full contact hit removes. */
  setStrength(s) {
    this.pass.uniforms.uParams.value.w = s;
  }

  /**
   * @param blurScale  multiplier on the blur's tap spacing, in units of this
   *   target's own texel. Below 1x resolution the bilateral would otherwise
   *   widen with the texel — a half-res buffer blurring +/-2 of ITS texels
   *   reaches +/-4 screen pixels, and a contact shadow is only a few pixels
   *   wide to begin with, so it would dissolve the very band this pass exists
   *   to resolve. Passing the resolution scale here keeps the blur's footprint
   *   fixed in SCREEN space at any resolution; the sub-texel offsets that
   *   produces are exact, the targets are LinearFilter.
   */
  setSize(w, h, blurScale = 1) {
    this.rtA?.dispose();
    this.rtB?.dispose();
    const o = { type: THREE.HalfFloatType, format: THREE.RGFormat, name: 'contact' };
    this.rtA = hdrTarget(w, h, o);
    this.rtB = hdrTarget(w, h, o);
    this._texel = new THREE.Vector2(blurScale / w, blurScale / h);
  }

  render(renderer, gbuffer, camera, sunDirView, frame) {
    const u = this.pass.uniforms;
    u.tDepth.value = gbuffer.depthTexture;
    u.tNormal.value = gbuffer.normalTexture;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uSunDirView.value.copy(sunDirView);
    u.uParams.value.z = frame % 64;
    this.pass.render(renderer, this.rtA);

    const b = this.blur.uniforms;
    b.tSrc.value = this.rtA.texture;
    b.uDirection.value.set(this._texel.x, 0);
    b.uFinal.value = 0;
    this.blur.render(renderer, this.rtB);
    b.tSrc.value = this.rtB.texture;
    b.uDirection.value.set(0, this._texel.y);
    // Only this direction may drop the sun-averted pixels; see BILATERAL.
    b.uFinal.value = 1;
    this.blur.render(renderer, this.rtA);

    this.texture = this.rtA.texture;
    return this.texture;
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.pass.dispose();
    this.blur.dispose();
  }
}

import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Ground-Truth Ambient Occlusion (Jimenez et al. 2016) — the visibility-arc
 * integral, not a hemisphere-sample SSAO approximation.
 *
 * Two slices x eight steps per frame, with the slice angle rotated by
 * interleaved-gradient noise and advanced every frame; a velocity-reprojected
 * temporal accumulator turns that into the equivalent of ~16 slices without
 * the cost. A depth-aware separable bilateral removes what is left.
 *
 * The result is consumed inside the material (see materialpatch.js), where it
 * multiplies indirect light only.
 */

const AO_CORE = /* glsl */ `
precision highp float;
${COMMON}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uProjInv;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uP11;
uniform vec4 uParams;   // x radius(m)  y intensity  z frame  w thickness
varying vec2 vUv;

#define OW_SLICES 3
#define OW_STEPS 8

float owArc( float h, float n, float cosN, float sinN ) {
  return 0.25 * ( -cos( 2.0 * h - n ) + cosN + 2.0 * h * sinN );
}

void main() {
  vec4 nrm = texture2D( tNormal, vUv );
  if ( nrm.z < 0.5 ) { gl_FragColor = vec4( 1.0, 1e4, 0.0, 1.0 ); return; }

  float depth = texture2D( tDepth, vUv ).r;
  vec3 P = owViewPos( vUv, depth, uProjInv );
  vec3 N = owDecodeNormal( nrm.xy );
  vec3 V = normalize( -P );

  float radius = uParams.x;
  // world radius -> pixels
  float radiusPx = radius * uP11 * 0.5 * uResolution.y / max( 0.2, depth );
  radiusPx = clamp( radiusPx, 6.0, 128.0 );

  float noise = owIGN( gl_FragCoord.xy + uParams.z * 5.588238 );
  float noise2 = owHash12( gl_FragCoord.xy * 0.371 + uParams.z );

  float invR2 = 1.0 / ( radius * radius );
  float visibility = 0.0;

  for ( int s = 0; s < OW_SLICES; s ++ ) {
    float phi = ( float( s ) + noise ) * ( OW_PI / float( OW_SLICES ) );
    vec2 dir2 = vec2( cos( phi ), sin( phi ) );
    vec3 sliceDir = vec3( dir2, 0.0 );

    vec3 axis = normalize( cross( sliceDir, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projLen = length( projN );
    if ( projLen < 1e-4 ) continue;
    vec3 projNn = projN / projLen;

    vec3 orthoDir = normalize( sliceDir - V * dot( sliceDir, V ) );
    float cosN = clamp( dot( projNn, V ), -1.0, 1.0 );
    float n = sign( dot( orthoDir, projNn ) ) * acos( cosN );
    float sinN = sin( n );

    // Horizons are signed relative to orthoDir: the +dir2 side carries the
    // POSITIVE angle. Getting this the wrong way round collapses the
    // visibility arc on every grazing surface.
    float cosHPos = -1.0;
    float cosHNeg = -1.0;

    for ( int t = 0; t < OW_STEPS; t ++ ) {
      // QUADRATIC step distribution, not linear.
      //
      // A 1.35 m radius on a wall three metres away is 316 px, clamped to 128,
      // which with eight linear steps put the FIRST sample sixteen pixels out.
      // Everything inside that — the wall/soffit junction, the foot of a
      // column, the gap under a crate, i.e. every contact in the frame — was
      // simply never sampled, and the buffer came back at 0.92 visibility
      // almost everywhere with nothing but a wide soft gradient in it. Weighting
      // the steps toward the origin puts the first three inside six pixels while
      // still reaching the full radius, at the same eight taps.
      //
      // +1 px minimum: a sample that lands back on the centre texel produces a
      // garbage horizon direction that closes the visibility arc completely.
      //
      // MEASURED AND REJECTED: an out-of-radius break before the fetch. The
      // claim was geometric and it is sound as far as it goes -- a tap updates
      // the horizon with cosH = max( cosH, mix( c, cosH, fall ) ), and at
      // fall == 1 that is bit-exactly the identity, so a sample that CANNOT land
      // within the AO radius is a provable no-op. |ds| is unknown before the fetch,
      // but a lower bound is not: the sample lies on the view ray through the
      // offset uv, and the nearest that ray comes to P is |P| sin(theta), which
      // depends only on the screen offset. Solving that bound for the offset
      // gives an offMax per (pixel, slice), and because off grows
      // monotonically in t the test is a break rather than a continue.
      //
      // It fires on NOTHING. Evaluated per pixel over the real depth field at
      // this pass's own resolution with the frame's own uniforms: 48 taps per
      // covered pixel, 0.00% of them skippable, 0.000 fetches saved per frame
      // pixel. The reason is radiusPx = clamp( .., 6, 128 ) two lines up -- the
      // clamp keeps the sampled disc well inside the world radius at every depth
      // the frame actually contains, so the bound is never reached. It would
      // only start paying on geometry far enough away for the unclamped radiusPx
      // to fall under 6 px, and at that distance the pass is being upsampled
      // from a quarter-resolution buffer anyway. Do not re-derive this: the
      // algebra is correct and the answer is still zero.
      //
      // ALSO MEASURED AND REJECTED, and it is a DIFFERENT argument from the one
      // above, so rejecting one does not reject the other: skipping a step that
      // lands on a texel the previous step already read. tDepth is
      // NearestFilter, so two taps inside one texel return the same number and
      // the second buys only a slightly different reconstruction of a value
      // already held -- worth 6 fetches, since off does not depend on the
      // slice. The ladder below is quadratic, so at radiusPx = 6 the first
      // three steps span 0.6 px and the case is real.
      //
      // It is worth 0.06 fetches per fragment, 0.2 % of this loop. The reason
      // is the frame, not the algebra: cod gtaosteps counts radiusPx over the
      // real depth field and finds a mean of 86.5 px with 0.000 % of covered
      // pixels at the clamp FLOOR -- 77 % of the frame is inside 10 m and none
      // of it beyond 40 m, where radiusPx would have to fall under about 10 for
      // two steps to share a texel. The other half of it is that the offsets
      // are scaled by uTexel, which is the PASS's 1134x736, while tDepth is the
      // full-resolution 2268x1473 gbuffer depth: one pass texel is TWO depth
      // texels, so a gap has to close to half a pass texel before it closes to
      // one depth texel. See the header of tools/cli/gtaosim.mjs.
      float ft = ( float( t ) + noise2 ) / float( OW_STEPS );
      float off = radiusPx * ft * ft + 1.0;
      vec2 duv = dir2 * off * uTexel;

      // Coverage is read off the DEPTH texture, not off normal.z. The prepass
      // clears to zero and no drawn fragment can have a view depth of 0 (it
      // would be behind the near plane), so testing d > 0.0 is exactly the old
      // cov > 0.5 test at half the bandwidth — this loop is 48 fetches per
      // pixel instead of 96, and it is the hottest loop in the frame.
      // See the contract note in prepass.js render().

      // +dir
      vec2 uv1 = vUv + duv;
      if ( uv1.x > 0.0 && uv1.x < 1.0 && uv1.y > 0.0 && uv1.y < 1.0 ) {
        float d1 = texture2D( tDepth, uv1 ).r;
        if ( d1 > 0.0 ) {
          vec3 ds = owViewPos( uv1, d1, uProjInv ) - P;
          float len2 = dot( ds, ds );
          if ( len2 > 2e-5 ) {
            float inv = inversesqrt( len2 );
            float c = dot( ds, V ) * inv;
            float fall = clamp( len2 * invR2, 0.0, 1.0 );
            fall *= fall;
            cosHPos = max( cosHPos, mix( c, cosHPos, fall ) );
          }
        }
      }

      // -dir
      vec2 uv2 = vUv - duv;
      if ( uv2.x > 0.0 && uv2.x < 1.0 && uv2.y > 0.0 && uv2.y < 1.0 ) {
        float d2 = texture2D( tDepth, uv2 ).r;
        if ( d2 > 0.0 ) {
          vec3 ds = owViewPos( uv2, d2, uProjInv ) - P;
          float len2 = dot( ds, ds );
          if ( len2 > 2e-5 ) {
            float inv = inversesqrt( len2 );
            float c = dot( ds, V ) * inv;
            float fall = clamp( len2 * invR2, 0.0, 1.0 );
            fall *= fall;
            cosHNeg = max( cosHNeg, mix( c, cosHNeg, fall ) );
          }
        }
      }
    }

    float h1 = -acos( clamp( cosHNeg, -1.0, 1.0 ) );
    float h2 = acos( clamp( cosHPos, -1.0, 1.0 ) );
    h1 = n + max( h1 - n, -OW_HALF_PI );
    h2 = n + min( h2 - n, OW_HALF_PI );

    // A single slice legitimately integrates to more than 1 on tilted
    // surfaces; the excess is what compensates the slices whose projected
    // normal is short. Clamping per slice (or per frame) biases the whole
    // buffer dark, which is the classic "my SSAO looks like dirt" bug.
    visibility += projLen * ( owArc( h1, n, cosN, sinN ) + owArc( h2, n, cosN, sinN ) );
  }

  visibility = clamp( visibility / float( OW_SLICES ), 0.0, 4.0 );

  gl_FragColor = vec4( visibility, depth, 0.0, 1.0 );
}
`;

const AO_TEMPORAL = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform float uFeedback;
varying vec2 vUv;

void main() {
  vec2 cur = texture2D( tCurrent, vUv ).rg;

  // Sky: AO_CORE writes vec4( 1.0, 1e4, 0, 1 ) wherever the gbuffer has no
  // normal, so .g carries 1e4 as a sentinel and .r carries a SCREEN CONSTANT of
  // 1.0. Both facts are needed, and together they make the rest of this shader a
  // no-op on the sky. .g is passed through untouched either way, so only .r has
  // to be argued, and it comes out as cur.x in all three cases:
  //
  //   history reprojects onto sky   rel is 0 and w stays uFeedback, but hist.x
  //                                 is that same 1.0 constant, and the clamp
  //                                 window is [ mn - 0.45, mx + 0.45 ] with
  //                                 mn <= cur.x <= mx, so it always contains
  //                                 cur.x +- 0.45 and cannot move hist.x off it.
  //                                 h == cur.x, and mix( x, x, w ) is x.
  //   history reprojects onto geometry  the world camera's far plane is 1200, so
  //                                 hist.y <= 1200 against cur.y of 1e4 gives
  //                                 rel >= 0.88 and w <= uFeedback * exp( -26.4 )
  //                                 = 3.4e-12. h is inside [ -0.45, 1.45 ], so
  //                                 the result differs from cur.x by at most
  //                                 1.45 * 3.4e-12 = 4.9e-12.
  //   history lands off screen      w is set to 0 outright and mix returns cur.x.
  //
  // The target is HalfFloatType/RGFormat, whose step at 1.0 is 4.9e-4 -- eight
  // orders of magnitude above that worst deficit, so the write is bit for bit
  // the same value. (In float32, whose step at 1.0 is 6.0e-8, it still is.)
  // The 1e4 sentinel itself is exact in half float: the step at 10000 is 8 and
  // 10000 / 8 is a whole number, so it survives every round trip unchanged.
  //
  // On a 41% sky frame this is 6 of the pass's 7 fetches on 41% of it.
  if ( cur.y > 2000.0 ) {
    gl_FragColor = vec4( cur.x, cur.y, 0.0, 1.0 );
    return;
  }

  vec2 vel = texture2D( tVelocity, vUv ).rg;
  vec2 huv = vUv - vel;

  float w = uFeedback;
  if ( huv.x < 0.0 || huv.x > 1.0 || huv.y < 0.0 || huv.y > 1.0 ) w = 0.0;

  vec2 hist = texture2D( tHistory, huv ).rg;
  // reject on depth discontinuity (disocclusion)
  float rel = abs( hist.y - cur.y ) / max( 0.05, cur.y );
  w *= exp( -rel * 30.0 );

  // A wide neighbourhood window only: the per-frame signal is 3 slices of a
  // stochastic integral, so a tight clamp would just re-inject its variance.
  float mn = cur.x, mx = cur.x;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 o = vec2( i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0 );
    float s = texture2D( tCurrent, vUv + o * uTexel * 2.0 ).r;
    mn = min( mn, s ); mx = max( mx, s );
  }
  float h = clamp( hist.x, mn - 0.45, mx + 0.45 );

  gl_FragColor = vec4( mix( cur.x, h, w ), cur.y, 0.0, 1.0 );
}
`;

const AO_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D tAo;
uniform vec2 uDirection;
uniform vec2 uParams;   // x: apply the intensity curve on this pass
varying vec2 vUv;

void main() {
  vec2 c = texture2D( tAo, vUv ).rg;

  // Sky, and the six neighbour fetches below provably cannot move the answer.
  //
  // AO_CORE writes vec4( 1.0, 1e4, 0, 1 ) wherever the gbuffer has no normal,
  // and AO_TEMPORAL passes .g through as cur.y untouched, so 1e4 still marks the
  // sky here. Geometry cannot reach it: .g is POSITIVE LINEAR VIEW DEPTH in
  // metres and the camera far plane is 1200, so the test below has eight times
  // the margin it needs in one direction and five in the other.
  //
  // With c.g = 1e4 the bilateral weight of a neighbour at a real depth d is
  // w0 * exp( -( 1e4 - d ) * 22 / 1e4 ) <= w0 * exp( -21.98 ) = 2.9e-10, while
  // every sky neighbour keeps its full w0 AND carries .r = 1.0. So the sum is
  // S * 1.0 + e over S + E, where S >= 0.4 is the sky weight including the 0.4
  // centre tap, E <= 2.5e-10 is the total geometry weight and 0 <= e <= E. That
  // is at worst 1 - E/S = 1 - 6.2e-10, and the intensity curve pow( x, 1.25 )
  // at most scales the deficit by 1.25.
  //
  // The target is HalfFloatType, whose step at 1.0 is 4.9e-4 -- six orders of
  // magnitude coarser. So this is not a close approximation of the loop below,
  // it is the same stored value. (It would still round to 1.0 in float32, whose
  // step at 1.0 is 6.0e-8.) 1e4 itself is exact in half float: the step at
  // 10000 is 8 and 10000 / 8 is a whole number, so the sentinel survives every
  // round trip through these targets unchanged.
  if ( c.g > 2000.0 ) {
    gl_FragColor = vec4( 1.0, c.g, 0.0, 1.0 );
    return;
  }

  float sum = c.r * 0.4;
  float wsum = 0.4;
  for ( int i = 1; i <= 3; i ++ ) {
    float w0 = 0.4 / float( i + 1 );
    vec2 o = uDirection * float( i );
    vec2 a = texture2D( tAo, vUv + o ).rg;
    vec2 b = texture2D( tAo, vUv - o ).rg;
    float wa = w0 * exp( -abs( a.g - c.g ) * 22.0 / max( 0.1, c.g ) );
    float wb = w0 * exp( -abs( b.g - c.g ) * 22.0 / max( 0.1, c.g ) );
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  float ao = sum / wsum;
  if ( uParams.x > 0.5 ) ao = pow( clamp( ao, 0.0, 1.0 ), uParams.y );
  gl_FragColor = vec4( ao, c.g, 0.0, 1.0 );
}
`;

export class Gtao {
  constructor() {
    this.core = new Pass('ow-gtao', AO_CORE, {
      tDepth: { value: null },
      tNormal: { value: null },
      uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uP11: { value: 1 },
      uParams: { value: new THREE.Vector4(0.9, 1.35, 0, 0.4) },
    });
    this.temporal = new Pass('ow-gtao-temporal', AO_TEMPORAL, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tVelocity: { value: null },
      tNormal: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFeedback: { value: 0.92 },
    });
    this.blur = new Pass('ow-gtao-blur', AO_BLUR, {
      tAo: { value: null },
      uDirection: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector2(0, 1.25) },
    });

    this.rtRaw = null;
    this.rtBlur = null;
    this.rtFinal = null;
    this.history = [null, null];
    this._flip = 0;
    this.texture = null;
  }

  setSize(w, h) {
    this.dispose(true);
    const o = { type: THREE.HalfFloatType, format: THREE.RGFormat, name: 'gtao' };
    this.rtRaw = hdrTarget(w, h, o);
    this.rtBlur = hdrTarget(w, h, o);
    this.rtFinal = hdrTarget(w, h, o);
    this.history[0] = hdrTarget(w, h, o);
    this.history[1] = hdrTarget(w, h, o);
    this.core.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.core.uniforms.uResolution.value.set(w, h);
    this.temporal.uniforms.uTexel.value.set(1 / w, 1 / h);
    this._texel = new THREE.Vector2(1 / w, 1 / h);
  }

  render(renderer, gbuffer, camera, frame, temporalOn) {
    const cu = this.core.uniforms;
    cu.tDepth.value = gbuffer.depthTexture;
    cu.tNormal.value = gbuffer.normalTexture;
    cu.uProjInv.value.copy(camera.projectionMatrixInverse);
    cu.uP11.value = camera.projectionMatrix.elements[5];
    cu.uParams.value.z = temporalOn ? frame % 64 : 0;
    this.core.render(renderer, this.rtRaw);

    let src = this.rtRaw;
    if (temporalOn) {
      const prev = this.history[this._flip];
      const next = this.history[this._flip ^ 1];
      const tu = this.temporal.uniforms;
      tu.tCurrent.value = this.rtRaw.texture;
      tu.tHistory.value = prev.texture;
      tu.tVelocity.value = gbuffer.velocityTexture;
      this.temporal.render(renderer, next);
      this._flip ^= 1;
      src = next;
    }

    // Blur into a dedicated target: the history must stay un-blurred or the
    // accumulator smears more every frame.
    const bu = this.blur.uniforms;
    bu.tAo.value = src.texture;
    bu.uDirection.value.set(this._texel.x, 0);
    bu.uParams.value.x = 0;
    this.blur.render(renderer, this.rtBlur);
    bu.tAo.value = this.rtBlur.texture;
    bu.uDirection.value.set(0, this._texel.y);
    bu.uParams.value.x = 1; // clamp + intensity curve on the last stage only
    this.blur.render(renderer, this.rtFinal);

    this.texture = this.rtFinal.texture;
    return this.texture;
  }

  setRadius(r) {
    this.core.uniforms.uParams.value.x = r;
  }
  setIntensity(i) {
    this.blur.uniforms.uParams.value.y = i;
  }

  dispose(keepPasses = false) {
    this.rtRaw?.dispose();
    this.rtBlur?.dispose();
    this.rtFinal?.dispose();
    this.history[0]?.dispose();
    this.history[1]?.dispose();
    this.rtRaw = this.rtBlur = this.rtFinal = null;
    this.history[0] = this.history[1] = null;
    if (!keepPasses) {
      this.core.dispose();
      this.temporal.dispose();
      this.blur.dispose();
    }
  }
}

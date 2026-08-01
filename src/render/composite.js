import * as THREE from 'three';
import { COMMON, TONEMAP } from './glsl.js';
import { Pass } from './pass.js';

/**
 * Final composite: exposure -> lens (chromatic aberration, additive thresholded
 * bloom, cos^4 lens shading — all in linear light) -> AgX filmic tone map ->
 * procedural LUT grade -> grain -> contrast-adaptive sharpen -> sRGB with an
 * ordered dither.
 *
 * All of it in one pass, one pass over the framebuffer, so the bandwidth cost
 * is a single read/write rather than one per effect.
 */

/**
 * The exposure fetch, hoisted to the three vertices of the full-screen triangle.
 *
 * `tExposure` is a 1x1 FloatType target (AutoExposure.adapt), so
 * `texture2D( tExposure, vec2( 0.5 ) )` returned the same texel on all 3.34 M
 * pixels — one texture instruction per pixel to read a number that is constant
 * over the whole draw. Reading it per vertex is 3 fetches instead of 3 340 764.
 *
 * `flat` is what makes this bit-identical rather than merely equal: the value
 * arrives from the provoking vertex with no interpolation, so it is the same
 * bits the fragment stage used to fetch, not a barycentric average of three
 * copies that a compiler is free to compute in a different order. It is legal
 * here despite the ESSL 1.00 spellings below because three.js compiles every
 * ShaderMaterial as `#version 300 es` — see the note on Pass in pass.js.
 *
 * The multiply by uLook.w rides along: it is a uniform too, so the whole
 * expression the fragment stage needs is finished before rasterisation starts.
 */
const COMPOSITE_VERT = /* glsl */ `
uniform sampler2D tExposure;
uniform vec4 uLook;
varying vec2 vUv;
flat out float vExposure;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vExposure = texture2D( tExposure, vec2( 0.5 ) ).r * uLook.w;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const COMPOSITE = /* glsl */ `
precision highp float;
${COMMON}
${TONEMAP}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler3D tLut;

uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uLens;      // x chromatic, y vignette, z grainAmount, w time
uniform vec4 uGrade;     // x bloomStrength, y lutStrength, z sharpen, w lutSize
uniform vec4 uLook;      // x agx slope, y agx power, z agx sat, w exposureBias
uniform float uRecon;    // edge-directed upscale strength; 0 at native res
varying vec2 vUv;
// Already multiplied by uLook.w in COMPOSITE_VERT.
flat in float vExposure;

vec3 sampleLut( vec3 c ) {
  float n = uGrade.w;
  vec3 uvw = clamp( c, 0.0, 1.0 ) * ( ( n - 1.0 ) / n ) + ( 0.5 / n );
  return texture( tLut, uvw ).rgb;
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  // --- chromatic aberration: sample the scene three times with a radial
  //     offset that grows toward the corners, like a real lens
  //
  // The centre tap is hoisted out and shared. Both arms of the branch fetched
  // vUv already and the centre variable then fetched it a third time, for the
  // same texel of the same texture in the same invocation. Starting from the
  // centre and overwriting only the two shifted channels is arithmetically the
  // same value: green is the centre either way, and the max( hdr, 0 ) below
  // makes max( max( x, 0 ), 0 ) collapse to max( x, 0 ) on the channels that
  // came through it.
  vec3 centre = max( texture2D( tColor, vUv ).rgb, vec3( 0.0 ) );
  vec3 hdr = centre;
  float ca = uLens.x * r2;
  if ( ca > 0.00002 ) {
    vec2 o = d * ca;
    hdr.r = texture2D( tColor, vUv + o ).r;
    hdr.b = texture2D( tColor, vUv - o ).b;
  }
  hdr = max( hdr, vec3( 0.0 ) );

  vec3 n1 = max( texture2D( tColor, vUv + vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 n2 = max( texture2D( tColor, vUv - vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 n3 = max( texture2D( tColor, vUv + vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );
  vec3 n4 = max( texture2D( tColor, vUv - vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );

  // The five luminances of the tap cross, computed once for the three consumers
  // below instead of twice. owLum is linear, so the chroma blur's owLum( nb ) is
  // exactly lblur and no longer needs a dot product of its own.
  float l1 = owLum( n1 ), l2 = owLum( n2 ), l3 = owLum( n3 ), l4 = owLum( n4 );
  float lc = owLum( centre );
  float lblur = ( l1 + l2 + l3 + l4 ) * 0.25;
  float lmn = min( min( l1, l2 ), min( l3, l4 ) );
  float lmx = max( max( l1, l2 ), max( l3, l4 ) );

  // --- edge-directed reconstruction of the upscale -------------------------
  // uTexel is ONE SOURCE TEXEL, and composite.render( renderer, null ) writes at
  // drawing-buffer size, so below renderScale 1 this pass IS the upscaler and the
  // four taps above are a cross at exactly one source texel around the fractional
  // source position. The bilinear tent that texture2D applies on the way up
  // spreads a one-texel step across two, and that smear -- not aliasing -- is
  // what a scaled frame actually looks like once TAA has band-limited it.
  //
  // What this undoes it with: the second derivative IN THE GRADIENT DIRECTION.
  //   wx      how much of the gradient lies along x, from EASU's two-texel first
  //           differences. 1 on a vertical edge, 0 on a horizontal one, 0.5 when
  //           there is no gradient to speak of (the +1e-12 pair makes that case
  //           land exactly on 0.5 instead of on 0/0).
  //   lAcross the neighbour pair that CROSSES the edge. lc - lAcross is minus
  //           half the second derivative along that direction, which is zero on
  //           the linear middle of a ramp and non-zero exactly at the two knees
  //           the tent rounded off. Undoing it there and only there compresses a
  //           two-texel edge back to one.
  //
  // THE CLAMP IS NOT A SAFETY RAIL, IT IS THE FILTER. Without it this is a plain
  // unsharp mask and it overshoots a step by +/-50%: on the measured frame,
  // dropping the clamp costs more than the whole filter gains, three times over
  // (SSIM 0.9577 -> 0.8987, against 0.9488 for bilinear). Clamping the TARGET
  // LUMINANCE to the tap cross is the same anti-ringing bound FSR's RCAS applies
  // through its lobe limit, and it is what turns a sharpen into a deconvolution.
  //
  // A LUMINANCE GAIN, for the reason the sharpen below is one: a scalar multiple
  // of the centre colour cannot invent chroma. It measured identically to the
  // per-channel form (SSIM 0.95777 rgb vs 0.95773 luma at 0.72), so the form that
  // cannot reintroduce the fringing bug wins for free.
  //
  // MEASURED with cod upsim, against a 9x supersampled reference. SSIM, bilinear
  // -> this, at 512x332:
  //   0.95 0.96507 -> 0.96857   0.85 0.95959 -> 0.96561   0.72 0.94883 -> 0.95777
  //   0.90 0.96193 -> 0.96656   0.80 0.95571 -> 0.96212   0.65 0.93961 -> 0.95009
  // and it runs BEFORE the chroma clean-up because that is where it was measured.
  //
  // WHERE IT LOSES, which is why reconStrength() gates it: on a source TAA has
  // not band-limited -- a 1-spp aliased frame -- sharpening amplifies the
  // staircase and costs 0.005 SSIM. That case is the no-TAA path, and there the
  // fxaa pass is non-null, the composite writes to ldrRt at internal size, FXAA
  // does the upscale and uRecon is 0. The filter is on exactly where it wins.
  if ( uRecon > 0.0 ) {
    float dx = l1 - l2, dy = l3 - l4;
    float gx = dx * dx, gy = dy * dy;
    float wx = ( gx + 1e-12 ) / ( gx + gy + 2e-12 );
    float lAcross = mix( ( l3 + l4 ) * 0.5, ( l1 + l2 ) * 0.5, wx );
    float lt = clamp( lc + ( lc - lAcross ) * uRecon, min( lc, lmn ), max( lc, lmx ) );
    hdr *= lt / max( lc, 1e-4 );
  }

  // --- chroma clean-up in the darks ---------------------------------------
  // A 4-tap CHROMA-only blur, applied only in the bottom three stops and
  // fading out completely by the mid-tones. It keeps each pixel's own
  // luminance exactly — so no detail, edge or texture is softened — and only
  // pulls its hue toward the neighbourhood's.
  //
  // The post chain is no longer the source of the per-pixel chroma speckle
  // over dark surfaces (measured: turning grain, CA and sharpen off together
  // moves the high-frequency chroma metric by under 5%), but the night frame
  // still reads as speckled because a ~14x exposure amplifies whatever chroma
  // variance the shading has. The eye has almost no chroma acuity down there,
  // which is exactly why every codec and every denoiser throws dark chroma
  // away, and why doing it here costs nothing visible but the noise.
  {
    vec3 nb = ( n1 + n2 + n3 + n4 ) * 0.25;
    float lh = owLum( hdr );
    float w = ( 1.0 - smoothstep( 0.003, 0.030, lh ) ) * 0.60;
    if ( w > 0.005 && lblur > 1e-6 ) hdr = mix( hdr, nb * ( lh / lblur ), w );
  }

  // --- sharpen (contrast adaptive, only where TAA softened things) ---------
  // LUMINANCE ONLY, and computed from the UNSHIFTED centre tap. The old code
  // sharpened hdr, which is the chromatically-aberrated fetch, against a blur
  // of unshifted neighbours: the difference therefore *contained the CA offset
  // itself* and the sharpen amplified it, which is where the coarse
  // magenta/green fringing on every high-contrast edge came from. A scalar gain
  // around the centre luminance cannot invent chroma at all.
  if ( uGrade.z > 0.001 ) {
    // contrast adaptive: less sharpening where local contrast is already high
    float contrast = ( lmx - lmn ) / ( lmx + lmn + 0.02 );
    float amount = uGrade.z * ( 1.0 - clamp( contrast * 1.6, 0.0, 1.0 ) );
    // ...and none at all down in the noise floor, where "detail" is grain.
    amount *= smoothstep( 0.004, 0.03, lc );
    float gain = ( lc + ( lc - lblur ) * amount ) / max( lc, 1e-4 );
    hdr *= clamp( gain, 0.0, 4.0 );
  }

  hdr *= vExposure;

  // --- bloom (already exposure-scaled AND thresholded in the prefilter) ----
  // ADDED, not mixed. mix() with an unthresholded pyramid is veiling glare: it
  // replaces N% of every pixel with a blurred copy of the frame, which is a
  // milky haze you cannot turn up far enough to see a specular event. The
  // pyramid now only carries what is above display white, so adding it puts
  // light around the sun disc, the glints and the muzzle flash and leaves the
  // rest of the frame exactly where the tone curve put it.
  vec3 bloom = max( texture2D( tBloom, vUv ).rgb, vec3( 0.0 ) );
  hdr += bloom * max( uGrade.x, 0.0 );

  // --- vignette: cos^4 natural falloff, in LINEAR LIGHT --------------------
  // Lens shading is a transmission loss, so it belongs in front of the tone
  // curve, not behind it. Applied in display space it was a flat multiply on the
  // code value: at 0.24 it scaled everything outside the middle sixth of the
  // frame by 0.85..0.81, which put a hard ceiling of ~210 code values on the sky
  // and made display white unreachable anywhere but dead centre. In linear light
  // the same 0.24 costs a quarter of a stop, which the filmic shoulder absorbs
  // in the highlights (a few code values) while still visibly weighting the mids
  // and shadows toward the corners — which is the whole point of a vignette.
  float cos4 = pow( 1.0 / ( 1.0 + r2 * 2.4 ), 2.0 );
  hdr *= mix( 1.0, cos4, uLens.y );

  // --- tone map ------------------------------------------------------------
  vec3 col = owAgX( hdr, uLook.x, uLook.y, uLook.z );

  // --- DISPLAY TRANSFORM ---------------------------------------------------
  // Everything below this line is display-referred (code values, 0..1 sRGB).
  // The grade LUT and the grain are authored in that space:
  // the LUT's toe/shadowTint are additive *code value* offsets, so feeding it
  // linear light turned a 0.008 toe into a hard linear floor and painted the
  // whole frame's shadows blue-grey. Encode first, grade second.
  col = clamp( col, 0.0, 1.0 );
  vec3 disp = owLinearToSrgb( col );

  // --- procedural film grade (display-referred) ----------------------------
  vec3 graded = sampleLut( disp );
  disp = mix( disp, graded, uGrade.y );

  // --- grain, in code-value space, LESS of it in the darks -----------------
  // Real sensor noise is loudest in the mid/upper mids once it has been
  // through a display transform; in the darks it is what the eye reads as
  // "dirty image", so the response is deliberately the opposite of the naive
  // "more grain where it is dark".
  if ( uLens.z > 0.0005 ) {
    float g = owHash12( gl_FragCoord.xy + uLens.w * 137.13 ) - 0.5;
    float g2 = owHash12( gl_FragCoord.xy * 1.7 - uLens.w * 71.3 ) - 0.5;
    float noise = ( g * 0.65 + g2 * 0.35 );
    float l = owLum( disp );
    float response = uLens.z * ( 0.35 + 0.65 * smoothstep( 0.0, 0.30, l ) );
    disp += noise * response;
  }

  // ordered dither before the 8-bit write kills gradient banding in the sky
  disp += ( owHash12( gl_FragCoord.xy * 0.5 + uLens.w ) - 0.5 ) * 0.0022;

  gl_FragColor = vec4( disp, 1.0 );
}
`;

const FXAA = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vUv;

// Compact FXAA 3.11-style edge filter, used only when TAA is off so the
// no-temporal path still has clean silhouettes.
void main() {
  vec3 rgbNW = texture2D( tColor, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbNE = texture2D( tColor, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbSW = texture2D( tColor, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 rgbSE = texture2D( tColor, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  vec4 texColor = texture2D( tColor, vUv );
  vec3 rgbM = texColor.rgb;

  float lumaNW = owLum( rgbNW );
  float lumaNE = owLum( rgbNE );
  float lumaSW = owLum( rgbSW );
  float lumaSE = owLum( rgbSE );
  float lumaM  = owLum( rgbM );
  float lumaMin = min( lumaM, min( min( lumaNW, lumaNE ), min( lumaSW, lumaSE ) ) );
  float lumaMax = max( lumaM, max( max( lumaNW, lumaNE ), max( lumaSW, lumaSE ) ) );

  if ( lumaMax - lumaMin < max( 0.0312, lumaMax * 0.125 ) ) {
    gl_FragColor = texColor;
    return;
  }

  vec2 dir = vec2(
    -( ( lumaNW + lumaNE ) - ( lumaSW + lumaSE ) ),
      ( ( lumaNW + lumaSW ) - ( lumaNE + lumaSE ) ) );
  float dirReduce = max( ( lumaNW + lumaNE + lumaSW + lumaSE ) * 0.03125, 0.0078125 );
  float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
  dir = clamp( dir * rcpDirMin, -8.0, 8.0 ) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D( tColor, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
    texture2D( tColor, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D( tColor, vUv - dir * 0.5 ).rgb +
    texture2D( tColor, vUv + dir * 0.5 ).rgb );

  float lumaB = owLum( rgbB );
  gl_FragColor = vec4( ( lumaB < lumaMin || lumaB > lumaMax ) ? rgbA : rgbB, texColor.a );
}
`;

/**
 * Composite the first-person scene over the finished world image.
 *
 * The viewmodel is rendered into its own MSAA colour+depth target AFTER the TAA
 * resolve, because it is the one thing in the frame whose motion the camera
 * matrices cannot describe. The ADS transition, sway, bob, recoil and the
 * skinned AI meshes all move in VIEW space, so a velocity buffer built from
 * `viewPrevVP`/`viewCurrVP` emits zero motion for them; TAA then reprojected
 * those pixels onto a stale sample containing the static background and blended
 * it in at ~85%, which is why the optic tube, the mount and the glove were
 * semi-transparent with balcony rails and power lines legible straight through.
 * Drawing it after the resolve makes the whole class of bug impossible.
 *
 * The target holds PREMULTIPLIED alpha: opaque geometry lands a = 1, the MSAA
 * resolve produces fractional coverage on the silhouette, additive muzzle flash
 * accumulates a little alpha and a lot of colour. `world * (1 - a) + rgb`
 * handles all three correctly. An FXAA-style edge filter runs on the RGBA so
 * the machining, rail teeth and optic ring get the antialiasing TAA used to
 * provide, without any history to smear.
 */
const VIEW_COMPOSITE = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tView;
uniform vec2 uTexel;
uniform vec4 uViewRect;   // x0 y0 x1 y1 in UV, padded by the filter reach
varying vec2 vUv;

vec4 fetchView( vec2 uv ) { return max( texture2D( tView, uv ), vec4( 0.0 ) ); }
// Alpha is part of the edge signal: the silhouette against an empty background
// is a step in coverage, not in luminance.
float edgeLuma( vec4 c ) { return owLum( c.rgb ) + c.a; }

void main() {
  vec3 world = texture2D( tColor, vUv ).rgb;

  // Outside the weapon this pass is an expensive copy, and skipping it there is
  // provably free rather than approximately free. The viewmodel target is
  // cleared to vec4( 0 ), so on a pixel whose whole five-tap neighbourhood is
  // empty every edgeLuma is 0, lmax - lmin is 0, the edge test cannot fire, v
  // stays at the centre tap, alpha is 0, and the last line below already
  // reduces to plain world. This returns the same bits, not a similar colour.
  //
  // It also means the rectangle only has to clear the DIAGONAL taps by its
  // reach: the +/-3 texel arm further down is inside the branch, and the branch
  // cannot be entered from a neighbourhood that is empty. One texel of taps plus
  // one of coverage quantisation is 2, and _viewScreenRect pads by 6.
  //
  // Worth 6.86 M fetches per frame at 2268x1473 averaged over the walk/fire/
  // ADS/reload/melee/swap script, and 9.02 M on the frame cod fill prices, which
  // sits near the script's median. The rectangle covers 0.5895 of the screen on
  // average against a measured ceiling -- the exact near-clipped footprint of
  // every triangle the weapon draws -- of 0.4856, so it collects 80% of
  // everything a perfect bound could. The weapon is much bigger on screen than
  // it looks: 45% at the median and 73% at p90, not the 15% it reads as.
  //
  // fillsim.mjs prices this by PARSING the branch below and then calling the
  // shipped _viewScreenRect on the measured frame, so deleting either one moves
  // the model instead of leaving it quoting a rectangle that is gone.
  //
  // THE FIRST VERSION OF THIS WAS DELETED, and the reason is worth keeping. It
  // unioned bounding SPHERES and collapsed to the whole screen on 140 frames of
  // 140, because the buttstock passes through the eye and a sphere touching the
  // near plane has no bounded perspective image. That was read as "no bound
  // exists here"; it was a fact about spheres. The bounding sphere of a rifle
  // has the radius of the rifle's length. See _viewScreenRect in render/index.js
  // for the box that replaced it and for why clipping it stays conservative.
  if ( vUv.x < uViewRect.x || vUv.x > uViewRect.z
    || vUv.y < uViewRect.y || vUv.y > uViewRect.w ) {
    gl_FragColor = vec4( world, 1.0 );
    return;
  }

  vec4 m = fetchView( vUv );
  vec4 nw = fetchView( vUv + vec2( -1.0, -1.0 ) * uTexel );
  vec4 ne = fetchView( vUv + vec2(  1.0, -1.0 ) * uTexel );
  vec4 sw = fetchView( vUv + vec2( -1.0,  1.0 ) * uTexel );
  vec4 se = fetchView( vUv + vec2(  1.0,  1.0 ) * uTexel );

  float lm = edgeLuma( m );
  float lnw = edgeLuma( nw );
  float lne = edgeLuma( ne );
  float lsw = edgeLuma( sw );
  float lse = edgeLuma( se );
  float lmin = min( lm, min( min( lnw, lne ), min( lsw, lse ) ) );
  float lmax = max( lm, max( max( lnw, lne ), max( lsw, lse ) ) );

  vec4 v = m;
  if ( lmax - lmin >= max( 0.045, lmax * 0.11 ) ) {
    vec2 dir = vec2(
      -( ( lnw + lne ) - ( lsw + lse ) ),
        ( ( lnw + lsw ) - ( lne + lse ) ) );
    float dirReduce = max( ( lnw + lne + lsw + lse ) * 0.03125, 0.0078125 );
    float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
    dir = clamp( dir * rcpDirMin, -6.0, 6.0 ) * uTexel;

    vec4 a = 0.5 * (
      fetchView( vUv + dir * ( 1.0 / 3.0 - 0.5 ) ) +
      fetchView( vUv + dir * ( 2.0 / 3.0 - 0.5 ) ) );
    vec4 b = a * 0.5 + 0.25 * (
      fetchView( vUv - dir * 0.5 ) + fetchView( vUv + dir * 0.5 ) );
    float lb = edgeLuma( b );
    v = ( lb < lmin || lb > lmax ) ? a : b;
  }

  float alpha = clamp( v.a, 0.0, 1.0 );
  gl_FragColor = vec4( world * ( 1.0 - alpha ) + v.rgb, 1.0 );
}
`;

export function createViewComposite() {
  return new Pass('ow-view-composite', VIEW_COMPOSITE, {
    tColor: { value: null },
    tView: { value: null },
    uTexel: { value: new THREE.Vector2() },
    // Whole screen until the first frame sets it, so a preset or a code path
    // that never calls _viewScreenRect degrades to the old unconditional pass
    // rather than to an invisible weapon.
    uViewRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  });
}

const DEBUG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform int uMode;
varying vec2 vUv;
void main() {
  vec4 s = texture2D( tSrc, vUv );
  vec3 c;
  if ( uMode == 0 ) c = vec3( s.r );                       // scalar (AO, shadow)
  else if ( uMode == 1 ) c = owDecodeNormal( s.xy ) * 0.5 + 0.5;
  else if ( uMode == 2 ) c = vec3( abs( s.rg ) * 40.0, 0.0 ); // velocity
  else if ( uMode == 3 ) c = vec3( fract( s.r * 0.05 ) );  // linear depth
  else if ( uMode == 4 ) c = s.rgb;                        // raw colour
  else c = vec3( s.a );                                    // confidence
  gl_FragColor = vec4( owLinearToSrgb( clamp( c, 0.0, 1.0 ) ), 1.0 );
}
`;

export function createDebug() {
  return new Pass('ow-debug', DEBUG, {
    tSrc: { value: null },
    uMode: { value: 0 },
  });
}

/**
 * How hard to run the edge-directed reconstruction, given how far the frame is
 * being stretched.
 *
 * `cod upsim --mode=kappa` swept the strength at seven render scales against a
 * supersampled reference. The optimum drifts only gently with the stretch —
 * ~0.5 at 1.05x, ~0.7 at 1.11x, ~1.0 at 1.39x, ~1.3 at 1.54x — and the curve is
 * so flat near its peak that every one of those points scores within 0.0004 SSIM
 * of the best under a single constant. So this is not a ramp with a slope, it is
 * a switch with a soft edge: off at native, fully on once the stretch is past
 * about 12%.
 *
 * It has to be exactly 0 at native. The filter undoes a bilinear tent, and at
 * 1:1 there is no tent to undo — `texture2D` lands on texel centres and returns
 * the texel. Anything above 0 there is a sharpen nobody asked for, on top of the
 * contrast-adaptive one this pass already runs.
 *
 * `adaptiveResolution` moves renderScale at runtime and resize() re-runs this,
 * so the filter fades in as the scaler drops rather than popping on.
 */
export function reconStrength(displayWidth, internalWidth) {
  if (!(internalWidth > 0) || !(displayWidth > internalWidth)) return 0;
  const t = Math.min(1, Math.max(0, (displayWidth / internalWidth - 1.0) / 0.12));
  return t * t * (3 - 2 * t);
}

export function createComposite(lut) {
  return new Pass('ow-composite', COMPOSITE, {
    tColor: { value: null },
    tBloom: { value: null },
    tExposure: { value: null },
    tLut: { value: lut.texture },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2() },
    uRecon: { value: 0 },
    uLens: { value: new THREE.Vector4(0.0016, 0.24, 0.010, 0) },
    uGrade: { value: new THREE.Vector4(0.05, 0.85, 0.22, lut.size) },
    // slope / power / saturation of the AgX look, applied to the LOG-NORMALISED
    // value. minEv..maxEv spans 16.5 stops, so power > 1 costs whole stops in
    // the shadows (1.35 lost ~1.8) — the contrast belongs in the LUT, which
    // works about a pivot instead of about zero.
    //
    // SLOPE IS 1.0 AND MUST STAY THERE. It multiplies the *normalised log*
    // value, so 1.05 is not "5% brighter", it is +0.5 EV applied to the whole
    // image at the point where AgX has already decided where mid-grey goes.
    // Together with a contrast pivot below mid-grey it is what put 18% scene
    // grey on code value 153.
    uLook: { value: new THREE.Vector4(1.0, 1.0, 1.08, 1) },
  }, { vertexShader: COMPOSITE_VERT });
}

export function createFxaa() {
  return new Pass('ow-fxaa', FXAA, {
    tColor: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}

/**
 * A closed-form second opinion on the TAA off-screen band that fillsim measures.
 *
 * WHY A SECOND OPINION AT ALL
 *   The band came out at 2.31 % of the frame against a 1.5 % assumption, and a
 *   simulation disagreeing with a guess is not evidence -- the simulation could
 *   simply be wrong. But this particular quantity has an exact answer that shares
 *   nothing with the simulation: no rasteriser, no depth buffer, no coverage
 *   mask, no reprojection loop. For a camera that only ROTATES, the band is pure
 *   projective geometry.
 *
 * THE GEOMETRY
 *   A pixel's horizontal UV is u = 0.5 + 0.5 * tan(theta) / tan(hFov/2), where
 *   theta is its angle off the axis. Rotating the camera by dTheta slides every
 *   pixel by
 *
 *       du/dTheta = 0.5 * sec^2(theta) / tan(hFov/2)
 *
 *   and the band is the set of pixels pushed past an edge, i.e. the strip whose
 *   width in u is that derivative EVALUATED AT THE EDGE, because that is where
 *   the pixels leaving the frame come from.
 *
 *   The sec^2 is the whole reason the 1.5 % assumption was low. At the centre of
 *   an 83 deg horizontal field a radian of yaw moves a pixel by 0.57 in u; at the
 *   edge it moves it by 1.01, a factor of 1.8. A small-angle estimate that
 *   divides the turn by the field of view is measuring the centre of the frame
 *   and reporting it as the edge.
 *
 * WHAT THIS DOES NOT COVER
 *   Translation. Parallax makes the band depth-dependent and there is no
 *   closed form; this run is a near-pure rotation (0.0001 m/frame) which is why
 *   the comparison is legitimate here and would not be under --move.
 */
import * as THREE from 'three';
import { boot, run } from './harness.mjs';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}).filter(Boolean));

const quiet = () => {
  const o = console.log, w = console.warn, e = console.error;
  console.log = console.warn = console.error = () => {};
  return () => { console.log = o; console.warn = w; console.error = e; };
};

const restore = quiet();
const { engine, rec } = await boot({ quality: 'ultra' });
const render = engine.ctx.peek('render');

// Same snapshot discipline as everywhere else: _prevVP is overwritten at the end
// of the frame, so the pair is read while the pass still holds it.
let snap = null;
const taa = render?.taa;
const orig = taa?.render?.bind(taa);
let prevQuat = null, prevPos = null;
if (taa) {
  taa.render = (renderer, colorTexture, gbuffer, invVP, prevVP) => {
    const cam = engine.camera;
    snap = {
      turnDeg: prevQuat ? (cam.quaternion.angleTo(prevQuat) * 180) / Math.PI : 0,
      moveM: prevPos ? cam.position.distanceTo(prevPos) : 0,
      // Yaw and pitch separately: the band has a horizontal and a vertical strip
      // and they are governed by different fields of view.
      quat: cam.quaternion.clone(), prevQuat: prevQuat?.clone() ?? null,
    };
    prevQuat = cam.quaternion.clone(); prevPos = cam.position.clone();
    return orig(renderer, colorTexture, gbuffer, invVP, prevVP);
  };
}

const frames = Number(argv.at ?? 90);
const look = Number(argv.look ?? 1);
// cod.mjs's driveLook, reproduced rather than imported -- importing cod.mjs runs
// its main. Same injection point, same single driven frame: raw pointer pixels on
// the LAST frame only, so the camera position and the whole scene are identical
// to an undriven run and only the one frame-to-frame delta differs.
//
// YAW ONLY. Any pitch this reports therefore comes from the game itself -- sway,
// bob, recoil settling -- and not from the drive, which is worth knowing, because
// the vertical strip of the band is entirely the game's doing.
const input = engine.input;
const px = (look * Math.PI) / 180 / (input?.config?.sensitivity || 0.0022);
const origStep = engine.step.bind(engine);
let stepI = 0;
if (look) {
  engine.step = (t) => {
    if (stepI++ === frames - 1) input._rawLook.x += px;
    return origStep(t);
  };
}
run(engine, rec, { frames, warm: 0 });
engine.step = origStep;
if (taa) taa.render = orig;
restore();

const cam = engine.camera;
const vFov = (cam.fov * Math.PI) / 180;
const tanY = Math.tan(vFov / 2);
const tanX = tanY * cam.aspect;
const hFov = 2 * Math.atan(tanX);

// Decompose the frame-to-frame rotation into yaw and pitch. The yaw keeps its
// SIGN: the band sits on the edge the camera turns away from, and the formulas
// below place it there rather than assuming a side.
let yawRad = 0, pitchRad = 0, yawSigned = 0;
if (snap?.prevQuat) {
  const e0 = new THREE.Euler().setFromQuaternion(snap.prevQuat, 'YXZ');
  const e1 = new THREE.Euler().setFromQuaternion(snap.quat, 'YXZ');
  yawSigned = e1.y - e0.y;
  yawRad = Math.abs(yawSigned);
  pitchRad = Math.abs(e1.x - e0.x);
}

// ---- the exact map, for a camera that only yaws --------------------------
//
// A pixel is a view ray ( X, Y, -1 ) with X = ndcX * tanX and Y = ndcY * tanY.
// Yawing the camera by theta carries it to
//
//     x' = X cos - sin        y' = Y        -z' = X sin + cos
//
// and dividing through gives the two things this needs:
//
//     ndcX' = ( X cos - sin ) / ( ( X sin + cos ) tanX )       depends on X only
//     v' - 0.5 = ( v - 0.5 ) / ( X sin + cos )                 depends on X only
//
// THE SECOND LINE IS THE ONE THE FIRST ESTIMATE MISSED, and it is why the band
// has a vertical part at all under a rotation with no pitch in it. Yaw does not
// slide pixels horizontally along their own row: it makes the ray more oblique on
// the side it turns away from, `-z'` shrinks there, and everything in that half
// of the frame is magnified AWAY from the horizon line. The corners go over the
// top and bottom edges. A separable "yaw fills the side strip, pitch fills the
// top strip" model has no term for it and reports zero.
//
// Column X therefore loses the fraction  max( 0, 1 - X sin - cos )  of its height
// through the top and bottom together, and loses ALL of it if ndcX' leaves
// [-1,1]. Integrating that over the columns is a one-dimensional quadrature and
// shares nothing with fillsim's per-pixel loop.
const sin = Math.sin(yawSigned), cos = Math.cos(yawSigned);
const COLS = 400000;
let bandH = 0, bandV = 0, bandAll = 0;
for (let k = 0; k < COLS; k++) {
  const ndcX = ((k + 0.5) / COLS) * 2 - 1;
  const X = ndcX * tanX;
  const denom = X * sin + cos;
  const ndcXp = (X * cos - sin) / (denom * tanX);
  const leavesSide = ndcXp < -1 || ndcXp > 1;
  const vFrac = Math.max(0, Math.min(1, 1 - denom));
  if (leavesSide) { bandH += 1; bandAll += 1; } else { bandV += vFrac; bandAll += vFrac; }
}
bandH /= COLS; bandV /= COLS; bandAll /= COLS;

// What the first estimate said, kept so the size of its error is visible rather
// than quietly corrected: du per radian at the edge of the field, times the turn.
const edgeGainX = 0.5 * (1 + tanX * tanX) / tanX;

console.log(JSON.stringify({
  camera: {
    vFovDeg: +cam.fov.toFixed(2), hFovDeg: +((hFov * 180) / Math.PI).toFixed(2),
    aspect: +cam.aspect.toFixed(4),
  },
  measuredRotation: {
    totalDeg: +(snap?.turnDeg ?? 0).toFixed(4),
    yawDeg: +((yawRad * 180) / Math.PI).toFixed(4),
    pitchDeg: +((pitchRad * 180) / Math.PI).toFixed(4),
    movedM: +(snap?.moveM ?? 0).toFixed(5),
    note: 'driveLook injects YAW only. Any pitch here is the game -- sway, bob, recoil -- and '
      + 'the formulas below assume it is negligible.',
  },
  perspectiveGain: {
    note: 'du per radian of yaw, at the CENTRE of the frame and at its EDGE. The ratio is '
      + 'why an estimate that divides the turn by the field of view is measuring the middle '
      + 'of the frame and reporting it as the edge.',
    centreX: +(0.5 / tanX).toFixed(4), edgeX: +edgeGainX.toFixed(4),
    ratioX: +(edgeGainX / (0.5 / tanX)).toFixed(3),
  },
  closedFormBandPct: {
    horizontal: +(100 * bandH).toFixed(3),
    verticalFromYawAlone: +(100 * bandV).toFixed(3),
    total: +(100 * bandAll).toFixed(3),
  },
  naiveEstimatePct: {
    note: 'Two ways of getting it wrong, for scale. The first divides the turn by the field '
      + 'of view, which is the centre-of-frame gain. The second uses the edge gain but has no '
      + 'term for the vertical strip yaw alone produces.',
    turnOverFieldOfView: +(100 * ((yawRad * 180) / Math.PI) / ((hFov * 180) / Math.PI)).toFixed(3),
    edgeGainNoVerticalTerm: +(100 * edgeGainX * yawRad).toFixed(3),
  },
  note: 'Compare against fillcost --look=1 taaOffScreen. This shares no code with it: no '
    + 'raster, no depth, no coverage, no velocity buffer, no reprojection through the engine '
    + 'matrices -- only the field of view and the frame-to-frame yaw. Valid only for a '
    + 'near-stationary camera; parallax has no closed form and --move would invalidate it.',
}, null, 2));
process.exit(0);

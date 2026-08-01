/**
 * _probe-nowall — throwaway. Two questions.
 *
 * 1. The sidestep in `_move` only fires when the controller reported a wall LAST
 *    frame. How many remaining stall frames have no wall at all, and how long do
 *    those streaks run? (First run: 269 of 781 eligible, longest 0.58 s, all in
 *    `combat`, median distance-to-waypoint 0.09 m at speed 0.)
 *
 * 2. Follow-up on that 0.09 m. `_combat` measures the peek shuffle as
 *    `position.distanceTo(stancePos)` — THREE dimensions — while `_move`'s
 *    arrival test drops Y (`to.y = 0`). If a stance sits above or below the
 *    man's feet, `_move` arrives every frame and `_combat` re-orders every
 *    frame. This measures both distances side by side.
 *
 * Samples exactly what the sidestep branch sees, by wrapping `_move`: the
 * `touchingWall` flag is read BEFORE the original runs, because `c.move()` at
 * the bottom of `_move` overwrites it, and `stallTimer`/`sidestepping` after,
 * because both are written inside.
 */
import { boot } from './harness.mjs';
import { play, engagePlay } from './play.mjs';

const FPS = 60;
const RUN = Math.round(40 * FPS);

const { engine, rec } = await boot({ quality: 'low', deterministic: true, width: 960, height: 600, dpr: 1 });
engagePlay(engine, { populate: true });
const ai = engine.ctx.peek('ai');

let eligible = 0, withWall = 0, fired = 0, noWp = 0, noWallWithWp = 0, aliveFrames = 0;
let steep = 0, blocked = 0, crowded = 0, airborne = 0;
// question 2
let arrivedHoriz = 0, stillFarIn3D = 0, reorderedThisFrame = 0;

const run = new Map();
const worst = new Map();
let longest = 0;
const byState = {};
const rows = [];

for (const a of ai.agents) {
  // Flag the peek shuffle at its source: `_setPath1(dest, 0.1)` is the shuffle
  // and only the shuffle — `_goTo` passes 0.45.
  const sp = a._setPath1.bind(a);
  a._setPath1 = (dest, eps) => { if (eps === 0.1) a.__shuffle = true; return sp(dest, eps); };

  const orig = a._move.bind(a);
  a._move = (dt) => {
    const con = a.controller;
    const wallBefore = !!con?.touchingWall;
    const steepBefore = !!con?.onSteepSlope;
    const blockedBefore = !!con?.lastMoveBlocked;
    const groundedBefore = !!con?.grounded;
    const hadWp = !!(a.hasMoveTarget && a.pathIndex < a.pathLen);
    const wp = hadWp ? a.path[a.pathIndex] : null;
    const dWp = hadWp ? Math.hypot(wp.x - a.position.x, wp.z - a.position.z) : -1;
    const wasShuffle = a.__shuffle;
    a.__shuffle = false;

    // The two distances that disagree.
    const sPos = a.stancePos;
    const d3 = sPos ? a.position.distanceTo(sPos) : -1;
    const d2 = sPos ? Math.hypot(sPos.x - a.position.x, sPos.z - a.position.z) : -1;
    const dy = sPos ? Math.abs(sPos.y - a.position.y) : -1;

    let near = Infinity, inSep = false;
    for (const o of ai.agents) {
      if (o === a || !o.alive) continue;
      const d = Math.hypot(a.position.x - o.position.x, a.position.z - o.position.z);
      if (d < near) near = d;
      if (d < a.radius + o.radius + 0.42) inSep = true;
    }

    orig(dt);
    if (!a.alive) { run.set(a.id, 0); return; }
    aliveFrames++;

    if (!(a.stallTimer > 0.25)) { run.set(a.id, 0); return; }
    eligible++;
    if (wallBefore) withWall++;
    if (a.sidestepping) fired++;
    if (!hadWp) noWp++;
    if (wallBefore || !hadWp) { run.set(a.id, 0); return; }

    noWallWithWp++;
    byState[a.state] = (byState[a.state] ?? 0) + 1;
    if (steepBefore) steep++;
    if (blockedBefore) blocked++;
    if (inSep) crowded++;
    if (!groundedBefore) airborne++;
    if (wasShuffle) reorderedThisFrame++;
    // "arrived" as `_move` judges it: horizontally inside the epsilon it was given
    if (d2 >= 0 && d2 < a.arriveEps) arrivedHoriz++;
    // "not arrived" as `_combat` judges it
    if (d3 > 0.12) stillFarIn3D++;

    const r = (run.get(a.id) ?? 0) + 1;
    run.set(a.id, r);
    if (r > longest) longest = r;
    const w = worst.get(a.id);
    if (!w || r > w.frames) worst.set(a.id, { frames: r, state: a.state, d2: +d2.toFixed(3), dy: +dy.toFixed(3) });

    if (rows.length < 12000) {
      rows.push({
        progress: a.progress, speed: a.speed, want: a.desiredSpeed, eps: a.arriveEps,
        dWp: +dWp.toFixed(3), d3: +d3.toFixed(3), d2: +d2.toFixed(3), dy: +dy.toFixed(3),
        stance: +a.stanceTimer.toFixed(2), near: +near.toFixed(2), shuffle: !!wasShuffle,
      });
    }
  };
}

play(engine, rec, { frames: RUN });

const med = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[s.length >> 1].toFixed(3);
};
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
};

const out = {
  aliveFrames,
  eligibleFrames: eligible,
  withWall, sidestepFired: fired, noWaypoint: noWp,
  NOWALL: noWallWithWp,
  noWallPctOfEligible: eligible ? +(100 * noWallWithWp / eligible).toFixed(1) : 0,
  longestNoWallStallS: +(longest / FPS).toFixed(2),
  perAgentWorst: [...worst.entries()].map(([id, w]) => ({ id, s: +(w.frames / FPS).toFixed(2), ...w })).sort((a, b) => b.s - a.s),
  noWallByState: byState,
  ofNoWall: {
    onSteepSlope: steep, lastMoveBlocked: blocked, insideSeparationRadius: crowded, airborne,
    // question 2 — the disagreement
    shuffleReorderedSameFrame: reorderedThisFrame,
    arrivedHorizontally: arrivedHoriz,
    stillFarIn3D,
    BOTH: rows.filter((r) => r.d2 < r.eps && r.d3 > 0.12).length,
    medHorizToStance: med(rows.map((r) => r.d2)),
    med3DToStance: med(rows.map((r) => r.d3)),
    medYGapToStance: med(rows.map((r) => r.dy)),
    p90YGap: pct(rows.map((r) => r.dy), 0.9),
    medStanceTimer: med(rows.map((r) => r.stance)),
    medProgress: med(rows.map((r) => r.progress)),
    medSpeed: med(rows.map((r) => r.speed)),
    medWant: med(rows.map((r) => r.want)),
    medEps: med(rows.map((r) => r.eps)),
  },
  sample: rows.slice(0, 4),
};

engine.dispose();
console.log('@@' + JSON.stringify(out, null, 1));

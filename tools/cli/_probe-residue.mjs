/**
 * _probe-residue — throwaway. Full accounting of what is LEFT in the travel
 * stall rate, so the next lever is chosen from evidence rather than from the
 * loudest remaining number.
 *
 * Classifies every travel-stall frame into exactly one bucket, in priority
 * order, and reports the streak length of each bucket:
 *
 *   ramp      — inside the first 8 frames of a march order; the speed ease-in
 *               is still spinning up and covering little ground is correct
 *   handled   — a wall is there and the sidestep is steering along it
 *   graze     — a wall is there but the stall is younger than the sidestep's
 *               0.25 s trigger
 *   crowd     — no wall, but a squadmate is inside the separation radius
 *   residue   — none of the above: unexplained, and the only bucket that is a
 *               defect
 */
import { boot } from './harness.mjs';
import { play, engagePlay } from './play.mjs';

const FPS = 60;
const RUN = Math.round(40 * FPS);

const { engine, rec } = await boot({ quality: 'low', deterministic: true, width: 960, height: 600, dpr: 1 });
engagePlay(engine, { populate: true });
const ai = engine.ctx.peek('ai');

let travel = 0, stalls = 0;
const bucket = { ramp: 0, handled: 0, graze: 0, crowd: 0, residue: 0 };
const longest = { ramp: 0, handled: 0, graze: 0, crowd: 0, residue: 0 };
const run = new Map();       // id -> { bucket, n }
const age = new Map();       // id -> consecutive travel frames (march-order age)
const residueRows = [];
const residueByState = {};

for (const a of ai.agents) {
  const sp = a._setPath1.bind(a);
  a._setPath1 = (dest, eps) => { if (eps === 0.1) a.__shuffle = true; return sp(dest, eps); };

  const orig = a._move.bind(a);
  a._move = (dt) => {
    const con = a.controller;
    const wall = !!con?.touchingWall;
    let near = Infinity;
    for (const o of ai.agents) {
      if (o === a || !o.alive) continue;
      const d = Math.hypot(a.position.x - o.position.x, a.position.z - o.position.z);
      if (d < near) near = d;
    }
    const inSep = near < a.radius * 2 + 0.42;
    const wasShuffle = a.__shuffle;
    a.__shuffle = false;

    orig(dt);
    if (!a.alive) { age.set(a.id, 0); run.set(a.id, null); return; }

    // Same travel population the gate uses, and the shuffle is excluded there
    // too — a 0.6 m walk is too short for a ratio test to mean anything.
    if (wasShuffle || !(a.desiredSpeed > 0.2 && a.hasMoveTarget && !a.pathPending)) {
      age.set(a.id, 0); run.set(a.id, null); return;
    }
    const ag = (age.get(a.id) ?? 0) + 1;
    age.set(a.id, ag);
    travel++;

    const got = a.progress ?? 0;
    if (!(got < Math.max(0.25, a.desiredSpeed * 0.25))) { run.set(a.id, null); return; }
    stalls++;

    let b;
    if (ag <= 8) b = 'ramp';
    else if (wall && a.sidestepping) b = 'handled';
    else if (wall) b = 'graze';
    else if (inSep) b = 'crowd';
    else b = 'residue';
    bucket[b]++;

    const cur = run.get(a.id);
    const n = cur && cur.bucket === b ? cur.n + 1 : 1;
    run.set(a.id, { bucket: b, n });
    if (n > longest[b]) longest[b] = n;

    if (b === 'residue') {
      residueByState[a.state] = (residueByState[a.state] ?? 0) + 1;
      if (residueRows.length < 4000) {
        residueRows.push({
          id: a.id, state: a.state, age: ag, stall: +a.stallTimer.toFixed(2),
          progress: +got.toFixed(3), speed: +a.speed.toFixed(2), want: a.desiredSpeed,
          near: +near.toFixed(2), blocked: !!con?.lastMoveBlocked, grounded: !!con?.grounded,
          dWp: a.pathIndex < a.pathLen
            ? +Math.hypot(a.path[a.pathIndex].x - a.position.x, a.path[a.pathIndex].z - a.position.z).toFixed(2)
            : -1,
        });
      }
    }
  };
}

play(engine, rec, { frames: RUN });

const med = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return +s[s.length >> 1].toFixed(2);
};
const pctOf = (n) => (stalls ? +(100 * n / stalls).toFixed(1) : 0);

const out = {
  travelFrames: travel,
  stallFrames: stalls,
  stallPct: travel ? +(100 * stalls / travel).toFixed(1) : 0,
  buckets: bucket,
  bucketPctOfStalls: {
    ramp: pctOf(bucket.ramp), handled: pctOf(bucket.handled), graze: pctOf(bucket.graze),
    crowd: pctOf(bucket.crowd), residue: pctOf(bucket.residue),
  },
  longestStreakS: Object.fromEntries(Object.entries(longest).map(([k, v]) => [k, +(v / FPS).toFixed(2)])),
  residueByState,
  residueProfile: {
    medAge: med(residueRows.map((r) => r.age)),
    medStallTimer: med(residueRows.map((r) => r.stall)),
    medProgress: med(residueRows.map((r) => r.progress)),
    medSpeed: med(residueRows.map((r) => r.speed)),
    medWant: med(residueRows.map((r) => r.want)),
    medNearestMate: med(residueRows.map((r) => r.near)),
    medDistToWaypoint: med(residueRows.map((r) => r.dWp)),
    blocked: residueRows.filter((r) => r.blocked).length,
    airborne: residueRows.filter((r) => !r.grounded).length,
    ofRows: residueRows.length,
  },
  residueSample: residueRows.slice(0, 6),
};

engine.dispose();
console.log('@@' + JSON.stringify(out, null, 1));

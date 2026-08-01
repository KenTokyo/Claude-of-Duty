/**
 * _probe-route — throwaway. The no-wall stall class is gone; one man still hits
 * the 1.38 s watchdog ceiling. The watchdog's cure is to THROW THE ROUTE AWAY,
 * and the standing suspicion is that A* hands the same one straight back.
 *
 * Measures, per watchdog fire: the destination that was dropped, the next
 * destination the man was given, the gap between them, and how long he went
 * without one. A re-issue inside a metre of the dropped destination is the same
 * order under a new name.
 */
import { boot } from './harness.mjs';
import { play, engagePlay } from './play.mjs';

const FPS = 60;
const RUN = Math.round(40 * FPS);

const { engine, rec } = await boot({ quality: 'low', deterministic: true, width: 960, height: 600, dpr: 1 });
engagePlay(engine, { populate: true });
const ai = engine.ctx.peek('ai');

let frame = 0;
let fires = 0;
const pending = new Map();   // id -> { x, z, frame, state }
const reissues = [];
const noReissue = new Map(); // id -> count of fires never followed by a target
const firesByState = {};
const firesById = {};
/** consecutive fires on the same destination, per agent */
const chain = new Map();
let worstChain = 0;
const chainDetail = [];

for (const a of ai.agents) {
  const orig = a._move.bind(a);
  a._move = (dt) => {
    const st0 = a.stallTimer;
    const had = a.hasMoveTarget;
    const dx = a.moveTarget.x, dz = a.moveTarget.z;
    const st = a.state;

    orig(dt);
    if (!a.alive) return;

    // The watchdog reset, recognised by its own footprint: it zeroes the timer,
    // clears the target and spends the path, all in one frame.
    if (had && st0 > 1.3 && a.stallTimer === 0 && !a.hasMoveTarget && a.pathIndex >= a.pathLen) {
      fires++;
      firesByState[st] = (firesByState[st] ?? 0) + 1;
      firesById[a.id] = (firesById[a.id] ?? 0) + 1;
      pending.set(a.id, { x: dx, z: dz, frame, state: st });
      return;
    }

    // First order after a fire.
    const p = pending.get(a.id);
    if (p && a.hasMoveTarget) {
      pending.delete(a.id);
      const gap = Math.hypot(a.moveTarget.x - p.x, a.moveTarget.z - p.z);
      const same = gap < 1.0;
      reissues.push({ id: a.id, gap: +gap.toFixed(2), waitFrames: frame - p.frame, same, state: p.state });
      const c = same ? (chain.get(a.id) ?? 0) + 1 : 0;
      chain.set(a.id, c);
      if (c > worstChain) { worstChain = c; }
      if (same) chainDetail.push({ id: a.id, run: c, at: frame, gap: +gap.toFixed(2) });
    }
  };
}

play(engine, rec, {
  frames: RUN,
  onFrame: () => { frame++; },
});

for (const [id] of pending) noReissue.set(id, (noReissue.get(id) ?? 0) + 1);

const med = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[s.length >> 1].toFixed(2);
};
const same = reissues.filter((r) => r.same);

const out = {
  watchdogFires: fires,
  firesByState,
  firesById,
  reissuesSeen: reissues.length,
  neverReissued: [...noReissue.entries()],
  SAME_DESTINATION: same.length,
  samePctOfReissues: reissues.length ? +(100 * same.length / reissues.length).toFixed(1) : 0,
  medGapM: med(reissues.map((r) => r.gap)),
  medGapWhenSame: med(same.map((r) => r.gap)),
  medWaitFrames: med(reissues.map((r) => r.waitFrames)),
  longestSameChain: worstChain,
  chainDetail: chainDetail.slice(0, 20),
  reissues: reissues.slice(0, 25),
};

engine.dispose();
console.log('@@' + JSON.stringify(out, null, 1));

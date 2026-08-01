/**
 * playtests — the gameplay scenarios `cod play` runs.
 *
 * Each scenario boots the real engine, plays a scripted input timeline through
 * the real Input handlers and returns `{ name, pass, ... }` with the evidence
 * that decided it. A scenario never prints; the command formats.
 *
 * These are assertions about FEEL, not about pixels: a crouch that reports the
 * stance but stops the player moving is a failure here even though every frame
 * still renders. That is exactly the class of bug this file exists to catch.
 */

import { boot } from './harness.mjs';
import { play, engagePlay, BROWSER_SHORTCUTS, makeDriver, travelled } from './play.mjs';
import { ACTIONS } from '../../src/core/input.js';

const FPS = 60;
const sec = (s) => Math.round(s * FPS);

/** Hold `codes` from frame `from` to frame `to`. */
function hold(codes, from, to) {
  const t = {};
  for (const c of [].concat(codes)) {
    t[from] = t[from] ?? [];
    t[to] = t[to] ?? [];
  }
  return { codes: [].concat(codes), from, to };
}

/** Build a timeline function from a list of hold() specs. */
function timelineOf(holds) {
  return (drv, engine, i) => {
    for (const h of holds) {
      if (i === h.from) for (const c of h.codes) drv.down(c);
      if (i === h.to) for (const c of h.codes) drv.up(c);
    }
  };
}

async function bootPlay(opts = {}) {
  const { engine, rec } = await boot({ quality: 'low', deterministic: true, width: 960, height: 600, dpr: 1 });
  engagePlay(engine, opts);
  return { engine, rec };
}

/* ====================================================================== */
/* 1. crouch                                                              */
/* ====================================================================== */

/**
 * Ducking has to work while you are moving, on both bound keys, and it has to
 * let go again. The interesting half is Ctrl: it is a browser modifier, so a
 * crouch-and-strafe sends `ctrlKey: true` on the D keydown.
 */
export async function scenarioCrouch() {
  const { engine, rec } = await bootPlay();
  const holds = [
    hold('KeyW', sec(0.2), sec(6.0)),        // walk the whole time
    hold('ControlLeft', sec(1.0), sec(2.5)), // hold-crouch
    hold('KeyD', sec(1.4), sec(2.2)),        // strafe WHILE crouched (Ctrl+D = bookmark)
    hold('KeyC', sec(3.5), sec(3.6)),        // tap-toggle crouch on
    hold('KeyC', sec(5.0), sec(5.1)),        // tap-toggle crouch off
  ];
  const { samples, keyLog } = play(engine, rec, { frames: sec(6.5), timeline: timelineOf(holds) });

  const win = (a, b) => samples.slice(sec(a), sec(b));
  const crouchedWhileHeld = win(1.3, 2.4).filter((s) => s.stance === 'crouch').length;
  const heldWindow = win(1.3, 2.4).length;
  const standAfterRelease = win(3.0, 3.4).every((s) => s.stance === 'stand');
  const toggledOn = win(4.0, 4.8).filter((s) => s.stance === 'crouch').length;
  const toggledOff = win(5.6, 6.4).every((s) => s.stance === 'stand');

  // Did the player keep moving while crouched with Ctrl held?
  const a = samples[sec(1.5)];
  const b = samples[sec(2.2)];
  const movedWhileCrouched = +Math.hypot(b.x - a.x, b.z - a.z).toFixed(3);

  const dKeys = keyLog.filter((k) => k.code === 'KeyD');
  const ctrlDLost = dKeys.filter((k) => k.ctrl && !k.registered).length;
  const ctrlDUnprevented = dKeys.filter((k) => k.ctrl && !k.prevented).length;

  const pass =
    crouchedWhileHeld > heldWindow * 0.8 &&
    standAfterRelease &&
    toggledOn > 20 &&
    toggledOff &&
    movedWhileCrouched > 0.6 &&
    ctrlDLost === 0 &&
    ctrlDUnprevented === 0;

  engine.dispose();
  return {
    name: 'crouch', pass,
    holdCrouchFrames: `${crouchedWhileHeld}/${heldWindow}`,
    standsUpOnRelease: standAfterRelease,
    tapToggleOnFrames: toggledOn,
    tapToggleOffClean: toggledOff,
    movedWhileCrouchedM: movedWhileCrouched,
    ctrlDKeysLost: ctrlDLost,
    ctrlDBrowserDefaultsNotPrevented: ctrlDUnprevented,
    eyeHeights: [samples[sec(0.9)].eye, samples[sec(2.0)].eye, samples[sec(3.2)].eye],
  };
}

/* ====================================================================== */
/* 2. strafe                                                              */
/* ====================================================================== */

export async function scenarioStrafe() {
  const { engine, rec } = await bootPlay();
  const holds = [
    hold('KeyD', sec(0.2), sec(2.0)),
    hold('KeyA', sec(2.4), sec(4.2)),
    hold(['ShiftLeft', 'KeyW', 'KeyD'], sec(4.6), sec(6.4)),
  ];
  const { samples } = play(engine, rec, { frames: sec(7.0), timeline: timelineOf(holds) });

  const p = engine.ctx.peek('player');
  const yaw = p.movement.yaw;
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const disp = (a, b) => {
    const s0 = samples[sec(a)];
    const s1 = samples[sec(b)];
    return {
      right: +((s1.x - s0.x) * rightX + (s1.z - s0.z) * rightZ).toFixed(2),
      dist: +Math.hypot(s1.x - s0.x, s1.z - s0.z).toFixed(2),
    };
  };
  const rightLeg = disp(0.4, 1.9);
  const leftLeg = disp(2.6, 4.1);
  const peakStrafeSpeed = Math.max(...samples.slice(sec(0.6), sec(1.9)).map((s) => s.speed));
  const diagonal = disp(4.8, 6.3);

  const pass =
    rightLeg.right > 3.5 &&
    leftLeg.right < -3.5 &&
    peakStrafeSpeed > 3.6 &&
    diagonal.dist > 6;

  engine.dispose();
  return {
    name: 'strafe', pass,
    strafeRightM: rightLeg.right, strafeLeftM: leftLeg.right,
    peakStrafeSpeed: +peakStrafeSpeed.toFixed(2),
    sprintDiagonalM: diagonal.dist,
  };
}

/* ====================================================================== */
/* 3. slide                                                               */
/* ====================================================================== */

export async function scenarioSlide() {
  const { engine, rec } = await bootPlay();
  const holds = [
    hold(['KeyW', 'ShiftLeft'], sec(0.2), sec(4.5)),
    hold('ControlLeft', sec(1.6), sec(1.7)),   // slide from a forward sprint
    hold('ControlLeft', sec(3.2), sec(3.3)),   // and again
    hold('Space', sec(3.55), sec(3.62)),       // slide-cancel into a jump
  ];
  const { samples } = play(engine, rec, { frames: sec(5.0), timeline: timelineOf(holds) });

  const slideFrames = samples.filter((s) => s.sliding).length;
  const firstSlide = samples.findIndex((s) => s.sliding);
  const sprintPeak = Math.max(...samples.slice(sec(0.6), sec(1.5)).map((s) => s.speed));
  const slidePeak = Math.max(...samples.filter((s) => s.sliding).map((s) => s.speed), 0);
  const crouchedDuringSlide = samples.filter((s) => s.sliding).every((s) => s.stance === 'crouch');
  const jumpedOut = samples.slice(sec(3.5), sec(4.0)).some((s) => !s.grounded);
  const recovered = samples.slice(sec(4.2), sec(4.9)).some((s) => s.speed > 3);

  const pass =
    slideFrames > 30 &&
    firstSlide > 0 && firstSlide < sec(2.1) &&
    slidePeak > sprintPeak * 1.05 &&
    crouchedDuringSlide &&
    jumpedOut &&
    recovered;

  engine.dispose();
  return {
    name: 'slide', pass,
    slideFrames, firstSlideFrame: firstSlide,
    sprintPeak: +sprintPeak.toFixed(2), slidePeak: +slidePeak.toFixed(2),
    crouchedDuringSlide, slideCancelJumped: jumpedOut, recoveredAfter: recovered,
  };
}

/**
 * The slide entry people actually use and the old code refused: a DIAGONAL
 * sprint. `sprinting` needs the stick within ~56 degrees of dead ahead, so
 * W+D+Shift never set the flag and the crouch key just crouched. The gate is
 * speed now, so this has to produce a slide — and a walk still must not.
 */
export async function scenarioSlideStrafe() {
  const { engine, rec } = await bootPlay();
  const holds = [
    hold(['KeyW', 'KeyD', 'ShiftLeft'], sec(0.2), sec(3.0)),
    hold('ControlLeft', sec(2.0), sec(2.1)),
    // …and a plain walk with the same crouch tap must NOT slide.
    hold('KeyW', sec(4.2), sec(7.0)),
    hold('ControlLeft', sec(6.0), sec(6.1)),
  ];
  const { samples } = play(engine, rec, { frames: sec(7.2), timeline: timelineOf(holds) });

  const diagonalSlide = samples.slice(sec(2.0), sec(3.0)).filter((s) => s.sliding).length;
  const walkSlide = samples.slice(sec(6.0), sec(7.0)).filter((s) => s.sliding).length;
  const walkCrouched = samples.slice(sec(6.3), sec(6.9)).every((s) => s.stance === 'crouch');
  const peak = Math.max(...samples.slice(sec(2.0), sec(3.0)).map((s) => s.speed));

  const pass = diagonalSlide > 25 && walkSlide === 0 && walkCrouched;

  engine.dispose();
  return {
    name: 'slide-strafe', pass,
    diagonalSprintSlideFrames: diagonalSlide,
    diagonalSlidePeak: +peak.toFixed(2),
    walkSlideFrames: walkSlide,
    walkCrouchedInstead: walkCrouched,
  };
}

/* ====================================================================== */
/* 4. death at 0 HP                                                       */
/* ====================================================================== */

export async function scenarioDeath() {
  const { engine, rec } = await bootPlay();
  const player = engine.ctx.peek('player');
  const deaths = [];
  engine.events.on('player:death', (e) => deaths.push({ frame: engine.time.frame, e }));

  let healthAtDeath = null;
  const holds = [hold(['KeyW', 'ShiftLeft'], sec(0.2), sec(9.0))];
  const script = timelineOf(holds);
  const timeline = (drv, eng, i) => {
    script(drv, eng, i);
    // four hits: 30 / 30 / 30 / 30 -> the fourth crosses zero
    if (i === sec(1.0) || i === sec(1.4) || i === sec(1.8) || i === sec(2.2)) {
      player.applyDamage(30, null, { type: 'bullet' });
    }
  };
  const { samples } = play(engine, rec, { frames: sec(9.0), timeline });

  const deathIdx = samples.findIndex((s) => s.dead);
  if (deathIdx >= 0) healthAtDeath = samples[deathIdx].health;
  // The window between the kill and the automatic redeploy. Everything about
  // "the round ended" has to hold across ALL of it.
  const downed = deathIdx >= 0 ? samples.slice(deathIdx + 2, deathIdx + sec(4.5)) : [];
  const stayedDead = downed.length > 0 && downed.every((s) => s.dead);
  const controlOff = downed.length > 0 && downed.every((s) => !s.control);
  const noRegen = downed.every((s) => s.health <= 0.01);
  // Both the reported speed AND the actual displacement: a stale speed reading
  // and a body that is still sliding forward are different bugs.
  const settle = downed.slice(20);
  const drift = settle.length
    ? Math.hypot(
      settle[settle.length - 1].x - settle[0].x,
      settle[settle.length - 1].z - settle[0].z,
    )
    : Infinity;
  const stopped = downed.length > 20 && settle.every((s) => s.speed < 0.35) && drift < 0.1;
  // …and then the player is put back in the fight, whole.
  const revivedIdx = deathIdx >= 0 ? samples.findIndex((s, i) => i > deathIdx && !s.dead) : -1;
  const revivedAfter = revivedIdx > 0 ? +((revivedIdx - deathIdx) / FPS).toFixed(2) : null;
  const revivedClean = revivedIdx > 0 &&
    samples.slice(revivedIdx + 4).every((s) => s.control && s.health > 99);

  const pass =
    deathIdx > 0 && deaths.length === 1 && healthAtDeath === 0 &&
    stayedDead && controlOff && noRegen && stopped && revivedClean;

  engine.dispose();
  return {
    name: 'death', pass,
    deathFrame: deathIdx, deathEvents: deaths.length, healthAtDeath,
    stayedDead, controlDisabled: controlOff, regenBlocked: noRegen, movementStopped: stopped,
    redeployedAfterS: revivedAfter, redeployRestoredControlAndHealth: revivedClean,
  };
}

/* ====================================================================== */
/* 5. regeneration                                                        */
/* ====================================================================== */

export async function scenarioRegen() {
  const { engine, rec } = await bootPlay();
  const player = engine.ctx.peek('player');

  const timeline = (drv, eng, i) => {
    if (i === sec(0.5)) player.applyDamage(24, null, { type: 'bullet' });
    if (i === sec(1.0)) player.applyDamage(24, null, { type: 'bullet' });
    if (i === sec(1.5)) player.applyDamage(22, null, { type: 'bullet' });
    // still under fire at 3.0 s: the regen clock must restart
    if (i === sec(3.0)) player.applyDamage(6, null, { type: 'bullet' });
    // 7.6 s would be the earliest legal restart. Sustained fire cracking past
    // from 7.4 to 8.6 s means we are still in contact and must still not heal.
    // 20 Hz of near misses is one enemy holding us down, not a stray round.
    if (i >= sec(7.4) && i <= sec(8.6) && i % 3 === 0) player.addSuppression(0.28);
  };
  const { samples } = play(engine, rec, { frames: sec(16), timeline });

  const low = Math.min(...samples.map((s) => s.health));
  const startedAt = samples.findIndex((s) => s.regen);
  // The last hit lands at 3.0 s, so nothing may regenerate before ~7.6 s: the
  // delay is measured from the LAST hit, not the first.
  const restarted = samples.slice(sec(3.05), sec(7.4)).every((s) => !s.regen);
  // While rounds are still cracking past (7.4 – 8.6 s) nothing may heal.
  const heldUnderFire = samples.slice(sec(7.5), sec(8.7)).every((s) => !s.regen);
  const full = samples[samples.length - 1].health;
  const fullAt = samples.findIndex((s, i) => i > sec(3) && s.health >= 99.9);

  const pass =
    low <= 30 &&
    startedAt > sec(7.0) &&
    restarted &&
    heldUnderFire &&
    full >= 99.9 &&
    fullAt > sec(8) && fullAt < sec(15);

  engine.dispose();
  return {
    name: 'regen', pass,
    lowestHealth: +low.toFixed(1),
    firstRegenFrame: startedAt,
    regenClockRestartedAfterHit: restarted,
    heldWhileUnderFire: heldUnderFire,
    fullAgainAtFrame: fullAt,
    finalHealth: +full.toFixed(1),
  };
}

/* ====================================================================== */
/* 6. enemies                                                             */
/* ====================================================================== */

/**
 * The enemies exist, wake up, and go somewhere.
 *
 * This is the shallowest AI gate and it stayed shallow too long: `travelled()`
 * sums the per-frame position delta, which is PATH LENGTH, and the bar was
 * "60 % of them beat 2 metres in 20 seconds". Two men jostling in a doorway
 * clear that in six seconds without either of them going anywhere — the
 * separation push in `_move` moves them both, every frame, in opposite
 * directions. Path length cannot tell walking from vibrating.
 *
 * Net displacement can. `reachedM` is the furthest a man ever got from where he
 * spawned, so a jitterer scores near zero however long he jitters, and
 * `straightness` is that over his path length: 1.0 is a man who walked a
 * straight line, and the jostling case is a few hundredths.
 *
 * The travel-stall claim from `ai-move` is mirrored here rather than assumed,
 * because this scenario runs the FIRST 20 seconds — the wake-up, the first
 * bound out of patrol, the first cover claim — and `ai-move` starts its window
 * at the same place but reads it over twice as long. A stall in the opening
 * seconds is a man who never joins the fight at all.
 */
export async function scenarioAi(frames = sec(20)) {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  const spawned = ai?.agents.length ?? 0;

  // Where each man started, and the furthest he ever got from it. Furthest-ever
  // and not final: a man who bounds to a flank and comes back has been
  // somewhere, and end-to-end displacement would score him a zero.
  const home = new Map();
  const reach = new Map();
  const stallRun = new Map();
  let longestStall = 0;
  const onFrame = () => {
    for (const a of ai?.agents ?? []) {
      if (!a.alive) { stallRun.set(a.id, 0); continue; }
      let h = home.get(a.id);
      if (!h) { h = { x: a.position.x, z: a.position.z }; home.set(a.id, h); }
      const d = Math.hypot(a.position.x - h.x, a.position.z - h.z);
      if (d > (reach.get(a.id) ?? 0)) reach.set(a.id, d);
      // same test as `ai-move` and as the watchdog in `_move`: somewhere to be,
      // a route to it, and no ground covered
      const trying = a.desiredSpeed > 0.2 && a.hasMoveTarget && !a.pathPending;
      const r = trying && (a.progress ?? 0) < Math.max(0.25, a.desiredSpeed * 0.25)
        ? (stallRun.get(a.id) ?? 0) + 1 : 0;
      stallRun.set(a.id, r);
      if (r > longestStall) longestStall = r;
    }
  };

  const { aiSamples } = play(engine, rec, { frames, trackAi: true, onFrame });
  const ids = spawned ? ai.agents.map((a) => a.id) : [];
  const dist = ids.map((id) => travelled(aiSamples, id));
  const reached = ids.map((id) => +(reach.get(id) ?? 0).toFixed(2));
  const straight = ids.map((id, i) => +(dist[i] > 0.01 ? reached[i] / dist[i] : 0).toFixed(3));
  const moved = dist.filter((d) => d > 2.0).length;
  const wentSomewhere = reached.filter((d) => d > 4).length;
  const last = aiSamples[aiSamples.length - 1] ?? [];
  const states = {};
  for (const a of last) states[a.state] = (states[a.state] ?? 0) + 1;
  const anyRun = aiSamples.some((f) => f.some((a) => a.speed > 1.0));
  const stallS = +(longestStall / FPS).toFixed(2);

  const pass =
    spawned >= 4 && anyRun &&
    // the old claim, kept: path length still has to be there
    moved >= Math.ceil(spawned * 0.6) &&
    // MEASURED all six of them past 4 m of net reach, the worst at 6.67 and the
    // best at 27.47, against path lengths of 16.7 to 43.6 — `straightness` of
    // 0.40 to 0.94. 4 m is a room of this level and well under the worst
    // reading; a man being shoved around a doorway peaks near 1 m however long
    // he is shoved, and his path length keeps climbing the whole time.
    //
    // A GUARD, not evidence: no revert measured for this file moves it (the
    // watchdog revert below leaves all six past 9 m, because a man wedged for
    // three seconds still walks for the other seventeen). It is here because it
    // is the only claim in this scenario that fails on a build where the
    // enemies vibrate in place, which is what the 2 m path-length bar it
    // replaced would have passed.
    wentSomewhere >= Math.ceil(spawned * 0.6) &&
    // MEASURED 1.40 s. Reverting the watchdog in `_move` to watch `speed`
    // instead of `progress` reads 3.57 s in this same 20 s window — shorter
    // than the 7.35 s it reaches over 40 s in `ai-move`, which is the whole
    // reason that scenario runs twice as long.
    stallS < 2.5;

  engine.dispose();
  return {
    name: 'ai-movement', pass,
    spawned, agentsThatMoved: moved, agentsThatWentSomewhere: wentSomewhere,
    travelledM: dist,
    reachedM: reached,
    straightness: straight,
    longestTravelStallS: stallS,
    reachedWalkSpeed: anyRun,
    finalStates: states,
  };
}

/* ====================================================================== */
/* 7. enemy death                                                         */
/* ====================================================================== */

export async function scenarioAiDeath() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  if (!ai?.agents.length) {
    engine.dispose();
    return { name: 'ai-death', pass: false, reason: 'no enemies spawned' };
  }
  const victim = ai.agents[0];
  const startY = victim.position.y;
  const deaths = [];
  engine.events.on('actor:death', (e) => deaths.push(engine.time.frame));

  const timeline = (drv, eng, i) => {
    if (i === sec(1.0)) {
      const p = victim.position;
      victim.applyDamage(500, 'torso', { x: p.x, y: p.y + 1.3, z: p.z }, { x: 0, y: 0, z: 1 });
    }
  };
  const { aiSamples } = play(engine, rec, { frames: sec(14), timeline, trackAi: true });

  const rec0 = aiSamples.map((f) => f.find((a) => a.id === victim.id)).filter(Boolean);
  const diedAt = rec0.findIndex((a) => !a.alive);
  const fadeSeen = rec0.some((a) => a.opacity !== undefined && a.opacity < 0.99 && a.opacity > 0);
  const removed = rec0[rec0.length - 1] === undefined || !ai.agents.includes(victim);
  const ragdoll = !!victim.ragdoll;
  const fellY = ragdoll && victim.ragdoll.aabb
    ? +(startY + 1.7 - victim.ragdoll.aabb.maxy).toFixed(2)
    : null;

  const pass = diedAt > 0 && deaths.length === 1 && ragdoll && fadeSeen && removed;

  engine.dispose();
  return {
    name: 'ai-death', pass,
    diedAtSample: diedAt, deathEvents: deaths.length,
    ragdollCreated: ragdoll, bodyDroppedM: fellY,
    fadeOutObserved: fadeSeen, corpseCleanedUp: removed,
    remainingAgents: ai.agents.length,
  };
}

/* ====================================================================== */
/* 8. squad reaction to a casualty                                        */
/* ====================================================================== */

/**
 * What a squad does when one of its own is killed. Before this existed the
 * answer was "nothing at all": MEASURED on this same garrison, agent 1 was shot
 * dead 1.1 m from agent 3, and agents 2 and 3 kept walking their patrol route
 * with `lastKnownAge` still at infinity four seconds later.
 *
 * Four claims, one kill each:
 *   1. the men beside him react at all — alert, and suppressed by it
 *   2. the shot gives them a bearing to search, never the player's position
 *   3. they flinch: small, and not shooting, for a beat
 *   4. nobody keeps holding the cover his mate was just killed behind
 * plus 5. the last man of a gutted squad breaks contact instead of trading
 * shots alone with whoever just killed the other two, 6. the flinch reaches a
 * man who is not in a firefight — the patrol that loses its point man stops
 * walking — and 7. the bearing reaches his BODY: he turns to face it instead
 * of searching with his back to the shot.
 */
export async function scenarioSquad() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  const squads = (ai?.squads ?? []).filter((s) => s.members.length >= 3);
  if (squads.length < 2) {
    engine.dispose();
    return { name: 'ai-squad', pass: false, reason: 'need two three-man squads' };
  }

  /** A killing hit from a known direction, so the back-trace has something to work with. */
  const kill = (a) => {
    const p = a.position;
    a.applyDamage(500, 'torso', { x: p.x, y: p.y + 1.3, z: p.z }, { x: 0, y: 0, z: 1 });
  };
  const snap = () =>
    ai.agents.map((a) => ({
      id: a.id, squad: a.squad, alive: a.alive, state: a.state,
      sup: a.suppression, flinch: a.manDownTimer, fire: a.wantFire,
      lka: a.lastKnownAge, cover: a.cover,
      cx: a.coverPos.x, cz: a.coverPos.z, x: a.position.x, z: a.position.z,
      yaw: a.yaw, speed: a.speed, lkx: a.lastKnown.x, lkz: a.lastKnown.z,
    }));

  const KILL1 = sec(4.0);  // a man on patrol, his squad walking beside him
  const KILL2 = sec(6.0);  // a man of the squad that is already in cover
  const KILL3 = sec(8.0);  // the second of squad one: one man left of three
  const bodies = {};
  const victims = {};

  const timeline = (drv, eng, i) => {
    if (i === KILL1) {
      const v = squads[0].members[0];
      victims[KILL1] = v; bodies[KILL1] = { x: v.position.x, z: v.position.z, squad: squads[0] };
      kill(v);
    }
    if (i === KILL2) {
      const v = squads[1].members[1];
      victims[KILL2] = v; bodies[KILL2] = { x: v.position.x, z: v.position.z, squad: squads[1] };
      kill(v);
    }
    if (i === KILL3) {
      const v = squads[0].members.find((m) => m.alive);
      if (v) { victims[KILL3] = v; bodies[KILL3] = { x: v.position.x, z: v.position.z, squad: squads[0] }; kill(v); }
    }
  };

  const frames = [];
  play(engine, rec, { frames: sec(16), timeline, onFrame: () => frames.push(snap()) });

  const dist = (a, bx, bz) => Math.hypot(a.x - bx, a.z - bz);
  const at = (f) => frames[f] ?? [];
  /**
   * The men of the dead man's squad who were close enough to know about it.
   * The victim is excluded explicitly: one frame before the kill he is alive,
   * 0 m from his own body and holding the very cover point in question.
   */
  const mates = (f, k) =>
    at(f).filter(
      (a) => a.alive && a.id !== victims[k]?.id && a.squad === bodies[k]?.squad &&
        dist(a, bodies[k].x, bodies[k].z) < 30
    );

  /* 1. did the survivors react, and were they oblivious before? */
  const before1 = mates(KILL1 - 1, KILL1);
  const obliviousBefore = before1.filter((a) => a.state === 'patrol' || a.state === 'idle').length;
  const noBearingBefore = before1.filter((a) => !(a.lka < 1e6)).length;
  const after1 = mates(KILL1, KILL1);
  const alerted = after1.filter((a) => a.state !== 'patrol' && a.state !== 'idle').length;
  const supBefore = Math.max(0, ...before1.map((a) => a.sup));
  const supAfter = Math.max(0, ...after1.map((a) => a.sup));

  /* 2. a bearing, arriving with a call-out delay rather than instantly */
  const bearings = after1.filter((a) => a.lka < 1e6).length;
  const bearingDelays = after1.map((a) => +a.lka.toFixed(2)).filter((v) => v > 0);

  /* 3. the flinch, and no shooting during it — across every casualty */
  let flinchFrames = 0;
  let firedWhileFlinching = 0;
  for (const f of frames) {
    for (const a of f) {
      if (!a.alive || a.flinch <= 0) continue;
      flinchFrames++;
      if (a.fire) firedWhileFlinching++;
    }
  }

  /* 4. cover held next to the body is given up for a point further from it */
  const holders = mates(KILL2 - 1, KILL2).filter((a) => a.cover && dist({ x: a.cx, z: a.cz }, bodies[KILL2].x, bodies[KILL2].z) < 5);
  const moved = holders.map((h) => {
    const now = at(KILL2 + sec(1.0)).find((a) => a.id === h.id);
    if (!now?.cover || now.cover === h.cover) return null;
    const was = dist({ x: h.cx, z: h.cz }, bodies[KILL2].x, bodies[KILL2].z);
    const is = dist({ x: now.cx, z: now.cz }, bodies[KILL2].x, bodies[KILL2].z);
    return +(is - was).toFixed(2);
  });
  const coverAbandoned = moved.filter((d) => d !== null).length;

  /* 5. one man left of three: break contact */
  const lastMan = frames[frames.length - 1].find((a) => a.alive && a.squad === squads[0]);
  const brokeContact = lastMan
    ? frames.slice(KILL3).some((f) => f.find((a) => a.id === lastMan.id)?.state === 'retreat')
    : false;

  /**
   * 6. the flinch is visible on a man who is NOT in a firefight. The flinch
   * used to be applied inside the combat branch, so the case it was written for
   * — a patrol losing its point man — walked straight past the body at 1.35 m/s
   * with the shock timer ticking down unread.
   */
  const patrolFlinch = after1.map((m) => {
    const window = frames.slice(KILL1, KILL1 + sec(1.2)).map((f) => f.find((a) => a.id === m.id));
    const during = window.filter((a) => a?.flinch > 0);
    return {
      id: m.id,
      wasWalking: +(at(KILL1 - 1).find((a) => a.id === m.id)?.speed ?? 0).toFixed(2),
      stoppedTo: during.length ? +Math.min(...during.map((a) => a.speed)).toFixed(2) : null,
      inCombat: during.some((a) => a.state === 'combat'),
    };
  });
  // 0.5 m/s is a man who has stopped; patrol speed is 1.35 and the ease-out is
  // ~0.14 s, so the two cases are nowhere near each other.
  const flinchStopped = patrolFlinch.filter((p) => p.stoppedTo !== null && p.stoppedTo < 0.5).length;

  /**
   * 7. and he turns to look at the bearing. Knowing where the shot came from
   * and standing there facing the other way is the tell that the squad's
   * information never reached the model — facing only followed `lastKnown`
   * while the man was in combat, and a man reacting to a casualty is not.
   */
  const bearingErrDeg = (a) => {
    if (!a) return null;
    const want = Math.atan2(a.lkx - a.x, a.lkz - a.z);
    let d = want - a.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) * 180 / Math.PI;
  };
  const turns = after1.map((m) => {
    const window = frames.slice(KILL1, KILL1 + sec(2.5)).map((f) => f.find((a) => a.id === m.id));
    const errs = window.map(bearingErrDeg).filter((e) => e !== null);
    return {
      id: m.id,
      offByAtTheShot: +(bearingErrDeg(at(KILL1).find((a) => a.id === m.id)) ?? -1).toFixed(1),
      closestWithin2p5s: errs.length ? +Math.min(...errs).toFixed(1) : null,
    };
  });
  const turned = turns.filter((t) => t.closestWithin2p5s !== null && t.closestWithin2p5s < 45).length;

  const pass =
    obliviousBefore === before1.length && before1.length >= 2 &&
    noBearingBefore === before1.length &&
    alerted === after1.length &&
    supAfter > supBefore + 0.4 &&
    bearings === after1.length && bearingDelays.length === after1.length &&
    flinchFrames > 0 && firedWhileFlinching === 0 &&
    holders.length > 0 && coverAbandoned === holders.length &&
    brokeContact &&
    flinchStopped === after1.length &&
    turned === after1.length;

  engine.dispose();
  return {
    name: 'ai-squad', pass,
    matesInEarshot: after1.length,
    obliviousBeforeKill: `${obliviousBefore}/${before1.length} patrolling, ${noBearingBefore} with no bearing`,
    alertedOnTheKill: `${alerted}/${after1.length}`,
    suppression: `${supBefore.toFixed(2)} -> ${supAfter.toFixed(2)}`,
    bearingsGiven: bearings,
    callOutDelaysS: bearingDelays,
    flinchFrames, shotsWantedWhileFlinching: firedWhileFlinching,
    coverNextToBody: `${coverAbandoned}/${holders.length} abandoned`,
    newCoverFurtherByM: moved.filter((d) => d !== null),
    lastManBrokeContact: brokeContact,
    patrolStoppedForIt: `${flinchStopped}/${after1.length}`,
    walkingAtMsThenDownTo: patrolFlinch.map((p) => `${p.wasWalking}->${p.stoppedTo}`),
    turnedToBearing: `${turned}/${after1.length}`,
    bearingErrorDeg: turns.map((t) => `${t.offByAtTheShot}->${t.closestWithin2p5s}`),
  };
}

/* ====================================================================== */
/* 9. flanking                                                            */
/* ====================================================================== */

/**
 * Do the enemies ever actually manoeuvre? "They just sit behind a wall" is the
 * single loudest complaint a shooter's AI can earn, and this garrison had two
 * independent reasons to earn it — both invisible from every other gate,
 * because a flank that never happens looks exactly like a firefight.
 *
 *   1. The destination was a raw geometric offset, "fifteen metres to my left",
 *      handed to A* without ever asking whether a man can stand there.
 *      MEASURED over 60 s: 11 of 14 manoeuvres died as a solve that returned no
 *      route, the dice already spent. `Agent._flankPoint` now snaps the point
 *      onto walkable ground in the agent's own nav component first.
 *   2. The gate refused to move anyone holding a grenade, on the theory that he
 *      would throw it instead — but the squad rations throws, so he mostly did
 *      not. MEASURED on that same run: 6637 of 11354 flank-eligible frames
 *      blocked, against 2139 of 2143 throw windows refused by the ration.
 *
 * The claims: the squad tries to flank, every try that gets past the dice finds
 * a route, the try becomes a real flank, and no man is barred from manoeuvring
 * for long by a grenade he is not going to get to throw.
 *
 * …and then three more, which are about the same complaint seen from the other
 * end. A flank that happens is worth nothing if the man who is NOT flanking is
 * a statue, and every one of these was a real, measured freeze:
 *
 *   5. Nobody holds one square metre for most of a firefight. MEASURED before
 *      the nav fix: one man stood on the same spot for 43 s, because he had
 *      walked onto a crate lid — an 8-cell nav island with no cover point on it
 *      — and every region-filtered query answered "nothing".
 *   6. Nobody stands in combat with no cover AND nowhere to go. That is the
 *      exact signature of the freeze above (2581 consecutive frames of it), and
 *      it is invisible to claim 5 alone: a man shuffling 0.3 m between peek
 *      poses reads as "moving" while being just as stuck.
 *   7. Nobody interrogates the CoverMap in a loop. The freeze above came with a
 *      full 1349-point scan every single frame, 2581 frames running, every one
 *      of them answered `null` — because "I have no cover" used to be its own
 *      right to re-ask, on top of the repath clock. A man the map has nothing
 *      for asked it sixty times a second for as long as that lasted.
 */
export async function scenarioFlank() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  if (!ai?.agents.length) {
    engine.dispose();
    return { name: 'ai-flank', pass: false, reason: 'no enemies spawned' };
  }

  const RUN = sec(40);
  const BIN = sec(10);
  const bins = new Array(Math.ceil(RUN / BIN)).fill(0);
  let attempts = 0, deadEnds = 0, deferred = 0, entries = 0;
  let throws = 0;
  const barred = new Map();      // agent id -> frames blocked back to back
  let longestBarred = 0;

  // EVERY destination anyone asks for, not just the flank ones. Reported
  // rather than asserted: see the note on the pass condition below.
  let goToCalls = 0, noRoutes = 0;
  const noRouteRun = new Map();  // agent id -> no-route answers back to back
  let longestNoRouteRun = 0;
  // claims 5 + 6: how long a man was a statue, and how long he was a statue
  // with nothing to get behind and nowhere to be.
  const stillRun = new Map();
  const adriftRun = new Map();
  let longestStill = 0, longestAdrift = 0, adriftFrames = 0;
  // claim 7: how hard the CoverMap is being worked, and how long one man went
  // on asking it a question it kept answering `null`.
  let coverQueries = 0, nullPicks = 0;
  const nullRun = new Map();
  let longestNullRun = 0;

  // A manoeuvre is one _flankPoint search followed by the _goTo it feeds. The
  // flag is per agent and cleared every frame, so a search that finds no ground
  // at all cannot be charged to somebody else's path request.
  for (const a of ai.agents) {
    const point = a._flankPoint.bind(a);
    a._flankPoint = (...args) => {
      a.__flanking = true;
      return point(...args);
    };
    const goTo = a._goTo.bind(a);
    a._goTo = (dest) => {
      const mine = a.__flanking;
      a.__flanking = false;
      const ok = goTo(dest);
      goToCalls++;
      // `!ok` with a pending path is the frame's A* budget talking and the
      // request is queued; `!ok` without one is A* saying there is no route at
      // all, which is what leaves a man standing.
      const dead = !ok && !a.pathPending;
      const run = dead ? (noRouteRun.get(a.id) ?? 0) + 1 : 0;
      noRouteRun.set(a.id, run);
      if (run > longestNoRouteRun) longestNoRouteRun = run;
      if (dead) noRoutes++;
      if (mine) {
        attempts++;
        if (!ok) a.pathPending ? deferred++ : deadEnds++;
      }
      return ok;
    };
  }
  const realThrow = ai.throwGrenade.bind(ai);
  ai.throwGrenade = (...args) => {
    throws++;
    return realThrow(...args);
  };

  // Every question put to the CoverMap, and who asked it. `pick` carries the
  // caller's id in its options, which is what makes the run per-man rather than
  // a squad-wide average that would hide one agent spinning.
  const cover = ai.cover;
  if (cover) {
    const pick = cover.pick.bind(cover);
    cover.pick = (pos, threat, opts = {}) => {
      const got = pick(pos, threat, opts);
      coverQueries++;
      if (!got) nullPicks++;
      const id = opts.id;
      if (id !== undefined) {
        const run = got ? 0 : (nullRun.get(id) ?? 0) + 1;
        nullRun.set(id, run);
        if (run > longestNullRun) longestNullRun = run;
      }
      return got;
    };
  }

  const prev = new Map();
  const onFrame = (i) => {
    const bin = Math.floor(i / BIN);
    for (const a of ai.agents) {
      a.__flanking = false;
      if (!a.alive) {
        stillRun.set(a.id, 0);
        adriftRun.set(a.id, 0);
        continue;
      }
      if (a.state === 'flank' && prev.get(a.id) !== 'flank') {
        entries++;
        bins[bin]++;
      }
      prev.set(a.id, a.state);

      /* 5. the statue check: how long he WANTED to be somewhere and was not
         getting there.
         This used to read `a.speed < 0.2` and that was wrong in both directions.
         `speed` is what he asked for, so a man wedged on a corner at a dead run
         read as moving — MEASURED, the loudest case of the bug this scenario is
         supposed to fence sat at 4.58 s and this counter never saw a frame of
         it. And a man holding cover deliberately, which is what soldiers do,
         read as a statue: the peek-pose fix in `_combat` moved this number from
         4.87 s to 6.95 s against a threshold of 8 by making men STOP instead of
         shuffling on the spot — a better build scoring worse.
         `progress` is the ground he actually covered, and the condition is now
         the same one the watchdog in `_move` makes: he has somewhere to be, and
         he is not getting there. Standing still on purpose is not a stall. */
      const wantsToBe = a.desiredSpeed > 0.2 && a.hasMoveTarget && !a.pathPending;
      const still = wantsToBe && (a.progress ?? 0) < Math.max(0.25, a.desiredSpeed * 0.25)
        ? (stillRun.get(a.id) ?? 0) + 1 : 0;
      stillRun.set(a.id, still);
      if (still > longestStill) longestStill = still;

      /* 6. …and the specific way he gets stuck: in the fight, nothing to get
         behind, no path anywhere. `onFrame` runs after `_move`, so a path that
         starts and ends inside one frame shows up here as a single adrift
         frame — which is why the claim is on the RUN, not the total. */
      const adrift = a.state === 'combat' && !a.cover && !a.hasMoveTarget && !a.pathPending;
      if (adrift) adriftFrames++;
      const arun = adrift ? (adriftRun.get(a.id) ?? 0) + 1 : 0;
      adriftRun.set(a.id, arun);
      if (arun > longestAdrift) longestAdrift = arun;

      // the exact term the flank gate tests, rebuilt from the outside
      const sq = a.squad;
      const target = a.hasTarget || a.lastKnownAge < 5 ? a.lastKnown : null;
      const d = target ? a.position.distanceTo(target) : 0;
      const blocked = !!sq && sq.grenadeCooldown <= 0 && a.hasGrenade && a.grenadeCooldown <= 0 &&
        !!target && d > 8 && d < 26 && a.lastKnownAge < 1.5;
      const streak = blocked ? (barred.get(a.id) ?? 0) + 1 : 0;
      barred.set(a.id, streak);
      if (streak > longestBarred) longestBarred = streak;
    }
  };

  play(engine, rec, { frames: RUN, onFrame });

  const barredS = +(longestBarred / FPS).toFixed(2);
  const stillS = +(longestStill / FPS).toFixed(2);
  const adriftS = +(longestAdrift / FPS).toFixed(2);
  const pass =
    attempts >= 3 && deadEnds === 0 && entries >= 3 && barredS < 8 &&
    // MEASURED 1.40 s — the watchdog in `_move` dropping a dead route at 1.4 s.
    // 2.5 s is that plus grace. Reverting the watchdog to watch `speed` instead
    // of `progress` reads 7.35 s here, which is the failure this claim is for
    // and which the old `speed < 0.2` spelling of it could not see at all.
    // `ai-move` fences the same property across every state and is the fuller
    // statement; this stays because a flank is the manoeuvre that produces the
    // longest routes and therefore the most chances to wedge on one.
    stillS < 2.5 &&
    // MEASURED 0 frames. 1 s of it is a man who has genuinely just lost his
    // cover and is about to be given a bound; the freeze ran 2581 frames.
    adriftS < 1 &&
    // MEASURED 76 queries in 40 s across six men — one every three agent-
    // seconds, which is the repath clock doing its job. A per-frame scan would
    // be 14400. 240 is a generous ceiling that still catches any return of
    // "asking is free".
    coverQueries < 240 &&
    // MEASURED 0 in a row. The freeze ran 2581.
    longestNullRun < 30;
  // `pathRequests` / `pathsWithNoRoute` / `longestNoRouteRun` are reported, not
  // asserted, and deliberately so. The failure they were meant to fence — A*
  // refusing a cover route over and over — no longer produces a distinctive
  // number: partial paths turn a starved solve into a short walk instead of a
  // refusal, and the escalating node budget solves what is left on the retry.
  // MEASURED across four deliberately broken builds (fixed 6000 nodes, fixed
  // 700, fixed 220, and partial paths disabled outright) the longest run of
  // no-route answers moved between 1 and 2 and the total between 1 and 3 — no
  // threshold separates a healthy build from a broken one, so any assertion
  // here would be decoration. What that freeze looked like from outside is
  // fenced instead, by claims 5 and 6, which do not care which mechanism
  // stopped the man.

  engine.dispose();
  return {
    name: 'ai-flank', pass,
    flankAttempts: attempts,
    attemptsWithNoRoute: deadEnds,
    attemptsDeferredByBudget: deferred,
    flanksEntered: entries,
    entriesPer10s: bins,
    longestBarredByGrenadeS: barredS,
    grenadesThrown: throws,
    longestTravelStallS: stillS,
    adriftInCombatFrames: adriftFrames,
    longestAdriftS: adriftS,
    pathRequests: goToCalls,
    pathsWithNoRoute: noRoutes,
    longestNoRouteRun,
    coverQueries,
    nullPicks,
    longestNullPickRun: longestNullRun,
  };
}

/* ====================================================================== */
/* 10. surviving a hit                                                    */
/* ====================================================================== */

/**
 * What a man does about a round that does NOT kill him.
 *
 * Every other AI gate here fires on a death: the squad one kills three men, the
 * flank one never shoots anybody. So the whole of `Agent.applyDamage` short of
 * `die()` — the back-trace, the suppression bump, the hit animation, the wake-up
 * from patrol — has run in play since the day it was written and has never once
 * been checked. That is the half of the code a player actually meets, because
 * most rounds that land are not the last one.
 *
 * Six claims, one shot each:
 *   1. he notices — an oblivious man on patrol does not keep walking his route
 *   2. the round tells him WHERE from: the bearing is the back-trace of the
 *      incident direction, not the shooter handed to him for free
 *   3. it registers on the body, not just in the state machine
 *   4. it suppresses him
 *   5. he does not stand there and take the next one — inside four seconds he
 *      has moved, or he has claimed something to get behind
 *   6. a round through the leg costs him his footing
 *
 * Claims 2, 4 and 6 each have exactly one owner: deleting the back-trace moves
 * the bearing error 0 -> 14 m, deleting the suppression line moves the jump
 * 0.34 -> 0, deleting `speed *= 0.4` leaves 1.5 m/s running into 1.49 out.
 * Claims 1, 3 and 5 are deliberately emergent and have no single owner — VERIFIED
 * by deleting the explicit patrol wake-up in `applyDamage` (he still wakes, off
 * `alertness = 1`) and the ALERT investigation move (he still covers 4.96 m, by
 * acquiring and taking cover instead). They assert what the player sees rather
 * than which line produced it, which is the point: any of those routes is a man
 * reacting, and no route at all is the bug.
 */
export async function scenarioHit() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  if (!ai?.agents.length) {
    engine.dispose();
    return { name: 'ai-hit', pass: false, reason: 'no enemies spawned' };
  }

  const HIT = sec(2.0);
  const LEG = sec(9.0);
  const RANGE = 14;               // the same 14 m the back-trace assumes
  const victim = ai.agents[0];
  const legMan = ai.agents.find((a) => a !== victim) ?? victim;
  /** Shoot `a` from `RANGE` metres due east, so the true origin is known. */
  const shoot = (a, amount, part) => {
    const from = { x: a.position.x + RANGE, y: a.position.y + 1.3, z: a.position.z };
    const point = { x: a.position.x, y: a.position.y + 1.3, z: a.position.z };
    const dir = { x: -1, y: 0, z: 0 };   // from the shooter toward him
    a.applyDamage(amount, part, point, dir);
    return from;
  };

  let origin = null, legOrigin = null;
  const snap = () =>
    ai.agents.map((a) => ({
      id: a.id, alive: a.alive, state: a.state, health: a.health,
      sup: a.suppression, lka: a.lastKnownAge,
      lkx: a.lastKnown.x, lkz: a.lastKnown.z,
      x: a.position.x, z: a.position.z, speed: a.speed,
      cover: a.cover, hitT: a.animator?.hitT ?? -1,
    }));

  const frames = [];
  const timeline = (drv, eng, i) => {
    // 28 of 100 HP: a real wound that leaves him on his feet whichever variant
    // he is, so the claims below are about surviving and not about dying slowly.
    if (i === HIT) origin = shoot(victim, 28, 'torso');
    if (i === LEG && legMan.alive) legOrigin = shoot(legMan, 22, 'leg');
  };
  play(engine, rec, { frames: sec(14), timeline, onFrame: () => frames.push(snap()) });

  const at = (f, id) => (frames[f] ?? []).find((a) => a.id === id);
  const before = at(HIT - 1, victim.id);
  const after = at(HIT, victim.id);

  /* 1. he notices */
  const wasOblivious = !!before && (before.state === 'patrol' || before.state === 'idle');
  const woke = !!after && after.state !== 'patrol' && after.state !== 'idle';

  /* 2. …and the round says where from. The back-trace runs 14 m up the incident
     ray, so with a shooter at exactly 14 m it should land on him. */
  const bearingErrM = after && origin
    ? +Math.hypot(after.lkx - origin.x, after.lkz - origin.z).toFixed(2)
    : null;

  /* 3. it lands on the body */
  const hitAnim = frames.slice(HIT, HIT + sec(0.5)).some((f) => (f.find((a) => a.id === victim.id)?.hitT ?? -1) >= 0);

  /* 4. and it suppresses */
  const supJump = before && after ? +(after.sup - before.sup).toFixed(2) : null;

  /* 5. he does not stand there. Either he covers ground or he claims cover —
     both are "did something about it"; only standing in the open is not. */
  const window = frames.slice(HIT, HIT + sec(4)).map((f) => f.find((a) => a.id === victim.id));
  const movedM = window.reduce((m, a) => (a && after ? Math.max(m, Math.hypot(a.x - after.x, a.z - after.z)) : m), 0);
  const tookCover = window.some((a) => a?.cover);
  const reacted = movedM > 2 || tookCover;

  /* 6. a leg wound costs him his footing: the dent, measured against the speed
     he was carrying into it. A man who was already stationary proves nothing,
     so that is reported rather than folded into the verdict. */
  const legBefore = at(LEG - 1, legMan.id);
  const legAfter = at(LEG, legMan.id);
  const wasRunning = (legBefore?.speed ?? 0) > 0.6;
  const legDrop = legBefore && legAfter ? +(legBefore.speed - legAfter.speed).toFixed(2) : null;
  const stumbled = !wasRunning || (legDrop !== null && legDrop > legBefore.speed * 0.4);

  const survived = !!after?.alive && frames[frames.length - 1].some((a) => a.id === victim.id && a.alive);

  const pass =
    survived && wasOblivious && woke &&
    bearingErrM !== null && bearingErrM < 2 &&
    hitAnim &&
    supJump !== null && supJump > 0.3 &&
    reacted &&
    stumbled;

  engine.dispose();
  return {
    name: 'ai-hit', pass,
    survivedTheRound: survived,
    obliviousBefore: before?.state ?? null,
    stateAfter: after?.state ?? null,
    bearingErrorM: bearingErrM,
    hitReactionPlayed: hitAnim,
    suppressionJump: supJump,
    movedWithin4sM: +movedM.toFixed(2),
    tookCoverWithin4s: tookCover,
    legShotWhileRunning: wasRunning,
    legSpeedBeforeAfter: legBefore && legAfter ? [+legBefore.speed.toFixed(2), +legAfter.speed.toFixed(2)] : null,
    legShotOrigin: legOrigin ? [+legOrigin.x.toFixed(1), +legOrigin.z.toFixed(1)] : null,
  };
}

/* ====================================================================== */
/* 11. grenade resupply                                                   */
/* ====================================================================== */

/**
 * Does a man ever get another grenade?
 *
 * `_throwGrenade` clears `hasGrenade` and charges a 16-34 s cooldown, and until
 * this scenario existed nothing ever read that clock back: the flag went false
 * and stayed false, so every enemy in the game threw exactly one grenade per
 * round and then carried an empty pouch for the rest of his life. The tell was
 * the cooldown itself — there is no reason to charge a timer for a thing that
 * cannot happen twice.
 *
 * It is invisible to every other gate on purpose: `ai-flank` runs 40 s and the
 * whole garrison throws three grenades in it, none of them a second one from
 * the same man. So this run is sized to the draw — throw, read what he was
 * charged, and play exactly that long plus a second.
 *
 * Three claims: the throw costs him the grenade and a real clock, the clock is
 * not a formality (he carries nothing for the whole of it), and it is not a
 * life sentence either.
 */
export async function scenarioGrenade() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  if (!ai?.agents.length) {
    engine.dispose();
    return { name: 'ai-grenade', pass: false, reason: 'no enemies spawned' };
  }

  const man = ai.agents[0];
  const carriedBefore = man.hasGrenade;
  // Throw it somewhere harmless and far enough off that the blast does not come
  // back and kill the thrower — this measures the pouch, not the explosive.
  const away = { x: man.position.x + 30, y: man.position.y, z: man.position.z + 30 };
  man._throwGrenade(away);
  const charged = +man.grenadeCooldown.toFixed(2);
  const emptyAtThrow = !man.hasGrenade;

  // exactly as long as he was charged, plus a second to see it come back
  const RUN = sec(charged + 1);
  let earlyResupply = -1;     // first frame he carried again while still charged
  let backAt = -1;            // first frame he carried again at all
  let clockAtZero = -1;
  const onFrame = (i) => {
    if (!man.alive) return;
    if (man.grenadeCooldown <= 0 && clockAtZero < 0) clockAtZero = i;
    if (man.hasGrenade) {
      if (backAt < 0) backAt = i;
      if (man.grenadeCooldown > 0 && earlyResupply < 0) earlyResupply = i;
    }
  };
  play(engine, rec, { frames: RUN, onFrame });

  const survived = man.alive;
  const backAfterS = backAt >= 0 ? +(backAt / FPS).toFixed(2) : null;
  const clockZeroAtS = clockAtZero >= 0 ? +(clockAtZero / FPS).toFixed(2) : null;
  // The flag is restored in the same `update` that ticks the clock past zero, so
  // "within a frame of it" is the honest tolerance, not a grace period.
  const promptly = backAt >= 0 && clockAtZero >= 0 && backAt - clockAtZero <= 1;

  const pass =
    carriedBefore && emptyAtThrow &&
    charged >= 16 && charged <= 34 &&
    survived &&
    earlyResupply < 0 &&
    backAt >= 0 && promptly;

  engine.dispose();
  return {
    name: 'ai-grenade', pass,
    carriedOneToStart: carriedBefore,
    emptyImmediatelyAfterThrow: emptyAtThrow,
    chargedS: charged,
    resuppliedEarlyAtFrame: earlyResupply,
    clockHitZeroAtS: clockZeroAtS,
    carryingAgainAtS: backAfterS,
    resuppliedOnTheClock: promptly,
    survivedHisOwnGrenade: survived,
  };
}

/* ====================================================================== */
/* 12. breaking contact                                                   */
/* ====================================================================== */

/**
 * What the last man of a wiped-out squad does with the rest of his life.
 *
 * `ai-squad` already checks that he ENTERS the retreat — claim 5 there — and
 * that is all it checks. It never asked what the state costs him, and the answer
 * was: most of it. Both callers of `_breakContact` gate on `squadIsBroken`,
 * which is not an event but a permanent fact — a three-man squad that is down to
 * one is down to one for the rest of the level — so the dice behind it came up
 * for that man roughly once a second, forever.
 *
 * MEASURED over 60 s with both squads gutted, before the fix: 16 break-offs,
 * NONE refused, taken at 14 m and then at 24-38 m by men at full health looking
 * straight at the player, the two survivors 48.3 % and 41.1 % of their lives
 * sprinting away in nine-metre bursts, and both still running when the clock
 * stopped. They wanted to fire on 364 and 121 frames of 3600. That is not a
 * retreating enemy, it is a commuting one, and it is the "the enemies don't
 * fight" complaint wearing the opposite disguise from the one `ai-flank` fences.
 *
 * Five claims:
 *   1. he still breaks contact at all — the cheap way to pass 2-5 is to delete
 *      the behaviour, and this is the claim that fails when someone does
 *   2. every break-off he does take is from inside knife range — falling back
 *      nine metres from a man thirty metres away breaks nothing off
 *   3. nobody commutes: no man spends a fifth of his life running
 *   4. no episode outlasts the state's own 4 s timeout by much, and
 *   5. nobody is still running when the fight ends — he comes back out of it
 *
 * Claims 2 and 3 have exactly one owner each and they do NOT overlap — MEASURED
 * by reverting each guard in `_breakContact` on its own:
 *
 *   guard reverted    breakOffs  maxRange  worstShare  wantedToFire
 *   ----------------  ---------  --------  ----------  ------------
 *   none (shipping)       3       15.7 m     13.4 %     2602 / 750
 *   range guard           6       28.8 m     17.8 %      889 / 884   <- claim 2
 *   cooldown              5       15.7 m     26.8 %     2602 / 750   <- claim 3
 *   both (pre-fix)       16       38.3 m     48.3 %      364 / 121
 *
 * Read the middle two rows: neither guard alone gets the behaviour back to
 * healthy, and neither claim alone catches both reverts. Dropping the range
 * guard leaves the share at 17.8 %, which passes claim 3; dropping the cooldown
 * leaves every break-off inside 15.7 m, which passes claim 2. The cooldown row
 * is the interesting one — with the range guard still in place the man does not
 * stop looping, he just picks a radius and loops there: eight consecutive
 * break-offs at 15.70 m, each one walking 3.1 m and ending 0.00-0.01 m from
 * where it started. Pacing, not retreating.
 *
 * Claims 4 and 5 are guards on the exit path, not evidence for the fix. Claim 5
 * did fail on the pre-fix build, but only because the clock happened to stop
 * mid-episode — over a different window it would have passed, so it is not the
 * discriminator. See the note at the pass condition.
 */
export async function scenarioRetreat() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  const squads = (ai?.squads ?? []).filter((s) => s.members.length >= 3);
  if (squads.length < 2) {
    engine.dispose();
    return { name: 'ai-retreat', pass: false, reason: 'need two three-man squads' };
  }

  // 60 s and not 40. The commute is a slow tell: over 40 s a build with the
  // cooldown reverted still reads 11.6 %, because the range guard alone pins
  // the loop rather than stopping it. Over 60 s the same build reads 26.7 % and
  // the claim that is supposed to catch it does.
  const RUN = sec(60);
  const kill = (a) => {
    if (!a?.alive) return;
    const p = a.position;
    a.applyDamage(500, 'torso', { x: p.x, y: p.y + 1.3, z: p.z }, { x: 0, y: 0, z: 1 });
  };
  // Two of three from each squad, so BOTH survivors are permanently "broken".
  // One gutted squad would leave the finding to a single man and a single seed.
  const timeline = (drv, eng, i) => {
    if (i === sec(3)) kill(squads[0].members[0]);
    if (i === sec(5)) kill(squads[1].members[0]);
    if (i === sec(7)) kill(squads[0].members.find((m) => m.alive));
    if (i === sec(9)) kill(squads[1].members.find((m) => m.alive));
  };

  // Every ask, taken or refused, and the range it was asked at. The range is
  // measured before the call, because a call that takes moves him.
  const asks = [];
  for (const a of ai.agents) {
    const bc = a._breakContact.bind(a);
    a._breakContact = (from) => {
      const range = Math.hypot(a.position.x - from.x, a.position.z - from.z);
      const was = a.state;          // a call that takes sets RETREAT
      const hp = a.health;
      const ok = bc(from);
      asks.push({ id: a.id, atS: +(engine.time.frame / FPS).toFixed(2), ok, rangeM: +range.toFixed(2), from: was, hp: +hp.toFixed(0) });
      return ok;
    };
  }

  const open = new Map();     // id -> the episode in progress
  const done = [];
  const life = new Map();     // id -> frames alive / retreating / wanting to fire
  const onFrame = (i) => {
    for (const a of ai.agents) {
      if (!a.alive) { open.delete(a.id); continue; }
      const b = life.get(a.id) ?? { alive: 0, retreat: 0, fire: 0 };
      b.alive++;
      if (a.wantFire) b.fire++;
      life.set(a.id, b);

      const inR = a.state === 'retreat';
      if (inR) b.retreat++;
      const ep = open.get(a.id);
      if (inR && !ep) {
        open.set(a.id, { id: a.id, startS: +(i / FPS).toFixed(2), frames: 1, x: a.position.x, z: a.position.z, x0: a.position.x, z0: a.position.z, walked: 0 });
      } else if (inR && ep) {
        ep.frames++;
        ep.walked += Math.hypot(a.position.x - ep.x, a.position.z - ep.z);
        ep.x = a.position.x; ep.z = a.position.z;
      } else if (!inR && ep) {
        done.push({
          id: ep.id, startS: ep.startS, durS: +(ep.frames / FPS).toFixed(2),
          walkedM: +ep.walked.toFixed(2),
          netM: +Math.hypot(a.position.x - ep.x0, a.position.z - ep.z0).toFixed(2),
          exitState: a.state,
        });
        open.delete(a.id);
      }
    }
  };

  play(engine, rec, { frames: RUN, timeline, onFrame });

  const taken = asks.filter((k) => k.ok);
  const survivors = [...life.entries()]
    .filter(([id]) => ai.agents.find((a) => a.id === id && a.alive))
    .map(([id, b]) => ({
      id,
      retreatShare: +(100 * b.retreat / b.alive).toFixed(1),
      aliveS: +(b.alive / FPS).toFixed(1),
      wantedToFireFrames: b.fire,
    }));

  const worstShare = Math.max(0, ...survivors.map((s) => s.retreatShare));
  const maxRange = taken.length ? Math.max(...taken.map((k) => k.rangeM)) : 0;
  const longestS = Math.max(0, ...done.map((e) => e.durS), ...[...open.values()].map((e) => +(e.frames / FPS).toFixed(2)));
  const cameBackOut = done.filter((e) => e.exitState === 'combat' || e.exitState === 'alert').length;

  const pass =
    // 1. the behaviour still exists. Every other claim here gets easier the less
    //    a man retreats, and passes perfectly on a build where he never does.
    taken.length >= 1 &&
    // 2. MEASURED worst 15.7 m, because 20 is the guard. Before it, fifteen of
    //    sixteen were taken at 24-38 m — where nine metres of ground buys
    //    nothing, since cover is scored out to 30 m and the grenade window
    //    closes at 26.
    maxRange <= 20 &&
    // 3. MEASURED 13.4 % worst of two men. The pre-fix build ran 48.3 % and the
    //    cooldown-reverted one 26.8 %. 20 % is "he ran for one stretch in five",
    //    which is the loosest reading of the intent that still separates them.
    worstShare < 20 &&
    // 4. RETREAT times out at 4 s for anyone above 45 HP and otherwise ends on
    //    arrival, so a run past 8 s means neither exit fired.
    longestS < 8 &&
    // 5. …and every episode that ended, ended in a fighting state.
    cameBackOut === done.length && open.size === 0;
  // Claims 4 and 5 are guards, not evidence. `longestEpisodeS` read 4.02 on
  // every build measured for this scenario, broken ones included — the exits are
  // `!hasMoveTarget`, arrival, and a 4 s clock, and no guard in `_breakContact`
  // touches any of them. Claim 5 did fire on the pre-fix build (2 men still
  // running at the whistle) but that is the clock stopping mid-episode, not a
  // property of the build: over a 45 s window the same build ended clean. They
  // are here because a man stuck in RETREAT is a man walking away from the fight
  // forever, which is the failure this scenario exists for, and watching for it
  // costs nothing — but claims 2 and 3 are what actually separate the builds.

  engine.dispose();
  return {
    name: 'ai-retreat', pass,
    squadsGutted: 2,
    breakOffsTaken: taken.length,
    breakOffsRefused: asks.length - taken.length,
    takenAtRangeM: taken.map((k) => k.rangeM),
    takenFromState: taken.map((k) => `${k.from}@${k.hp}hp`),
    worstRetreatSharePct: worstShare,
    perSurvivor: survivors,
    episodes: done.length,
    longestEpisodeS: longestS,
    episodeDetail: done,
    stillRetreatingAtEnd: open.size,
  };
}

/* ====================================================================== */
/* 13. movement that goes somewhere                                       */
/* ====================================================================== */

/**
 * A man who is walking has to arrive.
 *
 * Every other AI scenario here asks what a man DECIDES — take that cover, flank
 * that side, throw now, fall back. None of them checks that the decision turned
 * into ground. It did not: MEASURED over a 40 s firefight in which nobody dies,
 * agents covered less than a quarter of the ground they asked for on 2437 of
 * 9865 moving frames, with per-man streaks of 6.2 s, 4.6 s and 4.2 s, in
 * `combat`, `flank`, `alert` and `patrol` alike. The animation is a full sprint
 * and the position does not change. That is the single loudest thing wrong with
 * these enemies and nothing in this file could see it.
 *
 * WHY NOT `speed`. The obvious spelling — "he is slow, so he is stuck" — is the
 * reason the bug survived this long. `speed` is what he ASKED for; a man wedged
 * on a corner the nav grid calls open asks for 4.4 m/s and gets 0.0, so every
 * test written on `speed` reads him as sprinting. `scenarioFlank`'s statue check
 * had exactly that hole. Read `progress` instead — ground actually covered, m/s,
 * measured across a whole frame inside `_move`.
 *
 * WHAT COUNTS AS TRYING. Not `speed > 0`, for three reasons that are all normal
 * behaviour and none of them a stall:
 *   - the separation floor in `_move` (`if (want < 0.9) want = 0.9`) pushes a man
 *     off a squadmate whether or not he has anywhere to be;
 *   - the ease-out gives every stop half a second of `speed` after
 *     `desiredSpeed` has already gone to 0;
 *   - the 0.6 m shuffle onto a peek pose is a walk, but a walk so short that a
 *     ratio test on it is noise.
 * A travel frame is `desiredSpeed > 0.2` with a path under it and none pending —
 * he has somewhere to be and a route to it. That is the population the claims
 * below are about, and it is 6735 of the 40 s run.
 *
 * Claims 5, 6 and 7 count over LIVING frames instead, not travelling ones,
 * because all three are about what the man can perceive and do while pinned —
 * and a man can be shoved into a wall by a squadmate while holding cover with
 * `desiredSpeed` at zero. Claim 7 has a second reason: the frames it counts are
 * ones the mover cancelled in the frame they were ordered, so by the time the
 * travel test runs on them `hasMoveTarget` is already false and they are not in
 * the travel population at all. It is exactly the blind spot that hid it.
 *
 * Seven claims:
 *   1. they are actually travelling, so the rest of the numbers mean something
 *   2. no man is stuck on one route for long — the watchdog in `_move` exists
 *   3. the peek shuffle terminates — it is the one branch that can re-order the
 *      same impossible 0.6 m walk every frame for ever, and it did
 *   4. everyone covers real ground, which is the claim that fails on a build
 *      where nobody moves at all and every claim above passes perfectly
 *   5. an agent can tell a wall from the floor at all — `slopeLimit` is handed
 *      to the controller in the unit it asks for
 *   6. a wedged man walks ALONG the wall rather than into it
 *   7. no man is ordered to walk to a spot he is already standing on — the two
 *      places that measure the same trip measure it in the same dimensions
 *
 * An eighth number, the share of travel frames that stall, is reported and NOT
 * asserted — see the note under the pass condition, where the builds it fails to
 * separate are tabulated. Claims 2, 3, 5, 6 and 7 have exactly one owner each;
 * 1 and 4 are guards.
 */
export async function scenarioMove() {
  const { engine, rec } = await bootPlay({ populate: true });
  const ai = engine.ctx.peek('ai');
  if (!ai?.agents.length) {
    engine.dispose();
    return { name: 'ai-move', pass: false, reason: 'no enemies spawned' };
  }

  // 40 s of plain firefight, nobody killed. The gutted-squad setup reads a
  // LOWER stall rate (16.7 % against 19.6 %) because two men make no crowd, so
  // the harder case is the ordinary one and this is it.
  const RUN = sec(40);

  // The peek shuffle, identified at its source. `_setPath1(dest, 0.1)` is the
  // shuffle and only the shuffle — the other caller, `_goTo`, passes 0.45 — so
  // this needs no guess about which state or which flags mean "leaning out".
  for (const a of ai.agents) {
    const sp = a._setPath1.bind(a);
    a._setPath1 = (dest, eps) => {
      if (eps === 0.1) a.__shuffle = true;
      return sp(dest, eps);
    };
  }

  const travelRun = new Map();     // id -> travel-stall streak
  const shuffleRun = new Map();    // id -> shuffle-stall streak
  const worst = new Map();         // id -> longest travel streak + where
  const ground = new Map();        // id -> metres actually covered
  const byState = {};
  let travelFrames = 0, travelStalls = 0;
  let longestTravel = 0, longestShuffle = 0;
  let aliveFrames = 0, wallContact = 0, sidestep = 0, pinned = 0;

  const onFrame = () => {
    for (const a of ai.agents) {
      const wasShuffle = a.__shuffle;
      a.__shuffle = false;
      if (!a.alive) { travelRun.set(a.id, 0); shuffleRun.set(a.id, 0); continue; }

      // Claims 5 and 6, counted over every living frame rather than only the
      // travelling ones: a man can be shoved into a wall while holding cover.
      aliveFrames++;
      if (a.controller?.touchingWall) wallContact++;
      if (a.sidestepping) sidestep++;

      // Claim 7, and it is readable from out here for one reason: `update()`
      // runs `_think` before `_move`, so an order placed by `_combat` is served
      // by the mover in the SAME frame. A shuffle that was ordered this frame
      // and left `hasMoveTarget` false behind it is an order the mover threw
      // away on arrival without taking a step — he was sent to walk to a spot he
      // was already standing on. `desiredSpeed` is still set, so the watchdog
      // counts him as stalled, and `_combat` will order it again next frame.
      if (wasShuffle && !a.hasMoveTarget && a.desiredSpeed > 0.2) pinned++;

      // `progress` is set at the top of `_move` and `onFrame` runs after the
      // step, so this is the ground he covered during the frame just drawn.
      const got = a.progress ?? 0;
      ground.set(a.id, (ground.get(a.id) ?? 0) + got / FPS);

      // The same test the watchdog in `_move` makes, rebuilt from outside: both
      // floors, because a man whose speed never spins up makes 90 % of almost
      // nothing and a man at a dead run makes a hundredth of a lot.
      const short = got < Math.max(0.25, a.desiredSpeed * 0.25);

      if (wasShuffle) {
        travelRun.set(a.id, 0);
        const r = short ? (shuffleRun.get(a.id) ?? 0) + 1 : 0;
        shuffleRun.set(a.id, r);
        if (r > longestShuffle) longestShuffle = r;
        continue;
      }
      shuffleRun.set(a.id, 0);

      if (!(a.desiredSpeed > 0.2 && a.hasMoveTarget && !a.pathPending)) {
        travelRun.set(a.id, 0);
        continue;
      }
      travelFrames++;
      const r = short ? (travelRun.get(a.id) ?? 0) + 1 : 0;
      travelRun.set(a.id, r);
      if (short) {
        travelStalls++;
        byState[a.state] = (byState[a.state] ?? 0) + 1;
      }
      if (r > longestTravel) longestTravel = r;
      const w = worst.get(a.id);
      if (!w || r > w.frames) worst.set(a.id, { frames: r, state: a.state });
    }
  };

  play(engine, rec, { frames: RUN, onFrame });

  const travelS = +(longestTravel / FPS).toFixed(2);
  const shuffleS = +(longestShuffle / FPS).toFixed(2);
  const stallPct = travelFrames ? +(100 * travelStalls / travelFrames).toFixed(1) : 0;
  const covered = [...ground.entries()].map(([id, m]) => ({ id, m: +m.toFixed(1) })).sort((a, b) => a.m - b.m);
  const worstGround = covered.length ? covered[0].m : 0;

  /* The ten builds this gate is calibrated against, each one a deliberate
   * revert of a guard in `src/ai/agent.js`, each measured over this same 40 s:
   *
   *  build                        stallPct travelStall shuffleStall  wall  side  pinned  worstGround
   *  shipping                       15.7     1.38 s      0.80 s      4364   482      0     38.6 m
   *  A: watchdog back on `speed`    25.4     7.43 s      0.80 s      4679     0      0     33.5 m
   *  B: no stance deadline          19.7     1.38 s      5.28 s      5339   732      0     42.8 m
   *  C: slopeLimit in degrees       21.0     1.40 s      0.80 s         0     0      0     37.6 m
   *  D: no sidestep                 20.6     1.40 s      0.80 s      4315     0      0     37.8 m
   *  E: shuffle measured in 3D      19.3     1.40 s      0.82 s      5014   512    737     42.9 m
   *  A+B                            24.7     5.17 s      2.98 s      4230     0      0     29.9 m
   *  C+D                            21.0     1.40 s      0.80 s         0     0      0     37.6 m
   *  B+E                            21.3     1.40 s      5.77 s      5651   690   1823     44.2 m
   *  D+E                            25.4     1.40 s      0.98 s      4812     0    992     35.8 m
   *
   * The asserted columns do not cross. `travelStall` moves for A and A+B only;
   * `shuffleStall` for B, A+B and B+E only; `wall` is zero for C and C+D only;
   * `pinned` is nonzero for E, B+E and D+E only. So claims 2, 3, 5 and 7 each
   * have exactly one owner, and 6 has one too by the argument below.
   *
   * Build E is worth reading twice: it is the one-line revert of the horizontal
   * shuffle measurement, and it reproduces the PREVIOUS shipping build's numbers
   * to the digit — 19.3 / 1.40 / 0.82 / 5014 / 512 / 42.9. That is the check
   * that the revert is faithful and the run is deterministic, and it is why the
   * whole table had to be re-measured rather than inherited.
   *
   * Claim 6 is the one honest exception and it is worth stating: `side` is also
   * zeroed by C, because the sidestep reads `touchingWall`, which C kills — C is
   * upstream of D, not a second owner. What makes claim 6 D's own is that on
   * build D it is the ONLY failing claim: D's travelStall, shuffleStall, wall
   * and pinned are all inside their thresholds and it passes without it. (A
   * zeroes `side` for the same upstream reason — a watchdog that cannot see the
   * stall never lets `stallTimer` reach 0.25 s — and A is caught by claim 2
   * first.) Claim 7 stands the same way on E: E passes every other claim here,
   * including the ones it reads BETTER on than shipping. */
  const pass =
    // 1. they are travelling at all. Every claim below gets easier the less a
    //    man walks, and claim 5 alone would pass a build that only jitters.
    travelFrames >= 2000 &&
    // 2. MEASURED 1.40 s, which is the watchdog in `_move` giving up on a route
    //    at 1.4 s and nothing else. Build A, where it cannot see the stall
    //    because it watches `speed`, runs 7.43 s. 2.5 s is the watchdog plus
    //    grace and still a third of the broken reading.
    travelS < 2.5 &&
    // 3. MEASURED 0.80 s alone and 1.08 s in the full suite: the 0.8 s deadline
    //    in `_combat`, plus the next peek cycle's fresh budget landing back to
    //    back. Build B, the same branch with no deadline, runs 5.28 s — it
    //    re-orders the same impossible 0.6 m walk every frame, and one man held
    //    a constant 0.611 m from his stance across FOUR peek cycles with
    //    `progress` at 0.000. 1.5 covers the suite reading with room and is a
    //    fifth of the broken one.
    shuffleS < 1.5 &&
    // 4. …and it all added up to somewhere. MEASURED worst man 38.6 m in 40 s
    //    alone, 43.8 in the suite; the lowest any build here read was 29.9. A
    //    guard, not evidence, and the note under this condition says plainly
    //    that it reads LOWER here than on build E — no revert moves it reliably
    //    in the right direction, because a wedged man is wedged for seconds and
    //    then walks for the other thirty-five. It is here because a build where
    //    nobody moves at all passes every claim above perfectly.
    worstGround >= 10 &&
    // 5. HE CAN TELL A WALL FROM THE FLOOR. `CharacterController.cosSlope` is
    //    `Math.cos(slopeLimit)` and the constructor wants RADIANS; `agent.js`
    //    handed it 48 and every agent ran on `Math.cos(48) = -0.640`, which
    //    calls a surface walkable down to 130 degrees. MEASURED on build C:
    //    `_classifyContact` never once reached its wall branch — ZERO wall
    //    contacts in 14400 controller moves, against 4364 here — so
    //    `touchingWall` and `wallNormal` were dead, `onSteepSlope` was never
    //    true, and `probeGround` accepted a vertical face below a man as the
    //    floor he was standing on. Nothing in the AI could ask where a wall was.
    //    The floor of 500 is a tenth of the shipping reading and the broken
    //    build is not near it; it is not a percentage, because how much wall a
    //    squad brushes is this level's geometry and the claim is only that the
    //    question can be answered at all.
    wallContact >= 500 &&
    // 6. A WEDGED MAN WALKS ALONG THE WALL, NOT INTO IT. MEASURED on 1223 wedged
    //    frames before this existed: steer length 1, waypoint 4.0 m out, speed
    //    3.57 m/s, ground covered 0.22 m/s — the horizontal slide was handed
    //    59.5 mm and returned 7.5 mm, because collide-and-slide keeps only what
    //    lies along the plane and he was inside five degrees of dead-on.
    //    Build D is this build with the branch disabled and nothing else, and it
    //    is the comparison that shows what it buys: stalls 15.7 % against
    //    20.6 %, and per-man worst stalls of [1.38, 0.92, 0.63, 0.33, 0.32,
    //    0.27] against [1.40, 1.40, 1.38, 1.38, 1.38, 0.18] — five of six men
    //    pinned at the watchdog ceiling become one, which is the point: the
    //    sidestep frees him BEFORE the route has to be thrown away. MEASURED 482
    //    frames here and exactly 0 on D; 60 is one second of squad time.
    sidestep >= 60 &&
    // 7. NOBODY IS ORDERED TO WALK TO A SPOT HE IS ALREADY STANDING ON. The
    //    peek shuffle in `_combat` measured its own trip with
    //    `position.distanceTo(stancePos)` — three dimensions — and handed the
    //    same destination to `_setPath1`, whose mover arrives HORIZONTALLY
    //    (`to.y = 0`). `stancePos` is a cover height and `position` is a pair of
    //    boots, so the two never agreed: MEASURED over 40 s, on 263 of the 269
    //    stall frames that had no wall to sidestep along, he stood 0.094 m from
    //    the stance horizontally — inside the 0.1 m epsilon, so `_move` declared
    //    arrival, dropped the target and coasted him to a stop — while `_combat`
    //    read 0.192 m, because the stance sat a median 0.175 m above his boots,
    //    and re-ordered the identical walk the next frame with
    //    `desiredSpeed = 1.5`. He burned the whole 0.8 s stance budget standing
    //    9 cm from a pose he had already reached, never reached it, and never
    //    got the budget refunded either, since the refund needs the same test to
    //    come back small. All 269 were in COMBAT.
    //    The count is of orders the mover threw away on arrival in the frame
    //    they were placed — see the note where it is taken. MEASURED 0 here and
    //    on all six other control builds; build E, this fix reverted and nothing
    //    else, reads 737. The floor is 60 rather than 0 because the healthy
    //    build has a legitimate 0.02 m window in which a man crosses from
    //    "ordered" to "arrived" inside one frame (0.12 m test, 0.1 m epsilon,
    //    0.025 m of travel per frame at 1.5 m/s) — it did not fire once in ten
    //    runs, but it is reachable, and 60 is still twelve times under the
    //    broken reading.
    pinned < 60;
  // `travelStallPct` is REPORTED AND NOT ASSERTED. It now separates where it did
  // not before — shipping is the lowest of the ten at 15.7 % and the nearest
  // broken build is E at 19.3 — but it stays out of `pass` for two reasons that
  // are not "it does not work". It is REDUNDANT: every build above the line is
  // already caught by a claim that has exactly one owner, so asserting it adds
  // no coverage and a second, vaguer reason for the same failures. And it is the
  // number most exposed to route drift: it moved 19.3 -> 15.7 on a fix that
  // touched a distance test in `_combat`, and it reads 15.7 alone against 16.2
  // in the full suite, because `ai.cover` and the agent-id counter are shared
  // across scenarios. A threshold on it would fail on an honest change.
  //
  // The structural reason it is weak is unchanged: the watchdog does not stop a
  // man wedging, it stops him STAYING wedged, and then hands him back the same
  // route, so one 6 s stall becomes four 1.4 s stalls and the frame count barely
  // moves. How OFTEN a man wedges is a property of this level's geometry; how
  // LONG he stays is the property this file can defend, and claims 2, 6 and 7 do.
  //
  // Three corrections that were paid for and should not be re-derived:
  //
  //   - the "it is mostly the speed ramp" theory is WRONG. Splitting the stall
  //     frames by the age of the march order (consecutive travel frames) gives
  //     42.0 % stalls on frames younger than 8, which is the ramp and is real —
  //     but only 283 frames are that young, so it is 8.2 % of all stalls, not
  //     the ~60 % the estimate predicted. Recomputing the rate over settled
  //     frames only (age > 30) moves shipping 20.0 -> 19.1 and the broken build
  //     B 19.5 -> 19.7: it flips the sign of a 0.5-point gap into a 0.6-point
  //     one. That is not a metric, so the filter is not applied.
  //   - ground covered is NOT the outcome number, in either half, and claim 4 is
  //     a guard for exactly this reason. Total ground was disqualified when the
  //     builds that could not tell a wall from the floor covered the MOST of it,
  //     a man shoved back and forth racking up path length; that particular
  //     inversion is gone from the table above (shipping now covers the most at
  //     352.3 m against C's 311.8) but the property that caused it has not
  //     changed, and neither has the verdict.
  //   - and the honest half of it does not defend this build either. The worst
  //     man's ground reads 38.6 m here against 42.9 m on build E — LOWER on the
  //     build with the fix. It is a redistribution and not a loss: the same fix
  //     puts 24 m back into the squad's total (328.2 -> 352.3, the highest of
  //     the ten) and takes 3.6 points off the stall rate, and the worst man
  //     still walks 38.6 m in 40 s against a floor of 10. But it means claim 4
  //     is evidence for nothing here, and the case for this fix rests on claim 7
  //     and on the per-man stall ceiling, where it is unambiguous:
  //     [1.40, 1.38, 0.85, 0.73, 0.63, 0.28] on E against
  //     [1.38, 0.92, 0.63, 0.33, 0.32, 0.27] here — two men at the watchdog
  //     ceiling become one, and the whole tail halves.

  engine.dispose();
  return {
    name: 'ai-move', pass,
    travelFrames,
    travelStallFrames: travelStalls,
    travelStallPct: stallPct,
    longestTravelStallS: travelS,
    longestShuffleStallS: shuffleS,
    wallContactFrames: wallContact,
    wallContactPct: aliveFrames ? +(100 * wallContact / aliveFrames).toFixed(1) : 0,
    sidestepFrames: sidestep,
    pinnedShuffleFrames: pinned,
    stallsByState: byState,
    worstTravelPerAgent: [...worst.entries()]
      .map(([id, w]) => ({ id, s: +(w.frames / FPS).toFixed(2), state: w.state }))
      .sort((a, b) => b.s - a.s),
    groundCoveredM: covered,
  };
}

/* ====================================================================== */
/* 14. browser key conflicts                                              */
/* ====================================================================== */

/**
 * For every browser shortcut we can collide with, press it the way a player
 * would and record two things: did the game get the key, and did anything stop
 * the browser acting on it. A key that is bound to gameplay and leaves
 * `defaultPrevented === false` is a page that bookmarks itself mid-firefight.
 */
export async function scenarioKeys() {
  const { engine, rec } = await bootPlay();
  const bound = new Set(Object.values(ACTIONS).flat());
  const drv = makeDriver(engine);
  engine.input.pointerLocked = true;

  const rows = [];
  for (const [mod, code, what, reserved] of BROWSER_SHORTCUTS) {
    if (mod === 'ctrl') drv.down('ControlLeft');
    if (mod === 'shift') drv.down('ShiftLeft');
    const extra = mod === 'alt' ? { alt: true } : {};
    const r = drv.down(code, extra);
    drv.up(code, extra);
    if (mod === 'ctrl') drv.up('ControlLeft');
    if (mod === 'shift') drv.up('ShiftLeft');

    const isBound = bound.has(code);
    rows.push({
      combo: mod === 'none' ? code : `${mod}+${code}`,
      browserAction: what,
      boundInGame: isBound,
      gameReceived: r.registered,
      browserDefaultPrevented: r.prevented,
      reservedByBrowser: reserved,
      // A reserved shortcut (Ctrl+W) cannot be cancelled by preventDefault at
      // all; only the Keyboard Lock API in fullscreen stops it reaching Chrome.
      ok: reserved ? true : (!isBound || r.prevented),
      needsKeyboardLock: reserved && isBound,
    });
  }

  // Keys the game claims must actually arrive while playing.
  const lost = rows.filter((r) => r.boundInGame && !r.gameReceived);
  const leaks = rows.filter((r) => !r.ok);
  const locks = rows.filter((r) => r.needsKeyboardLock);

  engine.dispose();
  return {
    name: 'browser-keys',
    pass: leaks.length === 0 && lost.length === 0,
    leakingCombos: leaks.map((r) => `${r.combo} (${r.browserAction})`),
    swallowedGameKeys: lost.map((r) => r.combo),
    needKeyboardLock: locks.map((r) => r.combo),
    rows,
  };
}

export const SCENARIOS = {
  crouch: scenarioCrouch,
  strafe: scenarioStrafe,
  slide: scenarioSlide,
  slidestrafe: scenarioSlideStrafe,
  death: scenarioDeath,
  regen: scenarioRegen,
  ai: scenarioAi,
  aideath: scenarioAiDeath,
  aisquad: scenarioSquad,
  aiflank: scenarioFlank,
  aihit: scenarioHit,
  aigrenade: scenarioGrenade,
  airetreat: scenarioRetreat,
  aimove: scenarioMove,
  keys: scenarioKeys,
};

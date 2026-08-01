/**
 * AI — one enemy: body, senses, brain, gun.
 *
 * PERCEPTION is deliberately imperfect. A target has to be inside a 100 degree
 * cone, in line of sight through the physics BVH, and then *stay* there for a
 * reaction delay that scales with angle off-centre and distance before the
 * agent acknowledges it. Gunshots and footsteps arrive as events and only give
 * a direction, which becomes a "last known position" that decays — so enemies
 * search where you were, not where you are.
 *
 * BEHAVIOUR is a small state machine:
 *   idle / patrol -> alert -> combat -> suppressed -> flank -> retreat -> dead
 * Combat runs a peek-and-shoot loop from a scored cover point, with the squad
 * handing out permission to peek so they never all lean out at once, plus
 * suppressing fire, grenades and repositioning when the player stops moving.
 * Losing a squadmate is an input like any other: see squadmateDown(), which
 * turns a body hitting the floor into a flinch, a bearing to search, and a
 * refusal to keep holding the cover he was killed behind. A squad cut down to a
 * third of its strength breaks contact at full health rather than trade shots
 * alone with whoever killed the others.
 *
 * DAMAGE is per-bone: capsule colliders for head, chest, pelvis, arms and legs
 * are pushed into `physics` every frame, so a headshot is a headshot because of
 * where the round landed, not because of a random roll. Death hands the live
 * skeleton to the ragdoll solver with the bullet's impulse.
 */

import * as THREE from 'three';
import { RIG } from './rig.js';
import { Animator } from './animator.js';

const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  COMBAT: 'combat',
  SUPPRESSED: 'suppressed',
  FLANK: 'flank',
  RETREAT: 'retreat',
  DEAD: 'dead',
};

export { STATE };

const HITBOXES = [
  ['head', 'Head', 'HeadTop', 0.098, 4.0],
  ['torso', 'Spine1', 'Neck', 0.185, 1.0],
  ['torso', 'Hips', 'Spine1', 0.175, 0.9],
  ['arm', 'UpperArmR', 'HandR', 0.072, 0.65],
  ['arm', 'UpperArmL', 'HandL', 0.072, 0.65],
  ['leg', 'UpLegR', 'FootR', 0.105, 0.7],
  ['leg', 'UpLegL', 'FootL', 0.105, 0.7],
];

/**
 * Ragdoll bone spec, in the order the solver wants it.
 *   [ headBone, tailBone, radius, massFraction, parentIndex, cone°, twist°, map ]
 * `map` false marks a stub whose only job is to weld a limb chain to the torso:
 * the solver shares a particle between two bones only when their endpoints are
 * coincident, so the shoulder and hip need a bone that starts exactly on the
 * spine joint. Deriving our own spec (instead of letting physics infer one from
 * all 25 bones) also gets the capsule radii right, which is the difference
 * between a body and a pancake.
 */
const DOLL = [
  ['Hips', 'Spine', 0.135, 0.14, -1, 0, 0, true],
  ['Spine', 'Spine1', 0.125, 0.10, 0, 22, 16, true],
  ['Spine1', 'Spine2', 0.135, 0.14, 1, 18, 12, true],
  ['Spine2', 'Neck', 0.130, 0.10, 2, 16, 10, true],
  ['Neck', 'Head', 0.052, 0.03, 3, 30, 25, true],
  ['Head', 'HeadTop', 0.098, 0.07, 4, 42, 30, true],
  // stubs get a free cone: their direction is lateral while the parent points
  // up the spine, so any limit here is violated in the bind pose and the solver
  // would inject energy trying to fix it
  ['Spine2', 'UpperArmR', 0.055, 0.02, 3, 179, 179, false],
  ['UpperArmR', 'ForearmR', 0.058, 0.027, 6, 100, 60, true],
  ['ForearmR', 'HandR', 0.048, 0.018, 7, 80, 45, true],
  ['HandR', 'FingersR', 0.038, 0.006, 8, 55, 40, true],
  ['Spine2', 'UpperArmL', 0.055, 0.02, 3, 179, 179, false],
  ['UpperArmL', 'ForearmL', 0.058, 0.027, 10, 100, 60, true],
  ['ForearmL', 'HandL', 0.048, 0.018, 11, 80, 45, true],
  ['HandL', 'FingersL', 0.038, 0.006, 12, 55, 40, true],
  ['Hips', 'UpLegR', 0.065, 0.02, 0, 179, 179, false],
  ['UpLegR', 'LegR', 0.088, 0.10, 14, 95, 35, true],
  ['LegR', 'FootR', 0.068, 0.045, 15, 70, 20, true],
  ['FootR', 'ToeR', 0.050, 0.012, 16, 40, 20, true],
  ['Hips', 'UpLegL', 0.065, 0.02, 0, 179, 179, false],
  ['UpLegL', 'LegL', 0.088, 0.10, 18, 95, 35, true],
  ['LegL', 'FootL', 0.068, 0.045, 19, 70, 20, true],
  ['FootL', 'ToeL', 0.050, 0.012, 20, 40, 20, true],
];

const DEG = Math.PI / 180;

/** How far a man going down still registers, in metres. See squadmateDown(). */
const MANDOWN_RANGE = 30;

/**
 * Falling back is a move, and a move has to buy something. These two numbers are
 * what stop it from becoming a mood — see `_breakContact` for the measurement
 * that put them there.
 */
/** Past this range there is no contact to break: he holds and shoots instead. */
const BREAK_RANGE = 20;
/** And having fallen back, he fights from where he landed for this long. */
const BREAK_COOLDOWN = 15;

let _nextId = 1;

export class Agent {
  constructor(ai, opts = {}) {
    this.ai = ai;
    this.ctx = ai.ctx;
    this.id = _nextId++;
    this.rng = ai.rng.fork();
    this.variantName = opts.variant ?? 'vanguard';
    const def = ai.variant(this.variantName);
    this.def = def;
    this.scale = def.variant.scale ?? 1;

    /* ---------------- body ---------------- */
    const { bones, skeleton, root } = RIG.createSkeleton();
    this.bones = bones;
    this.skeleton = skeleton;
    this.mesh = new THREE.SkinnedMesh(def.geometry, def.materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
    this.mesh.userData.agent = this;
    this.group = new THREE.Group();
    this.group.name = `enemy${this.id}`;
    this.group.add(root);
    this.group.add(this.mesh);
    this.mesh.bind(skeleton);
    this.group.scale.setScalar(this.scale);
    ai.root.add(this.group);

    /** Physics looks for these when it adopts the skeleton on death. */
    this.skinnedMesh = this.mesh;
    this.mass = 82 * this.scale;

    this.position = new THREE.Vector3().copy(opts.position ?? new THREE.Vector3());
    this.yaw = opts.yaw ?? 0;
    this.targetYaw = this.yaw;
    /** where he means to face, before the search sweep is added. See _move. */
    this.faceYaw = this.yaw;
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    // The bones' world matrices are derived from the group's, so the group has
    // to be current before anything reads them — including the very first
    // animator pass and a same-frame ragdoll hand-off.
    this.group.updateMatrixWorld(true);

    this.animator = new Animator(RIG, bones, {
      weapon: def.weapon,
      rng: this.rng.fork(),
      scale: this.scale,
      probe: (x, z, fromY, out) => this.ai.probeGround(x, z, fromY, out),
    });

    /* ---------------- physics ---------------- */
    const phys = this.ctx.peek('physics');
    this.phys = phys;
    this.height = 1.78 * this.scale;
    this.radius = 0.34 * this.scale;
    this.controller = phys
      ? phys.createCharacter({
        radius: this.radius,
        height: this.height,
        position: this.position,
        stepHeight: 0.42,
        // RADIANS. `CharacterController.cosSlope` is `Math.cos(slopeLimit)` and
        // its own default is `50 * (Math.PI / 180)`; the player converts (see
        // `player/movement.js`). Passing the degrees straight through gave every
        // agent `Math.cos(48) = -0.640` as the walkable-surface threshold, and
        // MEASURED on a live controller that is exactly the number it held.
        //
        // A cosine of -0.64 calls a surface walkable down to 130 degrees, so for
        // an agent EVERY contact was ground: `_classifyContact` never reached
        // its wall branch even once in 3600 controller moves, which left
        // `touchingWall` and `wallNormal` permanently dead and let `probeGround`
        // accept a vertical face below him as the floor he is standing on.
        slopeLimit: 48 * (Math.PI / 180),
      })
      : null;
    this.velocity = new THREE.Vector3();
    this.grounded = true;

    this.colliders = [];
    if (phys) {
      for (const [part, a, b, r, dmg] of HITBOXES) {
        const c = phys.addCollider({
          shape: 'capsule',
          layer: phys.LAYER.ACTOR,
          surface: 'flesh',
          owner: this,
          part,
          radius: r * this.scale,
          damageScale: dmg,
        });
        c.userData = { a, b };
        this.colliders.push(c);
      }
    }

    /* ---------------- stats ---------------- */
    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.squad = opts.squad ?? null;
    this.team = opts.team ?? 1;

    /* ---------------- perception ---------------- */
    this.eyeHeight = RIG.eyeHeight * this.scale;
    this.viewRange = 58;
    this.viewCos = Math.cos((100 * Math.PI) / 180 / 2);
    this.awareness = 0; // 0..1 build-up before the target is acknowledged
    this.hasTarget = false;
    this.targetVisible = false;
    this.target = null;
    this.lastKnown = new THREE.Vector3();
    this.lastKnownAge = Infinity;
    this.searchPoint = new THREE.Vector3();
    this.suppression = 0;
    this.reactionTimer = 0;
    this.alertness = 0;

    /* ---------------- combat ---------------- */
    this.weaponRange = 60;
    this.fireRate = this.variantName === 'irregular' ? 8.2 : 10.5;
    this.burstLeft = 0;
    this.fireCooldown = 0;
    this.burstCooldown = this.rng.range(0.4, 1.4);
    this.magSize = 30;
    this.ammo = this.magSize;
    this.spread = 0.032;
    this.weaponDamage = 17;
    this.aimTarget = new THREE.Vector3();
    this.aimActual = new THREE.Vector3();
    this.aimWeight = 0;
    this.wantFire = false;
    this.peekSide = 0;
    this.peeking = false;
    this.peekTimer = this.rng.range(0.5, 2.5);
    this.grenadeCooldown = this.rng.range(9, 22);
    this.hasGrenade = true;

    /* ---------------- navigation ---------------- */
    this.path = [];
    this.pathLen = 0;
    this.pathIndex = 0;
    this.repathTimer = 0;
    /** how long until he is willing to fall back again — see _breakContact() */
    this.breakTimer = 0;
    this.moveTarget = new THREE.Vector3().copy(this.position);
    this.hasMoveTarget = false;
    this.desiredSpeed = 0;
    this.speed = 0;
    this.crouch = false;
    this.cover = null;
    /** the cover point itself — the anchor `atCover` is measured against */
    this.coverPos = new THREE.Vector3();
    /** where to stand right now: the cover point, or its peek offset */
    this.stancePos = new THREE.Vector3();
    /** how long he has been trying to shuffle onto `stancePos` — see _combat */
    this.stanceTimer = 0;
    /** how long we have held this cover, and how long we are willing to */
    this.coverHold = 0;
    this.coverHoldMax = this.rng.range(5, 9);
    this.patrolPoints = opts.patrol ?? null;
    this.patrolIndex = 0;
    this.stuckTimer = 0;
    this.vaultCooldown = 0;
    /** a path request the frame budget pushed to the next frame */
    this.pathPending = false;
    this._pendingDest = new THREE.Vector3();
    /** back-off after A* proved there is no route: see _goTo */
    this.pathFailTimer = 0;
    /** consecutive no-route answers; buys a bigger search each time, see _goTo */
    this.pathFails = 0;
    /** reused so escalating the node budget costs no per-frame allocation */
    this._pathOpts = { maxNodes: 6000 };
    /** wants to move, is not moving: see _move */
    this.stallTimer = 0;
    /** walking along a wall instead of into it this frame — see _move */
    this.sidestepping = false;
    /** ground actually covered last frame, m/s — NOT `speed`. See _move. */
    this.progress = 0;
    this._prevX = this.position.x;
    this._prevZ = this.position.z;
    /** waypoint arrival radius, tightened for the short shuffles at cover */
    this.arriveEps = 0.45;
    /** which walkable network we are standing on (NavGrid.region), -1 unknown */
    this.navRegion = -1;
    this.navRegionTimer = 0;

    /* ---------------- morale ---------------- */
    /** the beat of shock after a squadmate drops: see squadmateDown() */
    this.manDownTimer = 0;

    /* ---------------- LOD ---------------- */
    /** set by AiSystem._updateRelevance: nothing this actor does reaches a pixel */
    this.lodIrrelevant = false;
    this._animSkip = 0;
    this._animAccum = 0;

    /* ---------------- scratch ---------------- */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._steer = new THREE.Vector3();
    this._boneA = new THREE.Vector3();
    this._boneB = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();

    this.clip = 'idle';
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  get eye() {
    return this._eye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  update(dt, ctx) {
    if (!this.alive) return;
    this.stateTime += dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.55);
    this.fireCooldown -= dt;
    this.burstCooldown -= dt;
    this.grenadeCooldown -= dt;
    // Resupply. `_throwGrenade` sets this cooldown to 16-34 s and clears
    // `hasGrenade`, and until now nothing ever read the clock again: a man threw
    // exactly one grenade per round, for the rest of his life, and the timer he
    // was charged for it ran down into a number nobody looked at. The clock IS
    // the resupply — it is the only reason a throw sets it rather than just
    // dropping the flag. The squad ration (14-26 s, `Squad.requestGrenade`) is
    // what actually paces throws across the fireteam; this only decides whether
    // an individual man is carrying anything to be rationed.
    if (!this.hasGrenade && this.grenadeCooldown <= 0) this.hasGrenade = true;
    this.peekTimer -= dt;
    this.repathTimer -= dt;
    this.vaultCooldown -= dt;
    this.pathFailTimer -= dt;
    this.manDownTimer -= dt;
    this.breakTimer -= dt;
    if (this.lastKnownAge < 1e6) this.lastKnownAge += dt;

    // A deferred path is not re-asked here: AiSystem._servePathQueue() has
    // already served the frame's budget to whoever has been waiting longest,
    // before any agent updated. Asking again from inside the loop is what let
    // the men at the front of the array take the whole budget every frame.

    // Which walkable network we are on, for cover and goal selection. Note
    // `operatingRegion` and not `regionAt`: a man who has run up onto a crate is
    // standing on a five-square-metre island that holds nothing to fight from,
    // and answering "your region is the crate lid" makes every query he owns
    // come back empty — see the measurement in NavGrid.
    this.navRegionTimer -= dt;
    if (this.navRegionTimer <= 0) {
      this.navRegionTimer = 0.5;
      const g = this.ai.grid;
      this.navRegion = g ? g.operatingRegion(this.position.x, this.position.z, this.position.y, 3) : -1;
    }

    this._sense(dt);
    this._think(dt);
    this._move(dt);
    this._shoot(dt);
    this._drive(dt);
  }

  /* ================================================================== */
  /* perception                                                         */
  /* ================================================================== */

  _sense(dt) {
    const player = this.ai.playerPosition(this._v3);
    if (!player) return;
    const eye = this.eye;
    const to = this._dir.copy(player).sub(eye);
    const dist = to.length();
    let visible = false;
    if (dist < this.viewRange) {
      to.multiplyScalar(1 / dist);
      const fwd = this._v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const dot = fwd.x * to.x + fwd.z * to.z;
      // peripheral vision widens once alerted
      const cone = this.hasTarget ? -0.2 : this.viewCos - this.alertness * 0.25;
      if (dot > cone || dist < 4.5) {
        visible = this.phys ? this.phys.lineOfSight(eye, player, this.phys.MASK.SIGHT) : true;
      }
    }
    this.targetVisible = visible;

    if (visible) {
      // reaction: fast head-on and close, slow at the edge of vision
      const rate = 1 / Math.max(0.12, 0.16 + dist * 0.0075 + (1 - this.alertness) * 0.28);
      this.awareness = Math.min(1, this.awareness + dt * rate);
      this.lastKnown.copy(player);
      this.lastKnownAge = 0;
      this.alertness = 1;
      if (this.awareness >= 1) {
        this.hasTarget = true;
        this.target = player;
      }
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35);
      if (this.hasTarget && this.lastKnownAge > 6.5) this.hasTarget = false;
    }
  }

  /** A gunshot or footstep heard from `pos` with a given loudness (metres). */
  hear(pos, loudness) {
    if (!this.alive) return;
    const d = this.position.distanceTo(pos);
    if (d > loudness) return;
    const strength = 1 - d / loudness;
    this.alertness = Math.max(this.alertness, Math.min(1, 0.35 + strength));
    if (this.lastKnownAge > 1.2 || strength > 0.6) {
      this.lastKnown.copy(pos);
      this.lastKnownAge = Math.min(this.lastKnownAge, 0.35);
    }
    // hearing alone never grants a target; it turns the head and the body
    this.awareness = Math.min(0.85, this.awareness + strength * 0.5);
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);
  }

  /** Rounds cracking past raise suppression, which drives the flinch + duck. */
  suppress(amount) {
    if (!this.alive) return;
    this.suppression = Math.min(1.6, this.suppression + amount);
    this.alertness = 1;
  }

  /**
   * A squadmate just went down, `strength` of the squad left standing.
   *
   * This is the one event a soldier cannot plausibly ignore, and it used to be
   * ignored completely — MEASURED: agent 1 shot dead 1.1 m from agent 3, and
   * agent 3 walked on with `lastKnownAge` at infinity. Four things follow from
   * a body hitting the floor, in the order a man would do them:
   *
   *  1. flinch — get small, stop shooting, for a beat
   *  2. the round came from somewhere — a direction to check, never a free kill
   *  3. the spot he died on is proven lethal — do not hold cover next to it
   *  4. and if there is nearly nobody left, this fight is lost (see _combat)
   */
  squadmateDown(pos, threat, strength) {
    if (!this.alive) return;
    const d = this.position.distanceTo(pos);
    // A kill two streets away is a distant shot, not a man down beside you.
    if (d > MANDOWN_RANGE) return;
    const near = 1 - d / MANDOWN_RANGE;
    // losing the last of six is a louder event than losing the first
    const shock = 1 + (1 - strength) * 0.5;

    // 1. seeing it is suppressing, and scaled: beside you or barely in earshot
    this.suppress((0.2 + near * 0.55) * shock);
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);

    // 2. the same rule hear() follows: a bearing to search, with a delay on it,
    //    so a casualty gives the squad a direction and never a wallhack
    if (threat && !this.hasTarget && this.lastKnownAge > 1.2) {
      this.lastKnown.copy(threat);
      this.lastKnownAge = 0.6 + this.rng.float() * 0.7;
    }

    // 3. that wall has a firing lane onto it. Holding the cover the last man
    //    was killed behind is how a squad feeds itself into a kill zone one
    //    body at a time; hand it back and let _combat score a fresh one.
    if (this.cover && this.coverPos.distanceTo(pos) < 5) {
      this.ai.cover?.release(this.id);
      this.cover = null;
      this.coverHold = 0;
      this.repathTimer = 0;
    }

    // 4. the flinch itself, longest for the man who was standing next to him
    this.manDownTimer = (0.25 + near * (0.3 + this.rng.float() * 0.45)) * shock;
  }

  /* ================================================================== */
  /* behaviour                                                          */
  /* ================================================================== */

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    if (s !== STATE.COMBAT && s !== STATE.SUPPRESSED) this.peeking = false;
  }

  _think(dt) {
    const sq = this.squad;
    switch (this.state) {
      case STATE.IDLE:
        this.desiredSpeed = 0;
        this.crouch = false;
        if (this.hasTarget) this._enterCombat();
        else if (this.patrolPoints && this.stateTime > 2.5) this._setState(STATE.PATROL);
        break;

      case STATE.PATROL: {
        this.crouch = false;
        this.desiredSpeed = 1.35;
        if (this.hasTarget) {
          this._enterCombat();
          break;
        }
        // a route point whose path is still queued is not a route point reached:
        // taking the next one here would walk the patrol index forward for free
        if (this.pathPending || this.pathFailTimer > 0) break;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.1) {
          const p = this.patrolPoints?.[this.patrolIndex % this.patrolPoints.length];
          if (p) {
            this.patrolIndex++;
            this._goTo(p);
          } else this._setState(STATE.IDLE);
        }
        break;
      }

      case STATE.ALERT: {
        this.crouch = false;
        this.desiredSpeed = 1.5;
        if (this.hasTarget) {
          this._enterCombat();
          break;
        }
        // move to the last known position, then look around
        if (this.lastKnownAge < 8 && !this.hasMoveTarget && !this.pathPending && this.pathFailTimer <= 0) {
          this._goTo(this.lastKnown);
        }
        if (this.stateTime > 12) this._setState(this.patrolPoints ? STATE.PATROL : STATE.IDLE);
        break;
      }

      case STATE.COMBAT:
        this._combat(dt);
        break;

      case STATE.SUPPRESSED:
        this.crouch = true;
        this.desiredSpeed = 0;
        this.wantFire = false;
        this.peeking = false;
        if (this.suppression < 0.45) this._setState(STATE.COMBAT);
        break;

      case STATE.FLANK: {
        this.crouch = false;
        this.desiredSpeed = 4.4;
        this.wantFire = false;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.2 || this.stateTime > 7) {
          this._setState(STATE.COMBAT);
          this.cover = null;
          // and look for some straight away — _combat no longer treats "I have
          // no cover" as a licence to skip its own repath clock
          this.repathTimer = 0;
        }
        if (this.suppression > 1.0) this._setState(STATE.COMBAT);
        break;
      }

      case STATE.RETREAT: {
        this.crouch = false;
        this.desiredSpeed = 4.6;
        this.wantFire = false;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.2) {
          this._setState(STATE.COMBAT);
        }
        if (this.health > 45 && this.stateTime > 4) this._setState(STATE.COMBAT);
        break;
      }
    }

    // The beat of shock after a man goes down: nobody leans out into the lane
    // their mate was shot in half a second later. Holding fire and getting
    // small for ~0.3-0.8 s is the difference between a kill that lands on the
    // squad and a kill that lands on a scoreboard.
    //
    // It lives out here, after the switch, because shock is not a combat state.
    // While it sat inside _combat, the case it was written for — the point man
    // of a PATROL dropping a metre from the man behind him — went through the
    // ALERT branch instead and kept walking at 1.35 m/s past the body.
    if (this.manDownTimer > 0) {
      this.wantFire = false;
      this.peeking = false;
      // ...unless he is already running somewhere on purpose. A man sprinting
      // into cover, swinging wide or breaking contact does not improve his odds
      // by stopping in the open to think about it.
      const relocating =
        this.state === STATE.FLANK ||
        this.state === STATE.RETREAT ||
        (this.state === STATE.COMBAT && !!this.cover && this.position.distanceTo(this.coverPos) > 0.85);
      if (!relocating) {
        this.crouch = true;
        this.desiredSpeed = 0;
      }
    }

    // A squad that no longer exists is a fact a man knows whether or not he
    // currently has anyone in his sights. This test used to live inside _combat
    // only, and _combat is a method a man without a target never reaches — so
    // the last survivor of a patrol that was shot to pieces around him, who had
    // never actually seen the shooter, searched on alone for the twelve seconds
    // ALERT lasts and then went back to walking his route.
    if (
      (this.state === STATE.ALERT || this.state === STATE.SUPPRESSED) &&
      this.squadIsBroken &&
      this.stateTime > 1.5 &&
      this.rng.float() < dt * 0.9
    ) {
      const from = this._threatPoint();
      if (from) this._breakContact(from);
    }

    if (this.suppression > 1.15 && this.state === STATE.COMBAT && this.cover) {
      this._setState(STATE.SUPPRESSED);
    }
  }

  _enterCombat() {
    this._setState(STATE.COMBAT);
    this.cover = null;
    this.repathTimer = 0;
  }

  _combat(dt) {
    const target = this.hasTarget ? this.lastKnown : this.lastKnownAge < 5 ? this.lastKnown : null;
    if (!target) {
      this._setState(STATE.ALERT);
      return;
    }
    const sq = this.squad;
    const dist = this.position.distanceTo(target);

    // Wounded and outgunned: fall back. "Outgunned" is a squad-level fact as
    // well as a personal one — see the same test in _think, which catches the
    // man who never acquired a target to be in this method at all.
    const broken = this.squadIsBroken;
    if ((this.health < 34 || broken) && this.stateTime > 1.5 && this.rng.float() < dt * (broken ? 0.9 : 0.5)) {
      if (this._breakContact(target)) return;
    }

    // Holding one wall for the whole firefight is what "the enemies just stand
    // there" looks like from the player's side. Once we have been in this spot
    // longer than we are willing to, hand the claim back and take the best
    // point that is NOT this one, so the squad keeps flowing.
    //
    // Overstaying gets its OWN right to ask, rather than waiting for the repath
    // clock. That clock runs 2.2-4.5 s, so a willingness that expires at 5-9 s
    // was answered up to 4.5 s late — MEASURED over 60 s: the worst man held
    // one point, motionless, for 10.7 s.
    //
    // Having NO cover buys no extra right to ask. It used to: the test read
    // `!this.cover || repathTimer <= 0 || overstayed`, so a man the map had
    // nothing for re-scanned all 1349 points 60 times a second for as long as
    // that lasted — MEASURED at 2581 consecutive frames on one agent. Every
    // path that drops a claim already resets the clock (0.4 s, 0.6 s, or zero
    // on entering combat), so the responsiveness that disjunct was buying is
    // still there.
    const overstayed = !!this.cover && this.coverHold > this.coverHoldMax;
    const settled = overstayed ? this.cover : null;
    if ((this.repathTimer <= 0 || overstayed) && this.pathFailTimer <= 0) {
      const pick = this.ai.cover?.pick(this.position, target, {
        id: this.id,
        squad: sq?.members,
        minRange: 7,
        maxRange: 30,
        maxTravel: this.cover && !settled ? 12 : 26,
        // only cover we can walk to: 340 of this level's 1349 points are on
        // rooftops and ledges, and running at one is a man standing still
        region: this.navRegion,
        exclude: settled,
        // Where the last of ours went down, while it is still recent. Without
        // this the man who abandons the lethal wall re-scores the same point
        // one frame later and walks straight back onto it — MEASURED.
        danger: sq && sq.casualtyAge < 20 ? sq.lastCasualty : null,
      });
      this.repathTimer = this.rng.range(2.2, 4.5);
      // Asked, found nothing better, so settle back in: without this the
      // overstay flag stays true and the CoverMap scan above runs EVERY frame.
      if (overstayed) this.coverHold = 0;
      if (pick && pick !== this.cover) {
        this.cover = pick;
        this.coverHold = 0;
        this.coverHoldMax = this.rng.range(5, 9);
        this.coverPos.set(pick.x, pick.y, pick.z);
        this.stancePos.copy(this.coverPos);
        this.stanceTimer = 0;
        this.peekTimer = Math.min(this.peekTimer, 0.3);
        if (!this._goTo(this.coverPos) && !this.pathPending) {
          // unreachable after all: give it back and try a different one soon
          this.cover = null;
          this.ai.cover?.release(this.id);
          this.repathTimer = 0.4;
        }
      }
      // Still nothing to get behind and nowhere to be. Either the map had no
      // cover for him at all, or the one it offered turned out to be unreachable
      // — the second case is the one that bit, because it is not the `else` of
      // anything: MEASURED, the same point was picked and refused twenty times
      // over 13.6 s while its man stood in the open. The branch below reads "no
      // cover" as "stand where you are and shoot", which is the complaint this
      // whole file answers, so take the one decision left and move. Seven metres
      // off the line and four closer is a bound toward the threat, and
      // `_flankPoint` guarantees it is ground this man can actually reach.
      if (!this.cover && !this.hasMoveTarget && !this.pathPending) {
        const side = this.rng.float() < 0.5 ? 1 : -1;
        if (this._flankPoint(target, side, 7) || this._flankPoint(target, -side, 7)) {
          this._goTo(this._v2);
        }
      }
    }

    // A cover point we cannot actually reach must not mute the agent for ever.
    // `_goTo` fails outright when A* finds no route (which happens for a cover
    // point across an unwalkable seam), and a path can also run out short of the
    // point. The branch below reads "has cover, not standing in it" as "walk,
    // weapon down, hold fire", so without this the agent stands in the open with
    // the player in plain sight and never pulls the trigger.
    if (
      this.cover &&
      !this.hasMoveTarget &&
      !this.pathPending && // still queued behind the frame's A* budget
      this.position.distanceTo(this.coverPos) > 0.85
    ) {
      this.cover = null;
      this.ai.cover?.release(this.id);
      this.repathTimer = Math.min(this.repathTimer, 0.6);
    }

    const atCover = this.cover
      ? this.position.distanceTo(this.coverPos) < 0.85
      : false;
    this.coverHold = atCover ? this.coverHold + dt : 0;

    // Not in position yet — either running at a cover point or, with no cover to
    // be had, running the bound the branch above set. That second case used to
    // fall through to "peek and shoot", whose else-arm sets `desiredSpeed = 0`
    // and clears `hasMoveTarget` — it cancelled the move on the very frame it
    // was ordered, and did it silently, because `desiredSpeed` was 0 and the
    // stall watchdog in `_move` only fires on a man who WANTS to move.
    if (!atCover && (this.cover || this.hasMoveTarget)) {
      // moving into position: run, weapon down, no shooting
      this.desiredSpeed = 4.3;
      this.crouch = false;
      this.wantFire = false;
      this.aimWeight = 0.35;
    } else {
      // peek-and-shoot, gated by the squad so they alternate
      const allowed = !sq || sq.requestPeek(this, dt);
      if (this.peekTimer <= 0) {
        this.peeking = allowed && this.targetVisible !== false;
        this.peekTimer = this.peeking ? this.rng.range(1.1, 2.4) : this.rng.range(0.7, 1.8);
        if (this.cover) {
          if (this.peeking) {
            this.peekSide = this.ai.cover.peekOffset(this.cover, target, this.eyeHeight, this._v2);
            this.stancePos.copy(this._v2);
          } else {
            this.stancePos.copy(this.coverPos);
          }
          // a new place to stand is a new walk, and gets its own 0.8 s
          this.stanceTimer = 0;
        }
      }
      // AT COVER, AND NOT FROZEN. Leaning out and pulling back in is about
      // 0.6 m of lateral ground: the man WALKS it rather than teleporting his
      // aim, which is the difference between working a corner and being a
      // statue that happens to shoot. `coverPos` stays the anchor `atCover`
      // measures against, so this shuffle can never read as "left cover".
      //
      // The shuffle gets a DEADLINE, because `peekOffset` can name a pose the
      // man cannot stand on — a lip of cover with a kerb in front of it, a
      // corner the nav grid calls open — and this branch re-orders the same
      // 0.6 m walk on the very next frame, for ever. MEASURED over 40 s of
      // plain firefight: 1044 of the 2513 frames that went nowhere were this
      // one branch (41.5 %), and the worst of them was 4.58 s of one man
      // holding a constant 0.611 m from his stance across FOUR peek cycles,
      // `progress` at 0.000. The stall watchdog in `_move` is awake for all of
      // it and cannot help: it drops the path, and this re-orders it a frame
      // later. Only the caller can stop asking.
      //
      // 0.8 s is twice what the walk needs — 0.6 m at 1.5 m/s is 0.4 s — so a
      // shuffle that is merely slow (crouched, shoved by a squadmate, easing
      // out of a stop) still finishes. Past that he simply shoots from where he
      // stands, which is 0.6 m from where he wanted to be and still in cover:
      // `atCover` measures against `coverPos`, never against `stancePos`. The
      // next peek cycle is 0.7-2.4 s away and hands him a fresh budget and
      // often the other side of the wall.
      //
      // HORIZONTAL, and it has to be. The shuffle is a WALK: `_setPath1` below
      // hands `stancePos` to the same mover every other order goes through, and
      // that mover arrives horizontally — its waypoint test does `to.y = 0`
      // before measuring. Measuring the same trip in three dimensions here made
      // the two disagree, and they disagreed permanently, because `stancePos`
      // is a COVER height (`coverPos` comes off the cover point, `peekOffset`
      // off the wall) while `position` is his feet. MEASURED over 40 s: on 263
      // of the 269 stall frames that had no wall to sidestep along, he was
      // horizontally 0.094 m from the stance — inside the 0.1 m epsilon
      // `_setPath1` was given, so `_move` declared arrival, dropped the target
      // and coasted him to a stop — while this test read 0.192 m, because the
      // stance sat a median 0.175 m above his boots, and re-ordered the
      // identical walk on the very next frame with `desiredSpeed = 1.5`. Arrive,
      // re-order, coast, arrive: he spent the whole 0.8 s budget standing 9 cm
      // from a pose he had already reached, and the refund below could never
      // fire, so he never got the budget back either. All 269 were in COMBAT.
      //
      // The invariant that kills it is an ordering, not a number: 0.12 sits
      // ABOVE the 0.1 m epsilon, so anything `_move` calls arrived, this calls
      // arrived too. Whoever moves either constant keeps them in that order.
      const sdx = this.stancePos.x - this.position.x;
      const sdz = this.stancePos.z - this.position.z;
      const shuffle = this.cover ? Math.hypot(sdx, sdz) : 0;
      if (shuffle > 0.12 && this.stanceTimer < 0.8) {
        this.stanceTimer += dt;
        this._setPath1(this.stancePos, 0.1);
        this.desiredSpeed = 1.5;
      } else {
        // Arriving refunds the budget; giving up does not. Without the reset a
        // man who reached this stance would carry a spent timer into the next
        // one and never walk again.
        if (shuffle <= 0.12) this.stanceTimer = 0;
        this.desiredSpeed = 0;
        this.hasMoveTarget = false;
      }
      // reloading is done small: down behind the wall, not stood up in the open
      this.crouch = this.animator.reloading || (this.cover ? !this.cover.high || !this.peeking : false);
      this.aimWeight = this.peeking ? 1 : 0.55;
      this.wantFire = this.peeking && this.targetVisible && this.hasTarget && dist < this.weaponRange;
      // suppressing fire at the last known spot even without a clean shot
      if (!this.wantFire && this.hasTarget && this.lastKnownAge < 2.2 && this.peeking) {
        this.wantFire = this.rng.float() < 0.35;
      }
    }

    // Everything the throw at the bottom of this method needs, except the
    // squad's ration — `requestGrenade()` spends the ration when asked, so it
    // may only be called once, at the throw itself. Hoisted because the flank
    // gate has to know whether a throw is really imminent.
    const grenadeReady =
      this.hasGrenade &&
      this.grenadeCooldown <= 0 &&
      dist > 8 &&
      dist < 26 &&
      this.lastKnownAge < 1.5;

    // Flank when the player has been static and we have friends shooting.
    //
    // A man about to throw uses the grenade rather than running fifteen metres.
    // That is the whole of the intended preference, and both earlier spellings
    // of it were far wider than that:
    //   - `grenadeCooldown < 0 === false` reads as "cooldown >= 0", which after
    //     the one throw a man ever gets is false forever. MEASURED: four of six
    //     men sat at cooldown -22 to -46 s, permanently barred from flanking.
    //   - "he is holding a live grenade" is nearly as bad, because the squad
    //     rations throws. MEASURED over 60 s: it blocked 6637 of 11354
    //     flank-eligible frames while refusing 2139 of the 2143 frames in which
    //     the throw it was waiting for could have happened. Asking for the
    //     ration too drops the blocked frames to 754 — the ones where he really
    //     does throw instead.
    if (
      sq &&
      this.stateTime > 4 &&
      !(grenadeReady && sq.grenadeCooldown <= 0) &&
      sq.canFlank(this) &&
      this.rng.float() < dt * 0.25
    ) {
      const side = this.rng.float() < 0.5 ? 1 : -1;
      const reach = this.rng.range(8, 15);
      // Preferred side first, then the other one. The second try costs a ring
      // search, never an RNG draw, so which way a man swings stays decided by
      // the one coin flip above.
      if ((this._flankPoint(target, side, reach) || this._flankPoint(target, -side, reach)) &&
        this._goTo(this._v2)) {
        this.cover = null;
        this.ai.cover?.release(this.id);
        this._setState(STATE.FLANK);
        sq.claimFlank(this);
        return;
      }
    }

    // grenade when the player is pinned and we have line of fire
    if (grenadeReady && (!sq || sq.requestGrenade(this))) {
      this._throwGrenade(target);
    }
  }

  /**
   * Is what is left of the squad still a squad? A third of three men is one,
   * and standing his ground alone against whoever just killed the other two is
   * not bravery, it is the behaviour of something that cannot count.
   */
  get squadIsBroken() {
    const sq = this.squad;
    return !!sq && sq.casualties > 0 && sq.strength <= 0.34;
  }

  /**
   * Nine metres directly away from `from`, at a run. False when there is
   * nowhere to go or nothing to be gained, in which case the caller keeps doing
   * whatever it was doing — both callers already read it that way.
   *
   * The destination is snapped onto walkable ground first, for the reason
   * `_flankPoint` documents: "nine metres that way" is a direction, not a place,
   * and handing A* a point inside a wall spends the solve to learn nothing.
   *
   * The two refusals above that are the fix for a man who ran away for a living.
   * Both callers test `squadIsBroken`, which is not an event but a PERMANENT
   * fact — once a three-man squad is down to one, it is down to one for the rest
   * of the level — so the dice behind it (`< dt * 0.9`, about once a second) came
   * up for that man every second he had left. MEASURED over 45 s with both
   * squads gutted: 11 break-offs, 10 of them from `_combat` on a man at FULL
   * health looking straight at the player from 24-37 m, and the two survivors
   * spent 42.8 % and 35.7 % of their lives sprinting away in nine-metre bursts.
   * From the player's side that is not a retreat, it is a commute.
   *
   *   - RANGE: at 30 m a nine-metre dash breaks nothing off, because there is no
   *     contact at that distance to break. Cover is scored out to 30 m and the
   *     grenade window closes at 26, so 20 m is inside the band where being
   *     outnumbered is actually dangerous.
   *   - COOLDOWN: and one fall-back is a fall-back. Repeating it every six
   *     seconds is the metronome above. He holds what he took for BREAK_COOLDOWN
   *     and fights from there.
   *
   * Neither refusal is a state change, so a man who is refused does what he
   * would have done anyway: take cover, shoot, flank. Note also that neither
   * spends a die — the callers roll before asking, so a refusal costs nothing
   * and, in a fight where nobody has died, this method is never reached at all.
   */
  _breakContact(from) {
    if (this.breakTimer > 0) return false;
    const away = this._v.copy(this.position).sub(from).setY(0);
    const gap = away.length();
    if (gap < 1e-3 || gap > BREAK_RANGE) return false;
    away.multiplyScalar(9 / gap).add(this.position);
    const grid = this.ai.grid;
    if (grid && !grid.snapTo(away, 6, 2.5, this.navRegion)) return false;
    if (!this._goTo(away)) return false;
    this.breakTimer = BREAK_COOLDOWN;
    this._setState(STATE.RETREAT);
    return true;
  }

  /**
   * The best guess at where the danger is, for a man who is not looking at it:
   * his own last sighting, else where the squad thinks the round came from,
   * else the body of the last man it lost.
   */
  _threatPoint() {
    if (this.lastKnownAge < 8) return this.lastKnown;
    const sq = this.squad;
    if (sq && sq.casualtyAge < 12) return sq.hasThreat ? sq.threat : sq.lastCasualty;
    return null;
  }

  /**
   * Somewhere to swing wide to: `reach` metres off the line to `target`, on
   * `side`, and four metres closer in so the move gains ground as well as
   * angle. Written into `_v2`, snapped onto ground this agent can actually walk
   * to, and false when there is no such ground.
   *
   * The snap is the point of the method. Without it the destination was a raw
   * offset that landed inside a building or on the far side of a wall six times
   * out of seven — MEASURED: 11 of 14 manoeuvres over 60 s ended as an A* that
   * returned no route, which the RNG had already paid for.
   */
  _flankPoint(target, side, reach) {
    const perp = this._v.copy(target).sub(this.position).setY(0);
    if (perp.lengthSq() < 1e-6) return false;
    perp.normalize();
    const p = this._v2
      .set(-perp.z * side, 0, perp.x * side)
      .multiplyScalar(reach)
      .add(this.position)
      .addScaledVector(perp, 4);
    const grid = this.ai.grid;
    // 6 rings is ~5 m of give at a 0.8 m cell: enough to find the street beside
    // a wall, not enough to turn a flank into a stroll to somewhere else.
    return grid ? grid.snapTo(p, 6, 2.5, this.navRegion) : true;
  }

  /* ================================================================== */
  /* movement                                                           */
  /* ================================================================== */

  _goTo(dest) {
    const grid = this.ai.grid;
    this.arriveEps = 0.45;
    if (!grid) {
      // No navigation built yet. Walk straight at it — and write a REAL
      // one-waypoint path while doing so: `_move` steers on
      // `pathIndex < pathLen`, so setting `hasMoveTarget` alone moved nobody.
      this._setPath1(dest, 0.45);
      return true;
    }
    // A budget that is a fixed node count is a budget in the wrong currency: it
    // is spent on how TANGLED the route is, not on how far away it is. MEASURED:
    // a cover point 5.1 m away, seventeen waypoints away by road, exhausted 6000
    // nodes and came back "no route" — twenty times in a row, 13.6 s in which
    // that man never moved, while 12000 nodes solved it every time. So a man who
    // has just been told there is no route gets a bigger search rather than the
    // same one again. The frontier of a grid A* is a perimeter and not an area
    // (MEASURED high water: 798 of 48841 heap slots over a whole firefight), so
    // four times the nodes is four times the work and no more memory, and only
    // ever for an agent who is already stuck.
    //
    // It is a cold path and meant to be: partial paths, which landed alongside
    // it, turn most starved solves into a short walk rather than a refusal.
    // MEASURED over 60 s of firefight: 144 solves, 141 asked for the base 6000
    // and 3 escalated to 12000, none beyond; mean frontier 387 pushes per solve,
    // so the ceiling binds on the genuinely tangled route and nothing else.
    this._pathOpts.maxNodes = 6000 * Math.min(4, 1 + this.pathFails);
    const n = this.ai.requestPath(this.position, dest, this.path, this._pathOpts);
    if (n < 0) {
      // The frame's A* budget is spent. Hold the destination, take a place in
      // the system's queue and let it serve us in request order; `_combat` reads
      // a failed _goTo as "that cover point is unreachable" and drops it, so
      // this must not report failure.
      this._pendingDest.copy(dest);
      this.pathPending = true;
      this.ai.queuePath(this);
      return false;
    }
    this.pathPending = false;
    if (n === 0) {
      // No route: the destination is across a seam or on another walkable
      // island. Back off before asking again — retrying every frame is a full
      // A* flood per frame per stuck agent, which is exactly what used to eat
      // the budget everybody else was waiting for.
      this.hasMoveTarget = false;
      this.pathFailTimer = this.rng.range(0.45, 0.9);
      this.pathFails++;
      return false;
    }
    this.pathFails = 0;
    this.pathLen = n;
    this.pathIndex = 0;
    this.moveTarget.copy(this.path[n - 1]);
    this.hasMoveTarget = true;
    return true;
  }

  /** A single waypoint, straight at `dest`, arriving within `eps` metres. */
  _setPath1(dest, eps) {
    if (!this.path[0]) this.path[0] = new THREE.Vector3();
    this.path[0].copy(dest);
    this.pathLen = 1;
    this.pathIndex = 0;
    this.arriveEps = eps;
    this.moveTarget.copy(dest);
    this.hasMoveTarget = true;
    this.pathPending = false;
  }

  _move(dt) {
    /* How much ground he actually covered since the last frame, in m/s.
     *
     * Measured here, at the top, so it spans a WHOLE frame: the controller
     * integration at the bottom of this method plus `_drive`, which is what
     * moves a man through a vault. Measuring it around the integration alone
     * would read a vault as a man standing still. */
    this.progress = Math.hypot(this.position.x - this._prevX, this.position.z - this._prevZ) / Math.max(1e-6, dt);
    this._prevX = this.position.x;
    this._prevZ = this.position.z;

    const wp = this.hasMoveTarget && this.pathIndex < this.pathLen ? this.path[this.pathIndex] : null;
    this._steer.set(0, 0, 0);
    let want = 0;

    if (wp) {
      const to = this._v.copy(wp).sub(this.position);
      to.y = 0;
      const d = to.length();
      if (d < (this.pathIndex === this.pathLen - 1 ? this.arriveEps : 0.75)) {
        this.pathIndex++;
        if (this.pathIndex >= this.pathLen) this.hasMoveTarget = false;
      } else {
        to.multiplyScalar(1 / d);
        this._steer.copy(to);
        want = this.desiredSpeed;
      }
    }

    // local avoidance: push off squadmates and steer around them
    const others = this.ai.agents;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === this || !o.alive) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      const rr = (this.radius + o.radius + 0.42) ** 2;
      if (d2 > rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (1 - d / Math.sqrt(rr)) * 1.5;
      this._steer.x += (dx / d) * push;
      this._steer.z += (dz / d) * push;
      // tangential bias breaks head-on deadlocks deterministically
      this._steer.x += (-dz / d) * push * 0.35 * (this.id % 2 ? 1 : -1);
      this._steer.z += (dx / d) * push * 0.35 * (this.id % 2 ? 1 : -1);
      // Separation has to work for a man who is STANDING STILL. `desiredSpeed`
      // is 0 the whole time an agent holds cover, so `desiredSpeed * 0.35` was
      // exactly zero and two soldiers who ended up in the same doorway simply
      // stayed in it. MEASURED: close enough for one to hold his muzzle 0.3 m
      // inside the other's chest and put eight rounds through him.
      if (want < 0.9) want = 0.9;
    }

    if (this._steer.lengthSq() > 1e-6) this._steer.normalize();

    // speed: ease toward the request so starts and stops have weight
    const targetSpeed = want * (this.crouch ? 0.42 : 1) * (1 - this.suppression * 0.25);
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 7);
    if (this.speed < 0.05) this.speed = 0;

    // WANTS to move and ISN'T. A path that ended a metre short of its target, a
    // waypoint on the far side of a kerb, a goal the string pull could not
    // finish on — all of them used to leave a man standing with `desiredSpeed`
    // set and `speed` 0 for the rest of the round, and no state in the machine
    // noticed. Watch the outcome instead of the causes and ask for a new route.
    //
    // The test is on `progress` — ground actually covered — and not on `speed`,
    // which is only what he ASKED for and is the whole reason this missed the
    // loudest case of the bug it was written for. A man wedged against a corner
    // the nav grid thinks is open runs at 4.4 m/s on the spot: `speed` reads
    // 4.4, so nothing here fired, and the animation is a full sprint going
    // nowhere. MEASURED over a 40 s firefight in which NOBODY dies: agents
    // covered less than a quarter of the ground they asked for on 2437 of 9865
    // moving frames — a quarter of all of it — with per-man streaks of 6.2 s,
    // 4.6 s and 4.2 s, in `combat`, `flank`, `alert` and `patrol` alike.
    //
    // The other rescue below, on `controller.lastMoveBlocked`, was awake for
    // every one of those frames and could not help: it re-asks for a route to
    // the SAME destination from the SAME spot, so A* hands back the same path
    // and he keeps running at the same wall. MEASURED on one flanker: the
    // distance to his next waypoint sat at 5.85 m, unchanged, for four seconds
    // across four such retries. Giving the destination up is what breaks it,
    // and that is what this branch does.
    //
    // Both floors are needed. The absolute one catches the original case, a man
    // whose speed never spins up at all; the relative one catches the wedge,
    // where he is at a dead run and getting a hundredth of it.
    if (this.desiredSpeed > 0.2 && !this.pathPending &&
      this.progress < Math.max(0.25, this.speed * 0.25)) {
      this.stallTimer += dt;
      if (this.stallTimer > 1.4) {
        this.stallTimer = 0;
        this.pathFailTimer = 0;
        this.repathTimer = 0;
        this.hasMoveTarget = false;
        this.pathIndex = this.pathLen; // whatever we were following is spent
        if (this.state === STATE.PATROL) this.patrolIndex++;
      }
    } else this.stallTimer = 0;

    /* SIDESTEP. Dropping the route (above) ends a stall; it does not end the
     * WEDGE, because A* is asked again from the same spot and hands back the
     * same line — MEASURED up to five requests for one destination in 40 s. So
     * before giving up, walk along the wall instead of into it.
     *
     * MEASURED on 1223 wedged frames: he holds a steering vector of length 1,
     * a waypoint 4.0 m away and a speed of 3.57 m/s, and covers 0.22 m/s. The
     * horizontal slide is handed 59.5 mm and returns 7.5 mm — 12.6 % — because
     * collide-and-slide keeps only the component along the plane and he is
     * inside five degrees of dead-on. The tangent is the other 87 %, free.
     *
     * `wallNormal` is the real contact from last frame's move, not a guess, and
     * it only became readable when the `slopeLimit` unit above was fixed: with
     * `Math.cos(48)` as the threshold every contact classified as ground and
     * this branch would have been unreachable.
     *
     * Which way along the wall: the tangent that still points most toward the
     * waypoint. Dead-on into the wall that dot is zero, and then the side comes
     * from `id % 2` — same tie-break the separation bias above uses, so two men
     * on the same wall peel off opposite ways and neither draws an RNG number.
     *
     * It starts at 0.25 s, which leaves it 1.15 s to work before the watchdog
     * drops the route, and ramps over the next half second so a graze on a
     * doorframe bends the walk rather than throwing it away. */
    const con = this.controller;
    if (this.stallTimer > 0.25 && wp && con?.touchingWall) {
      const nx = con.wallNormal.x, nz = con.wallNormal.z;
      const nl = Math.sqrt(nx * nx + nz * nz);
      if (nl > 1e-4) {
        let tx = -nz / nl, tz = nx / nl;
        const along = this._steer.x * tx + this._steer.z * tz;
        const flip = Math.abs(along) > 1e-3 ? along < 0 : !!(this.id % 2);
        if (flip) { tx = -tx; tz = -tz; }
        const w = Math.min(1, (this.stallTimer - 0.25) / 0.5) * 1.6;
        this._steer.x += tx * w;
        this._steer.z += tz * w;
        const l = Math.hypot(this._steer.x, this._steer.z);
        if (l > 1e-6) { this._steer.x /= l; this._steer.z /= l; }
        this.sidestepping = true;
      } else this.sidestepping = false;
    } else this.sidestepping = false;

    // Facing: look where we are going, or at the threat when there is one.
    //
    // "When there is one" used to mean combat only, and that made the moment
    // the squad's information actually arrives look like nothing had happened.
    // A call-out — or the mate who just fell over beside him — puts a man into
    // ALERT with a bearing, and ALERT faced the direction he was walking, or
    // whatever he happened to be facing when he had nowhere to walk. The
    // information was in his head and nowhere on his body.
    const alerted = this.state === STATE.ALERT && this.lastKnownAge < 8;
    const engaged =
      this.state === STATE.COMBAT || this.state === STATE.SUPPRESSED || this.hasTarget || alerted;
    const bearing = this._v2.copy(this.lastKnown).sub(this.position).setY(0);
    // Inside 1.2 m the vector is noise, not a direction: standing on the spot
    // he was sent to must not spin him.
    if (engaged && this.lastKnownAge < 8 && bearing.lengthSq() > 1.44) {
      this.faceYaw = Math.atan2(bearing.x, bearing.z);
    } else if (this.speed > 0.2) {
      this.faceYaw = Math.atan2(this._steer.x, this._steer.z);
    }
    // Searching on the spot sweeps the gaze instead of staring down one line
    // for the twelve seconds ALERT lasts. The phase is the agent id, so no two
    // men scan in lockstep and the sweep costs no RNG draw — anything that did
    // would move every capture reference in the project (ARCHITECTURE rule 4).
    const sweeping = alerted && this.speed < 0.25;
    this.targetYaw = this.faceYaw + (sweeping ? Math.sin(this.stateTime * 0.9 + this.id) * 0.85 : 0);
    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // a big turn while standing still becomes a real turn-in-place step
    if (Math.abs(dy) > 0.9 && this.speed < 0.3) this.animator.turn(dy > 0 ? 1 : -1);
    const turnRate = this.speed > 0.3 ? 6.5 : 3.4;
    this.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, dy));

    /* integrate through the character controller */
    const c = this.controller;
    if (c) {
      const g = this.phys.gravity;
      this.velocity.y += g * dt;
      const vx = this._steer.x * this.speed;
      const vz = this._steer.z * this.speed;
      c.setHeight?.(this.crouch ? 1.16 * this.scale : this.height);
      c.move(vx * dt, this.velocity.y * dt, vz * dt);
      this.position.copy(c.position);
      this.grounded = c.grounded;
      if (c.grounded && this.velocity.y < 0) this.velocity.y = 0;

      // blocked by something low: vault it
      if (c.lastMoveBlocked && this.speed > 1.5 && this.vaultCooldown <= 0 && this.grounded) {
        this._tryVault();
      }
      if (c.lastMoveBlocked && this.speed > 0.5) {
        this.stuckTimer += dt;
        if (this.stuckTimer > 1.1) {
          this.stuckTimer = 0;
          this.repathTimer = 0;
          if (this.hasMoveTarget) this._goTo(this.moveTarget);
        }
      } else this.stuckTimer = 0;
    } else {
      this.position.x += this._steer.x * this.speed * dt;
      this.position.z += this._steer.z * this.speed * dt;
    }
  }

  _tryVault() {
    const phys = this.phys;
    const fwd = this._v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const low = phys.raycast(
      this.position.x, this.position.y + 0.35, this.position.z,
      fwd.x, 0, fwd.z, 0.85, phys.MASK.WORLD
    );
    if (!low.hit) return;
    const high = phys.raycastAny(
      this.position.x, this.position.y + 1.25, this.position.z,
      fwd.x, 0, fwd.z, 1.1, phys.MASK.WORLD
    );
    if (high) return; // a wall, not a ledge
    // landing spot on the other side
    const lx = this.position.x + fwd.x * 1.5;
    const lz = this.position.z + fwd.z * 1.5;
    const y = this.ai.groundAt(lx, lz, this.position.y + 2.2);
    if (!Number.isFinite(y) || Math.abs(y - this.position.y) > 1.3) return;
    this.vaultCooldown = 2.5;
    this.animator.vault(0.8);
    this.vaultFrom = (this.vaultFrom ?? new THREE.Vector3()).copy(this.position);
    this.vaultTo = (this.vaultTo ?? new THREE.Vector3()).set(lx, y, lz);
    this.vaultT = 0;
  }

  /* ================================================================== */
  /* shooting                                                           */
  /* ================================================================== */

  _shoot(dt) {
    // where the gun is pointing: lead toward the target with human error
    const t = this.hasTarget || this.lastKnownAge < 3 ? this.lastKnown : null;
    if (t) {
      // aim at the chest, not the feet
      this._v.set(t.x, t.y + 0.05, t.z);
      const dist = this.position.distanceTo(this._v);
      const wobbleT = this.ctx.time.elapsed * 1.7 + this.id;
      const wob = 0.012 + this.suppression * 0.05;
      this._v.x += Math.sin(wobbleT) * wob * dist * 0.12;
      this._v.y += Math.sin(wobbleT * 1.7 + 1.1) * wob * dist * 0.08;
      this._v.z += Math.cos(wobbleT * 0.8) * wob * dist * 0.12;
      this.aimTarget.lerp(this._v, Math.min(1, dt * 6));
    } else {
      const fwd = this._v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this._v2
        .copy(this.position)
        .addScaledVector(fwd, 12)
        .setY(this.position.y + this.eyeHeight - 0.1);
      this.aimTarget.lerp(this._v2, Math.min(1, dt * 3));
    }

    if (!this.wantFire || this.animator.reloading || this.animator.vaulting) return;
    if (this.ammo <= 0) {
      this.animator.reload(this.variantName === 'irregular' ? 2.9 : 2.35);
      this.ai.emitReload(this);
      this.ammo = this.magSize;
      return;
    }
    if (this.burstLeft <= 0) {
      if (this.burstCooldown > 0) return;
      this.burstLeft = this.rng.int(3, 7);
      this.burstCooldown = this.rng.range(0.45, 1.35) + this.suppression * 0.5;
    }
    if (this.fireCooldown > 0) return;
    // Do not shoot through your own side. Rounds are traced by physics against
    // the ACTOR colliders, so a man crossing another man's lane really does take
    // the burst — MEASURED once the agents started moving: one of six was shot
    // dead by his own squad inside 20 s, which is the opposite of the realism
    // this is all for. Hold, keep the burst, look again in a moment.
    if (this._friendlyInLine()) {
      this.fireCooldown = 0.1;
      return;
    }
    this.fireCooldown = 1 / this.fireRate;
    this.burstLeft--;
    this.ammo--;
    this._fireRound();
  }

  /** Is a living squadmate standing inside the cone we are about to fire into? */
  _friendlyInLine() {
    const an = this.animator;
    const o = an.muzzleWorld;
    const d = an.muzzleDir;
    const others = this.ai.agents;
    for (let i = 0; i < others.length; i++) {
      const a = others[i];
      if (a === this || !a.alive || a.team !== this.team) continue;
      const px = a.position.x - o.x;
      const py = a.position.y + a.eyeHeight * 0.55 - o.y;
      const pz = a.position.z - o.z;
      const t = px * d.x + py * d.y + pz * d.z;
      // 0.1 m, not 0.4: the case this exists for is a squadmate close enough
      // that the muzzle is already inside him, which is where every measured
      // friendly kill came from. Only what is behind the shooter is skipped.
      if (t < 0.1 || t > 34) continue;
      const miss = Math.hypot(px - d.x * t, py - d.y * t, pz - d.z * t);
      if (miss < a.radius + 0.45) return true;
    }
    return false;
  }

  _fireRound() {
    const an = this.animator;
    const origin = an.muzzleWorld;
    const dir = this._muzzleDir.copy(an.muzzleDir);
    // cone of fire: worse when suppressed, better the longer we have been aiming
    const spread = this.spread * (1 + this.suppression * 1.5);
    dir.x += this.rng.gauss() * spread;
    dir.y += this.rng.gauss() * spread * 0.8;
    dir.z += this.rng.gauss() * spread;
    dir.normalize();
    an.fire(1);
    this.ai.onAgentFire(this, origin, dir);
  }

  _throwGrenade(target) {
    this.grenadeCooldown = this.rng.range(16, 34);
    this.hasGrenade = false;
    const from = this._v.copy(this.animator.muzzleWorld);
    this.ai.throwGrenade(this, from, target);
  }

  /* ================================================================== */
  /* damage                                                             */
  /* ================================================================== */

  /**
   * Take a hit. NOTE: named `applyDamage`, not `damage` — the weapon's damage
   * value is a field on this object and a method of the same name would be
   * shadowed by it.
   * @param amount  post-falloff damage
   * @param part    'head' | 'torso' | 'arm' | 'leg'
   * @param point   world impact point
   * @param dir     incident direction (unit)
   */
  applyDamage(amount, part, point, dir) {
    if (!this.alive) return;
    this.health -= amount;
    this.alertness = 1;
    this.suppression = Math.min(1.6, this.suppression + 0.35);
    // knowing where it came from
    if (dir) {
      this._v.copy(point).addScaledVector(dir, -14);
      if (this.lastKnownAge > 0.5) {
        this.lastKnown.copy(this._v);
        this.lastKnownAge = 0.4;
      }
    }
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);

    if (this.health <= 0) {
      this.die(point, dir, amount);
      return;
    }
    // hit reaction by region, with the side the round came from
    const side = dir ? Math.sign(dir.x * Math.cos(this.yaw) - dir.z * Math.sin(this.yaw)) || 1 : 1;
    const region =
      part === 'head' ? 'head'
        : part === 'arm' ? (this._sideOf(point) < 0 ? 'armR' : 'armL')
          : part === 'leg' ? (this._sideOf(point) < 0 ? 'legR' : 'legL')
            : 'torso';
    this.animator.hit(region, side, Math.min(1.4, 0.5 + amount / 45));
    if (part === 'leg') this.speed *= 0.4;
  }

  /** Which side of the body a world point is on: <0 right, >0 left. */
  _sideOf(p) {
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    return dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
  }

  die(point, dir, amount = 30) {
    if (!this.alive) return;
    this.alive = false;
    this.state = STATE.DEAD;
    this.wantFire = false;
    this.animator.enabled = false;
    this.ai.cover?.release(this.id);

    // Tell the squad while the body is still standing where it was hit. The
    // bearing they get is the round's back-trace — the same 14 m guess
    // applyDamage() makes off a non-fatal hit — or, if the shot came from
    // nowhere we can reconstruct, the dead man's own last sighting. `_v3` is
    // only ever live inside _sense(), which a corpse never runs again.
    if (this.squad) {
      const threat = dir
        ? this._v3.copy(point ?? this.position).addScaledVector(dir, -14)
        : this.lastKnownAge < 3
          ? this._v3.copy(this.lastKnown)
          : null;
      this.squad.reportDown(this, threat);
    }
    if (this.controller) this.phys.removeCharacter(this.controller);
    this.controller = null;
    for (const c of this.colliders) this.phys?.removeCollider(c);
    this.colliders.length = 0;

    // Impulse is N·s, and the ragdoll turns it into a velocity change on the
    // particles it lands near: a 5.56 round carries ~4 N·s, so anything in the
    // hundreds launches the body across the street instead of dropping it.
    this.group.updateMatrixWorld(true);
    const impulse = this._v2
      .copy(dir ?? this._v.set(0, 0, 1))
      .normalize()
      .multiplyScalar(Math.min(5.5, 1.5 + amount * 0.02));
    const hitPoint = point ?? this._v.copy(this.position).setY(this.position.y + 1.2);

    // Own the hand-off: build the capsule spec from the *live* animated pose,
    // hand it to the solver and let it drive the skeleton from here. Setting
    // __ragdoll stops physics creating a second one off our death event.
    const rd = this._makeRagdoll(impulse, hitPoint);
    if (rd) {
      this.__ragdoll = rd;
      this.ragdoll = rd;
    }
    this.ctx.events.emit('actor:death', {
      actor: this,
      point: hitPoint,
      impulse,
      headshot: false,
    });
    this.deadTime = 0;
  }

  /**
   * Hand the live pose to the ragdoll solver. `physics` derives the capsule
   * chain from the skeleton itself, so the doll starts exactly in the pose the
   * animator left — the death has no pop. `radiusRatio` fattens the capsules
   * (its default is thin enough that a settled body reads as a pancake).
   */
  _makeRagdoll(impulse, point) {
    const phys = this.phys;
    if (!phys) return null;
    // Fat capsules that start half-buried in the floor tunnel straight through
    // it: the contact normal flips once a bone's axis is on the far side. Lift
    // the pose clear of the ground for the one frame it takes to build the doll,
    // then put the group back — the body drops the 15 cm invisibly.
    const lift = 0.15 * this.scale;
    this.group.position.y += lift;
    this.group.updateMatrixWorld(true);
    const rd = phys.createRagdollFromSkeleton(this.mesh, {
      actor: this,
      mass: this.mass,
      radiusRatio: 0.42,
      cone: 74,
      twist: 38,
      iterations: 8,
      velocity: { x: this.velocity.x * 0.6, y: 0, z: this.velocity.z * 0.6 },
    });
    this.group.position.y -= lift;
    this.group.updateMatrixWorld(true);
    if (!rd) return null;
    if (impulse && point) {
      // wide radius: a tight one dumps all of it into whichever light bone is
      // nearest and whips the limb across the street
      rd.applyImpulse(point.x, point.y, point.z, impulse.x, impulse.y, impulse.z, 0.85);
    }
    if (this.ai.debugLog) {
      console.info(
        `[ai] ragdoll ${rd.boneCount} bones / ${rd.particleCount} particles, ` +
          `mask=${rd.mask} tris=${rd.world?.triCount}`
      );
    }
    return rd;
  }

  /* ================================================================== */
  /* drive the visual                                                   */
  /* ================================================================== */

  _drive(dt) {
    // root motion for a vault
    if (this.vaultT !== undefined && this.animator.vaulting && this.vaultFrom) {
      this.vaultT += dt / 0.8;
      const t = Math.min(1, this.vaultT);
      this.position.lerpVectors(this.vaultFrom, this.vaultTo, t);
      this.position.y += Math.sin(t * Math.PI) * 0.42;
      this.controller?.teleport(this.position.x, this.position.y, this.position.z);
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);

    const moving = this.speed > 0.25;
    let clip;
    if (this.crouch) clip = moving ? 'crouchWalk' : 'crouchIdle';
    else if (this.speed > 2.6) clip = 'run';
    else if (moving) clip = 'walk';
    else clip = this.health < 35 ? 'hurtIdle' : 'idle';
    this.clip = clip;

    const an = this.animator;
    an.setState({
      clip,
      speed: this.speed,
      crouch: this.crouch,
      aimTarget: this.aimTarget,
      lookTarget: this.hasTarget || this.lastKnownAge < 4 ? this.lastKnown : this.aimTarget,
      aimWeight: this.aimWeight,
      suppress: Math.min(1, this.suppression * 0.8),
    });

    // ANIMATION RATE LOD. The pose write, the three IK chains and the two foot
    // ground rays are the whole per-actor cost, and for an actor that cannot
    // reach a pixel this frame (see AiSystem._updateRelevance) they buy nothing.
    // Evaluate a third as often and hand the solver the accumulated dt, so the
    // stride phase, the recoil envelope and the reload timeline stay on the same
    // clock — nothing skates or slides when the actor becomes visible again, and
    // the frame it does become visible is always a full evaluation because
    // lodIrrelevant is false by then.
    this._animAccum += dt;
    if (this.lodIrrelevant) {
      if (this._animSkip > 0) {
        this._animSkip--;
        return;
      }
      this._animSkip = 2; // one evaluation in three while nothing can see it
    } else {
      this._animSkip = 0;
    }
    an.update(this._animAccum, this.ctx.time.elapsed);
    this._animAccum = 0;
  }

  /* ================================================================== */
  /* the body leaves                                                    */
  /* ================================================================== */

  /**
   * Begin the corpse's fade. Idempotent — the frame loop just calls it.
   *
   * The materials are SHARED by every soldier of a variant (`ai.variant(name)
   * .materials` is one list handed to every SkinnedMesh), so writing `.opacity`
   * on them would dissolve the whole squad the moment one man went down. Clone
   * this body's set the instant it starts to go: nine clones once per corpse,
   * and nothing allocated on any frame after that.
   */
  beginFade() {
    if (this._fadeMats) return;
    const src = this.mesh.material;
    const list = Array.isArray(src) ? src : [src];
    this._fadeMats = list.map((m) => {
      const c = m.clone();
      c.transparent = true;
      c.depthWrite = false;
      return c;
    });
    // the clones are new materials, so render's patcher has not seen them and
    // they would otherwise fade out lit by ambient alone
    const r = this.ctx.peek('render');
    if (r?.patcher) for (const m of this._fadeMats) r.patcher.patch(m);
    this.mesh.material = Array.isArray(src) ? this._fadeMats : this._fadeMats[0];
    this.fadeOpacity = 1;
    // A body going transparent must stop laying down opaque depth. The shadow
    // opt-out is re-asserted every frame by AiSystem._updateRelevance, which
    // owns `owNoShadow` — setting it here as well would only be overwritten.
    this.mesh.userData.owNoPrepass = true;
  }

  /** Drive the fade: `t` seconds into a `dur`-second dissolve. True when gone. */
  updateFade(t, dur) {
    const o = t >= dur ? 0 : Math.max(0, 1 - t / dur);
    this.fadeOpacity = o;
    const mats = this._fadeMats;
    if (mats) for (let i = 0; i < mats.length; i++) mats[i].opacity = o;
    return o <= 0;
  }

  /** Push the hit capsules onto the animated skeleton. */
  syncHitboxes() {
    if (!this.alive) return;
    const an = this.animator;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const { a, b } = c.userData;
      an.bonePos(a, this._boneA);
      an.bonePos(b, this._boneB);
      c.setSegment(
        this._boneA.x, this._boneA.y, this._boneA.z,
        this._boneB.x, this._boneB.y, this._boneB.z
      );
    }
  }

  dispose() {
    if (this.controller) this.phys?.removeCharacter(this.controller);
    for (const c of this.colliders) this.phys?.removeCollider(c);
    this.colliders.length = 0;
    if (this.ragdoll) this.phys?.removeRagdoll(this.ragdoll);
    // only the fade clones are ours; the originals belong to ai.variant()
    if (this._fadeMats) for (const m of this._fadeMats) m.dispose();
    this._fadeMats = null;
    this.group.parent?.remove(this.group);
  }
}

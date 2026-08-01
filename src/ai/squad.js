/**
 * AI — squad coordination.
 *
 * The squad exists to stop four individually-sensible soldiers from behaving
 * like one four-headed idiot: it hands out permission to peek so they alternate
 * instead of all leaning out together, shares contact reports so one man
 * spotting you alerts the rest (after a believable call-out delay), rations
 * grenades, and allows only one flanker at a time.
 *
 * It also reports its own dead. A casualty is the loudest thing that happens in
 * a firefight and it used to be the only thing the squad ignored — MEASURED on
 * the garrison: agent 1 was shot dead 1.1 m from agent 3, and agents 2 and 3
 * kept walking their patrol route with `lastKnownAge` still at infinity for the
 * next four seconds. `reportDown()` is what turns a body hitting the floor into
 * information the survivors act on: see Agent.squadmateDown().
 */

import * as THREE from 'three';

let _nextSquad = 1;

export class Squad {
  constructor(rng) {
    this.id = _nextSquad++;
    this.members = [];
    this.rng = rng;
    this.peekTokens = 1;
    this.peekHolders = new Set();
    this.peekTimer = 0;
    this.grenadeCooldown = 6;
    this.flanker = null;
    this.contact = new THREE.Vector3();
    this.hasContact = false;
    this.contactAge = Infinity;
    this._pending = [];

    /* ---------------- casualties ---------------- */
    /** how many of us are down, and where the last one fell */
    this.casualties = 0;
    this.lastCasualty = new THREE.Vector3();
    this.casualtyAge = Infinity;
    /** best guess at where the killing round came from */
    this.threat = new THREE.Vector3();
    this.hasThreat = false;
    /** fraction of the original squad still standing, refreshed each frame */
    this.strength = 1;
  }

  add(agent) {
    agent.squad = this;
    this.members.push(agent);
    this.peekTokens = Math.max(1, Math.round(this.members.length * 0.5));
    return agent;
  }

  get alive() {
    let n = 0;
    for (const m of this.members) if (m.alive) n++;
    return n;
  }

  /** Called once per frame by the AI system. */
  update(dt) {
    this.grenadeCooldown -= dt;
    this.contactAge += dt;
    this.casualtyAge += dt;
    // Cached rather than a getter: _combat reads it every frame per man, and it
    // can only change when somebody dies.
    this.strength = this.members.length ? this.alive / this.members.length : 0;
    if (this.flanker && (!this.flanker.alive || this.flanker.state !== 'flank')) this.flanker = null;

    // contact sharing: whoever can see the player broadcasts, with a delay
    for (const m of this.members) {
      if (!m.alive) continue;
      if (m.hasTarget && m.targetVisible) {
        this.contact.copy(m.lastKnown);
        this.hasContact = true;
        this.contactAge = 0;
        break;
      }
    }
    if (this.hasContact && this.contactAge < 4) {
      for (const m of this.members) {
        if (!m.alive || m.hasTarget) continue;
        // a call-out only gives a direction to check, never a free kill
        if (m.lastKnownAge > 1.5) {
          m.lastKnown.copy(this.contact);
          m.lastKnownAge = 0.9 + this.rng.float() * 0.8;
          m.alertness = 1;
          if (m.state === 'idle' || m.state === 'patrol') m._setState('alert');
        }
      }
    }

    // rotate the peek tokens so the same man is not always exposed
    this.peekTimer -= dt;
    if (this.peekTimer <= 0) {
      this.peekTimer = 1.1 + this.rng.float() * 1.2;
      this.peekHolders.clear();
    }
  }

  /**
   * One of ours is down. Called from Agent.die() while the body is still where
   * it fell, so every survivor gets the position first-hand.
   *
   * @param victim  the man who just died
   * @param threat  world point the killing round is estimated to have come
   *                from, or null when there is nothing to go on
   */
  reportDown(victim, threat) {
    this.casualties++;
    this.lastCasualty.copy(victim.position);
    this.casualtyAge = 0;
    if (threat) {
      this.threat.copy(threat);
      this.hasThreat = true;
    }
    // whatever he was holding, he is not holding it any more
    this.peekHolders.delete(victim.id);
    if (this.flanker === victim) this.flanker = null;

    this.strength = this.members.length ? this.alive / this.members.length : 0;
    for (const m of this.members) {
      if (m === victim || !m.alive) continue;
      m.squadmateDown(this.lastCasualty, this.hasThreat ? this.threat : null, this.strength);
    }
  }

  /** Ask to lean out of cover. Only `peekTokens` members may at once. */
  requestPeek(agent, dt) {
    if (this.peekHolders.has(agent.id)) return true;
    if (this.peekHolders.size >= this.peekTokens) return false;
    this.peekHolders.add(agent.id);
    return true;
  }

  releasePeek(agent) {
    this.peekHolders.delete(agent.id);
  }

  /** One flanker at a time, and only if someone else is holding attention. */
  canFlank(agent) {
    if (this.flanker) return false;
    let shooting = 0;
    for (const m of this.members) {
      if (m !== agent && m.alive && (m.state === 'combat' || m.state === 'suppressed')) shooting++;
    }
    return shooting >= 1;
  }

  claimFlank(agent) {
    this.flanker = agent;
  }

  requestGrenade() {
    if (this.grenadeCooldown > 0) return false;
    this.grenadeCooldown = 14 + this.rng.float() * 12;
    return true;
  }
}

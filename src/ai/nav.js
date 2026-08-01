/**
 * AI — navigation and cover.
 *
 * NAVIGATION is a dense walkability grid sampled straight out of the physics
 * BVH at boot: one downward ray per cell finds the floor, one upward ray checks
 * standing clearance, and the floor normal gives the slope. That is a navmesh's
 * worth of information for a fraction of the code, and it stays correct for a
 * level the `world` system generated procedurally without any authoring pass.
 *
 *   • A* over the 8-connected grid with a heap, slope and step penalties
 *   • string pulling against a line-of-walk test, so paths hug corners instead
 *     of zig-zagging cell to cell
 *   • per-agent local avoidance so a squad flows around itself
 *
 * COVER is derived from the same grid. Every walkable cell next to a blocker
 * becomes a cover point with a direction and a height class (full / crouch),
 * plus a peek offset that has line of sight past the edge. At runtime cover is
 * scored against the live threat direction, the agent's distance, and what the
 * rest of the squad has already claimed.
 */

import * as THREE from 'three';

const SQRT2 = Math.SQRT2;

/* ------------------------------------------------------------------ */
/* Binary heap for A*                                                  */
/* ------------------------------------------------------------------ */

class Heap {
  constructor(cap) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.n = 0;
  }

  clear() {
    this.n = 0;
  }

  push(i, k) {
    if (this.n >= this.idx.length) return;
    let c = this.n++;
    this.idx[c] = i;
    this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      const ti = this.idx[p], tk = this.key[p];
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c];
      this.idx[c] = ti; this.key[c] = tk;
      c = p;
    }
  }

  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        const ti = this.idx[m], tk = this.key[m];
        this.idx[m] = this.idx[c]; this.key[m] = this.key[c];
        this.idx[c] = ti; this.key[c] = tk;
        c = m;
      }
    }
    return top;
  }
}

/* ------------------------------------------------------------------ */
/* Nav grid                                                            */
/* ------------------------------------------------------------------ */

export class NavGrid {
  constructor(physics, opts = {}) {
    this.physics = physics;
    this.cell = opts.cell ?? 0.8;
    this.radius = opts.radius ?? 0.36;
    this.height = opts.height ?? 1.78;
    this.crouchHeight = opts.crouchHeight ?? 1.15;
    this.maxStep = opts.maxStep ?? 0.45;
    this.maxSlope = Math.cos((opts.maxSlopeDeg ?? 46) * Math.PI / 180);

    const b = opts.bounds;
    this.minX = Math.floor(b.min.x / this.cell) * this.cell;
    this.minZ = Math.floor(b.min.z / this.cell) * this.cell;
    this.nx = Math.max(1, Math.ceil((b.max.x - this.minX) / this.cell));
    this.nz = Math.max(1, Math.ceil((b.max.z - this.minZ) / this.cell));
    this.topY = b.max.y + 4;

    const n = this.nx * this.nz;
    /** 0 = blocked, 1 = walkable standing, 2 = walkable crouched only */
    this.flags = new Uint8Array(n);
    this.floor = new Float32Array(n);
    this.floor.fill(-Infinity);
    /** how enclosed a cell is: 0 open, 1 hemmed in — used for cover scoring */
    this.enclosure = new Uint8Array(n);
    /** connected component per cell, -1 where blocked. See _buildRegions(). */
    this.region = new Int32Array(n).fill(-1);
    /** cell count per component, indexed by region id */
    this.regionSize = [];
    /** the biggest component — the level's actual walkable network */
    this.mainRegion = -1;

    // A* working set
    this.gScore = new Float32Array(n);
    this.came = new Int32Array(n);
    this.visitStamp = new Int32Array(n);
    this.stamp = 0;
    this.open = new Heap(Math.min(n, 1 << 16));

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._p0 = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    this.buildMs = 0;
    this.walkableCount = 0;
  }

  index(ix, iz) {
    return iz * this.nx + ix;
  }

  cellX(x) {
    return Math.round((x - this.minX) / this.cell);
  }

  cellZ(z) {
    return Math.round((z - this.minZ) / this.cell);
  }

  worldX(ix) {
    return this.minX + ix * this.cell;
  }

  worldZ(iz) {
    return this.minZ + iz * this.cell;
  }

  inside(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz;
  }

  /** Sample the physics world. ~2 rays per cell; logged so the cost is visible. */
  build() {
    const t0 = performance.now();
    const phys = this.physics;
    const MASK = phys.MASK.WORLD;
    const r = this.radius;
    let walk = 0;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const i = this.index(ix, iz);
        const x = this.worldX(ix), z = this.worldZ(iz);
        const down = phys.raycast(x, this.topY, z, 0, -1, 0, this.topY + 30, MASK);
        if (!down.hit) continue;
        this.floor[i] = down.point.y;
        if (down.normal.y < this.maxSlope) continue;
        const fy = down.point.y;
        // standing clearance straight up
        const up = phys.raycast(x, fy + 0.25, z, 0, 1, 0, this.height - 0.2, MASK);
        if (!up.hit) this.flags[i] = 1;
        else if (up.distance > this.crouchHeight - 0.25) this.flags[i] = 2;
        else continue;
        // shoulder clearance: four short lateral probes at chest height
        let blocked = 0;
        for (let d = 0; d < 4; d++) {
          const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
          const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
          if (phys.raycastAny(x, fy + 0.95, z, dx, 0, dz, r + 0.06, MASK)) blocked++;
        }
        if (blocked >= 3) {
          this.flags[i] = 0;
          continue;
        }
        this.enclosure[i] = blocked;
        walk++;
      }
    }
    this.walkableCount = walk;
    this._buildRegions();
    this.buildMs = performance.now() - t0;
    return this;
  }

  /**
   * Label every walkable cell with its connected component, flooding under
   * EXACTLY the rules A* walks with — same 8 neighbours, same no-corner-cutting
   * test, same max step. "Same region" therefore means "a route exists", and the
   * converse is what makes this worth building.
   *
   * MEASURED on this level: 38742 walkable cells in 789 components — one street
   * network of 29835 cells and 788 marooned rooftops, ledges, window sills and
   * table tops. Two of the six garrison spawns snapped onto a 10-cell island,
   * one patrol route point sat on it, and 340 of 1349 cover points were on
   * something nobody could walk to. Every one of those requests ran A* until it
   * had expanded its full 6000-node budget and then returned "no route": 1849
   * failed solves in a 20 s run, which is also what starved everyone else's
   * per-frame path budget. With the labels the same question is an integer
   * compare, and callers can ask for goals they can actually reach.
   */
  _buildRegions() {
    const region = this.region;
    region.fill(-1);
    this.regionSize.length = 0;
    const stack = this._regionStack ?? (this._regionStack = []);
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const seed = this.index(ix, iz);
        if (this.flags[seed] === 0 || region[seed] >= 0) continue;
        const id = this.regionSize.length;
        let count = 0;
        stack.length = 0;
        stack.push(seed);
        region[seed] = id;
        while (stack.length) {
          const cur = stack.pop();
          count++;
          const cx = cur % this.nx, cz = (cur / this.nx) | 0;
          const cy = this.floor[cur];
          for (let d = 0; d < 8; d++) {
            const dx = DX[d], dz = DZ[d];
            const jx = cx + dx, jz = cz + dz;
            if (!this.walkable(jx, jz)) continue;
            if (dx && dz && (!this.walkable(cx + dx, cz) || !this.walkable(cx, cz + dz))) continue;
            const j = this.index(jx, jz);
            if (region[j] >= 0) continue;
            if (Math.abs(this.floor[j] - cy) > this.maxStep) continue;
            region[j] = id;
            stack.push(j);
          }
        }
        this.regionSize.push(count);
      }
    }
    let best = -1;
    for (let i = 0; i < this.regionSize.length; i++) {
      if (best < 0 || this.regionSize[i] > this.regionSize[best]) best = i;
    }
    this.mainRegion = best;
    return this;
  }

  /** Which component a world point belongs to, or -1 if nothing is near it. */
  regionAt(x, z, y = null, maxRings = 4) {
    const i = this.nearest(x, z, y, maxRings);
    return i < 0 ? -1 : this.region[i];
  }

  /**
   * The component someone standing here can actually WORK in — which is not the
   * same question as `regionAt`, and the difference is a man who never moves.
   *
   * 749 of this level's 789 components are nine cells or fewer: crate lids,
   * doorsteps, kerbs, the flat top of a sandbag wall. `regionAt` answers such a
   * spot with that island's id, honestly, and every region-filtered query the
   * agent then makes can only answer "nothing". MEASURED over 60 s: one of six
   * men ran onto an 8-cell island (5 m², holding no cover points at all) at
   * second 16 and did not move again for 43 s — all 1349 cover points were
   * rejected on the region test alone, and the CoverMap was re-scanned for him
   * 60 times a second to keep saying so.
   *
   * So: an island smaller than `minSize` is somewhere a man is standing, not
   * somewhere he lives, and the region his queries should use is the network
   * beside it. Nearer beats bigger — the loop stops at the first ring that
   * offers a real network.
   *
   * `maxRings` is how far to look for ANY walkable cell, which is the caller's
   * business: a spawn point floating half a metre off the kerb needs a wider
   * net than a man who is standing on the ground. How far to look for a bigger
   * NETWORK is not the caller's business — it is pinned to UPGRADE_RINGS,
   * because `findPath` re-anchors a start cell exactly that far out into the
   * goal's component (see the re-anchor beside `this.region[start]`). Name a
   * region further away than that and the pathfinder cannot put the man into
   * it, which is the 43-second freeze above with a new signature.
   */
  operatingRegion(x, z, y = null, maxRings = 3, minSize = 10) {
    const UPGRADE_RINGS = 3;
    const i = this.nearest(x, z, y, maxRings);
    if (i < 0) return -1;
    let best = this.region[i];
    let bestSize = this.regionSize[best] ?? 0;
    if (bestSize >= minSize) return best;
    const cx = this.cellX(x), cz = this.cellZ(z);
    for (let ring = 1; ring <= UPGRADE_RINGS; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          if (!this.walkable(cx + dx, cz + dz)) continue;
          const r = this.region[this.index(cx + dx, cz + dz)];
          const size = this.regionSize[r] ?? 0;
          if (size > bestSize) {
            bestSize = size;
            best = r;
          }
        }
      }
      if (bestSize >= minSize) break;
    }
    return best;
  }

  walkable(ix, iz, crouch = true) {
    if (!this.inside(ix, iz)) return false;
    const f = this.flags[this.index(ix, iz)];
    return crouch ? f !== 0 : f === 1;
  }

  floorAt(ix, iz) {
    return this.floor[this.index(ix, iz)];
  }

  /**
   * Nearest walkable cell to a world point, searched in rings. Pass `y` plus a
   * `yTol` to reject cells on a different storey — otherwise a spawn point in a
   * street happily snaps onto a market stall's table top. Pass `region` to
   * demand a cell somebody standing in that component can actually walk to.
   */
  nearest(x, z, y = null, maxRings = 8, yTol = Infinity, region = -1) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    const okY = (i) =>
      (y === null || Math.abs(this.floor[i] - y) <= yTol) &&
      (region < 0 || this.region[i] === region);
    if (this.walkable(cx, cz) && okY(this.index(cx, cz))) return this.index(cx, cz);
    for (let ring = 1; ring <= maxRings; ring++) {
      let best = -1, bestD = Infinity;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const ix = cx + dx, iz = cz + dz;
          if (!this.walkable(ix, iz)) continue;
          const i = this.index(ix, iz);
          if (!okY(i)) continue;
          let d = dx * dx + dz * dz;
          if (y !== null && Number.isFinite(this.floor[i])) d += (this.floor[i] - y) ** 2 * 4;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Move a world point onto the walkable set, in place. Returns false when
   * there is nothing walkable within `maxRings` — the caller's point is not a
   * destination and asking A* about it is a wasted flood.
   *
   * This is what a raw geometric goal — "fifteen metres to my left" — has to
   * pass through before it is a place a man can stand. findPath() does snap the
   * goal itself, but with no region and no storey filter, so a point inside a
   * building happily lands on its ROOF, in another component, and the solve
   * then returns 0. MEASURED: 11 of 14 flank manoeuvres died exactly there.
   */
  snapTo(out, maxRings = 8, yTol = Infinity, region = -1) {
    const i = this.nearest(out.x, out.z, out.y, maxRings, yTol, region);
    if (i < 0) return false;
    const iz = (i / this.nx) | 0;
    out.set(this.worldX(i - iz * this.nx), this.floor[i], this.worldZ(iz));
    return true;
  }

  /**
   * A* between two world points. Writes world-space waypoints into `out`
   * (an array of THREE.Vector3, reused) and returns the count.
   */
  findPath(from, to, out, opts = {}) {
    let start = this.nearest(from.x, from.z, from.y);
    const goal = this.nearest(to.x, to.z, to.y);
    if (start < 0 || goal < 0) return 0;
    // Different components: no route exists, and proving that the long way costs
    // a full 6000-node flood every time it is asked. An agent standing one cell
    // onto a kerb or a doorstep is the common false negative, so re-anchor the
    // START inside the goal's component before giving up — the DESTINATION is
    // the caller's to choose and is never quietly moved.
    if (this.region[start] !== this.region[goal]) {
      start = this.nearest(from.x, from.z, from.y, 3, Infinity, this.region[goal]);
      if (start < 0) return 0;
    }
    if (start === goal) {
      this._emit(out, 0, to);
      return 1;
    }
    const nx = this.nx;
    const gx = goal % nx, gz = (goal / nx) | 0;
    const cell = this.cell;
    const maxNodes = opts.maxNodes ?? 6000;

    this.stamp++;
    const stamp = this.stamp;
    this.open.clear();
    this.gScore[start] = 0;
    this.came[start] = -1;
    this.visitStamp[start] = stamp;
    this.open.push(start, 0);

    // Closest we ever got, for the partial path below.
    const startH = (Math.max(Math.abs((start % nx) - gx), Math.abs(((start / nx) | 0) - gz)) +
      (SQRT2 - 1) * Math.min(Math.abs((start % nx) - gx), Math.abs(((start / nx) | 0) - gz))) * cell;
    let bestNode = -1;
    let bestH = startH;

    let expanded = 0;
    let found = false;
    while (this.open.n > 0 && expanded < maxNodes) {
      const cur = this.open.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      expanded++;
      const cxi = cur % nx, czi = (cur / nx) | 0;
      const cg = this.gScore[cur];
      const cy = this.floor[cur];
      for (let d = 0; d < 8; d++) {
        const dx = DX[d], dz = DZ[d];
        const ix = cxi + dx, iz = czi + dz;
        if (!this.walkable(ix, iz)) continue;
        if (dx && dz) {
          // no corner cutting
          if (!this.walkable(cxi + dx, czi) || !this.walkable(cxi, czi + dz)) continue;
        }
        const ni = this.index(ix, iz);
        const dy = this.floor[ni] - cy;
        if (Math.abs(dy) > this.maxStep) continue;
        let cost = (dx && dz ? SQRT2 : 1) * cell;
        cost += Math.abs(dy) * 2.2; // prefer flat ground
        if (this.flags[ni] === 2) cost += cell * 1.6; // crouch-only squeeze
        cost += this.enclosure[ni] * cell * 0.25; // avoid scraping walls
        const g = cg + cost;
        if (this.visitStamp[ni] === stamp && g >= this.gScore[ni]) continue;
        this.visitStamp[ni] = stamp;
        this.gScore[ni] = g;
        this.came[ni] = cur;
        const hx = Math.abs(ix - gx), hz = Math.abs(iz - gz);
        const h = (Math.max(hx, hz) + (SQRT2 - 1) * Math.min(hx, hz)) * cell;
        if (h < bestH) {
          bestH = h;
          bestNode = ni;
        }
        this.open.push(ni, g + h * 1.06);
      }
    }

    // Out of nodes, or out of frontier. Walk to the closest place we DID reach
    // rather than reporting failure and leaving the caller standing.
    //
    // Every node in the tree is reachable from `start` by construction, and the
    // region test above has already proved the goal itself is, so a partial path
    // is never a walk toward somewhere unreachable — it is the first leg of a
    // route the node budget could not finish in one solve. MEASURED: a flank
    // goal 9.7 m away in a straight line, 17 waypoints away by road, exhausted
    // the 6000-node budget and returned nothing; the agent had already paid the
    // dice for that manoeuvre and stood still instead of making it. Doubling the
    // budget would double the cost of every hard solve to fix that one; walking
    // the leg we found costs nothing and closes the gap for the next ask.
    //
    // The floor is what stops a "partial" that goes nowhere from becoming a
    // re-solve treadmill, and it has to be a real walk, not a step. MEASURED
    // with a half-cell floor: a partial that closed 0.57 m had its man arrive
    // inside `arriveEps` on the next frame, which reads to `_combat` as "reached
    // the end of the path and still not in cover", so it dropped the point, took
    // the same one again and asked again — ten times, 6.5 s, nobody moving.
    // Two and a half cells clears the arrival radius and the cover radius both.
    let end = goal;
    if (!found) {
      if (bestNode < 0 || startH - bestH < cell * 2.5) return 0;
      end = bestNode;
    }

    // walk the parents back, then string-pull
    const raw = this._raw ?? (this._raw = []);
    raw.length = 0;
    let n = end;
    while (n >= 0) {
      raw.push(n);
      n = this.came[n];
    }
    raw.reverse();
    if (found) return this._stringPull(raw, from, to, out);
    const last = this._p1.set(this.worldX(end % nx), this.floor[end], this.worldZ((end / nx) | 0));
    return this._stringPull(raw, from, last, out);
  }

  _emit(out, i, v) {
    if (!out[i]) out[i] = new THREE.Vector3();
    out[i].copy(v);
  }

  /**
   * Greedy string pull: keep the furthest waypoint still reachable in a
   * straight walkable line from the anchor. Turns a staircase into a corner.
   */
  _stringPull(raw, from, to, out) {
    let count = 0;
    const anchor = this._v.copy(from);
    let i = 0;
    const nx = this.nx;
    const pos = this._v2;
    while (i < raw.length - 1) {
      let best = i + 1;
      for (let j = raw.length - 1; j > i; j--) {
        const c = raw[j];
        pos.set(this.worldX(c % nx), this.floor[c], this.worldZ((c / nx) | 0));
        if (this.lineOfWalk(anchor, pos)) {
          best = j;
          break;
        }
      }
      const c = raw[best];
      pos.set(this.worldX(c % nx), this.floor[c], this.worldZ((c / nx) | 0));
      this._emit(out, count++, pos);
      anchor.copy(pos);
      i = best;
      if (count >= 32) break;
    }
    // finish on the exact goal if we can see it
    if (this.lineOfWalk(anchor, to) && count < 32) this._emit(out, count++, to);
    else if (count === 0) this._emit(out, count++, to);
    return count;
  }

  /** Is the straight segment walkable end to end? */
  lineOfWalk(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.65)));
    let prevY = a.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      const ix = this.cellX(x), iz = this.cellZ(z);
      if (!this.walkable(ix, iz)) return false;
      const y = this.floor[this.index(ix, iz)];
      if (Math.abs(y - prevY) > this.maxStep) return false;
      prevY = y;
    }
    return true;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/** Radius around a squad casualty that cover scoring treats as a kill zone. */
const DANGER_R = 6;

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

/**
 * A cover point: a spot to stand plus the direction the protection comes from.
 * `high` means the blocker stops a standing shot; otherwise it is crouch cover.
 * `peek` is a lateral offset that clears the edge for shooting.
 */
export class CoverMap {
  constructor(grid, physics) {
    this.grid = grid;
    this.physics = physics;
    this.points = [];
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this.buildMs = 0;
  }

  build(opts = {}) {
    const t0 = performance.now();
    const g = this.grid;
    const phys = this.physics;
    const MASK = phys.MASK.WORLD;
    const step = opts.step ?? 1; // sample every Nth cell
    const reach = opts.reach ?? 1.25;
    this.points.length = 0;
    for (let iz = 1; iz < g.nz - 1; iz += step) {
      for (let ix = 1; ix < g.nx - 1; ix += step) {
        if (!g.walkable(ix, iz)) continue;
        const i = g.index(ix, iz);
        if (g.enclosure[i] === 0) {
          // still allow cover next to a blocked cell (thin props, sandbags)
          let adj = false;
          for (let d = 0; d < 4 && !adj; d++) {
            if (!g.walkable(ix + DX[d], iz + DZ[d])) adj = true;
          }
          if (!adj) continue;
        }
        const x = g.worldX(ix), z = g.worldZ(iz), y = g.floor[i];
        // find the strongest blocking direction at chest and knee height
        for (let d = 0; d < 8; d++) {
          const dx = DX[d] / (d < 4 ? 1 : SQRT2);
          const dz = DZ[d] / (d < 4 ? 1 : SQRT2);
          const low = phys.raycast(x, y + 0.55, z, dx, 0, dz, reach, MASK);
          if (!low.hit) continue;
          const high = phys.raycastAny(x, y + 1.32, z, dx, 0, dz, reach, MASK);
          // must be able to shoot over/around: check a peek to both sides
          this.points.push({
            x, y, z,
            dx, dz, // direction the cover faces (toward the blocker)
            high,
            dist: low.distance,
            // which walkable network this point belongs to: 340 of the 1349
            // points on this level sit on ledges and rooftops nobody on the
            // street can reach, and running at one is a man standing still
            region: g.region[i],
            claimed: -1,
            score: 0,
          });
          break;
        }
      }
    }
    this.buildMs = performance.now() - t0;
    return this;
  }

  /**
   * Best cover for an agent at `pos` against a threat at `threat`.
   * Scoring, in order of weight: does the blocker actually sit between us and
   * the threat, is the spot a sensible distance from both, is it free, does a
   * peek from it have line of sight (a hole to shoot through), and did one of
   * ours just die there.
   */
  pick(pos, threat, opts = {}) {
    const wantMin = opts.minRange ?? 6;
    const wantMax = opts.maxRange ?? 26;
    const claimId = opts.id ?? -1;
    const squad = opts.squad ?? null;
    const maxTravel = opts.maxTravel ?? 22;
    const yRef = opts.yRef ?? null;
    const yTol = opts.yTol ?? Infinity;
    /** only points on this walkable network — see the `region` field */
    const region = opts.region ?? -1;
    /** the point we are already on, when the agent wants to move off it */
    const exclude = opts.exclude ?? null;
    /** where a squadmate was killed: the player owns that lane, see below */
    const danger = opts.danger ?? null;
    let best = null;
    let bestScore = -Infinity;
    const tx = threat.x, tz = threat.z;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p === exclude) continue;
      if (region >= 0 && p.region !== region) continue;
      if (p.claimed >= 0 && p.claimed !== claimId) continue;
      const toThreatX = tx - p.x, toThreatZ = tz - p.z;
      const dT = Math.hypot(toThreatX, toThreatZ);
      if (dT < 2.5 || dT > 40) continue;
      const travel = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (travel > maxTravel) continue;
      if (yRef !== null && Math.abs(p.y - yRef) > yTol) continue;
      // protection: the blocker must be on the threat side
      const prot = (toThreatX / dT) * p.dx + (toThreatZ / dT) * p.dz;
      if (prot < 0.25) continue;
      let score = prot * 5 + (p.high ? 2.2 : 1.0);
      // range preference
      if (dT < wantMin) score -= (wantMin - dT) * 0.55;
      else if (dT > wantMax) score -= (dT - wantMax) * 0.28;
      score -= travel * 0.16;
      // A spot one of ours was just shot on is a spot the threat has a firing
      // lane onto. This is a penalty and not a filter on purpose: if the only
      // cover left is beside the body, standing behind it still beats standing
      // in the open — but anything else wins first.
      if (danger) {
        const dd = Math.hypot(p.x - danger.x, p.z - danger.z);
        if (dd < DANGER_R) score -= (DANGER_R - dd) * 1.1;
      }
      // do not bunch up
      if (squad) {
        for (const other of squad) {
          if (!other || other.id === claimId || !other.alive) continue;
          const d = Math.hypot(other.position.x - p.x, other.position.z - p.z);
          if (d < 3.2) score -= (3.2 - d) * 1.4;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best && claimId >= 0) {
      for (const p of this.points) if (p.claimed === claimId) p.claimed = -1;
      best.claimed = claimId;
    }
    return best;
  }

  release(claimId) {
    for (const p of this.points) if (p.claimed === claimId) p.claimed = -1;
  }

  /**
   * Where to lean out from a cover point to shoot: try both sides and pick the
   * one with line of sight from the eye to the threat.
   */
  peekOffset(cover, threat, eyeH, out) {
    const phys = this.physics;
    // lateral axis = perpendicular to the cover facing
    const lx = -cover.dz, lz = cover.dx;
    const from = this._v;
    const to = this._v2.set(threat.x, threat.y, threat.z);
    for (const s of [1, -1, 0]) {
      const px = cover.x + lx * 0.62 * s;
      const pz = cover.z + lz * 0.62 * s;
      from.set(px, cover.y + eyeH, pz);
      if (phys.lineOfSight(from, to, phys.MASK.SIGHT)) {
        out.set(px, cover.y, pz);
        return s;
      }
    }
    out.set(cover.x, cover.y, cover.z);
    return 0;
  }
}

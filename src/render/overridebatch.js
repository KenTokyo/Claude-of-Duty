/**
 * One draw call per multi-material mesh, for the passes that override the
 * material anyway.
 *
 * THE PROBLEM
 *   three emits one draw call per geometry GROUP when a mesh has an array of
 *   materials, and it keeps doing that under `scene.overrideMaterial` — where
 *   every one of those groups is about to be drawn with the *identical* depth
 *   material. The group split exists to bind different materials. When there is
 *   only one material, it buys nothing and costs a draw call.
 *
 *   MEASURED on this scene: 6 multi-material meshes (the soldiers, ~9 material
 *   slots each) turn 242 meshes into 290 draw calls. That surcharge is paid
 *   five times per frame — four shadow cascades plus the depth prepass — for up
 *   to 240 draw calls of pure CPU overhead, ~17% of the frame's 1377.
 *
 * THE FIX
 *   Swap the array for its first element for the duration of the pass. three
 *   then takes its single-material branch, `group` comes through as null, and
 *   `renderBufferDirect` draws the whole index range in one call. Afterwards
 *   the array goes back.
 *
 * WHY THIS IS OUTPUT-IDENTICAL
 *   Under an override material the *only* thing a group contributes is the
 *   index range it draws. So collapsing is exact whenever the groups already
 *   tile the whole index buffer with no gap and no overlap — the merged draw
 *   then covers precisely the same triangles. `_eligible()` checks that per
 *   geometry and refuses anything else, so a mesh that deliberately leaves part
 *   of its buffer undrawn is left alone.
 *
 *   It also refuses when any slot is invisible, since that group is currently
 *   skipped and a merged draw would bring it back.
 *
 *   The draw ORDER changes: three sorts opaque by material id, and every
 *   collapsed mesh now sorts under one material instead of nine. That is
 *   immaterial for these two passes and only these two — both write depth-
 *   tested values with no blending, so the result is the nearest fragment
 *   regardless of the order the fragments arrive in. It is exactly why this
 *   must never be used around the forward pass, where order decides the image.
 */

/** Per-geometry eligibility, revalidated when the geometry's shape changes. */
const _cache = new WeakMap();

function tiles(geometry) {
  const groups = geometry.groups;
  if (groups === undefined || groups.length === 0) return false;
  const total = geometry.index !== null ? geometry.index.count : geometry.attributes.position.count;

  const hit = _cache.get(geometry);
  if (hit !== undefined && hit.n === groups.length && hit.total === total) return hit.ok;

  // Groups are authored in order by every builder in this project, but sorting
  // is what makes the check a proof rather than an assumption.
  let ok = true;
  let cursor = 0;
  const sorted = groups.length > 1 ? [...groups].sort((a, b) => a.start - b.start) : groups;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].start !== cursor) { ok = false; break; }
    cursor += sorted[i].count;
  }
  if (cursor !== total) ok = false;

  _cache.set(geometry, { n: groups.length, total, ok });
  return ok;
}

export class OverrideBatcher {
  constructor() {
    /** Objects currently collapsed, so `end()` restores exactly those. */
    this._objs = [];
    this._mats = [];
    this._n = 0;
    /** Diagnostics: draw calls this saved on the last `begin()`. */
    this.saved = 0;
  }

  /**
   * Collapse every eligible mesh in `list[0..n)`.
   *
   * The list is RenderSystem's opaque draw list, which is the same set these
   * passes submit, so nothing outside it needs looking at.
   */
  begin(list, n) {
    this._n = 0;
    this.saved = 0;
    for (let i = 0; i < n; i++) {
      const o = list[i];
      const mats = o.material;
      if (Array.isArray(mats) === false || mats.length < 2) continue;
      if (o.visible === false) continue;

      const geometry = o.geometry;
      if (geometry === undefined || tiles(geometry) === false) continue;

      // Every slot has to be visible and overridable. One that is not is a
      // group three is currently skipping (or drawing with its own material),
      // and a merged draw would change what lands on screen.
      const groups = geometry.groups;
      let ok = true;
      for (let g = 0; g < groups.length; g++) {
        const m = mats[groups[g].materialIndex];
        if (m === undefined || m.visible === false || m.allowOverride === false) { ok = false; break; }
      }
      if (ok === false) continue;

      this._objs[this._n] = o;
      this._mats[this._n] = mats;
      this._n++;
      this.saved += groups.length - 1;
      o.material = mats[0];
    }
    return this.saved;
  }

  end() {
    for (let i = 0; i < this._n; i++) this._objs[i].material = this._mats[i];
    this._n = 0;
  }
}

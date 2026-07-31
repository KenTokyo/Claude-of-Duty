import * as THREE from 'three';
import { Accum, trs } from './util.js';
import { PALETTE } from './palette.js';

/**
 * WORLD — the assembler.
 *
 * Every module in src/world/ writes into one of these instead of touching the
 * scene, which is how a 120 m map of hundreds of thousands of triangles comes
 * out as ~100 draw calls:
 *
 *   add(key, geo, matrix, opts)   merge into the static batch for that surface
 *   proto(id, spec)               declare an instanced prop prototype
 *   place(id, matrix, masks)      add one instance
 *   box(surface, ...)             add an axis-aligned collision proxy
 *   light(light, opts)            register a punctual light with `render`
 *
 * Collision is authored separately from the visual mesh: proxies are cheap
 * boxes generated from the same numbers that built the geometry, so a doorway
 * is a real hole in the collision hull and the BVH stays in the low thousands
 * of triangles instead of chewing on every chamfer.
 */

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();
const _xm = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _UP = new THREE.Vector3(0, 1, 0);

/**
 * Spatial bucket size for chunked instance clouds (frustum culling + LOD).
 * Sized so a 120 m map splits into a handful of buckets: finer chunking culls a
 * little better but multiplies draw calls through the prepass and four shadow
 * cascades, which is the wrong trade at this map size.
 */
const CHUNK = 64;

/**
 * Static geometry is merged inside 16 m world-space cells, then all cells for
 * one material are submitted by one BatchedMesh multi-draw. The old global
 * material merge already had excellent draw-call count, but its map-wide bound
 * meant a visible window frame also submitted every other frame of that
 * material to the camera, prepass and every shadow cascade. Sixteen metres is
 * close to one building footprint: fine enough for the near CSM slices while
 * keeping the per-pass sphere-test list in the low hundreds.
 */
const STATIC_CHUNK = 16;
const STATIC_LARGE = STATIC_CHUNK * 1.25;

/**
 * Batching introduces one additional, very large shader permutation per
 * material. On ANGLE/D3D11 compiling every tiny palette variant as batched can
 * exhaust the driver's compiler process during first load. These high-volume
 * surfaces account for most static triangles; smaller variants keep the proven
 * global one-draw merge. This is measurement-driven batching, not a blanket
 * conversion whose shader cost is larger than the geometry it saves.
 */
const STATIC_BATCH_KEYS = new Set([
  'concrete',
  'metal_dark',
  'plaster_cream',
  'plaster_sand',
  'plaster_pink',
  'wood_dark',
  'metal_rust',
  'fabric_cream',
]);

export class Assembler {
  constructor({ materials, rng, render }) {
    this.materials = materials;
    this.rng = rng;
    this.render = render;
    this._mats = new Map(); // palette key -> THREE.Material
    /**
     * palette key -> { spatial, accum?, runs? }. High-volume opaque statics use
     * spatial BatchedMesh runs when WEBGL_multi_draw exists. Transparent
     * and small surfaces retain the original global merge so blend order and
     * shader-compile cost stay fixed; browsers without multi-draw also retain
     * the old one-draw path rather than falling back to one JS draw per cell.
     */
    this._static = new Map();
    this._staticSerial = 0;
    const gl = render?.renderer?.getContext?.();
    // Spatial BatchedMesh culling is a diagnostic opt-in: real GPU/CPU gates
    // found it slower than the proven global material merge despite fewer tris.
    const batchEnabled = new URLSearchParams(globalThis.location?.search ?? '')
      .get('staticBatch') === '1';
    this._staticMultiDraw = batchEnabled && !!gl?.getExtension?.('WEBGL_multi_draw');
    this._protos = new Map(); // id -> { geo, key, instances[], masks[], opts }
    this._collide = new Map(); // surface -> Accum
    this._geoCache = new Map(); // kit piece key -> BufferGeometry
    this.lights = [];
    this.meshes = [];
    this.lodGroups = [];
    /**
     * LEVEL -> WORLD. The map is authored around a street running down -Z, then
     * placed in the world so the canonical hero camera looks straight along it.
     * Baking the transform in here (rather than rotating a parent Object3D)
     * keeps every merged vertex, collision proxy, instance matrix, light and
     * LOD bounding sphere in true world space — physics, culling and the
     * world-space triplanar materials all stay honest.
     */
    this.xform = new THREE.Matrix4();
    this._identity = true;
    /** Filled by interiors.js: where a bare bulb wants a point light. */
    this.interiorLights = [];
    /** Filled by dressing.js: where a street lamp wants a point light. */
    this.lampAnchors = [];
    /**
     * Per-instance placement jitter, armed for the set-dressing pass:
     * { rng, yaw, scale }. Per-prop tilt and sink come from the prototype.
     */
    this.jitter = null;
    /**
     * Whether put() drops a contact fillet under skirted prototypes. Turn it
     * off around a stack — the second crate in a pile is standing on the first,
     * not on the ground, and a dust ring floating at 60 cm is worse than none.
     */
    this.skirts = true;
    this.stats = {
      staticTris: 0,
      staticChunks: 0,
      staticBatches: 0,
      instTris: 0,
      instances: 0,
      drawCalls: 0,
      collideTris: 0,
    };
  }

  // -------------------------------------------------------------- transform --
  /**
   * Place LEVEL space into WORLD space. The map is authored around a street
   * running down -Z; the transform rotates and offsets it so the street lies on
   * the canonical camera axis. Baking it into every vertex, proxy, instance
   * matrix and light (rather than rotating a parent Object3D) keeps physics,
   * culling and the world-space triplanar materials honest.
   */
  setTransform(ry, tx = 0, tz = 0) {
    _q.setFromAxisAngle(_UP, ry);
    _v.set(tx, 0, tz);
    _one.set(1, 1, 1);
    this.xform.compose(_v, _q, _one);
    this._identity = ry === 0 && tx === 0 && tz === 0;
    this.ry = ry;
    return this;
  }

  /** LEVEL -> WORLD for a point. Writes into `out` (a THREE.Vector3). */
  toWorld(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z).applyMatrix4(this.xform);
  }

  /** Compose the level transform onto a level-space matrix (shared scratch). */
  _x(matrix) {
    if (this._identity) return matrix ?? null;
    if (!matrix) return this.xform;
    return _xm.copy(this.xform).multiply(matrix);
  }

  // ------------------------------------------------------------- materials --
  mat(key) {
    let m = this._mats.get(key);
    if (m) return m;
    const def = PALETTE[key];
    if (!def) {
      console.warn(`[world] unknown palette key "${key}"`);
      return this.mat('concrete');
    }
    m = this.materials.get(def.name, def.opts);
    this._mats.set(key, m);
    return m;
  }

  surfaceOf(key) {
    return PALETTE[key]?.surface ?? 'concrete';
  }

  // --------------------------------------------------------- static batch --
  /** Merge a transformed geometry into the spatial batch for `key`. */
  add(key, geo, matrix = null, opts = null) {
    let group = this._static.get(key);
    if (!group) {
      // The allow-list is opaque; glass is intentionally never eligible because
      // BatchedMesh sub-object ordering would alter blending.
      const spatial = this._staticMultiDraw && STATIC_BATCH_KEYS.has(key);
      group = spatial
        ? { spatial: true, runs: [], lastBucket: null }
        : { spatial: false, accum: new Accum(`world:${key}`) };
      this._static.set(key, group);
    }

    const worldMatrix = this._x(matrix);
    let a = group.accum;
    if (group.spatial) {
      if (geo.boundingBox === null) geo.computeBoundingBox();
      _box.copy(geo.boundingBox);
      if (worldMatrix) _box.applyMatrix4(worldMatrix);
      _box.getSize(_size);

      let bucket;
      if (
        !Number.isFinite(_box.min.x + _box.min.z + _box.max.x + _box.max.z) ||
        _size.x > STATIC_LARGE ||
        _size.z > STATIC_LARGE
      ) {
        // A road slab, cable or perimeter wall spanning several cells gets its
        // own conservative range instead of inflating one ordinary cell's bound.
        bucket = `large:${this._staticSerial++}`;
      } else {
        _box.getCenter(_v);
        bucket = `${Math.floor(_v.x / STATIC_CHUNK)},${Math.floor(_v.z / STATIC_CHUNK)}`;
      }
      // Preserve the old global merge's exact triangle order. Re-grouping all
      // additions by cell changes which coplanar triangle wins the depth test
      // and produced visible one-pixel speckling at facade seams. Consecutive
      // additions in the same cell can still share one cull range; revisiting a
      // cell later starts a new range so authored raster order stays untouched.
      const last = group.runs[group.runs.length - 1];
      if (last && group.lastBucket === bucket) {
        a = last;
      } else {
        a = new Accum(`world:${key}:${bucket}:${group.runs.length}`);
        group.runs.push(a);
        group.lastBucket = bucket;
      }
    }

    a.add(geo, worldMatrix, opts);
    return this;
  }

  /** Convenience: a transformed box merged into the static batch. */
  addBox(key, geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, opts = null) {
    return this.add(key, geo, trs(_m, x, y, z, ry, sx, sy, sz), opts);
  }

  /**
   * Geometry cache for kit pieces that repeat (window frames, sills, steps).
   * Merged data is copied, so everything here is freed by releaseCache() once
   * the level is built.
   */
  cache(key, factory) {
    let g = this._geoCache.get(key);
    if (!g) {
      g = factory();
      this._geoCache.set(key, g);
    }
    return g;
  }

  /** Merge a one-off geometry and free it immediately. */
  addOnce(key, geo, matrix = null, opts = null) {
    this.add(key, geo, matrix, opts);
    geo.dispose();
    return this;
  }

  releaseCache() {
    for (const g of this._geoCache.values()) g.dispose();
    this._geoCache.clear();
  }

  // ------------------------------------------------------------ instanced --
  /**
   * @param {string} id
   * @param {object} spec { geo, key, castShadow, chunk, maxDist, collide }
   */
  proto(id, spec) {
    if (this._protos.has(id)) return id;
    this._protos.set(id, {
      id,
      geo: spec.geo,
      /**
       * How far a loose object of this kind is allowed to be knocked out of
       * true, in radians, and how far to sink it so the raised corner does not
       * float. 0 (the default) means "this prop is fixed" — a lamp post, a
       * bullet pock, a bottle standing on a table — and `put()` leaves it alone.
       */
      tilt: spec.tilt ?? 0,
      sink: spec.sink ?? 0,
      key: spec.key,
      /**
       * Radius, in metres, of the swept dust fillet `put()` should drop under
       * every instance of this prototype. Nothing in the frame currently
       * touches anything: a crate meets the road on a razor-straight polygon
       * edge with no darkening, no piled grit and no transition, which is what
       * makes props read as decals pasted on. A low mound of the ground's own
       * material against the base fixes it geometrically (so the AO pass and
       * the sun both see it) rather than by painting a shadow.
       */
      skirt: spec.skirt ?? 0,
      castShadow: spec.castShadow !== false,
      receiveShadow: spec.receiveShadow !== false,
      chunk: spec.chunk !== false,
      maxDist: spec.maxDist ?? 0,
      matrices: [],
      masks: [],
      noPrepass: !!spec.noPrepass,
    });
    return id;
  }

  has(id) {
    return this._protos.has(id);
  }

  /** Add an instance. `masks` scales the geometry's [wear, grime, ao]. */
  place(id, matrix, masks = null) {
    const p = this._protos.get(id);
    if (!p) {
      console.warn(`[world] no prop prototype "${id}"`);
      return this;
    }
    p.matrices.push(this._x(matrix).clone());
    // Simple stock PBR does not consume wear/grime masks. Avoid thousands of
    // short-lived three-number arrays during world construction in that path.
    p.masks.push(!this.materials.simple && masks ? [masks[0], masks[1], masks[2]] : null);
    return this;
  }

  /**
   * Place with loose transform arguments — the common case.
   *
   * When `jitter` is armed (dressing.js does it for the whole set-dressing pass)
   * every prop declared as loose gets knocked out of true: a little yaw, a
   * little tilt on both horizontal axes and a little scale. Nothing in a real
   * street is square to anything else, and the identical-clone read is the
   * loudest tell in an instanced prop cloud — a barrel dropped by hand is never
   * plumb, and two barrels are never the same size.
   */
  put(id, x, y, z, ry = 0, s = 1, masks = null, rx = 0, rz = 0) {
    const j = this.jitter;
    const p = this._protos.get(id);
    if (j) {
      if (p && p.tilt > 0) {
        const r = j.rng;
        ry += r.range(-j.yaw, j.yaw);
        rx += r.range(-p.tilt, p.tilt);
        rz += r.range(-p.tilt, p.tilt);
        s *= 1 + r.range(-j.scale, j.scale);
        y -= p.sink;
      }
    }
    trs(_m, x, y, z, ry, s, s, s, rx, rz);
    this.place(id, _m, masks);
    // Ground it. The fillet is never tilted and never rotated with the prop:
    // it is a pile of dust, not part of the object.
    if (this.skirts && p && p.skirt > 0 && this._protos.has('dust_skirt')) {
      const rr = p.skirt * s;
      trs(_m, x, y + 0.004, z, (x * 2.7 + z * 1.9) % 6.283, rr, 1, rr);
      this.place('dust_skirt', _m, null);
    }
    return this;
  }

  putS(id, x, y, z, ry, sx, sy, sz, masks = null, rx = 0, rz = 0) {
    trs(_m, x, y, z, ry, sx, sy, sz, rx, rz);
    return this.place(id, _m, masks);
  }

  count(id) {
    return this._protos.get(id)?.matrices.length ?? 0;
  }

  // ------------------------------------------------------------ collision --
  /** Axis-aligned (or Y-rotated) box collision proxy. */
  box(surface, cx, cy, cz, sx, sy, sz, ry = 0) {
    let a = this._collide.get(surface);
    if (!a) {
      a = new Accum(`collide:${surface}`);
      this._collide.set(surface, a);
    }
    a.add(UNIT_BOX, this._x(trs(_m, cx, cy, cz, ry, sx, sy, sz)));
    return this;
  }

  /** Register real triangles as collision (ramps, terrain, odd shapes). */
  collideGeo(surface, geo, matrix = null) {
    let a = this._collide.get(surface);
    if (!a) {
      a = new Accum(`collide:${surface}`);
      this._collide.set(surface, a);
    }
    a.add(geo, this._x(matrix));
    return this;
  }

  /** A wall slab given in panel space, placed by the panel's matrix. */
  slabBox(surface, panelMatrix, x, y, w, h, t) {
    trs(_m, x, y, t * 0.5, 0, w, h, t);
    _m.premultiply(panelMatrix);
    let a = this._collide.get(surface);
    if (!a) {
      a = new Accum(`collide:${surface}`);
      this._collide.set(surface, a);
    }
    a.add(UNIT_BOX, this._x(_m));
    return this;
  }

  /** Register a punctual light. Position is in LEVEL space. */
  light(light, opts) {
    if (!this._identity) light.position.applyMatrix4(this.xform);
    this.lights.push({ light, opts });
    return this;
  }

  // ------------------------------------------------------------- finalize --
  /** Build the meshes, add them to `root`, register collision with physics. */
  finalize(root, physics) {
    // --- merged static geometry ------------------------------------------
    // Opaque material cells become one multi-draw BatchedMesh. Every geometry
    // is already baked into world space, so its batching matrix is identity:
    // the batching shader cannot change positions, normals or world projection.
    for (const [key, group] of this._static) {
      const geos = [];
      if (group.spatial) {
        for (const acc of group.runs) {
          if (!acc.empty) geos.push(acc.build());
        }
      } else if (!group.accum.empty) {
        geos.push(group.accum.build());
      }
      if (geos.length === 0) continue;

      let mesh;
      if (group.spatial && geos.length > 1) {
        let vertices = 0;
        let indices = 0;
        for (let i = 0; i < geos.length; i++) {
          vertices += geos[i].getAttribute('position').count;
          indices += geos[i].index.count;
        }
        const batch = new THREE.BatchedMesh(geos.length, vertices, indices, this.mat(key));
        batch.name = `world_${key}_spatial`;
        // Opaque cells do not need sorting. Stable authored cell order also
        // avoids needless per-pass depth sorting; only conservative culling runs.
        batch.sortObjects = false;
        batch.perObjectFrustumCulled = true;
        for (let i = 0; i < geos.length; i++) {
          const geometryId = batch.addGeometry(geos[i]);
          batch.addInstance(geometryId); // identity: vertices are world-space
          geos[i].dispose(); // BatchedMesh copied every attribute and index
        }
        batch.computeBoundingBox();
        batch.computeBoundingSphere();
        batch.userData.owSpatialChunks = geos.length;
        mesh = batch;
        this.stats.staticBatches++;
      } else {
        mesh = new THREE.Mesh(geos[0], this.mat(key));
        mesh.name = `world_${key}`;
      }

      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.surface = this.surfaceOf(key);
      mesh.userData.collision = false; // proxies own collision
      mesh.updateMatrix();
      root.add(mesh);
      this.meshes.push(mesh);
      for (let i = 0; i < geos.length; i++) {
        const index = geos[i].index;
        this.stats.staticTris += (index ? index.count : geos[i].getAttribute('position').count) / 3;
      }
      this.stats.staticChunks += geos.length;
      this.stats.drawCalls++;
    }

    // --- instanced props ---
    for (const p of this._protos.values()) {
      const n = p.matrices.length;
      if (n === 0) {
        p.geo.dispose();
        continue;
      }
      const buckets = new Map();
      if (p.chunk && n > 24) {
        for (let i = 0; i < n; i++) {
          const m = p.matrices[i];
          const gx = Math.floor(m.elements[12] / CHUNK);
          const gz = Math.floor(m.elements[14] / CHUNK);
          const k = gx * 97 + gz;
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = []));
          b.push(i);
        }
      } else {
        buckets.set(0, [...Array(n).keys()]);
      }

      const mat = this.mat(p.key);
      for (const list of buckets.values()) {
        const im = new THREE.InstancedMesh(p.geo, mat, list.length);
        im.name = `prop_${p.id}`;
        im.castShadow = p.castShadow;
        im.receiveShadow = p.receiveShadow;
        im.matrixAutoUpdate = false;
        im.userData.surface = this.surfaceOf(p.key);
        im.userData.collision = false;
        if (p.noPrepass) im.userData.owNoPrepass = true;
        let needColor = false;
        for (let j = 0; j < list.length; j++) if (p.masks[list[j]]) needColor = true;
        // In the extended shader these RGB values are wear/grime/AO masks.
        // Stock low-quality PBR would misread them as diffuse instance tint.
        if (needColor && !this.materials.simple) {
          const arr = new Float32Array(list.length * 3);
          for (let j = 0; j < list.length; j++) {
            const mk = p.masks[list[j]] ?? [1, 1, 1];
            arr[j * 3] = mk[0];
            arr[j * 3 + 1] = mk[1];
            arr[j * 3 + 2] = mk[2];
          }
          im.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
        }
        for (let j = 0; j < list.length; j++) im.setMatrixAt(j, p.matrices[list[j]]);
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.updateMatrix();
        root.add(im);
        this.meshes.push(im);
        this.stats.drawCalls++;
        this.stats.instances += list.length;
        const tri = (p.geo.index ? p.geo.index.count : p.geo.getAttribute('position').count) / 3;
        this.stats.instTris += tri * list.length;
        if (p.maxDist > 0) {
          im.userData.owLodDist = p.maxDist;
          this.lodGroups.push(im);
        }
      }
      p.matrices.length = 0;
      p.masks.length = 0;
    }

    // --- collision proxies ---
    this.collisionRoot = new THREE.Group();
    this.collisionRoot.name = 'world_collision';
    this.collisionRoot.visible = false;
    root.add(this.collisionRoot);
    this.handles = [];
    for (const [surface, acc] of this._collide) {
      if (acc.empty) continue;
      const geo = acc.build();
      const mesh = new THREE.Mesh(geo, INVISIBLE);
      mesh.name = `collide_${surface}`;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.collisionRoot.add(mesh);
      this.stats.collideTris += geo.index.count / 3;
      if (physics) this.handles.push(physics.addStatic(mesh, surface));
    }
    if (physics) physics.rebuildStatic();

    // --- lights ---
    for (const { light, opts } of this.lights) {
      root.add(light);
      this.render?.addLight?.(light, opts);
    }
    return this;
  }

  /** Distance LOD for prop clouds: cheap, per-mesh, no per-frame allocation. */
  updateLod(camera) {
    for (let i = 0; i < this.lodGroups.length; i++) {
      const im = this.lodGroups[i];
      const s = im.boundingSphere;
      if (!s) continue;
      _sph.copy(s);
      const d = _v.copy(camera.position).distanceTo(_sph.center) - _sph.radius;
      im.visible = d < im.userData.owLodDist;
    }
  }

  dispose() {
    this.releaseCache();
    for (const m of this.meshes) {
      // BatchedMesh owns matrix/id textures in addition to its geometry.
      // Instanced meshes share a prototype geometry — the prototype frees it.
      if (m.isBatchedMesh) m.dispose();
      else if (!m.isInstancedMesh) m.geometry?.dispose();
      m.parent?.remove(m);
    }
    for (const c of this.collisionRoot?.children ?? []) c.geometry?.dispose();
    this.meshes.length = 0;
    this.lodGroups.length = 0;
    for (const p of this._protos.values()) p.geo?.dispose();
    this._protos.clear();
    this._static.clear();
    this._collide.clear();
  }
}

/** Collision proxies are never drawn; they still need a material object. */
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

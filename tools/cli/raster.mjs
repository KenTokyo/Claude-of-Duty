/**
 * A CPU rasterizer for the engine's live scene graph.
 *
 * WHY THIS EXISTS
 *   The project may not launch a browser, so there is no GPU and no
 *   framebuffer to read back. Two things were lost with it, and this brings
 *   both back:
 *
 *   1. VISUAL QC. A PNG of what the camera sees, drawn from the same scene
 *      graph, the same world matrices and the same camera the GPU would have
 *      used. It is not a render of the game -- there is no PBR, no shadow
 *      filtering, no post -- but it is an honest picture of the GEOMETRY and
 *      the layout, which is what a refactor breaks. If a building stops being
 *      submitted, a cull goes too tight, or an LOD swaps at the wrong
 *      distance, it shows up here immediately and unmistakably.
 *
 *   2. OVERDRAW. How many times the GPU shades a pixel that ends up hidden.
 *      This is the number that says what a depth prepass is worth, and it can
 *      be computed exactly on the CPU because it depends only on geometry,
 *      the depth test and the submission order -- never on shading.
 *
 * WHAT IT MODELS FAITHFULLY
 *   - three's opaque submission order (painterSortStable: renderOrder, then
 *     MATERIAL ID, then front-to-back). The material grouping coming before
 *     depth is the whole reason real overdraw is worse than the ideal.
 *   - three's frustum culling, off the same bounding spheres.
 *   - the perspective divide, the near plane, the depth test, backface culling
 *     per material.side, and instancing.
 *
 * WHAT IT DOES NOT
 *   - fragment shading cost, textures (they are GPU-generated here and never
 *     exist on the CPU), skinning, morph targets, transparency sorting.
 *     Skinned meshes are drawn in bind pose and flagged in the report.
 */
import * as THREE from 'three';

const _frustum = new THREE.Frustum();
const _vpMat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();
const _mvp = new THREE.Matrix4();
const _world = new THREE.Matrix4();

/** Stride of the transformed-vertex scratch buffer: clip xyzw + world normal. */
const VSTRIDE = 8;

// ---------------------------------------------------------------------------
//  collection
// ---------------------------------------------------------------------------

/**
 * Everything the camera would draw, in the order three would draw it.
 *
 * Opaque and transparent are kept apart exactly as three keeps them: opaque
 * first in painter order, transparent afterwards back-to-front. Overdraw is
 * only ever counted over the opaque set, because that is the only set a depth
 * prepass can help.
 */
export function collectDrawables(scene, camera, { includeTransparent = true } = {}) {
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  _vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_vpMat);

  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const opaque = [];
  const transparent = [];
  let culled = 0;
  let skinned = 0;

  scene.traverseVisible((o) => {
    if (o.isMesh !== true && o.isInstancedMesh !== true) return;
    const geo = o.geometry;
    if (!geo?.attributes?.position) return;

    if (o.frustumCulled !== false) {
      if (geo.boundingSphere === null) geo.computeBoundingSphere();
      if (geo.boundingSphere) {
        _sphere.copy(geo.boundingSphere).applyMatrix4(o.matrixWorld);
        // An InstancedMesh's own bounding sphere covers all instances; three
        // culls on that, so culling on the geometry sphere alone would drop
        // instanced meshes that are plainly visible.
        if (o.isInstancedMesh === true) {
          if (o.boundingSphere === null) o.computeBoundingSphere();
          if (o.boundingSphere) _sphere.copy(o.boundingSphere).applyMatrix4(o.matrixWorld);
        }
        if (!_frustum.intersectsSphere(_sphere)) { culled++; return; }
      }
    }
    if (o.isSkinnedMesh === true) skinned++;

    _v.setFromMatrixPosition(o.matrixWorld);
    const z = _v.distanceTo(camPos);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const item = { object: o, material: m, z, renderOrder: o.renderOrder };
      if (m.transparent === true) { if (includeTransparent) transparent.push(item); }
      else opaque.push(item);
    }
  });

  // three r180, WebGLRenderLists.painterSortStable. Material id outranks depth,
  // which is exactly why front-to-back does not save what people assume.
  opaque.sort((a, b) => (a.renderOrder - b.renderOrder)
    || (a.material.id - b.material.id)
    || (a.z - b.z)
    || (a.object.id - b.object.id));
  transparent.sort((a, b) => (a.renderOrder - b.renderOrder)
    || (b.z - a.z)
    || (a.object.id - b.object.id));

  return { opaque, transparent, culled, skinned, camPos };
}

// ---------------------------------------------------------------------------
//  target
// ---------------------------------------------------------------------------

export function createTarget(width, height) {
  const n = width * height;
  return {
    width, height,
    color: new Float32Array(n * 3),
    depth: new Float32Array(n).fill(Infinity),
    /** Fragments that survived the depth test -- i.e. shader invocations. */
    shaded: new Uint32Array(n),
    /** Fragments generated before the depth test -- raw geometric coverage. */
    covered: new Uint32Array(n),
    tris: 0, trisDrawn: 0, meshes: 0, instances: 0,
  };
}

/** Vertical sky gradient, so the picture has a horizon to read the scene against. */
export function clearSky(rt, top = [0.28, 0.42, 0.62], bottom = [0.62, 0.60, 0.55]) {
  const { width, height, color } = rt;
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const r = top[0] + (bottom[0] - top[0]) * t;
    const g = top[1] + (bottom[1] - top[1]) * t;
    const b = top[2] + (bottom[2] - top[2]) * t;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      color[i] = r; color[i + 1] = g; color[i + 2] = b;
    }
  }
}

// ---------------------------------------------------------------------------
//  material colour
// ---------------------------------------------------------------------------

const _matColorCache = new Map();

/**
 * A base colour for a material.
 *
 * `material.color` where there is one. ShaderMaterials -- the sky, the
 * particles, anything custom -- have no CPU-side colour at all, so they get a
 * stable hash colour off their uuid. That is deliberate: it is arbitrary but
 * CONSISTENT, so the same material is the same colour in every shot, and a
 * material swap shows up as a colour change rather than as nothing.
 */
export function materialColor(mat) {
  let c = _matColorCache.get(mat.uuid);
  if (c) return c;
  if (mat.color?.isColor) {
    c = [mat.color.r, mat.color.g, mat.color.b];
  } else {
    let h = 0;
    for (let i = 0; i < mat.uuid.length; i++) h = (h * 31 + mat.uuid.charCodeAt(i)) | 0;
    const col = new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.45, 0.55);
    c = [col.r, col.g, col.b];
  }
  _matColorCache.set(mat.uuid, c);
  return c;
}

// ---------------------------------------------------------------------------
//  rasterizer
// ---------------------------------------------------------------------------

let _vbuf = new Float32Array(0);
let _clipScratch = new Float32Array(VSTRIDE * 8);

function ensureVBuf(n) {
  if (_vbuf.length < n * VSTRIDE) _vbuf = new Float32Array(n * VSTRIDE);
  return _vbuf;
}

/**
 * Transform one object's vertices into clip space, with world normals.
 *
 * The normal goes through the world matrix's upper 3x3 rather than a true
 * inverse-transpose. Every transform in this scene is a rigid motion with
 * uniform scale, where the two agree; a non-uniform scale would tilt a normal
 * slightly and shade a face a shade off, which does not matter for a QC image.
 */
function transformVertices(geo, world, vp, count) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal?.array;
  const buf = ensureVBuf(count);
  _mvp.multiplyMatrices(vp, world);
  const m = _mvp.elements;
  const w = world.elements;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
    const o = i * VSTRIDE;
    buf[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
    buf[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    buf[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    buf[o + 3] = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (nrm) {
      const nx = nrm[i3], ny = nrm[i3 + 1], nz = nrm[i3 + 2];
      buf[o + 4] = w[0] * nx + w[4] * ny + w[8] * nz;
      buf[o + 5] = w[1] * nx + w[5] * ny + w[9] * nz;
      buf[o + 6] = w[2] * nx + w[6] * ny + w[10] * nz;
    } else {
      buf[o + 4] = 0; buf[o + 5] = 1; buf[o + 6] = 0;
    }
  }
  return buf;
}

/**
 * Clip one triangle against the near plane, in clip space.
 *
 * The plane is `z + w >= 0`, GL's near plane, and it is the only one that has
 * to be clipped: the other five only cost time, and the screen-space bounding
 * box handles them for free. Without this, a vertex behind the eye divides by a
 * negative w and the triangle folds across the image.
 *
 * @returns number of vertices written to `_clipScratch` (0, 3 or 4).
 */
function clipNear(a, b, c, buf) {
  const src = [a, b, c];
  const out = _clipScratch;
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const cur = src[i];
    const nxt = src[(i + 1) % 3];
    const dCur = buf[cur + 2] + buf[cur + 3];
    const dNxt = buf[nxt + 2] + buf[nxt + 3];
    if (dCur >= 0) {
      for (let k = 0; k < VSTRIDE; k++) out[n * VSTRIDE + k] = buf[cur + k];
      n++;
    }
    if ((dCur >= 0) !== (dNxt >= 0)) {
      const t = dCur / (dCur - dNxt);
      for (let k = 0; k < VSTRIDE; k++) {
        out[n * VSTRIDE + k] = buf[cur + k] + (buf[nxt + k] - buf[cur + k]) * t;
      }
      n++;
    }
  }
  return n;
}

const _sx = new Float64Array(4);
const _sy = new Float64Array(4);
const _sz = new Float64Array(4);
const _sw = new Float64Array(4); // 1/w
const _snx = new Float64Array(4);
const _sny = new Float64Array(4);
const _snz = new Float64Array(4);

/**
 * Rasterize one clipped triangle.
 *
 * Depth is interpolated linearly in screen space, which is exact: NDC z is an
 * affine function of screen position across a triangle under a perspective
 * projection. Normals are not, so those are interpolated over 1/w and divided
 * back out.
 */
function rasterTri(rt, i0, i1, i2, shade, cull) {
  const { width, height, depth, color, shaded, covered } = rt;

  const x0 = _sx[i0], y0 = _sy[i0], x1 = _sx[i1], y1 = _sy[i1], x2 = _sx[i2], y2 = _sy[i2];
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area === 0 || !Number.isFinite(area)) return;
  // Screen y runs down, so a front-facing (CCW in NDC) triangle has NEGATIVE
  // signed area here. cull: 1 = drop front, -1 = drop back, 0 = keep both.
  if (cull === -1 && area < 0) return;
  if (cull === 1 && area > 0) return;

  let minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
  let maxX = Math.min(width - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
  let minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
  let maxY = Math.min(height - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
  if (minX > maxX || minY > maxY) return;

  const invArea = 1 / area;
  const z0 = _sz[i0], z1 = _sz[i1], z2 = _sz[i2];
  const w0i = _sw[i0], w1i = _sw[i1], w2i = _sw[i2];

  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    const rowBase = py * width;
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      // Barycentrics via edge functions, normalised by the signed area so the
      // sign convention takes care of itself for both windings.
      const e0 = ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1)) * invArea;
      if (e0 < 0) continue;
      const e1 = ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2)) * invArea;
      if (e1 < 0) continue;
      const e2 = 1 - e0 - e1;
      if (e2 < 0) continue;

      const idx = rowBase + px;
      covered[idx]++;

      const z = e0 * z0 + e1 * z1 + e2 * z2;
      if (z >= depth[idx]) continue;
      // `depthLocked` turns this target into a pure depth-TEST pass against a
      // buffer somebody else filled -- which is what the forward pass is once
      // the prepass has already written every depth (see prepass.js and
      // RenderSystem.resize). Without it a second rasterisation over a
      // pre-filled buffer still overwrites each pixel with its own z, so the
      // second and third fragments of a coplanar surface fail a test the GPU
      // would pass, and the forward pass reads as cheaper than it is.
      if (!rt.depthLocked) depth[idx] = z;
      shaded[idx]++;
      if (!shade) continue;

      const iw = e0 * w0i + e1 * w1i + e2 * w2i;
      const s = iw !== 0 ? 1 / iw : 0;
      const nx = (e0 * _snx[i0] * w0i + e1 * _snx[i1] * w1i + e2 * _snx[i2] * w2i) * s;
      const ny = (e0 * _sny[i0] * w0i + e1 * _sny[i1] * w1i + e2 * _sny[i2] * w2i) * s;
      const nz = (e0 * _snz[i0] * w0i + e1 * _snz[i1] * w1i + e2 * _snz[i2] * w2i) * s;
      shade(color, idx * 3, nx, ny, nz);
    }
  }
}

/** Project the clipped polygon into the screen-space scratch arrays. */
function project(n, rt) {
  const buf = _clipScratch;
  for (let i = 0; i < n; i++) {
    const o = i * VSTRIDE;
    const w = buf[o + 3];
    const inv = w !== 0 ? 1 / w : 0;
    _sx[i] = (buf[o] * inv * 0.5 + 0.5) * rt.width;
    _sy[i] = (0.5 - buf[o + 1] * inv * 0.5) * rt.height;
    _sz[i] = buf[o + 2] * inv;
    _sw[i] = inv;
    _snx[i] = buf[o + 4]; _sny[i] = buf[o + 5]; _snz[i] = buf[o + 6];
  }
}

const _instMat = new THREE.Matrix4();

/**
 * Draw one collected item. `shadeFor` builds the per-material shading closure,
 * or is null in overdraw mode where nothing is shaded at all.
 */
export function drawItem(rt, item, vp, shadeFor) {
  const o = item.object;
  const geo = o.geometry;
  const posAttr = geo.attributes.position;
  const index = geo.index;
  const vcount = posAttr.count;
  const mat = item.material;

  const cull = mat.side === THREE.DoubleSide ? 0 : mat.side === THREE.BackSide ? 1 : -1;
  const shade = shadeFor ? shadeFor(mat, o) : null;

  const idxArr = index ? index.array : null;
  const triCount = (idxArr ? idxArr.length : vcount) / 3 | 0;

  const instCount = o.isInstancedMesh === true ? o.count : 1;
  rt.meshes++;
  rt.instances += instCount;

  for (let inst = 0; inst < instCount; inst++) {
    if (o.isInstancedMesh === true) {
      _instMat.fromArray(o.instanceMatrix.array, inst * 16);
      _world.multiplyMatrices(o.matrixWorld, _instMat);
    } else {
      _world.copy(o.matrixWorld);
    }
    const buf = transformVertices(geo, _world, vp, vcount);

    for (let t = 0; t < triCount; t++) {
      const a = (idxArr ? idxArr[t * 3] : t * 3) * VSTRIDE;
      const b = (idxArr ? idxArr[t * 3 + 1] : t * 3 + 1) * VSTRIDE;
      const c = (idxArr ? idxArr[t * 3 + 2] : t * 3 + 2) * VSTRIDE;
      rt.tris++;

      // Fast reject before the clipper: entirely behind the near plane.
      const da = buf[a + 2] + buf[a + 3];
      const db = buf[b + 2] + buf[b + 3];
      const dc = buf[c + 2] + buf[c + 3];
      if (da < 0 && db < 0 && dc < 0) continue;

      let n;
      if (da >= 0 && db >= 0 && dc >= 0) {
        // Wholly in front: copy straight through, no clipping work.
        for (let k = 0; k < VSTRIDE; k++) {
          _clipScratch[k] = buf[a + k];
          _clipScratch[VSTRIDE + k] = buf[b + k];
          _clipScratch[VSTRIDE * 2 + k] = buf[c + k];
        }
        n = 3;
      } else {
        n = clipNear(a, b, c, buf);
      }
      if (n < 3) continue;

      project(n, rt);
      rt.trisDrawn++;
      rasterTri(rt, 0, 1, 2, shade, cull);
      if (n === 4) rasterTri(rt, 0, 2, 3, shade, cull);
    }
  }
}

// ---------------------------------------------------------------------------
//  shading
// ---------------------------------------------------------------------------

/**
 * A deliberately plain shading model: one sun with a wrapped Lambert term, plus
 * a sky/ground hemisphere fill taken from the engine's own fill uniforms.
 *
 * It is not trying to look like the game. It is trying to make SHAPE legible --
 * which face points where, where one object ends and the next begins -- because
 * that is what a QC image has to show. Anything fancier would only add ways for
 * the picture to differ from the GPU's for reasons that are not regressions.
 */
export function makeShader({ sunDir, sunColor, sunIntensity, skyFill, groundFill, exposure = 1 }) {
  const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z;
  const sr = sunColor.r * sunIntensity, sg = sunColor.g * sunIntensity, sb = sunColor.b * sunIntensity;
  return (mat) => {
    const [ar, ag, ab] = materialColor(mat);
    const em = mat.emissive?.isColor ? mat.emissive : null;
    const ei = mat.emissiveIntensity ?? 1;
    const er = em ? em.r * ei : 0, eg = em ? em.g * ei : 0, eb = em ? em.b * ei : 0;
    return (color, i, nx, ny, nz) => {
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const ux = nx / len, uy = ny / len, uz = nz / len;
      // Wrapped diffuse: a hard terminator on flat-shaded QC geometry reads as
      // a black hole, and half the scene's normals are axis-aligned.
      const ndl = Math.max(0, (ux * sx + uy * sy + uz * sz) * 0.75 + 0.25);
      const hemi = uy * 0.5 + 0.5;
      const fr = skyFill.x * hemi + groundFill.x * (1 - hemi);
      const fg = skyFill.y * hemi + groundFill.y * (1 - hemi);
      const fb = skyFill.z * hemi + groundFill.z * (1 - hemi);
      color[i] = (ar * (sr * ndl + fr) + er) * exposure;
      color[i + 1] = (ag * (sg * ndl + fg) + eg) * exposure;
      color[i + 2] = (ab * (sb * ndl + fb) + eb) * exposure;
    };
  };
}

// ---------------------------------------------------------------------------
//  output
// ---------------------------------------------------------------------------

/**
 * Auto-exposure, Reinhard, sRGB.
 *
 * The engine's own exposure lives in a 1x1 float render target and is computed
 * on the GPU, so it cannot be read here. Metering the image instead is not a
 * workaround but the better behaviour for a QC gate: it makes a noon shot and a
 * midnight shot directly comparable, so a geometry regression reads the same at
 * every time of day instead of hiding in a dark frame.
 *
 * The meter runs over pixels that have geometry only. Half this image is sky,
 * and metering on sky would just report the weather.
 */
export function toPNGBuffer(rt, { target = 0.62 } = {}) {
  const { width, height, color, depth } = rt;
  const n = width * height;

  const lum = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] === Infinity) continue;
    lum.push(0.2126 * color[i * 3] + 0.7152 * color[i * 3 + 1] + 0.0722 * color[i * 3 + 2]);
  }
  let gain = 1;
  if (lum.length > 64) {
    lum.sort((a, b) => a - b);
    // 90th percentile rather than the max: a single specular-white pixel or an
    // emissive muzzle flash must not drag the whole street into silhouette.
    const p90 = lum[Math.floor(lum.length * 0.9)];
    if (p90 > 1e-6) gain = (target / (1 - target)) / p90;
  }

  const px = Buffer.alloc(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Sky is authored in display space already; only lit geometry is metered.
    const g = depth[i] === Infinity ? 1 : gain;
    for (let k = 0; k < 3; k++) {
      const v = color[i * 3 + k] * g;
      const tm = depth[i] === Infinity ? v : v / (1 + v);
      const s = tm <= 0.0031308 ? tm * 12.92 : 1.055 * Math.pow(Math.max(tm, 0), 1 / 2.4) - 0.055;
      px[p + k] = Math.max(0, Math.min(255, Math.round(s * 255)));
    }
    px[p + 3] = 255;
  }
  return px;
}

/** False-colour the shaded-fragment count: black 0, blue 1, green 2, yellow 3, red 4, white 6+. */
export function overdrawToPNGBuffer(rt) {
  const { width, height, shaded } = rt;
  const RAMP = [[0, 0, 0], [40, 60, 160], [40, 160, 70], [220, 200, 40], [220, 90, 30], [230, 40, 40], [255, 255, 255]];
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const c = RAMP[Math.min(RAMP.length - 1, shaded[i])];
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
  }
  return px;
}

export async function writePNG(path, width, height, rgba) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  const { createWriteStream } = await import('node:fs');
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(path), { recursive: true });
  await new Promise((res, rej) => {
    const s = png.pack().pipe(createWriteStream(path));
    s.on('finish', res); s.on('error', rej);
  });
}

// ---------------------------------------------------------------------------
//  the two entry points
// ---------------------------------------------------------------------------

/** A shaded picture of what the camera sees. */
export function renderShot(engine, { width = 640, height = 400, transparent = true } = {}) {
  const render = engine.ctx.peek('render');
  const camera = engine.camera;
  const rt = createTarget(width, height);
  clearSky(rt);

  const { opaque, transparent: tr, culled, skinned } = collectDrawables(engine.scene, camera, {
    includeTransparent: transparent,
  });

  const u = render?.patcher?.uniforms ?? {};
  const shadeFor = makeShader({
    sunDir: render?.sunDir ?? new THREE.Vector3(0.4, 0.8, 0.3).normalize(),
    sunColor: render?.activeSun?.color ?? new THREE.Color(1, 0.96, 0.9),
    sunIntensity: Math.min(3, render?.activeSun?.intensity ?? 1),
    skyFill: u.owSkyFill?.value ?? new THREE.Vector3(0.12, 0.16, 0.24),
    groundFill: u.owGroundFill?.value ?? new THREE.Vector3(0.12, 0.10, 0.08),
    exposure: 1,
  });

  _vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  for (const item of opaque) drawItem(rt, item, _vpMat, shadeFor);
  // Transparents are drawn depth-tested but not depth-written on the GPU. Here
  // they write, which is wrong for glass but right for the thing the shot is
  // for: seeing that the object is present and where.
  for (const item of tr) drawItem(rt, item, _vpMat, shadeFor);

  return { rt, opaque: opaque.length, transparent: tr.length, culled, skinned };
}

/**
 * Overdraw over the OPAQUE set only, in three's real submission order.
 *
 * Three numbers come out and they mean different things:
 *   coveredPerPixel  raw geometric coverage, depth test ignored.
 *   shadedPerPixel   fragments that survived the depth test. This IS the
 *                    forward pass's fragment-shader invocation count, and it is
 *                    what a depth prepass would cut down to exactly one.
 *   idealShaded      the same figure if the submission were perfectly
 *                    front-to-back. The gap between it and `shaded` is what
 *                    three's material-first sort costs.
 */
export function measureOverdraw(engine, { width = 480, height = 300 } = {}) {
  const camera = engine.camera;
  const { opaque, culled, skinned } = collectDrawables(engine.scene, camera, { includeTransparent: false });

  _vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  const real = createTarget(width, height);
  for (const item of opaque) drawItem(real, item, _vpMat, null);

  // Same set, sorted purely front-to-back, to price the sort itself.
  const ideal = createTarget(width, height);
  const f2b = [...opaque].sort((a, b) => a.z - b.z);
  for (const item of f2b) drawItem(ideal, item, _vpMat, null);

  const sum = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; };
  const nonZero = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > 0) s++; return s; };

  const pixels = width * height;
  const litPixels = nonZero(real.covered);
  const shadedReal = sum(real.shaded);
  const shadedIdeal = sum(ideal.shaded);
  const coveredTotal = sum(real.covered);

  const hist = new Array(9).fill(0);
  for (let i = 0; i < real.shaded.length; i++) hist[Math.min(8, real.shaded[i])]++;

  return {
    resolution: `${width}x${height}`,
    opaqueItems: opaque.length,
    culledByFrustum: culled,
    skinnedInBindPose: skinned,
    trianglesSubmitted: real.tris,
    trianglesRasterized: real.trisDrawn,
    pixels,
    pixelsWithGeometry: litPixels,
    screenCoveragePct: +(100 * litPixels / pixels).toFixed(1),
    // Per pixel that has any geometry at all -- averaging over empty sky would
    // just report how much sky is in the shot.
    rawCoveragePerPixel: +(coveredTotal / Math.max(1, litPixels)).toFixed(3),
    shadedPerPixel: +(shadedReal / Math.max(1, litPixels)).toFixed(3),
    idealShadedPerPixel: +(shadedIdeal / Math.max(1, litPixels)).toFixed(3),
    // With the prepass depth reused, every covered pixel shades exactly once.
    depthPrepassSavesFragmentsPct: +(100 * (1 - litPixels / Math.max(1, shadedReal))).toFixed(1),
    sortingCostsFragmentsPct: +(100 * (shadedReal - shadedIdeal) / Math.max(1, shadedReal)).toFixed(1),
    shadedHistogram: hist.map((n, i) => ({ shadeCount: i === 8 ? '8+' : i, pixels: n })),
    _rt: real,
  };
}

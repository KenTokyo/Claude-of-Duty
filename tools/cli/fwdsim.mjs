/**
 * What the GEOMETRY passes cost, in the same currency `fill` prices the post
 * chain in: texture fetches per frame.
 *
 * WHY THIS EXISTS. `fill` says so in its own note -- "Fullscreen passes only ...
 * Geometry fragment counts are NOT here" -- and for five phases every ranking in
 * this project was built on its total anyway. That total is 375 M and it does
 * not contain a single fragment of the forward pass, which draws 1041 calls and
 * 8.5 M triangles beside it. Two phases were spent optimising the largest line
 * of a model that was missing a whole pass.
 *
 * THREE THINGS HAVE TO BE MEASURED, NOT ASSUMED, AND EACH ONE HAS ALREADY BURNT
 * SOMEBODY HERE:
 *
 * 1. HOW MANY FRAGMENTS THE FORWARD PASS SHADES. `overdraw` reports
 *    shadedPerPixel 2.145 and the obvious move is to multiply by that. It is
 *    wrong by 2x. `overdraw` rasterises into an EMPTY depth buffer, which is
 *    what the prepass sees; the forward pass runs afterwards against the depth
 *    the prepass already wrote (prepass.js hands its DepthTexture to the HDR
 *    target, and RenderSystem skips the depth clear), so early-Z rejects every
 *    fragment that is not the winner before the shader starts. The forward count
 *    is therefore ~1 per covered pixel, not 2.145, and a model built on 2.145
 *    would have doubled the entire forward pass. This runs the real test: a
 *    second rasterisation against the first one's depth, biased by exactly the
 *    OW_PREPASS_DEPTH_BIAS the prepass applies, with depth writes LOCKED so
 *    coplanar fragments are counted the way the GPU counts them.
 *
 * 2. WHAT A FRAGMENT COSTS. `fragcost` reports 233 fetches for the hot world
 *    materials and says in its own docstring that this is an upper bound with
 *    every branch taken. Two of those branches are enormous: three unrolls the
 *    directional light loop FOUR times, and both owSunShadow and owContactShadow
 *    sit inside it -- but each begins with `dot(lightDirView, owSunDirView) <
 *    0.999 -> return 1.0`, so three of the four invocations issue no fetch at
 *    all. Taking 233 at face value overstates the shadow term by 4x and the
 *    frame by ~100 M. Per-function real costs are listed in REAL below, each
 *    with the branch that decides it named.
 *
 * 3. WHICH MATERIAL PAYS. A per-frame total cannot be optimised; a per-material
 *    one can. Ownership is tracked through the shading callback, which the
 *    rasteriser only invokes on a fragment that survived the depth test, so the
 *    attribution is the visible surface's by construction.
 *
 * WHAT IT DOES NOT COVER, stated rather than quietly folded in: the four cascade
 * passes and the prepass itself (depth-only overrides -- one alpha fetch on the
 * three masked foliage draws, zero on everything else), transparents, decals and
 * particles (blended, no depth write, and small in this frame), and the
 * viewmodel scene, which is priced separately by `viewrect`.
 */
import * as THREE from 'three';
import { collectDrawables, createTarget, drawItem } from './raster.mjs';
import { fragmentCost } from './fragcost.mjs';

/** prepass.js OW_PREPASS_DEPTH_BIAS -- keep in step with it. */
const PREPASS_DEPTH_BIAS = 0.0012;

/**
 * Per-function real cost per SHADED FRAGMENT, and the branch that makes it so.
 *
 * `bound` is what fragcost reports; `real` is what the frame pays. Anything
 * whose real value is not a constant is marked `measured` and filled in at run
 * time -- guessing there is exactly the mistake this file exists to stop.
 */
const REAL = {
  owCsmTap: {
    measured: true,
    why: 'three unrolls NUM_DIR_LIGHTS=4, but owSunShadow rejects any light that is not '
      + 'the sun at csm.js:571 before its first fetch, so one of four invocations pays. '
      + 'That one is then priced by shadowsim with every early-out RUN (blocker count<0.5, '
      + 'full umbra, NdL<=0, beyond last split, cross-fade) rather than assumed.',
  },
  owContactShadow: {
    real: 1,
    why: 'same unrolled x4 loop; the sun-direction test at the top of owContactShadow '
      + 'returns 1.0 for the other three without fetching. The surviving one is '
      + 'unconditional once owFeat.y > 0.5, which ultra sets.',
  },
  owSampleAO: {
    real: 1,
    why: 'one fetch, hoisted to function scope by materialpatch.js so the direct-light '
      + 'micro-shadow and the indirect block share it. Unconditional at ultra (owFeat.x > 0.5).',
  },
  bilinearCubeUV: {
    real: 3,
    why: 'PMREM env lookup at two call sites, and they do NOT cost the same. three.js\'s '
      + 'textureCubeUV takes mipInt, then returns after ONE bilinearCubeUV when fract(mip) '
      + 'is 0 and only blends a second mip otherwise. getIBLIrradiance passes the literal '
      + 'roughness 1.0; roughnessToMip(1.0) is (cubeUV_r0 - 1.0) * k + cubeUV_m0, i.e. '
      + 'exactly cubeUV_m0 = -2.0, and clamp leaves it there -- so fract is exactly 0 and '
      + 'the irradiance site takes the early return on EVERY fragment. That site is 1 fetch, '
      + 'not 2, and it is a property of the literal rather than of the scene. getIBLRadiance '
      + 'passes the shaded roughness, which only lands on an exact mip breakpoint by '
      + 'coincidence, so it is charged the full 2 as an upper bound. 3, not 4. Verified '
      + 'against three ' + '0.180 cube_uv_reflection_fragment and envmap_physical_pars_fragment; '
      + 're-check on a three upgrade, because this rests on cubeUV_m0 being an integer.',
  },
  main: {
    measured: true,
    why: 'the SSR fetch is behind `owFeat.z > 0.5 && material.roughness < 0.62`; every '
      + 'other site in main is unconditional. Counted per material off its own roughness.',
  },
};

/** Vogel-free helper: object-space normal from a world-space one, rigid transform. */
function worldToObjectNormal(m, nx, ny, nz, out) {
  // Rigid + uniform scale, so the inverse rotation is the transpose of the
  // upper 3x3. A non-uniform scale would need the inverse-transpose; the
  // caller reports how many objects have one instead of hiding it.
  const e = m.elements;
  out[0] = e[0] * nx + e[1] * ny + e[2] * nz;
  out[1] = e[4] * nx + e[5] * ny + e[6] * nz;
  out[2] = e[8] * nx + e[9] * ny + e[10] * nz;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
}

/**
 * Triplanar blend weights, exactly as MAIN_FRAGMENT computes them:
 *   w = pow(abs(n), 5) / max(sum, 1e-4)
 */
function triplanarWeights(nx, ny, nz, out) {
  const ax = Math.abs(nx) ** 5, ay = Math.abs(ny) ** 5, az = Math.abs(nz) ** 5;
  const s = Math.max(ax + ay + az, 1e-4);
  out[0] = ax / s; out[1] = ay / s; out[2] = az / s;
}

const _objN = new Float64Array(3);
const _w = new Float64Array(3);
const _inv = new THREE.Matrix4();

/**
 * @param engine   a booted, stepped engine
 * @param opts.csmFetchesPerReceiverPixel  shadowsim's measured figure. Required:
 *        the static bound is 4x-30x too large and there is no honest default.
 */
export function measureForwardCost(engine, {
  width = 480, height = 300, programs = null, csmFetchesPerReceiverPixel = null,
  programOf = null,
  triplanarThresholds = [0, 1e-4, 1e-3, 0.002, 0.004, 0.01, 0.02, 0.05],
} = {}) {
  const camera = engine.camera;
  const render = engine.ctx.peek('render');
  const { opaque, culled } = collectDrawables(engine.scene, camera, { includeTransparent: false });

  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  // ---- pass 1: the depth the PREPASS leaves behind -------------------------
  // Shaded with a callback that stores the world normal, so what survives in
  // `color` is the VISIBLE surface's normal at every pixel -- i.e. exactly what
  // the prepass writes into gb-normal and every screen-space pass then reads.
  const pre = createTarget(width, height);
  const storeNormal = () => (color, off, nx, ny, nz) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    color[off] = nx / l; color[off + 1] = ny / l; color[off + 2] = nz / l;
  };
  for (const item of opaque) drawItem(pre, item, vp, storeNormal);

  const px = width * height;
  let litPixels = 0, prepassFragments = 0;
  for (let i = 0; i < px; i++) { if (pre.covered[i] > 0) litPixels++; prepassFragments += pre.shaded[i]; }

  // ---- the screen-space passes' backfacing population ----------------------
  // contact.js returns at `NdL <= 0.02` without marching, and csm.js:579 returns
  // 1.0 at `NdL <= 0.0`: the frame already treats a geometrically sun-averted
  // pixel as unshadowed. This is how much of the screen that is, measured off
  // the same normals the G-buffer would hold rather than inferred from
  // shadowsim's receiver-pixel share.
  const sun = render?.sunDir ?? new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  let backfacing = 0, grazing = 0;
  for (let i = 0; i < px; i++) {
    if (pre.covered[i] === 0) continue;
    const o = i * 3;
    const ndl = pre.color[o] * sun.x + pre.color[o + 1] * sun.y + pre.color[o + 2] * sun.z;
    if (ndl <= 0.02) backfacing++;
    else if (ndl <= 0.1) grazing++;
  }

  // ---- the bias, converted from view metres into the NDC z the raster uses --
  // z_ndc = (f+n)/(f-n) - (2fn/(f-n))/d, monotonic in the view depth d, so the
  // conversion is exact rather than a tolerance.
  const n = camera.near, f = camera.far;
  const A = (f + n) / (f - n), B = (2 * f * n) / (f - n);
  const ref = new Float32Array(px);
  for (let i = 0; i < px; i++) {
    const z = pre.depth[i];
    if (!Number.isFinite(z)) { ref[i] = Infinity; continue; }
    const d = B / Math.max(1e-9, A - z);
    ref[i] = A - B / (d * (1 + PREPASS_DEPTH_BIAS));
  }

  // ---- what the safety bias costs ------------------------------------------
  // OW_PREPASS_DEPTH_BIAS pushes the prepass depth 0.12% further away so the
  // forward pass cannot lose to its own prepass value on a compiler
  // reassociation. Everything within that band of the winner therefore SHADES
  // as well, and this frame is full of coplanar detail -- trim on facades, kerb
  // on road, decal-like geometry. That is a real per-frame cost of a safety
  // margin and nothing else measures it, so it gets measured here rather than
  // assumed to be free.
  //
  // There is deliberately no bias=0 row. This rasteriser's depth test is strict
  // `<` where GL_LEQUAL is `<=`, so at zero bias the winning fragment fails
  // against its own recorded depth and the row reads 0.54 per covered pixel --
  // a property of the test operator, not of the frame. The smallest row below
  // is already far above the float32 round-trip through view depth.
  const biasSweep = [];
  for (const b of [0.0002, 0.0006, PREPASS_DEPTH_BIAS, 0.004]) {
    const t = createTarget(width, height);
    t.depth = new Float32Array(px);
    for (let i = 0; i < px; i++) {
      const z = pre.depth[i];
      if (!Number.isFinite(z)) { t.depth[i] = Infinity; continue; }
      const d = B / Math.max(1e-9, A - z);
      t.depth[i] = A - B / (d * (1 + b));
    }
    t.depthLocked = true;
    for (const item of opaque) drawItem(t, item, vp, null);
    let n = 0;
    for (let i = 0; i < px; i++) n += t.shaded[i];
    biasSweep.push({ bias: b, forwardFragments: n, perCoveredPixel: +(n / Math.max(1, litPixels)).toFixed(4) });
  }

  // ---- pass 2: the forward pass, depth-TESTED against that ------------------
  const fwd = createTarget(width, height);
  fwd.depth = ref;
  fwd.depthLocked = true;

  const nMat = opaque.length;
  const fragsByItem = new Uint32Array(nMat);
  // Triplanar axis-weight population, per threshold: how many of the three
  // axes could be dropped, and what that is worth in fetches.
  const axesUnder = triplanarThresholds.map(() => 0);
  let triFragments = 0;
  let nonUniformScale = 0;

  let cur = 0;
  let curTriplanar = false;
  let curObjectSpace = false;
  const shadeFor = (mat, obj) => {
    const p = mat.userData?.owParams;
    curTriplanar = p?.uvMode === 'triplanar';
    curObjectSpace = p?.localSpace === true;
    if (curTriplanar && curObjectSpace) {
      _inv.copy(obj.matrixWorld);
      const s = new THREE.Vector3().setFromMatrixScale(_inv);
      if (Math.abs(s.x - s.y) > 1e-4 || Math.abs(s.y - s.z) > 1e-4) nonUniformScale++;
    }
    const id = cur;
    return (_color, _off, nx, ny, nz) => {
      fragsByItem[id]++;
      if (!curTriplanar) return;
      triFragments++;
      if (curObjectSpace) { worldToObjectNormal(_inv, nx, ny, nz, _objN); triplanarWeights(_objN[0], _objN[1], _objN[2], _w); }
      else {
        const l = Math.hypot(nx, ny, nz) || 1;
        triplanarWeights(nx / l, ny / l, nz / l, _w);
      }
      for (let t = 0; t < triplanarThresholds.length; t++) {
        const eps = triplanarThresholds[t];
        let k = 0;
        for (let a = 0; a < 3; a++) if (_w[a] <= eps) k++;
        // All three under the threshold cannot happen (they sum to 1), but a
        // guard costs nothing and a silently-3 would be a real bug.
        axesUnder[t] += Math.min(2, k);
      }
    };
  };

  for (let i = 0; i < nMat; i++) { cur = i; drawItem(fwd, opaque[i], vp, shadeFor); }

  let forwardFragments = 0;
  for (let i = 0; i < nMat; i++) forwardFragments += fragsByItem[i];

  // ---- join fragments onto per-program fetch costs --------------------------
  //
  // THROUGH THE RENDERER'S OWN MATERIAL->PROGRAM MAP, not through the name.
  // Joining on SHADER_NAME looks right and is badly wrong here. three caches
  // programs on defines and cache key, NOT on the material name, so every
  // material with the same define set shares one program and SHADER_NAME
  // records whichever material compiled it first. In this scene that means
  // `plaster`, `wood`, `dirt`, `metal_rust`, `ai_skin` and `ai_steel` have no
  // program bearing their name at all -- 56% of the forward pass's fragments
  // dropped out of the model as "unmatched" -- while `sand`, `gravel` and
  // `dirt` all share program 1232. `properties.get(material).currentProgram`
  // is the mapping the renderer actually used, and `.program.__id` is the
  // handle the GL mock recorded the source against.
  //
  // It also fixes a silent 2x: NUM_DIR_LIGHTS changes during boot, so two
  // programs exist for some materials, one compiled at 2 directional lights
  // (owCsmTap 104) and the shipped one at 4 (owCsmTap 208). A name join picks
  // by cost or by luck; this picks the one that drew the frame.
  const costOfProgram = new Map();
  for (const [id, src] of programs ?? []) costOfProgram.set(id, fragmentCost(src.fragment));

  const rows = new Map();
  for (let i = 0; i < nMat; i++) {
    if (fragsByItem[i] === 0) continue;
    const mat = opaque[i].material;
    const key = mat.name || mat.type;
    const e = rows.get(key) ?? {
      material: key,
      uvMode: mat.userData?.owParams?.uvMode ?? '(stock)',
      roughness: mat.roughness ?? null,
      programId: programOf?.(mat) ?? null,
      draws: 0, fragments: 0,
    };
    e.draws++;
    e.fragments += fragsByItem[i];
    rows.set(key, e);
  }
  const lookup = (e) => (e.programId === null ? null : costOfProgram.get(e.programId) ?? null);

  const scale = (render?.screenSize?.width ?? 0) * (render?.screenSize?.height ?? 0) / px;
  const csm = csmFetchesPerReceiverPixel;

  let totalFetches = 0, unmatched = 0;
  const unmatchedNames = [];
  const byFunction = {};
  for (const e of rows.values()) {
    const cost = lookup(e);
    if (!cost) {
      unmatched += e.fragments;
      unmatchedNames.push({ material: e.material, fragments: e.fragments, programId: e.programId });
      continue;
    }
    e.boundPerFragment = cost.dynamicFetches;
    const per = {};
    for (const [fn, bound] of Object.entries(cost.fetchesByFunction ?? {})) {
      let real;
      if (fn === 'owCsmTap') real = csm === null ? bound : csm;
      else if (fn === 'main') {
        // Every site in main is unconditional except the SSR fetch, which needs
        // roughness < 0.62. Materials are uniform-roughness here, so this is a
        // decision per material and not a per-pixel share.
        const ssrOn = (render?.ssr != null) && (e.roughness !== null && e.roughness < 0.62);
        real = bound - (ssrOn ? 0 : 1);
      } else real = REAL[fn]?.real ?? bound;
      per[fn] = real;
      byFunction[fn] = (byFunction[fn] ?? 0) + real * e.fragments * scale;
    }
    e.realPerFragment = +Object.values(per).reduce((p, c) => p + c, 0).toFixed(2);
    e.perFragmentByFunction = per;
    e.fetches = Math.round(e.realPerFragment * e.fragments * scale);
    totalFetches += e.fetches;
  }

  const ranked = [...rows.values()].sort((a, b) => (b.fetches ?? 0) - (a.fetches ?? 0));
  for (const e of ranked) e.fragmentsAtFullRes = Math.round(e.fragments * scale);

  // ---- what a triplanar weight threshold would remove ----------------------
  // Three fetches ride on each axis (map, roughnessMap, normalMap), so one
  // droppable axis is three fetches on that fragment.
  const triplanar = triplanarThresholds.map((eps, t) => ({
    threshold: eps,
    axesDroppablePerFragment: +(axesUnder[t] / Math.max(1, triFragments)).toFixed(4),
    fetchesSaved: Math.round(axesUnder[t] * 3 * scale),
    sharePctOfTriplanarFragments: +(100 * axesUnder[t] / Math.max(1, triFragments * 2)).toFixed(2),
  }));

  return {
    resolution: `${width}x${height}`,
    rasterPixels: px,
    viewportPx: Math.round(px * scale),
    scaleToFullRes: +scale.toFixed(3),
    scene: { opaqueItems: nMat, culledByFrustum: culled },
    fragments: {
      note: 'prepass shades every fragment that wins the depth test against an EMPTY buffer; '
        + 'the forward pass then runs against the depth the prepass left, so early-Z rejects '
        + 'everything but the winner. The ratio between the two IS what the prepass buys.',
      coveredPixels: litPixels,
      screenCoveragePct: +(100 * litPixels / px).toFixed(2),
      prepassFragments,
      prepassPerCoveredPixel: +(prepassFragments / Math.max(1, litPixels)).toFixed(3),
      forwardFragments,
      forwardPerCoveredPixel: +(forwardFragments / Math.max(1, litPixels)).toFixed(4),
      forwardAtFullRes: Math.round(forwardFragments * scale),
      prepassSavesFragmentsPct: +(100 * (1 - forwardFragments / Math.max(1, prepassFragments))).toFixed(1),
      depthBiasSweep: biasSweep,
    },
    // Priced for whoever wants to skip work on sun-averted pixels: the contact
    // pass already early-outs there, its bilateral blur does not, and the blur
    // is 4 fetches on every pixel of the frame.
    sunAverted: {
      note: 'share of the WHOLE screen (not just covered pixels) whose visible surface has '
        + 'N.L <= 0.02 -- the test contact.js line 40 already runs. `grazing` is the next '
        + 'band up, 0.02 < N.L <= 0.1, offered so a wider threshold can be priced without '
        + 'a second run.',
      backfacingPixels: backfacing,
      backfacingPctOfScreen: +(100 * backfacing / px).toFixed(2),
      backfacingPctOfCovered: +(100 * backfacing / Math.max(1, litPixels)).toFixed(2),
      grazingPctOfScreen: +(100 * grazing / px).toFixed(2),
      skyPctOfScreen: +(100 * (px - litPixels) / px).toFixed(2),
    },
    csmFetchesPerReceiverPixel: csm,
    totalFetches,
    fetchesByFunction: Object.fromEntries(
      Object.entries(byFunction).map(([k, v]) => [k, Math.round(v)]).sort((a, b) => b[1] - a[1])
    ),
    unmatchedFragments: unmatched,
    // A material with no program is a hole in the model, not a zero. Naming the
    // holes is what stops the total reading as complete when it is not.
    unmatchedMaterials: unmatchedNames.sort((a, b) => b.fragments - a.fragments).slice(0, 12),
    triplanar: {
      note: 'the triplanar branch blends three projections with w = pow(abs(n),5) normalised. '
        + 'An axis whose weight is 0 contributes nothing to any of albedo, orm or normal, '
        + 'and each axis carries exactly three fetches. This is the population of droppable '
        + 'axes over the fragments that actually shade, using the GEOMETRIC normal -- which '
        + 'is the same normal the shader branches on, so the measurement is exact and not a proxy.',
      fragments: triFragments,
      fragmentsAtFullRes: Math.round(triFragments * scale),
      objectsWithNonUniformScale: nonUniformScale,
      byThreshold: triplanar,
    },
    materials: ranked.slice(0, 16),
    perFunctionBasis: REAL,
  };
}

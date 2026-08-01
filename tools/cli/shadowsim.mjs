/**
 * A CPU re-implementation of the CSM shadow term, run over a real frame.
 *
 * WHY THIS EXISTS
 * `fragcost` counts texture fetches statically: it resolves loop trip counts and
 * propagates cost across calls, but it has to assume every branch is taken, so
 * it reports the shadow term at 52 fetches per fragment. That number is an upper
 * bound and nothing else. It cannot say how often the PCSS blocker search finds
 * no blocker and returns early, how often a pixel is in full umbra, or how much
 * screen the cascade cross-fade actually covers -- and those are exactly the
 * questions that decide whether a shader change is worth making.
 *
 * So this rasterizes the four cascade depth maps in software from the real light
 * cameras, rasterizes the camera view to get world position and normal per
 * pixel, and then runs the *same arithmetic as csm.js* per pixel with counters
 * on every branch. The output is a measurement, not a model.
 *
 * It also runs each pixel through both the old and the new shader and diffs the
 * results, which is the only way to price an "obviously safe" early-out honestly:
 * the claim is that the umbra early-out returns what the PCF loop would have
 * returned, and here that claim is checked against every pixel in the frame
 * rather than argued.
 *
 * WHAT IT IS NOT
 * There is no GPU, so this says nothing about ALU cost, texture cache behaviour,
 * or warp divergence -- only how many fetches are issued and what comes out.
 * Skinned casters rasterize in bind pose (the same limitation `shot` has), which
 * moves soldier shadows by a limb's width; it does not move the statistics.
 */
import * as THREE from 'three';
import { drawItem, collectDrawables } from './raster.mjs';

const fract = (x) => x - Math.floor(x);

/** A depth-only raster target. No colour buffer: 50 MB per cascade saved. */
function depthTarget(w, h) {
  const n = w * h;
  return {
    width: w,
    height: h,
    color: null,
    depth: new Float32Array(n).fill(Infinity),
    shaded: new Uint32Array(n),
    covered: new Uint32Array(n),
    tris: 0, trisDrawn: 0, meshes: 0, instances: 0,
  };
}

/** The depth material is DoubleSide, so the shadow raster must not cull. */
const DEPTH_SIDE = { side: THREE.DoubleSide };

/**
 * Vogel disc offsets, split into radius and base angle.
 *
 * The shader rotates the whole disc by a per-pixel angle, so the sin/cos of the
 * base angle can be hoisted out of the pixel loop and the rotation becomes one
 * complex multiply per tap.
 */
function vogel(n) {
  const r = new Float64Array(n), c = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = Math.sqrt((i + 0.5) / n);
    const t = i * 2.39996323;
    c[i] = Math.cos(t); s[i] = Math.sin(t);
  }
  return { r, c, s };
}

/**
 * Rasterize one cascade's depth map from its light camera.
 *
 * Reproduces `CascadedShadowMaps.render()`: the same per-cascade cylinder cull
 * decides which casters are submitted, so the map has the same holes the real
 * one has. Clear is 1.0, matching `setClearColor(0xffffff)`.
 */
export function renderCascade(csm, i, casters, nCasters, res) {
  const rt = depthTarget(res, res);
  const kept = csm._cullCascade(i, casters, nCasters);
  if (kept !== 0) {
    const vp = csm.matrices[i];
    for (let k = 0; k < nCasters; k++) {
      const o = casters[k];
      if (o.visible === false) continue;
      if (!o.geometry?.attributes?.position) continue;
      drawItem(rt, { object: o, material: DEPTH_SIDE }, vp, null);
    }
  }
  csm._restoreCulled();

  // NDC z -> the [0,1] window depth the depth material writes as gl_FragCoord.z.
  const n = res * res;
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const d = rt.depth[p];
    out[p] = d === Infinity ? 1.0 : d * 0.5 + 0.5;
  }
  return { map: out, casters: kept, tris: rt.trisDrawn };
}

/**
 * Camera-side G-buffer: world normal and a receive-shadow mask per pixel.
 *
 * Every opaque item is rasterized, because a wall that does not receive shadows
 * still occludes one that does; the mask then says which of the surviving
 * fragments actually run `owSunShadow`. That is `object.receiveShadow` and a
 * material the patcher touched -- the exact pair of conditions behind the
 * `receiveShadow ? owSunShadow(...) : 1.0` in materialpatch.js.
 */
function renderReceivers(engine, width, height) {
  const render = engine.ctx.peek('render');
  const patched = render?.patcher?._patched ?? null;
  const camera = engine.camera;

  const n = width * height;
  const rt = depthTarget(width, height);
  rt.color = new Float32Array(n * 3);
  const mask = new Uint8Array(n);

  const { opaque, culled } = collectDrawables(engine.scene, camera, { includeTransparent: false });
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  let receiverItems = 0;
  const shadeFor = (mat, obj) => {
    const isRecv = obj.receiveShadow === true && (patched === null || patched.has(mat));
    if (isRecv) receiverItems++;
    const flag = isRecv ? 1 : 0;
    return (color, i, nx, ny, nz) => {
      color[i] = nx; color[i + 1] = ny; color[i + 2] = nz;
      mask[i / 3] = flag;
    };
  };
  for (const item of opaque) drawItem(rt, item, vp, shadeFor);

  return { rt, mask, culled, opaqueItems: opaque.length, receiverItems };
}

/**
 * Run the shadow term over a rendered frame, counting every branch.
 *
 * @param engine      booted engine
 * @param casters     the caster list `csm.render()` was called with
 * @param nCasters    its length
 */
export function measureShadowCost(engine, casters, nCasters, {
  width = 480, height = 300, shadowRes = 0, blendT = 0.001, shaderSrc = '',
} = {}) {
  const render = engine.ctx.peek('render');
  const csm = render.csm;
  const u = csm.uniforms;
  const N = csm.cascades;
  const res = shadowRes || csm.mapSize;

  const t0 = Date.now();
  const cascades = [];
  for (let i = 0; i < N; i++) cascades.push(renderCascade(csm, i, casters, nCasters, res));
  const tShadow = Date.now() - t0;

  const t1 = Date.now();
  const { rt, mask, culled, opaqueItems, receiverItems } = renderReceivers(engine, width, height);
  const tCam = Date.now() - t1;

  // ---- uniforms, exactly as the shader sees them --------------------------
  const comp = ['x', 'y', 'z', 'w'];
  const split = comp.map((k) => u.owCsmSplit.value[k]);
  const splitNear = comp.map((k) => u.owCsmSplitNear.value[k]);
  const texelW = comp.map((k) => u.owCsmTexel.value[k]);
  const rangeW = comp.map((k) => u.owCsmRange.value[k]);
  const invTex = 1 / csm.mapSize;
  const mapSizeX = csm.mapSize;
  const params = u.owCsmParams.value;
  const strength = params.x, softness = params.y, maxTexels = params.z, rotBias = params.w;
  const sun = u.owSunDirWorld.value;

  // Tap counts come from a shader the engine actually compiled, not from a
  // second copy of the quality table here. A table that drifts out of sync with
  // csm.js would silently report the wrong shader.
  if (!shaderSrc) throw new Error('measureShadowCost needs the compiled owSunShadow fragment source');
  const BLOCKER = Number(/#define OW_BLOCKER_TAPS (\d+)/.exec(shaderSrc)?.[1] ?? NaN);
  const PCF = Number(/#define OW_PCF_TAPS (\d+)/.exec(shaderSrc)?.[1] ?? NaN);
  const PCSS = /#define OW_PCSS\b/.test(shaderSrc);
  if (!Number.isFinite(BLOCKER) || !Number.isFinite(PCF)) {
    throw new Error('could not read OW_BLOCKER_TAPS / OW_PCF_TAPS from the shader');
  }

  const vB = vogel(BLOCKER), vP = vogel(PCF);
  const maxR = maxTexels * invTex;
  const searchR = Math.min(maxR, 10.0 * invTex);

  const camera = engine.camera;
  const invVP = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const viewM = camera.matrixWorldInverse.elements;

  // ---- counters ------------------------------------------------------------
  const st = {
    receiverPixels: 0,
    beyondLastSplit: 0,
    backfacing: 0,
    cascadeCalls: 0,
    outsideMap: 0,
    depthOutOfRange: 0,
    fullyLit: 0,        // count < 0.5  -- the early-out that already shipped
    umbra: 0,           // count == BLOCKER -- the early-out under test
    penumbra: 0,        // the full PCF path
    umbraGuardBlocked: 0,
    // The already-shipped count<0.5 early-out, priced against the same ground
    // truth. This is the yardstick: a new approximation is defensible if it is
    // no worse than the one the shader has been using all along.
    shippedDiffPixels: 0,
    shippedDiffSum: 0,
    shippedDiffMax: 0,
    umbraFailByFilterTexels: new Float64Array(16),
    umbraHitByFilterTexels: new Float64Array(16),
    umbraFailLitTaps: new Float64Array(33),
    centreVariantHits: 0,
    centreVariantWrong: 0,
    centreVariantRejected: 0,
    centreVariantFalseReject: 0,
    shadingPixels: 0,   // receiver pixels that reach a cascade call at all
    blockerHist: new Float64Array(64), // distribution of occluded blocker taps
    diffHist: new Float64Array(9),     // |new - old| bucketed in 1/255 steps
    blendPixels: 0,     // pixels that take a second cascade at t > 0.001
    blendAt: new Float64Array(6), // coverage at rising thresholds
    tapsOld: 0,
    tapsNew: 0,
    tapsBlendRaised: 0,
    diffPixels: 0,
    diffMax: 0,
    diffSum: 0,
    blendDiffPixels: 0,
    blendDiffMax: 0,
    blendDiffSum: 0,
  };
  const THRESH = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1];

  const mapOf = (c) => cascades[c].map;
  const tap = (c, ux, uy) => {
    // NearestFilter, and the texture's v axis runs bottom-up while the raster's
    // rows run top-down.
    let x = Math.floor(ux * res);
    let y = Math.floor((1 - uy) * res);
    if (x < 0) x = 0; else if (x >= res) x = res - 1;
    if (y < 0) y = 0; else if (y >= res) y = res - 1;
    return mapOf(c)[y * res + x];
  };

  /**
   * `owCsmCascade`, line for line, with counters.
   *
   * Three values come back for every call, so the two early-outs can be priced
   * against ground truth rather than against each other:
   *   sNew    the shader as it stands now, with the umbra early-out
   *   sOld    the shader before it, with only the count<0.5 early-out
   *   sExact  no early-outs at all -- the PCF loop always run
   *
   * sExact is what makes this honest. Both early-outs are approximations: 10
   * sample points cannot prove what a whole disc contains. Comparing sNew to
   * sOld only says how much the new one moved things; comparing both to sExact
   * says whether the new one is worse than the approximation already shipping.
   *
   * For the count<0.5 case the shipped shader returns before filterR is ever
   * computed, so ground truth there uses the clamp minimum of 1 texel -- the
   * smallest disc the PCF loop is ever run with.
   */
  const cascadeAt = (c, wx, wy, wz, nx, ny, nz, NdL, cosPhi, sinPhi) => {
    st.cascadeCalls++;
    const tw = texelW[c], range = rangeW[c];
    const off = tw * (0.55 + 1.1 * (1 - NdL));
    const px = wx + nx * off, py = wy + ny * off, pz = wz + nz * off;

    const m = csm.matrices[c].elements;
    const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
    const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
    const cz = m[2] * px + m[6] * py + m[10] * pz + m[14];
    const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
    const iw = 1 / cw;
    const projZ = cz * iw * 0.5 + 0.5;
    if (projZ >= 1.0 || projZ <= 0.0) { st.depthOutOfRange++; return { s: 1, sOld: 1, taps: 0, tapsOld: 0 }; }
    const ux = cx * iw * 0.5 + 0.5;
    const uy = cy * iw * 0.5 + 0.5;
    const eu = Math.min(ux, 1 - ux), ev = Math.min(uy, 1 - uy);
    if (Math.min(eu, ev) <= 0.0) { st.outsideMap++; return { s: 1, sOld: 1, taps: 0, tapsOld: 0 }; }

    const slope = Math.min(5, Math.max(0, Math.sqrt(Math.max(0, 1 - NdL * NdL)) / Math.max(NdL, 0.12)));
    const bias = (tw * (0.7 + 1.15 * slope)) / range;
    const recv = projZ - bias;
    const extent = tw * mapSizeX;

    const pcf = (R) => {
      let sum = 0;
      for (let i = 0; i < PCF; i++) {
        const ox = (vP.c[i] * cosPhi - vP.s[i] * sinPhi) * vP.r[i] * R;
        const oy = (vP.s[i] * cosPhi + vP.c[i] * sinPhi) * vP.r[i] * R;
        if (recv <= tap(c, ux + ox, uy + oy)) sum += 1;
      }
      return sum / PCF;
    };

    // --- PCSS blocker search (absent below quality 2, where filterR is fixed) ---
    let filterR = 1.4 * invTex;
    let count = 0, pre = 0;
    if (PCSS) {
      pre = BLOCKER;
      let blocker = 0;
      for (let i = 0; i < BLOCKER; i++) {
        const ox = (vB.c[i] * cosPhi - vB.s[i] * sinPhi) * vB.r[i] * searchR;
        const oy = (vB.s[i] * cosPhi + vB.c[i] * sinPhi) * vB.r[i] * searchR;
        const d = tap(c, ux + ox, uy + oy);
        if (d < recv) { blocker += d; count += 1; }
      }
      st.blockerHist[count]++;
      if (count < 0.5) {
        st.fullyLit++;
        const exact = pcf(1.0 * invTex);
        if (exact !== 1) {
          st.shippedDiffPixels++;
          const d = Math.abs(1 - exact);
          st.shippedDiffSum += d;
          if (d > st.shippedDiffMax) st.shippedDiffMax = d;
        }
        return { s: 1, sOld: 1, sExact: exact, taps: pre, tapsOld: pre };
      }
      blocker /= count;
      const gap = Math.max(0, (recv - blocker) * range);
      const penumbra = gap * softness;
      filterR = Math.min(maxR, Math.max(1.0 * invTex, penumbra / extent));
    }

    // The full PCF loop is always evaluated here, whatever the shader would have
    // done, because it IS the ground truth the early-outs are measured against.
    const exact = pcf(filterR);

    const allBlocked = PCSS && count > BLOCKER - 0.5;
    if (allBlocked && !(filterR <= searchR)) st.umbraGuardBlocked++;
    if (allBlocked && filterR <= searchR) {
      st.umbra++;
      if (exact !== 0) {
        // Record how wide the PCF disc was when the early-out got it wrong. If
        // the failures cluster at the 1-texel clamp, the disc was far smaller
        // than the disc the blocker search proved occluded, and the guard needs
        // to be tighter than mere containment.
        const texels = Math.min(15, Math.round(filterR / invTex));
        st.umbraFailByFilterTexels[texels]++;
        st.umbraFailLitTaps[Math.round(exact * PCF)]++;
      }
      const texels = Math.min(15, Math.round(filterR / invTex));
      st.umbraHitByFilterTexels[texels]++;

      // Variant under test: spend ONE extra fetch at the disc centre before
      // trusting the early-out. The blocker ring's innermost tap sits at
      // sqrt(0.5/TAPS) * searchR -- 2 texels at ultra -- so when filterR clamps
      // to its 1-texel minimum the search never looked at the region the PCF
      // disc covers. A centre tap is the cheapest possible probe of exactly that
      // hole: 1 fetch against the 16 the early-out saves.
      const centreOccluded = tap(c, ux, uy) < recv;
      if (centreOccluded) {
        st.centreVariantHits++;
        if (exact !== 0) st.centreVariantWrong++;
      } else {
        st.centreVariantRejected++;
        if (exact === 0) st.centreVariantFalseReject++;
      }
      return { s: 0, sOld: exact, sExact: exact, taps: pre, tapsOld: pre + PCF };
    }
    st.penumbra++;
    return { s: exact, sOld: exact, sExact: exact, taps: pre + PCF, tapsOld: pre + PCF };
  };

  const { depth, color } = rt;
  const lastSplit = split[N - 1];

  for (let py = 0; py < height; py++) {
    for (let pxi = 0; pxi < width; pxi++) {
      const idx = py * width + pxi;
      if (mask[idx] === 0) continue;
      const dz = depth[idx];
      if (dz === Infinity) continue;
      st.receiverPixels++;

      // Reconstruct the world position of the surviving fragment. NDC z is
      // affine in screen space under a perspective projection, so the value the
      // rasterizer interpolated is the exact one.
      const ndcX = ((pxi + 0.5) / width) * 2 - 1;
      const ndcY = 1 - ((py + 0.5) / height) * 2;
      const e = invVP.elements;
      const hw = e[3] * ndcX + e[7] * ndcY + e[11] * dz + e[15];
      const ih = 1 / hw;
      const wx = (e[0] * ndcX + e[4] * ndcY + e[8] * dz + e[12]) * ih;
      const wy = (e[1] * ndcX + e[5] * ndcY + e[9] * dz + e[13]) * ih;
      const wz = (e[2] * ndcX + e[6] * ndcY + e[10] * dz + e[14]) * ih;

      // View depth, the shader's `-posView.z`.
      const vd = -(viewM[2] * wx + viewM[6] * wy + viewM[10] * wz + viewM[14]);
      if (vd >= lastSplit) { st.beyondLastSplit++; continue; }

      let nx = color[idx * 3], ny = color[idx * 3 + 1], nz = color[idx * 3 + 2];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const NdL = nx * sun.x + ny * sun.y + nz * sun.z;
      if (NdL <= 0) { st.backfacing++; continue; }
      st.shadingPixels++;

      const rot = fract(52.9829189 * fract((pxi + 0.5) * 0.06711056 + (py + 0.5 + rotBias) * 0.00583715)) * 6.2831853;
      const cosPhi = Math.cos(rot), sinPhi = Math.sin(rot);

      let c = N - 1;
      for (let i = 0; i < N; i++) { if (vd < split[i]) { c = i; break; } }

      const r0 = cascadeAt(c, wx, wy, wz, nx, ny, nz, NdL, cosPhi, sinPhi);
      let s = r0.s, sOld = r0.sOld;
      let taps = r0.taps, tapsOld = r0.tapsOld, tapsRaised = r0.taps;

      if (c < N - 1) {
        const a = splitNear[c], b = split[c];
        const lo = a + (b - a) * 0.88;
        const x = Math.min(1, Math.max(0, (vd - lo) / Math.max(1e-9, b - lo)));
        const t = x * x * (3 - 2 * x);
        for (let k = 0; k < THRESH.length; k++) if (t > THRESH[k]) st.blendAt[k]++;
        if (t > blendT) {
          st.blendPixels++;
          const r1 = cascadeAt(c + 1, wx, wy, wz, nx, ny, nz, NdL, cosPhi, sinPhi);
          taps += r1.taps; tapsOld += r1.tapsOld;
          if (t > 0.02) tapsRaised += r1.taps;
          else {
            // What raising the threshold to 0.02 would cost visually, exactly.
            const d = Math.abs(t * (r1.s - s));
            if (d > 1e-9) {
              st.blendDiffPixels++;
              st.blendDiffSum += d;
              if (d > st.blendDiffMax) st.blendDiffMax = d;
            }
          }
          s += (r1.s - s) * t;
          sOld += (r1.sOld - sOld) * t;
        }
      }

      const fade = (() => {
        const lo = lastSplit, hi = lastSplit * 0.88;
        const x = Math.min(1, Math.max(0, (vd - lo) / (hi - lo)));
        return x * x * (3 - 2 * x);
      })();
      s = 1 + (s - 1) * fade;
      sOld = 1 + (sOld - 1) * fade;
      s = 1 + (s - 1) * strength;
      sOld = 1 + (sOld - 1) * strength;

      const d = Math.abs(s - sOld);
      if (d > 1e-9) {
        st.diffPixels++;
        st.diffSum += d;
        if (d > st.diffMax) st.diffMax = d;
        st.diffHist[Math.min(8, Math.round(d * 255))]++;
      }

      st.tapsOld += tapsOld;
      st.tapsNew += taps;
      st.tapsBlendRaised += tapsRaised;
    }
  }
  const tEval = Date.now() - t1 - tCam;

  const rp = Math.max(1, st.receiverPixels);
  const sp = Math.max(1, st.shadingPixels);
  const pct = (x) => +(100 * x / rp).toFixed(2);
  return {
    resolution: `${width}x${height}`,
    shadowMapRaster: `${res}x${res}${res !== csm.mapSize ? ` (real ${csm.mapSize})` : ''}`,
    blockerTaps: BLOCKER,
    pcfTaps: PCF,
    ms: { shadowMaps: tShadow, cameraGBuffer: tCam, shaderEval: tEval },
    scene: {
      opaqueItems, receiverItems, frustumCulled: culled,
      castersPerCascade: cascades.map((c) => c.casters),
      shadowTrianglesRasterized: cascades.reduce((p, c) => p + c.tris, 0),
    },
    pixels: {
      receiverPixels: st.receiverPixels,
      // Everything past here costs nothing at all: the two scalar rejects at the
      // top of owSunShadow are already doing most of the work.
      beyondLastSplitPct: pct(st.beyondLastSplit),
      backfacingPct: pct(st.backfacing),
      shadingPixels: st.shadingPixels,
      shadingPixelsPct: pct(st.shadingPixels),
    },
    // Of every call into owCsmCascade, which exit did it take?
    cascadeCalls: st.cascadeCalls,
    exits: {
      outsideMapPct: +(100 * st.outsideMap / Math.max(1, st.cascadeCalls)).toFixed(2),
      depthOutOfRangePct: +(100 * st.depthOutOfRange / Math.max(1, st.cascadeCalls)).toFixed(2),
      fullyLitEarlyOutPct: +(100 * st.fullyLit / Math.max(1, st.cascadeCalls)).toFixed(2),
      umbraEarlyOutPct: +(100 * st.umbra / Math.max(1, st.cascadeCalls)).toFixed(2),
      fullPcfPct: +(100 * st.penumbra / Math.max(1, st.cascadeCalls)).toFixed(2),
      umbraBlockedByFilterGuard: st.umbraGuardBlocked,
      // How many of the blocker taps came back occluded. The two ends of this
      // histogram are the two early-outs; everything between them is penumbra
      // and has to run the full filter.
      blockerTapsOccludedHistogram: Object.fromEntries(
        [...st.blockerHist.slice(0, BLOCKER + 1)]
          .map((n, i) => [i, +(100 * n / Math.max(1, st.cascadeCalls)).toFixed(2)])
          .filter(([, v]) => v > 0)),
    },
    fetchesPerShadingPixel: {
      note: 'per pixel that actually runs owSunShadow past its scalar rejects',
      before: +(st.tapsOld / sp).toFixed(2),
      after: +(st.tapsNew / sp).toFixed(2),
      savedPct: +(100 * (st.tapsOld - st.tapsNew) / Math.max(1, st.tapsOld)).toFixed(2),
      ifBlendThresholdRaisedTo002: +(st.tapsBlendRaised / sp).toFixed(2),
      blendRaiseSavesPct: +(100 * (st.tapsNew - st.tapsBlendRaised) / Math.max(1, st.tapsNew)).toFixed(2),
    },
    fetchesPerReceiverPixel: {
      note: 'amortised over every receiver pixel, including the free rejects',
      before: +(st.tapsOld / rp).toFixed(2),
      after: +(st.tapsNew / rp).toFixed(2),
    },
    crossFade: {
      note: 'share of receiver pixels that pay for a SECOND cascade evaluation',
      coverageByThresholdPct: Object.fromEntries(THRESH.map((t, i) => [`t>${t}`, pct(st.blendAt[i])])),
    },
    // The whole point: does the early-out change the picture?
    outputDelta: {
      note: 'shadow factor in 0..1; |new - old| over every receiver pixel',
      changedPixels: st.diffPixels,
      changedPct: pct(st.diffPixels),
      maxAbs: +st.diffMax.toFixed(5),
      meanAbsOverChanged: +(st.diffSum / Math.max(1, st.diffPixels)).toFixed(5),
      maxAs8Bit: Math.round(st.diffMax * 255),
      // Bucketed in 1/255 steps, because a shadow factor that moves by less than
      // one 8-bit code cannot reach the framebuffer at all.
      histogram8Bit: Object.fromEntries([...st.diffHist]
        .map((n, i) => [i === 8 ? '8+' : i, n]).filter(([, v]) => v > 0)),
    },
    // Both early-outs against the same ground truth (the PCF loop always run).
    // The shipped one is the yardstick, not a control: it is an approximation
    // too, and it has been in the picture the whole time.
    approximationError: {
      note: 'per cascade call; ground truth is the PCF loop with no early-out at all',
      shippedFullyLitEarlyOut: {
        calls: st.fullyLit,
        wrongCalls: st.shippedDiffPixels,
        wrongPct: +(100 * st.shippedDiffPixels / Math.max(1, st.fullyLit)).toFixed(3),
        maxAbs: +st.shippedDiffMax.toFixed(5),
        meanAbsOverWrong: +(st.shippedDiffSum / Math.max(1, st.shippedDiffPixels)).toFixed(5),
      },
      newUmbraEarlyOut: {
        calls: st.umbra,
        wrongCalls: [...st.umbraFailLitTaps].reduce((p, c) => p + c, 0),
        wrongPct: +(100 * [...st.umbraFailLitTaps].reduce((p, c) => p + c, 0) / Math.max(1, st.umbra)).toFixed(3),
        // Where the failures sit. Concentration at 1 texel means the PCF disc
        // was far tighter than the disc the blocker search actually proved.
        wrongByFilterRadiusTexels: Object.fromEntries([...st.umbraFailByFilterTexels]
          .map((n, i) => [i, n]).filter(([, v]) => v > 0)),
        allByFilterRadiusTexels: Object.fromEntries([...st.umbraHitByFilterTexels]
          .map((n, i) => [i, n]).filter(([, v]) => v > 0)),
        wrongByLitPcfTaps: Object.fromEntries([...st.umbraFailLitTaps]
          .map((n, i) => [i, n]).filter(([, v]) => v > 0)),
      },
      // Would one extra fetch at the disc centre buy back the failures?
      plusCentreTapVariant: {
        note: 'costs 1 fetch on every umbra hit, saves the 16 the early-out skips',
        stillTakesEarlyOut: st.centreVariantHits,
        stillWrong: st.centreVariantWrong,
        wrongPct: +(100 * st.centreVariantWrong / Math.max(1, st.centreVariantHits)).toFixed(3),
        // Calls the centre tap pushes back onto the full PCF loop although the
        // early-out would have been right -- the price of the extra safety.
        rejectedButWouldHaveBeenCorrect: st.centreVariantFalseReject,
        rejectedTotal: st.centreVariantRejected,
      },
    },
    blendRaiseDelta: {
      note: 'what raising the cross-fade threshold 0.001 -> 0.02 would change',
      changedPixels: st.blendDiffPixels,
      changedPct: pct(st.blendDiffPixels),
      maxAbs: +st.blendDiffMax.toFixed(5),
      maxAs8Bit: Math.round(st.blendDiffMax * 255),
    },
  };
}

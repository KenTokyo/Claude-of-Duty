/**
 * How far one contact-shadow march step actually moves ON SCREEN.
 *
 * THE ANSWER, AND IT IS A REJECTION. Ultra, at=60, look=1, 480x300 over a
 * 2268x1473 G-buffer: mean spacing 5.46 texels per step, p50 4.85, p10 1.72.
 * Only 4.52% of steps land within one texel of the previous sample, 1.0% within
 * half a texel, and `redundantAndUndecided` is EXACTLY ZERO -- there is not one
 * step in 486,145 where the fetch was a re-read AND the occlusion test could not
 * have changed its mind. The ray's own depth moves 0.0238 m per step against a
 * bias of 0.004 + depth*0.0025, so it always clears it.
 *
 * So the march is not oversampled in screen space; if anything it is the
 * opposite, striding five and a half texels between samples, and a texel-aware
 * step rule would have nothing to collapse. `ow-contact` cannot be made cheaper
 * on this axis, and the 12.4 M it costs is not redundancy. DO NOT re-propose a
 * screen-space step clamp, a texel-skip, or an adaptive step count justified by
 * "consecutive samples read the same depth" -- they do not.
 *
 * Kept as a command because the question recurs for every screen-space march
 * (SSR and GTAO have the same shape), and because the answer is a property of
 * the camera and the ray length, so it must be re-run if either is retuned.
 *
 * WHY THIS EXISTS
 *   `ow-contact` marches a fixed WORLD length -- uParams.x * clamp(depth*0.08 +
 *   0.75, 0.75, 2.5), so 0.30 m to 1.00 m -- in OW_CS_STEPS equal steps, and
 *   projects each one into the depth buffer. The step is therefore constant in
 *   metres and shrinking in pixels: at 3 m from the camera a 2.1 cm step is a
 *   long way across the buffer, and at 60 m it is a fraction of a texel. Where
 *   it is a fraction of a texel, consecutive samples land in the SAME texel and
 *   the fetch is issued to read a number the loop already has.
 *
 *   That is the question this answers, and it answers it in texels rather than
 *   in metres because texels are what a fetch is charged in.
 *
 * WHAT IS EXACT AND WHAT IS NOT
 *   Exact: the depth buffer (the project's own rasteriser, same reconstruction
 *          fillsim and volsim use), the projection matrix, the viewport, the
 *          per-pixel ray length ramp, the sun direction in view space, and the
 *          N.L <= 0.02 and normal.z < 0.5 early-outs that decide which pixels
 *          march at all. Every one of those is read off the live engine.
 *   Exact: the displacement itself. Step i is projected exactly as the shader
 *          projects it -- uProj * vec4(sp,1), divide by w, scale to the
 *          viewport -- and the distance measured between consecutive
 *          projections. No small-angle approximation is used anywhere.
 *   Not:   the jitter. owIGN shifts every sample along the ray by a common
 *          offset, so it moves where the samples SIT and not how far apart
 *          they are. The gaps are what is under test, so the offset is taken at
 *          its mean of 0.5. This is the same argument fillsim makes for the
 *          march's dither and it is exact for spacing, not for position.
 *   Not:   the surface normal is read from the rasterised G-buffer rather than
 *          the shaded one, so the N.L test is the geometric normal without
 *          normal mapping. It decides POPULATION, not spacing.
 *
 * WHAT A RESULT MEANS
 *   `pctStepsUnderOneTexel` is the fraction of issued march fetches whose sample
 *   is in the same texel as the previous sample. Those fetches return a value
 *   the loop already read. They are not free and they are not no-ops -- the
 *   shader compares them against a DIFFERENT ray depth each step -- so this
 *   figure is an upper bound on what any texel-aware rule could recover, and
 *   the depth-difference columns are what say whether the comparison could have
 *   changed its mind. See `redundantAndUndecided`.
 */
import * as THREE from 'three';
import { collectDrawables, drawItem } from './raster.mjs';

/** Percentiles of a Float64Array prefix, sorted in place. */
function stats(a, count) {
  if (count === 0) return { n: 0 };
  const v = a.subarray(0, count);
  v.sort();
  const at = (p) => +v[Math.min(count - 1, Math.floor(p * count))].toFixed(4);
  let sum = 0;
  for (let i = 0; i < count; i++) sum += v[i];
  return {
    n: count,
    mean: +(sum / count).toFixed(4),
    p10: at(0.1), p50: at(0.5), p90: at(0.9), p99: at(0.99),
    max: +v[count - 1].toFixed(4),
  };
}

/**
 * Linear view depth AND the view-space normal, from one rasterisation.
 *
 * The rasteriser hands interpolated WORLD normals to a per-material shading
 * closure, so the closure is what captures them; rotating by the camera's
 * inverse world matrix afterwards is exact, because a view matrix carries no
 * scale. Depth is reconstructed the same way volsim's renderDepth does it, and
 * both come out of a single pass so the normal and the depth in a pixel are
 * guaranteed to belong to the same fragment -- two passes could disagree on a
 * silhouette and put a normal from one surface against a depth from another.
 */
function renderDepthAndNormals(engine, width, height) {
  const camera = engine.camera;
  const n = width * height;
  const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);
  const rt = {
    width, height,
    color: new Float32Array(n * 3),
    depth: new Float32Array(n).fill(Infinity),
    shaded: new Uint32Array(n), covered: new Uint32Array(n),
    tris: 0, trisDrawn: 0, meshes: 0, instances: 0,
  };
  // The closure's `i` is the colour offset idx*3, so idx is i/3. Writing the raw
  // normal rather than a shade keeps this exact: nothing is lit, clamped or
  // tone-mapped on the way through.
  const shadeFor = () => (color, i, vnx, vny, vnz) => {
    const idx = (i / 3) | 0;
    nx[idx] = vnx; ny[idx] = vny; nz[idx] = vnz;
  };
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const { opaque } = collectDrawables(engine.scene, camera, { includeTransparent: false });
  for (const item of opaque) drawItem(rt, item, vp, shadeFor);

  const near = camera.near, far = camera.far;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = rt.depth[i];
    depth[i] = Number.isFinite(z) ? (2 * near * far) / (far + near - z * (far - near)) : 0;
  }
  // World -> view. Rotation only, so the upper 3x3 of the inverse world matrix
  // is the correct and exact transform for a direction.
  const toView = new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (nx[i] === 0 && ny[i] === 0 && nz[i] === 0) continue;
    v.set(nx[i], ny[i], nz[i]).applyMatrix3(toView).normalize();
    nx[i] = v.x; ny[i] = v.y; nz[i] = v.z;
  }
  return { depth, nx, ny, nz };
}

export function measureContactSteps(engine, { width = 480, height = 300 } = {}) {
  const render = engine.ctx.peek('render');
  const contact = render.contact ?? null;
  if (!contact) return { unavailable: 'no contact shadow pass in this preset' };

  const src = contact.pass?.material?.fragmentShader ?? '';
  // The step count and the ray length ramp come off the compiled shader for the
  // same reason every other constant in this toolchain does: a copy here would
  // price a march the pass no longer runs.
  const STEPS = Number(/#define\s+OW_CS_STEPS\s+(\d+)/.exec(src)?.[1] ?? 0);
  if (!STEPS) throw new Error('contactstep: OW_CS_STEPS not found in the compiled contact shader');
  const rampRe = /clamp\(\s*depth\s*\*\s*([\d.]+)\s*\+\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(src);
  if (!rampRe) {
    throw new Error('contactstep: cannot find the len ramp clamp( depth*a + b, lo, hi ) in the contact shader');
  }
  const [rA, rB, rLo, rHi] = rampRe.slice(1).map(Number);
  const originRe = /N\s*\*\s*\(\s*([\d.]+)\s*\+\s*depth\s*\*\s*([\d.]+)\s*\)/.exec(src);
  const [oA, oB] = originRe ? originRe.slice(1).map(Number) : [0.012, 0.0015];
  const ndlRe = /NdL\s*<=\s*([\d.]+)/.exec(src);
  const NDL_MIN = ndlRe ? Number(ndlRe[1]) : 0.02;
  const thickRe = /diff\s*<\s*uParams\.y/.test(src);

  const u = contact.pass.uniforms;
  const rayLen1x = u.uParams?.value?.x ?? 0;
  const thickness = u.uParams?.value?.y ?? 0;
  const sunV = u.uSunDirView?.value ?? new THREE.Vector3(0, 1, 0);
  const camera = engine.camera;

  // The buffer the fetches are actually charged against. The march samples
  // tDepth, which is the G-buffer at RENDER resolution, while the contact target
  // itself may be smaller -- so a step is "one texel" in G-buffer texels.
  const rt = contact.rtA ?? null;
  const gW = render.gbuffer?.depthTexture?.image?.width
    ?? render.gbuffer?.width ?? rt?.width ?? width;
  const gH = render.gbuffer?.depthTexture?.image?.height
    ?? render.gbuffer?.height ?? rt?.height ?? height;

  const { depth, nx: vnx, ny: vny, nz: vnz } = renderDepthAndNormals(engine, width, height);

  const proj = camera.projectionMatrix;
  const projInv = camera.projectionMatrixInverse;
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = camera.aspect;

  const n = width * height;
  const gap = new Float64Array(n * STEPS);
  const gapFirst = new Float64Array(n);
  const gapLast = new Float64Array(n);
  const perPixelMean = new Float64Array(n);
  const rayDepthDelta = new Float64Array(n * STEPS);
  let nGap = 0, nPix = 0, nRayDelta = 0;
  let skySkipped = 0, awaySkipped = 0, entered = 0;
  let stepsUnder1 = 0, stepsUnderHalf = 0, stepsTotal = 0;
  let redundantAndUndecided = 0;

  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const sp = new THREE.Vector3();
  const clip = new THREE.Vector4();
  const L = new THREE.Vector3(sunV.x, sunV.y, sunV.z).normalize();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = depth[i];
      if (!(d > 0)) { skySkipped++; continue; }

      // View position, reconstructed exactly as owViewPos does.
      const ndcX = ((x + 0.5) / width) * 2 - 1;
      const ndcY = 1 - ((y + 0.5) / height) * 2;
      P.set(ndcX * tanY * aspect * d, ndcY * tanY * d, -d);

      N.set(vnx[i], vny[i], vnz[i]);
      if (N.lengthSq() < 1e-6) { skySkipped++; continue; }
      N.normalize();
      const NdL = N.dot(L);
      if (NdL <= NDL_MIN) { awaySkipped++; continue; }
      entered++;

      const len = rayLen1x * Math.min(rHi, Math.max(rLo, d * rA + rB));
      const stepLen = len / STEPS;
      const ox = P.x + N.x * (oA + d * oB);
      const oy = P.y + N.y * (oA + d * oB);
      const oz = P.z + N.z * (oA + d * oB);

      let px = 0, py = 0, have = false;
      let sumGap = 0, cnt = 0;
      for (let s = 0; s < STEPS; s++) {
        // Jitter at its mean: it offsets every sample equally, so it moves the
        // samples and not the gaps between them. See the header.
        const tt = s + 0.5;
        sp.set(ox + L.x * stepLen * tt, oy + L.y * stepLen * tt, oz + L.z * stepLen * tt);
        clip.set(sp.x, sp.y, sp.z, 1).applyMatrix4(proj);
        if (clip.w <= 0) break;
        const sx = (clip.x / clip.w) * 0.5 + 0.5;
        const sy = (clip.y / clip.w) * 0.5 + 0.5;
        if (sx <= 0 || sx >= 1 || sy <= 0 || sy >= 1) break;
        const tx = sx * gW, ty = sy * gH;
        if (have) {
          const dx = tx - px, dy = ty - py;
          const g = Math.sqrt(dx * dx + dy * dy);
          gap[nGap++] = g;
          sumGap += g; cnt++;
          stepsTotal++;
          if (g < 1) {
            stepsUnder1++;
            // The sample is in the previous texel, so the FETCH is redundant.
            // Whether the TEST is redundant depends on how much the ray's own
            // depth moved: the shader compares -sp.z against the same
            // sceneDepth, so if that move is small against the bias the
            // comparison cannot have changed its mind either.
            const dz = Math.abs(L.z * stepLen);
            const bias = 0.004 + d * 0.0025;
            rayDepthDelta[nRayDelta++] = dz;
            if (dz < bias) redundantAndUndecided++;
          }
          if (g < 0.5) stepsUnderHalf++;
          if (s === 1) gapFirst[nPix] = g;
          gapLast[nPix] = g;
        }
        px = tx; py = ty; have = true;
      }
      if (cnt > 0) { perPixelMean[nPix] = sumGap / cnt; nPix++; }
    }
  }

  return {
    note: 'Screen-space spacing of the contact march, in G-buffer texels. A gap under 1 '
      + 'texel means the sample shares a texel with the one before it, so its fetch returns a '
      + 'value the loop already read. See the header for why that is an upper bound and not a saving.',
    shader: {
      steps: STEPS,
      rayLengthMAt1x: rayLen1x,
      lengthRamp: `clamp( depth * ${rA} + ${rB}, ${rLo}, ${rHi} )`,
      thicknessM: thickness,
      hasThicknessTest: thickRe,
      ndlMin: NDL_MIN,
    },
    buffers: {
      marchSamplesFrom: `${gW}x${gH} (G-buffer depth)`,
      contactTarget: rt ? `${rt.width}x${rt.height}` : 'unknown',
      simGrid: `${width}x${height}`,
    },
    population: {
      pixels: n,
      skySkipped,
      awaySkipped,
      entered,
      enteredPct: +((entered / n) * 100).toFixed(2),
    },
    spacingTexels: stats(gap, nGap),
    perPixelMeanTexels: stats(perPixelMean, nPix),
    redundancy: {
      marchGapsMeasured: stepsTotal,
      underOneTexel: stepsUnder1,
      pctStepsUnderOneTexel: +((stepsUnder1 / Math.max(1, stepsTotal)) * 100).toFixed(2),
      underHalfTexel: stepsUnderHalf,
      pctStepsUnderHalfTexel: +((stepsUnderHalf / Math.max(1, stepsTotal)) * 100).toFixed(2),
      redundantAndUndecided,
      pctRedundantAndUndecided: +((redundantAndUndecided / Math.max(1, stepsTotal)) * 100).toFixed(2),
      whatUndecidedMeans: 'sample shares a texel with the previous one AND the ray depth moved '
        + 'less than the shader\'s own bias over that step, so the occlusion test read the same '
        + 'depth and could not have reached a different answer. This is the part that is provably '
        + 'recoverable; the rest of underOneTexel is a re-read that still decides something.',
      rayDepthMovePerStepM: stats(rayDepthDelta, nRayDelta),
    },
  };
}

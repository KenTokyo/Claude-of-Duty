/**
 * What the fullscreen passes REALLY fetch, as opposed to what they could.
 *
 * `fill` counts the fragments each fullscreen pass covers and multiplies by the
 * `fragcost` upper bound, which assumes every branch is taken. Every one of the
 * expensive passes opens with an early-out that the bound has to ignore:
 * SSR abandons sky pixels and rays pointing back at the camera, contact shadows
 * abandon anything facing away from the sun, GTAO abandons sky, and the
 * volumetric march stops asking the cascades for visibility the moment its ray
 * passes the last split. Ranking on the bound therefore ranks the shader with
 * the most generous worst case first, which is not the same question as which
 * shader is the frame.
 *
 * This rasterises the camera view once -- linear view depth and view-space
 * normal per pixel, the same two quantities the prepass writes -- and then
 * evaluates those conditions per pixel against the engine's live uniforms.
 *
 * WHAT IS EXACT HERE AND WHAT IS NOT
 *   Exact: the sky mask, the SSR facing test, the contact NdL test, and the
 *          volumetric march's per-pixel step count inside the shadow distance.
 *          These are closed-form functions of depth, normal and uniforms this
 *          reads off the running engine, so they are computed, not modelled.
 *   Not:   where a march BREAKS on a hit. SSR and contact shadows both stop at
 *          the first occluder, so their true cost is bounded above by the
 *          "entered" figure here and below by one step. This reports the
 *          entered fraction and says so rather than inventing a hit rate.
 *   Absent: object motion. Motion-blur velocity is reconstructed from the
 *          camera's own frame-to-frame reprojection, which is every static
 *          pixel in the frame and no moving one.
 */
import * as THREE from 'three';
import { collectDrawables, createTarget, drawItem } from './raster.mjs';
import { fragmentCost } from './fragcost.mjs';

/**
 * Linear view depth + view normal per pixel, which is what the gbuffer holds.
 *
 * Depth comes from the rasteriser's own z-buffer rather than being interpolated
 * a second time here: that buffer is what won the depth test, so reading it
 * back cannot disagree with the coverage mask beside it.
 */
export function renderGBuffer(engine, width, height) {
  const camera = engine.camera;
  const rt = createTarget(width, height);
  const n = width * height;
  const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);

  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const { opaque, culled } = collectDrawables(engine.scene, camera, { includeTransparent: false });
  const shadeFor = () => (color, i, a, b, c) => {
    const p = i / 3;
    nx[p] = a; ny[p] = b; nz[p] = c;
  };
  for (const item of opaque) drawItem(rt, item, vp, shadeFor);

  // NDC z back to metres. The rasteriser stores clip z/w, and the projection is
  // the camera's own, so this inverts exactly the transform that produced it.
  const near = camera.near, far = camera.far;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = rt.depth[i];
    depth[i] = Number.isFinite(z) ? (2 * near * far) / (far + near - z * (far - near)) : 0;
  }
  return { depth, nx, ny, nz, covered: rt.shaded, culled, opaqueItems: opaque.length };
}

/** Mean, and the share of pixels satisfying a predicate, over the covered set. */
const pct = (a, b) => +(100 * a / Math.max(1, b)).toFixed(2);

// Half-float rounds to zero below half of its smallest subnormal. This is the
// whole test fx-haze-warp's early-out turns on, so it gets a named constant
// rather than a literal buried in a comparison.
const HALF_MIN_NONZERO = 2 ** -25;

const STRIDE = 32;               // fx/particles.js, floats per instance
const O_PS = 0, O_VS = 4, O_LF = 8, O_RT = 12, O_C0 = 16, O_C1 = 20, O_MS = 24, O_EX = 28;

const gsmooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Rebuild the half-resolution distortion buffer fx-haze-warp reads, and count
 * the texels that are really non-zero.
 *
 * The warp pass returns after two fetches wherever `d == vec2( 0.0 )`, and that
 * branch is not a rounding argument: the distortion target is cleared to zero
 * and written only under a sprite, and where it reads back zero the three
 * chromatic taps are three fetches of the SAME texel, so `outColor = texture(
 * tColor, vUvw )` is the identical value bit for bit. What the branch is worth
 * therefore reduces to one question -- how much of the screen a live distortion
 * sprite covers -- and that is a rasterisation question, not an estimate. PH13
 * put it at 97% by argument. This measures it.
 *
 * Everything the GPU does to produce that buffer is reproduced here:
 *   - the ballistic + turbulence integration in PARTICLE_VERT, so a sprite sits
 *     where it is drawn rather than where it was emitted
 *   - the billboard corners in VIEW space, which is what makes this cheap: the
 *     quad's four corners share one view z, so its projection is affine and its
 *     near-plane test is all-or-nothing rather than a clip
 *   - the atlas, sampled bilinearly from the CPU-side DataTexture with the sRGB
 *     decode the hardware applies to RGB but not to A
 *   - both discards (`vCol.a <= 0` and `a < 0.004`), the soft-depth occlusion
 *     test and the depth fade that follows it
 *   - additive OneFactor/OneFactor accumulation into the RG target, so two
 *     sprites that overlap compound the way they do on the GPU
 *   - the half-float store, which is where an offset too small to represent
 *     becomes exactly zero again and hands the pixel back to the early-out
 *
 * Run at the distortion target's OWN resolution rather than the simulation
 * grid's, because the answer is then dilated by one texel for the warp's
 * bilinear fetch -- and one texel of a 480-wide grid is nearly five texels of
 * the real one, which would inflate the perimeter band by a factor of five.
 */
export function measureHazeDistortion(engine, { depth, width, height, screenW, screenH }) {
  const hz = engine.ctx?.peek?.('fx')?.hazeSys ?? null;
  if (!hz?.pass?.enabled || !hz.rt) return null;
  const layer = hz.layer;
  const img = layer.uniforms.uSprite?.value?.image ?? null;
  if (!img?.data || !layer.array) return null;
  const camera = engine.camera;

  const rw = Math.max(1, hz.size.x | 0), rh = Math.max(1, hz.size.y | 0);
  const nTex = rw * rh;
  const accX = new Float64Array(nTex), accY = new Float64Array(nTex);
  const stamp = new Int32Array(nTex);

  const aw = img.width, ah = img.height, ad = img.data;
  // The atlas is tagged SRGBColorSpace, so the driver decodes RGB on the way
  // out and leaves A alone -- fx/atlas.js writes linear RGB and sRGB-encodes it
  // on upload, so tex.r in the shader is the painter's own linear value.
  const S2L = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  const tex = [0, 0];
  const sampleAtlas = (u, v) => {
    const fx = u * aw - 0.5, fy = v * ah - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const cl = (a, hi) => Math.min(hi, Math.max(0, a));
    const x0 = cl(ix, aw - 1), x1 = cl(ix + 1, aw - 1);
    const y0 = cl(iy, ah - 1), y1 = cl(iy + 1, ah - 1);
    const i00 = (y0 * aw + x0) * 4, i10 = (y0 * aw + x1) * 4;
    const i01 = (y1 * aw + x0) * 4, i11 = (y1 * aw + x1) * 4;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty, w11 = tx * ty;
    tex[0] = S2L[ad[i00]] * w00 + S2L[ad[i10]] * w10 + S2L[ad[i01]] * w01 + S2L[ad[i11]] * w11;
    tex[1] = (ad[i00 + 3] * w00 + ad[i10 + 3] * w10 + ad[i01 + 3] * w01 + ad[i11 + 3] * w11) / 255;
  };

  const arr = layer.array;
  const count = Math.min(layer.capacity, layer.geometry.instanceCount | 0);
  const uTime = layer.uniforms.uTime.value;
  const atlasCols = layer.uniforms.uAtlas.value.x;
  const invCols = layer.uniforms.uAtlas.value.y;
  const softOn = layer.uniforms.uSoftEnable.value.x > 0.5;
  const vm = camera.matrixWorldInverse.elements, pm = camera.projectionMatrix.elements;

  let live = 0, drawn = 0, behindNear = 0, offScreen = 0, shaded = 0, discardAlpha = 0;
  let occluded = 0, zeroField = 0, wrote = 0;

  // PlaneGeometry(1,1,1,1): four corners, uv = position.xy + 0.5.
  const CX = [-0.5, 0.5, -0.5, 0.5], CY = [0.5, 0.5, -0.5, -0.5];
  const sx = [0, 0, 0, 0], sy = [0, 0, 0, 0];
  const qx = [0, 0, 0, 0], qy = [0, 0, 0, 0];
  const uu = [0, 0, 0, 0], vv = [0, 0, 0, 0];

  for (let p = 0; p < count; p++) {
    const o = p * STRIDE;
    const birth = arr[o + O_LF], invLife = arr[o + O_LF + 1];
    const t = uTime - birth, nAge = t * invLife;
    // PARTICLE_VERT pushes a dead instance behind the far plane, where it is
    // clipped before rasterisation -- not drawn transparently.
    if (!(t >= 0) || !(nAge < 1)) continue;
    live++;

    const k = Math.max(arr[o + O_LF + 2], 0.02);
    const e = Math.exp(-k * t);
    const gky = arr[o + O_LF + 3] / k;
    const ramp = (1 - e) / k;
    let wx = arr[o + O_PS] + arr[o + O_VS] * ramp;
    let wy = arr[o + O_PS + 1] + (arr[o + O_VS + 1] - gky) * ramp + gky * t;
    let wz = arr[o + O_PS + 2] + arr[o + O_VS + 2] * ramp;
    let vx = arr[o + O_VS] * e;
    let vy = arr[o + O_VS + 1] * e + gky * (1 - e);
    let vz = arr[o + O_VS + 2] * e;
    const ph = arr[o + O_EX + 2] * 6.2831853;
    const f = arr[o + O_EX + 1];
    const amp = arr[o + O_EX] * gsmooth(0, 0.4, nAge);
    if (amp !== 0) {
      wx += Math.sin(t * f * 1.13 + ph) * amp;
      wy += Math.sin(t * f * 0.79 + ph * 2.1) * amp;
      wz += Math.cos(t * f * 1.31 + ph * 1.7) * amp;
      vx += Math.cos(t * f * 1.13 + ph) * amp * f;
      vy += Math.cos(t * f * 0.79 + ph * 2.1) * amp * f;
      vz += -Math.sin(t * f * 1.31 + ph * 1.7) * amp * f;
    }

    // view space
    const mvx = vm[0] * wx + vm[4] * wy + vm[8] * wz + vm[12];
    const mvy = vm[1] * wx + vm[5] * wy + vm[9] * wz + vm[13];
    const mvz = vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
    const velX = vm[0] * vx + vm[4] * vy + vm[8] * vz;
    const velY = vm[1] * vx + vm[5] * vy + vm[9] * vz;
    const velZ = vm[2] * vx + vm[6] * vy + vm[10] * vz;
    const viewZ = -mvz;
    if (!(viewZ > camera.near)) { behindNear++; continue; }

    const size = arr[o + O_PS + 3]
      + (arr[o + O_VS + 3] - arr[o + O_PS + 3]) * (nAge ** Math.max(arr[o + O_RT + 3], 0.02));
    // vCol, and the two things the fragment shader reads off it.
    const inten = arr[o + O_C0 + 3] + (arr[o + O_C1 + 3] - arr[o + O_C0 + 3]) * nAge * nAge;
    let colR = (arr[o + O_C0] + (arr[o + O_C1] - arr[o + O_C0]) * nAge) * inten;
    if (arr[o + O_EX + 3] > 0.5) colR *= 0.72 + 0.28 * Math.sin(t * 63 + ph * 9);
    const colA = arr[o + O_MS + 2] * Math.max(1 - nAge, 0) ** Math.max(arr[o + O_MS + 3], 0.02)
      * gsmooth(0, 0.045, nAge);
    if (!(colA > 0)) continue;                                   // `vCol.a <= 0.0` discard
    const vSoft = Math.max(arr[o + O_MS + 1], 0.002);
    const tileX = arr[o + O_MS] % atlasCols, tileY = Math.floor(arr[o + O_MS] * invCols);

    const stretch = arr[o + O_RT + 2];
    let ax = 0, ay = 1, px_ = -1, py_ = 0, len = size;
    if (stretch > 0.001) {
      const dl = Math.hypot(velX, velY);
      if (dl > 1e-5) { ax = velX / dl; ay = velY / dl; }
      px_ = -ay; py_ = ax;
      len = size * (1 + stretch * Math.hypot(velX, velY, velZ));
    }
    const rot = arr[o + O_RT] + arr[o + O_RT + 1] * t;
    const sr = Math.sin(rot), cr = Math.cos(rot);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let c = 0; c < 4; c++) {
      let ox, oy;
      if (stretch > 0.001) {
        ox = ax * (CY[c] * len) + px_ * (CX[c] * size);
        oy = ay * (CY[c] * len) + py_ * (CX[c] * size);
      } else {
        ox = (CX[c] * cr - CY[c] * sr) * size;
        oy = (CX[c] * sr + CY[c] * cr) * size;
      }
      const cx = mvx + ox, cy = mvy + oy;
      const cw = -(pm[2] * cx + pm[6] * cy + pm[10] * mvz + pm[14]);
      const clx = pm[0] * cx + pm[4] * cy + pm[8] * mvz + pm[12];
      const cly = pm[1] * cx + pm[5] * cy + pm[9] * mvz + pm[13];
      const iw = 1 / cw;
      sx[c] = ((clx * iw) * 0.5 + 0.5) * rw;
      sy[c] = (0.5 - (cly * iw) * 0.5) * rh;
      qx[c] = ox / Math.max(size, 1e-4) * 2;
      qy[c] = oy / Math.max(size, 1e-4) * 2;
      uu[c] = (CX[c] + 0.5 + tileX) * invCols;
      vv[c] = (CY[c] + 0.5 + tileY) * invCols;
      if (sx[c] < minX) minX = sx[c];
      if (sx[c] > maxX) maxX = sx[c];
      if (sy[c] < minY) minY = sy[c];
      if (sy[c] > maxY) maxY = sy[c];
    }
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(rw - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(rh - 1, Math.ceil(maxY));
    if (x1 < x0 || y1 < y0) { offScreen++; continue; }
    drawn++;

    // Two triangles, PlaneGeometry's own winding. The quad is planar and at one
    // view z, so interpolation is affine -- perspective correction with a
    // constant w is the identity, which is why no 1/w term appears below.
    const TRI = [[0, 2, 1], [2, 3, 1]];
    const mark = p + 1;
    for (const [ia, ib, ic] of TRI) {
      const ex1 = sx[ib] - sx[ia], ey1 = sy[ib] - sy[ia];
      const ex2 = sx[ic] - sx[ia], ey2 = sy[ic] - sy[ia];
      const area = ex1 * ey2 - ey1 * ex2;
      if (Math.abs(area) < 1e-12) continue;
      const invA = 1 / area;
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const idx = y * rw + x;
          if (stamp[idx] === mark) continue;
          const cx = x + 0.5;
          const rx = cx - sx[ia], ry = cy - sy[ia];
          const b1 = (rx * ey2 - ry * ex2) * invA;
          const b2 = (ex1 * ry - ey1 * rx) * invA;
          if (b1 < 0 || b2 < 0 || b1 + b2 > 1) continue;
          const b0 = 1 - b1 - b2;
          stamp[idx] = mark;
          shaded++;

          const u = uu[ia] * b0 + uu[ib] * b1 + uu[ic] * b2;
          const v = vv[ia] * b0 + vv[ib] * b1 + vv[ic] * b2;
          sampleAtlas(u, v);
          let a = tex[1] * colA;
          if (a < 0.004) { discardAlpha++; continue; }

          if (softOn) {
            // uDepth is the prepass R32F target: linear view depth in metres,
            // zero where nothing was written, which the shader reads as 1e6.
            const dxi = Math.min(width - 1, ((cx / rw) * width) | 0);
            const dyi = Math.min(height - 1, ((cy / rh) * height) | 0);
            const dz = depth[dyi * width + dxi];
            const sceneZ = dz > 0.001 ? dz : 1e6;
            if (sceneZ < viewZ) { occluded++; continue; }
            a *= Math.min(1, Math.max(0, (sceneZ - viewZ) / vSoft));
          }

          const gx = qx[ia] * b0 + qx[ib] * b1 + qx[ic] * b2;
          const gy = qy[ia] * b0 + qy[ib] * b1 + qy[ic] * b2;
          const ql = Math.hypot(gx, gy);
          if (!(ql > 1e-4)) { zeroField++; continue; }
          const field = (tex[0] - 0.42) * 2;
          const s = (field * a * colR) / ql;
          if (s === 0) { zeroField++; continue; }
          accX[idx] += gx * s;
          accY[idx] += gy * s;
          wrote++;
        }
      }
    }
  }

  // The half-float store. An offset under half of the smallest subnormal comes
  // back as exactly zero and the pixel takes the early-out after all.
  let nonZero = 0;
  const nz = new Uint8Array(nTex);
  for (let i = 0; i < nTex; i++) {
    if (Math.abs(accX[i]) > HALF_MIN_NONZERO || Math.abs(accY[i]) > HALF_MIN_NONZERO) {
      nz[i] = 1; nonZero++;
    }
  }

  // The warp runs at full resolution and fetches tDistort with a LINEAR filter,
  // so a full-res pixel sees a 2x2 block of texels and takes the long path if
  // any one of them is non-zero. Counted against the real screen rather than the
  // simulation grid, since that is the population `fill` multiplies.
  const fw = Math.max(1, screenW | 0), fh = Math.max(1, screenH | 0);
  let warpLong = 0;
  const cols4 = new Int32Array(fw * 2);
  for (let x = 0; x < fw; x++) {
    const hx = ((x + 0.5) / fw) * rw - 0.5;
    const i0 = Math.floor(hx);
    cols4[x * 2] = Math.min(rw - 1, Math.max(0, i0));
    cols4[x * 2 + 1] = Math.min(rw - 1, Math.max(0, i0 + 1));
  }
  for (let y = 0; y < fh; y++) {
    const hy = ((y + 0.5) / fh) * rh - 0.5;
    const j0 = Math.min(rh - 1, Math.max(0, Math.floor(hy)));
    const j1 = Math.min(rh - 1, Math.max(0, Math.floor(hy) + 1));
    const r0 = j0 * rw, r1 = j1 * rw;
    for (let x = 0; x < fw; x++) {
      const a = cols4[x * 2], b = cols4[x * 2 + 1];
      if (nz[r0 + a] | nz[r0 + b] | nz[r1 + a] | nz[r1 + b]) warpLong++;
    }
  }

  return {
    distortTarget: `${rw}x${rh}`,
    screen: `${fw}x${fh}`,
    instanceSlots: count,
    liveSprites: live,
    spritesRasterised: drawn,
    spritesBehindNearPlane: behindNear,
    spritesOffScreen: offScreen,
    texelsShaded: shaded,
    texelsDiscardedByAlpha: discardAlpha,
    texelsOccluded: occluded,
    texelsWithZeroField: zeroField,
    texelsWritten: wrote,
    nonZeroTexels: nonZero,
    nonZeroPctOfDistortTarget: pct(nonZero, nTex),
    warpLongPathPixels: warpLong,
    warpLongPathPct: pct(warpLong, fw * fh),
  };
}

export function measureFillCost(engine, { width = 480, height = 300, mb = null } = {}) {
  const render = engine.ctx.peek('render');
  const camera = engine.camera;
  const { depth, nx, ny, nz, covered, culled, opaqueItems } = renderGBuffer(engine, width, height);
  const n = width * height;

  // Sun direction in VIEW space, exactly as contact.js receives it.
  const sunWorld = render.csm?.uniforms?.owSunDirWorld?.value ?? new THREE.Vector3(0, 1, 0);
  const sunView = sunWorld.clone().transformDirection(camera.matrixWorldInverse).normalize();

  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = camera.aspect;

  // ---- volumetric march inputs, read off the live pass ---------------------
  // Beyond the last cascade split skSunVisibility returns before its first
  // fetch, so a step out there is free in fetch terms however long the ray is.
  const vol = engine.ctx.peek('sky')?.volumetrics ?? null;
  const volComposite = vol?.compositePass ?? null;
  const steps = Number(vol?.marchPass?.material?.defines?.VOL_STEPS ?? 0);
  // Read the per-step tap count off the shader the engine compiled rather than
  // restating it here. A second copy of the number is exactly how a tool ends
  // up pricing a shader that no longer exists -- and it would read as
  // convincing, because every other figure around it would still be right.
  const VOL_TAPS = Number(
    /#define\s+SK_VOL_SHADOW_TAPS\s+(\d+)/.exec(vol?.marchPass?.material?.fragmentShader ?? '')?.[1] ?? 4
  );
  // Fetches the march pays ONCE per fragment, outside the step loop -- counted
  // off the compiled source for the same reason VOL_TAPS is, and this one has
  // already caught a drift: it was hardcoded at 3 (one tDepth plus the two
  // ambient-LUT texels skFogAmbient used to read), and when those two moved to
  // the vertex stage the model went on charging for them and reported a saving
  // of exactly zero. Everything inside skSunVisibility is the loop's, and is
  // priced per step above.
  const VOL_FIXED_FETCHES = (() => {
    const src = vol?.marchPass?.material?.fragmentShader ?? '';
    const body = src.slice(src.lastIndexOf('void main()'));
    const loop = body.indexOf('for (');
    return (body.slice(0, loop < 0 ? body.length : loop)
      .match(/\btexture(?:2D|Lod)?\s*\(/g) ?? []).length;
  })();
  const splits = render.csm?.uniforms?.owCsmSplit?.value;
  const lastSplit = splits ? Math.max(splits.x, splits.y, splits.z, splits.w) : 0;
  const mu = vol?.marchPass?.uniforms ?? {};
  const uFog = mu.uFog?.value, uFog2 = mu.uFog2?.value;
  const fogFar = uFog?.w ?? 0;
  const volOn = steps > 0 && lastSplit > 0 && fogFar > 0;

  // The march's three other exits, all of which happen BEFORE the four cascade
  // taps and none of which the "steps inside the last split" figure sees:
  //   - a step in air too thin to scatter is skipped outright (dens <= 1e-4)
  //   - the loop breaks for good once transmittance falls under 0.004
  //   - skSunVisibility itself returns 1.0, unfetched, for any sample that
  //     lands outside its cascade's depth range or off the side of its map
  // Modelling them turns the tap count from an upper bound into the real one.
  const camPos = mu.uCamPos?.value ?? camera.getWorldPosition(new THREE.Vector3());
  const csmMats = render.csm?.uniforms?.owCsmMatrix?.value ?? null;
  const csmOn = (render.csm?.uniforms?.owCsmParams?.value?.x ?? 0) > 0 && !!csmMats;
  const splitArr = splits ? [splits.x, splits.y, splits.z, splits.w] : [];
  const nCascades = Number(vol?.marchPass?.material?.defines?.OW_CASCADES ?? splitArr.length);
  const sigmaE0 = uFog2?.x ?? 0;
  const baseY = uFog?.z ?? 0, invH = uFog?.y ?? 0;
  // skFogDensity multiplies the height falloff by mix( 1, 0.30 + 1.55n, amount )
  // for value noise n. The noise is not reproduced here; it is evaluated at its
  // midpoint, and because it only ever scales the density by a factor near one
  // it moves the height at which a step falls under 1e-4 by ln(factor)/invH
  // metres, not the shape of the result. densitySkips below says how much of the
  // answer rests on it -- at zero skips it rests on none of it.
  const noiseAmt = uFog2?.w ?? 0;
  const densFactor = 1 + noiseAmt * (0.30 + 1.55 * 0.5 - 1);
  const camRot = new THREE.Matrix3().setFromMatrix4(camera.matrixWorld);

  // The fourth exit, and the only one that is a threshold rather than a fact
  // about geometry: a step whose weight w = T * sigmaS * (1 - aT) / sigmaE is
  // under SK_VIS_SKIP of a reference weight gets no shadow lookup at all. Read
  // off the shader; absent (or 0) means the build does not do it and every step
  // that reaches the taps pays, which is what this file modelled before.
  const VOL_SKIP_EPS = Number(
    /#define\s+SK_VIS_SKIP\s+([\d.eE+-]+)/.exec(vol?.marchPass?.material?.fragmentShader ?? '')?.[1] ?? 0
  );
  // The fifth exit, and the only one that makes a step CHEAPER rather than free:
  // between SK_VIS_SKIP and this threshold a step still calls skSunVisibility
  // but asks it for one tap instead of VOL_TAPS. Read off the shader for the
  // same reason the two above are -- and this one matters more than most,
  // because VOL_TAPS alone stopped being the per-step fetch count the moment it
  // became a ceiling. A model that keeps multiplying by it reports the cost of a
  // shader that no longer exists, and reports it as a saving of exactly zero.
  // Absent (or 0) means every tapping step pays the full VOL_TAPS.
  const VOL_TAP_TIER = Number(
    /#define\s+SK_VOL_TAP_TIER\s+([\d.eE+-]+)/.exec(vol?.marchPass?.material?.fragmentShader ?? '')?.[1] ?? 0
  );
  // The BASE both of those thresholds are fractions OF, and the one number in
  // the ladder that no regex over #defines can reach: wRef is a local, not a
  // define. It used to be the ray's own maxT and is now the frame's fog
  // distance, and on a near-field ray those differ by up to sixty times -- so a
  // model that prices the wrong one is not slightly off, it is reporting the
  // entire skip/tier ladder against a threshold the shader does not have, and
  // reporting the change as a saving of exactly zero. Derived from the source
  // rather than restated for the same reason OW_MB_PX_PER_TAP is, and matched
  // against BOTH spellings so that reverting the shader reverts the model too.
  const volWRefBase = /\bfloat\s+wRef\s*=\s*uFog\.x\s*\*\s*(uFog\.w|maxT)\s*\/\s*float\(\s*VOL_STEPS\s*\)/
    .exec(vol?.marchPass?.material?.fragmentShader ?? '')?.[1] ?? null;
  if (volOn && volWRefBase === null) {
    throw new Error(
      'fillsim: no "float wRef = uFog.x * (uFog.w|maxT) / float( VOL_STEPS )" in volumetrics.js, so '
      + 'the base of SK_VIS_SKIP and SK_VOL_TAP_TIER is unknown and the tap ladder cannot be priced');
  }
  // true: wRef is the frame constant uFog.w, identical in every pixel. false: it
  // is this ray's own maxT, which is the same number ONLY on sky rays.
  const VOL_WREF_FRAME = volWRefBase === 'uFog.w';
  const sigmaS0 = uFog?.x ?? 0;
  // smoothstep( 0, 12, t ), the near-field scattering ramp the skip mostly fires
  // under. Restated here rather than approximated: it is the term that decides
  // which steps are weightless, so an approximation of it would be an
  // approximation of the answer.
  const nearRamp = (t) => {
    if (t <= 0) return 0;
    if (t >= 12) return 1;
    const q = t / 12;
    return q * q * (3 - 2 * q);
  };

  // ---- motion blur inputs, snapshotted while the pass was actually running --
  // _prevVP is overwritten with _currVP at the end of every frame, so reading it
  // after run() returns would compare a frame against itself and report zero
  // motion. The caller hooks MotionBlur.render and hands the pair in here.
  const mbRes = render.motionBlur?.blurPass?.uniforms?.uResolution?.value ?? null;
  const mbMaxPx = render.motionBlur?.blurPass?.uniforms?.uParams?.value?.y ?? 0;
  // Read the loop bound off the shader source rather than restating it here, so
  // a change to OW_MB_TAPS cannot leave this reporting the old cost.
  const MB_TAPS = Number(
    /#define\s+OW_MB_TAPS\s+(\d+)/.exec(render.motionBlur?.blurPass?.material?.fragmentShader ?? '')?.[1] ?? 12
  );
  // Which of the two BLUR sources was compiled decides the loop's per-sample
  // cost: with the depth in the resolve target's alpha (see taa.js) one fetch
  // serves colour and depth, without it two. Detected from the SOURCE rather
  // than from the flag on the class, because the source is what runs.
  const mbSrc = render.motionBlur?.blurPass?.material?.fragmentShader ?? '';
  const MB_DEPTH_IN_ALPHA = mbSrc.length > 0 && !/uniform\s+sampler2D\s+tDepth\s*;/.test(mbSrc);
  // Fixed fetches before the sample loop, and fetches per sample. The pass
  // reads tColor, tTile and tVelocity in every case; the fourth is the centre
  // depth, which the alpha variant already has in hand.
  const MB_BASE = MB_DEPTH_IN_ALPHA ? 3 : 4;
  const MB_PER_SAMPLE = MB_DEPTH_IN_ALPHA ? 1 : 2;
  // Streak pixels per tap. This model used to carry its own copy of the divisor
  // -- a literal 2 in tapsFor below -- which is the same way ow-taa's
  // neighbourhood went wrong: the number is in two places, only one of them
  // runs, and the report goes on quoting the other. Cross-checked against the
  // rule in the source so a define nobody wired up cannot price a saving the
  // shader is not making.
  const MB_PX_PER_TAP = Number(
    /#define\s+OW_MB_PX_PER_TAP\s+([0-9.]+)/.exec(mbSrc)?.[1] ?? 2);
  if (mbSrc.length > 0 && !/ceil\(\s*radius\s*\/\s*OW_MB_PX_PER_TAP\s*\)/.test(mbSrc)) {
    throw new Error(
      'fillsim: motionblur.js does not derive its tap count from OW_MB_PX_PER_TAP, so the '
      + `divisor ${MB_PX_PER_TAP} read from the define is not the one the loop uses`);
  }
  const mbOn = !!(mb && mbRes && mbRes.x > 0);
  const velPx = mbOn ? new Float32Array(n) : null;

  // ---- TAA: the one branch in the pass, and the tap count of the dilation ---
  // Read off the compiled shader for the same reason VOL_TAPS and MB_TAPS are:
  // a second copy of the number here is exactly how a tool ends up pricing a
  // pattern the shader no longer has, and it would read as convincing.
  const taaSrc = render.taa?.pass?.material?.fragmentShader ?? '';
  const TAA_DILATE_TAPS = Number(
    /#define\s+OW_TAA_DILATE_TAPS\s+(\d+)/.exec(taaSrc)?.[1] ?? 9);
  const taaOn = !!render.taa && taaSrc.length > 0;

  // ---- the colour-box neighbourhood ---------------------------------------
  // Read off the shader for the third time in this block, and cross-checked
  // against the loop for the same reason the lobe tier below checks its guards:
  // a #define on its own would price a neighbourhood the loop does not have,
  // and this is the largest single block in the pass, so getting it wrong is
  // worth 6.5 M fetches of pure fiction either way.
  //
  // The loop runs one MORE time than it fetches. The centre tap is substituted
  // from the value already in hand rather than sampled, which is why the bound
  // is read separately and asserted against the define instead of being derived
  // from it -- the two disagreeing is precisely the half-applied edit this is
  // here to catch.
  const TAA_NB_TAPS = Number(
    /#define\s+OW_TAA_NB_TAPS\s+(\d+)/.exec(taaSrc)?.[1] ?? 8);
  // Located by what the loop DOES -- it is the one that accumulates nmin -- and
  // not by its bound. The bound is the thing being checked, so anchoring on it
  // would make the check circular; and the off-screen early-out below needs the
  // same position, which is how the previous version of this file went wrong.
  // It searched for the literal `i < 9`, so the first edit to the neighbourhood
  // silently dropped the whole pass out of its exact branch and into the bound,
  // which does not throw and does not warn -- it just quietly reports a smaller
  // saving than the change actually made.
  const [TAA_NB_LOOP, TAA_NB_LOOP_AT] = (() => {
    const at = taaSrc.indexOf('nmin = min( nmin, c );');
    if (at < 0) return [0, -1];
    const head = taaSrc.slice(0, at);
    const re = /for\s*\(\s*int\s+i\s*=\s*0;\s*i\s*<\s*(\d+)\s*;/g;
    let found = [0, -1];
    for (let m = re.exec(head); m; m = re.exec(head)) found = [Number(m[1]), m.index];
    return found;
  })();
  if (taaOn && TAA_NB_LOOP !== TAA_NB_TAPS + 1) {
    throw new Error(
      `fillsim: OW_TAA_NB_TAPS says ${TAA_NB_TAPS} fetches, so the variance loop should run `
      + `${TAA_NB_TAPS + 1} times with the centre held -- it runs ${TAA_NB_LOOP}`);
  }

  // ---- the Catmull-Rom lobe tier ------------------------------------------
  // sampleCatmullRom skips a lobe whose weight is already under a threshold,
  // and the weight is a function of the fractional history position alone, so
  // the saving is a COUNT over the frame rather than a model. Two things are
  // read off the source and neither is assumed: the threshold itself, and WHICH
  // of the four lobes is actually guarded. Reading only the #define would price
  // a tier on a shader that merely defines the constant, and hard-coding four
  // would price lobes a partial rollback had un-guarded -- both of which look
  // like a saving in the report and are not one in the frame.
  const TAA_CR_EPS = Number(
    /#define\s+OW_TAA_CR_EPS\s+([0-9.]+)/.exec(taaSrc)?.[1] ?? 0);
  const TAA_CR_GATED = (() => {
    const set = new Set();
    const re = /if\s*\(\s*abs\(\s*(w[abde])\s*\)\s*>\s*OW_TAA_CR_EPS\s*\)/g;
    for (let m = re.exec(taaSrc); m; m = re.exec(taaSrc)) set.add(m[1]);
    return set;
  })();
  // `f` lives on the PASS's texel grid, not on the simulation grid: it is
  // fract( huv * uResolution - 0.5 ). The off-screen band is a UV-space region
  // and so is grid-independent, which the model above relies on; this is not,
  // and taking the texel size from the coarse grid would be wrong by the ratio
  // of the two without changing anything visible in the output.
  const taaResV = render.taa?.pass?.uniforms?.uResolution?.value ?? null;
  const TAA_RES_W = taaResV?.x ?? 0, TAA_RES_H = taaResV?.y ?? 0;
  const taaCrOn = taaOn && TAA_CR_EPS > 0 && TAA_CR_GATED.size > 0
    && TAA_RES_W > 0 && TAA_RES_H > 0;

  // The shader's cubic weights, in the shader's own polynomial form rather than
  // the factored one, so that a change to either is a visible difference and
  // not an algebraic identity to re-derive. w12 is the bilinear-combined middle
  // pair and is at least 1, which is why the centre tap is never a candidate.
  const crW = (f) => {
    const w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    const w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    const w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    const w3 = f * f * (-0.5 + 0.5 * f);
    return { w0, w3, w12: w1 + w2 };
  };

  // The dilation's OFFSETS, not just how many there are. The off-screen early-out
  // below needs the argmin itself, because the velocity it reads belongs to the
  // NEIGHBOUR the dilation picked, and a pattern taken on faith here would price a
  // reprojection the shader does not perform. Parsed in SOURCE ORDER, including
  // the centre tap -- which has no owDilate call at all, because it is inlined
  // against the ownDepth fetch at the top of main() and so must be recognised by
  // the value it reuses. Order matters: the comparison is a strict `<`, so a tie
  // goes to the earliest tap, and a pattern assembled in the wrong order disagrees
  // with the shader on every flat-depth run for a reason unrelated to its shape.
  const TAA_DILATE_OFFSETS = (() => {
    const found = [];
    const re = /owDilate\(\s*vUv\s*\+\s*vec2\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*\*\s*uTexel/g;
    for (let m = re.exec(taaSrc); m; m = re.exec(taaSrc)) {
      found.push({ at: m.index, o: [Number(m[1]), Number(m[2])] });
    }
    // The inlined centre, in either of the two forms the pass has had: a depth
    // compared against ownDepth, or an alpha reciprocal compared against bestInv.
    // Both are the same tap; only the channel it reads changed.
    const centre = /float\s+d\s*=\s*ownDepth\s*;/.exec(taaSrc)
      ?? /ownInvDepth\s*>\s*bestInv/.exec(taaSrc);
    if (centre) found.push({ at: centre.index, o: [0, 0] });
    return found.sort((a, b) => a.at - b.at).map((f) => f.o);
  })();

  // Where the pass gets its depth. With 1/depth in the gbuffer normal's alpha
  // (see prepass.js) the dilation taps ARE the coverage reads, so the two
  // separate tNormal fetches and the separate tDepth fetch all collapse into the
  // pattern. Detected from the SOURCE, exactly as MB_DEPTH_IN_ALPHA is, because
  // the source is what runs -- and because the difference is 2 fetches on every
  // full-resolution pixel of the frame, which is not a rounding error.
  const TAA_DEPTH_IN_NORMAL = taaOn && !/uniform\s+sampler2D\s+tDepth\s*;/.test(taaSrc);
  // If the parse and the #define disagree, one of them is describing a shader that
  // no longer exists, and there is no way to tell which. Say so instead of picking.
  const taaPatternParsed = TAA_DILATE_OFFSETS.length === TAA_DILATE_TAPS;

  // Does the pass return early when the history reprojects off screen? Detected
  // from the source, in the window between huv and the neighbourhood loop, so the
  // model cannot go on quoting an early-out that was removed -- or, as happened
  // here, go on denying one that was added.
  const taaHuvAt = taaSrc.indexOf('vec2 huv = vUv - vel;');
  const taaLoopAt = TAA_NB_LOOP_AT;
  const TAA_EARLY_OUT = taaHuvAt >= 0 && taaLoopAt > taaHuvAt
    && /huv\.x\s*<\s*0\.0[\s\S]*?\breturn\s*;/.test(taaSrc.slice(taaHuvAt, taaLoopAt));
  // Losing the early-out is a SILENT downgrade -- the pass falls back to a bound
  // that is larger than the truth, so it reads as a pass that got more
  // expensive rather than as a model that stopped working. Two things are known
  // here that the fallback branch cannot see: the shader plainly has the return,
  // and the window parse failed anyway. Say so.
  if (taaOn && !TAA_EARLY_OUT && /huv\.x\s*<\s*0\.0/.test(taaSrc)) {
    throw new Error(
      'fillsim: taa.js still has the off-screen return, but the window between '
      + `'vec2 huv = vUv - vel;' (at ${taaHuvAt}) and the variance loop (at ${taaLoopAt}) `
      + 'did not parse. Fix the anchors -- do not let ow-taa fall back to its bound.');
  }

  // The first-frame exit two lines above the dilation returns after two fetches,
  // and it fires on the frame after any reset. uParams.z holds what the LAST frame
  // ran with, so a measurement taken on a reset frame is visible here rather than
  // being silently averaged in as a full-cost frame.
  const taaFirstFrame = (render.taa?.pass?.uniforms?.uParams?.value?.z ?? 0) > 0.5;

  // ---- ow-composite: the chromatic-aberration branch ------------------------
  // `if ( uLens.x * r2 > 0.00002 )` guards two of the pass's fetches, with
  // r2 = dot( vUv - 0.5, vUv - 0.5 ). Everything else in it -- bloom, the four
  // cross neighbours, the LUT -- is unconditional.
  const chromatic = render.composite?.uniforms?.uLens?.value?.x ?? 0;

  // Both halves of that sentence -- how many fetches are unconditional and how
  // many the branch adds -- are COUNTED OFF THE COMPILED FRAGMENT SHADER, not
  // restated here. They used to be the literals 8 and 10, and that is the exact
  // shape of drift VOL_FIXED_FETCHES already caught once: when the tExposure
  // read moved to the vertex stage the model would have gone on charging 3.34 M
  // for it and reported a saving of zero. Counting the FRAGMENT shader is also
  // what makes the hoist visible -- a vertex-stage fetch is 3 per draw, which
  // this file prices as the rounding error it is.
  const compositeFetches = (() => {
    const src = render.composite?.material?.fragmentShader ?? '';
    // The TOTAL comes from fragmentCost, which inlines helper functions -- the
    // same function `fill` uses for the bound in the next column, so the two
    // cannot drift apart. Only the branch's own share is found by text, and it
    // is found by brace matching from the guard rather than by a line number.
    const total = fragmentCost(src).dynamicFetches;
    const at = src.search(/if\s*\(\s*ca\s*>/);
    if (at < 0) return { base: total, ca: 0, found: false };
    const open = src.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    const ca = (src.slice(open, i).match(/\btexture(?:2D|3D|Lod)?\s*\(/g) ?? []).length;
    return { base: total - ca, ca, found: true };
  })();

  // ---- the two screen-space marches, read off the shaders that run them ------
  // Both were 'bounded' rows whose lo/hi differed by 3x (contact) and 10x (ssr),
  // which between them left 32 M of a 459 M frame unmeasured -- the last two
  // rows in the table that were modelled only in name. Both march the SAME
  // depth buffer this file already rasterises, so the step counts are simulable
  // exactly rather than bracketed. Loop bounds come off the compiled source for
  // the same reason VOL_TAPS and MB_TAPS do: a second copy of the number here
  // is how a tool ends up pricing a shader that no longer exists.
  const csSrc = render.contact?.pass?.material?.fragmentShader ?? '';
  const CS_STEPS = Number(/#define\s+OW_CS_STEPS\s+(\d+)/.exec(csSrc)?.[1] ?? 0);
  const csParams = render.contact?.pass?.uniforms?.uParams?.value ?? null;
  const csOn = CS_STEPS > 0 && !!csParams;

  const ssrSrc = render.ssr?.pass?.material?.fragmentShader ?? '';
  const SSR_STEPS = Number(/#define\s+OW_SSR_STEPS\s+(\d+)/.exec(ssrSrc)?.[1] ?? 0);
  const SSR_REFINE = Number(/#define\s+OW_SSR_REFINE\s+(\d+)/.exec(ssrSrc)?.[1] ?? 0);
  const ssrParams = render.ssr?.pass?.uniforms?.uParams?.value ?? null;
  const ssrOn = SSR_STEPS > 0 && !!ssrParams;
  const proj = camera.projectionMatrix;

  /**
   * The depth texture as both marches see it: one nearest fetch, and the
   * prepass's zero clear standing in for "no geometry" (see prepass.js).
   * Returns -1 for a sample off the edge of the buffer, which neither march can
   * reach -- both test the UV before fetching -- so it doubles as an assertion.
   */
  const depthAt = (u, v) => {
    const px = Math.floor(u * width), py = Math.floor((1 - v) * height);
    if (px < 0 || px >= width || py < 0 || py >= height) return -1;
    const j = py * width + px;
    return covered[j] === 0 ? 0 : depth[j];
  };

  let sky = 0, lit = 0, ssrEntered = 0, ssrFacing = 0;
  let caPixels = 0;
  let volTapSteps = 0, volPixels = 0;
  // Fetches, not steps. These diverged the moment SK_VOL_TAP_TIER made the
  // per-step tap count a function of the step rather than a constant.
  let volTapFetches = 0, volTapOneSteps = 0;
  let volTapSky = 0, volPixSky = 0, volTapGeo = 0, volPixGeo = 0;
  let volSkipDt = 0, volSkipDens = 0, volSkipSplit = 0, volSkipProj = 0, volSkipBreak = 0;
  let volSkipWeight = 0;
  let csFetch = 0, csHit = 0, csOffScreen = 0, csRanOut = 0, csEmpty = 0;
  let ssrFetch = 0, ssrHit = 0, ssrOffScreen = 0, ssrBehind = 0, ssrRanOut = 0, ssrDistOut = 0;
  const dir = new THREE.Vector3(), nrm = new THREE.Vector3(), refl = new THREE.Vector3();
  const V = new THREE.Vector3();
  const wp = new THREE.Vector4();
  const wdir = new THREE.Vector3(), _sc = new THREE.Vector4();
  const P = new THREE.Vector3(), sp = new THREE.Vector3(), _mc = new THREE.Vector4();

  /**
   * Does skSunVisibility reach its four taps for a sample at this depth?
   *
   * It picks the first cascade whose split the sample is inside, projects into
   * that cascade and bails -- before any fetch -- if the sample falls outside
   * the map's depth range or off its sides. Reproduced rather than assumed,
   * because a shaft sample well above the street is exactly the case that
   * leaves the cascade sideways.
   */
  function cascadeTaps(viewDepth, origin, wd, t) {
    if (!csmOn) return false;
    let c = nCascades - 1;
    for (let k = 0; k < nCascades; k++) if (viewDepth < splitArr[k]) { c = k; break; }
    _sc.set(origin.x + wd.x * t, origin.y + wd.y * t, origin.z + wd.z * t, 1)
      .applyMatrix4(csmMats[c]);
    const iw = 1 / (_sc.w || 1e-6);
    const pz = _sc.z * iw * 0.5 + 0.5;
    if (pz >= 1 || pz <= 0) return false;
    const px = _sc.x * iw * 0.5 + 0.5, py = _sc.y * iw * 0.5 + 0.5;
    return Math.min(Math.min(px, 1 - px), Math.min(py, 1 - py)) > 0;
  }

  for (let i = 0; i < n; i++) {
    const x = i % width, y = (i / width) | 0;
    // View ray through this pixel, matching owViewPos()'s reconstruction. Its
    // LENGTH is the shader's rayLen: the ratio between distance travelled along
    // the ray and view depth, which is what converts one into the other below.
    const ndcX = ((x + 0.5) / width) * 2 - 1;
    const ndcY = 1 - ((y + 0.5) / height) * 2;
    dir.set(ndcX * tanY * aspect, ndcY * tanY, -1);
    const rayLen = dir.length();
    const isSky = covered[i] === 0 || depth[i] <= 0;

    // ow-composite's chromatic-aberration branch, in the pass's own UV space.
    {
      const du = (x + 0.5) / width - 0.5, dv = (y + 0.5) / height - 0.5;
      if (chromatic * (du * du + dv * dv) > 0.00002) caPixels++;
    }

    if (volOn) {
      // Work in view-depth units throughout: the shader marches ray distance
      // t and then hands t/rayLen to the cascade selector, so dividing both
      // sides by rayLen once here is the same comparison with one less term.
      const maxD = isSky ? fogFar / rayLen : Math.min(depth[i], fogFar / rayLen);
      const maxT = maxD * rayLen;
      if (maxT > 0.02) {
        volPixels++;
        wdir.copy(dir).normalize().applyMatrix3(camRot);
        let taps = 0, tapFetches = 0, tapOne = 0, T = 1, prev = 0;
        const wRefV = sigmaS0 * (VOL_WREF_FRAME ? fogFar : maxT) / steps;
        const wSkip = VOL_SKIP_EPS * wRefV;
        const wTier = VOL_TAP_TIER * wRefV;
        // The shader's own distribution, with the dither at its mean of 0.5:
        // the dither shifts individual steps, not how many land inside a split.
        for (let k = 0; k < steps; k++) {
          const f = (k + 0.5) / steps;
          const t = maxT * (f * f * (3 - 2 * f) * 0.35 + f * f * f * 0.65);
          const dt = t - prev;
          prev = t;
          if (dt <= 1e-5) { volSkipDt++; continue; }
          const dens = Math.exp(-(camPos.y + wdir.y * t - baseY) * invH) * densFactor;
          if (dens <= 1e-4) { volSkipDens++; continue; }
          const sigmaE = Math.max(1e-7, sigmaE0 * dens);
          const aT = Math.exp(-sigmaE * dt);
          // Ordered as the shader orders it: the weight test comes before the
          // cascade work, so a skipped step is not counted against any of the
          // other exits either.
          const w = T * (sigmaS0 * dens * nearRamp(t)) * (1 - aT) / sigmaE;
          if (VOL_SKIP_EPS > 0 && w < wSkip) {
            volSkipWeight++;
          } else if (t / rayLen < lastSplit) {
            if (cascadeTaps(t / rayLen, camPos, wdir, t)) {
              taps++;
              // The tier is decided by w alone, but it is only PAID by a step
              // that got past every one of skSunVisibility's pre-fetch returns
              // -- so it is counted here, inside the branch that established
              // the call reaches its taps, and not beside the weight test.
              const one = VOL_TAP_TIER > 0 && w < wTier;
              if (one) tapOne++;
              tapFetches += one ? 1 : VOL_TAPS;
            } else volSkipProj++;
          } else volSkipSplit++;
          T *= aT;
          if (T < 0.004) { volSkipBreak += steps - k - 1; break; }
        }
        volTapSteps += taps;
        volTapFetches += tapFetches;
        volTapOneSteps += tapOne;
        // Split the two populations. They behave completely differently and the
        // aggregate hides it: a sky ray runs the full fog distance and leaves
        // the last split early, while any pixel with geometry closer than that
        // split has EVERY step inside it. See the note on the result.
        if (isSky) { volPixSky++; volTapSky += taps; } else { volPixGeo++; volTapGeo += taps; }
      }
    }

    if (mbOn && !isSky) {
      // Camera reprojection: unproject this pixel to world, then push it through
      // both frames' view-projections. dir already has z = -1, so dir * depth is
      // the view-space position without a second reconstruction.
      wp.set(dir.x * depth[i], dir.y * depth[i], -depth[i], 1).applyMatrix4(camera.matrixWorld);
      const c = wp.clone().applyMatrix4(mb.currVP);
      const p = wp.clone().applyMatrix4(mb.prevVP);
      const cw = Math.max(1e-6, c.w), pw = Math.max(1e-6, p.w);
      // prepass.js writes ( currNDC - prevNDC ) * 0.5, i.e. a UV delta.
      const vx = (c.x / cw - p.x / pw) * 0.5 * mb.shutter;
      const vy = (c.y / cw - p.y / pw) * 0.5 * mb.shutter;
      velPx[i] = Math.hypot(vx * mbRes.x, vy * mbRes.y);
    }

    if (isSky) { sky++; continue; }

    // The rasteriser hands back WORLD normals; both tests below live in view
    // space, so they are rotated once here rather than in each test.
    nrm.set(nx[i], ny[i], nz[i]).transformDirection(camera.matrixWorldInverse).normalize();
    const isLit = nrm.dot(sunView) > 0.02;
    if (isLit) lit++;

    // SSR: reflect the view vector and reject rays coming back at the camera.
    V.copy(dir).normalize();
    refl.copy(V).reflect(nrm);
    const ssrEnters = Math.max(0, Math.min(1, -V.dot(refl))) <= 0.94;
    if (ssrEnters) ssrEntered++; else ssrFacing++;

    // View-space position, the same reconstruction owViewPos() performs: dir
    // carries z = -1, so dir * depth IS the position with no second unproject.
    P.set(dir.x * depth[i], dir.y * depth[i], -depth[i]);

    // ---- ow-contact: march toward the sun until something occludes ----------
    // The dither is taken at its mean of 0.5, as the volumetric march above
    // does. It slides every sample along the ray by up to one step, which moves
    // where a hit lands but not how many steps precede it, except on the one
    // step that straddles the occluder.
    if (csOn && isLit) {
      const len = csParams.x * Math.min(2.5, Math.max(0.75, depth[i] * 0.08 + 0.75));
      const b = 0.012 + depth[i] * 0.0015;
      const sx = sunView.x * (len / CS_STEPS);
      const sy = sunView.y * (len / CS_STEPS);
      const sz = sunView.z * (len / CS_STEPS);
      let k = 0;
      for (; k < CS_STEPS; k++) {
        const f = k + 0.5;
        sp.set(P.x + nrm.x * b + sx * f, P.y + nrm.y * b + sy * f, P.z + nrm.z * b + sz * f);
        _mc.set(sp.x, sp.y, sp.z, 1).applyMatrix4(proj);
        const iw = 1 / (_mc.w || 1e-6);
        const su = _mc.x * iw * 0.5 + 0.5, sv = _mc.y * iw * 0.5 + 0.5;
        if (su <= 0 || su >= 1 || sv <= 0 || sv >= 1) { csOffScreen++; break; }
        csFetch++;
        const sd = depthAt(su, sv);
        if (sd <= 0) { csEmpty++; continue; }
        const diff = -sp.z - sd;
        if (diff > 0.004 + sd * 0.0025 && diff < csParams.y) { csHit++; break; }
      }
      if (k === CS_STEPS) csRanOut++;
    }

    // ---- ow-ssr: geometric march, then a binary refine on a hit -------------
    if (ssrOn && ssrEnters) {
      const maxDist = ssrParams.x;
      const nb = 0.02 + depth[i] * 0.002;
      const stx = P.x + nrm.x * nb, sty = P.y + nrm.y * nb, stz = P.z + nrm.z * nb;
      const stepScale = Math.pow(maxDist / 0.06, 1 / SSR_STEPS);
      let t = 0.06 + 0.5 * 0.06;
      let hit = false;
      let k = 0;
      for (; k < SSR_STEPS; k++) {
        sp.set(stx + refl.x * t, sty + refl.y * t, stz + refl.z * t);
        if (sp.z > -0.05) { ssrBehind++; break; }
        _mc.set(sp.x, sp.y, sp.z, 1).applyMatrix4(proj);
        const iw = 1 / (_mc.w || 1e-6);
        const su = _mc.x * iw * 0.5 + 0.5, sv = _mc.y * iw * 0.5 + 0.5;
        if (su <= 0 || su >= 1 || sv <= 0 || sv >= 1) { ssrOffScreen++; break; }
        ssrFetch++;
        const sd = depthAt(su, sv);
        const diff = -sp.z - sd;
        if (sd > 0 && diff > 0 && diff < ssrParams.y + t * 0.06) {
          // The refine is a fixed SSR_REFINE fetches, then tVelocity + tColor.
          ssrFetch += SSR_REFINE + 2;
          ssrHit++; hit = true; break;
        }
        t *= stepScale;
        if (t > maxDist) { ssrDistOut++; break; }
      }
      if (!hit && k === SSR_STEPS) ssrRanOut++;
    }
  }
  const shading = n - sky;

  // ---- motion blur: the tile dilation, then the early-out ------------------
  //
  // THIS ROW IS A BRACKET, and it used to claim to be exact. The reason is in
  // TILE_MAX: it does NOT reduce a 16x16 block to that block's longest
  // velocity. Its 8x8 taps sit at ( x - 3.5 ) * 2 texels, i.e. the odd offsets
  // -7, -5, -3, -1, 1, 3, 5, 7, so it reads half the columns and half the rows
  // -- 64 of the 256 texels -- and the output texel's own centre is not among
  // them. The blur pass then samples that 1/16 target with texture2D on a
  // LinearFilter target, so what it gets is a BILINEAR BLEND of four tile
  // texels, and a blend of two vectors pointing different ways is shorter than
  // either. "The block max, since a pixel's own velocity is inside its own
  // block" was therefore wrong twice over, and it decided the early-out for the
  // third largest row in the frame.
  //
  // What survives is a genuine two-sided bound, from the shader's own line
  // `vel = length( tileVel ) > length( ownVel ) ? tileVel : ownVel`:
  //   LO   the ternary always returns at least ownVel, so a pixel whose own
  //        velocity reaches 1 px is blurred no matter what the tile says.
  //   HI   a convex combination cannot be longer than its longest input, and
  //        each tile texel is a max over a SUBSET of its block, so the blend is
  //        at most the largest block max that bilinear can reach from here --
  //        the 2x2 of tile texels around this pixel, computed per pixel below.
  // The old single-containing-block figure is neither of those: it is above LO
  // and below HI, and reported as though it were the answer.
  let mbOut = { unavailable: 'motion blur is off in this preset, or its matrices were not captured' };
  let mbPerLo = 0, mbPerHi = 0;
  if (mbOn) {
    const bw = Math.max(1, 16 * width / mbRes.x), bh = Math.max(1, 16 * height / mbRes.y);
    const tw = Math.ceil(width / bw), th = Math.ceil(height / bh);
    const blockMax = new Float32Array(tw * th);
    for (let i = 0; i < n; i++) {
      const b = (((i / width) | 0) / bh | 0) * tw + ((i % width) / bw | 0);
      if (velPx[i] > blockMax[b]) blockMax[b] = velPx[i];
    }
    // The shader's own tap rule, with its divisor read from the source. Two
    // fetches per tap, so the sample spacing is half MB_PX_PER_TAP.
    const tapsFor = (v) => Math.min(
      Math.max(Math.ceil(Math.min(v, mbMaxPx) / MB_PX_PER_TAP), 2), MB_TAPS);
    const clampi = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

    let ownMoving = 0, dilMoving = 0, sumPx = 0, maxPx = 0, clamped = 0;
    let sumTaps = 0, atFullTaps = 0;
    let fetchLo = 0, fetchHi = 0;
    for (let i = 0; i < n; i++) {
      const x = i % width, y = (i / width) | 0;
      const own = velPx[i];

      // The 2x2 of tile texels a bilinear fetch at this pixel can reach.
      const cx = (x + 0.5) / bw - 0.5, cy = (y + 0.5) / bh - 0.5;
      const bx0 = clampi(Math.floor(cx), tw - 1), by0 = clampi(Math.floor(cy), th - 1);
      const bx1 = clampi(bx0 + 1, tw - 1), by1 = clampi(by0 + 1, th - 1);
      const hi = Math.max(
        own,
        blockMax[by0 * tw + bx0], blockMax[by0 * tw + bx1],
        blockMax[by1 * tw + bx0], blockMax[by1 * tw + bx1]
      );

      if (own >= 1) {
        ownMoving++; fetchLo += MB_BASE + 2 * MB_PER_SAMPLE * tapsFor(own);
      } else fetchLo += 3;
      if (hi >= 1) {
        dilMoving++; sumPx += hi; if (hi > maxPx) maxPx = hi; if (hi > mbMaxPx) clamped++;
        const t = tapsFor(hi);
        sumTaps += t;
        if (t >= MB_TAPS) atFullTaps++;
        fetchHi += MB_BASE + 2 * MB_PER_SAMPLE * t;
      } else fetchHi += 3;
    }
    const scale = (mbRes.x * mbRes.y) / n;
    mbPerLo = fetchLo / n;
    mbPerHi = fetchHi / n;
    mbOut = {
      note: 'Camera reprojection of STATIC geometry only -- no object motion, so this is a '
        + 'lower bound on how many pixels move. Sky carries no velocity of its own but is '
        + 'dragged in by tile dilation. Below 1 px the pass returns after 3 fetches; at or '
        + `above it, it pays ${MB_BASE} plus ${2 * MB_PER_SAMPLE} per tap. LO is the early-out decided by the pixel's `
        + 'OWN velocity, which the ternary guarantees; HI by the largest block max a '
        + 'bilinear tile fetch can reach. The truth is between them and depends on how much '
        + 'the blend shortens the dilated vector, which needs the real 1/16 target.',
      depthInAlpha: MB_DEPTH_IN_ALPHA,
      fetchesPerSample: MB_PER_SAMPLE,
      shutter: +mb.shutter.toFixed(4), maxRadiusPx: mbMaxPx,
      pxPerTap: MB_PX_PER_TAP,
      fullResolution: `${mbRes.x}x${mbRes.y}`,
      tileGridSimulated: `${tw}x${th}`,
      cameraMovedM: +mb.camMove.toFixed(4), cameraTurnedDeg: +mb.camTurn.toFixed(3),
      blurredPctOwnVelocityOnly: pct(ownMoving, n),
      blurredPctAfterTileDilation: pct(dilMoving, n),
      meanRadiusPxOverBlurred: +(sumPx / Math.max(1, dilMoving)).toFixed(2),
      maxRadiusPxSeen: +maxPx.toFixed(2),
      pixelsAtRadiusClamp: clamped,
      meanTapsOverBlurred: +(sumTaps / Math.max(1, dilMoving)).toFixed(2),
      pctOfBlurredStillAtFullTaps: pct(atFullTaps, dilMoving),
      fetchesPerFrameLo: Math.round(fetchLo * scale),
      fetchesPerFrameHi: Math.round(fetchHi * scale),
      [`fetchesPerFrameAtFixed${MB_TAPS}Taps`]: Math.round(
        (dilMoving * (MB_BASE + 2 * MB_PER_SAMPLE * MB_TAPS) + (n - dilMoving) * 3) * scale),
    };
  }

  // ---- ow-taa: the history that reprojects off the edge of the frame -------
  //
  // The pass returns after the dilation wherever `huv` leaves [0,1], which drops
  // every tCurrent of the variance neighbourhood and 5 tHistory for the
  // Catmull-Rom resample -- see fetchesSavedPerBandPixel below, which is built
  // from OW_TAA_NB_TAPS rather than written down here. That band is
  // the whole of the difference between the shader and the model that used to
  // sit here, and it is computable exactly, because `huv` is a closed-form
  // function of depth, coverage and the two camera matrices -- the same three
  // inputs `cod taataps` already reproduces, and colour never enters it.
  //
  // WHY THE ANSWER IS A FRACTION AND NOT A PIXEL COUNT. The band is a region in
  // UV space: `huv` is a UV, the test is against the UV unit square, and neither
  // depends on how finely the frame is sampled. So the SHARE of the frame it
  // covers is resolution-independent and this may be simulated on the coarse
  // grid, unlike the haze perimeter above, which is a one-texel dilation and is
  // inflated fivefold by exactly that substitution. What the coarse grid does
  // cost is quantisation: at 480 wide a 1 % band is under five columns, so the
  // figure carries about half a column of noise. Raise --w/--h to shrink it; the
  // band fraction should barely move, and if it does, the assumption above is
  // what broke.
  //
  // WHAT IS EXACT AND WHAT IS NOT. Exact: the dilation (the shader's own offsets
  // in the shader's own order, `d <= 0 -> 1e8`, strict `<`, border clamp), the
  // `cb > 0.5` branch, and the far-plane reprojection the uncovered branch takes.
  // Not: object motion -- the velocity here is the camera's reprojection of
  // STATIC geometry, as everywhere else in this file. A moving object can carry a
  // pixel off the edge that the camera alone would not, so this UNDERSTATES the
  // band, which is the safe direction for a saving.
  let taaOut = { unavailable: 'TAA is off in this preset' };
  let taaBand = 0, taaVelExact = 0, taaBandVel = 0;
  // Lobes skipped, and the filter mass that went with them, over the pixels
  // that REACH sampleCatmullRom -- the band returns before it and cannot save
  // anything there.
  let taaCrDrops = 0, taaCrMass = 0, taaCrReached = 0, taaCrAll = 0;
  let taaCrOut = { unavailable: 'no Catmull-Rom lobe tier in this build' };
  const taaBandKnown = taaOn && mbOn && taaPatternParsed && TAA_EARLY_OUT;
  if (taaBandKnown) {
    const cw4 = new THREE.Vector4(), pw4 = new THREE.Vector4(), wpt = new THREE.Vector4();
    const invVP = new THREE.Matrix4().copy(mb.currVP).invert();
    const clampi = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

    // The velocity the prepass wrote at pixel j: ( currNDC - prevNDC ) * 0.5 of
    // that pixel's own world position. No shutter -- that scaling belongs to
    // motion blur, and TAA reads the buffer raw.
    const velAt = (j, out) => {
      const jx = j % width, jy = (j / width) | 0;
      const jdx = (((jx + 0.5) / width) * 2 - 1) * tanY * aspect;
      const jdy = (1 - ((jy + 0.5) / height) * 2) * tanY;
      const d = depth[j];
      wpt.set(jdx * d, jdy * d, -d, 1).applyMatrix4(camera.matrixWorld);
      cw4.copy(wpt).applyMatrix4(mb.currVP);
      pw4.copy(wpt).applyMatrix4(mb.prevVP);
      const a = Math.max(1e-6, cw4.w), b = Math.max(1e-6, pw4.w);
      out[0] = (cw4.x / a - pw4.x / b) * 0.5;
      out[1] = (cw4.y / a - pw4.y / b) * 0.5;
    };

    const v = [0, 0];
    let bandX = 0, bandY = 0, bandBg = 0;
    for (let i = 0; i < n; i++) {
      const x = i % width, y = (i / width) | 0;
      const u = (x + 0.5) / width, vv = 1 - (y + 0.5) / height;

      let bestDepth = 1e9, best = i;
      for (let k = 0; k < TAA_DILATE_OFFSETS.length; k++) {
        const sx = clampi(x + TAA_DILATE_OFFSETS[k][0], width - 1);
        const sy = clampi(y + TAA_DILATE_OFFSETS[k][1], height - 1);
        const j = sy * width + sx;
        const d = covered[j] !== 0 && depth[j] > 0 ? depth[j] : 1e8;
        if (d < bestDepth) { bestDepth = d; best = j; }
      }

      const cb = covered[best] !== 0 && depth[best] > 0;
      if (cb) { taaVelExact++; velAt(best, v); } else {
        // The shader's else branch: unproject the FAR plane through uInvVP and
        // push it back through uPrevVP. Depth-independent by construction, which
        // is why the sky reprojects at all.
        wpt.set(u * 2 - 1, vv * 2 - 1, 1, 1).applyMatrix4(invVP);
        const iw = 1 / (wpt.w || 1e-6);
        cw4.set(wpt.x * iw, wpt.y * iw, wpt.z * iw, 1).applyMatrix4(mb.prevVP);
        const pw = cw4.w || 1e-6;
        v[0] = u - ((cw4.x / pw) * 0.5 + 0.5);
        v[1] = vv - ((cw4.y / pw) * 0.5 + 0.5);
      }

      const hx = u - v[0], hy = vv - v[1];
      const outX = hx < 0 || hx > 1, outY = hy < 0 || hy > 1;
      if (outX || outY) {
        taaBand++;
        if (outX) bandX++;
        if (outY) bandY++;
        if (!cb) bandBg++;
        if (cb) taaBandVel++;
      } else if (taaCrOn) {
        // Reached sampleCatmullRom. The fractional position is taken against
        // the PASS's texel grid, not this loop's, for the reason at the top --
        // the coarse grid samples the DISTRIBUTION of f fairly (neighbouring
        // samples are several pass texels apart, so f has cycled in between),
        // it just must not supply the texel size.
        taaCrReached++;
        const spx = hx * TAA_RES_W, spy = hy * TAA_RES_H;
        const X = crW(spx - (Math.floor(spx - 0.5) + 0.5));
        const Y = crW(spy - (Math.floor(spy - 0.5) + 0.5));
        const wa = Math.abs(X.w12 * Y.w0), wb = Math.abs(X.w0 * Y.w12);
        const wd = Math.abs(X.w3 * Y.w12), we = Math.abs(X.w12 * Y.w3);
        let d = 0;
        if (TAA_CR_GATED.has('wa') && wa <= TAA_CR_EPS) { d++; taaCrMass += wa; }
        if (TAA_CR_GATED.has('wb') && wb <= TAA_CR_EPS) { d++; taaCrMass += wb; }
        if (TAA_CR_GATED.has('wd') && wd <= TAA_CR_EPS) { d++; taaCrMass += wd; }
        if (TAA_CR_GATED.has('we') && we <= TAA_CR_EPS) { d++; taaCrMass += we; }
        taaCrDrops += d;
        if (d === TAA_CR_GATED.size) taaCrAll++;
      }
    }
    taaOut = {
      note: 'Share of the frame whose history sample leaves the unit square, which is what '
        + 'the early-out in taa.js returns on. A UV-space region, so this fraction does not '
        + 'depend on the simulation grid -- but it IS proportional to how fast the camera is '
        + 'turning, so it describes this frame and not the pass.',
      pattern: TAA_DILATE_OFFSETS.map((o) => `${o[0]},${o[1]}`).join(' '),
      cameraTurnedDeg: +mb.camTurn.toFixed(3), cameraMovedM: +mb.camMove.toFixed(4),
      offScreenPct: pct(taaBand, n),
      offScreenPctHorizontal: pct(bandX, n),
      offScreenPctVertical: pct(bandY, n),
      pctOfBandOnUncoveredNeighbour: pct(bandBg, Math.max(1, taaBand)),
      velocityFetchTakenPct: pct(taaVelExact, n),
      fetchesSavedPerBandPixel: TAA_NB_TAPS + 5 + (TAA_DEPTH_IN_NORMAL ? 0 : 1),
      neighbourhoodTaps: TAA_NB_TAPS,
      depthInNormalAlpha: TAA_DEPTH_IN_NORMAL,
      firstFrameExitActive: taaFirstFrame,
      warning: mb.camTurn < 0.01 && mb.camMove < 0.002
        ? 'THE CAMERA IS NEITHER TURNING NOR MOVING. huv is vUv, no pixel reprojects off the '
          + 'edge, and the early-out measures zero for that reason alone. Pass --look to see '
          + 'what it is worth.'
        : undefined,
    };
    if (taaCrOn) {
      const perReached = taaCrDrops / Math.max(1, taaCrReached);
      taaCrOut = {
        note: 'Lobes of sampleCatmullRom whose weight is under OW_TAA_CR_EPS, counted over '
          + 'the pixels that reach the filter -- the off-screen early-out is already applied, '
          + 'so fetchesSavedPerFragment is per FRAME pixel and subtracts directly from the '
          + 'pass\'s realFetchesPerFragment. A count of the frame, not a model of it.',
        threshold: TAA_CR_EPS,
        gatedLobes: [...TAA_CR_GATED].sort().join(' '),
        passResolution: `${TAA_RES_W}x${TAA_RES_H}`,
        simulated: `${width}x${height}`,
        reachedCatmullRomPct: pct(taaCrReached, n),
        tapsDroppedPerReachedPixel: +perReached.toFixed(4),
        fetchesSavedPerFragment: +(taaCrDrops / n).toFixed(4),
        meanMassDroppedPerPixel: +(taaCrMass / Math.max(1, taaCrReached)).toFixed(5),
        allGatedDroppedPct: pct(taaCrAll, Math.max(1, taaCrReached)),
        // At a standing camera huv is vUv, f is exactly 0, every lobe weighs
        // exactly 0 and all four go -- so this number is at its MAXIMUM when
        // the camera is still and shrinks as the turn rate rises. That is the
        // opposite direction to the off-screen band above, and quoting either
        // one without the other describes a camera that is not moving the way
        // the benchmark moves it.
        savingGrowsAsCameraSlows: true,
      };
    }
  } else if (taaOn) {
    taaOut = {
      unavailable: !TAA_EARLY_OUT
        ? 'taa.js has no off-screen early-out in this build, so there is no band to price.'
        : !taaPatternParsed
          ? `the dilation pattern did not parse: ${TAA_DILATE_OFFSETS.length} offsets found `
            + `against OW_TAA_DILATE_TAPS ${TAA_DILATE_TAPS}. Priced as if every pixel pays.`
          : 'the camera matrices were not captured -- motion blur is off, and the caller hooks '
            + 'that pass to snapshot the pair. Priced as if every pixel pays.',
    };
  }

  // ---- one realised cost per pass, for `fill --real` to join against -------
  //
  // `fill` multiplies exact fragment counts by the fragcost upper bound, which
  // has to assume every branch is taken. That bound ranks the shader with the
  // most generous worst case first, and reconciling it against the entry
  // fractions above is a hand calculation -- which is exactly where the last
  // pass at this got it wrong, by a factor of about ten. So the reconciliation
  // is done here, once, and `fill` prints the answer next to the bound.
  //
  // Each entry carries its BASIS, and the three are not interchangeable:
  //   exact    every branch that decides the count was evaluated per pixel
  //   bounded  the count depends on where a march breaks on a hit, which needs
  //            a hit test this does not run; lo and hi bracket it
  // The per-branch fetch counts are read off the shaders named in each note.
  // Weighted mean over populations that PARTITION the frame. Every caller below
  // must cover all n pixels exactly once; anything else would quietly drop a
  // population and report a cost that is too low.
  const avg = (pairs, extraTotal = 0) => {
    let px = 0, f = 0;
    for (const [count, cost] of pairs) { px += count; f += count * cost; }
    if (px !== n) throw new Error(`fillsim: populations sum to ${px}, not ${n}`);
    // extraTotal is a fetch count already summed over the whole frame -- the two
    // simulated marches below produce one, because their per-pixel cost is not a
    // constant per population. Added before the divide so it is not rounded twice.
    return +((f + extraTotal) / n).toFixed(1);
  };
  const passCost = [];
  if (volOn) {
    passCost.push({
      pass: 'sky-vol-march', basis: 'exact',
      fetchesPerFragmentLo: +(volTapFetches / Math.max(1, volPixels) + VOL_FIXED_FETCHES).toFixed(1),
      fetchesPerFragmentHi: +(volTapFetches / Math.max(1, volPixels) + VOL_FIXED_FETCHES).toFixed(1),
      note: 'Every step was classified: only the ones landing inside a cascade map tap, and '
        + 'the density skip, the transmittance break and the last-split exit were all run.',
    });
  }
  if (mbOn) {
    passCost.push({
      pass: 'ow-mb', basis: 'bounded',
      fetchesPerFragmentLo: +mbPerLo.toFixed(1), fetchesPerFragmentHi: +mbPerHi.toFixed(1),
      note: 'The streak-length tap rule is evaluated per pixel and is exact; the EARLY-OUT '
        + 'is not, because TILE_MAX subsamples its block (odd offsets only, 64 of 256 '
        + 'texels, centre excluded) and the blur then reads that 1/16 target through a '
        + 'LINEAR filter, so the dilated vector is a blend that can be shorter than any '
        + 'texel it came from. LO decides the early-out on the pixel\'s own velocity, which '
        + 'the ternary guarantees is a floor; HI on the largest block max a bilinear fetch '
        + 'can reach. Camera motion only -- object velocity would raise the blurred share, '
        + 'not lower it, so both ends are conservative in the same direction. Separately '
        + 'and not modelled here: the inner loop `continue`s on a sample outside 0..1 and '
        + 'saves 2 fetches in a thin border band, worth about 0.7 M against HI.',
    });
  }
  // ssr.js: sky returns after tNormal (1); a ray inside 0.94 of the view
  // direction returns after tNormal + tDepth (2); an entered ray pays those 2
  // plus one tDepth per march step, and on a hit SSR_REFINE taps + tVelocity +
  // tColor. The march itself was run above against this file's own depth
  // buffer, so ssrFetch is the counted total rather than a bracket.
  if (ssrOn) {
    passCost.push({
      pass: 'ow-ssr', basis: 'exact',
      fetchesPerFragmentLo: avg([[sky, 1], [ssrFacing, 2], [ssrEntered, 2]], ssrFetch),
      fetchesPerFragmentHi: avg([[sky, 1], [ssrFacing, 2], [ssrEntered, 2]], ssrFetch),
      note: 'The march was simulated per pixel against the rasterised depth buffer: the '
        + 'behind-camera break, the off-screen break, the distance break, the hit test and '
        + `the ${SSR_REFINE}-tap refine were all run. See ssrMarch for where the rays end. `
        + 'This replaces a 2.2/21.6 bracket that carried its HIGH end into the ranking and '
        + 'so listed the pass at nearly twice its cost. RESOLUTION: the march reads a depth '
        + 'buffer rasterised at the simulated size, not the pass\'s own 1134x736, so a thin '
        + 'occluder can be missed and a ray march further than it would. Measured by '
        + 're-running at 480x300, 760x476 and 1134x736: 11.5, 11.7, 11.8 fetches per '
        + 'fragment, and the ray-end distribution moves under one point. It converges from '
        + 'BELOW, so the default is the mildly optimistic end of a 2.6% spread.',
    });
  } else {
    passCost.push({
      pass: 'ow-ssr', basis: 'bounded',
      fetchesPerFragmentLo: avg([[sky, 1], [ssrFacing, 2], [ssrEntered, 3]]),
      fetchesPerFragmentHi: avg([[sky, 1], [ssrFacing, 2], [ssrEntered, 37]]),
      note: 'SSR is off in this preset or its shader was not readable; bracket only.',
    });
  }
  if (csOn) {
    passCost.push({
      pass: 'ow-contact', basis: 'exact',
      fetchesPerFragmentLo: avg([[sky, 1], [shading - lit, 2], [lit, 2]], csFetch),
      fetchesPerFragmentHi: avg([[sky, 1], [shading - lit, 2], [lit, 2]], csFetch),
      note: 'contact.js: sky returns after 1 fetch and a surface facing away after 2. The '
        + 'march was simulated per lit pixel, with the off-screen break, the empty-sample '
        + 'skip and the occluder break all run. See contactMarch for where the rays end. '
        + 'This replaces a 1.9/5.6 bracket that carried its HIGH end into the ranking. '
        + 'RESOLUTION: measured at 480x300, 760x476 and 1134x736 the row reads 3.6, 3.6 and '
        + '3.5 fetches per fragment -- the march is under a metre of world travel and its '
        + 'cost is set by how many steps fit before an occluder, which is a depth question '
        + 'rather than a coverage one, so it barely moves with the raster.',
    });
  } else {
    passCost.push({
      pass: 'ow-contact', basis: 'bounded',
      fetchesPerFragmentLo: avg([[sky, 1], [shading - lit, 2], [lit, 3]]),
      fetchesPerFragmentHi: avg([[sky, 1], [shading - lit, 2], [lit, 16]]),
      note: 'Contact shadows are off in this preset or the shader was not readable.',
    });
  }
  passCost.push({
    pass: 'ow-contact-blur', basis: 'exact',
    // Sky costs 1 on both directions. A sun-averted pixel (`shading - lit`, the
    // same N.L <= 0.02 test ow-contact itself runs) costs 5 on the horizontal
    // direction and 1 on the vertical, because only the vertical one's output
    // is read outside this pass -- see the long note in contact.js. Averaged
    // over the two draws that is 3.
    fetchesPerFragmentLo: avg([[sky, 1], [shading - lit, 3], [lit, 5]]),
    fetchesPerFragmentHi: avg([[sky, 1], [shading - lit, 3], [lit, 5]]),
    note: 'Both early-outs are decided by the one centre fetch and are exact. This row is '
      + 'the MEAN OF THE TWO DRAWS and the two are no longer identical: the horizontal '
      + 'direction still blurs sun-averted pixels because the vertical direction reads its '
      + 'output back, the vertical one drops them because only owContactShadow reads its '
      + 'output and those pixels have no sun term to shadow.',
  });
  passCost.push({
    pass: 'ow-gtao-blur', basis: 'exact',
    fetchesPerFragmentLo: avg([[sky, 1], [shading, 7]]),
    fetchesPerFragmentHi: avg([[sky, 1], [shading, 7]]),
    note: 'gtao.js AO_BLUR: 1 centre fetch, then 3 iterations x 2 neighbours. The sky '
      + 'early-out is decided by that one centre fetch and is exact rather than close -- a '
      + 'neighbour at a real depth weighs at most 2.9e-10 against a sentinel of 1e4, every '
      + 'sky neighbour carries .r = 1.0, and the worst deficit of 6.2e-10 is six orders of '
      + 'magnitude under the half-float step of 4.9e-4 at 1.0. Like ow-contact-blur this '
      + 'figure is per draw and the pass is drawn twice, once per direction.',
  });
  passCost.push({
    pass: 'ow-gtao', basis: 'exact',
    fetchesPerFragmentLo: avg([[sky, 1], [shading, 50]]),
    fetchesPerFragmentHi: avg([[sky, 1], [shading, 50]]),
    note: 'gtao.js returns after tNormal on sky; every covered pixel runs all 3 slices x 8 '
      + 'steps x 2 directions, since the bounds tests skip only the arithmetic, not the fetch.',
  });
  // Both GTAO early-outs test .g against 2000 to recognise the 1e4 sky sentinel,
  // and both are only sound while no REAL depth can reach that test. The world
  // far plane is what guarantees it, and it lives in a different file from the
  // shaders that depend on it -- so a preset that pushed the draw distance out
  // would silently turn "sky" into "sky and everything past 2 km", and every AO
  // number downstream would still look plausible. glslcheck cannot see this and
  // the GL mock compiles nothing, so the check belongs here, and it throws
  // rather than warns: a broken sentinel invalidates the two rows it prices.
  if (camera.far >= 2000) {
    throw new Error(
      `fillsim: camera.far is ${camera.far}, but gtao.js AO_TEMPORAL and AO_BLUR both treat `
      + '.g > 2000 as the sky sentinel. Geometry can now reach that test. Raise the sentinel '
      + 'in gtao.js above the new far plane before trusting any AO figure.');
  }
  passCost.push({
    pass: 'ow-gtao-temporal', basis: 'exact',
    fetchesPerFragmentLo: avg([[sky, 1], [shading, 7]]),
    fetchesPerFragmentHi: avg([[sky, 1], [shading, 7]]),
    note: 'AO_TEMPORAL: 1 tCurrent + 1 tVelocity + 1 tHistory + a 4-tap neighbourhood, with '
      + 'the sky early-out decided by that one tCurrent fetch. It is exact rather than close: '
      + 'AO_CORE writes 1.0 into .r on the sky as a SCREEN CONSTANT, so a history that '
      + 'reprojects onto sky carries the same 1.0 and the +-0.45 clamp window always contains '
      + 'it, while a history that reprojects onto geometry is rejected by rel >= 0.88 down to '
      + 'a weight of 3.4e-12. The worst deficit is 4.9e-12 against a half-float step of '
      + '4.9e-4 at 1.0. See the derivation in gtao.js.',
  });

  // ---- the rest of the chain, none of which has a per-pixel branch ---------
  // Recorded so the frame total is a measurement end to end rather than a
  // measurement with an unmeasured remainder folded into it. Four of these come
  // out exactly at their bound, and that is worth saying out loud: "not
  // modelled" and "modelled and equal to its bound" look identical in a table
  // and mean opposite things about how much slack is left in the pass.
  passCost.push({
    pass: 'ow-ssr-blur', basis: 'exact',
    fetchesPerFragmentLo: avg([[n, 5]]), fetchesPerFragmentHi: avg([[n, 5]]),
    note: 'ssr.js SSR_BLUR is a 5-tap separable kernel with no branch at all, so its bound IS '
      + 'its cost, per draw, and it is drawn twice. It has no sky sentinel to early-out on '
      + 'the way ow-contact-blur and ow-gtao-blur do: its only input is tSrc, the SSR colour '
      + 'target, and a blur cannot decide its own output from its centre tap -- the whole '
      + 'point of the pass is that neighbours bleed in. Adding a depth fetch to test for sky '
      + 'would cost 1 to save 4 on the sky, which is worth about 1.4 M, but it would also '
      + 'change the result at every sky pixel next to geometry, so it is NOT free.',
  });
  // Counted off the compiled fragment source rather than restated, for the
  // reason VOL_FIXED_FETCHES and compositeFetches are. This row used to be the
  // bracket [13, 14]: 13 unconditional taps plus a tExposure read guarded by
  // uParams.x, which bloom.js sets to 1 on level 0 and 0 on the five levels
  // below. `fill` joins realised cost by pass NAME and the pyramid runs the one
  // material at six resolutions, so a single number would have been wrong at one
  // end -- and the bracket's high end, which the ranking uses, over-charged the
  // five small levels by 277 725 fetches. The tExposure read is in the vertex
  // stage now, so every level costs the same and the bracket is a number again.
  //
  // The count comes from fragmentCost, not from counting `texture(` in the
  // source, because this shader issues all 13 of its taps through one `fetch()`
  // helper -- a text count would say 1. fragmentCost inlines calls, which is the
  // whole reason it exists, and it is the same function `fill` uses for the
  // bound in the next column, so the two can no longer disagree.
  const bloomDownFetches = fragmentCost(
    render.bloom?.down?.material?.fragmentShader ?? ''
  ).dynamicFetches;
  passCost.push({
    pass: 'ow-bloom-down', basis: 'exact',
    fetchesPerFragmentLo: avg([[n, bloomDownFetches]]),
    fetchesPerFragmentHi: avg([[n, bloomDownFetches]]),
    note: `${bloomDownFetches} taps, counted off the compiled fragment source, with no branch `
      + 'that skips one: uParams.x selects between the Karis prefilter and the plain tent and '
      + 'both consume all 13. The exposure read is not here -- it is a 1x1 target sampled once '
      + 'per vertex in DOWNSAMPLE_VERT, 3 fetches per draw, so all six levels cost the same.',
  });
  passCost.push({
    pass: 'ow-bloom-up', basis: 'exact',
    fetchesPerFragmentLo: avg([[n, 9]]), fetchesPerFragmentHi: avg([[n, 9]]),
    note: 'A 9-tap tent with no branch. uRadius and uWeight change per level, which moves '
      + 'where it samples and how much it contributes, never how many fetches it issues.',
  });
  passCost.push({
    pass: 'ow-mb-tile', basis: 'exact',
    fetchesPerFragmentLo: avg([[n, 64]]), fetchesPerFragmentHi: avg([[n, 64]]),
    note: 'TILE_MAX runs 8x8 taps unconditionally; the `l > bestLen` test picks a winner, it '
      + 'does not skip a fetch. 64 per fragment reads alarmingly, but the pass runs at 1/256 '
      + 'of the frame, which is the whole reason the tile pass exists.',
  });
  passCost.push({
    pass: 'ow-reduce', basis: 'exact',
    fetchesPerFragmentLo: avg([[n, 16]]), fetchesPerFragmentHi: avg([[n, 16]]),
    note: 'A 4x4 box reduction with no branch, on 256 pixels.',
  });
  passCost.push({
    pass: 'ow-adapt', basis: 'exact',
    fetchesPerFragmentLo: avg([[n, 2]]), fetchesPerFragmentHi: avg([[n, 2]]),
    note: 'tSrc and tPrev, both at the centre texel, on a 1x1 target: two fetches for the '
      + 'whole frame. Entered so the table has no unmeasured row left rather than because two '
      + 'fetches matter -- an unlabelled row reads as "not looked at", and after this one '
      + 'every row in the frame has been.',
  });
  {
    // The one guarded fetch in LOGLUM is `uMeter.w > 0.5` -- whether a depth
    // buffer was handed in at all. That is a uniform, not a per-pixel test, so
    // the pass costs 4 or 5 for the whole draw and the answer is read off the
    // running engine rather than assumed.
    const hasDepth = (render.exposure?.logPass?.uniforms?.uMeter?.value?.w ?? 0) > 0.5;
    passCost.push({
      pass: 'ow-loglum', basis: 'exact',
      fetchesPerFragmentLo: avg([[n, hasDepth ? 5 : 4]]),
      fetchesPerFragmentHi: avg([[n, hasDepth ? 5 : 4]]),
      note: `4 metering taps plus tDepth, and uMeter.w is ${hasDepth ? '1' : '0'} on this `
        + 'frame so the depth fetch is taken by every pixel or by none. The sky de-weight '
        + 'inside it is arithmetic on a value already fetched.',
    });
  }

  // ---- ow-taa --------------------------------------------------------------
  // The only conditional fetch in the whole pass is `tVelocity` at bestUv, taken
  // when the dilated neighbour is covered. bestUv is the argmin of the dilation
  // and covered depths are all finite, so `cb > 0.5` holds exactly when at least
  // one tap of the pattern lands on geometry -- i.e. on the pattern-dilation of
  // the coverage mask. The 3x3 dilation is used here because it CONTAINS every
  // sub-pattern's, which makes this an upper bound on one fetch out of 26.
  if (taaOn) {
    // On top of the dilation: 1 tCurrent, OW_TAA_NB_TAPS for the colour box, 5
    // Catmull-Rom, and the coverage reads -- 2 separate tNormal fetches when the
    // depth lives in its own texture, none at all when it rides in the normal's
    // alpha, because then the dilation taps already carry it.
    //
    // A pixel that takes the off-screen early-out pays the dilation, the tCurrent
    // it already held, and whichever coverage fetches are not part of the
    // pattern. The two populations therefore differ by the neighbourhood and the
    // Catmull-Rom and nothing else -- asserted here rather than restated, so a
    // change to either count cannot quietly desync the model. The two sides are
    // built from DIFFERENT algebra on purpose; writing one as the other's
    // difference would turn the check into a tautology.
    const fixed = (TAA_DEPTH_IN_NORMAL ? 0 : 2) + 1 + TAA_NB_TAPS + 5 + TAA_DILATE_TAPS;
    const band = (TAA_DEPTH_IN_NORMAL ? 1 : 2) + TAA_DILATE_TAPS;
    // The neighbourhood, 5 for the Catmull-Rom, plus the deferred coverage
    // fetch in the layout that still has one.
    const earlyOutSaves = TAA_NB_TAPS + 5 + (TAA_DEPTH_IN_NORMAL ? 0 : 1);
    if (fixed - band !== earlyOutSaves) {
      throw new Error(`fillsim: ow-taa early-out saves ${fixed - band}, not ${earlyOutSaves}`);
    }

    // The lobe tier is a term on the ON-SCREEN population only, and is kept out
    // of `fixed` deliberately. The band returns before sampleCatmullRom, so it
    // saves nothing there; and leaving `fixed` as the full pattern is what lets
    // the assertion above go on meaning what it says -- the two populations
    // still differ by the 3x3 and the five taps, whatever the threshold does to
    // one of them. Zero when the shader has no tier, so this line prices the
    // shader that is actually compiled rather than the one it was written for.
    const crSaved = taaCrReached > 0 ? taaCrDrops / taaCrReached : 0;
    const onScreen = fixed - crSaved;

    if (taaFirstFrame) {
      // The reset frame leaves after tCurrent and tDepth. It is not the frame
      // anyone means to price, so it is reported rather than blended away.
      passCost.push({
        pass: 'ow-taa', basis: 'exact',
        fetchesPerFragmentLo: avg([[n, 2]]), fetchesPerFragmentHi: avg([[n, 2]]),
        note: 'uParams.z was 1 on the measured frame: this is the FIRST-FRAME exit, which '
          + 'returns after tCurrent and tDepth. Re-run at a later --at; the pass does not '
          + 'cost this in steady state.',
      });
    } else if (taaBandKnown) {
      passCost.push({
        pass: 'ow-taa', basis: 'exact',
        fetchesPerFragmentLo: avg([
          [n - taaBand - (taaVelExact - taaBandVel), onScreen],
          [taaVelExact - taaBandVel, onScreen + 1],
          [taaBand - taaBandVel, band],
          [taaBandVel, band + 1],
        ]),
        fetchesPerFragmentHi: avg([
          [n - taaBand - (taaVelExact - taaBandVel), onScreen],
          [taaVelExact - taaBandVel, onScreen + 1],
          [taaBand - taaBandVel, band],
          [taaBandVel, band + 1],
        ]),
        note: `${+onScreen.toFixed(3)} fetches on a pixel whose history is on screen `
          + `(${TAA_DILATE_TAPS}-tap `
          + `velocity dilation read off OW_TAA_DILATE_TAPS, ${TAA_NB_TAPS} for the variance `
          + `neighbourhood, ${+(5 - crSaved).toFixed(3)} of the 5 Catmull-Rom taps, 1 `
          + `tCurrent, and ${TAA_DEPTH_IN_NORMAL
            ? 'NO separate depth or coverage fetches at all -- 1/depth rides in the gbuffer '
              + 'normal alpha, so the dilation taps carry both'
            : '2 tNormal for coverage'}), ${band} on one whose `
          + `history reprojects off the edge -- ${pct(taaBand, n)} % of this frame at `
          + `${(+mb.camTurn.toFixed(3))} deg/frame of turn. ${taaCrOn
            ? 'THE TWO TERMS MOVE IN OPPOSITE DIRECTIONS WITH THE TURN RATE, so neither '
              + 'describes the pass on its own: a faster turn widens the band, which pays '
              + 'less, but pushes the history sample further off the texel centre, which '
              + 'drops fewer lobes; a still camera has no band at all, so every pixel pays '
              + 'the on-screen figure -- but its history lands exactly on the texel grid, '
              + `every lobe weighs exactly zero, and that figure is ${fixed - TAA_CR_GATED.size} `
              + `rather than ${fixed}.`
            : 'THAT SHARE GROWS WITH THE TURN RATE: a flick has a wider band and pays less '
              + `than this, a still camera has no band at all and pays the full ${fixed}.`
          } Both populations take one more tVelocity wherever the dilation lands on `
          + 'geometry. See taaOffScreen and taaCatmullRom.',
      });
    } else {
      // No band figure: fall back to the pre-early-out accounting, which is an
      // upper bound on the real pass and is labelled as one. The 3x3 dilation is
      // used for the velocity branch because it CONTAINS every sub-pattern's.
      let taaVel = 0;
      for (let i = 0; i < n; i++) {
        const x = i % width, y = (i / width) | 0;
        let any = false;
        for (let oy = -1; oy <= 1 && !any; oy++) {
          const sy = Math.min(height - 1, Math.max(0, y + oy));
          for (let ox = -1; ox <= 1; ox++) {
            const sx = Math.min(width - 1, Math.max(0, x + ox));
            const j = sy * width + sx;
            if (covered[j] !== 0 && depth[j] > 0) { any = true; break; }
          }
        }
        if (any) taaVel++;
      }
      passCost.push({
        pass: 'ow-taa', basis: TAA_EARLY_OUT ? 'bounded' : 'exact',
        fetchesPerFragmentLo: avg([[n - taaVel, fixed], [taaVel, fixed + 1]]),
        fetchesPerFragmentHi: avg([[n - taaVel, fixed], [taaVel, fixed + 1]]),
        note: `Every pixel priced at ${fixed} fetches plus one tVelocity wherever the dilation `
          + `lands on geometry. ${TAA_EARLY_OUT
            ? 'THE SHADER HAS AN OFF-SCREEN EARLY-OUT THIS FRAME COULD NOT PRICE, so this is '
              + 'an upper bound, not the cost -- see taaOffScreen for why it was unavailable.'
            : 'The shader has no early-out, so its bound and its real cost are the same number '
              + 'to within that one fetch.'}`,
      });
    }
  }

  // ---- ow-composite --------------------------------------------------------
  {
    const { base, ca, found } = compositeFetches;
    passCost.push({
      pass: 'ow-composite', basis: found ? 'exact' : 'bound only',
      fetchesPerFragmentLo: avg([[n - caPixels, base], [caPixels, base + ca]]),
      fetchesPerFragmentHi: avg([[n - caPixels, base], [caPixels, base + ca]]),
      note: found
        ? `composite.js, fetch sites counted off the compiled fragment source: ${base} `
          + `unconditional (1 tColor + 4 cross neighbours + 1 tBloom + 1 tLut) plus ${ca} `
          + 'guarded by uLens.x * r2 > 2e-5, evaluated per pixel here. The 4 neighbours feed '
          + 'BOTH the dark-chroma clean-up and the sharpen and are fetched before either test, '
          + 'so neither removes them. The exposure read is NOT here: it is a 1x1 target sampled '
          + 'once per vertex in COMPOSITE_VERT and passed down flat, 3 fetches per draw.'
        : `composite.js: ${base} fetch sites counted off the compiled fragment source, but the `
          + '`if ( ca > ... )` guard this row prices was not found in it. Every site is charged '
          + 'unconditionally, so this is an upper bound and not a measurement -- if the branch '
          + 'was renamed rather than removed, fix the search here.',
    });
  }

  // ---- sky-dome ------------------------------------------------------------
  // The dome is a full-screen quad at NDC z = 1 drawn FIRST, and it is depth
  // tested against the prepass buffer the forward pass inherits (see dome.js),
  // so it is rejected before its fragment shader runs on every covered pixel.
  // The draw stream cannot see that -- a rejected fragment is still a submitted
  // draw of vw*vh -- so the whole correction has to come from here. Reported as
  // a FRACTION of the pass's own fragcost bound rather than as an absolute
  // count, because the bound belongs to skSample and this is only asking how
  // many pixels reach it.
  if (render.needsPrepass && render.reusePrepassDepth) {
    passCost.push({
      pass: 'sky-dome', basis: 'coverage',
      shadedFraction: +(sky / n).toFixed(4),
      note: 'Exact: the quad sits at the far plane, so LEQUAL passes precisely where the '
        + 'prepass wrote nothing, and the sky mask here is that same set. Opaque geometry '
        + 'the prepass cannot reproduce would shade here and be overdrawn -- the old cost, '
        + 'never a wrong pixel -- so this is a lower bound by however much of that there is.',
    });
  }

  // ---- ow-view-composite ---------------------------------------------------
  // 1 tColor + 5 tView unconditionally, plus 4 more inside the edge filter. The
  // viewmodel target is cleared TRANSPARENT, so outside the viewmodel every one
  // of the five taps is exactly vec4(0): lmax - lmin is 0, the test against
  // max( 0.045, 0 ) fails, and the four extra fetches provably cannot happen.
  // The bound therefore only applies within one texel of the viewmodel, which is
  // rasterised here rather than guessed at.
  const viewScene = engine.ctx?.viewScene ?? null;
  const viewCamera = engine.ctx?.viewCamera ?? null;
  if (viewScene && viewCamera && render.viewComposite) {
    const vrt = createTarget(width, height);
    const vvp = new THREE.Matrix4()
      .multiplyMatrices(viewCamera.projectionMatrix, viewCamera.matrixWorldInverse);
    const { opaque: vOpaque, transparent: vTrans } =
      collectDrawables(viewScene, viewCamera, { includeTransparent: true });
    for (const item of vOpaque) drawItem(vrt, item, vvp, null);
    for (const item of vTrans) drawItem(vrt, item, vvp, null);
    // The five taps reach one texel out, so a pixel one step outside the
    // silhouette still sees a non-zero neighbour and can enter the filter.
    let edgeCapable = 0;
    for (let i = 0; i < n; i++) {
      const x = i % width, y = (i / width) | 0;
      let any = false;
      for (let oy = -1; oy <= 1 && !any; oy++) {
        const sy = Math.min(height - 1, Math.max(0, y + oy));
        for (let ox = -1; ox <= 1; ox++) {
          if (vrt.covered[sy * width + Math.min(width - 1, Math.max(0, x + ox))] !== 0) {
            any = true; break;
          }
        }
      }
      if (any) edgeCapable++;
    }

    // ---- the uViewRect early-out ------------------------------------------
    // Read off the shipped shader and then evaluated against the shipped
    // _viewScreenRect on THIS frame, not against an average from cod viewrect.
    // A hardcoded population share here would keep quoting the rectangle after
    // someone widened the padding or deleted the branch, and it would read as
    // convincing because the number came from a real measurement once.
    const vcSrc = render.viewComposite.material?.fragmentShader ?? '';
    const vcFirstFetch = vcSrc.indexOf('vec4 m = fetchView( vUv );');
    const VIEW_RECT_EARLY_OUT = vcFirstFetch > 0
      && /uViewRect\.x[\s\S]*?\breturn\s*;/.test(vcSrc.slice(0, vcFirstFetch))
      && typeof render._viewScreenRect === 'function';

    let rectOutside = 0, rectEdgeEscapes = 0, rect = null;
    if (VIEW_RECT_EARLY_OUT) {
      // The world matrices the method reads have to be the ones this frame was
      // rasterised with; in the engine that is guaranteed by calling it after
      // renderer.render, and here it has to be asked for.
      viewScene.updateMatrixWorld(true);
      viewCamera.updateMatrixWorld(true);
      viewCamera.matrixWorldInverse.copy(viewCamera.matrixWorld).invert();
      const r = render._viewScreenRect(viewScene, viewCamera);
      rect = { x0: r.x, y0: r.y, x1: r.z, y1: r.w };
      for (let i = 0; i < n; i++) {
        const px = i % width, py = (i / width) | 0;
        // raster.mjs projects with (0.5 - ndcY * 0.5) * height, so row 0 is the
        // TOP of the screen and UV y counts the other way.
        const u = (px + 0.5) / width;
        const v = 1 - (py + 0.5) / height;
        const inside = u >= rect.x0 && u <= rect.x1 && v >= rect.y0 && v <= rect.y1;
        if (!inside) {
          rectOutside++;
          // A pixel that could enter the edge filter and is NOT in the
          // rectangle is the weapon being cut. It cannot be averaged away, so
          // it is counted and reported rather than folded into a population.
          const sy0 = Math.max(0, py - 1), sy1 = Math.min(height - 1, py + 1);
          const sx0 = Math.max(0, px - 1), sx1 = Math.min(width - 1, px + 1);
          let any = false;
          for (let sy = sy0; sy <= sy1 && !any; sy++) {
            for (let sx = sx0; sx <= sx1; sx++) {
              if (vrt.covered[sy * width + sx] !== 0) { any = true; break; }
            }
          }
          if (any) rectEdgeEscapes++;
        }
      }
    }
    // Pixels the rectangle keeps, split by whether the edge filter can fire.
    // edgeCapable is a subset of the kept set whenever the bound is sound, so
    // the plain-inside population is the remainder; if it were not, the count
    // below would go negative and the avg() partition check would throw.
    const kept = n - rectOutside;
    const keptEdge = Math.max(0, edgeCapable - rectEdgeEscapes);
    passCost.push({
      pass: 'ow-view-composite', basis: 'bounded',
      fetchesPerFragmentLo: avg([[rectOutside, 1], [kept, 6]]),
      fetchesPerFragmentHi: avg([
        [rectOutside, 1],
        [kept - keptEdge, 6],
        [keptEdge, 10],
      ]),
      viewmodelPctOfFrame: pct(edgeCapable, n),
      diag: {
        viewRectEarlyOut: VIEW_RECT_EARLY_OUT,
        viewRectPctSkipped: VIEW_RECT_EARLY_OUT ? pct(rectOutside, n) : 0,
        viewRectUV: rect
          ? [+rect.x0.toFixed(4), +rect.y0.toFixed(4), +rect.x1.toFixed(4), +rect.y1.toFixed(4)]
          : null,
        viewRectEdgeEscapes: rectEdgeEscapes,
        viewmodelPctOfFrame: pct(edgeCapable, n),
      },
      // A cost model is not the place to discover a clipped weapon, but it is a
      // place that CAN discover one, and a silently cheaper pass is exactly what
      // that failure looks like from here.
      alert: rectEdgeEscapes > 0
        ? `ow-view-composite: ${rectEdgeEscapes} pixels that can enter the edge filter fall `
          + 'OUTSIDE uViewRect. On the real rasteriser that is the weapon being cut. Run '
          + 'cod viewrect --q=ultra, which measures this exactly instead of on a coarse grid.'
        : undefined,
      note: `${VIEW_RECT_EARLY_OUT
        ? 'The pass returns after ONE fetch (tColor) outside uViewRect, and this frame that is '
          + 'the share in viewRectPctSkipped -- taken from the shipped _viewScreenRect on this '
          + 'frame\'s matrices, not from an average. Skipping is bit-exact: the viewmodel '
          + 'target is cleared to vec4(0), so out there lmax - lmin is 0, the edge test cannot '
          + 'fire and the last line already reduces to plain world. viewRectEdgeEscapes counts '
          + 'pixels that could enter the filter and were NOT kept, i.e. weapon being cut; it '
          + 'must be 0, and a raster this coarse can report a stray one at the silhouette.'
        : 'NO uViewRect EARLY-OUT FOUND IN THE SHIPPED SHADER, so every pixel is priced at the '
          + 'full 6 fetches. If the branch is supposed to be there, this model is overstating '
          + 'the pass by roughly 40%.'} Inside the rectangle: 1 tColor + 5 tView, plus 4 more `
        + 'in the edge filter. Lo is exact. Hi assumes every pixel the filter can reach takes '
        + 'it, which only the silhouette and the machining really do. The raster draws skinned '
        + 'meshes in bind pose and ignores the alpha cut, so that region is approximate at its '
        + 'edge -- cod viewrect measures 0 skinned and 0 morph in viewScene, so it is sound '
        + 'here either way.',
    });
  }

  // ---- fx-haze-warp --------------------------------------------------------
  // fragcost counts five fetches: 1 tDistort, 1 tColor on the early-out and 3
  // tColor on the chromatic split. No pixel can pay five -- the early-out
  // RETURNS -- so the bound is unreachable by construction and every pixel pays
  // either 2 or 4. Which one is decided by whether a distortion sprite reached
  // that texel, and haze.js is the only pass in the frame whose cost is set by
  // where a PARTICLE landed rather than by the scene. So it is rasterised.
  const haze = measureHazeDistortion(engine, {
    depth, width, height,
    screenW: render.screenSize?.width ?? 0, screenH: render.screenSize?.height ?? 0,
  });
  if (haze) {
    const long = Math.round((haze.warpLongPathPct / 100) * n);
    passCost.push({
      pass: 'fx-haze-warp', basis: 'exact',
      fetchesPerFragmentLo: avg([[n - long, 2], [long, 4]]),
      fetchesPerFragmentHi: avg([[n - long, 2], [long, 4]]),
      distortionCoveragePct: haze.warpLongPathPct,
      ceilingFetchesPerFragment: 4,
      note: 'Read the ceiling first: fragcost scores this pass at 5 because it counts the '
        + 'early-out\'s tColor AND the three chromatic taps, but the early-out RETURNS, so no '
        + 'pixel can pay both. Every pixel pays 2 or 4, and 4 everywhere is 13.4 M against a '
        + 'quoted 16.7 M -- the row was unreachable before anything was measured. What the '
        + 'measurement adds is the split. Where the distortion buffer reads back zero the '
        + 'three chromatic taps are three fetches of the SAME texel (vUvw + 0.0 * k is vUvw) '
        + 'and the early-out returns the identical value bit for bit, so what the branch is '
        + 'worth is a pure coverage question. This rebuilds the half-resolution RG target '
        + 'texel by texel: the ballistic integration in PARTICLE_VERT, the atlas with the '
        + 'sRGB decode the driver applies to RGB and not A, both discards, the soft-depth '
        + 'occlusion test, additive accumulation, and the half-float store where an offset '
        + 'too small to represent becomes zero again. The count then honours the warp\'s '
        + 'LINEAR fetch: a full-resolution pixel sees a 2x2 block and pays the long path if '
        + 'any one texel is non-zero. APPROXIMATE IN ONE PLACE: the atlas is sampled at level '
        + '0 where the driver would minify, which moves the silhouette by a texel or so -- a '
        + '30% error in covered area moves this row by under 4%. ONE FRAME, and the frame '
        + 'matters: over 900 firefight frames the long-path share runs 0% to 16.5% with a '
        + 'median of 2.5% and p90 of 8.3%, peaking around frame 180 as the engagement opens '
        + 'and settling after. `fill --real` samples frame 90 at about 7%, above the median '
        + 'and near p75, so this row is on the conservative side of the run it came from. '
        + 'Even the 16.5% peak prices the pass at 7.8 M.',
    });
  }

  // ---- sky-vol-resolve -----------------------------------------------------
  if (volOn) {
    passCost.push({
      pass: 'sky-vol-resolve', basis: 'exact',
      fetchesPerFragmentLo: avg([[n, 11]]), fetchesPerFragmentHi: avg([[n, 11]]),
      note: 'RESOLVE_FRAG: 1 tCurrent + 1 tVelocity + 1 tHistory + a 3x3 neighbourhood whose '
        + 'loop runs 9 times and `continue`s on i == 4, so it issues 8 fetches and not 9. '
        + 'That one skipped centre tap is the whole difference from the bound -- fragcost '
        + 'cannot see a continue, and 0.8 M of the frame was hiding behind it. Nothing else '
        + 'here is conditional: the off-screen test sets the blend weight to zero AFTER the '
        + 'history fetch it would make pointless.',
    });
  }

  // ---- sky-vol-composite ---------------------------------------------------
  if (volOn) {
    // COUNTED OFF THE COMPILED SHADER, not written down here. Nothing in this
    // pass is conditional -- the sky/geometry split only picks which distance
    // goes into the height integral, not which fetches happen -- so the static
    // count IS the realised one, and the two can never disagree by drifting
    // apart. A hand-written 10 sat here through the change that folded the
    // four tDepth taps into the tVolume fetches and went on reporting 10.
    const volCompFetches = fragmentCost(
      volComposite?.material?.fragmentShader ?? ''
    ).dynamicFetches;
    passCost.push({
      pass: 'sky-vol-composite', basis: 'exact',
      fetchesPerFragmentLo: volCompFetches, fetchesPerFragmentHi: volCompFetches,
      note: 'volumetrics.js COMPOSITE_FRAG, fetch sites counted off the compiled source: '
        + '1 tColor + 1 tDepth + skUpsample\'s 4 x tVolume, whose alpha carries the depth '
        + 'the march already had. Nothing here is conditional, so the bound is exact -- '
        + 'worth recording that not every unmodelled pass was overstated.',
    });
  }

  // ---- depth of field, which only exists while the sights are up -----------
  // These three rows are reachable only under `cod fill --ads`; without it the
  // chain never draws and cmdFill has no row to join them onto. They are here
  // because "not modelled" and "does not run" printed identically before, and
  // an ADS frame is 10% more fill than a hipfire one -- 446 M against 404 M at
  // ultra -- which is not a difference a ranking should be blind to.
  //
  // All three are counted off the compiled source and all three are EXACT, for
  // a stronger reason than sky-vol-composite's: there is not a single branch in
  // any of them. The gather's loop is a fixed 32 iterations with no break and
  // no continue, its radius is max(...,1.0) so it always taps, and the weight
  // that makes an in-focus tap free is a multiply by zero, not a skipped fetch.
  //
  // Counting off the RAW material source only became safe when fragcost learned
  // the GLSL ES 1.00 spellings. Every pass in src/render calls texture2D, three
  // supplies no `#define texture2D texture` outside its own prelude, and until
  // FETCH_BUILTINS listed it these three rows would have read 0, 0 and 0 -- an
  // entire chain reported as free at the exact moment it was being optimised.
  const dof = render?.dof ?? null;
  if (dof) {
    const cost = (p) => fragmentCost(p?.material?.fragmentShader ?? '').dynamicFetches;
    for (const [name, pass, note] of [
      ['ow-dof-pre', dof.pre,
        'dof.js PREFILTER: 1 tDepth at the screen centre for the focal plane, plus 4 tColor '
        + 'taps. The four tDepth taps that used to sit beside them are gone -- the taps land '
        + 'on exact full-res texel centres, so the 1/viewDepth in the colour target\'s alpha '
        + 'is the same number the depth fetch was returning.'],
      ['ow-dof-gather', dof.gather,
        'dof.js GATHER: 1 centre + OW_DOF_TAPS on a golden-angle spiral, no early exit.'],
      ['ow-dof-combine', dof.combine,
        'dof.js COMBINE: 1 tColor + 1 tBlur + 1 tDepth for the focal plane. The per-pixel '
        + 'depth fetch is gone the same way the prefilter\'s four are.'],
    ]) {
      const f = cost(pass);
      passCost.push({
        pass: name, basis: 'exact', fetchesPerFragmentLo: f, fetchesPerFragmentHi: f, note,
      });
    }
  }

  return {
    simulated: { width, height, pixels: n, opaqueItems, culledByFrustum: culled },
    passCost,
    coverage: {
      skyPixels: sky, skyPct: pct(sky, n),
      shadingPixels: shading, shadingPct: pct(shading, n),
    },
    ssr: {
      note: 'Sky pixels return before any fetch; rays within 0.94 of the view direction '
        + 'return after two. Only "entered" pixels can pay the 28-step march, and each of '
        + 'those still breaks at its first hit.',
      skippedSky: sky, skippedFacing: ssrFacing, entered: ssrEntered,
      enteredPctOfFrame: pct(ssrEntered, n),
    },
    ssrMarch: ssrOn ? {
      note: 'Where the entered rays end. Every entered pixel is in exactly one bucket, and '
        + 'the bucket says which break fired -- so a march that is cheap because its rays '
        + 'leave the screen reads differently from one that is cheap because they hit early.',
      steps: SSR_STEPS, refineTaps: SSR_REFINE,
      maxDistanceM: +ssrParams.x.toFixed(2), thicknessM: +ssrParams.y.toFixed(2),
      whereTheRaysEnd: {
        hit: ssrHit,
        leftTheScreen: ssrOffScreen,
        turnedBackPastTheCamera: ssrBehind,
        ranPastMaxDistance: ssrDistOut,
        exhaustedTheStepBudget: ssrRanOut,
      },
      marchFetchesTotal: ssrFetch,
      marchFetchesPerEnteredPixel: +(ssrFetch / Math.max(1, ssrEntered)).toFixed(2),
      hitRatePctOfEntered: pct(ssrHit, ssrEntered),
    } : { unavailable: 'SSR is off in this preset, or its shader/uniforms moved' },
    contact: {
      note: 'Surfaces facing away from the sun return after two fetches, before the march.',
      skippedSky: sky, skippedFacingAway: shading - lit, entered: lit,
      enteredPctOfFrame: pct(lit, n),
    },
    contactMarch: csOn ? {
      note: 'Where the lit rays end. The march is short by design -- under a metre of world '
        + 'travel -- so most rays simply run out of steps, which is the expensive case and '
        + 'the reason this row does not collapse the way SSR does.',
      steps: CS_STEPS,
      rayLengthMAt1x: +csParams.x.toFixed(2), thicknessM: +csParams.y.toFixed(2),
      whereTheRaysEnd: {
        occluded: csHit,
        leftTheScreen: csOffScreen,
        exhaustedTheStepBudget: csRanOut,
      },
      samplesLandingOnEmptySky: csEmpty,
      marchFetchesTotal: csFetch,
      marchFetchesPerLitPixel: +(csFetch / Math.max(1, lit)).toFixed(2),
      occludedPctOfLit: pct(csHit, lit),
    } : { unavailable: 'contact shadows are off in this preset, or the shader/uniforms moved' },
    gtao: { skippedSky: sky, entered: shading, enteredPctOfFrame: pct(shading, n) },
    haze: haze ?? { unavailable: 'fx-haze-warp is off this frame, or the haze system moved' },
    motionBlur: mbOut,
    taaOffScreen: taaOut,
    taaCatmullRom: taaCrOut,
    volumetricMarch: volOn ? {
      note: 'Exact: a step past the last cascade split issues no shadow tap at all, so the '
        + 'real tap count is the steps that land inside it, not the loop bound.'
        + (VOL_SKIP_EPS > 0
          ? ` SK_VIS_SKIP is ${VOL_SKIP_EPS} in the shipped shader, so a step whose weight is `
            + 'under that fraction of the reference also issues none; those are counted under '
            + 'skippedNegligibleWeight and are tested FIRST, in the shader\'s own order. This '
            + 'one bucket rests on the density approximation described at densFactor, because '
            + 'the weight is proportional to density -- the others are geometric.'
          : ' No SK_VIS_SKIP in the shipped shader.')
        + (VOL_TAP_TIER > 0
          ? ` SK_VOL_TAP_TIER is ${VOL_TAP_TIER}, so a tapping step between the two thresholds `
            + 'takes ONE tap rather than the full budget. Those steps are still tapping steps -- '
            + 'they issue a call and a fetch -- so they stay in the tapped bucket; what they '
            + 'change is fetchesPerFragment, which is why that figure is no longer '
            + 'maxTapsPerTappingStep times shadowTappingStepsPerPixel.'
          : ''),
      weightSkipEpsilon: VOL_SKIP_EPS,
      stepsPerPixel: steps, lastCascadeSplitM: +lastSplit.toFixed(1), fogFarM: +fogFar.toFixed(1),
      marchingPixels: volPixels,
      shadowTappingStepsPerPixel: +(volTapSteps / Math.max(1, volPixels)).toFixed(2),
      pctOfStepsThatTap: pct(volTapSteps, volPixels * steps),
      // A ceiling once the tier exists, so it is named as one. meanTapsPerTappingStep
      // is the figure that actually multiplies out to fetchesPerFragment.
      maxTapsPerTappingStep: VOL_TAPS,
      tapTierThreshold: VOL_TAP_TIER,
      oneTapStepsPerPixel: +(volTapOneSteps / Math.max(1, volPixels)).toFixed(2),
      oneTapPctOfTappingSteps: pct(volTapOneSteps, volTapSteps),
      meanTapsPerTappingStep: +(volTapFetches / Math.max(1, volTapSteps)).toFixed(3),
      // Every step is in exactly one of these buckets. The taps ride on the
      // first; the other four cost nothing.
      whereTheStepsGo: {
        tapped: volTapSteps,
        skippedNegligibleWeight: volSkipWeight,
        skippedPastLastSplit: volSkipSplit,
        skippedOutsideCascadeMap: volSkipProj,
        skippedTooThinToScatter: volSkipDens,
        skippedZeroLengthStep: volSkipDt,
        skippedAfterTransmittanceBreak: volSkipBreak,
      },
      fetchesPerFragment: +(volTapFetches / Math.max(1, volPixels) + VOL_FIXED_FETCHES).toFixed(1),
      // The aggregate above is the average of two populations that share almost
      // nothing, which is why it reads far higher than a "how far does 150 m go
      // into 900 m" estimate predicts. A geometry pixel closer than the last
      // split has maxT below it, so EVERY step is inside and taps; only sky
      // rays (and geometry beyond 150 m) ever leave the cascades early.
      bySurface: {
        sky: {
          pixels: volPixSky,
          tappingStepsPerPixel: +(volTapSky / Math.max(1, volPixSky)).toFixed(2),
          pctOfStepsThatTap: pct(volTapSky, volPixSky * steps),
        },
        geometry: {
          pixels: volPixGeo,
          tappingStepsPerPixel: +(volTapGeo / Math.max(1, volPixGeo)).toFixed(2),
          pctOfStepsThatTap: pct(volTapGeo, volPixGeo * steps),
        },
      },
    } : { unavailable: 'volumetric march is off in this preset, or its uniforms moved' },
  };
}

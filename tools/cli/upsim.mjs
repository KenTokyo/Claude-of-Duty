/**
 * upsim — does an edge-directed reconstruction beat bilinear when the frame is
 * rendered below display resolution?
 *
 * WHY THIS EXISTS
 *   `renderScale` is worth more than every fetch optimisation in the post chain
 *   put together: at ultra, 1.00 costs 353 990 461 post fetches and 0.72 costs
 *   194 368 716 — minus 45.1% for one number. The reason it is not simply turned
 *   down is that it has to still look native, and the only thing standing between
 *   the internal image and the canvas today is the bilinear filter inside
 *   `texture2D( tColor, vUv )` in ow-composite. (`composite.render( renderer,
 *   null )` writes at drawing-buffer size while `uTexel`/`uResolution` describe
 *   the internal size, so the upscale is already happening there, for free, with
 *   no separate pass — see render/index.js.)
 *
 *   Together with the contrast-adaptive luma sharpen that pass already runs in
 *   SOURCE texels, that makes the chain FSR 1.0 without EASU. This tool measures
 *   whether adding the missing edge-directed part is worth it — BEFORE it is
 *   written into the shader, so the answer is a number rather than a belief.
 *
 * THE MEASUREMENT
 *   Reference   render at ss x display resolution, box-filter down to display
 *               resolution. Supersampled, so it is what the frame SHOULD look
 *               like: no aliasing of its own to confuse the comparison.
 *   Source      render at ss x internal resolution, box-filter down to internal
 *               resolution. Supersampling here is not cheating — the internal
 *               image the composite reads has been through TAA, which is an
 *               accumulating supersampler. An aliased 1-spp source would be
 *               measuring TAA's absence, not the upscaler.
 *   Candidates  reconstruct display resolution from the source using ONLY the
 *               five taps ow-composite already holds in registers: the centre
 *               and the four cross neighbours at +/- one SOURCE texel. Any
 *               candidate that needs a sixth tap is not free and is not here.
 *   Verdict     PSNR, SSIM and an edge-weighted PSNR against the reference, plus
 *               a sharpness ratio that says whether a filter is landing detail or
 *               merely inventing contrast.
 *
 * WHY THE FLAT-SHADED RASTERISER IS THE RIGHT TEST SIGNAL HERE, FOR ONCE
 *   `cod shot` has no textures, no lighting model and no post — which is why it
 *   is useless for almost every shader question. An upscaler is the exception:
 *   its whole job is hard geometric edges at arbitrary angles on smooth
 *   interiors, and that is exactly and only what this rasteriser produces. The
 *   reference is also unambiguous, because supersampling flat-shaded polygons
 *   converges to the true coverage rather than to another approximation.
 *
 * WHAT IT CANNOT TELL YOU
 *   Nothing about cost in ms, as ever. Every candidate here fetches the same five
 *   texels, so they differ in ALU only, and ALU behind five dependent texture
 *   fetches is close to free — but "close to free" is an argument, not a
 *   measurement. `cod fill` still prices the fetches and reports 0 for a change
 *   that adds only arithmetic.
 */
import { renderShot, writePNG } from './raster.mjs';

// ---------------------------------------------------------------------------
//  images: { w, h, c: Float32Array( w * h * 3 ) }, LINEAR light
// ---------------------------------------------------------------------------

/**
 * Box-filter an image down by an integer factor.
 *
 * A box over an exact integer factor is the correct area-average of the
 * supersamples, which is the definition of the coverage the reference is
 * supposed to represent. Anything wider would prefilter the reference and make
 * every candidate look better than it is.
 */
export function boxDown(img, f) {
  if (f === 1) return img;
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f);
  const c = new Float32Array(w * h * 3);
  const inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < f; j++) {
        const row = (y * f + j) * img.w;
        for (let i = 0; i < f; i++) {
          const s = (row + x * f + i) * 3;
          r += img.c[s]; g += img.c[s + 1]; b += img.c[s + 2];
        }
      }
      const d = (y * w + x) * 3;
      c[d] = r * inv; c[d + 1] = g * inv; c[d + 2] = b * inv;
    }
  }
  return { w, h, c };
}

/**
 * `texture2D( tex, uv )` with LinearFilter and ClampToEdgeWrapping, which is how
 * every colour target in this engine is configured.
 *
 * Texel centres sit at ( i + 0.5 ) / w, so the source coordinate is
 * `uv * size - 0.5` — getting that half-texel wrong shifts the whole image by
 * half a source texel and would flatter or damn every candidate equally, which
 * is worse than an obvious error because it looks like a result.
 */
export function bl(img, u, v, out) {
  const { w, h, c } = img;
  const sx = u * w - 0.5, sy = v * h - 0.5;
  const fx0 = Math.floor(sx), fy0 = Math.floor(sy);
  const tx = sx - fx0, ty = sy - fy0;
  const x0 = fx0 < 0 ? 0 : fx0 > w - 1 ? w - 1 : fx0;
  const x1 = fx0 + 1 < 0 ? 0 : fx0 + 1 > w - 1 ? w - 1 : fx0 + 1;
  const y0 = fy0 < 0 ? 0 : fy0 > h - 1 ? h - 1 : fy0;
  const y1 = fy0 + 1 < 0 ? 0 : fy0 + 1 > h - 1 ? h - 1 : fy0 + 1;
  const i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3;
  const i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty, w11 = tx * ty;
  out[0] = c[i00] * w00 + c[i10] * w10 + c[i01] * w01 + c[i11] * w11;
  out[1] = c[i00 + 1] * w00 + c[i10 + 1] * w10 + c[i01 + 1] * w01 + c[i11 + 1] * w11;
  out[2] = c[i00 + 2] * w00 + c[i10 + 2] * w10 + c[i01 + 2] * w01 + c[i11 + 2] * w11;
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
//  the candidates
// ---------------------------------------------------------------------------

/**
 * Every candidate is handed the same five values ow-composite already has:
 * `c` (centre) and `n1..n4` (+x, -x, +y, -y at one SOURCE texel), and writes
 * three floats into `out`. No candidate may fetch.
 *
 * EASU'S DIRECTIONALITY, ADAPTED TO A FIVE-TAP CROSS
 *   FSR 1.0's FsrEasuSet derives, per axis, a direction and a "length" that says
 *   how confidently the neighbourhood is a straight edge rather than a dot:
 *
 *     dirX = lE - lW                       (the two-texel first difference)
 *     lenX = saturate( |dirX| / max( |lE - lC|, |lC - lW| ) ) ^ 2
 *
 *   On a monotone ramp the numerator equals the sum of the one-sided differences,
 *   so the ratio saturates to 1. On a single bright texel — a gradient reversal —
 *   the numerator is ~0 while the denominator is large, so it collapses to 0.
 *   That is the whole trick: it separates "edge" from "detail" with two subtracts
 *   and a divide, and it is what stops an edge filter from eating a specular
 *   glint or a thin wire.
 *
 *   EASU then builds an anisotropic elliptical kernel over twelve gathered
 *   texels. Twelve gathers are not available here and never will be, so the
 *   direction and the length are used instead to steer a blend of the five
 *   values already in registers:
 *
 *     blurAlong   the average of the neighbour pair that lies ALONG the edge.
 *                 Blending toward it removes the staircase, which is the single
 *                 most visible artefact of upscaling.
 *     blurAcross  the average of the pair that CROSSES the edge. Sharpening
 *                 against it restores what the bilinear tent took out, and —
 *                 unlike the isotropic sharpen the pass runs today — does not
 *                 also sharpen along the edge and re-cut the staircase it just
 *                 smoothed.
 */
const CANDIDATES = {
  /** What ships today: the bilinear tap, untouched. */
  bilinear(c, n1, n2, n3, n4, p, out) {
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  },

  easu5(c, n1, n2, n3, n4, p, out) {
    const lc = lum(c[0], c[1], c[2]);
    const lE = lum(n1[0], n1[1], n1[2]);
    const lW = lum(n2[0], n2[1], n2[2]);
    const lS = lum(n3[0], n3[1], n3[2]);
    const lN = lum(n4[0], n4[1], n4[2]);

    const dirX = lE - lW;
    const dirY = lS - lN;
    const denX = Math.max(Math.abs(lE - lc), Math.abs(lc - lW));
    const denY = Math.max(Math.abs(lS - lc), Math.abs(lc - lN));
    let lenX = denX > 1e-8 ? clamp01(Math.abs(dirX) / denX) : 0;
    let lenY = denY > 1e-8 ? clamp01(Math.abs(dirY) / denY) : 0;
    lenX *= lenX; lenY *= lenY;

    // How much of the gradient points along x. 1 = a vertical edge.
    const gx = dirX * dirX, gy = dirY * dirY;
    const g = gx + gy;
    const wx = g > 1e-12 ? gx / g : 0.5;
    const wy = 1 - wx;

    // Confidence that this is a straight edge at all, weighted toward the axis
    // that actually carries the gradient: a strong lenY on an axis with no
    // gradient is a statement about noise.
    const len = lenX * wx + lenY * wy;

    // Contrast gate. A ramp across a smooth shading gradient saturates `len` just
    // as an edge does — it is monotone — so without this the filter would smooth
    // every gently shaded surface along its gradient. Scaled by the centre
    // luminance so it means the same thing in a bright and a dark part of frame.
    const amp = Math.max(Math.abs(dirX), Math.abs(dirY));
    const rel = amp / (lc + amp + 1e-6);
    const gate = p.noGate ? 1 : smoothstep(p.gate0, p.gate1, rel);
    const conf = (p.noLen ? 1 : len) * gate;

    const wAlong = p.kAlong * conf;
    const wAcross = p.kAcross * conf;

    // A LUMINANCE GAIN rather than a per-channel filter, which is the form the
    // shipped sharpen already uses and the form composite.js argues for at
    // length: a scalar multiple of the centre colour cannot invent chroma, so it
    // cannot reproduce the magenta/green fringing that a per-channel filter
    // running against chromatically-aberrated taps produced. The clamp becomes a
    // clamp on the target luminance, which is the same anti-ringing bound
    // expressed one dimension down.
    if (p.lumaOnly) {
      const lAcross = (lE + lW) * 0.5 * wx + (lS + lN) * 0.5 * wy;
      let lt = lc + (lc - lAcross) * wAcross;
      if (p.clampToTaps) {
        const lmn = Math.min(lc, lE, lW, lS, lN), lmx = Math.max(lc, lE, lW, lS, lN);
        lt = lt < lmn ? lmn : lt > lmx ? lmx : lt;
      }
      const g = lt / Math.max(lc, 1e-4);
      out[0] = c[0] * g; out[1] = c[1] * g; out[2] = c[2] * g;
      return;
    }

    for (let k = 0; k < 3; k++) {
      const ax = (n1[k] + n2[k]) * 0.5;
      const ay = (n3[k] + n4[k]) * 0.5;
      const along = ax * wy + ay * wx;
      const across = ax * wx + ay * wy;
      let v = c[k] + (along - c[k]) * wAlong;
      v += (c[k] - across) * wAcross;
      out[k] = v;
    }

    if (p.clampToTaps) {
      for (let k = 0; k < 3; k++) {
        const mn = Math.min(c[k], n1[k], n2[k], n3[k], n4[k]);
        const mx = Math.max(c[k], n1[k], n2[k], n3[k], n4[k]);
        out[k] = out[k] < mn ? mn : out[k] > mx ? mx : out[k];
      }
    }
  },
};

// ---------------------------------------------------------------------------
//  the two shipped post-ops that consume the same five taps
// ---------------------------------------------------------------------------

/**
 * The dark-chroma clean-up and the contrast-adaptive luma sharpen, transcribed
 * from composite.js so the arms are compared through the pipeline they will
 * actually sit in rather than in isolation.
 *
 * `dirBlur` swaps the sharpen's isotropic four-tap blur for the ACROSS-edge pair
 * — the only change to the shipped sharpen that costs nothing and is a candidate
 * in its own right. Sharpening isotropically also sharpens ALONG an edge, which
 * re-cuts the staircase the reconstruction is trying to remove.
 *
 * `adaptive: false` removes the contrast roll-off and the dark gate, leaving a
 * plain luma unsharp mask. That is a candidate too, because the roll-off was
 * tuned for a native-resolution frame where high local contrast means real
 * detail; on an upscaled frame high local contrast is exactly the edge that the
 * bilinear tent softened, i.e. the place sharpening is most warranted.
 *
 * The absolute thresholds (0.003, 0.030, 0.004, 0.03) are quoted verbatim, which
 * is only meaningful if the image is in the same scale the shader sees. `runUpsim`
 * scales the linear image so the geometry's 90th-percentile luminance lands at
 * `--pre` (default 0.5, a daylight pre-exposure value) before any of this runs.
 */
function shippedPost(c, n1, n2, n3, n4, hdr, sharpen, dirBlur, adaptive, out) {
  let h0 = hdr[0], h1 = hdr[1], h2 = hdr[2];

  const nb0 = (n1[0] + n2[0] + n3[0] + n4[0]) * 0.25;
  const nb1 = (n1[1] + n2[1] + n3[1] + n4[1]) * 0.25;
  const nb2 = (n1[2] + n2[2] + n3[2] + n4[2]) * 0.25;
  const lh = lum(h0, h1, h2);
  const ln = lum(nb0, nb1, nb2);
  const w = (1 - smoothstep(0.003, 0.030, lh)) * 0.60;
  if (w > 0.005 && ln > 1e-6) {
    const s = lh / ln;
    h0 += (nb0 * s - h0) * w; h1 += (nb1 * s - h1) * w; h2 += (nb2 * s - h2) * w;
  }

  if (sharpen > 0.001) {
    const l1 = lum(n1[0], n1[1], n1[2]), l2 = lum(n2[0], n2[1], n2[2]);
    const l3 = lum(n3[0], n3[1], n3[2]), l4 = lum(n4[0], n4[1], n4[2]);
    const lc = lum(c[0], c[1], c[2]);
    const lmn = Math.min(l1, l2, l3, l4);
    const lmx = Math.max(l1, l2, l3, l4);
    let lblur = (l1 + l2 + l3 + l4) * 0.25;
    if (dirBlur) {
      const dirX = l1 - l2, dirY = l3 - l4;
      const gx = dirX * dirX, gy = dirY * dirY, g = gx + gy;
      const wx = g > 1e-12 ? gx / g : 0.5;
      lblur = (l1 + l2) * 0.5 * wx + (l3 + l4) * 0.5 * (1 - wx);
    }
    let amount = sharpen;
    if (adaptive) {
      const contrast = (lmx - lmn) / (lmx + lmn + 0.02);
      amount *= (1 - clamp01(contrast * 1.6));
      amount *= smoothstep(0.004, 0.03, lc);
    }
    let gain = (lc + (lc - lblur) * amount) / Math.max(lc, 1e-4);
    gain = gain < 0 ? 0 : gain > 4 ? 4 : gain;
    h0 *= gain; h1 *= gain; h2 *= gain;
  }

  out[0] = h0; out[1] = h1; out[2] = h2;
}

// ---------------------------------------------------------------------------
//  running a candidate over the whole frame
// ---------------------------------------------------------------------------

function upscale(src, W, H, name, p, { sharpen, dirBlur, adaptive = true }) {
  const fn = CANDIDATES[name];
  const c = new Float32Array(3), n1 = new Float32Array(3), n2 = new Float32Array(3);
  const n3 = new Float32Array(3), n4 = new Float32Array(3);
  const hdr = new Float32Array(3), fin = new Float32Array(3);
  const out = new Float32Array(W * H * 3);
  const tx = 1 / src.w, ty = 1 / src.h;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      bl(src, u, v, c);
      bl(src, u + tx, v, n1);
      bl(src, u - tx, v, n2);
      bl(src, u, v + ty, n3);
      bl(src, u, v - ty, n4);
      fn(c, n1, n2, n3, n4, p, hdr);
      shippedPost(c, n1, n2, n3, n4, hdr, sharpen, dirBlur, adaptive, fin);
      const d = (y * W + x) * 3;
      out[d] = fin[0] < 0 ? 0 : fin[0];
      out[d + 1] = fin[1] < 0 ? 0 : fin[1];
      out[d + 2] = fin[2] < 0 ? 0 : fin[2];
    }
  }
  return { w: W, h: H, c: out };
}

// ---------------------------------------------------------------------------
//  display transform + metrics
// ---------------------------------------------------------------------------

/**
 * One FIXED transform for every image in the comparison: Reinhard then sRGB.
 *
 * `toPNGBuffer` meters each image it is given, which is right for a QC picture
 * and fatal here — a filter that changes the 90th percentile by a hair would move
 * the exposure and score against a differently-graded reference. The gain is
 * therefore computed once, from the reference, and reused.
 */
export function displayEncode(img) {
  const n = img.w * img.h;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = Math.max(0, img.c[i * 3 + k]);
      const tm = v / (1 + v);
      out[i * 3 + k] = tm <= 0.0031308 ? tm * 12.92 : 1.055 * Math.pow(tm, 1 / 2.4) - 0.055;
    }
  }
  return { w: img.w, h: img.h, c: out };
}

export function toLuma(img) {
  const n = img.w * img.h;
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = lum(img.c[i * 3], img.c[i * 3 + 1], img.c[i * 3 + 2]);
  return l;
}

/** Sobel magnitude, used both as an edge weight and as a sharpness measure. */
export function sobel(l, w, h) {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -l[i - w - 1] - 2 * l[i - 1] - l[i + w - 1] + l[i - w + 1] + 2 * l[i + 1] + l[i + w + 1];
      const gy = -l[i - w - 1] - 2 * l[i - w] - l[i - w + 1] + l[i + w - 1] + 2 * l[i + w] + l[i + w + 1];
      g[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return g;
}

/**
 * Windowed SSIM on display luma, 8x8 windows at stride 4.
 *
 * PSNR alone ranks a blurrier image above a sharper one that is a fraction of a
 * pixel off, which is precisely the mistake an upscaler evaluation must not make.
 * SSIM compares local structure and does not.
 */
function ssim(a, b, w, h) {
  const C1 = 0.01 * 0.01, C2 = 0.03 * 0.03;
  const W = 8, S = 4;
  let sum = 0, n = 0;
  for (let y = 0; y + W <= h; y += S) {
    for (let x = 0; x + W <= w; x += S) {
      let ma = 0, mb = 0;
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        ma += a[(y + j) * w + x + i]; mb += b[(y + j) * w + x + i];
      }
      const inv = 1 / (W * W);
      ma *= inv; mb *= inv;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const da = a[(y + j) * w + x + i] - ma, db = b[(y + j) * w + x + i] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      const d = 1 / (W * W - 1);
      va *= d; vb *= d; cov *= d;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function metrics(cand, ref, refEdge, refEdgeSum) {
  const w = ref.w, h = ref.h, n = w * h;
  let mse = 0;
  for (let i = 0; i < n * 3; i++) { const d = cand.c[i] - ref.c[i]; mse += d * d; }
  mse /= n * 3;

  const lc = toLuma(cand), lr = toLuma(ref);

  // Edge-weighted MSE: where the reference has structure, which is where an
  // upscaler either works or does not. A flat wall agrees under every filter and
  // would otherwise dominate the average by area.
  let emse = 0;
  for (let i = 0; i < n; i++) {
    const d = lc[i] - lr[i];
    emse += d * d * refEdge[i];
  }
  emse /= Math.max(refEdgeSum, 1e-9);

  const gc = sobel(lc, w, h);
  let sc = 0, sr = 0;
  for (let i = 0; i < n; i++) { sc += gc[i]; sr += refEdge[i]; }

  return {
    psnr: +(10 * Math.log10(1 / Math.max(mse, 1e-12))).toFixed(3),
    edgePsnr: +(10 * Math.log10(1 / Math.max(emse, 1e-12))).toFixed(3),
    ssim: +ssim(lc, lr, w, h).toFixed(5),
    sharpness: +(sc / Math.max(sr, 1e-9)).toFixed(4),
  };
}

// ---------------------------------------------------------------------------
//  entry point
// ---------------------------------------------------------------------------

/**
 * @param engine   a booted engine, already stepped to the frame under test
 * @param scale    renderScale being simulated
 * @param W,H      display resolution to reconstruct
 * @param ss       supersample factor for BOTH renders
 * @param pre      geometry p90 linear luminance the images are normalised to,
 *                 so the shader's absolute thresholds mean what they mean on GPU
 * @param arms     [{ label, filter, params, sharpen, dirBlur }]
 */
export function runUpsim(engine, { scale = 0.72, W = 768, H = 498, ss = 3, srcSs = null, pre = 0.5, sharpen = 0.22, arms = null, out = null } = {}) {
  const t0 = performance.now();
  const refHi = renderShot(engine, { width: W * ss, height: H * ss });
  const ref0 = boxDown({ w: W * ss, h: H * ss, c: refHi.rt.color }, ss);

  // `srcSs` separates how clean the internal image is from how clean the
  // reference is. srcSs = ss models a TAA history that has converged; srcSs = 1
  // models the first frame after a camera cut, when it has not converged at all.
  // Reality is between them and both are worth asking about, because a filter
  // that only wins on a converged source wins on standing still.
  const sss = srcSs ?? ss;
  const w = Math.max(1, Math.floor(W * scale)), h = Math.max(1, Math.floor(H * scale));
  const srcHi = renderShot(engine, { width: w * sss, height: h * sss });
  const src0 = boxDown({ w: w * sss, h: h * sss, c: srcHi.rt.color }, sss);
  const renderMs = performance.now() - t0;

  // Normalise both images by the SAME factor, taken from the reference's lit
  // geometry, so the shipped thresholds below are evaluated in the scale the
  // shader sees rather than in whatever scale the flat shader happened to emit.
  const lums = [];
  for (let i = 0; i < ref0.w * ref0.h; i++) {
    lums.push(lum(ref0.c[i * 3], ref0.c[i * 3 + 1], ref0.c[i * 3 + 2]));
  }
  lums.sort((a, b) => a - b);
  const p90 = lums[Math.floor(lums.length * 0.9)] || 1;
  const norm = pre / p90;
  const scaleImg = (img) => {
    const c = new Float32Array(img.c.length);
    for (let i = 0; i < c.length; i++) c[i] = img.c[i] * norm;
    return { w: img.w, h: img.h, c };
  };
  const ref = scaleImg(ref0), src = scaleImg(src0);

  const refD = displayEncode(ref);
  const refL = toLuma(refD);
  const refEdge = sobel(refL, refD.w, refD.h);
  let refEdgeSum = 0;
  for (let i = 0; i < refEdge.length; i++) refEdgeSum += refEdge[i];

  const list = arms ?? [{ label: 'bilinear', filter: 'bilinear', params: {}, sharpen, dirBlur: false }];
  const results = [];
  const images = new Map();
  for (const a of list) {
    const t = performance.now();
    const img = upscale(src, W, H, a.filter, a.params ?? {}, {
      sharpen: a.sharpen ?? sharpen, dirBlur: !!a.dirBlur, adaptive: a.adaptive !== false,
    });
    const d = displayEncode(img);
    images.set(a.label, d);
    results.push({ label: a.label, ...metrics(d, refD, refEdge, refEdgeSum), ms: +(performance.now() - t).toFixed(0) });
  }

  // A control: the reference sampled through nothing at all is the ceiling, and
  // point-sampling the source is the floor. If a candidate is not between them
  // the harness is wrong, not the filter.
  const nearest = { w: W, h: H, c: new Float32Array(W * H * 3) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sxi = Math.min(src.w - 1, Math.floor(((x + 0.5) / W) * src.w));
    const syi = Math.min(src.h - 1, Math.floor(((y + 0.5) / H) * src.h));
    const s = (syi * src.w + sxi) * 3, d = (y * W + x) * 3;
    nearest.c[d] = src.c[s]; nearest.c[d + 1] = src.c[s + 1]; nearest.c[d + 2] = src.c[s + 2];
  }
  const nearestD = displayEncode(nearest);
  const floor = { label: '(control) nearest', ...metrics(nearestD, refD, refEdge, refEdgeSum) };

  return {
    display: `${W}x${H}`, internal: `${w}x${h}`, scale,
    supersample: ss, sourceSupersample: sss,
    preExposureP90: pre, sharpen,
    renderMs: +renderMs.toFixed(0),
    control: floor,
    arms: results.sort((a, b) => b.ssim - a.ssim),
    _images: images, _ref: refD,
    _stats: { opaque: refHi.opaque, transparent: refHi.transparent, culled: refHi.culled },
    _out: out,
  };
}

/** Quantise a display-space float image to 8-bit RGBA for writePNG. */
export function toRGBA(img) {
  const n = img.w * img.h;
  const px = Buffer.alloc(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    for (let k = 0; k < 3; k++) px[p + k] = Math.max(0, Math.min(255, Math.round(img.c[i * 3 + k] * 255)));
    px[p + 3] = 255;
  }
  return px;
}

export { writePNG };

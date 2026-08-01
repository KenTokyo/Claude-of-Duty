/**
 * How many samples a motion-blur streak actually needs.
 *
 * WHAT IS BEING QUESTIONED
 *   ow-mb is 11 % of the frame and almost all of it is the inner loop. The loop
 *   length is set by one line in motionblur.js:
 *
 *       int taps = int( clamp( ceil( radius * 0.5 ), 2.0, float( OW_MB_TAPS ) ) );
 *
 *   which spends 2 * taps fetches on a streak of `radius` pixels -- one sample
 *   per pixel of streak. That density is asserted in the comment above it and
 *   has never been measured. At the frame `fill --look=1` prices, the mean
 *   radius is 11.4 px and the mean tap count is 6.19, so the loop is 12.4 of the
 *   pass's 15.4 fetches on a blurred pixel and 66 % of the frame is blurred.
 *   Every 0.1 taken off the mean tap count is 0.44 M fetches.
 *
 * WHY ONE SAMPLE PER PIXEL IS NOT OBVIOUSLY RIGHT
 *   A blur is a low-pass. Sampling it at the Nyquist rate of the SOURCE is what
 *   the density-1 rule does, but the OUTPUT has already had everything above the
 *   streak's own cutoff removed, so the rule is conservative by construction.
 *   What stops it being reducible for free is that this pass runs AFTER the TAA
 *   resolve -- there is no temporal filter downstream to resolve a dithered
 *   sample set, so whatever undersampling produces stays in the frame. The two
 *   failure modes are different and are reported separately below:
 *
 *     BANDING  the streak resolves into discrete copies of the source instead
 *              of a smear. Smooth, structured, and what you get without jitter.
 *     GRAIN    the per-pixel jitter converts that structure into noise. Still
 *              an error, but incoherent, and the eye reads it very differently.
 *
 *   The shader jitters (owIGN on gl_FragCoord, offset by the frame), so it is
 *   already trading the first for the second. Measuring the split is the point:
 *   a candidate that only moves error from banding into grain is a different
 *   proposition from one that adds error at all.
 *
 * THE COLLISION NOBODY WOULD LOOK FOR
 *   The loop is not one comb of 2 * taps samples. It is TWO combs of `taps`,
 *   because the inner `s` loop mirrors each offset:
 *
 *       t = ( i + jitter ) / taps           i = 1 .. taps
 *       o = vel * ( t - 0.5 )               and the sample pair is +o and -o
 *
 *   so arm s=0 lands at p_i = ( i + j ) / T - 0.5 and arm s=1 at -p_i, both in
 *   units of the streak. Those two sets are mirror images of each other about
 *   zero, and a mirror image of an arithmetic comb is the SAME comb whenever
 *   2j is an integer. At j = 0 every sample is fetched exactly twice and the
 *   effective density is half of what the rule intends; at j = +-0.25 the two
 *   combs interleave perfectly and the density is what the rule says. `j` is
 *   uniform on [-0.5, 0.5), so the pass is somewhere between those two all over
 *   the frame -- paying for density 1 and receiving between 0.5 and 1.
 *
 *   Hence the `comb` geometry below: the same fetch count laid down as ONE
 *   uniform comb, which is what the rule was trying to buy. If the shipped
 *   geometry is losing samples to the collision, a comb at a LOWER tap count
 *   will match it, and that is a saving with no quality question attached.
 *
 * WHAT THE TRUTH IS HERE
 *   Not a supersampled render -- the question is sampling of the streak, not of
 *   the geometry. The reference is the SAME filter, same depth weight, same
 *   shutter profile, evaluated with 256 uniform samples. So every number below
 *   is sampling error of the loop and nothing else: change the filter and the
 *   reference changes with it, which is the only way to keep the arms
 *   comparable.
 *
 * WHAT IT CANNOT TELL YOU
 *   Object motion. The velocity field here is uniform in direction and
 *   magnitude, which is what a pure camera yaw produces -- the case
 *   `fill --look=1` prices, where cameraMovedM is 0 and 66 % of the frame is
 *   blurred by the turn alone. A real yaw's field varies about +-20 % in
 *   magnitude across a wide frame, which is why radius is SWEPT rather than
 *   fixed. What is not modelled is a fast object over a slow background, where
 *   the tile dilation makes the streak longer than the pixel's own motion and
 *   the depth weight has to cut a silhouette. The depth weight IS exercised
 *   here -- the streaks cross the scene's own rooflines, prop edges and
 *   sandbags, and it is evaluated per sample exactly as the shader evaluates it
 *   -- but against a background that is moving with them.
 *
 *   And, as everywhere in this toolchain: nothing in ms, and a flat-shaded
 *   rasteriser. Hard geometric edges on smooth interiors is the hard case for a
 *   filter that has to reconstruct a smear from a handful of taps.
 */
import { renderShot } from './raster.mjs';
import { boxDown, bl, displayEncode, toLuma, sobel, metrics } from './upsim.mjs';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The shader's own dither, line for line. See owIGN in src/render/glsl.js. */
const owIGN = (x, y) => {
  const d = x * 0.06711056 + y * 0.00583715;
  return (52.9829189 * (d - Math.floor(d))) % 1;
};

/**
 * View depth in metres from the rasteriser's NDC z.
 *
 * The raster target stores the interpolated NDC z, not the view depth the blur
 * weights on, and the two are not proportional -- inverting the projection is
 * the whole reason the weight behaves differently near and far. For three's
 * perspective matrix, z_ndc = -e10 + e14 / d, so d = e14 / ( z_ndc + e10 ).
 * Pixels the rasteriser never touched keep Infinity and become 0, which is the
 * value the prepass clears to and therefore the one the shader's `d <= 0.0`
 * test is written against.
 */
function viewDepthFrom(rt, camera) {
  const e = camera.projectionMatrix.elements;
  const n = rt.width * rt.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = rt.depth[i];
    out[i] = z === Infinity ? 0 : e[14] / (z + e[10]);
  }
  return out;
}

/**
 * Box-average a depth buffer down by `f`, in RECIPROCAL space.
 *
 * Not a taste decision: the blur reads its depth out of the TAA resolve's alpha,
 * which holds 1/d and is a LinearFilter target, so a sample between two texels
 * IS a blend of reciprocals on the GPU. Averaging d instead would build a
 * reference whose silhouettes behave the way taa.js went out of its way to stop
 * them behaving -- see the ONE OVER DEPTH note there. Sky stays exactly 0
 * because a zero reciprocal averages to a zero reciprocal.
 */
function invDepthDown(d, w, h, f) {
  const ow = Math.floor(w / f), oh = Math.floor(h / f);
  const out = new Float32Array(ow * oh);
  const inv = 1 / (f * f);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
          const v = d[(y * f + j) * w + x * f + i];
          s += v > 0 ? 1 / v : 0;
        }
      }
      out[y * ow + x] = s * inv;
    }
  }
  return out;
}

/** Bilinear tap of a single-channel image, same half-texel convention as bl(). */
function bl1(img, w, h, u, v) {
  const sx = u * w - 0.5, sy = v * h - 0.5;
  const fx = Math.floor(sx), fy = Math.floor(sy);
  const tx = sx - fx, ty = sy - fy;
  const c = (a, hi) => (a < 0 ? 0 : a > hi ? hi : a);
  const x0 = c(fx, w - 1), x1 = c(fx + 1, w - 1), y0 = c(fy, h - 1), y1 = c(fy + 1, h - 1);
  return img[y0 * w + x0] * (1 - tx) * (1 - ty) + img[y0 * w + x1] * tx * (1 - ty)
    + img[y1 * w + x0] * (1 - tx) * ty + img[y1 * w + x1] * tx * ty;
}

/**
 * The sample positions of one arm, in units of the streak, WITHOUT the centre.
 *
 * `mirror` is the shipped geometry and is deliberately reproduced with its
 * collision intact -- the pairing of a weight with its mirror is part of it, so
 * positions carry their own weight rather than having one derived from where
 * they landed. `comb` is the same count laid down uniformly, which is what the
 * density rule in the shader is written as though it already does.
 *
 * The shutter term is 1 - t * 0.35 on BOTH members of a mirrored pair, so it is
 * not the falloff it reads as: position p gets 0.825 - 0.35p from one arm and
 * 0.825 + 0.35p from the other, and the union is flat. A flat profile over the
 * shutter interval is what a real shutter does, so this reproduces it rather
 * than correcting it -- but it does mean the term cannot be read as a taper,
 * and the comb has to carry the same total weight to stay comparable.
 */
function positions(geometry, taps, jitter) {
  const out = [];
  if (geometry === 'mirror') {
    for (let i = 1; i <= taps; i++) {
      const t = (i + jitter) / taps;
      const w = (1 - t * 0.35);
      out.push([t - 0.5, w], [-(t - 0.5), w]);
    }
  } else {
    const n = 2 * taps;
    for (let i = 0; i < n; i++) {
      // Cell centres of a uniform partition of the shutter interval, dithered
      // by the same jitter, so the comb is stratified rather than merely dense.
      const p = (i + 0.5 + jitter) / n - 0.5;
      out.push([p, 0.825]);
    }
  }
  return out;
}

/**
 * One arm over the whole image.
 *
 * Everything that is not the sample set is the shader's, line for line: the
 * centre seeded at weight 1, the reciprocal read and its `d <= 0.0 -> 1e5`
 * guard, the smoothstep over the depth RATIO, the 0.15 floor, and the skip on a
 * sample that leaves the unit square. Same in the reference, so all of it
 * cancels and what is left is the sampling.
 */
function blurArm(src, invD, velUv, taps, geometry, out) {
  const { w, h } = src;
  const c0 = [0, 0, 0], cs = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, d3 = i * 3;
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      c0[0] = src.c[d3]; c0[1] = src.c[d3 + 1]; c0[2] = src.c[d3 + 2];

      const ia = invD[i];
      let centreDepth = ia > 0 ? 1 / ia : 0;
      if (centreDepth <= 0) centreDepth = 1e5;

      const jitter = owIGN(x + 0.5, y + 0.5) - 0.5;
      const pts = positions(geometry, taps, jitter);

      let r = c0[0], g = c0[1], b = c0[2], wsum = 1;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k][0];
        const su = u + velUv[0] * p, sv = v + velUv[1] * p;
        if (su < 0 || su > 1 || sv < 0 || sv > 1) continue;
        bl(src, su, sv, cs);
        const a = bl1(invD, w, h, su, sv);
        let dd = a > 0 ? 1 / a : 0;
        if (dd <= 0) dd = 1e5;
        let ww = 1 - smoothstep(0, 1.5, (dd - centreDepth) / Math.max(1, centreDepth));
        ww = (0.15 + 0.85 * clamp01(ww)) * pts[k][1];
        r += cs[0] * ww; g += cs[1] * ww; b += cs[2] * ww; wsum += ww;
      }
      out.c[d3] = r / wsum; out.c[d3 + 1] = g / wsum; out.c[d3 + 2] = b / wsum;
    }
  }
  return out;
}

/** The shader's tap rule with the divisor left open. */
const tapsFor = (radius, div, maxTaps) => Math.min(Math.max(Math.ceil(radius / div), 2), maxTaps);

/**
 * Split an error field into the part a 3x3 box keeps and the part it removes.
 *
 * That is the banding/grain split. Undersampling without a dither leaves a
 * structured residue that survives a local average; the dither trades it for
 * something that does not. Both are error and both are reported -- the point is
 * that they do not look alike, and a candidate that only converts one into the
 * other is not the same as one that adds error.
 */
function splitError(cand, ref, w, h) {
  const n = w * h;
  const el = new Float32Array(n);
  const lc = toLuma(cand), lr = toLuma(ref);
  for (let i = 0; i < n; i++) el[i] = lc[i] - lr[i];
  let sSmooth = 0, sGrain = 0, sAbs = 0, mx = 0;
  const abs = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j; if (yy < 0 || yy >= h) continue;
        for (let i2 = -1; i2 <= 1; i2++) {
          const xx = x + i2; if (xx < 0 || xx >= w) continue;
          s += el[yy * w + xx]; c++;
        }
      }
      const m = s / c, e = el[y * w + x];
      sSmooth += m * m; sGrain += (e - m) * (e - m);
      const a = Math.abs(e); sAbs += a; abs[y * w + x] = a; if (a > mx) mx = a;
    }
  }
  abs.sort();
  return {
    bandingCodeValues: +(255 * Math.sqrt(sSmooth / n)).toFixed(4),
    grainCodeValues: +(255 * Math.sqrt(sGrain / n)).toFixed(4),
    meanAbsCodeValues: +(255 * sAbs / n).toFixed(4),
    p99AbsCodeValues: +(255 * abs[Math.min(n - 1, Math.floor(0.99 * n))]).toFixed(3),
    maxAbsCodeValues: +(255 * mx).toFixed(3),
  };
}

/**
 * @param engine  a booted engine, already stepped to the frame under test
 * @param W,H     the grid the blur is evaluated on
 * @param ss      supersample factor for the SOURCE image only -- the blur's
 *                input is a TAA resolve, so an aliased source would charge every
 *                arm for the rasteriser's edges instead of its own sampling
 * @param radii   streak lengths in pixels to sweep
 * @param divs    tap-rule divisors; 2 is what ships
 * @param dirDeg  streak direction; 0 is horizontal, which is what a yaw gives
 * @param refTaps half the reference sample count
 */
export function measureMotionBlur(engine, opts = {}) {
  const {
    W = 480, H = 310, ss = 3, pre = 0.5, dirDeg = 0, refTaps = 128, maxTaps = 12,
    radii = [4, 8, 11.4, 16, 24, 40],
    divs = [2, 2.5, 3, 4],
  } = opts;

  const hi = renderShot(engine, { width: W * ss, height: H * ss });
  const src = boxDown({ w: W * ss, h: H * ss, c: hi.rt.color }, ss);
  const dHi = viewDepthFrom(hi.rt, engine.camera);
  const invD = invDepthDown(dHi, W * ss, H * ss, ss);

  // Same normalisation as the other sims: put the 90th-percentile luma of the
  // shaded pixels at `pre`, ONCE, and apply the same factor to everything. The
  // depth weight is a ratio and does not care, but displayEncode's tone curve
  // does, and a per-image exposure would score each arm against a differently
  // graded reference.
  {
    const l = [];
    for (let i = 0; i < W * H; i++) {
      if (invD[i] > 0) l.push(lum(src.c[i * 3], src.c[i * 3 + 1], src.c[i * 3 + 2]));
    }
    l.sort((a, b) => a - b);
    const p90 = l.length ? l[Math.floor(0.9 * (l.length - 1))] : 1;
    const k = p90 > 1e-6 ? pre / p90 : 1;
    for (let i = 0; i < src.c.length; i++) src.c[i] *= k;
  }

  const th = (dirDeg * Math.PI) / 180;
  const dir = [Math.cos(th), Math.sin(th)];
  const mk = () => ({ w: W, h: H, c: new Float32Array(W * H * 3) });
  const ref = mk(), cand = mk();

  const rows = [];
  for (const radius of radii) {
    // The streak in UV. `positions` spans -0.5..0.5, so the span it multiplies
    // is the full streak and not a half of it.
    const velUv = [dir[0] * radius / W, dir[1] * radius / H];

    blurArm(src, invD, velUv, refTaps, 'comb', ref);
    const refD = displayEncode(ref);
    const refEdge = sobel(toLuma(refD), W, H);
    let refEdgeSum = 0;
    for (let i = 0; i < W * H; i++) refEdgeSum += refEdge[i];

    const arms = [];
    for (const geometry of ['mirror', 'comb']) {
      for (const div of divs) {
        const taps = tapsFor(radius, div, maxTaps);
        blurArm(src, invD, velUv, taps, geometry, cand);
        const candD = displayEncode(cand);
        arms.push({
          geometry,
          div,
          taps,
          fetches: 2 * taps,
          samplesPerPixel: +((2 * taps) / radius).toFixed(3),
          shipped: geometry === 'mirror' && div === 2,
          ...metrics(candD, refD, refEdge, refEdgeSum),
          ...splitError(candD, refD, W, H),
        });
      }
    }
    rows.push({ radiusPx: radius, arms });
  }

  return {
    note: 'Sampling error of the ow-mb inner loop against the same filter at '
      + `${2 * refTaps} uniform samples. Uniform velocity field, ${dirDeg} deg, which is what a `
      + 'pure camera yaw produces -- the case fill --look=1 prices. banding is the part of '
      + 'the luma error a 3x3 box keeps, grain the part it removes; the shader dithers, so it '
      + 'is already trading the first for the second, and the split is the thing to read.',
    grid: `${W}x${H}`,
    supersample: ss,
    referenceSamples: 2 * refTaps,
    maxTaps,
    shippedRule: 'taps = clamp( ceil( radius / 2 ), 2, OW_MB_TAPS ), 2 fetches per tap',
    rows,
  };
}

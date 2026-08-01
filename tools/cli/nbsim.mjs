/**
 * nbsim — what TAA's 3x3 variance neighbourhood costs, and what the frame loses
 * if the four corners of it go.
 *
 * WHY THIS EXISTS
 *   After the Catmull-Rom lobe tier, `ow-taa` is 61.1 M of 340.2 M fetches at
 *   18.0 real fetches per fragment, and the single largest block inside it is
 *   the neighbourhood: EIGHT of those eighteen. (The loop is nine taps, but
 *   i == 4 is the centre and was substituted years ago with the value already
 *   held.) Dropping to a five-tap plus -- centre and the four edge neighbours --
 *   is four fetches per on-screen pixel, about 13.1 M, 3.9 % of the whole
 *   chain. Nothing else left in the frame is that size.
 *
 * WHAT THE NEIGHBOURHOOD IS FOR, so that the right thing gets measured
 *   It builds a colour box in YCoCg from the CURRENT frame and clips the
 *   reprojected history into it. The box does two jobs at once and they pull in
 *   opposite directions:
 *     too WIDE   history that no longer belongs survives -> ghosting.
 *     too NARROW good history is rejected -> the accumulation never converges,
 *                which shows up as residual aliasing and as shimmer.
 *   Removing the corners can only make the min/max half of the box NARROWER --
 *   a subset has a higher min and a lower max -- so the ghosting side cannot get
 *   worse from that half. It is the second job that is at risk, and it is the
 *   one this measures. The mean/sigma half is NOT monotone in the same way, so
 *   containment is counted per pixel and per channel here rather than assumed.
 *
 * THE EXPERIMENT
 *   The camera is held still and only the TAA jitter moves, which is the
 *   cleanest possible isolation: with no camera motion the history reprojects
 *   to its own texel, `sampleCatmullRom` degenerates to the centre tap exactly
 *   (f = 0 on both axes), and NOTHING in the pass differs between the arms
 *   except the box. A static jittered accumulation is also the case where the
 *   clamp is purely a cost -- there is no stale history for it to catch -- so
 *   the number that comes out is the price, uncontaminated by the benefit.
 *
 *   truth      the same view rendered at ss x display and box-filtered down.
 *              That is what an infinite jittered accumulation converges to, so
 *              it is what the accumulator is trying to be.
 *   arms       the shipped 3x3, the five-tap plus, and NO CLAMP AT ALL.
 *
 *   THE UNCLAMPED ARM IS THE ANCHOR AND IT IS THE POINT OF THE WHOLE FILE. It
 *   converges to the supersampled truth by construction, so the gap between it
 *   and the shipped 3x3 is the ENTIRE price the clamp already charges on this
 *   frame. A change that moves the shipped arm a small fraction of that gap is
 *   a change inside the accuracy the pass already accepts; one that moves it a
 *   multiple of it is not, whatever its PSNR looks like in isolation.
 *
 * WHAT IT CANNOT TELL YOU
 *   Ghosting. A still camera and a still scene present the clamp with nothing
 *   to reject, which is deliberate -- see above -- but it does mean the benefit
 *   side is out of frame here and rests on the containment count instead.
 *   And, as everywhere in this toolchain, nothing in ms, and a flat-shaded
 *   rasteriser with hard geometric edges on smooth interiors: the hard case for
 *   a reconstruction filter and the easy one for a colour box.
 */
import { Vector3 } from 'three';
import { renderShot } from './raster.mjs';
import { boxDown, displayEncode, toLuma, sobel, metrics } from './upsim.mjs';

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The engine's own Halton (2,3) jitter table, from src/render/taa.js. */
const HALTON = (() => {
  const h = (i, b) => {
    let f = 1, r = 0;
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
    return r;
  };
  const out = [];
  for (let i = 1; i <= 16; i++) out.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
  return out;
})();

// The pass's own colour transforms, line for line.
const owLum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const tonemapW = (c, o) => {
  const k = 1 / (1 + owLum(c[0], c[1], c[2]));
  o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k;
};
const tonemapWInv = (c, o) => {
  const k = 1 / Math.max(1e-4, 1 - owLum(c[0], c[1], c[2]));
  o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k;
};
const rgbToYCoCg = (c, o) => {
  const y = 0.25 * c[0] + 0.5 * c[1] + 0.25 * c[2];
  const co = 0.5 * c[0] - 0.5 * c[2];
  const cg = -0.25 * c[0] + 0.5 * c[1] - 0.25 * c[2];
  o[0] = y; o[1] = co; o[2] = cg;
};
const yCoCgToRgb = (c, o) => {
  const t = c[0] - c[2];
  o[0] = t + c[1]; o[1] = c[0] + c[2]; o[2] = t - c[1];
};

/**
 * The offsets of each arm's neighbourhood, in texels, WITHOUT the centre.
 *
 * The centre is not in these lists because it is not a fetch: the shipped loop
 * substitutes the value already held at i == 4, so the count here IS the fetch
 * count of the arm.
 */
const PLUS = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const CORNERS = [[-1, -1], [1, 1], [1, -1], [-1, 1]];   // the two diagonals, in pairs
const PATTERNS = {
  x9: [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  x5: PLUS,
  // The plus plus ONE diagonal, swapped every frame. TAA already dithers per
  // frame -- the jitter, GTAO's noise, the volumetric march's step offset -- so
  // a box that sees the other diagonal next frame is the same kind of trade the
  // pass makes everywhere else, and the accumulator is the thing that resolves
  // it. 6 fetches instead of 8.
  x7rot: (k) => PLUS.concat(k % 2 === 0 ? CORNERS.slice(0, 2) : CORNERS.slice(2)),
  // One corner, cycling through all four. 5 fetches.
  x6rot: (k) => PLUS.concat([CORNERS[k % 4]]),
};

/** Nearest texel of a float image, clamped at the border as the sampler is. */
function at(img, x, y, o) {
  const xx = x < 0 ? 0 : x > img.w - 1 ? img.w - 1 : x;
  const yy = y < 0 ? 0 : y > img.h - 1 ? img.h - 1 : y;
  const s = (yy * img.w + xx) * 3;
  o[0] = img.c[s]; o[1] = img.c[s + 1]; o[2] = img.c[s + 2];
}

/**
 * One frame of the resolve, for one arm, over the whole image.
 *
 * `pattern` null means the unclamped anchor: the history is blended in with no
 * box at all, which is the accumulation the jitter sequence is designed to
 * produce and therefore the thing the box is charged against.
 *
 * Everything that is not the box is held identical across arms ON PURPOSE:
 * `dynamic` is 0 because a still camera on static geometry has full coverage
 * everywhere the rasteriser shades, `speed` is 0 because the camera does not
 * move, and both feed the SAME gamma and the SAME feedback cap into every arm.
 */
function resolve(cur, hist, out, pattern, gamma, feedback0, stats) {
  const { w, h } = cur;
  const t = [0, 0, 0], tm = [0, 0, 0], curY = [0, 0, 0], hy = [0, 0, 0];
  const m1 = [0, 0, 0], m2 = [0, 0, 0], nmin = [0, 0, 0], nmax = [0, 0, 0];
  const lo = [0, 0, 0], hi = [0, 0, 0], clipped = [0, 0, 0], outY = [0, 0, 0], rgb = [0, 0, 0];
  const taps = pattern ? pattern.length + 1 : 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, d = i * 3;
      t[0] = cur.c[d]; t[1] = cur.c[d + 1]; t[2] = cur.c[d + 2];
      tonemapW(t, tm); rgbToYCoCg(tm, curY);

      let clipT = 1;
      for (let k = 0; k < 3; k++) clipped[k] = 0;
      t[0] = hist.c[d]; t[1] = hist.c[d + 1]; t[2] = hist.c[d + 2];
      tonemapW(t, tm); rgbToYCoCg(tm, hy);

      if (pattern) {
        for (let k = 0; k < 3; k++) {
          m1[k] = curY[k]; m2[k] = curY[k] * curY[k]; nmin[k] = curY[k]; nmax[k] = curY[k];
        }
        for (let p = 0; p < pattern.length; p++) {
          at(cur, x + pattern[p][0], y + pattern[p][1], t);
          tonemapW(t, tm); rgbToYCoCg(tm, rgb);
          for (let k = 0; k < 3; k++) {
            m1[k] += rgb[k]; m2[k] += rgb[k] * rgb[k];
            if (rgb[k] < nmin[k]) nmin[k] = rgb[k];
            if (rgb[k] > nmax[k]) nmax[k] = rgb[k];
          }
        }
        let tMin = 1;
        for (let k = 0; k < 3; k++) {
          const mean = m1[k] / taps;
          const sigma = Math.sqrt(Math.max(m2[k] / taps - mean * mean, 0));
          lo[k] = Math.max(mean - gamma * sigma, nmin[k]);
          hi[k] = Math.min(mean + gamma * sigma, nmax[k]);
          const centre = 0.5 * (lo[k] + hi[k]);
          const extent = 0.5 * (hi[k] - lo[k]) + 1e-5;
          const dir = hy[k] - centre;
          const ts = Math.abs(extent / Math.max(Math.abs(dir), 1e-5));
          if (ts < tMin) tMin = ts;
          clipped[k] = centre; outY[k] = dir;   // finish once tMin is known
        }
        clipT = tMin < 0 ? 0 : tMin > 1 ? 1 : tMin;
        for (let k = 0; k < 3; k++) clipped[k] += outY[k] * clipT;
        if (stats) {
          stats.clipSum += clipT;
          if (clipT < 0.999) stats.clipped++;
          stats.n++;
          for (let k = 0; k < 3; k++) { stats.lo[i * 3 + k] = lo[k]; stats.hi[i * 3 + k] = hi[k]; }
        }
      } else {
        for (let k = 0; k < 3; k++) clipped[k] = hy[k];
      }

      // heavy clipping means we were rejecting: shorten the tail. Identical
      // line to the shader, and it is why a tighter box costs twice -- once by
      // moving the history and once by trusting it less afterwards.
      const feedback = feedback0 * (0.82 + (1 - 0.82) * clipT);
      const wc = 1 / (1 + curY[0]);
      const wh = 1 / (1 + clipped[0]);
      const sum = wc + (wh - wc) * feedback;
      const inv = 1 / Math.max(sum, 1e-5);
      for (let k = 0; k < 3; k++) {
        outY[k] = (curY[k] * wc * (1 - feedback) + clipped[k] * wh * feedback) * inv;
      }
      yCoCgToRgb(outY, rgb); tonemapWInv(rgb, t);
      out.c[d] = Math.max(0, t[0]); out.c[d + 1] = Math.max(0, t[1]); out.c[d + 2] = Math.max(0, t[2]);
    }
  }
}

/** Render one jittered frame at the display grid, then put the camera back. */
function shotJittered(engine, W, H, jx, jy) {
  const cam = engine.camera;
  const e = cam.projectionMatrix.elements;
  const sx = e[8], sy = e[9];
  e[8] += (jx * 2) / W; e[9] += (jy * 2) / H;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  const r = renderShot(engine, { width: W, height: H });
  e[8] = sx; e[9] = sy;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  return { w: W, h: H, c: r.rt.color };
}

/**
 * Slide the camera sideways by `d` metres and return an undo.
 *
 * This is the ghost generator. Half way through the sequence the content under
 * every pixel changes while the history keeps pointing at its own texel -- no
 * reprojection, exactly as a still camera resolves -- so every pixel is handed
 * history that no longer belongs to it. That is the disocclusion case the
 * colour box exists for, produced without needing a velocity field, and it is
 * the half of the trade the convergence test above cannot see.
 */
function slideCamera(engine, d) {
  const cam = engine.camera;
  const before = cam.position.clone();
  const right = new Vector3(
    cam.matrixWorld.elements[0], cam.matrixWorld.elements[1], cam.matrixWorld.elements[2],
  ).normalize();
  cam.position.addScaledVector(right, d);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return () => {
    cam.position.copy(before);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  };
}

export function measureNeighbourhood(engine, opts = {}) {
  const {
    W = 640, H = 416, ss = 3, frames = 32, pre = 0.5,
    gamma = 1.25, feedback = 0.92, gammas = [], stepM = 0.35,
  } = opts;

  // ---- truth: the converged supersample -----------------------------------
  const hiRaw = renderShot(engine, { width: W * ss, height: H * ss });
  const truth0 = boxDown({ w: W * ss, h: H * ss, c: hiRaw.rt.color }, ss);

  // Same normalisation as upsim/crsim: put the 90th-percentile luma at `pre` so
  // displayEncode's tone curve lands where it lands on GPU rather than wherever
  // the flat shader happened to emit. Applied to EVERY image with the SAME
  // factor, so it cannot move one arm relative to another.
  const lums = new Float64Array(truth0.w * truth0.h);
  for (let i = 0; i < lums.length; i++) {
    lums[i] = lum(truth0.c[i * 3], truth0.c[i * 3 + 1], truth0.c[i * 3 + 2]);
  }
  const sorted = Array.from(lums).sort((a, b) => a - b);
  const norm = pre / (sorted[Math.floor(sorted.length * 0.9)] || 1);
  const scale = (img) => {
    const c = new Float32Array(img.c.length);
    for (let i = 0; i < c.length; i++) c[i] = img.c[i] * norm;
    return { w: img.w, h: img.h, c };
  };

  // ---- the jittered sequences, rendered once and shared by every arm -------
  // seqA is the still camera. seqB is the SAME jitter sequence from a camera
  // slid sideways, and it is only used from the step frame on -- see
  // slideCamera for why that produces a ghost without a velocity field.
  const shoot = () => {
    const out = [];
    for (let k = 0; k < frames; k++) {
      const j = HALTON[k % HALTON.length];
      out.push(scale(shotJittered(engine, W, H, j[0], j[1])));
    }
    return out;
  };
  const seqA = shoot();
  const truthA = scale(truth0);

  const stepAt = stepM > 0 ? Math.floor(frames / 2) : 0;
  let seqB = null, truthB = null;
  if (stepAt > 0) {
    const undo = slideCamera(engine, stepM);
    const hiB = renderShot(engine, { width: W * ss, height: H * ss });
    truthB = scale(boxDown({ w: W * ss, h: H * ss, c: hiB.rt.color }, ss));
    seqB = shoot();
    undo();
  }

  const n = W * H;
  const mk = () => ({ w: W, h: H, c: new Float32Array(n * 3) });
  const arms = [
    { label: 'no clamp (converged anchor)', pattern: null, fetches: 0, gamma },
    { label: '3x3 (shipped, 8 fetches)', pattern: PATTERNS.x9, fetches: 8, gamma },
    { label: '5-tap plus (4 fetches)', pattern: PATTERNS.x5, fetches: 4, gamma },
    { label: 'plus + 1 diagonal, rotating (6 fetches)', pattern: PATTERNS.x7rot, fetches: 6, gamma },
    { label: 'plus + 1 corner, rotating (5 fetches)', pattern: PATTERNS.x6rot, fetches: 5, gamma },
    ...gammas.map((g) => ({
      label: `5-tap plus, gamma ${g} (4 fetches)`, pattern: PATTERNS.x5, fetches: 4, gamma: g,
    })),
  ];

  /**
   * Run one arm over one sequence and hand back the converged frame.
   *
   * `curve` collects the error against `truthCurve` at every frame after the
   * step, which is the ghost decay -- a single end-of-run number cannot tell a
   * box that rejected the stale history immediately from one that took eight
   * frames to grind it out, and those are different pictures to look at.
   */
  const runArm = (a, sequence, stepFrom, truthCurve) => {
    let hist = sequence[0];
    const buf = [mk(), mk()];
    const st = a.pattern
      ? { clipSum: 0, clipped: 0, n: 0, lo: new Float32Array(n * 3), hi: new Float32Array(n * 3) }
      : null;
    const curve = [];
    for (let k = 1; k < frames; k++) {
      // Only the LAST frame's clip statistics are kept: the question is about
      // the converged state, and the first frames are the transient.
      if (st && k === frames - 1) { st.clipSum = 0; st.clipped = 0; st.n = 0; }
      const out = buf[k % 2];
      // A pattern may be a function of the frame index: that is the rotating
      // corner arms, and it is the only place the arms differ per frame.
      const pat = typeof a.pattern === 'function' ? a.pattern(k) : a.pattern;
      resolve(sequence[k], hist, out, pat, a.gamma, feedback, st);
      hist = out;
      if (truthCurve && k >= stepFrom) curve.push(meanAbs(out, truthCurve));
    }
    return { img: hist, st, curve };
  };

  const meanAbs = (a, b) => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let dm = 0;
      for (let k = 0; k < 3; k++) dm = Math.max(dm, Math.abs(a.c[i * 3 + k] - b.c[i * 3 + k]));
      sum += dm;
    }
    return +(255 * sum / n).toFixed(3);
  };

  // ---- study 1: what the box costs on a converging accumulation -----------
  const conv = arms.map((a) => runArm(a, seqA, frames, null));

  const truthD = displayEncode(truthA);
  const refEdge = sobel(toLuma(truthD), W, H);
  let refEdgeSum = 0;
  for (let i = 0; i < refEdge.length; i++) refEdgeSum += refEdge[i];

  const encoded = conv.map((r) => displayEncode(r.img));
  const vs = (a, b) => {
    let sum = 0, mx = 0, over1 = 0;
    for (let i = 0; i < n; i++) {
      let dm = 0;
      for (let k = 0; k < 3; k++) dm = Math.max(dm, Math.abs(a.c[i * 3 + k] - b.c[i * 3 + k]));
      sum += dm; if (dm > mx) mx = dm;
      if (dm * 255 > 1) over1++;
    }
    return {
      meanCodeValues: +(255 * sum / n).toFixed(4),
      maxCodeValues: +(255 * mx).toFixed(3),
      pctOverOneCodeValue: +(100 * over1 / n).toFixed(3),
    };
  };

  // ---- study 2: what the box catches when the history is stale ------------
  let ghostRows = null;
  if (stepAt > 0) {
    const mixed = seqA.slice(0, stepAt).concat(seqB.slice(stepAt));
    const truthBD = displayEncode(truthB);
    const edgeB = sobel(toLuma(truthBD), W, H);
    let edgeBSum = 0;
    for (let i = 0; i < edgeB.length; i++) edgeBSum += edgeB[i];
    ghostRows = arms.map((a) => {
      const r = runArm(a, mixed, stepAt, truthB);
      return {
        label: a.label,
        ...metrics(displayEncode(r.img), truthBD, edgeB, edgeBSum),
        errorAfterStepCodeValues: r.curve,
      };
    });
  }

  const rows = conv.map((r, i) => ({
    label: arms[i].label,
    fetchesPerPixel: arms[i].fetches,
    gamma: arms[i].gamma,
    ...metrics(encoded[i], truthD, refEdge, refEdgeSum),
    vsUnclamped: vs(encoded[i], encoded[0]),
    vsShipped: vs(encoded[i], encoded[1]),
    meanClipT: r.st ? +(r.st.clipSum / Math.max(1, r.st.n)).toFixed(5) : null,
    pctPixelsClipped: r.st ? +(100 * r.st.clipped / Math.max(1, r.st.n)).toFixed(3) : null,
  }));

  // ---- is each candidate box actually INSIDE the 3x3 box? -----------------
  // The min/max half of it must be, by subset. The mean +- gamma*sigma half
  // need not, and that is exactly the way this change could widen the box and
  // let a ghost through -- so it is counted rather than argued.
  const b9 = conv[1].st;
  const containment = conv.map((r, i) => {
    if (i < 2 || !r.st) return null;
    let wider = 0, widerBy = 0;
    for (let j = 0; j < n * 3; j++) {
      if (r.st.lo[j] < b9.lo[j] || r.st.hi[j] > b9.hi[j]) {
        wider++;
        widerBy = Math.max(widerBy, Math.max(b9.lo[j] - r.st.lo[j], r.st.hi[j] - b9.hi[j]));
      }
    }
    return {
      label: arms[i].label,
      pctChannelsWiderThan3x3: +(100 * wider / (n * 3)).toFixed(4),
      maxExcursionYCoCg: +widerBy.toFixed(6),
    };
  }).filter(Boolean);

  return {
    note: 'Two studies on the same arms. CONVERGENCE: a still camera with only the TAA '
      + 'jitter moving, scored against the supersampled render the accumulation converges '
      + 'to -- the unclamped arm is the anchor, and the gap between it and the shipped 3x3 '
      + 'is the whole price the colour box already charges. GHOST: the same sequence with '
      + 'the camera slid sideways half way through and NO reprojection, so every pixel is '
      + 'handed history that no longer belongs to it -- which is what the box is for.',
    grid: `${W}x${H}`, supersample: ss, frames, gamma, feedback,
    ghostStep: stepAt > 0 ? { atFrame: stepAt, cameraSlideM: stepM } : null,
    convergence: rows,
    ghost: ghostRows,
    boxContainment: {
      note: 'Channels where a candidate box reaches OUTSIDE the 3x3 box. The min/max half '
        + 'cannot -- a subset has a higher min and a lower max -- so anything here is the '
        + 'mean +- gamma*sigma half, and it is the only way this change could admit a ghost '
        + 'the shipped filter rejects.',
      arms: containment,
    },
  };
}

const QUERY_SLOTS = 5;
const SAMPLE_COUNT = 48;
const SCALE_FACTORS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
/**
 * Anything above this is a stall, not a frame: a tab wake-up, a GC pause, a
 * shader compile. Samples are CLAMPED to it rather than dropped — see `sample()`.
 */
const STALL_MS = 2000;
/**
 * How many wall-clock frame intervals back the GPU-timer ceiling looks. A query
 * result surfaces up to QUERY_SLOTS frames after the frame it measured, so the
 * ceiling has to cover at least that many; the MAX over the window (not the
 * mean) means one spuriously short interval — a double rAF, a resize frame —
 * cannot pull the ceiling down under an honest reading.
 */
const FRAME_WINDOW = 8;

/**
 * Non-blocking whole-frame GPU timer. Results arrive a few frames late; no
 * readback ever waits for the GPU. Unsupported/privacy-hardened browsers simply
 * fall back to frame-time based scaling.
 */
export class GpuFrameTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.slots = [];
    this.cursor = 0;
    this.active = -1;
    this.value = 0;
    this.sequence = 0;

    if (this.ext) {
      for (let i = 0; i < QUERY_SLOTS; i++) {
        this.slots.push({ query: this.gl.createQuery(), pending: false });
      }
    }
  }

  get supported() {
    return this.ext !== null;
  }

  /** Poll completed queries without stalling. */
  poll() {
    if (!this.ext) return 0;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.pending || !gl.getQueryParameter(slot.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(slot.query, gl.QUERY_RESULT);
      slot.pending = false;
      if (!disjoint && Number.isFinite(ns) && ns > 0) {
        this.value = ns / 1e6;
        this.sequence++;
      }
    }
    return this.value;
  }

  begin() {
    if (!this.ext || this.active >= 0) return false;
    this.poll();
    for (let n = 0; n < this.slots.length; n++) {
      const i = (this.cursor + n) % this.slots.length;
      if (this.slots[i].pending) continue;
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.slots[i].query);
      this.active = i;
      this.cursor = (i + 1) % this.slots.length;
      return true;
    }
    return false;
  }

  end() {
    if (!this.ext || this.active < 0) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.slots[this.active].pending = true;
    this.active = -1;
  }

  dispose() {
    if (this.active >= 0) {
      try { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); } catch { /* context lost */ }
      this.active = -1;
    }
    for (let i = 0; i < this.slots.length; i++) this.gl.deleteQuery(this.slots[i].query);
    this.slots.length = 0;
  }
}

/**
 * Hysteretic dynamic-resolution controller. It uses a percentile window rather
 * than a single frame, so shader compilation, GC, tab wake-up and one expensive
 * explosion cannot make every render target resize.
 */
export class AdaptiveResolution {
  constructor({ maxScale = 1, minScale = 0.6, targetFps = 60, enabled = true } = {}) {
    this.enabled = enabled;
    this.targetMs = 1000 / Math.max(30, Math.min(240, targetFps));
    this.scales = [];
    for (let i = 0; i < SCALE_FACTORS.length; i++) {
      const s = Math.max(minScale, maxScale * SCALE_FACTORS[i]);
      if (!this.scales.length || Math.abs(s - this.scales[this.scales.length - 1]) > 0.005) {
        this.scales.push(s);
      }
      if (s <= minScale + 0.005) break;
    }
    if (this.scales[this.scales.length - 1] > minScale + 0.005) this.scales.push(minScale);

    this.index = 0;
    this.scale = this.scales[0];
    this.samples = new Float32Array(SAMPLE_COUNT);
    this.sorted = new Float32Array(SAMPLE_COUNT);
    this.head = 0;
    this.count = 0;
    this.sinceEval = 0;
    this.hold = SAMPLE_COUNT * 2;
    this.overWindows = 0;
    this.underWindows = 0;
    this.p50 = 0;
    this.p90 = 0;
    this.changes = 0;
    this.source = 'frame';
    // Wall-clock frame intervals, fed by `observeFrame()`; the ceiling for
    // GPU-timer readings is derived from them. See `gpuCapMs`.
    // Float64: a Float32 round-trip makes the ceiling land a few ULP below an
    // identical double, so an honest timer would be "clamped" every frame by an
    // epsilon and `clampedSamples` would report a bug that isn't there.
    this.frameMs = new Float64Array(FRAME_WINDOW);
    this.frameHead = 0;
    this.frameCount = 0;
    this.lastGpuMs = 0;
    this.lastGpuRawMs = 0;
    this.clampedSamples = 0;
  }

  /**
   * Record the wall-clock interval of one frame. Must be called EVERY frame,
   * not only on the frames where a GPU query happens to resolve, or the window
   * below stops describing the frames the pending queries belong to.
   *
   * Pass a real clock difference. `ctx.time.dt` is the wrong source twice over:
   * the engine clamps it to 100 ms (so it understates every frame slower than
   * 10 fps) and multiplies it by the time scale (so slow motion would report a
   * 3 ms frame and license a scale-up that the hardware cannot pay for).
   */
  observeFrame(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.frameMs[this.frameHead] = Math.min(ms, STALL_MS);
    this.frameHead = (this.frameHead + 1) % FRAME_WINDOW;
    if (this.frameCount < FRAME_WINDOW) this.frameCount++;
  }

  /**
   * The largest value a GPU-timer reading can honestly take. Whole-frame GPU
   * work cannot outlast the frame that submitted it: if the GPU really needs
   * 480 ms, frames really do arrive 480 ms apart, and this ceiling is an
   * identity. It only bites when the timer disagrees with the clock — MEASURED
   * at ultra on an M5, every query returned 480-1050 ms while the game ran at
   * 10 fps, i.e. 100 ms frames, so the timer overstated by 5-10x. Acting on
   * that number costs image quality and buys nothing, because the work it
   * claims to have found is not there to remove.
   *
   * `Infinity` until the window has filled, so a cold start is never throttled
   * by a ceiling built from two frames.
   */
  get gpuCapMs() {
    if (this.frameCount < FRAME_WINDOW) return Infinity;
    let m = 0;
    for (let i = 0; i < FRAME_WINDOW; i++) if (this.frameMs[i] > m) m = this.frameMs[i];
    // Headroom, deliberately generous: GPU work can spill a hair past the frame
    // that submitted it and the clock is quantised, so a reading a few percent
    // over the interval is ordinary and must pass through untouched. The case
    // this exists for overstates by 500-1000%, which 5% + 1 ms does not hide.
    return m * 1.05 + 1;
  }

  /** Add one GPU-timer reading, held to what the wall clock says is possible. */
  sampleGpu(ms) {
    const cap = this.gpuCapMs;
    const capped = Math.min(ms, cap);
    this.lastGpuRawMs = ms;
    this.lastGpuMs = capped;
    if (capped < ms) this.clampedSamples++;
    return this.sample(capped, 'gpu');
  }

  reset(hold = SAMPLE_COUNT * 2) {
    this.head = 0;
    this.count = 0;
    this.sinceEval = 0;
    this.hold = hold;
    this.overWindows = 0;
    this.underWindows = 0;
  }

  /**
   * Add one GPU or frame-time sample. Returns a new scale only when a resize is
   * justified, otherwise 0.
   *
   * The upper bound CLAMPS, it does not discard. This used to be
   * `ms > 250 && return 0`, which disabled the controller in exactly the case it
   * exists for: MEASURED at ultra on an M5, every GPU frame came back at
   * 480-1050 ms, so every single sample was thrown away, `count` never reached
   * SAMPLE_COUNT, and the scale sat at 1.0 for the whole run while the game ran
   * at 10 fps. A frame that slow is not a measurement error — it is the
   * measurement — and the window is a percentile, so the one genuine outlier a
   * clamp lets through cannot move p50 on its own.
   */
  sample(ms, source = 'gpu') {
    if (!this.enabled || !Number.isFinite(ms) || ms <= 0) return 0;
    this.source = source;
    this.samples[this.head] = Math.min(ms, STALL_MS);
    this.head = (this.head + 1) % SAMPLE_COUNT;
    if (this.count < SAMPLE_COUNT) this.count++;
    if (this.hold > 0) {
      // Spend the hold in TIME, not in frames. 96 frames is 1.6 s of warm-up at
      // 60 fps and ten seconds at 10 fps, so the post-resize settling period
      // grew without bound exactly as the frame rate collapsed. A 100 ms frame
      // burns the hold six times faster than a 16.7 ms one.
      this.hold -= Math.max(1, Math.min(16, ms / 16.7));
      return 0;
    }
    // Evaluate on a partial window once it is at least half full. Waiting for 48
    // samples plus a 24-sample cooldown is 1.2 s at 60 fps but TWELVE SECONDS at
    // 10 fps — the controller was slowest to react precisely when the frame rate
    // most needed it. The percentiles below read the live `count`, not the
    // array length, so a half window is still a percentile and not a mean.
    const minSamples = Math.min(SAMPLE_COUNT, 16);
    const evalEvery = this.count >= SAMPLE_COUNT ? 24 : 8;
    if (this.count < minSamples || ++this.sinceEval < evalEvery) return 0;
    this.sinceEval = 0;

    // Sort only the FILLED span. `sorted.set(samples); sorted.sort()` sorted all
    // 48 slots including the zero-filled tail, so on a partial window every
    // percentile below the fill ratio read back 0 — "infinitely fast" — and the
    // controller would have scaled UP on a stalling frame.
    const n = this.count;
    const sorted = this.sorted;
    for (let i = 0; i < n; i++) sorted[i] = this.samples[i];
    sorted.subarray(0, n).sort();
    this.p50 = sorted[n >> 1];
    this.p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))];

    // GPU timings do not include rAF/vsync waiting, so leave CPU headroom. The
    // frame-time fallback needs a looser limit because a healthy 60 Hz frame is
    // quantised to ~16.7 ms even when rendering itself is much cheaper.
    const high = source === 'gpu' ? this.targetMs * 0.88 : this.targetMs * 1.12;
    const highTail = source === 'gpu' ? this.targetMs * 1.18 : this.targetMs * 1.55;
    const low = source === 'gpu' ? this.targetMs * 0.58 : this.targetMs * 0.72;

    if (this.p50 > high || this.p90 > highTail) {
      this.overWindows++;
      this.underWindows = 0;
    } else if (this.p50 < low && this.p90 < low * 1.25) {
      this.underWindows++;
      this.overWindows = 0;
    } else {
      this.overWindows = 0;
      this.underWindows = 0;
    }

    // Down quickly enough to save playability; recover slowly enough that a
    // camera turn cannot make the image breathe between two scales.
    //
    // The step is PROPORTIONAL when the frame is far past budget. Raster cost is
    // roughly quadratic in scale, so a frame at 4x the target needs about half
    // the linear scale — walking there one 10% step per two windows took 30 s of
    // unplayable frames. `overWindows >= 2` still gates the first move, so a
    // single expensive explosion cannot resize anything.
    let next = this.index;
    if (this.overWindows >= 2 && this.index < this.scales.length - 1) {
      const over = this.p50 / Math.max(1e-3, high);
      // wanted linear scale ~ current / sqrt(over)
      const want = this.scale / Math.sqrt(Math.max(1, over));
      let target = this.index + 1;
      while (target < this.scales.length - 1 && this.scales[target] > want) target++;
      next = target;
    } else if (this.underWindows >= 8 && this.index > 0) {
      next--;
    }
    if (next === this.index) return 0;

    this.index = next;
    this.scale = this.scales[next];
    this.changes++;
    this.reset(next > 0 ? SAMPLE_COUNT * 2 : SAMPLE_COUNT * 3);
    return this.scale;
  }
}

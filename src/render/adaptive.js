const QUERY_SLOTS = 5;
const SAMPLE_COUNT = 48;
const SCALE_FACTORS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

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
   */
  sample(ms, source = 'gpu') {
    if (!this.enabled || !Number.isFinite(ms) || ms <= 0 || ms > 250) return 0;
    this.source = source;
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % SAMPLE_COUNT;
    if (this.count < SAMPLE_COUNT) this.count++;
    if (this.hold > 0) {
      this.hold--;
      return 0;
    }
    if (this.count < SAMPLE_COUNT || ++this.sinceEval < 24) return 0;
    this.sinceEval = 0;

    this.sorted.set(this.samples);
    this.sorted.sort();
    this.p50 = this.sorted[SAMPLE_COUNT >> 1];
    this.p90 = this.sorted[Math.floor(SAMPLE_COUNT * 0.9)];

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
    let next = this.index;
    if (this.overWindows >= 2 && this.index < this.scales.length - 1) next++;
    else if (this.underWindows >= 8 && this.index > 0) next--;
    if (next === this.index) return 0;

    this.index = next;
    this.scale = this.scales[next];
    this.changes++;
    this.reset(next > 0 ? SAMPLE_COUNT * 2 : SAMPLE_COUNT * 3);
    return this.scale;
  }
}

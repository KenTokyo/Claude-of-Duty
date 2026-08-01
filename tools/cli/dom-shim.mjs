/**
 * Minimal DOM/browser shim so the real game modules can be imported and run
 * inside plain Node, with no browser process anywhere.
 *
 * WHY: measuring this game used to mean launching Chromium. Headless gave
 * untrustworthy numbers (a uniform flip that cannot cost anything measured a
 * 109.8 ms spread) and headed opens a real 3024x1964 window running flat out
 * with vsync disabled, which is hard on the machine and has killed the GPU
 * process outright. Neither is acceptable here.
 *
 * So we boot the ACTUAL engine -- same Engine, same systems, same config, same
 * world generation -- against a recording mock of WebGL2 (see gl-mock.mjs).
 * Everything that is decided on the CPU is then measured for real: draw calls,
 * triangle counts, shader permutations, GL object lifetimes, per-system frame
 * cost and allocation behaviour over long runs.
 *
 * What this deliberately CANNOT do is rasterise. There are no pixels here. Use
 * the draw-stream fingerprint (fingerprint.mjs) for visual regression instead:
 * for a change that is meant to be bit-exact, proving the draw stream and the
 * compiled shader text are identical is a stronger statement than an image diff
 * with a tolerance.
 */

class ClassList {
  constructor() { this._s = new Set(); }
  add(...c) { c.forEach((x) => this._s.add(x)); }
  remove(...c) { c.forEach((x) => this._s.delete(x)); }
  toggle(c, f) { const has = this._s.has(c); const on = f ?? !has; on ? this._s.add(c) : this._s.delete(c); return on; }
  contains(c) { return this._s.has(c); }
}

class Style {
  constructor() { this._p = new Map(); }
  setProperty(k, v) { this._p.set(k, v); }
  getPropertyValue(k) { return this._p.get(k) ?? ''; }
  removeProperty(k) { this._p.delete(k); }
}

let nodeId = 0;

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.id = '';
    this._uid = ++nodeId;
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.style = new Style();
    this.classList = new ClassList();
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this._listeners = new Map();
    this.clientWidth = 1512;
    this.clientHeight = 982;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => typeof c === 'object' && this.appendChild(c)); }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); c.parentNode = this; return c; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k] ?? null; }
  removeAttribute(k) { delete this[k]; }
  hasAttribute(k) { return this[k] !== undefined; }
  addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, new Set()); this._listeners.get(t).add(fn); }
  removeEventListener(t, fn) { this._listeners.get(t)?.delete(fn); }
  dispatchEvent(e) { this._listeners.get(e?.type)?.forEach((fn) => fn(e)); return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  getContext() { return null; }
  focus() {}
  blur() {}
  click() {}
  requestPointerLock() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  animate() { return { cancel() {}, finish() {}, addEventListener() {} }; }
  closest() { return null; }
  scrollTo() {}
}

/** A 2D canvas good enough for the procedural texture generators. */
class Canvas2DContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000'; this.strokeStyle = '#000';
    this.lineWidth = 1; this.globalAlpha = 1; this.globalCompositeOperation = 'source-over';
    this.font = '10px sans-serif'; this.textAlign = 'start'; this.textBaseline = 'alphabetic';
    this.shadowBlur = 0; this.shadowColor = '#000'; this.filter = 'none';
    this.lineCap = 'butt'; this.lineJoin = 'miter'; this.miterLimit = 10;
    this.imageSmoothingEnabled = true;
  }
  save() {} restore() {} beginPath() {} closePath() {} moveTo() {} lineTo() {}
  bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {}
  roundRect() {} fill() {} stroke() {} clip() {} fillRect() {} strokeRect() {} clearRect() {}
  translate() {} rotate() {} scale() {} transform() {} setTransform() {} resetTransform() {}
  fillText() {} strokeText() {} drawImage() {} setLineDash() {} getLineDash() { return []; }
  measureText(t) { return { width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; }
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  createConicGradient() { return { addColorStop() {} }; }
  createPattern() { return {}; }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }; }
  putImageData() {}
}

class Canvas extends El {
  constructor(w = 1512, h = 982) {
    super('canvas');
    this.width = w; this.height = h;
    this._ctx2d = null; this._gl = null;
  }
  getContext(type, attrs) {
    if (type === '2d') return (this._ctx2d ??= new Canvas2DContext(this));
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      // Handed in by install(); the harness decides which recorder to attach.
      return this._gl ?? null;
    }
    return null;
  }
  toDataURL() { return 'data:image/png;base64,'; }
  toBlob(cb) { cb?.(null); }
  transferControlToOffscreen() { return this; }
}

/**
 * Installs the shim onto globalThis. Idempotent.
 * Returns handles the harness needs (the canvas, and the rAF pump).
 */
export function installDom({ width = 1512, height = 982, dpr = 2, search = '' } = {}) {
  if (globalThis.__COD_DOM__) return globalThis.__COD_DOM__;

  const canvas = new Canvas(width, height);
  canvas.id = 'game';

  // --- requestAnimationFrame: driven manually, never by a real clock. ---
  // The harness steps time explicitly so runs are deterministic and repeatable;
  // nothing here is allowed to depend on how fast the host machine happens to be.
  const rafQueue = [];
  let rafId = 0;
  const raf = (fn) => { const id = ++rafId; rafQueue.push({ id, fn }); return id; };
  const cancelRaf = (id) => { const i = rafQueue.findIndex((r) => r.id === id); if (i >= 0) rafQueue.splice(i, 1); };

  /** Run every callback queued for one frame. Returns how many ran. */
  const pumpRaf = (t) => {
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const r of batch) { try { r.fn(t); } catch (e) { globalThis.__COD_DOM__.errors.push(e); } };
    return batch.length;
  };

  const listeners = new Map();
  const documentEl = new El('html');
  const body = new El('body');
  documentEl.appendChild(body);

  const byId = new Map([['game', canvas]]);

  const document = {
    documentElement: documentEl,
    body,
    head: new El('head'),
    hidden: false,
    visibilityState: 'visible',
    pointerLockElement: null,
    fullscreenElement: null,
    activeElement: body,
    readyState: 'complete',
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? new Canvas(width, height) : new El(tag)),
    createElementNS: (_ns, tag) => new El(tag),
    createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
    createDocumentFragment: () => new El('#fragment'),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => (sel === '#game' || sel === 'canvas' ? canvas : null),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener: (t, fn) => { listeners.get(t)?.delete(fn); },
    dispatchEvent: (e) => { listeners.get(e?.type)?.forEach((fn) => fn(e)); return true; },
    exitPointerLock: () => {},
    exitFullscreen: () => Promise.resolve(),
    hasFocus: () => true,
    fonts: { ready: Promise.resolve(), load: () => Promise.resolve([]), add() {}, check: () => true },
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  };

  class ImageShim extends El {
    constructor() { super('img'); this.width = 1; this.height = 1; this.complete = true; }
    set src(v) { this._src = v; queueMicrotask(() => this.dispatchEvent({ type: 'load' })); }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  }

  // `search` stands in for the query string the tools used to pass through a
  // real URL (?q=ultra&adaptive=0&capture=1). Several systems read it directly.
  const qs = search && !search.startsWith('?') ? `?${search}` : search;
  const loc = {
    href: `http://127.0.0.1:8080/${qs}`, search: qs, hash: '', pathname: '/',
    protocol: 'http:', host: '127.0.0.1:8080', hostname: '127.0.0.1', port: '8080', origin: 'http://127.0.0.1:8080',
    reload() {}, replace() {}, assign() {}, toString() { return this.href; },
  };

  const win = {
    document,
    localStorage,
    sessionStorage: localStorage,
    devicePixelRatio: dpr,
    innerWidth: width,
    innerHeight: height,
    outerWidth: width,
    outerHeight: height,
    screen: { width, height, availWidth: width, availHeight: height },
    location: loc,
    navigator: {
      userAgent: 'node-cod-harness',
      platform: 'MacIntel',
      hardwareConcurrency: 10,
      deviceMemory: 16,
      maxTouchPoints: 0,
      gpu: undefined,
      clipboard: { writeText: () => Promise.resolve() },
      sendBeacon: () => true,
    },
    performance: globalThis.performance,
    requestAnimationFrame: raf,
    cancelAnimationFrame: cancelRaf,
    addEventListener: document.addEventListener,
    removeEventListener: document.removeEventListener,
    dispatchEvent: document.dispatchEvent,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '', width: `${width}px`, height: `${height}px` }),
    scrollTo() {},
    alert() {}, confirm: () => true, prompt: () => null,
    close() {}, focus() {}, blur() {},
  };

  const handles = { canvas, window: win, document, pumpRaf, rafQueue, errors: [] };
  globalThis.__COD_DOM__ = handles;

  // Node already defines some of these as getter-only globals (navigator since
  // Node 21). Assigning through Object.assign would throw, so each one is
  // installed defensively and an existing host implementation is left alone.
  const define = (target, props) => {
    for (const [k, v] of Object.entries(props)) {
      try {
        if (Object.getOwnPropertyDescriptor(target, k)?.get) continue; // host owns it
        Object.defineProperty(target, k, { value: v, writable: true, configurable: true, enumerable: false });
      } catch { /* a frozen host global is not worth failing the run over */ }
    }
  };

  define(globalThis, {
    window: win,
    document,
    localStorage,
    sessionStorage: localStorage,
    devicePixelRatio: dpr,
    // The source calls these bare, without a `window.` prefix (21 x
    // addEventListener, 14 x innerWidth, 9 x location.search, ...), so they
    // have to exist as globals and not only as members of `window`.
    location: loc,
    innerWidth: width,
    innerHeight: height,
    outerWidth: width,
    outerHeight: height,
    screen: win.screen,
    self: win,
    top: win,
    parent: win,
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent: win.dispatchEvent,
    history: { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {}, state: null, length: 1 },
    requestAnimationFrame: raf,
    cancelAnimationFrame: cancelRaf,
    Image: ImageShim,
    HTMLCanvasElement: Canvas,
    HTMLElement: El,
    Element: El,
    Node: El,
    Event: class Event { constructor(t, o = {}) { this.type = t; Object.assign(this, o); } },
    CustomEvent: class CustomEvent { constructor(t, o = {}) { this.type = t; this.detail = o.detail; Object.assign(this, o); } },
    KeyboardEvent: class KeyboardEvent { constructor(t, o = {}) { this.type = t; Object.assign(this, o); } },
    MouseEvent: class MouseEvent { constructor(t, o = {}) { this.type = t; Object.assign(this, o); } },
    PointerEvent: class PointerEvent { constructor(t, o = {}) { this.type = t; Object.assign(this, o); } },
    matchMedia: win.matchMedia,
    getComputedStyle: win.getComputedStyle,
    createImageBitmap: (src) => Promise.resolve({ width: src?.width ?? 1, height: src?.height ?? 1, close() {} }),
    OffscreenCanvas: Canvas,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    AudioContext: class { constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; this.sampleRate = 48000; }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createBufferSource() { return { buffer: null, playbackRate: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {}, addEventListener() {} }; }
      createBuffer(c, l, r) { return { numberOfChannels: c, length: l, sampleRate: r, duration: l / r, getChannelData: () => new Float32Array(l) }; }
      createBiquadFilter() { return { type: 'lowpass', frequency: { value: 350, setValueAtTime() {} }, Q: { value: 1 }, gain: { value: 0 }, connect() {}, disconnect() {} }; }
      createDynamicsCompressor() { return { threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 }, attack: { value: 0.003 }, release: { value: 0.25 }, connect() {}, disconnect() {} }; }
      createStereoPanner() { return { pan: { value: 0, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createPanner() { return { connect() {}, disconnect() {}, setPosition() {}, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } }; }
      createConvolver() { return { buffer: null, connect() {}, disconnect() {} }; }
      createOscillator() { return { type: 'sine', frequency: { value: 440, setValueAtTime() {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
      createDelay() { return { delayTime: { value: 0 }, connect() {}, disconnect() {} }; }
      createWaveShaper() { return { curve: null, oversample: 'none', connect() {}, disconnect() {} }; }
      decodeAudioData() { return Promise.resolve(this.createBuffer(2, 1, 48000)); }
      resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { return Promise.resolve(); }
      get listener() { return { positionX: { value: 0 }, forwardX: { value: 0 }, setPosition() {}, setOrientation() {} }; }
    },
  });
  globalThis.webkitAudioContext = globalThis.AudioContext;

  return handles;
}

export { Canvas, El };

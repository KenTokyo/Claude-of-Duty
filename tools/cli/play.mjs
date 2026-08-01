/**
 * play — browserless GAMEPLAY probe.
 *
 * The rest of the CLI measures the renderer. This measures the *game*: does the
 * crouch key actually crouch, does a slide start, does the player die at 0 HP,
 * does health come back, do the enemies move. All of it against the real engine
 * booted in Node (see harness.mjs) — no browser, headless or otherwise.
 *
 * Input is not poked into the movement state machine directly. Every key goes
 * through `Input._onKeyDown` / `_onKeyUp` with a synthetic event object carrying
 * the same modifier flags a browser would send, so the probe sees exactly what a
 * player sees: if the handler drops Ctrl+D, the probe records a key that never
 * arrived AND a browser default that was never prevented. That second half is
 * the only way to catch "the game bookmarked the page" without a browser.
 */

/** Chrome/Edge/Firefox shortcuts a game key can collide with. */
export const BROWSER_SHORTCUTS = [
  ['ctrl', 'KeyD', 'bookmark this page', false],
  ['ctrl', 'KeyW', 'close tab', true],
  ['ctrl', 'KeyT', 'new tab', true],
  ['ctrl', 'KeyN', 'new window', true],
  ['ctrl', 'KeyS', 'save page', false],
  ['ctrl', 'KeyR', 'reload', false],
  ['ctrl', 'KeyF', 'find', false],
  ['ctrl', 'KeyP', 'print', false],
  ['ctrl', 'KeyA', 'select all', false],
  ['ctrl', 'KeyE', 'search from address bar', false],
  ['ctrl', 'KeyG', 'find next', false],
  ['ctrl', 'KeyQ', 'quit browser', true],
  ['ctrl', 'KeyH', 'history', false],
  ['ctrl', 'KeyJ', 'downloads', false],
  ['ctrl', 'KeyU', 'view source', false],
  ['ctrl', 'Digit1', 'switch to tab 1', true],
  ['ctrl', 'Digit2', 'switch to tab 2', true],
  ['ctrl', 'Tab', 'next tab', true],
  ['none', 'Space', 'scroll page', false],
  ['none', 'Tab', 'move focus', false],
  ['none', 'ArrowUp', 'scroll page', false],
  ['none', 'ArrowDown', 'scroll page', false],
  ['none', 'Backspace', 'history back', false],
  // Alt+Left IS cancelable from a page (unlike Ctrl+W), so preventDefault is
  // enough and this does not need the Keyboard Lock API.
  ['alt', 'ArrowLeft', 'history back', false],
  ['shift', 'Space', 'scroll page up', false],
];

/**
 * Drives keys and mouse through the real Input handlers.
 *
 * `held` mirrors physically-held keys so a later event carries `ctrlKey: true`
 * while Ctrl is down, which is the whole reason crouch-and-strafe used to break.
 */
export function makeDriver(engine) {
  const input = engine.input;
  const held = new Set();
  /** Every keydown we sent: did the game take it, did it stop the browser. */
  const keyLog = [];

  const mods = (extra = {}) => ({
    ctrlKey: !!extra.ctrl || held.has('ControlLeft') || held.has('ControlRight'),
    shiftKey: !!extra.shift || held.has('ShiftLeft') || held.has('ShiftRight'),
    altKey: !!extra.alt || held.has('AltLeft'),
    metaKey: !!extra.meta || held.has('MetaLeft'),
  });

  function down(code, extra = {}) {
    let prevented = false;
    const before = input._pendingDown.has(code) || input.down.has(code);
    const ev = {
      code, key: code, repeat: false, ...mods(extra),
      target: engine.canvas,
      preventDefault() { prevented = true; },
      stopPropagation() {},
    };
    input._onKeyDown(ev);
    held.add(code);
    const registered = before || input._pendingDown.has(code) || input.down.has(code);
    keyLog.push({ code, ctrl: ev.ctrlKey, alt: ev.altKey, prevented, registered });
    return { prevented, registered };
  }

  function up(code, extra = {}) {
    held.delete(code);
    const ev = {
      code, key: code, repeat: false, ...mods(extra),
      target: engine.canvas,
      preventDefault() {}, stopPropagation() {},
    };
    input._onKeyUp(ev);
  }

  function mouse(button, kind) {
    const ev = { button, target: engine.canvas, preventDefault() {} };
    if (kind === 'down') input._onMouseDown(ev);
    else input._onMouseUp(ev);
  }

  function look(dx, dy = 0) {
    input._rawLook.x += dx;
    input._rawLook.y += dy;
  }

  function releaseAll() {
    for (const c of [...held]) up(c);
  }

  return { down, up, mouse, look, releaseAll, keyLog, held };
}

/** Put the engine into a playable state: input live, pointer locked, control on. */
export function engagePlay(engine, { populate = false } = {}) {
  engine.input.enabled = true;
  engine.input.frozen = false;
  engine.input.pointerLocked = true;
  engine.ctx.peek('player')?.setControlEnabled?.(true);
  const ai = engine.ctx.peek('ai');
  if (populate && ai && ai.agents.length === 0) {
    ai.forcePopulate = true;
    try { ai.populate(); } catch (err) { console.warn('[play] populate failed', err?.message ?? err); }
  }
  return ai;
}

/** One frame's worth of everything the gameplay tests care about. */
export function sample(engine) {
  const p = engine.ctx.peek('player');
  const m = p?.movement;
  const h = p?.health;
  return {
    frame: engine.time.frame,
    t: +engine.time.elapsed.toFixed(3),
    state: m?.state ?? null,
    stance: m?.stance ?? null,
    stanceWant: m?.stanceWant ?? null,
    sliding: !!m?.sliding,
    sprinting: !!m?.sprinting,
    grounded: !!m?.grounded,
    speed: +(m?.horizontalSpeed ?? 0).toFixed(3),
    eye: +(m ? m.eyeHeight : 0).toFixed(3),
    x: +(m?.position.x ?? 0).toFixed(3),
    y: +(m?.position.y ?? 0).toFixed(3),
    z: +(m?.position.z ?? 0).toFixed(3),
    health: h ? +h.value.toFixed(2) : null,
    dead: !!h?.dead,
    regen: !!h?.regenerating,
    control: !!p?.controlEnabled,
  };
}

export function aiSample(engine) {
  const ai = engine.ctx.peek('ai');
  if (!ai) return [];
  return ai.agents.map((a) => ({
    id: a.id,
    alive: a.alive,
    state: a.state,
    clip: a.clip,
    speed: +(a.speed ?? 0).toFixed(3),
    x: +a.position.x.toFixed(3),
    z: +a.position.z.toFixed(3),
    hasTarget: !!a.hasTarget,
    deadTime: a.deadTime,
    opacity: a.fadeOpacity,
  }));
}

/**
 * Pump `frames` frames, applying a timeline and sampling every frame.
 *
 * timeline: `{ [frame]: (drv, engine) => void }` or an array of
 * `[frame, 'down'|'up', code]` triples.
 */
export function play(engine, rec, {
  frames = 240, stepMs = 1000 / 60, timeline = {}, onFrame = null, trackAi = false,
} = {}) {
  const dom = globalThis.__COD_DOM__;
  const drv = makeDriver(engine);
  const events = typeof timeline === 'function' ? {} : timeline;
  const samples = [];
  const aiSamples = [];
  let now = 1000;

  for (let i = 0; i < frames; i++) {
    rec?.beginFrame();
    now += stepMs;
    const step = Array.isArray(events) ? null : events[i];
    if (step) step(drv, engine, i);
    if (Array.isArray(events)) {
      for (const [f, kind, code] of events) {
        if (f !== i) continue;
        if (kind === 'down') drv.down(code);
        else if (kind === 'up') drv.up(code);
      }
    }
    if (typeof timeline === 'function') timeline(drv, engine, i);
    engine.step(now);
    dom?.pumpRaf(now);
    const s = sample(engine);
    samples.push(s);
    if (trackAi) aiSamples.push(aiSample(engine));
    onFrame?.(i, s, drv);
  }
  drv.releaseAll();
  return { samples, aiSamples, keyLog: drv.keyLog, drv };
}

/* ------------------------------------------------------------------ utils -- */

export const any = (samples, fn) => samples.some(fn);
export const count = (samples, fn) => samples.reduce((n, s) => n + (fn(s) ? 1 : 0), 0);
export const maxOf = (samples, key) => samples.reduce((m, s) => Math.max(m, s[key] ?? 0), -Infinity);
export const firstIndex = (samples, fn) => samples.findIndex(fn);

/** Total ground distance an agent covered across an AI sample series. */
export function travelled(aiSamples, id) {
  let d = 0;
  let prev = null;
  for (const frame of aiSamples) {
    const a = frame.find((x) => x.id === id);
    if (!a) continue;
    if (prev) d += Math.hypot(a.x - prev.x, a.z - prev.z);
    prev = a;
  }
  return +d.toFixed(2);
}

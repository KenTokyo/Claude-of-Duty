/**
 * Fullscreen + Keyboard Lock.
 *
 * Two problems, one solution. The obvious one is that a 16:9 game in a browser
 * window with a tab strip and a bookmarks bar is not the game. The less obvious
 * one is that Ctrl is bound to crouch, so crouch-and-strafe is literally Ctrl+D
 * — "bookmark this page" — and Ctrl+W, one key over, closes the tab. A
 * `preventDefault()` stops the first kind (bookmark, save, find, reload) but is
 * powerless against the second: Ctrl+W, Ctrl+T, Ctrl+Tab and the tab-switch
 * digits are reserved by the browser and never cancellable from a page.
 *
 * The Keyboard Lock API is the only thing that stops those, and it is only
 * available in fullscreen. So fullscreen is not a comfort feature here — it is
 * the mechanism that makes the movement keys safe. Everything below degrades
 * quietly: Safari and Firefox have no `navigator.keyboard`, so they get
 * fullscreen without the lock, which is exactly what they have today.
 */

/**
 * Codes whose browser shortcut cannot be cancelled with preventDefault().
 * Escape is deliberately absent — it stays the user's way out of fullscreen.
 */
export const LOCK_CODES = [
  'KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyA', 'KeyD', 'KeyS', 'KeyR', 'KeyF',
  'KeyE', 'KeyG', 'KeyC', 'KeyV', 'KeyZ',
  'Digit1', 'Digit2', 'Digit3',
  'Tab', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'AltLeft',
];

export function fullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

export function isFullscreen() {
  return !!fullscreenElement();
}

export function fullscreenSupported() {
  const e = document.documentElement;
  return typeof (e?.requestFullscreen ?? e?.webkitRequestFullscreen) === 'function';
}

export function keyboardLockSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.keyboard?.lock === 'function';
}

let locked = false;

/** Capture the reserved shortcuts. Only legal while fullscreen; never throws. */
export async function lockKeys() {
  if (locked || !keyboardLockSupported() || !isFullscreen()) return false;
  try {
    await navigator.keyboard.lock(LOCK_CODES);
    locked = true;
    return true;
  } catch {
    // A denied lock is a browser policy decision, not an error we can fix.
    return false;
  }
}

export function unlockKeys() {
  if (!locked) return;
  locked = false;
  try {
    navigator.keyboard.unlock();
  } catch {
    /* nothing to unwind */
  }
}

export function keysLocked() {
  return locked;
}

/**
 * Go fullscreen on `element`. Must be called from a user gesture (a keydown or
 * a click); the browser rejects it otherwise and we resolve `false` rather than
 * throwing an unhandled rejection into the frame loop.
 */
export async function enterFullscreen(element) {
  const el = element ?? document.documentElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (typeof request !== 'function') return false;
  try {
    // `navigationUI: 'hide'` is a hint; browsers that do not know it ignore the
    // options object entirely rather than rejecting.
    await request.call(el, { navigationUI: 'hide' });
  } catch {
    try {
      await request.call(el);
    } catch {
      return false;
    }
  }
  await lockKeys();
  return true;
}

export async function exitFullscreen() {
  unlockKeys();
  const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
  if (typeof exit !== 'function') return false;
  try {
    await exit.call(document);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<boolean>} the fullscreen state we ended up in. */
export async function toggleFullscreen(element) {
  if (isFullscreen()) {
    await exitFullscreen();
    return false;
  }
  return enterFullscreen(element);
}

/**
 * Subscribe to fullscreen changes, including the ones we did not ask for (the
 * user pressing Escape or the browser's own F11). Returns an unsubscribe.
 */
export function onFullscreenChange(fn) {
  const handler = () => {
    const on = isFullscreen();
    if (!on) unlockKeys();
    else if (!keysLocked()) lockKeys();
    fn(on);
  };
  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
  return () => {
    document.removeEventListener('fullscreenchange', handler);
    document.removeEventListener('webkitfullscreenchange', handler);
  };
}

import { el, setText, setStyle, clamp01, damp, ease } from './util.js';

/**
 * Death screen.
 *
 * The round has to END at zero health — visibly, not just in a boolean. This is
 * the visible half: the HUD goes, the world desaturates behind a red vignette,
 * and the player is told what killed them and offered a way back in.
 *
 * Timing is integrated from `dt` like every other widget here (no CSS
 * transitions), so it freezes correctly when the game does and stays
 * deterministic under the capture harness.
 */
export class DeathScreen {
  constructor(parent) {
    this.root = el('div', 'ow-death', parent);
    this.wash = el('div', 'ow-death-wash', this.root);
    this.inner = el('div', 'ow-death-inner', this.root);
    const inner = this.inner;
    this.title = el('div', 'ow-death-t', inner, 'YOU ARE DEAD');
    this.sub = el('div', 'ow-death-s', inner, '');
    el('div', 'ow-death-rule', inner);
    this.count = el('div', 'ow-death-count', inner, '');
    this.btn = el('button', 'ow-btn primary ow-death-btn', inner, 'Redeploy');
    this.btn.type = 'button';
    this.btn.addEventListener('click', () => this.onRespawn?.());

    /** Called by the click, and by the auto-timer when it runs out. */
    this.onRespawn = null;

    this.open = false;
    this.shown = 0;
    this.time = 0;
    this.autoAfter = 5.5;
    this._fired = false;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'pointer-events', 'none');
  }

  show({ killer = null, cause = null } = {}) {
    if (this.open) return;
    this.open = true;
    this.time = 0;
    this._fired = false;
    setText(
      this.sub,
      killer ? `KILLED BY ${String(killer).toUpperCase()}` : (cause ?? 'MISSION FAILED').toUpperCase()
    );
    this.btn.disabled = false;
    setStyle(this.root, 'display', '');
  }

  hide() {
    this.open = false;
    this._fired = false;
  }

  update(dt) {
    // The countdown must keep running while the world is frozen, so this is fed
    // unscaled time by the caller.
    if (this.open) {
      this.time += dt;
      const left = Math.max(0, this.autoAfter - this.time);
      setText(this.count, left > 0.05 ? `REDEPLOY IN ${left.toFixed(1)}s` : 'REDEPLOYING …');
      if (!this._fired && left <= 0) {
        this._fired = true;
        this.btn.disabled = true;
        this.onRespawn?.();
      }
    }

    this.shown = damp(this.shown, this.open ? 1 : 0, 6, dt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    const a = ease.outQuad(this.shown);
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', a.toFixed(3));
    // The title settles down into place rather than appearing; the eye reads
    // the movement as the body falling even though nothing here is the body.
    const y = (1 - ease.outCubic(clamp01(this.shown))) * -18;
    setStyle(this.inner, 'transform', `translate(-50%, calc(-50% + ${y.toFixed(2)}px))`);
  }

  dispose() {
    this.root.remove();
  }
}

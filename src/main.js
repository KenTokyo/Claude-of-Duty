import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const QUALITY_NAMES = ['low', 'medium', 'high', 'ultra'];
const QUALITY_TRANSITION_KEY = 'overwatch:quality-transition';

function consumeQualityTransition() {
  try {
    const raw = sessionStorage.getItem(QUALITY_TRANSITION_KEY);
    sessionStorage.removeItem(QUALITY_TRANSITION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !value ||
      !QUALITY_NAMES.includes(value.quality) ||
      !Number.isFinite(value.at) ||
      Date.now() - value.at > 30_000
    ) return null;
    return value;
  } catch {
    return null;
  }
}

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

const prewarmParam = params.get('prewarm');
const prewarmMode =
  prewarmParam === '1' || prewarmParam === 'full'
    ? 'full'
    : prewarmParam === '0' || prewarmParam === 'off'
      ? 'off'
      : capture
        ? 'full'
        : 'off';

const storedQualityTransition = consumeQualityTransition();
const qualityTransition =
  !capture && storedQualityTransition?.quality === params.get('q')
    ? storedQualityTransition
    : null;
const restoredSettings = {};
if (Number.isFinite(qualityTransition?.settings?.sensitivity)) {
  restoredSettings.sensitivity = qualityTransition.settings.sensitivity;
}
if (Number.isFinite(qualityTransition?.settings?.fov)) {
  restoredSettings.fov = Math.max(65, Math.min(120, qualityTransition.settings.fov));
}
if (typeof qualityTransition?.settings?.invertY === 'boolean') {
  restoredSettings.invertY = qualityTransition.settings.invertY;
}

// Preserve the established ultra capture baseline while normal play uses the
// safe production default from config.js. Every quality remains URL-selectable.
const config = createConfig({
  ...(params.has('q') ? { quality: params.get('q') } : capture ? { quality: 'ultra' } : {}),
  ...restoredSettings,
  deterministic: capture,
  prewarm: prewarmMode,
});

const canvas = document.getElementById('game');
const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const bootActivity = document.getElementById('boot-activity');
const bootPercent = document.getElementById('boot-percent');
const bootTrack = document.getElementById('boot-track');
const bootProgress = document.getElementById('boot-progress');
const bootDetail = document.getElementById('boot-detail');
const bootSteps = document.getElementById('boot-steps');

const BOOT_LABEL = {
  render: 'Renderer und Renderziele',
  materials: 'Materialien und Texturen',
  sky: 'Himmel und Beleuchtung',
  physics: 'Physik',
  world: 'Weltgeometrie',
  player: 'Spieler',
  weapons: 'Waffen',
  fx: 'Effekte',
  ai: 'Gegner und Navigation',
  ui: 'Benutzeroberfläche',
  audio: 'Audio',
  prewarm: 'Shader vorbereiten',
  'first-frame': 'Ersten Frame darstellen',
};
const BOOT_STATE_LABEL = {
  pending: 'Ausstehend',
  current: 'Wird vorbereitet',
  done: 'Bereit',
  skipped: 'Übersprungen',
  error: 'Fehler',
};
const BOOT_STATE_CLASSES = Object.keys(BOOT_STATE_LABEL).map((state) => `is-${state}`);
const QUALITY_LABEL = {
  low: 'Niedrig · schneller Start',
  medium: 'Mittel',
  high: 'Hoch',
  ultra: 'Ultra',
};
const bootProfile = `Qualität: ${QUALITY_LABEL[config.quality] ?? config.quality} · WebGL 2`;
const bootStepElements = new Map();
let activeBootStepId = null;
let bootProgressValue = 0.02;

for (const item of bootSteps?.querySelectorAll('[data-boot-step]') ?? []) {
  item.dataset.bootState = 'pending';
  bootStepElements.set(item.dataset.bootStep, item);
}

function ensureBootStep(id, label = BOOT_LABEL[id] ?? id) {
  let item = bootStepElements.get(id);
  if (item || !bootSteps || !id) return item ?? null;

  item = document.createElement('li');
  item.className = 'boot-step is-pending';
  item.dataset.bootStep = id;
  item.dataset.bootState = 'pending';

  const marker = document.createElement('span');
  marker.className = 'boot-step-marker';
  marker.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'boot-step-label';
  name.textContent = label;
  const state = document.createElement('span');
  state.className = 'boot-step-state';
  state.textContent = BOOT_STATE_LABEL.pending;
  item.append(marker, name, state);

  // Unknown future subsystems still appear before the two terminal boot steps.
  const terminalStep = bootSteps.querySelector('[data-boot-step="prewarm"], [data-boot-step="first-frame"]');
  bootSteps.insertBefore(item, terminalStep);
  bootStepElements.set(id, item);
  return item;
}

function setBootStep(id, state, { ms, stateText } = {}) {
  const item = ensureBootStep(id);
  if (!item || !BOOT_STATE_LABEL[state]) return;

  if (state === 'current' && activeBootStepId && activeBootStepId !== id) {
    const previous = bootStepElements.get(activeBootStepId);
    if (previous?.dataset.bootState === 'current') {
      previous.classList.remove('is-current');
      previous.classList.add('is-pending');
      previous.dataset.bootState = 'pending';
      const previousState = previous.querySelector('.boot-step-state');
      if (previousState) previousState.textContent = BOOT_STATE_LABEL.pending;
      previous.removeAttribute('aria-current');
    }
  }

  item.classList.remove(...BOOT_STATE_CLASSES);
  item.classList.add(`is-${state}`);
  item.dataset.bootState = state;

  const duration = state === 'done' && Number.isFinite(ms) && ms > 50 ? ` · ${Math.round(ms)} ms` : '';
  const stateElement = item.querySelector('.boot-step-state');
  if (stateElement) stateElement.textContent = `${stateText ?? BOOT_STATE_LABEL[state]}${duration}`;

  if (state === 'current') {
    activeBootStepId = id;
    item.setAttribute('aria-current', 'step');
    item.scrollIntoView?.({ block: 'nearest' });
  } else {
    item.removeAttribute('aria-current');
    if (activeBootStepId === id) activeBootStepId = null;
  }
}

function setBoot(text, progress = bootProgressValue, detail = bootProfile, activity) {
  const numericProgress = Number(progress);
  if (Number.isFinite(numericProgress)) {
    bootProgressValue = Math.max(bootProgressValue, Math.max(0, Math.min(1, numericProgress)));
  }
  const percent = Math.round(bootProgressValue * 100);

  if (bootStatus) bootStatus.textContent = text;
  if (bootActivity && typeof activity === 'string') bootActivity.textContent = activity;
  if (bootPercent) bootPercent.textContent = `${percent}%`;
  if (bootProgress) bootProgress.style.width = `${percent}%`;
  if (bootDetail && detail != null) bootDetail.textContent = detail;
  if (bootTrack) {
    bootTrack.setAttribute('aria-valuenow', String(percent));
    bootTrack.setAttribute('aria-valuetext', `${percent} Prozent – ${text}`);
  }
}

function showBootError(err, stepId = activeBootStepId) {
  const message = String(err?.message ?? err ?? 'Unbekannter Fehler');
  if (stepId) setBootStep(stepId, 'error');
  if (boot) {
    boot.classList.add('has-error');
    boot.setAttribute('role', 'alert');
    boot.setAttribute('aria-live', 'assertive');
    boot.setAttribute('aria-busy', 'false');
  }
  bootTrack?.setAttribute('aria-invalid', 'true');
  setBoot(
    'Start fehlgeschlagen',
    bootProgressValue,
    'Offene Schritte bleiben ausstehend',
    `Der Start wurde angehalten: ${message}`
  );
}

let qualityReloadStarted = false;
function beginQualityReload(name) {
  if (!QUALITY_NAMES.includes(name)) return false;
  if (qualityReloadStarted) return true;
  if (name === config.quality) return false;
  qualityReloadStarted = true;

  const label = QUALITY_LABEL[name] ?? name;
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set('q', name);

  try {
    sessionStorage.setItem(QUALITY_TRANSITION_KEY, JSON.stringify({
      quality: name,
      at: Date.now(),
      returnToMenu: true,
      settings: {
        sensitivity: config.sensitivity,
        fov: config.fov,
        invertY: config.invertY,
      },
    }));
  } catch {
    // Storage may be disabled; the query parameter still makes reload reliable.
  }

  bootProgressValue = 0.04;
  activeBootStepId = null;
  if (boot) {
    boot.style.display = 'grid';
    boot.classList.remove('is-hidden', 'has-error');
    boot.classList.add('is-reloading');
    boot.setAttribute('role', 'status');
    boot.setAttribute('aria-live', 'polite');
    boot.setAttribute('aria-busy', 'true');
    boot.querySelector('.boot-card')?.scrollTo?.(0, 0);
  }
  bootTrack?.removeAttribute('aria-invalid');
  setBoot(
    `Grafikprofil „${label}“ wird geladen …`,
    0.08,
    `Zielprofil: ${label} · Neustart`,
    'Die aktuelle Szene wird sicher beendet. Anschließend startet das Spiel mit der neuen Grafik.'
  );

  let navigationStarted = false;
  const navigate = () => {
    if (navigationStarted) return;
    navigationStarted = true;
    try {
      location.replace(nextUrl.href);
    } catch (err) {
      qualityReloadStarted = false;
      showBootError(err);
    }
  };
  requestAnimationFrame(() => {
    setBoot(
      'Spiel wird neu geladen …',
      0.14,
      `Zielprofil: ${label} · Neustart`,
      'Die Grafikeinstellung wurde gespeichert. Der Systemstart beginnt sofort.'
    );
    setTimeout(navigate, 140);
  });
  // Background tabs may throttle rAF; never leave the transition hanging.
  setTimeout(navigate, 800);
  return true;
}

function completeBootProgress() {
  setBootStep('first-frame', 'done');
  if (boot) boot.setAttribute('aria-busy', 'false');
  setBoot('Start abgeschlossen', 1, bootProfile, 'Das Spiel ist bereit.');
}

function finishBoot(immediate = false) {
  if (!boot) return;
  if (immediate) {
    boot.style.display = 'none';
    return;
  }
  boot.classList.add('is-hidden');
  setTimeout(() => { boot.style.display = 'none'; }, 220);
}

if (boot) boot.setAttribute('aria-busy', 'true');
setBoot(
  qualityTransition
    ? `Grafikprofil „${QUALITY_LABEL[config.quality] ?? config.quality}“ wird gestartet …`
    : 'Systemstart wird vorbereitet …',
  0.02,
  bootProfile,
  qualityTransition
    ? 'Das Spiel wurde für den Grafikwechsel neu geladen. Die Systeme werden jetzt vorbereitet.'
    : 'Der Start beginnt gleich. Alle Schritte sind noch ausstehend.'
);

// Ensure the static loading UI gets one paint before any procedural generation.
if (!capture) await new Promise((resolve) => requestAnimationFrame(() => resolve()));

const engine = new Engine({ canvas, config });
engine.events.on('ui:quality-request', (request) => {
  if (!request || request.handled) return;
  request.handled = beginQualityReload(request.quality);
});

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

let shotApi;
let warmup;
try {
  await engine.init({
    yieldBetween: !capture,
    onProgress: ({ id, index, total, phase, progress, ms }) => {
      const label = BOOT_LABEL[id] ?? id;
      const mappedProgress = Number.isFinite(progress) ? 0.04 + progress * 0.76 : bootProgressValue;

      if (phase === 'start') {
        setBootStep(id, 'current');
        const position = Number.isInteger(index) && Number.isInteger(total)
          ? `Schritt ${index + 1} von ${total}.`
          : 'Dieser Startschritt ist aktiv.';
        setBoot(
          `${label} wird vorbereitet …`,
          mappedProgress,
          bootProfile,
          `${position} Bitte kurz warten.`
        );
      } else if (phase === 'done') {
        setBootStep(id, 'done', { ms });
        const duration = Number.isFinite(ms) && ms > 50 ? ` (${Math.round(ms)} ms)` : '';
        setBoot(
          `${label} ist bereit${duration}`,
          mappedProgress,
          bootProfile,
          `${label} ist abgeschlossen. Der nächste Schritt beginnt automatisch.`
        );
      }
    },
  });

  shotApi = installShotApi(engine, { capture, lockstep });

  // A graphics change returns to the settings menu after the fresh renderer has
  // reached its first frame. Keeping the menu paused also preserves user intent.
  if (qualityTransition?.returnToMenu) engine.ctx.peek('ui')?.pause?.();

  // Exhaustive compilation is useful for deterministic gates and powerful GPUs,
  // but on some ANGLE/D3D11 drivers it is itself the multi-minute "loading freeze".
  // Normal play therefore compiles the much smaller low/forward program set on its
  // first visible frames. Opt into the exhaustive diagnostic path with ?prewarm=1.
  if (config.prewarm === 'full') {
    setBootStep('prewarm', 'current');
    setBoot(
      'Shader werden vorbereitet …',
      0.82,
      'Shader-Modus: vollständig',
      'Shader werden einmalig zusammengestellt. Das kann je nach Grafiktreiber etwas dauern.'
    );
    warmup = await prewarm(engine, {
      onProgress: (progress) => setBoot(
        'Shader werden vorbereitet …',
        0.82 + progress * 0.15,
        'Shader-Modus: vollständig',
        'Shader werden einmalig zusammengestellt. Das kann je nach Grafiktreiber etwas dauern.'
      ),
    });

    if (warmup?.ok) {
      setBootStep('prewarm', 'done', { ms: warmup.ms });
      setBoot(
        'Shader sind vorbereitet',
        0.97,
        'Shader-Modus: vollständig',
        'Die Shader-Vorbereitung ist abgeschlossen.'
      );
    } else {
      setBootStep('prewarm', 'error', { stateText: 'Nicht verfügbar' });
      setBoot(
        'Shader-Vorbereitung nicht verfügbar',
        0.97,
        'Start wird ohne vollständiges Prewarm fortgesetzt',
        'Das Spiel startet trotzdem; einzelne Shader werden bei Bedarf vorbereitet.'
      );
    }
  } else {
    warmup = { ok: false, reason: 'production fast boot; use ?prewarm=1 to opt in' };
    setBootStep('prewarm', 'skipped', { stateText: 'Übersprungen – schneller Start' });
    setBoot(
      'Shader-Vorbereitung übersprungen',
      0.97,
      bootProfile,
      'Der schnelle Start ist aktiv; Shader werden bei Bedarf vorbereitet.'
    );
  }
  console.info('[boot] prewarm', warmup);
  window.__PREWARM__ = warmup;
  window.__ENGINE__ = engine;

  setBootStep('first-frame', 'current');
  setBoot(
    'Erster Frame wird dargestellt …',
    0.98,
    bootProfile,
    'Die Spielwelt wird jetzt eingeblendet.'
  );
  engine.start();
} catch (err) {
  console.error('[boot] startup failed', err);
  showBootError(err);
  throw err;
}

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  // The DOM loading layer must never enter deterministic canvas screenshots.
  finishBoot(true);
  await shotApi.pump(BOOT_FRAMES);
  completeBootProgress();
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      completeBootProgress();
      window.__READY__ = true;
      finishBoot(capture);
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}

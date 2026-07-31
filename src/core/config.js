/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  // The production default. This is a genuinely cheaper forward path, not the
  // ultra pipeline rendered at a blurrier resolution: one shadow submission,
  // no MRT prepass, no depth-driven fog pass and shared stock PBR programs.
  low: {
    renderScale: 0.7,
    minRenderScale: 0.48,
    maxPixelRatio: 1,
    adaptiveResolution: true,
    targetFps: 60,
    gpuTimerDelayFrames: 180,
    shadowMapSize: 1024,
    cascades: 1,
    shadowDistance: 55,
    prepass: false,
    fogPost: false,
    simpleMaterials: true,
    simpleLighting: true,
    practicalLightBudget: 0,
    pointLightSlots: 4,
    viewPointLightSlots: 1,
    directViewmodel: true,
    characterTextureSize: 256,
    haze: false,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    bloomLevels: 3,
    exposureInterval: 8,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.82,
    minRenderScale: 0.55,
    maxPixelRatio: 1.25,
    adaptiveResolution: true,
    targetFps: 60,
    gpuTimerDelayFrames: 120,
    shadowMapSize: 1536,
    cascades: 2,
    shadowDistance: 85,
    prepass: true,
    fogPost: true,
    simpleMaterials: false,
    simpleLighting: false,
    directViewmodel: false,
    practicalLightBudget: 42,
    pointLightSlots: 20,
    viewPointLightSlots: 2,
    characterTextureSize: 384,
    haze: true,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: false,
    bloom: true,
    bloomLevels: 5,
    exposureInterval: 2,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    minRenderScale: 0.6,
    maxPixelRatio: 1.5,
    adaptiveResolution: true,
    targetFps: 60,
    gpuTimerDelayFrames: 120,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    viewPointLightSlots: 2,
    prepass: true,
    fogPost: true,
    simpleMaterials: false,
    simpleLighting: false,
    practicalLightBudget: 42,
    pointLightSlots: 20,
    directViewmodel: false,
    characterTextureSize: 512,
    haze: true,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    bloomLevels: 6,
    exposureInterval: 1,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    minRenderScale: 0.65,
    maxPixelRatio: 1.5,
    adaptiveResolution: true,
    targetFps: 60,
    gpuTimerDelayFrames: 120,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    viewPointLightSlots: 2,
    prepass: true,
    fogPost: true,
    simpleMaterials: false,
    simpleLighting: false,
    practicalLightBudget: 42,
    pointLightSlots: 20,
    directViewmodel: false,
    characterTextureSize: 512,
    haze: true,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    bloomLevels: 6,
    exposureInterval: 1,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  // Ultra remains available through ?q=ultra. Shipping ultra by default made
  // weaker ANGLE/D3D11 machines spend up to minutes compiling before frame 1.
  quality: 'low',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
  /** 'off' for normal play; the deterministic capture harness requests 'full'. */
  prewarm: 'off',
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}

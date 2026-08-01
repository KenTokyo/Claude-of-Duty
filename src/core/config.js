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
    prepassDepthReuse: false,
    overrideBatch: true,
    // Honour three's own `castShadow` flag in the cascade pass. That pass
    // drives renderer.render() with an override material, which renders
    // whatever is visible, so before this the flag did nothing: MEASURED at
    // ultra, 785 540 triangles per frame -- 11.3% of the whole shadow pass --
    // were pockmarks, litter, cans, small rocks and ground skirts that
    // src/world/props.js had already declared to be non-casters. Here only so
    // an A/B can turn it back off.
    shadowCastFlag: true,
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
    // The forward pass inherits the prepass depth buffer instead of re-resolving
    // it. This is the one change in the pipeline whose freedom from z-fighting
    // cannot be proven without a real GPU -- set false to fall back.
    prepassDepthReuse: true,
    // Collapse multi-material meshes to one draw in the depth/shadow passes.
    overrideBatch: true,
    shadowCastFlag: true,
    characterTextureSize: 384,
    haze: true,
    taa: true,
    gtao: true,
    // Resolution of the GTAO chain as a fraction of the internal render target.
    // The core pass is the most expensive fragment shader in the frame by a
    // wide margin — three slices x eight steps, each stepping both ways, is ~50
    // depth fetches per pixel — and AO is a low-frequency signal that is then
    // bilaterally blurred and temporally accumulated over ~16 frames. Half res
    // is a quarter of the fetches for a term that is blurred anyway; the
    // contact-shadow pass, not this one, is what resolves the 0-40 cm band.
    aoScale: 0.5,
    // The contact chain stays at 1.0, and that is a MEASURED decision, not an
    // oversight: ablating the entire pass at ultra/1512x982@2 costs 0.5 ms of a
    // 63 ms frame, so no resolution change here can be worth more than about a
    // millisecond -- and the band it resolves is 3-10 px wide, i.e. exactly the
    // detail that a half-res buffer would eat. ContactShadows.setSize still
    // takes a blurScale so the option remains correct if that ever changes.
    contactScale: 1,
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
    prepassDepthReuse: true,
    overrideBatch: true,
    shadowCastFlag: true,
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
    aoScale: 0.5,
    contactScale: 1,
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
    // 1.0, and it STAYS 1.0. This was carried as an open proposal for two
    // layers -- start ultra at 0.85 and bank the 26.2% of post-chain fetches --
    // and cod adaptive is what closes it. renderScale is not a starting value,
    // it is the controller's maxScale: AdaptiveResolution builds its ladder as
    // maxScale * [1, .9, .8, .7, .6, .5] clamped to minRenderScale, so 0.85
    // would make 0.85 a permanent CEILING. Hardware that can afford native
    // would never be allowed to render it, on the preset whose entire purpose
    // is to give capable hardware everything.
    //
    // And it buys nothing in the steady state, which is the part that was
    // assumed rather than measured. cod adaptive --q=ultra settles at the 0.65
    // FLOOR either way, in one resize, by frame 41; the ladders [1, .9, .8, .7,
    // .65] and [.85, .765, .68, .65] have the same last rung and the controller
    // walks to it. The only difference a lower start makes is those first 41
    // frames, which is the one window the controller is already there to fix.
    //
    // What actually reopens this is a machine that settles ABOVE the floor --
    // then the ceiling is doing real work and the trade is a real one. Re-run
    // cod adaptive before reviving it; if the verdict still reads PINNED AT
    // FLOOR, the answer has not changed.
    renderScale: 1.0,
    minRenderScale: 0.65,
    maxPixelRatio: 1.5,
    adaptiveResolution: true,
    targetFps: 60,
    gpuTimerDelayFrames: 120,
    // 2048, not 4096. CascadedShadowMaps clamps this to 2048 regardless (see
    // csm.js:39 — 4 x 4096 x R32F is 256 MB of shadow map), so a 4096 here was
    // never anything but a false promise in the preset table. 2048 with PCSS
    // reads sharper than 4096 without it.
    shadowMapSize: 2048,
    cascades: 4,
    // 150, not 200. Four cascades stretched over 200 m give the last one a
    // 153 m slice and a correspondingly coarse texel; at 150 m that slice is
    // 113 m and every cascade in the chain is proportionally sharper, so this
    // is a QUALITY change that happens to also shorten the shadowed depth
    // range. `high` has shipped 140 all along.
    shadowDistance: 150,
    viewPointLightSlots: 2,
    prepass: true,
    prepassDepthReuse: true,
    overrideBatch: true,
    shadowCastFlag: true,
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
    aoScale: 0.5,
    contactScale: 1,
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

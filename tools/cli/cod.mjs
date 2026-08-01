#!/usr/bin/env node
/**
 * cod — the browserless measurement CLI for Claude-of-Duty.
 *
 * STRUCTURE — counts and the draw stream, no timing needed to be believable
 *   probe       --q=ultra [--frames=300]        draws, tris, programs, GPU bytes
 *   drawlist    --q=ultra [--top=30]            the draw stream, biggest first
 *   targets     --q=ultra                       render targets and their bytes
 *   overdraw    --q=ultra [--out=FILE.png]      geometric overdraw per pixel
 *   shaders     --q=ultra [--out=FILE]          every compiled program + frag cost
 *   presets     [--frames=240]                  all four qualities, one child each
 *   fingerprint --q=ultra --out=FILE            hash of the whole draw stream
 *   diff        --a=FILE --b=FILE               what changed between two of those
 *
 * TIMING — only `ab` is trustworthy on a shared machine; see MEASUREMENT below
 *   ab          --toggle=<name> [--frames=1600]  paired in-process A/B + sign test
 *   systems     --q=ultra [--frames=300]        CPU cost per engine subsystem
 *   passes      --q=ultra [--frames=300]        CPU cost per render pass
 *   leak        --q=ultra [--frames=6000]       heap and frame-time drift (--expose-gc)
 *
 * SHADING — no GPU here, so these rebuild the work in software
 *   fragcost    --q=ultra                       static per-fragment cost of a shader
 *   fill        --q=ultra [--top=30]            fragments the fullscreen passes pay for
 *   fillcost    --q=ultra [--w=480 --h=300]     the same passes with their early-outs run
 *   shadowcost  --q=ultra [--w=400 --h=250]     CPU re-simulation of the CSM term
 *   voltaps     --q=ultra [--taps=1,2,3]        what the volumetric march's shadow taps buy
 *   taataps     --q=ultra [--pat=cross5,x5]    what TAA's 9-tap velocity dilation buys
 *   taahalf     --q=ultra [--move=KeyW]         what the dilation lost on half 1/depth
 *   viewrect    --q=ultra [--frames=140]        is the viewmodel screen bound a real bound
 *   upsim       --q=ultra [--scale=0.72 --sweep] does edge-directed beat bilinear upscaling
 *   csm         --q=ultra                       cascade split/cull/texel report
 *   glslcheck   --q=ultra [--only=NAME]         undeclared identifiers in every shader
 *
 * IMAGES
 *   shot        --q=ultra --out=FILE.png [--w=640 --h=400] [--at=90]
 *
 * Global: --q=<low|medium|high|ultra>, --frames=N, --at=<frame>, --verbose,
 *         and --qset=key=value,key2=value2 to override quality settings for one
 *         run (the ablation switch — unknown keys throw rather than silently
 *         measuring nothing).
 *
 * Every command runs the real engine in Node against a recording GL mock.
 * No browser is launched, headless or otherwise.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU
 *   Can:    draw calls, triangles, instancing, program count and switches,
 *           GPU memory footprint, GL object leaks, CPU frame cost per system,
 *           allocation growth over long runs, geometric overdraw, and whether
 *           two builds submit an identical draw stream.
 *   Cannot: real fragment shading time. There is no GPU here, and no calibrated
 *           model of one either — a number in milliseconds for GPU work would be
 *           invented, so this tool never prints one. `fragcost` counts texture
 *           fetches and ALU ops in the compiled GLSL, and `shadowcost` re-runs
 *           the shadow term over real rasterised depth maps. Both yield counts,
 *           and counts rank things honestly; neither yields time.
 *
 * MEASUREMENT DISCIPLINE
 *   This laptop shares its CPU with whatever else is running, so two separate
 *   runs of the same build drift by ~2 ms. Three runs agreeing proves nothing.
 *   Only `ab` is safe for timing: it alternates the toggle frame by frame inside
 *   one process and reports a median paired difference with a sign-test z. Treat
 *   |z| > 3 as a finding and anything below it as noise. Structural counters
 *   need no timing at all and are always sound.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { boot, run, stats } from './harness.mjs';
import { fragmentCost } from './fragcost.mjs';

const argv = Object.fromEntries(process.argv.slice(3).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const cmd = process.argv[2];
const Q = String(argv.q ?? 'ultra');
const FRAMES = Number(argv.frames ?? 300);
const WARM = Number(argv.warm ?? 60);

/**
 * `--qset=key=value,key2=value2` overrides quality settings for one run. This is
 * the ablation switch: measure with a feature on, measure with it off, and the
 * paired difference attributes the gain to that feature rather than to whatever
 * else the machine was doing between two runs an hour apart.
 *
 * Unknown keys throw in the harness rather than being ignored, because a typo
 * that silently measures nothing looks exactly like a feature with no effect.
 */
const QSET = String(argv.qset ?? '').split(',').filter(Boolean).reduce((o, pair) => {
  const [k, v] = pair.split('=');
  o[k] = v === 'true' ? true : v === 'false' ? false : v === undefined ? true : Number.isNaN(Number(v)) ? v : Number(v);
  return o;
}, {});

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const mb = (b) => +(b / 1048576).toFixed(2);
const writeOut = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };

/**
 * Silence the engine's own boot chatter unless --verbose, so stdout stays
 * parseable JSON. Hooking process.stdout directly rather than console.log,
 * because the subsystems reach the stream by more than one route.
 */
function quiet() {
  if (argv.verbose) return () => {};
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  return () => { process.stdout.write = write; };
}

/**
 * Put the game into a representative combat state rather than measuring an
 * empty spawn. Idle-at-spawn numbers flatter every metric that matters.
 */
function engage(engine, stage = argv.stage ?? 'firefight') {
  try {
    engine.input.enabled = true;
    engine.input.frozen = false;
    engine.ctx.peek('player')?.setControlEnabled?.(true);
    if (stage && stage !== 'none') engine.ctx.peek('ai')?.debugStage?.(stage);
  } catch { /* a stage hook that has moved is not a reason to abort a run */ }
}

/**
 * Synthetic mouse look on the LAST frame of a run, in degrees.
 *
 * There is no input recording in this harness: engage() enables control but
 * nothing ever moves the mouse, so the player stands still for every frame of
 * every measurement ever taken with it. That is invisible in most numbers and
 * decisive in one -- motion blur's early-out fires below one pixel of screen
 * motion, so a still camera makes the pass cost 3 fetches where a turning one
 * costs 52. Measuring it therefore requires a camera that moves.
 *
 * The delta is injected as raw pointer pixels, the same field a real mousemove
 * writes, so it passes through sensitivity, freeze and the yaw-rate feed rather
 * than being written onto the camera behind the player's back.
 *
 * Only the final frame is driven, on purpose: motion blur reads exactly one
 * frame-to-frame delta, so one frame is enough to trigger it, and leaving every
 * earlier frame untouched keeps the scene, the AI and the camera position
 * bit-identical to the undriven run. The measurement then differs in one
 * variable instead of drifting into a different view entirely.
 */
function driveLook(engine, degrees, lastFrameIndex) {
  if (!degrees) return () => {};
  const input = engine.input;
  const px = (degrees * Math.PI) / 180 / (input.config?.sensitivity || 0.0022);
  const orig = engine.step.bind(engine);
  let i = 0;
  engine.step = (t) => {
    if (i++ === lastFrameIndex) input._rawLook.x += px;
    return orig(t);
  };
  return () => { engine.step = orig; };
}

/**
 * Hold a movement key down for the whole run, so the camera TRANSLATES.
 *
 * driveLook above turns the camera and nothing else, and that turned out to
 * flatter one measurement badly. A pure rotation moves every pixel by very
 * nearly the same screen delta whatever its depth, because parallax is a
 * function of translation alone. So a velocity buffer sampled under rotation is
 * almost constant across a silhouette -- and TAA's whole reason for dilating the
 * velocity to the closest-depth neighbour is that it is NOT constant across a
 * silhouette. Measured on a rotating-only camera, the nine-tap dilation
 * therefore scores as worth nothing at all, which is an artefact of the input,
 * not a property of the shader.
 *
 * The key is pushed through `_pendingDown`, the same set a real keydown writes,
 * so it passes through the input update, the player controller, the collision
 * response and the head bob rather than teleporting the camera. It is held from
 * frame zero because a walking player needs a few frames to reach speed.
 */
function driveMove(engine, code = 'KeyW') {
  if (!code || code === 'none') return () => {};
  const input = engine.input;
  input._pendingDown.add(code);
  return () => { input._pendingUp.add(code); };
}

/**
 * Play a scripted input timeline: `[frame, code, 'down'|'up']` triples, plus an
 * optional constant yaw in degrees per frame.
 *
 * driveLook turns and driveMove walks, but the viewmodel's screen rectangle is
 * driven by neither. That rectangle moves when the WEAPON moves, and the weapon
 * moves on recoil, on the ADS transition, on a reload and on a swap — all of
 * them button EDGES rather than held state, so pricing them needs a timeline
 * rather than a switch. Firing is also the only way anything is added to
 * `viewScene` mid-frame: the muzzle flash is created by the weapon system when
 * the round leaves, so a run that never pulls the trigger never tests the case
 * the bound was written to survive.
 *
 * Codes go through `_pendingDown`/`_pendingUp`, the same sets a real keydown or
 * mousedown writes, so everything downstream — the recoil impulse, the ADS
 * blend, the animation state machine — happens for the ordinary reason instead
 * of being poked onto the viewmodel from outside.
 */
function driveScript(engine, events, degPerFrame = 0) {
  const input = engine.input;
  const px = degPerFrame
    ? (degPerFrame * Math.PI) / 180 / (input.config?.sensitivity || 0.0022)
    : 0;
  const at = new Map();
  for (const [f, code, kind] of events) {
    if (!at.has(f)) at.set(f, []);
    at.get(f).push([code, kind]);
  }
  const orig = engine.step.bind(engine);
  let i = 0;
  engine.step = (t) => {
    for (const [code, kind] of at.get(i) ?? []) {
      (kind === 'up' ? input._pendingUp : input._pendingDown).add(code);
    }
    if (px) input._rawLook.x += px;
    i++;
    return orig(t);
  };
  return () => {
    engine.step = orig;
    for (const code of input.down) input._pendingUp.add(code);
  };
}

// ---------------------------------------------------------------------------

async function cmdProbe() {
  const restore = quiet();
  const { engine, rec, bootMs, config } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = run(engine, rec, { frames: FRAMES, warm: WARM });
  restore();

  const liveTotal = Object.fromEntries(Object.entries(rec.live).map(([k, v]) => [k, v.size]));
  const out = {
    quality: Q,
    bootMs: +bootMs.toFixed(0),
    frames: FRAMES,
    cpuMsPerFrame: stats(r.cpuMs),
    drawCalls: stats(r.drawCalls),
    triangles: stats(r.triangles),
    programSwitchesPerFrame: stats(r.programSwitches),
    shaderPrograms: rec.programs.size,
    gpuMemoryMB: {
      textures: mb(rec.textureBytes),
      buffers: mb(rec.bufferBytes),
      renderbuffers: mb(rec.renderbufferBytes),
      total: mb(rec.textureBytes + rec.bufferBytes + rec.renderbufferBytes),
    },
    glObjectsLive: liveTotal,
    glObjectsCreated: rec.created,
    glObjectsDeleted: rec.deleted,
    internalPixels: config.q ? undefined : undefined,
    unmodelledGlCalls: Object.fromEntries(rec.unknownCalls),
  };
  console.log(JSON.stringify(out, null, 2));
}

async function cmdShaders() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  // Union across frames, not just the last one: a muzzle flash, a decal or an
  // explosion binds programs that a single quiet frame never shows, and those
  // are exactly the ones whose recompile would be felt as a hitch mid-fight.
  const drawn = new Set();
  const perFrame = [];
  run(engine, rec, {
    frames: 30,
    warm: 10,
    onFrame: (_i, r) => {
      const f = new Set();
      for (const d of r.draws) { drawn.add(d.p); f.add(d.p); }
      perFrame.push(f.size);
    },
  });
  restore();

  const list = [...rec.programs.entries()].map(([id, src]) => ({
    id,
    vertexHash: sha(src.vertex),
    fragmentHash: sha(src.fragment),
    vertexLines: src.vertex.split('\n').length,
    fragmentLines: src.fragment.split('\n').length,
    // How heavy the fragment stage is, so a regression in shader complexity is
    // visible without a GPU. This used to count `texture(` call SITES, which is
    // actively misleading: it reported 6 for a shader that really issues 136
    // fetches, because the expensive ones sit in owCsmTap behind two loop
    // levels. Counting sites once sent the whole GPU analysis down a dead end.
    // fragmentCost() resolves loop trip counts and propagates across calls.
    ...fragmentCost(src.fragment),
    fragLoops: (src.fragment.match(/\bfor\s*\(/g) ?? []).length,
    numPointLights: Number(src.fragment.match(/#define NUM_POINT_LIGHTS (\d+)/)?.[1] ?? -1),
    numDirLights: Number(src.fragment.match(/#define NUM_DIR_LIGHTS (\d+)/)?.[1] ?? -1),
    hasPointSkip: src.fragment.includes('owLightSkip'),
  }));

  // A cache thrashes on its WORKING SET, not on the total number of things that
  // ever existed. Programs compiled during boot -- sky LUT bakes, the PMREM
  // chain, preview scenes -- are never bound again once the game is running, so
  // counting them against a 64-entry cache overstates the risk. `drawnPerFrame`
  // is the number that decides whether entries get evicted and recompiled mid-
  // play; `programs` is what has to fit in memory.
  const summary = {
    quality: Q,
    programs: list.length,
    // ANGLE on Metal warns once a build exceeds 64 pipeline-cache entries and
    // starts evicting, which shows up in play as recurring hitches.
    anglePipelineCacheLimit: 64,
    drawnPerFrameMax: Math.max(0, ...perFrame),
    drawnAcrossRun: drawn.size,
    workingSetOverAngleLimitBy: Math.max(0, drawn.size - 64),
    overAngleLimitBy: Math.max(0, list.length - 64),
    withPointSkip: list.filter((p) => p.hasPointSkip).length,
    uniqueFragmentShaders: new Set(list.map((p) => p.fragmentHash)).size,
    uniqueVertexShaders: new Set(list.map((p) => p.vertexHash)).size,
  };

  if (argv.out) {
    const dump = [...rec.programs.entries()].map(([id, src]) => ({ id, ...src }));
    writeOut(String(argv.out), JSON.stringify({ summary, programs: list, sources: dump }, null, 2));
    console.log(JSON.stringify({ ...summary, wrote: String(argv.out) }, null, 2));
  } else {
    console.log(JSON.stringify({ summary, programs: list }, null, 2));
  }
}

/**
 * A deterministic fingerprint of everything that decides the image, taken
 * without rendering one.
 *
 * For a change that is meant to be bit-exact this is a sharper instrument than
 * an image diff with a tolerance: an image diff can only say "no pixel moved by
 * more than 2/255", whereas this says "the same programs drew the same
 * geometry with the same matrices in the same order". It is also immune to the
 * driver-level nondeterminism that makes tolerant image gates necessary in the
 * first place.
 */
async function cmdFingerprint() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  // A fixed number of frames so the simulation lands in a known state.
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });
  restore();

  // Program id -> hash of its source, so the fingerprint survives a run where
  // GL objects happen to be allocated in a different order.
  const progHash = new Map([...rec.programs.entries()].map(([id, s]) => [id, sha(s.vertex + ' ' + s.fragment)]));

  const drawStream = rec.draws.map((d) => `${progHash.get(d.p) ?? 'x'}|${d.fbo}|${d.mode}|${d.count}|${d.inst}`);

  // Scene-graph side: what is visible, where, and with which material.
  const scene = [];
  const round = (n) => (Math.abs(n) < 1e-6 ? 0 : +n.toFixed(4));
  const walk = (o) => {
    if (!o.visible) return;
    if (o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine || o.isSprite) {
      const m = o.matrixWorld.elements;
      const mat = Array.isArray(o.material) ? o.material : [o.material];
      scene.push([
        o.type, o.geometry?.uuid ? sha(o.geometry.uuid) : '-',
        o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0,
        o.isInstancedMesh ? o.count : 1,
        o.renderOrder, o.frustumCulled ? 1 : 0,
        m.map(round).join(','),
        mat.map((x) => `${x?.type}:${x?.uuid ? sha(x.uuid) : '-'}:${x?.transparent ? 1 : 0}:${x?.side}:${x?.alphaTest ?? 0}:${x?.depthWrite ? 1 : 0}`).join('/'),
      ].join('#'));
    }
    for (const c of o.children) walk(c);
  };
  walk(engine.scene);
  walk(engine.viewScene);
  scene.sort(); // registration order is not a visual property

  const out = {
    quality: Q,
    at: Number(argv.at ?? 90),
    camera: {
      pos: engine.camera.position.toArray().map(round),
      quat: engine.camera.quaternion.toArray().map(round),
      fov: engine.camera.fov, near: engine.camera.near, far: engine.camera.far,
    },
    counts: { drawCalls: rec.drawCalls, triangles: rec.triangles, programs: rec.programs.size, sceneNodes: scene.length },
    drawStreamHash: sha(drawStream.join('\n')),
    sceneHash: sha(scene.join('\n')),
    shaderSetHash: sha([...progHash.values()].sort().join('\n')),
    // Kept so `diff` can say WHERE two builds diverge, not just that they do.
    drawStream, scene,
  };

  const path = String(argv.out ?? `/tmp/cod-fingerprint-${Q}.json`);
  writeOut(path, JSON.stringify(out, null, 2));
  const { drawStream: _a, scene: _b, ...brief } = out;
  console.log(JSON.stringify({ ...brief, wrote: path }, null, 2));
}

async function cmdDiff() {
  const a = JSON.parse(readFileSync(String(argv.a), 'utf8'));
  const b = JSON.parse(readFileSync(String(argv.b), 'utf8'));

  const firstDiff = (x, y, label) => {
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return { label, index: i, a: x[i] ?? null, b: y[i] ?? null };
    return null;
  };

  const identical = a.drawStreamHash === b.drawStreamHash && a.sceneHash === b.sceneHash && a.shaderSetHash === b.shaderSetHash;
  const out = {
    identical,
    drawStream: { equal: a.drawStreamHash === b.drawStreamHash, a: a.drawStreamHash, b: b.drawStreamHash, lenA: a.drawStream.length, lenB: b.drawStream.length },
    scene: { equal: a.sceneHash === b.sceneHash, a: a.sceneHash, b: b.sceneHash, lenA: a.scene.length, lenB: b.scene.length },
    shaders: { equal: a.shaderSetHash === b.shaderSetHash, a: a.shaderSetHash, b: b.shaderSetHash },
    counts: { a: a.counts, b: b.counts },
    firstDrawDiff: a.drawStreamHash === b.drawStreamHash ? null : firstDiff(a.drawStream, b.drawStream, 'draw'),
    firstSceneDiff: a.sceneHash === b.sceneHash ? null : firstDiff(a.scene, b.scene, 'scene'),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = identical ? 0 : 1;
}

/**
 * "Repeated shooting, explosions, enemy combat and prolonged gameplay must not
 * cause increasing lag or memory usage." This is the test for that sentence.
 *
 * It runs a long fight and reports the trend, not the total: a pool that grows
 * once and then holds is fine, a pool that grows every hundred frames is a leak.
 */
async function cmdLeak() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  const total = Number(argv.frames ?? 3000);
  const bucket = Number(argv.bucket ?? 300);
  const marks = [];
  // "Prolonged gameplay must not cause increasing lag" is half the requirement,
  // and it is not implied by flat memory: a growing entity list, an unpruned
  // particle pool or a decal buffer that never recycles all cost time before
  // they cost bytes. Each bucket keeps its own frame times so the trend is a
  // median per bucket -- immune to the GC spikes that would drag a mean.
  let window = [];

  run(engine, rec, {
    frames: total, warm: 30,
    onFrame: (i, rc, ms) => {
      window.push(ms);
      if (i % bucket !== bucket - 1) return;
      const s = [...window].sort((a, b) => a - b);
      window = [];
      // A raw heapUsed sample is a point on a sawtooth: it says where the last
      // GC left the heap, not what is being RETAINED. Fitting a line through it
      // reports a leak whenever the samples happen to land late in a cycle.
      // With --expose-gc we collect first and read the retained set instead,
      // which is the only number that can actually distinguish a leak from
      // ordinary garbage. Run: node --expose-gc tools/cli/cod.mjs leak ...
      globalThis.gc?.();
      marks.push({
        frame: i + 1,
        cpuMsMedian: +s[s.length >> 1].toFixed(3),
        cpuMsP95: +s[Math.floor(s.length * 0.95)].toFixed(3),
        heapMB: mb(process.memoryUsage().heapUsed),
        glTextures: rec.live.texture.size,
        glBuffers: rec.live.buffer.size,
        glPrograms: rec.live.program.size,
        gpuMB: mb(rec.textureBytes + rec.bufferBytes + rec.renderbufferBytes),
        drawCalls: rec.drawCalls,
        triangles: rec.triangles,
      });
    },
  });
  restore();

  // Least-squares slope per 1000 frames — a trend, not a difference of two
  // samples, so one GC dip cannot fake a pass or a fail.
  const slope = (key) => {
    const n = marks.length;
    if (n < 3) return null;
    const mx = marks.reduce((p, m) => p + m.frame, 0) / n;
    const my = marks.reduce((p, m) => p + m[key], 0) / n;
    let num = 0, den = 0;
    for (const m of marks) { num += (m.frame - mx) * (m[key] - my); den += (m.frame - mx) ** 2; }
    return den ? +((num / den) * 1000).toFixed(3) : null;
  };

  const verdict = {
    heapMBper1000: slope('heapMB'),
    gpuMBper1000: slope('gpuMB'),
    glTexturesPer1000: slope('glTextures'),
    glBuffersPer1000: slope('glBuffers'),
    drawCallsPer1000: slope('drawCalls'),
    cpuMsPer1000: slope('cpuMsMedian'),
  };
  // Thresholds differ by unit: half a megabyte per 1000 frames is noise, half a
  // millisecond per 1000 frames is 30 ms over ten minutes and is not.
  const limits = { heapMBper1000: 0.5, gpuMBper1000: 0.5, glTexturesPer1000: 0.5, glBuffersPer1000: 0.5, drawCallsPer1000: 0.5, cpuMsPer1000: 0.1 };
  console.log(JSON.stringify({
    quality: Q, frames: total,
    // Without this the heap column is a sawtooth sample and its trend is noise.
    retainedHeapMeasured: typeof globalThis.gc === 'function',
    marks, trendPer1000Frames: verdict,
    leaking: Object.entries(verdict).filter(([k, v]) => v !== null && v > limits[k]).map(([k]) => k),
  }, null, 2));
}

/**
 * All four presets side by side.
 *
 * `boot()` is not re-entrant inside one process -- the DOM shim installs once
 * and the engine keeps process-global state -- so this forks a child per preset
 * and each child measures exactly one. `--only=<q>` is the child mode.
 *
 * The CPU numbers here are NOT comparable across presets to better than about
 * 2 ms: each child runs at a different moment and this machine has background
 * load that drifts by that much. What IS comparable is everything structural --
 * draw calls, triangles, programs, GPU memory -- because those are counted from
 * the draw stream rather than timed. Read the timings as an order of magnitude
 * and use `ab` when a real timing difference has to be resolved.
 */
async function cmdPresets() {
  const frames = Number(argv.frames ?? 240);
  const only = argv.only ? String(argv.only) : null;

  if (only) {
    const restore = quiet();
    const { engine, rec } = await boot({ quality: only, qset: QSET });
    engage(engine);
    const r = run(engine, rec, { frames, warm: 60 });
    restore();
    process.stdout.write(JSON.stringify({
      quality: only,
      cpuMs: stats(r.cpuMs),
      drawCalls: stats(r.drawCalls)?.median,
      triangles: stats(r.triangles)?.median,
      programs: rec.programs.size,
      gpuMB: mb(rec.textureBytes + rec.bufferBytes + rec.renderbufferBytes),
    }));
    return;
  }

  const { execFileSync } = await import('node:child_process');
  const rows = [];
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    try {
      const out = execFileSync(process.execPath, [
        process.argv[1], 'presets', `--only=${q}`, `--frames=${frames}`,
        ...(argv.qset ? [`--qset=${argv.qset}`] : []),
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      rows.push(JSON.parse(out));
    } catch (e) {
      rows.push({ quality: q, error: String(e.message).slice(0, 300) });
    }
  }
  console.log(JSON.stringify({
    frames,
    note: 'one child process per preset; timings drift ~2 ms between children, structure does not',
    rows,
  }, null, 2));
}

/**
 * Where the per-frame CPU time actually goes, per subsystem and per phase.
 *
 * This is the half of the frame the GPU-timer work could never see. The probe
 * measures ~7.6 ms of pure JS per frame at ultra, which is a large share of a
 * 16.7 ms budget and is entirely independent of resolution -- so unlike
 * fragment cost it cannot be dialled away by rendering smaller.
 */
async function cmdSystems() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  const acc = new Map(); // "id.phase" -> {ms, calls}
  const hit = (k, ms) => { const e = acc.get(k) ?? { ms: 0, calls: 0 }; e.ms += ms; e.calls++; acc.set(k, e); };

  for (const sys of engine.registry.ordered) {
    const id = sys.constructor.id;
    for (const phase of ['fixedUpdate', 'update', 'lateUpdate', 'render']) {
      const orig = sys[phase];
      if (typeof orig !== 'function') continue;
      sys[phase] = function (...a) {
        const t = performance.now();
        try { return orig.apply(this, a); } finally { hit(`${id}.${phase}`, performance.now() - t); }
      };
    }
  }

  const frames = FRAMES;
  const r = run(engine, rec, { frames, warm: WARM });
  restore();

  const rows = [...acc.entries()]
    .map(([k, v]) => ({
      system: k.split('.')[0],
      phase: k.split('.')[1],
      msPerFrame: +(v.ms / (frames + WARM)).toFixed(4),
      callsPerFrame: +(v.calls / (frames + WARM)).toFixed(2),
    }))
    .filter((x) => x.msPerFrame >= 0.0005)
    .sort((a, b) => b.msPerFrame - a.msPerFrame);

  const totalMeasured = rows.reduce((p, c) => p + c.msPerFrame, 0);
  const frameMs = stats(r.cpuMs);
  console.log(JSON.stringify({
    quality: Q, frames,
    frameCpuMs: frameMs,
    // Sum of the parts vs the whole. The gap is engine overhead outside any
    // subsystem: the registry walk, input begin/end and the step bookkeeping.
    accountedMsPerFrame: +totalMeasured.toFixed(3),
    unaccountedMsPerFrame: +(frameMs.mean - totalMeasured).toFixed(3),
    byPhase: ['fixedUpdate', 'update', 'lateUpdate', 'render'].map((p) => ({
      phase: p,
      msPerFrame: +rows.filter((r2) => r2.phase === p).reduce((a, b) => a + b.msPerFrame, 0).toFixed(3),
    })),
    systems: rows,
  }, null, 2));
}

/**
 * CPU cost and draw-call count of each render pass.
 *
 * `systems` shows render.render dominating the frame; this says which pass
 * inside it. Draw counts are attributed per pass too, which is what makes the
 * shadow cascades legible -- they submit the same geometry four more times and
 * that cost is CPU-side scene walking, not shading.
 *
 * The passes nest: csm.render() calls renderer.render() once per cascade, and
 * the probe re-enters it again for its cubemap faces. A flat accumulator counts
 * that inner work twice and the columns then sum to more than the frame. So the
 * profiler keeps a stack and reports SELF cost -- time and draws with every
 * nested wrapped call subtracted -- alongside the inclusive figure. Self is the
 * column that adds up; inclusive is the one that says what a pass costs you if
 * you delete it whole.
 */
function makeStackProfiler(rec) {
  const acc = new Map(); // label -> { incMs, selfMs, incDraws, selfDraws, calls }
  const stack = [];

  const enter = (label) => {
    stack.push({ label, t: performance.now(), d: rec.drawCalls, childMs: 0, childDraws: 0 });
  };
  const exit = () => {
    const f = stack.pop();
    const incMs = performance.now() - f.t;
    const incDraws = rec.drawCalls - f.d;
    const e = acc.get(f.label) ?? { incMs: 0, selfMs: 0, incDraws: 0, selfDraws: 0, calls: 0 };
    e.incMs += incMs;
    e.incDraws += incDraws;
    e.selfMs += incMs - f.childMs;
    e.selfDraws += incDraws - f.childDraws;
    e.calls++;
    acc.set(f.label, e);
    const parent = stack[stack.length - 1];
    if (parent) { parent.childMs += incMs; parent.childDraws += incDraws; }
  };

  return {
    acc,
    depth: () => stack.length,
    /** Label of the innermost pass currently running, or null at top level. */
    top: () => stack[stack.length - 1]?.label ?? null,
    /** Wrap a method so its cost lands under `label` (or a per-call label). */
    wrap(owner, key, label) {
      const orig = owner?.[key];
      if (typeof orig !== 'function') return;
      owner[key] = function (...a) {
        enter(typeof label === 'function' ? label.apply(this, a) : label);
        try { return orig.apply(this, a); } finally { exit(); }
      };
    },
    rows(n) {
      return [...acc.entries()]
        .map(([k, v]) => ({
          pass: k,
          selfMsPerFrame: +(v.selfMs / n).toFixed(4),
          inclusiveMsPerFrame: +(v.incMs / n).toFixed(4),
          selfDrawCallsPerFrame: +(v.selfDraws / n).toFixed(1),
          inclusiveDrawCallsPerFrame: +(v.incDraws / n).toFixed(1),
          callsPerFrame: +(v.calls / n).toFixed(2),
        }))
        .sort((a, b) => b.selfMsPerFrame - a.selfMsPerFrame);
    },
  };
}

async function cmdPasses() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  const r = engine.ctx.peek('render');
  const prof = makeStackProfiler(rec);

  prof.wrap(r, '_collect', 'collect(cull)');
  prof.wrap(r, '_collectViewScene', 'collect(viewmodel)');
  prof.wrap(r, '_ensureProbe', 'probe.update');
  prof.wrap(r.csm, 'update', 'csm.update');
  prof.wrap(r.csm, 'render', 'csm.render(cascades)');
  prof.wrap(r.csm, '_cullCascade', 'csm.cullCascade');
  prof.wrap(r.gbuffer, 'render', 'gbuffer(prepass)');
  for (const k of ['gtao', 'contact', 'ssr', 'taa', 'motionBlur', 'dof', 'bloom']) {
    prof.wrap(r[k], 'render', `${k}.render`);
  }

  // renderer.render is the shared entry point for the forward pass, the
  // viewmodel, every shadow cascade and every probe face. Label it by what is
  // actually being drawn; the stack profiler then keeps the nested cascade and
  // probe draws out of their parents' self columns.
  prof.wrap(r.renderer, 'render', function (scene) {
    if (scene === engine.viewScene) return 'forward(viewmodel)';
    if (this.getRenderTarget() === r.hdrRt) return 'forward(world)';
    // Nested inside an already-attributed pass: name it after its parent so the
    // table reads as a tree instead of a mystery bucket.
    const parent = prof.top();
    return parent ? `  ↳ renderer.render <${parent}>` : 'renderer.render(other)';
  });

  const frames = FRAMES;
  const res = run(engine, rec, { frames, warm: WARM });
  restore();

  const n = frames + WARM;
  const rows = prof.rows(n);
  const selfSum = rows.reduce((p, c) => p + c.selfMsPerFrame, 0);
  const selfDraws = rows.reduce((p, c) => p + c.selfDrawCallsPerFrame, 0);

  console.log(JSON.stringify({
    quality: Q, frames,
    frameCpuMs: stats(res.cpuMs),
    totalDrawCallsPerFrame: stats(res.drawCalls)?.median,
    // These two are the integrity check on the table: self columns must sum to
    // no more than the whole. If they exceed it, an attribution is wrong.
    selfMsAccounted: +selfSum.toFixed(3),
    selfDrawCallsAccounted: +selfDraws.toFixed(1),
    passes: rows,
  }, null, 2));
}

/**
 * A PNG of what the camera sees, drawn on the CPU from the live scene graph.
 *
 * This is the visual QC gate. It cannot show shading regressions -- there is no
 * PBR here -- but it shows every regression that moves, drops or duplicates
 * GEOMETRY, which is the class of bug a culling or batching change actually
 * causes. Read it next to `fingerprint`, which covers the rest.
 */
async function cmdShot() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });

  const { renderShot, toPNGBuffer, writePNG } = await import('./raster.mjs');
  const w = Number(argv.w ?? 640);
  const h = Number(argv.h ?? 400);
  const t0 = performance.now();
  const { rt, opaque, transparent, culled, skinned } = renderShot(engine, { width: w, height: h });
  const ms = performance.now() - t0;
  restore();

  const path = String(argv.out ?? `/tmp/cod-shot-${Q}-${argv.at ?? 90}.png`);
  await writePNG(path, w, h, toPNGBuffer(rt));
  console.log(JSON.stringify({
    quality: Q, at: Number(argv.at ?? 90), stage: argv.stage ?? 'firefight',
    size: `${w}x${h}`, wrote: path, rasterMs: +ms.toFixed(0),
    opaqueItems: opaque, transparentItems: transparent, culledByFrustum: culled,
    skinnedInBindPose: skinned,
    trianglesSubmitted: rt.tris, trianglesRasterized: rt.trisDrawn, instances: rt.instances,
    camera: engine.camera.position.toArray().map((n) => +n.toFixed(2)),
  }, null, 2));
}

/**
 * How many times the forward pass shades a pixel it then throws away.
 *
 * This is the measurement the depth-prepass decision hangs on, and it is exact
 * rather than modelled: overdraw is pure geometry, depth test and draw order,
 * none of which need a GPU.
 */
async function cmdOverdraw() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });

  const { measureOverdraw, overdrawToPNGBuffer, writePNG } = await import('./raster.mjs');
  const w = Number(argv.w ?? 480);
  const h = Number(argv.h ?? 300);
  const t0 = performance.now();
  const res = measureOverdraw(engine, { width: w, height: h });
  const ms = performance.now() - t0;
  restore();

  const { _rt, ...brief } = res;
  if (argv.out) await writePNG(String(argv.out), w, h, overdrawToPNGBuffer(_rt));
  console.log(JSON.stringify({
    quality: Q, at: Number(argv.at ?? 90), stage: argv.stage ?? 'firefight',
    rasterMs: +ms.toFixed(0), ...brief, wrote: argv.out ? String(argv.out) : null,
  }, null, 2));
}

/**
 * What the frame is actually made of, grouped so the batching opportunities are
 * visible.
 *
 * Draw-call totals say the cost; this says WHERE it comes from. A hundred
 * separate meshes sharing one material is a hundred draw calls in every pass at
 * once -- prepass, forward and four cascades -- so merging there pays six times
 * over, which no single-pass number would ever reveal.
 */
async function cmdDrawlist() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });

  const { collectDrawables } = await import('./raster.mjs');
  const { opaque, transparent, culled } = collectDrawables(engine.scene, engine.camera);
  restore();

  const tri = (o) => ((o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3 | 0)
    * (o.isInstancedMesh ? o.count : 1);

  const byMaterial = new Map();
  for (const it of [...opaque, ...transparent]) {
    const key = `${it.material.type}:${it.material.name || it.material.uuid.slice(0, 8)}`;
    const e = byMaterial.get(key) ?? { material: key, drawCalls: 0, triangles: 0, instancedMeshes: 0, geometries: new Set() };
    e.drawCalls++;
    e.triangles += tri(it.object);
    if (it.object.isInstancedMesh) e.instancedMeshes++;
    e.geometries.add(it.object.geometry.uuid);
    byMaterial.set(key, e);
  }

  const rows = [...byMaterial.values()]
    .map((e) => ({ ...e, geometries: e.geometries.size }))
    .sort((a, b) => b.drawCalls - a.drawCalls);

  // The whole scene, not just what is in frustum: the cascades draw far more
  // than the camera does, so the batching target is the scene-wide figure.
  //
  // `groupDrawCalls` is the number that matters. three emits one draw per
  // geometry GROUP for a multi-material mesh, and it does that even under
  // scene.overrideMaterial, where every group is about to be drawn with the
  // identical depth material. Those extra draws buy nothing in the shadow and
  // prepass passes, and they are paid five times over per frame: four cascades
  // plus the prepass.
  let sceneMeshes = 0, sceneInstanced = 0, sceneTris = 0;
  let groupDrawCalls = 0, collapsibleTo = 0, multiMaterial = 0, notTiling = 0;
  engine.scene.traverse((o) => {
    if (o.isMesh !== true && o.isInstancedMesh !== true) return;
    sceneMeshes++;
    if (o.isInstancedMesh) sceneInstanced++;
    sceneTris += tri(o);

    const mats = o.material;
    if (!Array.isArray(mats)) { groupDrawCalls++; collapsibleTo++; return; }
    multiMaterial++;
    const groups = o.geometry?.groups ?? [];
    const visible = groups.filter((g) => mats[g.materialIndex]?.visible !== false);
    groupDrawCalls += visible.length;
    // Collapsing is only output-identical if the groups exactly tile the whole
    // index buffer -- no gap a merged draw would newly cover, no overlap it
    // would drop.
    const total = o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0;
    const sorted = [...groups].sort((a, b) => a.start - b.start);
    let cursor = 0, tiles = sorted.length > 0;
    for (const g of sorted) { if (g.start !== cursor) { tiles = false; break; } cursor += g.count; }
    if (cursor !== total) tiles = false;
    if (tiles && visible.length === groups.length) collapsibleTo++;
    else { collapsibleTo += visible.length; notTiling++; }
  });

  console.log(JSON.stringify({
    quality: Q, at: Number(argv.at ?? 90),
    inFrustum: { opaqueDrawCalls: opaque.length, transparentDrawCalls: transparent.length, culledByFrustum: culled },
    wholeScene: { meshes: sceneMeshes, instancedMeshes: sceneInstanced, triangles: sceneTris },
    overridePassBatching: {
      multiMaterialMeshes: multiMaterial,
      meshesWhoseGroupsDoNotTile: notTiling,
      groupDrawCalls,
      collapsedDrawCalls: collapsibleTo,
      savedPerOverridePass: groupDrawCalls - collapsibleTo,
      // 4 cascades + 1 prepass, before per-cascade culling trims it.
      savedPerFrameUpperBound: (groupDrawCalls - collapsibleTo) * 5,
    },
    topByDrawCalls: rows.slice(0, Number(argv.top ?? 30)),
    materialsTotal: rows.length,
  }, null, 2));
}

/**
 * The render graph as GL actually sees it: every framebuffer and what is bound
 * to each of its attachment points.
 *
 * Render-target wiring is the one class of change that is invisible to every
 * other command here. Sharing a depth buffer between two targets, or failing to,
 * changes no draw call, no triangle and no shader — it changes which texture id
 * lands on an attachment point, and that is exactly what this prints.
 */
async function cmdTargets() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: 20, warm: 0 });
  restore();

  const bySize = new Map();
  for (const [id, size] of rec.textureSizes) bySize.set(id, size);

  const rows = [...rec.attachments.entries()].map(([fbo, map]) => ({
    framebuffer: fbo,
    attachments: Object.fromEntries([...map.entries()].map(([k, v]) => [k, `${v.kind}#${v.id}`])),
  }));

  // Any resource on more than one framebuffer is shared. Depth sharing is the
  // one that matters: it is what lets a later pass inherit an earlier pass's
  // depth instead of rebuilding it.
  const uses = new Map();
  for (const [fbo, map] of rec.attachments) {
    for (const [point, v] of map) {
      const key = `${v.kind}#${v.id}`;
      const e = uses.get(key) ?? { resource: key, framebuffers: [], points: new Set() };
      e.framebuffers.push(fbo);
      e.points.add(point);
      uses.set(key, e);
    }
  }
  const shared = [...uses.values()]
    .filter((e) => e.framebuffers.length > 1)
    .map((e) => ({ resource: e.resource, framebuffers: e.framebuffers, attachedAs: [...e.points], mb: mb(bySize.get(Number(e.resource.split('#')[1])) ?? 0) }));

  const r = engine.ctx.peek('render');
  console.log(JSON.stringify({
    quality: Q,
    framebuffers: rec.live.framebuffer.size,
    reusePrepassDepth: r?.reusePrepassDepth ?? null,
    hdrSharesPrepassDepth:
      r?.hdrRt?.depthTexture != null && r.hdrRt.depthTexture === r.gbuffer?.hardwareDepth,
    sharedResources: shared,
    targets: rows,
  }, null, 2));
}

/**
 * How many samples a motion-blur streak needs, against the same filter at 256.
 *
 * `ow-mb` is 11 % of the frame and the inner loop is almost all of it. Its
 * length comes from one density rule -- one sample per pixel of streak -- which
 * has never been measured, and the loop lays those samples down as TWO mirrored
 * combs that collide with each other whenever the per-pixel jitter is near zero.
 * See the header of mbsim.mjs for both, and read the banding/grain split rather
 * than the PSNR: this pass runs after the TAA resolve, so nothing downstream
 * resolves a dithered sample set.
 */
async function cmdMbtaps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });

  const { measureMotionBlur } = await import('./mbsim.mjs');
  const num = (v, d) => (v === undefined ? d : String(v).split(',').map(Number).filter((x) => x > 0));
  const out = measureMotionBlur(engine, {
    W: Number(argv.w ?? 480), H: Number(argv.h ?? 310), ss: Number(argv.ss ?? 3),
    dirDeg: Number(argv.dir ?? 0), refTaps: Number(argv.ref ?? 128),
    maxTaps: Number(argv.maxtaps ?? 12),
    radii: num(argv.radii, [4, 8, 11.4, 16, 24, 40]),
    divs: num(argv.divs, [2, 2.5, 3, 4]),
  });
  restore();
  console.log(JSON.stringify({ quality: Q, at: Number(argv.at ?? 90), ...out }, null, 2));
}

/**
 * What TAA's 3x3 variance neighbourhood is worth against a five-tap plus.
 *
 * Eight of `ow-taa`'s eighteen real fetches are that neighbourhood -- the
 * largest single block left anywhere in the chain -- and half of them are the
 * four corners. This holds the camera still, moves only the jitter, and
 * accumulates the real resolve for `--frames` frames against the supersampled
 * render the accumulation converges to. See nbsim.mjs for why an unclamped arm
 * is included and why it, not the PSNR, is the number to read.
 */
async function cmdNbtaps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });

  const { measureNeighbourhood } = await import('./nbsim.mjs');
  const out = measureNeighbourhood(engine, {
    W: Number(argv.w ?? 512), H: Number(argv.h ?? 332), ss: Number(argv.ss ?? 3),
    frames: Number(argv.frames ?? 32),
    gammas: argv.gammas ? String(argv.gammas).split(',').map(Number).filter((v) => v > 0) : [],
    stepM: Number(argv.step ?? 0.35),
    gamma: Number(argv.gamma ?? 1.25), feedback: Number(argv.feedback ?? 0.92),
  });
  restore();
  console.log(JSON.stringify({ quality: Q, at: Number(argv.at ?? 90), ...out }, null, 2));
}

/**
 * Whether GTAO's quadratic step ladder ever puts two taps on one depth texel.
 *
 * `ow-gtao` has no early-out left and 48 of its 50 fetches are the sample loop,
 * so the step count is the only lever. The steps are packed towards the origin
 * by `off = radiusPx * ft^2 + 1`, and tDepth is NearestFilter, so a step that
 * lands on a texel the previous one already read buys a second reconstruction
 * of a number already held -- worth 6 fetches, since `off` does not depend on
 * the slice. Whether that ever happens is a question about the frame's DEPTH
 * distribution and nothing else, which is what this counts.
 *
 * `--gaps` is in DEPTH texels, not pass texels: the loop offsets are scaled by
 * the pass's uTexel but fetch the full-resolution gbuffer depth. See the header
 * of gtaosim.mjs for why that distinction is the whole measurement.
 */
async function cmdGtaosteps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const frames = Number(argv.at ?? 90);
  const undrive = driveLook(engine, Number(argv.look ?? 0), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();

  const { measureGtaoSteps } = await import('./gtaosim.mjs');
  const out = measureGtaoSteps(engine, {
    width: Number(argv.w ?? 480), height: Number(argv.h ?? 300),
    gaps: String(argv.gaps ?? '0.5,1,1.5,2').split(',').map(Number).filter((v) => v > 0),
  });
  restore();
  console.log(JSON.stringify({ quality: Q, at: frames, ...out }, null, 2));
}

/**
 * Every shader the frame compiles, checked for identifiers nothing declares.
 *
 * The GL mock answers "compiled fine" to every shader, so this is the only
 * thing in the toolchain that can fail a shader edit. See glsllint.mjs for why
 * the check is scoped the way it is. Exit code 1 on any finding, so it can gate
 * a build rather than only inform one.
 */
async function cmdGlslcheck() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: 20, warm: 5 });
  restore();

  const { lintProgram } = await import('./glsllint.mjs');
  const only = argv.only ? String(argv.only) : null;

  const bad = [];
  const seen = new Set();
  const check = (name, sources, extra) => {
    if (only && !name.includes(only)) return;
    const r = lintProgram(sources);
    if (r.vertex.length || r.fragment.length || r.varyings.length) {
      bad.push({ name: name.slice(0, 60), ...extra, ...r });
    }
  };
  for (const [id, s] of rec.programs) {
    const name = (s.fragment.match(/#define SHADER_NAME (.*)/)?.[1] ?? `program#${id}`).trim();
    seen.add(name);
    check(name, s, { id });
  }

  // Passes the capture never DREW are never compiled, so the loop above cannot
  // see them -- depth of field only runs while the sights are up, the low-health
  // overlay only under a health threshold. Those are exactly the shaders an edit
  // is least likely to be caught in, so they are linted from their materials'
  // own sources instead. three's prefix is absent there, which is what
  // THREE_PROVIDED in glsllint.mjs covers.
  const materials = [];
  const renderSys = engine.ctx.peek('render');
  renderSys?._collectPassMaterials?.(materials);
  // ...and the passes other subsystems register through registerPass, which is
  // how the low-health overlay gets into the chain.
  for (const p of renderSys?.passes ?? []) if (p?.material) materials.push(p.material);
  const uncompiled = [];
  for (const m of materials) {
    const name = m?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    uncompiled.push(name);
    check(name, { vertex: m.vertexShader ?? '', fragment: m.fragmentShader ?? '' }, { id: null });
  }

  console.log(JSON.stringify({
    quality: Q,
    programs: rec.programs.size,
    checked: only ? `name contains "${only}"` : 'all',
    note: 'An undeclared identifier is a shader the driver would reject, and a varying whose '
      + 'interpolation qualifier or type disagrees across the two stages is a program that will '
      + 'not link. Nothing else in this toolchain can see either: the GL mock never compiles or '
      + 'links anything, so a deleted uniform with a surviving reader -- or a `flat out` met by a '
      + 'smooth `in` -- measures identically to correct code everywhere else.',
    alsoCheckedNotDrawnThisRun: uncompiled,
    programsWithFindings: bad.length,
    findings: bad,
  }, null, 2));
  if (bad.length) process.exitCode = 1;
}

async function cmdFragcost() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: 30, warm: 10 });
  restore();

  // How often each program is actually used in a steady-state frame, and at what
  // viewport. Cost per fragment on its own ranks a sky LUT that runs once at boot
  // above the material that covers the whole screen every frame -- which is a
  // ranking that sends the next optimisation pass at the wrong shader. `rec.draws`
  // holds the last frame only, which is the steady state we want.
  const usage = new Map();
  for (const d of rec.draws) {
    const u = usage.get(d.p) ?? { draws: 0, px: 0 };
    u.draws++;
    u.px = Math.max(u.px, d.vw * d.vh);
    usage.set(d.p, u);
  }

  const rows = [...rec.programs.entries()].map(([id, s]) => {
    const u = usage.get(id);
    return {
      id,
      name: (s.fragment.match(/#define SHADER_NAME (.*)/)?.[1] ?? '(none)').slice(0, 44),
      drawsInFrame: u?.draws ?? 0,
      viewportPx: u?.px ?? 0,
      ...fragmentCost(s.fragment),
    };
  });
  // Unused programs still get printed, but underneath, so they cannot masquerade
  // as the hot path. They are not noise -- 101 programs against ANGLE's 64-entry
  // pipeline cache is its own problem -- they are just not fragment cost.
  const used = rows.filter((r) => r.drawsInFrame > 0).sort((a, b) => b.dynamicFetches - a.dynamicFetches);
  const unused = rows.filter((r) => r.drawsInFrame === 0).sort((a, b) => b.dynamicFetches - a.dynamicFetches);
  const top = Number(argv.top ?? 20);

  console.log(JSON.stringify({
    quality: Q,
    programs: rows.length,
    note: 'dynamicFetches is an upper bound per fragment assuming every runtime branch is taken, '
      + 'counting only code that survives the preprocessor. deadFetches is what the preprocessor '
      + 'removed -- almost all of it three transmission code behind #ifdef USE_TRANSMISSION. '
      + 'Rank on drawsInFrame together with dynamicFetches: a program with drawsInFrame 0 costs '
      + 'nothing per frame however expensive its fragments are.',
    deadFetchesTotal: rows.reduce((p, c) => p + (c.deadFetches ?? 0), 0),
    programsDrawnThisFrame: used.length,
    programsNotDrawnThisFrame: unused.length,
    top: used.slice(0, top),
    notDrawnThisFrame: unused.slice(0, 8).map((r) => ({ id: r.id, name: r.name, dynamicFetches: r.dynamicFetches })),
  }, null, 2));
}

/**
 * Fill rate: how many fragments the fullscreen passes actually pay for.
 *
 * `fragcost` ranks shaders by cost PER fragment and `overdraw` counts geometric
 * coverage; neither says how many fragments the post chain issues. That is the
 * missing number, and it is the one that matters, because this frame is
 * fragment-bound rather than CPU-bound -- the CPU median sits near 5.7 ms while
 * the adaptive scaler saturates at its floor, which only happens when the GPU is
 * the wall.
 *
 * Unlike world geometry, a fullscreen pass is exactly measurable with no GPU at
 * all: it is one un-instanced quad or triangle covering the whole viewport, so
 * its fragment count IS `vw*vh`, not an estimate of one. That is the detection
 * rule -- at most 2 triangles and no instancing -- and `rec.draws` holds the
 * last frame only, which is the steady state we want.
 *
 * Fragments alone still under-rank a small pass that fetches thirty textures, so
 * the headline ranking is fragments x dynamicFetches: the texture fetches a pass
 * issues over one whole frame. On a bandwidth-bound frame that is the bill.
 */
async function cmdFill() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  // --real runs fillcost's simulation in the same process and joins its
  // realised per-pass cost onto the table. Without it there are two rankings,
  // one static and one dynamic, and reconciling them is a hand calculation --
  // which is how the pass with the most generous worst case ended up quoted as
  // the frame's biggest item when its early-outs had already removed most of it.
  const REAL = argv.real === true || argv.real === 'true';
  const r = engine.ctx.peek('render');

  // ADS is a gameplay state and the depth-of-field chain only exists inside it,
  // so every fill measurement this project has ever taken priced a frame with
  // three of its shipping passes missing. --ads pins the engagement (bare flag
  // = fully aimed, or --ads=0.5 for mid-transition) so the aimed frame can be
  // ranked too. The render system reads it once per frame off the weapons
  // subsystem, which the headless harness does not drive.
  const ADS = argv.ads === true || argv.ads === 'true' ? 1 : Number(argv.ads ?? 0);
  if (r && ADS > 0) r._readAds = () => Math.min(1, Math.max(0, ADS));

  let mb = null;
  const mbPass = REAL ? r?.motionBlur : null;
  const origMb = mbPass?.render?.bind(mbPass);
  if (mbPass) {
    // Same hook and the same reason as cmdFillcost: _prevVP is overwritten at
    // the end of every frame, so it has to be read while the pass has it.
    let prevPos = null, prevQuat = null;
    mbPass.render = (renderer, colorTexture, gbuffer, frame, shutter) => {
      const cam = engine.camera;
      mb = {
        shutter, currVP: r._currVP.clone(), prevVP: r._prevVP.clone(),
        camMove: prevPos ? cam.position.distanceTo(prevPos) : 0,
        camTurn: prevQuat ? (cam.quaternion.angleTo(prevQuat) * 180) / Math.PI : 0,
      };
      prevPos = cam.position.clone(); prevQuat = cam.quaternion.clone();
      return origMb(renderer, colorTexture, gbuffer, frame, shutter);
    };
  }

  const frames = REAL ? Number(argv.at ?? 90) : 30;
  const undrive = REAL ? driveLook(engine, Number(argv.look ?? 0), frames - 1) : () => {};
  run(engine, rec, { frames, warm: REAL ? 0 : 10 });
  undrive();
  if (mbPass) mbPass.render = origMb;

  let realCost = null;
  if (REAL) {
    const { measureFillCost } = await import('./fillsim.mjs');
    realCost = measureFillCost(engine, {
      width: Number(argv.w ?? 480), height: Number(argv.h ?? 300), mb,
    }).passCost;
  }

  const mainW = r?.screenSize?.width ?? 0;
  const mainH = r?.screenSize?.height ?? 0;
  restore();

  const mainPx = Math.max(1, mainW * mainH);
  const TRIANGLES = 4, TRIANGLE_STRIP = 5, TRIANGLE_FAN = 6;
  const tris = (d) => d.mode === TRIANGLES ? (d.count / 3) | 0
    : d.mode === TRIANGLE_STRIP || d.mode === TRIANGLE_FAN ? Math.max(0, d.count - 2)
      : 0;

  const nameOf = (id) => (rec.programs.get(id)?.fragment.match(/#define SHADER_NAME (.*)/)?.[1] ?? `program#${id}`)
    .trim().slice(0, 44);
  // fragmentCost walks the whole shader source, so it is far too slow to call
  // once per draw; the post chain reuses a handful of programs across dozens of
  // draws, and the cost only depends on the program.
  const costCache = new Map();
  const fetchesOf = (id) => {
    if (!costCache.has(id)) {
      const src = rec.programs.get(id)?.fragment;
      costCache.set(id, src ? fragmentCost(src).dynamicFetches : 0);
    }
    return costCache.get(id);
  };

  // Keyed by program AND viewport, because the bloom pyramid runs the identical
  // shader at six resolutions and collapsing them would hide exactly the fact
  // this command exists to establish: how much of the chain is full-resolution.
  const byPass = new Map();
  let fsDraws = 0, fsFragments = 0, fsFetches = 0;
  let geoDraws = 0, geoTris = 0;
  for (const d of rec.draws) {
    const t = tris(d);
    if (t > 2 || d.inst > 1) { geoDraws++; geoTris += t * Math.max(1, d.inst); continue; }
    const px = d.vw * d.vh;
    const per = fetchesOf(d.p);
    fsDraws++; fsFragments += px; fsFetches += px * per;

    const key = `${d.p}@${d.vw}x${d.vh}`;
    const e = byPass.get(key) ?? {
      pass: nameOf(d.p), vw: d.vw, vh: d.vh, draws: 0,
      fragmentsPerDraw: px, fetchesPerFragment: per, fbos: new Set(),
    };
    e.draws++;
    e.fbos.add(d.fbo);
    byPass.set(key, e);
  }

  const realBy = new Map((realCost ?? []).map((c) => [c.pass, c]));
  const rows = [...byPass.values()].map((e) => {
    const fragments = e.fragmentsPerDraw * e.draws;
    const row = {
      pass: e.pass,
      viewport: `${e.vw}x${e.vh}`,
      resFraction: +(e.fragmentsPerDraw / mainPx).toFixed(4),
      draws: e.draws,
      targets: e.fbos.size,
      fragments,
      screensOfFill: +(fragments / mainPx).toFixed(3),
      fetchesPerFragment: e.fetchesPerFragment,
      fetches: fragments * e.fetchesPerFragment,
    };
    const c = realBy.get(e.pass);
    if (c && c.shadedFraction !== undefined) {
      // A pass whose fragments are thrown away by the depth test before its
      // shader runs. The per-fragment bound is untouched -- what was measured is
      // how many fragments reach it -- so this scales the row's OWN fragcost
      // figure rather than restating it, which keeps the two in step if the
      // shader changes.
      const per = +(e.fetchesPerFragment * c.shadedFraction).toFixed(2);
      row.realBasis = c.basis;
      row.shadedFractionOfFragments = c.shadedFraction;
      row.realFetchesPerFragment = per;
      row.realFetches = Math.round(fragments * per);
      row.realFetchesLo = row.realFetches;
      row.boundOverstatesBy = +(1 / Math.max(1e-4, c.shadedFraction)).toFixed(2);
    } else if (c) {
      row.realBasis = c.basis;
      row.realFetchesPerFragment = c.fetchesPerFragmentHi === c.fetchesPerFragmentLo
        ? c.fetchesPerFragmentLo : [c.fetchesPerFragmentLo, c.fetchesPerFragmentHi];
      row.realFetches = Math.round(fragments * c.fetchesPerFragmentHi);
      row.realFetchesLo = Math.round(fragments * c.fetchesPerFragmentLo);
      row.boundOverstatesBy = +(e.fetchesPerFragment / Math.max(0.1, c.fetchesPerFragmentHi)).toFixed(2);
      if (c.diag) row.realDiag = c.diag;
    } else if (realCost) {
      // Not modelled: the bound is all there is, and saying so is the point --
      // an unlabelled row would read as "measured and equal to its bound".
      row.realBasis = 'bound only';
      row.realFetches = row.fetches;
    }
    return row;
  }).sort((a, b) => (b.realFetches ?? b.fetches) - (a.realFetches ?? a.fetches));

  // Full-resolution work is the part a smaller `maxPixelRatio` or a lower
  // `renderScale` would actually buy back, so it gets its own line rather than
  // being left to be reconstructed from the table.
  const atFull = rows.filter((x) => x.resFraction > 0.99);
  const reduced = rows.filter((x) => x.resFraction <= 0.99);
  const sum = (a, k) => a.reduce((p, c) => p + c[k], 0);

  console.log(JSON.stringify({
    quality: Q,
    mainViewport: { w: mainW, h: mainH, px: mainPx },
    note: 'Fullscreen passes only: <=2 triangles and no instancing, so fragments == vw*vh exactly. '
      + 'Geometry fragment counts are NOT here -- they depend on depth complexity, which needs a '
      + 'rasteriser (`overdraw`) and not a draw stream. screensOfFill is fragments / mainViewport.px; '
      + 'fetches is fragments * fragcost dynamicFetches, an upper bound assuming every branch is taken. '
      + 'A row naming a world material rather than a post shader would be a <=2-triangle mesh caught by '
      + 'the same rule, not a post pass.',
    real: realCost ? {
      note: 'realFetches is the pass evaluated with its early-outs RUN, not assumed. Rows are '
        + 'ranked on it. Basis: "exact" = every branch that decides the count was evaluated '
        + 'per pixel; "bounded" = the count depends on where a march breaks and lo/hi bracket '
        + 'it, with realFetches carrying the high end so the ranking stays conservative; '
        + '"coverage" = the per-fragment bound is unchanged and what was measured is how many '
        + 'fragments survive the depth test to reach it; "bound only" = NOT MODELLED, the '
        + 'bound is reported unchanged and is not a measurement. boundOverstatesBy is how many '
        + 'times too large the static bound is for that row.',
      totalFetches: rows.reduce((p, c) => p + (c.realFetches ?? c.fetches), 0),
      totalFetchesLo: rows.reduce((p, c) => p + (c.realFetchesLo ?? c.realFetches ?? c.fetches), 0),
      modelledPasses: rows.filter((x) => x.realBasis && x.realBasis !== 'bound only').length,
      // A model that prices a bound the shader does not honour reports a CHEAPER
      // pass, so the failure is invisible in the totals and looks like progress.
      // Any row that can detect its own precondition breaking says so here.
      alerts: (realCost ?? []).map((c) => c.alert).filter(Boolean),
      cameraTurnedDeg: mb ? +mb.camTurn.toFixed(3) : 0,
      warning: mb && mb.camTurn < 0.16
        ? 'THE CAMERA IS STANDING STILL. Motion blur takes its early-out below ~0.155 deg per '
          + 'frame, so ow-mb is priced here at its idle cost. Pass --look=1 for a turning player.'
        : undefined,
    } : undefined,
    fullscreen: {
      draws: fsDraws,
      fragments: fsFragments,
      screensOfFill: +(fsFragments / mainPx).toFixed(3),
      fetches: fsFetches,
      atFullResolution: {
        draws: sum(atFull, 'draws'),
        fragments: sum(atFull, 'fragments'),
        screensOfFill: +(sum(atFull, 'fragments') / mainPx).toFixed(3),
        shareOfFetches: +(sum(atFull, 'fetches') / Math.max(1, fsFetches)).toFixed(4),
      },
      belowFullResolution: {
        draws: sum(reduced, 'draws'),
        fragments: sum(reduced, 'fragments'),
        screensOfFill: +(sum(reduced, 'fragments') / mainPx).toFixed(3),
      },
    },
    geometryDraws: { draws: geoDraws, triangles: geoTris },
    passes: rows.slice(0, Number(argv.top ?? 30)),
  }, null, 2));
}

/**
 * The dynamic counterpart to `fragcost`: how many shadow fetches a pixel really
 * issues, and what each shader branch is worth.
 *
 * `fragcost` has to assume every branch is taken and reports the shadow term at
 * 52 fetches. This rasterizes the four cascade maps and the camera view in
 * software and runs the real arithmetic per pixel, so the early-outs, the umbra,
 * the penumbra and the cross-fade all get counted instead of assumed. It also
 * evaluates the pre- and post-change shader side by side on every pixel, which
 * is how an "obviously safe" early-out gets checked rather than argued.
 */
/**
 * The dynamic counterpart to `fill`, as `shadowcost` is to `fragcost`.
 *
 * `fill` multiplies exact fragment counts by an upper bound that assumes every
 * branch is taken, which ranks the pass with the most generous worst case
 * first. This rasterises the camera view and evaluates the real early-outs.
 * See fillsim.mjs for which of its numbers are exact and which are bounds.
 */
async function cmdFillcost() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const render = engine.ctx.peek('render');

  // Motion blur's early-out is decided by the frame-to-frame camera delta, and
  // RenderSystem copies _currVP over _prevVP at the end of every frame. Reading
  // the pair after run() returns would therefore compare the last frame against
  // itself and report a perfectly still camera. Snapshot them at the moment the
  // pass consumed them instead -- which also captures the real shutter, since
  // that is scaled by the frame's own dt.
  let mb = null;
  const mbPass = render.motionBlur;
  const origMb = mbPass?.render?.bind(mbPass);
  if (mbPass) {
    let prevPos = null, prevQuat = null;
    mbPass.render = (renderer, colorTexture, gbuffer, frame, shutter) => {
      const cam = engine.camera;
      mb = {
        shutter, currVP: render._currVP.clone(), prevVP: render._prevVP.clone(),
        camMove: prevPos ? cam.position.distanceTo(prevPos) : 0,
        camTurn: prevQuat ? (cam.quaternion.angleTo(prevQuat) * 180) / Math.PI : 0,
      };
      prevPos = cam.position.clone(); prevQuat = cam.quaternion.clone();
      return origMb(renderer, colorTexture, gbuffer, frame, shutter);
    };
  }

  const frames = Number(argv.at ?? 90);
  const undrive = driveLook(engine, Number(argv.look ?? 0), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  if (mbPass) mbPass.render = origMb;

  const { measureFillCost } = await import('./fillsim.mjs');
  const out = measureFillCost(engine, {
    width: Number(argv.w ?? 480), height: Number(argv.h ?? 300), mb,
  });
  restore();
  console.log(JSON.stringify({ quality: Q, at: Number(argv.at ?? 90), stage: argv.stage ?? 'firefight', ...out }, null, 2));
}

/**
 * What motion blur's depth weight costs when the depth comes through a LINEAR
 * filter, which is the price of reading it out of the resolve target's alpha
 * instead of taking a second full-resolution fetch per tap.
 *
 * That trade is worth 29 M fetches a frame and it is the only part of it that
 * is not exact, so it gets its own command rather than a paragraph. Defaults
 * to `--look=1` because a still camera has no taps to measure -- the pass
 * early-outs below 1 px of streak and the whole question disappears.
 * `--study` repeats it at three resolutions; the disagreement is a function of
 * how much world a texel spans, so a single number is not an answer.
 *
 * See mbdepthsim.mjs for what is exact here and what is not.
 */
async function cmdMbdepth() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const render = engine.ctx.peek('render');

  // Same snapshot discipline and the same reason as cmdFillcost: _prevVP is
  // overwritten at the end of every frame, so it has to be read while the pass
  // still has it.
  let mb = null;
  const mbPass = render.motionBlur;
  const origMb = mbPass?.render?.bind(mbPass);
  if (mbPass) {
    mbPass.render = (renderer, colorTexture, gbuffer, frame, shutter) => {
      mb = { shutter, currVP: render._currVP.clone(), prevVP: render._prevVP.clone() };
      return origMb(renderer, colorTexture, gbuffer, frame, shutter);
    };
  }

  const frames = Number(argv.at ?? 90);
  const undrive = driveLook(engine, Number(argv.look ?? 1), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  if (mbPass) mbPass.render = origMb;

  const { measureMbDepth } = await import('./mbdepthsim.mjs');
  const sizes = argv.study
    ? [[480, 300], [760, 476], [1134, 736]]
    : [[Number(argv.w ?? 760), Number(argv.h ?? 476)]];
  const runs = sizes.map(([w, h]) => measureMbDepth(engine, { width: w, height: h, mb }));
  restore();
  console.log(JSON.stringify({
    quality: Q,
    lookDeg: Number(argv.look ?? 1),
    depthInAlpha: !!render.motionBlur?.depthInAlpha,
    runs,
  }, null, 2));
}

/**
 * What the volumetric march's four shadow taps per step buy.
 *
 * `sky-vol-march` is the largest single item in the frame and 98% of it is
 * those taps, so the tap count is the only lever there worth pulling. This
 * rasterises the real cascade maps at their real 2048^2, marches every pixel
 * with the engine's own step distribution, dither, density noise and cascade
 * projection, and evaluates the visibility with 4 taps and with fewer, side by
 * side on the same steps. See volsim.mjs for why the resulting number bounds
 * the in-scatter error from above without needing the phase function.
 */
async function cmdVoltaps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const csm = engine.ctx.peek('render').csm;

  // Same snapshot discipline as cmdShadowcost: the caster array is scratch and
  // its non-casters are hidden only for the duration of the CSM pass.
  let snapshot = null;
  const origRender = csm.render.bind(csm);
  csm.render = function (renderer, scene, casters, nCasters) {
    if (casters) {
      const list = [];
      for (let k = 0; k < nCasters; k++) if (casters[k].visible !== false) list.push(casters[k]);
      snapshot = list;
    }
    return origRender(renderer, scene, casters, nCasters);
  };

  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });
  csm.render = origRender;

  let marchSrc = '';
  for (const [, s] of rec.programs) {
    if (s.fragment.includes('skSunVisibility')) { marchSrc = s.fragment; break; }
  }

  const { measureVolTaps } = await import('./volsim.mjs');
  const out = measureVolTaps(engine, snapshot ?? [], snapshot?.length ?? 0, {
    width: Number(argv.w ?? 480),
    height: Number(argv.h ?? 300),
    shadowRes: Number(argv.smres ?? 0),
    variants: String(argv.taps ?? '1,2,3').split(',').map(Number).filter((k) => k > 0),
    converge: Number(argv.converge ?? 1),
    theta: argv.theta != null ? String(argv.theta) : null,
    marchSrc,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: Number(argv.at ?? 90), casterListLength: snapshot?.length ?? 0, ...out,
  }, null, 2));
}

/**
 * What the volumetric march's STEP COUNT is worth, which `voltaps` cannot say.
 *
 * voltaps holds the weights fixed and moves only the shadow term, so it reports
 * |dV|/V and that is the right statistic there. Changing VOL_STEPS moves the
 * weights too -- it re-quadratures the whole integral -- so the same statistic
 * would rate four steps as excellent. This measures the two sums the in-scatter
 * is a non-negative combination of, and the larger of their relative errors
 * bounds |dL|/L for every sun angle. See the header of volstepsim.mjs for the
 * algebra and for why the step warp makes a short ray 45x over-resolved.
 *
 * `--rot` averages each visibility call over that many Vogel rotations, which is
 * the fixed point sky-vol-resolve walks to. Step-count error is a deterministic
 * bias and does not rotate, so a rule whose converged error is far below its
 * single-frame error is being credited for tap noise it did not remove.
 */
async function cmdVolsteps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const csm = engine.ctx.peek('render').csm;

  let snapshot = null;
  const origRender = csm.render.bind(csm);
  csm.render = function (renderer, scene, casters, nCasters) {
    if (casters) {
      const list = [];
      for (let k = 0; k < nCasters; k++) if (casters[k].visible !== false) list.push(casters[k]);
      snapshot = list;
    }
    return origRender(renderer, scene, casters, nCasters);
  };

  const frames = Number(argv.at ?? 90);
  const undrive = driveLook(engine, Number(argv.look ?? 0), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  csm.render = origRender;

  let marchSrc = '';
  for (const [, s] of rec.programs) {
    if (s.fragment.includes('skSunVisibility')) { marchSrc = s.fragment; break; }
  }

  const { measureVolSteps } = await import('./volstepsim.mjs');
  const out = measureVolSteps(engine, snapshot ?? [], snapshot?.length ?? 0, {
    width: Number(argv.w ?? 480), height: Number(argv.h ?? 300),
    shadowRes: Number(argv.smres ?? 0),
    refMul: Number(argv.refmul ?? 4),
    dith: Number(argv.dith ?? 1),
    rot: Number(argv.rot ?? argv.converge ?? 1),
    minSteps: Number(argv.min ?? 4),
    marchSrc,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: frames, casterListLength: snapshot?.length ?? 0, ...out,
  }, null, 2));
}

/**
 * How far one `ow-contact` march step moves ON SCREEN, in G-buffer texels.
 *
 * The march is a fixed WORLD length cut into OW_CS_STEPS equal pieces, so its
 * screen-space step shrinks with distance: a sample far from the camera can land
 * in the same texel as the one before it, and its fetch then returns a depth the
 * loop already read. This says how often that happens and -- separately -- how
 * often the re-read could not have changed the occlusion test's answer either.
 *
 * See contactstep.mjs for what is exact here and what is not.
 */
async function cmdContactstep() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  const frames = Number(argv.at ?? 90);
  const undrive = driveLook(engine, Number(argv.look ?? 0), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();

  const { measureContactSteps } = await import('./contactstep.mjs');
  const out = measureContactSteps(engine, {
    width: Number(argv.w ?? 480), height: Number(argv.h ?? 300),
  });
  restore();
  console.log(JSON.stringify({ quality: Q, at: frames, ...out }, null, 2));
}

/**
 * What TAA's nine-tap velocity dilation is worth, the way `voltaps` does for the
 * volumetric march's shadow taps.
 *
 * `ow-taa` is the largest item left in the frame and, unlike every other post
 * pass, it has no early-out: its static bound IS its real cost. Nine of its 26
 * fetches are the depth taps that dilate the velocity to the closest-depth
 * neighbour. This runs the dilation over the real rasterised depth buffer for
 * several tap patterns and reports how far the history sample moves, which is
 * the entire difference between them -- everything downstream of `huv` is a
 * fixed function of it. See taasim.mjs for what is exact and what is not.
 */
async function cmdTaataps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = engine.ctx.peek('render');

  // Same snapshot discipline as the motion-blur hook in cmdFill: _prevVP is
  // overwritten with _currVP at the end of every frame, so reading the pair
  // after run() returns would compare a frame against itself and report a
  // stationary camera -- which is exactly the case where the dilation cannot
  // disagree with itself and every pattern would score perfect.
  let vp = null;
  const taa = r?.taa;
  const orig = taa?.render?.bind(taa);
  let prevPos = null, camMove = 0, camTurn = 0, prevQuat = null;
  if (taa) {
    taa.render = (renderer, colorTexture, gbuffer, invVP, prevVP) => {
      const cam = engine.camera;
      vp = { currVP: r._currVP.clone(), prevVP: r._prevVP.clone() };
      camMove = prevPos ? cam.position.distanceTo(prevPos) : 0;
      camTurn = prevQuat ? (cam.quaternion.angleTo(prevQuat) * 180) / Math.PI : 0;
      prevPos = cam.position.clone(); prevQuat = cam.quaternion.clone();
      return orig(renderer, colorTexture, gbuffer, invVP, prevVP);
    };
  }

  const frames = Number(argv.at ?? 90);
  // Translation by default, because a rotating-only camera makes every dilation
  // pattern look free -- see driveMove.
  const unmove = driveMove(engine, argv.move === undefined ? 'KeyW' : String(argv.move));
  const undrive = driveLook(engine, Number(argv.look ?? 1), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  unmove();
  if (taa) taa.render = orig;

  if (!vp) {
    restore();
    console.log(JSON.stringify({
      quality: Q,
      unavailable: 'TAA is off in this preset, so there is no dilation to price.',
    }, null, 2));
    return;
  }

  // Default to the pass's OWN resolution. The dilation is a texel-space
  // operation: at half the width a 3x3 spans twice as much world, so depth
  // discontinuities fall inside it far more often and every pattern scores
  // worse than it really is. Simulating small is conservative, not cheap.
  const { measureTaaDilation } = await import('./taasim.mjs');
  const out = measureTaaDilation(engine, {
    width: Number(argv.w ?? r.screenSize?.width ?? 1134),
    height: Number(argv.h ?? r.screenSize?.height ?? 737),
    currVP: vp.currVP, prevVP: vp.prevVP,
    patterns: argv.pat ? String(argv.pat).split(',') : null,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: frames,
    camera: {
      note: 'Dilation only matters where the velocity field has parallax, and parallax '
        + 'comes from TRANSLATION. A run with movedMPerFrame at zero has measured a '
        + 'turning statue and every pattern will score perfect. Pass --move=none to see '
        + 'that for yourself.',
      movedMPerFrame: +camMove.toFixed(4), turnedDegPerFrame: +camTurn.toFixed(3),
    },
    warning: camMove < 0.002
      ? 'THE CAMERA IS NOT TRANSLATING. A pure rotation moves near and far pixels by '
        + 'nearly the same screen delta, so the dilation has nothing to disagree about '
        + 'and this result says nothing about the change.'
      : undefined,
    ...out,
  }, null, 2));
}

/**
 * `taahalf` — what the dilation lost when it moved off the R32F depth target and
 * onto the half `1/depth` that now rides in the gbuffer normal's alpha.
 *
 * The saving is not in question and is not measured here: the alpha tap the
 * dilation already makes now also returns the coverage, so the separate `cb` and
 * `ca` fetches and the whole `tDepth` sampler are gone -- 21 fetches per fragment
 * to 19. `fill` prices that. This asks only whether the picture paid for it.
 *
 * THE ORDERING IS SAFE BY CONSTRUCTION and that is worth stating so the
 * measurement is not mistaken for a check of it. 1/d is monotonic in d and half
 * rounding is monotonic, so argmin(depth) IS argmax(alpha); no rounding can swap
 * two neighbours' rank. The only thing half can do is make two of them EQUAL,
 * after which the strict comparison keeps the earlier tap and the dilation picks
 * a different texel than it used to.
 *
 * So a raw "how many pixels changed neighbour" is the wrong number and would be
 * alarmingly large. Half has an 11-bit mantissa: two depths must agree to within
 * 0.05% to collapse, and two samples 0.05% apart are two samples of ONE surface,
 * which carries ONE velocity. Trading one for the other costs nothing at all.
 * What is reported instead is how far the history sample position `huv` moves --
 * everything downstream, the Catmull-Rom, the variance clip, the feedback cap, is
 * a fixed function of `huv`, so that shift is the entire difference between the
 * two shaders rather than a proxy for it.
 *
 * AND IT IS SPLIT BY SILHOUETTE, which is the lesson PH19 paid for. A frame-wide
 * mean is dominated by flat geometry, where the dilation has nothing to do and
 * cannot be hurt; averaging it in drowns the one population the dilation exists
 * to serve. If this change breaks anything it breaks it on silhouettes, so the
 * silhouette bucket is the result and the frame mean is context.
 *
 * Translation by default (`--move=KeyW`) for the same reason `taataps` needs it:
 * under pure rotation near and far pixels reproject by nearly the same delta, so
 * every dilation agrees with every other and the run would score a flattering
 * zero without measuring anything.
 */
async function cmdTaahalf() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = engine.ctx.peek('render');

  // Same snapshot discipline as cmdTaataps: _prevVP is overwritten with _currVP
  // at the end of each frame, so the pair has to be cloned from inside the pass.
  let vp = null;
  const taa = r?.taa;
  const orig = taa?.render?.bind(taa);
  let prevPos = null, camMove = 0, camTurn = 0, prevQuat = null;
  if (taa) {
    taa.render = (renderer, colorTexture, gbuffer, invVP, prevVP) => {
      const cam = engine.camera;
      vp = { currVP: r._currVP.clone(), prevVP: r._prevVP.clone() };
      camMove = prevPos ? cam.position.distanceTo(prevPos) : 0;
      camTurn = prevQuat ? (cam.quaternion.angleTo(prevQuat) * 180) / Math.PI : 0;
      prevPos = cam.position.clone(); prevQuat = cam.quaternion.clone();
      return orig(renderer, colorTexture, gbuffer, invVP, prevVP);
    };
  }

  const frames = Number(argv.at ?? 90);
  const unmove = driveMove(engine, argv.move === undefined ? 'KeyW' : String(argv.move));
  const undrive = driveLook(engine, Number(argv.look ?? 1), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  unmove();
  if (taa) taa.render = orig;

  if (!vp) {
    restore();
    console.log(JSON.stringify({
      quality: Q,
      unavailable: 'TAA is off in this preset, so there is no dilation to price.',
    }, null, 2));
    return;
  }

  const { measureTaaHalfDepth } = await import('./taasim.mjs');
  const out = measureTaaHalfDepth(engine, {
    width: Number(argv.w ?? r.screenSize?.width ?? 1134),
    height: Number(argv.h ?? r.screenSize?.height ?? 737),
    currVP: vp.currVP, prevVP: vp.prevVP,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: frames,
    camera: {
      note: 'A run with movedMPerFrame at zero has measured a turning statue: pure '
        + 'rotation reprojects near and far by nearly the same delta, so no dilation '
        + 'can disagree with any other and the result would be a meaningless zero.',
      movedMPerFrame: +camMove.toFixed(4), turnedDegPerFrame: +camTurn.toFixed(3),
    },
    warning: camMove < 0.002
      ? 'THE CAMERA IS NOT TRANSLATING. This result says nothing about the change.'
      : undefined,
    ...out,
  }, null, 2));
}

/**
 * `viewrect` — is the viewmodel screen bound in `ow-view-composite` actually a
 * bound, on every frame of real combat?
 *
 * The pass skips its five viewmodel fetches wherever `uViewRect` says the gun
 * cannot be. The skip itself is not in question: the viewmodel target is cleared
 * to vec4(0), so on a pixel whose whole five-tap neighbourhood is empty the edge
 * test cannot fire, alpha is 0 and the pass already returns the world colour
 * unchanged. Everything therefore rests on the rectangle, and a rectangle that
 * is one texel too small does not look like a performance bug — it looks like a
 * clipped weapon.
 *
 * So this does not re-run the sphere maths and check it agrees with itself. It
 * projects EVERY VERTEX the viewmodel actually draws, through the full 4x4
 * projection matrix rather than the p00/p11 shortcut the renderer uses, and
 * reports how many texels of room were left between the outermost vertex and the
 * edge of the rectangle. The vertex bound is exact by construction: a triangle's
 * image is contained in the convex hull of its projected vertices whenever none
 * of them crosses the near plane, and the frames where one does are counted
 * separately and required to have fallen back to the whole screen.
 *
 * REQUIRED MARGIN IS 3 TEXELS, not zero. A pixel reads tView at +/-1 texel, and
 * a non-empty texel can sit up to a texel outside the vertex bound because
 * coverage is quantised to whole pixels. 2.5 texels bounds both; 3 is the round
 * number above it. The renderer adds 4 texels to a sphere bound that already
 * contains the vertices, so a healthy margin here is 4 or more and a margin
 * under 3 is a defect even though nothing visibly breaks yet.
 */
async function cmdViewrect() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = engine.ctx.peek('render');

  if (!r || r.directViewmodel || !r.viewComposite) {
    restore();
    console.log(JSON.stringify({
      quality: Q,
      unavailable: 'This preset draws the viewmodel directly into HDR, so there is no '
        + 'ow-view-composite pass and no rectangle to check.',
    }, null, 2));
    return;
  }

  // A pixel reads tView at +/-1 texel and coverage is quantised to whole pixels,
  // so a non-empty texel can sit up to 2.5 texels outside the vertex bound.
  const REACH = Number(argv.reach ?? 3);
  const W = r.screenSize.width, H = r.screenSize.height;
  const texX = 1 / W, texY = 1 / H;

  const frames = Number(argv.frames ?? 140);
  const samples = [];
  const kinds = { meshes: 0, skinned: 0, morph: 0, instanced: 0, noPosition: 0, noSphere: 0 };
  let peakMeshes = 0;

  // Grown on demand and reused across frames: this holds view-space positions
  // for the mesh being walked, and reallocating it 117 times a frame would make
  // the command slower than the thing it measures.
  let VBUF = new Float64Array(3 * 4096);

  // Per-mesh worst footprint, so a wide bound can be pinned on the object that
  // widened it.
  const spread = new Map();

  // Why a frame gave up, per mesh, so a full-screen result is diagnosable rather
  // than merely disappointing.
  // Keyed on mesh AND reason: the sphere clearance and the triangle clearance are
  // different quantities, and folding them into one row makes a metre of sphere
  // slack look like a metre of geometry poking through the eye.
  const blame = new Map();
  const note = (name, why, depth) => {
    const k = `${name} ${why}`;
    let e = blame.get(k);
    if (!e) blame.set(k, (e = { mesh: name, why, hits: 0, worstClearance: Infinity }));
    e.hits++;
    if (depth < e.worstClearance) e.worstClearance = depth;
  };

  const measure = (viewScene, viewCamera, rect) => {
    const rx = rect.x, ry = rect.y, rz = rect.z, rw = rect.w;

    const P = viewCamera.projectionMatrix.elements;
    const vm = viewCamera.matrixWorldInverse.elements;
    const near = viewCamera.near;
    const mv = new Float64Array(16);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let verts = 0, meshes = 0, nearCross = 0, culled = 0;
    let vbuf = VBUF;
    // The same footprint, counting only triangles that lie entirely in front of
    // the near plane. The gap between this and the full one IS the near-clip
    // smear, and that gap is what decides whether a tight bound can exist.
    let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
    let straddling = false;
    // The candidate bound accumulated over the same meshes, and the scratch the
    // box corners live in. See the block that fills them.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const bcx = new Float64Array(8), bcy = new Float64Array(8), bcz = new Float64Array(8);

    viewScene.traverseVisible((o) => {
      if (o.isMesh !== true && o.isInstancedMesh !== true) return;
      meshes++;
      kinds.meshes++;
      if (o.isInstancedMesh === true) { kinds.instanced++; return; }
      if (o.isSkinnedMesh === true) kinds.skinned++;
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) kinds.morph++;
      const geo = o.geometry;
      const pos = geo?.attributes?.position;
      if (!pos) { kinds.noPosition++; return; }
      if (!geo.boundingSphere) kinds.noSphere++;

      // Mirror of the renderer's own sphere test, purely to attribute a
      // full-screen frame to the mesh that caused it.
      if (geo.boundingSphere) {
        const e = o.matrixWorld.elements;
        const sc = Math.max(
          Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
        const bc = geo.boundingSphere.center;
        const wz = e[2] * bc.x + e[6] * bc.y + e[10] * bc.z + e[14];
        const wx = e[0] * bc.x + e[4] * bc.y + e[8] * bc.z + e[12];
        const wy = e[1] * bc.x + e[5] * bc.y + e[9] * bc.z + e[13];
        const cz = vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
        const clear = -cz - geo.boundingSphere.radius * sc - near;
        if (clear <= 0) note(o.name || geo.type || 'unnamed', 'sphere reaches near plane', clear);
      }

      // mv = matrixWorldInverse * matrixWorld, column-major.
      const mw = o.matrixWorld.elements;
      for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += vm[k * 4 + row] * mw[c * 4 + k];
          mv[c * 4 + row] = s;
        }
      }

      // View-space positions once per mesh, then triangles index into them. The
      // per-vertex matrix is the same for every triangle that shares a vertex,
      // so doing it in the triangle loop would repeat it six times over.
      const nv = pos.count;
      if (vbuf.length < nv * 3) vbuf = new Float64Array(nv * 3 * 2);
      for (let i = 0; i < nv; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        vbuf[i * 3] = mv[0] * x + mv[4] * y + mv[8] * z + mv[12];
        vbuf[i * 3 + 1] = mv[1] * x + mv[5] * y + mv[9] * z + mv[13];
        vbuf[i * 3 + 2] = mv[2] * x + mv[6] * y + mv[10] * z + mv[14];
      }

      // Which winding survives. This matters far more here than it would
      // anywhere else in a bound: the buttstock passes THROUGH the eye, and the
      // triangles that straddle the near plane there are the inside of a closed
      // solid. They clip to enormous polygons and then get culled, so counting
      // them turns a weapon in the corner into a bound over the whole screen.
      const mat = Array.isArray(o.material) ? null : o.material;
      if (mat && mat.visible === false) return;
      // A multi-material mesh draws each group under its own side setting, so
      // assume the most permissive of them rather than guessing per group.
      const side = mat ? mat.side : 2;
      const det = o.matrixWorld.determinant();
      let keepPos = side !== 1; // BackSide keeps CW, everything else CCW
      if (det < 0) keepPos = !keepPos;
      const cull = side === 2 ? 0 : keepPos ? 1 : -1;

      // This mesh's own footprint, so a wide frame can be attributed to the one
      // object that made it wide instead of to the viewmodel in general.
      let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;

      // ---- the CANDIDATE bound: the local AABB, near-clipped exactly --------
      //
      // Everything above this line is a measurement and could never ship: it
      // walks every triangle the weapon draws, which is the one thing the
      // rejected rectangle was rejected for needing. This block is the thing
      // that COULD ship, scored against it on the same frames.
      //
      // WHY A BOX AND NOT A SPHERE. The deleted rectangle bounded spheres, and
      // it gave up on 140 frames out of 140 on `-c.z - radius <= near`. That is
      // not a near-plane problem, it is a SHAPE problem: the bounding sphere of
      // a rifle has the radius of the rifle's LENGTH, so it reaches the eye
      // from half a metre away and a sphere touching the eye has no bounded
      // image. A box around the same rifle is thin in two of three axes.
      //
      // WHY CLIPPING THE BOX IS SOUND, which is the part the sphere version had
      // no answer to. y/(-z) is linear-fractional, so its extremes over a convex
      // polytope are attained at VERTICES of that polytope. The polytope here is
      // box ∩ { z <= -near }, whose vertices are (a) the box corners already in
      // front of the near plane and (b) the points where the box's twelve EDGES
      // cross it -- a plane cuts a convex solid in a polygon whose corners lie on
      // its edges, and there is nowhere else for one to be. Bounding those
      // twenty-at-most points therefore bounds the whole clipped box, and the
      // box contains the mesh, so it bounds the mesh's footprint too. No
      // triangle is ever visited.
      //
      // WHAT WOULD MAKE IT UNSOUND: a local box that does not contain the drawn
      // geometry, i.e. skinning or morphing, since three's boundingBox is the
      // bind pose. kinds.skinned / kinds.morph count those, and the report
      // refuses to recommend the bound if either is non-zero rather than
      // quietly averaging an invalid frame in.
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (bb) {
        const bmin = bb.min, bmax = bb.max;
        // Corner c: bit 0 picks x, bit 1 y, bit 2 z. Two corners share an edge
        // exactly when their indices differ in one bit, which is what the
        // edge loop below tests.
        for (let c = 0; c < 8; c++) {
          const lxv = (c & 1) ? bmax.x : bmin.x;
          const lyv = (c & 2) ? bmax.y : bmin.y;
          const lzv = (c & 4) ? bmax.z : bmin.z;
          bcx[c] = mv[0] * lxv + mv[4] * lyv + mv[8] * lzv + mv[12];
          bcy[c] = mv[1] * lxv + mv[5] * lyv + mv[9] * lzv + mv[13];
          bcz[c] = mv[2] * lxv + mv[6] * lyv + mv[10] * lzv + mv[14];
        }
        const takeBox = (vx, vy, vz) => {
          const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
          if (!(cw > 1e-9)) return;
          const ux = Math.min(1, Math.max(0, ((P[0] * vx + P[4] * vy + P[8] * vz + P[12]) / cw) * 0.5 + 0.5));
          const uy = Math.min(1, Math.max(0, ((P[1] * vx + P[5] * vy + P[9] * vz + P[13]) / cw) * 0.5 + 0.5));
          if (ux < bx0) bx0 = ux;
          if (ux > bx1) bx1 = ux;
          if (uy < by0) by0 = uy;
          if (uy > by1) by1 = uy;
        };
        for (let c = 0; c < 8; c++) if (bcz[c] <= -near) takeBox(bcx[c], bcy[c], bcz[c]);
        for (let c = 0; c < 8; c++) {
          for (let bit = 1; bit <= 4; bit <<= 1) {
            const d = c | bit;
            if (d === c) continue;          // that axis is already at max: not an edge
            const zs = bcz[c], zt = bcz[d];
            if ((zs <= -near) === (zt <= -near)) continue;
            const f = (zs + near) / (zs - zt);
            takeBox(bcx[c] + f * (bcx[d] - bcx[c]), bcy[c] + f * (bcy[d] - bcy[c]), -near);
          }
        }
      }

      const px = [0, 0, 0, 0], py = [0, 0, 0, 0], pz = [0, 0, 0, 0];
      const qx = [0, 0, 0, 0], qy = [0, 0, 0, 0];
      const emitPoly = (n) => {
        for (let i = 0; i < n; i++) {
          const cw = P[3] * px[i] + P[7] * py[i] + P[11] * pz[i] + P[15];
          if (!(cw > 1e-9)) return;
          qx[i] = (P[0] * px[i] + P[4] * py[i] + P[8] * pz[i] + P[12]) / cw;
          qy[i] = (P[1] * px[i] + P[5] * py[i] + P[9] * pz[i] + P[13]) / cw;
        }
        if (cull !== 0) {
          // Signed area in NDC is signed area in window coordinates, which is
          // exactly what glFrontFace/glCullFace decide on.
          let area = 0;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += qx[i] * qy[j] - qx[j] * qy[i];
          }
          if (cull > 0 ? !(area > 0) : !(area < 0)) { culled++; return; }
        }
        for (let i = 0; i < n; i++) {
          if (!straddling) {
            const ux = Math.min(1, Math.max(0, qx[i] * 0.5 + 0.5));
            const uy = Math.min(1, Math.max(0, qy[i] * 0.5 + 0.5));
            if (ux < fx0) fx0 = ux;
            if (ux > fx1) fx1 = ux;
            if (uy < fy0) fy0 = uy;
            if (uy > fy1) fy1 = uy;
          }
        }
        for (let i = 0; i < n; i++) {
          // Off-screen is not a hole in the bound: the side planes clip it, so
          // the rasterised footprint stops at the edge of the viewport.
          const ux = Math.min(1, Math.max(0, qx[i] * 0.5 + 0.5));
          const uy = Math.min(1, Math.max(0, qy[i] * 0.5 + 0.5));
          if (ux < x0) x0 = ux;
          if (ux > x1) x1 = ux;
          if (uy < y0) y0 = uy;
          if (uy > y1) y1 = uy;
          if (ux < lx0) lx0 = ux;
          if (ux > lx1) lx1 = ux;
          if (uy < ly0) ly0 = uy;
          if (uy > ly1) ly1 = uy;
          verts++;
        }
      };

      // Sutherland-Hodgman against the single plane vz = -near, keeping the half
      // space in FRONT of the camera. This is the whole reason the command
      // exists: a triangle with a vertex behind the eye does not project inside
      // the hull of its own vertices, so bounding the raw vertices would either
      // miss the footprint or invent an infinite one. Clipping first gives the
      // polygon the rasteriser actually sees, and the convex hull of THAT is
      // exact.
      const tri = (a, b, c) => {
        const ai = a * 3, bi = b * 3, ci = c * 3;
        const az = vbuf[ai + 2], bz = vbuf[bi + 2], cz = vbuf[ci + 2];
        const ain = az <= -near, bin = bz <= -near, cin = cz <= -near;
        if (ain && bin && cin) {
          straddling = false;
          px[0] = vbuf[ai]; py[0] = vbuf[ai + 1]; pz[0] = az;
          px[1] = vbuf[bi]; py[1] = vbuf[bi + 1]; pz[1] = bz;
          px[2] = vbuf[ci]; py[2] = vbuf[ci + 1]; pz[2] = cz;
          emitPoly(3);
          return;
        }
        if (!ain && !bin && !cin) return; // entirely behind the eye, never drawn
        straddling = true;
        nearCross++;
        note(o.name || geo.type || 'unnamed', 'triangle straddles the near plane',
          Math.max(-az, -bz, -cz) - near);
        let n = 0;
        const idx = [ai, bi, ci], ins = [ain, bin, cin];
        for (let e = 0; e < 3; e++) {
          const s = idx[e], t = idx[(e + 1) % 3];
          const si = ins[e], ti = ins[(e + 1) % 3];
          if (si) { px[n] = vbuf[s]; py[n] = vbuf[s + 1]; pz[n] = vbuf[s + 2]; n++; }
          if (si !== ti) {
            const f = (vbuf[s + 2] + near) / (vbuf[s + 2] - vbuf[t + 2]);
            px[n] = vbuf[s] + f * (vbuf[t] - vbuf[s]);
            py[n] = vbuf[s + 1] + f * (vbuf[t + 1] - vbuf[s + 1]);
            pz[n] = -near;
            n++;
          }
        }
        emitPoly(n);
      };

      // Exactly what the draw call touches: the index buffer through drawRange
      // when there is one, the position buffer through drawRange when there is
      // not. A geometry whose count is being grown per frame — the muzzle flash
      // and the brass are the ones that do this — has stale vertices past its
      // draw range, and bounding those would invent an excursion that never got
      // rasterised.
      const dr = geo.drawRange;
      const src = geo.index ?? pos;
      const total = src.count;
      const start = Math.max(0, dr ? dr.start : 0);
      const span = dr && Number.isFinite(dr.count) ? dr.count : total;
      const end = Math.min(total, start + span);
      if (geo.index) {
        const ix = geo.index;
        for (let i = start; i + 2 < end; i += 3) tri(ix.getX(i), ix.getX(i + 1), ix.getX(i + 2));
      } else {
        for (let i = start; i + 2 < end; i += 3) tri(i, i + 1, i + 2);
      }

      if (lx1 > lx0) {
        const nm = o.name || geo.type || 'unnamed';
        const a = (lx1 - lx0) * (ly1 - ly0);
        const e = spread.get(nm) ?? { mesh: nm, worstAreaFraction: 0, worstRectUV: null };
        if (a > e.worstAreaFraction) {
          e.worstAreaFraction = a;
          e.worstRectUV = [+lx0.toFixed(3), +ly0.toFixed(3), +lx1.toFixed(3), +ly1.toFixed(3)];
        }
        spread.set(nm, e);
      }
    });

    VBUF = vbuf;
    if (meshes > peakMeshes) peakMeshes = meshes;
    if (!verts) {
      samples.push({ empty: true, meshes, nearCross, area: (rz - rx) * (rw - ry) });
      return;
    }

    // What the shader must be allowed to see, clamped to the screen because a
    // pixel that does not exist cannot be got wrong.
    const nx0 = Math.max(0, x0 - REACH * texX), ny0 = Math.max(0, y0 - REACH * texY);
    const nx1 = Math.min(1, x1 + REACH * texX), ny1 = Math.min(1, y1 + REACH * texY);

    // The candidate bound gets the same reach allowance, because a shipped
    // rectangle would have to carry it for the same reason.
    const hasBox = bx1 >= bx0;
    const cx0 = hasBox ? Math.max(0, bx0 - REACH * texX) : 0;
    const cy0 = hasBox ? Math.max(0, by0 - REACH * texY) : 0;
    const cx1 = hasBox ? Math.min(1, bx1 + REACH * texX) : 1;
    const cy1 = hasBox ? Math.min(1, by1 + REACH * texY) : 1;
    // CONTAINMENT IS THE CORRECTNESS TEST, not the area. A candidate that is
    // merely small is a candidate that clips the player's weapon; the claim
    // being made is that box ∩ near-halfspace contains the drawn triangles, and
    // this is the frame-by-frame check of it. Reported in texels so a failure
    // reads as "it would have cut N pixels off the muzzle".
    const escapeTexels = Math.max(
      (cx0 - nx0) * W, (nx1 - cx1) * W, (cy0 - ny0) * H, (ny1 - cy1) * H);

    samples.push({
      meshes, verts, nearCross, culled,
      hasBox,
      boxArea: (cx1 - cx0) * (cy1 - cy0),
      escapeTexels,
      full: rx === 0 && ry === 0 && rz === 1 && rw === 1,
      area: (rz - rx) * (rw - ry),
      // The exact footprint the rasteriser fills, and therefore the smallest
      // rectangle any bound could ever be allowed to shrink to. This is the
      // ceiling on the whole idea, independent of how the bound is derived.
      trueArea: (nx1 - nx0) * (ny1 - ny0),
      tx0: nx0, ty0: ny0, tx1: nx1, ty1: ny1,
      frontArea: fx1 > fx0 ? (fx1 - fx0) * (fy1 - fy0) : 0,
      // Room left over AFTER the reach allowance. Negative on any side means the
      // pass can skip a pixel that would have shown weapon.
      mL: (nx0 - rx) * W, mR: (rz - nx1) * W,
      mB: (ny0 - ry) * H, mT: (rw - ny1) * H,
      // The bare vertex-to-edge distance, for reading the design margin off.
      rL: (x0 - rx) * W, rR: (rz - x1) * W,
      rB: (y0 - ry) * H, rT: (rw - y1) * H,
      // Which sides are sitting on the edge of the screen. A margin of exactly
      // zero there is the CLAMP, not a tight bound: the footprint is clamped to
      // [0,1] and so is the rectangle, so they coincide by construction, and no
      // pixel exists on the far side to get wrong. Without this distinction a
      // weapon running off the left of the frame reports "0 texels of room" and
      // reads as a near miss when there was nothing to miss.
      eL: rx <= 0, eR: rz >= 1, eB: ry <= 0, eT: rw >= 1,
    });
  };

  // Two ways in, because the command has to outlive the thing it was built to
  // check. If a RenderSystem._viewScreenRect exists, wrap it: the original runs
  // first and unmodified, so what gets measured is the shipping rectangle rather
  // than a re-implementation of it, and the margin columns are meaningful. If it
  // does not, observe the composite instead and score against the whole screen —
  // then the margins are trivially safe and the ceiling block is the answer.
  //
  // Either hook sits AFTER renderer.render(viewScene, viewCamera), which is what
  // refreshes the world matrices. Reading them earlier would bound the weapon
  // where it was last frame, and on recoil that is exactly the frame where a
  // bound would cut it.
  const FULL = { x: 0, y: 0, z: 1, w: 1 };
  const hooked = typeof r._viewScreenRect === 'function';
  let restoreHook;
  if (hooked) {
    const orig = r._viewScreenRect.bind(r);
    r._viewScreenRect = (viewScene, viewCamera) => {
      const rect = orig(viewScene, viewCamera);
      measure(viewScene, viewCamera, rect);
      return rect;
    };
    restoreHook = () => { r._viewScreenRect = orig; };
  } else {
    const vc = r.viewComposite;
    const orig = vc.render.bind(vc);
    vc.render = (renderer, out) => {
      const res = orig(renderer, out);
      measure(engine.viewScene, engine.viewCamera, FULL);
      return res;
    };
    restoreHook = () => { vc.render = orig; };
  }

  // Walk, shoot, aim, reload, melee, swap — every viewmodel excursion the game
  // has, in one run. Recoil and the reload are where the weapon travels
  // furthest, and the ADS blend is where it travels fastest.
  const script = [
    [0, 'KeyW', 'down'],
    [18, 'Mouse0', 'down'], [40, 'Mouse0', 'up'],
    [46, 'Mouse2', 'down'],
    [56, 'Mouse0', 'down'], [78, 'Mouse0', 'up'],
    [88, 'Mouse2', 'up'],
    [94, 'KeyR', 'down'], [96, 'KeyR', 'up'],
    [118, 'KeyV', 'down'], [120, 'KeyV', 'up'],
    [134, 'Digit2', 'down'], [136, 'Digit2', 'up'],
    [150, 'Mouse0', 'down'], [172, 'Mouse0', 'up'],
    [180, 'ShiftLeft', 'down'], [200, 'ShiftLeft', 'up'],
  ].filter(([f]) => f < frames);

  const undrive = driveScript(engine, script, Number(argv.look ?? 0.35));
  run(engine, rec, { frames, warm: 0 });
  undrive();
  restoreHook();
  restore();

  const seen = samples.filter((s) => !s.empty);
  const withVerts = seen.filter((s) => s.verts > 0);
  const minOf = (k) => withVerts.reduce((a, s) => Math.min(a, s[k]), Infinity);
  const worstSide = ['mL', 'mR', 'mB', 'mT'].map((k) => [k, minOf(k)]).sort((a, b) => a[0] - b[0]);
  const minMargin = withVerts.length ? Math.min(...worstSide.map((s) => s[1])) : Infinity;
  // The same minimum over sides that are NOT pinned to the edge of the screen.
  // Correctness only needs minMargin >= 0; this is the DESIGN margin, the room
  // a future weapon or near plane has before the rectangle starts cutting, and
  // it is the number the REACH requirement is really about.
  const offEdge = [['mL', 'eL'], ['mR', 'eR'], ['mB', 'eB'], ['mT', 'eT']]
    .map(([m, e]) => [m, withVerts.reduce((a, s) => (s[e] ? a : Math.min(a, s[m])), Infinity)]);
  const minFree = Math.min(...offEdge.map(([, v]) => v));
  const areas = seen.map((s) => s.area);
  const avgArea = areas.length ? areas.reduce((a, b) => a + b, 0) / areas.length : 1;
  const fullFrames = seen.filter((s) => s.full).length;
  const nearFrames = seen.filter((s) => s.nearCross > 0).length;
  // Every frame that clipped the near plane must have fallen back to the whole
  // screen; a frame that clipped AND narrowed is the one failure mode the sphere
  // maths cannot see, because the clipped edge is not on any sphere it tested.
  const clippedAndNarrowed = seen.filter((s) => s.nearCross > 0 && !s.full).length;

  const fails = withVerts
    .map((s, i) => ({ i, m: Math.min(s.mL, s.mR, s.mB, s.mT) }))
    .filter((s) => s.m < 0);

  const pct = (a, p) => {
    const v = a.slice().sort((x, y) => x - y);
    return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0;
  };
  const trueAreas = withVerts.map((s) => s.trueArea);
  const avgTrue = trueAreas.length ? trueAreas.reduce((a, b) => a + b, 0) / trueAreas.length : 1;
  const assumptionsHold = kinds.skinned === 0 && kinds.morph === 0 && kinds.instanced === 0;
  const candArea = withVerts.length ? withVerts.map((s) => s.boxArea) : null;
  const candAvg = candArea ? candArea.reduce((a, b) => a + b, 0) / candArea.length : 1;
  const ok = minMargin >= 0 && assumptionsHold;
  const widest = withVerts.slice().sort((a, b) => b.trueArea - a.trueArea)[0];

  console.log(JSON.stringify({
    quality: Q,
    frames, resolution: `${W}x${H}`, reachTexels: REACH,
    method: 'Every triangle the viewmodel draws, clipped against the near plane, projected '
      + 'through the full 4x4 matrix and compared against the shipping uViewRect. The '
      + 'renderer bounds spheres; this bounds the polygons the rasteriser actually fills, '
      + 'so the two disagree wherever the sphere maths is wrong.',
    framesMeasured: seen.length,
    framesWithGeometry: withVerts.length,
    boundInPlace: hooked,
    verdict: !withVerts.length
      ? 'NO GEOMETRY REACHED THE VIEWMODEL — this run proves nothing.'
      : !hooked
        ? 'No screen bound is installed. Read the ceiling block: it is what any bound could win.'
        : !ok
          ? 'DO NOT SHIP'
          : fullFrames === seen.length
            ? 'SAFE BUT WORTHLESS: the rect never narrowed, so the early-out never fired.'
            : `safe on all ${withVerts.length} frames: the drawn footprint never crossed the `
              + `rectangle. Design margin ${Number.isFinite(minFree) ? minFree.toFixed(2) : 'n/a'} `
              + `texels at the tightest side that is not pinned to the screen edge (${REACH} `
              + 'wanted); sides that ARE pinned read 0 by construction and cannot be missed.',
    // The point of the whole exercise: how much of the frame stops paying five
    // viewmodel fetches.
    saving: {
      avgRectAreaFraction: +avgArea.toFixed(4),
      minRectAreaFraction: +Math.min(...areas).toFixed(4),
      maxRectAreaFraction: +Math.max(...areas).toFixed(4),
      framesFullScreen: fullFrames,
    },
    // The ceiling. No bound, however clever, can shrink below the pixels the
    // weapon really covers — so if this is already most of the screen the idea is
    // dead on its merits rather than on its implementation.
    ceiling: {
      note: 'exact near-clipped footprint of the drawn viewmodel, widened by the filter '
        + 'reach. A perfect bound would save 1 minus the average.',
      avgTrueFootprintFraction: +avgTrue.toFixed(4),
      minTrueFootprintFraction: +Math.min(...trueAreas).toFixed(4),
      maxTrueFootprintFraction: +Math.max(...trueAreas).toFixed(4),
      // The mean is the wrong summary if a handful of melee frames carry it, so
      // the distribution is printed rather than described.
      p50: +pct(trueAreas, 0.5).toFixed(4),
      p75: +pct(trueAreas, 0.75).toFixed(4),
      p90: +pct(trueAreas, 0.9).toFixed(4),
      widestFrameRectUV: widest
        ? [+widest.tx0.toFixed(3), +widest.ty0.toFixed(3), +widest.tx1.toFixed(3), +widest.ty1.toFixed(3)]
        : null,
      bestCaseFetchesSavedPerFrame: Math.round((1 - avgTrue) * W * H * 5),
      backFacesCulled: seen.reduce((a, s) => a + (s.culled ?? 0), 0),
      // Everything above minus the near-clip smear. If this is small and the
      // number above is large, no bound can be tight, because the smear is real
      // fragments over most of the screen -- which is a rendering problem, not a
      // bounding one.
      avgFrontOnlyFootprintFraction: +(withVerts.reduce((a, s) => a + s.frontArea, 0)
        / Math.max(1, withVerts.length)).toFixed(4),
      maxFrontOnlyFootprintFraction: +Math.max(...withVerts.map((s) => s.frontArea)).toFixed(4),
      cullNote: 'Back faces are culled here exactly as the driver culls them. That is not '
        + 'a refinement: the buttstock passes through the eye, so the triangles that '
        + 'straddle the near plane are the inside of a closed solid and clip to enormous '
        + 'polygons that are then thrown away.',
      widestMeshes: [...spread.values()]
        .sort((a, b) => b.worstAreaFraction - a.worstAreaFraction)
        .slice(0, 6)
        .map((e) => ({ ...e, worstAreaFraction: +e.worstAreaFraction.toFixed(4) })),
    },
    // The candidate that could actually ship: the local AABB clipped against the
    // near plane, scored on the same frames as the ceiling above. Two questions,
    // and they are not the same question -- `escapeTexels` decides whether it is
    // ALLOWED, `avgAreaFraction` decides whether it is WORTH it, and a bound can
    // pass one and fail the other.
    candidate: candArea && {
      what: 'per-mesh local bounding box, its eight corners and the twelve edge/near-plane '
        + 'crossings projected and unioned. No triangle is visited, so unlike the ceiling '
        + 'above this is cheap enough to run every frame.',
      avgAreaFraction: +candAvg.toFixed(4),
      p50: +pct(candArea, 0.5).toFixed(4), p90: +pct(candArea, 0.9).toFixed(4),
      maxAreaFraction: +Math.max(...candArea).toFixed(4),
      framesFullScreen: candArea.filter((a) => a >= 0.9999).length,
      fetchesSavedPerFrame: Math.round((1 - candAvg) * W * H * 5),
      // How much of the perfect bound's saving this one actually collects. The
      // gap is the box's own slack plus whatever its clipped corners add.
      pctOfCeilingCaptured: avgTrue < 1
        ? +((100 * (1 - candAvg)) / (1 - avgTrue)).toFixed(1) : 0,
      containment: {
        note: 'texels by which the drawn footprint escapes the candidate, per frame, worst '
          + 'side. This is the correctness test and it must be <= 0 on EVERY frame: a '
          + 'positive number is the weapon being cut, not a bound being tight.',
        worstEscapeTexels: +Math.max(...withVerts.map((s) => s.escapeTexels)).toFixed(3),
        framesEscaping: withVerts.filter((s) => s.escapeTexels > 0).length,
        framesWithoutBox: withVerts.filter((s) => !s.hasBox).length,
      },
      // A bind-pose box does not bound a deformed mesh. If either count is
      // non-zero the numbers above are describing a bound that is not sound, and
      // saying so is the whole value of printing them.
      soundnessPreconditionsHold: assumptionsHold,
    },
    margins: {
      note: 'texels between the outermost drawn fragment (widened by the filter reach) and '
        + 'the rectangle. Negative on any side means a clipped weapon.',
      minAfterReach: +minMargin.toFixed(3),
      // Correctness is minAfterReach >= 0. This is the design margin: the same
      // minimum taken only over sides not pinned to the edge of the screen,
      // where a zero is the [0,1] clamp on both quantities rather than a bound
      // that came within a texel of cutting the weapon.
      minAfterReachOffScreenEdge: Number.isFinite(minFree) ? +minFree.toFixed(3) : null,
      perSide: Object.fromEntries(worstSide.map(([k, v]) => [k, +v.toFixed(3)])),
      perSideOffScreenEdge: Object.fromEntries(
        offEdge.map(([k, v]) => [k, Number.isFinite(v) ? +v.toFixed(3) : null])),
      minRawVertexToEdge: {
        left: +minOf('rL').toFixed(3), right: +minOf('rR').toFixed(3),
        bottom: +minOf('rB').toFixed(3), top: +minOf('rT').toFixed(3),
      },
      framesNegative: fails.length,
      worstFrames: fails.sort((a, b) => a.m - b.m).slice(0, 5),
    },
    nearPlane: {
      framesWithClippedTriangle: nearFrames,
      framesClippedButNarrowed: clippedAndNarrowed,
      note: 'Clipped triangles are handled exactly here, so this is diagnostic rather than '
        + 'a soundness condition: it says how often the renderer\'s sphere test is forced '
        + 'to give up, which is the only reason the rect would stay full-screen.',
    },
    // Which meshes gave the rectangle away. A full-screen result is usually ONE
    // mesh sitting on the near plane, and knowing which one is the difference
    // between abandoning the idea and fixing it.
    blame: [...blame.values()]
      .sort((a, b) => b.hits - a.hits)
      .slice(0, Number(argv.top ?? 12))
      .map((e) => ({ ...e, worstClearance: +e.worstClearance.toFixed(4) })),
    viewCameraNear: engine.viewCamera?.near ?? null,
    worldCameraNear: engine.camera?.near ?? null,
    // PH14 measured 111 rigid meshes and nothing else. If that ever stops being
    // true the bound loses its footing, so it is re-checked rather than recalled.
    geometry: {
      peakMeshesPerFrame: peakMeshes,
      meshVisits: kinds.meshes,
      skinned: kinds.skinned, morph: kinds.morph, instanced: kinds.instanced,
      withoutPosition: kinds.noPosition, withoutBoundingSphere: kinds.noSphere,
      note: 'skinned or morph above zero invalidates the bound outright: the vertices this '
        + 'command projects are the rest pose, and so is the bounding sphere the renderer uses.',
    },
  }, null, 2));

  // With no bound installed there is nothing to fail: the only thing that can
  // still go wrong is the rigid-geometry assumption a future bound would rest on.
  if (hooked ? !ok : !assumptionsHold) process.exitCode = 1;
}

async function cmdShadowcost() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const csm = engine.ctx.peek('render').csm;

  // The caster list is a scratch array RenderSystem refills every frame, and the
  // non-casters in it are hidden only for the duration of the CSM pass. Reading
  // it after the frame would therefore see a set that no longer matches. Snapshot
  // the objects that were actually visible at submission time instead.
  let snapshot = null;
  const origRender = csm.render.bind(csm);
  csm.render = function (renderer, scene, casters, nCasters) {
    if (casters) {
      const list = [];
      for (let k = 0; k < nCasters; k++) if (casters[k].visible !== false) list.push(casters[k]);
      snapshot = list;
    }
    return origRender(renderer, scene, casters, nCasters);
  };

  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });
  csm.render = origRender;

  let shaderSrc = '';
  for (const [, s] of rec.programs) {
    if (s.fragment.includes('OW_BLOCKER_TAPS')) { shaderSrc = s.fragment; break; }
  }

  const { measureShadowCost } = await import('./shadowsim.mjs');
  const out = measureShadowCost(engine, snapshot ?? [], snapshot?.length ?? 0, {
    width: Number(argv.w ?? 480),
    height: Number(argv.h ?? 300),
    shadowRes: Number(argv.smres ?? 0),
    shaderSrc,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: Number(argv.at ?? 90), stage: argv.stage ?? 'firefight',
    casterListLength: snapshot?.length ?? 0,
    ...out,
  }, null, 2));
}

/**
 * Where the shadow draw calls actually go, and what a size cull would buy.
 *
 * CSM is the largest single item in the frame -- 3.17 ms and 752 of 1153 draws
 * -- so it is the obvious place to cut. But the two obvious cuts (drop casters
 * whose shadow is sub-texel, drop casters that repeat across cascades) are only
 * worth their risk if they remove a lot, and neither is measurable by reading
 * the code. This counts both before anything is changed.
 */
async function cmdCsm() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = engine.ctx.peek('render');
  const csm = r.csm;

  // Per-cascade counts and the redundancy histogram have to be sampled from a
  // real frame, after update() has fitted the cascades to the live camera.
  const perCascade = [];
  const inNCascades = new Map();
  const sizeHist = [];
  const diag = {};
  const nearCull = new Int32Array(csm.cascades);
  let sampled = 0;

  // update() is the only place the VIEW camera is visible; render() only gets
  // the light cameras, and the depth test below is in view space.
  let viewCam = null;
  const origUpdate = csm.update.bind(csm);
  csm.update = function (camera, sunDir, softness) { viewCam = camera; return origUpdate(camera, sunDir, softness); };

  const origRender = csm.render.bind(csm);
  csm.render = function (renderer, scene, casters, nCasters) {
    if (sampled === 0 && casters) {
      sampled = 1;
      const seen = new Map();

      // Lower bound on any receiver point in the scene, so the shadow ray can
      // be stopped at a plane nothing is below. This has to come from bounding
      // BOXES: the road is a wide flat plane, and its bounding sphere reaches
      // ~118 m below it, which would make every shadow look unboundedly long.
      let groundY = Infinity;
      for (let k = 0; k < nCasters; k++) {
        const g = casters[k].geometry;
        if (!g) continue;
        if (g.boundingBox === null || g.boundingBox === undefined) g.computeBoundingBox?.();
        const bb = g.boundingBox;
        if (!bb) continue;
        const m = casters[k].matrixWorld.elements;
        // Lowest corner of the transformed AABB, without building a Box3.
        const cy = (bb.min.y + bb.max.y) * 0.5, hy = (bb.max.y - bb.min.y) * 0.5;
        const cx = (bb.min.x + bb.max.x) * 0.5, hx = (bb.max.x - bb.min.x) * 0.5;
        const cz = (bb.min.z + bb.max.z) * 0.5, hz = (bb.max.z - bb.min.z) * 0.5;
        const wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
        const ext = Math.abs(m[1]) * hx + Math.abs(m[5]) * hy + Math.abs(m[9]) * hz;
        groundY = Math.min(groundY, wy - ext);
      }
      const sun = csm._sunAxis;
      const splits = csm._splits;
      // Cascade i is first sampled where cascade i-1 starts cross-fading into
      // it, at 88% of cascade i-1's range -- not at its own near split.
      const sampleNear = [];
      for (let i = 0; i < csm.cascades; i++) {
        sampleNear.push(i === 0 ? 0 : splits[i - 1] + 0.88 * (splits[i] - splits[i - 1]));
      }
      diag.groundY = +groundY.toFixed(2);
      diag.sunY = +sun.y.toFixed(3);
      diag.splits = [...splits].map((x) => +x.toFixed(2));
      diag.cascadeFirstSampledAtDepthM = sampleNear.map((x) => +x.toFixed(2));
      for (let i = 0; i < csm.cascades; i++) {
        const center = csm._fitCenter[i];
        const rad = csm._fitRadius[i];
        const texelM = (2 * rad) / csm.mapSize;
        const axis = csm._sunAxis;
        const margin = (32 * (2 * rad)) / csm.mapSize;
        const rSide = rad + margin;
        const tFar = -rad - margin;
        const tNear = rad + csm._fitBack[i] + margin;
        let kept = 0;
        const texels = [];
        for (let k = 0; k < nCasters; k++) {
          const o = casters[k];
          if (o.visible === false) continue;
          let src = o.boundingSphere;
          if (src === undefined) {
            const g = o.geometry;
            if (!g) { kept++; continue; }
            if (g.boundingSphere === null) g.computeBoundingSphere();
            src = g.boundingSphere;
          }
          if (!src) { kept++; continue; }
          // Same slab+cylinder test render() uses, so "kept" here is exactly
          // what that cascade submits -- not an approximation of it.
          const c = src.center, m = o.matrixWorld.elements;
          const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
          const wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
          const wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
          const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
          const wr = src.radius * Math.max(sx, sy, sz);
          const dx = wx - center.x, dy = wy - center.y, dz = wz - center.z;
          const t = dx * axis.x + dy * axis.y + dz * axis.z;
          if (o.frustumCulled !== false) {
            if (t + wr < tFar || t - wr > tNear) continue;
            const perp2 = dx * dx + dy * dy + dz * dz - t * t;
            const lim = rSide + wr;
            if (perp2 > lim * lim) continue;
          }
          kept++;
          texels.push((2 * wr) / texelM);
          seen.set(o.id ?? k, (seen.get(o.id ?? k) ?? 0) + 1);

          // Would the proposed near-depth cull drop it from THIS cascade?
          // The shadow is the caster's sphere swept along -sun until it reaches
          // the lowest point anything in the scene occupies. If that whole swept
          // volume sits nearer than the depth where this cascade first gets
          // sampled, nothing it shades ever reads this cascade.
          if (i > 0 && viewCam && sun.y > 0.05) {
            const L = Math.max(0, (wy + wr - groundY) / sun.y);
            const e = viewCam.matrixWorldInverse.elements;
            const depthOf = (x, y, z) => -(e[2] * x + e[6] * y + e[10] * z + e[14]);
            const d0 = depthOf(wx, wy, wz);
            const d1 = depthOf(wx - sun.x * L, wy - sun.y * L, wz - sun.z * L);
            const maxDepth = Math.max(d0, d1) + wr;
            if (maxDepth < sampleNear[i] - 2) nearCull[i]++;
          }
        }
        texels.sort((a, b) => a - b);
        const pct = (p) => texels.length ? +texels[Math.floor((texels.length - 1) * p)].toFixed(1) : null;
        perCascade.push({
          cascade: i,
          fitRadiusM: +rad.toFixed(2),
          texelMm: +(texelM * 1000).toFixed(1),
          casters: kept,
          nearDepthCullWouldRemove: nearCull[i],
          // Diameter of each caster's bounding sphere in shadow texels. A caster
          // under ~2 texels cannot resolve a shadow the PCF kernel will show.
          casterTexelsP05: pct(0.05), casterTexelsMedian: pct(0.5), casterTexelsP95: pct(0.95),
          wouldCullUnder2Texels: texels.filter((x) => x < 2).length,
          wouldCullUnder4Texels: texels.filter((x) => x < 4).length,
          wouldCullUnder8Texels: texels.filter((x) => x < 8).length,
        });
        sizeHist.push(texels.length);
      }
      for (const n of seen.values()) inNCascades.set(n, (inNCascades.get(n) ?? 0) + 1);
    }
    return origRender(renderer, scene, casters, nCasters);
  };

  run(engine, rec, { frames: 4, warm: WARM });
  restore();

  const totalSubmitted = perCascade.reduce((p, c) => p + c.casters, 0);
  const nearCullTotal = [...nearCull].reduce((p, c) => p + c, 0);
  console.log(JSON.stringify({
    quality: Q,
    cascades: csm.cascades, mapSize: csm.mapSize, shadowDistanceM: csm.maxDistance,
    ...diag,
    perCascade,
    nearDepthCull: {
      removesSubmissions: nearCullTotal,
      ofTotal: totalSubmitted,
      pct: +((nearCullTotal / (totalSubmitted || 1)) * 100).toFixed(1),
    },
    casterSubmissionsPerFrame: totalSubmitted,
    // How many DISTINCT objects account for those submissions. The gap is the
    // redundancy: an object in three cascades is drawn three times.
    distinctCasters: [...inNCascades.values()].reduce((p, c) => p + c, 0),
    castersByCascadeCount: Object.fromEntries([...inNCascades.entries()].sort((a, b) => a[0] - b[0])),
    savingsIfCulled: {
      under2Texels: perCascade.reduce((p, c) => p + c.wouldCullUnder2Texels, 0),
      under4Texels: perCascade.reduce((p, c) => p + c.wouldCullUnder4Texels, 0),
      under8Texels: perCascade.reduce((p, c) => p + c.wouldCullUnder8Texels, 0),
    },
  }, null, 2));
}

/**
 * Runtime toggles for `ab`. Each must be flippable BETWEEN frames with no
 * resize, no reallocation and no simulation effect -- otherwise the two arms
 * are not measuring the same world and the paired difference is meaningless.
 * Anything that changes render-target wiring belongs in --qset and two separate
 * processes instead.
 */
const TOGGLES = {
  overrideBatch: async (r) => {
    const { OverrideBatcher } = await import('../../src/render/overridebatch.js');
    const batcher = r.overrideBatcher ?? new OverrideBatcher();
    return (on) => { r.overrideBatcher = on ? batcher : null; };
  },
  cascadeCull: async (r) => (on) => { r._noCascadeCull = !on; },
  // Honouring three's `castShadow` in the cascade pass. Flips the same field
  // `_visit` reads, so ON/OFF frames differ in nothing but that check.
  shadowCastFlag: async (r) => (on) => { r._shadowCastFlag = on; },

  /**
   * What the SHIPPED viewmodel screen rectangle costs on the CPU.
   *
   * This toggle used to reconstruct the old SPHERE version here in the tool,
   * because that version had been deleted from the engine and the open question
   * was what deleting it bought. Both halves of that are now stale: the sphere
   * bound is gone for good (its bounding radius was the rifle's LENGTH, so it
   * swallowed the eye and collapsed to full screen on 140 frames of 140), and a
   * box bound ships in `RenderSystem._viewScreenRect`. Measuring the sphere
   * would answer a question about code that exists nowhere.
   *
   * So ON is now the real method, unmodified -- the same traverseVisible, the
   * same 8 corners and 12 edge/near-plane crossings per mesh -- and OFF replaces
   * it with the full-screen answer it already gives up to, which is the cheapest
   * honest way to remove the work without removing the uniform. `off - on` is
   * therefore NEGATIVE by however much the traversal costs.
   *
   * READ THE RESULT AS CPU ONLY. The OFF arm hands the shader (0,0,1,1), so on
   * real hardware it would also make ow-view-composite pay its full 6 fetches on
   * every pixel; this harness has no GPU, so none of that appears here. The GPU
   * side is priced separately and exactly by `cod fill --real` (22.05 M -> 13.03
   * M fetches). This number is the other side of that trade, not a verdict on it.
   */
  viewScreenRect: async (r) => {
    let enabled = true;
    const real = r._viewScreenRect.bind(r);
    r._viewScreenRect = (viewScene, viewCamera) => (
      enabled ? real(viewScene, viewCamera) : r._viewRect.set(0, 0, 1, 1));
    return (on) => { enabled = on; };
  },
};

/**
 * Toggles whose ON arm RE-ADDS work that was deleted, rather than enabling
 * something the build ships.
 *
 * For those, `off - on` is negative exactly when the deletion was worth making,
 * and the default wording — "feature is faster" / "feature is SLOWER" — is not
 * merely backwards, it names the wrong thing: "the feature" here is the code
 * that is NOT in the build. A reader who corrects for the sign still has to
 * decide what noun the sentence is about, and that is the step that has been
 * getting missed since PH17.
 *
 * So this does not flip a sign. It replaces the sentence with one that names
 * the arm, and cmdAb also prints `onArmIs` so the convention is visible in the
 * output instead of living in a comment three hundred lines away.
 */
const TOGGLE_SENSE = {
  viewScreenRect: {
    onArmIs: 'ON runs the SHIPPED _viewScreenRect; OFF returns the full screen instead. '
      + 'CPU only: this harness has no GPU, so the fetches the rectangle saves are not '
      + 'in either arm. Those are priced by cod fill --real (22.05 M -> 13.03 M).',
    faster: 'Computing the rectangle is FASTER than not computing it, which cannot be '
      + 'true of the CPU alone — read this as no effect and check the pair count.',
    slower: 'Computing the rectangle costs this much CPU per frame. Weigh it against the '
      + '9.02 M fetches per frame it removes from ow-view-composite.',
  },
};

/**
 * A/B one feature by alternating it frame by frame inside a single process.
 *
 * Two separate runs cannot separate a 0.5 ms optimisation from a 0.5 ms drift in
 * CPU clock, thermal state or background load -- and on this laptop that drift
 * is real. Alternating frames pairs each ON measurement with the OFF
 * measurement 16 ms later, so anything slower than one frame cancels out.
 *
 * Reported: the median PAIRED difference (robust to the occasional GC spike),
 * the win rate, and a sign-test z. The sign test is the honest one -- it assumes
 * nothing about the distribution, only that under the null a pair is equally
 * likely to fall either way. |z| > 3 is a result; below that, report no effect.
 */
async function cmdAb() {
  const name = String(argv.toggle ?? '');
  const make = TOGGLES[name];
  if (!make) {
    console.error(`usage: --toggle=<${Object.keys(TOGGLES).join('|')}>`);
    process.exit(2);
  }

  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = engine.ctx.peek('render');
  const set = await make(r);

  const pairs = Math.floor(FRAMES / 2);
  const on = [];
  const off = [];
  const drawOn = [];
  const drawOff = [];
  // Alternate ON/OFF and, every other pair, swap which arm goes first. A fixed
  // order would let any first-of-pair systematic cost (a cache still warm from
  // the previous frame) load entirely onto one arm.
  run(engine, rec, {
    frames: pairs * 2, warm: WARM,
    onFrame: (i, rc, ms) => {
      const arm = (i & 1) === ((i >> 1) & 1);
      (arm ? on : off).push(ms);
      (arm ? drawOn : drawOff).push(rc.drawCalls);
      set(((i + 1) & 1) === (((i + 1) >> 1) & 1)); // arm of the NEXT frame
    },
  });
  restore();

  const n = Math.min(on.length, off.length);
  const diffs = [];
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const d = off[i] - on[i]; // positive == the feature is faster
    diffs.push(d);
    if (d > 0) wins++;
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : 0;
  // Sign test: under H0, wins ~ Binomial(n, 0.5).
  const z = n ? (wins - n / 2) / Math.sqrt(n / 4) : 0;

  // A toggle whose ON arm re-adds deleted work needs its own wording, not a
  // flipped sign -- see TOGGLE_SENSE.
  const sense = TOGGLE_SENSE[name];

  console.log(JSON.stringify({
    quality: Q, toggle: name, pairs: n,
    onArmIs: sense?.onArmIs,
    onMs: stats(on), offMs: stats(off),
    medianPairedDiffMs: +median.toFixed(4),
    meanPairedDiffMs: +(diffs.reduce((p, c) => p + c, 0) / (n || 1)).toFixed(4),
    winRate: +(wins / (n || 1)).toFixed(3),
    signTestZ: +z.toFixed(2),
    verdict: Math.abs(z) < 3
      ? 'no measurable effect'
      : sense
        ? (z > 0 ? sense.faster : sense.slower)
        : z > 0 ? 'feature is faster' : 'feature is SLOWER',
    drawCallsOn: stats(drawOn)?.median,
    drawCallsOff: stats(drawOff)?.median,
  }, null, 2));
}

/**
 * Closed-loop test of the resolution controller, with no engine and no GL.
 *
 * This is the one subsystem that decides whether the game is playable, and it
 * was the only one nothing could test. `AdaptiveResolution` only ever runs off
 * `EXT_disjoint_timer_query_webgl2`, and that extension is deliberately absent
 * from the GL mock, so every other command in this file exercises the frame-time
 * fallback and never the path that actually ships.
 *
 * The model is `gpuMs(s) = fixed + (cost - fixed) * s^2`: the fragment-bound part
 * of a frame falls with pixel count, the vertex, draw-submission and shadow parts
 * do not. That is why scaling resolution has a floor of usefulness, and the point
 * of this command is to find where that floor lands.
 *
 * `--inflate` exists because of a specific doubt. adaptive.js records, from the
 * real device, "every GPU frame came back at 480-1050 ms" while the game ran at
 * 10 fps -- but 10 fps is 100 ms, so the timer disagreed with the clock by five
 * to ten times. Feeding an inflated number to a controller that trusts it drives
 * render scale to its floor and keeps it there: a worse image and no more speed.
 * `--inflate=5` reproduces that.
 */
async function cmdAdaptive() {
  const { QUALITY_PRESETS } = await import('../../src/core/config.js');
  const { AdaptiveResolution } = await import('../../src/render/adaptive.js');
  const q = QUALITY_PRESETS[Q];
  if (!q) { console.error(`unknown quality ${Q}`); process.exit(2); }

  const cost = Number(argv.gpuMs ?? 63);      // true GPU ms at scale 1.0
  const fixed = Number(argv.fixed ?? 0.25) * cost; // part that does not scale with pixels
  const inflate = Number(argv.inflate ?? 1);
  const frames = Number(argv.frames ?? 1800);
  const cpuMs = Number(argv.cpuMs ?? 7);      // measured CPU render cost, 6.3-7.3 ms
  const target = q.targetFps ?? 60;

  const ctl = new AdaptiveResolution({
    maxScale: q.renderScale,
    minScale: q.minRenderScale ?? Math.min(q.renderScale, 0.6),
    targetFps: target,
    enabled: q.adaptiveResolution !== false,
  });

  const trueMs = (s) => fixed + (cost - fixed) * s * s;
  let scale = q.renderScale;
  let settledAt = null;
  const history = [];
  for (let i = 0; i < frames; i++) {
    const ms = trueMs(scale);
    // The wall clock cannot run faster than the slower of the two units. This
    // is what `observeFrame` sees on the device and what feeds the ceiling in
    // `sampleGpu` — the exact composition src/render/index.js ships.
    ctl.observeFrame(Math.max(ms, cpuMs));
    const next = ctl.sampleGpu(ms * inflate);
    if (next > 0 && Math.abs(next - scale) > 0.005) {
      scale = next;
      history.push({ frame: i, scale: +scale.toFixed(3), trueMs: +trueMs(scale).toFixed(1) });
      settledAt = null;
    } else if (settledAt === null && i > 240) settledAt = i;
  }

  const finalMs = trueMs(scale);
  console.log(JSON.stringify({
    quality: Q,
    model: {
      trueGpuMsAtScale1: cost, fixedMs: +fixed.toFixed(2), timerInflation: inflate, cpuMs,
    },
    timerSanity: {
      note: 'GPU readings held to the wall clock; clampedSamples > 0 means the timer was lying',
      clampedSamples: ctl.clampedSamples,
      lastRawMs: +ctl.lastGpuRawMs.toFixed(1),
      lastUsedMs: +ctl.lastGpuMs.toFixed(1),
    },
    ladder: ctl.scales.map((s) => +s.toFixed(3)),
    targetFps: target,
    settledScale: +scale.toFixed(3),
    settledTrueMs: +finalMs.toFixed(1),
    settledFps: +(1000 / finalMs).toFixed(1),
    reachesTarget: finalMs <= 1000 / target,
    atFloor: Math.abs(scale - ctl.scales[ctl.scales.length - 1]) < 0.005,
    resizes: ctl.changes,
    // A controller pinned at its floor has run out of authority: whatever is
    // left is not something resolution can fix.
    verdict: finalMs <= 1000 / target ? 'target reached'
      : Math.abs(scale - ctl.scales[ctl.scales.length - 1]) < 0.005
        ? 'PINNED AT FLOOR and still over budget'
        : 'settled above the floor but still over budget',
    changes: history.slice(0, 12),
  }, null, 2));
}

/**
 * What the volumetric upsample's depth weight does now that the tap depth
 * comes half-rounded out of the march target's alpha, and what rounding only
 * the tap -- rather than both sides of the comparison -- would have cost.
 *
 * That trade is worth 13.4 M fetches a frame and the centre-rounding beside it
 * is the part that is easy to get wrong silently, so it gets a command rather
 * than a paragraph. `--study` repeats it at three resolutions; the
 * disagreement RISES with resolution here (see volupsim.mjs), so the top row
 * is not a bound and the trend is the answer.
 */
async function cmdVolupsample() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  const frames = Number(argv.at ?? 90);
  const undrive = driveLook(engine, Number(argv.look ?? 1), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();

  const { measureVolUpsample } = await import('./volupsim.mjs');
  const sizes = argv.study
    ? [[480, 300], [760, 476], [1134, 736]]
    : [[Number(argv.w ?? 760), Number(argv.h ?? 476)]];
  const runs = sizes.map(([w, h]) => measureVolUpsample(engine, { width: w, height: h }));
  restore();
  console.log(JSON.stringify({
    quality: Q,
    lookDeg: Number(argv.look ?? 1),
    volScale: engine.ctx.peek('sky')?.volumetrics?.scale ?? null,
    runs,
  }, null, 2));
}

/**
 * Is an edge-directed reconstruction worth it when renderScale is below 1?
 *
 * `renderScale=0.72` is worth -45.1% of the post chain's fetches, more than every
 * shader optimisation of the last four sessions combined, and the only thing
 * standing between the internal image and the canvas is the bilinear filter
 * inside ow-composite's `texture2D( tColor, vUv )`. This asks whether the four
 * cross neighbours that pass ALREADY fetches can reconstruct the edges better,
 * against a supersampled reference. See upsim.mjs for why the flat-shaded
 * rasteriser is the right test signal for this one question and no other.
 *
 *   --scale=0.72   renderScale to simulate      --ss=3     supersample factor
 *   --w= --h=      display resolution           --pre=0.5  pre-exposure p90
 *   --srcss=N      source supersample; N=1 is an unconverged TAA history
 *   --mode=compare|sharpen|easu                 --out=DIR  write ref/best PNGs
 */
async function cmdUpsim() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  run(engine, rec, { frames: Number(argv.at ?? 90), warm: 0 });

  const { runUpsim, toRGBA, writePNG } = await import('./upsim.mjs');
  const shipped = Number(argv.sharpen ?? 0.22);
  const gate0 = Number(argv.gate0 ?? 0.02), gate1 = Number(argv.gate1 ?? 0.10);
  const mode = String(argv.mode ?? 'compare');

  const easu = (kAlong, kAcross, extra = {}) => ({
    label: `easu5 along=${kAlong} across=${kAcross}${extra.adaptive === false ? ' flat' : ''}`,
    filter: 'easu5', sharpen: extra.sharpen ?? shipped, dirBlur: !!extra.dirBlur,
    adaptive: extra.adaptive !== false,
    params: { kAlong, kAcross, gate0, gate1, clampToTaps: !argv.noclamp },
  });
  const plain = (sharpen, dirBlur, adaptive) => ({
    label: `bilinear sharpen=${sharpen}${dirBlur ? ' dir' : ' iso'}${adaptive ? '' : ' flat'}`,
    filter: 'bilinear', params: {}, sharpen, dirBlur, adaptive,
  });

  let arms;
  if (mode === 'sharpen') {
    // Is the shipped sharpen strength still right once the frame is upscaled,
    // and does the contrast roll-off help or hurt there?
    arms = [];
    for (const s of [0, 0.22, 0.35, 0.5, 0.7, 1.0]) {
      arms.push(plain(s, false, true));
      arms.push(plain(s, true, true));
      arms.push(plain(s, false, false));
      arms.push(plain(s, true, false));
    }
  } else if (mode === 'easu') {
    arms = [plain(shipped, false, true)];
    for (const kAlong of [0, 0.15, 0.3, 0.5, 0.75, 1.0]) {
      for (const kAcross of [0, 0.15, 0.3]) arms.push(easu(kAlong, kAcross));
    }
  } else if (mode === 'across') {
    // Two sharpening curves, each swept until it overshoots, so they can be read
    // off at MATCHED sharpness instead of at matched parameter. Comparing a
    // strong filter against a weak one only ever proves that the frame is soft.
    arms = [plain(shipped, false, true), plain(0, false, true)];
    for (const s of [0.25, 0.3, 0.35, 0.4, 0.5, 0.6]) arms.push(plain(s, false, false));
    for (const kAcross of [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
      arms.push({ ...easu(0, kAcross, { sharpen: 0 }), label: `easu5-across=${kAcross} (no shipped sharpen)` });
    }
  } else if (mode === 'ablate') {
    // Which PART of the winner is doing the work: the anisotropy, EASU's
    // edge-confidence `len`, or the contrast gate. An arm that scores the same
    // with a term removed does not need that term in the shader.
    arms = [plain(shipped, false, true), plain(0, false, true)];
    for (const kAcross of [0.6, 1.0, 1.5, 2.0, 3.0]) {
      arms.push({ ...easu(0, kAcross, { sharpen: 0 }), label: `across=${kAcross} len+gate` });
    }
    for (const kAcross of [0.6, 1.0, 1.5]) {
      arms.push({ ...easu(0, kAcross, { sharpen: 0 }), label: `across=${kAcross} gate only`, params: { kAlong: 0, kAcross, gate0, gate1, noLen: true, clampToTaps: !argv.noclamp } });
      arms.push({ ...easu(0, kAcross, { sharpen: 0 }), label: `across=${kAcross} len only`, params: { kAlong: 0, kAcross, gate0, gate1, noGate: true, clampToTaps: !argv.noclamp } });
      arms.push({ ...easu(0, kAcross, { sharpen: 0 }), label: `across=${kAcross} bare`, params: { kAlong: 0, kAcross, gate0, gate1, noLen: true, noGate: true, clampToTaps: !argv.noclamp } });
    }
  } else if (mode === 'final') {
    // The shortlist, run unchanged at every scale, frame and source cleanliness
    // so a win has to survive all of them rather than one flattering frame.
    const bare = (kAcross, s, clamp = true) => ({
      label: `across=${kAcross} sharpen=${s}${clamp ? '' : ' NOCLAMP'}`,
      filter: 'easu5', sharpen: s, dirBlur: false, adaptive: true,
      params: { kAlong: 0, kAcross, gate0, gate1, noLen: true, noGate: true, clampToTaps: clamp },
    });
    arms = [
      plain(shipped, false, true), plain(0, false, true),
      bare(0.6, 0), bare(1.0, 0), bare(1.5, 0),
      bare(0.4, shipped), bare(0.6, shipped), bare(1.0, shipped),
      bare(1.0, 0, false),
    ];
  } else if (mode === 'kappa') {
    // How strong the across-edge term should be, as a function of how far the
    // frame is being stretched. The answer decides whether the shader needs a
    // ramp or a switch.
    const bare = (kAcross, clamp = true, noLen = true) => ({
      label: `across=${kAcross}${clamp ? '' : ' NOCLAMP'}${noLen ? '' : ' +len'}`,
      filter: 'easu5', sharpen: shipped, dirBlur: false, adaptive: true,
      params: { kAlong: 0, kAcross, gate0, gate1, noLen, noGate: true, clampToTaps: clamp },
    });
    arms = [plain(shipped, false, true)];
    for (const k of [0.3, 0.5, 0.7, 1.0, 1.3, 1.6]) arms.push(bare(k));
    arms.push(bare(1.0, false), bare(1.0, false, false));
  } else if (mode === 'luma') {
    // Per-channel RGB against the luminance-gain form the shipped sharpen uses.
    // If they tie, the luminance form wins on principle: composite.js documents
    // the fringing bug a per-channel sharpen caused there once already.
    const one = (kAcross, lumaOnly, clamp = true) => ({
      label: `across=${kAcross} ${lumaOnly ? 'luma' : 'rgb '}${clamp ? '' : ' NOCLAMP'}`,
      filter: 'easu5', sharpen: shipped, dirBlur: false, adaptive: true,
      params: { kAlong: 0, kAcross, gate0, gate1, noLen: true, noGate: true, lumaOnly, clampToTaps: clamp },
    });
    arms = [plain(shipped, false, true)];
    for (const k of [0.5, 0.7, 1.0, 1.3]) { arms.push(one(k, false)); arms.push(one(k, true)); }
    arms.push(one(1.0, true, false));
  } else {
    arms = [
      plain(shipped, false, true),
      plain(shipped, true, true),
      easu(Number(argv.along ?? 0.5), Number(argv.across ?? 0.15)),
    ];
  }

  const scales = String(argv.scales ?? argv.scale ?? 0.72).split(',').map(Number);
  const runs = scales.map((scale) => runUpsim(engine, {
    scale,
    W: Number(argv.w ?? 768), H: Number(argv.h ?? 498),
    ss: Number(argv.ss ?? 3), srcSs: argv.srcss ? Number(argv.srcss) : null,
    pre: Number(argv.pre ?? 0.5), sharpen: shipped, arms,
  }));

  if (argv.out) {
    const dir = String(argv.out).replace(/\/$/, '');
    const r = runs[0];
    await writePNG(`${dir}/ref.png`, r._ref.w, r._ref.h, toRGBA(r._ref));
    for (const label of [arms[0].label, r.arms[0].label]) {
      const img = r._images.get(label);
      if (!img) continue;
      const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      await writePNG(`${dir}/${safe}.png`, img.w, img.h, toRGBA(img));
    }
  }
  restore();

  if (argv.table) {
    const pad = (s, n) => String(s).padStart(n);
    for (const r of runs) {
      console.log(`\n${r.display} <- ${r.internal}  scale ${r.scale}  upscale ${(1 / r.scale).toFixed(3)}  ss ${r.supersample}/${r.sourceSupersample}  pre ${r.preExposureP90}`);
      console.log(`${'filter'.padEnd(36)}${pad('psnr', 8)}${pad('edge', 8)}${pad('ssim', 10)}${pad('sharp', 8)}`);
      const row = (a) => console.log(`${String(a.label).padEnd(36)}${pad(a.psnr, 8)}${pad(a.edgePsnr, 8)}${pad(a.ssim, 10)}${pad(a.sharpness, 8)}`);
      row(r.control);
      for (const a of r.arms) row(a);
    }
  } else {
    console.log(JSON.stringify({
      quality: Q, at: Number(argv.at ?? 90),
      runs: runs.map(({ _images, _ref, _out, ...b }) => b),
    }, null, 2));
  }
}

/**
 * The geometry passes, priced in the same currency `fill` prices the post chain
 * in. See fwdsim.mjs for why the two obvious shortcuts -- overdraw's
 * shadedPerPixel and fragcost's per-fragment bound -- are each wrong by about a
 * factor of two and a factor of four respectively.
 *
 * The CSM term is not assumed: shadowsim is run in the same process, off the
 * same frame, so `owCsmTap` carries a figure with every early-out evaluated
 * rather than the 208-fetch static bound.
 */
async function cmdFwd() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);

  // Same hook and the same reason as cmdShadowcost: the caster array is scratch
  // that RenderSystem refills every frame, so it has to be snapshotted at
  // submission time.
  const csm = engine.ctx.peek('render').csm;
  let snapshot = null;
  const origRender = csm.render.bind(csm);
  csm.render = function (renderer, scene, casters, nCasters) {
    if (casters) {
      const list = [];
      for (let k = 0; k < nCasters; k++) if (casters[k].visible !== false) list.push(casters[k]);
      snapshot = list;
    }
    return origRender(renderer, scene, casters, nCasters);
  };

  const frames = Number(argv.at ?? 60);
  const undrive = driveLook(engine, Number(argv.look ?? 0), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  csm.render = origRender;

  let shaderSrc = '';
  for (const [, s] of rec.programs) {
    if (s.fragment.includes('OW_BLOCKER_TAPS')) { shaderSrc = s.fragment; break; }
  }

  const w = Number(argv.w ?? 480);
  const h = Number(argv.h ?? 300);

  const { measureShadowCost } = await import('./shadowsim.mjs');
  const shadow = measureShadowCost(engine, snapshot ?? [], snapshot?.length ?? 0, {
    width: w, height: h, shadowRes: 0, shaderSrc,
  });

  // The renderer's own material -> program map. See the long note in fwdsim.mjs
  // on why joining by SHADER_NAME instead loses more than half the frame.
  const props = engine.ctx.peek('render')?.renderer?.properties;
  const programOf = (mat) => props?.get(mat)?.currentProgram?.program?.__id ?? null;

  const { measureForwardCost } = await import('./fwdsim.mjs');
  const out = measureForwardCost(engine, {
    width: w, height: h,
    programs: rec.programs,
    programOf,
    csmFetchesPerReceiverPixel: shadow.fetchesPerReceiverPixel?.after ?? null,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: frames, stage: argv.stage ?? 'firefight',
    shadowBasis: {
      source: 'shadowsim, same frame',
      fetchesPerReceiverPixel: shadow.fetchesPerReceiverPixel,
      umbraEarlyOutPct: shadow.exits?.umbraEarlyOutPct,
      backfacingPct: shadow.pixels?.backfacingPct,
    },
    ...out,
  }, null, 2));
}

/**
 * `crtaps` — what TAA's five-tap Catmull-Rom history resample is worth, tap by
 * tap, and what a weight threshold on its four negative lobes costs the picture.
 *
 * The same shape of question `voltaps` asks of the volumetric march's shadow
 * taps, and the same answer shape: a lobe's weight is a closed-form function of
 * the fractional sample position and is therefore in hand BEFORE the fetch, so
 * "skip it when it is worth less than X" is a decision the shader can make for
 * free. `sampleCatmullRom` already divides by the surviving weight sum, because
 * the five-tap form is itself a renormalised subset of the sixteen-tap bicubic;
 * dropping a lobe uses the mechanism that is already there rather than adding
 * one. See crsim.mjs for the factored weights and for why the corner mass the
 * shipped filter ALREADY discards fixes the scale of a sensible threshold.
 *
 * Translation is on by default for the same reason `taataps` needs it: the
 * dilation feeds `huv`, and `huv` is the whole input to the filter under test.
 */
async function cmdCrtaps() {
  const restore = quiet();
  const { engine, rec } = await boot({ quality: Q, qset: QSET });
  engage(engine);
  const r = engine.ctx.peek('render');

  // _prevVP is overwritten with _currVP at the end of every frame, so the pair
  // is cloned from inside the pass -- same discipline as cmdTaataps.
  let vp = null;
  const taa = r?.taa;
  const orig = taa?.render?.bind(taa);
  let prevPos = null, camMove = 0, camTurn = 0, prevQuat = null;
  if (taa) {
    taa.render = (renderer, colorTexture, gbuffer, invVP, prevVP) => {
      const cam = engine.camera;
      vp = { currVP: r._currVP.clone(), prevVP: r._prevVP.clone() };
      camMove = prevPos ? cam.position.distanceTo(prevPos) : 0;
      camTurn = prevQuat ? (cam.quaternion.angleTo(prevQuat) * 180) / Math.PI : 0;
      prevPos = cam.position.clone(); prevQuat = cam.quaternion.clone();
      return orig(renderer, colorTexture, gbuffer, invVP, prevVP);
    };
  }

  const frames = Number(argv.at ?? 90);
  const unmove = driveMove(engine, argv.move === undefined ? 'KeyW' : String(argv.move));
  const undrive = driveLook(engine, Number(argv.look ?? 1), frames - 1);
  run(engine, rec, { frames, warm: 0 });
  undrive();
  unmove();
  if (taa) taa.render = orig;

  if (!vp) {
    restore();
    console.log(JSON.stringify({
      quality: Q, unavailable: 'TAA is off in this preset, so there is no history to resample.',
    }, null, 2));
    return;
  }

  const { measureCatmullRomTier } = await import('./crsim.mjs');
  const out = measureCatmullRomTier(engine, {
    W: Number(argv.w ?? 640), H: Number(argv.h ?? 416),
    ss: Number(argv.ss ?? 3), pre: Number(argv.pre ?? 0.5),
    // The pass's OWN texel grid, which is what `f` is taken against. Defaulting
    // this to the simulation width would quietly measure a different filter.
    resW: Number(argv.resw ?? r.screenSize?.width ?? 2268),
    resH: Number(argv.resh ?? r.screenSize?.height ?? 1473),
    freqW: Number(argv.freqw ?? 760), freqH: Number(argv.freqh ?? 494),
    // --chaink=0 turns the accumulation study off. It is a property of the
    // FILTER rather than of the frame, so the frame-to-frame and
    // resolution-to-resolution robustness runs do not need to pay for it.
    chainK: Number(argv.chaink ?? 8), chainSeeds: Number(argv.seeds ?? 6),
    thetas: String(argv.theta ?? '0.005,0.01,0.02,0.03,0.04,0.06').split(',').map(Number),
    currVP: vp.currVP, prevVP: vp.prevVP,
  });
  restore();

  console.log(JSON.stringify({
    quality: Q, at: frames,
    camera: { movedMPerFrame: +camMove.toFixed(4), turnedDegPerFrame: +camTurn.toFixed(3) },
    warning: camMove < 0.002 && camTurn < 0.01
      ? 'THE CAMERA IS NEITHER TURNING NOR MOVING. huv is vUv, f is exactly 0 on every '
        + 'pixel, every lobe weight is exactly 0 and the threshold would read as free. '
        + 'That is a true fact about a still camera and a useless one about the pass.'
      : undefined,
    ...out,
  }, null, 2));
}

const COMMANDS = {
  probe: cmdProbe, shaders: cmdShaders, fingerprint: cmdFingerprint, diff: cmdDiff,
  leak: cmdLeak, presets: cmdPresets, systems: cmdSystems, passes: cmdPasses,
  shot: cmdShot, overdraw: cmdOverdraw, drawlist: cmdDrawlist, targets: cmdTargets,
  ab: cmdAb, csm: cmdCsm, fragcost: cmdFragcost, shadowcost: cmdShadowcost, voltaps: cmdVoltaps,
  taataps: cmdTaataps, taahalf: cmdTaahalf, crtaps: cmdCrtaps,
  viewrect: cmdViewrect, mbdepth: cmdMbdepth,
  volupsample: cmdVolupsample, upsim: cmdUpsim,
  adaptive: cmdAdaptive, fill: cmdFill, fwd: cmdFwd, fillcost: cmdFillcost,
  gtaosteps: cmdGtaosteps, nbtaps: cmdNbtaps, mbtaps: cmdMbtaps, volsteps: cmdVolsteps,
  contactstep: cmdContactstep,
  glslcheck: cmdGlslcheck,
};

const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`usage: node tools/cli/cod.mjs <${Object.keys(COMMANDS).join('|')}>`);
  console.error(`       [--q=low|medium|high|ultra] [--frames=N] [--at=FRAME] [--verbose]`);
  console.error(`       [--qset=key=value,key2=value2]   override quality settings for one run`);
  console.error(`see the header of this file for what each command measures.`);
  process.exit(2);
}
await fn();
process.exit(process.exitCode ?? 0);

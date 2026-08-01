/**
 * Static per-fragment shader cost, lifted out of cod.mjs so the analysis is
 * importable on its own. Two exports: a small GLSL preprocessor and the fetch
 * counter built on it. No engine, no GL, no I/O -- pure source in, numbers out.
 */
/**
 * A minimal GLSL preprocessor: returns only the lines a driver would compile,
 * plus the macro values that survived.
 *
 * This exists because of one concrete false result. `fragcost` used to rank the
 * hot world materials at 136 fetches per fragment, of which 32 came from
 * `bicubic` -- on paper the single largest dynamic term in the frame, bigger
 * than the entire shadow pipeline, and duly written up as the next thing to
 * optimise. It was not real. `bicubic` belongs to three's
 * `transmission_pars_fragment`, which three pastes into every physical material
 * whether or not it transmits, and its only call site sits inside
 * `#ifdef USE_TRANSMISSION`. No world material defines that macro, so the driver
 * deletes the block outright. The tool was ranking deleted code first.
 *
 * A conditional this cannot decide is kept rather than dropped, so the result
 * stays an upper bound: this can only ever subtract cost that provably is not
 * compiled, never cost that might be.
 */
export function preprocessGlsl(lines) {
  const defines = new Map(); // name -> numeric value, or null for a bare flag
  const kept = [];
  const stack = []; // one frame per open #if, each { active, taken }
  const on = () => stack.every((s) => s.active);

  /** Fold a macro body down to a number, or null if it is not one. */
  const numeric = (raw) => {
    const t = String(raw ?? '').trim();
    if (!t) return null;
    if (/^[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
    let e = t;
    for (let i = 0; i < 4 && /[A-Za-z_]/.test(e); i++) {
      const before = e;
      e = e.replace(/\b[A-Za-z_]\w*\b/g, (n) => {
        const v = defines.get(n);
        return typeof v === 'number' ? String(v) : n;
      });
      if (e === before) break;
    }
    if (!/^[\d\s+\-*/%().eE]+$/.test(e)) return null;
    try { const v = Function(`"use strict";return (${e});`)(); return Number.isFinite(v) ? v : null; }
    catch { return null; }
  };

  /** true / false / null, where null means "undecidable, assume taken". */
  const truth = (raw) => {
    let e = String(raw ?? '')
      .replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (defines.has(n) ? '1' : '0'))
      .replace(/defined\s+(\w+)/g, (_, n) => (defines.has(n) ? '1' : '0'));
    for (let i = 0; i < 8 && /[A-Za-z_]/.test(e); i++) {
      const before = e;
      e = e.replace(/\b[A-Za-z_]\w*\b/g, (n) => {
        const v = defines.get(n);
        return typeof v === 'number' ? String(v) : n;
      });
      if (e === before) break;
    }
    // A function-like macro we could not expand means we are guessing; say so
    // rather than evaluating something that is not the expression the driver saw.
    if (/[A-Za-z_]\w*\s*\(/.test(e)) return null;
    // Anything still an identifier here is an undefined macro, which the
    // preprocessor substitutes with 0.
    e = e.replace(/\b[A-Za-z_]\w*\b/g, '0');
    if (!/^[\d\s+\-*/%()<>=!&|^~?:.]+$/.test(e)) return null;
    try { return !!Function(`"use strict";return (${e});`)(); }
    catch { return null; }
  };

  for (const line of lines) {
    const m = line.match(/^\s*#\s*(ifdef|ifndef|if|elif|else|endif|define|undef)\b(.*)$/);
    if (!m) { if (on()) kept.push(line); continue; }
    const [, dir, rest] = m;
    const parent = stack.slice(0, -1).every((s) => s.active);
    const top = stack[stack.length - 1];

    if (dir === 'ifdef' || dir === 'ifndef') {
      const name = (rest.match(/\w+/) ?? [''])[0];
      const v = dir === 'ifndef' ? !defines.has(name) : defines.has(name);
      stack.push({ active: on() && v, taken: v });
    } else if (dir === 'if') {
      const v = truth(rest) ?? true;
      stack.push({ active: on() && v, taken: v });
    } else if (dir === 'elif' && top) {
      const v = top.taken ? false : (truth(rest) ?? true);
      top.active = parent && v;
      top.taken = top.taken || v;
    } else if (dir === 'else' && top) {
      top.active = parent && !top.taken;
      top.taken = true;
    } else if (dir === 'endif') {
      stack.pop();
    } else if (dir === 'define' && on()) {
      const d = rest.match(/^\s+(\w+)([\s(].*)?$/);
      // Function-like macros (`#define F(x) ...`) have no scalar value; record
      // the name so `defined(F)` still answers correctly.
      if (d) defines.set(d[1], /^\(/.test(d[2] ?? '') ? null : numeric(d[2]));
    } else if (dir === 'undef' && on()) {
      defines.delete((rest.match(/\w+/) ?? [''])[0]);
    }
  }
  return { lines: kept, defines };
}

/**
 * Every spelling a texture fetch can have in one particular program.
 *
 * three compiles its GLSL1 sources against WebGL2 by prepending seven aliases --
 * `#define texture2D texture`, `#define textureCube texture` and friends -- so a
 * shader written the old way calls `texture2D` and never `texture`. A matcher
 * that only knows the GLSL3 spelling scores those shaders at ZERO fetches per
 * fragment, and it did: every post-processing pass in this project (gtao, ssr,
 * contact shadows, bloom, TAA, motion blur) read as free, while the world
 * materials -- which three writes in GLSL3 -- read at 104. The whole post chain
 * was invisible to `fragcost` and therefore to every ranking built on it.
 *
 * The aliases are read from the source itself rather than hard-coded, so a
 * three upgrade that renames them cannot quietly re-zero the same shaders.
 * Longest-first ordering matters: JS alternation is first-match-wins, so a bare
 * `texture` listed ahead of `textureLod` would eat the prefix and miss the `(`.
 *
 * READING THE ALIASES OFF THE SOURCE IS NOT ENOUGH ON ITS OWN, and the second
 * half of the list below is why. It only works when the source carries three's
 * prelude, which is true of what the GL mock records in `rec.programs` and
 * false of a raw `material.fragmentShader`. Every hand-written pass in
 * src/render is GLSL ES 1.00 and calls `texture2D` with no define in sight, so
 * `fragmentCost( pass.material.fragmentShader )` scored the entire post chain
 * at zero -- and zero is the dangerous direction, because a pass that reads as
 * free reads as already optimised. fillsim.mjs now prices sky-vol-composite
 * off its raw source exactly that way; it happens to be GLSL3 and survived,
 * and the same line on any of its neighbours would have reported a saving that
 * was not there. The GLSL1 spellings are therefore listed as builtins, which
 * they are: they are in the ES 1.00 spec, not something three invented, so
 * hard-coding them carries none of the rename risk the paragraph above avoids.
 */
export const FETCH_BUILTINS = [
  // GLSL ES 3.00
  'texelFetchOffset', 'textureProjGrad', 'textureProjLod', 'textureGather',
  'texelFetch', 'textureCube', 'textureGrad', 'textureProj', 'textureLod', 'texture',
  // GLSL ES 1.00, plus the EXT_shader_texture_lod spellings three emits when it
  // has to reach for explicit LOD in a fragment shader.
  'texture2DProjGradEXT', 'texture2DProjLodEXT', 'textureCubeGradEXT', 'textureCubeLodEXT',
  'texture2DGradEXT', 'texture2DProjLod', 'texture2DLodEXT', 'texture2DProj',
  'textureCubeLod', 'texture2DLod', 'texture2D'];

export function fetchRegex(src) {
  const names = new Set(FETCH_BUILTINS);
  for (const m of src.matchAll(/^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(\w+)[ \t]*$/gm)) {
    if (FETCH_BUILTINS.includes(m[2])) names.add(m[1]);
  }
  return new RegExp(`\\b(?:${[...names].sort((a, b) => b.length - a.length).join('|')})\\s*\\(`, 'g');
}

/**
 * Estimated DYNAMIC texture fetches per fragment, per program.
 *
 * `shaders` reports static call sites, which is close to useless as a cost
 * proxy: the world materials show 6 sites, but seven of those sites sit inside
 * loops -- PCSS alone is a 10-tap blocker search plus a 16-tap PCF disc -- so
 * the real number is several times higher and is where the GPU frame goes.
 * This walks the source tracking brace depth and loop bounds (resolving `#define`
 * trip counts like OW_PCF_TAPS) and weights each fetch by the product of the
 * loops enclosing it.
 *
 * It is an upper bound per branch taken, not a measurement: it cannot know how
 * often a dynamic branch is entered. It is still the only per-material fragment
 * cost signal available without a GPU, and the ranking it produces is the thing
 * you actually want.
 *
 * `live=false` reproduces the pre-preprocessor behaviour, which is what
 * `deadFetches` is measured against -- see preprocessGlsl for why that number
 * is worth printing rather than quietly dropping.
 */
export function fragmentCost(src, live = true) {
  const fetchRe = fetchRegex(src);
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  let clean = stripped;
  const defines = {};
  if (live) {
    const pre = preprocessGlsl(stripped);
    clean = pre.lines;
    for (const [k, v] of pre.defines) if (typeof v === 'number') defines[k] = v;
  } else {
    for (const l of clean) {
      const m = l.match(/^\s*#define\s+(\w+)\s+(\d+)\s*$/);
      if (m) defines[m[1]] = Number(m[2]);
    }
  }

  // Split into function bodies. The fetches that matter are not in main() --
  // they are in owCsmTap, called from inside the PCSS blocker and PCF loops, so
  // a purely lexical walk of main() sees nothing and reports a 26-tap shadow
  // shader as costing 8 fetches. Cost has to propagate through calls.
  //
  // Bodies are found by brace-matching FORWARD from each definition rather than
  // by tracking a global depth: three's chunk soup contains at least one
  // unbalanced brace (a multi-line signature in the iridescence chunk), and a
  // global counter never returns to zero after it, so every later function --
  // including main -- becomes invisible.
  const text = clean.join('\n');
  const fns = new Map();
  const consumed = [];
  const defRe = /(?:^|\n)\s*(?:highp\s+|mediump\s+|lowp\s+)?(?:void|float|int|uint|bool|vec[234]|ivec[234]|bvec[234]|mat[234](?:x[234])?)\s+(\w+)\s*\(/g;
  for (const m of text.matchAll(defRe)) {
    const name = m[1];
    if (consumed.some(([a, b]) => m.index >= a && m.index < b)) continue;
    // Walk to the '{' that opens the body; bail if a ';' arrives first (that is
    // a forward declaration, not a definition).
    let i = m.index + m[0].length, par = 1;
    while (i < text.length && par > 0) { const c = text[i]; if (c === '(') par++; else if (c === ')') par--; i++; }
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') continue;
    let d = 0, start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') d++;
      else if (text[i] === '}') { d--; if (d === 0) { i++; break; } }
    }
    // An unterminated body means this definition sat on the wrong side of the
    // stray brace. Recording it would consume the rest of the file -- including
    // main() -- and silently zero the whole shader's cost.
    if (d !== 0) continue;
    consumed.push([start, i]);
    fns.set(name, text.slice(start, i).split('\n'));
  }
  // Everything outside a function body: global initialisers and stray chunks.
  let cursor = 0;
  const topLevel = [];
  for (const [a, b] of consumed.sort((x, y) => x[0] - y[0])) {
    topLevel.push(text.slice(cursor, a));
    cursor = b;
  }
  topLevel.push(text.slice(cursor));

  /** Direct fetches and outgoing calls in one body, each weighted by its loops. */
  const analyse = (lines) => {
    const loops = [];
    let d = 0, direct = 0, sites = 0, nest = 0;
    const calls = new Map();
    for (const l of lines) {
      const forM = l.match(/\bfor\s*\(\s*(?:int|float|uint)?\s*\w+\s*=\s*[^;]*;\s*[^;<>!]*[<!]=?\s*([\w.]+)/);
      if (forM) {
        const b = forM[1];
        const trips = /^\d+$/.test(b) ? Number(b)
          : /^\d+\.\d*$/.test(b) ? Math.ceil(Number(b))
            : defines[b] ?? 8;
        loops.push({ d, trips });
      }
      const w = loops.reduce((p, c) => p * c.trips, 1);
      const f = (l.match(fetchRe) ?? []).length;
      if (f) { direct += f * w; sites += f; nest = Math.max(nest, loops.length); }
      for (const m of l.matchAll(/\b(\w+)\s*\(/g)) {
        const n = m[1];
        if (fns.has(n)) calls.set(n, (calls.get(n) ?? 0) + w);
      }
      for (const ch of l) {
        if (ch === '{') d++;
        else if (ch === '}') { d--; while (loops.length && loops[loops.length - 1].d >= d) loops.pop(); }
      }
    }
    return { direct, sites, nest, calls };
  };

  const info = new Map();
  for (const [n, lines] of fns) info.set(n, analyse(lines));
  info.set('__top__', analyse(topLevel.join('\n').split('\n')));

  // GLSL forbids recursion, so repeated relaxation converges; the bound is the
  // call-graph depth and a handful of passes is far past it.
  const cost = new Map([...info.keys()].map((k) => [k, 0]));
  for (let pass = 0; pass < 12; pass++) {
    for (const [n, v] of info) {
      let c = v.direct;
      for (const [callee, w] of v.calls) c += w * (cost.get(callee) ?? 0);
      cost.set(n, c);
    }
  }

  const mainCost = cost.get('main') ?? 0;
  const worst = [...cost.entries()].filter(([k]) => k !== 'main' && k !== '__top__')
    .sort((a, b) => b[1] - a[1])[0];

  // Split the total across the functions whose OWN texture() calls produce it.
  // `costliestCallee` names one function and stops; a shader at 136 fetches with
  // owSunShadow at 52 leaves 84 unaccounted for, and those 84 are where the next
  // optimisation has to come from. Invocations per fragment propagate down the
  // call graph exactly as cost propagates up, so inv[f] * direct[f] summed over
  // every f reconstructs mainCost -- this is a decomposition, not an estimate.
  let inv = new Map([['main', 1]]);
  for (let pass = 0; pass < 12; pass++) {
    const next = new Map([['main', 1]]);
    for (const [n, v] of info) {
      const iv = inv.get(n) ?? 0;
      if (iv === 0) continue;
      for (const [callee, w] of v.calls) next.set(callee, (next.get(callee) ?? 0) + iv * w);
    }
    inv = next;
  }
  const attributed = [...info.entries()]
    .map(([n, v]) => [n, (inv.get(n) ?? 0) * v.direct])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);

  const all = [...info.values()];
  const out = {
    staticSites: all.reduce((p, c) => p + c.sites, 0),
    dynamicFetches: mainCost,
    maxLoopNesting: Math.max(...all.map((c) => c.nest), 0),
    costliestCallee: worst && worst[1] > 0 ? `${worst[0]}=${worst[1]}` : null,
    fetchesByFunction: Object.fromEntries(attributed.slice(0, 8)),
  };
  // Report what the preprocessor removed instead of just being quietly right.
  // A silent correction here would have looked identical to the tool having been
  // right all along, and this number is exactly the size of the mistake.
  if (live) out.deadFetches = fragmentCost(src, false).dynamicFetches - mainCost;
  return out;
}

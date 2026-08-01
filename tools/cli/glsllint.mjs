/**
 * A scope checker for the GLSL this project actually ships.
 *
 * It exists because of a hole big enough to drive a broken build through: the
 * GL mock never compiles a shader. `getShaderParameter` answers "fine" to
 * everything, so a fragment shader that references a uniform somebody just
 * deleted passes `probe`, `fill`, `fragcost`, `passes`, `leak` and the pixel
 * diffs identically to a correct one — every measurement in this toolchain
 * agrees the frame is perfect, and the first thing that disagrees is the user's
 * screen. Editing a shader without this is editing blind.
 *
 * The check is deliberately narrow: find every identifier a shader USES that
 * nothing declares. That is the failure mode a shader edit actually has —
 * delete a uniform and miss a reader, rename a local, drop a varying from one
 * stage of the pair — and it is decidable by lexing alone, with no type system
 * and no GLSL grammar to get subtly wrong. Anything needing real semantics
 * (a type mismatch, a wrong swizzle) is out of scope and stays out of scope,
 * because a checker that is wrong about hard cases would poison the easy ones.
 *
 * Sources are run through the same preprocessor `fragcost` uses, so code the
 * driver deletes cannot raise a finding.
 */
import { preprocessGlsl } from './fragcost.mjs';

/** GLSL ES 3.00 keywords, types and qualifiers -- never identifiers. */
const KEYWORDS = new Set([
  'const', 'uniform', 'buffer', 'shared', 'attribute', 'varying', 'coherent', 'volatile',
  'restrict', 'readonly', 'writeonly', 'layout', 'centroid', 'flat', 'smooth', 'noperspective',
  'patch', 'sample', 'invariant', 'precise', 'break', 'continue', 'do', 'for', 'while', 'switch',
  'case', 'default', 'if', 'else', 'subroutine', 'in', 'out', 'inout', 'discard', 'return',
  'lowp', 'mediump', 'highp', 'precision', 'struct', 'true', 'false', 'void',
  'float', 'double', 'int', 'uint', 'bool',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4',
  'uvec2', 'uvec3', 'uvec4', 'dvec2', 'dvec3', 'dvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DShadow', 'samplerCubeShadow',
  'sampler2DArray', 'sampler2DArrayShadow', 'isampler2D', 'isampler3D', 'isamplerCube',
  'isampler2DArray', 'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DArray',
]);

/** Built-in functions and variables of GLSL ES 3.00, plus the WebGL1 aliases three defines. */
const BUILTINS = new Set([
  // trig / exponential / common
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'asinh', 'acosh', 'atanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract', 'mod', 'modf',
  'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'isnan', 'isinf',
  'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat',
  // geometric / matrix / vector-relational
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
  'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse',
  'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual',
  'any', 'all', 'not',
  // texture
  'texture', 'textureProj', 'textureLod', 'textureOffset', 'texelFetch', 'texelFetchOffset',
  'textureProjOffset', 'textureLodOffset', 'textureProjLod', 'textureProjLodOffset',
  'textureGrad', 'textureGradOffset', 'textureProjGrad', 'textureProjGradOffset',
  'textureSize', 'textureGather', 'textureGatherOffset',
  'texture2D', 'texture2DProj', 'texture2DLod', 'texture2DProjLod', 'textureCube',
  'textureCubeLod', 'texture2DLodEXT', 'texture2DProjLodEXT', 'textureCubeLodEXT',
  'texture2DGradEXT', 'texture2DProjGradEXT', 'textureCubeGradEXT',
  // derivatives / packing
  'dFdx', 'dFdy', 'fwidth', 'packSnorm2x16', 'unpackSnorm2x16', 'packUnorm2x16',
  'unpackUnorm2x16', 'packHalf2x16', 'unpackHalf2x16',
  // special variables
  'gl_Position', 'gl_PointSize', 'gl_VertexID', 'gl_InstanceID', 'gl_FragCoord',
  'gl_FrontFacing', 'gl_PointCoord', 'gl_FragDepth', 'gl_FragColor', 'gl_FragData',
  'gl_DepthRange', 'gl_MaxDrawBuffers',
]);

/**
 * Names a source DECLARES.
 *
 * Struct fields are collected as declared names too. They are only ever reached
 * through a `.`, and the use-scan already drops anything after a dot, so this
 * costs nothing and removes a whole class of false positive if that ever changes.
 */
function declaredIn(text) {
  const out = new Set();
  const add = (n) => { if (n && !KEYWORDS.has(n)) out.add(n); };

  // #define NAME  and  #define NAME(args)
  for (const m of text.matchAll(/^[ \t]*#[ \t]*define[ \t]+(\w+)\s*(\([^)]*\))?/gm)) {
    add(m[1]);
    if (m[2]) for (const a of m[2].slice(1, -1).split(',')) add(a.trim());
  }
  // struct NAME { ... }
  for (const m of text.matchAll(/\bstruct\s+(\w+)/g)) add(m[1]);
  // Function definitions and declarations, with their parameter names.
  for (const m of text.matchAll(/\b(?:\w+)\s+(\w+)\s*\(([^)]*)\)\s*[{;]/g)) {
    add(m[1]);
    // The array suffix goes first: three passes light probes as
    // `in vec3 shCoefficients[ 9 ]`, and taking "the last word" off that gets
    // the bracket rather than the name.
    for (const p of m[2].replace(/\[[^\]]*\]/g, '').split(',')) {
      const t = p.trim().split(/\s+/).filter(Boolean);
      if (t.length >= 2) add(t[t.length - 1].replace(/\W/g, ''));
    }
  }
  // Declarations, found by splitting into statements rather than by one large
  // regex. A single regex cannot do this: `;` both terminates a declaration and
  // introduces the next one, so a global match consumes the separator the
  // following declaration needs and every second declaration goes missing --
  // which is exactly the bug that made the first version of this file report
  // `uniform sampler2D tColor` as undeclared.
  //
  // A statement is a declaration when its first non-qualifier word is a type:
  // `uniform sampler2D tDepth`, `varying float vViewDepth`, `vec3 a, b = x`,
  // `const highp int N = 4`, and the initialiser clause of `for ( int i = 0;`.
  const QUAL = /^(?:const|uniform|attribute|varying|in|out|inout|flat|smooth|noperspective|centroid|sample|invariant|precise|lowp|mediump|highp|layout)$/;
  // Directives are line-terminated, not `;`-terminated, so splitting on `;`
  // glues a `#define` onto the declaration that follows it and the whole
  // statement then fails to parse as one. They are collected above anyway.
  const body = text.replace(/^[ \t]*#[^\n]*$/gm, '');
  for (let stmt of body.split(/[;{}]/)) {
    // `layout( location = 0 ) out vec4 pc_fragColor` and `for ( int i = 0`.
    stmt = stmt.replace(/\blayout\s*\([^)]*\)/g, ' ').replace(/^[\s\S]*?\bfor\s*\(/, '');
    const words = stmt.trim().split(/\s+/);
    let i = 0;
    while (i < words.length && QUAL.test(words[i])) i++;
    const type = words[i];
    if (!type || (!KEYWORDS.has(type) && !out.has(type))) continue;
    if (type === 'void' || type === 'struct' || type === 'precision' || type === 'return') continue;
    // Everything after the type, comma-separated: `a, b = f(x), c[4]`.
    const rest = words.slice(i + 1).join(' ');
    // A trailing `(` means this was a function signature, already handled above.
    if (/^\s*\w+\s*\(/.test(rest)) continue;
    let depth = 0, cur = '';
    for (const ch of `${rest},`) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { const n = cur.trim().match(/^([A-Za-z_]\w*)/); if (n) add(n[1]); cur = ''; }
      else cur += ch;
    }
  }
  return out;
}

/**
 * What three's ShaderMaterial prefix declares for every program it compiles.
 *
 * Sources taken off `rec.programs` already carry that prefix, so this changes
 * nothing for them. It exists so a pass that never COMPILED during a capture --
 * depth of field only runs while the sights are up, the low-health overlay only
 * below a health threshold -- can be linted from its material's own sources
 * instead of going unchecked, which is where an edit is least likely to be
 * caught by anything else.
 */
const THREE_PROVIDED = new Set([
  'position', 'normal', 'uv', 'tangent', 'color', 'instanceMatrix', 'instanceColor',
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition', 'isOrthographic', 'logDepthBufFC', 'vFragDepth', 'vIsPerspective',
  'gl_FragColor', 'pc_fragColor', 'gl_Position', 'gl_FragCoord', 'gl_FrontFacing',
  'gl_PointCoord', 'gl_PointSize', 'gl_FragDepth', 'gl_VertexID', 'gl_InstanceID',
]);

/** Identifiers a source USES, excluding field accesses and declarations' own names. */
function usedIn(text) {
  const out = new Set();
  // Drop struct/field access (`.xyz`, `.material.roughness`) and #directive names,
  // neither of which resolves against the identifier scope.
  const scan = text
    .replace(/^[ \t]*#[^\n]*$/gm, '')
    // `layout( location = 0 )` names a GL binding point, not a variable.
    .replace(/\blayout\s*\([^)]*\)/g, ' ')
    .replace(/\.\s*\w+/g, '.');
  for (const m of scan.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    if (!KEYWORDS.has(m[0]) && !BUILTINS.has(m[0])) out.add(m[0]);
  }
  return out;
}

/**
 * Interface variables of one stage: name -> { qualifier, type }, for the
 * `in`/`out`/`varying` declarations only.
 *
 * `varying` is included because three rewrites it per stage (`#define varying
 * out` in the vertex prefix, `#define varying in` in the fragment one), so a
 * source that spells it the ESSL 1.00 way declares the same interface variable
 * as one that spells it `out`.
 */
function interfaceOf(text, stage) {
  const out = new Map();
  const re = new RegExp(
    `^\\s*(?:(flat|smooth|noperspective|centroid)\\s+)?(?:(flat|smooth|noperspective|centroid)\\s+)?`
    + `(${stage === 'vertex' ? 'out|varying' : 'in|varying'})\\s+(\\w+)\\s+(\\w+)\\s*(\\[[^\\]]*\\])?\\s*;`,
    'gm'
  );
  for (const m of text.matchAll(re)) {
    // `in` also introduces function parameters and `layout` blocks; both are
    // excluded by requiring the declaration to be a whole statement at the
    // start of a line, which is how every stage interface in this project is
    // written.
    out.set(m[5], { qualifier: m[1] ?? m[2] ?? 'smooth', type: m[4] });
  }
  return out;
}

/**
 * Cross-stage agreement for everything the vertex stage hands the fragment one.
 *
 * A varying declared `flat out float` in one stage and `float` (i.e. smooth) in
 * the other is a LINK error, and it is invisible to every other tool here: it is
 * not an undeclared identifier, the GL mock never links, and `fill`, `fragcost`
 * and the pixel diffs would all report the frame as perfect. The failure mode is
 * specific to this codebase's main optimisation pattern -- hoisting a
 * frame-constant fetch to the vertex stage and passing it down `flat` -- so the
 * check exists exactly where the mistake is easy to make. A type mismatch is the
 * same class of error and comes free from the same declarations.
 *
 * Only names the fragment stage actually declares are compared. A vertex output
 * nothing downstream reads is legal and common (three's prefix emits several).
 */
function crossStage(vertex, fragment) {
  const v = interfaceOf(vertex, 'vertex');
  const f = interfaceOf(fragment, 'fragment');
  const bad = [];
  for (const [name, fd] of f) {
    const vd = v.get(name);
    if (!vd) continue;
    if (vd.qualifier !== fd.qualifier) {
      bad.push(`${name}: vertex is ${vd.qualifier}, fragment is ${fd.qualifier}`
        + ' -- interpolation qualifiers must match or the program will not link');
    }
    if (vd.type !== fd.type) {
      bad.push(`${name}: vertex declares ${vd.type}, fragment declares ${fd.type}`);
    }
  }
  return bad;
}

/**
 * @param sources  { vertex, fragment } as the driver would receive them.
 * @returns { vertex: string[], fragment: string[], varyings: string[] } --
 *          undeclared identifiers per stage, plus cross-stage disagreements.
 *
 * The two stages are checked against a SHARED declaration set on purpose. three
 * splits `#define`s and struct definitions unevenly across the pair, and this
 * checker's job is finding deleted references, not policing which stage owns a
 * declaration -- a shared set trades away a class of finding nobody would act on
 * for the absence of a false-positive wall nobody would read.
 */
export function lintProgram({ vertex = '', fragment = '' }) {
  // Comments are stripped before ANY parsing. Prose is not GLSL: a `//` line
  // above a declaration puts its own words at the head of the statement, the
  // statement then fails to look like a declaration, and the variable it
  // declares is reported as undeclared -- so the checker would fire hardest on
  // exactly the well-commented code this project is made of.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const vRaw = strip(vertex);
  const fRaw = strip(fragment);
  const vSrc = preprocessGlsl(vRaw).lines.join('\n');
  const fSrc = preprocessGlsl(fRaw).lines.join('\n');
  // Declarations come from the whole source, not the preprocessed one: a uniform
  // behind an #ifdef the preprocessor dropped is still declared for any code
  // that survived the same condition, and reporting it would be noise.
  const scope = new Set([
    ...declaredIn(vRaw.join('\n')), ...declaredIn(fRaw.join('\n')), ...THREE_PROVIDED,
  ]);
  const missing = (src) => [...usedIn(src)].filter((n) => !scope.has(n)).sort();
  return {
    vertex: missing(vSrc),
    fragment: missing(fSrc),
    varyings: crossStage(vRaw.join('\n'), fRaw.join('\n')),
  };
}

/**
 * A recording mock of WebGL2, good enough to run three.js r180 end to end.
 *
 * It does not rasterise anything. What it does is observe, exactly, every
 * decision the CPU side makes: which programs get compiled, which draw calls
 * get issued in which order with how many indices, how much buffer and texture
 * memory gets allocated, and which GL objects are created and never deleted.
 *
 * Those are precisely the quantities the brief asks about -- draw calls,
 * instancing, culling, shared materials and geometries, pooling, and "prolonged
 * combat must not cause increasing lag or memory usage" -- and none of them
 * need a GPU to measure. What genuinely needs a GPU (fragment cost per
 * megapixel) was already measured separately and is folded in as a calibrated
 * model, not guessed at.
 *
 * Design notes:
 *  - Constants use their REAL WebGL values. three compares against gl.<CONST>
 *    almost everywhere, but not quite everywhere, and a wrong-but-consistent
 *    number would fail in a way that is very hard to see.
 *  - Anything three touches that is not modelled below is auto-vivified by the
 *    Proxy: unknown CAPITALS become a stable unique constant, unknown methods
 *    become recording no-ops. That keeps the mock from needing to be complete
 *    to be useful, and `unknownCalls` reports what got hit so gaps are visible
 *    rather than silent.
 */

const C = {
  DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400, COLOR_BUFFER_BIT: 0x4000,
  POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  ZERO: 0, ONE: 1, SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303, DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
  DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307, SRC_ALPHA_SATURATE: 0x0308,
  CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002, CONSTANT_ALPHA: 0x8003,
  ONE_MINUS_CONSTANT_ALPHA: 0x8004, BLEND_COLOR: 0x8005,
  FUNC_ADD: 0x8006, FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,
  BLEND_EQUATION: 0x8009, BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883D,
  BLEND_DST_RGB: 0x80C8, BLEND_SRC_RGB: 0x80C9, BLEND_DST_ALPHA: 0x80CA, BLEND_SRC_ALPHA: 0x80CB,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
  BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765, CURRENT_VERTEX_ATTRIB: 0x8626,
  FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
  CULL_FACE: 0x0B44, BLEND: 0x0BE2, DITHER: 0x0BD0, STENCIL_TEST: 0x0B90,
  DEPTH_TEST: 0x0B71, SCISSOR_TEST: 0x0C11, POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0,
  NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502,
  INVALID_FRAMEBUFFER_OPERATION: 0x0506, OUT_OF_MEMORY: 0x0505, CONTEXT_LOST_WEBGL: 0x9242,
  CW: 0x0900, CCW: 0x0901,
  LINE_WIDTH: 0x0B21, ALIASED_POINT_SIZE_RANGE: 0x846D, ALIASED_LINE_WIDTH_RANGE: 0x846E,
  CULL_FACE_MODE: 0x0B45, FRONT_FACE: 0x0B46,
  DEPTH_RANGE: 0x0B70, DEPTH_WRITEMASK: 0x0B72, DEPTH_CLEAR_VALUE: 0x0B73, DEPTH_FUNC: 0x0B74,
  STENCIL_CLEAR_VALUE: 0x0B91, STENCIL_FUNC: 0x0B92, STENCIL_FAIL: 0x0B94,
  STENCIL_PASS_DEPTH_FAIL: 0x0B95, STENCIL_PASS_DEPTH_PASS: 0x0B96, STENCIL_REF: 0x0B97,
  STENCIL_VALUE_MASK: 0x0B93, STENCIL_WRITEMASK: 0x0B98, STENCIL_BACK_FUNC: 0x8800,
  VIEWPORT: 0x0BA2, SCISSOR_BOX: 0x0C10, COLOR_CLEAR_VALUE: 0x0C22, COLOR_WRITEMASK: 0x0C23,
  UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0D05,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_VIEWPORT_DIMS: 0x0D3A, SUBPIXEL_BITS: 0x0D50,
  POLYGON_OFFSET_UNITS: 0x2A00, POLYGON_OFFSET_FACTOR: 0x8038,
  TEXTURE_BINDING_2D: 0x8069, SAMPLE_BUFFERS: 0x80A8, SAMPLES: 0x80A9,
  NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204,
  NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
  KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03, INVERT: 0x150A,
  INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
  VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02, EXTENSIONS: 0x1F03,
  NEAREST: 0x2600, LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072,
  TEXTURE_2D: 0x0DE1, TEXTURE: 0x1702, TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A,
  TEXTURE_CUBE_MAP: 0x8513, TEXTURE_BINDING_CUBE_MAP: 0x8514,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
  TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517, TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
  TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, ACTIVE_TEXTURE: 0x84E0,
  REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
  TEXTURE_MIN_LOD: 0x813A, TEXTURE_MAX_LOD: 0x813B,
  TEXTURE_BASE_LEVEL: 0x813C, TEXTURE_MAX_LEVEL: 0x813D,
  TEXTURE_COMPARE_MODE: 0x884C, TEXTURE_COMPARE_FUNC: 0x884D, COMPARE_REF_TO_TEXTURE: 0x884E,
  TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF,
  FRAGMENT_SHADER: 0x8B30, VERTEX_SHADER: 0x8B31,
  MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
  MAX_VARYING_VECTORS: 0x8DFC, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
  SHADER_TYPE: 0x8B4F, DELETE_STATUS: 0x8B80, COMPILE_STATUS: 0x8B81,
  LINK_STATUS: 0x8B82, VALIDATE_STATUS: 0x8B83, ATTACHED_SHADERS: 0x8B85,
  ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89,
  SHADING_LANGUAGE_VERSION: 0x8B8C, CURRENT_PROGRAM: 0x8B8D,
  LOW_FLOAT: 0x8DF0, MEDIUM_FLOAT: 0x8DF1, HIGH_FLOAT: 0x8DF2,
  LOW_INT: 0x8DF3, MEDIUM_INT: 0x8DF4, HIGH_INT: 0x8DF5,
  FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41,
  READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
  RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62,
  DEPTH_COMPONENT16: 0x81A5, DEPTH_COMPONENT24: 0x81A6, DEPTH_COMPONENT32F: 0x8CAC,
  STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9,
  DEPTH24_STENCIL8: 0x88F0, DEPTH32F_STENCIL8: 0x8CAD,
  UNSIGNED_INT_24_8: 0x84FA, FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8DAD,
  COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20,
  DEPTH_STENCIL_ATTACHMENT: 0x821A, NONE: 0,
  FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_BINDING: 0x8CA6,
  RENDERBUFFER_BINDING: 0x8CA7, MAX_RENDERBUFFER_SIZE: 0x84E8,
  DEPTH_COMPONENT: 0x1902, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908,
  LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A, RED: 0x1903, RG: 0x8227,
  RED_INTEGER: 0x8D94, RG_INTEGER: 0x8228, RGB_INTEGER: 0x8D98, RGBA_INTEGER: 0x8D99,
  UNSIGNED_BYTE: 0x1401, BYTE: 0x1400, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
  INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x140B, HALF_FLOAT_OES: 0x8D61,
  UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
  UNSIGNED_INT_2_10_10_10_REV: 0x8368, UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B,
  UNSIGNED_INT_5_9_9_9_REV: 0x8C3E,
  R8: 0x8229, RG8: 0x822B, RGB8: 0x8051, RGBA8: 0x8058, RGB10_A2: 0x8059,
  R16F: 0x822D, R32F: 0x822E, RG16F: 0x822F, RG32F: 0x8230,
  RGBA32F: 0x8814, RGB32F: 0x8815, RGBA16F: 0x881A, RGB16F: 0x881B,
  R11F_G11F_B10F: 0x8C3A, RGB9_E5: 0x8C3D,
  SRGB: 0x8C40, SRGB8: 0x8C41, SRGB8_ALPHA8: 0x8C43,
  R8I: 0x8231, R8UI: 0x8232, R16I: 0x8233, R16UI: 0x8234, R32I: 0x8235, R32UI: 0x8236,
  RGBA8I: 0x8D8E, RGBA8UI: 0x8D7C, RGBA16I: 0x8D88, RGBA16UI: 0x8D76,
  RGBA32I: 0x8D82, RGBA32UI: 0x8D70,
  UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244,
  MAX_3D_TEXTURE_SIZE: 0x8073, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
  MAX_DRAW_BUFFERS: 0x8824, DRAW_BUFFER0: 0x8825, MAX_COLOR_ATTACHMENTS: 0x8CDF,
  MAX_SAMPLES: 0x8D57, MAX_ELEMENTS_VERTICES: 0x80E8, MAX_ELEMENTS_INDICES: 0x80E9,
  MAX_TEXTURE_LOD_BIAS: 0x84FD, MAX_VARYING_COMPONENTS: 0x8B4B,
  MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8B49, MAX_VERTEX_UNIFORM_COMPONENTS: 0x8B4A,
  MIN_PROGRAM_TEXEL_OFFSET: 0x8904, MAX_PROGRAM_TEXEL_OFFSET: 0x8905,
  UNIFORM_BUFFER: 0x8A11, MAX_UNIFORM_BUFFER_BINDINGS: 0x8A2F,
  UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8A34, MAX_UNIFORM_BLOCK_SIZE: 0x8A30,
  ACTIVE_UNIFORM_BLOCKS: 0x8A36, UNIFORM_BLOCK_DATA_SIZE: 0x8A40,
  COPY_READ_BUFFER: 0x8F36, COPY_WRITE_BUFFER: 0x8F37,
  PIXEL_PACK_BUFFER: 0x88EB, PIXEL_UNPACK_BUFFER: 0x88EC,
  RASTERIZER_DISCARD: 0x8C89, VERTEX_ARRAY_BINDING: 0x85B5,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911A, TIMEOUT_EXPIRED: 0x911B,
  CONDITION_SATISFIED: 0x911C, WAIT_FAILED: 0x911D, SYNC_FLUSH_COMMANDS_BIT: 0x0001,
  QUERY_RESULT: 0x8866, QUERY_RESULT_AVAILABLE: 0x8867,
  ANY_SAMPLES_PASSED: 0x8C2F, ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8D6A,
  TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB, TIMESTAMP_EXT: 0x8E28,
  UNPACK_ROW_LENGTH: 0x0CF2, UNPACK_SKIP_ROWS: 0x0CF3, UNPACK_SKIP_PIXELS: 0x0CF4,
  UNPACK_SKIP_IMAGES: 0x806D, UNPACK_IMAGE_HEIGHT: 0x806E,
  PACK_ROW_LENGTH: 0x0D02, READ_BUFFER: 0x0C02, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8B9B,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8B9A,
};

for (let i = 0; i < 32; i++) C[`TEXTURE${i}`] = 0x84C0 + i;
for (let i = 0; i < 16; i++) { C[`COLOR_ATTACHMENT${i}`] = 0x8CE0 + i; C[`DRAW_BUFFER${i}`] = 0x8825 + i; }

/** Bytes per texel by internal format; used for the VRAM estimate. */
const TEXEL_BYTES = new Map([
  [C.R8, 1], [C.R8I, 1], [C.R8UI, 1], [C.ALPHA, 1], [C.LUMINANCE, 1],
  [C.RG8, 2], [C.R16F, 2], [C.R16I, 2], [C.R16UI, 2], [C.LUMINANCE_ALPHA, 2],
  [C.RGB565, 2], [C.RGBA4, 2], [C.RGB5_A1, 2], [C.DEPTH_COMPONENT16, 2],
  [C.RGB8, 3], [C.SRGB8, 3], [C.RGB, 3],
  [C.RGBA8, 4], [C.SRGB8_ALPHA8, 4], [C.RGBA, 4], [C.RGB10_A2, 4], [C.RGB9_E5, 4],
  [C.R11F_G11F_B10F, 4], [C.RG16F, 4], [C.R32F, 4], [C.R32I, 4], [C.R32UI, 4],
  [C.DEPTH_COMPONENT24, 4], [C.DEPTH_COMPONENT32F, 4], [C.DEPTH24_STENCIL8, 4],
  [C.RGBA8I, 4], [C.RGBA8UI, 4],
  [C.RGB16F, 6], [C.DEPTH32F_STENCIL8, 8], [C.RGBA16F, 8], [C.RG32F, 8],
  [C.RGBA16I, 8], [C.RGBA16UI, 8],
  [C.RGB32F, 12], [C.RGBA32F, 16], [C.RGBA32I, 16], [C.RGBA32UI, 16],
]);

const PARAMS = new Map([
  [C.MAX_TEXTURE_SIZE, 16384], [C.MAX_CUBE_MAP_TEXTURE_SIZE, 16384],
  [C.MAX_3D_TEXTURE_SIZE, 2048], [C.MAX_ARRAY_TEXTURE_LAYERS, 2048],
  [C.MAX_TEXTURE_IMAGE_UNITS, 16], [C.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 16],
  [C.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 32], [C.MAX_VERTEX_ATTRIBS, 16],
  [C.MAX_VERTEX_UNIFORM_VECTORS, 1024], [C.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
  [C.MAX_VARYING_VECTORS, 31], [C.MAX_VARYING_COMPONENTS, 124],
  [C.MAX_SAMPLES, 4], [C.MAX_DRAW_BUFFERS, 8], [C.MAX_COLOR_ATTACHMENTS, 8],
  [C.MAX_RENDERBUFFER_SIZE, 16384], [C.MAX_VIEWPORT_DIMS, new Int32Array([16384, 16384])],
  [C.MAX_TEXTURE_MAX_ANISOTROPY_EXT, 16], [C.MAX_UNIFORM_BUFFER_BINDINGS, 24],
  [C.UNIFORM_BUFFER_OFFSET_ALIGNMENT, 256], [C.MAX_UNIFORM_BLOCK_SIZE, 65536],
  [C.MAX_ELEMENTS_VERTICES, 1048575], [C.MAX_ELEMENTS_INDICES, 1048575],
  [C.MAX_TEXTURE_LOD_BIAS, 2], [C.MAX_FRAGMENT_UNIFORM_COMPONENTS, 4096],
  [C.MAX_VERTEX_UNIFORM_COMPONENTS, 4096],
  [C.MIN_PROGRAM_TEXEL_OFFSET, -8], [C.MAX_PROGRAM_TEXEL_OFFSET, 7],
  [C.SAMPLES, 0], [C.SAMPLE_BUFFERS, 0], [C.SUBPIXEL_BITS, 4],
  [C.VENDOR, 'cod-harness'], [C.RENDERER, 'cod-harness (no rasteriser)'],
  [C.VERSION, 'WebGL 2.0 (OpenGL ES 3.0 cod-harness)'],
  [C.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 cod-harness)'],
  [C.IMPLEMENTATION_COLOR_READ_FORMAT, C.RGBA], [C.IMPLEMENTATION_COLOR_READ_TYPE, C.UNSIGNED_BYTE],
  [C.ALIASED_LINE_WIDTH_RANGE, new Float32Array([1, 1])],
  [C.ALIASED_POINT_SIZE_RANGE, new Float32Array([1, 1024])],
]);

/**
 * Extensions three may ask for. Anything not listed returns null.
 * Timer queries are deliberately absent: there is no GPU here, so letting the
 * engine believe it can time the GPU would make its adaptive resolution
 * controller act on numbers that do not exist.
 */
const EXTENSIONS = {
  EXT_texture_filter_anisotropic: { MAX_TEXTURE_MAX_ANISOTROPY_EXT: C.MAX_TEXTURE_MAX_ANISOTROPY_EXT, TEXTURE_MAX_ANISOTROPY_EXT: C.TEXTURE_MAX_ANISOTROPY_EXT },
  WEBGL_compressed_texture_s3tc: {}, WEBGL_compressed_texture_pvrtc: {},
  WEBGL_compressed_texture_etc1: {}, WEBGL_compressed_texture_astc: {},
  EXT_color_buffer_float: {}, EXT_color_buffer_half_float: {},
  OES_texture_float_linear: {}, EXT_float_blend: {},
  WEBGL_debug_renderer_info: { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 },
  KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91B1 },
  WEBGL_lose_context: { loseContext() {}, restoreContext() {} },
  WEBGL_multi_draw: {},
  OVR_multiview2: {},
};

let uid = 0;
const obj = (kind) => ({ __kind: kind, __id: ++uid });

export function createGLMock({ width = 3024, height = 1964 } = {}) {
  const rec = {
    // --- lifetime bookkeeping: what exists right now, and what ever existed ---
    live: { buffer: new Set(), texture: new Set(), framebuffer: new Set(), renderbuffer: new Set(), program: new Set(), shader: new Set(), vao: new Set(), query: new Set(), sync: new Set() },
    created: { buffer: 0, texture: 0, framebuffer: 0, renderbuffer: 0, program: 0, shader: 0, vao: 0, query: 0, sync: 0 },
    deleted: { buffer: 0, texture: 0, framebuffer: 0, renderbuffer: 0, program: 0, shader: 0, vao: 0, query: 0, sync: 0 },

    bufferBytes: 0, textureBytes: 0, renderbufferBytes: 0,
    /** Per-object byte accounting so deletes can subtract accurately. */
    bufferSizes: new Map(), textureSizes: new Map(), renderbufferSizes: new Map(),

    shaderSources: new Map(),   // shader object id -> {type, source}
    programs: new Map(),        // program object id -> {vertex, fragment, linkedAt}
    programOrder: [],

    // --- per-frame draw stream ---
    frame: 0,
    draws: [],                  // reset per frame by beginFrame()
    drawCalls: 0, triangles: 0, instancedCalls: 0, instances: 0,
    programSwitches: 0, currentProgram: null,
    fboBinds: 0, currentFbo: null,
    clears: 0, viewportSets: 0, currentViewport: null,
    texUploads: 0, texUploadBytes: 0, bufferUploads: 0, bufferUploadBytes: 0,

    /** framebuffer id -> { attachmentName -> {kind, id, layer} }. */
    attachments: new Map(),

    unknownCalls: new Map(),
    calls: 0,
  };

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  const ATTACHMENT_NAMES = new Map([
    [C.DEPTH_ATTACHMENT, 'depth'],
    [C.STENCIL_ATTACHMENT, 'stencil'],
    [C.DEPTH_STENCIL_ATTACHMENT, 'depthStencil'],
  ]);
  const attachmentName = (a) =>
    ATTACHMENT_NAMES.get(a) ??
    (a >= C.COLOR_ATTACHMENT0 && a < C.COLOR_ATTACHMENT0 + 16 ? `color${a - C.COLOR_ATTACHMENT0}` : `0x${a.toString(16)}`);

  const recordAttachment = (attachment, resource, kind, layer) => {
    const fbo = rec.currentFbo;
    if (fbo === null || fbo === undefined) return; // the default framebuffer
    let map = rec.attachments.get(fbo.__id);
    if (map === undefined) rec.attachments.set(fbo.__id, (map = new Map()));
    const name = attachmentName(attachment);
    if (resource === null || resource === undefined) map.delete(name);
    else map.set(name, { kind, id: resource.__id, layer });
  };

  const texBytes = (internalformat, w, h, d = 1) => {
    const bpp = TEXEL_BYTES.get(internalformat) ?? 4;
    return Math.max(0, (w | 0) * (h | 0) * (d | 0) * bpp);
  };

  const gl = {
    canvas: { width, height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    drawingBufferColorSpace: 'srgb',
    ...C,

    getContextAttributes: () => ({ alpha: false, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false, desynchronized: false }),
    getExtension: (name) => EXTENSIONS[name] ?? null,
    getSupportedExtensions: () => Object.keys(EXTENSIONS),
    getParameter: (p) => {
      if (PARAMS.has(p)) return PARAMS.get(p);
      if (p === C.CURRENT_PROGRAM) return rec.currentProgram;
      if (p === C.FRAMEBUFFER_BINDING) return rec.currentFbo;
      if (p === C.VIEWPORT) return new Int32Array([0, 0, width, height]);
      if (p === C.SCISSOR_BOX) return new Int32Array([0, 0, width, height]);
      if (p === 0x9245 || p === 0x9246) return 'cod-harness';
      return 0;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getError: () => C.NO_ERROR,
    isContextLost: () => false,

    // --- shaders & programs -------------------------------------------------
    createShader(type) { const s = obj('shader'); s.type = type; rec.live.shader.add(s.__id); rec.created.shader++; return s; },
    shaderSource(s, src) { if (s) rec.shaderSources.set(s.__id, { type: s.type, source: src }); },
    compileShader() {},
    getShaderParameter: (s, p) => (p === C.COMPILE_STATUS ? true : p === C.SHADER_TYPE ? s?.type ?? 0 : 0),
    getShaderInfoLog: () => '',
    getShaderSource: (s) => rec.shaderSources.get(s?.__id)?.source ?? '',
    deleteShader(s) { if (s && rec.live.shader.delete(s.__id)) rec.deleted.shader++; },

    createProgram() { const p = obj('program'); p.shaders = []; rec.live.program.add(p.__id); rec.created.program++; return p; },
    attachShader(p, s) { p?.shaders?.push(s); },
    detachShader() {},
    bindAttribLocation() {},
    linkProgram(p) {
      if (!p) return;
      const src = { vertex: '', fragment: '' };
      for (const s of p.shaders ?? []) {
        const e = rec.shaderSources.get(s?.__id);
        if (!e) continue;
        if (e.type === C.VERTEX_SHADER) src.vertex = e.source; else src.fragment = e.source;
      }
      rec.programs.set(p.__id, src);
      rec.programOrder.push(p.__id);
    },
    getProgramParameter: (p, k) => {
      if (k === C.LINK_STATUS || k === C.VALIDATE_STATUS) return true;
      // Reporting zero active uniforms/attributes leaves three's uniform maps
      // empty, so uniform uploads become no-ops. That is fine and intended:
      // nothing here shades pixels, and every quantity this harness reports is
      // decided before a uniform would ever be written.
      return 0;
    },
    getProgramInfoLog: () => '',
    useProgram(p) { if (p !== rec.currentProgram) { rec.programSwitches++; rec.currentProgram = p; } },
    deleteProgram(p) { if (p && rec.live.program.delete(p.__id)) rec.deleted.program++; },
    validateProgram() {},
    getUniformLocation: () => ({ __kind: 'uniformLocation', __id: ++uid }),
    getAttribLocation: () => -1,
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformBlockIndex: () => 0,
    uniformBlockBinding() {},
    getActiveUniformBlockParameter: () => 0,
    getActiveUniformBlockName: () => '',
    getActiveUniforms: () => [],
    getUniformIndices: () => [],

    // --- buffers ------------------------------------------------------------
    createBuffer() { const b = obj('buffer'); rec.live.buffer.add(b.__id); rec.created.buffer++; return b; },
    bindBuffer(target, b) { gl.__boundBuffer = b; },
    bufferData(target, data, usage) {
      const bytes = typeof data === 'number' ? data : (data?.byteLength ?? 0);
      const b = gl.__boundBuffer;
      if (b) {
        rec.bufferBytes -= rec.bufferSizes.get(b.__id) ?? 0;
        rec.bufferSizes.set(b.__id, bytes);
        rec.bufferBytes += bytes;
      }
      rec.bufferUploads++; rec.bufferUploadBytes += bytes;
    },
    bufferSubData(target, off, data) { rec.bufferUploads++; rec.bufferUploadBytes += data?.byteLength ?? 0; },
    deleteBuffer(b) {
      if (!b || !rec.live.buffer.delete(b.__id)) return;
      rec.deleted.buffer++;
      rec.bufferBytes -= rec.bufferSizes.get(b.__id) ?? 0;
      rec.bufferSizes.delete(b.__id);
    },

    // --- textures -----------------------------------------------------------
    createTexture() { const t = obj('texture'); rec.live.texture.add(t.__id); rec.created.texture++; return t; },
    bindTexture(target, t) { gl.__boundTex = t; },
    activeTexture() {},
    texParameteri() {}, texParameterf() {},
    pixelStorei() {},
    texImage2D(target, level, internalformat, w, h, border, format, type, px) {
      // Short-form overload: texImage2D(target, level, internalformat, format, type, source)
      if (typeof w !== 'number') { const src = border; w = src?.width ?? 1; h = src?.height ?? 1; }
      const bytes = texBytes(internalformat, w, h);
      const t = gl.__boundTex;
      if (t && level === 0) {
        rec.textureBytes -= rec.textureSizes.get(t.__id) ?? 0;
        // Cube maps upload six faces into the same object.
        const faces = target >= C.TEXTURE_CUBE_MAP_POSITIVE_X && target <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z ? 6 : 1;
        const total = bytes * faces;
        rec.textureSizes.set(t.__id, total);
        rec.textureBytes += total;
      }
      rec.texUploads++; rec.texUploadBytes += bytes;
    },
    texStorage2D(target, levels, internalformat, w, h) {
      const bytes = Math.round(texBytes(internalformat, w, h) * (levels > 1 ? 1.34 : 1));
      const t = gl.__boundTex;
      if (t) { rec.textureBytes -= rec.textureSizes.get(t.__id) ?? 0; rec.textureSizes.set(t.__id, bytes); rec.textureBytes += bytes; }
    },
    texStorage3D(target, levels, internalformat, w, h, d) {
      const bytes = Math.round(texBytes(internalformat, w, h, d) * (levels > 1 ? 1.34 : 1));
      const t = gl.__boundTex;
      if (t) { rec.textureBytes -= rec.textureSizes.get(t.__id) ?? 0; rec.textureSizes.set(t.__id, bytes); rec.textureBytes += bytes; }
    },
    texImage3D(target, level, internalformat, w, h, d) { rec.texUploads++; rec.texUploadBytes += texBytes(internalformat, w, h, d); },
    texSubImage2D() { rec.texUploads++; },
    texSubImage3D() { rec.texUploads++; },
    compressedTexImage2D(target, level, internalformat, w, h, border, data) { rec.texUploads++; rec.texUploadBytes += data?.byteLength ?? 0; },
    compressedTexSubImage2D() { rec.texUploads++; },
    copyTexImage2D() {}, copyTexSubImage2D() {},
    generateMipmap() {},
    deleteTexture(t) {
      if (!t || !rec.live.texture.delete(t.__id)) return;
      rec.deleted.texture++;
      rec.textureBytes -= rec.textureSizes.get(t.__id) ?? 0;
      rec.textureSizes.delete(t.__id);
    },

    // --- framebuffers / renderbuffers --------------------------------------
    createFramebuffer() { const f = obj('framebuffer'); rec.live.framebuffer.add(f.__id); rec.created.framebuffer++; return f; },
    bindFramebuffer(target, f) { rec.fboBinds++; rec.currentFbo = f ?? null; },
    // Attachments are recorded, not ignored. Which texture is bound to which
    // attachment point of which framebuffer is the whole wiring of the render
    // graph, and it is the only way to prove -- with no GPU present -- that two
    // targets really do share one depth buffer rather than each owning its own.
    framebufferTexture2D(target, attachment, textarget, texture, level) {
      recordAttachment(attachment, texture, 'texture');
    },
    framebufferTextureLayer(target, attachment, texture, level, layer) {
      recordAttachment(attachment, texture, 'texture', layer);
    },
    framebufferRenderbuffer(target, attachment, rbtarget, rb) {
      recordAttachment(attachment, rb, 'renderbuffer');
    },
    checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
    deleteFramebuffer(f) { if (f && rec.live.framebuffer.delete(f.__id)) rec.deleted.framebuffer++; },
    createRenderbuffer() { const r = obj('renderbuffer'); rec.live.renderbuffer.add(r.__id); rec.created.renderbuffer++; return r; },
    bindRenderbuffer(target, r) { gl.__boundRb = r; },
    renderbufferStorage(target, internalformat, w, h) {
      const bytes = texBytes(internalformat, w, h);
      const r = gl.__boundRb;
      if (r) { rec.renderbufferBytes -= rec.renderbufferSizes.get(r.__id) ?? 0; rec.renderbufferSizes.set(r.__id, bytes); rec.renderbufferBytes += bytes; }
    },
    renderbufferStorageMultisample(target, samples, internalformat, w, h) {
      const bytes = texBytes(internalformat, w, h) * Math.max(1, samples);
      const r = gl.__boundRb;
      if (r) { rec.renderbufferBytes -= rec.renderbufferSizes.get(r.__id) ?? 0; rec.renderbufferSizes.set(r.__id, bytes); rec.renderbufferBytes += bytes; }
    },
    deleteRenderbuffer(r) {
      if (!r || !rec.live.renderbuffer.delete(r.__id)) return;
      rec.deleted.renderbuffer++;
      rec.renderbufferBytes -= rec.renderbufferSizes.get(r.__id) ?? 0;
      rec.renderbufferSizes.delete(r.__id);
    },
    blitFramebuffer() {}, drawBuffers() {}, readBuffer() {}, invalidateFramebuffer() {},
    readPixels(x, y, w, h, fmt, type, dst) { if (dst?.fill) dst.fill(0); },

    // --- VAOs, queries, sync ------------------------------------------------
    createVertexArray() { const v = obj('vao'); rec.live.vao.add(v.__id); rec.created.vao++; return v; },
    bindVertexArray() {},
    deleteVertexArray(v) { if (v && rec.live.vao.delete(v.__id)) rec.deleted.vao++; },
    enableVertexAttribArray() {}, disableVertexAttribArray() {},
    vertexAttribPointer() {}, vertexAttribIPointer() {}, vertexAttribDivisor() {},
    vertexAttrib1f() {}, vertexAttrib2fv() {}, vertexAttrib3fv() {}, vertexAttrib4fv() {},
    createQuery() { const q = obj('query'); rec.live.query.add(q.__id); rec.created.query++; return q; },
    beginQuery() {}, endQuery() {},
    getQueryParameter: (q, p) => (p === C.QUERY_RESULT_AVAILABLE ? true : 0),
    deleteQuery(q) { if (q && rec.live.query.delete(q.__id)) rec.deleted.query++; },
    fenceSync: () => { const s = obj('sync'); rec.live.sync.add(s.__id); rec.created.sync++; return s; },
    clientWaitSync: () => C.ALREADY_SIGNALED,
    getSyncParameter: () => C.SIGNALED,
    deleteSync(s) { if (s && rec.live.sync.delete(s.__id)) rec.deleted.sync++; },
    flush() {}, finish() {},

    // --- draws --------------------------------------------------------------
    drawElements(mode, count, type, offset) { record(mode, count, 1); },
    drawArrays(mode, first, count) { record(mode, count, 1); },
    drawElementsInstanced(mode, count, type, offset, primcount) { record(mode, count, primcount, true); },
    drawArraysInstanced(mode, first, count, primcount) { record(mode, count, primcount, true); },
    drawRangeElements(mode, s, e, count) { record(mode, count, 1); },

    // --- fixed-function state ----------------------------------------------
    // The viewport is recorded, not discarded, because per-fragment shader cost
    // is meaningless without knowing how many fragments there are. A sky LUT
    // shader at 576 fetches per fragment that runs once over 32x32 texels is
    // free; a world material at 104 over a 1920x1080 target is the frame.
    viewport(x, y, w, h) { rec.viewportSets++; rec.currentViewport = [w | 0, h | 0]; }, scissor() {},
    clear() { rec.clears++; }, clearColor() {}, clearDepth() {}, clearStencil() {},
    bufferfv() {}, clearBufferfv() {}, clearBufferiv() {}, clearBufferuiv() {}, clearBufferfi() {},
    enable() {}, disable() {}, isEnabled: () => false,
    depthFunc() {}, depthMask() {}, depthRange() {},
    colorMask() {}, cullFace() {}, frontFace() {},
    blendFunc() {}, blendFuncSeparate() {}, blendEquation() {}, blendEquationSeparate() {}, blendColor() {},
    stencilFunc() {}, stencilFuncSeparate() {}, stencilOp() {}, stencilOpSeparate() {}, stencilMask() {}, stencilMaskSeparate() {},
    polygonOffset() {}, lineWidth() {}, sampleCoverage() {}, hint() {},
    bindBufferBase() {}, bindBufferRange() {},
    createSampler: () => obj('sampler'), bindSampler() {}, samplerParameteri() {}, deleteSampler() {},
  };

  function record(mode, count, instances, isInstanced = false) {
    const tri = mode === C.TRIANGLES ? (count / 3) | 0
      : mode === C.TRIANGLE_STRIP || mode === C.TRIANGLE_FAN ? Math.max(0, count - 2)
      : 0;
    rec.drawCalls++;
    rec.triangles += tri * Math.max(1, instances);
    if (isInstanced) { rec.instancedCalls++; rec.instances += instances; }
    rec.draws.push({
      p: rec.currentProgram?.__id ?? 0,
      fbo: rec.currentFbo?.__id ?? 0,
      vw: rec.currentViewport?.[0] ?? 0,
      vh: rec.currentViewport?.[1] ?? 0,
      mode, count, inst: instances,
    });
  }

  // Uniform setters: three calls dozens of shapes of these. They are recorded
  // as calls but do nothing, because getActiveUniform reports no uniforms.
  for (const n of ['1f', '2f', '3f', '4f', '1i', '2i', '3i', '4i', '1ui', '2ui', '3ui', '4ui',
    '1fv', '2fv', '3fv', '4fv', '1iv', '2iv', '3iv', '4iv', '1uiv', '2uiv', '3uiv', '4uiv']) {
    gl[`uniform${n}`] = () => {};
  }
  for (const n of ['2fv', '3fv', '4fv', '2x3fv', '2x4fv', '3x2fv', '3x4fv', '4x2fv', '4x3fv']) {
    gl[`uniformMatrix${n}`] = () => {};
  }

  /** Called by the harness at the top of every frame. */
  rec.beginFrame = () => { rec.frame++; rec.draws = []; rec.drawCalls = 0; rec.triangles = 0; rec.instancedCalls = 0; rec.instances = 0; rec.programSwitches = 0; rec.fboBinds = 0; rec.clears = 0; rec.texUploads = 0; rec.texUploadBytes = 0; rec.bufferUploads = 0; rec.bufferUploadBytes = 0; };

  // Auto-vivify anything three touches that is not modelled above, so a gap in
  // the mock degrades into a recorded no-op instead of a crash -- and shows up
  // in `unknownCalls` so it can be modelled properly if it turns out to matter.
  const proxy = new Proxy(gl, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) { const v = 0x10000 + (uid++); t[k] = v; return v; }
      const fn = (...a) => { bump(rec.unknownCalls, k); return undefined; };
      t[k] = fn;
      return fn;
    },
  });

  return { gl: proxy, rec, C };
}

export { C as GL_CONSTANTS };

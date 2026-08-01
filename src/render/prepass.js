import * as THREE from 'three';
import { COMMON } from './glsl.js';

/**
 * Depth / normal / velocity prepass.
 *
 * Three MRT attachments:
 *   0  RGBA16F  octahedral view normal (xy), coverage (z), ONE OVER view depth (w)
 *   1  RG16F    screen-space velocity as a UV delta (current - previous)
 *   2  R32F     linear view depth in metres (positive)
 *
 * ALPHA CARRIES 1/DEPTH, and it is there for TAA. That pass reads this target for
 * coverage and the depth target for its velocity dilation, at overlapping UVs, so
 * it was fetching two textures to answer one question about one texel. With the
 * reciprocal here, its five dilation taps and its two coverage reads collapse into
 * five fetches of THIS attachment and the depth target drops out of the pass
 * entirely — 2 of 21 fetches on every full-resolution pixel of the frame.
 *
 * It replaced a material id that nothing ever wrote and nothing ever read.
 *
 * WHY THE RECIPROCAL AND NOT THE DEPTH. TAA does not want metres. It wants an
 * ordering (which of five neighbours is nearest) and a value to republish in its
 * own alpha for motion blur, and that value was ALREADY 1/depth rounded to half —
 * see the long note in taa.js on why blending reciprocals is the right thing at a
 * roofline. Storing the reciprocal here therefore moves the rounding earlier
 * rather than adding one: TAA now reads a half and writes the same half, exactly,
 * where before it read an R32F depth and rounded the reciprocal on the way out.
 * One rounding either way, and motion blur receives the identical value.
 *
 * The ordering survives it because 1/d is monotonic in d and half rounding is
 * monotonic, so argmin(depth) is argmax(alpha) — with one caveat worth naming:
 * two neighbours whose depths agree to within half's relative step of 2^-11 can
 * now tie where R32F separated them, and the tie goes to the earlier tap. Those
 * are two samples of one surface 0.05% apart, which carry the same velocity; the
 * silhouettes the dilation exists for are orders of magnitude further apart.
 *
 * Uncovered pixels need no sentinel: the black clear leaves alpha at exactly 0,
 * which is "infinitely far" under the reciprocal and loses every comparison to
 * real geometry. That is the same clear the coverage channel beside it relies on,
 * and it is strictly simpler than the 1e8 substitution the depth version needed.
 *
 * Coverage is 1.0 for ordinary geometry and OW_COVERAGE_DYNAMIC (0.7) for
 * geometry whose *vertices* move independently of its transform — skinned
 * characters and morphed meshes. Every consumer only ever tests coverage
 * against 0.5, so both still read as "there is a surface here", but TAA uses the
 * distinction to reject history on exactly the pixels whose motion no
 * matrix-difference velocity can describe. Without it a running enemy's arms and
 * legs emit zero motion and the temporal filter drags the background through
 * them — the smear on the character silhouettes.
 *
 * Velocity is computed from *unjittered* view-projection matrices for both
 * frames, so the TAA jitter never leaks into the motion vectors — which is
 * the single most common reason browser TAA implementations smear.
 *
 * Per-object previous world matrices are pushed through
 * `material.onBeforeRender`, which the renderer calls once per draw; setting
 * `uniformsNeedUpdate` forces the re-upload. This is what makes the velocity
 * buffer *per object* rather than camera-only.
 */
/** Coverage written for skinned / morphed geometry. See the class note. */
export const OW_COVERAGE_DYNAMIC = 0.7;

/**
 * How far the prepass pushes its hardware depth away from the camera, as a
 * fraction of the fragment's own view depth.
 *
 * The forward pass reuses this depth buffer instead of clearing and refilling
 * it, which only works if the prepass depth is never NEARER than what the
 * forward pass computes for the same surface — a fragment one float ULP in
 * front of its own prepass value fails GL_LEQUAL and the surface vanishes.
 *
 * Both passes reach `gl_Position` through the identical chunk chain
 * (`begin_vertex` -> `morphtarget_vertex` -> `skinning_vertex` ->
 * `project_vertex`) with the same operands, so in principle they already agree
 * bit for bit. This bias makes the pass correct even if they do not: a
 * compiler that contracts a multiply-add differently in the two programs, or a
 * driver that reassociates the matrix product, cannot produce an error anywhere
 * near this size.
 *
 * It is relative because depth-buffer precision is relative: 0.12% is 1.2 mm at
 * one metre and 12 cm at a hundred. The only thing it costs is that a surface
 * closer than that to its occluder is shaded rather than rejected — at a
 * hundred metres, that is a surface less than a pixel from the one in front.
 */
const OW_PREPASS_DEPTH_BIAS = 0.0012;

const _prevClear = new THREE.Color();
const _identityTile = new THREE.Vector4(1, 1, 0, 0);

/**
 * Can this material's alpha mask be reproduced by the prepass?
 *
 * The prepass has to discard exactly the fragments the forward pass discards,
 * or it writes depth where the image has a hole and the geometry behind gets
 * rejected. The extended surface shader builds its alpha from `map.a` sampled
 * at `vMapUv * owTile.xy + owTile.zw`, so mesh-UV materials can be reproduced
 * exactly. Triplanar and world-projected ones cannot, and are told so rather
 * than approximated.
 */
export function canPrepassAlphaTest(mat) {
  if (!mat || !(mat.alphaTest > 0) || !mat.map) return false;
  const p = mat.userData?.owParams;
  // A stock three material alpha-tests straight off map.a, which is also exact.
  if (p === undefined) return true;
  return p.uvMode === 'mesh' && !(p.parallax > 0);
}

/**
 * @param {boolean} masked  build the alpha-tested variant.
 *
 * Two materials rather than one with a uniform branch, because a `discard`
 * anywhere in a fragment shader makes the driver give up early-Z for that whole
 * program. Foliage is three draw calls; the other ninety must not pay for it.
 */
function createPrepassMaterial(masked) {
  return new THREE.ShaderMaterial({
    name: masked ? 'ow-prepass-masked' : 'ow-prepass',
    glslVersion: THREE.GLSL3,
    // The masked variant is only ever used for alpha-cut foliage, which the
    // forward pass draws double-sided; the prepass has to agree or a frond seen
    // from behind gets no depth.
    side: masked ? THREE.DoubleSide : THREE.FrontSide,
    defines: masked ? { OW_PREPASS_MASK: '' } : {},
    uniforms: {
      owPrevModelMatrix: { value: new THREE.Matrix4() },
      owCurrVP: { value: new THREE.Matrix4() },
      owPrevVP: { value: new THREE.Matrix4() },
      owCoverage: { value: 1 },
      owDepthBias: { value: OW_PREPASS_DEPTH_BIAS },
      ...(masked
        ? {
            owAlphaMap: { value: null },
            owAlphaTest: { value: 0 },
            owTile: { value: new THREE.Vector4(1, 1, 0, 0) },
          }
        : {}),
    },
    vertexShader: /* glsl */ `
        #include <common>
        #include <batching_pars_vertex>
        #include <skinning_pars_vertex>
        #include <morphtarget_pars_vertex>

        uniform mat4 owPrevModelMatrix;
        uniform mat4 owCurrVP;
        uniform mat4 owPrevVP;
        uniform float owDepthBias;

        varying vec3 vNrm;
        varying vec4 vCurrClip;
        varying vec4 vPrevClip;
        varying float vViewDepth;

        #ifdef OW_PREPASS_MASK
          uniform vec4 owTile;
          varying vec2 vOwAlphaUv;
        #endif

        void main() {
          #include <batching_vertex>
          #include <beginnormal_vertex>
          #include <morphinstance_vertex>
          #include <morphnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <defaultnormal_vertex>
          #include <begin_vertex>
          #include <morphtarget_vertex>
          #include <skinning_vertex>
          #include <project_vertex>

          vNrm = transformedNormal;
          // Read BEFORE the bias below. This is the linear depth GTAO, contact
          // shadows and SSR march against; shifting it would move every one of
          // them for a reason that has nothing to do with them.
          vViewDepth = -mvPosition.z;

          #ifdef OW_PREPASS_MASK
            vOwAlphaUv = uv * owTile.xy + owTile.zw;
          #endif

          // Nudge the hardware depth away from the camera so the forward pass,
          // which reuses this buffer, always passes GL_LEQUAL on the surface
          // that wrote it. See OW_PREPASS_DEPTH_BIAS.
          mvPosition.z *= 1.0 + owDepthBias;
          gl_Position = projectionMatrix * mvPosition;

          vec4 objPos = vec4( transformed, 1.0 );
          #ifdef USE_BATCHING
            objPos = batchingMatrix * objPos;
          #endif
          #ifdef USE_INSTANCING
            objPos = instanceMatrix * objPos;
          #endif
          vCurrClip = owCurrVP * ( modelMatrix * objPos );
          vPrevClip = owPrevVP * ( owPrevModelMatrix * objPos );
        }
      `,
    fragmentShader: /* glsl */ `
        precision highp float;
        ${COMMON}
        uniform float owCoverage;

        varying vec3 vNrm;
        varying vec4 vCurrClip;
        varying vec4 vPrevClip;
        varying float vViewDepth;

        #ifdef OW_PREPASS_MASK
          uniform sampler2D owAlphaMap;
          uniform float owAlphaTest;
          varying vec2 vOwAlphaUv;
        #endif

        layout(location = 0) out vec4 gNormal;
        layout(location = 1) out vec4 gVelocity;
        layout(location = 2) out vec4 gDepth;

        void main() {
          #ifdef OW_PREPASS_MASK
            // The same test the surface shader runs: opacity is 1 and every
            // albedo tweak in shader.js touches rgb only, so the forward pass's
            // alpha IS map.a at this uv.
            if ( texture( owAlphaMap, vOwAlphaUv ).a < owAlphaTest ) discard;
          #endif

          vec3 n = normalize( vNrm );
          if ( !gl_FrontFacing ) n = -n;
          // Alpha is 1/depth for TAA -- see the attachment table at the top of
          // this file. vViewDepth is a positive linear view depth and is never
          // below the near plane, so the divide needs no guard; the value it
          // produces spans about 20 down to 5e-4 across the frustum, well inside
          // half float's normal range.
          gNormal = vec4( owEncodeNormal( n ), owCoverage, 1.0 / vViewDepth );

          vec2 a = vCurrClip.xy / max( 1e-6, vCurrClip.w );
          vec2 b = vPrevClip.xy / max( 1e-6, vPrevClip.w );
          gVelocity = vec4( ( a - b ) * 0.5, 0.0, 0.0 );

          gDepth = vec4( vViewDepth, 0.0, 0.0, 0.0 );
        }
      `,
  });
}

export class GBuffer {
  constructor() {
    this.rt = null;
    this.width = 1;
    this.height = 1;
    this.prev = new Map();
    this._seen = new Set();
    /**
     * The hardware depth attachment, owned here and handed to the HDR target so
     * the forward pass inherits this pass's depth instead of rebuilding it.
     */
    this.hardwareDepth = null;

    this.material = createPrepassMaterial(false);
    this.maskMaterial = createPrepassMaterial(true);
    for (const m of [this.material, this.maskMaterial]) {
      m.onBeforeRender = (renderer, scene, camera, geometry, object) => {
        const u = m.uniforms;
        const p = this.prev.get(object.id);
        if (p !== undefined) u.owPrevModelMatrix.value.copy(p);
        else u.owPrevModelMatrix.value.copy(object.matrixWorld);
        // Skinned and morphed geometry deforms *inside* its transform, so the
        // matrix difference above describes none of the motion its pixels
        // actually have. Flag it so TAA can reject history there instead of
        // smearing.
        u.owCoverage.value =
          object.isSkinnedMesh === true ||
          (object.morphTargetInfluences !== undefined && object.morphTargetInfluences !== null)
            ? OW_COVERAGE_DYNAMIC
            : 1;

        if (u.owAlphaMap !== undefined) {
          // The real material is still on the object; only the *drawn* material
          // was swapped out by scene.overrideMaterial.
          const src = Array.isArray(object.material) ? object.material[0] : object.material;
          u.owAlphaMap.value = src?.map ?? null;
          u.owAlphaTest.value = src?.alphaTest ?? 0;
          u.owTile.value.copy(src?.userData?.owUniforms?.owTile?.value ?? _identityTile);
        }
        m.uniformsNeedUpdate = true;
      };
    }
  }

  setSize(w, h) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (this.rt && this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;
    if (this.rt) this.rt.dispose();

    // An explicit depth TEXTURE rather than the renderbuffer three would
    // allocate, because the HDR target attaches this same object and so
    // inherits the depths this pass writes. That is what lets the forward pass
    // skip its depth clear and let early-Z throw away the hidden half of the
    // frame before it shades anything. See RenderSystem.resize().
    this.hardwareDepth?.dispose();
    this.hardwareDepth = new THREE.DepthTexture(w, h);
    this.hardwareDepth.format = THREE.DepthFormat;
    this.hardwareDepth.type = THREE.UnsignedIntType;
    this.hardwareDepth.minFilter = THREE.NearestFilter;
    this.hardwareDepth.magFilter = THREE.NearestFilter;
    this.hardwareDepth.generateMipmaps = false;
    this.hardwareDepth.name = 'gb-hw-depth';

    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: 3,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture: this.hardwareDepth,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.textures[0].name = 'gb-normal';

    rt.textures[1].format = THREE.RGFormat;
    rt.textures[1].type = THREE.HalfFloatType;
    rt.textures[1].name = 'gb-velocity';

    rt.textures[2].format = THREE.RedFormat;
    rt.textures[2].type = THREE.FloatType;
    rt.textures[2].name = 'gb-depth';

    for (const t of rt.textures) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    }

    this.rt = rt;
  }

  get normalTexture() {
    return this.rt.textures[0];
  }
  get velocityTexture() {
    return this.rt.textures[1];
  }
  get depthTexture() {
    return this.rt.textures[2];
  }

  /**
   * @param {boolean} clear  clear colour+depth (world pass) or depth only
   *                         (viewmodel pass, composited over the same buffer)
   *
   * The clear colour is forced to zero rather than inherited. WebGL clears every
   * MRT attachment with the same value, so a black clear is what makes
   * `depth == 0` mean *no geometry here* — and that equivalence is load-bearing:
   * gtao.js, contact.js and ssr.js all test the depth texture instead of
   * re-fetching `normal.z` for coverage, which is one texture fetch per march
   * step rather than two. Inheriting the renderer's colour would silently break
   * every one of them the day somebody clears to the sky.
   */
  /**
   * `masked` / `nMasked` is the subset of the draw list whose materials
   * alpha-cut (foliage). Those go through a second, alpha-tested override so
   * this pass's silhouettes match the forward pass's exactly. Getting that wrong
   * is not cosmetic once the forward pass reuses this depth buffer: depth
   * written across a whole frond quad would reject everything behind it and
   * punch the sky through the leaves.
   */
  render(renderer, scene, camera, currVP, prevVP, clear, masked = null, nMasked = 0) {
    for (const m of [this.material, this.maskMaterial]) {
      m.uniforms.owCurrVP.value.copy(currVP);
      m.uniforms.owPrevVP.value.copy(prevVP);
    }

    const prevOverride = scene.overrideMaterial;
    renderer.getClearColor(_prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.rt);
    if (clear) renderer.clear(true, true, false);
    else renderer.clear(false, true, false);

    // Pass 1: everything except the alpha-cut geometry.
    for (let i = 0; i < nMasked; i++) masked[i].visible = false;
    scene.overrideMaterial = this.material;
    renderer.render(scene, camera);
    for (let i = 0; i < nMasked; i++) masked[i].visible = true;

    // Pass 2: only the alpha-cut geometry. Three draws at ultra, so the extra
    // scene walk is cheaper than making all ninety of the others share a
    // shader that can discard.
    if (nMasked > 0) {
      this._hideOthers(scene, masked, nMasked);
      scene.overrideMaterial = this.maskMaterial;
      renderer.render(scene, camera);
      this._restoreOthers();
    }

    scene.overrideMaterial = prevOverride;
    renderer.setClearColor(_prevClear, prevAlpha);
  }

  /** Hide every visible mesh that is not in `keep`, remembering exactly which. */
  _hideOthers(scene, keep, nKeep) {
    const set = this._keepSet ?? (this._keepSet = new Set());
    set.clear();
    for (let i = 0; i < nKeep; i++) set.add(keep[i]);
    const hidden = this._hiddenOthers ?? (this._hiddenOthers = []);
    let n = 0;
    scene.traverseVisible((o) => {
      if ((o.isMesh === true || o.isInstancedMesh === true) && set.has(o) === false) {
        hidden[n++] = o;
      }
    });
    // Hidden after the walk, not during: traverseVisible prunes on `visible`,
    // and clearing it mid-walk would skip a hidden node's children.
    for (let i = 0; i < n; i++) hidden[i].visible = false;
    this._nHiddenOthers = n;
  }

  _restoreOthers() {
    for (let i = 0; i < this._nHiddenOthers; i++) this._hiddenOthers[i].visible = true;
    this._nHiddenOthers = 0;
  }

  beginRecord() {
    this._seen.clear();
  }

  /** Remember this frame's transforms so next frame can difference them. */
  recordMatrices(objects, count) {
    for (let i = 0; i < count; i++) {
      const o = objects[i];
      this._seen.add(o.id);
      let m = this.prev.get(o.id);
      if (m === undefined) {
        m = new THREE.Matrix4();
        this.prev.set(o.id, m);
      }
      m.copy(o.matrixWorld);
    }
  }

  /** Drop entries for objects that went away, so the map cannot grow forever. */
  endRecord() {
    if (this.prev.size > this._seen.size * 2 + 64) {
      for (const id of this.prev.keys()) if (!this._seen.has(id)) this.prev.delete(id);
    }
  }

  dispose() {
    if (this.rt) this.rt.dispose();
    this.hardwareDepth?.dispose();
    this.material.dispose();
    this.maskMaterial.dispose();
    this.prev.clear();
  }
}

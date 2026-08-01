import * as THREE from 'three';
import { FS_VERT } from './glsl.js';

/**
 * Full-screen triangle infrastructure. One shared geometry, one shared scene,
 * one shared camera — a pass is just a material we swap in. No allocation per
 * frame, no examples/jsm EffectComposer.
 */

const _geometry = new THREE.BufferGeometry();
_geometry.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
);
_geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
_geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);

const _scene = new THREE.Scene();
_scene.matrixAutoUpdate = false;
const _camera = new THREE.Camera();
const _mesh = new THREE.Mesh(_geometry, null);
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
_scene.add(_mesh);

/** Draw `material` over `target` (null = canvas). */
export function blit(renderer, material, target, clear = false, layer = 0) {
  _mesh.material = material;
  renderer.setRenderTarget(target, layer);
  if (clear) renderer.clear(true, false, false);
  renderer.render(_scene, _camera);
}

export function disposeFullScreen() {
  _geometry.dispose();
}

/**
 * A post-processing pass: a ShaderMaterial plus the uniforms it owns.
 *
 * `opts.vertexShader` replaces the shared FS_VERT. It exists so a pass can hoist
 * a frame-constant fetch out of the fragment stage and into the three vertices
 * of the full-screen triangle — see composite.js for the worked example.
 *
 * THE LANGUAGE HERE IS GLSL ES 3.00 EVEN THOUGH `glslVersion` DEFAULTS TO null,
 * and that is not obvious enough to leave unwritten. three.js emits
 * `#version 300 es` for every material that is not a RawShaderMaterial
 * (WebGLProgram.js, "GLSL 3.0 conversion for built-in materials and
 * ShaderMaterial"); `glslVersion` only decides whether it ALSO defines
 * `varying`/`texture2D`/`gl_FragColor` back to their ESSL 1.00 spellings. So the
 * ESSL-1.00-looking shaders in this directory may use `flat` interpolation,
 * `sampler3D` (composite.js already does) and the rest of ES 3.00 — a `flat`
 * varying is the difference between a hoist that is provably bit-identical and
 * one that merely interpolates three copies of the same number.
 */
export class Pass {
  constructor(name, fragmentShader, uniforms, opts = {}) {
    this.name = name;
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms,
      vertexShader: opts.vertexShader ?? FS_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      defines: opts.defines ?? {},
      glslVersion: opts.glslVersion ?? null,
      transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    });
  }
  render(renderer, target, clear = false) {
    blit(renderer, this.material, target, clear);
  }
  dispose() {
    this.material.dispose();
  }
}

/** Half-float colour target with sane defaults for HDR post. */
export function hdrTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  rt.texture.name = opts.name ?? 'hdr';
  return rt;
}

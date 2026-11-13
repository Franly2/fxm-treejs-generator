import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export class Viewer {
  constructor(container, tooltipEl) {
    this.container = container;
    this.tooltip = tooltipEl;
    this.api = null;
    this.root = null;
    this.hoverDirty = false;
    this.mouse = new THREE.Vector2();
    this.ray = new THREE.Raycaster();
    this.hoverHit = null;
    this.onRuntimeError = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 5000);
    this.camera.position.set(8, 6, 10);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;

    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.5));

    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.13 })
    );
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    this.grid = new THREE.GridHelper(40, 40, 0xe5e7eb, 0xf1f5f9);
    this.scene.add(this.grid);

    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const clean = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 500;
      down = null;
      if (clean) this.handleClick(e);
    });
    dom.addEventListener('pointermove', (e) => {
      this.setMouse(e);
      this.hoverDirty = true;
    });
    dom.addEventListener('pointerleave', () => {
      this.hoverDirty = false;
      this.hoverHit = null;
      this.tooltip.classList.remove('show');
      dom.style.cursor = 'default';
    });

    this.renderer.setAnimationLoop(() => this.frame());
  }

  setMouse(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  pick() {
    if (!this.root) return null;
    this.ray.setFromCamera(this.mouse, this.camera);
    const hits = this.ray.intersectObject(this.root, true);
    return hits[0] || null;
  }

  handleClick(e) {
    this.setMouse(e);
    const hit = this.pick();
    if (hit && this.api?.onClick && this.clickable(hit)) {
      try {
        this.api.onClick(hit);
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  clickable(hit) {
    try {
      return this.api?.isClickable ? !!this.api.isClickable(hit) : true;
    } catch {
      return false;
    }
  }

  reportError(err) {
    console.error(err);
    if (this.onRuntimeError) this.onRuntimeError(err);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this.controls.update();
    if (this.api?.update) {
      try {
        this.api.update(dt, t);
      } catch (err) {
        this.api.update = null;
        this.reportError(err);
      }
    }
    if (this.hoverDirty) {
      this.hoverDirty = false;
      const hit = this.pick();
      const can = hit && this.api?.onClick && this.clickable(hit);
      this.renderer.domElement.style.cursor = can ? 'pointer' : 'default';
      if (can && this.api.hoverLabel) {
        const p = hit.point.clone().project(this.camera);
        const r = this.renderer.domElement.getBoundingClientRect();
        this.tooltip.textContent = this.api.hoverLabel;
        this.tooltip.style.left = `${(p.x * 0.5 + 0.5) * r.width}px`;
        this.tooltip.style.top = `${(-p.y * 0.5 + 0.5) * r.height}px`;
        this.tooltip.classList.add('show');
      } else this.tooltip.classList.remove('show');
    }
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        mats.forEach((m) => {
          Object.values(m).forEach((v) => v && v.isTexture && v.dispose());
          m.dispose();
        });
      });
    }
    this.root = null;
    this.api = null;
    this.tooltip.classList.remove('show');
  }

  /** Runs generated code. Returns { ok, error?, stats? }. */
  load(code, opts = {}) {
    const hadRoot = !!this.root;
    const prevPos = this.camera.position.clone();
    const prevTarget = this.controls.target.clone();
    this.clear();
    let out;
    try {
      const fn = new Function('THREE', 'ctx', code);
      out = fn(THREE, {});
      if (!out || !out.root || !out.root.isObject3D) throw new Error('The code must return { root: THREE.Object3D }');
    } catch (err) {
      this.clear();
      return { ok: false, error: `${err.name}: ${err.message}` };
    }
    this.api = out;
    this.root = out.root;
    this.scene.add(this.root);

    let tris = 0;
    let meshes = 0;
    this.root.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        const g = o.geometry;
        const n = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
        tris += n * (o.isInstancedMesh ? o.count : 1);
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.frame3d();
    if (opts.preserveCamera && hadRoot) {
      this.camera.position.copy(prevPos);
      this.controls.target.copy(prevTarget);
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
    return { ok: true, stats: { meshes, triangles: Math.round(tris) } };
  }

  frame3d() {
    if (!this.root) return;
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.1);
    const dist = radius * 1.9;
    this.camera.near = radius / 500;
    this.camera.far = radius * 60;
    this.camera.position.set(center.x + dist * 0.8, center.y + dist * 0.45, center.z + dist);
    this.controls.target.copy(center);
    this.controls.maxDistance = radius * 12;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    this.shadowPlane.position.set(center.x, box.min.y - 0.002, center.z);
    this.shadowPlane.scale.set(radius * 6, radius * 6, 1);
    this.grid.position.set(center.x, box.min.y - 0.004, center.z);
    this.grid.scale.setScalar(Math.max(radius / 20, 0.05));

    const s = radius * 1.3;
    this.sun.position.set(center.x + s, box.max.y + s * 1.2, center.z + s * 0.7);
    this.sun.target.position.copy(center);
    const c = this.sun.shadow.camera;
    c.left = -radius * 1.4; c.right = radius * 1.4; c.top = radius * 1.4; c.bottom = -radius * 1.4;
    c.near = 0.1; c.far = radius * 8;
    c.updateProjectionMatrix();
  }

  async exportGLB(filename) {
    if (!this.root) throw new Error('No model to export');
    const exporter = new GLTFExporter();
    const result = await new Promise((resolve, reject) =>
      exporter.parse(this.root, resolve, reject, { binary: true, onlyVisible: true })
    );
    const blob = new Blob([result], { type: 'model/gltf-binary' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return blob.size;
  }
}


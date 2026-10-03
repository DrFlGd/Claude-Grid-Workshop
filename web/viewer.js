// 3D preview: loads an STL into a Z-up scene over a 42 mm Gridfinity grid.
import * as THREE from "three";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import { STLLoader } from "./vendor/three/STLLoader.js";

const GRID = 42; // mm, one Gridfinity unit

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -220, 170);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a3, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1, -1.5, 2.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-2, 2, 1);
    this.scene.add(rim);
    this.keyLight = key;

    this.material = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.55, metalness: 0.02 });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0x18222d, transparent: true, opacity: 0.55 });
    this.mesh = null;
    this.edges = null;
    this.gridGroup = new THREE.Group();
    this.scene.add(this.gridGroup);
    this.showEdges = false;
    this.showGrid = true;
    this.bbox = null;
    this._buildGrid(new THREE.Box3(new THREE.Vector3(-63, -63, 0), new THREE.Vector3(63, 63, 0)));

    this._resize = () => this.resize();
    new ResizeObserver(this._resize).observe(canvas.parentElement);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setColor(hex) { this.material.color.set(hex); }

  setEdges(on) {
    this.showEdges = on;
    if (this.edges) this.edges.visible = on;
  }

  setGrid(on) {
    this.showGrid = on;
    this.gridGroup.visible = on;
  }

  async load(url) {
    const buf = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Could not load the model (${r.status})`);
      return r.arrayBuffer();
    });
    const geom = new STLLoader().parse(buf);
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    // rest the part on the floor, centred over the grid
    const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
    geom.translate(-cx, -cy, -bb.min.z);
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    this.clear();
    this.mesh = new THREE.Mesh(geom, this.material);
    this.scene.add(this.mesh);
    const triangles = geom.attributes.position.count / 3;
    if (triangles < 400000) {
      this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), this.edgeMaterial);
      this.edges.visible = this.showEdges;
      this.scene.add(this.edges);
    }
    const prevSize = this.bbox ? this.bbox.getSize(new THREE.Vector3()) : null;
    this.bbox = geom.boundingBox.clone();
    this._buildGrid(this.bbox);
    const size = this.bbox.getSize(new THREE.Vector3());
    // keep the user's camera if the part barely changed size; otherwise re-frame
    if (!prevSize || prevSize.distanceTo(size) > 0.15 * Math.max(prevSize.length(), 1)) this.view("iso");
    return { x: size.x, y: size.y, z: size.z, triangles };
  }

  clear() {
    for (const o of [this.mesh, this.edges]) {
      if (o) { this.scene.remove(o); o.geometry.dispose(); }
    }
    this.mesh = this.edges = null;
  }

  _buildGrid(bb) {
    for (const c of [...this.gridGroup.children]) { this.gridGroup.remove(c); c.geometry?.dispose(); }
    const half = (v) => Math.ceil(v / GRID + 1.0) * GRID;
    const hx = Math.max(half(Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x))), GRID * 2);
    const hy = Math.max(half(Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y))), GRID * 2);
    // grid lines sit on cell boundaries so a 2×3 bin covers exactly 2×3 cells
    const ox = Math.round((bb.max.x - bb.min.x) / GRID) % 2 === 1 ? GRID / 2 : 0;
    const oy = Math.round((bb.max.y - bb.min.y) / GRID) % 2 === 1 ? GRID / 2 : 0;
    const pts = [];
    for (let x = -hx + ox; x <= hx + ox + 0.01; x += GRID) pts.push(x, -hy + oy, 0, x, hy + oy, 0);
    for (let y = -hy + oy; y <= hy + oy + 0.01; y += GRID) pts.push(-hx + ox, y, 0, hx + ox, y, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8693a0, transparent: true, opacity: 0.55 }));
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(hx * 2, hy * 2),
      new THREE.MeshBasicMaterial({ color: 0xeef1f4, transparent: true, opacity: 0.7, depthWrite: false })
    );
    plate.position.set(ox, oy, -0.05);
    this.gridGroup.add(plate, lines);
    this.gridGroup.visible = this.showGrid;
  }

  view(name) {
    const bb = this.bbox || new THREE.Box3(new THREE.Vector3(-42, -42, 0), new THREE.Vector3(42, 42, 42));
    const size = bb.getSize(new THREE.Vector3());
    const center = bb.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 20);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.3;
    const dirs = {
      iso: new THREE.Vector3(0.62, -0.95, 0.75),
      top: new THREE.Vector3(0, -0.0001, 1),
      front: new THREE.Vector3(0, -1, 0.08),
    };
    const dir = (dirs[name] || dirs.iso).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 200, 0.1);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}

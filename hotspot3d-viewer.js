// hotspot3d-viewer.js
// Viewer 3D istanziabile con:
// - Sphere / Box / Cylinder
// - Position: X/Y/Z (input + +/-)
// - Rotation: Rot X/Y/Z (input + +/-) per box/cylinder
// - Scale:
//   - sphere: Raggio
//   - box: Scale X/Y/Z
//   - cylinder: Raggio + Altezza
// - Color: color picker
// - Opacity: slider 0–1 con etichetta numerica
// - TransformControls: translate / rotate / scale
// - Limiti dinamici dalla bounding box del modello
// - Background: colore + panorama 360 equirectangular
// - Light intensity: regolabile da API

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const HOTSPOT_SELECTED_COLOR  = 0xffa500;
const HOTSPOT_HIGHLIGHT_COLOR = 0xff0000;

const DEFAULT_SPHERE_R = 0.05;
const DEFAULT_BOX      = { x: 0.08, y: 0.08, z: 0.08 };
const DEFAULT_CYL      = { r: 0.06, h: 0.12 };
const DEFAULT_BOX_ROT  = { x: 0, y: 0, z: 0 }; // gradi
const DEFAULT_CYL_ROT  = { x: 0, y: 0, z: 0 }; // gradi
const DEFAULT_HOTSPOT_HEX = '#00ff00';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const POSITION_STEP = 0.01;
const ROT_STEP      = 1;    // gradi per click rot
const SCALE_STEP    = 0.01; // step per scale / raggio

export class Hotspot3DViewer {
  /**
   * @param {HTMLElement} container
   * @param {{ modelUrl?: string, onEvent?: (msg:{type:string,payload?:any})=>void, background?: number|string }} options
   */
  constructor(container, { modelUrl = '', onEvent = () => {}, background = 0xf0f0f0 } = {}) {
    if (!container) throw new Error('Hotspot3DViewer: container mancante');
    this.container = container;
    this.onEvent = (msg) => { try { onEvent?.(msg); } catch {} };

    // 3D base
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.loader = null;

    // luci
    this.ambientLight = null;
    this.dirLight = null;
    this.axesHelper = null;
    this.lightHelper = null;

    // modello
    this.model = null;
    this.currentModelUrl = '';
    this.pendingModelUrl = '';

    // hotspot + selezione
    /** @type {Record<string,THREE.Mesh>} */
    this.hotspots = {};
    this.selectedHotspotId = null;

    // input picking
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };

    // modalità & creazione
    this.currentMode = 'view';       // 'view' | 'edit' | 'hide'
    this.creationShape = 'sphere';   // 'sphere' | 'box' | 'cylinder'

    // limiti dinamici dal modello
    this.modelLimits = {
      maxSphereR: 0.6,
      maxBox: { x: 1.0, y: 1.0, z: 1.0 },
      maxCylinder: { r: 0.6, h: 1.0 }
    };
    this.modelBounds = {
      min: new THREE.Vector3(-1, -1, -1),
      max: new THREE.Vector3( 1,  1,  1),
      center: new THREE.Vector3(0,0,0),
      size: new THREE.Vector3(2,2,2)
    };

    // UI refs
    this.ui = null;

    // TransformControls
    this.transformControls = null;
    this.transformHelper   = null;

    // stato gizmo
    this.gizmoEnabled = false;
    this.gizmoMode = 'translate'; // 'translate' | 'rotate' | 'scale'

    // panorama
    this.texLoader = new THREE.TextureLoader();
    this._panoramaTexture = null;

    // setup
    this._initScene(background);
    this._mountUI();
    this._bindEvents();
    this._animate();

    if (modelUrl) this.loadModel(modelUrl);
  }

  /* =============== PUBLIC API =============== */

  init(sharedData) {
    const { mode, model3D, pointOfView, hotspots = [] } = sharedData || {};
    this.setMode(mode);

    // modello
    if (typeof model3D === 'string') {
      if (model3D) {
        if (model3D !== this.currentModelUrl) this.loadModel(model3D);
      } else {
        this.pendingModelUrl = '';
        this.currentModelUrl = '';
        this._removeModel();
      }
    }
    this._recomputeLimitsFromModel();

    // POV
    if (pointOfView) {
      this.camera.position.set(pointOfView.X, pointOfView.Y, pointOfView.Z);
      this.controls.update();
      this._emit({
        type: 'onPointOfViewChanged',
        payload: { ...pointOfView }
      });
    }

    // Hotspot
    this._clearHotspots();
    for (const h of hotspots) {
      const shape = ['sphere','box','cylinder'].includes(h.shape) ? h.shape : 'sphere';

      let dims;
      if (shape === 'sphere') {
        dims = { r: (h.dims?.r ?? DEFAULT_SPHERE_R) };
      } else if (shape === 'box') {
        dims = {
          x: (h.dims?.x ?? DEFAULT_BOX.x),
          y: (h.dims?.y ?? DEFAULT_BOX.y),
          z: (h.dims?.z ?? DEFAULT_BOX.z)
        };
      } else {
        dims = {
          r: (h.dims?.r ?? DEFAULT_CYL.r),
          h: (h.dims?.h ?? DEFAULT_CYL.h)
        };
      }
      dims = this._clampDimsToLimits(shape, dims);

      const num = (v, dflt) => Number.isFinite(v) ? v : dflt;

      const rot = (shape === 'box')
        ? { x: num(h.rot?.x, DEFAULT_BOX_ROT.x), y: num(h.rot?.y, DEFAULT_BOX_ROT.y), z: num(h.rot?.z, DEFAULT_BOX_ROT.z) }
        : (shape === 'cylinder')
        ? { x: num(h.rot?.x, DEFAULT_CYL_ROT.x), y: num(h.rot?.y, DEFAULT_CYL_ROT.y), z: num(h.rot?.z, DEFAULT_CYL_ROT.z) }
        : undefined;

      const colorHex = normalizeHex(h.color) ?? DEFAULT_HOTSPOT_HEX;
      const opacity  = Number.isFinite(h.opacity) ? Math.min(Math.max(h.opacity, 0), 1) : 1;

      const mesh = this._createHotspot(
        h.Id,
        { x: h.X, y: h.Y, z: h.Z },
        shape,
        dims,
        rot,
        colorHex,
        opacity
      );
      this.scene.add(mesh);
      this.hotspots[h.Id] = mesh;
    }

    if (hotspots.length) this._selectHotspot(hotspots[0].Id, { notify: false });
    else this._selectHotspot(null, { notify: false });

    this._syncAll();
  }

  loadModel(url) {
    if (!url) return;
    this.pendingModelUrl = url;
    if (this.model) this._removeModel();

    this.loader.load(
      url,
      (gltf) => {
        this.model = gltf.scene;
        this.scene.add(this.model);
        this.currentModelUrl = url;
        this.pendingModelUrl = '';
        this._recomputeLimitsFromModel();
        this._syncAll();
      },
      undefined,
      (error) => {
        this.pendingModelUrl = '';
        this._emit({
          type: 'onModelLoadError',
          payload: { url, message: String(error) }
        });
        this._syncAll();
      }
    );
  }

  setMode(mode) {
    this.currentMode = mode === 'edit' ? 'edit' : (mode === 'hide' ? 'hide' : 'view');
    if (this.currentMode !== 'edit') this._hideUI();

    this._updateTransformControls();
    this._updateHelpersVisibility();

    this._emit({ type: 'onModeApplied', payload: { mode: this.currentMode } });
    this._syncAll();
  }

  setCreationShape(shape) {
    if (['sphere','box','cylinder'].includes(shape)) this.creationShape = shape;
  }

  setBackground(bg) {
    try {
      const color = new THREE.Color(bg);
      this.scene.background = color;
      this._emit({
        type: 'onBackgroundChanged',
        payload: { color: color.getHexString() }
      });
    } catch (e) {
      console.warn('Hotspot3DViewer.setBackground(): colore non valido', bg, e);
    }
  }

  /**
   * Imposta un panorama 360 equirectangular come sfondo.
   * @param {string} url percorso della texture (es. /images/EiffelTower.jpg)
   */
  setPanorama(url) {
    if (!url) {
      // rimuovi panorama, eventualmente torna ad un colore di sfondo
      this.scene.background = new THREE.Color(0x000000);
      if (this._panoramaTexture) {
        this._panoramaTexture.dispose();
        this._panoramaTexture = null;
      }
      this._emit({
        type: 'onBackgroundPanoramaChanged',
        payload: { url: '' }
      });
      return;
    }

    this.texLoader.load(
      url,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        this._panoramaTexture = tex;
        this.scene.background = tex;
        this._emit({
          type: 'onBackgroundPanoramaChanged',
          payload: { url }
        });
      },
      undefined,
      (error) => {
        console.error('Errore caricamento panorama 360:', error);
        this._emit({
          type: 'onBackgroundPanoramaError',
          payload: { url, message: String(error) }
        });
      }
    );
  }

  /**
   * Imposta l'intensità della luce direzionale principale (0..3 tipicamente).
   */
  setLightIntensity(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || !this.dirLight) return;
    const clamped = Math.min(Math.max(v, 0), 3);
    this.dirLight.intensity = clamped;
    this._emit({
      type: 'onLightChanged',
      payload: { intensity: clamped }
    });
  }

  highlightHotspot(id) {
    this._selectHotspot(id, { notify:false, color: HOTSPOT_HIGHLIGHT_COLOR });
  }

  getSharedData() { return this._buildSharedData(); }
  requestSync()    { this._syncAll(); }

  /* =============== INTERNAL =============== */

  _initScene(background) {
    const cs = getComputedStyle(this.container);
    if (cs.position === 'static') this.container.style.position = 'relative';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, 1.5, 3);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // tone mapping "soft"
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;

    this._updateRendererSize();
    this.renderer.domElement.style.width  = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    // luci più morbide
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(this.ambientLight);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.dirLight.position.set(2, 5, 2);
    this.scene.add(this.dirLight);

    // helper
    this.lightHelper = new THREE.DirectionalLightHelper(this.dirLight, 0.3);
    this.axesHelper  = new THREE.AxesHelper(1);
    this.scene.add(this.lightHelper);
    this.scene.add(this.axesHelper);

    this._updateHelpersVisibility();

    this.loader = new GLTFLoader();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('end', () => {
      this._emit({
        type: 'onPointOfViewChanged',
        payload: {
          X: this.camera.position.x,
          Y: this.camera.position.y,
          Z: this.camera.position.z
        }
      });
      this._syncAll();
    });

    this._resizeObserver = new ResizeObserver(() => this._updateRendererSize());
    this._resizeObserver.observe(this.container);
    window.addEventListener('resize', this._updateRendererSize);

    // TransformControls
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setMode(this.gizmoMode);
    this.transformControls.setTranslationSnap(null);
    this.transformControls.size = 0.9;

    // r181+: helper da getHelper() se disponibile
    this.transformHelper = (typeof this.transformControls.getHelper === 'function')
      ? this.transformControls.getHelper()
      : this.transformControls;

    if (this.transformHelper && this.transformHelper.isObject3D) {
      this.scene.add(this.transformHelper);
      this.transformHelper.visible = false;
    }

    // disabilita Orbit mentre trascino
    this.transformControls.addEventListener('dragging-changed', (ev) => {
      this.controls.enabled = !ev.value;
    });

    // aggiornamento live con gizmo
    this.transformControls.addEventListener('objectChange', () => {
      if (!this.selectedHotspotId) return;
      const mesh = this.hotspots[this.selectedHotspotId];
      if (!mesh) return;

      // scale uniforme per sphere
      if (this.gizmoMode === 'scale' && mesh.userData.shape === 'sphere') {
        const sx = mesh.scale.x || 1;
        const sy = mesh.scale.y || 1;
        const sz = mesh.scale.z || 1;
        const s  = (sx + sy + sz) / 3;
        mesh.scale.set(s, s, s);
      }

      // scale cilindro: raggio sugli assi X/Z, altezza su Y
      if (this.gizmoMode === 'scale' && mesh.userData.shape === 'cylinder') {
        const sx = mesh.scale.x || 1;
        const sy = mesh.scale.y || 1;
        const sz = mesh.scale.z || 1;
        const radial = (sx + sz) / 2;
        mesh.scale.set(radial, sy, radial);
      }

      if (this.gizmoMode === 'translate' && this.ui && this.selectedHotspotId === mesh.name) {
        this._updatePosFieldsFromMesh(mesh);
      }

      if (this.gizmoMode === 'rotate' && this.ui && this.selectedHotspotId === mesh.name) {
        if (mesh.userData.shape === 'box' || mesh.userData.shape === 'cylinder') {
          this._updateRotFieldsFromMesh(mesh);
        }
      }

      this._syncAll();
    });

    // commit al mouseUp
    this.transformControls.addEventListener('mouseUp', () => {
      if (!this.selectedHotspotId) return;
      const mesh = this.hotspots[this.selectedHotspotId];
      if (!mesh) return;

      const ud = mesh.userData || {};

      // scala
      if (this.gizmoMode === 'scale') {
        const sx = mesh.scale.x || 1;
        const sy = mesh.scale.y || 1;
        const sz = mesh.scale.z || 1;

        if (ud.shape === 'sphere') {
          const s = (sx + sy + sz) / 3;
          const newR = (ud.dims?.r || DEFAULT_SPHERE_R) * s;
          mesh.scale.set(1,1,1);
          this._resizeSelectedSphere(newR, true);
          return;
        } else if (ud.shape === 'box') {
          const base = ud.dims || DEFAULT_BOX;
          const dims = {
            x: base.x * sx,
            y: base.y * sy,
            z: base.z * sz
          };
          mesh.scale.set(1,1,1);
          this._resizeSelectedBox(dims, true);
          return;
        } else if (ud.shape === 'cylinder') {
          const base = ud.dims || DEFAULT_CYL;
          const radialS = (sx + sz) / 2;
          const dims = {
            r: base.r * radialS,
            h: base.h * sy
          };
          mesh.scale.set(1,1,1);
          this._resizeSelectedCylinder(dims, true);
          return;
        }
      }

      // rotazione
      if (this.gizmoMode === 'rotate') {
        if (ud.shape === 'box' || ud.shape === 'cylinder') {
          ud.rot = {
            x: mesh.rotation.x * RAD2DEG,
            y: mesh.rotation.y * RAD2DEG,
            z: mesh.rotation.z * RAD2DEG,
          };
          mesh.userData.rot = ud.rot;
          this._updateRotFieldsFromMesh(mesh);
        }
      }

      // traslazione (o generico)
      const p = mesh.position;
      const payload = {
        Id: this.selectedHotspotId,
        X: p.x, Y: p.y, Z: p.z,
        shape: ud.shape,
        dims: { ...(ud.dims || {}) },
        color: ud.color,
        opacity: ud.opacity
      };
      if (ud.rot) payload.rot = { ...ud.rot };
      this._emit({ type: 'onHotspotUpdated', payload });

      this._updatePosFieldsFromMesh(mesh);
      this._syncAll();
    });
  }

  _updateRendererSize = () => {
    const w = Math.max(this.container.clientWidth || 1, 1);
    const h = Math.max(this.container.clientHeight || 1, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  _animate = () => {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  _mountUI() {
    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'absolute', right: '12px', top: '12px', zIndex: '10',
      minWidth: '220px', maxWidth: '280px',
      background: 'rgba(255,255,255,0.9)', color: '#111',
      borderRadius: '10px', padding: '10px 12px',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      boxShadow: '0 6px 24px rgba(0,0,0,0.25)', display: 'none'
    });

    const title = document.createElement('h4');
    title.style.margin = '0 0 6px 0';
    title.style.fontSize = '14px';
    title.textContent = 'Hotspot';
    root.appendChild(title);

    // ===== TOP BAR Gizmo + Mode =====
    const topBar = document.createElement('div');
    Object.assign(topBar.style, {
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      marginBottom: '8px',
      flexWrap: 'wrap'
    });

    const btnGizmo = document.createElement('button');
    btnGizmo.textContent = 'Gizmo OFF';
    Object.assign(btnGizmo.style, {
      padding: '.35rem .6rem',
      border: '1px solid #00000030',
      background: '#f0f0f0',
      borderRadius: '.5rem',
      cursor: 'pointer',
      fontSize: '12px',
      whiteSpace: 'nowrap'
    });

    const updateGizmoButtonUI = () => {
      if (this.gizmoEnabled) {
        btnGizmo.textContent = 'Gizmo ON';
        btnGizmo.style.background = '#d1f5d3';
        btnGizmo.style.borderColor = '#58b965';
      } else {
        btnGizmo.textContent = 'Gizmo OFF';
        btnGizmo.style.background = '#f0f0f0';
        btnGizmo.style.borderColor = '#00000030';
      }
    };
    updateGizmoButtonUI();

    btnGizmo.addEventListener('click', () => {
      this.gizmoEnabled = !this.gizmoEnabled;
      updateGizmoButtonUI();
      this._updateTransformControls();
    });

    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'Mode';
    modeLabel.style.fontSize = '12px';
    modeLabel.style.opacity = '.8';

    const modeSelect = document.createElement('select');
    Object.assign(modeSelect.style, {
      fontSize: '12px',
      padding: '2px 4px',
      borderRadius: '6px',
      border: '1px solid #00000030',
      background: '#ffffff'
    });
    modeSelect.innerHTML = `
      <option value="translate">Translate</option>
      <option value="rotate">Rotate</option>
      <option value="scale">Scale</option>
    `;
    modeSelect.value = this.gizmoMode;
    modeSelect.addEventListener('change', () => {
      this.gizmoMode = modeSelect.value;
      if (this.transformControls) this.transformControls.setMode(this.gizmoMode);
      this._updateTransformControls();
    });

    topBar.appendChild(btnGizmo);
    topBar.appendChild(modeLabel);
    topBar.appendChild(modeSelect);
    root.appendChild(topBar);

    // ===== POSITION BLOCK =====
    const posBlock = document.createElement('div');
    const posTitle = document.createElement('div');
    posTitle.textContent = 'Position';
    posTitle.style.fontSize = '12px';
    posTitle.style.opacity = '.8';
    posTitle.style.marginBottom = '4px';
    posBlock.appendChild(posTitle);

    const makeAxisRow = (axisLabel) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '4px'
      });

      const lab = document.createElement('span');
      lab.textContent = axisLabel;
      lab.style.fontSize = '12px';
      lab.style.width = '16px';

      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.001';
      input.style.width = '80px';
      input.style.fontSize = '12px';
      input.style.padding = '2px 4px';
      input.style.borderRadius = '4px';
      input.style.border = '1px solid #00000030';

      const btnMinus = document.createElement('button');
      btnMinus.textContent = '–';
      Object.assign(btnMinus.style, {
        width: '22px',
        height: '22px',
        padding: '0',
        borderRadius: '4px',
        border: '1px solid #00000030',
        background: '#f3f3f3',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1'
      });

      const btnPlus = document.createElement('button');
      btnPlus.textContent = '+';
      Object.assign(btnPlus.style, {
        width: '22px',
        height: '22px',
        padding: '0',
        borderRadius: '4px',
        border: '1px solid #00000030',
        background: '#f3f3f3',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1'
      });

      row.appendChild(lab);
      row.appendChild(input);
      row.appendChild(btnMinus);
      row.appendChild(btnPlus);

      return { row, input, btnMinus, btnPlus };
    };

    const posRowX = makeAxisRow('X');
    const posRowY = makeAxisRow('Y');
    const posRowZ = makeAxisRow('Z');
    posBlock.appendChild(posRowX.row);
    posBlock.appendChild(posRowY.row);
    posBlock.appendChild(posRowZ.row);

    // ===== ROTATION BLOCK =====
    const rotBlock = document.createElement('div');
    const rotTitle = document.createElement('div');
    rotTitle.textContent = 'Rotation (°)';
    rotTitle.style.fontSize = '12px';
    rotTitle.style.opacity = '.8';
    rotTitle.style.margin = '8px 0 4px 0';
    rotBlock.appendChild(rotTitle);

    const makeRotRow = (labelText) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '4px'
      });

      const lab = document.createElement('span');
      lab.textContent = labelText;
      lab.style.fontSize = '12px';
      lab.style.width = '40px';

      const input = document.createElement('input');
      input.type = 'number';
      input.step = '1';
      input.min = '-180';
      input.max = '180';
      input.style.width = '70px';
      input.style.fontSize = '12px';
      input.style.padding = '2px 4px';
      input.style.borderRadius = '4px';
      input.style.border = '1px solid #00000030';

      const btnMinus = document.createElement('button');
      btnMinus.textContent = '–';
      Object.assign(btnMinus.style, {
        width: '22px',
        height: '22px',
        padding: '0',
        borderRadius: '4px',
        border: '1px solid #00000030',
        background: '#f3f3f3',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1'
      });

      const btnPlus = document.createElement('button');
      btnPlus.textContent = '+';
      Object.assign(btnPlus.style, {
        width: '22px',
        height: '22px',
        padding: '0',
        borderRadius: '4px',
        border: '1px solid #00000030',
        background: '#f3f3f3',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1'
      });

      row.appendChild(lab);
      row.appendChild(input);
      row.appendChild(btnMinus);
      row.appendChild(btnPlus);

      return { row, input, btnMinus, btnPlus };
    };

    const rotRowX = makeRotRow('Rot X');
    const rotRowY = makeRotRow('Rot Y');
    const rotRowZ = makeRotRow('Rot Z');
    rotBlock.appendChild(rotRowX.row);
    rotBlock.appendChild(rotRowY.row);
    rotBlock.appendChild(rotRowZ.row);

    // ===== SCALE BLOCKS (solo input) =====

    const makeScaleRow = (labelText) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '4px'
      });

      const lab = document.createElement('span');
      lab.textContent = labelText;
      lab.style.fontSize = '12px';
      lab.style.width = '60px';

      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.001';
      input.style.width = '70px';
      input.style.fontSize = '12px';
      input.style.padding = '2px 4px';
      input.style.borderRadius = '4px';
      input.style.border = '1px solid #00000030';

      const btnMinus = document.createElement('button');
      btnMinus.textContent = '–';
      Object.assign(btnMinus.style, {
        width: '22px',
        height: '22px',
        padding: '0',
        borderRadius: '4px',
        border: '1px solid #00000030',
        background: '#f3f3f3',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1'
      });

      const btnPlus = document.createElement('button');
      btnPlus.textContent = '+';
      Object.assign(btnPlus.style, {
        width: '22px',
        height: '22px',
        padding: '0',
        borderRadius: '4px',
        border: '1px solid #00000030',
        background: '#f3f3f3',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1'
      });

      row.appendChild(lab);
      row.appendChild(input);
      row.appendChild(btnMinus);
      row.appendChild(btnPlus);

      return { row, input, btnMinus, btnPlus };
    };

    // sphere: raggio
    const sphereBlock = document.createElement('div');
    const sphTitle = document.createElement('div');
    sphTitle.textContent = 'Scale (Sphere)';
    sphTitle.style.fontSize = '12px';
    sphTitle.style.opacity = '.8';
    sphTitle.style.margin = '8px 0 4px 0';
    sphereBlock.appendChild(sphTitle);
    const sphRow = makeScaleRow('Raggio');
    sphereBlock.appendChild(sphRow.row);

    // box: scale X/Y/Z
    const boxBlock = document.createElement('div');
    const boxTitle = document.createElement('div');
    boxTitle.textContent = 'Scale (Box)';
    boxTitle.style.fontSize = '12px';
    boxTitle.style.opacity = '.8';
    boxTitle.style.margin = '8px 0 4px 0';
    boxBlock.appendChild(boxTitle);
    const boxRowX = makeScaleRow('Scale X');
    const boxRowY = makeScaleRow('Scale Y');
    const boxRowZ = makeScaleRow('Scale Z');
    boxBlock.appendChild(boxRowX.row);
    boxBlock.appendChild(boxRowY.row);
    boxBlock.appendChild(boxRowZ.row);

    // cylinder: raggio, altezza
    const cylBlock = document.createElement('div');
    const cylTitle = document.createElement('div');
    cylTitle.textContent = 'Scale (Cylinder)';
    cylTitle.style.fontSize = '12px';
    cylTitle.style.opacity = '.8';
    cylTitle.style.margin = '8px 0 4px 0';
    cylBlock.appendChild(cylTitle);
    const cylRowR = makeScaleRow('Raggio');
    const cylRowH = makeScaleRow('Altezza');
    cylBlock.appendChild(cylRowR.row);
    cylBlock.appendChild(cylRowH.row);

    // ===== COLOR & OPACITY =====

    const colorBlock = document.createElement('div');
    const colorLabel = document.createElement('label');
    colorLabel.textContent = 'color';
    colorLabel.style.display = 'block';
    colorLabel.style.fontSize = '12px';
    colorLabel.style.opacity = '.8';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = DEFAULT_HOTSPOT_HEX;
    colorInput.style.width = '100%';
    colorInput.style.height = '32px';
    colorInput.style.padding = '0';
    colorInput.style.border = '1px solid #00000030';
    colorInput.style.borderRadius = '6px';

    colorBlock.appendChild(colorLabel);
    colorBlock.appendChild(colorInput);

    // Opacity
    const opacityBlock = document.createElement('div');
    opacityBlock.style.marginTop = '6px';

    const opacityLabel = document.createElement('label');
    opacityLabel.style.display = 'flex';
    opacityLabel.style.alignItems = 'center';
    opacityLabel.style.justifyContent = 'space-between';
    opacityLabel.style.fontSize = '12px';
    opacityLabel.style.opacity = '.8';

    const opacityText = document.createElement('span');
    opacityText.textContent = 'opacity';

    const opacityValueLabel = document.createElement('span');
    opacityValueLabel.textContent = '1.00';
    opacityValueLabel.style.fontSize = '11px';
    opacityValueLabel.style.opacity = '.7';

    opacityLabel.appendChild(opacityText);
    opacityLabel.appendChild(opacityValueLabel);

    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0';
    opacitySlider.max = '1';
    opacitySlider.step = '0.01';
    opacitySlider.value = '1';
    opacitySlider.style.width = '100%';

    opacityBlock.appendChild(opacityLabel);
    opacityBlock.appendChild(opacitySlider);

    // ===== ACTIONS =====
    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
      marginTop: '8px'
    });

    const btnDelete = document.createElement('button');
    btnDelete.textContent = 'Delete';
    Object.assign(btnDelete.style, {
      padding: '.35rem .6rem',
      border: '1px solid #ff8a8a',
      background: '#ffe6e6',
      borderRadius: '.5rem',
      cursor: 'pointer',
      fontSize: '12px',
      whiteSpace: 'nowrap'
    });
    btnDelete.addEventListener('mouseenter', () => { btnDelete.style.background = '#ffd6d6'; });
    btnDelete.addEventListener('mouseleave', () => { btnDelete.style.background = '#ffe6e6'; });

    const btnClose = document.createElement('button');
    btnClose.textContent = 'Chiudi';
    Object.assign(btnClose.style, {
      padding: '.35rem .6rem',
      border: '1px solid #00000030',
      background: '#f6f6f6',
      borderRadius: '.5rem',
      cursor: 'pointer',
      fontSize: '12px',
      whiteSpace: 'nowrap'
    });

    actions.appendChild(btnDelete);
    actions.appendChild(btnClose);

    // ordine UI
    root.appendChild(posBlock);
    root.appendChild(rotBlock);
    root.appendChild(sphereBlock);
    root.appendChild(boxBlock);
    root.appendChild(cylBlock);
    root.appendChild(colorBlock);
    root.appendChild(opacityBlock);
    root.appendChild(actions);

    // ===== memorizzazione refs UI =====
    this.ui = {
      root, title,
      pos: {
        block: posBlock,
        x: { input: posRowX.input, dec: posRowX.btnMinus, inc: posRowX.btnPlus },
        y: { input: posRowY.input, dec: posRowY.btnMinus, inc: posRowY.btnPlus },
        z: { input: posRowZ.input, dec: posRowZ.btnMinus, inc: posRowZ.btnPlus },
      },
      sphere: {
        block: sphereBlock,
        r: { input: sphRow.input, dec: sphRow.btnMinus, inc: sphRow.btnPlus },
      },
      box: {
        block: boxBlock,
        x: { input: boxRowX.input, dec: boxRowX.btnMinus, inc: boxRowX.btnPlus },
        y: { input: boxRowY.input, dec: boxRowY.btnMinus, inc: boxRowY.btnPlus },
        z: { input: boxRowZ.input, dec: boxRowZ.btnMinus, inc: boxRowZ.btnPlus },
      },
      cyl: {
        block: cylBlock,
        r: { input: cylRowR.input, dec: cylRowR.btnMinus, inc: cylRowR.btnPlus },
        h: { input: cylRowH.input, dec: cylRowH.btnMinus, inc: cylRowH.btnPlus },
      },
      rot: {
        block: rotBlock,
        x: { input: rotRowX.input, dec: rotRowX.btnMinus, inc: rotRowX.btnPlus },
        y: { input: rotRowY.input, dec: rotRowY.btnMinus, inc: rotRowY.btnPlus },
        z: { input: rotRowZ.input, dec: rotRowZ.btnMinus, inc: rotRowZ.btnPlus },
      },
      color: { block: colorBlock, input: colorInput },
      opacity: { block: opacityBlock, slider: opacitySlider, label: opacityValueLabel },
      btnDelete, btnClose,
      btnGizmo,
      updateGizmoButtonUI,
      modeSelect
    };

    // ===== listeners UI =====
    btnClose.addEventListener('click', () => this._hideUI());
    btnDelete.addEventListener('click', () => {
      if (this.selectedHotspotId) this._removeHotspot(this.selectedHotspotId);
    });

    // posizione: input + +/- 
    const applyAxisValue = (axis) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;
      const uiAxis = this.ui.pos[axis];

      const v = parseFloat(uiAxis.input.value);
      if (!Number.isFinite(v)) return;

      mesh.position[axis] = v;

      if (this.transformControls && this.currentMode === 'edit' && this.gizmoEnabled) {
        this.transformControls.attach(mesh);
      }

      const ud = mesh.userData || {};
      const p = mesh.position;
      const payload = {
        Id: id,
        X: p.x, Y: p.y, Z: p.z,
        shape: ud.shape,
        dims: { ...(ud.dims || {}) },
        color: ud.color,
        opacity: ud.opacity
      };
      if (ud.rot) payload.rot = { ...ud.rot };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };

    const applyAxisStep = (axis, sign) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;

      const current = mesh.position[axis] || 0;
      const next = current + sign * POSITION_STEP;
      mesh.position[axis] = next;

      this._updatePosFieldsFromMesh(mesh);

      if (this.transformControls && this.currentMode === 'edit' && this.gizmoEnabled) {
        this.transformControls.attach(mesh);
      }

      const ud = mesh.userData || {};
      const p = mesh.position;
      const payload = {
        Id: id,
        X: p.x, Y: p.y, Z: p.z,
        shape: ud.shape,
        dims: { ...(ud.dims || {}) },
        color: ud.color,
        opacity: ud.opacity
      };
      if (ud.rot) payload.rot = { ...ud.rot };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };

    ['x','y','z'].forEach(axis => {
      const uiAxis = this.ui.pos[axis];

      uiAxis.input.addEventListener('change', () => applyAxisValue(axis));
      uiAxis.input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') applyAxisValue(axis);
      });

      uiAxis.dec.addEventListener('click', () => applyAxisStep(axis, -1));
      uiAxis.inc.addEventListener('click', () => applyAxisStep(axis, +1));
    });

    // scale sphere (raggio)
    const applySphereRadiusValue = () => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'sphere') return;

      let r = parseFloat(this.ui.sphere.r.input.value);
      if (!Number.isFinite(r)) return;
      r = Math.max(0.01, Math.min(r, this.modelLimits.maxSphereR));
      this.ui.sphere.r.input.value = r.toFixed(3);
      this._resizeSelectedSphere(r, true);
    };

    const applySphereRadiusStep = (sign) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'sphere') return;

      const dims = mesh.userData.dims || { r: DEFAULT_SPHERE_R };
      let r = dims.r || DEFAULT_SPHERE_R;
      r += sign * SCALE_STEP;
      r = Math.max(0.01, Math.min(r, this.modelLimits.maxSphereR));
      this._resizeSelectedSphere(r, true);
      if (this.ui.sphere?.r?.input) {
        this.ui.sphere.r.input.value = r.toFixed(3);
      }
    };

    this.ui.sphere.r.input.addEventListener('change', applySphereRadiusValue);
    this.ui.sphere.r.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') applySphereRadiusValue();
    });
    this.ui.sphere.r.dec.addEventListener('click', () => applySphereRadiusStep(-1));
    this.ui.sphere.r.inc.addEventListener('click', () => applySphereRadiusStep(+1));

    // scale box
    const applyBoxDims = () => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'box') return;

      let dims = {
        x: parseFloat(this.ui.box.x.input.value),
        y: parseFloat(this.ui.box.y.input.value),
        z: parseFloat(this.ui.box.z.input.value),
      };
      if (!Number.isFinite(dims.x) || !Number.isFinite(dims.y) || !Number.isFinite(dims.z)) return;

      dims = this._clampDimsToLimits('box', dims);
      this.ui.box.x.input.value = dims.x.toFixed(3);
      this.ui.box.y.input.value = dims.y.toFixed(3);
      this.ui.box.z.input.value = dims.z.toFixed(3);

      this._resizeSelectedBox(dims, true);
    };

    const applyBoxStep = (axis, sign) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'box') return;

      let dims = mesh.userData.dims || { ...DEFAULT_BOX };
      let v = dims[axis] || DEFAULT_BOX[axis];
      v += sign * SCALE_STEP;
      dims[axis] = v;

      dims = this._clampDimsToLimits('box', dims);
      this._resizeSelectedBox(dims, true);

      this.ui.box.x.input.value = dims.x.toFixed(3);
      this.ui.box.y.input.value = dims.y.toFixed(3);
      this.ui.box.z.input.value = dims.z.toFixed(3);
    };

    ['x','y','z'].forEach(axis => {
      const uiAxis = this.ui.box[axis];
      uiAxis.input.addEventListener('change', applyBoxDims);
      uiAxis.input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') applyBoxDims();
      });
      uiAxis.dec.addEventListener('click', () => applyBoxStep(axis, -1));
      uiAxis.inc.addEventListener('click', () => applyBoxStep(axis, +1));
    });

    // scale cylinder
    const applyCylDims = () => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'cylinder') return;

      let dims = {
        r: parseFloat(this.ui.cyl.r.input.value),
        h: parseFloat(this.ui.cyl.h.input.value),
      };
      if (!Number.isFinite(dims.r) || !Number.isFinite(dims.h)) return;

      dims = this._clampDimsToLimits('cylinder', dims);
      this.ui.cyl.r.input.value = dims.r.toFixed(3);
      this.ui.cyl.h.input.value = dims.h.toFixed(3);

      this._resizeSelectedCylinder(dims, true);
    };

    const applyCylStep = (key, sign) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'cylinder') return;

      let dims = mesh.userData.dims || { ...DEFAULT_CYL };
      let v = dims[key] || DEFAULT_CYL[key];
      v += sign * SCALE_STEP;
      dims[key] = v;

      dims = this._clampDimsToLimits('cylinder', dims);
      this._resizeSelectedCylinder(dims, true);

      this.ui.cyl.r.input.value = dims.r.toFixed(3);
      this.ui.cyl.h.input.value = dims.h.toFixed(3);
    };

    this.ui.cyl.r.input.addEventListener('change', applyCylDims);
    this.ui.cyl.h.input.addEventListener('change', applyCylDims);
    this.ui.cyl.r.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyCylDims(); });
    this.ui.cyl.h.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyCylDims(); });
    this.ui.cyl.r.dec.addEventListener('click', () => applyCylStep('r', -1));
    this.ui.cyl.r.inc.addEventListener('click', () => applyCylStep('r', +1));
    this.ui.cyl.h.dec.addEventListener('click', () => applyCylStep('h', -1));
    this.ui.cyl.h.inc.addEventListener('click', () => applyCylStep('h', +1));

    // rotazione: input + +/-
    const applyRotAxisValue = (axis) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;
      if (!(mesh.userData.shape === 'box' || mesh.userData.shape === 'cylinder')) return;

      const uiAxis = this.ui.rot[axis];
      const v = parseFloat(uiAxis.input.value);
      if (!Number.isFinite(v)) return;

      const rot = mesh.userData.rot || { x: 0, y: 0, z: 0 };
      rot[axis] = v;
      mesh.userData.rot = rot;

      mesh.rotation.set(
        (rot.x || 0) * DEG2RAD,
        (rot.y || 0) * DEG2RAD,
        (rot.z || 0) * DEG2RAD
      );

      if (this.transformControls && this.currentMode === 'edit' && this.gizmoEnabled) {
        this.transformControls.attach(mesh);
      }

      const c = mesh.position;
      const payload = {
        Id: id,
        X: c.x, Y: c.y, Z: c.z,
        shape: mesh.userData.shape,
        dims: { ...mesh.userData.dims },
        rot: { ...mesh.userData.rot },
        color: mesh.userData.color,
        opacity: mesh.userData.opacity
      };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };

    const applyRotAxisStep = (axis, sign) => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;
      if (!(mesh.userData.shape === 'box' || mesh.userData.shape === 'cylinder')) return;

      const rot = mesh.userData.rot || { x: 0, y: 0, z: 0 };
      const current = rot[axis] || 0;
      let next = current + sign * ROT_STEP;
      if (next > 180) next -= 360;
      if (next < -180) next += 360;
      rot[axis] = next;
      mesh.userData.rot = rot;

      mesh.rotation.set(
        (rot.x || 0) * DEG2RAD,
        (rot.y || 0) * DEG2RAD,
        (rot.z || 0) * DEG2RAD
      );

      this._updateRotFieldsFromMesh(mesh);

      if (this.transformControls && this.currentMode === 'edit' && this.gizmoEnabled) {
        this.transformControls.attach(mesh);
      }

      const c = mesh.position;
      const payload = {
        Id: id,
        X: c.x, Y: c.y, Z: c.z,
        shape: mesh.userData.shape,
        dims: { ...mesh.userData.dims },
        rot: { ...mesh.userData.rot },
        color: mesh.userData.color,
        opacity: mesh.userData.opacity
      };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };

    ['x','y','z'].forEach(axis => {
      const uiAxis = this.ui.rot[axis];

      uiAxis.input.addEventListener('change', () => applyRotAxisValue(axis));
      uiAxis.input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') applyRotAxisValue(axis);
      });

      uiAxis.dec.addEventListener('click', () => applyRotAxisStep(axis, -1));
      uiAxis.inc.addEventListener('click', () => applyRotAxisStep(axis, +1));
    });

    // colore
    const onColorChange = () => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;
      const hex = this.ui.color.input.value || DEFAULT_HOTSPOT_HEX;
      mesh.userData.color = normalizeHex(hex);
      // il selezionato ha colore di evidenza; per gli altri usiamo userData.color
      if (this.selectedHotspotId !== id) {
        mesh.material.color.set(mesh.userData.color);
      }
      const c = mesh.position;
      const payload = {
        Id: id,
        X: c.x, Y: c.y, Z: c.z,
        shape: mesh.userData.shape,
        dims: { ...mesh.userData.dims },
        color: mesh.userData.color,
        opacity: mesh.userData.opacity
      };
      if (mesh.userData.rot) payload.rot = { ...mesh.userData.rot };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };
    this.ui.color.input.addEventListener('input', onColorChange);
    this.ui.color.input.addEventListener('change', onColorChange);

    // opacity
    const onOpacityChange = () => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;

      let v = parseFloat(this.ui.opacity.slider.value);
      if (!Number.isFinite(v)) v = 1;
      v = Math.min(Math.max(v, 0), 1);
      this.ui.opacity.slider.value = v.toString();
      this.ui.opacity.label.textContent = v.toFixed(2);

      mesh.userData.opacity = v;
      mesh.material.opacity = v;
      mesh.material.transparent = v < 1;
      mesh.material.needsUpdate = true;

      const ud = mesh.userData || {};
      const p = mesh.position;
      const payload = {
        Id: id,
        X: p.x, Y: p.y, Z: p.z,
        shape: ud.shape,
        dims: { ...(ud.dims || {}) },
        color: ud.color,
        opacity: ud.opacity
      };
      if (ud.rot) payload.rot = { ...ud.rot };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };
    this.ui.opacity.slider.addEventListener('input', onOpacityChange);
    this.ui.opacity.slider.addEventListener('change', onOpacityChange);

    this.container.appendChild(root);
    this._applyLimitsToUI();
  }

  _bindEvents() {
    const dom = this.renderer.domElement;

    dom.addEventListener('mousedown', (e) => {
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.isDragging = false;
    });

    dom.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.sqrt(dx*dx + dy*dy) > 5) this.isDragging = true;
    });

    dom.addEventListener('mouseup', (e) => {
      if (!this.isDragging) this._handlePointerTap(e);
    });

    window.addEventListener('keydown', (e) => {
      if (this.currentMode !== 'edit') return;
      if (!this.selectedHotspotId) return;

      const target = e.target;
      const tag = target && target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        this._removeHotspot(this.selectedHotspotId);
      }
    });
  }

  _emit(msg) { this.onEvent?.(msg); }

  _buildSharedData() {
    const list = Object.entries(this.hotspots).map(([Id, mesh]) => {
      const shape = mesh.userData?.shape || 'sphere';
      const dims  = mesh.userData?.dims  || {};
      const rot   = mesh.userData?.rot;
      const colorHex = mesh.userData?.color || DEFAULT_HOTSPOT_HEX;
      const opacity  = Number.isFinite(mesh.userData?.opacity)
        ? mesh.userData.opacity
        : (mesh.material.opacity ?? 1);

      const base = {
        Id,
        X: mesh.position.x, Y: mesh.position.y, Z: mesh.position.z,
        shape,
        dims: (shape === 'sphere')
          ? { r: dims?.r ?? DEFAULT_SPHERE_R }
          : (shape === 'box')
          ? {
              x: dims?.x ?? DEFAULT_BOX.x,
              y: dims?.y ?? DEFAULT_BOX.y,
              z: dims?.z ?? DEFAULT_BOX.z
            }
          : {
              r: dims?.r ?? DEFAULT_CYL.r,
              h: dims?.h ?? DEFAULT_CYL.h
            },
        color: colorHex,
        opacity
      };

      if (shape === 'box' || shape === 'cylinder') {
        base.rot = {
          x: Number.isFinite(rot?.x) ? rot.x : (mesh.rotation.x * RAD2DEG),
          y: Number.isFinite(rot?.y) ? rot.y : (mesh.rotation.y * RAD2DEG),
          z: Number.isFinite(rot?.z) ? rot.z : (mesh.rotation.z * RAD2DEG),
        };
      }

      return base;
    });

    return {
      mode: this.currentMode,
      model3D: (this.currentModelUrl || this.pendingModelUrl || ''),
      pointOfView: {
        X: this.camera.position.x,
        Y: this.camera.position.y,
        Z: this.camera.position.z
      },
      hotspots: list,
    };
  }

  _syncAll() {
    this._emit({ type: 'SYNC_DATA', payload: this._buildSharedData() });
  }

  _removeModel() {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model = null;
    this._recomputeLimitsFromModel();
  }

  _clearHotspots() {
    if (this.transformControls && this.transformHelper) {
      this.transformControls.detach();
      this.transformHelper.visible = false;
    }
    Object.values(this.hotspots).forEach((mesh) => {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
    this.hotspots = {};
    this.selectedHotspotId = null;
    this._hideUI();
  }

  _handlePointerTap(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const hotspotMeshes = Object.values(this.hotspots);
    if (hotspotMeshes.length > 0) {
      const hotspotHit = this.raycaster.intersectObjects(hotspotMeshes, false);
      if (hotspotHit.length > 0) {
        this._selectHotspot(hotspotHit[0].object.name);
        return;
      }
    }

    if (this.currentMode !== 'edit') {
      this._selectHotspot(null);
      return;
    }

    if (!this.model) return;
    const intersects = this.raycaster.intersectObject(this.model, true);
    if (intersects.length === 0) return;

    const point = intersects[0].point;
    const newId = `hs_${Date.now()}`;
    const shape = this.creationShape;

    let dims, rot;
    if (shape === 'sphere') {
      dims = { DEFAULT_SPHERE_R };
      rot = undefined;
      dims = { r: DEFAULT_SPHERE_R };
    } else if (shape === 'box') {
      dims = { ...DEFAULT_BOX };
      rot = { ...DEFAULT_BOX_ROT };
    } else {
      dims = { ...DEFAULT_CYL };
      rot = { ...DEFAULT_CYL_ROT };
    }
    dims = this._clampDimsToLimits(shape, dims);

    const colorHex = DEFAULT_HOTSPOT_HEX;
    const opacity  = 1.0;

    const mesh = this._createHotspot(newId, point, shape, dims, rot, colorHex, opacity);
    this.scene.add(mesh);
    this.hotspots[newId] = mesh;
    this._selectHotspot(newId);

    const payload = {
      Id: newId,
      X: point.x, Y: point.y, Z: point.z,
      shape,
      dims,
      color: colorHex,
      opacity
    };
    if (rot) payload.rot = rot;

    this._emit({ type: 'onHotspotAdded', payload });
    this._syncAll();
  }

  _removeHotspot(id) {
    const mesh = this.hotspots[id];
    if (!mesh) return;

    if (this.transformControls && this.transformHelper && this.selectedHotspotId === id) {
      this.transformControls.detach();
      this.transformHelper.visible = false;
    }

    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    delete this.hotspots[id];

    const wasSelected = this.selectedHotspotId === id;
    if (wasSelected) {
      this.selectedHotspotId = null;
      this._hideUI();
    }

    this._emit({ type: 'onHotspotRemoved', payload: { Id: id } });
    this._syncAll();
  }

  _selectHotspot(id, { notify = true, color = HOTSPOT_SELECTED_COLOR } = {}) {
    // ripristina colore base
    if (this.selectedHotspotId && this.hotspots[this.selectedHotspotId]) {
      const prev = this.hotspots[this.selectedHotspotId];
      const baseHex = prev.userData?.color || DEFAULT_HOTSPOT_HEX;
      prev.material.color.set(baseHex);
    }

    if (!id || !this.hotspots[id]) {
      this.selectedHotspotId = null;
      this._hideUI();
      this._updateTransformControls();
      if (notify) this._emit({ type: 'onHotspotSelected', payload: { Id: null } });
      this._syncAll();
      return;
    }

    const mesh = this.hotspots[id];
    mesh.material.color.set(color);
    this.selectedHotspotId = id;

    this._updateTransformControls();

    if (notify) this._emit({ type: 'onHotspotSelected', payload: { Id: id } });
    this._syncAll();

    if (this.currentMode === 'edit') {
      this._showUIFor(mesh);
    }
  }

  _updateTransformControls() {
    if (!this.transformControls || !this.transformHelper) return;

    const canShow =
      this.currentMode === 'edit' &&
      this.gizmoEnabled &&
      this.selectedHotspotId &&
      this.hotspots[this.selectedHotspotId];

    if (canShow) {
      const mesh = this.hotspots[this.selectedHotspotId];
      this.transformControls.attach(mesh);
      this.transformControls.setMode(this.gizmoMode);
      this.transformHelper.visible = true;
    } else {
      this.transformControls.detach();
      this.transformHelper.visible = false;
    }
  }

  _updateHelpersVisibility() {
    const visible = (this.currentMode === 'edit');
    if (this.axesHelper)  this.axesHelper.visible  = visible;
    if (this.lightHelper) this.lightHelper.visible = visible;
  }

  _createHotspot(
    id,
    pos,
    shape = 'sphere',
    dims = { r: DEFAULT_SPHERE_R },
    rotDeg,
    colorHex = DEFAULT_HOTSPOT_HEX,
    opacity = 1.0
  ) {
    let geom;
    if (shape === 'box') {
      const dx = dims?.x ?? DEFAULT_BOX.x;
      const dy = dims?.y ?? DEFAULT_BOX.y;
      const dz = dims?.z ?? DEFAULT_BOX.z;
      geom = new THREE.BoxGeometry(dx, dy, dz);
    } else if (shape === 'cylinder') {
      const r = dims?.r ?? DEFAULT_CYL.r;
      const h = dims?.h ?? DEFAULT_CYL.h;
      geom = new THREE.CylinderGeometry(r, r, h, 16, 1);
    } else {
      const r = dims?.r ?? DEFAULT_SPHERE_R;
      geom = new THREE.SphereGeometry(r, 16, 16);
      shape = 'sphere';
    }

    const mat = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const o = Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
    mat.opacity = o;
    mat.transparent = o < 1;

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos.x ?? pos?.x, pos.y ?? pos?.y, pos.z ?? pos?.z);
    mesh.name = id;

    if (shape === 'sphere') {
      mesh.userData.dims = { r: dims?.r ?? DEFAULT_SPHERE_R };
    } else if (shape === 'box') {
      mesh.userData.dims = {
        x: dims?.x ?? DEFAULT_BOX.x,
        y: dims?.y ?? DEFAULT_BOX.y,
        z: dims?.z ?? DEFAULT_BOX.z
      };
    } else {
      mesh.userData.dims = {
        r: dims?.r ?? DEFAULT_CYL.r,
        h: dims?.h ?? DEFAULT_CYL.h
      };
    }

    mesh.userData.shape = shape;
    mesh.userData.color = normalizeHex(colorHex);
    mesh.userData.opacity = o;

    mesh.material.color.set(mesh.userData.color);

    if (shape === 'box' || shape === 'cylinder') {
      const r = rotDeg || (shape === 'box' ? DEFAULT_BOX_ROT : DEFAULT_CYL_ROT);
      mesh.userData.rot = {
        x: r.x ?? 0,
        y: r.y ?? 0,
        z: r.z ?? 0
      };
      mesh.rotation.set(
        (mesh.userData.rot.x) * DEG2RAD,
        (mesh.userData.rot.y) * DEG2RAD,
        (mesh.userData.rot.z) * DEG2RAD
      );
    }

    return mesh;
  }

  _showUIFor(mesh) {
    const shape = mesh.userData.shape || 'sphere';
    let dims = mesh.userData.dims;

    this.ui.title.textContent = `Hotspot ${mesh.name} (${shape})`;
    this.ui.btnDelete.disabled = false;

    this._applyLimitsToUI();

    this.ui.pos.block.style.display    = 'block';
    this.ui.sphere.block.style.display = 'none';
    this.ui.box.block.style.display    = 'none';
    this.ui.cyl.block.style.display    = 'none';
    this.ui.rot.block.style.display    = 'none';

    this._updatePosFieldsFromMesh(mesh);

    if (shape === 'sphere') {
      const c = this._clampDimsToLimits('sphere', dims);
      if (c.r !== dims.r) { dims = c; mesh.userData.dims = c; }
      this.ui.sphere.block.style.display = 'block';
      this.ui.sphere.r.input.value = (dims.r ?? DEFAULT_SPHERE_R).toFixed(3);
    } else if (shape === 'box') {
      const c = this._clampDimsToLimits('box', dims);
      if (c.x !== dims.x || c.y !== dims.y || c.z !== dims.z) {
        mesh.userData.dims = c;
        dims = c;
      }
      this.ui.box.block.style.display = 'block';
      this.ui.rot.block.style.display = 'block';

      this.ui.box.x.input.value = (dims.x ?? DEFAULT_BOX.x).toFixed(3);
      this.ui.box.y.input.value = (dims.y ?? DEFAULT_BOX.y).toFixed(3);
      this.ui.box.z.input.value = (dims.z ?? DEFAULT_BOX.z).toFixed(3);

      this._updateRotFieldsFromMesh(mesh);
    } else { // cylinder
      const c = this._clampDimsToLimits('cylinder', dims);
      if (c.r !== dims.r || c.h !== dims.h) {
        mesh.userData.dims = c;
        dims = c;
      }
      this.ui.cyl.block.style.display = 'block';
      this.ui.rot.block.style.display = 'block';

      this.ui.cyl.r.input.value = (dims.r ?? DEFAULT_CYL.r).toFixed(3);
      this.ui.cyl.h.input.value = (dims.h ?? DEFAULT_CYL.h).toFixed(3);

      this._updateRotFieldsFromMesh(mesh);
    }

    const baseHex = mesh.userData?.color || DEFAULT_HOTSPOT_HEX;
    this.ui.color.block.style.display = 'block';
    this.ui.color.input.value = baseHex;

    const op = Number.isFinite(mesh.userData?.opacity)
      ? mesh.userData.opacity
      : (mesh.material.opacity ?? 1);
    this.ui.opacity.block.style.display = 'block';
    this.ui.opacity.slider.value = op.toString();
    this.ui.opacity.label.textContent = op.toFixed(2);

    if (this.ui.modeSelect) this.ui.modeSelect.value = this.gizmoMode;

    this.ui.root.style.display = 'block';
  }

  _hideUI() {
    if (!this.ui) return;
    this.ui.root.style.display = 'none';
    this.ui.btnDelete.disabled = true;
    this.ui.rot.block.style.display = 'none';
    this.ui.color.block.style.display = 'none';
    this.ui.opacity.block.style.display = 'none';
  }

  _updatePosFieldsFromMesh(mesh) {
    if (!this.ui || !this.ui.pos) return;
    const p = mesh.position;
    this.ui.pos.x.input.value = p.x.toFixed(3);
    this.ui.pos.y.input.value = p.y.toFixed(3);
    this.ui.pos.z.input.value = p.z.toFixed(3);
  }

  _updateRotFieldsFromMesh(mesh) {
    if (!this.ui || !this.ui.rot) return;
    if (!(mesh.userData.shape === 'box' || mesh.userData.shape === 'cylinder')) return;

    const xDeg = mesh.rotation.x * RAD2DEG;
    const yDeg = mesh.rotation.y * RAD2DEG;
    const zDeg = mesh.rotation.z * RAD2DEG;

    const rot = mesh.userData.rot || {};
    rot.x = xDeg;
    rot.y = yDeg;
    rot.z = zDeg;
    mesh.userData.rot = rot;

    this.ui.rot.x.input.value = xDeg.toFixed(0);
    this.ui.rot.y.input.value = yDeg.toFixed(0);
    this.ui.rot.z.input.value = zDeg.toFixed(0);
  }

  _resizeSelectedSphere(r, commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'sphere') return;

    r = Math.min(Math.max(r, 0.01), this.modelLimits.maxSphereR);

    const center = mesh.position.clone();
    mesh.geometry.dispose();
    mesh.geometry = new THREE.SphereGeometry(r, 16, 16);
    mesh.position.copy(center);
    mesh.userData.dims = { r };

    if (commit) {
      this._emit({
        type: 'onHotspotUpdated',
        payload: {
          Id: id,
          X: center.x, Y: center.y, Z: center.z,
          shape: 'sphere',
          dims: { r },
          color: mesh.userData.color,
          opacity: mesh.userData.opacity
        }
      });
      if (this.ui && this.selectedHotspotId === id) this._showUIFor(mesh);
    }
    this._syncAll();
  }

  _resizeSelectedBox(dims, commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'box') return;

    const c = this._clampDimsToLimits('box', dims);
    dims = c;
    const center = mesh.position.clone();
    const rot = mesh.userData.rot || DEFAULT_BOX_ROT;
    const rx = (rot.x || 0) * DEG2RAD;
    const ry = (rot.y || 0) * DEG2RAD;
    const rz = (rot.z || 0) * DEG2RAD;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
    mesh.position.copy(center);
    mesh.userData.dims = { ...dims };
    mesh.rotation.set(rx, ry, rz);

    if (commit) {
      this._emit({
        type: 'onHotspotUpdated',
        payload: {
          Id: id,
          X: center.x, Y: center.y, Z: center.z,
          shape: 'box',
          dims: { ...dims },
          rot: { ...mesh.userData.rot },
          color: mesh.userData.color,
          opacity: mesh.userData.opacity
        }
      });
      if (this.ui && this.selectedHotspotId === id) this._showUIFor(mesh);
    }
    this._syncAll();
  }

  _resizeSelectedCylinder(dims, commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'cylinder') return;

    const c = this._clampDimsToLimits('cylinder', dims);
    dims = c;
    const center = mesh.position.clone();
    const rot = mesh.userData.rot || DEFAULT_CYL_ROT;
    const rx = (rot.x || 0) * DEG2RAD;
    const ry = (rot.y || 0) * DEG2RAD;
    const rz = (rot.z || 0) * DEG2RAD;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.CylinderGeometry(dims.r, dims.r, dims.h, 16, 1);
    mesh.position.copy(center);
    mesh.userData.dims = { ...dims };
    mesh.rotation.set(rx, ry, rz);

    if (commit) {
      this._emit({
        type: 'onHotspotUpdated',
        payload: {
          Id: id,
          X: center.x, Y: center.y, Z: center.z,
          shape: 'cylinder',
          dims: { ...dims },
          rot: { ...mesh.userData.rot },
          color: mesh.userData.color,
          opacity: mesh.userData.opacity
        }
      });
      if (this.ui && this.selectedHotspotId === id) this._showUIFor(mesh);
    }
    this._syncAll();
  }

  /* ===== limiti dinamici dal modello ===== */

  _recomputeLimitsFromModel() {
    if (!this.model) {
      this.modelLimits.maxSphereR = 0.6;
      this.modelLimits.maxBox = { x: 1.0, y: 1.0, z: 1.0 };
      this.modelLimits.maxCylinder = { r: 0.6, h: 1.0 };

      this.modelBounds.min.set(-1, -1, -1);
      this.modelBounds.max.set( 1,  1,  1);
      this.modelBounds.center.set(0,0,0);
      this.modelBounds.size.set(2,2,2);

      this._applyLimitsToUI();
      return;
    }

    const box = new THREE.Box3().setFromObject(this.model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxSphereR = Math.max(0.01, 0.5 * Math.min(size.x, size.y, size.z) * 0.95);
    const maxBox = {
      x: Math.max(0.02, size.x * 0.95),
      y: Math.max(0.02, size.y * 0.95),
      z: Math.max(0.02, size.z * 0.95)
    };
    const maxCylinder = {
      r: maxSphereR,
      h: Math.max(0.02, size.y * 0.95)
    };

    this.modelLimits.maxSphereR = maxSphereR;
    this.modelLimits.maxBox = maxBox;
    this.modelLimits.maxCylinder = maxCylinder;

    this.modelBounds.min.copy(box.min);
    this.modelBounds.max.copy(box.max);
    this.modelBounds.center.copy(center);
    this.modelBounds.size.copy(size);

    this._applyLimitsToUI();
  }

  _applyLimitsToUI() {
    if (!this.ui) return;

    if (this.ui.sphere?.r?.input) {
      this.ui.sphere.r.input.min = '0.01';
      this.ui.sphere.r.input.max = String(this.modelLimits.maxSphereR.toFixed(3));
    }
    if (this.ui.box?.x?.input) {
      this.ui.box.x.input.min = '0.02';
      this.ui.box.y.input.min = '0.02';
      this.ui.box.z.input.min = '0.02';
      this.ui.box.x.input.max = String(this.modelLimits.maxBox.x.toFixed(3));
      this.ui.box.y.input.max = String(this.modelLimits.maxBox.y.toFixed(3));
      this.ui.box.z.input.max = String(this.modelLimits.maxBox.z.toFixed(3));
    }
    if (this.ui.cyl?.r?.input) {
      this.ui.cyl.r.input.min = '0.01';
      this.ui.cyl.h.input.min = '0.02';
      this.ui.cyl.r.input.max = String(this.modelLimits.maxCylinder.r.toFixed(3));
      this.ui.cyl.h.input.max = String(this.modelLimits.maxCylinder.h.toFixed(3));
    }
  }

  _clampDimsToLimits(shape, dims) {
    const clamp = (v, mn, mx) => Math.min(Math.max(v ?? mn, mn), mx);
    if (shape === 'sphere') {
      return { r: clamp(dims.r, 0.01, this.modelLimits.maxSphereR) };
    } else if (shape === 'box') {
      return {
        x: clamp(dims.x, 0.02, this.modelLimits.maxBox.x),
        y: clamp(dims.y, 0.02, this.modelLimits.maxBox.y),
        z: clamp(dims.z, 0.02, this.modelLimits.maxBox.z),
      };
    } else {
      return {
        r: clamp(dims.r, 0.01, this.modelLimits.maxCylinder.r),
        h: clamp(dims.h, 0.02, this.modelLimits.maxCylinder.h),
      };
    }
  }
}

/* ===== helper ===== */
function normalizeHex(s) {
  if (!s) return DEFAULT_HOTSPOT_HEX;
  const t = ('' + s).trim();
  if (t.startsWith('#')) return t.length === 7 ? t.toLowerCase() : DEFAULT_HOTSPOT_HEX;
  if (/^[0-9a-fA-F]{6}$/.test(t)) return ('#' + t).toLowerCase();
  return DEFAULT_HOTSPOT_HEX;
}

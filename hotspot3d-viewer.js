// hotspot3d-viewer.js
// Classe istanziabile con: Sphere/Box/Cylinder, resize/rot, colore,
// limiti dinamici dal bbox, selezione/deselezione in View Mode,
// e TRASLAZIONE tramite 3 slider ΔX/ΔY/ΔZ (baseline = origine hotspot).

// hotspot3d-viewer.js
import * as THREE from 'three';
import { GLTFLoader }   from 'three/addons/loaders/GLTFLoader.js';
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

    // modello
    this.model = null;
    this.currentModelUrl = '';
    this.pendingModelUrl = '';

    // hotspot + selezione
    this.hotspots = {}; // id -> Mesh (userData: { shape, dims, rot?, color })
    this.selectedHotspotId = null;

    // input
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };

    // modalità & creazione
    this.currentMode = 'view';                 // 'view' | 'edit' | 'hide'
    this.creationShape = 'sphere';             // 'sphere' | 'box' | 'cylinder'

    // limiti dinamici (dal bbox del modello)
    this.modelLimits = {
      maxSphereR: 0.6,
      maxBox: { x: 1.0, y: 1.0, z: 1.0 },
      maxCylinder: { r: 0.6, h: 1.0 }
    };
    // bounds del modello (per eventuali clamp/visualizzazione)
    this.modelBounds = { min: new THREE.Vector3(-1,-1,-1), max: new THREE.Vector3(1,1,1), center: new THREE.Vector3(), size: new THREE.Vector3(2,2,2) };

    // UI refs
    this.ui = null;

    // baseline per traslazione (origine hotspot quando selezionato)
    this.translateOrigin = new THREE.Vector3(0,0,0);

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
      this._emit({ type: 'onPointOfViewChanged', payload: { ...pointOfView } });
    }

    // Hotspots
    this._clearHotspots();
    for (const h of hotspots) {
      const shape = ['sphere','box','cylinder'].includes(h.shape) ? h.shape : 'sphere';
      let dims;
      if (shape === 'sphere') dims = { r: (h.dims?.r ?? DEFAULT_SPHERE_R) };
      else if (shape === 'box') dims = { x: (h.dims?.x ?? DEFAULT_BOX.x), y: (h.dims?.y ?? DEFAULT_BOX.y), z: (h.dims?.z ?? DEFAULT_BOX.z) };
      else dims = { r: (h.dims?.r ?? DEFAULT_CYL.r), h: (h.dims?.h ?? DEFAULT_CYL.h) };
      dims = this._clampDimsToLimits(shape, dims);

      const rot = (shape === 'box')
        ? { x: num(h.rot?.x, DEFAULT_BOX_ROT.x), y: num(h.rot?.y, DEFAULT_BOX_ROT.y), z: num(h.rot?.z, DEFAULT_BOX_ROT.z) }
        : (shape === 'cylinder')
        ? { x: num(h.rot?.x, DEFAULT_CYL_ROT.x), y: num(h.rot?.y, DEFAULT_CYL_ROT.y), z: num(h.rot?.z, DEFAULT_CYL_ROT.z) }
        : undefined;
      const colorHex = normalizeHex(h.color) ?? DEFAULT_HOTSPOT_HEX;

      const mesh = this._createHotspot(h.Id, { x: h.X, y: h.Y, z: h.Z }, shape, dims, rot, colorHex);
      this.scene.add(mesh);
      this.hotspots[h.Id] = mesh;
    }

    if (hotspots.length) this._selectHotspot(hotspots[0].Id, { notify:false });
    else this._selectHotspot(null, { notify:false });

    this._syncAll();

    function num(v, dflt) { return Number.isFinite(v) ? v : dflt; }
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
        this._emit({ type: 'onModelLoadError', payload: { url, message: String(error) } });
        this._syncAll();
      }
    );
  }

  setMode(mode) {
    this.currentMode = mode === 'edit' ? 'edit' : (mode === 'hide' ? 'hide' : 'view');
    if (this.currentMode !== 'edit') this._hideUI();
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
      this._emit({ type: 'onBackgroundChanged', payload: { color: color.getHexString() } });
    } catch (e) {
      console.warn('Hotspot3DViewer.setBackground(): colore non valido:', bg, e);
    }
  }

  highlightHotspot(id) { this._selectHotspot(id, { notify:false, color: HOTSPOT_HIGHLIGHT_COLOR }); }
  getSharedData() { return this._buildSharedData(); }
  requestSync() { this._syncAll(); }

  /* =============== INTERNALS =============== */

  _initScene(background) {
    const cs = getComputedStyle(this.container);
    if (cs.position === 'static') this.container.style.position = 'relative';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, 1.5, 3);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this._updateRendererSize();
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    // luci & helpers
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.position.set(2, 5, 2);
    this.scene.add(dirLight);
    this.scene.add(new THREE.DirectionalLightHelper(dirLight, 0.3));
    this.scene.add(new THREE.AxesHelper(1));

    this.loader = new GLTFLoader();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('end', () => {
      this._emit({
        type: 'onPointOfViewChanged',
        payload: { X: this.camera.position.x, Y: this.camera.position.y, Z: this.camera.position.z }
      });
      this._syncAll();
    });

    this._resizeObserver = new ResizeObserver(() => this._updateRendererSize());
    this._resizeObserver.observe(this.container);
    window.addEventListener('resize', this._updateRendererSize);
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

  _mkRow(labelText) {
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 80px';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.margin = '6px 0';

    const label = document.createElement('label');
    label.textContent = labelText;
    label.style.fontSize = '12px';
    label.style.opacity = '.8';

    const value = document.createElement('span');
    value.className = 'small';
    value.style.fontSize = '12px';
    value.style.opacity = '.6';
    value.textContent = '';

    row.appendChild(label);
    row.appendChild(value);
    return { row, value };
  }

  _mountUI() {
    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'absolute', right: '12px', top: '12px', zIndex: '10',
      minWidth: '260px', maxWidth: '340px',
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

    // --- blocco POSITION (ΔX ΔY ΔZ) ---
    const posBlock = document.createElement('div');
    const posRowX = this._mkRow('ΔX');
    const posX = document.createElement('input');
    posX.type = 'range'; posX.min = '-1.0'; posX.max = '1.0'; posX.step = '0.005'; posX.value = '0';

    const posRowY = this._mkRow('ΔY');
    const posY = document.createElement('input');
    posY.type = 'range'; posY.min = '-1.0'; posY.max = '1.0'; posY.step = '0.005'; posY.value = '0';

    const posRowZ = this._mkRow('ΔZ');
    const posZ = document.createElement('input');
    posZ.type = 'range'; posZ.min = '-1.0'; posZ.max = '1.0'; posZ.step = '0.005'; posZ.value = '0';

    posBlock.appendChild(posRowX.row); posBlock.appendChild(posX);
    posBlock.appendChild(posRowY.row); posBlock.appendChild(posY);
    posBlock.appendChild(posRowZ.row); posBlock.appendChild(posZ);

    // --- Sphere ---
    const sphereBlock = document.createElement('div');
    const sphereRow = this._mkRow('raggio');
    const sphereSlider = document.createElement('input');
    sphereSlider.type = 'range'; sphereSlider.min = '0.01'; sphereSlider.max = '0.6'; sphereSlider.step = '0.005';
    sphereSlider.value = String(DEFAULT_SPHERE_R);
    sphereBlock.appendChild(sphereRow.row);
    sphereBlock.appendChild(sphereSlider);

    // --- Box dims ---
    const boxBlock = document.createElement('div');
    const boxRowX = this._mkRow('box x'); const boxX = document.createElement('input');
    boxX.type = 'range'; boxX.min = '0.02'; boxX.max = '1.0'; boxX.step = '0.005'; boxX.value = String(DEFAULT_BOX.x);
    const boxRowY = this._mkRow('box y'); const boxY = document.createElement('input');
    boxY.type = 'range'; boxY.min = '0.02'; boxY.max = '1.0'; boxY.step = '0.005'; boxY.value = String(DEFAULT_BOX.y);
    const boxRowZ = this._mkRow('box z'); const boxZ = document.createElement('input');
    boxZ.type = 'range'; boxZ.min = '0.02'; boxZ.max = '1.0'; boxZ.step = '0.005'; boxZ.value = String(DEFAULT_BOX.z);
    boxBlock.appendChild(boxRowX.row); boxBlock.appendChild(boxX);
    boxBlock.appendChild(boxRowY.row); boxBlock.appendChild(boxY);
    boxBlock.appendChild(boxRowZ.row); boxBlock.appendChild(boxZ);

    // --- Cylinder dims ---
    const cylBlock = document.createElement('div');
    const cylRowR = this._mkRow('cyl r'); const cylR = document.createElement('input');
    cylR.type = 'range'; cylR.min = '0.01'; cylR.max = '0.6'; cylR.step = '0.005'; cylR.value = String(DEFAULT_CYL.r);
    const cylRowH = this._mkRow('cyl h'); const cylH = document.createElement('input');
    cylH.type = 'range'; cylH.min = '0.02'; cylH.max = '1.0'; cylH.step = '0.005'; cylH.value = String(DEFAULT_CYL.h);
    cylBlock.appendChild(cylRowR.row); cylBlock.appendChild(cylR);
    cylBlock.appendChild(cylRowH.row); cylBlock.appendChild(cylH);

    // --- Rotazioni (box & cylinder) ---
    const rotBlock = document.createElement('div');
    const rotRowX = this._mkRow('rot X (°)'); const rotX = document.createElement('input');
    rotX.type = 'range'; rotX.min = '-180'; rotX.max = '180'; rotX.step = '1'; rotX.value = '0';
    const rotRowY = this._mkRow('rot Y (°)'); const rotY = document.createElement('input');
    rotY.type = 'range'; rotY.min = '-180'; rotY.max = '180'; rotY.step = '1'; rotY.value = '0';
    const rotRowZ = this._mkRow('rot Z (°)'); const rotZ = document.createElement('input');
    rotZ.type = 'range'; rotZ.min = '-180'; rotZ.max = '180'; rotZ.step = '1'; rotZ.value = '0';
    rotBlock.appendChild(rotRowX.row); rotBlock.appendChild(rotX);
    rotBlock.appendChild(rotRowY.row); rotBlock.appendChild(rotY);
    rotBlock.appendChild(rotRowZ.row); rotBlock.appendChild(rotZ);

    // --- Colore ---
    const colorBlock = document.createElement('div');
    const colorLabel = document.createElement('label');
    colorLabel.textContent = 'color'; colorLabel.style.display = 'block';
    colorLabel.style.fontSize = '12px'; colorLabel.style.opacity = '.8';
    const colorInput = document.createElement('input');
    colorInput.type = 'color'; colorInput.value = DEFAULT_HOTSPOT_HEX;
    colorInput.style.width = '100%'; colorInput.style.height = '32px';
    colorInput.style.padding = '0'; colorInput.style.border = '1px solid #00000030';
    colorInput.style.borderRadius = '6px';
    colorBlock.appendChild(colorLabel); colorBlock.appendChild(colorInput);

    // --- Actions ---
    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' });
    const btnDelete = document.createElement('button');
    btnDelete.textContent = 'Delete';
    Object.assign(btnDelete.style, { padding: '.35rem .6rem', border: '1px solid #ff8a8a', background: '#ffe6e6', borderRadius: '.5rem', cursor: 'pointer' });
    btnDelete.addEventListener('mouseenter', () => { btnDelete.style.background = '#ffd6d6'; });
    btnDelete.addEventListener('mouseleave', () => { btnDelete.style.background = '#ffe6e6'; });
    const btnClose = document.createElement('button');
    btnClose.textContent = 'Chiudi';
    Object.assign(btnClose.style, { padding: '.35rem .6rem', border: '1px solid #00000030', background: '#f6f6f6', borderRadius: '.5rem', cursor: 'pointer' });
    actions.appendChild(btnDelete); actions.appendChild(btnClose);

    // Compose UI
    root.appendChild(posBlock);
    root.appendChild(sphereBlock);
    root.appendChild(boxBlock);
    root.appendChild(cylBlock);
    root.appendChild(rotBlock);
    root.appendChild(colorBlock);
    root.appendChild(actions);

    // refs
    this.ui = {
      root, title,
      pos: {
        block: posBlock,
        x: { slider: posX, val: posRowX.value },
        y: { slider: posY, val: posRowY.value },
        z: { slider: posZ, val: posRowZ.value },
      },
      sphere: { block: sphereBlock, slider: sphereSlider, val: sphereRow.value },
      box: {
        block: boxBlock,
        x: { slider: boxX, val: boxRowX.value },
        y: { slider: boxY, val: boxRowY.value },
        z: { slider: boxZ, val: boxRowZ.value },
      },
      cyl: {
        block: cylBlock,
        r: { slider: cylR, val: cylRowR.value },
        h: { slider: cylH, val: cylRowH.value },
      },
      rot: {
        block: rotBlock,
        x: { slider: rotX, val: rotRowX.value },
        y: { slider: rotY, val: rotRowY.value },
        z: { slider: rotZ, val: rotRowZ.value },
      },
      color: { block: colorBlock, input: colorInput },
      btnDelete, btnClose
    };

    // listeners
    btnClose.addEventListener('click', () => this._hideUI());
    btnDelete.addEventListener('click', () => { if (this.selectedHotspotId) this._removeHotspot(this.selectedHotspotId); });

    // --- TRASLAZIONE: slider ΔX/ΔY/ΔZ ---
    const updatePosLabels = () => {
      this.ui.pos.x.val.textContent = this.ui.pos.x.slider.value;
      this.ui.pos.y.val.textContent = this.ui.pos.y.slider.value;
      this.ui.pos.z.val.textContent = this.ui.pos.z.slider.value;
    };
    const onPosInput = () => {
      updatePosLabels();
      this._applyDeltaPosition(false); // SYNC live
    };
    const onPosCommit = () => {
      this._applyDeltaPosition(true);  // commit + onHotspotUpdated
    };
    this.ui.pos.x.slider.addEventListener('input', onPosInput);
    this.ui.pos.y.slider.addEventListener('input', onPosInput);
    this.ui.pos.z.slider.addEventListener('input', onPosInput);
    this.ui.pos.x.slider.addEventListener('change', onPosCommit);
    this.ui.pos.y.slider.addEventListener('change', onPosCommit);
    this.ui.pos.z.slider.addEventListener('change', onPosCommit);

    // --- sphere resize ---
    const clamp = (v, mn, mx) => Math.min(Math.max(v, mn), mx);
    sphereSlider.addEventListener('input', () => {
      let r = Number(sphereSlider.value);
      r = clamp(r, 0.01, this.modelLimits.maxSphereR);
      sphereSlider.value = String(r);
      this.ui.sphere.val.textContent = sphereSlider.value;
      this._resizeSelectedSphere(r, false);
    });
    sphereSlider.addEventListener('change', () => {
      let r = Number(sphereSlider.value);
      r = clamp(r, 0.01, this.modelLimits.maxSphereR);
      sphereSlider.value = String(r);
      this._resizeSelectedSphere(r, true);
    });

    // --- box dims ---
    const onBoxInput = () => {
      let dims = { x: +this.ui.box.x.slider.value, y: +this.ui.box.y.slider.value, z: +this.ui.box.z.slider.value };
      dims = this._clampDimsToLimits('box', dims);
      this.ui.box.x.slider.value = String(dims.x);
      this.ui.box.y.slider.value = String(dims.y);
      this.ui.box.z.slider.value = String(dims.z);
      this.ui.box.x.val.textContent = this.ui.box.x.slider.value;
      this.ui.box.y.val.textContent = this.ui.box.y.slider.value;
      this.ui.box.z.val.textContent = this.ui.box.z.slider.value;
      this._resizeSelectedBox(dims, false);
    };
    const onBoxCommit = () => {
      let dims = { x: +this.ui.box.x.slider.value, y: +this.ui.box.y.slider.value, z: +this.ui.box.z.slider.value };
      dims = this._clampDimsToLimits('box', dims);
      this.ui.box.x.slider.value = String(dims.x);
      this.ui.box.y.slider.value = String(dims.y);
      this.ui.box.z.slider.value = String(dims.z);
      this._resizeSelectedBox(dims, true);
    };
    this.ui.box.x.slider.addEventListener('input', onBoxInput);
    this.ui.box.y.slider.addEventListener('input', onBoxInput);
    this.ui.box.z.slider.addEventListener('input', onBoxInput);
    this.ui.box.x.slider.addEventListener('change', onBoxCommit);
    this.ui.box.y.slider.addEventListener('change', onBoxCommit);
    this.ui.box.z.slider.addEventListener('change', onBoxCommit);

    // --- cylinder dims ---
    const onCylInput = () => {
      let dims = { r: +this.ui.cyl.r.slider.value, h: +this.ui.cyl.h.slider.value };
      dims = this._clampDimsToLimits('cylinder', dims);
      this.ui.cyl.r.slider.value = String(dims.r);
      this.ui.cyl.h.slider.value = String(dims.h);
      this.ui.cyl.r.val.textContent = this.ui.cyl.r.slider.value;
      this.ui.cyl.h.val.textContent = this.ui.cyl.h.slider.value;
      this._resizeSelectedCylinder(dims, false);
    };
    const onCylCommit = () => {
      let dims = { r: +this.ui.cyl.r.slider.value, h: +this.ui.cyl.h.slider.value };
      dims = this._clampDimsToLimits('cylinder', dims);
      this.ui.cyl.r.slider.value = String(dims.r);
      this.ui.cyl.h.slider.value = String(dims.h);
      this._resizeSelectedCylinder(dims, true);
    };
    this.ui.cyl.r.slider.addEventListener('input', onCylInput);
    this.ui.cyl.h.slider.addEventListener('input', onCylInput);
    this.ui.cyl.r.slider.addEventListener('change', onCylCommit);
    this.ui.cyl.h.slider.addEventListener('change', onCylCommit);

    // --- rot (box/cylinder) ---
    const onRotInput = () => {
      const rot = { x: +this.ui.rot.x.slider.value, y: +this.ui.rot.y.slider.value, z: +this.ui.rot.z.slider.value };
      this.ui.rot.x.val.textContent = String(rot.x);
      this.ui.rot.y.val.textContent = String(rot.y);
      this.ui.rot.z.val.textContent = String(rot.z);
      this._rotateSelected(rot, false);
    };
    const onRotCommit = () => {
      const rot = { x: +this.ui.rot.x.slider.value, y: +this.ui.rot.y.slider.value, z: +this.ui.rot.z.slider.value };
      this._rotateSelected(rot, true);
    };
    this.ui.rot.x.slider.addEventListener('input', onRotInput);
    this.ui.rot.y.slider.addEventListener('input', onRotInput);
    this.ui.rot.z.slider.addEventListener('input', onRotInput);
    this.ui.rot.x.slider.addEventListener('change', onRotCommit);
    this.ui.rot.y.slider.addEventListener('change', onRotCommit);
    this.ui.rot.z.slider.addEventListener('change', onRotCommit);

    // --- colore ---
    const onColorChange = () => {
      const id = this.selectedHotspotId; if (!id) return;
      const mesh = this.hotspots[id]; if (!mesh) return;
      const hex = this.ui.color.input.value || DEFAULT_HOTSPOT_HEX;
      mesh.userData.color = normalizeHex(hex);
      if (this.selectedHotspotId !== id) mesh.material.color.set(mesh.userData.color);
      const c = mesh.position;
      const payload = {
        Id: id, X: c.x, Y: c.y, Z: c.z,
        shape: mesh.userData.shape,
        dims: { ...mesh.userData.dims },
        color: mesh.userData.color
      };
      if (mesh.userData.rot) payload.rot = { ...mesh.userData.rot };
      this._emit({ type: 'onHotspotUpdated', payload });
      this._syncAll();
    };
    this.ui.color.input.addEventListener('input', onColorChange);
    this.ui.color.input.addEventListener('change', onColorChange);

    // monta UI
    this.container.appendChild(root);
    this._applyLimitsToUI();
  }

  _bindEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener('mousedown', (e) => { this.dragStart = { x: e.clientX, y: e.clientY }; this.isDragging = false; });
    dom.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this.dragStart.x, dy = e.clientY - this.dragStart.y;
      if (Math.sqrt(dx*dx + dy*dy) > 5) this.isDragging = true;
    });
    dom.addEventListener('mouseup', (e) => { if (!this.isDragging) this._handlePointerTap(e); });

    window.addEventListener('keydown', (e) => {
      if (this.currentMode !== 'edit') return;
      if (!this.selectedHotspotId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') this._removeHotspot(this.selectedHotspotId);
    });
  }

  _emit(msg) { this.onEvent?.(msg); }

  _buildSharedData() {
    const list = Object.entries(this.hotspots).map(([Id, mesh]) => {
      const shape = mesh.userData?.shape || 'sphere';
      const dims  = mesh.userData?.dims  || {};
      const rot   = mesh.userData?.rot;
      const colorHex = mesh.userData?.color || DEFAULT_HOTSPOT_HEX;

      const base = {
        Id,
        X: mesh.position.x, Y: mesh.position.y, Z: mesh.position.z,
        shape,
        dims: (shape === 'sphere')
          ? { r: dims?.r ?? DEFAULT_SPHERE_R }
          : (shape === 'box')
          ? { x: dims?.x ?? DEFAULT_BOX.x, y: dims?.y ?? DEFAULT_BOX.y, z: dims?.z ?? DEFAULT_BOX.z }
          : { r: dims?.r ?? DEFAULT_CYL.r, h: dims?.h ?? DEFAULT_CYL.h },
        color: colorHex
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
      pointOfView: { X: this.camera.position.x, Y: this.camera.position.y, Z: this.camera.position.z },
      hotspots: list,
    };
  }

  _syncAll() { this._emit({ type: 'SYNC_DATA', payload: this._buildSharedData() }); }

  _removeModel() {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model = null;
    this._recomputeLimitsFromModel();
  }

  _clearHotspots() {
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

    // 1) prova selezione hotspot
    const hotspotMeshes = Object.values(this.hotspots);
    if (hotspotMeshes.length > 0) {
      const hotspotHit = this.raycaster.intersectObjects(hotspotMeshes, false);
      if (hotspotHit.length > 0) { this._selectHotspot(hotspotHit[0].object.name); return; }
    }

    // 2) click a vuoto
    if (this.currentMode !== 'edit') { this._selectHotspot(null); return; }

    // 3) crea nuovo (click su modello)
    if (!this.model) return;
    const intersects = this.raycaster.intersectObject(this.model, true);
    if (intersects.length === 0) return;

    const point = intersects[0].point;
    const newId = `hs_${Date.now()}`;
    const shape = this.creationShape;

    let dims, rot;
    if (shape === 'sphere') { dims = { r: DEFAULT_SPHERE_R }; rot = undefined; }
    else if (shape === 'box') { dims = { ...DEFAULT_BOX }; rot = { ...DEFAULT_BOX_ROT }; }
    else { dims = { ...DEFAULT_CYL }; rot = { ...DEFAULT_CYL_ROT }; }
    dims = this._clampDimsToLimits(shape, dims);
    const colorHex = DEFAULT_HOTSPOT_HEX;

    const mesh = this._createHotspot(newId, point, shape, dims, rot, colorHex);
    this.scene.add(mesh);
    this.hotspots[newId] = mesh;
    this._selectHotspot(newId);

    const payload = { Id: newId, X: point.x, Y: point.y, Z: point.z, shape, dims, color: colorHex };
    if (rot) payload.rot = rot;
    this._emit({ type: 'onHotspotAdded', payload });
    this._syncAll();
  }

  _removeHotspot(id) {
    const mesh = this.hotspots[id];
    if (!mesh) return;

    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    delete this.hotspots[id];

    const wasSelected = this.selectedHotspotId === id;
    if (wasSelected) { this.selectedHotspotId = null; this._hideUI(); }

    this._emit({ type: 'onHotspotRemoved', payload: { Id: id } });
    this._syncAll();
  }

  _selectHotspot(id, { notify = true, color = HOTSPOT_SELECTED_COLOR } = {}) {
    // ripristina colore base sul precedente selezionato
    if (this.selectedHotspotId && this.hotspots[this.selectedHotspotId]) {
      const prev = this.hotspots[this.selectedHotspotId];
      const baseHex = prev.userData?.color || DEFAULT_HOTSPOT_HEX;
      prev.material.color.set(baseHex);
    }

    if (!id || !this.hotspots[id]) {
      this.selectedHotspotId = null;
      this._hideUI();
      if (notify) this._emit({ type: 'onHotspotSelected', payload: { Id: null } });
      this._syncAll();
      return;
    }

    const mesh = this.hotspots[id];
    mesh.material.color.set(color);
    this.selectedHotspotId = id;

    // Aggiorna baseline di traslazione (origine) e reset slider Δ a 0
    this.translateOrigin.copy(mesh.position);
    if (this.ui?.pos) {
      this.ui.pos.x.slider.value = '0';
      this.ui.pos.y.slider.value = '0';
      this.ui.pos.z.slider.value = '0';
      this.ui.pos.x.val.textContent = '0';
      this.ui.pos.y.val.textContent = '0';
      this.ui.pos.z.val.textContent = '0';
    }

    if (notify) this._emit({ type: 'onHotspotSelected', payload: { Id: id } });
    this._syncAll();

    if (this.currentMode === 'edit') this._showUIFor(mesh);
  }

  _createHotspot(id, pos, shape = 'sphere', dims = { r: DEFAULT_SPHERE_R }, rotDeg /* opzionale */, colorHex = DEFAULT_HOTSPOT_HEX) {
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
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos.x ?? pos?.x, pos.y ?? pos?.y, pos.z ?? pos?.z);
    mesh.name = id;

    if (shape === 'sphere') mesh.userData.dims = { r: dims?.r ?? DEFAULT_SPHERE_R };
    else if (shape === 'box') mesh.userData.dims = { x: dims?.x ?? DEFAULT_BOX.x, y: dims?.y ?? DEFAULT_BOX.y, z: dims?.z ?? DEFAULT_BOX.z };
    else mesh.userData.dims = { r: dims?.r ?? DEFAULT_CYL.r, h: dims?.h ?? DEFAULT_CYL.h };

    mesh.userData.shape = shape;
    mesh.userData.color = normalizeHex(colorHex);
    mesh.material.color.set(mesh.userData.color);

    if (shape === 'box' || shape === 'cylinder') {
      const r = rotDeg || (shape === 'box' ? DEFAULT_BOX_ROT : DEFAULT_CYL_ROT);
      mesh.userData.rot = { x: r.x ?? 0, y: r.y ?? 0, z: r.z ?? 0 };
      mesh.rotation.set((r.x ?? 0) * DEG2RAD, (r.y ?? 0) * DEG2RAD, (r.z ?? 0) * DEG2RAD);
    }

    return mesh;
  }

  _showUIFor(mesh) {
    const shape = mesh.userData.shape || 'sphere';
    let dims = mesh.userData.dims;

    this.ui.title.textContent = `Hotspot ${mesh.name} (${shape})`;
    this.ui.btnDelete.disabled = false;

    // allinea limiti
    this._applyLimitsToUI();

    // reset display dei blocchi
    this.ui.pos.block.style.display    = 'block'; // la traslazione c’è sempre in edit
    this.ui.sphere.block.style.display = 'none';
    this.ui.box.block.style.display    = 'none';
    this.ui.cyl.block.style.display    = 'none';
    this.ui.rot.block.style.display    = 'none';

    // reset pos sliders (baseline aggiornata in _selectHotspot)
    this.ui.pos.x.slider.value = '0'; this.ui.pos.y.slider.value = '0'; this.ui.pos.z.slider.value = '0';
    this.ui.pos.x.val.textContent = '0'; this.ui.pos.y.val.textContent = '0'; this.ui.pos.z.val.textContent = '0';

    if (shape === 'sphere') {
      const c = this._clampDimsToLimits('sphere', dims); if (c.r !== dims.r) { dims = c; mesh.userData.dims = c; }
      this.ui.sphere.block.style.display = 'block';
      this.ui.sphere.slider.max = String(this.modelLimits.maxSphereR.toFixed(3));
      this.ui.sphere.slider.value = String(dims.r ?? DEFAULT_SPHERE_R);
      this.ui.sphere.val.textContent = this.ui.sphere.slider.value;

    } else if (shape === 'box') {
      const c = this._clampDimsToLimits('box', dims); if (c.x !== dims.x || c.y !== dims.y || c.z !== dims.z) { mesh.userData.dims = c; dims = c; }
      this.ui.box.block.style.display = 'block';
      this.ui.rot.block.style.display = 'block';

      this.ui.box.x.slider.max = String(this.modelLimits.maxBox.x.toFixed(3));
      this.ui.box.y.slider.max = String(this.modelLimits.maxBox.y.toFixed(3));
      this.ui.box.z.slider.max = String(this.modelLimits.maxBox.z.toFixed(3));
      this.ui.box.x.slider.value = String(dims.x ?? DEFAULT_BOX.x);
      this.ui.box.y.slider.value = String(dims.y ?? DEFAULT_BOX.y);
      this.ui.box.z.slider.value = String(dims.z ?? DEFAULT_BOX.z);
      this.ui.box.x.val.textContent = this.ui.box.x.slider.value;
      this.ui.box.y.val.textContent = this.ui.box.y.slider.value;
      this.ui.box.z.val.textContent = this.ui.box.z.slider.value;

      const r = mesh.userData.rot || DEFAULT_BOX_ROT;
      this.ui.rot.x.slider.value = String(r.x ?? 0);
      this.ui.rot.y.slider.value = String(r.y ?? 0);
      this.ui.rot.z.slider.value = String(r.z ?? 0);
      this.ui.rot.x.val.textContent = this.ui.rot.x.slider.value;
      this.ui.rot.y.val.textContent = this.ui.rot.y.slider.value;
      this.ui.rot.z.val.textContent = this.ui.rot.z.slider.value;

    } else { // cylinder
      const c = this._clampDimsToLimits('cylinder', dims); if (c.r !== dims.r || c.h !== dims.h) { mesh.userData.dims = c; dims = c; }
      this.ui.cyl.block.style.display = 'block';
      this.ui.rot.block.style.display = 'block';

      this.ui.cyl.r.slider.max = String(this.modelLimits.maxCylinder.r.toFixed(3));
      this.ui.cyl.h.slider.max = String(this.modelLimits.maxCylinder.h.toFixed(3));
      this.ui.cyl.r.slider.value = String(dims.r ?? DEFAULT_CYL.r);
      this.ui.cyl.h.slider.value = String(dims.h ?? DEFAULT_CYL.h);
      this.ui.cyl.r.val.textContent = this.ui.cyl.r.slider.value;
      this.ui.cyl.h.val.textContent = this.ui.cyl.h.slider.value;

      const r = mesh.userData.rot || DEFAULT_CYL_ROT;
      this.ui.rot.x.slider.value = String(r.x ?? 0);
      this.ui.rot.y.slider.value = String(r.y ?? 0);
      this.ui.rot.z.slider.value = String(r.z ?? 0);
      this.ui.rot.x.val.textContent = this.ui.rot.x.slider.value;
      this.ui.rot.y.val.textContent = this.ui.rot.y.slider.value;
      this.ui.rot.z.val.textContent = this.ui.rot.z.slider.value;
    }

    // colore
    const baseHex = mesh.userData?.color || DEFAULT_HOTSPOT_HEX;
    this.ui.color.block.style.display = 'block';
    this.ui.color.input.value = baseHex;

    this.ui.root.style.display = 'block';
  }

  _hideUI() {
    if (!this.ui) return;
    this.ui.root.style.display = 'none';
    this.ui.btnDelete.disabled = true;
    this.ui.rot.block.style.display = 'none';
    this.ui.color.block.style.display = 'none';
  }

  /* === Traslazione con slider ΔX/ΔY/ΔZ === */
  _applyDeltaPosition(commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh) return;

    const dx = +this.ui.pos.x.slider.value;
    const dy = +this.ui.pos.y.slider.value;
    const dz = +this.ui.pos.z.slider.value;

    // nuovo centro = origineSelezione + delta
    const newPos = new THREE.Vector3(
      this.translateOrigin.x + dx,
      this.translateOrigin.y + dy,
      this.translateOrigin.z + dz
    );

    // (opzionale) clamp in base ai bounds del modello.
    // Semplificato: lasciamo libero per ora; puoi abilitare un clamp conservativo qui.

    mesh.position.copy(newPos);

    if (commit) {
      const p = mesh.position;
      const payload = {
        Id: id, X: p.x, Y: p.y, Z: p.z,
        shape: mesh.userData.shape,
        dims: { ...mesh.userData.dims },
        color: mesh.userData.color
      };
      if (mesh.userData.rot) payload.rot = { ...mesh.userData.rot };
      this._emit({ type: 'onHotspotUpdated', payload });
    }

    this._syncAll(); // sempre SYNC (live e a commit)
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
      this._emit({ type: 'onHotspotUpdated', payload: { Id: id, X: center.x, Y: center.y, Z: center.z, shape: 'sphere', dims: { r }, color: mesh.userData.color } });
    }
    this._syncAll();
  }

  _resizeSelectedBox(dims, commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'box') return;

    const c = this._clampDimsToLimits('box', dims); dims = c;
    const center = mesh.position.clone();
    const rot = mesh.userData.rot || DEFAULT_BOX_ROT;
    const rx = (rot.x || 0) * DEG2RAD, ry = (rot.y || 0) * DEG2RAD, rz = (rot.z || 0) * DEG2RAD;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
    mesh.position.copy(center);
    mesh.userData.dims = { ...dims };
    mesh.rotation.set(rx, ry, rz);

    if (commit) {
      this._emit({ type: 'onHotspotUpdated', payload: { Id: id, X: center.x, Y: center.y, Z: center.z, shape: 'box', dims: { ...dims }, rot: { ...mesh.userData.rot }, color: mesh.userData.color } });
    }
    this._syncAll();
  }

  _resizeSelectedCylinder(dims, commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh || mesh.userData.shape !== 'cylinder') return;

    const c = this._clampDimsToLimits('cylinder', dims); dims = c;
    const center = mesh.position.clone();
    const rot = mesh.userData.rot || DEFAULT_CYL_ROT;
    const rx = (rot.x || 0) * DEG2RAD, ry = (rot.y || 0) * DEG2RAD, rz = (rot.z || 0) * DEG2RAD;

    mesh.geometry.dispose();
    mesh.geometry = new THREE.CylinderGeometry(dims.r, dims.r, dims.h, 16, 1);
    mesh.position.copy(center);
    mesh.userData.dims = { ...dims };
    mesh.rotation.set(rx, ry, rz);

    if (commit) {
      this._emit({ type: 'onHotspotUpdated', payload: { Id: id, X: center.x, Y: center.y, Z: center.z, shape: 'cylinder', dims: { ...dims }, rot: { ...mesh.userData.rot }, color: mesh.userData.color } });
    }
    this._syncAll();
  }

  _rotateSelected(rotDeg, commit) {
    const id = this.selectedHotspotId; if (!id) return;
    const mesh = this.hotspots[id]; if (!mesh) return;
    if (!(mesh.userData.shape === 'box' || mesh.userData.shape === 'cylinder')) return;

    mesh.rotation.set((rotDeg.x || 0) * DEG2RAD, (rotDeg.y || 0) * DEG2RAD, (rotDeg.z || 0) * DEG2RAD);
    mesh.userData.rot = { x: rotDeg.x || 0, y: rotDeg.y || 0, z: rotDeg.z || 0 };

    if (commit) {
      const c = mesh.position;
      this._emit({
        type: 'onHotspotUpdated',
        payload: { Id: id, X: c.x, Y: c.y, Z: c.z, shape: mesh.userData.shape, dims: { ...mesh.userData.dims }, rot: { ...mesh.userData.rot }, color: mesh.userData.color }
      });
    }
    this._syncAll();
  }

  /* ===== limiti dinamici dal bbox ===== */

  _recomputeLimitsFromModel() {
    if (!this.model) {
      this.modelLimits.maxSphereR = 0.6;
      this.modelLimits.maxBox = { x: 1.0, y: 1.0, z: 1.0 };
      this.modelLimits.maxCylinder = { r: 0.6, h: 1.0 };

      // bounds fallback
      this.modelBounds.min.set(-1,-1,-1);
      this.modelBounds.max.set( 1, 1, 1);
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
    const maxCylinder = { r: maxSphereR, h: Math.max(0.02, size.y * 0.95) };

    this.modelLimits.maxSphereR = maxSphereR;
    this.modelLimits.maxBox = maxBox;
    this.modelLimits.maxCylinder = maxCylinder;

    // salva bounds
    this.modelBounds.min.copy(box.min);
    this.modelBounds.max.copy(box.max);
    this.modelBounds.center.copy(center);
    this.modelBounds.size.copy(size);

    // opzionale: adegua range degli slider Δ a ~mezzo bbox (così hai leve utili)
    const half = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    if (this.ui?.pos) {
      const setRange = (sl) => { sl.min = (-half).toFixed(3); sl.max = (half).toFixed(3); };
      setRange(this.ui.pos.x.slider);
      setRange(this.ui.pos.y.slider);
      setRange(this.ui.pos.z.slider);
    }

    this._applyLimitsToUI();
  }

  _applyLimitsToUI() {
    if (!this.ui) return;
    if (this.ui.sphere?.slider) this.ui.sphere.slider.max = String(this.modelLimits.maxSphereR.toFixed(3));
    if (this.ui.box?.x?.slider) this.ui.box.x.slider.max = String(this.modelLimits.maxBox.x.toFixed(3));
    if (this.ui.box?.y?.slider) this.ui.box.y.slider.max = String(this.modelLimits.maxBox.y.toFixed(3));
    if (this.ui.box?.z?.slider) this.ui.box.z.slider.max = String(this.modelLimits.maxBox.z.toFixed(3));
    if (this.ui.cyl?.r?.slider) this.ui.cyl.r.slider.max = String(this.modelLimits.maxCylinder.r.toFixed(3));
    if (this.ui.cyl?.h?.slider) this.ui.cyl.h.slider.max = String(this.modelLimits.maxCylinder.h.toFixed(3));
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
    } else { // cylinder
      return {
        r: clamp(dims.r, 0.01, this.modelLimits.maxCylinder.r),
        h: clamp(dims.h, 0.02, this.modelLimits.maxCylinder.h),
      };
    }
  }
}

/* ===== helpers ===== */
function normalizeHex(s) {
  if (!s) return DEFAULT_HOTSPOT_HEX;
  const t = ('' + s).trim();
  if (t.startsWith('#')) return t.length === 7 ? t.toLowerCase() : DEFAULT_HOTSPOT_HEX;
  if (/^[0-9a-fA-F]{6}$/.test(t)) return ('#' + t).toLowerCase();
  return DEFAULT_HOTSPOT_HEX;
}

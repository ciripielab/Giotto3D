// giottoemulator.js
import { Hotspot3DViewer } from './hotspot3d-viewer.js';

// === Config ===
const DEFAULT_MODEL_URL = '/models/plane.glb'; // stessa origine => niente CORS
const DEFAULT_POV = { X: 0, Y: 1.5, Z: 3, targetX: 0, targetY: 0, targetZ: 0 };
const DEFAULT_EXPOSURE = 0.8;
const MAX_MSGS = 50; // ultimo 50 messaggi
const LOAD_MODEL_FIT_OPTIONS = {
  anchor: 'ground', // 'ground' | 'center'
  maxRadius: 100,
  scaleUp: false
};
const LIGHT_MARKER_OPTIONS = {
  scaleFactor: 0.03,
  minScale: 0.18,
  maxScale: 6,
  sizeAttenuation: true
};

// Panorama: nome di default nella cartella /images
const PANORAMA_DEFAULT_NAME = 'EiffelTower.jpg';

function createDefaultAnimationState() {
  return {
    available: false,
    clips: [],
    selectedIndex: -1,
    selectedClip: '',
    playing: false
  };
}

// === Stato condiviso (single instance) ===
let shared = {
  mode: 'view',
  model3D: DEFAULT_MODEL_URL,
  model3DScale: null,
  model3DPosition: null,
  pointOfView: { ...DEFAULT_POV },
  background: 'color',
  backgroundcolor: '#ffffff',
  panoimage: null,
  animation: createDefaultAnimationState(),
  exposure: DEFAULT_EXPOSURE,
  hotspots: []
};

// === DOM refs ===
const $modeBadge = document.getElementById('modeBadgeLeft');
const $state = document.getElementById('state');
const $meta = document.getElementById('meta');
const $shape = document.getElementById('shape-select');
const $bgColor = document.getElementById('bgColor');
const $btnBgApply = document.getElementById('btn-bg-apply');
const $btnReset = document.getElementById('btn-reset');
const $msgBox = document.getElementById('msgBox');

// nuovi riferimenti per panorama
const $panoramaName = document.getElementById('panoramaName');
const $btnPanorama = document.getElementById('btn-panorama');
const $panoramaPreset = document.getElementById('panoramaPreset');

const $exposure = document.getElementById('exposure');
const $exposureLabel = document.getElementById('exposureLabel');
const $btnAmbientLight = document.getElementById('btn-ambient-light');
const $btnAddPointLight = document.getElementById('btn-add-point-light');
const $animationSelect = document.getElementById('animation-select');
const $btnAnimationToggle = document.getElementById('btn-animation-toggle');
const $animationStatus = document.getElementById('animationStatus');

function now() { return new Date().toLocaleTimeString(); }

function syncExposureControls(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || !$exposure) return;
  const clamped = Math.min(Math.max(v, 0), 2);
  $exposure.value = String(clamped);
  if ($exposureLabel) $exposureLabel.textContent = clamped.toFixed(2);
}

function render(note = '') {
  $state.textContent = JSON.stringify(shared, null, 2);
  $modeBadge.textContent = `mode: ${shared.mode}`;
  $meta.textContent = `${now()} — ${note}`;
}


function syncAnimationControls(animation = shared.animation) {
  if (!$animationSelect || !$btnAnimationToggle || !$animationStatus) return;

  const state = animation || createDefaultAnimationState();
  const clips = Array.isArray(state.clips) ? state.clips : [];

  $animationSelect.innerHTML = '';

  if (!state.available || !clips.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- nessuna clip --';
    $animationSelect.appendChild(opt);
    $animationSelect.disabled = true;
    $btnAnimationToggle.disabled = true;
    $btnAnimationToggle.textContent = 'Play';
    $animationStatus.textContent = 'modello fermo';
    return;
  }

  for (const clip of clips) {
    const opt = document.createElement('option');
    opt.value = String(clip.index);
    opt.textContent = clip.label || clip.name || `Clip ${clip.index + 1}`;
    $animationSelect.appendChild(opt);
  }

  $animationSelect.disabled = false;
  $animationSelect.value = String(
    Number.isInteger(state.selectedIndex) && state.selectedIndex >= 0
      ? state.selectedIndex
      : clips[0].index
  );
  $btnAnimationToggle.disabled = false;
  $btnAnimationToggle.textContent = state.playing ? 'Pause' : 'Play';
  $animationStatus.textContent = state.playing
    ? `in riproduzione: ${state.selectedClip || 'clip'}`
    : `in pausa: ${state.selectedClip || 'clip'}`;
}

// Area messaggi (separata)
function pushMessage(text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'item';
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = now();
  const tx = document.createElement('div');
  tx.className = 'text';
  tx.textContent = text;

  wrapper.appendChild(ts);
  wrapper.appendChild(tx);
  $msgBox.appendChild(wrapper);

  const items = $msgBox.querySelectorAll('.item');
  if (items.length > MAX_MSGS) {
    $msgBox.removeChild(items[0]);
  }
  $msgBox.scrollTop = $msgBox.scrollHeight;
}

/* ===== carica la lista di panorami da images/panoramas.json ===== */
async function loadPanoramaList() {
  if (!$panoramaPreset) return;

  try {
    const res = await fetch('/images/panoramas.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('JSON non è un array');

    // cancella eventuali voci (tranne il placeholder)
    $panoramaPreset.innerHTML = '';
    const optEmpty = document.createElement('option');
    optEmpty.value = '';
    optEmpty.textContent = '-- scegli --';
    $panoramaPreset.appendChild(optEmpty);

    // aggiungi le opzioni dalla lista
    for (const name of list) {
      if (typeof name !== 'string' || !name.trim()) continue;
      const opt = document.createElement('option');
      opt.value = name.trim();
      opt.textContent = name.trim();
      $panoramaPreset.appendChild(opt);
    }

    pushMessage('Lista panorami caricata da panoramas.json');
  } catch (err) {
    console.warn('Impossibile caricare /images/panoramas.json', err);

    const hasOnlyPlaceholder = $panoramaPreset.options.length <= 1;
    if (hasOnlyPlaceholder) {
      const opt = document.createElement('option');
      opt.value = PANORAMA_DEFAULT_NAME;
      opt.textContent = PANORAMA_DEFAULT_NAME + ' (default)';
      $panoramaPreset.appendChild(opt);
    }

    pushMessage('Errore nel caricamento della lista panorami; uso fallback');
  }
}

// chiamiamo subito il caricamento della lista
loadPanoramaList();

/* ===== Viewer singolo ===== */
const viewer = new Hotspot3DViewer(document.getElementById('viewer'), {
  lightMarkerOptions: LIGHT_MARKER_OPTIONS,
  onEvent: ({ type, payload }) => {
    // Messaggi di selezione di un hotspot in View/Edit/Hide Mode
    if (type === 'onHotspotSelected') {
      if (shared.mode === 'view' || shared.mode === 'edit' || shared.mode === 'hide') {
        const id = payload?.Id;
        if (id) pushMessage(`Hotspot selezionato: ${id}`);
        else pushMessage('Nessun hotspot selezionato');
      }
      return;
    }

    // SYNC_DATA: aggiorna shared ma non tocca l'area messaggi
    if (type === 'SYNC_DATA' && payload) {
      shared = {
        mode: payload.mode ?? shared.mode,
        model3D: payload.model3D ?? shared.model3D,
        model3DScale: payload.model3DScale !== undefined ? payload.model3DScale : shared.model3DScale,
        model3DPosition: payload.model3DPosition !== undefined ? payload.model3DPosition : shared.model3DPosition,
        pointOfView: payload.pointOfView ?? shared.pointOfView,
        background: payload.background ?? shared.background,
        backgroundcolor: payload.backgroundcolor ?? shared.backgroundcolor,
        panoimage: payload.panoimage ?? shared.panoimage,
        animation: payload.animation ?? shared.animation,
        exposure: payload.exposure ?? shared.exposure,
        hotspots: payload.hotspots ?? shared.hotspots
      };
      syncAnimationControls(shared.animation);
      syncExposureControls(shared.exposure);
      render('SYNC_DATA');
      return;
    }

    if (type === 'onHotspotAdded' && payload) {
      if (!shared.hotspots.find(h => h.Id === payload.Id)) shared.hotspots.push(payload);
      render('onHotspotAdded');
      return;
    }

    if (type === 'onHotspotRemoved' && payload) {
      shared.hotspots = shared.hotspots.filter(h => h.Id !== payload.Id);
      render('onHotspotRemoved');
      return;
    }

    if (type === 'onHotspotUpdated' && payload) {
      const hs = shared.hotspots.find(h => h.Id === payload.Id);
      if (hs) {
        hs.X = payload.X; hs.Y = payload.Y; hs.Z = payload.Z;
        if (payload.shape) hs.shape = payload.shape;
        if (payload.dims) hs.dims = payload.dims;
        if (payload.rot) hs.rot = payload.rot;
        if (payload.color) hs.color = payload.color;
        if (payload.opacity !== undefined) hs.opacity = payload.opacity;
      }
      render('onHotspotUpdated');
      return;
    }

    if (type === 'onPointOfViewChanged' && payload) {
      shared.pointOfView = { ...shared.pointOfView, ...payload };
      return;
    }

    if (type === 'onModeApplied' && payload) {
      shared.mode = payload.mode ?? shared.mode;
      render('onModeApplied');
      pushMessage(`Modalità: ${shared.mode}`);
      return;
    }

    if (type === 'onModelLoadError') {
      console.warn('[Model load error]:', payload);
      render('onModelLoadError');
      pushMessage('Errore caricamento modello');
      return;
    }

    if (type === 'onAnimationStateChanged' && payload) {
      shared.animation = payload;
      syncAnimationControls(shared.animation);
      render('onAnimationStateChanged');
      return;
    }

    if (type === 'onBackgroundChanged') {
      render(`background #${payload?.color ?? ''}`);
      return;
    }

    if (type === 'onBackgroundPanoramaChanged') {
      render(`panorama 360: ${payload?.url ?? ''}`);
      pushMessage(`Panorama 360 impostato: ${payload?.url ?? ''}`);
      return;
    }

    if (type === 'onBackgroundPanoramaError') {
      console.warn('[Panorama load error]:', payload);
      pushMessage('Errore caricamento panorama 360');
      return;
    }

  }
});

// init default (carica modello e stato base)
viewer.init(shared);
syncAnimationControls(shared.animation);
pushMessage('Pronto');

syncExposureControls(shared.exposure);

// === Azioni UI ===

// Load Model: reset + prompt URL + load
document.getElementById('btn-load').addEventListener('click', () => {
  const suggested = shared.model3D || DEFAULT_MODEL_URL;
  const url = window.prompt(
    'Inserisci il percorso del modello (.glb/.gltf).\nConsigliato: un URL relativo es. /models/plane.glb (stessa origine).',
    suggested
  );

  if (!url) {
    pushMessage('Caricamento modello annullato');
    render('loadModel: annullato');
    return;
  }

  try {
    const u = new URL(url, window.location.href);
    if (u.origin !== window.location.origin) {
      alert('Attenzione: URL di origine diversa. Potresti avere errori CORS se il server non consente l’accesso.');
    }
  } catch { }

  shared = {
    mode: 'view',
    model3D: url,
    model3DScale: null,
    model3DPosition: null,
    pointOfView: { ...DEFAULT_POV },
    background: 'color',
    backgroundcolor: '#ffffff',
    panoimage: null,
    animation: createDefaultAnimationState(),
    exposure: DEFAULT_EXPOSURE,
    hotspots: []
  };
  viewer.init(shared, {
    autoCenterAndFitModel: true,
    forceReloadModel: true,
    modelFitOptions: LOAD_MODEL_FIT_OPTIONS
  });
  syncAnimationControls(shared.animation);
  render('loadModel: reset + nuovo modello');
  pushMessage('Modello caricato');
});

document.getElementById('btn-init').addEventListener('click', () => {
  viewer.init(shared);
  render('init');
  pushMessage('Init eseguito');
});

document.getElementById('btn-view').addEventListener('click', () => {
  shared.mode = 'view';
  viewer.setMode('view');
  render('setMode(view)');
  pushMessage('Modalità: view');
});

document.getElementById('btn-edit').addEventListener('click', () => {
  shared.mode = 'edit';
  viewer.setMode('edit');
  render('setMode(edit)');
  pushMessage('Modalità: edit');
});

document.getElementById('btn-hide').addEventListener('click', () => {
  shared.mode = 'hide';
  viewer.setMode('hide');
  render('setMode(hide)');
  pushMessage('ModalitÇÿ: hide');
});

document.getElementById('btn-sync').addEventListener('click', () => {
  viewer.requestSync();
  render('REQUEST_SYNC');
  pushMessage('Sync richiesto');
});

$shape.addEventListener('change', () => {
  const shape = $shape.value; // 'sphere' | 'box' | 'cylinder'
  viewer.setCreationShape(shape);
  render(`setCreationShape(${shape})`);
  pushMessage(`Shape per nuovi hotspot: ${shape}`);
});

// Background (salvato nello shared solo su Applica)
$bgColor.addEventListener('input', () => {
  viewer.setBackground($bgColor.value);
  render('setBackground (live)');
});
$btnBgApply?.addEventListener('click', () => {
  viewer.setBackground($bgColor.value);
  shared.background = 'color';
  shared.backgroundcolor = $bgColor.value;
  shared.panoimage = null;
  render('setBackground (apply)');
  pushMessage('Background aggiornato');
});

// Select panorami: aggiorna il campo testo
$panoramaPreset?.addEventListener('change', () => {
  const v = $panoramaPreset.value;
  if (v && $panoramaName) {
    $panoramaName.value = v;
  }
});

// Panorama 360 dalla cartella /images
$btnPanorama?.addEventListener('click', () => {
  const raw = ($panoramaName?.value || '').trim();
  const fileName = raw || PANORAMA_DEFAULT_NAME;
  const url = `./images/${fileName}`;

  viewer.setPanorama(url);
  shared.background = 'pano';
  shared.panoimage = url;
  shared.backgroundcolor = null;
  render(`setPanorama(360: ${fileName})`);
  pushMessage(`Richiesto panorama 360: ${url}`);
});

// Focus ambient light and open its panel
$btnAmbientLight?.addEventListener('click', () => {
  shared.mode = 'edit';
  viewer.setMode('edit');
  const ok = viewer.focusAmbientLight?.({ select: true });
  render('setMode(edit) + focusAmbientLight');
  if (ok === false) {
    pushMessage('Ambient light non disponibile');
    return;
  }
  pushMessage('Ambient light selezionata (Edit Mode)');
});

// Add positional (point) light
$btnAddPointLight?.addEventListener('click', () => {
  const id = viewer.addPointLight?.({ select: true });
  render('addPointLight');
  pushMessage(`Positional light aggiunta${id ? `: ${id}` : ''}`);
});

$animationSelect?.addEventListener('change', () => {
  const index = Number.parseInt($animationSelect.value, 10);
  if (!Number.isInteger(index)) return;

  const ok = viewer.setAnimationClip(index);
  if (!ok) return;

  const label = $animationSelect.selectedOptions[0]?.textContent || `Clip ${index + 1}`;
  render(`setAnimationClip(${index})`);
  pushMessage(`Clip selezionata: ${label}`);
});

$btnAnimationToggle?.addEventListener('click', () => {
  const wasPlaying = !!shared.animation?.playing;
  const ok = wasPlaying ? viewer.pauseAnimation() : viewer.playAnimation();
  if (!ok) return;

  render(wasPlaying ? 'pauseAnimation' : 'playAnimation');
  pushMessage(wasPlaying ? 'Animazione in pausa' : 'Animazione in riproduzione');
});

// Exposure slider -> viewer.setExposure
$exposure?.addEventListener('input', () => {
  const v = parseFloat($exposure.value);
  if (!Number.isFinite(v)) return;
  const applied = viewer.setExposure(v);
  if (applied == null) return;
  shared.exposure = applied;
  syncExposureControls(applied);
  render('setExposure');
});

// Reset (mantiene il modello corrente)
function resetState({ preserveModel = true } = {}) {
  const modelUrl = preserveModel ? shared.model3D : DEFAULT_MODEL_URL;
  const modelScale = preserveModel ? shared.model3DScale : null;
  const modelPosition = preserveModel ? shared.model3DPosition : null;
  shared = {
    mode: 'view',
    model3D: modelUrl,
    model3DScale: modelScale,
    model3DPosition: modelPosition,
    pointOfView: { ...DEFAULT_POV },
    background: 'color',
    backgroundcolor: '#ffffff',
    panoimage: null,
    animation: createDefaultAnimationState(),
    exposure: DEFAULT_EXPOSURE,
    hotspots: []
  };
  syncAnimationControls(shared.animation);
  syncExposureControls(shared.exposure);
  viewer.init(shared);
  render('reset');
  pushMessage('Reset eseguito');
}
$btnReset?.addEventListener('click', () => resetState({ preserveModel: true }));

// Download / Import JSON
function downloadJSON() {
  // Snapshot live dal viewer per evitare race condition (es. modello appena caricato/scalato).
  const live = viewer.getSharedData();
  const exportData = {
    ...shared,
    mode: live.mode ?? shared.mode,
    model3D: live.model3D ?? shared.model3D,
    model3DScale: live.model3DScale !== undefined ? live.model3DScale : shared.model3DScale,
    model3DPosition: live.model3DPosition !== undefined ? live.model3DPosition : shared.model3DPosition,
    pointOfView: live.pointOfView ?? shared.pointOfView,
    animation: live.animation ?? shared.animation,
    exposure: live.exposure ?? shared.exposure,
    hotspots: live.hotspots ?? shared.hotspots
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `giotto-single-${ts}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
document.getElementById('btn-download').addEventListener('click', downloadJSON);


// ELS: modifiche per rendere opzionali tutte le proprietà del json
// obiettivo -> poter inviare al viewer un json con le sole proprietà da modificare
// il validatore dovrà validare solo le proprietà presenti
function validateSharedData(data) {
  const err = (msg) => ({ valid: false, error: msg });
  const ok = () => ({ valid: true });
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

   // ELS: validazione oggetto, non cambia nulla
  if (typeof data !== 'object' || data === null) return err('root non è oggetto');

  // ELS: se esiste mode lo valida
  if (data.mode != null && !['view', 'edit', 'hide'].includes(data.mode)) return err('mode non valido');

  // ELS: se esiste model3D lo valida
  if (data.model3D && typeof data.model3D !== 'string') return err('model3D deve essere stringa');
  if (data.model3DScale != null) {
    if (typeof data.model3DScale !== 'object') return err('model3DScale deve essere oggetto o null');
    const { x, y, z } = data.model3DScale;
    if (!isNum(x) || !isNum(y) || !isNum(z) || x <= 0 || y <= 0 || z <= 0) {
      return err('model3DScale deve avere x,y,z numerici maggiori di 0');
    }
  }
  if (data.model3DPosition != null) {
    if (typeof data.model3DPosition !== 'object') return err('model3DPosition deve essere oggetto o null');
    const { x, y, z } = data.model3DPosition;
    if (!isNum(x) || !isNum(y) || !isNum(z)) {
      return err('model3DPosition deve avere x,y,z numerici');
    }
  }

  if (data.animation != null) {
    if (typeof data.animation !== 'object' || data.animation === null) {
      return err('animation deve essere un oggetto');
    }

    if (data.animation.selectedIndex != null && !Number.isInteger(data.animation.selectedIndex)) {
      return err('animation.selectedIndex deve essere un intero');
    }

    if (data.animation.selectedClip != null && typeof data.animation.selectedClip !== 'string') {
      return err('animation.selectedClip deve essere una stringa');
    }

    if (data.animation.playing != null && typeof data.animation.playing !== 'boolean') {
      return err('animation.playing deve essere boolean');
    }

    if (data.animation.clips != null) {
      if (!Array.isArray(data.animation.clips)) return err('animation.clips deve essere array');

      for (const clip of data.animation.clips) {
        if (typeof clip !== 'object' || clip === null) return err('animation.clips contiene valori non validi');
        if (!Number.isInteger(clip.index)) return err('animation.clips[].index deve essere un intero');
        if (clip.name != null && typeof clip.name !== 'string') return err('animation.clips[].name deve essere stringa');
        if (clip.label != null && typeof clip.label !== 'string') return err('animation.clips[].label deve essere stringa');
        if (clip.duration != null && !Number.isFinite(clip.duration)) return err('animation.clips[].duration deve essere numerico');
      }
    }
  }
  
  // ELS: se esiste pointOfView lo valida
  const pov = data.pointOfView;
  if (pov != null && (!isNum(pov.X) || !isNum(pov.Y) || !isNum(pov.Z))) return err('pointOfView deve avere X,Y,Z numerici');
  if (pov != null) {
    if (pov.targetX != null && !isNum(pov.targetX)) return err('pointOfView.targetX deve essere numerico');
    if (pov.targetY != null && !isNum(pov.targetY)) return err('pointOfView.targetY deve essere numerico');
    if (pov.targetZ != null && !isNum(pov.targetZ)) return err('pointOfView.targetZ deve essere numerico');
  }

  // ELS: se esiste background lo valida
  if (data.background != null && !['color', 'pano'].includes(data.background)) return err('background non valido (usa color o pano)');

  // ELS: cambiando !== con != possiamo fare un unico check su null, comprendendo anche il caso undefined
  if (data.backgroundcolor != null && typeof data.backgroundcolor !== 'string') {
    return err('backgroundcolor deve essere stringa o null');
  }

  // ELS: cambiando !== con != possiamo fare un unico check su null, comprendendo anche il caso undefined
  if (data.panoimage != null && typeof data.panoimage !== 'string') {
    return err('panoimage deve essere stringa o null');
  }

  if (data.exposure != null && (!isNum(data.exposure) || data.exposure < 0 || data.exposure > 2)) {
    return err('exposure deve essere un numero tra 0 e 2');
  }

  // ELS: Check degli hotspots solo se il json contiene la proprietà
  // aggiungo un if che blocca tutto se non esiste la proprietà hotspots
  if (data.hotspots != null) {
    if (!Array.isArray(data.hotspots)) return err('hotspots deve essere array');

    for (const h of data.hotspots) {
      if (typeof h !== 'object' || h === null) return err('hotspot non è oggetto');
      if (typeof h.Id !== 'string' || !h.Id) return err('hotspot.Id mancante o non valido');
      if (!isNum(h.X) || !isNum(h.Y) || !isNum(h.Z)) return err(`hotspot ${h.Id}: coordinate X/Y/Z non valide`);

      const shape = h.shape ?? 'sphere';
      if (!['sphere', 'box', 'cylinder'].includes(shape)) return err(`hotspot ${h.Id}: shape non valida`);

      if (shape === 'sphere') {
        const r = h.dims?.r;
        if (!isNum(r) || r <= 0) return err(`hotspot ${h.Id}: dims.r non valido (> 0)`);
      } else if (shape === 'box') {
        const { x, y, z } = h.dims || {};
        if (![x, y, z].every(isNum) || x <= 0 || y <= 0 || z <= 0) {
          return err(`hotspot ${h.Id}: dims.x/y/z non validi (> 0)`);
        }
        if (h.rot !== undefined) {
          const { x: rx, y: ry, z: rz } = h.rot || {};
          const inRange = (a) => isNum(a) && a >= -360 && a <= 360;
          if (![rx, ry, rz].every(inRange)) return err(`hotspot ${h.Id}: rot.x/y/z non validi (gradi -360..360)`);
        }
      } else { // cylinder
        const { r, h: hh } = h.dims || {};
        if (!isNum(r) || r <= 0 || !isNum(hh) || hh <= 0) {
          return err(`hotspot ${h.Id}: dims.r/h non validi (> 0)`);
        }
        if (h.rot !== undefined) {
          const { x: rx, y: ry, z: rz } = h.rot || {};
          const inRange = (a) => isNum(a) && a >= -360 && a <= 360;
          if (![rx, ry, rz].every(inRange)) return err(`hotspot ${h.Id}: rot.x/y/z non validi (gradi -360..360)`);
        }
      }

      if (h.color !== undefined) {
        if (typeof h.color !== 'string') return err(`hotspot ${h.Id}: color deve essere stringa`);
        const hex = h.color.replace('#', '');
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) return err(`hotspot ${h.Id}: color non valido (usa #rrggbb)`);
      }

      if (h.opacity !== undefined) {
        if (typeof h.opacity !== 'number' || h.opacity < 0 || h.opacity > 1) {
          return err(`hotspot ${h.Id}: opacity deve essere numero tra 0 e 1`);
        }
      }
    }
  }

  return ok();
}


document.getElementById('btn-import').addEventListener('click', () => document.getElementById('importInput').click());
document.getElementById('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const { valid, error } = validateSharedData(data);
    if (!valid) { alert('Import fallito: ' + error); return; }


    // ELS: per gestire upload di json parziali mantenendo le proprietà già caricate facciamo update di 
    // shared definendo le singole proprietà (operazione che si potrebbe fattorizzare facilmente con una utility)
    // shared = data;
    shared = {
      mode: data.mode ?? shared.mode,
      model3D: data.model3D ?? shared.model3D,
      model3DScale: data.model3DScale !== undefined
        ? data.model3DScale
        : (data.model3D != null ? null : shared.model3DScale),
      model3DPosition: data.model3DPosition !== undefined
        ? data.model3DPosition
        : (data.model3D != null ? null : shared.model3DPosition),
      pointOfView: data.pointOfView ?? shared.pointOfView,
      background: data.background ?? shared.background,
      backgroundcolor: data.backgroundcolor ?? shared.backgroundcolor,
      panoimage: data.panoimage ?? shared.panoimage,
      animation: data.animation ?? (data.model3D != null ? createDefaultAnimationState() : shared.animation),
      exposure: data.exposure ?? shared.exposure,
      hotspots: data.hotspots ?? shared.hotspots
    };

    syncAnimationControls(shared.animation);
    syncExposureControls(shared.exposure);
    viewer.init(shared);

    // ELS: Valutare se sia più pulito impostare anche bg e panoImage in init del viewer,
    // il controllo sulle proprietà esiste già, sono di fatto opzionali
    if (shared.background === 'color' && shared.backgroundcolor) {
      viewer.setBackground(shared.backgroundcolor);
      if ($bgColor) $bgColor.value = shared.backgroundcolor;
    } else if (shared.background === 'pano' && shared.panoimage) {
      viewer.setPanorama(shared.panoimage);
      if ($panoramaName) {
        const fileName = shared.panoimage.split('/').pop();
        $panoramaName.value = fileName || shared.panoimage;
      }
      if ($panoramaPreset) {
        const fileName = shared.panoimage.split('/').pop();
        const match = Array.from($panoramaPreset.options).find((opt) => opt.value === fileName);
        $panoramaPreset.value = match ? fileName : '';
      }
    }

    render('imported');
    pushMessage('JSON importato');
  } catch (err) {
    console.error(err); alert('Errore durante import JSON');
    pushMessage('Errore import JSON');
  } finally {
    e.target.value = '';
  }

});

// render iniziale
render('ready');

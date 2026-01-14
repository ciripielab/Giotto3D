// giottoemulator.js
import { Hotspot3DViewer } from './hotspot3d-viewer.js';

// === Config ===
const DEFAULT_MODEL_URL = '/models/plane.glb'; // stessa origine => niente CORS
const DEFAULT_POV = { X: 0, Y: 1.5, Z: 3 };
const MAX_MSGS = 50; // ultimo 50 messaggi

// Panorama: nome di default nella cartella /images
const PANORAMA_DEFAULT_NAME = 'EiffelTower.jpg';

// === Stato condiviso (single instance) ===
let shared = {
  mode: 'view',
  model3D: DEFAULT_MODEL_URL,
  pointOfView: { ...DEFAULT_POV },
  background: 'color',
  backgroundcolor: '#ffffff',
  panoimage: null,
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
const $panoramaName   = document.getElementById('panoramaName');
const $btnPanorama    = document.getElementById('btn-panorama');
const $panoramaPreset = document.getElementById('panoramaPreset');

// nuovi riferimenti per light intensity
const $lightIntensity       = document.getElementById('lightIntensity');
const $lightIntensityLabel  = document.getElementById('lightIntensityLabel');

function now() { return new Date().toLocaleTimeString(); }
function render(note='') {
  $state.textContent = JSON.stringify(shared, null, 2);
  $modeBadge.textContent = `mode: ${shared.mode}`;
  $meta.textContent = `${now()} — ${note}`;
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
  onEvent: ({ type, payload }) => {
    // Messaggi di selezione in View/Edit Mode
    if (type === 'onHotspotSelected') {
      if (shared.mode === 'view' || shared.mode === 'edit') {
        const id = payload?.Id;
        if (id) pushMessage(`Hotspot selezionato: ${id}`);
        else    pushMessage('Nessun hotspot selezionato');
      }
      return;
    }

    // SYNC_DATA: aggiorna shared ma non tocca l'area messaggi
    if (type === 'SYNC_DATA' && payload) {
      shared = {
        mode: payload.mode,
        model3D: payload.model3D,
        pointOfView: payload.pointOfView,
        background: payload.background ?? shared.background ?? 'color',
        backgroundcolor: payload.backgroundcolor ?? shared.backgroundcolor ?? '#ffffff',
        panoimage: payload.panoimage ?? shared.panoimage ?? null,
        hotspots: payload.hotspots ?? []
      };
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
        if (payload.dims)  hs.dims  = payload.dims;
        if (payload.rot)   hs.rot   = payload.rot;
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

    if (type === 'onLightChanged') {
      render(`lightIntensity=${payload?.intensity ?? 'n/a'}`);
      return;
    }
  }
});

// init default (carica modello e stato base)
viewer.init(shared);
pushMessage('Pronto');

// applica lightIntensity iniziale
if ($lightIntensity) {
  const initVal = parseFloat($lightIntensity.value);
  if (Number.isFinite(initVal)) {
    viewer.setLightIntensity(initVal);
    if ($lightIntensityLabel) $lightIntensityLabel.textContent = initVal.toFixed(2);
  }
}

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
  } catch {}

  shared = {
    mode: 'view',
    model3D: url,
    pointOfView: { ...DEFAULT_POV },
    background: 'color',
    backgroundcolor: '#ffffff',
    panoimage: null,
    hotspots: []
  };
  viewer.init(shared);
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
  const url = `/images/${fileName}`;

  viewer.setPanorama(url);
  shared.background = 'pano';
  shared.panoimage = url;
  shared.backgroundcolor = null;
  render(`setPanorama(360: ${fileName})`);
  pushMessage(`Richiesto panorama 360: ${url}`);
});

// Light intensity slider -> viewer.setLightIntensity
$lightIntensity?.addEventListener('input', () => {
  const v = parseFloat($lightIntensity.value);
  if (!Number.isFinite(v)) return;
  viewer.setLightIntensity(v);
  if ($lightIntensityLabel) $lightIntensityLabel.textContent = v.toFixed(2);
});

// Reset (mantiene il modello corrente)
function resetState({ preserveModel = true } = {}) {
  const modelUrl = preserveModel ? shared.model3D : DEFAULT_MODEL_URL;
  shared = {
    mode: 'view',
    model3D: modelUrl,
    pointOfView: { ...DEFAULT_POV },
    background: 'color',
    backgroundcolor: '#ffffff',
    panoimage: null,
    hotspots: []
  };
  viewer.init(shared);
  render('reset');
  pushMessage('Reset eseguito');
}
$btnReset?.addEventListener('click', () => resetState({ preserveModel: true }));

// Download / Import JSON
function downloadJSON() {
  const blob = new Blob([JSON.stringify(shared, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `giotto-single-${ts}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
document.getElementById('btn-download').addEventListener('click', downloadJSON);


function validateSharedData(data) {
  const err = (msg) => ({ valid: false, error: msg });
  const ok  = () => ({ valid: true });
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  if (typeof data !== 'object' || data === null) return err('root non è oggetto');

  if (!['view', 'edit', 'hide'].includes(data.mode)) return err('mode non valido');
  if (typeof data.model3D !== 'string') return err('model3D deve essere stringa');

  const pov = data.pointOfView;
  if (!pov || !isNum(pov.X) || !isNum(pov.Y) || !isNum(pov.Z)) return err('pointOfView deve avere X,Y,Z numerici');

  if (!['color', 'pano'].includes(data.background)) return err('background non valido (usa color o pano)');
  if (data.backgroundcolor !== null && data.backgroundcolor !== undefined && typeof data.backgroundcolor !== 'string') {
    return err('backgroundcolor deve essere stringa o null');
  }
  if (data.panoimage !== null && data.panoimage !== undefined && typeof data.panoimage !== 'string') {
    return err('panoimage deve essere stringa o null');
  }

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
    shared = data;
    viewer.init(shared);
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

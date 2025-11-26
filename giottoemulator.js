// giottoemulator.js
import { Hotspot3DViewer } from './hotspot3d-viewer.js';

// === Config ===
const DEFAULT_MODEL_URL = '/models/plane.glb'; // stessa origine => niente CORS
const DEFAULT_POV = { X: 0, Y: 1.5, Z: 3 };
const MAX_MSGS = 50; // ultimo 50 messaggi

// === Stato condiviso (single instance) ===
let shared = {
  mode: 'view',
  model3D: DEFAULT_MODEL_URL,
  pointOfView: { ...DEFAULT_POV },
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

function now() { return new Date().toLocaleTimeString(); }
function render(note='') {
  $state.textContent = JSON.stringify(shared, null, 2);
  $modeBadge.textContent = `mode: ${shared.mode}`;
  $meta.textContent = `${now()} — ${note}`;
}

// Area messaggi (separata)
function pushMessage(text) {
  // crea riga
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

  // trim storia
  const items = $msgBox.querySelectorAll('.item');
  if (items.length > MAX_MSGS) {
    $msgBox.removeChild(items[0]);
  }
  // scroll in fondo
  $msgBox.scrollTop = $msgBox.scrollHeight;
}

// === Viewer singolo ===
const viewer = new Hotspot3DViewer(document.getElementById('viewer'), {
  onEvent: ({ type, payload }) => {
    // Messaggi di selezione SOLO in View Mode
    if (type === 'onHotspotSelected') {
      if (shared.mode === 'view') {
        const id = payload?.Id;
        if (id) pushMessage(`Hotspot selezionato: ${id}`);
        else    pushMessage('Nessun hotspot selezionato');
      }
      return;
    }

    // SYNC_DATA: aggiorna shared ma non tocca l'area messaggi
    if (type === 'SYNC_DATA' && payload) {
      shared = payload;
      render('SYNC_DATA');
      return;
    }

    // Altri eventi con aggiornamento stato ma senza messaggi "rumorosi"
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
      }
      render('onHotspotUpdated');
      return;
    }

    if (type === 'onPointOfViewChanged' && payload) {
      shared.pointOfView = { ...shared.pointOfView, ...payload };
      // nessun messaggio
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
      // messaggio opzionale
      return;
    }

    // fallback silenzioso
    // render(type);
  }
});

// init default (carica modello e stato base)
viewer.init(shared);
pushMessage('Pronto');

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
  const shape = $shape.value; // 'sphere' | 'box'
  viewer.setCreationShape(shape);
  render(`setCreationShape(${shape})`);
  pushMessage(`Shape per nuovi hotspot: ${shape}`);
});

// Background (non salvato nello shared)
$bgColor.addEventListener('input', () => {
  viewer.setBackground($bgColor.value);
  render('setBackground (live)');
});
$btnBgApply?.addEventListener('click', () => {
  viewer.setBackground($bgColor.value);
  render('setBackground (apply)');
  pushMessage('Background aggiornato');
});

// Reset (mantiene il modello corrente)
function resetState({ preserveModel = true } = {}) {
  const modelUrl = preserveModel ? shared.model3D : DEFAULT_MODEL_URL;
  shared = {
    mode: 'view',
    model3D: modelUrl,
    pointOfView: { ...DEFAULT_POV },
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

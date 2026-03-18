# Giotto3D 0.0.1

Single-page demo per visualizzare un modello 3D con hotspot editabili (sphere/box/cylinder) tramite Three.js. Include un pannello di controllo per emulare lo stato condiviso di Giotto, esportare/importare JSON e monitorare gli eventi generati dal viewer.

## Requisiti
- Browser moderno con WebGL e moduli ES attivi.
- Accesso alla rete per caricare i moduli Three.js da `https://esm.sh/`.
- Serve un piccolo server statico locale per evitare problemi CORS quando si caricano i `.glb`.

## Avvio rapido
1. Clona o copia la cartella e posizionati nella root (`Giotto3D/`).
2. Avvia un server statico, ad esempio:
   - Python: `python -m http.server 8000`
   - Node (serve): `npx serve .`
3. Apri `http://localhost:8000` nel browser.
4. Dovresti vedere il viewer a sinistra e il pannello Giotto Emulator a destra con il modello di default `models/plane.glb`.

## Uso dell'interfaccia
- **Init/View/Edit/Hide**: cambia modalità del viewer. In *edit* puoi creare, spostare, ridimensionare e ruotare hotspot.
- **Load Model (URL)**: inserisci il percorso di un `.glb/.gltf` (meglio relativo, es. `/models/plane.glb`). Il caricamento resetta lo stato.
- **Shape**: scegli la forma con cui verranno creati i nuovi hotspot.
- **Request Sync**: forza l'invio dello stato corrente al pannello (sinistra/destra restano in sync tramite `SYNC_DATA`).
- **Reset**: azzera lo stato mantenendo il modello corrente.
- **Background**: cambia il colore di sfondo (non salvato nello stato condiviso).
- **Download JSON / Import JSON**: esporta o importa lo stato (mode, modello, point of view, hotspot con coordinate, dimensioni, rotazioni e colore).
- **Messaggi**: log testuale degli eventi principali (selezione hotspot, cambi di modalità, import/export, errori modello).

### Editing hotspot in modalità *edit*
- Clic sul modello per creare un hotspot alla posizione di intersezione.
- Seleziona un hotspot per aprire il pannello contestuale:
  - Slider `ΔX/ΔY/ΔZ` per traslazione rispetto alla posizione corrente.
  - Slider dimensioni (raggio, box x/y/z, cilindro r/h) con limiti dinamici basati sul bounding box del modello.
  - Slider di rotazione (box/cilindro).
  - Picker colore.
  - `Delete` per rimuovere l'hotspot (anche `Del/Backspace`).

## Struttura
- `index.html` – layout e pannello di controllo dell'emulatore.
- `giottoemulator.js` – gestisce stato condiviso, UI di destra e comunicazione con il viewer.
- `hotspot3d-viewer.js` – viewer 3D, gestione hotspot e UI contestuale in overlay.
- `models/` – modelli di esempio (`plane.glb`, `submersible.glb`).

## Note
- Il badge e il riquadro JSON mostrano sempre lo stato sincronizzato corrente.
- I limiti per dimensioni e slider vengono ricalcolati dal bounding box del modello caricato.
- Se usi un URL esterno per il modello, assicurati che il server consenta il CORS. In caso contrario apparirà un messaggio di errore in alto a destra.

## Documentazione istanza `Hotspot3DViewer`

Questa sezione descrive l'uso dell'istanza del viewer dal punto di vista integrazione applicativa (metodi pubblici, eventi emessi, formato stato).

### 1) Quick start

```js
import { Hotspot3DViewer } from './hotspot3d-viewer.js';

const shared = {
  mode: 'view',
  model3D: '/models/plane.glb',
  model3DScale: null,
  model3DPosition: null,
  pointOfView: { X: 0, Y: 1.5, Z: 3, targetX: 0, targetY: 0, targetZ: 0 },
  animation: {
    selectedIndex: 0,
    selectedClip: '',
    playing: false
  },
  hotspots: []
};

const viewer = new Hotspot3DViewer(document.getElementById('viewer'), {
  onEvent: ({ type, payload }) => {
    // gestisci eventi del viewer
    console.log(type, payload);
  },
  background: 0xf0f0f0
});

viewer.init(shared);
```

### 2) Costruttore

```js
new Hotspot3DViewer(container, {
  modelUrl = '',
  onEvent = () => {},
  background = 0xf0f0f0
})
```

- `container` (`HTMLElement`, obbligatorio): nodo DOM che ospita renderer e UI overlay.
- `modelUrl` (`string`, opzionale): se valorizzato, richiama automaticamente `loadModel(modelUrl)`.
- `onEvent` (`function`, opzionale): callback centralizzata eventi `{ type, payload }`.
- `background` (`number|string`, opzionale): colore iniziale scena.

### 3) Metodi pubblici

#### `init(sharedData, options?)`

```js
viewer.init(sharedData, {
  autoCenterAndFitModel: false,
  forceReloadModel: false
});
```

Applica stato condiviso:
- modalita (`mode`)
- modello (`model3D`, `model3DScale`, `model3DPosition`)
- camera (`pointOfView`)
- animazione (`animation`)
- hotspot (`hotspots`)

Opzioni:
- `autoCenterAndFitModel`: centra e adatta il modello al caricamento.
- `forceReloadModel`: forza ricarica anche con URL uguale al corrente.

#### `loadModel(url, options?)`

```js
viewer.loadModel('/models/plane.glb', {
  autoCenterAndFit: true,
  initialScale: { x: 1, y: 1, z: 1 },
  initialPosition: { x: 0, y: 0, z: 0 }
});
```

Carica un modello GLTF/GLB. In caso di errore emette `onModelLoadError`.

#### `setMode(mode)`

```js
viewer.setMode('view');   // 'view' | 'edit' | 'hide'
viewer.setMode('edit');
viewer.setMode('hide');
```

#### `setCreationShape(shape)`

```js
viewer.setCreationShape('sphere');   // 'sphere' | 'box' | 'cylinder'
```

Forma usata quando in modalita `edit` fai click sul modello per creare un nuovo hotspot.

#### Sfondo e lighting

```js
viewer.setBackground('#ffffff');       // o 0xffffff
viewer.setPanorama('./images/EiffelTower.jpg');
viewer.setEnvMapIntensity(1.0);        // clamp 0..3
viewer.setEmissiveIntensity(1.0);      // clamp 0..3
viewer.setExposure(0.8);               // clamp 0..2
```

#### Animazioni modello

```js
const state = viewer.getAnimationState();
viewer.setAnimationClip(0);            // index
viewer.setAnimationClip('Clip 1');     // label/name
viewer.playAnimation();
viewer.pauseAnimation();
```

`setAnimationClip`, `playAnimation`, `pauseAnimation` ritornano `boolean`.

#### Luci

```js
const pointId = viewer.addPointLight({ select: true });
const ok = viewer.focusAmbientLight({ select: true });
```

- `addPointLight` ritorna ID luce (es. `point_1`) o `null`.
- `focusAmbientLight` ritorna `true/false`.

#### Sync e stato

```js
const data = viewer.getSharedData();
viewer.requestSync(); // emette SYNC_DATA
viewer.highlightHotspot('hs_123');
```

### 4) Eventi emessi (`onEvent`)

La callback riceve sempre:

```js
{ type: string, payload?: any }
```

#### Eventi di sync/stato

- `SYNC_DATA`
  - payload: snapshot completo da `getSharedData()`.

- `onModeApplied`
  - payload:
  ```json
  { "mode": "view" }
  ```

- `onPointOfViewChanged`
  - payload:
  ```json
  { "X": 0, "Y": 1.5, "Z": 3, "targetX": 0, "targetY": 0, "targetZ": 0 }
  ```

#### Eventi hotspot

- `onHotspotAdded`
- `onHotspotUpdated`
- `onHotspotRemoved`
- `onHotspotSelected`

Payload tipici:

```json
{
  "Id": "hs_1740000000000",
  "X": 0.12,
  "Y": 1.48,
  "Z": -0.33,
  "shape": "box",
  "dims": { "x": 0.08, "y": 0.08, "z": 0.08 },
  "rot": { "x": 0, "y": 0, "z": 0 },
  "color": "#00ff00",
  "opacity": 1,
  "material": {
    "roughness": 0.4,
    "metalness": 0.1,
    "envMapIntensity": 1
  }
}
```

Per rimozione/selezione:

```json
{ "Id": "hs_1740000000000" }
```

oppure, in caso di nessuna selezione:

```json
{ "Id": null }
```

#### Eventi modello/animazione

- `onModelLoadError`
  - payload:
  ```json
  { "url": "/models/missing.glb", "message": "..." }
  ```

- `onAnimationStateChanged`
  - payload:
  ```json
  {
    "available": true,
    "clips": [
      { "index": 0, "name": "Take 001", "label": "Take 001", "duration": 2.4 }
    ],
    "selectedIndex": 0,
    "selectedClip": "Take 001",
    "playing": false
  }
  ```

#### Eventi background

- `onBackgroundChanged`
  - payload:
  ```json
  { "color": "ffffff" }
  ```

- `onBackgroundPanoramaChanged`
  - payload:
  ```json
  { "url": "./images/EiffelTower.jpg" }
  ```

- `onBackgroundPanoramaError`
  - payload:
  ```json
  { "url": "./images/missing.jpg", "message": "..." }
  ```

#### Eventi luci

- `onLightSelected`
  - payload:
  ```json
  { "Id": "ambient" }
  ```
  oppure
  ```json
  { "Id": "directional" }
  ```
  oppure
  ```json
  { "Id": "point_1" }
  ```
  oppure
  ```json
  { "Id": null }
  ```

- `onLightRemoved`
  - payload:
  ```json
  { "Id": "point_1" }
  ```

### 5) Formato `sharedData`

Schema operativo (input di `init`, output di `getSharedData`/`SYNC_DATA`):

```json
{
  "mode": "view",
  "model3D": "/models/plane.glb",
  "model3DScale": { "x": 1, "y": 1, "z": 1 },
  "model3DPosition": { "x": 0, "y": 0, "z": 0 },
  "pointOfView": { "X": 0, "Y": 1.5, "Z": 3, "targetX": 0, "targetY": 0, "targetZ": 0 },
  "animation": {
    "available": true,
    "clips": [
      { "index": 0, "name": "Take 001", "label": "Take 001", "duration": 2.4 }
    ],
    "selectedIndex": 0,
    "selectedClip": "Take 001",
    "playing": false
  },
  "hotspots": [
    {
      "Id": "hs_1",
      "X": 0,
      "Y": 0,
      "Z": 0,
      "shape": "sphere",
      "dims": { "r": 0.05 },
      "color": "#00ff00",
      "opacity": 1,
      "material": {
        "roughness": 0.4,
        "metalness": 0.1,
        "envMapIntensity": 1
      }
    }
  ]
}
```

Note su hotspot:
- `shape: "sphere"` -> `dims: { r }`
- `shape: "box"` -> `dims: { x, y, z }` + `rot: { x, y, z }`
- `shape: "cylinder"` -> `dims: { r, h }` + `rot: { x, y, z }`

### 6) Esempio integrazione consigliato (`onEvent`)

```js
const viewer = new Hotspot3DViewer(container, {
  onEvent: ({ type, payload }) => {
    if (type === 'SYNC_DATA' && payload) {
      shared = {
        mode: payload.mode ?? shared.mode,
        model3D: payload.model3D ?? shared.model3D,
        model3DScale: payload.model3DScale !== undefined ? payload.model3DScale : shared.model3DScale,
        model3DPosition: payload.model3DPosition !== undefined ? payload.model3DPosition : shared.model3DPosition,
        pointOfView: payload.pointOfView ?? shared.pointOfView,
        animation: payload.animation ?? shared.animation,
        hotspots: payload.hotspots ?? shared.hotspots
      };
      return;
    }

    if (type === 'onHotspotAdded' && payload) {
      if (!shared.hotspots.find((h) => h.Id === payload.Id)) shared.hotspots.push(payload);
      return;
    }

    if (type === 'onHotspotUpdated' && payload) {
      const hs = shared.hotspots.find((h) => h.Id === payload.Id);
      if (!hs) return;
      hs.X = payload.X; hs.Y = payload.Y; hs.Z = payload.Z;
      if (payload.shape) hs.shape = payload.shape;
      if (payload.dims) hs.dims = payload.dims;
      if (payload.rot) hs.rot = payload.rot;
      if (payload.color) hs.color = payload.color;
      if (payload.opacity !== undefined) hs.opacity = payload.opacity;
      if (payload.material) hs.material = payload.material;
      return;
    }

    if (type === 'onHotspotRemoved' && payload) {
      shared.hotspots = shared.hotspots.filter((h) => h.Id !== payload.Id);
    }
  }
});
```

### 7) Note importanti per evitare bug

- `init()` gestisce solo: `mode`, `model3D`, `model3DScale`, `model3DPosition`, `pointOfView`, `animation`, `hotspots`.
- Per coerenza del punto di vista salva anche `pointOfView.targetX/targetY/targetZ` (target OrbitControls).
- `background`, `backgroundcolor`, `panoimage` non fanno parte di `SYNC_DATA` del viewer: mantienili lato app e applicali via `setBackground`/`setPanorama`.
- Se richiami `init()` senza campo `hotspots`, per default viene usato `[]` e gli hotspot correnti vengono azzerati.
- Le dimensioni hotspot sono clampate ai limiti dinamici derivati dal bounding box del modello.

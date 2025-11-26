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

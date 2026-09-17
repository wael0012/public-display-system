# BA Wael Hammami – Public Display System

Public-Display-System für zwei Räume (Bachelorarbeit, TU Dortmund).

## Wie es funktioniert

- In jedem der beiden Räume (Labor und Küche) stehen **zwei Bildschirme**:
  ein **Haupt-Display** (main) und ein **Hilfs-Display** (aux), gespeist von
  zwei Chrome-Vollbildfenstern desselben Rechners.
- Eine Kamera erkennt **im Browser** per MediaPipe Face Detector (BlazeFace;
  bei ausbleibender Gesichtserkennung ergänzt ein Pose Landmarker), ob eine
  Person vor dem Display steht, wie nah sie ist und wie lange sie verweilt.
- Jede Seite meldet ihren eigenen Präsenz-Status per WebSocket an den
  **Signaling-Server**. Nur der Server kennt beide Seiten gleichzeitig und
  entscheidet zentral, **ob und wann** ein Anruf beginnt (`start_call`) oder
  endet (`end_call`) — die Clients raten nichts selbst.
- Sobald der Server einen Anruf startet, bauen die beiden Haupt-Displays
  direkt eine **WebRTC-Peer-to-Peer-Verbindung** auf (reines LAN, keine
  Cloud, keine STUN/TURN-Server nötig). Der Server vermittelt dabei nur noch
  Offer/Answer/ICE-Kandidaten, das Video/Audio läuft danach direkt zwischen
  den beiden Rechnern.
- Ohne Person bleibt das Display im Ruhezustand (Ambient-Szene, Partikelfeld).

## Architektur-Überblick

**Backend** — ein einzelner Python-Prozess (FastAPI + WebSocket):

| Datei | Zweck |
|---|---|
| `backend/signaling_server.py` | Signaling-Server: verwaltet Verbindungen, entscheidet per `ConnectionManager.evaluate_call_state()` server-seitig über Anrufbeginn/-ende, leitet WebRTC-Signaling weiter, schreibt Studien-Ereignisse ins CSV-Log. |

**Frontend** — React/Vite-App, die als zwei separate Browserfenster
(`?screen=main` und `?screen=aux`) oder als ein geteiltes Fenster läuft:

| Datei | Zweck |
|---|---|
| `src/main.jsx` | Einstiegspunkt, mountet `App` in den DOM. |
| `src/App.jsx` | Hauptkomponente: State Machine (AMBIENT → DETECTING → HANDSHAKE → ACTIVE), verbindet Signaling, WebRTC und Gesichtserkennung, verzweigt ins passende Rendering. |
| `src/hooks/useFaceDetection.js` | MediaPipe-Gesichtserkennung im Browser (Präsenz, Distanz, Verweildauer). |
| `src/hooks/useSignaling.js` | WebSocket-Verbindung zum Signaling-Server inkl. Reconnect/Heartbeat. |
| `src/hooks/useWebRTC.js` | Baut die WebRTC-Peer-Verbindung auf (Offer/Answer/ICE, Caller-/Callee-Rolle). |
| `src/components/dual/AuxScreenApp.jsx` | Eigenständiges Hilfs-Display-Fenster (`?screen=aux`); rein passiv, empfängt seinen Zustand vom Haupt-Fenster per `BroadcastChannel`. |
| `src/components/dual/MainDisplay.jsx` | Rendering des Haupt-Displays (Ambient-Szene bzw. Remote-Video im Anruf). |
| `src/components/dual/AuxDisplay.jsx` | Rendering des Hilfs-Displays (Proxemic-Ring, Anleitung, im Anruf Self-View/Audio-Wellenform). |
| `src/components/dual/AmbientScene.jsx` | Sternfeld-Ambient-Szene (Canvas 2D) für Haupt- und Hilfs-Display. |
| `src/components/dual/AuxRingScene.jsx` | Ring-Visualisierung (Verweil-Fortschritt) für das Hilfs-Display. |
| `src/components/dual/AudioWaveScene.jsx` | Audio-Wellenform-Visualisierung für das Hilfs-Display während eines Anrufs. |
| `src/components/dual/SplitLayout.jsx` | Teilt ein Fenster in zwei Hälften für den Split-Betrieb über zwei Monitore. |
| `src/components/dual/StartGate.jsx` | Start-Overlay: eine Nutzergeste für Vollbild, Audio-Freigabe, Cursor, Wake Lock. |
| `src/components/dual/displayBridge.js` | „Merged Display“-Feature (aktuell per Konstante deaktiviert): lokale Video-Brücke, die das Remote-Bild über beide Bildschirme spannen würde. |
| `src/components/dual/visualBus.js` | Gemeinsamer Kanal für hochfrequente visuelle Werte (Position, Näherung) außerhalb des React-State. |
| `src/components/dual/useProxemicZone.js` | Leitet aus dem Näherungswert eine von drei proxemischen Zonen ab (fern/mittel/nah). |
| `src/components/*.jsx` (ohne `dual/`) | Alternativer Einzelbildschirm-Anzeigepfad, aktiv bei `?screen=1`/`?screen=2`. |

## Voraussetzungen

- Windows 11
- Python 3.12
- Node.js 20
- Google Chrome
- Zwei Bildschirme im erweiterten Modus (Haupt- + Hilfs-Display)
- Logi Tune geschlossen (blockiert sonst den Kamerazugriff)

## Installation

```
cd backend
pip install -r requirements.txt

cd ../frontend
npm install
```

## Zertifikate

`certs/` liegt **nicht** im Repository (siehe `.gitignore`) und muss lokal
angelegt werden — Backend und Frontend laufen sonst nur über unverschlüsseltes
HTTP/WS. Kamera- und Wake-Lock-APIs im Browser verlangen aber einen sicheren
Kontext (HTTPS), daher werden selbstsignierte Zertifikate benötigt, die
**beide** Raum-IPs als `subjectAltName` enthalten:

```
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=public-display" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:129.217.18.124,IP:129.217.18.121"
```

(IPs ggf. an die tatsächlichen Adressen der Labor-/Küchen-Rechner anpassen.)
Chrome wird beim Start zusätzlich mit `--ignore-certificate-errors`
aufgerufen (siehe `start_display.ps1`), sodass das selbstsignierte Zertifikat
keine manuelle Bestätigung im Browser braucht.

## Start

**Labor-Rechner zuerst** (Backend + Frontend + eigene Displays):

```
start_display_labor.bat [SESSION_ID]
```

**Küchen-Rechner** (nur die zwei Browserfenster, erst NACH dem Labor-Rechner starten):

```
start_display_kueche.bat
```

`SESSION_ID` kennzeichnet die Studien-Sitzung im CSV-Protokoll
(`backend/logs/session_log.csv`); ohne Angabe wird `default` verwendet.

Manuell/zum Entwickeln (ein Rechner, ein Fenster genügt):

```
cd backend
python signaling_server.py

cd frontend
npm run dev -- --host
```

## Ports

| Dienst                    | Port | Rechner |
|---------------------------|------|---------|
| Signaling-Server (WSS)    | 8765 | Labor   |
| Frontend (HTTPS)          | 5173 | Labor   |

## URL-Parameter

| Parameter | Bedeutung |
|---|---|
| `?screen=main` | Eigenständiges Haupt-Display-Fenster (Vollbild). |
| `?screen=aux` | Eigenständiges Hilfs-Display-Fenster (Vollbild, passiv, kein eigenes Signaling). |
| `?screen=1` / `?screen=2` | Alternativer Einzelbildschirm-Pfad (siehe `src/components/*.jsx`). |
| kein `?screen=` | Split-Layout: ein Fenster, Haupt- und Hilfs-Display nebeneinander. |
| `?autostart=1` | Überspringt den „Display starten“-Klick (für automatisierten Start über die `.bat`-Skripte). |
| `?debug=1` | Solo-Testmodus: simuliert Zonen/Verweil-Fortschritt/Loopback-Anruf per Tastatur, zeigt ein Testmodus-Badge. |
| `?sim=1` | Simulationsmodus: erzwingt per Tastatur die Präsenz der Gegenseite, zum Testen ohne zweite Person. |
| `?wsport=` | Signaling-Port überschreiben (Test gegen eine zweite Backend-Instanz). |
| `?zone=` / `?facex=` | Erzwingt Zone bzw. Gesichtsposition rein visuell, für Feintuning ohne Kamera. |

Taste `d` blendet im Entwicklungsmodus eine Debug-Statusleiste ein.

## Konfiguration

Die wichtigsten Stellschrauben liegen als benannte Konstanten am Kopf der
jeweiligen Datei, nicht in einer zentralen Config:

- `src/App.jsx` — Timeouts/Karenzzeiten der State Machine (z.B.
  `HANDSHAKE_TIMEOUT_MS`, `READY_RELEASE_MS_IDLE`/`_ACTIVE`,
  `CALL_TIMEOUT_MS`), Split-Layout (`LAYOUT_MODE`, `SPLIT`).
- `src/components/dual/displayBridge.js` — Merged-Display-Feature
  (`MERGED_DISPLAY_ENABLED`, Bezel-/Offset-Kalibrierung).
- `src/components/dual/useProxemicZone.js` — Zonengrenzen und Hysterese der
  proxemischen Zonen.
- `src/hooks/useFaceDetection.js` — Erkennungs-/Verweil-Schwellen (nicht Teil
  dieser Überarbeitung, siehe Kommentare direkt in der Datei).
- `backend/signaling_server.py` — `HEARTBEAT_TIMEOUT_S`, Port (`PORT`-Umgebungsvariable, Default 8765).

## Projektstruktur

```
BA Wael Hammami/
├── .gitignore
├── README.md
├── start_display_labor.bat
├── start_display_kueche.bat
├── start_display.ps1
├── certs/                      (lokal anzulegen, nicht im Repo)
│   ├── cert.pem
│   └── key.pem
├── backend/
│   ├── signaling_server.py
│   ├── requirements.txt
│   └── logs/                   (wird zur Laufzeit angelegt)
│       └── session_log.csv
└── frontend/
    ├── index.html
    ├── package.json
    ├── package-lock.json
    ├── vite.config.js
    ├── public/
    │   ├── models/
    │   └── mediapipe/
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── components/
        │   ├── AmbientDisplay.jsx
        │   ├── HandshakeAnimation.jsx
        │   ├── HandshakeInvitationOverlay.jsx
        │   ├── InvitationScreen.jsx
        │   ├── VideoPortal.jsx
        │   └── dual/
        │       ├── AmbientScene.jsx
        │       ├── AudioWaveScene.jsx
        │       ├── AuxDisplay.jsx
        │       ├── AuxRingScene.jsx
        │       ├── AuxScreenApp.jsx
        │       ├── MainDisplay.jsx
        │       ├── SplitLayout.jsx
        │       ├── StartGate.jsx
        │       ├── displayBridge.js
        │       ├── useProxemicZone.js
        │       └── visualBus.js
        └── hooks/
            ├── useFaceDetection.js
            ├── useSignaling.js
            └── useWebRTC.js
```

## Weiterführende Dokumentation

Die vollständige Bedienungsanleitung steht in **Anhang A der Bachelorarbeit**.

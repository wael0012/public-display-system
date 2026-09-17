/**
 * App.jsx
 *
 * @fileoverview Hauptkomponente des Public Display Systems: orchestriert die
 * State Machine (AMBIENT/DETECTING/HANDSHAKE/ACTIVE, siehe Kommentar bei der
 * State-Machine-Sektion unten), das Signaling (useSignaling), WebRTC
 * (useWebRTC) und die Gesichtserkennung (useFaceDetection) für ein
 * Raum-Display. Verzweigt je nach ?screen=-Parameter entweder in diese
 * Master-Komponente (main / Split-Layout) oder in das passive Hilfs-Fenster
 * (AuxScreenApp.jsx, ?screen=aux). Zentrale Design-Entscheidung: OB ein
 * WebRTC-Anruf beginnt, entscheidet ausschließlich der Signaling-Server
 * (signaling_server.py) — der Client meldet nur seinen eigenen Präsenz-
 * Status und wartet auf eine explizite Anweisung, statt selbst über den
 * Verbindungsaufbau zu raten.
 *
 * @author Wael Hammami
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

import AmbientDisplay    from './components/AmbientDisplay.jsx';
import InvitationScreen  from './components/InvitationScreen.jsx';
import HandshakeAnimation from './components/HandshakeAnimation.jsx';
import HandshakeInvitationOverlay from './components/HandshakeInvitationOverlay.jsx';
import VideoPortal       from './components/VideoPortal.jsx';

import SplitLayout from './components/dual/SplitLayout.jsx';
import MainDisplay from './components/dual/MainDisplay.jsx';
import AuxDisplay  from './components/dual/AuxDisplay.jsx';
import AuxScreenApp, { VISUAL_SYNC_CHANNEL } from './components/dual/AuxScreenApp.jsx';
import StartGate from './components/dual/StartGate.jsx';
import {
  useDisplayBridgeMaster,
  MERGED_DISPLAY_ENABLED,
  BEZEL_COMPENSATION_PX,
  SELF_VIEW_MODE,
  MERGE_OFFSET_PERCENT,
  MERGE_OFFSET_STEP_PERCENT,
  MERGE_OFFSET_MAX_PERCENT,
} from './components/dual/displayBridge.js';
import useProxemicZone from './components/dual/useProxemicZone.js';
import { visualBus } from './components/dual/visualBus.js';

import { useSignaling }     from './hooks/useSignaling.js';
import { useWebRTC }        from './hooks/useWebRTC.js';
import { useFaceDetection } from './hooks/useFaceDetection.js';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

/**
 * WebSocket-URL des Signaling-Servers.
 * Passe dies an die IP-Adresse deines Rechners im LAN an, damit das
 * Mobilgerät den Server erreichen kann.
 * Beispiel: 'ws://192.168.1.42:8765/ws'
 */
// ?wsport= erlaubt Tests gegen eine ZWEITE Backend-Instanz (z. B. 8766),
// ohne das Studien-Backend zu berühren; ohne Parameter unverändert 8765.
//
// &role=...: Der Server zählt und erwartet "ready" NUR von role=main —
// alles andere (aux, ein vergessener Tab auf der nackten URL ohne
// ?screen=, ein künftiger Debug-Modus) wird registriert, aber nie in die
// Anrufsteuerung einbezogen. AuxScreenApp erreicht diesen Code gar nicht
// erst (eigener früher Return in App() vor jedem Hook-Aufruf, s.u.) —
// die Rolle hier ist also
// bei jeder Verbindung, die tatsächlich zustande kommt, praktisch immer
// 'main'. Der explizite String schützt trotzdem strukturell, falls sich
// das je ändert, und macht die Absicht für den Server unmissverständlich.
const SIGNALING_ROLE = getScreenMode() === 'aux' ? 'aux' : 'main';
const SIGNALING_URL =
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}` +
  `:${new URLSearchParams(window.location.search).get('wsport') ?? '8765'}/ws` +
  `?role=${SIGNALING_ROLE}`;

/**
 * Liest den Screen-Modus aus dem ?screen=-URL-Parameter:
 *   'main' → eigenständiges HAUPT-Display-Fenster, VOLLBILD (Master:
 *            Kern-Kette; Partikel-Ambient + Botschaften; ACTIVE: Remote-Video)
 *   'aux'  → eigenständiges HILFS-Display-Fenster, VOLLBILD (passiv: Ring +
 *            Anleitung; ACTIVE: Self-View). Zustand kommt per BroadcastChannel
 *            vom Master — KEIN eigenes Signaling (der Server würde das
 *            Fenster sonst als weiteren Peer zählen)!
 *   1 / 2  → alternativer Pfad (separate Fenster/Rechner)
 *   null   → Split-Layout: EIN Fenster, links Haupt, rechts Hilfs
 *
 * Tolerant gegenüber Groß-/Kleinschreibung und Leerzeichen
 * (?screen=MAIN, ?screen=main%20 → 'main').
 *
 * @returns {'main'|'aux'|number|null}
 */
function getScreenMode() {
  const raw = new URLSearchParams(window.location.search).get('screen');
  if (raw === null) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'main' || normalized === 'aux') return normalized;
  const n = parseInt(normalized, 10);
  return Number.isFinite(n) ? n : null;
}

/** Einmal beim Laden ausgewertet — die URL ändert sich zur Laufzeit nicht. */
const SCREEN_MODE = getScreenMode();
console.info(`[App] Screen-Modus: ${SCREEN_MODE ?? 'split (kein ?screen)'}`);

/**
 * TEST-HELFER (nur visuelle Schicht, für Feintuning ohne Kamera-Person):
 *   ?zone=ambient|awareness|engagement → Zone A/B/C erzwingen
 *   ?facex=-1..1                                → Gesichtsposition erzwingen
 * Beide greifen NICHT in die Kern-Kette ein (Erkennung/Anruf laufen normal).
 */
const ZONE_OVERRIDE = (() => {
  const z = new URLSearchParams(window.location.search).get('zone');
  return ['ambient', 'awareness', 'engagement'].includes(z) ? z : null;
})();
const FACEX_OVERRIDE = (() => {
  const v = parseFloat(new URLSearchParams(window.location.search).get('facex'));
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : null;
})();

/**
 * TEIL D — SOLO-TESTMODUS: NUR über ?debug=1 aktiv. Ohne den Parameter
 * existiert der Modus nicht (keine versehentliche Aktivierung in der
 * Studie). Tasten: 0/1/2/3 Zonen-Stufen, p Verweil-Fortschritt,
 * t Loopback-Anruf, e Anruf beenden, d Debug-HUD.
 */
const DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === '1';

/**
 * Autostart: ?autostart=1 (von den .bat-Skripten gesetzt) überspringt den
 * "Display starten"-Klick — s. ausführliche Begründung im Kopf von
 * StartGate.jsx (Fullscreen/Ton laufen dann über Chrome-Startflags
 * --kiosk/--autoplay-policy, nicht über diesen Parameter). Ohne den
 * Parameter bleibt der manuelle Klick nötig.
 */
const AUTO_START = new URLSearchParams(window.location.search).get('autostart') === '1';

/**
 * Simulationsmodus (zum Testen ohne zweite Person): existiert
 * AUSSCHLIESSLICH bei ?sim=1 in der URL (z.B.
 * https://localhost:5173/?screen=main&sim=1). Die Studienrechner starten
 * über die .bat-Datei OHNE diesen Parameter — der Modus kann während der
 * Studie also nicht versehentlich ausgelöst werden. Ohne sim=1 existiert
 * er nicht: keine Tastenbindung (der Keydown-Effect registriert dann gar
 * keinen Listener), kein Overlay, kein Log-Eintrag.
 *   Taste 1  remotePresent = false erzwingen (Gegenseite leer)
 *   Taste 2  remotePresent = true  erzwingen (Gegenseite besetzt)
 *   Taste 3  Erzwingung aufheben — wieder der echte Wert vom Server
 *   Taste 4  lokale Präsenz simulieren an/aus (der erzwungene Wert wird
 *            NACH der Erkennung angewandt — s. displayState/displayZone
 *            weiter unten; useFaceDetection bleibt unangetastet)
 */
const SIM_MODE = new URLSearchParams(window.location.search).get('sim') === '1';

/** Sim-Hinweis oben links, nur bei sim=1 sichtbar — klein, gedämpft. */
const SIM_BADGE = {
  position:      'fixed',
  top:           '12px',
  left:          '16px',
  zIndex:        10001,
  fontFamily:    "'Courier New', monospace",
  fontSize:      '11px',
  letterSpacing: '1px',
  color:         '#fff',
  opacity:       0.4,
  pointerEvents: 'none',
};

/** "TESTMODUS"-Badge oben rechts — damit der Modus nie unbemerkt in der
 *  Studie aktiv ist. */
const DEBUG_BADGE = {
  position:      'fixed',
  top:           '12px',
  right:         '16px',
  zIndex:        10001,
  padding:       '3px 10px',
  borderRadius:  '12px',
  background:    'rgba(180,40,40,0.35)',
  color:         'rgba(255,200,200,0.85)',
  fontFamily:    "'Courier New', monospace",
  fontSize:      '11px',
  letterSpacing: '2px',
  pointerEvents: 'none',
};

/**
 * Karenzzeit (ms), bevor dem Server ready=false gemeldet wird, nachdem der
 * lokale Zustand HANDSHAKE/ACTIVE verlassen wurde. Toleriert kurze
 * Aussetzer der Gesichtserkennung (z.B. Person dreht kurz den Kopf), ohne
 * dass sofort ein laufender Anruf beendet wird. ready=true wird dagegen
 * IMMER sofort gemeldet (kein Grund, den Start künstlich zu verzögern).
 *
 * Im ACTIVE-Zustand (Anruf läuft) gilt eine DEUTLICH höhere
 * Toleranz als davor — kurzes Bewegen/Kopfdrehen darf den Anruf nicht
 * beenden. Zusätzlich hält die Erkennung selbst die Präsenz im
 * HANDSHAKE/ACTIVE bereits PRESENCE_HOLD_MS_ACTIVE = 25 s ohne Treffer
 * (useFaceDetection.js) — die effektive Toleranz ist also 25 s + 20 s.
 * Der Server reagiert AUSSCHLIESSLICH auf gemeldete presence-Nachrichten
 * (kein eigenes Timeout) — die Client-Karenzzeit wird respektiert.
 */
const READY_RELEASE_MS_IDLE   = 5_000;    // vor dem Anruf (HANDSHAKE verlassen)
const READY_RELEASE_MS_ACTIVE = 20_000;   // im Anruf (ACTIVE verlassen)

/**
 * Countdown-Overlay: Quelle des Werts ist
 * PRESENCE_HOLD_MS_ACTIVE = 25 s in useFaceDetection.js (s. Kommentar
 * direkt oben) — die tatsächliche Frist, die die Erkennung im ACTIVE-
 * Zustand ohne Treffer wartet, bevor onFaceLost unten den Anruf lokal
 * beendet (endCall + AMBIENT). CALL_TIMEOUT_MS dupliziert diesen Wert NUR
 * zur ANZEIGE (Countdown auf dem Main-Display, s. presenceLostAt unten) —
 * der Timeout-Mechanismus selbst bleibt unverändert in useFaceDetection.js
 * (TABU, hier nicht angetastet).
 */
const CALL_TIMEOUT_MS = 25_000;

/**
 * Countdown-Karenz: Kurze Erkennungslücken (Kopfdrehung, Verdeckung,
 * Gegenlicht) sind im laufenden Gespräch normal und werden von der
 * Präsenzlogik intern überbrückt. Der Countdown darf erst starten, wenn
 * die Lücke diese Karenz überschreitet — sonst Fehlalarm mitten im
 * Gespräch. Anzeige ab dann:
 * verbleibend = CALL_TIMEOUT_MS − Lückendauer, d.h. der Countdown steigt
 * bei ~17s ein und bleibt synchron zum echten Abbruch bei 25s.
 */
const COUNTDOWN_GRACE_MS = 8_000;

/**
 * HANDSHAKE-Ausstieg: Der HANDSHAKE-Zustand braucht einen Ausstieg — geht
 * die Person weg, bevor der Server start_call sendet, bliebe die App sonst
 * ewig bei "Verbindung wird aufgebaut …" stehen (Flur-Bewegung hält die
 * Präsenzerkennung am Leben, onFaceLost feuert dann nie).
 *
 *  1. HANDSHAKE_TIMEOUT_MS: kommt binnen 15 s kein Anruf zustande → AMBIENT.
 *  2. WICHTIGER (Zustand folgt der Präsenz): fällt der Verweil-Fortschritt
 *     (dwellProgress) unter HANDSHAKE_ABORT_DWELL, ist die Person real weg
 *     (~2 s nach dem Weggehen, Flur-Bewegung zählt dabei NICHT) → SOFORT
 *     AMBIENT, ohne den Timeout abzuwarten.
 */
const HANDSHAKE_TIMEOUT_MS   = 15_000;
const HANDSHAKE_ABORT_DWELL  = 0.3;

/**
 * TESTMODUS: Auf true setzen, um SOFORT nach dem Signaling-
 * Connect ready=true an den Server zu melden — OHNE Gesichtserkennung.
 * Damit lässt sich die gesamte Anruf-Kette (start_call → Offer/Answer →
 * connected → Video) isoliert verifizieren. Im Testmodus wird zusätzlich:
 *   – bei start_call direkt in den HANDSHAKE-Zustand gewechselt (sonst
 *     würde der Übergang HANDSHAKE→ACTIVE beim Verbindungsaufbau ignoriert,
 *     weil die App ohne Erkennung nie HANDSHAKE erreicht), und
 *   – onFaceLost ignoriert (sonst würde die Erkennung den Testanruf auflegen).
 * NACH DEM TEST WIEDER AUF false STELLEN — auf BEIDEN Geräten!
 */
const FORCE_READY = false;

// ---------------------------------------------------------------------------
// Dual-Display-Layout (Split-Screen für zwei Monitore im Extended-Modus)
// ---------------------------------------------------------------------------
// Unabhängig von SCREEN_MODE (separate Fenster/Rechner). Greift nur, wenn
// kein ?screen=-Parameter gesetzt ist. 'dual' = beide Hälften (Vollbild über
// zwei Monitore), 'single' = nur linke Hälfte, volle Breite (zum Testen auf
// einem einzelnen Monitor).
const LAYOUT_MODE = 'dual'; // 'dual' | 'single'

/** Breite der linken (Haupt-)Hälfte in Prozent. 50 = exakt hälftig. */
const SPLIT = 50;

/**
 * Zulässige Systemzustände.
 * @enum {string}
 */
const STATE = {
  AMBIENT:    'AMBIENT',
  DETECTING:  'DETECTING',
  HANDSHAKE:  'HANDSHAKE',
  ACTIVE:     'ACTIVE',
};

// ---------------------------------------------------------------------------
// App-Komponente
// ---------------------------------------------------------------------------

/**
 * App – Einstieg. Verzweigt VOR jeglichen Hooks in das passive Aux-Fenster
 * (?screen=aux, ohne Kern-Kette) oder in die vollwertige CoreApp.
 * SCREEN_MODE ist eine Modul-Konstante → die Verzweigung ist über die
 * Lebensdauer der App stabil (kein Rules-of-Hooks-Problem).
 *
 * @component
 * @returns {JSX.Element}
 */
export default function App() {
  if (SCREEN_MODE === 'aux') return <AuxScreenApp />;
  return <CoreApp />;
}

/**
 * CoreApp – Hauptkomponente (Master).
 * Orchestriert Zustandsmaschine, Signaling, WebRTC und Gesichtserkennung.
 *
 * @component
 * @returns {JSX.Element}
 */
function CoreApp() {
  // ----------------------------------------------------------------
  // State Machine
  // ----------------------------------------------------------------
  //
  //   ┌──────────┐   Gesicht erkannt    ┌───────────┐   1,5 s stabil    ┌───────────┐
  //   │  AMBIENT │ ──────────────────► │ DETECTING  │ ────────────────► │ HANDSHAKE │
  //   └──────────┘                     └───────────┘                    └───────────┘
  //        ▲                                 │                                │
  //        │       Gesicht verloren          │                    WebRTC OK   │
  //        └─────────────────────────────────┘          ┌──────────┐◄────────┘
  //        │                                            │  ACTIVE  │
  //        └────────────────────── Anruf beendet ───────└──────────┘
  //
  //   AMBIENT    → DETECTING  : useFaceDetection.onFaceDetected
  //   DETECTING  → AMBIENT    : useFaceDetection.onFaceLost
  //   DETECTING  → HANDSHAKE  : useFaceDetection.onFaceStabilized (1,5 s)
  //   HANDSHAKE  → ACTIVE     : useWebRTC.onConnected
  //   ACTIVE     → AMBIENT    : Anruf beendet / Peer getrennt
  //
  // SERVER-DRIVEN CALL STATE: appState beschreibt nur den lokalen Präsenz-
  // Zustand DIESES Standorts. Ob tatsächlich ein WebRTC-Anruf beginnt,
  // entscheidet ausschließlich der Signaling-Server (ConnectionManager.
  // evaluate_call_state() in signaling_server.py) — er kennt als einziger
  // beide Seiten gleichzeitig. Der Client meldet nur seinen eigenen
  // HANDSHAKE-Status per {type:"presence", ready} und wartet auf eine
  // explizite {type:"start_call", role} bzw. {type:"end_call"}-Anweisung.
  const [appState, setAppState] = useState(STATE.AMBIENT);
  /** Ref-Kopie des Zustands für den callRole-Effekt — dort
   *  brauchen wir den Zustand ZUM ZEITPUNKT des start_call, ohne den
   *  Effekt an appState zu koppeln (er soll nur bei Rollen-Wechsel laufen).
   *  Dieser Update-Effekt steht bewusst VOR dem callRole-Effekt und ist
   *  daher beim Commit immer schon aktuell. */
  const appStateRef = useRef(appState);
  useEffect(() => { appStateRef.current = appState; }, [appState]);
  /**
   * Call-Rolle für DIESEN Anruf — ausschließlich vom Server per start_call
   * gesetzt (siehe onSignalingMessage unten). null = kein Anruf zugewiesen.
   * Ersetzt die frühere peerHandshakePresent-Vermutung komplett.
   */
  const [callRole, setCallRole] = useState(null);
  /** ready-Status der jeweils ANDEREN main-Verbindung, vom Server
   *  gespiegelt (remote_presence, s. onSignalingMessage unten).
   *  Rein visuell — beeinflusst die Anrufsteuerung nicht. */
  const [remotePresent, setRemotePresent] = useState(false);
  /** Simulationsmodus (s. SIM_MODE oben), nur bei sim=1 überhaupt änderbar:
   *  null = kein Override (echter remotePresent-Wert gilt), sonst erzwungen. */
  const [simRemotePresentForce, setSimRemotePresentForce] = useState(null);
  /** Simulationsmodus: lokale Präsenz simuliert an/aus, s. SIM_MODE oben. */
  const [simLocalPresence, setSimLocalPresence] = useState(false);
  const [facePromptReady, setFacePromptReady] = useState(false);
  const [faceCount, setFaceCount] = useState(0);
  const [idleContentReady, setIdleContentReady] = useState(false);
  /** Proxemic-Näherungswert (0..1), aus useFaceDetection – siehe AuxDisplay */
  const [proximity, setProximity] = useState(0);
  /** true nach Klick auf "Display starten" — schaltet Audio frei
   *  (Autoplay-Policy) und blendet den Start-Button aus. */
  const [displayStarted, setDisplayStarted] = useState(false);

  /** MERGED DISPLAY: Bezel-Kompensation + Self-View-Modus — zur Laufzeit
   *  im Testmodus justierbar (+/− bzw. Taste v), Startwerte aus
   *  displayBridge.js. Werden per BroadcastChannel ans aux-Fenster gespiegelt. */
  const [bezelPx, setBezelPx]           = useState(BEZEL_COMPENSATION_PX);
  const [selfViewMode, setSelfViewMode] = useState(SELF_VIEW_MODE);
  const [bezelHudVisible, setBezelHudVisible] = useState(false);
  const bezelHudTimerRef = useRef(null);
  /** Horizontaler Bild-Versatz gegen Gesicht-auf-
   *  der-Bezel-Kante — gleiches Muster wie bezelPx (Testmodus ←/→, HUD,
   *  BroadcastChannel an aux). */
  const [mergeOffsetPercent, setMergeOffsetPercent] = useState(MERGE_OFFSET_PERCENT);

  /**
   * Sicherer Zustandsübergang: verhindert ungültige Übergänge.
   * @param {string} from – Erwarteter aktueller Zustand.
   * @param {string} to   – Zielzustand.
   */
  const transition = useCallback((from, to) => {
    setAppState((current) => {
      if (current !== from) {
        console.debug(`[App] Übergang ignoriert: ${current} ≠ ${from} → ${to}`);
        return current;
      }
      console.info(`[App] Zustandsübergang: ${from} → ${to}`);
      return to;
    });
  }, []);

  /**
   * An JEDER Stelle, die nach AMBIENT wechselt (Call-Ende, onFaceLost,
   * abgebrochener Handshake, Handshake-Timeout, WebRTC-Fehler), VOR dem
   * eigentlichen setAppState(AMBIENT) aufrufen. Setzt dwellProgress sofort
   * auf 0 (visualBus + React-State, damit Main UND — über den periodischen
   * Broadcast weiter unten — auch das aux-Fenster den Ring sofort leeren)
   * und übersteuert die ROHE zone aus useFaceDetection (computedZone)
   * kurzzeitig auf 'ambient'. Ohne diesen Override bliebe ein sichtbarer
   * Übergangszustand stehen (Main: Partikel/schwarzer Grund, Aux:
   * Ring/Text), weil computedZone dem State-Wechsel etwas hinterherhinkt.
   * Der Override löst sich von selbst wieder (s. Effects bei
   * computedZone/zone weiter unten) — kein Risiko, spätere echte
   * Zonenwechsel dauerhaft zu maskieren.
   */
  const [ambientZoneOverride, setAmbientZoneOverride] = useState(false);
  const forceAmbientNow = useCallback(() => {
    visualBus.dwellProgress = 0;
    setDwellProgress(0);
    setAmbientZoneOverride(true);
  }, []);

  // ----------------------------------------------------------------
  // Signaling: WebSocket-Verbindung zum Server
  // ----------------------------------------------------------------

  // Refs damit handleSignalingMessage/endCall nicht als Abhängigkeiten von
  // onSignalingMessage benötigt werden (beide stammen aus useWebRTC, das
  // ERST NACH onSignalingMessage aufgerufen wird — ein direkter Verweis
  // wäre eine zirkuläre Abhängigkeit / ReferenceError durch temporal dead
  // zone). Die Refs werden weiter unten per Effect aktuell gehalten.
  const handleSigRef = useRef(null);
  const endCallRef    = useRef(null);
  // logTiming ist erst weiter unten deklariert, wird aber im früher
  // stehenden useWebRTC()-Aufruf (onTiming) gebraucht — Ref-Indirektion
  // wie bei handleSigRef/endCallRef, sonst Temporal-Dead-Zone-Fehler.
  const logTimingRef = useRef(null);

  const onSignalingMessage = useCallback((msg) => {
    // WebRTC-Nachrichten (offer/answer/ice-candidate) an den WebRTC-Hook weiterleiten
    handleSigRef.current?.(msg);

    // start_call: Der SERVER hat entschieden, dass jetzt ein Anruf beginnen
    // soll, und teilt uns unsere Rolle für diesen Anruf explizit mit — wir
    // raten hier nichts mehr selbst (siehe Kopf-Dokumentation dieser Datei).
    if (msg.type === 'start_call') {
      console.info(`[Signaling] start_call EMPFANGEN: role=${msg.role}, peerId=${msg.peerId}`);
      setCallRole(msg.role);
      // Testmodus: Ohne Gesichtserkennung erreicht die App nie HANDSHAKE —
      // hier direkt hinspringen, damit onConnected (HANDSHAKE→ACTIVE) greift
      // und das Video sichtbar wird.
      if (FORCE_READY) {
        setAppState((current) => (current === STATE.ACTIVE ? current : STATE.HANDSHAKE));
      }
    }

    // end_call: Der Server hat entschieden, dass die Voraussetzung für den
    // Anruf nicht mehr gilt (Peer weg oder nicht mehr ready) — sauber
    // beenden und zurück in den Ambient-/Detecting-Zyklus.
    if (msg.type === 'end_call') {
      console.info(`[Signaling] end_call EMPFANGEN (Grund: ${msg.reason ?? 'unbekannt'})`);
      setCallRole(null);
      endCallRef.current?.();
      setFacePromptReady(false);
      forceAmbientNow();
      setAppState((current) => (
        current === STATE.HANDSHAKE || current === STATE.ACTIVE ? STATE.AMBIENT : current
      ));
      // remotePresent wird nur von tatsächlichen remote_presence-
      // Nachrichten gesetzt — beim eigenen end_call hier ausdrücklich
      // zurücksetzen, sonst bliebe der zuletzt empfangene Wert (oft noch
      // true) stehen, bis die Gegenseite ihrerseits (nach ihrer eigenen
      // Karenzzeit) ein neues remote_presence:false sendet — bis dahin
      // rotes Nebelbild trotz leerem anderen Raum. Siehe auch den
      // generischen Reset unten (jeder Wechsel nach AMBIENT).
      setRemotePresent(false);
    }

    // remote_presence: der Server spiegelt hier nur informativ den
    // ready-Status der jeweils ANDEREN main-Verbindung — beeinflusst die
    // Anrufsteuerung (appState, callRole, evaluate_call_state) in keiner
    // Weise, rein visuelle Schicht (Nebelfarbe/Ring/Guide-Text, s.
    // AmbientScene.jsx/AuxRingScene.jsx/AuxDisplay.jsx). Diese Verarbeitung
    // ist unbedingt (kein appState-Gate) und läuft in jedem Zustand inkl.
    // ACTIVE mit.
    if (msg.type === 'remote_presence') {
      const present = !!msg.present;
      console.info('[Signaling] remote_presence:', present);
      setRemotePresent(present);
    }
  }, []);

  const { sendMessage, connectionState } = useSignaling({
    serverUrl: SIGNALING_URL,
    onMessage: onSignalingMessage,
  });

  // ----------------------------------------------------------------
  // WebRTC: P2P-Videoverbindung
  // ----------------------------------------------------------------

  /** Gesichtserkennung ist nur aktiv wenn wir im AMBIENT- oder DETECTING-Zustand sind */
  const faceDetectionEnabled =
    appState === STATE.AMBIENT ||
    appState === STATE.DETECTING ||
    appState === STATE.HANDSHAKE ||
    appState === STATE.ACTIVE;

  const {
    localStream,
    remoteStream,
    startCall,
    endCall,
    handleSignalingMessage,
    prewarmLocalStream,
    cancelPrewarm,
  } = useWebRTC({
    sendSignal: sendMessage,
    role: callRole,
    onConnected: useCallback(() => {
      transition(STATE.HANDSHAKE, STATE.ACTIVE);
      // Studien-Logging: dem Server melden, dass die P2P-Verbindung
      // tatsächlich steht — er schreibt daraus die call_connected-Zeile
      // ins Session-CSV (Zeitdifferenz start_call → call_connected).
      sendMessage({ type: 'call_connected' });
      // Meilenstein auf der Client-Uhr (t_ms seit Laden)
      sendMessage({
        type: 'client_event', event: 'timing_connected',
        extra: `t_ms=${Math.round(performance.now())}`,
      });
    }, [transition, sendMessage]),
    onDisconnected: useCallback(() => {
      setCallRole(null);
      // Wie beim end_call-Handler oben: onDisconnected feuert bei JEDEM
      // endCall()-Aufruf (WebRTC-Hook ruft es intern am Ende von endCall()
      // auf, s. useWebRTC.js), ist also der zentrale Rückkehrpunkt nach
      // AMBIENT für praktisch alle Auflege-Pfade (end_call, onFaceLost,
      // Handshake-Abbruch, Countdown-Timeout unten). remotePresent hier
      // zurückzusetzen deckt sie alle ab.
      setRemotePresent(false);
      forceAmbientNow();
      setAppState(STATE.AMBIENT);
    }, [forceAmbientNow]),
    // Verbindungsstatistik (alle 5 s) → Server-CSV (Videoqualität im LAN)
    onStats: useCallback((stats) => {
      sendMessage({ type: 'call_stats', stats });
    }, [sendMessage]),
    // Offer/Answer-Meilensteine der Zeitkette
    onTiming: useCallback((event) => {
      logTimingRef.current?.(`timing_${event}`);
    }, []),
  });

  // handleSignalingMessage-/endCall-Ref aktuell halten
  useEffect(() => {
    handleSigRef.current = handleSignalingMessage;
  }, [handleSignalingMessage]);

  useEffect(() => {
    endCallRef.current = endCall;
  }, [endCall]);

  // ----------------------------------------------------------------
  // Kamera-Vorwärmen: HANDSHAKE ist das stärkste verfügbare Signal für
  // einen unmittelbar bevorstehenden Anruf (Verweilen ist abgeschlossen).
  // cancelPrewarm() läuft bei JEDEM Verlassen von HANDSHAKE — auch im
  // Erfolgsfall ACTIVE (dort ein harmloses No-Op, der Stream wurde bereits
  // von acquireLocalStream konsumiert) UND bei jedem Abbruch (Timeout,
  // Präsenzverlust, Abbruch-Race) — deckt so ALLE Ausstiege ab, ohne jeden
  // einzelnen Abbruch-Pfad separat verdrahten zu müssen.
  // ----------------------------------------------------------------
  useEffect(() => {
    if (appState === STATE.HANDSHAKE) {
      prewarmLocalStream();
    } else {
      cancelPrewarm();
    }
  }, [appState, prewarmLocalStream, cancelPrewarm]);

  // ----------------------------------------------------------------
  // Anruf starten, sobald der Server per start_call die Rolle zuweist
  // ----------------------------------------------------------------
  //
  // Reihenfolge-Garantie: useWebRTC() wurde WEITER OBEN
  // aufgerufen und registriert dabei intern einen Effect, der roleRef.current
  // aktuell hält (useWebRTC.js: useEffect(() => { roleRef.current = role },
  // [role])). React führt Effects INNERHALB einer Komponente in der
  // Reihenfolge aus, in der sie deklariert wurden. Da dieser Effect HIER
  // textuell NACH dem useWebRTC()-Aufruf steht, ist roleRef in useWebRTC
  // bereits auf dem neuen Wert, wenn startCall() unten läuft — kein
  // Race-Condition-Risiko, ohne dass wir dafür einen setTimeout o.ä. brauchen.
  const callStartedRef = useRef(false);

  useEffect(() => {
    if (callRole === 'caller' && !callStartedRef.current) {
      // Race zwischen Abbruch und start_call: War der HANDSHAKE lokal
      // bereits abgebrochen (Timeout/Präsenzverlust), als das start_call
      // eintraf, wird KEIN Anruf mehr gestartet. Unser ready=false ist zu
      // diesem Zeitpunkt schon zum Server unterwegs — er beendet den
      // halb gestarteten Anruf ohnehin; wir bauen dann gar nicht erst
      // eine unsichtbare Verbindung auf. FORCE_READY (Testmodus ohne
      // Erkennung) bleibt ausgenommen.
      if (appStateRef.current !== STATE.HANDSHAKE && !FORCE_READY) {
        console.warn(
          `[App] start_call ignoriert: lokaler Zustand ist ${appStateRef.current}, `
          + 'nicht HANDSHAKE (Abbruch-Race) — warte auf end_call des Servers',
        );
        setCallRole(null);
        return;
      }
      callStartedRef.current = true;
      console.info('[App] start_call: Rolle=caller → initiiere WebRTC-Anruf');
      startCall().catch((err) => {
        console.error('[App] Fehler beim Starten des Anrufs:', err);
        callStartedRef.current = false;
        setCallRole(null);
        forceAmbientNow();
        setAppState(STATE.AMBIENT);
      });
    } else if (callRole === 'callee') {
      // Symmetrisch für den Callee: Rolle verwerfen → useWebRTC
      // ignoriert das eintreffende Offer (roleRef ist dann null).
      if (appStateRef.current !== STATE.HANDSHAKE && !FORCE_READY) {
        console.warn(
          `[App] start_call (callee) ignoriert: lokaler Zustand ist ${appStateRef.current}, `
          + 'nicht HANDSHAKE (Abbruch-Race)',
        );
        setCallRole(null);
        return;
      }
      console.info('[App] start_call: Rolle=callee → warte auf Offer');
    } else if (callRole === null) {
      callStartedRef.current = false;
    }
  }, [callRole, startCall]);

  // ----------------------------------------------------------------
  // Presence: eigenen HANDSHAKE/ACTIVE-Zustand an den Server melden
  // ----------------------------------------------------------------
  //
  // Der Server entscheidet anhand dieses ready-Flags (von BEIDEN Seiten),
  // wann ein Anruf beginnt/endet (evaluate_call_state im Backend). Wir
  // raten selbst nichts über den Peer-Zustand mehr.
  //
  // Karenzzeit: ready=true wird SOFORT gemeldet. ready=false
  // wird erst nach READY_RELEASE_MS gemeldet — toleriert kurze Aussetzer
  // der Gesichtserkennung (z.B. Person dreht kurz den Kopf), ohne dass ein
  // laufender Anruf sofort beendet wird. Kehrt appState innerhalb der
  // Karenzzeit zu HANDSHAKE/ACTIVE zurück, wird der Timer verworfen und
  // NIE ready=false gesendet — aus Sicht des Servers war die Person nie weg.
  const readyReleaseTimerRef = useRef(null);
  /** A3: Merkt sich den letzten ready-Zustand (HANDSHAKE oder ACTIVE) —
   *  daraus ergibt sich, ob die kurze (IDLE) oder lange (ACTIVE)
   *  Karenzzeit gilt, wenn der Zustand verlassen wird. */
  const lastReadyStateRef = useRef(null);

  useEffect(() => {
    if (connectionState !== 'connected') return;

    // Testmodus: sofort und dauerhaft ready=true melden —
    // unabhängig von der Gesichtserkennung. Der Server startet den Anruf,
    // sobald BEIDE Seiten so verbunden sind.
    if (FORCE_READY) {
      clearTimeout(readyReleaseTimerRef.current);
      readyReleaseTimerRef.current = null;
      console.info('[Signaling] presence GESENDET (FORCE_READY-Testmodus): ready= true');
      sendMessage({ type: 'presence', ready: true });
      return;
    }

    const isReady = appState === STATE.HANDSHAKE || appState === STATE.ACTIVE;

    if (isReady) {
      lastReadyStateRef.current = appState;   // A3: für die Karenzzeit-Wahl
      clearTimeout(readyReleaseTimerRef.current);
      readyReleaseTimerRef.current = null;
      console.info('[Signaling] presence GESENDET: ready= true');
      sendMessage({ type: 'presence', ready: true });
      return;
    }

    if (!readyReleaseTimerRef.current) {
      // A3: Nach einem LAUFENDEN Anruf (ACTIVE) gilt die lange Karenzzeit —
      // kurze Bewegung/Aussetzer beenden den Anruf nicht. Vor dem Anruf
      // (nur HANDSHAKE verlassen) reicht die kurze.
      const releaseMs = lastReadyStateRef.current === STATE.ACTIVE
        ? READY_RELEASE_MS_ACTIVE
        : READY_RELEASE_MS_IDLE;
      readyReleaseTimerRef.current = setTimeout(() => {
        readyReleaseTimerRef.current = null;
        console.info(`[Signaling] presence GESENDET (nach ${releaseMs} ms Karenzzeit): ready= false`);
        sendMessage({ type: 'presence', ready: false });
      }, releaseMs);
    }
  }, [appState, connectionState, sendMessage]);

  // Karenz-Timer beim Unmounten aufräumen
  useEffect(() => () => clearTimeout(readyReleaseTimerRef.current), []);

  useEffect(() => {
    if (appState !== STATE.AMBIENT) {
      setIdleContentReady(false);
      return undefined;
    }

    const timer = setTimeout(() => {
      setIdleContentReady(true);
    }, 30_000);

    return () => clearTimeout(timer);
  }, [appState]);

  useEffect(() => {
    if (appState === STATE.AMBIENT && faceCount > 0) {
      setIdleContentReady(false);
      setFacePromptReady(true);
      transition(STATE.AMBIENT, STATE.DETECTING);
    }
  }, [appState, faceCount, transition]);

  // ----------------------------------------------------------------
  // Gesichtserkennung: Callbacks für State Machine
  // ----------------------------------------------------------------

  const onFaceDetected = useCallback(() => {
    setFacePromptReady(true);
    setIdleContentReady(false);
    transition(STATE.AMBIENT, STATE.DETECTING);
  }, [transition]);

  const onFacePromptReady = useCallback(() => {
    setFacePromptReady(true);
  }, []);

  const onFaceStabilized = useCallback(() => {
    setFacePromptReady(false);
    transition(STATE.DETECTING, STATE.HANDSHAKE);
  }, [transition]);

  const onFaceLost = useCallback(() => {
    // Testmodus: Erkennungs-Aussetzer dürfen den Testanruf nicht auflegen
    if (FORCE_READY) return;
    setFacePromptReady(false);
    setFaceCount(0);
    forceAmbientNow();
    transition(STATE.DETECTING, STATE.AMBIENT);
    if (appState === STATE.ACTIVE || appState === STATE.HANDSHAKE) {
      // Lokales Sicherheitsnetz: Person ist (nach bereits 10 s Grace-Period
      // in useFaceDetection) wirklich weg → sofort lokal auflegen, statt auf
      // den Server-Roundtrip (ready=false → end_call) zu warten. callRole
      // MUSS hier mit zurückgesetzt werden, sonst würde ein späterer
      // erneuter start_call mit DERSELBEN Rolle vom callRole-Effect
      // stillschweigend ignoriert (React re-rendert nicht bei identischem
      // Primitivwert, callStartedRef bliebe fälschlich auf true stehen).
      endCall();
      setCallRole(null);
      setAppState(STATE.AMBIENT);
      // PROBLEM 2 (Labortest): Das Auflegen wegen Abwesenheit ist eine
      // FINALE Entscheidung (25 s ohne Gesicht/Pose sind vergangen) — dem
      // Server SOFORT ready=false melden statt weitere 20 s Karenz: er
      // sendet dann end_call an BEIDE Seiten (in evaluate_call_state
      // verifiziert) und setzt call_active zurück → der nächste Anruf-
      // Zyklus kann sauber und ohne Umweg starten. + Studien-CSV.
      clearTimeout(readyReleaseTimerRef.current);
      readyReleaseTimerRef.current = null;
      sendMessage({ type: 'presence', ready: false });
      sendMessage({ type: 'client_event', event: 'call_ended_no_presence' });
    }
  }, [appState, endCall, transition, sendMessage, forceAmbientNow]);

  const handleFaceCountChange = useCallback((count) => {
    setFaceCount(count);
    if (count > 0) {
      setIdleContentReady(false);
      setFacePromptReady(true);
      setAppState((current) => (
        current === STATE.AMBIENT ? STATE.DETECTING : current
      ));
    }
  }, []);

  /**
   * Countdown-Overlay: Zeitpunkt, seit dem im ACTIVE-
   * Zustand kein Gesicht mehr gemeldet wird (faceCount 0) — vorhandenes
   * Präsenz-Signal (s. handleFaceCountChange oben), keine neue Erkennungs-
   * logik. null = Präsenz da oder kein Anruf; setzt SOFORT zurück, sobald
   * ein Gesicht wieder gemeldet wird oder ACTIVE verlassen wird (s. Regel
   * "verschwindet sofort" am Countdown-Overlay in MainDisplay.jsx).
   */
  const [presenceLostAt, setPresenceLostAt] = useState(null);
  const gapStartRef = useRef(null);
  useEffect(() => {
    if (appState !== STATE.ACTIVE || faceCount > 0) {
      gapStartRef.current = null;
      setPresenceLostAt(null);
      return;
    }
    const gapStart = gapStartRef.current ?? Date.now();
    gapStartRef.current = gapStart;
    const remaining = COUNTDOWN_GRACE_MS - (Date.now() - gapStart);
    if (remaining <= 0) {
      setPresenceLostAt(gapStart);
      return;
    }
    const timer = setTimeout(() => setPresenceLostAt(gapStart), remaining);
    return () => clearTimeout(timer);
  }, [appState, faceCount]);

  // Der angezeigte Countdown (oben, presenceLostAt + CALL_TIMEOUT_MS) und
  // das tatsächliche Auflegen laufen an zwei unabhängigen Zeitbasen: die
  // Anzeige rein lokal hier in App.jsx, das eigentliche Auflegen sonst nur
  // über useFaceDetection.onFaceLost (eigene interne Presence-Hold-Logik,
  // ebenfalls mit 25s bemessen, aber mit eigenem, ggf. abweichendem
  // Startzeitpunkt, z.B. durch Pose-/Motion-Anker, die eine Abwesenheit
  // später erkennen als die reine Gesichtserkennung). Ohne einen eigenen
  // Timeout hier liefe der Countdown auf 0, AMBIENT käme aber erst, sobald
  // das (später feuernde) onFaceLost der Erkennung eintrifft.
  // Deshalb: ein eigener, autoritativer Timeout auf genau derselben
  // Zeitbasis wie die Anzeige (presenceLostAt + CALL_TIMEOUT_MS) — läutet
  // sofort beim Erreichen von 0 selbst das Ende ein, unabhängig davon,
  // ob/wann useFaceDetection.onFaceLost intern feuert. endCall() löst über
  // onDisconnected (s. useWebRTC-Aufruf oben) automatisch appState→AMBIENT
  // und den remotePresent-Reset aus.
  useEffect(() => {
    if (presenceLostAt == null) return undefined;
    const fireIn = CALL_TIMEOUT_MS - (Date.now() - presenceLostAt);
    const hangUp = () => {
      console.info('[App] Countdown abgelaufen (0s) → Anruf wird sofort lokal beendet');
      endCall();
      setCallRole(null);
      clearTimeout(readyReleaseTimerRef.current);
      readyReleaseTimerRef.current = null;
      sendMessage({ type: 'presence', ready: false });
      sendMessage({ type: 'client_event', event: 'call_ended_countdown_timeout' });
    };
    if (fireIn <= 0) { hangUp(); return undefined; }
    const t = setTimeout(hangUp, fireIn);
    return () => clearTimeout(t);
  }, [presenceLostAt, endCall, sendMessage]);

  // Zentraler, robuster Fallback — bei JEDEM Wechsel nach AMBIENT
  // (unabhängig vom auslösenden Pfad) wird
  // remotePresent zurückgesetzt, so dass nie ein veralteter true-Wert das
  // rote Nebelbild zeigt. Ein danach eintreffendes echtes remote_presence
  // (s. Handler oben, in JEDEM Zustand verarbeitet) überschreibt den Wert
  // sofort wieder korrekt.
  useEffect(() => {
    if (appState === STATE.AMBIENT) setRemotePresent(false);
  }, [appState]);

  const onProximityChange = useCallback((value) => {
    visualBus.proximity = value;   // Kopie für die visuelle Schicht (rAF-Loop)
    setProximity(value);
  }, []);

  /**
   * faceX (-1..1, horizontale Gesichtsposition) — proxemische Positions-
   * Reaktion. HOCHFREQUENT und rein visuell: läuft bewusst am React-State
   * vorbei über visualBus (siehe visualBus.js), damit nicht der gesamte
   * Baum ~8×/s re-rendert. AmbientScene liest den Wert direkt in seiner
   * Animationsschleife.
   */
  const onFaceXChange = useCallback((value) => {
    if (FACEX_OVERRIDE !== null) return;   // Test-Helfer ?facex= hat Vorrang
    visualBus.faceX = value;
  }, []);

  /**
   * TEIL A3 (Feedforward): Verweil-Fortschritt 0..1 aus der Erkennung.
   * Der Aux-Ring füllt sich damit — die Person SIEHT, dass ihr Verweilen
   * etwas bewirkt, BEVOR der Anruf startet. debugDwellUntilRef: solange
   * der Solo-Testmodus (Taste "p") den Wert animiert, hat er Vorrang.
   */
  const debugDwellUntilRef = useRef(0);
  const [dwellProgress, setDwellProgress] = useState(0);
  const onDwellProgress = useCallback((value) => {
    if (Date.now() < debugDwellUntilRef.current) return;
    visualBus.dwellProgress = value;
    setDwellProgress(value);
  }, []);

  /** Kamera-Ereignisse (lost/recovered/ready) ins Studien-CSV — immer mit
   *  t_ms seit Seitenladen (gemeinsame Zeitachse). */
  const onCameraEvent = useCallback((event) => {
    console.info(`[Kamera] ${event}`);
    sendMessage({
      type: 'client_event', event,
      extra: `t_ms=${Math.round(performance.now())}`,
    });
  }, [sendMessage]);

  // ----------------------------------------------------------------
  // Meilensteine des Verbindungsaufbaus ins CSV (Zeitachse).
  // Alle t_ms beziehen sich auf das Seitenladen DIESES Clients (gleiche
  // Uhr → Differenzen direkt auswertbar):
  //   timing_ws_connected   – Signaling steht (einmalig)
  //   timing_camera_ready   – Kamera + Erkennung bereit (via onCameraEvent)
  //   timing_dwell_complete – Verweilen abgeschlossen (pro Anruf-Zyklus)
  //   timing_start_call     – start_call empfangen (pro Anruf-Zyklus)
  //   timing_connected      – P2P-Verbindung steht (pro Anruf-Zyklus)
  // ----------------------------------------------------------------
  const timingOnceRef = useRef({});
  const logTiming = useCallback((event, once = false) => {
    if (once) {
      if (timingOnceRef.current[event]) return;
      timingOnceRef.current[event] = true;
    }
    sendMessage({
      type: 'client_event', event,
      extra: `t_ms=${Math.round(performance.now())}`,
    });
  }, [sendMessage]);
  useEffect(() => { logTimingRef.current = logTiming; }, [logTiming]);

  useEffect(() => {
    if (connectionState === 'connected') logTiming('timing_ws_connected', true);
  }, [connectionState, logTiming]);

  useEffect(() => {
    // HANDSHAKE-Eintritt = Verweilen abgeschlossen (dwellProgress hat 1.0
    // erreicht) — pro Zyklus eine Zeile
    if (appState === STATE.HANDSHAKE) logTiming('timing_dwell_complete');
  }, [appState, logTiming]);

  // presence ready=true als EIGENER Meilenstein —
  // spiegelt exakt den sendMessage-Aufruf im presence-Effekt oben (gleiche
  // Bedingung), damit die Zeitkette lückenlos ist (dwell_complete kann vor
  // connectionState 'connected' liegen; ready wird erst danach gesendet).
  useEffect(() => {
    if (appState === STATE.HANDSHAKE && connectionState === 'connected') {
      logTiming('timing_presence_ready');
    }
  }, [appState, connectionState, logTiming]);

  useEffect(() => {
    if (callRole !== null) logTiming('timing_start_call');
  }, [callRole, logTiming]);

  // Test-Helfer: erzwungene Gesichtsposition einmalig setzen
  useEffect(() => {
    if (FACEX_OVERRIDE !== null) visualBus.faceX = FACEX_OVERRIDE;
  }, []);

  const { debugInfo: faceDebug, resetDwell } = useFaceDetection({
    onFaceDetected,
    onFaceStabilized,
    onFacePromptReady,
    onTwoFacesStabilized: onFaceStabilized,
    onFaceLost,
    onFaceCountChange: handleFaceCountChange,
    onProximityChange,
    onFaceXChange,
    onDwellProgress,
    onCameraEvent,
    enabled: faceDetectionEnabled,
    appState,   // nur für den 2-s-Status-Log in useFaceDetection
  });

  // ----------------------------------------------------------------
  // AUDIENCE FUNNEL (Müller et al. 2010): proxemische Zone aus proximity
  // (Hysterese ±0.05, 500 ms stabil — siehe useProxemicZone.js). Rein
  // visuelle Schicht: steuert Partikel, Botschaften und Ring, greift NICHT
  // in die State Machine oder Anruf-Logik ein.
  // ----------------------------------------------------------------
  const computedZone = useProxemicZone(proximity, appState);
  const zone = ZONE_OVERRIDE ?? computedZone;   // Test-Helfer ?zone=

  // ambientZoneOverride (s. forceAmbientNow oben) löst sich von selbst
  // wieder: entweder sobald die ROHE Zone tatsächlich 'ambient' bestätigt,
  // oder sobald ein neuer Zyklus beginnt (appState verlässt AMBIENT
  // wieder) — kein Risiko, spätere echte Zonenwechsel zu maskieren.
  useEffect(() => {
    if (ambientZoneOverride && computedZone === 'ambient') setAmbientZoneOverride(false);
  }, [computedZone, ambientZoneOverride]);
  useEffect(() => {
    if (ambientZoneOverride && appState !== STATE.AMBIENT) setAmbientZoneOverride(false);
  }, [appState, ambientZoneOverride]);

  // ----------------------------------------------------------------
  // HANDSHAKE-Ausstieg (siehe Konstanten oben): sauber zurück
  // nach AMBIENT — ready=false sofort melden (Server beendet ggf. die
  // angelaufene Aushandlung), Verweildauer zurücksetzen (Ring leert
  // sich, nächster Versuch erst nach erneutem Verweilen), Ereignis ins
  // Studien-CSV. Der Fade zurück ins Ambient läuft über die bestehenden
  // sanften Übergänge (Botschaften-Crossfade, Zonen-Lerp der Szenen).
  // ----------------------------------------------------------------
  const abortHandshake = useCallback((reasonEvent) => {
    console.warn(`[App] HANDSHAKE abgebrochen (${reasonEvent}) → zurück zu AMBIENT`);
    // endCall ist idempotent: räumt eine ggf. schon angelaufene
    // WebRTC-Aushandlung ab, tut ohne Verbindung nichts
    endCall();
    setCallRole(null);
    clearTimeout(readyReleaseTimerRef.current);
    readyReleaseTimerRef.current = null;
    sendMessage({ type: 'presence', ready: false });
    sendMessage({ type: 'client_event', event: reasonEvent });
    resetDwell();
    forceAmbientNow();
    setAppState(STATE.AMBIENT);
  }, [endCall, sendMessage, resetDwell, forceAmbientNow]);

  // Ausstieg 1 — Timeout: 15 s im HANDSHAKE ohne zustande gekommenen Anruf.
  // (Deckt auch eine hängende Aushandlung ab: normal verbindet WebRTC im
  // LAN in < 5 s; nach 15 s ist Abbrechen die richtige Entscheidung —
  // der Server beendet über ready=false die Gegenseite sauber.)
  useEffect(() => {
    if (appState !== STATE.HANDSHAKE || FORCE_READY) return undefined;
    const t = setTimeout(() => abortHandshake('handshake_timeout'), HANDSHAKE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [appState, abortHandshake]);

  // Ausstieg 2 — Präsenz verloren: der Zustand folgt der TATSÄCHLICHEN
  // Präsenz. dwellProgress fällt ~2 s nach dem Weggehen auf 0 (Trefferquote
  // unter DWELL_RESET_RATIO); kurzes Kopfdrehen friert ihn nur ein und
  // löst hier nichts aus. Gilt NUR im HANDSHAKE — im ACTIVE bleiben die
  // großzügigen Toleranzen (25 s + 20 s) unverändert.
  useEffect(() => {
    if (appState !== STATE.HANDSHAKE || FORCE_READY) return undefined;
    // NUR solange der Server den Anruf noch nicht gestartet hat (callRole
    // null — das war der gemeldete Bug: "Person geht weg, BEVOR ein Anruf
    // zustande kommt"). Sobald start_call da ist, übernehmen die
    // etablierten Anruf-Toleranzen (PRESENCE_HOLD 25 s) und der
    // 15-s-Timeout oben als Sicherheitsnetz — sonst würde ein kurzes
    // Wegdrehen (>2 s) den bereits angelaufenen Verbindungsaufbau killen.
    if (callRole !== null) return undefined;
    if (dwellProgress < HANDSHAKE_ABORT_DWELL) {
      abortHandshake('handshake_aborted_presence_lost');
    }
    return undefined;
  }, [appState, dwellProgress, callRole, abortHandshake]);

  // ----------------------------------------------------------------
  // TEIL D — SOLO-TESTMODUS (?debug=1): simuliert Zonen-Stufen, Verweil-
  // Fortschritt und einen Loopback-"Anruf" — ausschließlich auf der
  // ANZEIGE-Ebene (display*-Werte unten). Die echte State Machine, das
  // Signaling und WebRTC laufen unverändert weiter.
  // ----------------------------------------------------------------
  const [debugStage, setDebugStage]       = useState(null);   // {state, zone} | null
  const [debugLoopback, setDebugLoopback] = useState(null);   // 'pending' | {stream} | null
  const debugLoopbackRef = useRef(null);
  useEffect(() => { debugLoopbackRef.current = debugLoopback; }, [debugLoopback]);

  useEffect(() => {
    if (!DEBUG_MODE) return undefined;
    const STAGES = {
      0: null,                                            // leerer Raum
      1: { state: STATE.DETECTING, zone: 'ambient' },     // jemand im Raum, fern
      2: { state: STATE.DETECTING, zone: 'awareness' },   // nähert sich
      3: { state: STATE.DETECTING, zone: 'engagement' },  // direkt davor
    };
    const onKey = async (e) => {
      const k = e.key;
      if (k in STAGES) { setDebugStage(STAGES[k]); return; }

      if (k === 'p' || k === 'P') {
        // Verweil-Fortschritt 0→1 über ~3 s animieren (Ring-Check);
        // debugDwellUntilRef blockiert solange die echten Erkennungswerte
        debugDwellUntilRef.current = Date.now() + 8_000;
        const start = performance.now();
        const id = setInterval(() => {
          const v = Math.min(1, (performance.now() - start) / 3_000);
          visualBus.dwellProgress = v;
          setDwellProgress(v);
          if (v >= 1) clearInterval(id);
        }, 60);
      }

      if (k === 't' || k === 'T') {
        // Loopback-"Anruf": erst HANDSHAKE-Anzeige, dann der EIGENE
        // Kamerastream als "Remote" (ohne Audio → keine Rückkopplung)
        if (debugLoopbackRef.current) return;
        setDebugStage(null);
        setDebugLoopback('pending');
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true, audio: false,
          });
          setTimeout(() => setDebugLoopback({ stream }), 1_500);
        } catch (err) {
          console.warn('[Testmodus] Loopback-Kamera fehlgeschlagen:', err?.name ?? err);
          setDebugLoopback(null);
        }
      }

      if (k === 'e' || k === 'E') {
        // Loopback beenden → zurück zum echten Zustand (danach ist ein
        // neuer Anruf/Loopback sofort möglich)
        const lb = debugLoopbackRef.current;
        if (lb && lb !== 'pending') lb.stream?.getTracks().forEach((t) => t.stop());
        setDebugLoopback(null);
        debugDwellUntilRef.current = 0;
        visualBus.dwellProgress = 0;
        setDwellProgress(0);
      }

      // MERGED DISPLAY: Bezel-Kompensation live justieren (+/− in 5er-
      // Schritten, Wert wird dezent eingeblendet zum Ablesen/Notieren)
      if (k === '+' || k === '=' || k === '-' || k === '_') {
        const delta = (k === '+' || k === '=') ? 5 : -5;
        setBezelPx((v) => Math.max(0, v + delta));
        setBezelHudVisible(true);
        clearTimeout(bezelHudTimerRef.current);
        bezelHudTimerRef.current = setTimeout(() => setBezelHudVisible(false), 2_500);
      }

      // Self-View-Modus umschalten: 'corner' (Merged) ↔ 'full' (bisher)
      if (k === 'v' || k === 'V') {
        setSelfViewMode((m) => (m === 'corner' ? 'full' : 'corner'));
      }

      // Bild-Versatz live justieren (←/→, ±0.5 Prozentpunkte)
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const delta = k === 'ArrowRight' ? MERGE_OFFSET_STEP_PERCENT : -MERGE_OFFSET_STEP_PERCENT;
        setMergeOffsetPercent((v) => Math.max(
          -MERGE_OFFSET_MAX_PERCENT, Math.min(MERGE_OFFSET_MAX_PERCENT, v + delta),
        ));
        setBezelHudVisible(true);
        clearTimeout(bezelHudTimerRef.current);
        bezelHudTimerRef.current = setTimeout(() => setBezelHudVisible(false), 2_500);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Simulationsmodus (s. SIM_MODE oben): NUR bei ?sim=1 wird überhaupt ein
  // Listener registriert — ohne den Parameter läuft dieser Effect als reines
  // No-Op (sofortiges return undefined), es existiert also buchstäblich kein
  // Codepfad, der eine Taste abfängt.
  useEffect(() => {
    if (!SIM_MODE) return undefined;
    const onKey = (e) => {
      if (e.key === '1') {
        setSimRemotePresentForce(false);
        console.info('[Sim] remotePresent erzwungen: false (Gegenseite leer)');
      } else if (e.key === '2') {
        setSimRemotePresentForce(true);
        console.info('[Sim] remotePresent erzwungen: true (Gegenseite besetzt)');
      } else if (e.key === '3') {
        setSimRemotePresentForce(null);
        console.info('[Sim] remotePresent-Erzwingung aufgehoben — echter Wert vom Server gilt wieder');
      } else if (e.key === '4') {
        setSimLocalPresence((v) => {
          const next = !v;
          console.info('[Sim] lokale Präsenz simuliert:', next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Anzeige-Werte: Testmodus-Overrides haben Vorrang — NUR Darstellung.
  // simLocalPresence (Taste 4, NUR bei sim=1 änderbar) wirkt NACH der
  // echten Erkennung — useFaceDetection/appState/zone bleiben unangetastet,
  // nur was hier gerendert/gesendet wird, tut so, als wäre appState/zone
  // bereits auf "jemand erkannt" gesprungen.
  const displayState = debugLoopback
    ? (debugLoopback === 'pending' ? STATE.HANDSHAKE : STATE.ACTIVE)
    : simLocalPresence ? STATE.DETECTING
    : (debugStage?.state ?? appState);
  const displayZone = debugLoopback
    ? 'engagement'
    : simLocalPresence ? 'awareness'
    : (debugStage?.zone ?? (ambientZoneOverride ? 'ambient' : zone));
  const displayRemoteStream =
    (debugLoopback && debugLoopback !== 'pending') ? debugLoopback.stream : remoteStream;

  // Simulationsmodus (Tasten 1–3, NUR bei sim=1 änderbar): überschreibt den
  // echten remotePresent-Wert, solange simRemotePresentForce gesetzt ist —
  // fließt in ALLE Stellen, die remotePresent unten verwenden (Props an
  // MainDisplay/AuxDisplay UND der visualBus-Payload für das aux-Fenster).
  const effectiveRemotePresent =
    simRemotePresentForce !== null ? simRemotePresentForce : remotePresent;

  // ----------------------------------------------------------------
  // MERGED DISPLAY: permanente lokale Brücke main → aux (displayBridge.js).
  // Speist displayRemoteStream ein — damit funktioniert auch der Solo-
  // Loopback (Taste t) über beide Bildschirme. Der Anruf selbst hängt in
  // KEINER Weise an dieser Brücke (Fallback statt Fehler).
  // ----------------------------------------------------------------
  const { bridgeConnected, viewerOk } = useDisplayBridgeMaster({
    enabled: MERGED_DISPLAY_ENABLED && SCREEN_MODE === 'main',
    stream: displayRemoteStream,
  });

  /** Merged nur wenn: Feature an, Two-Window-Master, Brücke steht, aux
   *  bestätigt Frames, Self-View-Modus 'corner' ('full' = altes Verhalten). */
  const mergedActive =
    MERGED_DISPLAY_ENABLED &&
    SCREEN_MODE === 'main' &&
    bridgeConnected &&
    viewerOk &&
    selfViewMode === 'corner';

  // Studien-CSV: merged_display_active / merged_display_fallback (mit Grund)
  // — einmal beim ACTIVE-Eintritt und bei jedem Umschalten während des Anrufs
  useEffect(() => {
    if (displayState !== STATE.ACTIVE) return;
    if (SCREEN_MODE !== 'main' || !MERGED_DISPLAY_ENABLED) return;
    if (mergedActive) {
      sendMessage({ type: 'client_event', event: 'merged_display_active' });
    } else {
      const reason = !bridgeConnected ? 'bridge_not_connected'
        : !viewerOk ? 'viewer_no_frames'
        : 'self_view_mode_full';
      sendMessage({ type: 'client_event', event: 'merged_display_fallback', extra: reason });
    }
  }, [displayState, mergedActive, bridgeConnected, viewerOk, sendMessage]);

  // ----------------------------------------------------------------
  // Two-Window-Sync (?screen=main): Zustand/Zone/Proximity/faceX an das
  // passive aux-Fenster senden (BroadcastChannel, ~6×/s). Rein visuelle
  // Schicht — das aux-Fenster greift nirgends in die Kern-Kette ein.
  // ----------------------------------------------------------------
  // display*-Werte statt Rohwerte: so spiegelt das aux-Fenster auch die
  // Simulationen des Solo-Testmodus korrekt wider.
  const visualSnapRef = useRef({ state: displayState, zone: displayZone, proximity });
  useEffect(() => {
    visualSnapRef.current = {
      state:           displayState,
      zone:            displayZone,
      proximity,
      faceDetected:    displayState !== STATE.AMBIENT,
      callRole,
      remoteConnected: displayRemoteStream != null,
      merged:          mergedActive,
      bezelPx,
      selfViewMode,
      mergeOffsetPercent,
      remotePresent: effectiveRemotePresent,   // remote_presence + Sim-Override
    };
  }, [displayState, displayZone, proximity, callRole, displayRemoteStream,
      mergedActive, bezelPx, selfViewMode, mergeOffsetPercent, effectiveRemotePresent]);

  useEffect(() => {
    if (SCREEN_MODE !== 'main') return undefined;
    let channel = null;
    try {
      channel = new BroadcastChannel(VISUAL_SYNC_CHANNEL);
    } catch (err) {
      console.error('[App] BroadcastChannel nicht verfügbar (aux-Sync aus):', err);
      return undefined;
    }
    const buildVisualPayload = () => {
      const s = visualSnapRef.current;
      return {
        type:            'visual',
        state:           s.state,
        appState:        s.state,          // Alias (Teil-C-Spezifikation)
        zone:            s.zone,
        proximity:       s.proximity,
        faceX:           visualBus.faceX,
        dwellProgress:   visualBus.dwellProgress,   // → Aux-Ring
        faceDetected:    s.faceDetected,
        callRole:        s.callRole ?? null,
        remoteConnected: s.remoteConnected ?? false,
        // MERGED DISPLAY: aux rendert die rechte Bildhälfte nur, wenn der
        // Master das Flag setzt — so fallen beide Fenster GEMEINSAM zurück
        merged:          s.merged ?? false,
        bezelPx:         s.bezelPx ?? BEZEL_COMPENSATION_PX,
        selfViewMode:    s.selfViewMode ?? SELF_VIEW_MODE,
        mergeOffsetPercent: s.mergeOffsetPercent ?? MERGE_OFFSET_PERCENT,
        remotePresent:   s.remotePresent ?? false,   // s. remote_presence oben
      };
    };
    const id = setInterval(() => {
      channel.postMessage(buildVisualPayload());
    }, 150);
    // Zusätzlich zum 150-ms-Takt oben wird explizit alle 1000 ms gesendet,
    // unabhängig davon ob sich etwas geändert hat. Der 150-ms-Takt oben ist
    // bereits unbedingt periodisch (kein Vergleich mit dem letzten Wert)
    // und deckt "alle 1000ms, auch ohne Änderung" bereits ab — dieser
    // zweite, langsamere Intervall ist daher redundant, dient aber als
    // eigener, klar benannter Heartbeat (z.B. falls der 150-ms-Takt
    // künftig mal bedingt gemacht wird). Beide Intervalle teilen sich den
    // Kanal und die Payload-Funktion, kein doppelter Code.
    const heartbeatId = setInterval(() => {
      channel.postMessage(buildVisualPayload());
    }, 1000);
    return () => { clearInterval(id); clearInterval(heartbeatId); channel.close(); };
  }, []);

  // ----------------------------------------------------------------
  // Anruf beenden
  // ----------------------------------------------------------------

  const handleEndCall = useCallback(() => {
    console.info('[App] Anruf wird beendet (manuell)');
    endCall();
    setCallRole(null);
    // Bewusstes Auflegen soll den Server SOFORT informieren, nicht erst nach
    // der READY_RELEASE_MS-Karenzzeit (die ist nur für unabsichtliche kurze
    // Erkennungsaussetzer gedacht, siehe presence-Effekt weiter oben).
    clearTimeout(readyReleaseTimerRef.current);
    readyReleaseTimerRef.current = null;
    sendMessage({ type: 'presence', ready: false });
    forceAmbientNow();
    setAppState(STATE.AMBIENT);
  }, [endCall, sendMessage, forceAmbientNow]);

  // ----------------------------------------------------------------
  // Handshake-Timeout: Falls WebRTC-Verbindung fehlschlägt
  // ----------------------------------------------------------------

  const handleHandshakeTimeout = useCallback(() => {
    console.warn('[App] Handshake-Timeout – zurück zu AMBIENT');
    endCall();
    setCallRole(null);
    clearTimeout(readyReleaseTimerRef.current);
    readyReleaseTimerRef.current = null;
    sendMessage({ type: 'presence', ready: false });
    forceAmbientNow();
    setAppState(STATE.AMBIENT);
  }, [endCall, sendMessage, forceAmbientNow]);

  // ----------------------------------------------------------------
  // Debug-Ausgabe (Konsole)
  // ----------------------------------------------------------------

  useEffect(() => {
    console.info(
      `[App] Zustand: ${appState} | Rolle: ${callRole ?? '—'} | Signaling: ${connectionState}`
    );
  }, [appState, callRole, connectionState]);

  // ----------------------------------------------------------------
  // Rendering: Komponente basierend auf aktuellem Zustand
  // ----------------------------------------------------------------

  // ----------------------------------------------------------------
  // Dual-Display-Layout: Split (kein ?screen) ODER eigenständiges
  // Haupt-Display-Fenster (?screen=main, volle Breite; das aux-Fenster
  // läuft separat als AuxScreenApp). Der Pfad für ?screen=1/2 (separate
  // Fenster/Rechner) folgt weiter unten.
  // ----------------------------------------------------------------

  if (SCREEN_MODE === null || SCREEN_MODE === 'main') {
    return (
      <>
        {/* Start-Button — die eine Nutzergeste für Vollbild/Audio/
            Cursor/Wake-Lock. Die Pipeline (Kamera/Signaling) läuft darunter
            bereits an, das Overlay verdeckt sie nur. */}
        {!displayStarted && (
          <StartGate onStarted={() => setDisplayStarted(true)} autoStart={AUTO_START} />
        )}
        {DEBUG_MODE && <div style={DEBUG_BADGE}>TESTMODUS</div>}
        {SIM_MODE && <div style={SIM_BADGE}>SIM — 1 leer · 2 besetzt · 3 echt · 4 lokal</div>}
        {/* Bezel-Justage: aktueller Wert zum Ablesen/Notieren (+/−) */}
        {DEBUG_MODE && bezelHudVisible && (
          <div style={{ ...DEBUG_BADGE, top: '40px', background: 'rgba(40,80,160,0.4)' }}>
            BEZEL: {bezelPx}px · OFFSET: {mergeOffsetPercent.toFixed(1)}% (←/→)
          </div>
        )}
        <SplitLayout
          split={SPLIT}
          singleMode={SCREEN_MODE === 'main' || LAYOUT_MODE === 'single'}
          left={
            <MainDisplay
              state={displayState}
              remoteStream={displayRemoteStream}
              zone={displayZone}
              audioUnlocked={displayStarted}
              merged={mergedActive}
              bezelPx={bezelPx}
              mergeOffsetPercent={mergeOffsetPercent}
              localStream={localStream}
              presenceLostAt={presenceLostAt}
              callTimeoutMs={CALL_TIMEOUT_MS}
              remotePresent={effectiveRemotePresent}
            />
          }
          right={
            <AuxDisplay
              state={displayState}
              proximity={proximity}
              localStream={localStream}
              zone={displayZone}
              dwellProgress={dwellProgress}
              remotePresent={effectiveRemotePresent}
            />
          }
        />

        {import.meta.env.DEV && (
          <DevPanel
            appState={appState}
            connectionState={connectionState}
            faceDebug={faceDebug}
          />
        )}
      </>
    );
  }

  // ----------------------------------------------------------------
  // Alternativer Pfad: aktiv wenn ?screen=1 oder ?screen=2 gesetzt ist
  // ----------------------------------------------------------------

  return (
    <>
      {/* AmbientDisplay / InvitationScreen je nach Zustand und screen-Parameter */}
      {(appState === STATE.AMBIENT || appState === STATE.DETECTING) && (
        SCREEN_MODE === 2 && appState === STATE.AMBIENT ? (
          <InvitationScreen />
        ) : (
          <AmbientDisplay
            state={appState}
            screenMode={SCREEN_MODE}
            inviteReady={facePromptReady}
            faceCount={faceCount}
            showSlides={idleContentReady}
            meshReady={faceDebug.cameraReady}
          />
        )
      )}

      {/* HandshakeAnimation während WebRTC-Aushandlung */}
      {appState === STATE.HANDSHAKE && (
        <>
          <HandshakeAnimation onTimeout={handleHandshakeTimeout} />
          {/* callRole !== null: Server hat start_call gesendet, d.h. beide
              Seiten waren ready — nächstliegende Entsprechung zur früheren
              peerHandshakePresent-Vermutung in der neuen, server-gesteuerten
              Architektur (siehe Kopf-Dokumentation dieser Datei). */}
          <HandshakeInvitationOverlay peerReady={callRole !== null} />
        </>
      )}

      {/* VideoPortal wenn Verbindung aktiv ist */}
      {appState === STATE.ACTIVE && (
        <VideoPortal
          localStream={localStream}
          remoteStream={remoteStream}
          onEndCall={handleEndCall}
        />
      )}

      {/* Entwicklungs-Overlay: vollständige Pipeline-Info */}
      {import.meta.env.DEV && (
        <DevPanel
          appState={appState}
          connectionState={connectionState}
          faceDebug={faceDebug}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// DevPanel — vollständige Kamera-Pipeline-Debug-Anzeige (nur DEV)
// ---------------------------------------------------------------------------

function DevPanel({ appState, connectionState, faceDebug }) {
  // Studie: Statusleiste startet UNSICHTBAR und wird nur per Taste "d"
  // eingeblendet (gleiche Taste wie das Erkennungs-HUD in useFaceDetection).
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'd' || e.key === 'D') setVisible((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Relative "last seen" timestamp, refreshed every second
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  const lastSeen = faceDebug.lastDetectionTs
    ? Math.round((now - faceDebug.lastDetectionTs) / 1000)
    : null;

  const seg = (label, value, color) => (
    <span key={label} style={P.seg}>
      <span style={P.segLabel}>{label}</span>
      <span style={{ color }}>{value}</span>
    </span>
  );

  return (
    <div style={P.bar}>
      {seg('STATE', appState,  STATE_COLOR[appState])}
      {seg('SIG',   connectionState, connectionState === 'connected' ? C.ok : C.warn)}
      <span style={P.divider} />
      {seg('CAM',    faceDebug.cameraReady ? `${faceDebug.videoW}×${faceDebug.videoH}` : '…', faceDebug.cameraReady ? C.ok : C.warn)}
      {seg('FACES',  String(faceDebug.faceCount), faceDebug.faceCount > 0 ? C.ok : C.dim)}
      {seg('MOTION', faceDebug.motionActive ? 'yes' : 'no', faceDebug.motionActive ? C.accent : C.dim)}
      {seg('PROX',   `${Math.round((faceDebug.proximity ?? 0) * 100)}%`, C.accent)}
      {seg('LAST',   lastSeen === null ? '—' : lastSeen === 0 ? 'now' : `${lastSeen}s ago`, lastSeen !== null && lastSeen < 5 ? C.ok : C.dim)}
    </div>
  );
}

const C = {
  ok:     '#4ade80',
  warn:   '#facc15',
  accent: '#60a5fa',
  dim:    'rgba(148,163,184,0.7)',
};

const STATE_COLOR = {
  AMBIENT:   'rgba(148,163,184,0.8)',
  DETECTING: '#60a5fa',
  HANDSHAKE: '#facc15',
  ACTIVE:    '#4ade80',
};

const P = {
  bar: {
    position:      'fixed',
    bottom:        0,
    left:          0,
    right:         0,
    zIndex:        9999,
    height:        '22px',
    display:       'flex',
    alignItems:    'center',
    gap:           '20px',
    paddingLeft:   '16px',
    background:    'rgba(0, 0, 0, 0.38)',
    fontFamily:    "'Courier New', monospace",
    fontSize:      '10px',
    letterSpacing: '0.5px',
    pointerEvents: 'none',
    userSelect:    'none',
  },
  seg: {
    display: 'flex',
    gap:     '5px',
  },
  segLabel: {
    color:   'rgba(255,255,255,0.28)',
  },
  divider: {
    display:    'inline-block',
    width:      '1px',
    height:     '10px',
    background: 'rgba(255,255,255,0.15)',
    flexShrink: 0,
  },
};

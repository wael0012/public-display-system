/**
 * useWebRTC.js
 *
 * @fileoverview React-Hook für die eigentliche WebRTC-Peer-to-Peer-Video-
 * verbindung. App.jsx ruft diesen Hook mit der vom Signaling-Server
 * zugewiesenen Rolle (role: callRole) auf und reicht Offer/Answer/ICE über
 * sendSignal (aus useSignaling.js) weiter; handleSignalingMessage verarbeitet
 * eingehende Nachrichten in Gegenrichtung.
 *
 * Reines LAN ohne STUN/TURN (iceServers: []); ein Glare-Schutz
 * (makingOfferRef) und ein automatischer ICE-Neustart bei "failed"/
 * "disconnected" (nur durch den Caller) fangen kurze Netzwackler ab, ohne
 * die ganze Verbindung neu aufzubauen.
 *
 * Rollenkonzept: caller erstellt das Offer und wartet auf die Answer,
 * callee wartet auf das Offer und beantwortet es.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

/** WebRTC-Konfiguration: kein externer ICE-Server, reines LAN */
const RTC_CONFIG = {
  iceServers: [],           // LAN-interne host-Kandidaten reichen vollständig aus
  iceTransportPolicy: 'all', // nicht 'relay' — wir haben keine Relay-Server
};

/* ═══════════════════════════════════════════════════════════════════════════
 * VIDEOQUALITÄT — alle Stellschrauben für den Gigabit-LAN-Betrieb gebündelt.
 * Vor Ort justierbar; Änderungen wirken ab dem NÄCHSTEN Anruf.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Medien-Einschränkungen für Video und Audio */
const MEDIA_CONSTRAINTS = {
  video: {
    width:      { ideal: 1920 },
    height:     { ideal: 1080 },
    frameRate:  { ideal: 30 },
    facingMode: 'user',
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
  },
};

/**
 * Im reinen Gigabit-LAN ist Bandbreite kein Limit — der Engpass wäre sonst
 * die künstliche Kappung (WebRTC deckelt Video standardmäßig auf
 * ~2,5 Mbit/s). 1080p30 braucht für nahezu artefaktfreie BEWEGUNG (Personen,
 * die auf die Kamera zugehen) 8–10 Mbit/s; 10 gibt dem Encoder Luft für
 * Bewegungsspitzen, ohne den Hardware-Encoder auch nur annähernd zu fordern.
 * Der tatsächlich gesendete Wert landet als sendBitrateKbps im Studien-CSV.
 */
export const VIDEO_MAX_BITRATE   = 10_000_000;
export const VIDEO_MAX_FRAMERATE = 30;

/**
 * 'detail' (Encoder priorisiert Bildschärfe pro Frame statt zeitlicher
 * Glättung) sieht bei GROSSEM Bitraten-Puffer (10 Mbit/s, praktisch nie
 * ausgereizt) und RUHIGER Begegnung (stehende, sprechende Personen, kaum
 * schnelle Bewegung) sichtbar besser aus als die bewegungsoptimierte
 * Variante 'maintain-framerate'.
 */
const VIDEO_DEGRADATION_PREFERENCE = 'maintain-resolution';
const VIDEO_CONTENT_HINT = 'detail';

/**
 * Bildabstimmung der ANRUF-Kamera (v. a. relevant bei hellem, weißem
 * Hintergrund → Kamera belichtet die Person zu dunkel). null = Kamera-
 * Automatik unangetastet lassen (DEFAULT — die Präsenzerkennung setzt
 * bereits exposureCompensation auf 65 % der Range, und Kamera-Einstellungen
 * wirken HARDWARE-GLOBAL auf alle Streams derselben Kamera; hier nur
 * eingreifen, wenn das Anruf-Bild vor Ort zusätzlich justiert werden muss).
 *   exposureCompensationFraction: 0..1 der Kamera-Range (z. B. 0.65)
 *   brightnessFraction:           0..1 der Kamera-Range
 *   whiteBalanceMode:             'continuous' | 'manual' (nur mit colorTemperature)
 *   colorTemperature:             Kelvin (nur bei whiteBalanceMode 'manual')
 */
const CALL_CAMERA_TUNE = {
  exposureCompensationFraction: null,
  brightnessFraction:           null,
  whiteBalanceMode:             null,
  colorTemperature:             null,
};

/**
 * Auflösungs-Capabilities loggen + 1080p VERBINDLICH nachfordern, falls die
 * Kamera es laut getCapabilities kann.
 *
 * WICHTIG — Aufklärung eines scheinbaren Widerspruchs im Log: Ein Eintrag
 * "[MediaPipe] Kamera gestartet: 1280×720" ist NICHT diese Kamera hier. Das
 * ist der SEPARATE, ABSICHTLICH niedrig aufgelöste Erkennungs-Stream aus
 * useFaceDetection.js (für MediaPipe reicht 720p, mehr kostet nur
 * Detektionszeit ohne Nutzen). Die HIER betroffene Kamera ist die für den
 * ANRUF (diese Datei, MEDIA_CONSTRAINTS), separat geöffnet.
 *
 * Warum 'ideal' allein reichen KANN, aber nicht MUSS: 'ideal' ist eine
 * weiche Präferenz — der Browser darf niedriger liefern, wenn er eine
 * Kamera-interne Abwägung trifft (z.B. Framerate/Format-Kompromiss) oder
 * WENN DIESELBE PHYSISCHE KAMERA gerade schon in einer ANDEREN Auflösung
 * geöffnet ist (hier: der Erkennungs-Stream oben, 1280×720 — manche UVC-
 * Treiber/Windows Media Foundation liefern dann ALLEN Konsumenten
 * DIESELBE bereits ausgehandelte Auflösung, unabhängig von neuen
 * Constraints). Dieser zweite Fall lässt sich softwareseitig NICHT sicher
 * umgehen; er wird hier nur sichtbar gemacht (Capabilities vs. Ist-Wert),
 * nicht automatisch behoben.
 *
 * Ablauf: Stream normal (mit 'ideal') holen (s. Aufrufer) → Capabilities
 * des ECHTEN Tracks lesen (max. mögliche Auflösung) → falls die Kamera
 * mehr kann als sie gerade liefert, EINMALIG applyConstraints mit engerem
 * 'ideal' (bewusst NICHT 'exact' — ein hartes 'exact' würde den ganzen
 * Anruf mit OverconstrainedError abbrechen, wenn die Kamera doch nicht
 * mitspielt; hier soll höchstens nachgebessert, nie etwas zerstört
 * werden) versuchen. Scheitert das, bleibt der ursprüngliche Stream
 * unangetastet in Betrieb — nie fatal.
 */
async function logAndUpgradeResolution(track) {
  try {
    const caps = track.getCapabilities?.();
    const settings = track.getSettings();
    if (!caps || !caps.width || !caps.height) {
      console.info('[WebRTC] Kamera-Capabilities nicht verfügbar (Browser/Treiber) — kann Auflösung nicht prüfen');
      return;
    }
    console.info(
      `[WebRTC] Kamera-Capabilities: Breite ${caps.width.min}-${caps.width.max}px, `
      + `Höhe ${caps.height.min}-${caps.height.max}px, fps ${caps.frameRate?.min ?? '?'}-${caps.frameRate?.max ?? '?'} `
      + `| aktuell geliefert: ${settings.width}×${settings.height}`,
    );

    const canDo1080p = caps.width.max >= 1920 && caps.height.max >= 1080;
    const already1080p = settings.width >= 1920 && settings.height >= 1080;
    if (!canDo1080p) {
      console.warn('[WebRTC] Kamera kann laut Capabilities KEIN 1920×1080 — 1280×720 ist hier das technische Maximum, nichts zu tun');
      return;
    }
    if (already1080p) return;

    console.info('[WebRTC] Kamera kann 1080p, liefert aber weniger → fordere verbindlicher nach (applyConstraints)');
    try {
      await track.applyConstraints({
        width:  { ideal: 1920, min: 1920 },
        height: { ideal: 1080, min: 1080 },
      });
      const after = track.getSettings();
      console.info(`[WebRTC] Nach Nachforderung: ${after.width}×${after.height}`);
      if (after.width < 1920 || after.height < 1080) {
        console.warn(
          '[WebRTC] Immer noch nicht 1080p, obwohl die Kamera es laut Capabilities kann — '
          + 'vermutlich belegt der Erkennungs-Stream (720p) dieselbe Kamera bereits in dieser '
          + 'Auflösung (Treiber-Limitierung, s. Kommentar oben). Kein Software-Fix möglich.',
        );
      }
    } catch (err) {
      console.warn('[WebRTC] Auflösungs-Nachforderung fehlgeschlagen (Stream bleibt wie er ist):', err?.message ?? err);
    }
  } catch (err) {
    console.warn('[WebRTC] Capability-Check fehlgeschlagen (ignoriert):', err?.message ?? err);
  }
}

/**
 * Encoder-Politik auf den Video-Sender anwenden (Bitraten-Deckel, fps-Deckel,
 * Degradations-Präferenz — s. Konstanten oben). try/catch: ein Fehlschlag
 * (z. B. Browser unterstützt setParameters nicht vollständig) darf den Anruf
 * NIE verhindern — schlimmstenfalls bleibt die Browser-Standardkodierung
 * (die ~2,5-Mbit/s-Kappung) aktiv.
 */
async function applyVideoSenderParams(sender) {
  try {
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate   = VIDEO_MAX_BITRATE;
    params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE;
    params.degradationPreference     = VIDEO_DEGRADATION_PREFERENCE;
    await sender.setParameters(params);
  } catch (err) {
    console.warn('[WebRTC] Video-Sender-Parameter nicht setzbar:', err);
  }
}

/**
 * Wendet CALL_CAMERA_TUNE auf den Video-Track an (nur gesetzte Werte,
 * nur wenn die Kamera sie laut getCapabilities kann). Fehler sind nie
 * fatal — schlimmstenfalls bleibt die Automatik aktiv.
 */
async function applyCallCameraTune(track) {
  try {
    const caps = track.getCapabilities?.();
    if (!caps) { console.info('[WebRTC] Kamera-Tune: getCapabilities nicht verfügbar'); return; }
    const c = {};
    const t = CALL_CAMERA_TUNE;
    const frac = (range, f) => range.min + (range.max - range.min) * f;
    if (t.exposureCompensationFraction != null && caps.exposureCompensation) {
      c.exposureCompensation = frac(caps.exposureCompensation, t.exposureCompensationFraction);
    }
    if (t.brightnessFraction != null && caps.brightness) {
      c.brightness = frac(caps.brightness, t.brightnessFraction);
    }
    if (t.whiteBalanceMode != null && caps.whiteBalanceMode?.includes(t.whiteBalanceMode)) {
      c.whiteBalanceMode = t.whiteBalanceMode;
      if (t.whiteBalanceMode === 'manual' && t.colorTemperature != null && caps.colorTemperature) {
        c.colorTemperature = Math.min(caps.colorTemperature.max,
          Math.max(caps.colorTemperature.min, t.colorTemperature));
      }
    }
    if (Object.keys(c).length === 0) {
      console.info('[WebRTC] Kamera-Tune: nichts zu tun (alle Werte null oder nicht unterstützt)');
      return;
    }
    await track.applyConstraints({ advanced: [c] });
    console.info('[WebRTC] Kamera-Tune angewandt:', JSON.stringify(c));
  } catch (err) {
    console.warn('[WebRTC] Kamera-Tune fehlgeschlagen (Automatik bleibt):', err?.message ?? err);
  }
}

/**
 * connectionState 'disconnected' ist bei WebRTC oft TRANSIENT — ein kurzer
 * Netzwackler, den restartIce() (siehe oniceconnectionstatechange) meist
 * binnen Sekunden repariert. Würde onDisconnected sofort feuern, fiele die
 * App nach AMBIENT, obwohl sich die Verbindung gleich wieder erholt (das
 * Video liefe dann unsichtbar weiter, weil der Übergang HANDSHAKE→ACTIVE
 * bereits konsumiert wäre) — deshalb wird 'disconnected' erst nach diesem
 * Debounce als echte Trennung gemeldet. 'failed' und 'closed' werden
 * weiterhin SOFORT gemeldet.
 */
const DISCONNECT_DEBOUNCE_MS = 4_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebRTC({ sendSignal, role, onConnected, onDisconnected, onStats, onTiming }) {
  const [localStream,     setLocalStream]     = useState(null);
  const [remoteStream,    setRemoteStream]    = useState(null);
  const [connectionState, setConnectionState] = useState('new');

  // Stabile Objekte über Re-Renders hinweg
  const pcRef          = useRef(null);   // RTCPeerConnection
  const localStreamRef = useRef(null);   // Lokaler Stream (für Cleanup)

  /**
   * ICE-Candidate-Queue:
   * ICE-Kandidaten des Gegenübers treffen oft ein, BEVOR setRemoteDescription
   * abgeschlossen ist (beim Callee läuft davor noch getUserMedia — das dauert).
   * addIceCandidate wirft dann InvalidStateError ("remote description was
   * null") und die Kandidaten gehen VERLOREN → keine P2P-Verbindung, obwohl
   * Offer/Answer sauber durchlaufen. Standard-Lösung: Kandidaten puffern und
   * direkt nach setRemoteDescription nachreichen.
   */
  const pendingCandidatesRef = useRef([]);

  /** Laufender Trenn-Debounce für ein transientes 'disconnected' */
  const disconnectTimerRef = useRef(null);

  // Callback-Refs: Closures sehen immer den aktuellen Wert
  const sendSignalRef     = useRef(sendSignal);
  const onConnectedRef    = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);

  /**
   * Ref-Kopie der Rolle:
   * Wird in oniceconnectionstatechange benötigt — dort wäre role aus dem
   * äußeren Closure veraltet, wenn sich die Rolle nach dem ersten Render
   * ändert. roleRef ist immer aktuell.
   */
  const roleRef = useRef(role);

  /**
   * Glare-Schutz:
   * true  → wir erstellen gerade selbst ein Offer (createOffer läuft)
   * false → wir sind frei, eingehende Offers anzunehmen
   *
   * Glare tritt auf, wenn beide Peers gleichzeitig ein Offer senden.
   * Im System passiert das selten, weil nur der Caller startCall() aufruft.
   * Mit makingOfferRef ist es aber sauber abgesichert.
   */
  const makingOfferRef = useRef(false);

  const onStatsRef = useRef(onStats);
  /** Zeitkette Offer/Answer für das Studien-Timing, s. onTiming-Aufrufe unten */
  const onTimingRef = useRef(onTiming);

  /** Vorherige Byte-Zähler für die Bitraten-Berechnung (Δ/5s) */
  const statsPrevRef = useRef({ bytesSent: 0, bytesReceived: 0, t: 0 });

  // Refs aktuell halten (ohne neuen useEffect-Durchlauf auszulösen)
  useEffect(() => { sendSignalRef.current     = sendSignal;     }, [sendSignal]);
  useEffect(() => { onConnectedRef.current    = onConnected;    }, [onConnected]);
  useEffect(() => { onDisconnectedRef.current = onDisconnected; }, [onDisconnected]);
  useEffect(() => { roleRef.current           = role;           }, [role]);
  useEffect(() => { onStatsRef.current        = onStats;        }, [onStats]);
  useEffect(() => { onTimingRef.current       = onTiming;       }, [onTiming]);

  // -------------------------------------------------------------------------
  // Studien-Logging (rein additiv): Alle 5 s Verbindungsstatistiken aus
  // pc.getStats() ziehen — Auflösung/fps/Bytes/Paketverluste des EMPFANGENEN
  // Videos + qualityLimitationReason des GESENDETEN. Gedrosselt in die
  // Konsole und per onStats-Callback an App.jsx (→ call_stats ins CSV).
  // Greift NICHT in die Verbindungslogik ein.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (connectionState !== 'connected') return undefined;
    const id = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        const summary = {};
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            summary.frameWidth      = report.frameWidth;
            summary.frameHeight     = report.frameHeight;
            summary.framesPerSecond = report.framesPerSecond;
            summary.bytesReceived   = report.bytesReceived;
            summary.packetsLost     = report.packetsLost;
          }
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            summary.qualityLimitationReason = report.qualityLimitationReason;
            // TATSÄCHLICHE Sende-Auflösung/fps — zeigt, ob
            // der Encoder 1080p durchhält oder degradiert
            summary.sendWidth  = report.frameWidth;
            summary.sendHeight = report.frameHeight;
            summary.sendFps    = report.framesPerSecond;
            summary.bytesSent  = report.bytesSent;
          }
        });
        // Reale Bitraten aus den Byte-Deltas seit dem letzten Abruf (kbit/s)
        const prev = statsPrevRef.current;
        const nowT = performance.now();
        if (prev.t > 0 && nowT > prev.t) {
          const dtSec = (nowT - prev.t) / 1000;
          if (summary.bytesSent >= prev.bytesSent) {
            summary.sendBitrateKbps = Math.round(((summary.bytesSent - prev.bytesSent) * 8) / 1000 / dtSec);
          }
          if (summary.bytesReceived >= prev.bytesReceived) {
            summary.recvBitrateKbps = Math.round(((summary.bytesReceived - prev.bytesReceived) * 8) / 1000 / dtSec);
          }
        }
        statsPrevRef.current = {
          bytesSent: summary.bytesSent ?? 0,
          bytesReceived: summary.bytesReceived ?? 0,
          t: nowT,
        };
        // JSON — exakt das, was als call_stats ins CSV geht
        console.debug('[WebRTC] Stats:', JSON.stringify(summary));
        onStatsRef.current?.(summary);
      } catch (err) {
        console.debug('[WebRTC] getStats fehlgeschlagen (ignoriert):', err?.message ?? err);
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [connectionState]);

  // -------------------------------------------------------------------------
  // RTCPeerConnection erstellen und konfigurieren
  // -------------------------------------------------------------------------

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // ICE-Kandidaten senden (bei LAN-Betrieb sind das ausschließlich host-Kandidaten
    // mit der lokalen IP, z.B. 192.168.x.x – kein STUN/TURN nötig)
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        console.debug('[WebRTC] ICE-Kandidat gesendet:', candidate.candidate);
        sendSignalRef.current({ type: 'ice-candidate', candidate });
      } else {
        console.info('[WebRTC] ICE-Kandidatensammlung abgeschlossen');
      }
    };

    // Remote-Stream empfangen
    pc.ontrack = ({ track, streams }) => {
      console.info(`[WebRTC] Remote-Track: kind=${track?.kind ?? '?'}`);
      if (streams?.[0]) {
        console.info('[WebRTC] Remote-Stream erhalten');
        setRemoteStream(streams[0]);
      }
    };

    // Verbindungszustand (DTLS/SCTP-Ebene) überwachen.
    // Bei "connected" wird onConnected() aufgerufen → App.jsx wechselt
    // HANDSHAKE → ACTIVE und zeigt das Video an.
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.info('[WebRTC] connectionState:', state);
      setConnectionState(state);

      if (state === 'connected') {
        // Ein evtl. laufender Trenn-Debounce ist hinfällig — der
        // Wackler wurde (i.d.R. durch restartIce) gerettet. onConnected
        // führt in App.jsx über transition(HANDSHAKE→ACTIVE) nach ACTIVE;
        // blieb die App während des Wacklers ohnehin durchgehend ACTIVE,
        // wird der Übergang schlicht ignoriert — beides korrekt.
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
        onConnectedRef.current?.();
      }

      if (state === 'failed' || state === 'closed') {
        // endgültige Zustände: weiterhin SOFORT melden
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
        onDisconnectedRef.current?.();
      }

      if (state === 'disconnected') {
        // Transient möglich → erst nach DISCONNECT_DEBOUNCE_MS als
        // echte Trennung behandeln (restartIce läuft parallel an)
        if (!disconnectTimerRef.current) {
          console.warn(
            `[WebRTC] 'disconnected' – warte ${DISCONNECT_DEBOUNCE_MS} ms auf Erholung`,
          );
          disconnectTimerRef.current = setTimeout(() => {
            disconnectTimerRef.current = null;
            // Gehört der Timer noch zum AKTUELLEN Anruf? (endCall/neuer
            // Anruf könnten pc inzwischen ersetzt haben)
            if (pcRef.current !== pc) return;
            const s = pc.connectionState;
            if (s === 'connected' || s === 'connecting') {
              console.info('[WebRTC] Verbindung hat sich erholt – keine Trennung gemeldet');
              return;
            }
            console.warn('[WebRTC] Verbindung nicht erholt → Trennung wird gemeldet');
            onDisconnectedRef.current?.();
          }, DISCONNECT_DEBOUNCE_MS);
        }
      }
    };

    /**
     * ICE-Verbindungszustand (Transport-Ebene) überwachen.
     * Bei "failed" oder "disconnected": Caller startet automatisch einen
     * ICE-Neustart — das löst einen neuen Offer mit refreshten Kandidaten aus,
     * ohne die gesamte RTCPeerConnection neu aufzubauen.
     */
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.info('[WebRTC] iceConnectionState:', iceState);

      if (
        (iceState === 'failed' || iceState === 'disconnected') &&
        roleRef.current === 'caller'
      ) {
        console.warn('[WebRTC] ICE-Verbindung unterbrochen – starte restartIce()');
        try {
          pc.restartIce();
        } catch (err) {
          console.error('[WebRTC] restartIce() fehlgeschlagen:', err);
        }
      }
    };

    return pc;
  }, []);

  // -------------------------------------------------------------------------
  // Kamera-Vorwärmen: Kamera-/Mikrofon-Init kostet je nach Treiber 200 ms
  // bis über 1 s — ohne Vorwärmen läge das genau im kritischen Pfad
  // zwischen start_call und dem ersten sichtbaren Bild. App.jsx ruft
  // prewarmLocalStream() auf, sobald HANDSHAKE beginnt (starkes, aber noch
  // nicht sicheres Signal für einen unmittelbar bevorstehenden Anruf) —
  // der fertige Stream liegt dann meist schon bereit, wenn start_call
  // eintrifft. GEFAHRLOS, weil rein additiv: Schlägt das Vorwärmen fehl
  // oder wird es gar nicht aufgerufen, arbeitet acquireLocalStream exakt
  // gleich weiter (frischer getUserMedia-Aufruf) — kein neuer Pflichtpfad.
  // cancelPrewarm() wird aus App.jsx bei JEDEM Verlassen von HANDSHAKE
  // aufgerufen (auch im Erfolgsfall, wo es ein harmloses No-Op ist, da der
  // Stream dann bereits konsumiert/ref geleert ist) — verhindert, dass ein
  // ungenutzter vorgewärmter Stream (abgebrochener Handshake) Kamera/Mikro
  // offen hält.
  // -------------------------------------------------------------------------
  const prewarmedStreamRef = useRef(null);
  const prewarmInFlightRef = useRef(false);

  const prewarmLocalStream = useCallback(async () => {
    if (prewarmedStreamRef.current || prewarmInFlightRef.current) return;
    prewarmInFlightRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
      // Zwischenzeitlich schon verworfen (cancelPrewarm während des Wartens)?
      if (!prewarmInFlightRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      prewarmedStreamRef.current = stream;
      console.info('[WebRTC] Kamera vorgewärmt (bereit vor start_call)');
    } catch (err) {
      console.warn('[WebRTC] Vorwärmen fehlgeschlagen (kein Problem, holt acquireLocalStream nach):', err?.message ?? err);
    } finally {
      prewarmInFlightRef.current = false;
    }
  }, []);

  const cancelPrewarm = useCallback(() => {
    prewarmInFlightRef.current = false;   // ein noch laufendes getUserMedia wird beim Eintreffen verworfen
    const stream = prewarmedStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      prewarmedStreamRef.current = null;
      console.info('[WebRTC] Vorgewärmter Stream verworfen (Anruf kam nicht zustande)');
    }
  }, []);

  // -------------------------------------------------------------------------
  // Lokalen Medienstream holen und zur Verbindung hinzufügen
  // (wird sowohl von Caller als auch von Callee aufgerufen)
  // -------------------------------------------------------------------------

  const acquireLocalStream = useCallback(async (pc) => {
    // Vorgewärmten Stream nutzen, falls vorhanden UND noch live (Kamera
    // könnte zwischenzeitlich getrennt worden sein) — sonst normaler Weg.
    let stream = prewarmedStreamRef.current;
    if (stream && stream.getTracks().every((t) => t.readyState === 'live')) {
      prewarmedStreamRef.current = null;   // konsumiert
      console.info('[WebRTC] Vorgewärmter Kamerastream übernommen (kein Warten auf getUserMedia)');
    } else {
      if (stream) stream.getTracks().forEach((t) => t.stop());   // tot, aufräumen
      prewarmedStreamRef.current = null;
      stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
    }

    // Kritisch: Wurde der Anruf WÄHREND getUserMedia beendet (end_call/
    // Abbruch → pc.close()), würde addTrack unten mit InvalidStateError
    // werfen UND der frisch geholte Kamera-Stream würde leaken
    // (localStreamRef wäre nie gesetzt → Kamera-LED bliebe an).
    // Dann: Stream sofort wieder freigeben und abbrechen.
    if (pc.signalingState === 'closed' || pcRef.current !== pc) {
      console.warn('[WebRTC] Anruf wurde während getUserMedia beendet – Stream wird verworfen');
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }

    localStreamRef.current = stream;
    setLocalStream(stream);

    // Ist-Auflösung loggen, contentHint setzen, Bildabstimmung anwenden
    // (nur wenn in CALL_CAMERA_TUNE aktiviert)
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const s = videoTrack.getSettings();
      console.info(`[WebRTC] Kamera liefert: ${s.width}×${s.height} @ ${s.frameRate ?? '?'} fps`);
      try { videoTrack.contentHint = VIDEO_CONTENT_HINT; } catch { /* optional */ }
      applyCallCameraTune(videoTrack);        // async, nie fatal
      logAndUpgradeResolution(videoTrack);    // async, nie fatal
    }

    stream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, stream);
      console.debug('[WebRTC] Track hinzugefügt:', track.kind);

      // Encoder-Politik: Bitraten-Deckel (LAN: großzügig), fps-Deckel,
      // Degradations-Präferenz (s. Konstanten oben) — greift auf BEIDEN
      // Pfaden (Caller/Offer via startCall UND Callee/Answer via
      // handleSignalingMessage), da acquireLocalStream die einzige zentrale
      // Stelle ist, die Tracks der PeerConnection hinzufügt.
      if (track.kind === 'video' && sender.setParameters) {
        applyVideoSenderParams(sender); // async, nie fatal (s. o.)
      }
    });

    // Sichtbar machen, dass Video UND Audio im SDP landen
    console.info(
      '[WebRTC] Lokale Tracks hinzugefügt: ' +
      stream.getTracks().map((t) => t.kind).join(', '),
    );

    return stream;
  }, []);

  // -------------------------------------------------------------------------
  // Anruf initiieren (nur Caller)
  // -------------------------------------------------------------------------

  const startCall = useCallback(async () => {
    if (roleRef.current !== 'caller') {
      console.warn('[WebRTC] startCall() ist nur für den Caller verfügbar');
      return;
    }

    console.info('[WebRTC] Starte Anruf als Caller');
    const pc = createPeerConnection();
    pcRef.current = pc;

    // WICHTIG: Tracks ZUERST hinzufügen, dann Offer erstellen.
    // Browser erzeugen sonst einen m-line-losen SDP – das Gegenstück lehnt ab.
    // null = Anruf wurde während getUserMedia beendet → Abbruch
    if ((await acquireLocalStream(pc)) === null) return;

    // Glare-Schutz aktivieren: makingOfferRef bleibt true während createOffer/
    // setLocalDescription läuft, damit eingehende Offers in dieser Zeit ignoriert werden.
    makingOfferRef.current = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignalRef.current({ type: 'offer', sdp: offer });
      console.info('[WebRTC] Offer gesendet');
      onTimingRef.current?.('offer_sent');
    } finally {
      // Immer zurücksetzen – auch bei Fehler, sonst ist der Glare-Schutz dauerhaft aktiv
      makingOfferRef.current = false;
    }
  }, [createPeerConnection, acquireLocalStream]);

  // -------------------------------------------------------------------------
  // Gepufferte ICE-Kandidaten nachreichen (direkt nach setRemoteDescription)
  // -------------------------------------------------------------------------

  const flushPendingCandidates = useCallback(async (pc) => {
    const pending = pendingCandidatesRef.current;
    if (pending.length === 0) return;
    pendingCandidatesRef.current = [];

    let added = 0;
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        added++;
      } catch (err) {
        console.error('[WebRTC] Gepufferter ICE-Kandidat fehlgeschlagen:', err);
      }
    }
    console.info(`[WebRTC] ${added} gepufferte ICE-Kandidaten nachgereicht`);
  }, []);

  // -------------------------------------------------------------------------
  // Eingehende Signaling-Nachrichten verarbeiten
  // -------------------------------------------------------------------------

  const handleSignalingMessage = useCallback(async (message) => {
    const { type } = message;

    // --- Offer empfangen ---
    if (type === 'offer') {
      /**
       * Glare-Schutz:
       * Wenn wir als Caller gerade selbst ein Offer erstellen und gleichzeitig
       * ein Offer vom anderen Peer eintrifft, ignorieren wir das eingehende Offer.
       * Im System ist das selten, weil nur der Caller startCall() aufruft,
       * aber es ist eine saubere Absicherung für Race-Conditions.
       */
      if (roleRef.current === 'caller' && makingOfferRef.current) {
        console.warn('[WebRTC] Glare erkannt – eingehendes Offer wird ignoriert');
        return;
      }

      // Nur der Callee beantwortet Offers
      if (roleRef.current !== 'callee') return;

      console.info('[WebRTC] Offer empfangen – erstelle Verbindung als Callee');
      const pc = createPeerConnection();
      pcRef.current = pc;

      // WICHTIG: Tracks ZUERST hinzufügen (vor setRemoteDescription),
      // damit der SDP-Answer vollständige m-Lines enthält.
      // null = Anruf wurde während getUserMedia beendet → Abbruch
      if ((await acquireLocalStream(pc)) === null) return;
      await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));

      // Kandidaten, die während getUserMedia/setRemoteDescription eintrafen,
      // jetzt nachreichen — vorher warf addIceCandidate InvalidStateError
      // und die Kandidaten gingen verloren (kein P2P trotz Offer/Answer)
      await flushPendingCandidates(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignalRef.current({ type: 'answer', sdp: answer });
      console.info('[WebRTC] Answer gesendet');
      onTimingRef.current?.('answer_sent');
    }

    // --- Answer empfangen (nur Caller) ---
    else if (type === 'answer' && roleRef.current === 'caller') {
      console.info('[WebRTC] Answer empfangen');
      const pc = pcRef.current;
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
        onTimingRef.current?.('answer_received');
        // Auch beim Caller: Kandidaten des Callee können vor dem Answer
        // eingetroffen sein → jetzt nachreichen
        await flushPendingCandidates(pc);
      }
    }

    // --- ICE-Kandidat empfangen (bidirektional) ---
    else if (type === 'ice-candidate' && message.candidate) {
      const pc = pcRef.current;

      // Solange die Verbindung noch nicht existiert oder remoteDescription
      // noch nicht gesetzt ist, dürfen Kandidaten NICHT hinzugefügt werden
      // (InvalidStateError). Stattdessen puffern — flushPendingCandidates
      // reicht sie direkt nach setRemoteDescription nach.
      if (!pc || !pc.remoteDescription) {
        pendingCandidatesRef.current.push(message.candidate);
        console.info('[WebRTC] ICE-Kandidat gepuffert (remoteDescription noch nicht gesetzt)');
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        console.debug('[WebRTC] ICE-Kandidat hinzugefügt');
      } catch (err) {
        console.error('[WebRTC] Fehler beim Hinzufügen von ICE-Kandidat:', err);
      }
    }
  }, [createPeerConnection, acquireLocalStream, flushPendingCandidates]);

  // -------------------------------------------------------------------------
  // Anruf beenden
  // -------------------------------------------------------------------------

  const endCall = useCallback(() => {
    console.info('[WebRTC] Anruf beendet');

    // Lokale Tracks stoppen (gibt Kamera/Mikrofon frei)
    localStreamRef.current?.getTracks().forEach((t) => t.stop());

    // Verbindung schließen
    pcRef.current?.close();
    pcRef.current      = null;
    makingOfferRef.current = false;
    pendingCandidatesRef.current = []; // Queue leeren — alte Kandidaten gehören zum beendeten Anruf
    // Trenn-Debounce des beendeten Anrufs verwerfen (zusätzlich zum
    // pcRef-Guard im Timer-Callback — doppelt hält besser)
    clearTimeout(disconnectTimerRef.current);
    disconnectTimerRef.current = null;

    // Bitraten-Deltas gehören zum beendeten Anruf → zurücksetzen
    statsPrevRef.current = { bytesSent: 0, bytesReceived: 0, t: 0 };

    setLocalStream(null);
    setRemoteStream(null);
    setConnectionState('closed');

    onDisconnectedRef.current?.();
  }, []);

  // Aufräumen beim Unmounten der Komponente
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      prewarmedStreamRef.current?.getTracks().forEach((t) => t.stop());
      pcRef.current?.close();
      clearTimeout(disconnectTimerRef.current);
    };
  }, []);

  return {
    localStream,
    remoteStream,
    connectionState,
    startCall,
    endCall,
    handleSignalingMessage,
    prewarmLocalStream,
    cancelPrewarm,
  };
}

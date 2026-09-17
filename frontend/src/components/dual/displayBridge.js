/**
 * displayBridge.js
 *
 * @fileoverview Merged-Display-Feature — aktuell deaktiviert
 * (MERGED_DISPLAY_ENABLED = false). Aktiviert würde es im ACTIVE-Zustand das
 * Remote-Video über main- UND aux-Bildschirm strecken. Da MediaStreams sich
 * nicht per BroadcastChannel übertragen lassen, transportiert eine zweite,
 * rein lokale RTCPeerConnection (iceServers=[]) den Stream vom Master
 * (App.jsx) zur Viewer-Seite im aux-Fenster (AuxScreenApp.jsx) — komplett
 * getrennt von der echten Anruf-Verbindung.
 *
 * Design-Entscheidung: Die Brücke wird einmal aufgebaut und bleibt dauerhaft
 * offen; ein Anruf wechselt beim Start/Ende nur per replaceTrack() den
 * Track, ganz ohne Renegotiation.
 *
 * @author Wael Hammami
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { VIDEO_MAX_BITRATE, VIDEO_MAX_FRAMERATE } from '../../hooks/useWebRTC.js';

// ═════════════════════════════════════════════════════════════════════════
// KONSTANTEN — Studien-Stellschrauben
// ═════════════════════════════════════════════════════════════════════════

/** Not-Aus: false = exakt das bisherige Verhalten (main voll, aux Self-View) */
export const MERGED_DISPLAY_ENABLED = false;

/** Bezel-Kompensation: so viele Bild-Pixel "verschwinden" im Rahmen zwischen
 *  den Bildschirmen (3–4 cm). Im Testmodus mit +/− live justierbar; den
 *  abgelesenen Wert hier als neuen Standard eintragen. */
export const BEZEL_COMPENSATION_PX = 83;

/** 'corner' = Merged Display + kleine Self-View unten rechts auf aux.
 *  'full'   = bisheriges Verhalten (aux zeigt Self-View in voller Größe,
 *             main das volle Remote-Video). Testmodus-Taste "v" schaltet um. */
export const SELF_VIEW_MODE = 'corner';

/** Corner-Self-View: Breite in % der aux-Bildschirmbreite und Deckkraft */
export const SELF_VIEW_WIDTH_PERCENT = 20;
export const SELF_VIEW_OPACITY = 0.55;

/**
 * Horizontaler Versatz des gesamten Merged-Bilds in Prozent der
 * Bildschirmbreite (positiv = nach rechts). 0 = Kamera-Mitte liegt auf der
 * Bezel-Kante; eine mittig vor der Kamera stehende Person landet sonst
 * strukturell genau im Rahmen zwischen den Monitoren. Reine Verschiebung,
 * keine Verzerrung — alle Größen-/Bewegungsverhältnisse bleiben erhalten.
 * Im Testmodus (?debug=1) mit ←/→ live justierbar, Wert im HUD sichtbar.
 */
export const MERGE_OFFSET_PERCENT = 0;
/** Schrittweite pro Tastendruck (Prozentpunkte) */
export const MERGE_OFFSET_STEP_PERCENT = 0.5;
/** Deckel: bei mehr würde der Rand des (200%+Bezel)-breiten Videos sichtbar
 *  werden (leerer schwarzer Streifen statt Bildinhalt). */
export const MERGE_OFFSET_MAX_PERCENT = 15;

/**
 * Kompensiert visuell, dass die zwei Kameras ein unterschiedliches Sichtfeld
 * haben (bei gleicher Distanz füllt ein Gesicht im Labor-Bild einen größeren
 * Anteil des Frames als im Küchen-Bild) — skaliert nur das EMPFANGENE Bild
 * der jeweils anderen Seite (< 1 = verkleinert = wirkt weiter weg). Der
 * gesendete Kamera-Track selbst wird nirgends gezoomt. Referenzwert 0.53 aus
 * ROOM_FACE_SCALE (useFaceDetection.js) übernommen, unabhängig feinjustierbar.
 */
export const ROOM_VIDEO_SCALE = {
  labor:  1.0,    // zeigt die Küche — bereits "natürlich" (User-Beobachtung)
  kueche: 1.0,   // zeigt das Labor — wirkte deutlich vergrößert
};

// ── intern ──────────────────────────────────────────────────────────────────
const BRIDGE_CHANNEL = 'public-display-bridge';
/** Selbstheilung wie beim Signaling-Reconnect: 1 s, 2 s, 4 s, 8 s, Deckel */
const BRIDGE_RETRY_BASE_MS = 1_000;
const BRIDGE_RETRY_MAX_MS  = 10_000;

// ═════════════════════════════════════════════════════════════════════════
// MASTER-SEITE (main-Fenster): baut die Brücke, speist den Remote-Track ein
// ═════════════════════════════════════════════════════════════════════════

/**
 * @param {Object}  options
 * @param {boolean} options.enabled – Brücke überhaupt aufbauen?
 * @param {MediaStream|null} options.stream – aktueller Remote-Stream des
 *        Anrufs (oder Loopback im Testmodus); null = kein Anruf.
 * @returns {{ bridgeConnected: boolean, viewerOk: boolean }}
 */
export function useDisplayBridgeMaster({ enabled, stream }) {
  const [bridgeConnected, setBridgeConnected] = useState(false);
  /** aux meldet über bridge-status, ob wirklich Frames ankommen */
  const [viewerOk, setViewerOk] = useState(true);

  const pcRef      = useRef(null);
  const senderRef  = useRef(null);
  const genRef     = useRef(0);       // Generationszähler gegen veraltete SDP/ICE
  const retryRef   = useRef(null);
  const attemptRef = useRef(0);
  const pendingIceRef = useRef([]);   // aux-Kandidaten vor der Answer puffern
  const streamRef  = useRef(stream);
  useEffect(() => { streamRef.current = stream; }, [stream]);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const channel = new BroadcastChannel(BRIDGE_CHANNEL);

    // Aktuellen Anruf-Track in den vorhandenen Sender einspeisen —
    // NIE ein Neuaufbau der Verbindung (siehe Kopf-Dokumentation)
    const applyCurrentTrack = () => {
      const sender = senderRef.current;
      if (!sender) return;
      const track = streamRef.current?.getVideoTracks?.()[0] ?? null;
      sender.replaceTrack(track).catch((err) => {
        console.warn('[Brücke] replaceTrack fehlgeschlagen:', err?.message ?? err);
      });
    };

    const scheduleRebuild = () => {
      if (disposed || retryRef.current) return;
      const attempt = Math.min(attemptRef.current + 1, 10);
      attemptRef.current = attempt;
      const delay = Math.min(BRIDGE_RETRY_BASE_MS * 2 ** (attempt - 1), BRIDGE_RETRY_MAX_MS);
      console.warn(`[Brücke] Verbindung verloren – Neuaufbau in ${delay / 1000}s`);
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        buildBridge();
      }, delay);
    };

    const buildBridge = async () => {
      if (disposed) return;
      genRef.current += 1;
      const gen = genRef.current;
      pendingIceRef.current = [];
      try { pcRef.current?.close(); } catch { /* war ggf. schon zu */ }

      const pc = new RTCPeerConnection({ iceServers: [] });   // rein lokal
      pcRef.current = pc;
      // Videoleitung VON ANFANG AN aushandeln (auch ohne Track) —
      // spätere Anrufe brauchen dann nur noch replaceTrack
      const transceiver = pc.addTransceiver('video', { direction: 'sendonly' });
      senderRef.current = transceiver.sender;

      // Ohne setParameters fällt Chromium auf ~2,5 Mbit/s zurück statt der
      // Bitrate des echten Anrufs, sonst wirkt die aux-Bildhälfte sichtbar
      // weicher. Muss NACH addTransceiver gesetzt werden (der Sender
      // existiert erst dann); die Parameter gelten schon vor dem ersten
      // replaceTrack().
      if (transceiver.sender.setParameters) {
        const params = transceiver.sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate   = VIDEO_MAX_BITRATE;
        params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE;
        transceiver.sender.setParameters(params).catch((err) => {
          console.warn('[Brücke] Sender-Parameter nicht setzbar:', err?.message ?? err);
        });
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          channel.postMessage({ type: 'bridge-ice', from: 'main', gen, candidate: candidate.toJSON() });
        }
      };
      pc.onconnectionstatechange = () => {
        if (disposed || gen !== genRef.current) return;
        const s = pc.connectionState;
        console.info('[Brücke] Zustand:', s);
        if (s === 'connected') {
          attemptRef.current = 0;
          setBridgeConnected(true);
          setViewerOk(true);          // frisch verbunden: Viewer neu bewerten
          applyCurrentTrack();        // laufenden Anruf nach Rebuild wieder einspeisen
        }
        if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          setBridgeConnected(false);
          scheduleRebuild();
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        channel.postMessage({ type: 'bridge-offer', gen, sdp: offer });
      } catch (err) {
        console.warn('[Brücke] Offer fehlgeschlagen:', err?.message ?? err);
        scheduleRebuild();
      }
    };

    channel.onmessage = async ({ data }) => {
      if (!data || disposed) return;

      // aux ist (neu) da → frische Brücke (deckt aux-Reload ab)
      if (data.type === 'bridge-hello') buildBridge();

      if (data.type === 'bridge-answer' && data.gen === genRef.current) {
        try {
          await pcRef.current?.setRemoteDescription(data.sdp);
          for (const c of pendingIceRef.current) {
            try { await pcRef.current?.addIceCandidate(c); } catch { /* egal */ }
          }
          pendingIceRef.current = [];
        } catch (err) {
          console.warn('[Brücke] Answer fehlgeschlagen:', err?.message ?? err);
        }
      }

      if (data.type === 'bridge-ice' && data.from === 'aux' && data.gen === genRef.current) {
        const pc = pcRef.current;
        if (pc?.remoteDescription) {
          try { await pc.addIceCandidate(data.candidate); } catch { /* egal */ }
        } else {
          pendingIceRef.current.push(data.candidate);
        }
      }

      // aux meldet, ob wirklich Bild ankommt (Fallback-Entscheidung)
      if (data.type === 'bridge-status') setViewerOk(!!data.ok);
    };

    // Falls aux schon offen ist: es antwortet auf den Ping mit bridge-hello
    channel.postMessage({ type: 'bridge-ping' });

    return () => {
      disposed = true;
      clearTimeout(retryRef.current);
      retryRef.current = null;
      try { pcRef.current?.close(); } catch { /* egal */ }
      pcRef.current = null;
      senderRef.current = null;
      channel.close();
      setBridgeConnected(false);
    };
  }, [enabled]);

  // Anrufzyklus (Anruf 1 → Ende → Anruf 2 → …): NUR der Track wechselt.
  // stream=null (end_call) → replaceTrack(null); neuer Anruf → neuer Track.
  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0] ?? null;

    // Verhindert einen Deadlock: meldet aux einmal "keine Frames" und
    // stoppt dann seinen Watchdog (merged abgeschaltet), würde es nie
    // wieder ok=true melden. Der Viewer bekommt daher bei jedem Anrufende
    // (Track entfernt) eine frische Chance.
    if (track === null) setViewerOk(true);

    const sender = senderRef.current;
    if (!sender) return;   // Brücke (noch) nicht bereit — applyCurrentTrack()
                           // beim connected-Ereignis holt das nach
    sender.replaceTrack(track).catch((err) => {
      console.warn('[Brücke] replaceTrack fehlgeschlagen:', err?.message ?? err);
    });
  }, [stream, bridgeConnected]);

  return { bridgeConnected, viewerOk };
}

// ═════════════════════════════════════════════════════════════════════════
// VIEWER-SEITE (aux-Fenster): empfängt den Stream, meldet Frame-Status
// ═════════════════════════════════════════════════════════════════════════

/**
 * @param {Object}  options
 * @param {boolean} options.enabled
 * @returns {{ bridgeStream: MediaStream|null,
 *             postStatus: (ok: boolean, reason?: string) => void }}
 */
export function useDisplayBridgeViewer({ enabled }) {
  const [bridgeStream, setBridgeStream] = useState(null);
  const channelRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let pc = null;
    let currentGen = -1;
    let pendingIce = [];
    const channel = new BroadcastChannel(BRIDGE_CHANNEL);
    channelRef.current = channel;

    const handleOffer = async (data) => {
      try { pc?.close(); } catch { /* egal */ }
      pendingIce = [];
      currentGen = data.gen;
      pc = new RTCPeerConnection({ iceServers: [] });
      const gen = data.gen;

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          channel.postMessage({ type: 'bridge-ice', from: 'aux', gen, candidate: candidate.toJSON() });
        }
      };
      // Das Track-Objekt bleibt über alle Anrufe dasselbe (muted/unmuted) —
      // ontrack feuert nur einmal pro Brücken-Generation
      pc.ontrack = ({ track, streams }) => {
        console.info('[Brücke] Video-Track empfangen');
        setBridgeStream(streams?.[0] ?? new MediaStream([track]));
      };

      await pc.setRemoteDescription(data.sdp);
      for (const c of pendingIce) {
        try { await pc.addIceCandidate(c); } catch { /* egal */ }
      }
      pendingIce = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      channel.postMessage({ type: 'bridge-answer', gen, sdp: answer });
    };

    channel.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'bridge-offer') {
        handleOffer(data).catch((err) => {
          console.warn('[Brücke] Offer-Verarbeitung fehlgeschlagen:', err?.message ?? err);
        });
      }
      if (data.type === 'bridge-ping') channel.postMessage({ type: 'bridge-hello' });
      if (data.type === 'bridge-ice' && data.from === 'main') {
        if (pc?.remoteDescription && data.gen === currentGen) {
          pc.addIceCandidate(data.candidate).catch(() => { /* egal */ });
        } else {
          pendingIce.push(data.candidate);
        }
      }
    };

    // Beim (Neu-)Laden des aux-Fensters: Master um eine frische Brücke bitten
    channel.postMessage({ type: 'bridge-hello' });

    return () => {
      try { pc?.close(); } catch { /* egal */ }
      channel.close();
      channelRef.current = null;
      setBridgeStream(null);
    };
  }, [enabled]);

  /** Frame-Status an den Master melden (Fallback-Entscheidung, CSV) */
  const postStatus = useCallback((ok, reason = '') => {
    channelRef.current?.postMessage({ type: 'bridge-status', ok, reason });
  }, []);

  return { bridgeStream, postStatus };
}

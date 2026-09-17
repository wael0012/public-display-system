/**
 * AuxScreenApp.jsx
 *
 * @fileoverview Eigenständiges Hilfs-Display-Fenster (?screen=aux) im
 * Two-Window-Modus. Bewusst PASSIV: kein eigenes Signaling (der Server
 * zählt Verbindungen als Anruf-Peers) und keine Gesichtserkennung. Der
 * Master (App.jsx, ?screen=main) sendet Zustand/Zone/Proximity/faceX per
 * BroadcastChannel; dieses Fenster rendert daraus nur AuxDisplay.jsx
 * (Proxemic-Ring + Anleitung, im ACTIVE-Zustand die Audio-Wellenform).
 * Öffnet im ACTIVE-Zustand zusätzlich kurz die eigene Kamera, da
 * MediaStreams sich nicht fensterübergreifend teilen lassen.
 *
 * @author Wael Hammami
 */

import React, { useEffect, useRef, useState } from 'react';
import AuxDisplay from './AuxDisplay.jsx';
import StartGate from './StartGate.jsx';
import { visualBus } from './visualBus.js';
import {
  useDisplayBridgeViewer,
  MERGED_DISPLAY_ENABLED,
  BEZEL_COMPENSATION_PX,
  SELF_VIEW_MODE,
  MERGE_OFFSET_PERCENT,
} from './displayBridge.js';

/** Kanalname des Master→Aux-Syncs (muss mit App.jsx übereinstimmen). */
export const VISUAL_SYNC_CHANNEL = 'public-display-state';

/** Testmodus-Badge auch im aux-Fenster anzeigen (?debug=1) */
const DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === '1';
/** Autostart: s. ausführliche Begründung in App.jsx/StartGate.jsx */
const AUTO_START = new URLSearchParams(window.location.search).get('autostart') === '1';
const DEBUG_BADGE = {
  position: 'fixed', top: '12px', right: '16px', zIndex: 10001,
  padding: '3px 10px', borderRadius: '12px',
  background: 'rgba(180,40,40,0.35)', color: 'rgba(255,200,200,0.85)',
  fontFamily: "'Courier New', monospace", fontSize: '11px',
  letterSpacing: '2px', pointerEvents: 'none',
};

export default function AuxScreenApp() {
  const [snap, setSnap] = useState({ state: 'AMBIENT', zone: 'ambient', proximity: 0 });
  const [selfStream, setSelfStream] = useState(null);
  /** Auch das aux-Fenster braucht seine eigene Nutzergeste für Vollbild */
  const [displayStarted, setDisplayStarted] = useState(false);

  // Zustand vom Master empfangen
  useEffect(() => {
    let channel = null;
    try {
      channel = new BroadcastChannel(VISUAL_SYNC_CHANNEL);
      channel.onmessage = (ev) => {
        const d = ev.data;
        if (!d || d.type !== 'visual') return;
        // Zeitstempel bei jeder Nachricht setzen, auch wenn sich die Werte
        // nicht geändert haben (das deduplizierte setSnap unten würde das
        // sonst verschlucken) — AuxDisplay.jsx pollt ihn, um eine
        // ausbleibende Übertragung (Haupt-Fenster gecrasht/gedrosselt) zu
        // erkennen.
        visualBus.lastVisualMsgAt = Date.now();
        // hochfrequente Werte am React-State vorbei (siehe visualBus.js)
        visualBus.faceX         = d.faceX ?? 0;
        visualBus.proximity     = d.proximity ?? 0;
        visualBus.dwellProgress = d.dwellProgress ?? 0;   // Teil A3 → Ring
        setSnap((prev) => (
          prev.state === d.state && prev.zone === d.zone
            && prev.proximity === d.proximity
            && prev.dwellProgress === (d.dwellProgress ?? 0)
            && prev.merged === (d.merged ?? false)
            && prev.bezelPx === (d.bezelPx ?? BEZEL_COMPENSATION_PX)
            && prev.selfViewMode === (d.selfViewMode ?? SELF_VIEW_MODE)
            && prev.mergeOffsetPercent === (d.mergeOffsetPercent ?? MERGE_OFFSET_PERCENT)
            // Fehlt das Feld (ältere Nachricht, z.B. während eines
            // Deploys), gilt false.
            && prev.remotePresent === (d.remotePresent ?? false)
            ? prev
            : {
                state: d.state, zone: d.zone, proximity: d.proximity,
                dwellProgress: d.dwellProgress ?? 0,
                merged:       d.merged ?? false,
                bezelPx:      d.bezelPx ?? BEZEL_COMPENSATION_PX,
                selfViewMode: d.selfViewMode ?? SELF_VIEW_MODE,
                mergeOffsetPercent: d.mergeOffsetPercent ?? MERGE_OFFSET_PERCENT,
                remotePresent: d.remotePresent ?? false,
              }
        ));
      };
    } catch (err) {
      console.error('[AuxScreen] BroadcastChannel nicht verfügbar:', err);
    }
    return () => channel?.close();
  }, []);

  // ── MERGED DISPLAY: permanente Brücke (Viewer-Seite) + Frame-Watchdog ──
  // Die Brücke liefert den Remote-Stream des Masters; ob wirklich Bild
  // ankommt, prüft der Watchdog über track.muted (replaceTrack(null) beim
  // end_call setzt den Track auf muted, ein echter Anruf-Track liefert
  // Frames → unmuted). Bei Problemen: lokaler Fallback auf Self-View UND
  // Meldung an den Master, damit BEIDE Fenster gemeinsam zurückfallen.
  const { bridgeStream, postStatus } = useDisplayBridgeViewer({
    enabled: MERGED_DISPLAY_ENABLED,
  });
  const [bridgeOk, setBridgeOk] = useState(true);
  const lastStatusRef = useRef(null);

  useEffect(() => {
    const mergedWanted = snap.state === 'ACTIVE' && snap.merged;
    if (!mergedWanted) {
      setBridgeOk(true);
      lastStatusRef.current = null;
      return undefined;
    }
    const check = () => {
      const track = bridgeStream?.getVideoTracks?.()[0];
      const ok = !!track && track.muted === false;
      setBridgeOk(ok);
      // Nur bei ÄNDERUNG melden (kein CSV-/Kanal-Spam)
      if (lastStatusRef.current !== ok) {
        lastStatusRef.current = ok;
        postStatus(ok, ok ? '' : (bridgeStream ? 'track_muted' : 'no_stream'));
      }
    };
    const t  = setTimeout(check, 2_500);   // Anlauf-Karenz nach ACTIVE-Beginn
    const iv = setInterval(check, 5_000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [snap.state, snap.merged, bridgeStream, postStatus]);

  // Self-View: eigene Kamera nur während ACTIVE öffnen, danach sofort freigeben
  const isActive = snap.state === 'ACTIVE';
  useEffect(() => {
    if (!isActive) return undefined;
    let stream = null;
    let cancelled = false;
    // Bewusst klein (640×360, KEIN Audio): zweiter, paralleler Zugriff auf
    // dieselbe Kamera — Chromium teilt das Gerät zwischen Tabs/Fenstern,
    // die niedrige Auflösung minimiert die Last neben dem Master-Stream.
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
      audio: false,
    })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        setSelfStream(s);
      })
      .catch((err) => {
        console.warn('[AuxScreen] Self-View-Kamera nicht verfügbar:', err?.name ?? err);
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setSelfStream(null);
    };
  }, [isActive]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050505', overflow: 'hidden' }}>
      {!displayStarted && (
        <StartGate onStarted={() => setDisplayStarted(true)} autoStart={AUTO_START} />
      )}
      {DEBUG_MODE && <div style={DEBUG_BADGE}>TESTMODUS</div>}
      <AuxDisplay
        state={snap.state}
        proximity={snap.proximity}
        localStream={selfStream}
        zone={snap.zone}
        dwellProgress={snap.dwellProgress ?? 0}
        merged={(snap.merged ?? false) && bridgeOk}
        bridgeStream={bridgeStream}
        bezelPx={snap.bezelPx ?? BEZEL_COMPENSATION_PX}
        selfViewMode={snap.selfViewMode ?? SELF_VIEW_MODE}
        mergeOffsetPercent={snap.mergeOffsetPercent ?? MERGE_OFFSET_PERCENT}
        remotePresent={snap.remotePresent ?? false}
      />
    </div>
  );
}

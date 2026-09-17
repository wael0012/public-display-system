/**
 * StartGate.jsx
 *
 * @fileoverview Start-Button "Display starten" — die eine Nutzergeste, die
 * ein Public Display braucht: Browser verlangen für Vollbild und Ton eine
 * Nutzergeste, ein unbeaufsichtigtes Display hat im Betrieb aber keine. Ein
 * Klick bündelt daher Vollbild, Audio-Freigabe (onStarted → audioUnlocked),
 * Cursor ausblenden und Wake Lock; danach läuft alles automatisch. Jedes
 * Fenster (main UND aux) braucht seinen eigenen Klick.
 *
 * ?autostart=1 (von den .bat-Skripten gesetzt) löst denselben handleStart()
 * beim Mount aus statt auf einen Klick zu warten — Vollbild und Ton laufen
 * dann stattdessen über Chrome-Startflags (--kiosk,
 * --autoplay-policy=no-user-gesture-required), da die Browser-APIs sonst
 * weiterhin eine echte Geste verlangen; Cursor-CSS und Wake Lock brauchten
 * ohnehin nie eine Geste.
 *
 * @author Wael Hammami
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

const StartGate = ({ onStarted, autoStart = false }) => {
  const [started, setStarted] = useState(false);
  const wakeLockRef = useRef(null);

  /** Wake Lock anfordern; Fehler sind nicht fatal (ältere Browser/HTTP). */
  const requestWakeLock = useCallback(async () => {
    try {
      if (!('wakeLock' in navigator)) return;
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      console.info('[StartGate] Wake Lock aktiv');
      // Bei Verlust (Browser gibt ihn z.B. beim Minimieren frei) neu anfordern:
      // sichtbare Seite → sofort; versteckte Seite → beim nächsten
      // visibilitychange (siehe Effekt unten). Ohne den Sofort-Pfad bliebe
      // der Lock nach einem Release bei sichtbarer Seite bis zum nächsten
      // Tab-Wechsel weg.
      wakeLockRef.current.addEventListener('release', () => {
        console.info('[StartGate] Wake Lock verloren');
        wakeLockRef.current = null;
        if (document.visibilityState === 'visible') {
          setTimeout(() => {
            if (!wakeLockRef.current) requestWakeLock();
          }, 1_000);
        }
      });
    } catch (err) {
      console.warn('[StartGate] Wake Lock nicht verfügbar:', err?.message ?? err);
    }
  }, []);

  // Nach Sichtbarkeitswechsel (Tab wieder aktiv) verlorenen Wake Lock erneuern
  useEffect(() => {
    if (!started) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !wakeLockRef.current) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [started, requestWakeLock]);

  const handleStart = useCallback(async () => {
    // 1. Vollbild — muss SYNCHRON in der Geste angestoßen werden
    try {
      await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn('[StartGate] Vollbild abgelehnt:', err?.message ?? err);
    }
    // 2. Mauszeiger verstecken (Public Display)
    document.body.style.cursor = 'none';
    // 3. Wake Lock
    await requestWakeLock();
    // 4. Button weg + Audio freigeben (audioUnlocked im Parent)
    setStarted(true);
    onStarted?.();
  }, [onStarted, requestWakeLock]);

  // Autostart: löst handleStart() einmal beim Mount aus, ohne auf einen
  // Klick zu warten — NUR wenn autoStart=true (s. Dateikopf). Bewusst
  // leeres Deps-Array: soll genau einmal pro Mount feuern, nicht bei jeder
  // (stabilen) Neuerzeugung von handleStart.
  useEffect(() => {
    if (autoStart) handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (started) return null;

  return (
    <div style={S.overlay}>
      <button type="button" style={S.button} onClick={handleStart}>
        <span style={S.de}>Display starten</span>
        <span style={S.en}>Start display</span>
      </button>
    </div>
  );
};

const S = {
  overlay: {
    position:       'fixed',
    inset:          0,
    zIndex:         10000,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    background:     '#050608',
  },
  button: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           '8px',
    padding:       '28px 64px',
    background:    'rgba(212,175,90,0.06)',
    border:        '1px solid rgba(212,175,90,0.45)',
    borderRadius:  '14px',
    cursor:        'pointer',
    color:         '#e8c979',
  },
  de: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(22px, 2.2vw, 34px)',
    fontWeight:    500,
    letterSpacing: '0.04em',
  },
  en: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(13px, 1.1vw, 18px)',
    fontWeight:    300,
    color:         'rgba(232,201,121,0.6)',
    letterSpacing: '0.06em',
  },
};

export default StartGate;

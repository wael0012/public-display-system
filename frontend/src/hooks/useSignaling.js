/**
 * useSignaling.js
 *
 * @fileoverview React-Hook für die WebSocket-Verbindung zum Signaling-Server
 * (backend/signaling_server.py): Verbindungsaufbau, automatische Wiederver-
 * bindung (Exponential-Backoff) und Heartbeat-Überwachung. Wird von App.jsx
 * verwendet; useWebRTC.js sendet seine Offer/Answer/ICE-Nachrichten über den
 * hier bereitgestellten sendMessage-Kanal.
 *
 * Liefert bewusst KEINE Anruf-Rolle (caller/callee) — der Server entscheidet
 * zentral, wann ein Anruf beginnt, und teilt die Rolle explizit per
 * "start_call"-Nachricht mit (an App.jsx über onMessage weitergereicht).
 *
 * @author Wael Hammami
 */

import { useEffect, useRef, useState, useCallback } from 'react';

/** Heartbeat alle 5 s — Grundlage der Tote-Verbindung-Erkennung */
const HEARTBEAT_MS = 5_000;

/** Kommt so lange kein Pong (heartbeat_ack), gilt die Verbindung als
 *  TOT und wird aktiv geschlossen → Reconnect. Fängt "hängende" Sockets ab,
 *  die nie ein sauberes close liefern. */
const HEARTBEAT_TIMEOUT_MS = 15_000;

/** Exponentieller Backoff 1 s → 2 s → 4 s → 8 s, gedeckelt bei
 *  RECONNECT_MAX_MS; danach unbegrenzt alle 10 s weiter versuchen.
 *  Das Display muss sich stundenlang selbst reparieren können. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 10_000;

/**
 * @typedef {Object} SignalingHookResult
 * @property {Function}  sendMessage     – Sendet eine JSON-Nachricht an den Server.
 * @property {string}    connectionState – 'disconnected' | 'connecting' | 'connected'
 * @property {string|null} clientId      – Vom Server zugewiesene Client-ID.
 */

/**
 * Stellt eine verwaltete WebSocket-Verbindung zum Signaling-Server bereit.
 *
 * @param {Object}   options
 * @param {string}   options.serverUrl  – WebSocket-URL des Signaling-Servers.
 * @param {Function} options.onMessage  – Callback für eingehende Nachrichten.
 * @returns {SignalingHookResult}
 */
export function useSignaling({ serverUrl, onMessage }) {
  // Verbindungszustand für die UI
  const [connectionState, setConnectionState] = useState('disconnected');
  const [clientId, setClientId]               = useState(null);

  // Refs damit Callbacks immer auf die aktuellsten Werte zugreifen
  const wsRef             = useRef(null);
  const onMessageRef      = useRef(onMessage);
  const heartbeatRef      = useRef(null);
  const reconnectRef      = useRef(null);
  const isUnmountedRef    = useRef(false);
  const reconnectAttemptRef = useRef(0); // für Exponential-Backoff
  const connectRef        = useRef(null); // Indirektion, damit scheduleReconnect() connect() aufrufen kann
  const lastPongRef       = useRef(0);   // Zeitpunkt des letzten heartbeat_ack
  // true, sobald der Server diesen Client per {type:"superseded"} verdrängt
  // hat (neue main-Verbindung derselben IP). Der direkt darauf folgende
  // Verbindungsabbau darf dann KEINEN Reconnect auslösen — sonst würde
  // dieses veraltete Fenster versuchen, die neue, gültige Verbindung
  // seinerseits zu verdrängen (Ping-Pong). Ein neuer main-Wunsch braucht
  // einen Seiten-Reload.
  const supersededRef     = useRef(false);

  // onMessage-Ref aktuell halten ohne Neuverbindung auszulösen
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  /**
   * Plant einen Reconnect-Versuch mit Exponential-Backoff (3 s, 6 s, 12 s,
   * gedeckelt bei RECONNECT_DELAY_MAX). Verhindert, dass bei einem länger
   * gestörten Server ständig im 3-Sekunden-Takt neue Verbindungen (und
   * damit neue Client-IDs/Rollen-Neuberechnungen) erzeugt werden.
   * Nutzt connectRef statt direkt `connect`, um die zirkuläre Abhängigkeit
   * connect ↔ scheduleReconnect ohne Re-Erzeugung beider Callbacks aufzulösen.
   */
  const scheduleReconnect = useCallback(() => {
    clearTimeout(reconnectRef.current);
    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    // 1 s, 2 s, 4 s, 8 s … gedeckelt bei RECONNECT_MAX_MS, unbegrenzt
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    console.warn(`[Signaling] Verbindung verloren, neuer Versuch in ${delay / 1000}s (Nr. ${attempt})`);
    reconnectRef.current = setTimeout(() => connectRef.current?.(), delay);
  }, []);

  /**
   * Baut die WebSocket-Verbindung auf und registriert alle Ereignishandler.
   *
   * Idempotenz-Guard: Falls bereits ein Socket existiert, das gerade
   * verbindet (CONNECTING) oder offen ist (OPEN), wird KEINE zweite
   * Verbindung aufgebaut. Das schützt gegen jede Art von Doppel-Aufruf
   * (z.B. falls connect() durch einen Bug oder künftige Code-Änderungen
   * mehrfach ausgelöst wird) — pro Seite darf immer nur ein Socket parallel
   * existieren.
   */
  const connect = useCallback(() => {
    if (isUnmountedRef.current) return;

    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
      console.warn('[Signaling] connect() übersprungen – es existiert bereits ein aktiver Socket');
      return;
    }

    // Eventuell noch ausstehenden Reconnect-Timer verwerfen (verhindert
    // doppelt geplante Reconnects, falls connect() aus mehreren Quellen
    // ausgelöst wird)
    clearTimeout(reconnectRef.current);
    reconnectRef.current = null;

    setConnectionState('connecting');

    let ws;
    try {
      ws = new WebSocket(serverUrl);
    } catch (err) {
      console.error('[Signaling] Verbindungsfehler:', err);
      scheduleReconnect();
      return;
    }

    wsRef.current = ws;

    // ----------------------------------------------------------------
    // Verbindung geöffnet
    // ----------------------------------------------------------------
    ws.onopen = () => {
      if (isUnmountedRef.current || wsRef.current !== ws) return;
      const wasReconnect = reconnectAttemptRef.current > 0;
      if (wasReconnect) {
        console.info('[Signaling] Wieder verbunden');
        // Reconnect-Erfolg inkl. Versuchszähler loggen. Einzelne
        // reconnect_attempt-Events kann der Client nicht senden (die
        // Verbindung ist in dem Moment ja weg) — der Zähler steckt deshalb
        // im extra-Feld dieses Events.
        ws.send(JSON.stringify({
          type:  'client_event',
          event: 'reconnect_success',
          extra: `attempts=${reconnectAttemptRef.current}`,
        }));
      } else {
        console.info('[Signaling] Verbunden mit', serverUrl);
      }
      setConnectionState('connected');
      reconnectAttemptRef.current = 0; // Backoff nach erfolgreicher Verbindung zurücksetzen
      lastPongRef.current = Date.now();

      // Heartbeat + Watchdog — alle HEARTBEAT_MS ein Ping; bleibt der
      // Pong (heartbeat_ack) HEARTBEAT_TIMEOUT_MS aus, gilt der Socket als
      // tot und wird AKTIV geschlossen → onclose → Reconnect. Das
      // fängt hängende Verbindungen ab, die nie sauber schließen.
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
          if (Date.now() - lastPongRef.current > HEARTBEAT_TIMEOUT_MS) {
            console.warn('[Signaling] Kein Pong seit '
              + `${HEARTBEAT_TIMEOUT_MS / 1000}s – Verbindung gilt als tot, schließe Socket`);
            ws.close(4000, 'Heartbeat-Timeout');
          }
        }
      }, HEARTBEAT_MS);
    };

    // ----------------------------------------------------------------
    // Eingehende Nachricht
    // ----------------------------------------------------------------
    ws.onmessage = (event) => {
      if (isUnmountedRef.current || wsRef.current !== ws) return;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn('[Signaling] Ungültige JSON-Nachricht:', event.data);
        return;
      }

      // Willkommensnachricht: eigene Client-ID aus der Serverantwort lesen.
      // KEINE Rolle mehr hier — die kommt ausschließlich per "start_call"
      // vom Server, sobald er entscheidet, dass ein Anruf beginnen soll.
      if (data.type === 'welcome') {
        setClientId(data.clientId);
        console.info('[Signaling] Willkommen – ID:', data.clientId);
      }

      // Pong registrieren — der Watchdog misst die Zeit seit dem letzten
      if (data.type === 'heartbeat_ack') {
        lastPongRef.current = Date.now();
      }

      // Server hat diese Verbindung verdrängt (neue main-Verbindung
      // derselben IP, s. Backend ConnectionManager._evict) — der gleich
      // folgende close() darf keinen Reconnect auslösen.
      if (data.type === 'superseded') {
        supersededRef.current = true;
        console.warn(
          '[Signaling] Diese Verbindung wurde vom Server verdrängt '
          + `(${data.reason ?? 'unbekannter Grund'}) — vermutlich läuft in einem `
          + 'anderen Fenster/Tab bereits eine neuere main-Verbindung von diesem '
          + 'Rechner. Dieses Fenster verbindet sich NICHT automatisch neu '
          + '(Seite neu laden, falls es doch das gültige Fenster sein soll).',
        );
      }

      // Alle Nachrichten (inkl. start_call/end_call/offer/answer/...) an den
      // aufrufenden Hook (App.jsx) weitergeben.
      onMessageRef.current?.(data);
    };

    // ----------------------------------------------------------------
    // Verbindung geschlossen
    // ----------------------------------------------------------------
    ws.onclose = (event) => {
      // wsRef.current !== ws: dieses Schließen gehört zu einem bereits
      // ersetzten/alten Socket (z.B. weil connect() zwischenzeitlich erneut
      // lief) — dann NICHT nochmal einen Reconnect einplanen, sonst könnten
      // zwei überlappende Reconnect-Ketten entstehen.
      if (isUnmountedRef.current || wsRef.current !== ws) return;
      console.warn('[Signaling] Verbindung getrennt – Code:', event.code);
      setConnectionState('disconnected');
      clearInterval(heartbeatRef.current);
      if (supersededRef.current) {
        console.warn('[Signaling] Kein Reconnect – Verbindung wurde verdrängt (s. vorige Meldung)');
        return;
      }
      scheduleReconnect();
    };

    // ----------------------------------------------------------------
    // Verbindungsfehler
    // ----------------------------------------------------------------
    ws.onerror = (error) => {
      console.error('[Signaling] WebSocket-Fehler:', error);
      // onclose wird direkt danach aufgerufen und übernimmt den Reconnect
    };
  }, [serverUrl, scheduleReconnect]);

  // connectRef immer aktuell halten, damit scheduleReconnect() (die vor
  // connect definiert ist und nur einmal erzeugt wird) immer die neueste
  // connect-Funktion aufruft.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Verbindung beim ersten Rendern aufbauen
  useEffect(() => {
    isUnmountedRef.current = false;
    connect();

    return () => {
      // Aufräumen beim Unmounten der Komponente
      isUnmountedRef.current = true;
      clearInterval(heartbeatRef.current);
      clearTimeout(reconnectRef.current);
      wsRef.current?.close(1000, 'Komponentenabriss');
    };
  }, [connect]);

  // Geister-Verbindungen verhindern: Beim Verlassen/Neuladen der Seite den
  // Socket SAUBER schließen (Close-Frame), damit der Server den Client
  // sofort austrägt. Ohne das bleibt nach einem abrupten Reload (F5,
  // Vite-Reload) eine tote Verbindung auf dem Server zurück, die einen der
  // beiden Anruf-Slots blockiert ("2 Clients" trotz eines Fensters).
  // Rein additiv — ändert nichts an der Anruf-Logik.
  useEffect(() => {
    const onPageHide = () => {
      // Nur schließen — bewusst KEIN isUnmountedRef/Timer-Stopp: Wird die
      // Seite aus dem Back-Forward-Cache wiederhergestellt, sorgt der
      // normale onclose→scheduleReconnect-Pfad automatisch für eine neue
      // Verbindung. Beim echten Verlassen stirbt die Seite ohnehin.
      wsRef.current?.close(1000, 'Seite verlassen');
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  /**
   * Sendet eine Nachricht als JSON an den Signaling-Server.
   *
   * @param {Object} message – Das zu sendende Nachrichtenobjekt.
   */
  const sendMessage = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('[Signaling] Nachricht verworfen – Verbindung nicht offen:', message);
    }
  }, []);

  return { sendMessage, connectionState, clientId };
}

/**
 * MainDisplay.jsx
 *
 * @fileoverview HAUPT-Display (linke Hälfte im Split-Layout bzw. eigenes
 * Fenster bei ?screen=main). Wird von App.jsx gerendert und bekommt appState/
 * zone/remoteStream/localStream als Props; nutzt AmbientScene.jsx als
 * permanent gemountete Hintergrundszene und displayBridge.js-Konstanten für
 * das (aktuell deaktivierte) Merged-Display-Feature.
 *
 * Zone A/B/C steuern Partikelruhe/Annäherungshinweis/Fokus-Linse (CALM
 * TECHNOLOGY, FEEDFORWARD); im ACTIVE-Zustand öffnet sich das Remote-Video
 * als wachsender Kreis aus der Linse (HOLE IN SPACE, Galloway & Rabinowitz
 * 1980) und schließt sich beim Anrufende wieder symmetrisch.
 *
 * Übergangs-Phasen: 'ambient' → 'opening' → 'video' → 'closing' → 'ambient'
 *
 * @author Wael Hammami
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import AmbientScene from './AmbientScene.jsx';
import { visualBus } from './visualBus.js';
import { ROOM_VIDEO_SCALE, SELF_VIEW_WIDTH_PERCENT, SELF_VIEW_OPACITY } from './displayBridge.js';

/**
 * AmbientScene bleibt für alle Zonen/Zustände PERMANENT gemountet (nie
 * mounten/unmounten bei Zustandswechseln, sonst müsste ihr WebGL/Canvas-
 * Kontext bei jedem Wechsel neu aufgebaut werden) — nur ihre Opacity
 * wechselt per Crossfade, s. personDetected weiter unten.
 */
const PERSON_LOST_DEBOUNCE_MS = 3_000; // Rückblenden erst nach 3s stabiler Abwesenheit
const CALL_END_REARM_WINDOW_MS = 10_000; // nach Call-Ende: Re-Arm-Schutzfenster
const CALL_END_REARM_CONFIRM_MS = 2_000; // ...darin erst nach 2s DURCHGEHENDER Erkennung wieder rein
const SCENE_CROSSFADE_MS = 1_500;

/**
 * Gleicher ?room=-Parameter wie in useFaceDetection.js (dort für
 * ROOM_FACE_SCALE) — hier für die VISUELLE Größe des EMPFANGENEN Videos.
 * Eigenständig gelesen statt durchgereicht, damit MainDisplay unabhängig
 * von der Erkennungs-Pipeline bleibt.
 */
const ROOM_ID = (() => {
  try {
    return new URLSearchParams(window.location.search).get('room') === 'kueche'
      ? 'kueche' : 'labor';
  } catch { return 'labor'; }
})();
const VIDEO_SCALE = ROOM_VIDEO_SCALE[ROOM_ID] ?? 1.0;

// ── Stellschrauben des Video-Übergangs ──────────────────────────────────────
/** Kreis-Maske klein → formatfüllend (ms) */
const OPEN_MS = 1000;
/** Partikel-"Rahmen" fadet nach dem Öffnen aus (ms) */
const FRAME_FADE_MS = 800;
/** end_call: Kreis schrumpft, Partikel kehren zurück (ms) */
const CLOSE_MS = 900;
/** Kreis öffnet sich an der Linsen-Position: ±8 % Verschiebung durch faceX */
const FOCUS_MAX_SHIFT_PCT = 8;

// ---------------------------------------------------------------------------
// Botschaften pro Zone — bewusst DEZENT, klein, unten (kein aufdringlicher
// Text; Zone A ganz ohne: die Bewegung selbst signalisiert Bereitschaft)
// ---------------------------------------------------------------------------
const MESSAGES = {
  ambient:    null,
  awareness:  { de: 'Komm näher', en: 'Come closer' },
  engagement: { de: "Gleich geht's los …", en: 'Connecting soon …', white: true, pulse: true },
};

/** Im HANDSHAKE (WebRTC-Aushandlung läuft) ein freundlicher, ruhiger
 *  Übergangstext — kein abruptes Aufpoppen des Videos danach (die Kreis-
 *  Maske übernimmt das sanfte Einblenden). */
const CONNECTING_MSG = {
  de: 'Verbindung wird aufgebaut …', en: 'Connecting …', white: true, pulse: true,
};

const KEYFRAMES = `
  @keyframes mdMsgPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.78; } }
`;

/** Countdown-Overlay erscheint erst kurz vor Anrufende, nicht die ganzen
 *  25 s über — sonst würde er in aller Regel gar nicht bewusst wahr-
 *  genommen (Person meist längst zurück, bevor die Frist überhaupt naht). */
const COUNTDOWN_VISIBLE_AT_SEC = 20;
/** Wie oft die Restzeit neu berechnet wird (ms) — 250ms genügt für eine
 *  ruhige Sekunden-Anzeige, ohne unnötig oft zu rendern. */
const COUNTDOWN_TICK_MS = 250;

const MainDisplay = ({
  state, remoteStream, zone = 'ambient', audioUnlocked = false,
  merged = false, bezelPx = 0, mergeOffsetPercent = 0, localStream = null,
  presenceLostAt = null, callTimeoutMs = 25_000, remotePresent = false,
}) => {
  const isActive = state === 'ACTIVE';
  const videoRef = useRef(null);

  // Fester Bild-Versatz (Prozent der Bildschirmbreite → px) + Raum-Video-
  // Skalierung, NUR im Merged-Modus.
  // translateX zuerst (wirkt in Bildschirm-Pixeln), dann scale (Ursprung
  // Elementmitte) — reine CSS-Transform-Ebene, rührt an width/left (Bezel-
  // Mathematik) nichts an.
  const mergedTransform = merged
    ? `translateX(${(mergeOffsetPercent / 100) * window.innerWidth}px) scale(${VIDEO_SCALE})`
    : undefined;

  // ----------------------------------------------------------------
  // Übergangs-Phasen + Kreis-Maske
  // ----------------------------------------------------------------
  const [phase, setPhase]       = useState(isActive ? 'video' : 'ambient');
  const [maskOpen, setMaskOpen] = useState(isActive);
  /** x-Position (%) der Kreis-Maske — beim start_call an der Linse eingefroren */
  const focusXRef = useRef(50);

  useEffect(() => {
    if (isActive) {
      // Der Kreis öffnet sich DORT, wo die Linse gerade steht (faceX)
      focusXRef.current =
        50 + Math.max(-1, Math.min(1, visualBus.faceX)) * FOCUS_MAX_SHIFT_PCT;
      setPhase((prev) => (prev === 'video' ? 'video' : 'opening'));
      setMaskOpen(false);                       // Startzustand: Kreis zu
      const t1 = setTimeout(() => setPhase('video'), OPEN_MS + FRAME_FADE_MS);
      return () => clearTimeout(t1);
    }

    // ACTIVE verlassen (end_call): Kreis schrumpft, Partikel kehren zurück
    setMaskOpen(false);
    setPhase((prev) => (prev === 'video' || prev === 'opening' ? 'closing' : 'ambient'));
    const t = setTimeout(() => setPhase('ambient'), CLOSE_MS);
    return () => clearTimeout(t);
  }, [isActive]);

  // Öffnen erst NACH Commit + erzwungenem Layout-Flush: garantiert, dass die
  // clip-path-Transition wirklich vom circle(0%)-Zustand aus animiert. Ein
  // reiner Timeout kann unter Last (WebRTC-Verbindungsaufbau + MediaPipe)
  // mit dem ersten Paint kollidieren — dann landen Start- und Zielwert im
  // selben Style-Recalc und der Kreis "springt" statt zu wachsen.
  useLayoutEffect(() => {
    if (phase !== 'opening' || maskOpen) return undefined;
    const el = videoRef.current;
    if (el) void el.getBoundingClientRect();   // Layout mit circle(0%) flushen
    const raf = requestAnimationFrame(() => setMaskOpen(true));
    return () => cancelAnimationFrame(raf);
  }, [phase, maskOpen]);

  // ----------------------------------------------------------------
  // AUDIO: Das REMOTE-Video spielt mit Ton, sobald der Start-Button
  // geklickt wurde (audioUnlocked=true — die Nutzergeste schaltet die
  // Autoplay-Policy frei). Schlägt play() mit Ton dennoch fehl, wird stumm
  // gestartet (Bild vor Stille) und ein dezenter Hinweis eingeblendet.
  // ----------------------------------------------------------------
  const [audioBlocked, setAudioBlocked] = useState(false);

  // WICHTIG: isActive MUSS in den Abhängigkeiten stehen. Der Remote-Stream
  // trifft ein, BEVOR der Zustand ACTIVE wird (ontrack feuert vor
  // connectionState "connected") — zu dem Zeitpunkt ist das <video> noch
  // gar nicht gerendert. Ohne isActive-Dep bliebe srcObject für immer leer.
  useEffect(() => {
    const el = videoRef.current;
    if (el && remoteStream) {
      el.srcObject = remoteStream;
      el.muted = !audioUnlocked;
      el.play()
        .then(() => setAudioBlocked(false))
        .catch((err) => {
          console.warn('[MainDisplay] play() mit Ton abgelehnt – Fallback stumm:', err?.name ?? err);
          // Fallback: stumm abspielen, damit wenigstens das Bild läuft
          el.muted = true;
          setAudioBlocked(audioUnlocked);   // Hinweis nur, wenn Ton erwartet war
          el.play().catch((err2) => {
            console.warn('[MainDisplay] play() auch stumm abgelehnt:', err2?.name ?? err2);
          });
        });
    }
  }, [remoteStream, isActive, phase, audioUnlocked]);

  // ----------------------------------------------------------------
  // Self-View (von aux hierher verschoben): kleine eigene Kamera-Vorschau
  // unten rechts, NUR wenn nicht merged (im Merged-Modus zeigt aux bereits
  // die Corner-Self-View, s. AuxDisplay.jsx). Immer stumm (Rückkopplung).
  // ----------------------------------------------------------------
  const selfViewRef = useRef(null);
  // isActive in den Deps: gleicher Grund wie beim Remote-Video oben — das
  // <video> rendert erst ab ACTIVE, ohne die Dep bliebe srcObject leer.
  useEffect(() => {
    const el = selfViewRef.current;
    if (el && localStream) {
      el.srcObject = localStream;
      el.play().catch((err) => {
        console.warn('[MainDisplay] Self-View play() abgelehnt:', err?.name ?? err);
      });
    }
  }, [localStream, isActive, merged]);

  // ----------------------------------------------------------------
  // Countdown-Overlay: presenceLostAt (Zeitstempel aus App.jsx, s. dort)
  // ist gesetzt, sobald im ACTIVE-Zustand keine Präsenz mehr gemeldet wird.
  // Tickt nur, solange wirklich gezählt wird — kein Intervall im Leerlauf.
  // ----------------------------------------------------------------
  const [countdownNow, setCountdownNow] = useState(null);
  useEffect(() => {
    if (!isActive || presenceLostAt == null) return undefined;
    setCountdownNow(Date.now());   // sofort ab dem neuen presenceLostAt neu berechnen
    const id = setInterval(() => setCountdownNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [isActive, presenceLostAt]);

  const remainingSec = (isActive && presenceLostAt != null && countdownNow != null)
    ? Math.max(0, Math.ceil((callTimeoutMs - (countdownNow - presenceLostAt)) / 1000))
    : null;
  // Letzten bekannten Wert für das Ausblenden festhalten: presenceLostAt
  // fällt SOFORT auf null zurück, sobald Präsenz zurückkehrt — der 500ms-
  // Fade würde sonst eine leere Box zeigen statt sanft mit der Zahl zu
  // verschwinden.
  const lastRemainingSecRef = useRef(null);
  if (remainingSec != null) lastRemainingSecRef.current = remainingSec;
  const countdownDisplaySec = remainingSec ?? lastRemainingSecRef.current;
  const showCountdown = remainingSec != null && remainingSec <= COUNTDOWN_VISIBLE_AT_SEC;

  // ----------------------------------------------------------------
  // Botschaft: sanfter Crossfade beim Zonenwechsel
  // ----------------------------------------------------------------
  // Der Crossfade läuft über einen SCHLÜSSEL aus Zustand+Zone: so blendet
  // auch der Rückfall HANDSHAKE → AMBIENT (Handshake-Abbruch) sanft über,
  // statt hart umzuschalten.
  const msgKey = state === 'HANDSHAKE' ? 'connecting' : zone;
  const [displayKey, setDisplayKey] = useState(msgKey);
  const [msgVisible, setMsgVisible] = useState(false);

  useEffect(() => {
    if (isActive) { setMsgVisible(false); return undefined; }
    if (msgKey === displayKey) {
      const t = setTimeout(() => setMsgVisible(true), 60);
      return () => clearTimeout(t);
    }
    setMsgVisible(false);                       // alte Botschaft ausblenden …
    const t = setTimeout(() => {
      setDisplayKey(msgKey);                    // … dann Text tauschen
      setMsgVisible(true);                      // … und neue einblenden
    }, 400);
    return () => clearTimeout(t);
  }, [msgKey, displayKey, isActive]);

  const msg = displayKey === 'connecting'
    ? CONNECTING_MSG
    : (MESSAGES[displayKey] ?? null);

  const showVideo = phase === 'opening' || phase === 'video' || phase === 'closing';

  // ----------------------------------------------------------------
  // Personen-Erkennung mit Hysterese: steuert die Sternbewegung in
  // AmbientScene. Erkennen wechselt SOFORT (rawValue true → personDetected
  // sofort true); Verlieren blendet erst nach PERSON_LOST_DEBOUNCE_MS
  // stabiler Abwesenheit zurück, damit kurzes Flackern der Erkennung nicht
  // sofort durchschlägt.
  //
  // Direkt nach Call-Ende kann rawPersonDetected durch Phantom-Erkennungen
  // flackern und würde einen einfachen Rückblend-Timer immer wieder neu
  // starten, bevor er durchläuft. Deshalb: beim isActive-Übergang true→false
  // sofort FORCE-RESET auf false (kein Warten), und für
  // CALL_END_REARM_WINDOW_MS danach darf personDetected erst wieder auf true
  // springen, wenn rawPersonDetected CALL_END_REARM_CONFIRM_MS lang
  // durchgehend true war.
  // ----------------------------------------------------------------
  const rawPersonDetected = state !== 'AMBIENT' || zone !== 'ambient';
  const [personDetected, setPersonDetected] = useState(rawPersonDetected);
  const lastActiveExitAtRef = useRef(null);
  const prevIsActiveRef = useRef(isActive);

  useEffect(() => {
    if (prevIsActiveRef.current && !isActive) {
      lastActiveExitAtRef.current = Date.now();
      setPersonDetected(false);
    }
    prevIsActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    const inReArmWindow = lastActiveExitAtRef.current != null
      && (Date.now() - lastActiveExitAtRef.current) < CALL_END_REARM_WINDOW_MS;

    if (rawPersonDetected) {
      if (inReArmWindow) {
        const t = setTimeout(() => setPersonDetected(true), CALL_END_REARM_CONFIRM_MS);
        return () => clearTimeout(t);
      }
      setPersonDetected(true);
      return undefined;
    }
    const t = setTimeout(() => setPersonDetected(false), PERSON_LOST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rawPersonDetected]);

  // Beidseitige Präsenz: personDetected (lokale Präsenz, samt Hysterese/
  // Re-Arm oben) UND remotePresent zusammen steuern die Sternbewegung in
  // AmbientScene (starsMoving-Prop weiter unten). Steht die Gegenseite
  // NICHT (remotePresent=false), bleiben die Sterne ruhig — ein Fortschritt/
  // eine Bewegung für eine Verbindung, die mangels Gegenseite nicht zustande
  // kommen kann, führt in die Irre (gleiche Begründung wie im Aux-Ring, s.
  // AuxRingScene.jsx). Die Botschaften (msgKey/MESSAGES) hängen NICHT an
  // bothPresent — "Komm näher" etc. bleiben unberührt.
  const bothPresent = personDetected && remotePresent;

  return (
    <div style={S.root}>
      <style>{KEYFRAMES}</style>

      {/* ── Remote-Video HINTER den Partikeln, kreisförmig maskiert ────── */}
      {showVideo && (
        <>
          {/* Kreis-Öffnung liegt auf dem WRAPPER (nicht auf dem Video),
              damit sie auch im Merged-Modus mittig bleibt, wenn das Video
              doppelt so breit ist. 85 %: deckt alle Ecken auch bei
              verschobener Linse (±8 %), übersteuert aber kaum. */}
          <div
            style={{
              ...S.videoWrap,
              clipPath: maskOpen
                ? `circle(85% at ${focusXRef.current}% 50%)`
                : `circle(0% at ${focusXRef.current}% 50%)`,
              transition: `clip-path ${maskOpen ? OPEN_MS : CLOSE_MS}ms ease-in-out`,
            }}
          >
            {/* Remote-Video MIT Ton, sobald der Start-Button geklickt
                wurde (audioUnlocked). Das lokale Self-View (aux) bleibt
                dagegen immer stumm (Rückkopplung).

                MERGED DISPLAY (Hole in Space, Galloway & Rabinowitz 1980):
                Das Video der anderen Person erstreckt sich über BEIDE
                Bildschirme — annähernd Lebensgröße, damit das Gegenüber
                als Mensch statt als Bildschirminhalt wahrgenommen wird.
                main zeigt die LINKE Hälfte: das Video ist doppelt so breit
                plus Bezel-Kompensation (der Rahmen zwischen den Monitoren
                "verschluckt" bezelPx Bildpixel wie ein Fensterrahmen);
                der rechte Überstand wird vom Wrapper geclippt. */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted={!audioUnlocked}
              style={
                merged
                  ? { ...S.videoMergedLeft, width: `calc(200% + ${bezelPx}px)`, transform: mergedTransform }
                  : S.video
              }
            />
          </div>
          {!remoteStream && phase === 'video' && (
            <div style={S.waiting}>Warte auf Video… / Waiting for video…</div>
          )}
          {/* Dezenter Hinweis, falls der Browser Ton trotz Geste blockiert */}
          {audioBlocked && (
            <div style={S.audioHint}>🔇 Ton blockiert / audio blocked</div>
          )}
        </>
      )}

      {/* Self-View unten rechts (von aux hierher verschoben): NUR im
          nicht-merged ACTIVE-Zustand — im Merged-Modus übernimmt aux das
          (dort läuft weiterhin die Corner-Self-View, s. AuxDisplay.jsx). */}
      {isActive && !merged && (
        <video
          ref={selfViewRef}
          autoPlay
          playsInline
          muted
          style={{
            ...S.selfCorner,
            width:   `${SELF_VIEW_WIDTH_PERCENT}%`,
            opacity: SELF_VIEW_OPACITY,
          }}
        />
      )}

      {/* ── EINE Ambient-Szene, permanent gemountet, nur Opacity wechselt
          (nie mounten/unmounten bei Zustandswechseln — 1500 Sterne würden
          sonst bei jedem Auf-/Abbau neu geseedet). */}
      <div
        style={{
          ...S.particleLayer,
          opacity:    !isActive ? 1 : 0,
          transition: `opacity ${SCENE_CROSSFADE_MS}ms ease`,
        }}
      >
        {/* presenceRemote bleibt ABSICHTLICH konstant false: steuert
            Sternenwärme/-helligkeit, bleibt aber bewusst von remotePresent
            getrennt — die Sterne selbst bleiben vollständig unverändert.
            remotePresent steuert den Nebel-Grundton (s. AmbientScene.jsx) —
            kein Text/Icon auf Main, das Display trägt im Call das Videobild
            und muss frei bleiben.
            starsMoving = bothPresent: löst ausschließlich die Sternbewegung
            in AmbientScene aus, s. dort. */}
        {/* paused (Performance): NUR noch während des Videos (isActive) —
            bothPresent darf die Szene NICHT mehr ausblenden/pausieren,
            sie zeigt bei beidseitiger Präsenz ja gerade die Sternbewegung. */}
        <AmbientScene
          presenceRemote={false}
          label="System bereit"
          paused={isActive}
          remotePresent={remotePresent}
          starsMoving={bothPresent}
        />
      </div>

      {/* ── Dezente Botschaft (Zone B/C), unten — Zone A: visuelle Stille ─ */}
      {!isActive && phase === 'ambient' && msg && (
        <div style={{ ...S.messageBox, opacity: msgVisible ? 1 : 0 }}>
          <div
            style={{
              ...S.lineDe,
              color: msg.white ? '#f5ecd8' : S.lineDe.color,
              animation: msg.pulse ? 'mdMsgPulse 1.8s ease-in-out infinite' : undefined,
            }}
          >
            {msg.de}
          </div>
          <div style={S.lineEn}>{msg.en}</div>
        </div>
      )}

      {/* Countdown-Overlay: NUR im ACTIVE-Zustand, wenn der Countdown läuft
          UND Restzeit ≤ 20 s (s. COUNTDOWN_VISIBLE_AT_SEC). Aux zeigt hier
          bewusst nichts — die Wellenform bleibt dort ungestört. */}
      {isActive && (
        <div style={{ ...S.countdownOverlay, opacity: showCountdown ? 1 : 0 }}>
          {countdownDisplaySec != null && (
            <div style={S.countdownBox}>
              <div style={S.countdownNumber}>{countdownDisplaySec}</div>
              <div style={S.countdownDe}>Verbindung endet in {countdownDisplaySec} s</div>
              <div style={S.countdownEn}>Connection ends in {countdownDisplaySec} s</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const S = {
  root: {
    position: 'relative',
    width:    '100%',
    height:   '100%',
    // "Deep Obsidian": fast schwarz mit leichtem Blaustich (visuelle Stille)
    background: 'radial-gradient(ellipse at center, #090b12 0%, #05060A 60%, #020308 100%)',
    overflow: 'hidden',
  },
  videoWrap: {
    position:   'absolute',
    inset:      0,
    overflow:   'hidden',   // clippt im Merged-Modus den rechten Überstand
    background: '#000',
    zIndex:     1,
  },
  video: {
    position:  'absolute',
    inset:     0,
    width:     '100%',
    height:    '100%',
    objectFit: 'cover',
    background: '#000',
  },
  // Merged: linke Hälfte des doppelt breiten Bilds (width kommt inline,
  // weil bezelPx zur Laufzeit justierbar ist)
  videoMergedLeft: {
    position:  'absolute',
    left:      0,
    top:       0,
    height:    '100%',
    objectFit: 'cover',
    background: '#000',
  },
  // Self-View: klein, halbtransparent, abgerundet, weicher Schatten
  // (identischer Stil zur früheren Corner-Self-View in AuxDisplay.jsx)
  selfCorner: {
    position:     'absolute',
    right:        '24px',
    bottom:       '24px',
    aspectRatio:  '16 / 9',
    objectFit:    'cover',
    transform:    'scaleX(-1)',   // Selfie-Spiegelung
    borderRadius: '14px',
    border:       '1px solid rgba(255,255,255,0.18)',
    boxShadow:    '0 10px 36px rgba(0,0,0,0.6)',
    zIndex:       6,
  },
  particleLayer: {
    position: 'absolute',
    inset:    0,
    zIndex:   2,
    pointerEvents: 'none',
  },
  waiting: {
    position:      'absolute',
    inset:         0,
    display:       'flex',
    alignItems:    'center',
    justifyContent:'center',
    color:         'rgba(212,175,90,0.55)',
    fontFamily:    "'Courier New', monospace",
    fontSize:      'clamp(14px, 1.4vw, 20px)',
    letterSpacing: '1px',
    zIndex:        3,
  },
  audioHint: {
    position:      'absolute',
    bottom:        '16px',
    right:         '20px',
    padding:       '4px 10px',
    borderRadius:  '14px',
    background:    'rgba(0,0,0,0.45)',
    color:         'rgba(255,255,255,0.55)',
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      '12px',
    letterSpacing: '0.5px',
    zIndex:        4,
    pointerEvents: 'none',
  },
  messageBox: {
    position:      'absolute',
    bottom:        '10%',
    left:          '50%',
    transform:     'translateX(-50%)',
    textAlign:     'center',
    width:         'max-content',
    maxWidth:      '80%',
    zIndex:        10,
    transition:    'opacity 800ms ease',
    pointerEvents: 'none',
  },
  lineDe: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(16px, 1.6vw, 26px)',
    fontWeight:    400,
    lineHeight:    1.3,
    color:         '#e8c979',
    letterSpacing: '0.06em',
    marginBottom:  '6px',
  },
  lineEn: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(12px, 1.1vw, 18px)',
    fontWeight:    300,
    lineHeight:    1.3,
    color:         'rgba(232,201,121,0.55)',
    letterSpacing: '0.06em',
  },
  // Countdown-Overlay: groß, zentriert, gut lesbar aus ~3 m Entfernung
  // (60-Zoll-Display) — sanftes Ein-/Ausblenden über die Opacity-Transition.
  countdownOverlay: {
    position:       'absolute',
    inset:           0,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:          20,
    pointerEvents:  'none',
    transition:     'opacity 500ms ease',
  },
  countdownBox: {
    textAlign:    'center',
    padding:      '3vh 5vw',
    borderRadius: '20px',
    background:   'rgba(0,0,0,0.55)',
  },
  countdownNumber: {
    fontFamily:   '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:     '12vh',
    fontWeight:   600,
    lineHeight:   1,
    color:        '#e8c979',
    marginBottom: '1.5vh',
  },
  countdownDe: {
    fontFamily:   '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:     '3vh',
    fontWeight:   500,
    color:        '#e8c979',
    marginBottom: '0.6vh',
  },
  countdownEn: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:   '1.8vh',
    fontWeight: 300,
    color:      'rgba(232,201,121,0.6)',
  },
};

// React.memo: App re-rendert bei JEDEM Proximity-Update (mehrmals/Sek.);
// das Haupt-Display braucht davon nur die (seltenen) Zonen-/Zustandswechsel.
export default React.memo(MainDisplay);

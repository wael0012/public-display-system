/**
 * AuxDisplay.jsx
 *
 * @fileoverview HILFS-Display (rechte Hälfte im Split-Layout bzw. eigenes
 * Fenster bei ?screen=aux, oder gerendert über AuxScreenApp.jsx im
 * Two-Window-Modus). Weltraum-Hintergrund (AmbientScene, wie MainDisplay)
 * als unterste Ebene, darüber ein dünner Füllring (AuxRingScene.jsx, Canvas
 * 2D) plus Guide-Texte; im ACTIVE-Zustand zeigt es Self-View/die
 * Audio-Wellenform (AudioWaveScene.jsx) statt des Rings.
 *
 * Die Guide-Text-/Ring-Darstellung ergibt sich aus einer 2×2-Matrix aus
 * lokaler Präsenz (hier) und der vom Server gespiegelten Präsenz der
 * Gegenseite (drueben, remotePresent-Prop) — s. AuxRingScene.jsx für die
 * Ring-/Icon-Seite dieser Matrix:
 *
 *   hier=false, drueben=false → Einladungstext (E1) + pulsierender Punkt
 *   hier=false, drueben=true  → "Gesprächspartner bereit" (E2)
 *   hier=true,  drueben=false → Wartetext ohne Füllstand (E3)
 *   hier=true,  drueben=true  → feinere Phasen (E4): Annäherungshinweis →
 *                         Dwell-Ring füllt sich → Verbindungsaufbau
 *   ACTIVE              → Self-View bzw. Audio-Wellenform — NUR hier
 *
 * @author Wael Hammami
 */

import React, { useEffect, useRef, useState } from 'react';
import AuxRingScene from './AuxRingScene.jsx';
import AmbientScene from './AmbientScene.jsx';
import AudioWaveScene from './AudioWaveScene.jsx';
import { SELF_VIEW_WIDTH_PERCENT, SELF_VIEW_OPACITY, ROOM_VIDEO_SCALE } from './displayBridge.js';
import { visualBus } from './visualBus.js';

// Selbstheilung (s. Kommentar bei selfHealed weiter unten): wie lange ohne
// frische BroadcastChannel-Nachricht, bis lokal auf AMBIENT/Ruhetext
// zurückgesetzt wird, und wie oft dafür geprüft wird.
const SELF_HEAL_TIMEOUT_MS = 3_000;
const SELF_HEAL_POLL_MS = 500;

// Gleiche Konstruktion wie in MainDisplay.jsx — eigenständig gelesen, da
// aux ein separates Fenster ist.
const ROOM_ID = (() => {
  try {
    return new URLSearchParams(window.location.search).get('room') === 'kueche'
      ? 'kueche' : 'labor';
  } catch { return 'labor'; }
})();
const VIDEO_SCALE = ROOM_VIDEO_SCALE[ROOM_ID] ?? 1.0;

/** Phase-0-Guide-Text (E1) ist raumabhängig: zeigt jeweils auf den ANDEREN
 *  Raum (Labor-Rechner → "…in die Küche", Küchen-Rechner → "…ins Labor"). */
const GUIDE_PHASE0_DE = ROOM_ID === 'kueche' ? 'Ein Fenster ins Labor' : 'Ein Fenster in die Küche';
const GUIDE_PHASE0_EN = ROOM_ID === 'kueche' ? 'A window into the lab' : 'A window into the kitchen';

// Texte E2/E3, s. Kopf-Dokumentation.
const GUIDE_E2_DE = 'Gesprächspartner bereit';
const GUIDE_E2_EN = 'Someone is ready to talk';
const GUIDE_E3_DE = ROOM_ID === 'kueche'
  ? 'Bereit — sobald jemand das Labor betritt'
  : 'Bereit — sobald jemand die Küche betritt';
const GUIDE_E3_EN = ROOM_ID === 'kueche'
  ? 'Ready — the moment someone enters the lab'
  : 'Ready — the moment someone enters the kitchen';

const TEXT_COLOR_NEUTRAL    = '#e8e9ee';  // E1, E3, E4 (bestehende Farbe)
const TEXT_COLOR_NEBEL_HELL = '#bb6167';  // E2 — NEBEL_HELL, gleicher Wert wie AmbientScene.jsx

const KEYFRAMES = `
  @keyframes auxIdleDotPulse { 0%,100% { opacity: 0.4; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.2); } }
`;

const AuxDisplay = ({
  state, localStream, zone = 'ambient', dwellProgress = 0,
  merged = false, bridgeStream = null, bezelPx = 0, selfViewMode = 'corner',
  mergeOffsetPercent = 0, remotePresent = false,
}) => {
  const isActive      = state === 'ACTIVE';
  // Gleicher Versatz/dieselbe Skalierung wie MainDisplay — beide Fenster
  // zeigen zusammen EIN durchgehendes Bild.
  const mergedTransform =
    `translateX(${(mergeOffsetPercent / 100) * window.innerWidth}px) scale(${VIDEO_SCALE})`;
  /** MERGED DISPLAY: rechte Hälfte des Remote-Videos statt Self-View in
   *  voller Größe — nur wenn der Master das Flag setzt UND die Brücke
   *  wirklich liefert (sonst automatischer Fallback aufs alte Verhalten). */
  const showMerged = isActive && merged && !!bridgeStream && selfViewMode === 'corner';

  // Selbstheilung: dwellProgress kommt NICHT als Prop, sondern über
  // visualBus direkt in den Frame-Loop der Ringszene (s. Kommentar bei
  // AuxRingScene weiter unten). Bleiben BroadcastChannel-Nachrichten aus
  // (Haupt-Fenster gecrasht, im Hintergrund gedrosselt, Reload), hält das
  // Fenster einfach den zuletzt empfangenen Wert für immer — Ring UND
  // Guide-Text würden im letzten Zustand einfrieren, obwohl der Raum längst
  // leer ist. Ohne diese Absicherung gibt es keinen Weg zurück außer einem
  // Reload.
  //
  // visualBus.lastVisualMsgAt wird bei JEDER Nachricht (auch unveränderten
  // Werten) in AuxScreenApp.jsx gesetzt — bewusst NICHT aus zone/state/
  // dwellProgress selbst abgeleitet, weil die während eines echten,
  // stabilen HANDSHAKE (Werte halten absichtlich konstant) sonst fälschlich
  // als "keine Nachricht mehr" gelesen würden.
  const [selfHealed, setSelfHealed] = useState(false);
  useEffect(() => {
    const iv = setInterval(() => {
      const last = visualBus.lastVisualMsgAt ?? 0;
      const stale = last !== 0 && (Date.now() - last) > SELF_HEAL_TIMEOUT_MS;
      setSelfHealed((prev) => {
        if (stale && !prev) {
          visualBus.dwellProgress = 0;
          return true;
        }
        if (!stale && prev) return false;
        return prev;
      });
    }, SELF_HEAL_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  const effState = selfHealed ? 'AMBIENT' : state;
  const effZone  = selfHealed ? 'ambient' : zone;
  const effDwellProgress = selfHealed ? 0 : dwellProgress;
  // remote_presence kommt über denselben (potenziell stale) Kanal wie
  // state/zone/dwellProgress — bei ausbleibenden Nachrichten also ebenso
  // über selfHealed absichern statt einer veralteten "drüben ist jemand"-
  // Meldung zu vertrauen.
  const effRemotePresent = selfHealed ? false : remotePresent;

  // hier = lokale Präsenz (aus state/zone), drueben = Präsenz auf der
  // Gegenseite. Die 2×2-Matrix bestimmt die Phase — NUR wenn BEIDE Seiten
  // besetzt sind (E4), gilt die feinere Phase (awareness/engagement/
  // HANDSHAKE).
  const hier = effState !== 'AMBIENT' || effZone !== 'ambient';
  const drueben = effRemotePresent;

  const guidePhase = (() => {
    if (!hier && !drueben) return 'E1';
    if (!hier && drueben) return 'E2';
    if (hier && !drueben) return 'E3';
    if (effState === 'HANDSHAKE' || effDwellProgress >= 0.99) return 'E4-handshake';
    if (effZone === 'engagement') return 'E4-engagement';
    return 'E4-awareness';
  })();

  const videoRef = useRef(null);
  // isActive in den Deps: localStream existiert schon vor ACTIVE (wird beim
  // Offer/Answer-Handling gesetzt), das <video> rendert aber erst ab ACTIVE —
  // ohne isActive-Dep bliebe srcObject leer (gleicher Fix wie MainDisplay).
  useEffect(() => {
    const el = videoRef.current;
    if (el && localStream) {
      el.srcObject = localStream;
      el.play().catch((err) => {
        console.warn('[AuxDisplay] video.play() abgelehnt:', err?.name ?? err);
      });
    }
    // showMerged in den Deps: beim Umschalten corner ↔ full wird ein
    // ANDERES <video>-Element gerendert — srcObject muss neu gesetzt werden
  }, [localStream, isActive, showMerged]);

  // Brücken-Video (rechte Hälfte des Remote-Bilds) anbinden
  const bridgeVideoRef = useRef(null);
  useEffect(() => {
    const el = bridgeVideoRef.current;
    if (el && bridgeStream) {
      el.srcObject = bridgeStream;
      el.play().catch((err) => {
        console.warn('[AuxDisplay] Brücken-Video play() abgelehnt:', err?.name ?? err);
      });
    }
  }, [bridgeStream, showMerged]);

  // Sanfter Crossfade beim Zusammenwachsen der Flächen (Feedforward:
  // die Formveränderung signalisiert, dass etwas Bedeutsames beginnt)
  const [mergedVisible, setMergedVisible] = useState(false);
  useEffect(() => {
    if (!showMerged) { setMergedVisible(false); return undefined; }
    const t = setTimeout(() => setMergedVisible(true), 60);
    return () => clearTimeout(t);
  }, [showMerged]);

  // Guide-Text-Crossfade (~600ms): bei Phasenwechsel erst ausblenden, dann
  // Text tauschen und wieder einblenden — nie hart umschalten (gleiches
  // Muster wie der Botschaften-Crossfade in MainDisplay.jsx).
  const [displayPhase, setDisplayPhase] = useState(guidePhase);
  const [guideVisible, setGuideVisible] = useState(true);
  useEffect(() => {
    if (guidePhase === displayPhase) {
      setGuideVisible(true);
      return undefined;
    }
    setGuideVisible(false);
    const t = setTimeout(() => {
      setDisplayPhase(guidePhase);
      setGuideVisible(true);
    }, 300);
    return () => clearTimeout(t);
  }, [guidePhase, displayPhase]);

  return (
    <div style={S.root}>
      <style>{KEYFRAMES}</style>

      {/* Weltraum-Hintergrund (unterste Ebene, wie MainDisplay): permanent
          gemountet (gleiche WebGL-Context-Regel, s. AmbientScene.jsx) — nur
          bei ACTIVE unsichtbar (Wellenform läuft dann auf Schwarz). label
          leer: AuxDisplay zeigt seine EIGENEN Guide-Texte weiter unten,
          AmbientScenes eingebauter Zeilen-Slot bleibt hier ungenutzt
          (Komponente wird nicht geändert). */}
      <div style={{ ...S.spaceLayer, opacity: isActive ? 0 : 1, transition: 'opacity 800ms ease', pointerEvents: 'none' }}>
        {/* presenceRemote bleibt ABSICHTLICH false (s. gleiche Begründung in
            MainDisplay.jsx — die Sterne dürfen sich nicht verfärben).
            remotePresent steuert hier wie auf Main nur den Nebel-Grundton. */}
        <AmbientScene presenceRemote={false} label="" paused={isActive} remotePresent={effRemotePresent} />
      </div>

      {/* Proxemic-Ring (Canvas 2D, s. AuxRingScene.jsx) — bleibt
          IMMER gemountet, nur Opacity wechselt. dwellProgress kommt NICHT
          als Prop, sondern wie schon vorher über visualBus direkt in den
          Frame-Loop der Ringszene (s. Kopf-Dokumentation dort). */}
      <div style={{ ...S.ringLayer, opacity: isActive ? 0 : 1, transition: 'opacity 500ms ease', pointerEvents: 'none' }}>
        <AuxRingScene zone={effZone} state={effState} hier={hier} drueben={drueben} />
      </div>

      {/* Ambient-Audio-Wellenform (ACTIVE, Self-View-Ersatz): bleibt wie der
          Ring IMMER gemountet, nur Opacity wechselt — kein Auf-/Abbau des
          AudioContext bei jedem showMerged-Wechsel innerhalb eines Anrufs
          nötig, die Komponente kümmert sich selbst um active=false. */}
      <div style={{ ...S.waveLayer, opacity: (isActive && !showMerged) ? 1 : 0, transition: 'opacity 800ms ease', pointerEvents: 'none' }}>
        <AudioWaveScene stream={localStream} active={isActive && !showMerged} />
      </div>

      {isActive ? (
        showMerged ? (
          <>
            {/* MERGED DISPLAY ("Hole in Space", Galloway & Rabinowitz 1980):
                aux zeigt die RECHTE Hälfte des durchgehenden Remote-Bilds —
                beide Bildschirme zusammen ergeben annähernd Lebensgröße.
                Das Video ist doppelt so breit plus Bezel-Kompensation und
                nach links verschoben; der Rahmen zwischen den Monitoren
                "verschluckt" bezelPx Bildpixel wie ein Fensterrahmen. */}
            <div style={{ ...S.mergedWrap, opacity: mergedVisible ? 1 : 0 }}>
              <video
                ref={bridgeVideoRef}
                autoPlay
                playsInline
                muted
                style={{
                  ...S.mergedVideo,
                  width: `calc(200% + ${bezelPx}px)`,
                  left:  `calc(-100% - ${bezelPx}px)`,
                  transform: mergedTransform,
                }}
              />
            </div>
            {/* Self-View nur noch klein unten rechts — die Aufmerksamkeit
                gehört dem Gegenüber, nicht dem eigenen Bild. Immer muted. */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                ...S.selfCorner,
                width:   `${SELF_VIEW_WIDTH_PERCENT}%`,
                opacity: SELF_VIEW_OPACITY,
              }}
            />
          </>
        ) : (
          // Self-View ist auf das Main-Display gewandert (dort unten rechts,
          // s. MainDisplay.jsx) — hier bleibt nur der permanent gemountete
          // Wellenform-Layer (oben) sichtbar, kein eigenes Video-Element mehr.
          null
        )
      ) : (
        <>
          {/* Guide-Texte als Overlay über dem Ring, pro Phase, Crossfade
              ~600ms bei Wechsel (s. displayPhase/guideVisible oben) — kein
              Text bei ACTIVE (dieser Zweig läuft nur !isActive). Ruhiges
              Weiß, ruhiger Grundton — der pulsierende Punkt bei Phase 0
              bleibt als einziger Gold-Akzent. */}
          <div style={S.textLayer}>
            <div style={{ opacity: guideVisible ? 1 : 0, transition: 'opacity 600ms ease' }}>
              {displayPhase === 'E1' && (
                <div style={S.promptWrap}>
                  <div style={{ ...S.promptDeXL, color: TEXT_COLOR_NEUTRAL }}>{GUIDE_PHASE0_DE}</div>
                  <div style={S.promptEn}>{GUIDE_PHASE0_EN}</div>
                  <div style={S.idleDotRow}><span style={S.idleDot} /></div>
                </div>
              )}
              {displayPhase === 'E2' && (
                <div style={S.promptWrap}>
                  <div style={{ ...S.promptDe, color: TEXT_COLOR_NEBEL_HELL }}>{GUIDE_E2_DE}</div>
                  <div style={S.promptEn}>{GUIDE_E2_EN}</div>
                </div>
              )}
              {displayPhase === 'E3' && (
                <div style={S.promptWrap}>
                  <div style={{ ...S.promptDe, color: TEXT_COLOR_NEUTRAL }}>{GUIDE_E3_DE}</div>
                  <div style={S.promptEn}>{GUIDE_E3_EN}</div>
                </div>
              )}
              {displayPhase === 'E4-awareness' && (
                <div style={S.promptWrap}>
                  <div style={{ ...S.promptDe, color: TEXT_COLOR_NEUTRAL }}>Komm näher, um zu verbinden</div>
                  <div style={S.promptEn}>Come closer to connect</div>
                </div>
              )}
              {displayPhase === 'E4-engagement' && (
                <div style={S.promptWrap}>
                  <div style={{ ...S.promptDe, color: TEXT_COLOR_NEUTRAL }}>Bleib kurz stehen — gleich geht's los</div>
                  <div style={S.promptEn}>Stay a moment — starting soon</div>
                </div>
              )}
              {displayPhase === 'E4-handshake' && (
                <div style={S.promptWrap}>
                  <div style={{ ...S.promptDe, color: TEXT_COLOR_NEUTRAL }}>Verbindung wird aufgebaut …</div>
                  <div style={S.promptEn}>Connecting …</div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const S = {
  root: {
    position:   'relative',
    width:      '100%',
    height:     '100%',
    background: '#050505',
    overflow:   'hidden',
  },
  spaceLayer: {
    position: 'absolute',
    inset:    0,
    zIndex:   1,
  },
  ringLayer: {
    position: 'absolute',
    inset:    0,
    zIndex:   2,
  },
  waveLayer: {
    position: 'absolute',
    inset:    0,
    zIndex:   3,
  },
  textLayer: {
    position:       'absolute',
    left:           0,
    right:          0,
    bottom:         '12%',
    display:        'flex',
    justifyContent: 'center',
    zIndex:         5,
    pointerEvents:  'none',
  },
  promptWrap: {
    textAlign:  'center',
    padding:    '0 6vw',
    transition: 'opacity 600ms ease',
  },
  // color kommt NICHT von hier: E1/E3/E4 vs. E2 (NEBEL_HELL) brauchen
  // unterschiedliche Farben — s. TEXT_COLOR_* und die jeweilige
  // Inline-color am Einsatzort weiter oben.
  promptDe: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(18px, 2vw, 30px)',
    fontWeight:    500,
    lineHeight:    1.3,
    marginBottom:  '10px',
    textShadow:    '0 2px 12px rgba(0,0,0,0.6)',
  },
  // Phase 0 (niemand da): deutlich größer/ruhiger als die übrigen Guide-
  // Texte — die Einladung selbst ist die "Botschaft", kein Alarm.
  promptDeXL: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(34px, 3.6vw, 64px)',
    fontWeight:    400,
    lineHeight:    1.25,
    marginBottom:  '14px',
    textShadow:    '0 2px 12px rgba(0,0,0,0.6)',
  },
  promptEn: {
    fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:      'clamp(13px, 1.2vw, 18px)',
    fontWeight:    300,
    color:         'rgba(232,233,238,0.55)',
    textShadow:    '0 2px 12px rgba(0,0,0,0.6)',
  },
  idleDotRow: {
    display:        'flex',
    justifyContent: 'center',
    marginTop:      '16px',
  },
  // MERGED DISPLAY: rechte Bildhälfte (width/left kommen inline — bezelPx
  // ist zur Laufzeit justierbar). Sanfter Crossfade beim Zusammenwachsen.
  mergedWrap: {
    position:   'absolute',
    inset:      0,
    overflow:   'hidden',
    background: '#000',
    transition: 'opacity 800ms ease',
  },
  mergedVideo: {
    position:   'absolute',
    top:        0,
    height:     '100%',
    objectFit:  'cover',
    background: '#000',
    // KEINE Spiegelung: das ist die andere Person, kein Selfie
  },
  // Corner-Self-View: klein, halbtransparent, abgerundet, weicher Schatten
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
  // Einziger Gold-Akzent: pulsiert sanft, s. KEYFRAMES
  idleDot: {
    width:        '7px',
    height:       '7px',
    borderRadius: '50%',
    background:   'rgba(212,175,90,0.85)',
    animation:    'auxIdleDotPulse 3s ease-in-out infinite',
  },
};

export default AuxDisplay;

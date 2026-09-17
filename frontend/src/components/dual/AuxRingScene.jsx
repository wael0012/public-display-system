/**
 * AuxRingScene.jsx
 *
 * @fileoverview Proxemic-Füllring des AUX-Fensters (Canvas 2D, kein WebGL/
 * Three.js — leichtgewichtig, permanent gemountet, rAF auf 30fps gedrosselt).
 * Wird von AuxDisplay.jsx eingebunden (Props zone/state/hier/drueben);
 * dwellProgress kommt NICHT als Prop, sondern direkt aus visualBus.js in
 * den Frame-Loop (s. dort).
 *
 * Die Ring-Darstellung ergibt sich aus einer 2×2-Matrix aus lokaler Präsenz
 * (hier) und der vom Server gespiegelten Präsenz der Gegenseite (drueben):
 * beide leer → Basis-Ring; nur Gegenseite besetzt → Ring + Personen-Icon;
 * nur hier besetzt → gedämpfter Ring + wandernder Lichtbogen, KEIN
 * Füllstand (ein Fortschrittsring für eine Verbindung, die mangels
 * Gegenseite nicht zustande kommen kann, führt in die Irre); beide besetzt
 * → der goldene Dwell-Füllstand plus Voll-/HANDSHAKE-Puls. Im ACTIVE-
 * Zustand zeichnet die Szene nichts (Self-View/Wellenform übernehmen).
 *
 * Sichtbarkeit gestuft über zone (CALM TECHNOLOGY): ambient = stark
 * gedämpft, ab awareness voll.
 *
 * @author Wael Hammami
 */

import React, { useEffect, useRef } from 'react';
import { visualBus } from './visualBus.js';

// ── Stellschrauben ──────────────────────────────────────────────────────────
const TARGET_FRAME_MS = 33;     // 30fps-Deckel

const CY_FRAC     = 0.44;   // Ring-Mitte, Anteil der Hoehe
const RADIUS_FRAC = 0.26;   // Ring-Radius, Anteil der Hoehe
const STROKE_FRAC = 0.012;  // Strichstaerke, Anteil der Hoehe

const BREATH_AMP      = 0.02;  // +-2% Radius
const BREATH_PERIOD_S = 8;

const AMBIENT_DIM_FACTOR = 0.25; // Zone ambient: stark gedaempft (Calm Technology)

const DWELL_LERP = 6; // Dämpfung (pro Sekunde), Verweil-Fortschritt folgt weich
const FADE_LERP  = 12; // Dämpfung fürs Ein-/Ausblenden des D2-Icons (~0.5s)

const PULSE_CYCLE_MS = 1000;
const PULSE_WAVES    = 2;      // gestaffelte, auslaufende Wellen

// s. AmbientScene.jsx/AuxDisplay.jsx für dieselben, dort separat angelegten
// Konstanten (gemessene Referenzfarben).
const NEBEL_HELL = [187, 97, 103];   // #bb6167 — helle Nebelzone (D2)
const RING_BLUE  = [180, 200, 255];  // bestehende blaue Ruhefarbe des Rings
const WHITE      = [255, 255, 255];

const ORBIT_PERIOD_S = 16;  // D3: eine Umdrehung des wandernden Bogens
const ORBIT_ARC_LEN  = 0.85; // rad

// ── Helfer ───────────────────────────────────────────────────────────────────
const mixRgb = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
const rgbaStr = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

const ICON_COLOR = mixRgb(WHITE, NEBEL_HELL, 0.45); // Mischung Weiß/NEBEL_HELL

/** Weicher heller Lichtpunkt am Fortschrittsende — einmalig vorgebacken. */
function bakeDotSprite(px = 96) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0,    'rgba(255,255,252,1)');
  grad.addColorStop(0.3,  'rgba(255,250,235,0.85)');
  grad.addColorStop(0.65, 'rgba(232,201,121,0.35)');
  grad.addColorStop(1,    'rgba(232,201,121,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}
const END_DOT_SPRITE = bakeDotSprite();

/** Robuste Größen-Synchronisation (gleiches Muster wie AudioWaveScene.jsx):
 *  canvas.width/height JEDEN Frame aus clientWidth/clientHeight ableiten
 *  statt einmalig zu cachen. */
function syncCanvasSize(canvas) {
  const cssWidth  = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(cssWidth * dpr));
  const targetH = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width  = targetW;
    canvas.height = targetH;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { width: cssWidth, height: cssHeight };
}

/** Schlichtes Personen-Icon (Kopf-Kreis + Schulter-Halbkreis), sichtbar wenn
 *  nur die Gegenseite besetzt ist. opacityMul bündelt Fade (Ein-/Ausblenden)
 *  und die Zonen-Sichtbarkeit (visibility). */
function drawPersonIcon(ctx, cx, cy, radius, opacityMul) {
  const a = 0.72 * opacityMul; // konstant, kein Mitpulsieren
  if (a <= 0.002) return;

  const iconSize   = radius * 0.62;
  const headR      = iconSize * 0.30;
  const headCy     = cy - iconSize * 0.24;
  const shoulderR  = iconSize * 0.50;
  const shoulderCy = cy + iconSize * 0.30;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgbaStr(ICON_COLOR, a);

  ctx.beginPath();
  ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();

  // Schultern: obere Hälfte eines größeren Kreises (Bogen π→2π ergibt die
  // nach oben gewölbte, unten flache Dom-Form eines Schulteransatzes).
  ctx.beginPath();
  ctx.arc(cx, shoulderCy, shoulderR, Math.PI, Math.PI * 2, false);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/** Einzelner heller Bogen (sichtbar wenn nur die lokale Seite besetzt ist),
 *  wandert langsam einmal um den Ring (~16s/Umdrehung), weicher Schein. */
function drawOrbitingArc(ctx, cx, cy, radius, stroke, opacityMul, angle) {
  const a = 0.85 * opacityMul;
  if (a <= 0.002) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = 'rgba(210,222,255,0.8)';
  ctx.shadowBlur = stroke * 5;
  ctx.strokeStyle = rgbaStr([225, 232, 255], a);
  ctx.lineWidth = stroke * 1.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, angle, angle + ORBIT_ARC_LEN);
  ctx.stroke();
  ctx.restore();
}

const AuxRingScene = ({ zone = 'ambient', state = 'AMBIENT', hier = false, drueben = false }) => {
  const canvasRef  = useRef(null);
  const zoneRef    = useRef(zone);
  const stateRef   = useRef(state);
  const hierRef    = useRef(hier);
  const druebenRef = useRef(drueben);

  useEffect(() => { zoneRef.current = zone; }, [zone]);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { hierRef.current = hier; }, [hier]);
  useEffect(() => { druebenRef.current = drueben; }, [drueben]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let raf = 0;
    let last = performance.now();
    let tSec = 0;
    let dwell = 0;           // gedaempfter Verweil-Fortschritt
    let pulseT = 0;          // ms, wraps alle PULSE_CYCLE_MS
    let iconOpacity = 0;     // D2 — gedämpftes Ein-/Ausblenden
    let orbitOpacity = 0;    // D3 — gedämpftes Ein-/Ausblenden
    let orbitAngle = 0;      // D3 — Position des wandernden Bogens

    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      if (now - last < TARGET_FRAME_MS) return;
      const dtMs = Math.min(now - last, 50);
      last = now;
      tSec += dtMs / 1000;

      const { width, height } = syncCanvasSize(canvas);
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (width <= 0 || height <= 0) return;

      const stateNow = stateRef.current;
      if (stateNow === 'ACTIVE') return; // nichts zeichnen

      const hierNow = hierRef.current;
      const druebenNow = druebenRef.current;

      // Verweil-Fortschritt: HANDSHAKE haelt den Ring voll, sonst
      // gedaempft aus visualBus (hochfrequent, s. Kopf-Dokumentation).
      // Der Lerp naehert sich dem Ziel nur EXPONENTIELL an, erreicht es
      // rechnerisch nie exakt — bei knappem Restabstand (< 0.002) daher
      // hart auf das Ziel springen, damit 0 (und 1) tatsaechlich erreicht
      // wird, statt für immer als winziger Rest hängen zu bleiben.
      const dwellTarget = stateNow === 'HANDSHAKE' ? 1 : (visualBus.dwellProgress ?? 0);
      const dwellDelta = dwellTarget - dwell;
      if (Math.abs(dwellDelta) < 0.002) {
        dwell = dwellTarget;
      } else {
        dwell += dwellDelta * Math.min(1, (dtMs / 1000) * DWELL_LERP);
      }

      pulseT = (pulseT + dtMs) % (PULSE_CYCLE_MS * PULSE_WAVES);
      orbitAngle = (orbitAngle + (dtMs / 1000) * ((Math.PI * 2) / ORBIT_PERIOD_S)) % (Math.PI * 2);

      const zoneNow = zoneRef.current;
      const visibility = zoneNow === 'ambient' ? AMBIENT_DIM_FACTOR : 1;
      if (visibility <= 0.001) return;

      const cx = width / 2;
      const cy = height * CY_FRAC;
      const breath = 1 + BREATH_AMP * Math.sin((tSec / BREATH_PERIOD_S) * Math.PI * 2);
      const radius = height * RADIUS_FRAC * breath;
      const stroke = Math.max(1, height * STROKE_FRAC);

      // 2×2-Matrix aus hier/drueben — s. Kopf-Dokumentation.
      const showFill = hierNow && druebenNow;    // Füllung NUR wenn beide besetzt
      const showIcon = !hierNow && druebenNow;
      const showOrbit = hierNow && !druebenNow;

      const iconTarget = showIcon ? 1 : 0;
      iconOpacity += (iconTarget - iconOpacity) * Math.min(1, (dtMs / 1000) * FADE_LERP);
      const orbitTarget = showOrbit ? 1 : 0;
      orbitOpacity += (orbitTarget - orbitOpacity) * Math.min(1, (dtMs / 1000) * FADE_LERP);

      const full = dwell >= 0.99 || stateNow === 'HANDSHAKE';

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (showOrbit) {
        // Ring sehr dünn/zurückhaltend, bestehende blaue Ruhefarbe
        ctx.shadowBlur = 0;
        ctx.strokeStyle = rgbaStr(RING_BLUE, 0.24 * visibility);
        ctx.lineWidth = stroke * 0.6;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else if (showIcon) {
        // Ring in NEBEL_HELL, ruhig atmend (4,5s-Periode mit
        // Smoothstep-Glättung statt hartem Ein-/Ausschalten), weicher Schein.
        const roh = 0.5 - 0.5 * Math.cos((tSec % 4.5) / 4.5 * Math.PI * 2);
        const pulse = roh * roh * (3 - 2 * roh);
        const ringA = (0.58 + 0.24 * pulse) * visibility;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = rgbaStr(NEBEL_HELL, ringA * 0.5);
        ctx.lineWidth = stroke * 4;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = rgbaStr(NEBEL_HELL, ringA);
        ctx.shadowColor = rgbaStr(NEBEL_HELL, 0.7);
        ctx.shadowBlur = stroke * 3 * (1.0 + 0.15 * pulse);
        ctx.lineWidth = stroke * 1.2 * (1.0 + 0.08 * pulse);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // Basis-Ring: breiter, schwacher Aussenglow zuerst, dann der
        // duenne Basis-Kreis selbst.
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(180,200,255,${0.06 * visibility})`;
        ctx.lineWidth = stroke * 4;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(180,200,255,${0.28 * visibility})`;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (showFill) {
        // Füllung / HANDSHAKE-Puls
        if (full) {
          // ── Ring fast weiss, starker Glow ────────────────────────────
          ctx.strokeStyle = `rgba(248,248,252,${0.95 * visibility})`;
          ctx.shadowColor = 'rgba(248,248,252,0.9)';
          ctx.shadowBlur = stroke * 6;
          ctx.lineWidth = stroke * 1.4;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.shadowBlur = 0;

          // ── Auslaufende Puls-Wellen (gestaffelt, ~1s Zyklus) ─────────
          for (let w = 0; w < PULSE_WAVES; w++) {
            const localT = (pulseT - w * PULSE_CYCLE_MS + PULSE_CYCLE_MS * PULSE_WAVES)
              % (PULSE_CYCLE_MS * PULSE_WAVES);
            if (localT >= PULSE_CYCLE_MS) continue;
            const k = localT / PULSE_CYCLE_MS; // 0..1
            const waveR = radius + k * radius * 0.8;
            const alpha = (1 - k) * 0.5 * visibility;
            if (alpha < 0.01) continue;
            ctx.strokeStyle = `rgba(248,248,252,${alpha})`;
            ctx.lineWidth = Math.max(1, stroke * (1 - k * 0.5));
            ctx.beginPath();
            ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
            ctx.stroke();
          }
        } else if (dwell > 0.001) {
          // ── Fuellung: Bogen von oben (-90°) im Uhrzeigersinn, warmes
          //    Gold, Glow, runde Enden ────────────────────────────────────
          const startAngle = -Math.PI / 2;
          const endAngle = startAngle + dwell * Math.PI * 2;
          ctx.strokeStyle = `rgba(232,201,121,${0.95 * visibility})`;
          ctx.shadowColor = 'rgba(232,201,121,0.85)';
          ctx.shadowBlur = stroke * 4;
          ctx.lineWidth = stroke * 1.3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(cx, cy, radius, startAngle, endAngle, false);
          ctx.stroke();
          ctx.lineCap = 'butt';
          ctx.shadowBlur = 0;

          // Weicher heller Lichtpunkt am Fortschrittsende
          const dotX = cx + Math.cos(endAngle) * radius;
          const dotY = cy + Math.sin(endAngle) * radius;
          const dotSize = stroke * 10;
          ctx.globalAlpha = visibility;
          ctx.drawImage(END_DOT_SPRITE, dotX - dotSize / 2, dotY - dotSize / 2, dotSize, dotSize);
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();

      // Icon/Bogen liegen bewusst AUSSERHALB des obigen ctx.save()/restore()-
      // Blocks (der u.a. globalCompositeOperation setzt) — jede Zeichen-
      // funktion kapselt ihren eigenen ctx-Zustand selbst.
      if (iconOpacity > 0.002) {
        drawPersonIcon(ctx, cx, cy, radius, iconOpacity * visibility);
      }
      if (orbitOpacity > 0.002) {
        drawOrbitingArc(ctx, cx, cy, radius, stroke, orbitOpacity * visibility, orbitAngle);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, []);

  return <canvas ref={canvasRef} style={S.canvas} />;
};

const S = {
  canvas: {
    position:      'absolute',
    inset:          0,
    width:          '100%',
    height:         '100%',
    display:        'block',
    pointerEvents:  'none',
  },
};

export default React.memo(AuxRingScene);

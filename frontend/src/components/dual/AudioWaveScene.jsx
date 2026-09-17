/**
 * AudioWaveScene.jsx
 *
 * @fileoverview Ambient-Audio-Wellenform für das Aux-Display: läuft im
 * ACTIVE-Zustand als Self-View-Ersatz (von AuxDisplay.jsx eingebunden,
 * stream/active als Props). Canvas 2D statt WebGL, da neben Ring/Ambient-
 * Szene schon genug GPU-Last anfällt.
 *
 * Attack/Decay-Dämpfung (statt AnalyserNode.smoothingTimeConstant) plus
 * eine zusätzliche räumliche Glättung über Nachbarbalken direkt vor dem
 * Zeichnen ergeben eine ruhige, lebendige Wellenform. Die Stille-Erkennung
 * läuft über den RMS-Wert des Zeitbereichssignals (robuster als einzelne
 * Frequenzbänder): bleibt der Pegel 350 ms unter der Schwelle, trudeln die
 * Balken aus und die Analyse pausiert bis zum nächsten Ton.
 *
 * @author Wael Hammami
 */

import React, { useEffect, useRef } from 'react';

// ── Stellschrauben ──────────────────────────────────────────────────────────
const BAR_COUNT                  = 56;
const FFT_SIZE                    = 256;
const ATTACK                       = 0.35;
const DECAY                        = 0.06;
const SILENCE_RMS_THRESHOLD        = 0.015;
const SILENCE_HOLD_MS              = 350;
const FREEZE_FADE_FACTOR           = 0.9;   // pro Frame Richtung 0 beim Einfrieren
const GHOST_ROWS                    = 2;
const GHOST_SCALE_STEP              = 0.18;  // je Reihe 18% kleiner (kumulativ)
const GHOST_OPACITY                 = [0.14, 0.06];
const GHOST_Y_STEP_FRAC              = 0.032; // Versatz nach oben, Anteil der Canvas-Höhe
const REFLECTION_OPACITY             = 0.10;
const REFLECTION_HEIGHT_FRACTION     = 0.4;
const REFLECTION_GAP_PX              = 6;
const FROZEN_BASELINE_OPACITY        = 0.22;
const MIN_BAR_HEIGHT_PX              = 2;
const BAR_WIDTH_RATIO                = 0.55;  // Anteil der Balkenbreite an ihrem Slot
const USABLE_WIDTH_FRACTION          = 0.70;  // horizontale Zentrierung
const HIGH_BIN_BOOST                 = 1.5;   // milde Anhebung der äußeren (höheren) Bins

/**
 * Symmetrische Bin-Zuordnung: Sprachenergie liegt
 * in den unteren Frequenzen — eine einfache links→rechts-Rampe über den
 * Bin-Bereich lässt die rechten Balken fast tot wirken. Stattdessen wird
 * von der MITTE nach außen gezählt: Balken-Paar an "Tiefe" k (0 = Mitte)
 * bekommt Frequenz-Bin k — tiefe (energiereiche) Frequenzen in der Mitte,
 * hohe außen. BAR_COUNT ist gerade (56), daher exakt symmetrisch (28
 * Paare, Tiefe 0..27).
 */
const BAR_HALF = BAR_COUNT / 2;
const BIN_FOR_INDEX = Array.from({ length: BAR_COUNT }, (_, i) => (
  i < BAR_HALF ? (BAR_HALF - 1 - i) : (i - BAR_HALF)
));

/** Räumliche Glättung über Nachbarbalken (Rand: nächster vorhandener Wert). */
function smoothNeighbors(levels, out) {
  const n = levels.length;
  for (let i = 0; i < n; i++) {
    const l = levels[i > 0 ? i - 1 : 0];
    const c = levels[i];
    const r = levels[i < n - 1 ? i + 1 : n - 1];
    out[i] = 0.25 * l + 0.5 * c + 0.25 * r;
  }
}

/** Kapselförmiger Balken, symmetrisch um baselineY (radius = Balkenbreite/2). */
function drawBarRow(ctx, levels, { startX, barSlot, barWidth, baselineY, maxBarHeight, color }) {
  ctx.fillStyle = color;
  const radius = barWidth / 2;
  for (let i = 0; i < levels.length; i++) {
    const h = Math.max(MIN_BAR_HEIGHT_PX, levels[i] * maxBarHeight);
    const x = startX + i * barSlot + (barSlot - barWidth) / 2;
    ctx.beginPath();
    ctx.roundRect(x, baselineY - h / 2, barWidth, h, radius);
    ctx.fill();
  }
}

/** Dezente Spiegelung UNTER dem Hauptbalken (eigener Abstand + Höhenanteil). */
function drawReflectionRow(ctx, levels, { startX, barSlot, barWidth, baselineY, maxBarHeight, opacity, gap }) {
  ctx.fillStyle = `rgba(255,255,255,${opacity})`;
  const radius = barWidth / 2;
  for (let i = 0; i < levels.length; i++) {
    const mainH = Math.max(MIN_BAR_HEIGHT_PX, levels[i] * maxBarHeight);
    const reflH = Math.max(MIN_BAR_HEIGHT_PX, mainH * REFLECTION_HEIGHT_FRACTION);
    const x = startX + i * barSlot + (barSlot - barWidth) / 2;
    ctx.beginPath();
    ctx.roundRect(x, baselineY + mainH / 2 + gap, barWidth, reflH, radius);
    ctx.fill();
  }
}

function renderFrame(ctx, width, height, levels, frozen) {
  ctx.clearRect(0, 0, width, height);

  const baselineY    = height * 0.5;
  const maxBarHeight  = height * 0.34;
  const totalWidth    = width * USABLE_WIDTH_FRACTION;
  const startX         = (width - totalWidth) / 2;
  const barSlot         = totalWidth / BAR_COUNT;
  const barWidth         = barSlot * BAR_WIDTH_RATIO;

  if (frozen) {
    ctx.strokeStyle = `rgba(255,255,255,${FROZEN_BASELINE_OPACITY})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, baselineY + 0.5);
    ctx.lineTo(startX + totalWidth, baselineY + 0.5);
    ctx.stroke();
    return;
  }

  // Pseudo-3D: blassere, kleinere Reihen weiter hinten zuerst zeichnen
  for (let r = GHOST_ROWS; r >= 1; r--) {
    const scale = (1 - GHOST_SCALE_STEP) ** r;
    drawBarRow(ctx, levels, {
      startX, barSlot, barWidth,
      baselineY:    baselineY - r * height * GHOST_Y_STEP_FRAC,
      maxBarHeight: maxBarHeight * scale,
      color:        `rgba(255,255,255,${GHOST_OPACITY[r - 1]})`,
    });
  }

  drawReflectionRow(ctx, levels, {
    startX, barSlot, barWidth, baselineY, maxBarHeight,
    opacity: REFLECTION_OPACITY, gap: REFLECTION_GAP_PX,
  });

  drawBarRow(ctx, levels, {
    startX, barSlot, barWidth, baselineY, maxBarHeight, color: 'rgba(255,255,255,0.95)',
  });
}

/**
 * Robuste Zentrierung: canvas.width/height werden bei JEDEM Frame gegen
 * clientWidth/clientHeight abgeglichen statt einmal beim Mount gecacht —
 * ist das Element beim ersten Render noch unsichtbar/0×0 (Layout noch
 * nicht fertig), liefert diese Funktion einfach 0 zurück; der Aufrufer
 * überspringt dann das Zeichnen — der NÄCHSTE Frame prüft erneut, sobald
 * das Layout steht. Backing-Store (canvas.width/height) wird nur bei
 * TATSÄCHLICHER Änderung neu gesetzt (sonst teurer Kontext-Reset jeden
 * Frame). Rückgabe in CSS-Pixeln — die Basis für ALLE x/y-Positionen beim
 * Zeichnen, nichts davon wird zwischen Frames gecacht.
 */
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

const AudioWaveScene = ({ stream, active }) => {
  const canvasRef    = useRef(null);
  const rafRef       = useRef(null);
  const audioCtxRef  = useRef(null);
  const sourceRef    = useRef(null);
  const ownStreamRef = useRef(null);   // nur gesetzt, wenn wir selbst per getUserMedia geholt haben
  const levelsRef    = useRef(new Float32Array(BAR_COUNT));
  const smoothedRef  = useRef(new Float32Array(BAR_COUNT));
  const silentSinceRef = useRef(null);
  const frozenRef      = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!active) {
      cancelAnimationFrame(rafRef.current);
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return undefined;
    }

    let disposed = false;
    levelsRef.current.fill(0);
    smoothedRef.current.fill(0);
    silentSinceRef.current = null;
    frozenRef.current = false;

    const setup = async () => {
      let audioStream = stream;
      const existingTrack = stream?.getAudioTracks?.()[0] ?? null;

      if (!existingTrack) {
        try {
          const gum = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (disposed) { gum.getTracks().forEach((t) => t.stop()); return; }
          ownStreamRef.current = gum;
          audioStream = gum;
        } catch (err) {
          console.warn('[AudioWaveScene] getUserMedia(audio) fehlgeschlagen:', err?.name ?? err);
          return;
        }
      }
      if (disposed || !audioStream) return;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      audioCtx.resume().catch(() => { /* Autoplay-Policy: läuft ggf. erst nach Gesture an */ });

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;   // eigenes Attack/Decay unten

      const source = audioCtx.createMediaStreamSource(audioStream);
      sourceRef.current = source;
      source.connect(analyser);
      // BEWUSST NICHT mit audioCtx.destination verbunden — sonst Rückkopplung

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.fftSize);

      const draw = () => {
        rafRef.current = requestAnimationFrame(draw);
        if (disposed) return;

        // RMS läuft IMMER (auch eingefroren) — sonst gäbe es kein
        // Wiederaufwachen, wenn der Ton zurückkehrt
        analyser.getByteTimeDomainData(timeData);
        let sumSq = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / timeData.length);

        const now = performance.now();
        if (rms < SILENCE_RMS_THRESHOLD) {
          if (silentSinceRef.current === null) silentSinceRef.current = now;
        } else {
          silentSinceRef.current = null;
          frozenRef.current = false;
        }
        const isSilentLongEnough =
          silentSinceRef.current !== null && (now - silentSinceRef.current) >= SILENCE_HOLD_MS;

        if (!frozenRef.current) {
          const levels = levelsRef.current;
          if (isSilentLongEnough) {
            // Weiches Austrudeln statt normalem Decay — deutlich schneller
            // Richtung 0, danach kompletter Stillstand (Einfrieren)
            let maxLevel = 0;
            for (let i = 0; i < BAR_COUNT; i++) {
              levels[i] *= FREEZE_FADE_FACTOR;
              maxLevel = Math.max(maxLevel, levels[i]);
            }
            if (maxLevel < 0.002) {
              levels.fill(0);
              frozenRef.current = true;
            }
          } else {
            analyser.getByteFrequencyData(freqData);
            for (let i = 0; i < BAR_COUNT; i++) {
              // Symmetrisch von der Mitte nach außen (BIN_FOR_INDEX, s. oben)
              // statt einer geraden links→rechts-Rampe über den Bin-Bereich.
              const bin = Math.min(BIN_FOR_INDEX[i], analyser.frequencyBinCount - 1);
              const raw = freqData[bin] / 255;
              // Milde Anhebung der äußeren (höheren) Bins, damit sie trotz
              // geringerer Sprachenergie sichtbar mitleben.
              const boost = 1 + (bin / analyser.frequencyBinCount) * HIGH_BIN_BOOST;
              // Sinus-Gewichtung: Mitte betont, Ränder gedämpft (nie ganz stumm)
              const weight = Math.sin(Math.PI * (i / (BAR_COUNT - 1)));
              const target = Math.min(1, raw * boost * (0.4 + 0.6 * weight));
              const rate = target > levels[i] ? ATTACK : DECAY;
              levels[i] += (target - levels[i]) * rate;
            }
          }
        }

        // Räumliche Glättung NUR auf der Zeichen-Ebene (vor dem Rendern) —
        // levelsRef bleibt die "physikalische" Attack/Decay-Historie
        smoothNeighbors(levelsRef.current, smoothedRef.current);

        // Größe JEDEN Frame frisch von clientWidth/Height ableiten (s.
        // syncCanvasSize oben) — nichts wird zwischen Frames gecacht.
        const currentCanvas = canvasRef.current;
        if (currentCanvas) {
          const { width, height } = syncCanvasSize(currentCanvas);
          const ctx = currentCanvas.getContext('2d');
          if (ctx && width > 0 && height > 0) {
            renderFrame(ctx, width, height, smoothedRef.current, frozenRef.current);
          }
        }
      };

      draw();
    };

    setup();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      try { sourceRef.current?.disconnect(); } catch { /* schon getrennt */ }
      try { audioCtxRef.current?.close(); } catch { /* schon zu */ }
      audioCtxRef.current = null;
      sourceRef.current = null;
      if (ownStreamRef.current) {
        ownStreamRef.current.getTracks().forEach((t) => t.stop());
        ownStreamRef.current = null;
      }
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [stream, active]);

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

export default React.memo(AudioWaveScene);

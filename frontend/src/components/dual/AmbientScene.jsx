/**
 * AmbientScene.jsx
 *
 * @fileoverview Ambient-Hintergrundszene ("Deep Space"): ein perspektivisches
 * Sternfeld in Canvas 2D, keine externen Assets. Jeder Stern hat eine
 * (x, y, z)-Position und wird jeden Frame neu projiziert — Parallaxe, Größe
 * und Helligkeit ergeben sich aus der Tiefe statt aus festen Ebenen.
 * Wird von MainDisplay.jsx und AuxDisplay.jsx permanent gemountet eingebunden
 * (remotePresent/starsMoving/paused als Props); liest hochfrequente Werte
 * (proximity) direkt aus visualBus.js statt über React-State/Props.
 * Viele Kommentare im Rendering-Code sind bewusst auf Englisch belassen
 * (Herkunft: v0.dev-Entwurf, unverändert übernommen).
 *
 * @author Wael Hammami (Konvertierung), v0.dev (Entwurf)
 */

import { useEffect, useRef } from 'react';
import { visualBus } from './visualBus.js';

/* ---------------------------- tuning ----------------------------- */

const NEBULA_CYCLE = 30_000; // ms, full breath (expand + contract)
const SHOOT_MIN = 180_000; // ms
const SHOOT_MAX = 300_000; // ms

/** 30fps-Deckel (Performance): die Szene bewegt sich langsam,
 *  30fps sind visuell nicht unterscheidbar von 60fps, halbieren aber die
 *  Last. Frames werden übersprungen, nicht die Physik verlangsamt — dt
 *  bleibt real (s. frame() unten), es läuft also nicht in Zeitlupe. */
const TARGET_FRAME_MS = 33;

/**
 * Render-Auflösung (Performance): statt Qualität zu opfern (Sternenzahl/
 * Effekte), wird intern auf halber Auflösung gezeichnet (canvas.width/height) und per CSS
 * auf volle Elementgröße hochskaliert — die GPU übernimmt das Upscaling
 * kostenlos. Sterne sind weiche Glow-Sprites, das Upscaling ist bei ihnen
 * unsichtbar. Alle Zeichenkoordinaten bleiben unverändert in LOGISCHEN
 * (CSS-)Pixeln (w/h) — nur der ctx-Transform (devScale = dpr * RENDER_SCALE,
 * s. resize()) bildet sie auf den kleineren Backing-Store ab.
 */
// Bei 0.33 kam das Canvas auf einer 3072×1727-Anzeigefläche sichtbar weicher
// heraus als beabsichtigt; 0.55 liegt näher an der realen Panel-Auflösung,
// die GPU skaliert den Rest weiterhin verlustarm hoch.
export const RENDER_SCALE = 0.55; // ~1690x950 bei 3072er-Anzeigefläche

const Z_NEAR = 0.16;
const Z_FAR = 1.0;
/** STAR_TOTAL bleibt exportiert, damit sie später justierbar ist. */
export const STAR_TOTAL = 1500; // scaled by viewport area

const WARM = [255, 224, 176]; // presenceRemote starlight
// #1a2140 lifted in saturation: additive light needs more chroma than a flat swatch
const NEB_BLUE = [22, 42, 112];
const NEB_GOLD = [232, 201, 121]; // #e8c979

// Gemessene Referenzfarben aus der Nutzeraufnahme des Pferdekopfnebels. Nur
// der Nebel wechselt bei remotePresent Richtung diesen Tönen — Sterne bleiben
// in JEDER Hinsicht unangetastet (s. drawStars(), das hier nichts referenziert).
const NEBEL_KERN = [135, 53, 60];   // #87353c — Nebelkern
const NEBEL_HELL = [187, 97, 103];  // #bb6167 — helle Nebelzone

/**
 * Sternbewegung "Strömen zur Mitte" (Main-Display bei beidseitiger Präsenz):
 * eigenständiges, PERSISTENTES Polarkoordinaten-
 * system (strD/strA je Stern) — bewusst UNABHÄNGIG vom bestehenden
 * Tiefensystem (s.x/s.y/s.z, spawn()/seedStars() oben) gehalten, damit
 * dessen Ruhezustand (Parallaxe, Twinkle, seitliches Driften) unangetastet
 * bleibt. Die Bewegungsstärke moveStrength (0..1, ~2000ms ein-/ausgeblendet
 * über targetMoveStrength) blendet Position/Größe/Deckkraft weich zwischen
 * der UNVERÄNDERTEN Basis-Darstellung (moveStrength=0 → exakt wie bisher)
 * und dem Strömen (moveStrength=1) — s. drawStars() weiter unten.
 */
const STAR_MOVE_LERP_MS = 2000; // Ein-/Ausblenden der Bewegungsstärke, beide Richtungen

/** Stellar colour temperatures — real starfields are never one grey. */
const TEMPS = [
  [176, 199, 255], // hot blue
  [214, 228, 255], // blue-white
  [240, 244, 255], // white
  [255, 240, 214], // warm white
  [255, 206, 158], // amber giant
];
const TEMP_WEIGHTS = [0.1, 0.24, 0.34, 0.22, 0.1];

/* ---------------------------- helpers ---------------------------- */

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function rgba(c, a) {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function pickTemp() {
  let r = Math.random();
  for (let i = 0; i < TEMP_WEIGHTS.length; i++) {
    r -= TEMP_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 2;
}

/** Wide soft halo — the atmosphere around a star. */
function haloSprite(color, px = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  // steep falloff on purpose: a gentle one turns every mid-distance star into a
  // fuzzy disc, which is what makes a starfield look like blurred pixels
  grad.addColorStop(0, rgba(color, 1));
  grad.addColorStop(0.06, rgba(color, 0.72));
  grad.addColorStop(0.16, rgba(color, 0.26));
  grad.addColorStop(0.36, rgba(color, 0.07));
  grad.addColorStop(0.68, rgba(color, 0.015));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

/** Tight core — gives near stars a hard, present centre instead of mush. */
function coreSprite(color, px = 32) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, rgba([255, 255, 255], 1));
  grad.addColorStop(0.25, rgba(mix(color, [255, 255, 255], 0.5), 0.9));
  grad.addColorStop(0.6, rgba(color, 0.2));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

const KEYFRAMES = `
  @keyframes ambient-dot {
    0%, 100% { opacity: 0.28; transform: scale(0.92); }
    50%      { opacity: 0.95; transform: scale(1.06); }
  }
  @keyframes ambient-halo {
    0%, 100% { opacity: 0.15; transform: scale(0.8); }
    50%      { opacity: 0.6;  transform: scale(1.25); }
  }
`;

/* --------------------------- component --------------------------- */

export default function AmbientScene({
  presenceRemote = false,
  proximity = 0,
  label = 'System bereit',
  paused = false,
  remotePresent = false,
  starsMoving = false,
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);

  // live prop mirror so the render loop never restarts (presenceRemote ist
  // ein seltener, binärer Zustandswechsel — passender Fall für einen
  // normalen React-Prop, s. visualBus.js Kopf-Dokumentation: "Langsame
  // Werte ... laufen weiterhin normal über Props").
  const targetPresence = useRef(presenceRemote ? 1 : 0);
  // paused (Performance): während eines Calls ist die Szene ohnehin
  // unsichtbar hinter dem Video (s. MainDisplay.jsx) — gleiches
  // Ref-Mirror-Muster, damit die rAF-Schleife nicht neu aufgebaut werden
  // muss (kein Auf-/Abbau von WebAudio/Canvas, s. presence oben).
  const pausedRef = useRef(paused);
  // Gleiches Ref-Mirror-Muster wie oben. "läuft kein Call" ist hier NICHT
  // extra zu prüfen — während eines Calls ist diese Szene über paused (s.o.)
  // ohnehin pausiert bzw. per Opacity unsichtbar (s. MainDisplay.jsx/
  // AuxDisplay.jsx), der Nebel-Tint bleibt also praktisch unsichtbar, selbst
  // wenn er intern weiterrechnet.
  const targetNebulaTint = useRef(remotePresent ? 1 : 0);
  // Gleiches Ref-Mirror-Muster wie oben.
  const targetMoveStrength = useRef(starsMoving ? 1 : 0);

  useEffect(() => {
    targetPresence.current = presenceRemote ? 1 : 0;
  }, [presenceRemote]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    targetNebulaTint.current = remotePresent ? 1 : 0;
  }, [remotePresent]);
  useEffect(() => {
    targetMoveStrength.current = starsMoving ? 1 : 0;
  }, [starsMoving]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return undefined;

    let w = 0;
    let h = 0;
    let dpr = 1;
    // devScale = dpr * RENDER_SCALE: einziger Faktor, der logische (CSS-)
    // Pixel auf den (bewusst kleineren) Canvas-Backing-Store abbildet —
    // von resize() gesetzt, von paintBg() beim Transform-Reset mitgenutzt.
    let devScale = 1;
    let scale = 1; // 1 at 3840px wide
    let cx = 0;
    let cy = 0;
    let f = 1; // focal length in px

    const stars = [];
    const blobs = [];
    let shot = null;
    let nextShot = SHOOT_MIN + Math.random() * (SHOOT_MAX - SHOOT_MIN);

    /* --------------------------- sprites -------------------------- */

    let halos = TEMPS.map((c) => haloSprite(c));
    let cores = TEMPS.map((c) => coreSprite(c));
    // flat colours for the single-pixel far stars, kept in sync with the sprites
    let tempCss = TEMPS.map((c) => rgba(c, 1));
    let spriteKey = -1;
    const spriteFlare = haloSprite(mix(TEMPS[3], WARM, 0.5));

    function rebuildSprites(key) {
      // every temperature drifts toward warm together when presence rises
      const tinted = TEMPS.map((c) => mix(c, WARM, key));
      halos = tinted.map((c) => haloSprite(c));
      cores = tinted.map((c) => coreSprite(c));
      tempCss = tinted.map((c) => rgba(c, 1));
    }

    // low-res nebula buffer, upscaled — soft by nature, cheap at 4K
    const neb = document.createElement('canvas');
    const nctx = neb.getContext('2d');
    let nebAge = 1e9;

    // baked deep-background: diffuse galactic glow + dust dropouts only.
    // Soft by nature, so it survives being upscaled from a small buffer.
    const deep = document.createElement('canvas');
    const dctx = deep.getContext('2d');

    // unresolved background stars, baked at DEVICE resolution and blitted 1:1
    // with smoothing off — that is what makes them read as hard pixels instead
    // of the grey mush an upscaled buffer produces
    const grain = document.createElement('canvas');
    const gctx = grain.getContext('2d');

    // flattened background (base + band + nebula) at device resolution, so the
    // per-frame cost is one unscaled copy instead of two upscaled composites
    const bg = document.createElement('canvas');
    const bgctx = bg.getContext('2d', { alpha: false });

    /* ---------------------- build / resize ---------------------- */

    function spawn(s, initial) {
      // place by screen position, then invert the projection, so coverage is
      // even no matter how far away the star starts
      const z = initial ? Z_NEAR + Math.random() * (Z_FAR - Z_NEAR) : Z_FAR * (0.95 + Math.random() * 0.05);
      const sx = (Math.random() * 1.18 - 0.09) * w;
      const sy = (Math.random() * 1.18 - 0.09) * h;
      s.z = z;
      s.x = ((sx - cx) * z) / f;
      s.y = ((sy - cy) * z) / f;
    }

    function seedStars() {
      stars.length = 0;
      const n = Math.round(STAR_TOTAL * clamp((w * h) / (3840 * 2160), 0.4, 1.15));
      for (let i = 0; i < n; i++) {
        const s = {
          x: 0,
          y: 0,
          z: 1,
          // heavily skewed: a few real anchors, a lot of faint dust
          size: 0.0007 + Math.pow(Math.random(), 3.2) * 0.0042,
          lum: 0.3 + Math.pow(Math.random(), 1.7) * 0.85,
          temp: pickTemp(),
          tw: 0.1 + Math.random() * 0.55,
          ph: Math.random() * Math.PI * 2,
          presenceOnly: Math.random() < 0.3,
          cull: i % 3 === 0,
          sx: 0,
          sy: 0,
          sr: 0,
          // Sternbewegung (s. Kopf-Dokumentation "Strömen zur Mitte"):
          // eigenes, vom Tiefensystem unabhängiges Polarkoordinatenpaar.
          strD: 0.3 + Math.random() * 0.8,
          strA: Math.random() * Math.PI * 2,
          strTempo: 0.55 + Math.random() * 0.9,   // fester Zufallswert je Stern
          strFadeFrom: null,                       // s.u., beim ersten Frame gesetzt
        };
        s.strFadeFrom = s.strD;
        spawn(s, true);
        stars.push(s);
      }
    }

    function seedBlobs() {
      blobs.length = 0;
      const spots = [
        [0.24, 0.34, 0.58, 0.0],
        [0.7, 0.28, 0.46, 0.55],
        [0.52, 0.62, 0.66, 0.25],
        [0.86, 0.72, 0.4, 0.8],
        [0.1, 0.78, 0.44, 0.4],
        [0.42, 0.14, 0.34, 0.7],
      ];
      for (const [fx, fy, fr, tint] of spots) {
        blobs.push({
          x: fx,
          y: fy,
          r: fr,
          ph: Math.random() * Math.PI * 2,
          tint,
          a: 0.1 + Math.random() * 0.07,
        });
      }
    }

    /** Galactic band + dust: baked once, blitted as a single distant layer. */
    function bakeDeep() {
      const bw = deep.width;
      const bh = deep.height;
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.clearRect(0, 0, bw, bh);

      const diag = Math.hypot(bw, bh);
      dctx.save();
      dctx.translate(bw * 0.5, bh * 0.44);
      dctx.rotate(-0.34); // band tilt

      // diffuse milky glow along the band axis
      dctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const spread = diag * (0.055 + i * 0.055);
        const g = dctx.createLinearGradient(0, -spread, 0, spread);
        const col = i === 0 ? [150, 172, 224] : [96, 116, 172];
        const a = 0.05 - i * 0.012;
        g.addColorStop(0, rgba(col, 0));
        g.addColorStop(0.42, rgba(col, a * 0.55));
        g.addColorStop(0.5, rgba(col, a));
        g.addColorStop(0.58, rgba(col, a * 0.55));
        g.addColorStop(1, rgba(col, 0));
        dctx.fillStyle = g;
        dctx.fillRect(-diag, -spread, diag * 2, spread * 2);
      }

      // dark dust lanes carved straight out of the band
      dctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 26; i++) {
        const x = (Math.random() - 0.5) * diag * 1.7;
        const y = (Math.random() - 0.5) * diag * 0.14;
        const rx = diag * (0.03 + Math.random() * 0.11);
        const ry = rx * (0.18 + Math.random() * 0.3);
        const g = dctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        g.addColorStop(0, 'rgba(0,0,0,0.85)');
        g.addColorStop(0.55, 'rgba(0,0,0,0.4)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        dctx.save();
        dctx.translate(x, y);
        dctx.rotate((Math.random() - 0.5) * 0.5);
        dctx.scale(rx, ry);
        dctx.fillStyle = g;
        dctx.beginPath();
        dctx.arc(0, 0, 1, 0, Math.PI * 2);
        dctx.fill();
        dctx.restore();
      }
      dctx.restore();
      dctx.globalCompositeOperation = 'source-over';
    }

    /**
     * The distant sky: hard single-pixel stars, one per device pixel, never
     * interpolated. Baked once per resize because there are tens of thousands.
     */
    function bakeGrain() {
      const bw = grain.width;
      const bh = grain.height;
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.clearRect(0, 0, bw, bh);

      const diag = Math.hypot(bw, bh);
      const ang = -0.34; // matches the band tilt in bakeDeep
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ox = bw * 0.5;
      const oy = bh * 0.44;

      // count follows pixel area so density looks identical at 4K and on a laptop
      const n = Math.round(clamp((bw * bh) / 8000, 2600, 34000));

      for (let i = 0; i < n; i++) {
        // two thirds cluster into the band, the rest fill the whole sky
        const inBand = Math.random() < 0.66;
        let px;
        let py;
        if (inBand) {
          // gaussian-ish falloff off the band axis
          const gy = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
          const lx = (Math.random() - 0.5) * diag * 1.9;
          const ly = gy * diag * 0.1;
          px = ox + lx * ca - ly * sa;
          py = oy + lx * sa + ly * ca;
        } else {
          px = Math.random() * bw;
          py = Math.random() * bh;
        }
        if (px < 0 || py < 0 || px >= bw || py >= bh) continue;

        // brightness is heavily skewed so the field has structure rather than
        // an even sprinkle: mostly the faintest dust, a few readable points
        const q = Math.random();
        const a = inBand ? 0.1 + Math.pow(q, 2.1) * 0.75 : 0.07 + Math.pow(q, 2.6) * 0.6;
        const t = TEMPS[pickTemp()];
        gctx.fillStyle = rgba(t, a);

        const x = px | 0;
        const y = py | 0;
        if (q > 0.985) {
          // the rare brighter ones get a 2px core plus faint pixel neighbours,
          // which is what makes a pixel sky feel three-dimensional
          gctx.fillRect(x, y, 2, 2);
          gctx.fillStyle = rgba(t, a * 0.3);
          gctx.fillRect(x - 1, y, 1, 2);
          gctx.fillRect(x + 2, y, 1, 2);
          gctx.fillRect(x, y - 1, 2, 1);
          gctx.fillRect(x, y + 2, 2, 1);
        } else {
          gctx.fillRect(x, y, 1, 1);
        }
      }
    }

    function resize() {
      const rect = host.getBoundingClientRect();
      // keep total pixels sane on hi-dpi laptops; signage panels report dpr 1
      dpr = Math.min(window.devicePixelRatio || 1, rect.width > 2200 ? 1 : 1.5);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      devScale = dpr * RENDER_SCALE;
      // Backing-Store bewusst kleiner als die Anzeigegröße (RENDER_SCALE) —
      // canvas.style.width/height bleiben auf voller Elementgröße, der
      // Browser skaliert per CSS/GPU verlustarm hoch (imageRendering bleibt
      // auf dem Default "auto": weiche Interpolation ist hier erwünscht).
      canvas.width = Math.round(w * devScale);
      canvas.height = Math.round(h * devScale);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(devScale, 0, 0, devScale, 0, 0);
      scale = clamp(w / 3840, 0.4, 1.4);
      cx = w / 2;
      cy = h * 0.48;
      f = Math.min(w, h) * 0.95;

      const lw = Math.max(220, Math.round(w / 6));
      const lh = Math.max(124, Math.round(h / 6));
      neb.width = lw;
      neb.height = lh;
      nebAge = 1e9;

      deep.width = Math.min(1900, Math.max(700, Math.round(w * 0.55)));
      deep.height = Math.round(deep.width * (h / w));
      bakeDeep();

      grain.width = canvas.width;
      grain.height = canvas.height;
      bakeGrain();

      bg.width = canvas.width;
      bg.height = canvas.height;
      // bg teilt sich den Backing-Store 1:1 mit dem Haupt-Canvas (s. oben) —
      // derselbe devScale-Transform, sonst würde bgctx auf ein zu großes
      // Ziel zeichnen (Bildausschnitt statt vollem Bild).
      bgctx.setTransform(devScale, 0, 0, devScale, 0, 0);

      seedStars();
      if (!blobs.length) seedBlobs();
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    /* --------------------------- loop --------------------------- */

    let raf = 0;
    let last = performance.now();
    let t = 0; // elapsed ms
    let presence = targetPresence.current;
    let nebulaTint = targetNebulaTint.current;
    let moveStrength = targetMoveStrength.current;
    // proximity ist HOCHFREQUENT (~8x/s) — kommt wie bei ParticleField.jsx/
    // AuxRingScene.jsx direkt aus visualBus statt über einen React-Prop
    // (s. Kopf-Dokumentation in visualBus.js); der proximity-Prop dient nur
    // als initialer Seed-Wert (z.B. für Nutzung ohne laufenden visualBus).
    let prox = clamp(proximity);
    let visible = true;
    // adaptive quality: on a weak signage player the faintest dust is thinned
    // rather than letting the whole scene stutter
    let frameEma = 16;
    let lean = false;

    const onVis = () => {
      visible = document.visibilityState === 'visible';
      last = performance.now();
    };
    document.addEventListener('visibilitychange', onVis);

    function drawNebula(breath, nebulaTint) {
      const lw = neb.width;
      const lh = neb.height;
      nctx.clearRect(0, 0, lw, lh);
      nctx.globalCompositeOperation = 'lighter';
      const secs = t / 1000;
      for (const b of blobs) {
        const local = 0.5 - 0.5 * Math.cos((secs / (NEBULA_CYCLE / 1000)) * Math.PI * 2 + b.ph);
        const mixed = clamp(b.tint * 0.55 + breath * 0.6 * (0.4 + b.tint), 0, 1);
        let col = mix(NEB_BLUE, NEB_GOLD, mixed * 0.46);
        // Grundton weich Richtung NEBEL_KERN, wenn drüben jemand steht —
        // nebulaTint ist bereits die 1s-gedämpfte Übergangsvariable von oben
        // (frame()), hier nur noch angewendet.
        if (nebulaTint > 0.001) col = mix(col, NEBEL_KERN, nebulaTint * 0.85);
        const drift = Math.sin(secs * 0.02 + b.ph) * 0.02;
        const bx = (b.x + drift) * lw;
        const by = (b.y + Math.cos(secs * 0.016 + b.ph) * 0.015) * lh;
        const rad = b.r * Math.max(lw, lh) * (0.82 + 0.3 * local);
        const alpha = b.a * (0.55 + 0.65 * local) * (1 + breath * 0.25);
        const g = nctx.createRadialGradient(bx, by, 0, bx, by, rad);
        g.addColorStop(0, rgba(col, alpha));
        g.addColorStop(0.45, rgba(col, alpha * 0.42));
        g.addColorStop(1, rgba(col, 0));
        nctx.fillStyle = g;
        nctx.beginPath();
        nctx.arc(bx, by, rad, 0, Math.PI * 2);
        nctx.fill();

        // Zweiter, schwächerer Verlauf in NEBEL_HELL — nur während des
        // Übergangs, etwas größer und blasser als der Grundton-Layer oben.
        if (nebulaTint > 0.001) {
          const hellAlpha = alpha * 0.4 * nebulaTint;
          const hellRad = rad * 1.15;
          const gh = nctx.createRadialGradient(bx, by, 0, bx, by, hellRad);
          gh.addColorStop(0, rgba(NEBEL_HELL, hellAlpha));
          gh.addColorStop(0.5, rgba(NEBEL_HELL, hellAlpha * 0.4));
          gh.addColorStop(1, rgba(NEBEL_HELL, 0));
          nctx.fillStyle = gh;
          nctx.beginPath();
          nctx.arc(bx, by, hellRad, 0, Math.PI * 2);
          nctx.fill();
        }
      }
      nctx.globalCompositeOperation = 'source-over';
    }

    function paintBg(breath) {
      // true black with only a whisper of blue — space is black, and a dark
      // panel is what lets faint single pixels read from three metres away
      bgctx.globalCompositeOperation = 'source-over';
      bgctx.globalAlpha = 1;
      bgctx.fillStyle = `rgb(${1 + breath},${2 + breath},${5 + breath * 3})`;
      bgctx.fillRect(0, 0, w, h);

      bgctx.globalCompositeOperation = 'lighter';

      // diffuse layers first, interpolated
      bgctx.imageSmoothingEnabled = true;
      bgctx.imageSmoothingQuality = 'high';
      bgctx.globalAlpha = 0.34 + breath * 0.06;
      bgctx.drawImage(deep, 0, 0, w, h);
      bgctx.globalAlpha = 0.88;
      bgctx.drawImage(neb, 0, 0, w, h);

      // then the pixel sky, blitted device-pixel-for-device-pixel
      bgctx.setTransform(1, 0, 0, 1, 0, 0);
      bgctx.imageSmoothingEnabled = false;
      bgctx.globalAlpha = 1;
      bgctx.drawImage(grain, 0, 0);
      bgctx.setTransform(devScale, 0, 0, devScale, 0, 0);
      bgctx.globalCompositeOperation = 'source-over';
    }

    /** Four-point diffraction cross — reserved for the few nearest anchors. */
    function drawFlare(x, y, r, a, temp) {
      const len = r * 7;
      const col = mix(TEMPS[temp], [255, 255, 255], 0.35);
      ctx.lineWidth = Math.max(0.6, r * 0.22);
      for (let i = 0; i < 2; i++) {
        const horiz = i === 0;
        const ex = horiz ? len : 0;
        const ey = horiz ? 0 : len * 0.72;
        const g = ctx.createLinearGradient(x - ex, y - ey, x + ex, y + ey);
        g.addColorStop(0, rgba(col, 0));
        g.addColorStop(0.5, rgba(col, a * 0.5));
        g.addColorStop(1, rgba(col, 0));
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - ex, y - ey);
        ctx.lineTo(x + ex, y + ey);
        ctx.stroke();
      }
    }

    function drawStars(dt, secs, moveStrength) {
      const reach = Math.hypot(w, h) * 0.5;
      const push = prox * Math.min(w, h) * 0.09;
      // proximity also dollies the camera a hair forward: real depth response
      const zSquash = 1 - prox * 0.07;
      const dts = dt / 1000;

      ctx.globalCompositeOperation = 'lighter';
      for (const s of stars) {
        // approach the camera; near stars sweep faster purely from perspective
        s.z -= (0.006 + s.size * 1.6) * dts;
        s.x += 0.0009 * dts; // whole field drifts sideways
        if (s.z <= Z_NEAR) {
          spawn(s, false);
          continue;
        }

        const z = s.z * zSquash;
        let x = cx + (s.x * f) / z;
        let y = cy + (s.y * f) / z;
        const margin = 60;
        if (x < -margin || x > w + margin || y < -margin || y > h + margin) {
          spawn(s, false);
          continue;
        }
        if (lean && s.cull) continue;

        if (push > 0.5) {
          const dx = x - cx;
          const dy = y - cy;
          const d = Math.hypot(dx, dy) || 1;
          // stronger near the centre and on near stars → space opens in the middle
          const falloff = Math.exp(-(d / reach) * 1.9);
          const p = push * falloff * (0.35 + 0.65 / (z * 2));
          x += (dx / d) * p;
          y += (dy / d) * p;
        }

        let r = Math.min((s.size * f) / z, 13 * scale + 4);
        const twinkle = 0.76 + 0.24 * Math.sin(secs * s.tw * 2 + s.ph);
        // depth attenuation + soft fades at both ends of the volume
        const depth = clamp(1.16 - s.z * 0.62, 0.12, 1);
        const enter = clamp((Z_FAR - s.z) / (Z_FAR * 0.08));
        const exit = clamp((s.z - Z_NEAR) / (Z_NEAR * 0.7));
        let a = s.lum * twinkle * depth * enter * exit;
        if (s.presenceOnly) a *= presence * 0.95;
        else a *= 0.84 + presence * 0.22;
        if (a <= 0.005) continue;

        // ── Sternbewegung "Strömen zur Mitte" ───────────────────────────────
        // Eigenes, persistentes Polarkoordinatenpaar (strD/strA) je Stern,
        // UNABHÄNGIG vom Tiefensystem oben. Bei moveStrength=0 sind alle
        // Deltas exakt 0 UND x/y/r/a werden unten per Lerp-Gewicht 0 exakt
        // auf die soeben berechnete Basis zurückgeblendet — die Szene sieht
        // im Ruhezustand exakt wie bisher aus.
        const naeh = Math.max(0, 1 - s.strD / 1.1);
        const prevStrD = s.strD;
        const prevStrA = s.strA;
        s.strD -= dts * moveStrength * (0.020 + 0.085 * naeh * naeh) * s.strTempo;
        s.strA += dts * moveStrength * (0.10 + 0.55 * naeh * naeh) * s.strTempo;
        let justRespawned = false;
        if (s.strD < 0.05) {
          s.strA = Math.random() * Math.PI * 2;
          s.strD = 0.62 + Math.random() * 0.5;
          s.strFadeFrom = s.strD;
          justRespawned = true;
        }
        const strFadeIn = clamp((s.strFadeFrom - s.strD) / 0.14, 0, 1);
        const strX = cx + Math.cos(s.strA) * s.strD * reach;
        const strY = cy + Math.sin(s.strA) * s.strD * reach * 0.80;
        // Bahn-Richtung fürs Schweif (s.u.): aus der tatsächlichen Verschiebung
        // dieses Frames — nach einem Neuanlegen ist sie bewusst 0 (kein
        // Sprung quer durchs Bild).
        const prevStrX = justRespawned ? strX : cx + Math.cos(prevStrA) * prevStrD * reach;
        const prevStrY = justRespawned ? strY : cy + Math.sin(prevStrA) * prevStrD * reach * 0.80;

        x += (strX - x) * moveStrength;
        y += (strY - y) * moveStrength;
        r *= 1 + naeh * 0.45 * moveStrength;
        const streamAlpha = (0.24 + 0.46 * naeh) * strFadeIn + twinkle;
        a += (streamAlpha - a) * moveStrength;

        s.sx = x;
        s.sy = y;
        s.sr = r;

        // Far dust is drawn as a snapped single device pixel rather than a
        // scaled sprite: a sub-pixel sprite only ever resolves to a grey smudge.
        if (r < 1.25) {
          const px = 1 / dpr;
          ctx.globalAlpha = clamp(a * 0.95 * (0.4 + r * 0.55), 0, 1);
          ctx.fillStyle = tempCss[s.temp];
          ctx.fillRect(Math.round(x * dpr) / dpr, Math.round(y * dpr) / dpr, px, px);
          continue;
        }

        // the halo fades in with size, so nothing in the middle distance shows
        // up as a milky patch without a star inside it
        const hr = r * 3.1;
        ctx.globalAlpha = clamp(a * 0.8 * clamp((r - 1.1) / 1.8, 0.15, 1), 0, 1);
        ctx.drawImage(halos[s.temp], x - hr, y - hr, hr * 2, hr * 2);

        // every sprite star gets a resolved core so none of them reads as a disc
        {
          const kr = r * 0.95;
          ctx.globalAlpha = clamp(a, 0, 1);
          ctx.drawImage(cores[s.temp], x - kr, y - kr, kr * 2, kr * 2);
          // spikes only on the genuinely close anchors, and kept faint: a calm
          // room should never have anything that reads as a sparkle
          if (r > 6 * scale + 3.4 && !lean) drawFlare(x, y, r, clamp(a * 0.3, 0, 1), s.temp);
        }

        // Feiner Schweif: lineCap wird explizit auf 'butt' gesetzt, sonst
        // übernimmt der Canvas-Kontext das 'round' von updateShot()/dem
        // Shooting-Star weiter unten und der Schweif wirkt wie ein dicker
        // Balken. Nur ab moveStrength > 0.05 UND nur für die hellsten Sterne
        // (a >= 0.35), nur für sprite-gezeichnete Sterne (Performance).
        if (moveStrength > 0.05 && a >= 0.35) {
          const dirX = strX - prevStrX;
          const dirY = strY - prevStrY;
          const dirLen = Math.hypot(dirX, dirY) || 1;
          const tailLen = (0.003 + 0.018 * naeh * naeh) * moveStrength * reach;
          const tailX = x - (dirX / dirLen) * tailLen;
          const tailY = y - (dirY / dirLen) * tailLen;
          // Verlauf vom Stern (volle Schweifdeckkraft) zum äußeren Ende
          // (Deckkraft 0) — verhindert den "Balken mit zwei runden Enden".
          const tailAlpha = clamp(a * 0.3, 0, 1);
          const tailGrad = ctx.createLinearGradient(x, y, tailX, tailY);
          tailGrad.addColorStop(0, rgba(TEMPS[s.temp], tailAlpha));
          tailGrad.addColorStop(1, rgba(TEMPS[s.temp], 0));
          ctx.globalAlpha = 1;
          ctx.strokeStyle = tailGrad;
          ctx.lineWidth = r * 0.35;
          ctx.lineCap = 'butt';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(tailX, tailY);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function updateShot(dt) {
      if (!shot) {
        nextShot -= dt;
        if (nextShot <= 0) {
          nextShot = SHOOT_MIN + Math.random() * (SHOOT_MAX - SHOOT_MIN);
          const fromLeft = Math.random() < 0.5;
          const ang = (Math.random() * 0.22 + 0.12) * Math.PI;
          const speed = (Math.min(w, h) / 1000) * (620 + Math.random() * 260);
          shot = {
            t: 0,
            life: 1400 + Math.random() * 900,
            x: fromLeft ? -w * 0.05 : w * 1.05,
            y: h * (0.05 + Math.random() * 0.45),
            vx: Math.cos(ang) * speed * (fromLeft ? 1 : -1),
            vy: Math.sin(ang) * speed,
            len: Math.min(w, h) * (0.1 + Math.random() * 0.08),
          };
        }
        return;
      }

      shot.t += dt;
      const k = shot.t / shot.life;
      if (k >= 1) {
        shot = null;
        return;
      }
      shot.x += (shot.vx * dt) / 1000;
      shot.y += (shot.vy * dt) / 1000;

      // fade in / long fade out
      const env = Math.sin(Math.PI * Math.pow(k, 0.7)) * 0.75;
      const mag = Math.hypot(shot.vx, shot.vy) || 1;
      const ux = shot.vx / mag;
      const uy = shot.vy / mag;
      const tailX = shot.x - ux * shot.len;
      const tailY = shot.y - uy * shot.len;
      const head = mix(TEMPS[2], NEB_GOLD, 0.35);

      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(tailX, tailY, shot.x, shot.y);
      g.addColorStop(0, rgba(head, 0));
      g.addColorStop(0.72, rgba(head, env * 0.28));
      g.addColorStop(1, rgba(head, env * 0.75));
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1, 2.2 * scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(shot.x, shot.y);
      ctx.stroke();

      const hr = 7 * scale + 3;
      ctx.globalAlpha = env;
      ctx.drawImage(spriteFlare, shot.x - hr, shot.y - hr, hr * 2, hr * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      // paused (Performance): rAF-Schleife komplett aussetzen — kein
      // Zeichnen, keine Physik. Sterne/Blobs/shot bleiben unangetastet
      // (Zustand bleibt erhalten), last wird nachgezogen, damit dt beim
      // Fortsetzen nicht die gesamte Pausendauer nachholen will.
      if (pausedRef.current) { last = now; return; }
      // 30fps-Deckel: Frame überspringen, wenn seit dem letzten gezeichneten
      // Frame weniger als TARGET_FRAME_MS vergangen sind (s. Konstante oben).
      if (now - last < TARGET_FRAME_MS) return;
      const dt = Math.min(now - last, 50);
      last = now;
      if (!visible) return;
      t += dt;
      const secs = t / 1000;

      frameEma += (dt - frameEma) * 0.04;
      if (!lean && frameEma > 26) lean = true;
      else if (lean && frameEma < 19) lean = false;

      // eased prop response — nothing ever snaps
      presence += (targetPresence.current - presence) * (1 - Math.exp(-dt / 900));
      // ~1s gedämpfter Übergang in beide Richtungen (rein/raus), exakt
      // dasselbe Dämpfungsmuster wie presence oben — kein Springen, kein Blinken.
      nebulaTint += (targetNebulaTint.current - nebulaTint) * (1 - Math.exp(-dt / 1000));
      // ~2000ms gedämpfter Übergang in beide Richtungen, exakt dasselbe
      // Muster — bei moveStrength=0 rechnet
      // drawStars() zwar weiter mit, der Beitrag ist dann aber exakt 0
      // (s. dort), die Basis-Darstellung bleibt unverändert.
      moveStrength += (targetMoveStrength.current - moveStrength) * (1 - Math.exp(-dt / STAR_MOVE_LERP_MS));
      // Fallback auf den proximity-Prop, falls visualBus.proximity aus
      // irgendeinem Grund undefined wäre (regulär immer gesetzt, s. onProxi-
      // mityChange in App.jsx / visualBus.js) — proximity ist hier der
      // Closure-Wert vom Mount, also nur als Notnagel, nicht als Live-Wert.
      prox += (clamp(visualBus.proximity ?? proximity) - prox) * (1 - Math.exp(-dt / 420));

      const breath = 0.5 - 0.5 * Math.cos((t / NEBULA_CYCLE) * Math.PI * 2);

      // presence tint is quantised so star sprites are rebuilt rarely
      const key = Math.round(presence * 0.6 * 16) / 16;
      if (key !== spriteKey) {
        spriteKey = key;
        rebuildSprites(key);
      }

      // the nebula moves over 30s — reflattening the background 8x/second is
      // imperceptible and keeps the per-frame work down to one copy
      nebAge += dt;
      if (nebAge > 125) {
        nebAge = 0;
        drawNebula(breath, nebulaTint);
        paintBg(breath);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bg, 0, 0, w, h);

      // sprite scaling stays cheap: thousands of blits per frame
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      drawStars(dt, secs, moveStrength);
      updateShot(dt);
    }

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return (
    <div ref={hostRef} style={S.root} aria-label="Ambient status display">
      <canvas ref={canvasRef} style={S.canvas} />

      {/* vignette as a composited layer — keeps the canvas loop free of a full-screen pass */}
      <div style={S.vignette} />

      <div style={S.labelRow}>
        <span style={S.labelText}>{label}</span>
        <span style={S.dotWrap}>
          <span style={S.dot} />
          <span style={S.dotHalo} />
        </span>
      </div>

      <style>{KEYFRAMES}</style>
    </div>
  );
}

const S = {
  root: {
    position:   'relative',
    width:      '100%',
    height:     '100%',
    overflow:   'hidden',
    background: '#03050b',
  },
  canvas: {
    display: 'block',
    width:   '100%',
    height:  '100%',
  },
  // vignette as a composited layer — keeps the canvas loop free of a full-screen pass
  vignette: {
    pointerEvents: 'none',
    position:      'absolute',
    inset:         0,
    background:
      'radial-gradient(120% 105% at 50% 46%, rgba(0,0,0,0) 40%, rgba(0,1,4,0.34) 74%, rgba(0,1,4,0.84) 100%)',
  },
  labelRow: {
    pointerEvents:  'none',
    position:       'absolute',
    left:           0,
    right:          0,
    bottom:         '4.5%',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '0.9em',
  },
  labelText: {
    fontFamily:     "'Courier New', monospace",
    fontSize:       'clamp(11px, 0.62vw, 26px)',
    textTransform:  'uppercase',
    color:          'rgba(212,175,90,0.4)',
    letterSpacing:  '0.42em',
    textIndent:     '0.42em',
  },
  dotWrap: {
    position:   'relative',
    display:    'flex',
    height:     '6px',
    width:      '6px',
    flexShrink: 0,
  },
  dot: {
    position:     'absolute',
    inset:        0,
    borderRadius: '50%',
    background:   'rgba(212,175,90,0.85)',
    animation:    'ambient-dot 6s ease-in-out infinite',
  },
  dotHalo: {
    position:     'absolute',
    inset:        '-5px',
    borderRadius: '50%',
    background:   'radial-gradient(circle, rgba(212,175,90,0.35), rgba(212,175,90,0))',
    animation:    'ambient-halo 6s ease-in-out infinite',
  },
};

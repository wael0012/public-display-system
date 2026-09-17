/**
 * AmbientDisplay.jsx
 *
 * Ambient- und Erkennungs-Anzeige für den Einzelbildschirm-Anzeigepfad
 * (aktiv bei ?screen=1 oder ?screen=2, siehe App.jsx): Partikelfeld mit
 * rotierenden Botschaften im AMBIENT-Zustand, Einladungskarte mit
 * Fortschrittsring im DETECTING-Zustand. Bei screenMode=1 empfängt sie
 * zusätzlich per BroadcastChannel Phasenwechsel von InvitationScreen.jsx
 * (Bildschirm 2) und blendet ein herüberwanderndes Einladungs-Overlay ein.
 *
 * @author Wael Hammami
 */

import React, {
  useEffect, useRef, useState, useCallback,
} from 'react';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Anzahl der Partikel im Partikel-System */
const PARTICLE_COUNT = 120;

/** Maximale Distanz für Verbindungslinien (px) */
const CONNECTION_DISTANCE = 130;

/** Einflussradius der Maus (px) */
const MOUSE_RADIUS = 160;

/** Abstoßungsstärke */
const MOUSE_FORCE = 0.06;

/** Anzeigedauer jeder Nachricht (ms) */
const MSG_DURATION = 4_000;

/** Fade-Dauer (ms) */
const FADE_DURATION = 700;

/** Kreisumfang des Fortschrittsrings (r=80) */
const RING_R = 80;
const RING_C = 2 * Math.PI * RING_R; // ≈ 502.65

/** Nachrichten die im Ambient-Modus rotieren */
const MESSAGES = [
  'Welcome',
  'Step a little closer',
  'Interactive Display',
  'Video connection available',
  'Someone is waiting for you',
];

// ---------------------------------------------------------------------------
// Partikel-Klasse
// ---------------------------------------------------------------------------

/**
 * Einzelnes Partikel im Canvas-Partikel-System.
 * Bewegt sich autonom und wird von der Maus abgestoßen.
 */
class Particle {
  /**
   * @param {number} w – Canvas-Breite
   * @param {number} h – Canvas-Höhe
   */
  constructor(w, h) {
    this._init(w, h);
  }

  /** Setzt das Partikel auf eine zufällige Startposition. */
  _init(w, h) {
    this.x  = Math.random() * w;
    this.y  = Math.random() * h;
    this.vx = (Math.random() - 0.5) * 0.6;
    this.vy = (Math.random() - 0.5) * 0.6;
    this.r  = Math.random() * 2 + 0.8;
    const alpha = Math.random() * 0.45 + 0.15;
    this.color  = `rgba(100,200,255,${alpha.toFixed(2)})`;
  }

  /**
   * Aktualisiert Position und Geschwindigkeit.
   * @param {number} w     – Canvas-Breite
   * @param {number} h     – Canvas-Höhe
   * @param {{ x:number|null, y:number|null }} mouse – Mausposition
   */
  update(w, h, mouse) {
    // Mausabstoßung berechnen
    if (mouse.x !== null && mouse.y !== null) {
      const dx   = this.x - mouse.x;
      const dy   = this.y - mouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist < MOUSE_RADIUS && dist > 0) {
        const force = (MOUSE_RADIUS - dist) / MOUSE_RADIUS;
        this.vx += (dx / dist) * force * MOUSE_FORCE;
        this.vy += (dy / dist) * force * MOUSE_FORCE;
      }
    }

    // Geschwindigkeitsabnahme (Dämpfung)
    this.vx *= 0.99;
    this.vy *= 0.99;

    // Position vorwärts bewegen
    this.x += this.vx;
    this.y += this.vy;

    // Randbehandlung: Partikel erscheinen auf der gegenüberliegenden Seite wieder
    if (this.x < 0)  this.x = w;
    if (this.x > w)  this.x = 0;
    if (this.y < 0)  this.y = h;
    if (this.y > h)  this.y = 0;
  }

  /**
   * Zeichnet das Partikel als gefüllten Kreis.
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: globale CSS-Animationen einmalig einfügen
// ---------------------------------------------------------------------------

let _stylesInjected = false;

/** Fügt Keyframe-Animationen in den Document-Head ein (einmalig). */
function injectGlobalStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes ad-pulse {
      0%,100% { opacity:1; box-shadow: 0 0 6px #64c8ff; }
      50%      { opacity:0.3; box-shadow: 0 0 2px #64c8ff; }
    }
    @keyframes ad-ring-rotate {
      from { transform: rotate(-90deg); }
      to   { transform: rotate(270deg); }
    }
    @keyframes ad-blink {
      0%,100% { opacity: 0.6; }
      50%      { opacity: 0.2; }
    }
    @keyframes ad-invite-float {
      0%,100% { transform: perspective(900px) rotateX(8deg) rotateY(-7deg) translateY(0); }
      50% { transform: perspective(900px) rotateX(5deg) rotateY(7deg) translateY(-12px); }
    }
    @keyframes ad-invite-ring {
      0% { transform: scale(0.78); opacity: 0.54; }
      100% { transform: scale(1.55); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

/**
 * AmbientDisplay-Komponente.
 *
 * @component
 * @param {Object} props
 * @param {'AMBIENT'|'DETECTING'|'HANDSHAKE'|'ACTIVE'} props.state – Aktueller Systemzustand
 * @returns {JSX.Element}
 */
const AmbientDisplay = ({
  state = 'AMBIENT',
  inviteReady = false,
  faceCount = 0,
  meshReady = false,
  screenMode = null,
}) => {
  // Canvas & Animation
  const canvasRef       = useRef(null);
  const animFrameRef    = useRef(null);
  const particlesRef    = useRef([]);
  const mouseRef        = useRef({ x: null, y: null });

  // Nachrichtenrotation
  const [msgIndex,   setMsgIndex]   = useState(0);
  const [msgOpacity, setMsgOpacity] = useState(1);
  const msgIntervalRef = useRef(null);
  const fadeTimerRef   = useRef(null);

  // Fortschrittsring: kontrolliert via CSS-Animation, kein JS-Timer nötig
  const [showRing, setShowRing] = useState(false);

  // Fensterdimensionen für SVG-Ecken
  const [dim, setDim] = useState({
    w: window.innerWidth,
    h: window.innerHeight,
  });

  // Screen-1 visitor overlay: phase driven by BroadcastChannel from InvitationScreen
  const [visitorPhase, setVisitorPhase] = useState('hidden');

  // ---------------------------------------------------------------------------
  // CSS injizieren
  // ---------------------------------------------------------------------------
  useEffect(() => { injectGlobalStyles(); }, []);

  // ---------------------------------------------------------------------------
  // Fenstergröße überwachen
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onResize = () => setDim({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---------------------------------------------------------------------------
  // Partikel initialisieren
  // ---------------------------------------------------------------------------
  const initParticles = useCallback((w, h) => {
    particlesRef.current = Array.from(
      { length: PARTICLE_COUNT },
      () => new Particle(w, h),
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Verbindungslinien zeichnen
  // ---------------------------------------------------------------------------
  const drawConnections = useCallback((ctx, particles) => {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx   = particles[i].x - particles[j].x;
        const dy   = particles[i].y - particles[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist < CONNECTION_DISTANCE) {
          const alpha = (1 - dist / CONNECTION_DISTANCE) * 0.25;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(100,200,255,${alpha.toFixed(3)})`;
          ctx.lineWidth   = 0.6;
          ctx.stroke();
        }
      }
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Animationsschleife
  // ---------------------------------------------------------------------------
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;

    ctx.clearRect(0, 0, w, h);

    particlesRef.current.forEach((p) => {
      p.update(w, h, mouseRef.current);
      p.draw(ctx);
    });

    drawConnections(ctx, particlesRef.current);
    animFrameRef.current = requestAnimationFrame(animate);
  }, [drawConnections]);

  // ---------------------------------------------------------------------------
  // Canvas-Setup & Resize
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      initParticles(canvas.width, canvas.height);
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [initParticles]);

  // ---------------------------------------------------------------------------
  // Maus-Events
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onMove  = (e) => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    const onLeave = ()  => { mouseRef.current = { x: null, y: null }; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Animation starten / stoppen
  // ---------------------------------------------------------------------------
  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [animate]);

  // ---------------------------------------------------------------------------
  // Nachrichtenrotation
  // ---------------------------------------------------------------------------
  useEffect(() => {
    msgIntervalRef.current = setInterval(() => {
      // Fade-Out
      setMsgOpacity(0);

      fadeTimerRef.current = setTimeout(() => {
        setMsgIndex((prev) => (prev + 1) % MESSAGES.length);
        setMsgOpacity(1);
      }, FADE_DURATION);
    }, MSG_DURATION);

    return () => {
      clearInterval(msgIntervalRef.current);
      clearTimeout(fadeTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Fortschrittsring basierend auf Zustand
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setShowRing(state === 'DETECTING');
  }, [state]);

  // ---------------------------------------------------------------------------
  // Screen-1: BroadcastChannel listener for visitor invitation overlay
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (screenMode !== 1) return undefined;
    let channel;
    try {
      channel = new BroadcastChannel('ambient-invite');
    } catch {
      return undefined;
    }
    channel.onmessage = ({ data }) => {
      if      (data.type === 'invite-enter')   setVisitorPhase('entering');
      else if (data.type === 'invite-arrived') setVisitorPhase('visible');
      else if (data.type === 'invite-exit')    setVisitorPhase('exiting');
      else if (data.type === 'invite-home')    setVisitorPhase('hidden');
    };
    return () => channel.close();
  }, [screenMode]);

  // ---------------------------------------------------------------------------
  // Statustext berechnen
  // ---------------------------------------------------------------------------
  const statusText =
    state === 'DETECTING' ? 'ERKENNUNG'
    : meshReady           ? 'BEREIT'
    :                       'KI LÄDT …';

  const dotStyle = meshReady || state === 'DETECTING'
    ? S.dot
    : { ...S.dot, background: '#facc15', boxShadow: '0 0 6px #facc15' };

  const subtitleText = {
    AMBIENT:   'Nähern Sie sich dem Display',
    DETECTING: 'Person erkannt – Verbindung wird aufgebaut',
  }[state] ?? '';

  // SVG-Ecken-Koordinaten aus Fenstergröße berechnen
  const { w, h } = dim;
  const M = 40;   // Randabstand
  const L = 70;   // Linienlänge

  return (
    <div style={S.container}>

      {/* --- Partikel-Canvas --- */}
      <canvas ref={canvasRef} style={S.canvas} />

      {/* --- Vignette-Effekt --- */}
      <div style={S.vignette} />

      {/* --- Scanlines-Effekt --- */}
      <div style={S.scanlines} />

      {/* --- Dekorative SVG-Ecken + Fortschrittsring --- */}
      <svg style={S.svg} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg">
        {/* Ecke oben-links */}
        <path d={`M${M} ${M+L} L${M} ${M} L${M+L} ${M}`}
              fill="none" stroke="rgba(100,200,255,0.55)" strokeWidth="1.5" />
        {/* Ecke oben-rechts */}
        <path d={`M${w-M-L} ${M} L${w-M} ${M} L${w-M} ${M+L}`}
              fill="none" stroke="rgba(100,200,255,0.55)" strokeWidth="1.5" />
        {/* Ecke unten-links */}
        <path d={`M${M} ${h-M-L} L${M} ${h-M} L${M+L} ${h-M}`}
              fill="none" stroke="rgba(100,200,255,0.55)" strokeWidth="1.5" />
        {/* Ecke unten-rechts */}
        <path d={`M${w-M-L} ${h-M} L${w-M} ${h-M} L${w-M} ${h-M-L}`}
              fill="none" stroke="rgba(100,200,255,0.55)" strokeWidth="1.5" />

        {/* Fortschrittsring – nur im DETECTING-Zustand */}
        {showRing && (
          <g transform={`translate(${w/2},${h/2})`}>
            {/* Hintergrundkreis */}
            <circle r={RING_R} fill="none"
                    stroke="rgba(100,200,255,0.1)" strokeWidth="1.5" />
            {/* Animierter Fortschrittsring (75 % sichtbar, dreht sich) */}
            <circle r={RING_R} fill="none"
                    stroke="rgba(100,200,255,0.85)" strokeWidth="2"
                    strokeDasharray={`${RING_C * 0.75} ${RING_C * 0.25}`}
                    strokeLinecap="round"
                    style={{ animation: 'ad-ring-rotate 1.5s linear infinite',
                             transformOrigin: '0 0' }} />
          </g>
        )}
      </svg>

      {/* --- Zentraler Inhalt --- */}
      <div style={S.content}>

        {/* Statusbadge */}
        <div style={S.badge}>
          <span style={dotStyle} />
          <span style={S.badgeText}>{statusText}</span>
        </div>

        {state === 'DETECTING' ? (
          <div style={S.inviteCard}>
            <div style={S.inviteRing} />
            <div style={S.inviteKicker}>
              {faceCount >= 2
                ? 'Connection starting'
                : inviteReady
                  ? 'Someone wants to speak with you'
                  : 'Face detected'}
            </div>
            <div style={S.inviteTitle}>Come closer</div>
            <div style={S.inviteSubtitle}>
              {faceCount >= 2
                ? 'Hold your position while the secure video link opens.'
                : 'Step into the center of the display to begin.'}
            </div>
          </div>
        ) : (
          <>
            {/* Animierte Hauptnachricht */}
            <div style={{ ...S.message, opacity: msgOpacity,
                          transition: `opacity ${FADE_DURATION}ms ease` }}>
              {MESSAGES[msgIndex]}
            </div>

            {/* Untertitel */}
            {subtitleText && <div style={S.subtitle}>{subtitleText}</div>}
          </>
        )}
      </div>

      {/* --- Screen-1 visitor overlay: invitation glides over from screen 2 --- */}
      {screenMode === 1 && <VisitorOverlay phase={visitorPhase} />}

      {/* --- Fußzeile --- */}
    <footer style={S.footer}>
</footer>

    </div>
  );
};

// ---------------------------------------------------------------------------
// VisitorOverlay — shown on screen 1 when the invitation wanders over
// ---------------------------------------------------------------------------

function VisitorOverlay({ phase }) {
  const atRight = phase === 'hidden' || phase === 'exiting';
  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      zIndex:         50,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      overflow:       'hidden',
      background:     'linear-gradient(-45deg, #0d0221, #1a0533, #0a1628, #0d0533)',
      transform:      `translateX(${atRight ? '110vw' : '0'})`,
      transition:     'transform 1300ms cubic-bezier(0.4,0,0.2,1)',
      willChange:     'transform',
      pointerEvents:  atRight ? 'none' : 'auto',
    }}>
      <div style={VO.inner}>
        <h1 style={VO.headline}>
          Möchtest du mit<br />jemandem sprechen?
        </h1>
        <p style={VO.subline}>
          Jemand wartet auf dich&ensp;—&ensp;komm näher!
        </p>
      </div>
    </div>
  );
}

const VO = {
  inner: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    textAlign:     'center',
    padding:       '0 8vw',
    userSelect:    'none',
  },
  headline: {
    margin:        '0 0 28px',
    fontFamily:    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
    fontSize:      'clamp(44px, 6.5vw, 100px)',
    fontWeight:    700,
    lineHeight:    1.07,
    letterSpacing: '-0.02em',
    color:         '#ffffff',
    textShadow:    '0 4px 50px rgba(124,58,237,0.55)',
  },
  subline: {
    margin:        0,
    fontFamily:    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
    fontSize:      'clamp(22px, 3vw, 46px)',
    fontWeight:    300,
    lineHeight:    1.3,
    color:         'rgba(255,255,255,0.80)',
    letterSpacing: '0.01em',
  },
};

// ---------------------------------------------------------------------------
// Inline-Stile
// ---------------------------------------------------------------------------

const S = {
  container: {
    position:   'relative',
    width:      '100vw',
    height:     '100vh',
    background: 'radial-gradient(ellipse at center, #081525 0%, #04100d 60%, #000000 100%)',
    overflow:   'hidden',
    fontFamily: "'Courier New', Courier, monospace",
    color:      '#64c8ff',
    userSelect: 'none',
  },
  canvas: {
    position: 'absolute',
    inset:    0,
    width:    '100%',
    height:   '100%',
  },
  vignette: {
    position:   'absolute',
    inset:      0,
    background: 'radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.75) 100%)',
    pointerEvents: 'none',
  },
  scanlines: {
    position:   'absolute',
    inset:      0,
    background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)',
    pointerEvents: 'none',
  },
  svg: {
    position: 'absolute',
    inset:    0,
    width:    '100%',
    height:   '100%',
    pointerEvents: 'none',
  },
  content: {
    position:  'absolute',
    top:       '50%',
    left:      '50%',
    transform: 'translate(-50%, -50%)',
    textAlign: 'center',
    zIndex:    10,
  },
  badge: {
    display:       'inline-flex',
    alignItems:    'center',
    gap:           '8px',
    padding:       '5px 18px',
    border:        '1px solid rgba(100,200,255,0.35)',
    borderRadius:  '20px',
    fontSize:      '10px',
    letterSpacing: '3px',
    marginBottom:  '32px',
    background:    'rgba(100,200,255,0.05)',
  },
  dot: {
    display:      'inline-block',
    width:        '6px',
    height:       '6px',
    borderRadius: '50%',
    background:   '#64c8ff',
    animation:    'ad-pulse 2s ease-in-out infinite',
  },
  badgeText: {
    letterSpacing: '4px',
  },
  message: {
    fontSize:      'clamp(28px, 5vw, 52px)',
    fontWeight:    '200',
    letterSpacing: 'clamp(4px, 1vw, 10px)',
    textTransform: 'uppercase',
    textShadow:    '0 0 40px rgba(100,200,255,0.7)',
    marginBottom:  '20px',
    whiteSpace:    'nowrap',
  },
  subtitle: {
    fontSize:      '12px',
    letterSpacing: '3px',
    opacity:       0.45,
    textTransform: 'uppercase',
    animation:     'ad-blink 3s ease-in-out infinite',
  },
  inviteCard: {
    position:      'relative',
    width:         'min(78vw, 780px)',
    padding:       'clamp(28px, 5vw, 58px) clamp(26px, 5vw, 64px)',
    borderRadius:  '18px',
    background:    'linear-gradient(145deg, rgba(255,255,255,0.22), rgba(100,200,255,0.08))',
    border:        '1px solid rgba(255,255,255,0.34)',
    boxShadow:     '0 34px 120px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.42)',
    backdropFilter:'blur(18px)',
    animation:     'ad-invite-float 5.5s ease-in-out infinite',
    transformStyle:'preserve-3d',
    overflow:      'hidden',
  },
  inviteRing: {
    position:      'absolute',
    top:           '50%',
    left:          '50%',
    width:         '240px',
    height:        '240px',
    margin:        '-120px 0 0 -120px',
    borderRadius:  '50%',
    border:        '2px solid rgba(100,200,255,0.38)',
    animation:     'ad-invite-ring 2.4s ease-out infinite',
    pointerEvents: 'none',
  },
  inviteKicker: {
    position:      'relative',
    fontSize:      'clamp(11px, 1.2vw, 15px)',
    fontWeight:    700,
    letterSpacing: '4px',
    textTransform: 'uppercase',
    color:         'rgba(186,235,255,0.82)',
    marginBottom:  '16px',
    transform:     'translateZ(42px)',
  },
  inviteTitle: {
    position:      'relative',
    fontSize:      'clamp(44px, 8vw, 118px)',
    lineHeight:    0.9,
    fontWeight:    800,
    letterSpacing: '0',
    color:         '#ffffff',
    textShadow:    '0 20px 70px rgba(0,0,0,0.42), 0 0 28px rgba(100,200,255,0.46)',
    transform:     'translateZ(72px)',
  },
  inviteSubtitle: {
    position:      'relative',
    marginTop:     '18px',
    fontSize:      'clamp(15px, 2vw, 26px)',
    lineHeight:    1.35,
    fontWeight:    400,
    color:         'rgba(255,255,255,0.78)',
    transform:     'translateZ(48px)',
  },
  footer: {
    position:      'absolute',
    bottom:        '28px',
    left:          '50%',
    transform:     'translateX(-50%)',
    fontSize:      '10px',
    letterSpacing: '3px',
    opacity:       0.25,
    display:       'flex',
    gap:           '12px',
    textTransform: 'uppercase',
    whiteSpace:    'nowrap',
  },
  sep: { opacity: 0.4 },
};

export default AmbientDisplay;

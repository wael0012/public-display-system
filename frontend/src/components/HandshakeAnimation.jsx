/**
 * HandshakeAnimation.jsx
 *
 * Verbindungsaufbau-Animation für den Einzelbildschirm-Anzeigepfad
 * (?screen=1/2, siehe App.jsx): läuft im HANDSHAKE-Zustand, während
 * WebRTC Offer/Answer/ICE ausgetauscht werden, und schaltet dabei
 * nacheinander Statustexte weiter. Bricht über onTimeout auch selbst
 * nach 30 s ohne Verbindung ab, unabhängig vom Timeout in App.jsx.
 *
 * @author Wael Hammami
 */

import React, { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// CSS-Animationen (einmalig)
// ---------------------------------------------------------------------------

let _injected = false;

function injectStyles() {
  if (_injected) return;
  _injected = true;
  const s = document.createElement('style');
  s.textContent = `
    @keyframes hs-pulse {
      0%,100% { transform: scale(1);   opacity: 1; }
      50%      { transform: scale(1.15); opacity: 0.7; }
    }
    @keyframes hs-flow {
      0%   { stroke-dashoffset: 300; opacity: 0; }
      20%  { opacity: 1; }
      80%  { opacity: 1; }
      100% { stroke-dashoffset: 0;   opacity: 0; }
    }
    @keyframes hs-appear {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes hs-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Statusnachrichten die sequentiell erscheinen
// ---------------------------------------------------------------------------

const STATUS_STEPS = [
  'Verbindung wird initialisiert…',
  'Offer wird gesendet…',
  'Warte auf Antwort…',
  'ICE-Kandidaten werden ausgetauscht…',
  'Verbindung wird hergestellt…',
];

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

/**
 * HandshakeAnimation-Komponente.
 *
 * @component
 * @param {Object}   props
 * @param {Function} props.onTimeout – Callback wenn Handshake zu lange dauert (optional).
 * @returns {JSX.Element}
 */
const HandshakeAnimation = ({ onTimeout }) => {
  const [stepIndex, setStepIndex] = useState(0);
  const stepTimerRef = useRef(null);

  // CSS-Animationen einmalig laden
  useEffect(() => { injectStyles(); }, []);

  // Statusnachrichten alle 1,8 Sekunden weiterschalten
  useEffect(() => {
    stepTimerRef.current = setInterval(() => {
      setStepIndex((prev) => {
        if (prev >= STATUS_STEPS.length - 1) {
          clearInterval(stepTimerRef.current);
          // Optional: Timeout-Callback nach 30 Sekunden
          return prev;
        }
        return prev + 1;
      });
    }, 1_800);

    // Timeout-Safeguard: nach 30 Sekunden zurückspringen
    const timeoutId = setTimeout(() => {
      onTimeout?.();
    }, 30_000);

    return () => {
      clearInterval(stepTimerRef.current);
      clearTimeout(timeoutId);
    };
  }, [onTimeout]);

  // SVG-Abmessungen für die Verbindungslinie
  const svgW = 400;
  const svgH = 120;
  const nodeR = 28;
  const leftX = nodeR + 20;
  const rightX = svgW - nodeR - 20;
  const centerY = svgH / 2;
  const lineLen = rightX - leftX;

  return (
    <div style={S.overlay}>

      {/* --- Hintergrundraster --- */}
      <div style={S.grid} />

      {/* --- Zentraler Kasten --- */}
      <div style={S.card}>

        {/* Ladekreis */}
        <div style={S.spinnerWrap}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="28"
                    fill="none" stroke="rgba(100,200,255,0.15)" strokeWidth="3" />
            <circle cx="32" cy="32" r="28"
                    fill="none" stroke="#64c8ff" strokeWidth="3"
                    strokeDasharray="44 132"
                    strokeLinecap="round"
                    style={{ animation: 'hs-spin 1.2s linear infinite',
                             transformOrigin: '50% 50%' }} />
          </svg>
        </div>

        <h2 style={S.title}>Verbindungsaufbau</h2>

        {/* Verbindungs-SVG: zwei Knoten + animierter Datenstrom */}
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}
             style={S.connectionSvg}>
          {/* Verbindungslinie (Hintergrund) */}
          <line x1={leftX} y1={centerY} x2={rightX} y2={centerY}
                stroke="rgba(100,200,255,0.15)" strokeWidth="1.5" />

          {/* Animierter Datenstrom links → rechts */}
          <line x1={leftX} y1={centerY} x2={rightX} y2={centerY}
                stroke="#64c8ff" strokeWidth="2"
                strokeDasharray={`${lineLen * 0.35} ${lineLen * 0.65}`}
                style={{ animation: 'hs-flow 1.8s linear infinite' }} />

          {/* Animierter Datenstrom rechts → links (versetzt) */}
          <line x1={rightX} y1={centerY} x2={leftX} y2={centerY}
                stroke="rgba(100,220,180,0.7)" strokeWidth="1.5"
                strokeDasharray={`${lineLen * 0.25} ${lineLen * 0.75}`}
                style={{ animation: 'hs-flow 2.1s linear infinite 0.9s' }} />

          {/* Linker Knoten – Display */}
          <circle cx={leftX} cy={centerY} r={nodeR}
                  fill="rgba(100,200,255,0.08)"
                  stroke="rgba(100,200,255,0.7)" strokeWidth="1.5"
                  style={{ animation: 'hs-pulse 2s ease-in-out infinite' }} />
          <text x={leftX} y={centerY - 3}
                textAnchor="middle" fill="#64c8ff" fontSize="9"
                fontFamily="'Courier New', monospace" letterSpacing="1">
            DISPLAY
          </text>

          {/* Rechter Knoten – Mobilgerät */}
          <circle cx={rightX} cy={centerY} r={nodeR}
                  fill="rgba(100,220,180,0.08)"
                  stroke="rgba(100,220,180,0.7)" strokeWidth="1.5"
                  style={{ animation: 'hs-pulse 2s ease-in-out infinite 1s' }} />
          <text x={rightX} y={centerY - 3}
                textAnchor="middle" fill="rgba(100,220,180,0.9)" fontSize="9"
                fontFamily="'Courier New', monospace" letterSpacing="1">
            MOBIL
          </text>
        </svg>

        {/* Statustext */}
        <div style={S.statusText} key={stepIndex}>
          {STATUS_STEPS[stepIndex]}
        </div>

        {/* Fortschrittsbalken */}
        <div style={S.progressBar}>
          <div style={{
            ...S.progressFill,
            width: `${((stepIndex + 1) / STATUS_STEPS.length) * 100}%`,
            transition: 'width 0.6s ease',
          }} />
        </div>

      </div>

      {/* Fußzeile */}
      <footer style={S.footer}>
        WebRTC P2P · Lokales Netzwerk · BA Wael Hammami
      </footer>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inline-Stile
// ---------------------------------------------------------------------------

const S = {
  overlay: {
    position:   'fixed',
    inset:      0,
    display:    'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'radial-gradient(ellipse at center, #081525 0%, #04100d 60%, #000 100%)',
    fontFamily: "'Courier New', Courier, monospace",
    color:      '#64c8ff',
    zIndex:     100,
  },
  grid: {
    position:   'absolute',
    inset:      0,
    backgroundImage: `
      linear-gradient(rgba(100,200,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(100,200,255,0.04) 1px, transparent 1px)
    `,
    backgroundSize: '40px 40px',
    pointerEvents: 'none',
  },
  card: {
    position:      'relative',
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           '24px',
    padding:       '48px 60px',
    border:        '1px solid rgba(100,200,255,0.2)',
    borderRadius:  '4px',
    background:    'rgba(8,21,37,0.85)',
    backdropFilter:'blur(12px)',
    boxShadow:     '0 0 60px rgba(100,200,255,0.08)',
    animation:     'hs-appear 0.5s ease both',
  },
  spinnerWrap: {
    marginBottom: '-8px',
  },
  title: {
    fontSize:      '18px',
    fontWeight:    '300',
    letterSpacing: '6px',
    textTransform: 'uppercase',
    margin:        0,
  },
  connectionSvg: {
    display: 'block',
    margin:  '0 auto',
  },
  statusText: {
    fontSize:      '12px',
    letterSpacing: '1.5px',
    opacity:       0.6,
    animation:     'hs-appear 0.4s ease both',
    minHeight:     '18px',
    textAlign:     'center',
  },
  progressBar: {
    width:        '280px',
    height:       '2px',
    background:   'rgba(100,200,255,0.1)',
    borderRadius: '1px',
    overflow:     'hidden',
  },
  progressFill: {
    height:        '100%',
    background:    'linear-gradient(90deg, rgba(100,200,255,0.4), #64c8ff)',
    borderRadius:  '1px',
    boxShadow:     '0 0 8px #64c8ff',
  },
  footer: {
    position:      'absolute',
    bottom:        '24px',
    fontSize:      '10px',
    letterSpacing: '2px',
    opacity:       0.2,
    textTransform: 'uppercase',
  },
};

export default HandshakeAnimation;

/**
 * HandshakeInvitationOverlay.jsx
 *
 * Ganzflächiges Einladungs-Overlay für den Einzelbildschirm-Anzeigepfad
 * (?screen=1/2, siehe App.jsx): wird zusammen mit HandshakeAnimation.jsx
 * im HANDSHAKE-Zustand eingeblendet und zeigt an, ob der andere Peer laut
 * Server bereits bereit ist (peerReady). Rein dekorativ — beeinflusst den
 * Verbindungsaufbau selbst nicht.
 */

import React, { useEffect } from 'react';

let _injected = false;

function injectStyles() {
  if (_injected) return;
  _injected = true;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes invite-fade-in {
      from { opacity: 0; transform: scale(0.98); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes invite-breathe {
      0%, 100% { transform: scale(1); opacity: 0.92; }
      50% { transform: scale(1.045); opacity: 1; }
    }
    @keyframes invite-halo {
      0%, 100% { transform: scale(0.92); opacity: 0.24; }
      50% { transform: scale(1.18); opacity: 0.42; }
    }
    @keyframes invite-gradient {
      0%, 100% { transform: translate3d(-2%, -1%, 0) scale(1); opacity: 0.78; }
      50% { transform: translate3d(2%, 1%, 0) scale(1.05); opacity: 1; }
    }
    @keyframes invite-rise {
      from { opacity: 0; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

const HandshakeInvitationOverlay = ({ peerReady = false }) => {
  useEffect(() => { injectStyles(); }, []);

  return (
    <div style={S.overlay} aria-live="polite">
      <div style={S.gradientA} />
      <div style={S.gradientB} />
      <div style={S.vignette} />

      <main style={S.content}>
        <div style={S.iconStage} aria-hidden="true">
          <div style={S.haloOuter} />
          <div style={S.haloInner} />
          <div style={S.iconShell}>
            <svg width="78" height="78" viewBox="0 0 78 78" fill="none">
              <path
                d="M26.7 19.8c-2.7 1.1-5.2 4.9-4.7 8.4 1.9 13.8 13.9 25.8 27.7 27.7 3.5.5 7.3-2 8.4-4.7l2.2-5.1c.7-1.6.1-3.4-1.4-4.3l-8-4.7c-1.4-.8-3.2-.5-4.2.8l-3.1 3.8c-4.6-2.1-8.5-6-10.6-10.6l3.8-3.1c1.3-1 1.6-2.8.8-4.2l-4.7-8c-.9-1.5-2.7-2.1-4.3-1.4l-5.9 2.5Z"
                stroke="white"
                strokeWidth="3.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        <p style={S.kicker}>{peerReady ? 'Gegenuber bereit' : 'Einladung bereit'}</p>
        <h1 style={S.headline}>Möchtest du jemanden anrufen?</h1>
        <p style={S.subline}>
          {peerReady ? 'Jemand wartet auf dich...' : 'Tritt vor die Kamera.'}
        </p>
      </main>
    </div>
  );
};

const S = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 120,
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    color: '#fff',
    background: '#05070b',
    pointerEvents: 'none',
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    animation: 'invite-fade-in 720ms ease both',
  },
  gradientA: {
    position: 'absolute',
    inset: '-16%',
    background: 'radial-gradient(circle at 28% 30%, rgba(255,119,96,0.55), transparent 28%), radial-gradient(circle at 70% 28%, rgba(97,201,255,0.48), transparent 30%), radial-gradient(circle at 54% 76%, rgba(80,232,170,0.38), transparent 32%)',
    filter: 'blur(34px)',
    animation: 'invite-gradient 7s ease-in-out infinite',
  },
  gradientB: {
    position: 'absolute',
    inset: '-10%',
    background: 'linear-gradient(135deg, rgba(255,255,255,0.08), transparent 38%, rgba(255,255,255,0.06))',
    animation: 'invite-gradient 9s ease-in-out infinite reverse',
  },
  vignette: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle at center, rgba(5,7,11,0.16), rgba(5,7,11,0.82) 72%, #05070b 100%)',
  },
  content: {
    position: 'relative',
    width: 'min(92vw, 980px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: '18px',
    padding: '7vh 24px',
    animation: 'invite-rise 800ms ease 120ms both',
  },
  iconStage: {
    position: 'relative',
    width: '174px',
    height: '174px',
    display: 'grid',
    placeItems: 'center',
    marginBottom: '8px',
  },
  haloOuter: {
    position: 'absolute',
    width: '174px',
    height: '174px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.16)',
    animation: 'invite-halo 2.8s ease-in-out infinite',
  },
  haloInner: {
    position: 'absolute',
    width: '126px',
    height: '126px',
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.34)',
    animation: 'invite-halo 2.8s ease-in-out infinite 250ms',
  },
  iconShell: {
    position: 'relative',
    width: '112px',
    height: '112px',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    background: 'linear-gradient(145deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))',
    boxShadow: '0 24px 90px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.44)',
    backdropFilter: 'blur(18px)',
    animation: 'invite-breathe 2.8s ease-in-out infinite',
  },
  kicker: {
    margin: 0,
    fontSize: 'clamp(12px, 1.5vw, 16px)',
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    opacity: 0.72,
  },
  headline: {
    margin: 0,
    maxWidth: '920px',
    fontSize: 'clamp(42px, 7vw, 104px)',
    lineHeight: 0.96,
    fontWeight: 760,
    letterSpacing: 0,
    textWrap: 'balance',
    textShadow: '0 18px 80px rgba(0,0,0,0.42)',
  },
  subline: {
    margin: 0,
    fontSize: 'clamp(20px, 2.5vw, 34px)',
    lineHeight: 1.25,
    fontWeight: 420,
    opacity: 0.78,
    textShadow: '0 10px 40px rgba(0,0,0,0.36)',
  },
};

export default HandshakeInvitationOverlay;

/**
 * InvitationScreen.jsx
 *
 * Screen-2-Ambientanzeige für den Einzelbildschirm-Anzeigepfad (?screen=2,
 * siehe App.jsx). Fungiert als BroadcastChannel-Master: alle 15-20 s lässt
 * sie die Einladung optisch von Bildschirm 2 zu Bildschirm 1 hinüberwandern
 * (AmbientDisplay.jsx mit screenMode=1 ist der Listener) und wieder
 * zurückkehren — rein clientseitig, ohne Serverbeteiligung.
 */

import React, { useEffect, useRef, useState } from 'react';

const CHANNEL    = 'ambient-invite';
const SLIDE_MS   = 1_300;
const HOLD_MS    = 3_000;
const WANDER_MIN = 15_000;
const WANDER_MAX = 20_000;

let _invStyles = false;

function injectInvStyles() {
  if (_invStyles) return;
  _invStyles = true;
  const el = document.createElement('style');
  el.textContent = `
    @keyframes inv-bg-shift {
      0%,100% { background-position: 0% 50%; }
      50%      { background-position: 100% 50%; }
    }
    @keyframes inv-float {
      0%,100% { transform: translateY(0px); }
      50%      { transform: translateY(-18px); }
    }
    @keyframes inv-pulse-ring {
      0%   { transform: scale(0.88); opacity: 0.65; }
      70%  { transform: scale(1.35); opacity: 0; }
      100% { transform: scale(0.88); opacity: 0; }
    }
    @keyframes inv-icon-glow {
      0%,100% { filter: drop-shadow(0 0 14px rgba(167,139,250,0.8)); }
      50%      { filter: drop-shadow(0 0 38px rgba(167,139,250,1)); }
    }
    @keyframes inv-cta-blink {
      0%,100% { opacity: 0.55; }
      50%      { opacity: 1; }
    }
    @keyframes inv-orb-a {
      0%,100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(-40px) scale(1.06); }
    }
    @keyframes inv-orb-b {
      0%,100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(30px) scale(0.94); }
    }
  `;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InvitationScreen() {
  // 'center' | 'exiting' | 'absent' | 'entering'
  // center & entering → translateX(0)  (visible)
  // exiting & absent  → translateX(-100vw) (off-screen to the left, toward screen 1)
  const [phase, setPhase] = useState('center');

  const channelRef = useRef(null);
  const timersRef  = useRef([]);

  useEffect(() => { injectInvStyles(); }, []);

  useEffect(() => {
    let channel = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channelRef.current = channel;
    } catch {
      // BroadcastChannel unavailable — static fallback, wander loop still runs locally
    }

    let cancelled = false;
    const timers = timersRef.current;

    const after = (fn, ms) => {
      const id = setTimeout(() => { if (!cancelled) fn(); }, ms);
      timers.push(id);
    };

    const runCycle = () => {
      const delay = WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);

      after(() => {
        // 1. Slide out to the LEFT toward screen 1; screen 1 slides in from the right
        setPhase('exiting');
        channel?.postMessage({ type: 'invite-enter' });

        after(() => {
          // 2. Hold: fully off-screen while screen 1 displays the invitation
          setPhase('absent');
          channel?.postMessage({ type: 'invite-arrived' });

          after(() => {
            // 3. Return: slide back in from the left; screen 1 slides back to the right
            setPhase('entering');
            channel?.postMessage({ type: 'invite-exit' });

            after(() => {
              // 4. Back home
              setPhase('center');
              channel?.postMessage({ type: 'invite-home' });
              runCycle();
            }, SLIDE_MS + 200);
          }, HOLD_MS);
        }, SLIDE_MS + 200);
      }, delay);
    };

    runCycle();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      timers.length = 0;
      channel?.close();
      channelRef.current = null;
    };
  }, []);

  const atLeft = phase === 'exiting' || phase === 'absent';

  return (
    <div style={{
      ...IS.root,
      transform:  `translateX(${atLeft ? '-100vw' : '0'})`,
      transition: `transform ${SLIDE_MS}ms cubic-bezier(0.4,0,0.2,1)`,
    }}>
      <div style={IS.bg} />
      <div style={{ ...IS.orb, ...IS.orbA }} />
      <div style={{ ...IS.orb, ...IS.orbB }} />

      <div style={IS.content}>
        <IconBlock />

        <h1 style={IS.headline}>
          Möchtest du mit<br />jemandem sprechen?
        </h1>

        <p style={IS.subline}>
          Jemand wartet auf dich&ensp;—&ensp;komm näher!
        </p>

        <div style={IS.cta}>
          <span style={IS.dot} />
          Einfach vor das Display treten
          <span style={IS.dot} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Person icon with pulsing rings
// ---------------------------------------------------------------------------

function IconBlock() {
  return (
    <div style={IS.iconWrap}>
      <div style={{ ...IS.ring, animationDelay: '0s'   }} />
      <div style={{ ...IS.ring, animationDelay: '0.9s' }} />
      <svg width="90" height="90" viewBox="0 0 90 90" fill="none"
           xmlns="http://www.w3.org/2000/svg"
           style={{ animation: 'inv-icon-glow 3s ease-in-out infinite', flexShrink: 0 }}>
        {/* Head */}
        <circle cx="45" cy="27" r="18" fill="rgba(255,255,255,0.95)" />
        {/* Shoulders */}
        <path d="M10 76 Q10 48 45 48 Q80 48 80 76"
              stroke="rgba(255,255,255,0.95)" strokeWidth="5.5"
              strokeLinecap="round" fill="none" />
        {/* Purple accent dot — suggests "online / reachable" */}
        <circle cx="68" cy="18" r="10" fill="#7c3aed" />
        <circle cx="68" cy="18" r="5"  fill="rgba(255,255,255,0.95)" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const IS = {
  root: {
    position:       'fixed',
    inset:          0,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    overflow:       'hidden',
    willChange:     'transform',
  },
  bg: {
    position:       'absolute',
    inset:          0,
    background:     'linear-gradient(-45deg, #0d0221, #1a0533, #0a1628, #0d0533)',
    backgroundSize: '400% 400%',
    animation:      'inv-bg-shift 14s ease infinite',
  },
  orb: {
    position:      'absolute',
    borderRadius:  '50%',
    filter:        'blur(90px)',
    pointerEvents: 'none',
    opacity:       0.38,
  },
  orbA: {
    width:      '65vw',
    height:     '65vw',
    top:        '-20vw',
    left:       '-15vw',
    background: 'radial-gradient(circle, #7c3aed 0%, transparent 65%)',
    animation:  'inv-orb-a 9s ease-in-out infinite',
  },
  orbB: {
    width:      '55vw',
    height:     '55vw',
    bottom:     '-15vw',
    right:      '-12vw',
    background: 'radial-gradient(circle, #1d4ed8 0%, transparent 65%)',
    animation:  'inv-orb-b 11s ease-in-out infinite',
  },
  content: {
    position:       'relative',
    zIndex:         10,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    textAlign:      'center',
    animation:      'inv-float 7s ease-in-out infinite',
    padding:        '0 8vw',
    userSelect:     'none',
  },
  iconWrap: {
    position:       'relative',
    width:          '150px',
    height:         '150px',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    marginBottom:   '52px',
  },
  ring: {
    position:     'absolute',
    inset:        '-24px',
    borderRadius: '50%',
    border:       '2px solid rgba(167,139,250,0.5)',
    animation:    'inv-pulse-ring 2.6s ease-out infinite',
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
    margin:        '0 0 56px',
    fontFamily:    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
    fontSize:      'clamp(22px, 3vw, 46px)',
    fontWeight:    300,
    lineHeight:    1.3,
    color:         'rgba(255,255,255,0.80)',
    letterSpacing: '0.01em',
  },
  cta: {
    display:       'flex',
    alignItems:    'center',
    gap:           '14px',
    fontFamily:    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
    fontSize:      'clamp(13px, 1.4vw, 20px)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color:         'rgba(167,139,250,0.9)',
    animation:     'inv-cta-blink 3s ease-in-out infinite',
  },
  dot: {
    display:      'inline-block',
    width:        '6px',
    height:       '6px',
    borderRadius: '50%',
    background:   'rgba(167,139,250,0.9)',
    flexShrink:   0,
  },
};

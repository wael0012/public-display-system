/**
 * VideoPortal.jsx
 *
 * Vollbild-Videoansicht für den ACTIVE-Zustand im Einzelbildschirm-
 * Anzeigepfad (?screen=1/2, siehe App.jsx): zeigt den Remote-Stream groß
 * und den lokalen Stream als bewegliches Bild-im-Bild-Fenster, dazu
 * Anrufsteuerung (Stumm/Video/Auflegen) und Gesprächsdauer-Timer. Im
 * aktuellen Zwei-Fenster-Betrieb übernimmt stattdessen MainDisplay.jsx
 * die entsprechende ACTIVE-Anzeige.
 *
 * @author Wael Hammami
 */

import React, {
  useEffect, useRef, useState, useCallback,
} from 'react';

// ---------------------------------------------------------------------------
// CSS-Animationen
// ---------------------------------------------------------------------------

let _injected = false;

function injectStyles() {
  if (_injected) return;
  _injected = true;
  const s = document.createElement('style');
  s.textContent = `
    @keyframes vp-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes vp-slide-up {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes vp-pulse-dot {
      0%,100% { opacity: 1; }
      50%      { opacity: 0.2; }
    }
  `;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Sekunden → MM:SS
// ---------------------------------------------------------------------------

/** @param {number} sek – Sekunden */
const formatDuration = (sek) => {
  const m = String(Math.floor(sek / 60)).padStart(2, '0');
  const s = String(sek % 60).padStart(2, '0');
  return `${m}:${s}`;
};

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

/**
 * VideoPortal-Komponente.
 *
 * @component
 * @param {Object}         props
 * @param {MediaStream}    props.localStream  – Lokaler Kamera-/Mikrofonstream.
 * @param {MediaStream}    props.remoteStream – Remote-Videostream.
 * @param {Function}       props.onEndCall    – Callback beim Beenden des Anrufs.
 * @returns {JSX.Element}
 */
const VideoPortal = ({ localStream, remoteStream, onEndCall }) => {
  // Video-Element-Refs
  const remoteVideoRef = useRef(null);
  const localVideoRef  = useRef(null);

  // Steuerungszustände
  const [isMuted,     setIsMuted]     = useState(false);
  const [isVideoOff,  setIsVideoOff]  = useState(false);
  const [duration,    setDuration]    = useState(0);
  const [showControls,setShowControls]= useState(true);

  // Steuerleiste automatisch ausblenden
  const hideTimerRef  = useRef(null);
  const durationTimer = useRef(null);

  // PiP-Fenster: Drag-Zustand
  const [pipPos,  setPipPos]  = useState({ x: null, y: null }); // null = Standardposition
  const dragRef   = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  // CSS laden
  useEffect(() => { injectStyles(); }, []);

  // ----------------------------------------------------------------
  // Remote-Stream an Video-Element binden
  // ----------------------------------------------------------------
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // ----------------------------------------------------------------
  // Lokalen Stream an PiP-Video-Element binden
  // ----------------------------------------------------------------
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // ----------------------------------------------------------------
  // Gesprächsdauer-Timer
  // ----------------------------------------------------------------
  useEffect(() => {
    durationTimer.current = setInterval(() => {
      setDuration((d) => d + 1);
    }, 1_000);
    return () => clearInterval(durationTimer.current);
  }, []);

  // ----------------------------------------------------------------
  // Steuerleiste automatisch nach 4 Sekunden ausblenden
  // ----------------------------------------------------------------
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setShowControls(false), 4_000);
  }, []);

  useEffect(() => {
    resetHideTimer();
    window.addEventListener('mousemove', resetHideTimer);
    window.addEventListener('touchstart', resetHideTimer);
    return () => {
      clearTimeout(hideTimerRef.current);
      window.removeEventListener('mousemove', resetHideTimer);
      window.removeEventListener('touchstart', resetHideTimer);
    };
  }, [resetHideTimer]);

  // ----------------------------------------------------------------
  // Mikrofon stumm schalten / wieder einschalten
  // ----------------------------------------------------------------
  const toggleMute = useCallback(() => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    setIsMuted((m) => !m);
  }, [localStream]);

  // ----------------------------------------------------------------
  // Kamera ein- / ausschalten
  // ----------------------------------------------------------------
  const toggleVideo = useCallback(() => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    setIsVideoOff((v) => !v);
  }, [localStream]);

  // ----------------------------------------------------------------
  // PiP-Drag-Ereignisse
  // ----------------------------------------------------------------
  const onPipMouseDown = useCallback((e) => {
    e.preventDefault();
    const pip = e.currentTarget;
    const rect = pip.getBoundingClientRect();
    dragRef.current = {
      dragging: true,
      startX:  e.clientX,
      startY:  e.clientY,
      origX:   pipPos.x ?? rect.left,
      origY:   pipPos.y ?? rect.top,
    };
  }, [pipPos]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current.dragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPipPos({
        x: dragRef.current.origX + dx,
        y: dragRef.current.origY + dy,
      });
    };
    const onUp = () => { dragRef.current.dragging = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  // PiP-Positionsstil berechnen
  const pipStyle = pipPos.x !== null
    ? { ...S.pip, left: pipPos.x, top: pipPos.y, right: 'auto', bottom: 'auto' }
    : S.pip;

  return (
    <div style={S.container}>

      {/* --- Remote-Vollbild-Video --- */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        style={S.remoteVideo}
      />

      {/* Platzhalter wenn kein Remote-Stream vorhanden */}
      {!remoteStream && (
        <div style={S.noStream}>
          <span style={S.noStreamIcon}>⬡</span>
          <span style={S.noStreamText}>Warte auf Video-Stream…</span>
        </div>
      )}

      {/* --- Dunkel-Überlagerung (leichte Vignette) --- */}
      <div style={S.vignette} />

      {/* --- Lokales PiP-Video --- */}
      <div style={pipStyle} onMouseDown={onPipMouseDown}>
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          style={{ ...S.localVideo, filter: isVideoOff ? 'brightness(0)' : 'none' }}
        />
        {isVideoOff && <div style={S.videoOffBadge}>VIDEO AUS</div>}
      </div>

      {/* --- HUD: Oben links – Gesprächsdauer --- */}
      <div style={S.hud}>
        <span style={S.recDot} />
        <span style={S.recText}>LIVE</span>
        <span style={S.duration}>{formatDuration(duration)}</span>
      </div>

      {/* --- Steuerleiste (unten, verschwindet automatisch) --- */}
      <div style={{ ...S.controls, opacity: showControls ? 1 : 0,
                    transition: 'opacity 0.5s ease' }}>

        {/* Mikrofon-Taste */}
        <button
          style={{ ...S.btn, background: isMuted ? 'rgba(220,60,60,0.4)' : S.btn.background }}
          onClick={toggleMute}
          title={isMuted ? 'Mikrofon einschalten' : 'Mikrofon stumm schalten'}
        >
          {isMuted ? '🔇' : '🎤'}
        </button>

        {/* Kamera-Taste */}
        <button
          style={{ ...S.btn, background: isVideoOff ? 'rgba(220,60,60,0.4)' : S.btn.background }}
          onClick={toggleVideo}
          title={isVideoOff ? 'Kamera einschalten' : 'Kamera ausschalten'}
        >
          {isVideoOff ? '📷' : '📹'}
        </button>

        {/* Auflegen-Taste */}
        <button
          style={{ ...S.btn, background: 'rgba(220,60,60,0.7)', transform: 'scale(1.15)' }}
          onClick={onEndCall}
          title="Anruf beenden"
        >
          📵
        </button>

      </div>

    </div>
  );
};

// ---------------------------------------------------------------------------
// Inline-Stile
// ---------------------------------------------------------------------------

const S = {
  container: {
    position:       'fixed',
    inset:          0,
    background:     '#000',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    animation:      'vp-fade-in 0.5s ease',
  },
  remoteVideo: {
    position:   'absolute',
    inset:      0,
    width:      '100%',
    height:     '100%',
    objectFit:  'cover',
  },
  noStream: {
    position:       'absolute',
    inset:          0,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '16px',
    color:          'rgba(100,200,255,0.4)',
    fontFamily:     "'Courier New', monospace",
    letterSpacing:  '2px',
  },
  noStreamIcon: { fontSize: '48px' },
  noStreamText: { fontSize: '12px', textTransform: 'uppercase' },
  vignette: {
    position:   'absolute',
    inset:      0,
    background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)',
    pointerEvents: 'none',
    zIndex:     2,
  },
  pip: {
    position:     'fixed',
    right:        '24px',
    bottom:       '100px',
    width:        '200px',
    height:       '150px',
    border:       '1px solid rgba(100,200,255,0.4)',
    borderRadius: '4px',
    overflow:     'hidden',
    cursor:       'grab',
    zIndex:       20,
    background:   '#111',
    boxShadow:    '0 4px 20px rgba(0,0,0,0.5)',
    animation:    'vp-slide-up 0.4s ease both',
  },
  localVideo: {
    width:      '100%',
    height:     '100%',
    objectFit:  'cover',
    display:    'block',
    transform:  'scaleX(-1)', // Selfie-Spiegelung
  },
  videoOffBadge: {
    position:       'absolute',
    inset:          0,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    color:          'rgba(255,255,255,0.5)',
    fontSize:       '10px',
    letterSpacing:  '2px',
    fontFamily:     "'Courier New', monospace",
  },
  hud: {
    position:    'fixed',
    top:         '24px',
    left:        '24px',
    display:     'flex',
    alignItems:  'center',
    gap:         '8px',
    zIndex:      20,
    fontFamily:  "'Courier New', monospace",
  },
  recDot: {
    display:      'inline-block',
    width:        '8px',
    height:       '8px',
    borderRadius: '50%',
    background:   '#ff4444',
    animation:    'vp-pulse-dot 1.5s ease-in-out infinite',
  },
  recText: {
    fontSize:      '10px',
    letterSpacing: '3px',
    color:         '#ff4444',
  },
  duration: {
    fontSize:      '12px',
    letterSpacing: '2px',
    color:         'rgba(255,255,255,0.7)',
    marginLeft:    '8px',
    fontVariantNumeric: 'tabular-nums',
  },
  controls: {
    position:       'fixed',
    bottom:         '32px',
    left:           '50%',
    transform:      'translateX(-50%)',
    display:        'flex',
    gap:            '16px',
    alignItems:     'center',
    zIndex:         30,
    padding:        '12px 24px',
    background:     'rgba(0,0,0,0.6)',
    borderRadius:   '40px',
    backdropFilter: 'blur(12px)',
    border:         '1px solid rgba(255,255,255,0.1)',
    animation:      'vp-slide-up 0.4s ease both',
  },
  btn: {
    width:        '52px',
    height:       '52px',
    borderRadius: '50%',
    border:       '1px solid rgba(255,255,255,0.2)',
    background:   'rgba(255,255,255,0.1)',
    cursor:       'pointer',
    fontSize:     '22px',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
    transition:   'transform 0.15s ease, background 0.2s ease',
  },
};

export default VideoPortal;

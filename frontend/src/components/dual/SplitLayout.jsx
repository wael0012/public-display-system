/**
 * SplitLayout.jsx
 *
 * @fileoverview Teilt die Vollbild-Fläche in zwei Hälften auf, damit bei
 * einem im ERWEITERTEN Modus (Extended Displays) über zwei Monitore
 * gespannten Vollbild-Fenster jede Hälfte genau auf einem Monitor landet.
 *
 * Unabhängig vom bestehenden SCREEN_MODE (?screen=1/2 – separate
 * Browserfenster/Rechner). SplitLayout betrifft EIN Fenster, intern geteilt.
 *
 * @author Wael Hammami
 */

import React from 'react';

/**
 * @param {Object} props
 * @param {React.ReactNode} props.left  – Inhalt der linken Hälfte (Haupt-Display)
 * @param {React.ReactNode} props.right – Inhalt der rechten Hälfte (Hilfs-Display)
 * @param {number} [props.split=50]     – Breite der linken Hälfte in Prozent
 * @param {boolean} [props.singleMode=false] – true = nur linke Hälfte, volle Breite
 */
const SplitLayout = ({ left, right, split = 50, singleMode = false }) => {
  if (singleMode) {
    return (
      <div style={S.root}>
        <div style={S.full}>{left}</div>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <div style={{ ...S.half, width: `${split}%` }}>{left}</div>
      <div style={{ ...S.half, width: `${100 - split}%` }}>{right}</div>
    </div>
  );
};

const S = {
  root: {
    position: 'fixed',
    inset:    0,
    display:  'flex',
    width:    '100vw',
    height:   '100vh',
    overflow: 'hidden',
    background: '#000',
  },
  half: {
    position: 'relative',
    height:   '100%',
    overflow: 'hidden',
  },
  full: {
    position: 'relative',
    width:    '100%',
    height:   '100%',
    overflow: 'hidden',
  },
};

export default SplitLayout;

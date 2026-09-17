/**
 * useProxemicZone.js
 *
 * @fileoverview Leitet aus dem kontinuierlichen Proximity-Wert (0..1) der
 * Gesichtserkennung eine von drei proxemischen Zonen ab (nach Hall 1966 /
 * Müller et al. 2010, Audience Funnel): 'ambient' (weit weg, peripher),
 * 'awareness' (mittlere Distanz, implizite Interaktion) und 'engagement'
 * (nah, explizit). Hysterese + ein Stabilitätsfenster (ZONE_STABLE_MS)
 * verhindern Flackern an den Zonengrenzen. Im HANDSHAKE-/ACTIVE-Zustand ist
 * die Zone fix 'engagement'. Reine visuelle Schicht — greift nicht in State
 * Machine oder Anruf-Logik ein.
 *
 * @author Wael Hammami
 */

import { useEffect, useRef, useState } from 'react';

/** Zone A / B / C (Reihenfolge = Eskalationsstufen des Audience Funnel) */
export const ZONES = ['ambient', 'awareness', 'engagement'];

// ── Stellschrauben (Zonen zu früh/spät → hier justieren) ────────────────────
const ZONE_A_MAX     = 0.2;    // darunter: Zone A (weit weg)
const ZONE_B_MAX     = 0.6;    // darunter: Zone B; darüber: Zone C (nah)
const HYSTERESIS     = 0.05;   // ± um die Schwellen (kein Grenz-Flackern)
const ZONE_STABLE_MS = 500;    // Kandidat muss so lange stabil anstehen

const THRESHOLDS = [ZONE_A_MAX, ZONE_B_MAX];

/**
 * @param {number} proximity – Näherungswert 0..1 aus useFaceDetection
 * @param {string} appState  – aktueller App-Zustand (AMBIENT/…/ACTIVE)
 * @returns {'ambient'|'awareness'|'engagement'}
 */
export default function useProxemicZone(proximity, appState) {
  const [zone, setZone] = useState('ambient');
  // Anstehender Zonen-Kandidat + Timer für das Stabilitätsfenster
  const pendingRef = useRef({ zone: null, timer: null });

  useEffect(() => {
    const pending = pendingRef.current;

    // HANDSHAKE/ACTIVE: Zone fix auf 'engagement'
    if (appState === 'HANDSHAKE' || appState === 'ACTIVE') {
      clearTimeout(pending.timer);
      pending.zone = null;
      setZone('engagement');
      return;
    }

    // Kandidat mit Hysterese relativ zur AKTUELLEN Zone bestimmen
    let idx = ZONES.indexOf(zone);
    while (idx < ZONES.length - 1 && proximity >= THRESHOLDS[idx] + HYSTERESIS) idx++;
    while (idx > 0 && proximity < THRESHOLDS[idx - 1] - HYSTERESIS) idx--;
    const candidate = ZONES[idx];

    if (candidate === zone) {
      // Zurück zum Ist-Zustand → anstehenden Wechsel verwerfen
      clearTimeout(pending.timer);
      pending.zone = null;
      return;
    }

    if (pending.zone !== candidate) {
      // Neuer Kandidat → Stabilitätsfenster (neu) starten
      clearTimeout(pending.timer);
      pending.zone  = candidate;
      pending.timer = setTimeout(() => {
        pendingRef.current.zone = null;
        setZone(candidate);
      }, ZONE_STABLE_MS);
    }
  }, [proximity, appState, zone]);

  // Timer beim Unmount aufräumen
  useEffect(() => () => clearTimeout(pendingRef.current.timer), []);

  return zone;
}

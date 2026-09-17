/**
 * visualBus.js
 *
 * @fileoverview Gemeinsamer, mutierbarer Kanal für HOCHFREQUENTE visuelle
 * Werte (faceX ~8×/s, proximity ~8×/s). Die 3D-Szenen lesen diese Werte
 * direkt in ihrem useFrame-Loop — bewusst OHNE React-State: ein setState
 * pro Update würde den gesamten Baum (inkl. beider Canvas-Szenen) mehrmals
 * pro Sekunde re-rendern, nur um eine Zahl zu transportieren, die ohnehin
 * jedes Frame neu interpoliert wird.
 *
 * Langsame Werte (Zone, App-Zustand) laufen weiterhin normal über Props.
 * Reine visuelle Schicht — die Kern-Kette schreibt hier nur hinein.
 *
 * @author Wael Hammami
 */

export const visualBus = {
  /** Horizontale Gesichtsposition -1 (links) .. +1 (rechts), gespiegelt
   *  wie ein Spiegelbild (Person bewegt sich nach links → Wert wird negativ).
   *  0 = zentriert oder niemand da. */
  faceX: 0,
  /** Proxemic-Näherungswert 0..1 (Kopie des App-States für die Szenen). */
  proximity: 0,
  /** Verweil-Fortschritt 0..1 (Feedforward) — der Aux-Ring füllt sich
   *  damit; im Aux-Fenster wird der Wert aus dem BroadcastChannel hierher
   *  gespiegelt. */
  dwellProgress: 0,
};

/**
 * useFaceDetection.js
 *
 * Präsenzerkennung via MediaPipe (tasks-vision, lokal/offline).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * KOMPLETT-ÜBERARBEITUNG 2026-08-18: "PERSON ANWESEND" statt "GESICHT STABIL"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Die alte Logik (3 s ununterbrochen stabiles Gesicht, 20-Frame-Fenster mit
 * Hysterese, aggressiver Tracking-Zoom 1.5–3.0) war im Labor zu streng:
 * faces=1 flackerte, faceRatio pendelte um die Hysterese-Schwellen, der
 * Handshake feuerte nicht oder fiel sofort zurück. Ein Public Display muss
 * die Frage "Ist eine Person da?" beantworten — nicht "Steht sie wie eine
 * Statue?".
 *
 * Neue Philosophie (radikal einfacher, nur Zeitstempel + Trefferfenster):
 *
 *   1. PRÄSENZ = ZEITSTEMPEL. Jeder Treffer (Gesicht, Pose oder Bewegung)
 *      setzt lastPresenceAt = jetzt. Präsenz gilt, solange seit dem letzten
 *      Treffer weniger als PRESENCE_HOLD_MS vergangen sind. Ein einziger
 *      Treffer alle paar Sekunden reicht → kein Flackern mehr möglich.
 *
 *   2. HANDSHAKE = TREFFERFENSTER. Ausgelöst, wenn im gleitenden Fenster
 *      der letzten HANDSHAKE_WINDOW_MS mindestens HANDSHAKE_MIN_HITS
 *      Personen-Treffer (Gesicht/Pose, NICHT Bewegung) lagen. Bei ~15–30
 *      Detections/s ist das trivial erfüllt, sobald wirklich jemand da ist —
 *      aber nicht durch einen einzelnen Geister-Frame oder einen Schatten.
 *
 *   3. VERLASSEN = TIMEOUT. Erst wenn PRESENCE_HOLD_MS ohne jeden Treffer
 *      vergangen sind, wird onFaceLost gemeldet. Im ACTIVE-/HANDSHAKE-
 *      Zustand gilt die längere ACTIVE_NO_FACE_TIMEOUT_MS, damit ein laufendes
 *      Videogespräch nicht durch natürliche Bewegung abbricht.
 *
 * Weitere Robustheits-Maßnahmen:
 *   – Confidence-Schwellen auf 0.15 (lieber False Positives, die das
 *     Trefferfenster wegfiltert, als verpasste Personen)
 *   – Moderater, träger Zoom (1.0–2.0, Dämpfung 0.05) statt springendem
 *     Tracking-Zoom — MediaPipe muss nicht ständig neu "suchen"
 *   – Fallback-Scan: 1 s ohne Gesicht → ein Frame OHNE Zoom (Vollbild)
 *     prüfen, damit Personen am Rand / sehr nah / sehr fern gefunden werden
 *   – Bewegung (Motion) hält die Präsenz gleichwertig aufrecht
 *   – Optionaler PoseLandmarker-Fallback (Ganzkörper — robuster bei Abstand
 *     und Kopfdrehung), läuft nur wenn das Gesicht gerade nichts liefert
 *   – Sichtbares Debug-HUD (Taste "d"), damit im Labor sofort sichtbar ist,
 *     was die Erkennung tut
 *
 * Unverändert:
 *   – Bewegungserkennung (80×45-Pixel-Differenz)
 *   – Proxemic-Näherungsmetrik (proximity 0..1 für AuxDisplay)
 *   – Kamera-/WASM-Lifecycle, Callbacks per Ref
 *   – WebRTC-Stream bleibt komplett unberührt (eigener Stream in useWebRTC)
 */

import { useEffect, useRef, useCallback, useState } from 'react';
// DURCHBRUCH-FIX 2026-08-20: FaceDetector (BlazeFace, 230 KB) statt
// FaceLandmarker (478-Punkte-Mesh, 3,7 MB). Wir nutzten von den 478
// Landmarks ausschließlich min/max für eine Bounding-Box — der Detector
// liefert genau diese Box direkt, bei ~1/8 der Kosten (Labor-Messung:
// Landmarker 258 ms vs. Pose-lite 31 ms auf CPU/XNNPACK).
import { FaceDetector, PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

/** Median einer Zahlen-Liste (leeres Array → 0). Reine Hilfsfunktion, kein Hook. */
function medianOf(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ═══════════════════════════════════════════════════════════════════════════
// KONFIGURATION — alle Stellschrauben an einem Ort
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GLÄTTUNG GEGEN WEITWINKEL-RAUSCHEN (2026-08-21): Küchen-Messung zeigte
 * faceWidthOrig bei RUHIG STEHENDER Person schwankend zwischen 0.044 und
 * 0.102 (Faktor 2!) — Objektiv-/Detektions-Rauschen des Weitwinkelobjektivs,
 * keine echte Bewegung. Das lag GENAU um die (raumskalierte) DWELL/ACTIVE/
 * DETECT-Schwellen herum → Nähe-Entscheidung kippte frameweise hin und her,
 * presence ready pendelte, HANDSHAKE synchronisierte nie zwischen den
 * Räumen. FIX: Median der letzten FACE_WIDTH_SMOOTH_N ECHTEN (nicht
 * überbrückten) Rohmessungen ersetzt den Rohwert für JEDE Nähe-Entscheidung
 * (Dwell-Gewicht, ACTIVE-Präsenz-Guard, Distanz-Gate-Hysterese, Proximity,
 * Zoom-Ziel, Bridging-Anker) — nur die reine Box-POSITION (Crop-Führung)
 * bleibt roh, Ortsrauschen schadet dort weniger als Verzögerung. Ein
 * Median (statt Mittelwert) verwirft einzelne Ausreißer robust, ohne echte
 * Sprünge (Person tritt näher) über Gebühr zu verschleifen.
 */
const FACE_WIDTH_SMOOTH_N = 10;

/**
 * RAUM-KALIBRIERUNG (2026-08-21): Labor- und Küchenkamera liefern bei
 * GLEICHER Distanz (1 m) UNTERSCHIEDLICHE faceWidth-Werte — Labor Mitte
 * ≈0.116, Küche Mitte ≈0.0615, Faktor ≈0.53. Vermutlich unterschiedliches
 * Kamera-Sichtfeld/Optik. ALLE faceWidth-Schwellen unten waren bisher NUR
 * im Labor kalibriert.
 * Physikalische Begründung fürs Skalieren: Bei zwei Kameras mit fester
 * Brennweite ist das Verhältnis der belegten Bildbreite für ein gleich
 * großes, gleich weit entferntes Gesicht über die Distanz NÄHERUNGSWEISE
 * KONSTANT (beide Sichtfelder sind fix) — ein EINZELNER Kalibrierpunkt
 * (hier 1 m) lässt sich näherungsweise auf andere Distanzen übertragen.
 * ACHTUNG: nur EIN Messpunkt vorhanden — keine Bestätigung bei 2-3 m in
 * der Küche. Vor Ort gegenprüfen, wenn Zeit bleibt (HUD zeigt faceWidth
 * live); ROOM_FACE_SCALE hier direkt nachjustieren, falls nötig.
 * Aktivierung: URL-Parameter ?room=kueche (Default 'labor' = Faktor 1.0 —
 * KEINE Verhaltensänderung im Labor). start_display_kueche.bat hängt den
 * Parameter automatisch an.
 */
const ROOM_ID = (() => {
  try {
    return new URLSearchParams(window.location.search).get('room') === 'kueche'
      ? 'kueche' : 'labor';
  } catch { return 'labor'; }
})();
const ROOM_FACE_SCALE = ROOM_ID === 'kueche' ? 0.53 : 1.0;

/**
 * Manuelle Notbremse für den Score (2026-08-21): Küche maß Score 0.65-0.85,
 * teils UNTER dem Labor-kalibrierten FACE_MIN_SCORE=0.75 — ein zweites,
 * von der Distanz-Kalibrierung UNABHÄNGIGES Risiko. Bewusst NICHT automatisch
 * raumabhängig gesenkt (kein Phantom-Test in der Küche vorhanden, anders als
 * im Labor) — stattdessen als expliziter, manueller Vor-Ort-Hebel:
 * ?scoremin=0.6 überschreibt FACE_MIN_SCORE testweise, ohne Codeänderung.
 */
const SCORE_MIN_OVERRIDE = (() => {
  try {
    const v = parseFloat(new URLSearchParams(window.location.search).get('scoremin'));
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null;
  } catch { return null; }
})();

// ── Präsenz-Philosophie: Zeitstempel + Trefferfenster ────────────────────────
const PRESENCE_HOLD_MS_IDLE   = 8_000;   // AMBIENT/DETECTING: 8 s ohne Treffer → Person gilt als weg
/**
 * PROBLEM 2 (Labortest 2026-08-20): Werden im HANDSHAKE/ACTIVE so lange
 * weder Gesicht noch Pose erkannt, gilt die Person als weg → der Anruf
 * wird beendet (onFaceLost → App legt auf). WICHTIG: Reine BEWEGUNG hält
 * die Präsenz in diesen Zuständen NICHT mehr am Leben (sonst hielten
 * Ventilator/Lichtwechsel/Flur-Passanten den Anruf ewig offen — derselbe
 * Fehlertyp wie der HANDSHAKE-Bug). Kurzes Kopfdrehen/Bücken bleibt
 * durch die 25 s Nachlauf tolerant abgedeckt.
 */
const ACTIVE_NO_FACE_TIMEOUT_MS = 25_000;

/**
 * Problem 3.3 (Phantom-Absicherung): Im HANDSHAKE/ACTIVE hält ein
 * Gesichts-Treffer die Präsenz nur, wenn das Gesicht mindestens so breit
 * ist (relativ zum Bild). Ein winziges Phantom-"Gesicht" am Bildrand
 * (Möbelstruktur) kann den Anruf damit nicht mehr am Leben halten.
 * 0.02 = die Untergrenze der Proximity-Skala; echte Personen im Raum
 * liegen deutlich darüber (Labor gemessen: 0.11–0.13). 0 = Guard aus.
 */
const ACTIVE_MIN_FACE_RATIO = 0.02 * ROOM_FACE_SCALE;
const HANDSHAKE_WINDOW_MS     = 4_000;   // Gleitendes Fenster für Präsenz-Treffer (HUD/Diagnose)
const HANDSHAKE_MIN_HITS      = 5;       // (nur noch informativ — Auslösung siehe DWELL unten)
const HANDSHAKE_REFIRE_MS     = 5_000;   // Frühestens alle 5 s erneut auslösen (Selbstheilung, falls
                                         // die App nach end_call wieder in DETECTING steht)

// ── TEIL A: VERWEILDAUER-GATE — Vorbeigehende lösen KEINEN Anruf aus ────────
// AUDIENCE FUNNEL (Müller et al. 2010): Der Übergang von "Passing By" zu
// "Subtle/Direct Interaction" braucht ein Signal für ABSICHT — das Verweilen.
// Ein Handshake startet erst, wenn die Person DWELL_REQUIRED_MS bewusst
// stehen bleibt (hohe Trefferquote im gleitenden Fenster) UND nah genug ist.
const DWELL_REQUIRED_MS    = 3000;  // so lange muss die Person verweilen (Audience Funnel, Müller et al. 2010)
// Labortest (Küche): Erkennung dort intermittierend → 0.7 war nie erreichbar
// (gemessen ~5 % Trefferquote). 0.5 heißt: jeder zweite Detektions-Frame
// darf ausfallen. Die Unterscheidung Vorbeigehen/Verweilen bleibt erhalten,
// weil sie primär über die DAUER (3 s) + NÄHE läuft, nicht über die Quote —
// ein Vorbeigehender ist schlicht zu kurz nah, egal wie gut er erkannt wird.
const DWELL_MIN_HIT_RATIO  = 0.5;
const DWELL_RESET_RATIO    = 0.2;    // erst unter 20 % (gewichtet) beginnt die
                                     // Verweildauer von vorn (dazwischen: einfrieren)
/**
 * Pose-Treffer tragen den Verweil-Fortschritt MIT — mit halbem Gewicht:
 * Die Pose bestätigt "eine Person steht da", aber nicht die Zuwendung des
 * Gesichts zum Display. Halbes Gewicht wahrt die Audience-Funnel-Semantik
 * (bewusstes Zuwenden füllt doppelt so schnell wie bloßes Dastehen) und
 * überbrückt die Lücken der intermittierenden Gesichtserkennung (Küche).
 * Pose kann den Fortschritt nur FORTSETZEN, nie allein starten (Guard in
 * processFrame: erst wenn schon Gesichts-Fortschritt existiert).
 */
const DWELL_POSE_WEIGHT    = 0.5;
/**
 * Nähe-Bedingung (A2): Gesichtsbreite im ORIGINALBILD (0..1). Zum Vergleich:
 * proximity=0 entspricht 0.02, proximity=1 entspricht 0.06 (PROXIMITY_FACE_
 * WIDTH_MIN/MAX). 0.035 ≈ proximity 0.375 — zwischen Zone B und C: die
 * Person muss erkennbar herangetreten sein, aber nicht schon mit der Nase
 * an der Kamera stehen. JUSTIEREN IM LABOR: Taste "d" → HUD zeigt
 * "faceWidthOrig" live; Wert ablesen, wenn jemand an der gewünschten
 * "Anruf-Position" steht, und hier eintragen (Weitwinkel → eher kleiner).
 */
const DWELL_MIN_FACE_RATIO = 0.09 * ROOM_FACE_SCALE;

/**
 * DISTANZ-WAHRNEHMBARKEIT ("zu weit", 2026-08-21): ANDERE Schwelle als
 * DWELL_MIN_FACE_RATIO — die hier liegt DAVOR und entscheidet, ob eine
 * Erkennung überhaupt REGISTRIERT wird (Präsenz, Zustandswechsel AMBIENT→
 * DETECTING, Zoom/Crop/Proximity-Reaktion). DWELL_MIN_FACE_RATIO entscheidet
 * erst DANACH, ob ein bereits registriertes Verweilen zu einem Anruf führt.
 * Kalibrierung Labor (User): 1 m → faceWidth 0.09-0.13, 2-3 m → 0.064-0.075.
 * ENTER=0.085 liegt knapp ÜBER der 2-3-m-Bande (trifft dort niemanden mehr),
 * aber unter der Dwell-Schwelle 0.09 — jemand, der bis zur Dwell-Position
 * weitergeht, wird also immer erst "wahrgenommen", bevor er "verweilt".
 * HYSTERESE gegen Flackern an der Schwelle: einmal wahrgenommen, muss die
 * Box auf EXIT=0.07 schrumpfen (spürbar weiter weg), bevor sie wieder als
 * "zu weit" gilt — ein Pendeln um 0.085 allein reicht nicht mehr.
 * ACHTUNG (Weitwinkel-Vorbehalt): faceWidth hängt AUCH von der Position im
 * Bild ab (Rand < Mitte, s. Antwort im Chat) — die Schwelle ist eine
 * Annäherung an Distanz, keine exakte Messung. Vor Ort an mehreren
 * Bildpositionen gegenprüfen (HUD zeigt Box-Position in %).
 */
const DETECT_MIN_FACE_RATIO  = 0.085 * ROOM_FACE_SCALE;   // ENTER: ab hier "wahrgenommen"
const DETECT_EXIT_FACE_RATIO = 0.07  * ROOM_FACE_SCALE;   // EXIT: erst darunter wieder "zu weit"

// ── Zweite Präsenzquelle: Bewegung ───────────────────────────────────────────
const MOTION_KEEPS_PRESENCE   = true;    // Bewegung hält (und in ACTIVE/HANDSHAKE seit 2026-08-31
                                         // auch stützt) Präsenz — aber IMMER nur innerhalb von
                                         // MOTION_ANCHOR_MS nach dem letzten ECHTEN Treffer (s.u.)
const MOTION_ANCHOR_MS = 20_000;         // Zeitanker (2026-08-31): Bewegung allein trägt Präsenz
                                         // höchstens so lange über einen fehlenden Gesichts-/Pose-
                                         // Treffer hinweg — danach greift wieder die normale
                                         // PRESENCE_HOLD_MS_IDLE- bzw. ACTIVE_NO_FACE_TIMEOUT_MS-
                                         // Karenz ungebremst (kein endloses Halten durch Bewegung).
const POSE_ANCHOR_MS = 45_000;           // Zeitanker (2026-08-31): Pose OHNE eigene Distanz-/
                                         // Identitätsinformation kann ein statisches Objekt im
                                         // Raum als Körper erkennen und die Präsenz sonst
                                         // unbegrenzt aufrecht halten — Pose stützt Präsenz daher
                                         // nur, solange ein ECHTES Gesicht nicht länger als
                                         // POSE_ANCHOR_MS zurückliegt (s. lastFaceHitRef unten).
const MOTION_CHECK_INTERVAL_MS = 220;    // Bewegungsprüfung alle 220 ms
const MOTION_SCORE_THRESHOLD   = 9;      // Mindest-Grauwertdifferenz pro Pixel
const MOTION_PIXELS_THRESHOLD  = 55;     // Mindestanzahl veränderter Pixel

// ── Detektor-Wahl (Aufgabe 4) ────────────────────────────────────────────────
// 'face' = nur FaceLandmarker
// 'pose' = nur PoseLandmarker (Ganzkörper, robust bei Abstand/Kopfdrehung)
// 'both' = Gesicht jede Frame-Runde; Pose läuft NUR als Fallback, wenn das
//          Gesicht länger als POSE_FALLBACK_AFTER_MS nichts geliefert hat
//          (spart CPU auf dem Mini-PC, bringt aber die Pose-Robustheit,
//          genau wenn sie gebraucht wird). Präsenz gilt bei Gesicht ODER Pose.
const DETECTOR               = 'both';   // 'face' | 'pose' | 'both'
const POSE_FALLBACK_AFTER_MS = 500;      // 'both': Pose schon nach 0,5 s ohne Gesicht (Küche:
                                         // intermittierende Erkennung → Pose füllt Lücken schneller)
const POSE_MIN_INTERVAL_MS   = 200;      // Pose höchstens 5×/s (Performance Mini-PC)
// In leerem AMBIENT sucht Pose 5x/s à ~138ms nach niemandem und kostet ~70%
// CPU-Zeit (Messung 2026-08-25: 16 fps statt 30). 1x/s reicht dort — sobald
// Bewegung oder ein Gesicht Präsenz meldet, gilt sofort wieder das schnelle
// Intervall (s. Pose-Gate weiter unten).
const POSE_MIN_INTERVAL_IDLE_MS = 1000;

// ── MediaPipe-Empfindlichkeit (Aufgabe 1.1) ──────────────────────────────────
// Bewusst sehr niedrig (0.15): Ein Public Display, das Passanten nicht
// erkennt, ist nutzlos. False Positives werden vom Trefferfenster gefiltert.
/**
 * FaceDetector-Schwelle (ersetzt die drei Landmarker-Konfidenzen —
 * der Detector kennt nur minDetectionConfidence). BlazeFace-Scores sind
 * ANDERS kalibriert als die Landmarker-Präsenzwerte: echte Gesichter
 * liegen meist deutlich über 0.5. 0.35 ist empfindlich genug für die
 * Küche (faceWidth 0.11+ wird sicher gefunden) und zugleich deutlich
 * phantomfester als der alte Landmarker@0.15 — wichtig gegen "Anruf
 * endet nie" durch Phantom-Gesichter in Möbelstrukturen (Problem 3).
 */
// PHANTOM-FIX (2026-08-21, leerer Laborraum wurde als Person erkannt):
// 0.35 → 0.5. Begründung: 0.5 ist der von MediaPipe kalibrierte DEFAULT
// des FaceDetectors (gute Precision); wir hatten ihn aus Landmarker-Zeiten
// übervorsichtig gesenkt. Echte frontale Gesichter scoren typisch 0.7+,
// auch klein/weitwinkel meist >0.6 — das Phantom (Stuhl/Monitor) lag
// zwischen 0.35 und 0.5. Der Score jeder Erkennung steht jetzt im HUD:
// vor Ort an der Studien-Position ablesen und ggf. nachjustieren.
const FACE_MIN_SCORE = SCORE_MIN_OVERRIDE ?? 0.75;


/**
 * DIAGNOSE-SPLIT (2026-08-21): An die MediaPipe-API geht eine NIEDRIGE
 * Schwelle, gefiltert wird in JS gegen FACE_MIN_SCORE — das VERHALTEN ist
 * identisch, aber verworfene Kandidaten werden erstmals SICHTBAR
 * (HUD "verworfen: Score (0.42)", rote Box in der Preview) und füttern
 * das Statik-Fenster kontinuierlich (ein um die Schwelle pendelndes
 * Möbel-Phantom wird sonst nie als statisch erkannt, weil seine
 * Trefferserie lückenhaft ist). Inferenzkosten unverändert.
 */
const FACE_API_MIN_SCORE = 0.2;

/**
 * Modellwahl per URL (?facemodel=full|short), Standard: short_range —
 * der getestete Stand. full_range (blaze_face_full_range.tflite, lokal
 * vorhanden) ist für GRÖSSERE Distanzen/Weitwinkel ausgelegt und könnte
 * bei uns (Person 2–3 m vor Weitwinkelkamera) robuster UND phantomfester
 * sein — zwei Tage vor der Studie aber KEIN Default-Wechsel ohne
 * Vor-Ort-A/B-Test (HUD zeigt Score/Quote für beide direkt vergleichbar).
 */
const FACE_MODEL_PATH = (() => {
  try {
    return new URLSearchParams(window.location.search).get('facemodel') === 'short'
      ? '/models/blaze_face_short_range.tflite'
      : '/models/blaze_face_full_range.tflite';
  } catch { return '/models/blaze_face_full_range.tflite'; }
})();

/**
 * ANTI-MÖBEL-PRÜFUNG (Statik): Ein echter Mensch erzeugt IMMER Box-Jitter
 * (Atmung, Gewichtsverlagerung — und BlazeFace-Boxen rauschen selbst bei
 * stillem Gesicht um etliche Promille). Bleibt die Box über das ganze
 * Fenster in Position UND Größe nahezu exakt konstant (Spannweite unter
 * STATIC_MAX_SPAN) UND ist der Score dabei NIEDRIG (< STATIC_SCORE_MAX),
 * ist es ein statisches Objekt → der Treffer hält weder Präsenz noch füllt
 * er das Verweil-Gate (Anzeige/HUD bleiben, Flag "STATISCH").
 *
 * FEHLALARM 2026-08-21 (KRITISCH, Labor): Eine ruhig stehende echte Person
 * (Score 0.84, Spannweite 0.23 %) wurde mitten im ACTIVE-Anruf als
 * "statisch" eingestuft → Präsenz weg → Anruf brach ab. Zwei Gegenmaßnahmen:
 *   (1) STATIC_MAX_SPAN 0.004 → 0.001 (strenger; gilt jetzt NUR noch in
 *       AMBIENT/DETECTING, s. (2)).
 *   (2) Score-Kombination NEU: Nur bei NIEDRIGEM Score (< STATIC_SCORE_MAX)
 *       UND geringer Spannweite greift "statisch" — ein hoher Score (+
 *       bereits geprüfte plausible Keypoints) ist mit hoher Wahrschein-
 *       lichkeit ein echtes, nur ruhig stehendes Gesicht, unabhängig davon,
 *       wie wenig es sich bewegt.
 *   (3) Der Filter greift NIE MEHR im HANDSHAKE/ACTIVE — eine laufende
 *       Verbindung BEWEIST bereits, dass eine echte Person da war; er wird
 *       nur zum AUSLÖSEN gebraucht (AMBIENT/DETECTING), nicht zum HALTEN
 *       (s. Umsetzung unten, im Statik-Fenster-Block).
 * Der gemessene Jitter steht weiterhin im HUD und ist vor Ort kalibrierbar.
 */
const STATIC_WINDOW_MS  = 5_000;
const STATIC_MIN_FRAMES = 20;
const STATIC_MAX_SPAN   = 0.001;
const STATIC_SCORE_MAX  = 0.7;   // ab diesem Score gilt "statisch" NIE (Punkt 4)

/**
 * KEYPOINT-PLAUSIBILITÄT: BlazeFace liefert 6 Keypoints (Augen, Nase,
 * Mund, Ohren). Ein echtes frontales Gesicht erfüllt einfache Geometrie:
 * Augenabstand 15–70 % der Boxbreite und Augen OBERHALB des Munds.
 * Phantome (Möbelkanten) verletzen das häufig → Treffer wird verworfen.
 * Bewusst nur diese zwei groben Checks (keine Ausschluss-Gefahr für
 * echte, leicht gedrehte Gesichter). Abschaltbar: false.
 */
const KEYPOINT_CHECK = true;

/**
 * KURZZEIT-PERSISTENZ / "BRIDGING" (2026-08-21): BlazeFace verpasst
 * vereinzelt einen Frame, obwohl die Person ruhig davorsteht (s. der
 * seltene FACE-Max-Ausreißer im HUD, ~1 von mehreren hundert Frames) —
 * das lässt den Verweil-Fortschritt sichtbar stocken. Bleibt ein
 * akzeptierter, NICHT-statischer Treffer für weniger als
 * FACE_GAP_TOLERANCE_MS aus, gilt seine letzte Position/Größe weiter.
 * Ein echter Mensch verschwindet nicht für 300 ms und kommt zurück.
 * WICHTIG (Phantom-Schutz): Der Anker wird NUR aus einem Frame gesetzt,
 * das Score- UND Keypoint-Filter bestanden hat UND nicht als statisch
 * markiert ist (s. lastGoodFaceRef-Zuweisung unten) — ein verworfener
 * oder als Möbel erkannter Treffer kann sich so NIE einbrücken.
 */
const FACE_GAP_TOLERANCE_MS = 500;
const MIN_POSE_DETECTION_CONFIDENCE = 0.25;  // Pose etwas höher: Ganzkörper-Fehltreffer sind seltener nötig

// ── Moderater, gedämpfter Zoom (Aufgabe 1.2) ─────────────────────────────────
// Kein aggressives Tracking mehr: enger Bereich, sehr langsame Anpassung.
// Ein ruhiges Bild ist für MediaPipe wichtiger als ein perfekt gefülltes.
const ZOOM_MIN          = 1.0;    // Untergrenze (Vollbild)
const ZOOM_MAX          = 2.0;    // Obergrenze (vorher 3.0 → sprang zu stark)
const ZOOM_IDLE         = 1.3;    // Ruhestellung, wenn kein Gesicht gefunden wird
// Labortest (Küche): Der Zoom destabilisierte die Erkennung — Gesicht klein
// (Weitwinkel) + Zoom 2.0 + träges Crop-Zentrum → Gesicht fiel aus dem
// Ausschnitt, Erkennung wurde intermittierend. Drei Gegenmaßnahmen:
//   1. Zoom noch träger (0.03), Crop-Zentrum dafür ETWAS schneller (0.08),
//   2. Nach einem Fallback-Scan-Fund springt das Crop-Zentrum SOFORT auf
//      die Fundstelle (siehe handleFaceResults),
//   3. Solange die Verweildauer läuft (0 < dwell < 1), wird der Zoom
//      EINGEFROREN — kein Ausschnittswechsel mitten im Verweilen.
const ZOOM_DAMPING      = 0.03;
const CROP_DAMPING      = 0.08;
const FACE_TARGET_RATIO = 0.3;    // Zielbreite des Gesichts im Detection-Canvas

// ── Fallback-Scan (Aufgabe 1.3) ──────────────────────────────────────────────
// Wenn 1 s lang kein Gesicht gefunden wurde, wird ca. 1×/s ein Frame OHNE
// Zoom (Vollbild, zentriert) geprüft — findet Personen am Bildrand oder in
// unerwarteter Entfernung, ohne dauerhaft Rechenzeit zu kosten.
const FALLBACK_SCAN_AFTER_MS    = 1_000;
const FALLBACK_SCAN_INTERVAL_MS = 1_000;

// ── Debug-HUD — PRODUKTION: beides false = für Teilnehmer unsichtbar ───────
// Die Elemente werden trotzdem (versteckt) erzeugt, damit Taste "d" sie
// zur Laufzeit ein-/ausblenden kann (Prüfen im Labor ohne Code-Änderung).
const SHOW_DEBUG_HUD    = false;  // Overlay unten links: Start-Sichtbarkeit
const SHOW_ZOOM_PREVIEW = false;  // Detection-Preview unten rechts: Start-Sichtbarkeit
const HUD_UPDATE_INTERVAL_MS = 250;
// s. Problem 5 (2026-08-21): Trägerstatistik nur alle 2s neu sortieren
const STAT_RECALC_INTERVAL_MS = 2_000;

// ── PERFORMANCE (Problem 3, Labortest): Detektions-Takt ─────────────────────
// detectForVideo läuft SYNCHRON auf dem Main-Thread und blockierte bei
// voller rAF-Rate (30–60×/s) das Rendern → sichtbares Stocken der Partikel.
// 15 Detektionen/s reichen vollständig: die Verweil-Logik arbeitet mit
// RELATIVEN Quoten + Δt-Wachstum (ratenunabhängig), und für Problem 1
// zählt die Trefferquote pro Detektion, nicht deren Anzahl.
const DETECTION_INTERVAL_MS = 66;   // ~15 Detektionen/s (Stufe 0, GPU-Fall)

/**
 * CPU-NOTFALLPFAD (Labortest: Detekt 274 ms = MediaPipe auf CPU/XNNPACK):
 * Läuft die Detektion auf der CPU, ist die AUFLÖSUNG der größte Hebel
 * (Kosten ~ Pixelzahl). Die Stufen werden AUTOMATISCH anhand der
 * gemessenen Detektionsdauer (EMA) geschaltet und im HUD angezeigt:
 *   Stufe 0: 640×360, alle 66 ms   (GPU: ~10–20 ms → Ziel-fps)
 *   Stufe 1: 480×270, alle 150 ms  (EMA > 45 ms)
 *   Stufe 2: 320×180, alle 300 ms  (EMA > 45 ms auch auf Stufe 1)
 * Qualität ehrlich: Dank Zoom (bis 2.0) bleibt das Gesicht an der
 * Studien-Position (faceWidth ~0.116 → ~74 px auf Stufe 2) sicher
 * erkennbar; die FERN-Erkennung (Stufe-1-Anzeige, Gesichter nahe der
 * 0.035-Grenze ≈ 22 px) wird auf Stufe 2 spürbar schwächer.
 */
const DETECTION_LEVELS = [
  { w: 640, h: 360, interval: 66,  poseInterval: 200 },
  { w: 480, h: 270, interval: 150, poseInterval: 400 },
  { w: 320, h: 180, interval: 300, poseInterval: 600 },
];
const DETECT_COST_UP_MS   = 45;   // EMA darüber → eine Stufe runter (gröber)
const DETECT_COST_DOWN_MS = 18;   // EMA darunter → eine Stufe rauf (feiner)

/**
 * READBACK-HYPOTHESE (Labortest): Detektions-Eingang wählbar —
 *   'canvas' (Standard): Video → Detection-Canvas (Zoom/Crop + adaptives
 *            Enhancement) → MediaPipe. Seit dem willReadFrequently-Fix
 *            ohne GPU-Readback-Stall.
 *   'direct': das HTMLVideoElement wird DIREKT an detectForVideo
 *            übergeben — gar kein Canvas in der Kette (Chromiums
 *            schnellster Pfad). Dafür entfallen Zoom/Crop UND das
 *            Enhancement; kleine/ferne Gesichter (Küche!) werden dann
 *            schwerer gefunden. regionOfInterest kann das nicht ersetzen:
 *            der FaceLandmarker unterstützt diese Option NICHT (nur
 *            Classifier-/Embedder-Tasks).
 * MESSERGEBNIS (Laptop, CPU-Delegate): direct = Prep 0 + Infer 31 ms,
 * fps am Limit; canvas = je nach willReadFrequently 20–214 ms Infer und
 * fps-Einbrüche — das Canvas-Verhalten ist hardware-/treiberabhängig in
 * BEIDE Richtungen fragil. Deshalb ist 'direct' der STANDARD; 'canvas'
 * bleibt als Küchen-Notnagel (Zoom+Enhancement) per ?detect=canvas.
 * Die HUD-Werte "Prep/Infer" zeigen vor Ort sofort, welcher Pfad gewinnt.
 */
const DETECT_INPUT_MODE = (() => {
  try {
    return new URLSearchParams(window.location.search).get('detect') === 'canvas'
      ? 'canvas' : 'direct';
  } catch { return 'direct'; }
})();

// ── BILDAUFBEREITUNG (Problem 1, Küche): adaptiv, NUR für die Erkennung ────
// Heller Hintergrund (weiße Küchenfronten) → Kamera belichtet aufs Weiß,
// das Gesicht säuft ab. Vor der Erkennung wird das Detection-Canvas per
// GPU-billigem CSS-Filter (brightness/contrast) aufgehellt — ADAPTIV:
// Maßstab ist das 25. Helligkeits-Perzentil (p25 = die dunklen Partien,
// also Gesicht/Bart). Liegt p25 im Normalbereich (Labor), bleibt der
// Filter praktisch aus (Faktor ~1.0) — kein fester Offset. Das an WebRTC
// gesendete Bild bleibt unberührt (eigener Stream, eigener Pfad).
const ENHANCE_ENABLED        = true;
const ENHANCE_TARGET_P25     = 80;    // Ziel: dunkle Partien auf ~80/255 heben
const ENHANCE_TRIGGER_MEAN   = 135;   // nur eingreifen, wenn Bild hell-lastig …
const ENHANCE_TRIGGER_P25    = 70;    // … UND dunkle Partien wirklich absaufen
const ENHANCE_MAX_BRIGHTNESS = 1.7;   // Deckel gegen Überkorrektur
const ENHANCE_MAX_CONTRAST   = 1.3;
const ENHANCE_LERP           = 0.08;  // sanfte Anpassung (kein Flackern)

// ── KAMERA-TUNING (Problem 1): Belichtungskorrektur, falls unterstützt ─────
// ACHTUNG: wirkt auf die KAMERA-HARDWARE, also (physikbedingt) auch leicht
// auf das WebRTC-Bild — ein korrekt belichtetes Gesicht ist aber auch für
// die Teilnehmer die Verbesserung. Bei Problemen: false.
const CAMERA_EXPOSURE_TUNE   = true;
const EXPOSURE_COMP_FRACTION = 0.65;  // Ziel im Range: 65 % Richtung "heller"

// ── Kamera & Detection-Canvas ────────────────────────────────────────────────
// Zurückgesetzt auf 720p (2026-08-25): BlazeFace skaliert intern auf
// 128×128 — 1080p-Input bringt keine Erkennungsqualität, kostet aber
// Detekt 92ms statt 31ms und senkt fps von 30 auf 19 (Messung 2026-08-23).
// 720p ist die korrekte Erkennungsauflösung; der WebRTC-Videostream
// (useWebRTC.js) bleibt davon unberührt.
const CAMERA_WIDTH           = 1280;
const CAMERA_HEIGHT          = 720;
const CAMERA_FALLBACK_WIDTH  = 960;
const CAMERA_FALLBACK_HEIGHT = 540;
const DETECTION_CANVAS_WIDTH  = 640;   // klein halten (Performance Mini-PC),
const DETECTION_CANVAS_HEIGHT = 360;   // 16:9 wie das Kamerabild (keine Verzerrung)

// ── MediaPipe-Optionen ───────────────────────────────────────────────────────
// FaceDetector statt FaceLandmarker (Durchbruch-Fix, s. Import-Kommentar):
// liefert Bounding-Box + Score — exakt das, was die App nutzt (faceWidth,
// Position, Anzahl). Vorher: face_landmarker.task, numFaces: 2,
// Blendshapes bereits aus, Matrizen bereits aus — der Kostentreiber war
// das 478-Punkte-Mesh selbst.
const FACE_DETECTOR_OPTIONS = {
  baseOptions: {
    modelAssetPath: FACE_MODEL_PATH,   // short_range | full_range (?facemodel=)
    delegate: 'GPU',   // fällt automatisch auf CPU zurück
  },
  runningMode: 'VIDEO',
  // niedrig — die eigentliche Schwelle FACE_MIN_SCORE wird in JS geprüft
  // (Diagnose-Split, s. FACE_API_MIN_SCORE)
  minDetectionConfidence: FACE_API_MIN_SCORE,
};

const POSE_LANDMARKER_OPTIONS = {
  baseOptions: {
    modelAssetPath: '/models/pose_landmarker_lite.task',  // lokal aus public/models/
    delegate: 'GPU',
  },
  runningMode: 'VIDEO',
  numPoses: 1,
  minPoseDetectionConfidence: MIN_POSE_DETECTION_CONFIDENCE,
  minPosePresenceConfidence:  MIN_POSE_DETECTION_CONFIDENCE,
  minTrackingConfidence:      MIN_POSE_DETECTION_CONFIDENCE,
};

// ── Proxemic-Näherungsmetrik (unverändert, für AuxDisplay) ──────────────────
const PROXIMITY_FACE_WIDTH_MIN   = 0.02 * ROOM_FACE_SCALE;
const PROXIMITY_FACE_WIDTH_MAX   = 0.06 * ROOM_FACE_SCALE;
const PROXIMITY_SMOOTHING        = 0.15;
const PROXIMITY_EMIT_INTERVAL_MS = 120;

// ── faceX: horizontale Gesichtsposition -1 (links) .. +1 (rechts) ───────────
// PROXEMIC INTERACTION (Ballendat et al. 2010, Greenberg et al. 2011):
// Das Display reagiert nicht nur auf Distanz (proximity), sondern auch auf
// die laterale POSITION der Person — rein visuelle Schicht (ParticleField).
// GESPIEGELT wie ein Spiegelbild (Person geht nach links → Wert negativ);
// wirkt die Reaktion im Labor "falsch herum", nur FACE_X_SIGN umdrehen.
const FACE_X_SIGN      = 1;      // 1 = Spiegel-Logik, -1 = Kamera-Logik
const FACE_X_SMOOTHING = 0.12;   // EMA bei sichtbarem Gesicht
const FACE_X_DECAY     = 0.03;   // langsames Zurückgleiten zu 0 ohne Gesicht

// ── Status-Log (Konsole, gedrosselt) ─────────────────────────────────────────
const STATUS_LOG_INTERVAL_MS  = 2_000;
const DEBUG_FLUSH_INTERVAL_MS = 250;

// ─────────────────────────────────────────────────────────────────────────────

export function useFaceDetection({
  onFaceDetected,
  onFaceStabilized,
  onFacePromptReady,
  onTwoFacesStabilized,   // API-kompatibel; in App identisch mit onFaceStabilized verdrahtet
  onFaceLost,
  onFaceCountChange,
  onProximityChange,
  onFaceXChange,          // optional: horizontale Gesichtsposition -1..1 (visuelle Schicht)
  onDwellProgress,        // optional: Verweil-Fortschritt 0..1 (Feedforward, Teil A3)
  onCameraEvent,          // optional: 'camera_lost' | 'camera_recovered' (Teil B4, CSV)
  enabled = true,
  appState = '—',   // steuert die Wahl der Hold-Zeit (IDLE vs. ACTIVE) + HUD/Log
}) {
  // ── MediaPipe-Objekte ─────────────────────────────────────────────────────
  const videoRef          = useRef(null);
  const faceDetectorRef   = useRef(null);
  const poseLandmarkerRef = useRef(null);
  const animFrameRef      = useRef(null);

  // ── Kern der neuen Philosophie: nur Zeitstempel, keine Timer-Ketten ──────
  const isPresentRef        = useRef(false);  // "Person anwesend" (abgeleiteter Zustand)
  const lastFaceSeenAt      = useRef(0);      // letzter Gesichts-/Pose-Treffer (performance.now())
  const lastPresenceAt      = useRef(0);      // letzter Treffer JEGLICHER Quelle (inkl. Bewegung)
  const lastRealHitRef      = useRef(0);      // Zeitanker (2026-08-31): letzter ECHTER Treffer
                                               // (Gesicht ODER Pose, exakt an den registerPresence-
                                               // Stellen dafür gesetzt) — begrenzt MOTION_KEEPS_PRESENCE
  const lastFaceHitRef      = useRef(0);      // Zeitanker (2026-08-31): letzter ECHTER Treffer
                                               // NUR Gesicht (nicht Pose) — begrenzt POSE_ANCHOR_MS
  const hitTimestampsRef    = useRef([]);     // Personen-Treffer im Handshake-Fenster
  const lastHandshakeFireAt = useRef(0);      // Throttle für erneutes Auslösen
  const lastFaceCount       = useRef(0);

  // ── Bewegungszustand ──────────────────────────────────────────────────────
  const motionCanvas    = useRef(null);
  const lastMotionFrame = useRef(null);
  const lastMotionCheck = useRef(0);
  const lastMotionAt    = useRef(0);      // nur fürs HUD ("Motion vor X s")

  // ── Zoom / Crop ───────────────────────────────────────────────────────────
  const zoomCanvasRef  = useRef(null);
  const zoomCtxRef     = useRef(null);
  const zoomRef        = useRef(ZOOM_IDLE);
  const cropCenterRef  = useRef({ x: 0.5, y: 0.5 });
  // Geometrie des Crops, mit dem der AKTUELLE Frame gezeichnet wurde —
  // nötig, um Landmark-Koordinaten exakt ins Originalbild zurückzurechnen.
  const frameCropRef   = useRef({ zoom: ZOOM_IDLE, sx: 0, sy: 0, sw: 0, sh: 0, vw: 0, vh: 0 });
  const lastFallbackScanAt = useRef(0);

  // ── Pose-Fallback-Zustand ────────────────────────────────────────────────
  const lastPoseRunAt  = useRef(0);
  const lastPoseHitAt  = useRef(0);       // nur fürs HUD

  // ── Debug-HUD / Preview ──────────────────────────────────────────────────
  const hudElRef       = useRef(null);
  const previewElRef   = useRef(null);
  const previewCtxRef  = useRef(null);
  // Studie: HUD startet gemäß SHOW_DEBUG_HUD (Produktion: unsichtbar) —
  // Taste "d" blendet es bei Bedarf ein/aus.
  const hudVisibleRef  = useRef(SHOW_DEBUG_HUD);
  const lastHudUpdate  = useRef(0);
  const lastFaceBoxRef = useRef(null);    // Bounding-Box (Canvas-Koordinaten 0..1) fürs Preview

  // ── Status-Log / Proximity ───────────────────────────────────────────────
  const lastStatusLogRef     = useRef(0);
  const lastFaceWidthOrigRef = useRef(0);
  const proximitySmoothedRef = useRef(0);
  const proximityLastEmitRef = useRef(0);
  const faceXSmoothedRef     = useRef(0);

  // ── TEIL A: Verweildauer-Zustand ─────────────────────────────────────────
  const dwellFramesRef    = useRef([]);  // gleitendes Fenster: {t, w} pro Detektions-Frame
  const dwellLastFrameRef = useRef(0);   // Zeitstempel des letzten Frames (Δt-Basis)
  const dwellProgressRef  = useRef(0);   // 0..1 (Feedforward für den Aux-Ring)
  const dwellLastEmitRef  = useRef(0);
  const dwellRatioRef     = useRef(0);   // gewichtete Trefferquote (HUD)
  const dwellSourceRef    = useRef('—'); // was trägt den Fortschritt: FACE/POSE/—

  // ── Problem 1/3: Bildaufbereitung, Detektions-Takt, fps ─────────────────
  const enhanceBrightRef   = useRef(1);  // aktueller brightness-Faktor (gelerpt)
  const enhanceContrastRef = useRef(1);  // aktueller contrast-Faktor (gelerpt)
  const lumaStatsRef       = useRef({ mean: 128, p25: 128 });  // aus Motion-Graustufen
  const faceLumaRef        = useRef(-1); // mittlere Helligkeit des Gesichtsbereichs (HUD)
  const lastDetectRunRef   = useRef(0);  // Drossel: Detektion nur alle DETECTION_INTERVAL_MS
  const fpsCounterRef      = useRef({ frames: 0, since: 0, fps: 0 });  // Render-Loop-fps (HUD)

  // ── fps-Diagnose/Selbstschutz (Labortest: 4 fps!) ────────────────────────
  const detectDtRef        = useRef(66);   // realer Abstand zwischen Detektionen (Δt-Lerps)
  const detectCostRef      = useRef(0);    // EMA der GESAMT-Detektionsdauer (Stufenschaltung)
  const prepCostRef        = useRef(0);    // EMA: Canvas-Vorbereitung (drawImage) — HUD
  const inferCostRef       = useRef(0);    // EMA: reine MediaPipe-Inferenz — HUD
  // Problem 4.1: getrennte 30-s-Statistik pro Träger (min/median/max im HUD)
  const faceStatsRef       = useRef([]);   // [{t, ms}] der FaceDetector-Läufe
  const poseStatsRef       = useRef([]);   // [{t, ms}] der PoseLandmarker-Läufe

  // ── Phantom-Abwehr (2026-08-21) ──────────────────────────────────────────
  const lastFaceScoreRef   = useRef(0);    // Confidence der letzten Erkennung (HUD)
  const faceBoxHistRef     = useRef([]);   // [{t, cx, cy, w}] fürs Statik-Fenster
  const faceStaticRef      = useRef(false);// true = Box statisch → Möbel-Verdacht
  const faceJitterRef      = useRef(0);    // gemessene Spannweite (HUD, Kalibrierung)
  const lastRejectReasonRef = useRef('');  // 'Score (0.42)' | 'Keypoints' | 'statisch' | ''
  const rejectCountsRef    = useRef({ score: 0, kp: 0 });  // kumulative Verwurf-Zähler
  const lastRejectBoxRef   = useRef(null); // Box+Grund des besten VERWORFENEN Kandidaten (Preview, rot)

  // ── Kurzzeit-Persistenz / Bridging (2026-08-21) ──────────────────────────
  const lastGoodFaceRef    = useRef({ t: 0, minX: 0, maxX: 0, minY: 0, maxY: 0, faceWidthOrig: 0 });
  const bridgingMsRef      = useRef(0);    // >0 = gerade überbrückt, HUD-Anzeige (ms seit letztem Echt-Treffer)

  // ── Distanz-Wahrnehmbarkeit / "zu weit" (2026-08-21) ─────────────────────
  // perceivedRef = Hysterese-Zustand: "ist gerade eine NAHE Person etabliert?"
  // Wird von Face (echt/überbrückt) gesetzt, von Pose UND Bewegung nur
  // GELESEN (sie können eine bestehende Nähe halten, aber nie selbst eine
  // ferne Person zu "nah" machen — Problem 4/5).
  const perceivedRef       = useRef(false);
  const tooFarRef          = useRef(false);   // HUD/Preview: diesen Frame "zu weit"?

  // ── Weitwinkel-Glättung (2026-08-21) ──────────────────────────────────────
  const faceWidthHistRef   = useRef([]);   // letzte N ECHTE Rohmessungen (Median-Fenster)
  const faceWidthRawRef    = useRef(0);    // letzter Rohwert, nur fürs HUD (Diagnose)

  // ── HUD-Statistik-Cache (2026-08-21): stat() sortiert bis zu ~900
  // Einträge (30-s-Fenster bei ~30 Detekt/s) — bei jedem 250-ms-HUD-Tick
  // NEU zu sortieren erzeugt genau die Art von periodischer GC-Last, die
  // vereinzelte Detektions-Aussetzer verursachen kann (Problem 5). Der
  // String wird daher nur alle STAT_RECALC_INTERVAL_MS neu berechnet.
  const statCacheRef       = useRef({ face: '—', pose: '—', lastCalc: 0 });

  // ── Video-Diagnose (Problem 1.1): kommen wirklich Frames an? ─────────────
  const videoDiagRef       = useRef({ lastLog: 0, lastTime: -1 });
  const detectLevelRef     = useRef(0);    // CPU-Notfallstufe 0/1/2 (Auflösung+Takt)
  const detectLevelSinceRef = useRef(0);   // Hysterese: nicht öfter als alle 3 s schalten
  const delegateRef        = useRef('unbekannt'); // tatsächliches Delegate (HUD): GPU/CPU
  const enhanceKilledRef   = useRef(false);// Enhancement wegen fps-Einbruch deaktiviert
  const lastFilterStrRef   = useRef('');   // ctx.filter nur bei ÄNDERUNG zuweisen

  // ── ACTIVE-Timeout-Logging (Problem "nie zurück zu AMBIENT") ─────────────
  const presenceCountdownLogRef = useRef(0);  // letzter Countdown-Log
  const presenceHoldLogRef      = useRef(0);  // letzter "Anruf gehalten von"-Log
  const appStateRef          = useRef(appState);
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  // ── Callback-Refs (stabile Identität über Re-Renders hinweg) ─────────────
  const onDetectedRef   = useRef(onFaceDetected);
  const onStabilizedRef = useRef(onFaceStabilized);
  const onPromptRef     = useRef(onFacePromptReady);
  const onTwoFacesRef   = useRef(onTwoFacesStabilized);
  const onLostRef       = useRef(onFaceLost);
  const onCountRef      = useRef(onFaceCountChange);
  const onProximityRef  = useRef(onProximityChange);
  const onFaceXRef      = useRef(onFaceXChange);
  const onDwellRef      = useRef(onDwellProgress);
  const onCameraRef     = useRef(onCameraEvent);

  useEffect(() => { onDetectedRef.current   = onFaceDetected;       }, [onFaceDetected]);
  useEffect(() => { onStabilizedRef.current = onFaceStabilized;     }, [onFaceStabilized]);
  useEffect(() => { onPromptRef.current     = onFacePromptReady;    }, [onFacePromptReady]);
  useEffect(() => { onTwoFacesRef.current   = onTwoFacesStabilized; }, [onTwoFacesStabilized]);
  useEffect(() => { onLostRef.current       = onFaceLost;           }, [onFaceLost]);
  useEffect(() => { onCountRef.current      = onFaceCountChange;    }, [onFaceCountChange]);
  useEffect(() => { onProximityRef.current  = onProximityChange;    }, [onProximityChange]);
  useEffect(() => { onFaceXRef.current      = onFaceXChange;        }, [onFaceXChange]);
  useEffect(() => { onDwellRef.current      = onDwellProgress;      }, [onDwellProgress]);
  useEffect(() => { onCameraRef.current     = onCameraEvent;        }, [onCameraEvent]);

  // ── Debug-Zustand für das DevPanel in App.jsx (nur DEV) ──────────────────
  const debugRef = useRef({
    cameraReady:     false,
    videoW:          0,
    videoH:          0,
    faceCount:       0,
    motionActive:    false,
    lastDetectionTs: null,
    proximity:       0,
  });
  const [debugInfo, setDebugInfo] = useState({ ...debugRef.current });
  const lastDebugFlush            = useRef(0);

  const flushDebug = useCallback(() => {
    if (!import.meta.env.DEV) return;
    const now = Date.now();
    if (now - lastDebugFlush.current < DEBUG_FLUSH_INTERVAL_MS) return;
    lastDebugFlush.current = now;
    setDebugInfo({ ...debugRef.current });
  }, []);

  // ── Bewegungserkennung (unverändert übernommen) ───────────────────────────
  // Vergleicht zwei aufeinanderfolgende 80×45-Miniaturbilder pixelweise.
  const detectMotion = useCallback((video) => {
    const now = performance.now();
    if (now - lastMotionCheck.current < MOTION_CHECK_INTERVAL_MS) return false;
    lastMotionCheck.current = now;
    if (!video.videoWidth || !video.videoHeight) return false;

    const canvas = motionCanvas.current ?? document.createElement('canvas');
    motionCanvas.current = canvas;
    canvas.width  = 80;
    canvas.height = 45;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame   = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const prev    = lastMotionFrame.current;
    const compact = new Uint8ClampedArray(canvas.width * canvas.height);

    let changed   = 0;
    let totalDiff = 0;
    for (let src = 0, dst = 0; src < frame.length; src += 4, dst++) {
      const gray = frame[src] * 0.299 + frame[src + 1] * 0.587 + frame[src + 2] * 0.114;
      compact[dst] = gray;
      if (prev) {
        const diff = Math.abs(gray - prev[dst]);
        if (diff > MOTION_SCORE_THRESHOLD) {
          changed++;
          totalDiff += diff;
        }
      }
    }
    lastMotionFrame.current = compact;

    // ── Problem 1: Helligkeits-Statistik (huckepack, alle 220 ms) ─────────
    // Histogramm über die vorhandenen Graustufen → mean + p25 (dunkle
    // Partien = Gesicht/Bart). Steuert die ADAPTIVE Bildaufbereitung.
    {
      const hist = new Uint32Array(256);
      let sum = 0;
      for (let i = 0; i < compact.length; i++) {
        const v = compact[i] | 0;
        hist[v]++;
        sum += v;
      }
      const mean = sum / compact.length;
      const q = compact.length * 0.25;
      let acc = 0, p25 = 255;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= q) { p25 = v; break; }
      }
      lumaStatsRef.current = { mean, p25 };

      // Zielfaktoren: NUR eingreifen, wenn hell-lastiges Bild UND dunkle
      // Partien absaufen (Küche). Im Labor bleibt der Faktor bei ~1.0.
      let targetBright = 1.0;
      if (ENHANCE_ENABLED && mean > ENHANCE_TRIGGER_MEAN && p25 < ENHANCE_TRIGGER_P25) {
        targetBright = Math.min(
          ENHANCE_MAX_BRIGHTNESS,
          Math.max(1.0, ENHANCE_TARGET_P25 / Math.max(p25, 20)),
        );
      }
      const targetContrast = Math.min(ENHANCE_MAX_CONTRAST, 1 + (targetBright - 1) * 0.4);
      enhanceBrightRef.current   += (targetBright   - enhanceBrightRef.current)   * ENHANCE_LERP;
      enhanceContrastRef.current += (targetContrast - enhanceContrastRef.current) * ENHANCE_LERP;

      // Mittlere Helligkeit des GESICHTSBEREICHS (HUD): letzte FaceBox über
      // die Crop-Geometrie ins Originalbild und auf das 80×45-Bild mappen
      const box = lastFaceBoxRef.current;
      const crop = frameCropRef.current;
      if (box && crop.vw > 0) {
        const x0 = Math.max(0, Math.floor(((crop.sx + box.minX * crop.sw) / crop.vw) * canvas.width));
        const x1 = Math.min(canvas.width - 1, Math.ceil(((crop.sx + box.maxX * crop.sw) / crop.vw) * canvas.width));
        const y0 = Math.max(0, Math.floor(((crop.sy + box.minY * crop.sh) / crop.vh) * canvas.height));
        const y1 = Math.min(canvas.height - 1, Math.ceil(((crop.sy + box.maxY * crop.sh) / crop.vh) * canvas.height));
        let fSum = 0, fN = 0;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) { fSum += compact[y * canvas.width + x]; fN++; }
        }
        faceLumaRef.current = fN > 0 ? Math.round(fSum / fN) : -1;
      } else {
        faceLumaRef.current = -1;
      }
    }

    return prev
      && changed > MOTION_PIXELS_THRESHOLD
      && totalDiff / changed > MOTION_SCORE_THRESHOLD;
  }, []);

  // ── Frame auf das Detection-Canvas zeichnen ──────────────────────────────
  // fullFrame=true → Fallback-Scan: Vollbild ohne Zoom (Aufgabe 1.3).
  // Sonst: gedämpfter Ausschnitt um das Crop-Zentrum (moderater Zoom).
  // Die verwendete Geometrie landet in frameCropRef für die Rückrechnung.
  const drawDetectionFrame = useCallback((video, fullFrame) => {
    const canvas = zoomCanvasRef.current;
    const ctx    = zoomCtxRef.current;
    if (!canvas || !ctx) return null;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const zoom    = fullFrame ? 1.0 : zoomRef.current;
    const sWidth  = vw / zoom;
    const sHeight = vh / zoom;

    const cx = (fullFrame ? 0.5 : cropCenterRef.current.x) * vw;
    const cy = (fullFrame ? 0.5 : cropCenterRef.current.y) * vh;
    const sx = Math.min(vw - sWidth,  Math.max(0, cx - sWidth  / 2));
    const sy = Math.min(vh - sHeight, Math.max(0, cy - sHeight / 2));

    frameCropRef.current = { zoom, sx, sy, sw: sWidth, sh: sHeight, vw, vh };

    // Problem 1: ADAPTIVE Aufbereitung NUR für die Erkennung. VORSICHT
    // (fps-Fix 2026-08-20): ctx.filter kann den Canvas in Chromium auf den
    // CPU-Pfad zwingen → drastischer fps-Einbruch. Deshalb: (a) Filter-
    // String nur bei ÄNDERUNG zuweisen, (b) Not-Aus enhanceKilledRef —
    // bricht die Render-fps unter 20 ein, während der Filter aktiv ist,
    // wird er dauerhaft deaktiviert (Kamera-Belichtungskorrektur und die
    // übrigen Küche-Fixes bleiben davon unberührt).
    const b = enhanceBrightRef.current;
    const c = enhanceContrastRef.current;
    const filterStr =
      (ENHANCE_ENABLED && !enhanceKilledRef.current && (b > 1.02 || c > 1.02))
        ? `brightness(${b.toFixed(2)}) contrast(${c.toFixed(2)})`
        : 'none';
    if (filterStr !== lastFilterStrRef.current) {
      lastFilterStrRef.current = filterStr;
      ctx.filter = filterStr;
    }
    ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
    return canvas;
  }, []);

  // ── Debug-Preview zeichnen (Erkennungs-EINGABE + Gesichtsrahmen) ─────────
  // FIX 2026-08-21 (Problem 1/3): Im direct-Modus wird das Detection-Canvas
  // nie befüllt — die Vorschau zeichnete deshalb ein leeres (schwarzes)
  // Canvas, während die Erkennung längst auf dem echten Video arbeitete.
  // Jetzt zeigt die Vorschau exakt die jeweilige MediaPipe-Eingabe:
  // direct → das Video-Element, canvas-Modus → das Zoom-Canvas.
  const drawPreview = useCallback(() => {
    const preview = previewElRef.current;
    const pctx    = previewCtxRef.current;
    if (!preview || !pctx || !hudVisibleRef.current) return;

    if (DETECT_INPUT_MODE === 'direct') {
      const video = videoRef.current;
      if (!video || video.videoWidth === 0) return;
      pctx.drawImage(video, 0, 0, preview.width, preview.height);
    } else {
      const canvas = zoomCanvasRef.current;
      if (!canvas) return;
      pctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, preview.width, preview.height);
    }

    // Rahmen + Score (Box ist im selben Koordinatenraum wie die jeweilige
    // Eingabe → passt in beiden Modi).
    //   GRÜN     = akzeptierte, nahe Person
    //   BLAU     = überbrückter Aussetzer (letzte Position gehalten)
    //   ORANGE   = akzeptiert, aber STATISCH (Möbel-Verdacht, zählt nicht)
    //   GRAU     = akzeptiert, aber ZU WEIT (Distanz-Gate, 2026-08-21)
    //   ROT      = verworfener Kandidat, mit Grund (Score/Keypoints)
    const drawBox = (b, color, label) => {
      pctx.strokeStyle = color;
      pctx.lineWidth   = 2;
      const bx = b.minX * preview.width;
      const by = b.minY * preview.height;
      pctx.strokeRect(bx, by, (b.maxX - b.minX) * preview.width, (b.maxY - b.minY) * preview.height);
      pctx.font = 'bold 12px monospace';
      pctx.fillStyle = color;
      pctx.fillText(label, bx + 2, Math.max(11, by - 4));
    };
    const box = lastFaceBoxRef.current;
    const rej = lastRejectBoxRef.current;
    if (box) {
      const isStatic   = faceStaticRef.current;
      const isBridging = bridgingMsRef.current > 0;
      const isTooFar   = tooFarRef.current;
      const color = isBridging ? '#38bdf8' : isTooFar ? '#9ca3af' : isStatic ? '#ffaa00' : '#00ff66';
      const label = isBridging
        ? `Bridging ${(bridgingMsRef.current / 1000).toFixed(1)}s`
        : `${lastFaceScoreRef.current.toFixed(2)}${isTooFar ? ' ZU WEIT' : isStatic ? ' STATISCH' : ''}`;
      drawBox(box, color, label);
    } else if (rej) {
      drawBox(rej, '#f87171', `${rej.score.toFixed(2)} ${rej.reason}`);
    }
  }, []);

  // ── Debug-HUD aktualisieren (Aufgabe 3) ──────────────────────────────────
  const updateHud = useCallback((now, hitsInWindow) => {
    const hud = hudElRef.current;
    if (!hud || !hudVisibleRef.current) return;
    if (now - lastHudUpdate.current < HUD_UPDATE_INTERVAL_MS) return;
    lastHudUpdate.current = now;

    const present   = isPresentRef.current;
    const sinceFace = lastFaceSeenAt.current > 0
      ? ((now - lastFaceSeenAt.current) / 1000).toFixed(1) + ' s'
      : '—';
    const sinceMotion = lastMotionAt.current > 0
      ? ((now - lastMotionAt.current) / 1000).toFixed(1) + ' s'
      : '—';
    const poseInfo = (DETECTOR === 'face' || !poseLandmarkerRef.current)
      ? ''
      : ` | Pose vor: ${lastPoseHitAt.current > 0 ? ((now - lastPoseHitAt.current) / 1000).toFixed(1) + ' s' : '—'}`;

    const luma = lumaStatsRef.current;
    const faceLuma = faceLumaRef.current;
    const enhanceB = enhanceBrightRef.current;

    // Problem 4.1: min/median/max (ms) über das 30-s-Fenster, pro Träger.
    // Problem 5 (2026-08-21): NICHT bei jedem 250-ms-HUD-Tick neu sortieren
    // (bis zu ~900 Einträge × 2 Träger, mehrmals pro Sekunde) — das erzeugt
    // periodische GC-Last, die selbst zu den vereinzelten Detektions-
    // Aussetzern beitragen kann. Nur alle STAT_RECALC_INTERVAL_MS neu
    // berechnen; dazwischen den letzten Wert anzeigen (Werte ändern sich
    // über 2 s ohnehin kaum sichtbar).
    const sc = statCacheRef.current;
    if (now - sc.lastCalc > STAT_RECALC_INTERVAL_MS) {
      const stat = (arr) => {
        if (arr.length === 0) return '—';
        const v = arr.map((e) => e.ms).sort((a, b) => a - b);
        return `${Math.round(v[0])}/${Math.round(v[v.length >> 1])}/${Math.round(v[v.length - 1])}`;
      };
      sc.face = stat(faceStatsRef.current);
      sc.pose = stat(poseStatsRef.current);
      sc.lastCalc = now;
    }

    const inputInfo = DETECT_INPUT_MODE === 'direct'
      ? 'video-direkt'
      : `${DETECTION_LEVELS[detectLevelRef.current].w}×${DETECTION_LEVELS[detectLevelRef.current].h}`;

    // Mehrzeilig, Wichtigstes zuerst (Problem 2)
    hud.innerHTML =
      // Zeile 1: Zustand · Quote · Dwell · Detekt · fps · Delegate · Träger
      `<div><b>${appStateRef.current}</b>`
      // Raum-Kalibrierung sichtbar bestätigen (2026-08-21) — nur wenn NICHT
      // Labor-Default, damit im Labor nichts Neues im Blick steht
      + `${ROOM_ID === 'kueche' ? ` <b style="color:#38bdf8">[Küche ×${ROOM_FACE_SCALE}]</b>` : ''}`
      + ` · Quote <b>${Math.round(dwellRatioRef.current * 100)}%</b>/${Math.round(DWELL_MIN_HIT_RATIO * 100)}`
      + ` · Dwell <b>${Math.round(dwellProgressRef.current * 100)}%</b>`
      + ` · Detekt <b>${Math.round(detectCostRef.current)}ms</b> (P${Math.round(prepCostRef.current)}+I${Math.round(inferCostRef.current)})`
      + ` · fps <b>${fpsCounterRef.current.fps}</b>`
      + ` · Delegate <b style="color:${delegateRef.current === 'GPU' ? '#4ade80' : '#f87171'}">${delegateRef.current}</b>`
      + ` · Träger <b>${dwellSourceRef.current}</b>`
      // Kurzzeit-Persistenz aktiv? (Problem 1-4, 2026-08-21)
      + `${bridgingMsRef.current > 0
          ? ` · <b style="color:#38bdf8">Bridging ${(bridgingMsRef.current / 1000).toFixed(1)}s</b>` : ''}`
      + `</div>`
      // Zeile 2: Präsenz · Statistik pro Träger · Eingang/Stufe
      + `<div><b style="color:${present ? '#4ade80' : '#f87171'}">Präsenz ${present ? 'JA' : 'NEIN'}</b>`
      + ` · FACE min/med/max ${sc.face}ms`
      + ` · POSE ${sc.pose}ms`
      + ` · Eingang ${inputInfo}`
      + `${detectLevelRef.current > 0 ? ` <b style="color:#facc15">Stufe ${detectLevelRef.current}</b>` : ''}`
      + `</div>`
      // Zeile 3: Erkennungsdetails + Phantom-Diagnose (2026-08-21)
      + `<div>faceWidth ${lastFaceWidthOrigRef.current.toFixed(3)}`
      // Rohwert daneben (Diagnose): zeigt, wie stark die Glättung wirklich
      // dämpft (2026-08-21, Küchen-Rauschen)
      + ` <span style="color:#888">(roh ${faceWidthRawRef.current.toFixed(3)}, n=${faceWidthHistRef.current.length})</span>`
      + ` · <b>Score ${lastFaceScoreRef.current > 0 ? lastFaceScoreRef.current.toFixed(2) : '—'}</b>`
      + `${(() => {
          const b = lastFaceBoxRef.current;
          if (!b) return ' · Box —';
          return ` · Box ${Math.round(((b.minX + b.maxX) / 2) * 100)}%/${Math.round(((b.minY + b.maxY) / 2) * 100)}%`;
        })()}`
      + ` · Jitter ${faceBoxHistRef.current.length >= STATIC_MIN_FRAMES ? (faceJitterRef.current * 100).toFixed(2) + '%' : '—'}`
      + `${faceStaticRef.current ? ' <b style="color:#ffaa00">STATISCH</b>' : ''}`
      // Welche Schicht hat zuletzt verworfen? + kumulative Zähler pro Schicht
      + `${lastRejectReasonRef.current ? ` · <b style="color:#f87171">verworfen: ${lastRejectReasonRef.current}</b>` : ''}`
      + `${(rejectCountsRef.current.score + rejectCountsRef.current.kp) > 0
          ? ` · Rejects S/K ${rejectCountsRef.current.score}/${rejectCountsRef.current.kp}` : ''}`
      + ` · ${FACE_MODEL_PATH.includes('full') ? 'full_range' : 'short_range'}`
      + ` · Luma ${faceLuma >= 0 ? faceLuma : '—'} (ø${Math.round(luma.mean)}/p25 ${Math.round(luma.p25)})`
      // Enhance wirkt nur im canvas-Notnagel-Modus → nur dort anzeigen
      + `${DETECT_INPUT_MODE !== 'direct' ? ` · Enhance ${enhanceKilledRef.current ? '<b style="color:#f87171">AUS(fps)</b>' : '×' + enhanceB.toFixed(2)}` : ''}`
      + ` · Treffer ${hitsInWindow}`
      + ` · letzter vor ${sinceFace}`
      + ` · Motion ${sinceMotion}${poseInfo}`
      + ` · Zoom ${zoomRef.current.toFixed(2)}</div>`;
  }, []);

  // ── TEIL A: Verweildauer aktualisieren (einmal pro Detektions-Frame) ─────
  // AUDIENCE FUNNEL: Verweilen = Absicht. nearHit = Gesicht gefunden UND
  // nah genug (DWELL_MIN_FACE_RATIO). Pose-Treffer halten die PRÄSENZ
  // aufrecht (laufender Anruf bricht nicht ab), zählen aber bewusst NICHT
  // als Verweil-Treffer — ein Anruf startet nur über ein nahes Gesicht.
  /**
   * @param {number} now    – performance.now()
   * @param {number} weight – Treffer-Gewicht dieses Detektions-Frames:
   *                          1.0 = nahes Gesicht, DWELL_POSE_WEIGHT = Pose,
   *                          0 = nichts (Labortest-Fix: Pose trägt mit)
   */
  const updateDwell = useCallback((now, weight) => {
    const frames = dwellFramesRef.current;
    frames.push({ t: now, w: weight });
    while (frames.length > 0 && now - frames[0].t > DWELL_REQUIRED_MS) frames.shift();

    let weightSum = 0;
    for (let i = 0; i < frames.length; i++) weightSum += frames[i].w;
    const ratio = frames.length > 0 ? weightSum / frames.length : 0;
    dwellRatioRef.current = ratio;   // fürs HUD (Problem 1.7)

    // Δt seit dem letzten Detektions-Frame. Deckel 350 ms: Tab-Aussetzer
    // zählen nicht als "verweilte Zeit", aber langsame Frames (z.B. 4 fps
    // = 250 ms Abstand) zählen VOLL — sonst liefe die Verweildauer bei
    // niedriger fps in Zeitlupe (Fix 2026-08-20).
    const dt = dwellLastFrameRef.current > 0
      ? Math.min(now - dwellLastFrameRef.current, 350)
      : 0;
    dwellLastFrameRef.current = now;

    if (ratio < DWELL_RESET_RATIO) {
      // Person ist (praktisch) weg → Verweildauer beginnt von vorn.
      // WICHTIG: Ein EINZELNER Frame ohne Gesicht landet nie hier —
      // die Quote sinkt nur allmählich.
      dwellProgressRef.current = 0;
    } else if (ratio >= DWELL_MIN_HIT_RATIO && weight > 0) {
      // INKREMENTELL statt zeitstempel-basiert (Audit-Fix): während einer
      // Einfrier-Phase läuft KEINE Zeit auf. Pose-Frames wachsen mit
      // halbem Gewicht (Audience-Funnel-Semantik, s. DWELL_POSE_WEIGHT).
      dwellProgressRef.current = Math.min(
        1, dwellProgressRef.current + (dt * weight) / DWELL_REQUIRED_MS,
      );
    }
    // Quote zwischen RESET und MIN: Fortschritt friert ein (weder Reset
    // noch Wachstum) — kurze Aussetzer kosten nur Zeit, nicht den Fortschritt.

    // Feedforward (A3): Fortschritt gedrosselt an die App melden
    if (now - dwellLastEmitRef.current >= PROXIMITY_EMIT_INTERVAL_MS) {
      dwellLastEmitRef.current = now;
      onDwellRef.current?.(dwellProgressRef.current);
    }
  }, []);

  // ── HANDSHAKE-Prüfung: VERWEILDAUER-GATE (Teil A) ────────────────────────
  // Früher reichten 5 Treffer in 4 s (Vorbeigehende lösten Anrufe aus!).
  // Jetzt: dwellProgress muss 1.0 erreichen — 3 s bewusstes Stehenbleiben
  // in Kameranähe. Das Treffer-Fenster bleibt nur fürs HUD erhalten.
  const checkHandshake = useCallback((now) => {
    // Treffer-Fenster fürs HUD pflegen (Diagnose, keine Auslöse-Funktion mehr)
    const hits = hitTimestampsRef.current;
    while (hits.length > 0 && now - hits[0] > HANDSHAKE_WINDOW_MS) hits.shift();

    const state = appStateRef.current;
    const canFire =
      isPresentRef.current &&
      dwellProgressRef.current >= 1 &&
      (state === 'AMBIENT' || state === 'DETECTING') &&   // in HANDSHAKE/ACTIVE nichts erneut auslösen
      now - lastHandshakeFireAt.current > HANDSHAKE_REFIRE_MS;

    if (canFire) {
      lastHandshakeFireAt.current = now;
      console.info(
        `[Präsenz] Verweildauer erfüllt (${DWELL_REQUIRED_MS} ms, ` +
        `Quote ≥ ${DWELL_MIN_HIT_RATIO}, Nähe ≥ ${DWELL_MIN_FACE_RATIO}) → HANDSHAKE auslösen`,
      );
      onStabilizedRef.current?.();
    }
    return hits.length;
  }, []);

  // ── Präsenz-Verwaltung: Treffer registrieren / Verlust prüfen ────────────
  const registerPresence = useCallback((now, source) => {
    const st = appStateRef.current;
    const inCall = st === 'ACTIVE' || st === 'HANDSHAKE';
    const gap = now - lastPresenceAt.current;

    // Diagnose "nie zurück zu AMBIENT": Wenn ein Timeout-Countdown lief
    // (>3 s ohne Treffer) und jetzt aufgefrischt wird, WER war es? Damit
    // ist im Labor sofort sichtbar, ob Phantom-Treffer den Anruf halten.
    if (inCall && gap > 3_000) {
      console.warn(
        `[Präsenz] ${(gap / 1000).toFixed(1)}s-Countdown ZURÜCKGESETZT durch: ${source} `
        + `(faceWidth=${lastFaceWidthOrigRef.current.toFixed(3)}, t=${Math.round(now)})`,
      );
    }
    // Gedrosseltes Halte-Log im Anruf (alle 5 s): Quelle des Anruf-Bestands
    if (inCall && now - presenceHoldLogRef.current > 5_000) {
      presenceHoldLogRef.current = now;
      console.info(`[Präsenz] Anruf wird gehalten von: ${source} (t=${Math.round(now)})`);
    }

    lastPresenceAt.current = now;
    if (!isPresentRef.current) {
      isPresentRef.current = true;
      console.info(`[Präsenz] Person anwesend (Quelle: ${source})`);
      onDetectedRef.current?.();
      onPromptRef.current?.();
    }
  }, []);

  const checkPresenceLoss = useCallback((now) => {
    if (!isPresentRef.current) return;

    // Im HANDSHAKE/ACTIVE-Zustand gilt der lange Nachlauf, sonst der kurze
    const state  = appStateRef.current;
    const holdMs = (state === 'ACTIVE' || state === 'HANDSHAKE')
      ? ACTIVE_NO_FACE_TIMEOUT_MS
      : PRESENCE_HOLD_MS_IDLE;

    // Diagnose-Log (Problem "nie zurück"): laufender Countdown, alle 5 s.
    // Erscheint diese Zeile NIE, obwohl niemand da ist, frischt etwas die
    // Präsenz auf → das Zurücksetzen-Log oben nennt die Quelle.
    const gap = now - lastPresenceAt.current;
    if (gap > 3_000 && now - presenceCountdownLogRef.current > 5_000) {
      presenceCountdownLogRef.current = now;
      console.warn(
        `[Präsenz] Timeout läuft: ${(gap / 1000).toFixed(1)}/${(holdMs / 1000).toFixed(0)}s `
        + `ohne Gesicht/Pose (Zustand ${state}, t=${Math.round(now)})`,
      );
    }

    if (now - lastPresenceAt.current > holdMs) {
      isPresentRef.current       = false;
      hitTimestampsRef.current   = [];
      lastHandshakeFireAt.current = 0;
      // Nähe-Erinnerung zurücksetzen (2026-08-21): sonst könnte eine
      // spätere ferne Bewegung/Pose über die "war mal nah"-Erinnerung
      // Präsenz auslösen, obwohl seither niemand mehr nah war.
      perceivedRef.current = false;
      // Glättungs-Fenster leeren: eine neue Person soll nicht mit den
      // Rohmessungen der vorigen (evtl. Minuten alt) starten.
      faceWidthHistRef.current = [];
      if (lastFaceCount.current !== 0) {
        lastFaceCount.current = 0;
        onCountRef.current?.(0);
      }
      console.info(`[Präsenz] ${holdMs} ms ohne jeden Treffer → Person weg (onFaceLost)`);
      onLostRef.current?.();
    }
  }, []);

  // ── Gesichts-Ergebnis verarbeiten: Treffer, Zoom, Proximity ──────────────
  // FaceDetector-Ausgabe: detections[].boundingBox in PIXELN des Eingabe-
  // bilds → über inputW/inputH auf 0..1 normiert; ab da ist die gesamte
  // nachgelagerte Rechnung (Crop-Rückrechnung, faceWidth, faceX, Proximity)
  // identisch zur alten Landmark-Box.
  const handleFaceResults = useCallback((results, now, wasFallbackScan, inputW, inputH) => {
    const detections = Array.isArray(results.detections) ? results.detections : [];
    let faceFound = detections.length > 0 && inputW > 0 && inputH > 0;

    // ── PHANTOM-SCHICHT 2: Keypoint-Geometrie (2026-08-21) ────────────────
    // Ein echtes Gesicht: Augenabstand 15–70 % der Boxbreite, Augen über
    // dem Mund. Möbelkanten-Phantome verletzen das häufig → verwerfen.
    // BlazeFace-Keypoints (normiert aufs Bild): 0=Auge R, 1=Auge L,
    // 2=Nase, 3=Mund, 4=Ohr R, 5=Ohr L.
    const keypointsPlausible = (det) => {
      if (!KEYPOINT_CHECK) return true;
      const kp = det.keypoints;
      const bbw = det.boundingBox.width / inputW;
      if (!Array.isArray(kp) || kp.length < 4 || bbw <= 0) return true; // im Zweifel NICHT ausschließen
      const eyeR = kp[0], eyeL = kp[1], nose = kp[2], mouth = kp[3];
      const eyeDist = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y) / bbw;
      const eyesAboveMouth = eyeR.y < mouth.y && eyeL.y < mouth.y && nose.y < mouth.y;
      return eyeDist >= 0.15 && eyeDist <= 0.7 && eyesAboveMouth;
    };

    // Es wird die ERSTE plausible Detection gewählt (MediaPipe sortiert
    // nach Score) — ein verworfenes Phantom auf Platz 0 verdeckt so keine
    // echte Person auf Platz 1. Verwurf-Grund wird fürs HUD festgehalten
    // ("verworfen: Score (0.42)" / "verworfen: Keypoints").
    let chosenIdx = -1;
    let rejectReason = '';
    if (faceFound) {
      for (let i = 0; i < detections.length; i++) {
        const score = detections[i].categories?.[0]?.score ?? 0;
        if (score < FACE_MIN_SCORE) {
          rejectCountsRef.current.score++;
          if (!rejectReason) rejectReason = `Score (${score.toFixed(2)})`;
          continue;
        }
        if (!keypointsPlausible(detections[i])) {
          rejectCountsRef.current.kp++;
          if (!rejectReason) rejectReason = 'Keypoints';
          continue;
        }
        chosenIdx = i;
        break;
      }
      if (chosenIdx < 0) faceFound = false;
    }

    // Score erfassen: der GEWÄHLTEN Erkennung — oder des besten VERWORFENEN
    // Kandidaten (zeigt vor Ort, was das Phantom scored)
    lastFaceScoreRef.current = faceFound
      ? (detections[chosenIdx].categories?.[0]?.score ?? 0)
      : (detections[0]?.categories?.[0]?.score ?? 0);

    // Box+Grund des besten verworfenen Kandidaten (Preview: rote Box)
    if (!faceFound && detections.length > 0 && inputW > 0 && inputH > 0) {
      const rb = detections[0].boundingBox;
      lastRejectBoxRef.current = {
        minX: rb.originX / inputW,
        maxX: (rb.originX + rb.width) / inputW,
        minY: rb.originY / inputH,
        maxY: (rb.originY + rb.height) / inputH,
        reason: rejectReason,
        score: lastFaceScoreRef.current,
      };
    } else {
      lastRejectBoxRef.current = null;
    }
    lastRejectReasonRef.current = rejectReason && !faceFound ? rejectReason : '';

    // ── PHANTOM-SCHICHT 3: Statik-Fenster (Anti-Möbel, 2026-08-21) ────────
    // Spannweite von Zentrum + Breite über 5 s. Gefüttert mit der besten
    // BETRACHTETEN Box jedes Frames — auch Score-verworfenen Kandidaten —,
    // damit das Fenster bei einem intermittierenden Phantom kontinuierlich
    // bleibt. Tritt eine Person neben das Objekt, wechselt die beste Box →
    // Spannweite explodiert → nie fälschlich statisch. Fütterung läuft
    // IMMER (auch im Anruf) — nur die WIRKUNG (faceStaticRef) ist unten
    // zustandsabhängig, damit nach Anrufende sofort eine korrekte
    // Einschätzung vorliegt, statt das Fenster neu aufbauen zu müssen.
    {
      const st = appStateRef.current;
      const inCall = st === 'ACTIVE' || st === 'HANDSHAKE';
      const hist = faceBoxHistRef.current;
      const hd = chosenIdx >= 0 ? detections[chosenIdx] : detections[0];
      if (hd && inputW > 0 && inputH > 0) {
        const hb = hd.boundingBox;
        hist.push({
          t: now,
          cx: (hb.originX + hb.width / 2) / inputW,
          cy: (hb.originY + hb.height / 2) / inputH,
          w: hb.width / inputW,
        });
      }
      while (hist.length > 0 && now - hist[0].t > STATIC_WINDOW_MS) hist.shift();

      if (inCall) {
        // FEHLALARM-FIX (KRITISCH, 2026-08-21, Punkt 1/2): Im HANDSHAKE/
        // ACTIVE greift der Statik-Filter NIE — eine laufende Verbindung
        // BEWEIST bereits, dass eine echte Person da war; ein Möbelstück
        // kann keinen Anruf auslösen. Der Filter wird nur zum AUSLÖSEN
        // gebraucht (AMBIENT/DETECTING), nicht zum HALTEN.
        if (faceStaticRef.current) {
          console.info(`[Phantom] Statik-Sperre aufgehoben (Zustand ${st}) — laufende Verbindung beweist bereits eine echte Person`);
        }
        faceStaticRef.current = false;
      } else if (hist.length >= STATIC_MIN_FRAMES && now - hist[0].t > STATIC_WINDOW_MS * 0.8) {
        let span = 0;
        for (const key of ['cx', 'cy', 'w']) {
          let mn = Infinity, mx = -Infinity;
          for (const e of hist) { if (e[key] < mn) mn = e[key]; if (e[key] > mx) mx = e[key]; }
          span = Math.max(span, mx - mn);
        }
        faceJitterRef.current = span;
        const wasStatic = faceStaticRef.current;
        // Punkt 4: NUR bei NIEDRIGEM Score zusätzlich zur geringen Spann-
        // weite greift "statisch" — Score > STATIC_SCORE_MAX (+ bereits
        // geprüfte plausible Keypoints) ist mit hoher Wahrscheinlichkeit
        // ein echtes, nur ruhig stehendes Gesicht.
        const scoreLow = lastFaceScoreRef.current < STATIC_SCORE_MAX;
        faceStaticRef.current = span < STATIC_MAX_SPAN && scoreLow;
        if (faceStaticRef.current !== wasStatic) {
          console.warn(`[Phantom] Box ${faceStaticRef.current ? 'STATISCH (Möbel-Verdacht) — hält keine Präsenz mehr' : 'wieder beweglich — zählt als Person'} | Spannweite ${(span * 100).toFixed(2)} % | Score ${lastFaceScoreRef.current.toFixed(2)} | Zustand ${st}`);
        }
      } else {
        // Fensterbedingung (≥20 Messpunkte über ≥4 s) nicht erfüllt →
        // konservativ: NICHT statisch (nie eine echte Person ausschließen)
        faceStaticRef.current = false;
      }
    }
    // Statisch = Treffer wird nicht als Präsenz gewertet → als Grund anzeigen
    if (faceFound && faceStaticRef.current) lastRejectReasonRef.current = 'statisch';

    const crop = frameCropRef.current;   // Geometrie DIESES Frames
    let zoomTarget      = ZOOM_IDLE;     // ohne Gesicht: träge zur Ruhestellung
    let cropTargetX     = 0.5;
    let cropTargetY     = 0.5;
    let proximityTarget = 0;

    // ── Bridging-Entscheidung: kein akzeptierter Treffer DIESES Frames,
    // aber vor Kurzem einer? Dann überbrücken (s. Konstante oben).
    let isBridging = false;
    if (!faceFound) {
      const anchor = lastGoodFaceRef.current;
      if (anchor.t > 0 && now - anchor.t <= FACE_GAP_TOLERANCE_MS) {
        isBridging = true;
        faceFound = true;   // ab hier wie ein echter Treffer behandelt
      }
    }
    bridgingMsRef.current = isBridging ? (now - lastGoodFaceRef.current.t) : 0;

    let tooFar = false;

    if (faceFound) {
      let minX, maxX, minY, maxY, faceWidthOrig;

      if (isBridging) {
        // Letzte Position/Größe unverändert übernehmen (eingefroren)
        ({ minX, maxX, minY, maxY, faceWidthOrig } = lastGoodFaceRef.current);
      } else {
        // Bounding-Box der GEWÄHLTEN Detection, auf 0..1 normiert
        const bb = detections[chosenIdx].boundingBox;
        minX = bb.originX / inputW;
        maxX = (bb.originX + bb.width) / inputW;
        minY = bb.originY / inputH;
        maxY = (bb.originY + bb.height) / inputH;
        // Rückrechnung auf das ORIGINAL-Kamerabild (unabhängig vom Zoom)
        const faceWidthRaw = (maxX - minX) / crop.zoom;
        faceWidthRawRef.current = faceWidthRaw;

        // Median der letzten N Rohmessungen statt Rohwert (Weitwinkel-
        // Rauschen, s. Konstante FACE_WIDTH_SMOOTH_N oben) — ab hier ist
        // faceWidthOrig überall im Rest der Funktion der GEGLÄTTETE Wert.
        const hist = faceWidthHistRef.current;
        hist.push(faceWidthRaw);
        if (hist.length > FACE_WIDTH_SMOOTH_N) hist.shift();
        faceWidthOrig = medianOf(hist);
      }
      lastFaceBoxRef.current = { minX, maxX, minY, maxY };
      lastFaceWidthOrigRef.current = faceWidthOrig;

      // ── Zoom reagiert auf JEDE plausible Erkennung (2026-08-21, Fix) ─────
      // WICHTIG: unabhängig von der Distanz-Beurteilung unten — erst der
      // Zoom, dann die Distanz. Vorher stand das im "!tooFar"-Zweig: eine
      // Küchen-Person unter DETECT_MIN_FACE_RATIO hätte den Zoom NIE auf
      // ZOOM_MAX gebracht (Selbstverstärkung des "zu weit"-Urteils). In
      // ?detect=canvas (Küchen-Notnagel) bräuchte genau das den Zoom, um
      // überhaupt näher heranzukommen — im Standard-Modus 'direct' ist
      // crop.zoom ohnehin fest 1 (s. Antwort im Chat), hier nur Diagnose/
      // HUD-Wert und Absicherung für den Notnagel-Pfad.
      if (faceWidthOrig > 0.001) {
        zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, FACE_TARGET_RATIO / faceWidthOrig));
      }

      // ── Distanz-Wahrnehmbarkeit (Hysterese, 2026-08-21) ─────────────────
      // perceivedRef ist die geteilte Nähe-Erinnerung für Face/Pose/Bewegung
      // (s.u.). Nur eine ECHTE (nicht überbrückte) Breite darf den Zustand
      // ändern — ein Bridge-Frame reicht bewusst nur den letzten echten
      // Wert durch und bestätigt damit denselben Zustand erneut.
      if (!isBridging) {
        if (faceWidthOrig >= DETECT_MIN_FACE_RATIO) perceivedRef.current = true;
        else if (faceWidthOrig < DETECT_EXIT_FACE_RATIO) perceivedRef.current = false;
      }
      tooFar = !perceivedRef.current;
      if (tooFar) {
        lastRejectReasonRef.current = faceStaticRef.current ? 'statisch, zu weit' : 'zu weit';
      }

      if (!tooFar) {
        // Anker NUR aus einem ECHTEN, NICHT-statischen, NAHEN Treffer
        // aktualisieren (Phantom-Schutz UND Problem 5: eine zu weite
        // Erkennung darf nie zur Bridging-Quelle werden)
        if (!isBridging && !faceStaticRef.current) {
          lastGoodFaceRef.current = { t: now, minX, maxX, minY, maxY, faceWidthOrig };
        }

        // Treffer registrieren: Zeitstempel + Handshake-Fenster (auch beim
        // Überbrücken — ein Aussetzer ist keine Abwesenheit)
        lastFaceSeenAt.current = now;
        hitTimestampsRef.current.push(now);

        // Präsenz halten — im Anruf NUR, wenn das Gesicht groß genug ist
        // (Problem 3.3: winzige Phantom-Gesichter halten den Anruf nicht),
        // und NIE bei statischer Box (Möbel hält weder Anruf noch Dwell)
        const st = appStateRef.current;
        const inCall = st === 'ACTIVE' || st === 'HANDSHAKE';
        if ((!inCall || faceWidthOrig >= ACTIVE_MIN_FACE_RATIO) && !faceStaticRef.current) {
          registerPresence(now, isBridging ? 'Gesicht (überbrückt)' : 'Gesicht');
          lastRealHitRef.current = now; // Zeitanker (2026-08-31), s. MOTION_ANCHOR_MS
          lastFaceHitRef.current = now; // Zeitanker (2026-08-31), s. POSE_ANCHOR_MS — NUR Gesicht
        }

        // Crop-Zentrum langsam Richtung Gesicht führen
        if (crop.vw > 0 && crop.vh > 0) {
          cropTargetX = (crop.sx + ((minX + maxX) / 2) * crop.sw) / crop.vw;
          cropTargetY = (crop.sy + ((minY + maxY) / 2) * crop.sh) / crop.vh;
        }

        // Proximity-Zielwert aus der Original-Gesichtsbreite
        const range = PROXIMITY_FACE_WIDTH_MAX - PROXIMITY_FACE_WIDTH_MIN;
        proximityTarget = Math.min(1, Math.max(0,
          (faceWidthOrig - PROXIMITY_FACE_WIDTH_MIN) / range,
        ));
      }
      // Ist tooFar: NUR cropTarget/proximityTarget bleiben auf den AMBIENT-
      // Defaults (keine sichtbare Partikel-/faceX-Reaktion) — zoomTarget
      // reagiert bewusst TROTZDEM (s.o., internes Detektions-/HUD-Maß,
      // für die Audience nicht sichtbar).
    } else {
      lastFaceBoxRef.current = null;
      // (Statik-Fenster wird bereits zentral oben gepflegt)
    }
    tooFarRef.current = tooFar;

    // Gesichtsanzahl an die App melden (UI) — NACH Statik- UND Distanz-
    // Filter: eine statische oder zu weit entfernte "Erkennung" darf
    // appState nie von AMBIENT nach DETECTING kippen (Problem 2026-08-21).
    const perceptible = faceFound && !tooFar && !faceStaticRef.current;
    const faceCount = perceptible ? (isBridging ? 1 : detections.length) : 0;
    if (faceCount !== lastFaceCount.current) {
      lastFaceCount.current = faceCount;
      onCountRef.current?.(faceCount);
    }

    // Zoom + Crop SEHR träge nachführen (ruhiges Bild = stabile Erkennung).
    // Im reinen Pose-Modus bleibt der Zoom auf Vollbild (Körper braucht Weite).
    if (DETECTOR === 'pose') zoomTarget = ZOOM_MIN;

    // Labortest-Fix 1.6a: Fand der FALLBACK-Scan (Vollbild) das Gesicht,
    // springt das Crop-Zentrum SOFORT auf die Fundstelle — das träge
    // Nachziehen war die Hauptursache der intermittierenden Erkennung
    // (gezoomter Ausschnitt zeigte sekundenlang die falsche Bildregion).
    if (faceFound && wasFallbackScan) {
      cropCenterRef.current.x = cropTargetX;
      cropCenterRef.current.y = cropTargetY;
    }

    // Labortest-Fix 1.6b: Solange die Verweildauer läuft, wird der Zoom
    // EINGEFROREN — kein Ausschnittswechsel mitten im Verweilen (das
    // Gesicht darf nicht durch die eigene Zoom-Änderung verloren gehen).
    if (dwellProgressRef.current > 0.05 && dwellProgressRef.current < 0.99) {
      zoomTarget = zoomRef.current;
    }

    // Δt-NORMIERT (Fix 2026-08-20): Die Dämpfungen waren PRO FRAME
    // definiert — bei 4 fps liefen Zoom/Glättungen 15× zu langsam (Zeitlupe).
    // Referenz 33 ms = die ursprüngliche Kalibrierung; bei normaler Rate
    // verhält sich alles wie bisher, bei niedriger fps holt es auf.
    const lerpK = (k) => 1 - Math.pow(1 - k, Math.min(detectDtRef.current, 400) / 33.3);

    zoomRef.current         += (zoomTarget  - zoomRef.current)         * lerpK(ZOOM_DAMPING);
    cropCenterRef.current.x += (cropTargetX - cropCenterRef.current.x) * lerpK(CROP_DAMPING);
    cropCenterRef.current.y += (cropTargetY - cropCenterRef.current.y) * lerpK(CROP_DAMPING);

    // Proximity glätten (EMA, Δt-normiert) und gedrosselt melden
    proximitySmoothedRef.current +=
      (proximityTarget - proximitySmoothedRef.current) * lerpK(PROXIMITY_SMOOTHING);

    // faceX aus dem bereits zurückgerechneten Gesichtszentrum (cropTargetX,
    // Originalbild-Koordinaten 0..1) → -1..1, gespiegelt. Ohne Gesicht
    // gleitet der Wert langsam zurück zur Mitte (0).
    const faceXTarget = faceFound ? FACE_X_SIGN * (0.5 - cropTargetX) * 2 : 0;
    faceXSmoothedRef.current +=
      (faceXTarget - faceXSmoothedRef.current)
      * lerpK(faceFound ? FACE_X_SMOOTHING : FACE_X_DECAY);

    if (now - proximityLastEmitRef.current >= PROXIMITY_EMIT_INTERVAL_MS) {
      proximityLastEmitRef.current = now;
      onProximityRef.current?.(proximitySmoothedRef.current);
      onFaceXRef.current?.(Math.max(-1, Math.min(1, faceXSmoothedRef.current)));
    }

    // DevPanel-Daten (nur DEV)
    if (import.meta.env.DEV) {
      if (faceFound) debugRef.current.lastDetectionTs = Date.now();
      debugRef.current.faceCount    = faceCount;
      debugRef.current.motionActive = (now - lastMotionAt.current) < 1_500;
      debugRef.current.proximity    = proximitySmoothedRef.current;
      flushDebug();
    }

    return faceFound;
  }, [registerPresence, flushDebug]);

  // ── FaceLandmarker/PoseLandmarker + Kamera-Lifecycle ─────────────────────
  useEffect(() => {
    if (!enabled) return;

    let isRunning = true;

    // Verstecktes Video-Element (Off-Screen), damit der Browser es nicht throttlt
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
    videoRef.current = video;

    let mediaStream = null;
    let cameraRecoveryTimer = null;   // Teil B4: Selbstheilungs-Intervall

    // Taste "d": Debug-HUD + Preview ein-/ausblenden (Aufgabe 3.3)
    const onKeyDown = (e) => {
      if (e.key !== 'd' && e.key !== 'D') return;
      hudVisibleRef.current = !hudVisibleRef.current;
      const disp = hudVisibleRef.current ? 'block' : 'none';
      if (hudElRef.current)     hudElRef.current.style.display     = disp;
      if (previewElRef.current) previewElRef.current.style.display = disp;
    };
    window.addEventListener('keydown', onKeyDown);

    const init = async () => {
      try {
        // 0. GPU-Diagnose (Labortest: Detekt 274 ms = CPU-Fallback!):
        //    (a) Kann DIESE Seite überhaupt WebGL2? Ohne WebGL2 ist das
        //        GPU-Delegate unmöglich — edge://gpu kann trotzdem
        //        "accelerated" melden (anderes Profil/Prozess!).
        const webgl2ok = (() => {
          try { return !!document.createElement('canvas').getContext('webgl2'); }
          catch { return false; }
        })();
        console.info(`[MediaPipe] WebGL2 im Seiten-Kontext: ${
          webgl2ok ? 'verfügbar' : 'NICHT verfügbar → GPU-Delegate unmöglich!'}`);
        if (!webgl2ok) delegateRef.current = 'CPU (kein WebGL2)';

        //    (b) Delegate-Detektor: tasks-vision fällt STILL auf CPU zurück
        //        und meldet das nur als Konsolen-INFO ("Created TensorFlow
        //        Lite XNNPACK delegate for CPU"). Wir hören 10 s mit, um
        //        das TATSÄCHLICHE Delegate zu kennen (HUD-Anzeige) — die
        //        API selbst bietet keine Abfrage.
        const sniffDelegate = (first) => {
          const s = String(first);
          // GPU-Meldung hat VORRANG: XNNPACK kann auch bei aktivem GPU-
          // Delegate zusätzlich erscheinen (CPU-Restanteile des Graphen).
          // Der harte Indikator bleibt die gemessene Detekt-Zeit im HUD:
          // ~10–20 ms = GPU, 100 ms+ = CPU-Inferenz.
          if (/delegate for GPU/i.test(s)) {
            delegateRef.current = 'GPU';
          } else if (/XNNPACK|delegate for CPU/i.test(s)
                     && delegateRef.current !== 'GPU') {
            delegateRef.current = 'CPU (XNNPACK)';
          }
        };
        const origError = console.error;
        const origInfo  = console.info;
        const origLog   = console.log;
        console.error = (...a) => { sniffDelegate(a[0]); origError.apply(console, a); };
        console.info  = (...a) => { sniffDelegate(a[0]); origInfo.apply(console, a); };
        console.log   = (...a) => { sniffDelegate(a[0]); origLog.apply(console, a); };
        const unhookConsole = () => {
          console.error = origError; console.info = origInfo; console.log = origLog;
        };
        // Die XNNPACK-Meldung kommt oft erst bei der ERSTEN Inferenz —
        // deshalb 10 s mithören, dann sauber aushängen.
        setTimeout(() => {
          unhookConsole();
          if (delegateRef.current === 'unbekannt') {
            // keine CPU-Meldung aufgetaucht → GPU-Delegate läuft
            delegateRef.current = webgl2ok ? 'GPU' : 'CPU?';
          }
          console.info(`[MediaPipe] Delegate (erkannt): ${delegateRef.current}`);
        }, 10_000);

        // 1. WASM-Laufzeitumgebung lokal laden (kein CDN). Hinweis: Die
        //    Dateien in public/mediapipe/wasm sind byte-identisch mit
        //    node_modules 0.10.35 (SIMD-Variante vorhanden) — geprüft.
        console.info('[MediaPipe] Lade WASM-Laufzeitumgebung aus /mediapipe/wasm/ ...');
        const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');

        // 2. FaceDetector (außer im reinen Pose-Modus): delegate GPU ist
        //    gesetzt; wirft der GPU-Init eine Exception, expliziter
        //    CPU-Retry mit klarer Kennzeichnung (statt Totalausfall).
        if (DETECTOR !== 'pose') {
          console.info('[MediaPipe] Initialisiere FaceDetector (BlazeFace, delegate: GPU) ...');
          try {
            faceDetectorRef.current =
              await FaceDetector.createFromOptions(vision, FACE_DETECTOR_OPTIONS);
          } catch (gpuErr) {
            console.warn(
              '[MediaPipe] GPU-Init fehlgeschlagen → expliziter CPU-Retry:',
              gpuErr?.message ?? gpuErr,
            );
            delegateRef.current = 'CPU (GPU-Init-Fehler)';
            faceDetectorRef.current = await FaceDetector.createFromOptions(vision, {
              ...FACE_DETECTOR_OPTIONS,
              baseOptions: { ...FACE_DETECTOR_OPTIONS.baseOptions, delegate: 'CPU' },
            });
          }
          console.info(
            `[MediaPipe] FaceDetector bereit (minDetectionConfidence=${FACE_MIN_SCORE})`,
          );
        }

        // 2b. PoseLandmarker (Aufgabe 4) — Fehlschlag ist NICHT fatal:
        //     ohne Pose-Modell läuft die Erkennung mit Gesicht allein weiter.
        if (DETECTOR !== 'face') {
          try {
            console.info('[MediaPipe] Initialisiere PoseLandmarker (Fallback-Detektor) ...');
            poseLandmarkerRef.current =
              await PoseLandmarker.createFromOptions(vision, POSE_LANDMARKER_OPTIONS);
            console.info('[MediaPipe] PoseLandmarker bereit (pose_landmarker_lite.task)');
          } catch (poseErr) {
            console.warn(
              '[MediaPipe] PoseLandmarker nicht verfügbar (Modell fehlt?) — weiter ohne Pose:',
              poseErr?.message ?? poseErr,
            );
            poseLandmarkerRef.current = null;
          }
        }

        // 3. Kamerastream (nur Video — Audio kommt in useWebRTC)
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width:     { ideal: CAMERA_WIDTH },
              height:    { ideal: CAMERA_HEIGHT },
              frameRate: { ideal: 30 },
              facingMode: 'user',
            },
            audio: false,
          });
        } catch (camErr) {
          console.warn(
            `[MediaPipe] ${CAMERA_WIDTH}×${CAMERA_HEIGHT} fehlgeschlagen ` +
            `(${camErr?.name ?? camErr}) → zweiter Versuch ${CAMERA_WIDTH}×${CAMERA_HEIGHT}`,
          );
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width:     { ideal: CAMERA_WIDTH },
              height:    { ideal: CAMERA_HEIGHT },
              frameRate: { ideal: 30 },
              facingMode: 'user',
            },
            audio: false,
          });
        }
        video.srcObject = mediaStream;
        await video.play();
        console.info('[MediaPipe] Kamera gestartet:', video.videoWidth, '×', video.videoHeight);
        // Problem 4 (FF1-Timing): Meilenstein "Kamera+Erkennung bereit"
        onCameraRef.current?.('timing_camera_ready');

        // ── Problem 1.2: Kamera-Belichtung programmatisch korrigieren ─────
        // Nur wenn die Kamera es unterstützt (getCapabilities). ACHTUNG:
        // wirkt auf die Kamera-HARDWARE, also physikbedingt auch auf das
        // WebRTC-Bild — ein korrekt belichtetes Gesicht ist dort aber
        // ebenfalls die Verbesserung. exposureMode 'manual' wird bewusst
        // NICHT gesetzt (bei Lichtwechsel riskant); nur exposureCompensation.
        if (CAMERA_EXPOSURE_TUNE) {
          try {
            const track = mediaStream.getVideoTracks()[0];
            const caps  = track?.getCapabilities?.() ?? {};
            console.info('[MediaPipe] Kamera-Capabilities (Belichtung):', JSON.stringify({
              exposureMode:         caps.exposureMode ?? 'nicht unterstützt',
              exposureCompensation: caps.exposureCompensation ?? 'nicht unterstützt',
              brightness:           caps.brightness ?? 'nicht unterstützt',
              contrast:             caps.contrast ?? 'nicht unterstützt',
            }));
            const ec = caps.exposureCompensation;
            if (ec && typeof ec.max === 'number' && typeof ec.min === 'number' && ec.max > ec.min) {
              const target = ec.min + (ec.max - ec.min) * EXPOSURE_COMP_FRACTION;
              await track.applyConstraints({ advanced: [{ exposureCompensation: target }] });
              console.info(`[MediaPipe] exposureCompensation gesetzt: ${target.toFixed(2)} `
                + `(Range ${ec.min}..${ec.max}) — Gegenlicht-Korrektur`);
            } else {
              console.info('[MediaPipe] exposureCompensation nicht verfügbar — '
                + 'Software-Aufbereitung (ENHANCE) übernimmt allein');
            }
          } catch (err) {
            console.warn('[MediaPipe] Kamera-Tuning fehlgeschlagen (ignoriert):', err?.message ?? err);
          }
        }

        // ── TEIL B4: Kamera-Selbstheilung ─────────────────────────────────
        // Stirbt der Kamera-Track (Gerät kurz weg, Treiber-Aussetzer), wird
        // alle 5 s unbegrenzt neu angefordert — das Display muss stundenlang
        // ohne Betreuung laufen. camera_lost/camera_recovered gehen über
        // onCameraEvent → client_event ins Studien-CSV.
        const scheduleCameraRecovery = () => {
          if (cameraRecoveryTimer) return;
          cameraRecoveryTimer = setInterval(async () => {
            if (!isRunning) { clearInterval(cameraRecoveryTimer); return; }
            try {
              const fresh = await navigator.mediaDevices.getUserMedia({
                video: {
                  width:     { ideal: CAMERA_WIDTH },
                  height:    { ideal: CAMERA_HEIGHT },
                  frameRate: { ideal: 30 },
                  facingMode: 'user',
                },
                audio: false,
              });
              mediaStream?.getTracks().forEach((t) => t.stop());
              mediaStream = fresh;
              video.srcObject = fresh;
              await video.play();
              attachCameraWatch(fresh);
              clearInterval(cameraRecoveryTimer);
              cameraRecoveryTimer = null;
              console.info('[MediaPipe] Kamera wiederhergestellt');
              onCameraRef.current?.('camera_recovered');
            } catch (err) {
              console.warn(
                '[MediaPipe] Kamera-Wiederherstellung fehlgeschlagen – nächster Versuch in 5 s:',
                err?.name ?? err,
              );
            }
          }, 5_000);
        };
        const attachCameraWatch = (stream) => {
          const track = stream.getVideoTracks()[0];
          if (!track) return;
          track.onended = () => {
            if (!isRunning) return;
            console.warn('[MediaPipe] Kamera-Track beendet – starte Selbstheilung');
            onCameraRef.current?.('camera_lost');
            scheduleCameraRecovery();
          };
        };
        attachCameraWatch(mediaStream);

        if (import.meta.env.DEV) {
          debugRef.current.cameraReady = true;
          debugRef.current.videoW      = video.videoWidth;
          debugRef.current.videoH      = video.videoHeight;
          setDebugInfo({ ...debugRef.current });
        }

        // 3b. Detection-Canvas (einmalig, pro Frame wiederverwendet)
        const zoomCanvas = document.createElement('canvas');
        zoomCanvas.width  = DETECTION_CANVAS_WIDTH;
        zoomCanvas.height = DETECTION_CANVAS_HEIGHT;
        zoomCanvasRef.current = zoomCanvas;
        // Hinweis (Messung 2026-08-20): Dieses Canvas wird nur noch im
        // ?detect=canvas-Notnagel genutzt. Beide willReadFrequently-
        // Varianten sind hardwareabhängig problematisch (NUC/Arc: false →
        // 214 ms Readback-Stall; Laptop: true → 144 ms, tasks-vision
        // uploadt den CPU-Canvas offenbar intern erneut zur GPU). false
        // ist der am wenigsten schlechte Kompromiss — der eigentliche Fix
        // ist der DIREKT-Pfad ohne Canvas (DETECT_INPUT_MODE 'direct').
        zoomCtxRef.current    = zoomCanvas.getContext('2d', { willReadFrequently: false });

        // 3c. Debug-HUD — unten links, halbtransparent. Wird IMMER erzeugt
        // (Start-Sichtbarkeit gemäß SHOW_DEBUG_HUD), Taste "d" toggelt.
        {
          const hud = document.createElement('div');
          hud.id = 'pd-hud';   // feste ID für Diagnose/Tests
          // Problem 2 (Labortest): mehrzeilig, große Schrift (aus ~2 m an
          // der Wand lesbar), dunkler halbtransparenter Grund, links UND
          // rechts verankert → läuft nie über den Bildschirmrand hinaus
          hud.style.cssText =
            'position:fixed;left:8px;right:8px;bottom:30px;z-index:99999;' +
            'padding:10px 14px;background:rgba(0,0,0,0.78);color:#e2e8f0;' +
            'font:17px/1.55 "Courier New",monospace;border-radius:8px;' +
            'pointer-events:none;user-select:none;overflow-wrap:break-word;' +
            'box-sizing:border-box;max-width:calc(100vw - 16px);';
          hud.textContent = 'Präsenz-HUD startet … (Taste "d" blendet aus)';
          hud.style.display = hudVisibleRef.current ? 'block' : 'none';
          document.body.appendChild(hud);
          hudElRef.current = hud;
        }

        // 3d. Zoom-Preview mit Gesichtsrahmen — unten rechts. Wird IMMER
        // erzeugt (Start-Sichtbarkeit gemäß SHOW_ZOOM_PREVIEW, siehe oben).
        {
          const preview = document.createElement('canvas');
          preview.id = 'pd-preview';   // feste ID für Diagnose/Tests
          preview.width  = 220;
          preview.height = Math.round(220 * (DETECTION_CANVAS_HEIGHT / DETECTION_CANVAS_WIDTH));
          preview.style.cssText =
            'position:fixed;right:8px;bottom:30px;width:220px;height:auto;' +
            'z-index:99999;border:2px solid #0f0;background:#000;pointer-events:none;';
          preview.style.display = hudVisibleRef.current ? 'block' : 'none';
          document.body.appendChild(preview);
          previewElRef.current  = preview;
          previewCtxRef.current = preview.getContext('2d');
        }

        // 4. Frame-Schleife
        const processFrame = () => {
          if (!isRunning) return;

          try {
            const now = performance.now();

            // ── fps-Zähler (Problem 3.7, fürs HUD): misst die Render-Loop ─
            const fc = fpsCounterRef.current;
            fc.frames++;
            if (now - fc.since >= 1_000) {
              fc.fps = Math.round((fc.frames * 1000) / (now - fc.since));
              fc.frames = 0;
              fc.since = now;

              // fps-Not-Aus für die Bildaufbereitung (Fix 2026-08-20):
              // Bricht die Renderrate ein, während der ctx.filter aktiv
              // ist, war er sehr wahrscheinlich der Auslöser (CPU-Pfad).
              if (!enhanceKilledRef.current && fc.fps < 20
                  && enhanceBrightRef.current > 1.02) {
                enhanceKilledRef.current   = true;
                enhanceBrightRef.current   = 1;
                enhanceContrastRef.current = 1;
                console.warn(
                  `[MediaPipe] fps=${fc.fps} bei aktivem Enhance-Filter → `
                  + 'Bildaufbereitung DAUERHAFT deaktiviert (Not-Aus). '
                  + 'Kamera-Belichtungskorrektur bleibt aktiv.',
                );
              }
            }

            // ── Bewegung: hält (und startet) Präsenz — jetzt auch in
            //    HANDSHAKE/ACTIVE, aber NUR innerhalb von MOTION_ANCHOR_MS
            //    nach dem letzten ECHTEN Gesichts-/Pose-Treffer (Zeitanker,
            //    2026-08-31 — löst zwei beobachtete Fehler mit gemeinsamer
            //    Ursache: (a) leerer Raum galt durch Bewegung ohne
            //    zeitliche Obergrenze dauerhaft als besetzt; (b) im Call
            //    fiel die Präsenz bei kurzem Gesichtsverlust — Person zu
            //    nah, abgeschnitten, Kopf gedreht — sofort in die Karenz,
            //    obwohl beide vor den Displays standen). Ohne einen echten
            //    Treffer in den letzten MOTION_ANCHOR_MS greift wieder die
            //    unveränderte PRESENCE_HOLD_MS_IDLE-/ACTIVE_NO_FACE_TIMEOUT_MS-
            //    Karenz ungebremst — Bewegung kann einen leeren Raum also
            //    weiterhin nicht dauerhaft besetzt halten.
            if (detectMotion(video)) {
              lastMotionAt.current = now;
              // Distanz-Gate (2026-08-21, Problem 4): Bewegungserkennung
              // hat KEINE Distanzinformation (Diff über das ganze Bild) —
              // sie darf eine bereits NAHE Person halten (perceivedRef),
              // aber niemals selbst eine ferne Person "wahrnehmbar" machen.
              if (MOTION_KEEPS_PRESENCE && perceivedRef.current
                  && (performance.now() - lastRealHitRef.current) < MOTION_ANCHOR_MS) {
                registerPresence(now, 'Bewegung');
              }
            }

            // ── Detektions-Drossel (Problem 3): detectForVideo blockiert
            //    den Main-Thread — ~15×/s reichen der Verweil-Logik völlig
            //    (relative Quote + Δt-Wachstum sind ratenunabhängig), und
            //    das Rendering (Partikelfeld) läuft dazwischen flüssig.
            // CPU-Notfallstufen (s. DETECTION_LEVELS): Auflösung + Takt
            // werden automatisch an die gemessene Detektionsdauer angepasst.
            // Die Verweil-Logik ist ratenunabhängig (Quote + Δt).
            const level = DETECTION_LEVELS[detectLevelRef.current];
            const effectiveInterval = level.interval;
            const detectionDue = now - lastDetectRunRef.current >= effectiveInterval;

            // ── Kamera-Diagnose (Problem 1.1, alle 5 s): kommen Frames an? ──
            // currentTime muss zwischen zwei Logs STEIGEN — sonst liefert
            // die Kamera keine neuen Bilder (z. B. von anderer App belegt).
            {
              const vd = videoDiagRef.current;
              if (now - vd.lastLog > 5_000) {
                const advancing = video.currentTime > vd.lastTime;
                console.info(
                  `[Kamera-Diag] ${video.videoWidth}×${video.videoHeight}` +
                  ` readyState=${video.readyState}` +
                  ` currentTime=${video.currentTime.toFixed(2)}s` +
                  ` (${vd.lastTime < 0 ? 'erster Messpunkt' : advancing ? 'Frames laufen' : 'STEHT!'})` +
                  ` | Eingabe-Luma ø${Math.round(lumaStatsRef.current.mean)}`,
                );
                if (vd.lastTime >= 0 && !advancing) {
                  console.error('[Kamera-Diag] KEINE neuen Frames! Belegt eine andere App die Kamera (Windows-Kamera-App schließen)? Erkennung arbeitet sonst auf einem Standbild.');
                }
                vd.lastTime = video.currentTime;
                vd.lastLog = now;
              }
            }

            if (detectionDue
                && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                && video.videoWidth > 0) {
              // realer Detektions-Abstand für die Δt-normierten Lerps
              detectDtRef.current = lastDetectRunRef.current > 0
                ? now - lastDetectRunRef.current
                : effectiveInterval;
              lastDetectRunRef.current = now;
              const detectT0 = performance.now();

              // ── Eingang vorbereiten — getrennt gemessen (Prep vs Infer,
              //    Readback-Diagnose): 'direct' = Video ohne Canvas ────────
              let fallbackScan = false;
              let detectionInput = null;
              if (DETECT_INPUT_MODE === 'direct') {
                // Identitäts-Geometrie, damit die Landmark-Rückrechnung
                // (faceWidthOrig, cropTarget, faceX) unverändert stimmt
                frameCropRef.current = {
                  zoom: 1, sx: 0, sy: 0,
                  sw: video.videoWidth, sh: video.videoHeight,
                  vw: video.videoWidth, vh: video.videoHeight,
                };
                detectionInput = video;
              } else {
                // ── Fallback-Scan (Aufgabe 1.3): lange kein Gesicht →
                //    dieser Frame wird OHNE Zoom (Vollbild) geprüft ────────
                fallbackScan =
                  now - lastFaceSeenAt.current > FALLBACK_SCAN_AFTER_MS &&
                  now - lastFallbackScanAt.current > FALLBACK_SCAN_INTERVAL_MS;
                if (fallbackScan) lastFallbackScanAt.current = now;

                detectionInput = drawDetectionFrame(video, fallbackScan);
              }
              const prepDur = performance.now() - detectT0;
              prepCostRef.current = prepCostRef.current * 0.8 + prepDur * 0.2;
              const inferT0 = performance.now();

              if (detectionInput) {
                // Eingabemaße (Video direkt ODER Canvas) — der FaceDetector
                // liefert Boxen in PIXELN, die Normierung braucht die Maße
                const inputW = detectionInput.videoWidth ?? detectionInput.width ?? 0;
                const inputH = detectionInput.videoHeight ?? detectionInput.height ?? 0;

                // ── EXKLUSIV (Problem 4.2): Face und Pose laufen NIE im
                //    selben Frame. Ist ein Pose-Fallback fällig (>0,5 s
                //    kein Gesicht), ersetzt er in diesem Frame die
                //    Gesichtssuche — dazwischen sucht weiter das Gesicht.
                // Idle-Drosselung (2026-08-26): NUR in leerem AMBIENT (keine
                // aktive Präsenz jeglicher Quelle seit POSE_FALLBACK_AFTER_MS)
                // greift das langsamere Intervall — in DETECTING/HANDSHAKE/
                // ACTIVE oder bei aktiver Präsenz bleibt level.poseInterval
                // exakt wie bisher (Küchen-Fix, s. Kommentar bei DETECTOR).
                const isIdleAmbient =
                  appStateRef.current === 'AMBIENT'
                  && now - lastPresenceAt.current > POSE_FALLBACK_AFTER_MS;
                const poseMinInterval = isIdleAmbient
                  ? POSE_MIN_INTERVAL_IDLE_MS
                  : level.poseInterval;
                const poseDue =
                  poseLandmarkerRef.current !== null &&
                  (DETECTOR === 'pose'
                    || now - lastFaceSeenAt.current > POSE_FALLBACK_AFTER_MS) &&
                  now - lastPoseRunAt.current > poseMinInterval;

                let faceFound = false;
                let poseFoundThisFrame = false;

                if (!poseDue && faceDetectorRef.current) {
                  // ── Gesichtserkennung (synchron, getrennt gemessen) ─────
                  const t0 = performance.now();
                  const results = faceDetectorRef.current.detectForVideo(
                    detectionInput,
                    performance.now(),
                  );
                  faceStatsRef.current.push({ t: now, ms: performance.now() - t0 });
                  faceFound = handleFaceResults(results, now, fallbackScan, inputW, inputH);
                } else if (poseDue) {
                  // ── Pose-Fallback (ersetzt diesen Face-Frame) ───────────
                  lastPoseRunAt.current = now;
                  const t0 = performance.now();
                  const poseResults = poseLandmarkerRef.current.detectForVideo(
                    detectionInput,
                    performance.now(),
                  );
                  poseStatsRef.current.push({ t: now, ms: performance.now() - t0 });
                  if (poseResults.landmarks?.length > 0) {
                    // Pose liefert keine Gesichtsbreite → kann Distanz nicht
                    // selbst beurteilen (Problem 5). poseFoundThisFrame bleibt
                    // IMMER true (trägt Dwell fort — das ist über
                    // dwellProgressRef>0 bereits an eine vorherige NAHE
                    // Gesichtserkennung gebunden, s.u.); Präsenz/Zeitstempel
                    // aber NUR, wenn gerade eine nahe Person etabliert ist
                    // (perceivedRef) — Pose kann eine ferne Person sonst
                    // genauso am Leben halten wie ein Gesichts-Phantom.
                    poseFoundThisFrame    = true;
                    lastPoseHitAt.current = now;
                    if (perceivedRef.current) {
                      lastFaceSeenAt.current = now;
                      hitTimestampsRef.current.push(now);
                      // Zeitanker (2026-08-31): Pose hat keine eigene Identitäts-
                      // information — ein statisches Objekt im Raum kann als
                      // Körper erkannt werden und Präsenz sonst unbegrenzt
                      // tragen. Pose stützt Präsenz daher nur, solange ein
                      // ECHTES Gesicht nicht länger als POSE_ANCHOR_MS her ist;
                      // sonst wird der Treffer ignoriert (auch lastRealHitRef
                      // bleibt unangetastet).
                      if ((performance.now() - lastFaceHitRef.current) < POSE_ANCHOR_MS) {
                        registerPresence(now, 'Pose');
                        lastRealHitRef.current = now; // Zeitanker (2026-08-31), s. MOTION_ANCHOR_MS
                      }
                    }
                  }
                }

                // 30-s-Fenster der Statistiken beschneiden (Problem 4.1)
                const fs = faceStatsRef.current;
                while (fs.length > 0 && now - fs[0].t > 30_000) fs.shift();
                const ps = poseStatsRef.current;
                while (ps.length > 0 && now - ps[0].t > 30_000) ps.shift();

                // ── TEIL A: Verweildauer — gewichtete Treffer (Problem 1.4):
                //    nahes Gesicht = 1.0; Pose = 0.5, aber NUR als
                //    Fortsetzung bereits begonnenen Gesichts-Fortschritts
                //    (Pose allein kann keinen Anruf anbahnen — die
                //    Nähe-Bedingung bleibt beim Gesicht verankert).
                let dwellWeight = 0;
                let dwellSource = '—';
                // Statische Box (Möbel-Verdacht) füllt das Verweil-Gate nicht
                if (faceFound && !faceStaticRef.current
                    && lastFaceWidthOrigRef.current >= DWELL_MIN_FACE_RATIO) {
                  dwellWeight = 1;
                  dwellSource = 'FACE';
                } else if (poseFoundThisFrame && dwellProgressRef.current > 0) {
                  dwellWeight = DWELL_POSE_WEIGHT;
                  dwellSource = 'POSE';
                }
                dwellSourceRef.current = dwellSource;
                updateDwell(now, dwellWeight);

                // ── Detektionskosten messen (EMA) → HUD "Detekt: Xms".
                //    Vor Ort DER Diagnosewert: ~10-20 ms = GPU-Delegate ok,
                //    50 ms+ = CPU-Fallback oder Filter-Problem. ────────────
                const inferDur = performance.now() - inferT0;
                inferCostRef.current = inferCostRef.current * 0.8 + inferDur * 0.2;
                const detectDur = performance.now() - detectT0;   // Prep + Infer (Face ODER Pose)
                // Stufenschaltungs-EMA (2026-08-26, Stufenfix): NUR Face-Läufe
                // fließen ein. Der PoseLandmarker (~130 ms/Lauf) hat mit
                // poseInterval + der Idle-Drossel (2026-08-25) eine EIGENE
                // Frequenzsteuerung — würde ein Pose-Frame hier mitgemessen,
                // hebt er die EMA dauerhaft über DETECT_COST_DOWN_MS (18 ms),
                // die Schwellen 45/18 sind aus der Zeit VOR Pose (Face
                // allein: 10-20 ms GPU) kalibriert und dafür nicht gedacht —
                // das System bliebe nach dem ersten Pose-Lauf für immer auf
                // Stufe ≥1 hängen (echte Gesichter mit Score 0.4-0.6 werden
                // dann durch die zu grobe Auflösung verworfen).
                if (!poseDue) {
                  detectCostRef.current = detectCostRef.current * 0.8 + detectDur * 0.2;
                }

                // Stufenschaltung mit Hysterese (frühestens alle 3 s):
                // zu teuer → gröber (kleinere Auflösung, seltener);
                // deutlich schnell → wieder feiner. Auflösung wird direkt
                // am Detection-Canvas umgestellt (alle Folge-Rechnungen
                // sind normiert und auflösungsunabhängig).
                if (now - detectLevelSinceRef.current > 3_000) {
                  const cur = detectLevelRef.current;
                  let next = cur;
                  if (detectCostRef.current > DETECT_COST_UP_MS
                      && cur < DETECTION_LEVELS.length - 1) next = cur + 1;
                  else if (detectCostRef.current < DETECT_COST_DOWN_MS && cur > 0) next = cur - 1;
                  if (next !== cur) {
                    detectLevelRef.current = next;
                    detectLevelSinceRef.current = now;
                    const nl = DETECTION_LEVELS[next];
                    const zc = zoomCanvasRef.current;
                    // Canvas-Resize nur im canvas-Modus relevant; im
                    // direct-Modus wirken nur die Intervall-Stufen.
                    // WICHTIG: Resize setzt den 2D-Kontext zurück — den
                    // gemerkten Filter-String mit invalidieren!
                    if (zc && DETECT_INPUT_MODE === 'canvas') {
                      zc.width = nl.w; zc.height = nl.h;
                      lastFilterStrRef.current = '';
                    }
                    detectCostRef.current = (DETECT_COST_UP_MS + DETECT_COST_DOWN_MS) / 2;
                    console.warn(
                      `[MediaPipe] Detektionsstufe ${cur} → ${next}: ${nl.w}×${nl.h}, `
                      + `alle ${nl.interval} ms (Delegate: ${delegateRef.current}, `
                      + `Kosten waren Ø ${Math.round(detectDur)} ms)`,
                    );
                  }
                }

                // ── Sicherheitsnetz gegen Festfressen (2026-08-26,
                //    Stufenfix): bleibt die Stufenschaltung trotz Fix über
                //    60 s auf einer groben Stufe stehen (z. B. ein alter
                //    EMA-Ausreißer), wird — NUR wenn gerade niemand da ist
                //    (AMBIENT ohne Präsenz, also risikolos) — probeweise
                //    eine Stufe feiner geschaltet. Der normale Mechanismus
                //    (EMA gegen 45/18 ms) übernimmt danach sofort wieder;
                //    dieser Block korrigiert nur ein falsches Feststecken,
                //    er ersetzt die Hysterese nicht.
                if (detectLevelRef.current > 0
                    && now - detectLevelSinceRef.current > 60_000
                    && appStateRef.current === 'AMBIENT'
                    && !perceivedRef.current) {
                  const stuckCur = detectLevelRef.current;
                  const stuckNext = stuckCur - 1;
                  detectLevelRef.current = stuckNext;
                  detectLevelSinceRef.current = now;
                  detectCostRef.current = (DETECT_COST_UP_MS + DETECT_COST_DOWN_MS) / 2;
                  const stuckNl = DETECTION_LEVELS[stuckNext];
                  const stuckZc = zoomCanvasRef.current;
                  if (stuckZc && DETECT_INPUT_MODE === 'canvas') {
                    stuckZc.width = stuckNl.w; stuckZc.height = stuckNl.h;
                    lastFilterStrRef.current = '';
                  }
                  console.warn(
                    `[MediaPipe] Sicherheitsnetz: Stufe ${stuckCur} → ${stuckNext} `
                    + `nach 60s ohne Wechsel (AMBIENT ohne Präsenz), ${stuckNl.w}×${stuckNl.h}`,
                  );
                }
              }
            }

            // ── Kernlogik: Handshake-Fenster prüfen, Verlust prüfen ───────
            const hitsInWindow = checkHandshake(now);
            checkPresenceLoss(now);

            // ── Debug-Ausgaben ────────────────────────────────────────────
            drawPreview();
            updateHud(now, hitsInWindow);

            if (now - lastStatusLogRef.current >= STATUS_LOG_INTERVAL_MS) {
              lastStatusLogRef.current = now;
              const sinceFace = lastFaceSeenAt.current > 0
                ? Math.round(now - lastFaceSeenAt.current)
                : -1;
              console.info(
                `[Präsenz] Status: anwesend=${isPresentRef.current ? 'JA' : 'NEIN'}` +
                ` | Treffer(${HANDSHAKE_WINDOW_MS}ms)=${hitsInWindow}/${HANDSHAKE_MIN_HITS}` +
                ` | letzterTreffer=${sinceFace < 0 ? '—' : sinceFace + 'ms'}` +
                ` | zoom=${zoomRef.current.toFixed(2)}` +
                ` | faceWidthOrig=${lastFaceWidthOrigRef.current.toFixed(3)}` +
                ` | state=${appStateRef.current}`,
              );
            }
          } catch (err) {
            // Ein einzelner Frame-Fehler darf die Pipeline nicht töten
            console.warn('[MediaPipe] Frame-Fehler (ignoriert):', err?.message ?? err);
          }

          animFrameRef.current = requestAnimationFrame(processFrame);
        };

        animFrameRef.current = requestAnimationFrame(processFrame);

      } catch (err) {
        console.error('[MediaPipe] Initialisierungsfehler:', err);
        if (import.meta.env.DEV) {
          debugRef.current.cameraReady = false;
          setDebugInfo({ ...debugRef.current });
        }
      }
    };

    init();

    // Aufräumen beim Unmounten / wenn enabled wechselt
    return () => {
      isRunning = false;
      cancelAnimationFrame(animFrameRef.current);
      clearInterval(cameraRecoveryTimer);   // Teil B4
      window.removeEventListener('keydown', onKeyDown);

      // Präsenz-Zustand zurücksetzen
      isPresentRef.current        = false;
      lastFaceSeenAt.current      = 0;
      lastPresenceAt.current      = 0;
      lastMotionAt.current        = 0;
      lastPoseHitAt.current       = 0;
      hitTimestampsRef.current    = [];
      lastHandshakeFireAt.current = 0;
      lastFaceCount.current       = 0;
      lastMotionFrame.current     = null;
      lastFaceBoxRef.current      = null;
      proximitySmoothedRef.current = 0;
      proximityLastEmitRef.current = 0;
      faceXSmoothedRef.current     = 0;
      dwellFramesRef.current       = [];
      dwellLastFrameRef.current    = 0;
      dwellProgressRef.current     = 0;
      dwellLastEmitRef.current     = 0;
      onProximityRef.current?.(0);
      onFaceXRef.current?.(0);
      onDwellRef.current?.(0);

      // Zoom zurücksetzen
      zoomRef.current       = ZOOM_IDLE;
      cropCenterRef.current = { x: 0.5, y: 0.5 };

      // Landmarker schließen (gibt WASM-Speicher frei)
      faceDetectorRef.current?.close();
      faceDetectorRef.current = null;
      poseLandmarkerRef.current?.close();
      poseLandmarkerRef.current = null;

      // Kamerastream stoppen (Kamera-LED aus)
      mediaStream?.getTracks().forEach((t) => t.stop());
      if (video.parentNode) video.parentNode.removeChild(video);

      // Canvas + HUD + Preview aufräumen
      zoomCanvasRef.current = null;
      zoomCtxRef.current    = null;
      if (hudElRef.current?.parentNode) hudElRef.current.parentNode.removeChild(hudElRef.current);
      hudElRef.current = null;
      if (previewElRef.current?.parentNode) {
        previewElRef.current.parentNode.removeChild(previewElRef.current);
      }
      previewElRef.current  = null;
      previewCtxRef.current = null;
    };
  }, [
    enabled, detectMotion, drawDetectionFrame, handleFaceResults, updateDwell,
    registerPresence, checkHandshake, checkPresenceLoss, drawPreview, updateHud,
  ]);

  /**
   * Verweildauer von außen zurücksetzen (Handshake-Abbruch in App.jsx):
   * Die Person muss danach erneut DWELL_REQUIRED_MS verweilen, bevor der
   * nächste Handshake-Versuch startet — der Aux-Ring leert sich sichtbar,
   * statt irreführend voll stehen zu bleiben.
   */
  const resetDwell = useCallback(() => {
    dwellFramesRef.current   = [];
    dwellLastFrameRef.current = 0;
    dwellProgressRef.current = 0;
    dwellLastEmitRef.current = 0;
    onDwellRef.current?.(0);
  }, []);

  return { videoRef, isActive: enabled, debugInfo, resetDwell };
}

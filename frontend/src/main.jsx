/**
 * main.jsx
 *
 * @fileoverview Einstiegspunkt der React-Anwendung — montiert App.jsx in
 * den DOM-Wurzelknoten. Bewusst OHNE React.StrictMode (Begründung direkt
 * unten): die im Dev-Modus doppelt ausgeführten Effects würden bei echten
 * WebSocket-/WebRTC-Verbindungen zu Reconnect-Problemen führen.
 */

import ReactDOM from 'react-dom/client';
import App from './App.jsx';

// KEIN React.StrictMode: Diese App hält zustandsbehaftete Hardware-
// Ressourcen (WebSocket-Signaling, WebRTC-PeerConnection, Kamerastream).
// StrictMode führt Effects im Dev-Modus absichtlich doppelt aus
// (mount → cleanup → erneut mount), um unreine Render-Effekte aufzudecken.
// Bei echten Verbindungen erzeugt das aber eine "Phantom"-WebSocket-
// Verbindung, die noch im CONNECTING-Zustand geschlossen wird, gefolgt von
// einer zweiten echten Verbindung — das führte zu Reconnect-Loops und
// dazu, dass der Server kurzzeitig zwei Clients gleichzeitig sah und
// Rollen (Caller/Callee) falsch zuwies.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);

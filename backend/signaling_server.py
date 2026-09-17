"""
signaling_server.py

Signaling-Server für das Public-Display-System: vermittelt den WebRTC-
Verbindungsaufbau zwischen den beiden Haupt-Displays (Offer, Answer,
ICE-Kandidaten) über WebSocket und entscheidet zentral, wann ein Anruf
beginnt und endet (siehe ConnectionManager.evaluate_call_state). Die
React-Frontends (App.jsx) verbinden sich auf /ws und melden nur ihren
eigenen Präsenz-Status — der Server kennt als einzige Instanz beide
Seiten gleichzeitig und weist die Rollen caller/callee zu, statt die
Clients selbst raten zu lassen.

Endpunkte: WS /ws (Signaling), GET /status, GET /health.
Start: python signaling_server.py — SSL-Zertifikate unter
certs/key.pem und certs/cert.pem werden automatisch erkannt (WSS/HTTPS
statt WS/HTTP).
"""

import asyncio
import csv
import json
import logging
import os
import sys
import time
from datetime import datetime
from typing import Dict, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketState

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass  # python-dotenv not installed; SESSION_ID/PORT can still be set as system env vars

# ---------------------------------------------------------------------------
# Logging-Konfiguration
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("signaling")

# ---------------------------------------------------------------------------
# Studien-Logging: CSV-Ereignisprotokoll für die Auswertung in der Thesis
# ---------------------------------------------------------------------------
# Session-ID pro Teilnehmerpaar: entweder Umgebungsvariable SESSION_ID
# (z.B.  set SESSION_ID=Paar03  vor dem Start) ODER erstes Kommandozeilen-
# Argument (python signaling_server.py Paar03). Fallback: "default".
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_ID = (
    os.getenv("SESSION_ID")
    or (sys.argv[1] if len(sys.argv) > 1 else None)
    or "default"
)
SESSION_LOG_PATH = os.path.join(_BASE_DIR, "logs", "session_log.csv")
_SESSION_LOG_HEADER = ["timestamp_iso", "session_id", "event", "peer_id", "extra"]


def log_session_event(event: str, peer_id: str = "", extra: str = "") -> None:
    """
    Schreibt EINE Ereigniszeile ins Session-CSV (Ordner/Datei werden bei
    Bedarf angelegt). Ereignisse: connect, disconnect, presence_ready_true/
    false, start_call, call_connected, end_call, call_stats, error.

    ROBUST: Ein Schreibfehler (Datei gesperrt, Platte voll, …) darf den
    Signaling-Server unter keinen Umständen abstürzen lassen — nur Warnung.
    """
    try:
        os.makedirs(os.path.dirname(SESSION_LOG_PATH), exist_ok=True)
        is_new = not os.path.exists(SESSION_LOG_PATH)
        with open(SESSION_LOG_PATH, "a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            if is_new:
                writer.writerow(_SESSION_LOG_HEADER)
            writer.writerow([
                datetime.now().isoformat(timespec="milliseconds"),
                SESSION_ID, event, peer_id, extra,
            ])
    except Exception as exc:
        logger.warning("Session-Log-Schreibfehler (ignoriert): %s", exc)


logger.info("Studien-Logging aktiv: SESSION_ID=%s → %s", SESSION_ID, SESSION_LOG_PATH)

# ---------------------------------------------------------------------------
# FastAPI-Anwendung
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Public Display Signaling Server",
    description="WebRTC-Signaling für BA Wael Hammami – Public Display System",
    version="1.0.0",
)

# CORS erlauben (LAN-Umgebung, alle Origins zulässig)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Zeitpunkt des Serverstarts für Uptime-Berechnung
_SERVER_START = time.time()

# ---------------------------------------------------------------------------
# Verbindungsverwaltung
# ---------------------------------------------------------------------------

class ConnectionManager:
    """
    Verwaltet alle aktiven WebSocket-Verbindungen und ist die alleinige
    Quelle der Wahrheit dafür, OB und WANN ein WebRTC-Anruf stattfindet
    ("server-driven call state"): jeder Client meldet dem Server nur
    seinen eigenen ready-Status (siehe set_ready()), der Server
    entscheidet zentral und einmalig, wann ein Anruf beginnt
    (evaluate_call_state()) und teilt beiden Clients per start_call
    explizit ihre Rolle mit — die Clients raten nichts selbst. Das
    vermeidet den Wettlauf, der entstünde, wenn beide Seiten anhand der
    jeweils gegenseitig gemeldeten Präsenz selbst über den Verbindungs-
    aufbau entscheiden.

    Nur Verbindungen mit role=="main" zählen für die Anrufsteuerung
    (evaluate_call_state() verlangt genau 2 verbundene main-Peers) —
    role kommt vom Client als ?role=-Query-Parameter der WebSocket-URL;
    ein Fenster ohne diesen Parameter zählt bewusst nicht mit. Verbindet
    sich ein neuer main-Client von derselben IP wie ein bereits
    verbundener main-Client (Reload/Reconnect/vergessenes Fenster),
    verdrängt er den alten automatisch (siehe connect()/_evict()),
    statt zusätzlich gezählt zu werden.

    Attribute:
        connections (Dict[str, WebSocket]): Aktive Verbindungen, indiziert nach Client-ID.
        ready       (Dict[str, bool]):      Lokaler Präsenz-Status pro Client.
        last_beat   (Dict[str, float]):     Zeitstempel des letzten Heartbeats.
        counter     (int):                  Fortlaufende Verbindungsnummer.
        roles       (Dict[str, str]):       Vom Client gemeldete Rolle ("main"/"aux"/…).
        ips         (Dict[str, str]):       Herkunfts-IP der Verbindung.
        call_active (bool):                 Läuft aktuell ein vom Server gestarteter Anruf?
        call_roles  (Dict[str, str]):       Für die Dauer des aktiven Anrufs fixe Rollen.
    """

    def __init__(self) -> None:
        """Initialisiert den Manager mit leeren Datenstrukturen."""
        self.connections: Dict[str, WebSocket] = {}
        self.ready: Dict[str, bool] = {}
        self.last_beat: Dict[str, float] = {}
        self.counter: int = 0

        # Rolle + IP pro Verbindung — role kommt vom Client als ?role=-
        # Query-Parameter der WebSocket-URL (main/aux/unknown); nur
        # role=="main" zählt für die Anrufsteuerung (siehe Klassen-Docstring).
        self.roles: Dict[str, str] = {}
        self.ips: Dict[str, str] = {}

        self.call_active: bool = False
        self.call_roles: Dict[str, str] = {}

    # ------------------------------------------------------------------
    # Verbindungsaufbau
    # ------------------------------------------------------------------

    async def connect(self, websocket: WebSocket, role: str) -> str:
        """
        Akzeptiert eine neue WebSocket-Verbindung. Der neue Client startet
        immer mit ready=False — er muss seinen tatsächlichen Präsenz-Status
        selbst per "presence"-Nachricht melden (das Frontend sendet sie
        sofort nach dem Connect erneut).

        Args:
            websocket: Die eingehende Verbindung.
            role:      Vom Client gemeldete Rolle ("main", "aux", oder
                       "unknown" falls kein ?role= mitgeschickt wurde).

        Returns:
            Die eindeutige Client-ID.
        """
        await websocket.accept()
        self.counter += 1
        client_id = f"peer_{self.counter}_{int(time.time())}"
        ip = websocket.client.host if websocket.client else "unknown"

        # Dedup: Ein zweiter main-Client von derselben IP verdrängt den
        # alten, statt zusätzlich gezählt zu werden — deckt Reload/
        # Reconnect/vergessene Fenster ab, ohne dass der Bediener manuell
        # eingreifen muss. Nur unter main-Clients relevant (mehrere
        # aux-artige Verbindungen derselben IP sind für die Anrufsteuerung
        # ohnehin irrelevant).
        if role == "main":
            stale_ids = [
                cid for cid, cip in self.ips.items()
                if cip == ip and self.roles.get(cid) == "main"
            ]
            for old_id in stale_ids:
                logger.warning(
                    "Verdrängt: %s (main, IP %s) durch neue Verbindung derselben IP",
                    old_id, ip,
                )
                await self._evict(old_id, reason="superseded_same_ip")

        self.connections[client_id] = websocket
        self.roles[client_id] = role
        self.ips[client_id] = ip
        self.ready[client_id] = False
        self.last_beat[client_id] = time.time()

        logger.info(
            "Verbunden: %s | Rolle=%s | IP=%s | main-Clients: %d | Gesamt verbunden: %d",
            client_id, role, ip, self._main_count(), len(self.connections),
        )
        log_session_event(
            "connect", client_id,
            f"role={role} ip={ip} total={len(self.connections)}",
        )

        await self._send(client_id, {
            "type":      "welcome",
            "clientId":  client_id,
            "role":      role,
            "timestamp": time.time(),
        })

        # Neuer Client kann die Voraussetzungen für einen Anruf verändert
        # haben (z.B. jetzt sind es 2 statt 1 main-Verbindungen) — neu
        # bewerten (evaluate_call_state ignoriert Nicht-main-Clients selbst).
        await self.evaluate_call_state(reason=f"connect {client_id} ({role})")

        # Ein neu verbundener main-Client bekäme sonst erst bei der nächsten
        # presence-Änderung mit, ob im jeweils anderen Raum schon jemand
        # steht — einmalig den aktuellen ready-Status jedes anderen
        # main-Clients nachreichen.
        if role == "main":
            for other_id in self.connections:
                if other_id == client_id or self.roles.get(other_id) != "main":
                    continue
                present = self.ready.get(other_id, False)
                await self._send(client_id, {
                    "type":      "remote_presence",
                    "present":   present,
                    "timestamp": time.time(),
                })
                logger.info("remote_presence an %s gesendet: present=%s", client_id, present)

        return client_id

    def _main_count(self) -> int:
        """Anzahl aktuell verbundener main-Clients (für Logs/Status)."""
        return sum(1 for cid in self.connections if self.roles.get(cid) == "main")

    def _describe(self, client_ids) -> list:
        """Client-IDs mit IP fürs Log, z.B. 'peer_1_123@129.217.18.121'."""
        return [f"{cid}@{self.ips.get(cid, '?')}" for cid in client_ids]

    async def _evict(self, client_id: str, reason: str) -> None:
        """
        Entfernt einen Client SOFORT und aktiv (im Unterschied zu
        _prune_and_notify, das nur auf bereits TOTE Verbindungen reagiert):
        schickt eine Abschieds-Nachricht, schließt den Socket, räumt die
        Buchhaltung auf. Ruft bewusst NICHT evaluate_call_state() auf — der
        Aufrufer (connect()) tut das ohnehin gleich danach für den
        Gesamtzustand nach dem Verdrängen UND dem Hinzufügen des neuen
        Clients in einem Rutsch.
        """
        ws = self.connections.get(client_id)
        if ws is not None:
            try:
                await ws.send_json({
                    "type": "superseded", "reason": reason, "timestamp": time.time(),
                })
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass
        await self.disconnect(client_id)
        log_session_event("superseded", client_id, reason)

    # ------------------------------------------------------------------
    # Verbindungsabbau
    # ------------------------------------------------------------------

    async def disconnect(self, client_id: str) -> None:
        """
        Entfernt eine Verbindung und alle zugehörigen Metadaten.

        WICHTIG: Ruft NICHT selbst evaluate_call_state() auf (u.a. weil sie
        auch aus _prune_and_notify() heraus aufgerufen wird) — der Aufrufer
        muss das explizit danach tun. Die Methode ist async, das eigentliche
        Aufräumen/Loggen bleibt synchron.

        Args:
            client_id: Die ID der zu entfernenden Verbindung.
        """
        role = self.roles.get(client_id, "?")
        ip = self.ips.get(client_id, "?")

        self.connections.pop(client_id, None)
        self.ready.pop(client_id, None)
        self.last_beat.pop(client_id, None)
        self.roles.pop(client_id, None)
        self.ips.pop(client_id, None)

        logger.info(
            "Getrennt: %s | Rolle=%s | IP=%s | Verbleibend: %d (main: %d)",
            client_id, role, ip, len(self.connections), self._main_count(),
        )
        log_session_event(
            "disconnect", client_id,
            f"role={role} ip={ip} remaining={len(self.connections)}",
        )

        # Verlor ein main-Client die Verbindung, die verbleibenden
        # main-Clients informieren — rein informativ, beeinflusst
        # evaluate_call_state()/roles/ips nicht.
        if role == "main":
            await self._broadcast_remote_presence(False)

    # ------------------------------------------------------------------
    # Präsenz & Call-State (Kernstück der neuen Architektur)
    # ------------------------------------------------------------------

    async def set_ready(self, client_id: str, ready: bool) -> None:
        """
        Setzt den ready-Status eines Clients (lokal stabil erkannte Person,
        entspricht dem Frontend-Zustand HANDSHAKE) und bewertet danach den
        Call-State neu.

        Args:
            client_id: Der meldende Client.
            ready:     True, wenn dieser Client bereit für einen Anruf ist.
        """
        if client_id not in self.connections:
            return

        # presence von Nicht-main-Clients wird ignoriert — sie dürfen die
        # Anrufsteuerung nicht beeinflussen.
        role = self.roles.get(client_id, "unknown")
        if role != "main":
            logger.info(
                "presence von %s (Rolle=%s, IP=%s) IGNORIERT — zählt nicht für die Anrufsteuerung",
                client_id, role, self.ips.get(client_id, "?"),
            )
            return

        self.ready[client_id] = ready
        ready_count = sum(
            1 for cid, v in self.ready.items() if v and self.roles.get(cid) == "main"
        )
        logger.info(
            "presence: %s (IP=%s) ready=%s | ready main-Clients: %d/%d",
            client_id, self.ips.get(client_id, "?"), ready, ready_count, self._main_count(),
        )
        log_session_event(
            "presence_ready_true" if ready else "presence_ready_false",
            client_id, f"ready_clients={ready_count}",
        )
        await self.evaluate_call_state(reason=f"presence {client_id}={ready}")

        # Den anderen main-Clients mitteilen, ob im Raum dieses Clients
        # jemand steht — rein informativ, beeinflusst evaluate_call_state()/
        # roles/ips nicht.
        await self._broadcast_remote_presence(ready, exclude_id=client_id)

    async def evaluate_call_state(self, reason: str = "") -> None:
        """
        Zentrale Entscheidungslogik — einzige Stelle, die einen Anruf
        startet oder beendet:

          • Genau 2 Clients verbunden, BEIDE ready, noch kein Anruf aktiv
            → Rollen deterministisch vergeben (der ZUERST verbundene Client
            ist immer Callee, siehe Docstring der Klasse) und start_call an
            beide senden. Die Rollen bleiben in self.call_roles fix, bis
            der Anruf wieder endet.

          • Ein Anruf läuft, aber eine der Bedingungen (weiterhin exakt 2
            verbunden UND beide ready) ist nicht mehr erfüllt → end_call an
            alle verbleibenden Clients senden.

          • Sonst (kein Anruf aktiv, Bedingungen noch nicht erfüllt) → nur
            informatives Log, WER noch fehlt/nicht ready ist.

        Args:
            reason: Kurzer Text für die Logs, WARUM diese Bewertung ausgelöst wurde
                    (Connect/Disconnect/presence-Änderung) — macht im Log
                    sofort sichtbar, welche Seite fehlt.
        """
        # Nur role=="main" zählt. aux/unbekannte Verbindungen werden
        # registriert (Logging/Status), aber hier komplett ignoriert — sie
        # können weder die 2er-Bedingung verfälschen noch je ein "ready"
        # beisteuern, das der Server erwarten würde.
        client_ids = [
            cid for cid in self.connections.keys()  # Einfügereihenfolge = Beitrittsreihenfolge
            if self.roles.get(cid) == "main"
        ]
        two_connected = len(client_ids) == 2
        ready_ids = [cid for cid in client_ids if self.ready.get(cid, False)]
        not_ready_ids = [cid for cid in client_ids if not self.ready.get(cid, False)]
        both_ready = two_connected and len(ready_ids) == 2

        if not self.call_active and two_connected and both_ready:
            # Deterministisch: der ZUERST verbundene Client (Index 0 in der
            # Einfügereihenfolge) ist Callee, der andere Caller.
            callee_id, caller_id = client_ids[0], client_ids[1]
            self.call_roles = {callee_id: "callee", caller_id: "caller"}
            self.call_active = True

            logger.info(
                "→ start_call gesendet: %s=callee, %s=caller (Grund: %s)",
                callee_id, caller_id, reason,
            )
            log_session_event("start_call", f"{callee_id}|{caller_id}", reason)
            await self._send(callee_id, {
                "type":      "start_call",
                "role":      "callee",
                "peerId":    caller_id,
                "timestamp": time.time(),
            })
            await self._send(caller_id, {
                "type":      "start_call",
                "role":      "caller",
                "peerId":    callee_id,
                "timestamp": time.time(),
            })

        elif self.call_active and not (two_connected and both_ready):
            logger.info(
                "→ end_call gesendet an %d Client(s) (Grund: %s)",
                len(client_ids), reason,
            )
            log_session_event("end_call", "", reason)
            for cid in client_ids:
                await self._send(cid, {
                    "type":      "end_call",
                    "reason":    reason,
                    "timestamp": time.time(),
                })
            self.call_active = False
            self.call_roles = {}

        elif not self.call_active:
            # Kein Anruf aktiv und die Startbedingung ist (noch) nicht
            # erfüllt — zeigt im Log klar, wer (mit IP) fehlt/nicht ready
            # ist. Nicht-main-Verbindungen werden separat gezählt, damit
            # sofort auffällt, falls doch mal eine auftaucht.
            non_main = len(self.connections) - len(client_ids)
            logger.info(
                "evaluate_call_state (%s): %d/2 main verbunden%s | ready=%s | warte auf=%s",
                reason, len(client_ids),
                f" (+{non_main} nicht-main ignoriert)" if non_main else "",
                self._describe(ready_ids),
                self._describe(not_ready_ids) or "niemand",
            )

    # ------------------------------------------------------------------
    # Nachrichtenversand
    # ------------------------------------------------------------------

    async def _send(self, client_id: str, message: dict) -> None:
        """
        Sendet eine JSON-Nachricht an einen einzelnen Client.

        Prüft VOR dem Senden den application_state der Verbindung. Das
        verhindert den Fehler "Cannot call 'send' once a close message has
        been sent" — dieser trat auf, wenn eine bereits tote Verbindung noch
        in self.connections stand (z.B. weil der WebSocketDisconnect im
        Empfangs-Loop dieser Verbindung noch nicht ausgelöst wurde). Schlägt
        die Prüfung oder der Sendeversuch fehl, wird die Verbindung sofort
        entfernt und die Rollen/Presence werden neu ausgestrahlt — statt die
        Zombie-Verbindung stehen zu lassen, wo sie bei jedem weiteren
        Broadcast erneut fehlschlägt UND die Rollenzuweisung verfälscht
        (self.connections erscheint "voller" als die Zahl echter Clients).

        Args:
            client_id: Ziel-Client.
            message:   Nachrichteninhalt als Dictionary.
        """
        ws = self.connections.get(client_id)
        if ws is None:
            return

        if ws.application_state != WebSocketState.CONNECTED:
            logger.warning(
                "Sende an %s übersprungen – Verbindung bereits geschlossen, wird entfernt",
                client_id,
            )
            await self._prune_and_notify(client_id)
            return

        try:
            await ws.send_json(message)
        except Exception as exc:
            logger.error("Sendefehler an %s: %s – Verbindung wird entfernt", client_id, exc)
            await self._prune_and_notify(client_id)

    async def _broadcast_remote_presence(self, present: bool, exclude_id: Optional[str] = None) -> None:
        """
        Sendet {"type": "remote_presence", "present": <bool>} an alle
        main-Clients außer exclude_id. Rein informativ — beeinflusst
        evaluate_call_state(), roles oder ips nicht; fällt die Methode aus,
        bleibt der Rest der Anrufsteuerung unverändert funktionsfähig.

        Args:
            present:    Präsenz-Wert, der verschickt werden soll.
            exclude_id: Client, der die Nachricht NICHT bekommen soll
                        (typischerweise der Absender der presence-Änderung).
        """
        for cid in list(self.connections):
            if cid == exclude_id or self.roles.get(cid) != "main":
                continue
            await self._send(cid, {
                "type":      "remote_presence",
                "present":   present,
                "timestamp": time.time(),
            })
            logger.info("remote_presence an %s gesendet: present=%s", cid, present)

    async def _prune_and_notify(self, client_id: str) -> None:
        """
        Entfernt eine tote (Zombie-)Verbindung sofort und bewertet danach den
        Call-State neu — statt zu warten, bis der Empfangs-Loop dieser
        Verbindung selbst (ggf. erst nach vielen Sekunden, abhängig von
        TCP/TLS-Timeouts) einen WebSocketDisconnect erkennt. Das ist der
        Kern des Selbstheilungs-Mechanismus: eine tote Verbindung darf nie
        länger als nötig als "verbunden" mitzählen.
        """
        if client_id not in self.connections:
            return
        await self.disconnect(client_id)
        await self.evaluate_call_state(reason=f"Zombie-Verbindung entfernt: {client_id}")

    async def relay(self, sender_id: str, message: dict) -> Optional[str]:
        """
        Leitet eine Signaling-Nachricht (Offer/Answer/ICE) 1:1 an den
        jeweils anderen Peer weiter.

        Args:
            sender_id: ID des sendenden Clients.
            message:   Weiterzuleitende Nachricht (Offer / Answer / ICE-Kandidat).

        Returns:
            Die Client-ID des Empfängers, oder None falls aktuell kein
            anderer Peer verbunden ist (z.B. während des Verbindungsaufbaus).
        """
        message["from"] = sender_id
        for cid in list(self.connections):
            # WebRTC-Signaling geht nur an andere main-Clients — eine aux/
            # unbekannte Verbindung darf niemals Offer/Answer/ICE-
            # Kandidaten des Gegenübers sehen.
            if cid != sender_id and self.roles.get(cid) == "main":
                await self._send(cid, message)
                logger.debug("Weitergeleitet: %s von %s → %s", message.get("type"), sender_id, cid)
                return cid  # Nur an genau einen Peer weiterleiten
        return None

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------

    def update_heartbeat(self, client_id: str) -> None:
        """
        Aktualisiert den Heartbeat-Zeitstempel eines Clients.

        Args:
            client_id: Der zu aktualisierende Client.
        """
        self.last_beat[client_id] = time.time()

    # ------------------------------------------------------------------
    # Statusinformationen
    # ------------------------------------------------------------------

    def status(self) -> dict:
        """
        Gibt einen Snapshot des aktuellen Serverstatus zurück.

        Returns:
            Dictionary mit Verbindungs-, Ready- und Call-State-Informationen.
        """
        peers = {
            cid: {
                "role":  self.roles.get(cid, "unknown"),
                "ip":    self.ips.get(cid, "?"),
                "ready": self.ready.get(cid, False),
            }
            for cid in self.connections
        }
        return {
            "connected_clients": len(self.connections),
            "main_clients":      self._main_count(),   # auf einen Blick sichtbar
            "peers":             peers,                # Rolle+IP pro Peer
            "ready":             dict(self.ready),
            "call_active":       self.call_active,
            "call_roles":        dict(self.call_roles),
            "uptime_seconds":    round(time.time() - _SERVER_START, 1),
            "total_connections": self.counter,
        }


# Globale Manager-Instanz
manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Heartbeat-Reaper: Zombie-Verbindungen serverseitig aufräumen
# ---------------------------------------------------------------------------
# Clients senden alle 5 s einen Heartbeat (zusätzlich zählt JEDE Nachricht,
# siehe WebSocket-Loop). Kommt HEARTBEAT_TIMEOUT_S lang nichts, wird der
# Peer entfernt — evaluate_call_state() gibt dabei automatisch Rollen frei
# und setzt call_active zurück. Ohne den Reaper würde eine hängende
# Verbindung einen der beiden Anruf-Slots blockieren ("3/3 verbunden").
HEARTBEAT_TIMEOUT_S = 15
_REAPER_INTERVAL_S  = 5


@app.on_event("startup")
async def _start_heartbeat_reaper() -> None:
    async def reaper() -> None:
        while True:
            await asyncio.sleep(_REAPER_INTERVAL_S)
            now = time.time()
            stale = [
                cid for cid, beat in list(manager.last_beat.items())
                if now - beat > HEARTBEAT_TIMEOUT_S
            ]
            for cid in stale:
                logger.warning("Heartbeat-Timeout: %s wird aufgeräumt", cid)
                log_session_event("heartbeat_timeout", cid)
                ws = manager.connections.get(cid)
                await manager.disconnect(cid)
                if ws is not None:
                    try:
                        await ws.close()
                    except Exception:
                        pass  # Socket war ohnehin tot
                await manager.evaluate_call_state(reason=f"Heartbeat-Timeout {cid}")

    asyncio.create_task(reaper())


# ---------------------------------------------------------------------------
# WebSocket-Endpunkt
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """
    Haupt-WebSocket-Endpunkt für WebRTC-Signaling.

    Vom Client gesendete Nachrichtentypen:
      heartbeat     – Lebenszeichen des Clients (Antwort: heartbeat_ack)
      presence      – {ready: bool} – eigener lokaler Präsenz-Status
      offer         – WebRTC-Angebot (wird 1:1 an den anderen Peer weitergeleitet)
      answer        – WebRTC-Antwort (wird 1:1 an den anderen Peer weitergeleitet)
      ice-candidate – ICE-Kandidat (bidirektional weitergeleitet)

    Vom Server gesendete Nachrichtentypen (server-driven call state):
      welcome    – {clientId, role} nach dem Connect
      start_call – {role: "caller"|"callee", peerId} sobald der Server
                   entscheidet, dass ein Anruf beginnen soll
      end_call   – {reason} sobald der Server entscheidet, dass ein
                   laufender Anruf beendet werden muss
      superseded – {reason} — Verbindung wird verdrängt, weil eine neue
                   main-Verbindung derselben IP eingetroffen ist (siehe
                   ConnectionManager-Docstring); Socket wird direkt danach
                   geschlossen, der Client reconnected nicht automatisch
      remote_presence – {present: bool} — informiert einen main-Client, ob
                   im Raum des jeweils anderen main-Clients gerade jemand
                   steht. Rein informativ, beeinflusst evaluate_call_state()
                   nicht —
                   gesendet bei presence-Änderung (set_ready), einmalig
                   beim Connect (Nachreichen des aktuellen Stands) und bei
                   Disconnect eines main-Clients (present=false).
      heartbeat_ack

    Args:
        websocket: Die eingehende WebSocket-Verbindung.
    """
    # Rolle aus ?role=main|aux in der WebSocket-URL lesen (vom Frontend
    # gesetzt, s. App.jsx SIGNALING_ROLE). Fehlt der Parameter, gilt
    # "unknown" — bewusst nicht automatisch "main", damit nichts
    # unbeabsichtigt zählt.
    role = websocket.query_params.get("role", "unknown")
    client_id = await manager.connect(websocket, role)

    try:
        while True:
            raw = await websocket.receive_json()
            msg_type = raw.get("type", "unbekannt")

            # Jede Nachricht zählt als Lebenszeichen (nicht nur der
            # explizite Heartbeat) — der Reaper misst dagegen.
            manager.update_heartbeat(client_id)

            if msg_type == "heartbeat":
                # Heartbeat bestätigen und Zeitstempel aktualisieren
                manager.update_heartbeat(client_id)
                await manager._send(client_id, {
                    "type":      "heartbeat_ack",
                    "timestamp": time.time(),
                })

            elif msg_type in {"offer", "answer", "ice-candidate"}:
                # WebRTC-Signaling an den anderen Peer weiterleiten
                logger.info("Signaling: %s von %s", msg_type, client_id)
                await manager.relay(client_id, raw)

            elif msg_type == "presence":
                # Client meldet SEINEN EIGENEN Präsenz-Status (ready=true/false).
                # Löst evaluate_call_state() aus — der Server, nicht der Client,
                # entscheidet, ob/wann daraus ein start_call wird.
                await manager.set_ready(client_id, bool(raw.get("ready")))

            elif msg_type == "call_connected":
                # Studien-Logging: Frontend meldet, dass die P2P-Verbindung
                # tatsächlich steht (connectionState "connected"). Nur
                # loggen — keine Auswirkung auf die Anrufsteuerung.
                logger.info("call_connected von %s", client_id)
                log_session_event("call_connected", client_id)

            elif msg_type == "client_event":
                # Studien-Logging: generisches Client-Ereignis
                # (reconnect_success, camera_lost, camera_recovered, …) —
                # nur ins CSV, keine Auswirkung auf die Anrufsteuerung.
                log_session_event(
                    str(raw.get("event", "client_event"))[:40],
                    client_id,
                    str(raw.get("extra", ""))[:200],
                )

            elif msg_type == "call_stats":
                # Studien-Logging: periodische Verbindungsstatistik vom
                # Frontend (Auflösung/fps/Bytes/Verluste). Nur loggen.
                log_session_event(
                    "call_stats", client_id,
                    json.dumps(raw.get("stats", {}), ensure_ascii=False),
                )

            else:
                logger.warning("Unbekannter Nachrichtentyp: %s", msg_type)

    except WebSocketDisconnect:
        await manager.disconnect(client_id)
        # Ein Disconnect kann die Startbedingung (2 verbunden + beide ready)
        # zerstören oder einen laufenden Anruf beenden — neu bewerten.
        await manager.evaluate_call_state(reason=f"Disconnect {client_id}")

    except Exception as exc:
        logger.error("Unbehandelter Fehler bei %s: %s", client_id, exc)
        log_session_event("error", client_id, str(exc)[:200])
        await manager.disconnect(client_id)
        await manager.evaluate_call_state(reason=f"Fehler bei {client_id}: {exc}")


# ---------------------------------------------------------------------------
# REST-Endpunkte
# ---------------------------------------------------------------------------

@app.get("/status", summary="Serverstatus", tags=["Monitoring"])
async def get_status() -> JSONResponse:
    """
    Gibt den aktuellen Serverstatus zurück.

    Returns:
        JSON mit Verbindungsanzahl, Ready-/Call-State, Uptime und Versionsinformationen.
    """
    return JSONResponse({
        "status":    "running",
        "server":    "BA Wael Hammami – Public Display Signaling Server",
        "version":   "1.0.0",
        "timestamp": time.time(),
        **manager.status(),
    })


@app.get("/health", summary="Health-Check", tags=["Monitoring"])
async def health_check() -> JSONResponse:
    """
    Einfacher Gesundheitscheck für Monitoring-Systeme.

    Returns:
        JSON mit Status 'healthy' und Uptime-Sekunden.
    """
    return JSONResponse({
        "status":         "healthy",
        "uptime_seconds": round(time.time() - _SERVER_START, 1),
        "timestamp":      time.time(),
    })


# ---------------------------------------------------------------------------
# Serverstart
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Pfade zu optionalen SSL-Zertifikaten
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    CERT_CANDIDATES = [
        (
            os.path.join(BASE_DIR, "certs", "key.pem"),
            os.path.join(BASE_DIR, "certs", "cert.pem"),
        ),
        (
            os.path.join(BASE_DIR, "..", "certs", "key.pem"),
            os.path.join(BASE_DIR, "..", "certs", "cert.pem"),
        ),
    ]
    KEY_FILE, CERT_FILE = next(
        ((key, cert) for key, cert in CERT_CANDIDATES if os.path.exists(key) and os.path.exists(cert)),
        (None, None),
    )
    use_ssl = KEY_FILE is not None and CERT_FILE is not None

    # Port per Umgebungsvariable überschreibbar (Tests gegen eine zweite
    # Instanz, ohne das Studien-Backend auf 8765 zu berühren); Default 8765.
    PORT = int(os.getenv("PORT", "8765"))

    if use_ssl:
        logger.info("SSL-Zertifikate gefunden – starte mit HTTPS / WSS auf Port %d", PORT)
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=PORT,
            ssl_keyfile=KEY_FILE,
            ssl_certfile=CERT_FILE,
            log_level="info",
        )
    else:
        logger.info(
            "Keine SSL-Zertifikate – starte mit HTTP / WS auf Port %d "
            "(nur für lokale Entwicklung geeignet)", PORT
        )
        uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

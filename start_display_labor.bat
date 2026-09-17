@echo off
REM ============================================================
REM  Start-Skript LABOR-Rechner (129.217.18.124)
REM  Startet Backend + Frontend + zwei Browserfenster (main/aux)
REM
REM  Aufruf:   start_display_labor.bat [SESSION_ID]
REM  Beispiel: start_display_labor.bat Paar03
REM
REM  Die Fenster-Logik steckt in start_display.ps1: Bildschirme
REM  werden dort selbst erkannt, beide Fenster laufen in EINEM
REM  Chrome-Profil (noetig fuer den BroadcastChannel main->aux)
REM  und werden per Win32-API positioniert, weil Chrome bei
REM  bereits laufender Instanz --window-position ignoriert.
REM ============================================================

REM --- Session-ID fuer das Studien-CSV -------------------------
set "SESSION_ID=%~1"
if "%SESSION_ID%"=="" set "SESSION_ID=default"

REM Projekt-Root = Ordner dieses Skripts (enthaelt Leerzeichen!)
set "BASE=%~dp0"

echo [1/4] Starte Backend (SESSION_ID=%SESSION_ID%) ...
start "Backend (Signaling)" /d "%BASE%backend" cmd /k "set SESSION_ID=%SESSION_ID%&& python signaling_server.py"

echo [2/4] Starte Frontend (Vite) ...
start "Frontend (Vite)" /d "%BASE%frontend" cmd /k "npm run dev -- --host"

echo [3/4] Warte 12 Sekunden auf die Server ...
timeout /t 12 /nobreak >nul

echo [4/4] Oeffne die zwei Display-Fenster ...
powershell -ExecutionPolicy Bypass -File "%~dp0start_display.ps1" -Room labor

echo.
echo Taste "d" = Debug-HUD.
echo Session-CSV: backend\logs\session_log.csv
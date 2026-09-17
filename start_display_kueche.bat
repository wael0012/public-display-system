@echo off
REM ============================================================
REM  Start-Skript KUECHEN-Rechner (129.217.18.121)
REM  Oeffnet NUR die zwei Browserfenster mit der Labor-URL.
REM  Backend + Frontend laufen auf dem Labor-Rechner (…124).
REM  Reihenfolge: ERST Labor starten!
REM
REM  Die gesamte Fenster-Logik steckt in start_display.ps1
REM  (Bildschirm-Erkennung, gemeinsames Chrome-Profil fuer den
REM  BroadcastChannel, Positionierung per Win32 + F11).
REM ============================================================
powershell -ExecutionPolicy Bypass -File "%~dp0start_display.ps1" -Room kueche
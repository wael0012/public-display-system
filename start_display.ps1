# ============================================================
#  Display-Starter (2026-08-21)
#  Aufruf:  start_display.ps1 -Room kueche | -Room labor
#
#  WARUM DIESES SKRIPT?
#  Beide Fenster brauchen DASSELBE --user-data-dir, sonst laufen sie
#  in zwei unabhaengigen Chrome-Instanzen und der BroadcastChannel
#  (main -> aux) funktioniert nicht; aux bleibt auf "SYSTEM BEREIT".
#  Bei gleichem Profil reicht Chrome den zweiten Aufruf aber an die
#  laufende Instanz weiter, die --window-position und
#  --start-fullscreen IGNORIERT. Deshalb: erst BEIDE Fenster oeffnen,
#  dann per Win32 positionieren, und ERST GANZ ZUM SCHLUSS F11.
#  (Frueher Vollbild auf Fenster 1 blockiert das Verschieben von 2.)
# ============================================================
param(
    [ValidateSet('labor','kueche')]
    [string]$Room = 'kueche'
)

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int t, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static string Title(IntPtr h) {
    StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString();
  }
  public static string Pos(IntPtr h) {
    RECT r; GetWindowRect(h, out r); return r.L + "," + r.T + " (" + (r.R-r.L) + "x" + (r.B-r.T) + ")";
  }
  public static List<IntPtr> Chrome() {
    List<IntPtr> res = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cn = new StringBuilder(256);
      GetClassName(h, cn, 256);
      if (cn.ToString() == "Chrome_WidgetWin_1" && GetWindowTextLength(h) > 0) res.Add(h);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@

# --- Bildschirme automatisch ermitteln, links nach rechts ------------
$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }
Write-Host "Gefundene Anzeigen:"
$screens | ForEach-Object { Write-Host "   $($_.DeviceName)  $($_.Bounds)  Primary=$($_.Primary)" }

if ($screens.Count -lt 2) {
    Write-Host "[FEHLER] Nur EINE Anzeige. Win+P -> 'Erweitern'."
    Read-Host "Enter zum Beenden"; exit 1
}

$m = $screens[0].Bounds   # links  -> main
$a = $screens[1].Bounds   # rechts -> aux

$chrome = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host "[FEHLER] Chrome nicht gefunden."; Read-Host; exit 1 }

$profileDir = "$env:LOCALAPPDATA\DisplayProfile"

# --ignore-certificate-errors: selbstsigniertes Zertifikat, reines LAN
# --test-type: unterdrueckt den gelben Chrome-Hinweisbalken, den
#   --ignore-certificate-errors sonst dauerhaft oben einblendet
# --use-fake-ui-for-media-stream: echte Kamera, nur der Dialog entfaellt
# --disable-features=...,Translate: verhindert das Uebersetzen-Popup,
#   das sonst faelschlich als Display-Fenster erkannt wurde
$flags = @(
    "--no-first-run"
    "--no-default-browser-check"
    "--disable-session-crashed-bubble"
    "--disable-features=TranslateUI,Translate"
    "--autoplay-policy=no-user-gesture-required"
    "--ignore-certificate-errors"
    "--test-type"
    "--use-fake-ui-for-media-stream"
    "--user-data-dir=$profileDir"
)

if ($Room -eq 'kueche') {
    $base = "https://129.217.18.124:5173"; $roomParam = "&room=kueche"
} else {
    $base = "https://localhost:5173";      $roomParam = ""
}

function Wait-NewWindow($before, $label) {
  # Chrome oeffnet neben dem App-Fenster kurzzeitig Popups
  # ("Translate this page?", Berechtigungs-Bubbles). Die haben
  # entweder Groesse 0x0 oder sind deutlich kleiner als ein Display.
  # Ohne diesen Filter positioniert das Skript das Popup statt des
  # Display-Fensters, und das echte Fenster bleibt links liegen.
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $new = @([W]::Chrome() | Where-Object { $before -notcontains $_ })
    foreach ($h in $new) {
      $t = [W]::Title($h)
      $p = [W]::Pos($h)
      if ($t -match 'Translate|Uebersetzen') { continue }
      if ($p -match '\(0x0\)') { continue }
      if ($p -match '\((\d+)x(\d+)\)') {
        if ([int]$Matches[1] -lt 400 -or [int]$Matches[2] -lt 300) { continue }
      }
      Write-Host "   $label gefunden: $t  $p"
      return $h
    }
  }
  Write-Host "   [WARNUNG] $label - kein passendes Fenster erkannt."
  return [IntPtr]::Zero
}

Write-Host ""
Write-Host "[1/3] Oeffne beide Fenster ..."

$b0 = [W]::Chrome()
Start-Process $chrome -ArgumentList ($flags + @("--app=$base/?screen=main$roomParam&autostart=1"))
$hMain = Wait-NewWindow $b0 "main"

Start-Sleep -Seconds 3
$b1 = [W]::Chrome()
Start-Process $chrome -ArgumentList ($flags + @("--app=$base/?screen=aux$roomParam&autostart=1"))
$hAux = Wait-NewWindow $b1 "aux"

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "[2/3] Positioniere ..."

# SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10) -- zweimal setzen, weil Chrome
# die erste Positionierung direkt nach dem Start manchmal zurueckdreht.
function Move-To($h, $b, $label) {
    if ($h -eq [IntPtr]::Zero) { return }
    [W]::ShowWindow($h, 9) | Out-Null
    Start-Sleep -Milliseconds 500
    [W]::SetWindowPos($h, [IntPtr]::Zero, $b.X, $b.Y, $b.Width, $b.Height, 0x14) | Out-Null
    Start-Sleep -Milliseconds 800
    [W]::SetWindowPos($h, [IntPtr]::Zero, $b.X, $b.Y, $b.Width, $b.Height, 0x14) | Out-Null
    Start-Sleep -Milliseconds 500
    Write-Host "   $label soll $($b.X),$($b.Y) -- ist jetzt $([W]::Pos($h))"
}

Move-To $hMain $m "main"
Move-To $hAux  $a "aux"

Write-Host ""
Write-Host "[3/3] Vollbild (F11) ..."

# F11 ERST JETZT, sonst blockiert das Vollbild-Fenster das Verschieben.
# SetForegroundWindow scheitert auf dem nicht-primaeren Bildschirm
# gelegentlich stillschweigend; dann landet F11 im falschen Fenster.
# Deshalb pruefen wir, ob das Fenster wirklich vorne ist, und
# wiederholen im Zweifel.
function Go-Fullscreen($h, $label) {
    if ($h -eq [IntPtr]::Zero) { return }
    for ($try = 1; $try -le 3; $try++) {
        [W]::ShowWindow($h, 9) | Out-Null
        Start-Sleep -Milliseconds 600
        [W]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 1200
        if ([W]::Foreground() -eq $h) {
            [System.Windows.Forms.SendKeys]::SendWait("{F11}")
            Start-Sleep -Milliseconds 1500
            Write-Host "   $label Vollbild OK (Versuch $try) -- $([W]::Pos($h))"
            return
        }
        Write-Host "   $label nicht im Vordergrund, neuer Versuch ..."
    }
    Write-Host "   [WARNUNG] $label - bitte einmal anklicken und F11 druecken."
}

Go-Fullscreen $hAux  "aux"
Start-Sleep -Seconds 1
Go-Fullscreen $hMain "main"

Write-Host ""
Write-Host "Fertig. Beenden: Alt+F4 in jedem Fenster."
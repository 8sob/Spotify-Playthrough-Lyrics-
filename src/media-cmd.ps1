# One-shot transport control for the Spotify desktop SMTC session.
# Usage: media-cmd.ps1 -Action next|prev|toggle|volup|voldn|mute|seek [-PositionMs N]
# Volume keys go straight to the system mixer (no Spotify session needed).
# Seek position is in milliseconds (converted to WinRT ticks here).
# Prints {"ok":true} or {"ok":false,"reason":"..."} and exits.
param([string]$Action = 'toggle', [long]$PositionMs = -1)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Out($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  # System volume keys: VK_VOLUME_MUTE/DOWN/UP. Session-independent.
  if ($Action -eq 'volup' -or $Action -eq 'voldn' -or $Action -eq 'mute') {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VolKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
    $vk = @{ volup = 0xAF; voldn = 0xAE; mute = 0xAD }[$Action]
    [VolKeys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
    [VolKeys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
    Out @{ ok = $true }
    exit 0
  }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function AwaitOp($op, $type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $t.Wait(8000)) { throw 'timed out waiting for Spotify' }
    $t.Result
  }

  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $boolType = [bool]

  $manager = AwaitOp ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

  $session = $null
  foreach ($s in $manager.GetSessions()) {
    try { if ($s.SourceAppUserModelId -match '(?i)spotify') { $session = $s; break } }
    catch { continue }
  }
  if ($null -eq $session) {
    Out @{ ok = $false; reason = 'no Spotify session' }
    exit 0
  }

  switch ($Action) {
    'next' { AwaitOp ($session.TrySkipNextAsync()) ($boolType) | Out-Null }
    'prev' { AwaitOp ($session.TrySkipPreviousAsync()) ($boolType) | Out-Null }
    'seek' {
      if ($PositionMs -lt 0) { throw 'no seek position given' }
      $ticks = [int64]$PositionMs * 10000 # ms -> 100ns WinRT ticks
      $accepted = AwaitOp ($session.TryChangePlaybackPositionAsync($ticks)) ($boolType)
      if (-not $accepted) { throw 'Spotify refused the seek' }
    }
    default { AwaitOp ($session.TryTogglePlayPauseAsync()) ($boolType) | Out-Null }
  }
  Out @{ ok = $true }
} catch {
  Out @{ ok = $false; reason = $_.Exception.Message }
}

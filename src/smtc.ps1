# Reads the Spotify desktop app's Windows media session (SMTC) and prints
# one JSON object per line:
#   full:  {"title","artist","album","status","positionMs","durationMs","updatedAt","art?"}
#   empty: {"none":true}
#   error: {"error":"..."}
# Art is only included on the first line for each track.
param([int]$Loops = 0)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

$asStream = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
})[0]

function AwaitOp($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$MgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

function Out($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function ArtUrl($thumb) {
  if (-not $thumb) { return $null }
  try {
    $raw = AwaitOp ($thumb.OpenReadAsync()) ($StreamType)
    if (-not $raw) { return $null }
    $net = $asStream.Invoke($null, @($raw))
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    try { $net.Dispose() } catch {}
    try { $raw.Dispose() } catch {}
    $bytes = $ms.ToArray()
    if (-not $bytes -or $bytes.Length -eq 0) { return $null }
    $mime = 'image/jpeg'
    if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $mime = 'image/png' }
    elseif ($bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49) { $mime = 'image/gif' }
    elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49) { $mime = 'image/webp' }
    return 'data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch { return $null }
}

$manager = $null
$artKey = $null
$n = 0

while ($Loops -le 0 -or $n -lt $Loops) {
  $n++
  try {
    if ($null -eq $manager) {
      $manager = AwaitOp ($MgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }

    $session = $null
    foreach ($s in $manager.GetSessions()) {
      try { if ($s.SourceAppUserModelId -match '(?i)spotify') { $session = $s; break } }
      catch { continue }
    }
    if ($null -eq $session) {
      Out @{ none = $true }
      $artKey = $null
      Start-Sleep -Milliseconds 250
      continue
    }

    $props = AwaitOp ($session.TryGetMediaPropertiesAsync()) ($PropsType)
    $info = $session.GetPlaybackInfo()
    $tl = $session.GetTimelineProperties()

    $title = [string]$props.Title
    if ([string]::IsNullOrWhiteSpace($title)) {
      Out @{ none = $true }
      Start-Sleep -Milliseconds 250
      continue
    }
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
    $status = $info.PlaybackStatus.ToString()

    $dur = 0; $pos = 0; $stamp = 0
    try { $dur = [int]$tl.EndTime.TotalMilliseconds } catch {}
    try { $pos = [int]$tl.Position.TotalMilliseconds } catch {}
    try { $stamp = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds() } catch {}
    if ($pos -lt 0) { $pos = 0 }
    if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
    if ($stamp -le 0) { $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

    $key = "$title`n$artist`n$album"
    $art = $null
    if ($key -ne $artKey) {
      $art = ArtUrl $props.Thumbnail
      $artKey = $key
    }

    $line = [ordered]@{
      title = $title; artist = $artist; album = $album; status = $status
      positionMs = $pos; durationMs = $dur; updatedAt = $stamp
    }
    if ($art) { $line.art = $art }
    Out $line
  } catch {
    Out @{ error = $_.Exception.Message }
    $manager = $null
    Start-Sleep -Milliseconds 250
    continue
  }
  Start-Sleep -Milliseconds 250
}

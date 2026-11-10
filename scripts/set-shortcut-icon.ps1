# Retargets the installed app's Desktop/Start Menu shortcuts at the brand icon.
# Needed while the exe cannot be re-signed (see README: winCodeSign needs
# symlink privilege). Run after installing:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-shortcut-icon.ps1
$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\frameforge-studio'
$png = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\icon.png'
$ico = Join-Path $installDir 'icon.ico'

if (-not (Test-Path $png)) { throw "Missing brand source: $png" }

Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::FromFile($png)
$handle = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($handle)
$stream = [System.IO.File]::Create($ico)
$icon.Save($stream)
$stream.Close()
$bitmap.Dispose()
Write-Output "wrote $ico"

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @(
  (Join-Path $env:USERPROFILE 'Desktop\FrameForge Studio.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\FrameForge Studio.lnk')
)

foreach ($path in $shortcuts) {
  if (-not (Test-Path $path)) { Write-Output "skip (missing): $path"; continue }
  $link = $shell.CreateShortcut($path)
  $link.IconLocation = "$ico,0"
  $link.Save()
  Write-Output "retargeted $path"
}

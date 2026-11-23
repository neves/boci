$ErrorActionPreference = "Stop"

$InstallDir = if ($env:BOCI_INSTALL_DIR) { $env:BOCI_INSTALL_DIR } else { "$HOME\.local\bin" }
$Url = "https://github.com/neves/boci/releases/latest/download/boci-windows-x64.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$OutFile = Join-Path $InstallDir "boci.exe"
Invoke-WebRequest -Uri $Url -OutFile $OutFile

Write-Host "Installed boci to $OutFile"

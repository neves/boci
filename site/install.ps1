$ErrorActionPreference = "Stop"

$InstallDir = if ($env:BOCI_INSTALL_DIR) { $env:BOCI_INSTALL_DIR } else { "$HOME\.local\bin" }
$BaseUrl = if ($env:BOCI_RELEASE_BASE_URL) { $env:BOCI_RELEASE_BASE_URL } else { "https://github.com/neves/boci/releases/latest/download" }
$Asset = "boci-windows-x64.exe"
$Url = "$BaseUrl/$Asset"
$SumsUrl = "$BaseUrl/SHA256SUMS"

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("boci-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
    $TmpBin = Join-Path $TmpDir $Asset
    $TmpSums = Join-Path $TmpDir "SHA256SUMS"

    Invoke-WebRequest -Uri $Url -OutFile $TmpBin
    Invoke-WebRequest -Uri $SumsUrl -OutFile $TmpSums

    $Expected = $null
    foreach ($line in Get-Content -Path $TmpSums) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            if ($Matches[2] -eq $Asset) {
                $Expected = $Matches[1].ToLowerInvariant()
                break
            }
        }
    }
    if (-not $Expected) {
        throw "Checksum for $Asset not found in SHA256SUMS"
    }

    $Actual = (Get-FileHash -Path $TmpBin -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        throw "Checksum verification failed for ${Asset}: expected $Expected, got $Actual"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $OutFile = Join-Path $InstallDir "boci.exe"
    Move-Item -Path $TmpBin -Destination $OutFile -Force

    Write-Host "Installed boci to $OutFile"
} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

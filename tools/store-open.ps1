# Open the Hydra Emulator Store packaging files and Partner Center.
# Usage: Right Key → Run with PowerShell
# Activate: Place four things on the desktop once and save the directory.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
# Version number taken from package. json, don't write it down in the script -- every lift is changed here sooner or later.
# The MSIX version is a four-string format (0.5.2 § 0.5.2.0), which is consistent with the building/msix.js rules.
$ver = '0.0.0.0'
try {
    # The default code for the mandatory -Encoding UTF8: Windows PowerShell 5.1 is ANSI,
    # And the cardage. json has Chinese description, and press ANSI to read with a misdirected error by the ConvertFrom-Json.
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $ver = ('{0}.0' -f $pkg.version)
} catch {
    Write-Host '  [I can’t read package.json version, back to 0.5.3.0 to find the bag.' -ForegroundColor Yellow
    $ver = '0.5.3.0'
}
$msix = Join-Path $root ('dist\store\Hydra Emulator_{0}_x64.msix' -f $ver)
$guide = Join-Path $root 'docs\store-upload-walkthrough.md'
$listing = Join-Path $root 'docs\store-listing.md'

Write-Host ''
Write-Host '  Hydra Emulator.' -ForegroundColor Green
Write-Host '  ─────────────────────────────' -ForegroundColor DarkGray

if (-not (Test-Path $msix)) {
    Write-Host "  [Can not find installation package: $msix" -ForegroundColor Red
    Write-Host '      Run node build/msix.js repackaging.' -ForegroundColor DarkGray
} else {
    $mb = [math]::Round((Get-Item $msix).Length / 1MB, 1)
    Write-Host "  [1. Install package $mb MB" -ForegroundColor Cyan
    Write-Host '      Selected in resource manager to drag it directly when uploading' -ForegroundColor DarkGray
    Start-Process explorer.exe "/select,`"$msix`""
}

Write-Host '  [2. Partner Center (browser open, you are required to log in))' -ForegroundColor Cyan
Start-Process 'https://partner.microsoft.com/dashboard/apps-and-games'

if (Test-Path $guide) {
    Write-Host '  [3. Listing of operations (copy copy))' -ForegroundColor Cyan
    Start-Process $guide
}

if (Test-Path $listing) {
    Write-Host '  [4. Listing Case (Long Description / Function Point / Review Remarks)' -ForegroundColor Cyan
    Start-Process $listing
}

Write-Host ''
Write-Host '  Order: New product * Upload package * Sticking * Submission' -ForegroundColor Yellow
Write-Host '  Privacy policy: https://github.com/Lord1Egypt/Hydra-Emulator/blob/main/docs/privacy.md' -ForegroundColor DarkGray
Write-Host ''

param(
  [string]$NodeVersion = "24.14.1",
  [string]$RuntimeIdentifier = "win-x64"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Dist = Join-Path $Root "dist"
$ReleaseName = "CS2Overlay-Windows-x64"
$ReleaseDir = Join-Path $Dist $ReleaseName
$AppDir = Join-Path $ReleaseDir "app"
$RuntimeDir = Join-Path $ReleaseDir "runtime"
$CacheDir = Join-Path $Dist ".cache"
$NodeZip = Join-Path $CacheDir "node-v$NodeVersion-$RuntimeIdentifier.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-$RuntimeIdentifier.zip"
$LauncherProject = Join-Path $Root "tools\CS2Overlay.Launcher\CS2Overlay.Launcher.csproj"
$LauncherPublishDir = Join-Path $Dist "launcher-publish"
$ZipPath = Join-Path $Dist "$ReleaseName.zip"

function Copy-RequiredItem($Source, $Destination) {
  if (!(Test-Path $Source)) {
    throw "Required item missing: $Source"
  }
  Copy-Item $Source $Destination -Recurse -Force
}

New-Item -ItemType Directory -Force $Dist, $CacheDir | Out-Null
Remove-Item $ReleaseDir, $LauncherPublishDir, $ZipPath -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ReleaseDir, $AppDir, $RuntimeDir | Out-Null

Push-Location $Root
try {
  npm ci --omit=dev

  dotnet publish $LauncherProject `
    --configuration Release `
    --runtime $RuntimeIdentifier `
    --self-contained true `
    --output $LauncherPublishDir `
    -p:PublishSingleFile=true `
    -p:EnableCompressionInSingleFile=true
}
finally {
  Pop-Location
}

if (!(Test-Path $NodeZip)) {
  Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
}

$NodeExtractDir = Join-Path $CacheDir "node-v$NodeVersion-$RuntimeIdentifier"
if (!(Test-Path $NodeExtractDir)) {
  Expand-Archive -Path $NodeZip -DestinationPath $CacheDir -Force
}

Copy-RequiredItem (Join-Path $LauncherPublishDir "CS2Overlay.exe") (Join-Path $ReleaseDir "CS2Overlay.exe")
Copy-RequiredItem (Join-Path $NodeExtractDir "node.exe") (Join-Path $RuntimeDir "node.exe")

Copy-RequiredItem (Join-Path $Root "server.js") (Join-Path $AppDir "server.js")
Copy-RequiredItem (Join-Path $Root "package.json") (Join-Path $AppDir "package.json")
Copy-RequiredItem (Join-Path $Root "index.html") (Join-Path $AppDir "index.html")
Copy-RequiredItem (Join-Path $Root "mock-live.json") (Join-Path $AppDir "mock-live.json")
Copy-RequiredItem (Join-Path $Root "src") (Join-Path $AppDir "src")
Copy-RequiredItem (Join-Path $Root "logos") (Join-Path $AppDir "logos")
Copy-RequiredItem (Join-Path $Root "node_modules") (Join-Path $AppDir "node_modules")

@"
CS2 Overlay
===========

Start:
  1. Double-click CS2Overlay.exe.
  2. Choose the HLTV events in the console.
  3. Add this URL as OBS Browser Source:
     http://localhost:3000/

Notes:
  - Node.js is bundled in runtime\node.exe.
  - The launcher uses Microsoft Edge for Playwright by default.
  - Team logos are bundled in app\logos.
  - To add a logo, copy the image into app\logos and add it to app\logos\teams.json.
  - To reuse the previous selection, run:
      CS2Overlay.exe --lastEvent
  - To skip the prompt, set EVENT_IDS before starting.
"@ | Set-Content -Path (Join-Path $ReleaseDir "README.txt") -Encoding UTF8

if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
  Push-Location $ReleaseDir
  try {
    tar.exe -a -c -f $ZipPath *
  }
  finally {
    Pop-Location
  }
}
else {
  Compress-Archive -Path (Join-Path $ReleaseDir "*") -DestinationPath $ZipPath -Force
}

Write-Host "Portable release created:"
Write-Host "  $ReleaseDir"
Write-Host "  $ZipPath"

<#
.SYNOPSIS
  Clone-and-compile bootstrap for the Helm engine (helm-server) on Windows.

.DESCRIPTION
  The Windows sibling of engine/bootstrap.sh. Reproduces, on Windows/MSVC, the
  full path from a fresh Helm checkout to a built helm-server.exe, following
  OpenCPN's own (32-bit / Win32) Windows dependency model:

    1. fetch the pinned OpenCPN SHA (engine/vendor/OPENCPN_REF)
    2. apply Helm's patch series (engine/patches) + overlay engine/vendor/cli
    3. provision OpenCPN's Windows deps into <clone>/cache:
         - prebuilt wxWidgets 3.2.9 (vc14x, 32-bit)
         - OCPNWindowsCoreBuildSupport bundle (glew/cairo/expat/openssl/curl/...)
       (the same artifacts OpenCPN's buildwin/win_deps.bat downloads, fetched
        natively here so no chocolatey/wget/admin is required - only 7-Zip)
    4. CMake configure (-A Win32) + build the helm-server target

  Helm's targets live INSIDE the patched OpenCPN CMake tree (patch 0003 adds
  them to cli/CMakeLists.txt; helm_*.cpp are overlaid into cli/), so helm-server
  is produced by this single build - there is no separate "build OpenCPN first".

.NOTES
  Prerequisites:
    - Visual Studio 2022 or 2026, "Desktop development with C++", incl. the
      x86 (32-bit) build tools. The prebuilt wxWidgets is vc14x; a v14x-family
      toolset (VS2015-2022 = v140-v143) is the tested combination.
    - Git, CMake >= 3.24, 7-Zip (7z on PATH or C:\Program Files\7-Zip\7z.exe).
    - ~2 GB free disk and an internet connection (first run downloads ~300 MB).

  Long paths: keep the clone at a short root (default C:\h\ocpn); OpenCPN's git
  object tree and the dep caches overflow the legacy 260-char MAX_PATH otherwise.
#>
[CmdletBinding()]
param(
  [string]$CloneDir  = "C:\h\ocpn",
  [string]$Generator = "",            # auto-detected from the installed VS if empty
  [ValidateSet("Release","Debug","RelWithDebInfo")]
  [string]$Config    = "Release",
  [switch]$SkipDeps,                   # reuse already-provisioned wx + bundle
  [switch]$Clean                       # wipe the clone first
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
function Say($m){ Write-Host "`n== $m" -ForegroundColor Cyan }
function Info($m){ Write-Host "   $m" }
function Die($m){ Write-Host "FATAL: $m" -ForegroundColor Red; exit 1 }

# Pinned dependency versions - keep in sync with OpenCPN's buildwin/win_deps.bat
# for the pinned OPENCPN_SHA.
$WXVER      = "3.2.9"
$WXBASE     = "https://github.com/wxWidgets/wxWidgets/releases/download/v$WXVER"
$BUNDLE_URL = "https://github.com/OpenCPN/OCPNWindowsCoreBuildSupport/archive/refs/tags/v0.5.zip"
$IPHLPAPI   = "https://dl.cloudsmith.io/public/alec-leamas/opencpn-support/raw/files/iphlpapi.lib"

# ---- prerequisites --------------------------------------------------------
Say "prerequisites"
foreach($t in "git","cmake"){ if(-not (Get-Command $t -ErrorAction SilentlyContinue)){ Die "$t not found on PATH" } }
$sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source
if(-not $sevenZip){ if(Test-Path "C:\Program Files\7-Zip\7z.exe"){ $sevenZip = "C:\Program Files\7-Zip\7z.exe" } }
if(-not $sevenZip){ Die "7-Zip not found (install: choco install 7zip, or from 7-zip.org)" }

$vsw = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if(-not (Test-Path $vsw)){ Die "Visual Studio not found (need the Desktop C++ workload)" }
if(-not $Generator){
  # The prebuilt wxWidgets is vc14x. VS2022 (v143) is the tested-matching toolset:
  # VS2026's newer toolset LINKS against vc14x but crashes at runtime inside the wx
  # DLLs (CRT/ABI mismatch). So PREFER VS2022 whenever it is installed.
  $vs2022 = & $vsw -version "[17.0,18.0)" -property installationPath 2>$null | Select-Object -First 1
  if($vs2022){
    $Generator = "Visual Studio 17 2022"
  } else {
    $vsMajor = (& $vsw -latest -property installationVersion).Split('.')[0]
    switch($vsMajor){
      "18" { $Generator = "Visual Studio 18 2026"
             Info "WARNING: only VS2026 found. The prebuilt wx is vc14x; if helm-server.exe"
             Info "         crashes on startup inside wxbase32u, install the VS2022 (v143) C++"
             Info "         build tools and re-run (or pass -Generator 'Visual Studio 17 2022')." }
      "16" { $Generator = "Visual Studio 16 2019" }
      default { Die "unrecognized Visual Studio version $vsMajor; pass -Generator explicitly" }
    }
  }
}
Info "repo:      $RepoRoot"
Info "clone:     $CloneDir"
Info "generator: $Generator  (arch: Win32 / x86)"
Info "7-Zip:     $sevenZip"

function Download($url, $dest){
  if(Test-Path $dest){ Info "cached  $(Split-Path $dest -Leaf)"; return }
  Info "download $(Split-Path $dest -Leaf)"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}
function Extract7z($archive, $destDir){
  & $sevenZip x -y "-o$destDir" $archive | Out-Null
  if($LASTEXITCODE -ne 0){ Die "7z extract failed: $archive" }
}

# ---- read pinned upstream -------------------------------------------------
Say "pinned upstream (engine/vendor/OPENCPN_REF)"
$ref = Get-Content (Join-Path $RepoRoot "engine\vendor\OPENCPN_REF")
$remote = ($ref | Where-Object { $_ -match "^OPENCPN_REMOTE=" }) -replace "^OPENCPN_REMOTE=",""
$sha    = ($ref | Where-Object { $_ -match "^OPENCPN_SHA=" })    -replace "^OPENCPN_SHA=",""
if(-not $sha){ Die "OPENCPN_SHA missing from OPENCPN_REF" }
Info "$remote @ $sha"

# ---- fetch pinned SHA (shallow, long-paths on) ----------------------------
Say "fetch OpenCPN -> $CloneDir"
if($Clean){ Remove-Item -Recurse -Force $CloneDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $CloneDir | Out-Null
Push-Location $CloneDir
try {
  if(-not (Test-Path ".git")){
    git init -q
    git config core.longpaths true
    git config core.autocrlf input      # keep upstream LF so the patch series applies
    git remote add origin $remote 2>$null
  }
  if(-not (git cat-file -e "$sha^{commit}" 2>$null)){ git -c core.longpaths=true fetch --depth 1 origin $sha }
  git -c core.longpaths=true checkout -q --detach $sha
  git -c core.longpaths=true reset --hard -q $sha
  git -c core.longpaths=true clean -fdq -e build-win -e cache
  if((git rev-parse HEAD) -ne $sha){ Die "checkout is not the pinned SHA" }

  # ---- apply Helm patch series ------------------------------------------
  Say "apply Helm patch series"
  # NB: -Filter uses only * and ? wildcards (no [0-9] character classes), so match
  # the numeric prefix with a regex instead.
  $patches = Get-ChildItem (Join-Path $RepoRoot "engine\patches") -Filter "*.patch" |
             Where-Object { $_.Name -match '^\d{4}-' } | Sort-Object Name
  if($patches.Count -eq 0){ Die "no Helm patches found under engine/patches" }
  foreach($p in $patches){
    git -c core.longpaths=true apply --check $p.FullName
    if($LASTEXITCODE -ne 0){ Die "patch does not apply: $($p.Name)" }
    git -c core.longpaths=true apply $p.FullName
    Info "applied $($p.Name)"
  }

  # ---- overlay Helm cli/ -------------------------------------------------
  Say "overlay engine/vendor/cli -> cli/"
  Get-ChildItem (Join-Path $RepoRoot "engine\vendor\cli") -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path "$CloneDir\cli" $_.Name) -Force
  }

  # ---- provision OpenCPN Windows deps (wx 3.2.9 + buildwin bundle) -------
  $cache = "$CloneDir\cache"
  $wxRoot = "$cache\wxWidgets-$WXVER"
  $wxLib  = "$wxRoot\lib\vc14x_dll"
  $buildwin = "$cache\buildwin"
  if($SkipDeps -and (Test-Path "$buildwin\libcurl.lib") -and (Test-Path $wxLib)){
    Say "deps: reusing existing cache (-SkipDeps)"
  } else {
    Say "provision deps -> $cache  (prebuilt wxWidgets $WXVER + OCPN buildwin bundle)"
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    if(-not (Test-Path $wxLib)){
      foreach($a in @("wxMSW-${WXVER}_vc14x_Dev.7z","wxWidgets-${WXVER}-headers.7z","wxMSW-${WXVER}_vc14x_ReleaseDLL.7z")){
        Download "$WXBASE/$a" "$cache\$a"
        Extract7z "$cache\$a" $wxRoot
      }
    } else { Info "wxWidgets $WXVER already present" }
    if(-not (Test-Path "$buildwin\libcurl.lib")){
      Download $BUNDLE_URL "$cache\OCPNWindowsCoreBuildSupport.zip"
      Extract7z "$cache\OCPNWindowsCoreBuildSupport.zip" "$cache\buildwintemp"
      New-Item -ItemType Directory -Force -Path $buildwin | Out-Null
      Copy-Item "$cache\buildwintemp\OCPNWindowsCoreBuildSupport-0.5\buildwin\*" $buildwin -Recurse -Force
      if(Test-Path "$buildwin\wxWidgets"){ Remove-Item "$buildwin\wxWidgets\*.dll" -Force -ErrorAction SilentlyContinue }
      Download $IPHLPAPI "$buildwin\iphlpapi.lib"
    } else { Info "buildwin bundle already present" }
  }

  # ---- configure + build helm-server ------------------------------------
  Say "cmake configure ($Generator, Win32)"
  $bld = "$CloneDir\build-win"
  # Drop a stale cache from a different arch OR generator (e.g. an earlier x64
  # spike, or a VS2026 vs VS2022 switch) so the configure does not fail on a
  # generator/platform mismatch.
  if(Test-Path "$bld\CMakeCache.txt"){
    $cache = Get-Content "$bld\CMakeCache.txt" -Raw
    $archOk = $cache -match "CMAKE_GENERATOR_PLATFORM:\w+=Win32"
    $genOk  = $cache -match [regex]::Escape("CMAKE_GENERATOR:INTERNAL=$Generator")
    if(-not ($archOk -and $genOk)){
      Info "removing stale build dir (generator/arch mismatch)"
      Remove-Item -Recurse -Force $bld
    }
  }
  # curl comes from the buildwin bundle now (OCPN_USE_EXTERN_CURL stays OFF).
  # OCPN_BUNDLE_WXDLLS OFF: headless helm-server does not need the GUI DLL-copy step.
  cmake -S $CloneDir -B $bld -G $Generator -A Win32 `
    -DwxWidgets_ROOT_DIR="$wxRoot" `
    -DwxWidgets_LIB_DIR="$wxLib" `
    -DwxWidgets_CONFIGURATION=mswu `
    -DOCPN_TARGET_TUPLE="msvc-wx32;10;x86_64" `
    -DOCPN_BUNDLE_WXDLLS=OFF `
    -DOCPN_BUILD_TEST=OFF
  if($LASTEXITCODE -ne 0){ Die "cmake configure failed" }

  Say "cmake build helm-server ($Config)"
  cmake --build $bld --target helm-server --config $Config
  if($LASTEXITCODE -ne 0){ Die "helm-server build failed" }

  $exe = "$bld\cli\$Config\helm-server.exe"
  if(-not (Test-Path $exe)){ Die "build reported success but helm-server.exe not found under $bld\cli\$Config" }

  # Stage the prebuilt runtime DLLs next to the exe so it runs standalone (these
  # are NOT built with helm-server; they are the wx + OpenCPN-bundle DLLs).
  Say "stage runtime DLLs next to helm-server.exe"
  $exeDir = Split-Path $exe
  Get-ChildItem "$wxLib\*.dll" | Where-Object { $_.Name -notmatch 'ud_' } | Copy-Item -Destination $exeDir -Force  # release wx DLLs (skip debug *ud_*)
  Copy-Item "$buildwin\*.dll" $exeDir -Force
  Info "staged $((Get-ChildItem "$exeDir\*.dll").Count) DLLs"

  Say "DONE"
  Info "built: $exe"
  Info "run it directly (DLLs are alongside it):  `"$exe`" --port 9001"
  Info "chart data: set HELM_S57_DATA to your s57data dir, or place it at %USERPROFILE%\.helm\runtime\s57data"
} finally { Pop-Location }

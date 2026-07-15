<#
.SYNOPSIS
  Phase 0 Windows toolchain spike for the Helm engine (docs/proposals/WINDOWS-PORT.md).

.DESCRIPTION
  Reproduces, on Windows/MSVC, what engine/bootstrap.sh does on macOS UP TO the
  configure step: fetch the pinned OpenCPN SHA, apply the Helm patch series,
  overlay engine/vendor/cli, resolve deps with vcpkg (wxWidgets 3.2 pinned via
  vcpkg.json), and CMake-configure the tree with the Visual Studio generator.

  This is a SPIKE, not the product build. Its job is to answer, with evidence:
  do the patches apply, and does OpenCPN + wxWidgets 3.2 + GDAL configure under
  MSVC? Phase 2 folds fetch/patch into CMake and replaces this script.

.NOTES
  Requirements: Git, CMake >= 3.24, Visual Studio 2022/2026 (C++ workload),
  and vcpkg (VCPKG_ROOT set). wxWidgets/GDAL/libarchive come from vcpkg.json.

  Long paths: OpenCPN's object tree overflows the legacy 260-char MAX_PATH, so
  the clone MUST live at a short root (default C:\h\ocpn) with core.longpaths on.
#>
[CmdletBinding()]
param(
  [string]$CloneDir     = "C:\h\ocpn",
  [string]$InstallRoot  = "C:\h\vi",   # vcpkg installed tree - MUST be short (MAX_PATH)
  [string]$Generator    = "Visual Studio 18 2026",
  [string]$Triplet      = "x64-windows",
  [switch]$Build,          # also try to build the helm-server target after configure
  [switch]$Clean          # wipe the clone first
)

# NOTE (Phase 0 finding): Windows' legacy 260-char MAX_PATH bites twice here -
# the OpenCPN git object tree AND vcpkg's installed include tree (e.g.
# openssl/opensslconf.h) overflow if rooted under a deep path. Keep BOTH the
# clone ($CloneDir) and the vcpkg install tree ($InstallRoot) at short roots.

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
function Say($m){ Write-Host "`n== $m" -ForegroundColor Cyan }
function Die($m){ Write-Host "FATAL: $m" -ForegroundColor Red; exit 1 }

# ---- prerequisites --------------------------------------------------------
Say "prerequisites"
foreach($t in "git","cmake"){ if(-not (Get-Command $t -ErrorAction SilentlyContinue)){ Die "$t not found on PATH" } }
$vcpkgRoot = $env:VCPKG_ROOT
if(-not $vcpkgRoot -or -not (Test-Path "$vcpkgRoot\vcpkg.exe")){ Die "VCPKG_ROOT not set or vcpkg.exe missing (need vcpkg for wxWidgets/GDAL)" }
$toolchain = Join-Path $vcpkgRoot "scripts\buildsystems\vcpkg.cmake"
"  repo:     $RepoRoot"
"  vcpkg:    $vcpkgRoot"
"  clone:    $CloneDir"

# ---- read pinned upstream (engine/vendor/OPENCPN_REF) ---------------------
Say "pinned upstream"
$ref = Get-Content (Join-Path $RepoRoot "engine\vendor\OPENCPN_REF")
$remote = ($ref | Where-Object { $_ -match "^OPENCPN_REMOTE=" }) -replace "^OPENCPN_REMOTE=",""
$sha    = ($ref | Where-Object { $_ -match "^OPENCPN_SHA=" })    -replace "^OPENCPN_SHA=",""
if(-not $sha){ Die "OPENCPN_SHA missing from OPENCPN_REF" }
"  $remote @ $sha"

# ---- fetch pinned SHA (shallow, long-paths on) ----------------------------
Say "fetch OpenCPN -> $CloneDir"
if($Clean){ Remove-Item -Recurse -Force $CloneDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $CloneDir | Out-Null
Push-Location $CloneDir
if(-not (Test-Path ".git")){
  git init -q
  git config core.longpaths true
  git config core.autocrlf input        # keep upstream LF so patches apply
  git remote add origin $remote 2>$null
}
if(git cat-file -e "$sha^{commit}" 2>$null){ "  pinned SHA already present" }
else { git -c core.longpaths=true fetch --depth 1 origin $sha }
git -c core.longpaths=true checkout -q --detach $sha
git -c core.longpaths=true reset --hard -q $sha
git -c core.longpaths=true clean -fdq -e build
if((git rev-parse HEAD) -ne $sha){ Die "checkout is not the pinned SHA" }

# ---- apply the maintained patch series ------------------------------------
Say "apply patch series"
$patches = Get-ChildItem (Join-Path $RepoRoot "engine\patches") -Filter "*.patch" |
           Where-Object { $_.Name -match '^\d{4}-' } | Sort-Object Name  # -Filter has no [0-9] classes
if($patches.Count -eq 0){ Die "no Helm patches found under engine/patches" }
foreach($p in $patches){
  git -c core.longpaths=true apply --check $p.FullName
  if($LASTEXITCODE -ne 0){ Die "patch does not apply on Windows: $($p.Name)" }
  git -c core.longpaths=true apply $p.FullName
  "  applied $($p.Name)"
}
foreach($t in "helm-server","helm-packd","helm-envd","helm-basemap-cache"){
  if(-not (Select-String -Path "$CloneDir\cli\CMakeLists.txt" -Pattern "add_executable\($t" -Quiet)){
    Die "patch series did not expose CMake target $t"
  }
}

# ---- overlay our NEW cli/ files -------------------------------------------
Say "overlay engine/vendor/cli -> cli/"
Get-ChildItem (Join-Path $RepoRoot "engine\vendor\cli") -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path "$CloneDir\cli" $_.Name) -Force
}
"  overlaid $((Get-ChildItem (Join-Path $RepoRoot 'engine\vendor\cli') -File).Count) files"

# ---- resolve deps + configure under MSVC ----------------------------------
Say "vcpkg install (wxWidgets 3.2 pinned, GDAL, libarchive) -> $InstallRoot"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
& "$vcpkgRoot\vcpkg.exe" install --x-manifest-root="$RepoRoot" --x-install-root="$InstallRoot" --triplet $Triplet
if($LASTEXITCODE -ne 0){ Die "vcpkg dependency install failed" }

Say "cmake configure ($Generator, $Triplet)"
# Phase 0 flags for the vcpkg (vs. classic OpenCPN-Windows) dependency layout:
#   OCPN_BUNDLE_WXDLLS=OFF  - vcpkg ships wx DLLs in bin/, not lib/; the classic
#                            bundle-glob fails. Irrelevant to the headless server.
#   OCPN_USE_EXTERN_CURL=ON - use vcpkg curl, not OpenCPN's bundled
#                            cache/buildwin/libcurl.lib (absent in a source clone).
$bld = "$CloneDir\build-win"
cmake -S $CloneDir -B $bld -G $Generator -A x64 `
  -DCMAKE_TOOLCHAIN_FILE="$toolchain" `
  -DVCPKG_TARGET_TRIPLET="$Triplet" `
  -DVCPKG_MANIFEST_MODE=OFF `
  -DVCPKG_INSTALLED_DIR="$InstallRoot" `
  -DOCPN_BUNDLE_WXDLLS=OFF `
  -DOCPN_USE_EXTERN_CURL=ON `
  -DOCPN_BUILD_TEST=OFF
if($LASTEXITCODE -ne 0){ Die "cmake configure FAILED - capture the log; this is the Phase 0 gate" }
Say "configure OK - build files in $bld"

if($Build){
  Say "cmake build helm-server (Release)"
  cmake --build $bld --config Release --target helm-server
  if($LASTEXITCODE -ne 0){ Die "helm-server build FAILED (expected pre-net_compat; capture errors)" }
  Say "helm-server built"
}
Pop-Location
Say "Phase 0 spike complete"

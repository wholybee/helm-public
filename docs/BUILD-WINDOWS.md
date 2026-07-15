# Build Helm on Windows (source)

Status: alpha / in progress. This builds the headless `helm-server` engine on
Windows from source, following OpenCPN's own **32-bit (Win32)** Windows
dependency model. Background and design: [proposals/WINDOWS-PORT.md](proposals/WINDOWS-PORT.md).

> Helm's engine targets (`helm-server`, ...) are built **inside** a patched
> OpenCPN tree, not as a separate step on top of OpenCPN. The bootstrap script
> fetches the pinned OpenCPN, applies Helm's patches, overlays Helm's `cli/`
> sources, provisions dependencies, and builds — `helm-server.exe` falls out of
> that one build.

## Prerequisites

| Requirement | Notes |
|---|---|
| **Visual Studio 2022 or 2026** | "Desktop development with C++" workload, **including the x86 (32-bit) build tools**. The prebuilt wxWidgets is `vc14x`; a v14x-family toolset (VS2015–2022) is the tested match — see [Toolset note](#toolset-note). |
| **Git** | Any recent version. |
| **CMake ≥ 3.24** | On `PATH`. |
| **7-Zip** | `7z` on `PATH` or installed at `C:\Program Files\7-Zip\7z.exe` (`choco install 7zip`). |
| Disk + network | ~2 GB free; first run downloads ~300 MB of prebuilt dependencies. |

No chocolatey, `wget`, or admin rights are required — the script downloads
dependencies natively and extracts them with 7-Zip.

## Build

From a fresh clone of this repository:

```powershell
scripts\windows\bootstrap.ps1
```

That single command:

1. **fetches** the pinned OpenCPN SHA (`engine/vendor/OPENCPN_REF`) into a short
   clone root (default `C:\h\ocpn` — short paths avoid Windows' 260-char limit);
2. **applies** Helm's patch series (`engine/patches`) and overlays
   `engine/vendor/cli` into the OpenCPN `cli/` directory;
3. **provisions** OpenCPN's Windows dependencies into `<clone>/cache`:
   prebuilt **wxWidgets 3.2.9** (vc14x, 32-bit) and the
   **OCPNWindowsCoreBuildSupport** bundle (GLEW, cairo, expat, OpenSSL, curl,
   …) — the same artifacts OpenCPN's own `buildwin/win_deps.bat` uses;
4. **configures** with CMake (`-A Win32`) and **builds** the `helm-server` target.

Useful switches:

```powershell
scripts\windows\bootstrap.ps1 -SkipDeps          # reuse an already-provisioned cache
scripts\windows\bootstrap.ps1 -Config Debug      # Debug build
scripts\windows\bootstrap.ps1 -Clean             # wipe the clone and start fresh
scripts\windows\bootstrap.ps1 -CloneDir D:\h\ocpn -Generator "Visual Studio 17 2022"
```

The result is `C:\h\ocpn\build-win\cli\Release\helm-server.exe`.

## Run

`helm-server.exe` needs the wxWidgets and bundle DLLs on `PATH`. The script
prints the exact line; it looks like:

```powershell
$env:PATH = "C:\h\ocpn\cache\wxWidgets-3.2.9\lib\vc14x_dll;C:\h\ocpn\cache\buildwin;" + $env:PATH
C:\h\ocpn\build-win\cli\Release\helm-server.exe --port 9001
```

Then open `http://127.0.0.1:9001/`. See [RUNBOOK.md](RUNBOOK.md) for chart data
(`HELM_ENC`), NMEA/SignalK input, and the feature-by-feature verification list —
those are cross-platform once the server runs.

## Notes & troubleshooting

- **Why 32-bit?** OpenCPN's maintained Windows build is Win32/x86 (prebuilt wx
  and the dependency bundle are 32-bit, and it vendors GDAL in-tree). Riding that
  path is far less fragile than assembling a bespoke x64 dependency set OpenCPN
  never tests. An x64 track is possible but is a separate effort — see
  [proposals/WINDOWS-PORT.md](proposals/WINDOWS-PORT.md).
- **<a id="toolset-note"></a>Toolset note (important).** The prebuilt wxWidgets
  is `vc14x`, and the **VS2022 (v143) toolset is the required match**. `bootstrap.ps1`
  auto-selects VS2022 when it is installed. **VS2026's newer toolset is not
  compatible**: it *links* against the vc14x wx but then **crashes on startup with
  an access violation inside `wxbase32u_vc14x.dll`** (a CRT/ABI mismatch). If you
  see that crash, install the "MSVC v143 — VS2022 C++ x64/x86 build tools"
  component (VS Installer) and re-run, or pass `-Generator "Visual Studio 17 2022"`.
- **Serial NMEA input** is not yet implemented on Windows (TCP/UDP/SignalK feeds
  work; serial returns a clear "not supported on Windows yet"). Bonjour/mDNS
  discovery is macOS-only.
- **Long paths.** Keep the clone at a short root. If you change `-CloneDir`, keep
  it near a drive root (e.g. `D:\h\ocpn`).
- **First-run downloads fail?** Check connectivity to `github.com` and
  `dl.cloudsmith.io`; re-run (downloads are cached under `<clone>/cache`).

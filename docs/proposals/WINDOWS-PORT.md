# Helm Native Windows Port — Scope & Plan

Status: Draft — Phase 0 + 1 done; Windows build strategy decided (2026-07-12)
Date: 2026-07-12
Scope: Port the `helm-server` C++ engine to build and run natively on Windows, and unify the build so the server opens and compiles from VSCode on Windows or Xcode on macOS.

> **Decision (2026-07-12):** Windows targets **32-bit (Win32), OpenCPN-native**.
> Helm rides OpenCPN's maintained Windows dependency model (prebuilt wxWidgets
> 3.2.9 + the OCPNWindowsCoreBuildSupport bundle + vendored GDAL) rather than a
> bespoke x64/vcpkg set OpenCPN never tests. The clone-and-compile entry point is
> [`scripts/windows/bootstrap.ps1`](../../scripts/windows/bootstrap.ps1); user
> instructions live in [docs/BUILD-WINDOWS.md](../BUILD-WINDOWS.md). This revises
> the Phase 0 x64/vcpkg spike (`vcpkg.json` + the engine `windows-msvc` preset are
> now the *alternative* x64 track, not the primary path); the Phase 1 `net_compat`
> shim is architecture-independent and applies unchanged.

## Purpose

The documented build/run path today is **macOS from source** ([../../README.md](../../README.md)).
The browser cockpit is already portable; the C++ engine is not. This document
scopes a **native Windows port** of `helm-server` (not a WSL workaround) with
the explicit end goal of a single cross-platform CMake project a developer can
open and build in **VSCode on Windows** or **Xcode on macOS** without hand-editing
a generated clone.

It is a scope and plan, not a claim that any of this is done yet. Phase 0 is a
risk gate: everything after it depends on OpenCPN + wxWidgets + GDAL building
clean under MSVC.

## Goal (definition of done)

- `helm-server` compiles and links natively on Windows (MSVC/`x64`) with no POSIX
  emulation layer (no WSL, no Cygwin runtime dependency).
- The same CMake project configures on macOS (AppleClang) and Windows (MSVC) from
  one `CMakePresets.json`; VSCode's CMake Tools and the CMake `Xcode` generator
  both consume it.
- `/health`, `/catalog`, and an S-52 `/chart/{z}/{x}/{y}.png` tile serve on Windows.
- The nav WebSocket stream ([../STREAMING-API.md](../STREAMING-API.md)) works on Windows.
- A `windows-latest` CI job guards the build against regression.

## Key architectural finding: the networking/rendering split

The port hinges on one fact about how the engine is layered.

- **Networking is hand-rolled on raw POSIX sockets**, *not* on wxWidgets.
  `helm_server.cpp` implements its own HTTP + WebSocket server directly on
  `socket`/`bind`/`accept`/`poll` — see the POSIX includes at
  [../../engine/vendor/cli/helm_server.cpp](../../engine/vendor/cli/helm_server.cpp) (`sys/socket.h`,
  `netinet/in.h`, `arpa/inet.h`, `poll.h`, `unistd.h`). This is the part that
  does **not** compile on Windows.
- **Rendering is already cross-platform, through wxWidgets.** The S-52 chart path
  uses `wxString` / `wxBitmap` / `wxImage` / `wxFileConfig`
  ([../../engine/vendor/cli/chart_spike.cpp](../../engine/vendor/cli/chart_spike.cpp),
  [../../engine/vendor/cli/chart_stubs.cpp](../../engine/vendor/cli/chart_stubs.cpp)).
  wxWidgets 3.2 builds on Windows, so once it links, the render path ports for
  essentially no code change. This is the hard half, and wx already carries it.

### Should wxWidgets replace the POSIX networking?

wxWidgets ships cross-platform sockets (`wxSocketServer` / `wxSocketBase`), and
because wx is already linked, using them adds no new dependency. **We recommend
against it**, for three concrete reasons:

1. **It only replaces the syscalls, not the protocol.** wxSocket gives you a
   cross-platform TCP socket but no HTTP and no WebSocket. The HTTP/WS parsing
   stays hand-rolled either way, so wxSocket touches only the bottom ~20% of the
   networking code.
2. **It forces a rewrite of working, tested code.** wxSocket is designed around
   the wx event loop; a headless server drives it in blocking mode and must
   re-express the current `poll()` accept loop in wxSocket's model. That is churn
   on code already covered by contract/smoke tests
   ([../../engine/contract-channels-smoke.js](../../engine/contract-channels-smoke.js),
   [../../engine/stream-smoke.js](../../engine/stream-smoke.js)).
3. **It is not built for server workloads.** wxSocket targets client-side and
   modest GUI use, not many-connection servers.

A third option — replacing the hand-rolled HTTP with a portable library such as
`cpp-httplib` (single-header, Win/Mac/Linux) — is also rejected: it has **no
WebSocket support**, and Helm streams nav over WS. It would add a dependency and
still leave the WS upgrade hand-rolled.

**Decision: introduce a thin platform socket-compat layer** (`net_compat.h`) that
maps the handful of primitives so the existing HTTP/WS server compiles unchanged
on both platforms. This keeps the tested I/O logic byte-identical and confines
Windows-ness to one header.

## What is already portable

| Concern | Status |
|---|---|
| Chart / S-52 rendering | Cross-platform via wxWidgets 3.2 (already a link dependency) |
| Threading | `std::thread` / `std::mutex` / `std::condition_variable` — no `pthread` in the server |
| Filesystem paths | Largely `std::filesystem` + read-only `std::getenv` |
| Web cockpit (`web/`) | Browser-native, already portable |
| `native/` client core | Already handles MSVC ([../../native/CMakeLists.txt](../../native/CMakeLists.txt)) and provides a `CMakePresets.json` model to copy |

## Port surface

The Windows-specific C++ is small and concentrated; the build system is the
larger lift.

### 1. Socket compat layer — new `net_compat.h`

A ~100-line header included by the six runtime binaries that open sockets. Call
sites: `helm_server.cpp` (~20), `helm_engine.cpp` (~7), `helm_basemap_cache.cpp`
(~4), `helm_packd.cpp` (~2), `helm_envd.cpp` (~2), `helm_tiles.cpp` (~1).

| POSIX | Windows |
|---|---|
| `<sys/socket.h>` `<netinet/in.h>` `<arpa/inet.h>` | `<winsock2.h>` `<ws2tcpip.h>` |
| implicit startup | `WSAStartup` / `WSACleanup` (once at boot) |
| `close(fd)` | `closesocket` |
| `poll()` | `WSAPoll` (drop-in) |
| `fcntl(..., O_NONBLOCK)` | `ioctlsocket(FIONBIO)` |
| `int` file descriptor | `SOCKET` typedef + `INVALID_SOCKET` sentinel |
| `SO_REUSEADDR` | `SO_REUSEADDR` (same; avoid `SO_REUSEPORT`) |

Link `ws2_32.lib` on Windows.

### 2. Filesystem shims (small)

- `::mkdir(path, 0700)` → `_mkdir(path)` on Windows
  ([../../engine/vendor/cli/helm_server.cpp](../../engine/vendor/cli/helm_server.cpp), the tide cache dir).
- `mmap` / `munmap` PMTiles reader → `CreateFileMapping` / `MapViewOfFile`
  ([../../engine/vendor/cli/helm_packd.cpp](../../engine/vendor/cli/helm_packd.cpp)). Confine behind the same
  accessor that already abstracts the mapped-vs-`pread` fallback.
- `gmtime_r` vs `gmtime_s` is **already** guarded
  ([../../engine/vendor/cli/helm_packd.cpp](../../engine/vendor/cli/helm_packd.cpp)) — a template for the rest.

### 3. Environment / paths

- The server only **reads** env (`std::getenv`) — no `setenv` to shim.
- `$HOME`-derived defaults (`~/.helm/...`) need a Windows fallback
  (`%USERPROFILE%` / `%LOCALAPPDATA%`). Centralize the runtime-root resolver.
- Prefer `std::filesystem::path` over string concatenation with `/` at any new
  path seams.

## Build-system unification (the "open and compile in either IDE" goal)

Today you cannot open the repo in an IDE and build the server — not because of
Windows, but because the server source does not fully exist in the tree.
[../../engine/bootstrap.sh](../../engine/bootstrap.sh) fetches a pinned OpenCPN SHA, applies the
[patch series](../../engine/patches), overlays `engine/vendor/cli/*.cpp` into the clone,
then runs CMake. The CMake project lives in the **generated clone**, driven by a
bash script with hardcoded Homebrew paths ([../../engine/bootstrap.sh](../../engine/bootstrap.sh)) and a
macOS `DYLD_LIBRARY_PATH` branch ([../../scripts/start-helm.sh](../../scripts/start-helm.sh)).

Three changes make "open folder → build" work in both IDEs on both OSes:

1. **Move fetch + patch into CMake.** Convert the git-clone + `git apply` +
   overlay into a CMake `FetchContent` / `ExternalProject` step with a
   `git apply` patch command (`git` behaves identically on Windows and macOS).
   A single `cmake --preset ...` then configures everything, with no bash
   required. This is the linchpin for the IDE story.
2. **Top-level `CMakePresets.json`** with `macos`, `windows-msvc`, and `linux`
   presets — the pattern [../../native/CMakePresets.json](../../native/CMakePresets.json) already
   establishes. VSCode CMake Tools reads presets natively; Xcode is produced via
   the `-G Xcode` generator preset. Both IDEs consume the same file.
3. **`vcpkg.json` dependency manifest** (`wxwidgets` pinned to a 3.2.x that still
   ships wxNode — 3.3 removed it, see [../../engine/bootstrap.sh](../../engine/bootstrap.sh) — plus
   `gdal`, `libarchive`). vcpkg resolves these on Windows; Homebrew keeps working
   on macOS, or use vcpkg on both for uniformity. This also retires the hardcoded
   `WX_CONFIG` Homebrew path and the `DYLD_LIBRARY_PATH`/`Darwin` special-casing.

## Phased plan

**⚠️ Phase 0 is a risk gate.** OpenCPN officially ships a Windows build, so
upstream *is* buildable under MSVC. What is unproven is whether the **pinned SHA
+ Helm patch series + the POSIX-assuming `cli/` targets** configure and compile
there. Prove that before committing to the rest.

| Phase | Work | Rough size |
|---|---|---|
| **0. Toolchain spike** | Build pinned OpenCPN + wx 3.2 + GDAL on Windows via vcpkg; confirm the patch series applies and the `cli/` targets configure under MSVC | ✅ **DONE 2026-07-12** — see execution log below |
| **1. Compile the server** | `net_compat.h` + `mkdir`/path shims; get `helm-server` linking on Windows; green the contract/smoke tests | ✅ **BUILDS + LINKS + STARTS 2026-07-14** (32-bit, VS2022 v143). One runtime bug remains: crash in S-52 data load — see log |
| **2. Unified build** | Fetch+patch into CMake; root `CMakePresets.json`; `vcpkg.json` → "open & build" in VSCode/Xcode | 3–4 days |
| **3. CI lock-in** | Add a `windows-latest` workflow (all current workflows are Ubuntu/macOS — nothing guards Windows) | 1–2 days |
| **4. Other daemons + scripts** | `helm-packd` `mmap`→`MapViewOfFile`; port or replace the bash `test-*.sh` / `start-helm.sh` launchers (PowerShell or a portable runner) | 1 week+ |

## Risks & open questions

- **OpenCPN + patches under MSVC (highest risk).** The patch series and the added
  `cli/` targets have only ever been exercised on the macOS toolchain. Line-ending
  and header-path assumptions in patches may need adjustment. Resolve in Phase 0.
- **wxWidgets 3.2 on Windows.** Must pin a 3.2.x with wxNode intact; confirm the
  vcpkg port matches, or fall back to official wxWidgets Windows binaries.
- **GDAL on Windows.** Heavy dependency; the vcpkg `gdal` port pulls a large
  transitive tree. Confirm the feature set the engine needs (ENC/S-57 drivers).
- **libarchive** runtime dependency (used on macOS via Homebrew) must resolve on
  Windows too.
- **Bash test harness.** The `engine/test-*.sh` and `scripts/*.sh` suites assume
  bash + `lsof`/`curl`. Phase 4 either ports them (PowerShell / portable runner)
  or scopes them as Git-Bash-only initially. Native Windows CI needs at least the
  core smoke tests runnable without bash.
- **Line endings.** Add/verify `.gitattributes` so patch files and shell scripts
  keep LF on Windows checkouts.

## Acceptance criteria

- `cmake --preset windows-msvc && cmake --build --preset windows-msvc` produces
  `helm-server.exe` from a clean Windows checkout with no manual clone editing.
- The same presets build on macOS; VSCode (Windows) and Xcode (macOS) both open
  and build the target.
- On Windows: `/health` returns 200, `/catalog` serves, one S-52 tile renders,
  and the nav WebSocket streams — the equivalent of the macOS bootstrap `--smoke`
  gate ([../../engine/bootstrap.sh](../../engine/bootstrap.sh)).
- A `windows-latest` CI job runs the build + core smoke on every push.

## Phase 0 execution log (2026-07-12)

First Phase 0 run, on a Windows 11 dev box. Scaffolding landed and the fast,
high-information gates were exercised directly.

### Environment

| Tool | Version |
|---|---|
| Visual Studio | Community 2026, 18.6 (MSVC 14.51.36231) |
| CMake | 4.3.2 (knows `Visual Studio 18 2026` generator) |
| vcpkg | 2026-05-27 (`VCPKG_ROOT=C:\dev\vcpkg`) |
| Git / Node | Git 2.x, Node present |

### Confirmed green

- **Patch series applies cleanly on Windows — 8/8.** `git apply --check` then
  `git apply` for `engine/patches/0001..0008` all succeeded on a fresh MSVC-side
  checkout. The line-ending risk did **not** materialize (`core.autocrlf=input`
  globally, plus LF-pinned patches). This was the top-ranked risk; it is retired.
- **CMake targets exposed — 4/4.** `helm-server`, `helm-packd`, `helm-envd`,
  `helm-basemap-cache` are all present in `cli/CMakeLists.txt` after patching.
- **cli overlay — 28/28 files** copy into the clone.
- **Toolchain compiles & runs repo C++.** The dependency-free `native/` core
  builds and tests **green under MSVC via the `windows-debug` preset**
  (`cmake --preset` → `--build --preset` → `ctest --preset`, 1/1 passed) — the
  exact path VSCode CMake Tools uses. The "open in VSCode on Windows and compile"
  goal is proven for the native core today.
- **GDAL 3.12.4** is already built in vcpkg and restores from the binary cache in
  milliseconds — the heaviest engine dependency is a non-issue on this box.

### Findings & mitigations

- **`MAX_PATH` (260-char) bites twice.** Both the OpenCPN git object tree and
  vcpkg's installed include tree overflow when rooted under a deep path — the
  first vcpkg attempt failed with `Cannot open include file 'openssl/opensslconf.h'`
  purely because the install root was nested too deep. Mitigation: keep the clone
  (`C:\h\ocpn`) **and** the vcpkg install tree (`C:\h\vi`) at short roots, set
  `git core.longpaths true`, and ship `.gitattributes` to hold LF. (Longer-term:
  enable Win32 long paths, or keep the engine build under a short drive root.)
- **wxWidgets version pin.** vcpkg mainline is **3.3.1**, which drops wxNode and
  is therefore incompatible with the pinned OpenCPN. **3.2.8.1** (latest 3.2.x,
  wxNode intact) is pinnable via `vcpkg.json` `overrides` + `builtin-baseline`.
  The manifest resolves and installs its dependency closure without version
  conflict.

### Artifacts added this run

- [`vcpkg.json`](../../vcpkg.json) — dependency manifest, wxWidgets pinned to 3.2.8.1.
- [`.gitattributes`](../../.gitattributes) — LF for patches/shell so the Windows checkout still applies patches.
- [`scripts/windows/spike-phase0.ps1`](../../scripts/windows/spike-phase0.ps1) — repeatable fetch → patch → overlay → vcpkg → configure spike.
- [`native/CMakePresets.json`](../../native/CMakePresets.json) — `windows-debug` / `windows-release` presets (verified building).

### The decisive gate — PASSED ✅

**OpenCPN + the full Helm patch series + the cli overlay + wxWidgets 3.2.8.1 +
GDAL 3.12.4 configures cleanly under MSVC (VS 2026) and generates a buildable
Visual Studio project tree** — `Configuring done` / `Generating done`, exit 0.

- wxWidgets **3.2.8.1** resolved with every component OpenCPN needs
  (`core base gl aui html adv net xml richtext`; only the optional `webview`
  add-on absent). GDAL and curl resolved from vcpkg.
- All **21 Helm target projects generated**, including `helm-server.vcxproj`,
  `helm-packd`, `helm-envd`, `helm-basemap-cache`, `helm-engine`, `helm-tiles`,
  `helm-chartrender`, the tide stack, and the symbol/atlas tools.
- wxWidgets 3.2.8.1 built via vcpkg in **9.6 min** (binary cache warm).

**Two flags were required**, both simply because we use vcpkg rather than
OpenCPN's classic bundled-Windows-binary layout — neither implies engine changes:

| Flag | Why |
|---|---|
| `-DOCPN_BUNDLE_WXDLLS=OFF` | OpenCPN's GUI DLL-bundling step globs wx DLLs from `wxWidgets_LIB_DIR`; vcpkg puts DLLs in `bin/`, not `lib/`. Irrelevant to the headless server. |
| `-DOCPN_USE_EXTERN_CURL=ON` | Switches from OpenCPN's bundled `cache/buildwin/libcurl.lib` (absent in a source clone) to `find_package(CURL)` → vcpkg's curl (already pulled in by GDAL). |

The remaining `Could NOT find …` lines (webview, Shapelib, LibSndfile, Jasper,
LibUSB) are all optional and non-fatal.

**Interpretation.** The two hardest unknowns going into Phase 0 — "do the patches
apply on Windows?" and "does OpenCPN + wx 3.2 + GDAL configure under MSVC?" — are
both answered **yes**, with no engine source changes. The engine's Windows
problem is now confined to the code layer the scope already predicted: the POSIX
socket/`mmap` calls, which the **Phase 1** `net_compat` shim addresses. Building
`helm-server` (as opposed to configuring it) is expected to fail at those POSIX
includes until Phase 1 lands — that is the next step, not a Phase 0 gap.

### How to reproduce

```powershell
# Requires: VS 2022/2026 (C++), CMake, Git, vcpkg (VCPKG_ROOT). ~10 min cold.
scripts\windows\spike-phase0.ps1
```

The script fetches the pinned OpenCPN SHA, applies the patch series, overlays
`engine/vendor/cli`, installs deps via `vcpkg.json` (wx pinned to 3.2.8.1), and
configures under MSVC with the two flags above. Keep the clone and vcpkg install
tree at short roots (`C:\h\ocpn`, `C:\h\vi`) — see the `MAX_PATH` finding.

## Phase 1 execution log (2026-07-12)

### The shim — DONE and validated on MSVC ✅

The cross-platform seam is in place and proven to compile and run under MSVC
(VS 2026), standalone, before touching the full engine build:

- **`engine/vendor/cli/net_compat.h`** — raw-socket shim. Maps the POSIX socket
  surface (`socket`/`bind`/`listen`/`accept`/`connect`/`poll`/`close`/nonblock/
  `recv`/`SO_*`) to Winsock2, and provides `helm_net::init()` (WSAStartup, once).
  Include-ordering guard pulls `<winsock2.h>` before any `<windows.h>`/wx header.
- **`engine/vendor/cli/plat_compat.h`** — file/process helpers (`popen`→`_popen`,
  `access`→`_access`, a portable temp-path helper).
- **`helm_server.cpp`** rewired: the 3 socket helpers (`tcp_connect`,
  `tcp_server_accept`, `udp_bind`) and the fd-carrying feed functions now use a
  `helm_net::sock_t` + `helm_net::BAD_SOCK` sentinel; `::mkdir`→`std::filesystem`,
  `mkstemp`/`::unlink`→portable, serial (termios) guarded to POSIX with a Windows
  stub, Bonjour (`dns_sd`) guarded to Apple, `_USE_MATH_DEFINES` for `M_PI`, and
  `ix::initNetSystem()` + `helm_net::init()` in `main()`.

Key architecture fact confirmed: the HTTP/WebSocket server rides **IXWebSocket**
(vendored in OpenCPN at `libs/IXWebSocket`, already Winsock-capable), so the raw
POSIX sockets were only the NMEA/AIS feed paths — a small, contained surface.

A standalone MSVC compile (`cl /std:c++17 /W3`) of both headers + every helper
built clean and ran (`sizeof(sock_t)=8`; temp/access/popen all work).

### New blocker (Phase 0 provisioning gap, not shim code) ⛔

Building the **full** `helm-server` compiles OpenCPN's own libraries first, and
that stops in `geoprim` with:

```
LLRegion.cpp(40): fatal error C1083: Cannot open include file: 'glew.h'
```

OpenCPN's Windows build expects a prebuilt **dependency cache** at
`cache/buildwin/` (GLEW, cairo, expat, OpenSSL, crashrpt, wxWidgets locale, VC
runtime DLLs — see `CMakeLists.txt:661` and `cmake/OcpnFind*.cmake`). A source
clone does not contain it; OpenCPN's own `buildwin/winConfig.bat` downloads it:

```
https://github.com/OpenCPN/OCPNWindowsCoreBuildSupport/archive/refs/tags/v0.5.zip
```

Phase 0's *configure* gate passed without this because the headers are only read
at *compile* time. So this is a **Phase 0 toolchain-provisioning gap**, distinct
from the Phase 1 shim (which is done). `helm_server.cpp` itself was never reached
by the failed build — its full-engine compile is gated behind provisioning this
cache (or teaching the headless targets to take GLEW/cairo/expat from vcpkg
instead of OpenCPN's bundled Windows layout).

**Next step:** provision `cache/buildwin/` (fetch OpenCPN's
`OCPNWindowsCoreBuildSupport` bundle, or redirect the headless targets' GLEW/
cairo/expat to vcpkg), then resume the `helm-server` build and iterate on any
remaining `helm_server.cpp` compile errors.

## Phase 1 result — helm-server.exe builds, links, and starts on Windows (2026-07-14)

The full 32-bit OpenCPN-native path works end to end through process startup:

- **Builds + links**: `scripts\windows\bootstrap.ps1` produces `helm-server.exe`
  (7 MB, 32-bit) from a clean checkout. OpenCPN's own code compiled clean in
  32-bit MSVC; every issue was in Helm's small overlay TUs.
- **Starts + runs**: the exe launches, initializes wxWidgets, loads all DLLs, and
  (with no chart data) prints the correct graceful message
  `s52plib load FAILED — missing S-52 presentation library … set HELM_S57_DATA`,
  then exits cleanly — identical to macOS behavior without data.

### Fixes required to get there (all in Helm's overlay TUs; OpenCPN core was clean)

| File | Fix |
|---|---|
| `net_compat.h` / `plat_compat.h` | new — Winsock socket shim + popen/access/temp helpers |
| `helm_server.cpp` | sockets → shim, `mkdir`/`unlink`/`mkstemp` → `std::filesystem`, serial + Bonjour guarded, `_USE_MATH_DEFINES`, `ix::initNetSystem()` |
| `chart_stubs.cpp` | `DECL_EXP` on the plugin-API stub definitions; guard the 9 that `api_shim.cpp` also provides on MSVC |
| `helm_tides.cpp` | `stat`/`S_ISDIR`/`mkdir` → `std::filesystem` |
| `helm_tides_stubs.cpp` | weak fallback stubs deferred to chart-render on MSVC (no `__attribute__((weak))`) |
| `cli/CMakeLists.txt` (patch 0003) | `helm-server` links `api_shim.cpp` (49 plugin-API vtable symbols MSVC won't dead-strip) + `psapi` |

### Toolset finding

The prebuilt wxWidgets is **vc14x** → build with the **VS2022 (v143)** toolset.
VS2026's newer toolset links but is not the tested match. `bootstrap.ps1` now
prefers VS2022 automatically.

### Known open issue — S-52 load crash (next task)

With `HELM_S57_DATA` pointed at real S-52 data, startup gets past the "no data"
path and then **crashes (access violation) inside `wxbase32u` at a fixed offset**
during S-52 presentation-library loading — **deterministic and identical on both
the VS2022 and VS2026 builds**, so it is a genuine Windows-specific bug in the
chart-data load path (parsing `chartsymbols.xml` / reading `S52RAZDS.RLE`), not a
toolset/ABI issue. Basic wx init is fine (the no-data path is clean). Next step:
get a stack trace (Debug build with symbols, or WinDbg/cdb) to localize it; a
prime suspect is a binary file opened in text mode or a bad `wxString` handed to
wxbase in the headless S-52 init.

## Related

- [TARGET-SERVICE-ARCHITECTURE.md](TARGET-SERVICE-ARCHITECTURE.md) — target C++ service boundaries
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — headless server + thin client boundary
- [../RUNBOOK.md](../RUNBOOK.md) — current macOS build & run
- [../STREAMING-API.md](../STREAMING-API.md) — nav WebSocket contract the port must preserve
- [../PROJECT-STATUS.md](../PROJECT-STATUS.md) — lists "improve Linux and Windows build notes" as wanted work

# Runtime License Register and Native Distribution Posture

Tracked as `NATIVE-12`.

This register completes the license posture that
[CLIENT-LICENSE-REGISTER.md](CLIENT-LICENSE-REGISTER.md) deliberately leaves
out: the boat-side runtime, OpenCPN/GPL boundary, GDAL/OGR/PROJ clean-room
path, native packaging rule, and distribution attribution checklist.

This is an engineering compliance artifact, not legal advice. Any paid public
distribution, preloaded appliance, or App Store/native binary launch still
requires IP-counsel sign-off.

## Bottom Line

As of 2026-07-05 on `origin/main` `0893bba098f1fba3d8dcc8b84c7dba814cc83ad2`:

- Helm-authored source in this repo is under root
  [LICENSE.BSL](../LICENSE.BSL), with Change License Apache-2.0 on the
  stated change date, unless a file or third-party component says otherwise.
- OpenCPN-derived engine work remains GPLv2-or-later. Helm does not relicense
  OpenCPN code.
- The GPL engine is contained in standalone boat-side executables and speaks
  HTTP/WebSocket protocols to browser/native clients. See
  [ADR-0009](decisions/0009-arms-length-gpl-containment.md) and
  [`engine/containment-check.sh`](../engine/containment-check.sh).
- Browser, WKWebView, and native Apple clients must not embed OpenCPN,
  wxWidgets, `engine/vendor`, `helm-server`, `helm-engine`,
  `libhelm-chartrender.a`, or any other GPL engine artifact.
- GDAL/OGR/PROJ are allowed for data tooling and remain the strategic
  clean-room chart-rendering path, but they do not launder OpenCPN source,
  S-52 rule expression, or GPL-derived renderer code into Helm-owned code.
- Third-party dependencies and data sources keep their own licenses and
  attribution duties. This file is the runtime companion to root
  [NOTICE](../NOTICE), [LEGAL.md](LEGAL.md), and the client register.

## Distribution Surfaces

| Surface | What ships | Current license posture | Release rule |
|---|---|---|---|
| Source checkout | Mixed Helm-authored code, docs, OpenCPN patch inputs, third-party references | Multi-license: BSL for Helm-authored work; GPLv2-or-later for OpenCPN-derived work; third-party terms preserved | Keep root `LICENSE`, `LICENSE.BSL`, `NOTICE`, and both license registers current. |
| Boat runtime / appliance | `helm-server`, `helm-engine`, `helm-tiles`, `helm-packd`, `helm-envd`, support files | GPL obligations apply to OpenCPN-derived engine binaries; Helm-authored runtime services are BSL unless separately marked | Provide/point to complete corresponding source for GPL engine work; include notices and do not add GPL-incompatible restrictions. Counsel before paid appliance. |
| Browser client served by boat server | `web/` static assets and vendored browser bundles | BSL for Helm code; permissive third-party bundles; no GPL today | Must pass the audit in `CLIENT-LICENSE-REGISTER.md`; GPL/LGPL/AGPL dependencies are rejected. |
| WKWebView proof / native Apple clients | Native shell plus Helm native client seam | Checked-in native source is Helm-authored BSL unless marked otherwise; no GPL/wx/OpenCPN engine embed | Client speaks only documented HTTP/WebSocket protocol. App Store path must keep engine off-device. |
| Serverless phone-only chartplotter | Not implemented | Requires clean-room chart/render stack with no OpenCPN code on device | Do not promise or ship until clean-room path and counsel review are complete. |
| Hosted/cloud services | Hosted Helm service implementation | Helm-owned service terms; deployment-specific | Do not bundle restricted data sources; preserve user-data privacy and source attribution. |

## Runtime Dependency and Attribution Register

| Component | Runtime role | License / source posture | Boundary and required action |
|---|---|---|---|
| OpenCPN `model/`, S-57/S-52 renderer, and adapted patch series | Navigation model, AIS/route/track/persistence, chart tile renderer | GPLv2-or-later | Stays in boat-side engine executables. Source must remain available for distributed engine builds. Do not link into clients. |
| wxWidgets 3.2 | OpenCPN engine dependency | wxWindows/wxWidgets license terms | Engine-side only. Native clients must not link wx or include wx/OpenCPN headers. |
| OpenCPN S-57/S-52 assets and data tables | Engine-side chart portrayal data | OpenCPN/GPL-compatible distribution posture | Keep with engine/runtime data, not in client-owned clean-room symbol packs unless provenance explicitly permits. |
| Vulkan/OpenCPN render-core POC | Shared renderer proof / future backend seam | GPL-compatible/OpenCPN-side boundary for OpenCPN-derived renderer semantics | Follow [VULKAN-RENDER-LICENSE-BOUNDARY.md](VULKAN-RENDER-LICENSE-BOUNDARY.md). Helm consumes protocol/artifact outputs, not GPL renderer code in clients. |
| GDAL / OGR / PROJ | Data tooling and possible clean-room chart pipeline | Permissive MIT/X-style family; verify exact package notices before distribution | Allowed in tooling and future clean-room service work. It is not a substitute for clean-room provenance of S-52/S-101 rules or symbol assets. |
| SQLite | Local metadata, MBTiles, nav object stores | Public-domain/project-specific SQLite notice | Used by engine/runtime services. Preserve any bundled notices if statically packaged. |
| ixwebsocket | C++ HTTP/WebSocket services | Third-party dependency from the OpenCPN/Helm build stack; verify and preserve upstream notice in packaged builds | Runtime-service dependency only. Include notice in binary/appliance bundle material. |
| RapidJSON | C++ JSON parsing/writing | MIT-style RapidJSON license; verify bundled upstream notice | Runtime-service dependency only. Include notice when bundled. |
| libarchive / zlib / libpng and image/archive libraries | OpenCPN/runtime image/archive support | Third-party library terms vary by build source | Verify exact linked libraries with the release build and include notices if bundled. |
| OpenSSL command-line tool | Local development TLS certificate generation | External tool, not linked by `helm-server` in current path | Do not treat CLI availability as linked dependency. Production TLS packaging needs its own review. |
| MapLibre, PMTiles, deck.gl, Terra Draw, browser plugins | Browser client rendering and interaction | Permissive, audited in `CLIENT-LICENSE-REGISTER.md` | Client-side register owns details and bump audits. |
| Noto Sans glyph atlases | Browser font glyphs | SIL Open Font License 1.1 | Keep font attribution in `NOTICE` and client register. |
| NOAA ENC / NCDS | Chart data source | US public-domain source | Courtesy attribution recommended. User-provided chart cells remain user data. |
| Copernicus Sentinel data | Imagery source | Free/commercial-OK with attribution | Public builds using it need visible "Contains modified Copernicus Sentinel data [Year]" attribution. |
| OpenStreetMap / OpenSeaMap | Places and seamark overlays | ODbL | Overlay only; preserve attribution/share-alike duties. Not a primary chart. |
| Restricted commercial sources | Google, Bing, Esri, Navionics, Windy, PredictWind | Contract/ToS restricted | Do not bundle, cache, host, scrape, or redistribute unless `LEGAL.md` says a signed agreement permits it. |

## GPL / GDAL Boundary

There are two chart-rendering paths and they must not blur:

1. **Current OpenCPN-derived engine path.** This is the fast, correct path for
   real S-52/S-57 behavior today. It is GPLv2-or-later and remains a separate
   boat-server process. Clients consume `/nav`, `/chart/{z}/{x}/{y}.png`,
   `/catalog`, and `/health`; they do not link or embed the engine.
2. **Future clean-room GDAL/OGR/PROJ path.** This is the relicensing-insurance
   path for a serverless/on-device chartplotter or clean-room commercial
   renderer. It may use permissive geospatial libraries, but it must not copy,
   translate, trace, or encode OpenCPN source expression, S-52 renderer logic,
   OpenCPN raster symbol assets, or GPL-derived portrayal tables. It needs its
   own provenance, fixtures, attribution, and counsel review.

The practical rule: GDAL/OGR/PROJ can help parse and transform chart data, but
it does not by itself solve S-52/S-101 portrayal provenance. Clean-room chart
semantics require clean-room inputs and documented review.

## Native Packaging Rules

These rules apply before `NATIVE-13` notarized DMG work, any iOS/iPadOS App
Store build, or any appliance image:

1. Native clients speak only the documented JSON/WebSocket and PNG/HTTP
   protocol.
2. Native client build products must not contain OpenCPN headers, wxWidgets,
   `engine/vendor`, `helm-server`, `helm-engine`, `helm-tiles`,
   `libhelm-chartrender.a`, or OpenCPN S-57/S-52 assets.
3. macOS packaging may launch/connect to a separate engine process, but must
   preserve process separation and source/notice obligations for the engine.
4. iOS/iPadOS packaging must keep the GPL engine off the device. The supported
   path is a thin network client to a boat-side server.
5. Any App Store, paid, or preloaded appliance distribution must carry a
   counsel-reviewed license/notice bundle and user-facing safety disclaimer.

The engine guard is `engine/containment-check.sh`. The macOS DMG path added by
`NATIVE-13` has a native-side companion check in
[`native/macos/package-macos-dmg.sh`](../native/macos/package-macos-dmg.sh):
before it signs or creates a DMG, it rejects client bundles that contain
OpenCPN/wx/engine artifacts or link forbidden engine dependencies.

## Release Checklist

Before a public alpha, paid distribution, preloaded appliance, or native binary
release:

- Re-run the audit commands in
  [CLIENT-LICENSE-REGISTER.md](CLIENT-LICENSE-REGISTER.md).
- Run `engine/containment-check.sh` against the built engine output.
- Run `scripts/check-runtime-inventory.py` and the HELMC++ acceptance gates for
  required runtime services.
- Refresh root [NOTICE](../NOTICE) for bundled runtime libraries, fonts, data
  sources, sample packs, and native client dependencies.
- Verify the exact release build's linked/bundled libraries with platform
  tools (`otool -L`, package manifests, app bundle contents, installer
  contents).
- For hardware or appliance distribution, refresh
  [NATIVE-REFERENCE-HARDWARE.md](NATIVE-REFERENCE-HARDWARE.md) with the exact
  compute, display, power chain, data gateway, evidence level, and sea-trial
  status.
- Confirm no restricted data source from [LEGAL.md](LEGAL.md) is bundled,
  cached, or hosted without a signed agreement.
- Preserve all user-supplied chart, imagery, route, weather, and private boat
  data outside public release artifacts.
- Get IP-counsel sign-off for BSL wording, GPL boundary, App Store/native
  distribution, and any paid commercial launch.

## Open Items

- Counsel sign-off remains open for commercial GPL-engine distribution,
  BSL/Additional Use Grant wording, native client packaging, and appliance
  distribution.
- Exact binary notices for the release build must be generated from the
  release artifact, not guessed from a development machine.
- Future clean-room S-52/S-101 work must record source provenance for IHO,
  OpenBridge, Esri, NOAA, and any other portrayal/symbol sources before runtime
  promotion.
- Native packaging containment checks must be extended to future iOS/iPadOS,
  appliance, and multi-tier package outputs after those tasks produce final
  installable artifacts.

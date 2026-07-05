# Native Reference Hardware, Appliance Power, and Sea-Trial Plan

Tracked as `NATIVE-15`.

This document defines Helm's internal reference-hardware certification path for
the native/appliance lane: candidate hardware, DC power and UPS expectations,
and the parallel sea-trial plan that lets Helm earn trust next to OpenCPN.

This is not regulatory certification, not type approval, and not permission to
use Helm as primary navigation. "Certified" in this file means
"reference-qualified for Helm testing at the named evidence level."

## Bottom Line

As of 2026-07-05 on `origin/main`
`15e5380075870f30726ecdbd532ef33bafaf711f`:

- Helm's first reference appliance path is an Apple Silicon Mac mini running the
  boat-side C++ Helm server and the macOS native client, connected to a
  sunlight-readable marine touch display.
- The Mac mini reference is an AC-input computer. Do not bypass or modify its
  power inlet for a DC hack. A boat install must use a marine-safe DC power
  chain that presents approved AC power to the Mac mini, or remain a lab-only
  candidate until an electrical design is reviewed.
- A Raspberry Pi 5 or industrial Linux mini-PC can be a low-power C++ runtime
  candidate later, but it is not the native macOS appliance path.
- OpenCPN remains the primary navigation system during every Helm trial. Helm
  runs in parallel from the same data feed and is evaluated against OpenCPN,
  instruments, official charts, and watchkeeping.
- No hardware bundle is "reference certified" until the evidence log says which
  level passed, on which vessel, with which software SHA and hardware revision.

## Certification Levels

| Level | Name | Meaning | Minimum evidence |
|---|---|---|---|
| L0 | Candidate | Reasonable hardware shape, not yet trusted | Spec review, safety/power risks documented, no purchase recommendation beyond lab use |
| L1 | Bench-certified | Builds, boots, and survives controlled bench tests | 24 hour run, cold boot, warm restart, local network reconnect, package/install check, logs archived |
| L2 | Dock-certified | Works at the dock from real boat power and boat data | 4 hour dock run on boat DC path, GNSS/AIS/depth/feed visible, OpenCPN running in parallel |
| L3 | Underway-certified | Works underway without replacing OpenCPN | 3 separate daylight trips, 10 total underway hours, no critical crash, stale/offline states visible |
| L4 | Passage-candidate | Ready for longer non-primary passage evaluation | One overnight or 100 nm run, power events handled, post-run OpenCPN/Helm comparison reviewed |

Promotion is monotonic per exact hardware revision. Changing the display,
power chain, storage, OS major version, data gateway, or Helm runtime branch
returns the bundle to the lowest affected level until the delta is tested.

## Reference Hardware Matrix

| ID | Role | Candidate baseline | Current level | Evidence still needed |
|---|---|---|---|---|
| `H-MAC-1` | Primary macOS reference compute | Current Apple Silicon Mac mini, 16 GB+ memory, 512 GB+ SSD, Ethernet enabled, macOS current enough for Xcode/native client support | L0 | Bench run, thermal observation, helm-server + HelmMac install, OpenCPN side-by-side run |
| `H-DISP-1` | Helm-station touch display | 10-15 inch marine or rugged HDMI/USB touch display, 1000 nit class daylight readability, IP65 or better enclosure claim, VESA mount, dimming, glove/wet-touch behavior tested | L0 | Sunlight, night dimming, rain/spray, touch accuracy, USB reconnect after sleep |
| `H-PWR-MAC-1` | Mac mini boat power chain | Boat 12/24 V DC -> fused/isolated power conditioning -> approved inverter or AC UPS output -> Mac mini AC inlet | L0 | Brownout test, low-voltage cutoff, clean shutdown, thermal check, fused install review |
| `H-PWR-DC-1` | DC-native runtime power chain | Boat 12/24 V DC -> isolated DC-DC UPS -> regulated 5 V USB-C PD or device-native DC output | L0 | Applies to Raspberry Pi/industrial candidates, not direct Mac mini input |
| `H-IO-1` | Boat-data gateway | SignalK or NMEA gateway that can feed OpenCPN and Helm simultaneously without Helm controlling the primary feed | L0 | Feed split verified, timestamped NMEA/SignalK capture, loss/reconnect behavior |
| `H-STOR-1` | Local data storage | Internal SSD plus optional external SSD for chart/basemap packs, mounted read-only where practical during trials | L0 | Offline chart-pack replay, restart after unclean power, no private data in release artifacts |
| `H-PI-1` | Low-power C++ runtime candidate | Raspberry Pi 5 class board, active cooling, 5 V/5 A USB-C PD supply, RTC, SSD/NVMe, Ethernet | L0 | HELMC++ runtime parity on device, thermal and power testing, no native macOS client assumption |

External spec anchors are intentionally minimal and must be refreshed before a
purchase or public appliance claim:

- Apple Mac mini technical specs:
  <https://support.apple.com/en-us/121555>
- Raspberry Pi 5 product page:
  <https://www.raspberrypi.com/products/raspberry-pi-5/>
- IEC ingress-protection overview:
  <https://www.iec.ch/ip-ratings>

## Reference Bundles

### Bundle A: BYO Alpha Workstation

Purpose: developer and tester setup only.

- User-owned Mac or laptop.
- Private Helm server port.
- Browser cockpit and optional native macOS client.
- No appliance enclosure, no underway certification, no resale claim.

Required status text: "BYO alpha workstation, supplemental only."

### Bundle B: Mac Mini Helm Station

Purpose: first real boat helm-station candidate.

- `H-MAC-1` compute.
- `H-DISP-1` display.
- `H-PWR-MAC-1` power chain.
- `H-IO-1` data gateway.
- OpenCPN installed and visible as the primary reference.
- Helm server and client installed from reviewed release artifacts.

Required status text until L3: "Parallel evaluation station, not primary
navigation."

### Bundle C: DC-Native Low-Power Runtime

Purpose: future low-cost or always-on runtime candidate after C++ runtime
parity is proven on target hardware.

- `H-PI-1` or industrial mini-PC.
- `H-PWR-DC-1` power chain.
- Browser/native thin clients over LAN.
- No claim that this replaces the Mac mini native packaging path.

Required status text until L3: "Low-power runtime candidate, supplemental
only."

## Power and UPS Rules

Electrical installation is a safety boundary. A reference build must satisfy
all of these before it can move beyond L0:

- Fuse the boat DC feed close to the source and document fuse size, wire gauge,
  cable length, and breaker/switch location.
- Use isolated DC-DC conversion or a marine-rated inverter/AC UPS path
  appropriate for the target computer. Do not feed unregulated boat DC into
  consumer electronics.
- Add low-voltage cutoff so Helm cannot drain the house bank below the vessel's
  operating policy.
- Provide enough hold-up time for an orderly shutdown after brownout or engine
  start sag. Target 5 minutes minimum for lab certification and 10 minutes for
  underway certification.
- Log power events with timestamp, input voltage if available, and shutdown
  reason.
- Prove restart behavior after hard power loss and after orderly shutdown.
- Keep display power and compute power on documented circuits so a display
  reboot does not silently kill the boat server.
- Keep cable strain relief, vibration mount, ventilation, salt/humidity
  exposure, and service access in the evidence photos.

Mac mini note: Apple's current Mac mini specification lists AC line-voltage
input. The Helm reference path must preserve that boundary unless a future
electrical design is explicitly reviewed and documented. A DC-DC UPS can still
be part of the upstream boat-power chain, but the Mac mini must see approved
AC input in the reference bundle.

Raspberry Pi note: Raspberry Pi 5 class candidates require a high-quality 5 V,
5 A USB-C PD supply and active cooling. Undersized USB power bricks are not
reference hardware.

## Parallel OpenCPN Sea-Trial Protocol

Helm earns trust by running next to OpenCPN, not by replacing it early.

### Trial Setup

Before departure:

- Record Helm branch, commit SHA, package source, and `helm-server --version`
  or build metadata.
- Record OpenCPN version, chart set, active plugins, and configuration snapshot.
- Confirm official paper/electronic charts, instruments, and watchkeeping are
  the primary navigation sources.
- Split or mirror GNSS, AIS, depth, heading, wind, and route data so Helm and
  OpenCPN observe the same feed without Helm controlling OpenCPN.
- Start a timestamped NMEA/SignalK capture when legally and practically
  possible.
- Take photos of the helm layout, display brightness, power wiring, and
  enclosure ventilation.
- Mark Helm UI with the short safety warning from `SAFETY.md`.

### Trial Phases

| Phase | Duration | Conditions | Pass bar |
|---|---|---|---|
| Bench | 24 hours | Shore power or bench supply, simulated/recorded data | No critical crash, restart works, stale/offline states visible |
| Dock | 4 hours | Vessel power, real instruments, no underway risk | Feed parity with OpenCPN, no brownout corruption, display readable at berth |
| Harbor | 2+ hours | Daylight, familiar water, low workload | Ownship, COG/SOG, AIS count, and route state agree within instrument/data-source tolerance |
| Coastal | 6+ hours | Mixed speed/turns/weather, still non-primary | No unplanned restart, alarms/stale states visible, operator can switch to OpenCPN immediately |
| Passage | Overnight or 100 nm | Only after prior phases pass | Power/thermal/logging survive; post-run review finds no critical nav disagreement |

Any restricted-water, night, bad-weather, traffic-separation, reef, pass, bar,
or landfall use remains OpenCPN/instrument/official-chart primary. Helm may be
observed, but a Helm discrepancy never becomes the basis for a navigation
decision during alpha.

### Comparison Log

Create one log per run with this shape:

```text
trial_id:
date_utc:
vessel:
crew:
helm_sha:
helm_artifact:
opencpn_version:
hardware_bundle:
power_chain:
display:
data_sources:
charts:
route_or_area:
weather:
duration:
power_events:
network_events:
helm_restarts:
opencpn_restarts:
observed_disagreements:
operator_actions:
screenshots_or_video:
raw_data_capture:
result: candidate | pass | pass_with_notes | fail
reviewer:
```

Disagreement examples to log:

- position, COG/SOG, heading, depth, AIS target, CPA/TCPA, waypoint, XTE, ETA,
  alarm, stale/offline, or chart portrayal differs enough for the operator to
  notice;
- Helm hides stale/missing data that OpenCPN or instruments still show;
- Helm shows a chart, overlay, route, or advisory that could mislead a user if
  treated as primary.

## Release and Appliance Gates

No public hardware or appliance claim ships until all gates pass:

- `NATIVE-13` DMG path is green, and public DMGs are Developer ID signed,
  notarized, and stapled.
- `NATIVE-12` license registers and root `NOTICE` are refreshed for the exact
  appliance artifact.
- HELMC++ required-runtime gates pass for every daemon included in the bundle.
- `engine/containment-check.sh` passes against the built engine output.
- `H-PWR-*` evidence includes shutdown and brownout tests.
- Trial log reaches at least L2 before any dockside tester receives the bundle,
  and L3 before any underway tester receives it.
- IP counsel reviews GPL distribution, BSL wording, notices, warranty language,
  and any paid/preloaded appliance terms.

## Open Items

- Pick exact display vendor/model candidates and record brightness, IP rating,
  touch technology, viewing angles, dimming range, and mounting evidence.
- Decide whether the first Mac mini reference build uses inverter plus AC UPS,
  a marine AC circuit, or a reviewed integrated DC-to-AC power module.
- Add a small runtime power-event logger once the selected UPS/power module is
  known.
- Attach the first completed bench and dock trial logs to this document or a
  release-specific evidence folder.

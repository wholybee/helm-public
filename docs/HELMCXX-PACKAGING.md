# HELMC++ packaging and install proof

Status: HELMC++-6 packaging proof for the boat-side C++ runtime.

This document proves the install shape for the required C++ runtime. It is
separate from the NATIVE-13 macOS DMG, which packages the thin `HelmMac` client
and deliberately does not bundle OpenCPN, wxWidgets, or the boat server.

## Acceptance claim

The supported boat-runtime install path is:

1. build the C++ runtime with `engine/bootstrap.sh`;
2. install the built binaries, web cockpit, and durable S-52/tide assets with
   `scripts/install-helmcxx-runtime.sh`;
3. supervise the installed binaries as a reboot-persistent stack — the installer
   generates and enables `systemd` units (Linux) or `launchd` plists (macOS) for
   the resolved layout, in `--system` or `--user` mode;
4. put user-owned ENC, MBTiles/PMTiles, and environmental packs in deterministic
   runtime directories;
5. run smoke checks on private ports before enabling a live boat port.

The install path does not require Docker, a Python daemon, a virtual
environment, or build output left under a temporary checkout. Python may still be
used by developer/test/offline-bake tooling as allowed by
`docs/HELMCXX-ACCEPTANCE.md`; it is not part of the supervised runtime path here.

## Deterministic directories

The default install directories are intentionally conventional and boring:

| Path | Purpose |
|---|---|
| `/opt/helm/bin` | Installed C++ runtime binaries: `helm-server`, `helm-packd`, `helm-envd`, `helm-basemap-cache`. |
| `/opt/helm/web` | Static browser cockpit served by `helm-server`. |
| `/etc/helm` | Runtime config and generated `helm-runtime.env`. |
| `/var/lib/helm/runtime` | Durable runtime assets such as `s57data`, `tcdata`, and user-installed ENC cells. |
| `/var/lib/helm/data` | User-owned overlays and generated data exposed through `/user-data/`. |
| `/var/cache/helm` | Regenerable SENC, tide, basemap-fill, tile, and service caches. |
| `/var/log/helm` | Runtime logs for supervised services. |
| `/srv/helm/packs` | User-owned MBTiles/PMTiles packs served by `helm-packd`. |
| `/srv/helm/wx-packs` | Baked `helm.env.grid.v1` environmental pack releases for `helm-envd`. |

For CI and local review, `scripts/install-helmcxx-runtime.sh --staging-root
<dir>` prepends a staging root to every destination while preserving the target
paths in the generated runtime environment. That is how the proof can verify the
install shape without requiring root privileges.

## macOS fresh-machine path

Install prerequisites and build:

```sh
brew install wxwidgets@3.2 gpatch cmake libarchive libusb libsndfile mpg123 lame openssl@3 gdal node
engine/bootstrap.sh --smoke
scripts/install-sample-enc.sh
```

Install the C++ runtime as a reboot-persistent supervised stack. Pick a model:

**System service (boat appliance — starts at boot, no login, needs root):**

```sh
sudo scripts/install-helmcxx-runtime.sh --system
```

Installs binaries to `/opt/helm`, generates launchd `LaunchDaemons` for the
resolved paths, and `launchctl bootstrap`s all four daemons. `RunAtLoad` +
`KeepAlive` make them survive reboot and crash.

**Per-user (app foundation — no root, reboot-persists on login):**

```sh
scripts/install-helmcxx-runtime.sh --user
```

Installs everything under `~/.helm/opt`, writes launchd `LaunchAgents` to
`~/Library/LaunchAgents`, and bootstraps them into your GUI session. This is the
layout a double-click `.app` bundle wraps. To dogfood against charts/packs you
already have instead of copying them, point the install at them:

```sh
scripts/install-helmcxx-runtime.sh --user \
  --enc "$HOME/.helm/runtime/enc/US5GA2BC/US5GA2BC.000" \
  --mbtiles-dir "$HOME/.helm/charts/fiji" \
  --serve-web "$HOME/.helm/live/web"
```

Use `--no-supervision` to install files only, or `--staging-root DIR` to render
everything (including units) into a staging tree without touching the live
service manager. Upgrades are atomic (see below) and restarts go through the
supervisor:

```sh
# macOS
launchctl kickstart -k gui/$(id -u)/com.6thelement.helm-server   # --user
sudo launchctl kickstart -k system/com.6thelement.helm-server    # --system
```

Smoke:

```sh
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/catalog
curl -fsS http://127.0.0.1:8091/catalog
```

For public macOS distribution, the thin native client follows
`native/macos/package-macos-dmg.sh --notarize`. The boat-side runtime remains a
separate process/package with GPL/OpenCPN source and notice obligations. A
signed runtime installer package is allowed, but it must keep this process
separation and pass the same smoke checks before any release claim.

## Linux and Raspberry-Pi-style path

Install toolchain and dependencies through the target distro packages, then build
with the same source path:

```sh
engine/bootstrap.sh --smoke
scripts/install-sample-enc.sh
sudo useradd --system --home /var/lib/helm --shell /usr/sbin/nologin helm || true
sudo scripts/install-helmcxx-runtime.sh --system
sudo chown -R helm:helm /etc/helm /var/lib/helm /var/cache/helm /var/log/helm /srv/helm
```

`--system` on Linux generates hardened systemd units (`User=helm`,
`ProtectSystem`, `NoNewPrivileges`, `EnvironmentFile=/etc/helm/helm-runtime.env`)
into `/etc/systemd/system`, runs `daemon-reload`, and `systemctl enable --now`s
all four so they start on boot. For a rootless per-user service set (`systemctl
--user`, units under `~/.config/systemd/user`) use `--user` instead.

`helm-envd` reads `HELM_ENV_GRID_MANIFESTS` (defaulted to
`<wx-packs>/current/current.manifest.json`) and serves pre-baked packs from disk —
no weather API key is needed to *serve* (the key is only for the offline bake).
Because envd resolves a manifest's chunk paths relative to the manifest file's own
directory, the stable pointer is a `current` symlink to the live release's packs
dir plus a stable-named `current.manifest.json` inside it; the bake/publish step
maintains both and `launchctl kickstart`/`systemctl restart`s envd after a new
release. A fresh install has no packs yet — envd starts and serves nothing until
weather is baked. `helm-basemap-cache` is idle unless online-fill or remote-pack
cache policy is configured.

Smoke:

```sh
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/catalog
curl -fsS http://127.0.0.1:8091/catalog
sudo systemctl stop helm-packd.service helm-server.service
```

## Proof command

The cheap CI-safe proof is:

```sh
scripts/helmcxx-packaging-proof.sh
```

It verifies the install script, service templates, deterministic directories, and
the absence of Docker/Python/temp-path runtime dependencies in the packaging
artifacts. It also stages a fake install tree and confirms the generated runtime
environment contains target paths rather than build-machine paths.

After a real `engine/bootstrap.sh`, run the fuller smoke:

```sh
scripts/helmcxx-packaging-proof.sh --run-smoke
```

That installs the real C++ binaries into a staging root, starts `helm-server` and
`helm-packd` on private ports, checks `/health`, core `/catalog`, local pack
`/catalog`, and shuts the processes down cleanly. It never uses the shared
`:8080` screen.

## Weather refresh

`helm-envd` only *serves* pre-baked packs; something has to *bake* them on a
cadence. That is a packaged, OS-scheduled job — not a shell loop. Pass a weather
env file (with at least `HELM_WX_OPENMETEO_KEY`) and the installer schedules it:

```sh
scripts/install-helmcxx-runtime.sh --user --wx-env-file ~/.helm/wx/.env
```

This bundles the **whole bake chain** self-contained under `<prefix>` —
`wx_refresh_once.py`, `boat_anchor.py`, `wx_bake_openmeteo.py`, `wx_pack_factory.py`,
`env_grid_pack.py`, and the `services/wx/fixtures/wx-openmeteo-source.json`
source-spec (the tools resolve each other and their fixtures by `__file__`, so the
mirrored layout just works) — writes the key to a `0600` `helm-wx.env`, and
generates a periodic unit: a launchd `StartInterval` agent (macOS) or a systemd
`.timer` (Linux), default every 6h (`--wx-interval SECS`). Each firing runs one
`wx_refresh_once.py` cycle: resolve the anchor (`HELM_WX_ANCHOR` override > live
GPS via `boat_anchor.py`, drift-gated > previous release), bake a fresh release,
publish the stable `current/current.manifest.json` pointer, and restart the
supervised `helm-envd`. The OpenMeteo key stays only in the `0600` env file —
never in a service unit. Omit `--wx-env-file` and `helm-envd` is still supervised;
it just serves whatever packs already exist.

## Controlling the stack

The installer also drops a single control script, `<prefix>/bin/helmctl`, so you
manage the whole stack with one command instead of touching each unit:

```sh
helmctl start      # bring the stack up
helmctl stop       # take it down
helmctl restart    # bounce all daemons
helmctl status     # per-daemon health + pids
```

It wraps the OS supervision (launchd / systemd) for the resolved layout, which it
reads from `<prefix>/etc/helmctl.env`. Reboot-persistence still comes from the
units themselves; `helmctl` is the human-facing control over them.

## Upgrading a running install

Replace runtime binaries **atomically** — never overwrite a running/mmap'd binary
in place. On macOS, a plain in-place `cp` over a binary that is currently running
(or was, and is still mapped by a supervisor's respawn) poisons the kernel's
cached code signature for that file's vnode; every subsequent `exec` is then
killed with `OS_REASON_CODESIGNING` (symptom: processes stuck in uninterruptible
`UE` state, 0 CPU, empty log, unkillable until reboot — even though `codesign -v`
reports the on-disk file as valid). `scripts/install-helmcxx-runtime.sh` does this
correctly: it copies to a temp path beside the destination and `mv`s it into place,
giving the destination a fresh inode.

Stop the service through its supervisor before (or after) the swap, and restart it
through the supervisor rather than launching a second copy by hand — a manual
launch races a `KeepAlive`/`Restart=always` respawn, and two concurrent chart
inits on the same runtime state wedge both. On systemd:

```sh
sudo systemctl stop helm-server.service
sudo scripts/install-helmcxx-runtime.sh
sudo systemctl start helm-server.service
```

On a launchd-managed macOS install, restart with
`launchctl kickstart -k gui/$(id -u)/<label>` rather than a manual `nohup`.

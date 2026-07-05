# Helm quickstart

This is the public-alpha path for macOS source builds:

```bash
git clone https://github.com/StevenRidder/Helm.git
cd Helm
brew install wxwidgets@3.2 gpatch cmake libarchive libusb libsndfile mpg123 lame openssl@3 gdal node python3
engine/bootstrap.sh
scripts/install-sample-enc.sh
scripts/start-helm.sh --port 9001 --fill
open http://127.0.0.1:9001/
```

What this does:

- `engine/bootstrap.sh` builds the C++ one-origin `helm-server` and installs durable runtime data
  under `~/.helm/runtime`.
- `scripts/install-sample-enc.sh` downloads a free NOAA sample ENC cell into
  `~/.helm/runtime/enc`.
- `scripts/start-helm.sh --port 9001 --fill` starts Helm on a private local port and serves the
  browser cockpit, `/health`, `/catalog`, `/nav`, and `/chart/...png` from the C++ server.

Do not use `:8080` in shared development environments. Use `9001` or another private port.

## Confirm It Worked

```bash
curl -s http://127.0.0.1:9001/health | python3 -m json.tool
curl -s http://127.0.0.1:9001/catalog | python3 -m json.tool
```

Expected:

- `/health` reports `"engine": "helm-server"`;
- `/health` includes a `chart_loaded` field;
- `/catalog` returns chart inventory JSON;
- the browser opens at `http://127.0.0.1:9001/`.

The UI can load without live boat data. To see movement, connect NMEA 0183, SignalK, or another
configured input after the server is running. Helm must not invent a fake live position.

## Smoke Test

For a full fresh-machine proof, run:

```bash
scripts/launch1-quickstart-smoke.sh
```

That creates an isolated HOME, installs the sample ENC, runs the bootstrap smoke, starts
`helm-server` on a private port, and checks `/health`, `/catalog`, and the UI root.

For a faster local check after you already built `helm-server`:

```bash
HELM_OCPN_DIR="$HOME/.helm/build/helm-opencpn" \
  scripts/launch1-quickstart-smoke.sh --skip-bootstrap
```

## Common Failures

`helm-server not built`

Run:

```bash
engine/bootstrap.sh
```

`no ENC chart found`

Run:

```bash
scripts/install-sample-enc.sh
```

`wx-config not executable`

Install wxWidgets 3.2, not 3.3:

```bash
brew install wxwidgets@3.2
```

`C toolchain cannot compile`

Accept the Xcode license or switch to Command Line Tools:

```bash
sudo xcodebuild -license accept
sudo xcode-select -s /Library/Developer/CommandLineTools
```

`port already serving /health`

Pick another private port:

```bash
scripts/start-helm.sh --port 9002 --fill
open http://127.0.0.1:9002/
```

## Next

- Add your own NOAA ENC cells with `HELM_ENC=/path/to/CELL.000 scripts/start-helm.sh --port 9001`.
- Add your own MBTiles/PMTiles packs with `HELM_MBTILES_DIR=/path/to/packs scripts/start-helm.sh --port 9001 --basemap`.
- Read [RUNBOOK.md](RUNBOOK.md) for weather, basemaps, NMEA/SignalK, and deeper verification.

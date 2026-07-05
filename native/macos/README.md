# Helm macOS native client

`HelmMac` is the first NATIVE-4 macOS client slice. It is a SwiftUI/AppKit app that speaks the
documented Helm boat-server protocol over the local network:

- discovers `_helm._tcp` Bonjour services and supports a manual `127.0.0.1:9001` fallback;
- opens `/nav` with `URLSessionWebSocketTask`;
- sends `hello`, `conn.list`, and `conn.upsert`;
- configures a macOS serial/USB NMEA input using the CONN-9 contract:
  `type="serial"`, `address="/dev/cu.*"`, and `port=<baud>`.

The app does not link OpenCPN, wxWidgets, `engine/vendor`, or the GPL engine. The boat-side
`helm-server` remains the safety core and owns persisted connections at `~/.helm/connections.json`.

## Build

```sh
native/macos/build-macos-client.sh
```

The script builds on a private DerivedData path under `native/macos/build`, with signing disabled.
It does not start a Helm server and never touches the shared live `:8080` screen.

For an end-to-end manual check, start a private server first:

```sh
scripts/start-helm.sh --port 9001
```

Then run the `HelmMac` scheme in Xcode or open the built app from
`native/macos/build/Build/Products/Debug/HelmMac.app`.

## DMG packaging and notarization

`NATIVE-13` adds the non-App-Store macOS distribution path:

```sh
native/macos/package-macos-dmg.sh
```

By default the script builds the Release app, verifies the app bundle does not
contain OpenCPN/wx/engine artifacts, ad-hoc signs it for local package-shape
checks, and writes a DMG under `native/macos/dist/`. That local DMG is not a
public release artifact.

For a real Developer ID build, first store notary credentials in the macOS
keychain:

```sh
xcrun notarytool store-credentials helm-notary \
  --apple-id "$APPLE_ID" \
  --team-id "$TEAM_ID" \
  --password "$APP_SPECIFIC_PASSWORD"
```

Then build, sign, submit, and staple:

```sh
HELM_MACOS_SIGN_IDENTITY="Developer ID Application: 6th Element Labs (TEAMID)" \
HELM_MACOS_NOTARY_PROFILE=helm-notary \
native/macos/package-macos-dmg.sh --notarize
```

The DMG contains `HelmMac.app`, an `/Applications` shortcut, and the current
license/safety notices. It does not bundle `helm-server`, OpenCPN, wxWidgets,
or chart-rendering engine artifacts; the app remains a thin client to a
boat-side Helm server.

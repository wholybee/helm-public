#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"

PROJECT="$ROOT/HelmMac.xcodeproj"
SCHEME="${HELM_MACOS_SCHEME:-HelmMac}"
CONFIGURATION="${HELM_MACOS_CONFIGURATION:-Release}"
DERIVED_DATA="${HELM_MACOS_DERIVED_DATA:-$ROOT/build}"
DIST_ROOT="${HELM_MACOS_DIST_ROOT:-$ROOT/dist}"
STAGE_DIR="$DERIVED_DATA/dmg-stage"
APP_PATH="$DERIVED_DATA/Build/Products/$CONFIGURATION/$SCHEME.app"
APP_BUNDLE_NAME="${HELM_MACOS_APP_BUNDLE_NAME:-HelmMac.app}"

SIGN_IDENTITY="${HELM_MACOS_SIGN_IDENTITY:-}"
NOTARY_PROFILE="${HELM_MACOS_NOTARY_PROFILE:-}"
APPLE_ID="${HELM_MACOS_APPLE_ID:-}"
APPLE_TEAM_ID="${HELM_MACOS_TEAM_ID:-}"
APPLE_PASSWORD="${HELM_MACOS_APP_PASSWORD:-}"

SKIP_BUILD=0
NOTARIZE=0
OUTPUT_PATH=""

usage() {
  cat <<'USAGE'
Usage: native/macos/package-macos-dmg.sh [options]

Build the HelmMac Release app, verify it is a thin client, create a DMG, and
optionally submit/staple Apple notarization.

Options:
  --skip-build              Reuse an existing Release app in native/macos/build.
  --identity NAME           Developer ID Application identity for codesign.
  --notary-profile NAME     notarytool keychain profile to use with --notarize.
  --notarize                Submit the DMG to Apple notarytool and staple it.
  --output PATH             Write the DMG to this path.
  -h, --help                Show this help.

Environment:
  HELM_MACOS_SIGN_IDENTITY  Developer ID Application identity.
  HELM_MACOS_NOTARY_PROFILE notarytool keychain profile.
  HELM_MACOS_APPLE_ID       Apple ID fallback for notarytool.
  HELM_MACOS_TEAM_ID        Team ID fallback for notarytool.
  HELM_MACOS_APP_PASSWORD   App-specific password fallback for notarytool.

Without --notarize the script ad-hoc signs when no Developer ID identity is
provided. That local DMG is useful for CI/package-shape checks, but it is not a
public release artifact.
USAGE
}

log() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    --identity)
      shift
      SIGN_IDENTITY="${1:-}"
      [[ -n "$SIGN_IDENTITY" ]] || die "--identity requires a value"
      ;;
    --notary-profile)
      shift
      NOTARY_PROFILE="${1:-}"
      [[ -n "$NOTARY_PROFILE" ]] || die "--notary-profile requires a value"
      ;;
    --notarize)
      NOTARIZE=1
      ;;
    --output)
      shift
      OUTPUT_PATH="${1:-}"
      [[ -n "$OUTPUT_PATH" ]] || die "--output requires a value"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found"
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$ROOT/HelmMac/Info.plist"
}

version="$(plist_value CFBundleShortVersionString)"
build_number="$(plist_value CFBundleVersion)"
git_sha="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$DIST_ROOT/HelmMac-$version-$build_number-$git_sha.dmg"
fi

require_tool xcodebuild
require_tool codesign
require_tool hdiutil
require_tool ditto
require_tool otool

if (( NOTARIZE )); then
  require_tool xcrun
  if [[ -z "$SIGN_IDENTITY" || "$SIGN_IDENTITY" == "-" ]]; then
    die "--notarize requires HELM_MACOS_SIGN_IDENTITY or --identity with a Developer ID Application certificate"
  fi
  if [[ -z "$NOTARY_PROFILE" && ( -z "$APPLE_ID" || -z "$APPLE_TEAM_ID" || -z "$APPLE_PASSWORD" ) ]]; then
    die "--notarize requires HELM_MACOS_NOTARY_PROFILE or HELM_MACOS_APPLE_ID/HELM_MACOS_TEAM_ID/HELM_MACOS_APP_PASSWORD"
  fi
fi

if (( ! SKIP_BUILD )); then
  log "Building $SCHEME $CONFIGURATION"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -sdk macosx \
    -derivedDataPath "$DERIVED_DATA" \
    CODE_SIGNING_ALLOWED=NO \
    build
fi

[[ -d "$APP_PATH" ]] || die "expected app bundle missing: $APP_PATH"
binary_path="$APP_PATH/Contents/MacOS/$SCHEME"
[[ -x "$binary_path" ]] || die "expected app executable missing: $binary_path"

log "Checking native client containment"
forbidden_found=0
while IFS= read -r -d '' forbidden_path; do
  printf '%s\n' "$forbidden_path" >&2
  forbidden_found=1
done < <(
  find "$APP_PATH" \
    \( -iname '*opencpn*' \
    -o -iname '*wxwidgets*' \
    -o -iname '*wx*.dylib' \
    -o -name 'engine' \
    -o -name 'vendor' \
    -o -name 'helm-server' \
    -o -name 'helm-engine' \
    -o -name 'helm-tiles' \
    -o -name 'libhelm-chartrender.a' \
    \) -print0
)
if (( forbidden_found )); then
  die "client bundle contains GPL/runtime artifacts"
fi

if otool -L "$binary_path" | grep -Eiq 'opencpn|wxwidgets|libwx|helm-server|helm-engine|helm-tiles|chartrender'; then
  otool -L "$binary_path" >&2
  die "client executable links a forbidden engine/OpenCPN/wx dependency"
fi

if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="-"
fi

log "Signing $APP_BUNDLE_NAME with ${SIGN_IDENTITY}"
sign_args=(--force --options runtime --sign "$SIGN_IDENTITY")
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  sign_args+=(--timestamp)
fi
codesign "${sign_args[@]}" "$APP_PATH"
codesign --verify --strict --verbose=2 "$APP_PATH"

log "Staging DMG"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/Legal" "$DIST_ROOT"
ditto "$APP_PATH" "$STAGE_DIR/$APP_BUNDLE_NAME"
ln -s /Applications "$STAGE_DIR/Applications"
cp "$REPO_ROOT/LICENSE" "$STAGE_DIR/Legal/LICENSE"
cp "$REPO_ROOT/LICENSE.BSL" "$STAGE_DIR/Legal/LICENSE.BSL"
cp "$REPO_ROOT/NOTICE" "$STAGE_DIR/Legal/NOTICE"
cp "$REPO_ROOT/SAFETY.md" "$STAGE_DIR/Legal/SAFETY.md"
cp "$REPO_ROOT/docs/CLIENT-LICENSE-REGISTER.md" "$STAGE_DIR/Legal/CLIENT-LICENSE-REGISTER.md"
cp "$REPO_ROOT/docs/RUNTIME-LICENSE-REGISTER.md" "$STAGE_DIR/Legal/RUNTIME-LICENSE-REGISTER.md"

log "Creating DMG $OUTPUT_PATH"
rm -f "$OUTPUT_PATH"
hdiutil create \
  -volname "Helm Mac" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  "$OUTPUT_PATH"
hdiutil verify "$OUTPUT_PATH"

if [[ "$SIGN_IDENTITY" != "-" ]]; then
  log "Signing DMG with ${SIGN_IDENTITY}"
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$OUTPUT_PATH"
  codesign --verify --verbose=2 "$OUTPUT_PATH"
fi

if (( NOTARIZE )); then
  log "Submitting DMG for notarization"
  notary_args=(notarytool submit "$OUTPUT_PATH" --wait)
  if [[ -n "$NOTARY_PROFILE" ]]; then
    notary_args+=(--keychain-profile "$NOTARY_PROFILE")
  else
    notary_args+=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD")
  fi
  xcrun "${notary_args[@]}"

  log "Stapling notarization ticket"
  xcrun stapler staple "$OUTPUT_PATH"
  xcrun stapler validate "$OUTPUT_PATH"
fi

log "Wrote $OUTPUT_PATH"

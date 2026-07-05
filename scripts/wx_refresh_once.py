#!/usr/bin/env python3
"""One weather bake+publish cycle for helm-envd (packaged, OS-scheduled).

This replaces the machine-local refresh.sh while-true loop: it runs ONE cycle and
exits. A launchd StartInterval (macOS) or systemd timer (Linux) — both generated
by scripts/install-helmcxx-runtime.sh — repeats it on cadence. No shell daemon.

One cycle:
  1. resolve the bake anchor: HELM_WX_ANCHOR override > live GPS via boat_anchor.py
     (drift-gated) > previous release centre (LOUD). No fix and no previous release
     -> skip (exit 0).
  2. bake a fresh helm.env.grid.v1 release with wx_bake_openmeteo.py.
  3. publish the stable fallback pointer: <packs>/current -> release packs dir, and
     <packs>/current/current.manifest.json -> packs[0] inside it (envd resolves chunk
     paths relative to the manifest's own directory, so the pointer must preserve that
     directory). The supervised helm-envd launches via helm-envd-launch, which expands
     current.json into EVERY pack manifest (atmospheric + marine current/swell/waves),
     so this single pointer is only the graceful fallback if that expansion fails.
  4. restart the supervised helm-envd on the new release.

Config (env, all optional): HELM_WX_PACKS_DIR, HELM_WX_LAYERS, HELM_WX_STEP_HOURS,
HELM_WX_ANCHOR, HELM_WX_FRAMES, HELM_WX_CONNECTIONS, HELM_ENVD_LABEL (launchd),
HELM_ENVD_UNIT (systemd), HELM_WX_OPENMETEO_KEY (commercial bake host).
"""
import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def log(msg):
    sys.stderr.write("wx-refresh: %s\n" % msg)


def load_env_file(path):
    # Read KEY=VAL lines (the OpenMeteo key + tuning) into the environment. Kept in
    # a 0600 file so the secret never lives in a service unit. Explicit env wins.
    if not path:
        return
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())
    except OSError:
        pass


def default_packs_dir():
    return os.environ.get("HELM_WX_PACKS_DIR") or str(Path.home() / ".helm" / "live" / "web" / "wx-packs")


def max_frames(step):
    # 3h-aligned frames that fit the measured 240h marine horizon (from today 00Z).
    now = datetime.datetime.now(datetime.timezone.utc)
    snap = now.hour - now.hour % step
    return (237 - snap) // step + 1


def previous_anchor(out):
    # Centre of the previous release's route-high coverage, as "lon,lat".
    try:
        base = Path(out)
        cur = json.loads((base / "current.json").read_text())
        release = json.loads((base / cur["indexUrl"]).read_text())
        b = release["packs"][0]["coverage"]["bbox"]
        return "%.1f,%.1f" % ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)
    except (OSError, ValueError, KeyError, IndexError):
        return None


def resolve_anchor(out, connections):
    manual = os.environ.get("HELM_WX_ANCHOR")
    if manual:
        log("anchor %s (HELM_WX_ANCHOR override)" % manual)
        return manual
    try:
        r = subprocess.run(
            [sys.executable, str(HERE / "boat_anchor.py"), "--packs-dir", out, "--connections", connections],
            capture_output=True, text=True, timeout=90)
        if r.stderr:
            sys.stderr.write(r.stderr)
        if r.returncode == 0 and r.stdout.strip():
            log("anchor %s (live GPS, drift-gated)" % r.stdout.strip())
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        log("boat_anchor failed: %s" % e)
    prev = previous_anchor(out)
    if prev:
        log("WARNING no live GPS fix - reusing previous release anchor %s" % prev)
        return prev
    return None


def publish_and_restart(out):
    base = Path(out)
    cur = json.loads((base / "current.json").read_text())
    idx = base / cur["indexUrl"]
    release = json.loads(idx.read_text())
    # packs[0] backs the single-pointer FALLBACK only. helm-envd-launch loads EVERY
    # pack in the release from current.json; this stable symlink is what envd falls
    # back to if that expansion ever fails (serves atmospheric rather than nothing).
    first_manifest = (idx.parent / release["packs"][0]["manifestUrl"]).resolve()
    packs_dir = first_manifest.parent

    current = base / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(packs_dir)
    stable = packs_dir / "current.manifest.json"
    if stable.is_symlink() or stable.exists():
        stable.unlink()
    stable.symlink_to(first_manifest.name)
    log("published %s -> %s" % (current, packs_dir))

    if sys.platform == "darwin":
        label = os.environ.get("HELM_ENVD_LABEL", "com.6thelement.helm-envd")
        subprocess.run(["launchctl", "kickstart", "-k", "gui/%d/%s" % (os.getuid(), label)], check=False)
    else:
        unit = os.environ.get("HELM_ENVD_UNIT", "helm-envd.service")
        subprocess.run(["systemctl", "--user", "restart", unit], check=False)


def main():
    load_env_file(os.environ.get("HELM_WX_ENV_FILE", ""))
    out = default_packs_dir()
    layers = os.environ.get("HELM_WX_LAYERS", "wind,rain,waves,swell,current")
    step = int(os.environ.get("HELM_WX_STEP_HOURS", "3"))
    connections = os.environ.get("HELM_WX_CONNECTIONS") or str(Path.home() / ".helm" / "connections.json")

    anchor = resolve_anchor(out, connections)
    if not anchor:
        log("BAKE SKIPPED - no live fix and no previous release to anchor on")
        return 0

    frames = os.environ.get("HELM_WX_FRAMES") or str(max_frames(step))
    log("baking %s frames @ %sh into %s" % (frames, step, out))
    r = subprocess.run(
        [sys.executable, str(HERE / "wx_bake_openmeteo.py"),
         "--anchor", anchor, "--layers", layers, "--frames", str(frames),
         "--step-hours", str(step), "--out", out])
    if r.returncode != 0:
        log("BAKE FAILED - previous release stays current (atomic publish)")
        return r.returncode

    publish_and_restart(out)
    log("weather refresh cycle complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())

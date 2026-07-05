"""
Optional HTTP client for Helm C++ engine facts consumed by the Python backend.

The backend is non-safety and must degrade honestly when helm-server is absent.
"""
from __future__ import annotations

import os
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlencode

import httpx

from agents import UA


def engine_origin() -> str:
    return os.environ.get("HELM_ENGINE_URL", "http://127.0.0.1:8080").rstrip("/")


def get_tides_summary(lat: float, lon: float, t: Optional[str] = None) -> Dict[str, Any]:
    """Fetch engine-backed tide prediction at a point and time."""
    params = {"lat": lat, "lon": lon}
    if t:
        params["time"] = t
    url = "%s/tides/summary?%s" % (engine_origin(), urlencode(params))
    try:
        response = httpx.get(url, headers=UA, timeout=5)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "engineUrl": engine_origin(),
            "trace": "backend.engine_client.get_tides_summary",
        }
    if not isinstance(payload, dict):
        return {
            "ok": False,
            "error": "invalid tides summary payload",
            "engineUrl": engine_origin(),
            "trace": "backend.engine_client.get_tides_summary",
        }
    payload.setdefault("trace", "helm-server:/tides/summary")
    payload.setdefault("engineUrl", engine_origin())
    return payload


def tides_summary_provider(
    fetcher: Callable[[float, float, Optional[str]], Dict[str, Any]] = get_tides_summary,
):
    def provider(lat: float, lon: float, t: Optional[str] = None) -> Dict[str, Any]:
        return fetcher(lat, lon, t)

    return provider

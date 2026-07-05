"""
Default backend probe layers for Helm's spacetime context resolver.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

import store
from agents import get_weather
from engine_client import tides_summary_provider

from probe_contract import LayerSample, ProbeLayer, ProbeRegistry, SampleRequest


SUPPLEMENTAL = "Supplemental advisory data; verify with official charts and onboard instruments."


def _source_ref(product_id: str, dataset_name: str, producer: str, **extra) -> Dict[str, Any]:
    ref = {
        "productId": product_id,
        "datasetName": dataset_name,
        "producer": producer,
    }
    ref.update({k: v for k, v in extra.items() if v is not None})
    return ref


def valid_at(weather: dict, t: Optional[str]):
    series = weather.get("next") or []
    if not t or not series:
        return weather.get("now"), None
    chosen = next((h for h in series if h.get("t") and h["t"] >= t), series[-1])
    return chosen, chosen.get("t")


class WeatherProbeLayer(ProbeLayer):
    layer_id = "weather"
    product_id = "weather.open-meteo.forecast"
    dataset_name = "Open-Meteo point forecast"
    producer = "Open-Meteo"

    def __init__(self, weather_provider: Callable[[float, float], dict] = get_weather):
        self.weather_provider = weather_provider

    def sample(self, req: SampleRequest) -> LayerSample:
        weather = self.weather_provider(req.lat, req.lon)
        wx_at, wx_time = valid_at(weather, req.t)
        error = weather.get("windError") or weather.get("seaError")
        value = {
            "validAt": wx_time,
            "atTime": wx_at,
            "now": weather.get("now"),
            "sea": weather.get("sea"),
            "sst": weather.get("sst"),
            "current": weather.get("current"),
            "series": weather.get("next"),
            "horizon": "good ~0-7d; beyond is climatology",
            "error": error,
        }
        return LayerSample(
            layer=self.layer_id,
            status="not_available" if error and not (wx_at or weather.get("sea")) else "ok",
            value=value,
            source="open",
            source_ref=_source_ref(
                self.product_id,
                self.dataset_name,
                self.producer,
                title="Open-Meteo",
                url="https://open-meteo.com",
                referenceDate=weather.get("fetchedAt"),
                trace="backend.agents.get_weather",
            ),
            freshness=weather.get("fetchedAt") or "forecast",
            valid_time=wx_time,
            confidence="forecast",
            horizon="good ~0-7d; beyond is climatology",
            coverage={"status": "point"},
            trace="probe:weather",
            not_for_navigation=True,
            disclaimer=SUPPLEMENTAL,
            note=error,
        )


class ClimateProbeLayer(ProbeLayer):
    layer_id = "climate"
    product_id = "climate.noaa.pilot"
    dataset_name = "Seasonal and cyclone climatology"
    producer = "NOAA"

    def sample(self, req: SampleRequest) -> LayerSample:
        value = {
            "note": "Seasonal & cyclone context (climatology tier - stub).",
            "source": {"title": "NOAA climatology / pilot charts", "url": "https://www.noaa.gov", "kind": "open"},
        }
        return LayerSample(
            layer=self.layer_id,
            status="not_implemented",
            value=value,
            source="open",
            source_ref=_source_ref(
                self.product_id,
                self.dataset_name,
                self.producer,
                title="NOAA climatology / pilot charts",
                url="https://www.noaa.gov",
                trace="backend.probe_layers.ClimateProbeLayer",
            ),
            freshness="stub",
            confidence="low",
            horizon="seasonal context only",
            coverage={"status": "global-coarse"},
            trace="probe:climate",
            not_for_navigation=True,
            disclaimer=SUPPLEMENTAL,
            note="Climatology probe face exists; live climatology dataset is not wired yet.",
        )


class DepthProbeLayer(ProbeLayer):
    layer_id = "depth"
    product_id = "depth.noaa-enc.proxy"
    dataset_name = "Nearest charted depth proxy"
    producer = "NOAA ENC / Helm seed store"

    def sample(self, req: SampleRequest) -> LayerSample:
        nd = store.nearest_charted_depth(req.lat, req.lon)
        value = {
            "nearestChartedM": round(nd[1], 1) if nd else None,
            "nearFeature": nd[2] if nd else None,
            "note": "Charted-depth proxy; read exact soundings on the S-52 chart.",
            "source": {"title": "NOAA ENC (S-52)", "kind": "open"},
        }
        return LayerSample(
            layer=self.layer_id,
            status="ok" if nd else "out_of_coverage",
            value=value,
            unit="m",
            source="open",
            source_ref=_source_ref(
                self.product_id,
                self.dataset_name,
                self.producer,
                title="NOAA ENC (S-52)",
                trace="backend.store.nearest_charted_depth",
            ),
            freshness="seed-static",
            confidence="proxy",
            horizon="current chart edition unknown in backend seed store",
            coverage={"status": "nearest-feature" if nd else "out_of_coverage"},
            trace="probe:depth",
            not_for_navigation=True,
            disclaimer=SUPPLEMENTAL,
        )


class AISProbeLayer(ProbeLayer):
    layer_id = "ais"
    product_id = "ais.seed-nearby"
    dataset_name = "Nearby AIS target seed"
    producer = "Helm seed store"

    def sample(self, req: SampleRequest) -> LayerSample:
        targets = store.ais_near(req.lat, req.lon)
        value = {
            "count": len(targets),
            "targets": targets,
            "source": "sample",
            "note": "sample AIS - the engine provides real decode + CPA/TCPA",
        }
        return LayerSample(
            layer=self.layer_id,
            status="ok",
            value=value,
            source="sample",
            source_ref=_source_ref(
                self.product_id,
                self.dataset_name,
                self.producer,
                title="Helm sample AIS",
                trace="backend.store.ais_near",
            ),
            freshness="seed-static",
            confidence="demo",
            horizon="current sample only",
            coverage={"status": "radius", "radiusNm": 8},
            trace="probe:ais",
            not_for_navigation=True,
            disclaimer=SUPPLEMENTAL,
        )


class TidesProbeLayer(ProbeLayer):
    layer_id = "tides"
    product_id = "tides.opencpn-harmonic.summary"
    dataset_name = "Nearest-station tide prediction"
    producer = "Helm helm-server / OpenCPN TCMgr"

    def __init__(self, tides_provider=tides_summary_provider()):
        self.tides_provider = tides_provider

    def sample(self, req: SampleRequest) -> LayerSample:
        summary = self.tides_provider(req.lat, req.lon, req.t)
        if not summary.get("ok"):
            error = summary.get("error") or "tide summary unavailable"
            return LayerSample(
                layer=self.layer_id,
                status="not_available",
                value={
                    "error": error,
                    "engineUrl": summary.get("engineUrl"),
                    "note": "Engine tide summary unavailable; verify helm-server is running.",
                },
                unit="m",
                source="engine",
                source_ref=_source_ref(
                    self.product_id,
                    self.dataset_name,
                    self.producer,
                    title="Helm helm-server tides",
                    url=summary.get("engineUrl"),
                    trace=summary.get("trace", "backend.engine_client.get_tides_summary"),
                ),
                freshness="unavailable",
                valid_time=req.t,
                confidence="none",
                horizon="requires live helm-server /tides/summary",
                coverage={"status": "not_available"},
                trace="probe:tides",
                not_for_navigation=True,
                disclaimer=SUPPLEMENTAL,
                note=error,
            )

        station = summary.get("station") or {}
        confidence = summary.get("confidence") or {}
        next_event = summary.get("next_event") or {}
        station_name = station.get("name") or station.get("reference") or "nearest station"
        value = {
            "valueM": summary.get("value_m"),
            "directionDeg": summary.get("direction_deg"),
            "hasDirection": summary.get("has_direction"),
            "timeUtc": summary.get("time_utc"),
            "station": station,
            "nextEvent": next_event if next_event.get("ok") else None,
            "confidence": confidence,
            "engine": summary.get("engine"),
            "sourcePolicy": summary.get("source_policy"),
            "note": "Engine-backed harmonic tide prediction; verify datum and station on official publications.",
        }
        return LayerSample(
            layer=self.layer_id,
            status="ok",
            value=value,
            unit="m",
            source="engine",
            source_ref=_source_ref(
                self.product_id,
                self.dataset_name,
                self.producer,
                title=station_name,
                url=summary.get("engineUrl"),
                trace=summary.get("trace", "helm-server:/tides/summary"),
                stationIndex=station.get("index"),
                stationSource=station.get("source"),
            ),
            freshness=summary.get("time_utc") or "engine-live",
            valid_time=summary.get("time_utc") or req.t,
            confidence=confidence.get("tier") or "engine",
            horizon="harmonic prediction at requested valid time",
            coverage={
                "status": "nearest-station",
                "distanceNm": station.get("distance_nm"),
            },
            trace="probe:tides",
            not_for_navigation=True,
            disclaimer=SUPPLEMENTAL,
        )


def build_default_registry(
    weather_provider: Callable[[float, float], dict] = get_weather,
    tides_provider=tides_summary_provider(),
) -> ProbeRegistry:
    registry = ProbeRegistry()
    for layer in (
        WeatherProbeLayer(weather_provider),
        ClimateProbeLayer(),
        DepthProbeLayer(),
        AISProbeLayer(),
        TidesProbeLayer(tides_provider),
    ):
        registry.register(layer)
    return registry

"""S-100 layer ingestion spike fixtures.

This module deliberately does not parse production S-100 files. It models the
inventory, target Helm contracts, and probe path needed for LABS-5 so the next
real parser can be held to an executable shape.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Iterable, List, Optional

from probe_contract import LayerSample, ProbeLayer, ProbeRegistry, SampleRequest


INVENTORY_SCHEMA = "helm.labs.s100.layer_inventory.v1"
SUPPLEMENTAL = "Experimental S-100 layer sample; not for navigation."


PRODUCT_MAPPINGS: Dict[str, Dict[str, Any]] = {
    "S-102": {
        "contract": "depth.bathymetry",
        "role": "bathymetry",
        "probe_handle": "s102.bathymetry",
        "uses": ["depth", "contours", "ukc_input"],
        "unit": "m",
    },
    "S-104": {
        "contract": "tides.water_level",
        "role": "water_level",
        "probe_handle": "s104.water_level",
        "uses": ["tides", "ukc_input", "safety_contour_adjustment"],
        "unit": "m",
    },
    "S-111": {
        "contract": "tides.current",
        "role": "surface_current",
        "probe_handle": "s111.surface_current",
        "uses": ["currents", "pass_conditions", "route_context"],
        "unit": "kn",
    },
    "S-124": {
        "contract": "warnings.navigation",
        "role": "navigation_warning",
        "probe_handle": "s124.navigation_warning",
        "uses": ["route_warnings", "probe_context", "advisory_alerts"],
        "unit": None,
    },
    "S-129": {
        "contract": "pass.ukc",
        "role": "under_keel_clearance",
        "probe_handle": "s129.under_keel_clearance",
        "uses": ["ukc_model", "pass_conditions", "route_clearance"],
        "unit": "m",
    },
}


FIJI_REEF_PASS_BBOX = [178.05, -17.89, 178.27, -17.70]
FIJI_REEF_PASS_POLYGON = [
    [178.05, -17.89],
    [178.27, -17.89],
    [178.27, -17.70],
    [178.05, -17.70],
    [178.05, -17.89],
]


def _target_contract(product_identifier: str) -> Dict[str, Any]:
    mapping = PRODUCT_MAPPINGS[product_identifier]
    return {
        "name": mapping["contract"],
        "role": mapping["role"],
        "uses": list(mapping["uses"]),
        "unit": mapping["unit"],
    }


def _coverage() -> Dict[str, Any]:
    return {
        "status": "area",
        "bbox": list(FIJI_REEF_PASS_BBOX),
        "polygon": deepcopy(FIJI_REEF_PASS_POLYGON),
        "region": "Fiji reef-pass fixture",
    }


def _source_links(product_identifier: str) -> List[Dict[str, str]]:
    return [
        {
            "rel": "spec",
            "title": "%s product specification placeholder" % product_identifier,
            "href": "urn:helm:labs:s100:%s:spec" % product_identifier.lower(),
        },
        {
            "rel": "fixture",
            "title": "Helm LABS-5 synthetic fixture",
            "href": "urn:helm:labs:s100:fiji-reef-pass-fixture",
        },
    ]


def _layer_record(
    product_identifier: str,
    dataset_name: str,
    dataset_edition: str,
    dataset_reference_date: str,
    sample_value: Dict[str, Any],
    freshness: str,
    confidence: str,
) -> Dict[str, Any]:
    mapping = PRODUCT_MAPPINGS[product_identifier]
    return {
        "product_identifier": product_identifier,
        "dataset_name": dataset_name,
        "dataset_edition": dataset_edition,
        "dataset_reference_date": dataset_reference_date,
        "producer_code": "HELM-LABS",
        "source_feature_ids": ["%s-FIXTURE-001" % product_identifier],
        "source_links": _source_links(product_identifier),
        "coverage": _coverage(),
        "time_range": {
            "start": "2026-06-29T00:00:00Z",
            "end": "2026-06-30T00:00:00Z",
        },
        "target_contract": _target_contract(product_identifier),
        "probe_handle": mapping["probe_handle"],
        "sample_value": deepcopy(sample_value),
        "freshness": freshness,
        "confidence": confidence,
        "not_for_navigation": True,
        "advisory_label": "LABS-5 S-100 fixture; verify official sources.",
    }


def build_fixture_inventory(generated_at: str = "2026-06-29T00:00:00Z") -> Dict[str, Any]:
    """Return a local-first S-100 layer inventory for the Fiji proof fixture."""
    layers = [
        _layer_record(
            "S-102",
            "Fiji reef pass bathymetry fixture",
            "1",
            "2026-06-29",
            {
                "depth": {
                    "depthM": 7.4,
                    "datum": "LAT",
                    "resolutionM": 10,
                    "nearFeature": "synthetic reef pass shoal",
                }
            },
            "fixture-static",
            "demo",
        ),
        _layer_record(
            "S-104",
            "Fiji reef pass water level fixture",
            "1",
            "2026-06-29",
            {
                "waterLevel": {
                    "heightM": 0.72,
                    "datum": "LAT",
                    "trend": "rising",
                }
            },
            "fixture-valid-2026-06-29",
            "demo",
        ),
        _layer_record(
            "S-111",
            "Fiji reef pass surface current fixture",
            "1",
            "2026-06-29",
            {
                "current": {
                    "speedKn": 1.2,
                    "directionDeg": 245,
                    "validAt": "2026-06-29T06:00:00Z",
                }
            },
            "fixture-valid-2026-06-29",
            "demo",
        ),
        _layer_record(
            "S-124",
            "Fiji reef pass navigation warning fixture",
            "1",
            "2026-06-29",
            {
                "warning": {
                    "category": "local_warning",
                    "headline": "Fixture shoaling notice near reef pass",
                    "severity": "advisory",
                }
            },
            "fixture-static",
            "demo",
        ),
        _layer_record(
            "S-129",
            "Fiji reef pass under-keel clearance fixture",
            "1",
            "2026-06-29",
            {
                "ukc": {
                    "minClearanceM": 1.8,
                    "status": "amber",
                    "inputs": ["S-102", "S-104", "S-111"],
                    "model": "future TIDES-5/LABS-2 pass-condition model",
                }
            },
            "fixture-derived",
            "demo",
        ),
    ]
    return {
        "schema": INVENTORY_SCHEMA,
        "generated_at": generated_at,
        "source": {
            "kind": "synthetic-fixture",
            "name": "Helm LABS-5 Fiji S-100 mapping spike",
            "not_for_navigation": True,
        },
        "layers": layers,
    }


def layer_by_product(inventory: Dict[str, Any], product_identifier: str) -> Dict[str, Any]:
    for layer in inventory.get("layers", []):
        if layer.get("product_identifier") == product_identifier:
            return layer
    raise KeyError("missing S-100 product in inventory: %s" % product_identifier)


def _bbox_contains(bbox: Iterable[float], lat: float, lon: float) -> bool:
    min_lon, min_lat, max_lon, max_lat = [float(item) for item in bbox]
    return min_lat <= lat <= max_lat and min_lon <= lon <= max_lon


class S100FixtureProbeLayer(ProbeLayer):
    """Probe adapter over one local S-100 inventory record."""

    def __init__(self, record: Dict[str, Any]):
        self.record = deepcopy(record)
        self.layer_id = record["probe_handle"]
        self.product_id = record["product_identifier"]
        self.dataset_name = record["dataset_name"]
        self.producer = record["producer_code"]

    def sample(self, req: SampleRequest) -> LayerSample:
        coverage = deepcopy(self.record["coverage"])
        in_coverage = _bbox_contains(coverage["bbox"], req.lat, req.lon)
        coverage["status"] = "area" if in_coverage else "out_of_coverage"
        product_id = self.record["product_identifier"]
        value = deepcopy(self.record["sample_value"]) if in_coverage else None
        return LayerSample(
            layer=self.layer_id,
            status="ok" if in_coverage else "out_of_coverage",
            value=value,
            unit=self.record["target_contract"]["unit"],
            source="s100-fixture",
            source_ref={
                "productId": product_id,
                "datasetName": self.record["dataset_name"],
                "producer": self.record["producer_code"],
                "edition": self.record["dataset_edition"],
                "referenceDate": self.record["dataset_reference_date"],
                "sourceFeatureIds": list(self.record["source_feature_ids"]),
                "targetContract": self.record["target_contract"]["name"],
                "trace": "backend.labs.s100_spike.%s" % self.layer_id,
            },
            freshness=self.record["freshness"],
            valid_time=req.t,
            confidence=self.record["confidence"],
            horizon="fixture only; parser and real service wiring pending",
            coverage=coverage,
            trace="probe:%s" % self.layer_id,
            not_for_navigation=self.record["not_for_navigation"],
            disclaimer=SUPPLEMENTAL,
            note=self.record["advisory_label"],
        )


def build_fixture_probe_registry(inventory: Optional[Dict[str, Any]] = None) -> ProbeRegistry:
    """Register every fixture layer behind the AI-17 probe contract."""
    inventory = inventory or build_fixture_inventory()
    registry = ProbeRegistry()
    for record in inventory.get("layers", []):
        registry.register(S100FixtureProbeLayer(record))
    return registry


def sample_surface_current_path(
    lat: float = -17.75,
    lon: float = 178.12,
    t: str = "2026-06-29T06:00:00Z",
) -> Dict[str, Any]:
    """One executable LABS-5 sample path: S-111 inventory to LayerSample."""
    registry = build_fixture_probe_registry(build_fixture_inventory())
    return registry.sample("s111.surface_current", lat, lon, t)

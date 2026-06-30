"""
Enforceable sample() contract for Helm's spacetime probe layers.

Every probeable layer implements sample(lat, lon, t). The returned sample is
structured, source-tagged, and honest about missing data. This keeps "rendered"
and "queryable" from drifting apart as new layers land.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional


class ProbeContractError(ValueError):
    pass


@dataclass(frozen=True)
class SampleRequest:
    lat: float
    lon: float
    t: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not -90 <= float(self.lat) <= 90:
            raise ProbeContractError("lat must be between -90 and 90")
        if not -180 <= float(self.lon) <= 180:
            raise ProbeContractError("lon must be between -180 and 180")


@dataclass
class LayerSample:
    layer: str
    status: str
    value: Any = None
    unit: Optional[str] = None
    source: str = "unknown"
    source_ref: Dict[str, Any] = field(default_factory=dict)
    freshness: str = "unknown"
    valid_time: Optional[str] = None
    confidence: str = "unknown"
    horizon: Optional[str] = None
    coverage: Dict[str, Any] = field(default_factory=dict)
    trace: Optional[str] = None
    not_for_navigation: bool = True
    disclaimer: str = "Supplemental layer sample; verify with official sources."
    note: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out = {
            "layer": self.layer,
            "status": self.status,
            "value": self.value,
            "unit": self.unit,
            "source": self.source,
            "sourceRef": self.source_ref,
            "freshness": self.freshness,
            "validTime": self.valid_time,
            "confidence": self.confidence,
            "horizon": self.horizon,
            "coverage": self.coverage,
            "trace": self.trace,
            "notForNavigation": self.not_for_navigation,
            "disclaimer": self.disclaimer,
            "note": self.note,
        }
        return {k: v for k, v in out.items() if v is not None}


class ProbeLayer(ABC):
    layer_id: str = ""
    product_id: str = ""
    dataset_name: str = ""
    producer: str = ""

    @abstractmethod
    def sample(self, req: SampleRequest) -> LayerSample:
        raise NotImplementedError

    def metadata(self) -> Dict[str, Any]:
        return {
            "layer": self.layer_id,
            "productId": self.product_id,
            "datasetName": self.dataset_name,
            "producer": self.producer,
        }


class ProbeRegistry:
    def __init__(self):
        self._layers: Dict[str, ProbeLayer] = {}

    def register(self, layer: ProbeLayer) -> ProbeLayer:
        layer_id = getattr(layer, "layer_id", "")
        if not isinstance(layer_id, str) or not layer_id:
            raise ProbeContractError("probe layer must define non-empty layer_id")
        sample = getattr(layer, "sample", None)
        if not callable(sample):
            raise ProbeContractError("%s must expose sample(req)" % layer_id)
        if not isinstance(layer, ProbeLayer):
            raise ProbeContractError("%s must subclass ProbeLayer" % layer_id)
        self._layers[layer_id] = layer
        return layer

    def layer_ids(self) -> List[str]:
        return sorted(self._layers)

    def metadata(self) -> List[Dict[str, Any]]:
        return [self._layers[layer_id].metadata() for layer_id in self.layer_ids()]

    def require(self, layer_ids: Iterable[str]) -> None:
        missing = [layer_id for layer_id in layer_ids if layer_id not in self._layers]
        if missing:
            raise ProbeContractError("missing probe layer(s): " + ", ".join(sorted(missing)))

    def sample(self, layer_id: str, lat: float, lon: float, t: Optional[str] = None,
               context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if layer_id not in self._layers:
            raise ProbeContractError("unknown probe layer: %s" % layer_id)
        req = SampleRequest(lat=float(lat), lon=float(lon), t=t, context=context or {})
        sample = self._layers[layer_id].sample(req)
        validate_sample(sample)
        return sample.to_dict()

    def sample_many(self, layer_ids: Iterable[str], lat: float, lon: float,
                    t: Optional[str] = None, context: Optional[Dict[str, Any]] = None) -> Dict[str, Dict[str, Any]]:
        return {
            layer_id: self.sample(layer_id, lat, lon, t, context)
            for layer_id in layer_ids
        }


def validate_sample(sample: LayerSample) -> None:
    if not isinstance(sample, LayerSample):
        raise ProbeContractError("sample() must return LayerSample")
    if sample.status not in ("ok", "not_available", "not_implemented", "out_of_coverage", "error"):
        raise ProbeContractError("invalid sample status for %s: %s" % (sample.layer, sample.status))
    if not sample.layer:
        raise ProbeContractError("sample must include layer")
    if not sample.source_ref:
        raise ProbeContractError("%s sample must include source_ref" % sample.layer)
    for key in ("productId", "datasetName", "producer"):
        if not sample.source_ref.get(key):
            raise ProbeContractError("%s source_ref missing %s" % (sample.layer, key))
    if not sample.freshness:
        raise ProbeContractError("%s sample must include freshness" % sample.layer)
    if not sample.confidence:
        raise ProbeContractError("%s sample must include confidence" % sample.layer)
    if "status" not in sample.coverage:
        raise ProbeContractError("%s sample coverage must include status" % sample.layer)


def sample_metadata(sample: Dict[str, Any]) -> Dict[str, Any]:
    """Return the provenance envelope without duplicating the sampled value."""
    return {k: v for k, v in sample.items() if k != "value"}

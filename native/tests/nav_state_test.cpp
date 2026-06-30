#include "helm/native/nav_state.hpp"

#include <chrono>
#include <iostream>
#include <string>

using namespace helm::native_core;

namespace {

int failures = 0;

void check(bool condition, const std::string& message) {
  if (condition) {
    std::cout << "  PASS  " << message << '\n';
  } else {
    std::cerr << "  FAIL  " << message << '\n';
    ++failures;
  }
}

Value::Object object(std::initializer_list<std::pair<const std::string, Value>> values) {
  return Value::Object(values);
}

}  // namespace

int main() {
  {
    State base = object({
      {"sog", 5},
      {"wind", Value(object({{"spd", 17}, {"dir", 105}}))},
      {"ais", Value(Value::Array{Value(object({{"mmsi", 123456789}}))})},
    });
    State patch = object({
      {"sog", 6},
      {"wind", Value(object({{"spd", 19}}))},
    });

    State out = merge_state(base, patch);
    check(out["sog"].number() == 6, "patched primitive updates");
    check(out["wind"].object().at("spd").number() == 19, "nested object field updates");
    check(out["wind"].object().at("dir").number() == 105, "nested object preserves omitted field");
    check(out["ais"] == base["ais"], "unchanged array is retained");
    check(base["sog"].number() == 5, "base state is not mutated");
  }

  {
    NavReducer reducer;
    Frame early_delta;
    early_delta.type = FrameType::Delta;
    early_delta.seq = 12;
    early_delta.payload = object({{"sog", 7}});
    const ApplyResult early = reducer.apply(early_delta);
    check(early.status == ApplyStatus::NeedsSnapshot, "delta before snapshot is refused");
    check(reducer.last_seq() == 12, "delta-before-snapshot still records resume seq");
    check(!reducer.has_baseline(), "delta-before-snapshot does not create a baseline");

    Frame snapshot;
    snapshot.type = FrameType::Snapshot;
    snapshot.seq = 13;
    snapshot.payload = object({
      {"pos", Value(object({{"lat", -17.75}, {"lon", 177.45}}))},
      {"sog", 5},
    });
    const ApplyResult snap = reducer.apply(snapshot);
    check(snap.status == ApplyStatus::Applied, "snapshot applies");
    check(reducer.has_baseline(), "snapshot establishes baseline");
    check(reducer.last_seq() == 13, "snapshot updates seq");

    Frame delta;
    delta.type = FrameType::Delta;
    delta.seq = 14;
    delta.payload = object({{"sog", 6}});
    const ApplyResult applied = reducer.apply(delta);
    check(applied.status == ApplyStatus::Applied, "delta after snapshot applies");
    check(reducer.state().at("sog").number() == 6, "delta updates state");
    check(reducer.state().at("pos").object().at("lat").number() == -17.75, "delta keeps untouched position");
    check(reducer.hello_resume().last_seq == 14, "hello resume uses latest seq");
  }

  {
    check(classify_age(std::nullopt) == ConnectionPhase::Offline, "no frame is offline");
    check(classify_age(std::chrono::milliseconds(2999)) == ConnectionPhase::Live, "age <3s is live");
    check(classify_age(std::chrono::milliseconds(3000)) == ConnectionPhase::Lagging, "age at 3s is lagging");
    check(classify_age(std::chrono::milliseconds(9999)) == ConnectionPhase::Lagging, "age <10s is lagging");
    check(classify_age(std::chrono::milliseconds(10000)) == ConnectionPhase::Stale, "age at 10s is stale");
  }

  {
    EndpointTrust trust;
    trust.host = "helm.local";
    trust.port = 443;
    trust.token = "boat-token";
    check(!trust.is_paired(), "missing certificate fingerprint is not paired");
    trust.certificate_fingerprint_sha256 = "0123456789abcdef";
    check(trust.is_paired(), "host, port, token, and fingerprint form paired trust metadata");
  }

  if (failures != 0) {
    std::cerr << "\nhelm_native_core_tests: " << failures << " failed\n";
    return 1;
  }

  std::cout << "\nhelm_native_core_tests: all passed\n";
  return 0;
}


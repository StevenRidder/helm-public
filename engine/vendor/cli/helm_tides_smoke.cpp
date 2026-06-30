#include "helm_tides.h"

#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

#include <wx/init.h>
#include <wx/log.h>

namespace {

std::string JsonEscape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

void PrintError(const std::string &error) {
  std::cout << "{\"ok\":false,\"error\":\"" << JsonEscape(error) << "\"}\n";
}

std::string Basename(const std::string &path) {
  size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

void PrintSourceInfo(const helm::tides::TideSourceInfo &s) {
  std::cout << "{\"path\":\"" << JsonEscape(s.path) << "\""
            << ",\"basename\":\"" << JsonEscape(s.basename) << "\""
            << ",\"license\":\"" << JsonEscape(s.license) << "\""
            << ",\"provenance\":\"" << JsonEscape(s.provenance) << "\""
            << ",\"redistribution_status\":\""
            << JsonEscape(s.redistribution_status) << "\""
            << ",\"redistribution_cleared\":"
            << (s.redistribution_cleared ? "true" : "false")
            << ",\"enabled_by_default\":"
            << (s.enabled_by_default ? "true" : "false")
            << "}";
}

void PrintOfficialReference(const helm::tides::OfficialTideReference &r) {
  std::cout << "{\"provider_region_id\":\""
            << JsonEscape(r.provider_region_id) << "\""
            << ",\"provider\":\"" << JsonEscape(r.provider) << "\""
            << ",\"product\":\"" << JsonEscape(r.product) << "\""
            << ",\"station_id\":\"" << JsonEscape(r.station_id) << "\""
            << ",\"station_name\":\"" << JsonEscape(r.station_name) << "\""
            << ",\"country\":\"" << JsonEscape(r.country) << "\""
            << ",\"source_url\":\"" << JsonEscape(r.source_url) << "\""
            << ",\"observed_url\":\"" << JsonEscape(r.observed_url) << "\""
            << ",\"datum_name\":\"" << JsonEscape(r.datum_name) << "\""
            << ",\"issue_date\":\"" << JsonEscape(r.issue_date) << "\""
            << ",\"valid_start_utc\":\"" << JsonEscape(r.valid_start_utc)
            << "\""
            << ",\"valid_end_utc\":\"" << JsonEscape(r.valid_end_utc) << "\""
            << ",\"interpolation_method\":\""
            << JsonEscape(r.interpolation_method) << "\""
            << ",\"lat\":" << r.lat
            << ",\"lon\":" << r.lon
            << ",\"distance_nm\":" << r.distance_nm
            << ",\"official\":" << (r.official ? "true" : "false")
            << ",\"prediction_calendar\":"
            << (r.prediction_calendar ? "true" : "false")
            << ",\"observed_water_level_available\":"
            << (r.observed_water_level_available ? "true" : "false")
            << ",\"valid_for_time\":"
            << (r.valid_for_time ? "true" : "false")
            << "}";
}

bool HasProviderRegion(
    const std::vector<helm::tides::TideProviderRegion> &regions,
    const std::string &id) {
  for (const helm::tides::TideProviderRegion &region : regions) {
    if (region.id == id) return true;
  }
  return false;
}

void PrintConfidence(const helm::tides::TideConfidence &c) {
  std::cout << "{\"tier\":\"" << JsonEscape(c.tier) << "\""
            << ",\"score\":" << c.score
            << ",\"summary\":\"" << JsonEscape(c.summary) << "\""
            << ",\"basis\":\"" << JsonEscape(c.basis) << "\""
            << ",\"harmonic_station_distance_nm\":"
            << c.harmonic_station_distance_nm
            << ",\"official_station_distance_nm\":"
            << c.official_station_distance_nm
            << ",\"has_official_reference\":"
            << (c.has_official_reference ? "true" : "false")
            << ",\"official_reference_valid_for_time\":"
            << (c.official_reference_valid_for_time ? "true" : "false")
            << ",\"live_observation_available\":"
            << (c.live_observation_available ? "true" : "false")
            << ",\"factors\":[";
  for (size_t i = 0; i < c.factors.size(); ++i) {
    if (i) std::cout << ",";
    std::cout << "\"" << JsonEscape(c.factors[i]) << "\"";
  }
  std::cout << "]";
  if (c.has_official_reference) {
    std::cout << ",\"official_reference\":";
    PrintOfficialReference(c.official_reference);
  } else {
    std::cout << ",\"official_reference\":null";
  }
  std::cout << "}";
}

void PrintStation(const helm::tides::TideStation &s) {
  std::cout << "{\"index\":" << s.index
            << ",\"name\":\"" << JsonEscape(s.name) << "\""
            << ",\"reference\":\"" << JsonEscape(s.reference_name) << "\""
            << ",\"type\":\"" << s.type << "\""
            << ",\"lat\":" << s.lat
            << ",\"lon\":" << s.lon
            << ",\"distance_nm\":" << s.distance_nm
            << ",\"source\":\"" << JsonEscape(s.source) << "\""
            << ",\"source_basename\":\"" << JsonEscape(Basename(s.source))
            << "\""
            << ",\"source_license\":\"" << JsonEscape(s.source_license)
            << "\""
            << ",\"source_provenance\":\"" << JsonEscape(s.source_provenance)
            << "\""
            << ",\"source_redistribution_status\":\""
            << JsonEscape(s.source_redistribution_status) << "\""
            << ",\"source_redistribution_cleared\":"
            << (s.source_redistribution_cleared ? "true" : "false")
            << ",\"source_enabled_by_default\":"
            << (s.source_enabled_by_default ? "true" : "false")
            << ",\"unit\":\"" << JsonEscape(s.unit) << "\""
            << ",\"datum_m\":" << s.datum_m
            << ",\"has_datum\":" << (s.has_datum ? "true" : "false")
            << "}";
}

void PrintEvent(const helm::tides::TideEvent &e) {
  std::cout << "{\"ok\":" << (e.ok ? "true" : "false");
  if (!e.error.empty()) {
    std::cout << ",\"error\":\"" << JsonEscape(e.error) << "\"";
  }
  if (e.ok) {
    std::cout << ",\"kind\":\"" << JsonEscape(e.kind) << "\""
              << ",\"search_start_utc\":\""
              << helm::tides::FormatUtcIso8601(e.search_start_utc) << "\""
              << ",\"event_utc\":\""
              << helm::tides::FormatUtcIso8601(e.event_utc) << "\""
              << ",\"value_m\":" << e.value_m;
  }
  std::cout << "}";
}

void PrintPrediction(const helm::tides::TidePrediction &prediction,
                     const std::vector<helm::tides::TideSourceInfo> &sources,
                     const helm::tides::TideEvent &next_event,
                     bool all_local_sources) {
  const helm::tides::TideStation &s = prediction.station;
  std::cout << std::fixed << std::setprecision(6)
            << "{\"ok\":true"
            << ",\"engine\":\"" << JsonEscape(prediction.engine) << "\""
            << ",\"source_policy\":\""
            << (all_local_sources ? "all-local" : "redistributable-only")
            << "\""
            << ",\"time_utc\":\""
            << helm::tides::FormatUtcIso8601(prediction.time_utc) << "\""
            << ",\"value_m\":" << prediction.value_m
            << ",\"has_direction\":"
            << (prediction.has_direction ? "true" : "false")
            << ",\"direction_deg\":";
  if (prediction.has_direction) {
    std::cout << prediction.direction_deg;
  } else {
    std::cout << "null";
  }
  std::cout << ",\"station\":";
  PrintStation(s);
  std::cout << ",\"loaded_sources\":[";
  for (size_t i = 0; i < sources.size(); ++i) {
    if (i) std::cout << ",";
    PrintSourceInfo(sources[i]);
  }
  std::cout << "],\"next_event\":";
  PrintEvent(next_event);
  std::cout << ",\"confidence\":";
  PrintConfidence(prediction.confidence);
  std::cout << "}\n";
}

bool ParseTimeOrFail(const std::string &iso, std::time_t *utc) {
  if (helm::tides::ParseUtcIso8601(iso, utc)) return true;
  PrintError("time must be UTC ISO-8601, e.g. 2026-06-26T00:00:00Z");
  return false;
}

bool Check(bool condition, const std::string &message, std::string *error) {
  if (condition) return true;
  if (error) *error = message;
  return false;
}

bool RunRegression(helm::tides::TideEngine *engine, std::string *error) {
  constexpr double kLat = 21.3069;
  constexpr double kLon = -157.8583;
  constexpr double kHeightToleranceM = 0.005;

  struct Golden {
    const char *iso;
    double value_m;
  };
  const Golden goldens[] = {
      {"2026-06-26T00:00:00Z", 0.624134},
      {"2026-06-26T06:00:00Z", 0.188624},
      {"2026-06-26T18:00:00Z", 0.017206},
  };

  std::vector<double> values;
  helm::tides::TideStation station;
  for (const Golden &golden : goldens) {
    std::time_t utc = 0;
    if (!helm::tides::ParseUtcIso8601(golden.iso, &utc)) {
      if (error) *error = "internal regression timestamp failed to parse";
      return false;
    }
    helm::tides::TidePrediction prediction =
        engine->PredictNearest(kLat, kLon, utc);
    if (!Check(prediction.ok, "regression prediction failed: " +
                                  prediction.error, error)) {
      return false;
    }
    station = prediction.station;
    if (!Check(station.name ==
                   "Honolulu, Honolulu Harbor, Oahu Island, Hawaii",
               "nearest station changed: " + station.name, error)) {
      return false;
    }
    if (!Check(station.index == 2, "nearest station index changed", error)) {
      return false;
    }
    if (!Check(Basename(station.source) ==
                   "harmonics-dwf-20210110-free.tcd",
               "regression did not use the redistributable source", error)) {
      return false;
    }
    if (!Check(station.source_redistribution_cleared &&
                   station.source_enabled_by_default,
               "regression source is not marked default redistributable",
               error)) {
      return false;
    }
    if (!Check(std::fabs(prediction.value_m - golden.value_m) <=
                   kHeightToleranceM,
               std::string("height drift at ") + golden.iso, error)) {
      return false;
    }
    if (!Check(prediction.value_m > -2.0 && prediction.value_m < 5.0,
               "height outside plausible tide bounds", error)) {
      return false;
    }
    if (!Check(!prediction.has_direction,
               "tide station leaked a current direction sentinel", error)) {
      return false;
    }
    if (!Check(prediction.confidence.tier == "high",
               "official confidence tier changed: " +
                   prediction.confidence.tier,
               error)) {
      return false;
    }
    if (!Check(prediction.confidence.has_official_reference &&
                   prediction.confidence.official_reference.station_id ==
                       "1612340",
               "NOAA official reference did not attach to regression station",
               error)) {
      return false;
    }
    if (!Check(prediction.confidence.official_reference.datum_name == "MLLW",
               "NOAA official datum metadata changed", error)) {
      return false;
    }
    values.push_back(prediction.value_m);
  }

  double min_value = values[0];
  double max_value = values[0];
  for (double value : values) {
    if (value < min_value) min_value = value;
    if (value > max_value) max_value = value;
  }
  if (!Check(max_value - min_value > 0.30,
             "regression values did not change enough across the day", error)) {
    return false;
  }

  std::time_t search = 0;
  std::time_t expected_event = 0;
  helm::tides::ParseUtcIso8601("2026-06-26T00:20:00Z", &search);
  helm::tides::ParseUtcIso8601("2026-06-26T07:44:00Z", &expected_event);
  helm::tides::TideEvent event =
      engine->NextHighLowEvent(station.index, search);
  if (!Check(event.ok, "next high/low event failed: " + event.error, error)) {
    return false;
  }
  if (!Check(event.kind == "low_water",
             "next high/low event kind changed: " + event.kind, error)) {
    return false;
  }
  if (!Check(std::llabs(static_cast<long long>(event.event_utc -
                                               expected_event)) <= 300,
             "next low-water event time drifted by more than five minutes",
             error)) {
    return false;
  }
  if (!Check(std::fabs(event.value_m - 0.146708) <= 0.01,
             "next low-water event height drifted", error)) {
    return false;
  }

  std::time_t suva_time = 0;
  helm::tides::ParseUtcIso8601("2026-06-26T00:00:00Z", &suva_time);
  helm::tides::OfficialTideReference suva_ref;
  if (!Check(engine->NearestOfficialReference(-18.1248, 178.4501, suva_time,
                                              &suva_ref),
             "Fiji official tide reference lookup failed", error)) {
    return false;
  }
  if (!Check(suva_ref.station_id == "FJ-SUVA-WHARF",
             "Fiji official reference station changed: " +
                 suva_ref.station_id,
             error)) {
    return false;
  }
  if (!Check(suva_ref.datum_name == "Tide Prediction Datum",
             "Fiji official datum metadata changed", error)) {
    return false;
  }
  if (!Check(suva_ref.valid_for_time,
             "Fiji official reference is not valid for 2026 query time",
             error)) {
    return false;
  }

  std::vector<helm::tides::TideProviderRegion> provider_catalog =
      engine->ProviderRegions();
  if (!Check(provider_catalog.size() >= 3,
             "provider catalog should include NOAA, Fiji, and SHOM regions",
             error)) {
    return false;
  }
  if (!Check(HasProviderRegion(engine->ProviderRegionsForPoint(kLat, kLon),
                               "noaa-coops-us"),
             "NOAA provider region does not cover Honolulu", error)) {
    return false;
  }
  if (!Check(HasProviderRegion(engine->ProviderRegionsForPoint(-18.1248,
                                                               178.4501),
                               "fiji-met-cosppac"),
             "Fiji provider region does not cover Suva", error)) {
    return false;
  }
  if (!Check(HasProviderRegion(engine->ProviderRegionsForPoint(-15.0, -147.0),
                               "shom-spm-refmar-fr-polynesia"),
             "SHOM/REFMAR provider region does not cover Tuamotu test point",
             error)) {
    return false;
  }

  helm::tides::TideResolvePoint honolulu_point;
  honolulu_point.id = "gps";
  honolulu_point.name = "Honolulu regression point";
  honolulu_point.role = "gps";
  honolulu_point.lat = kLat;
  honolulu_point.lon = kLon;
  honolulu_point.eta_utc = search;
  helm::tides::TideSourceResolution honolulu_resolution =
      engine->ResolveSources({honolulu_point}, search, 25.0);
  if (!Check(honolulu_resolution.ok, "resolver failed for Honolulu", error)) {
    return false;
  }
  if (!Check(honolulu_resolution.offline_ready,
             "Honolulu resolver should be offline-ready", error)) {
    return false;
  }
  if (!Check(honolulu_resolution.official_coverage_ready,
             "Honolulu resolver should have official coverage", error)) {
    return false;
  }
  if (!Check(honolulu_resolution.confidence_tier == "high",
             "Honolulu resolver tier changed: " +
                 honolulu_resolution.confidence_tier,
             error)) {
    return false;
  }
  const bool expect_official_cache =
      !engine->OfficialPredictionCacheDir().empty();
  const bool honolulu_cached =
      !honolulu_resolution.points.empty() &&
      honolulu_resolution.points[0].official_prediction_cached;
  const helm::tides::OfficialPredictionRequest *honolulu_request =
      !honolulu_resolution.points.empty()
          ? &honolulu_resolution.points[0].official_prediction_request
          : nullptr;
  if (!Check(honolulu_request && honolulu_request->ok &&
                 honolulu_request->provider_region_id == "noaa-coops-us" &&
                 honolulu_request->station_id == "1612340" &&
                 honolulu_request->date_utc == "2026-06-26" &&
                 honolulu_request->can_fetch_live &&
                 !honolulu_request->fetch_url.empty(),
             "NOAA official prediction request metadata changed", error)) {
    return false;
  }
  if (expect_official_cache) {
    if (!Check(honolulu_cached,
               "Honolulu resolver should find the pinned NOAA prediction cache",
               error)) {
      return false;
    }
    const helm::tides::OfficialPredictionCacheInfo &cache =
        honolulu_resolution.points[0].official_prediction_cache;
    if (!Check(cache.provider_region_id == "noaa-coops-us" &&
                   cache.station_id == "1612340" &&
                   cache.datum_name == "MLLW" && cache.valid_for_time &&
                   !cache.data_path.empty() &&
                   !cache.refresh_after_utc.empty() &&
                   cache.redistribution_cleared && cache.sample_count == 24,
               "NOAA official prediction cache metadata changed", error)) {
      return false;
    }
    if (!Check(honolulu_request->cached &&
                   honolulu_request->action == "use-cache" &&
                   honolulu_request->needed == false,
               "NOAA official prediction request should use cache", error)) {
      return false;
    }
  }

  std::time_t fiji_cache_time = 0;
  helm::tides::ParseUtcIso8601("2026-06-18T00:00:00Z", &fiji_cache_time);
  helm::tides::TideResolvePoint suva_point;
  suva_point.id = "suva";
  suva_point.name = "Suva Wharf regression point";
  suva_point.role = "route-waypoint";
  suva_point.lat = -18.1330;
  suva_point.lon = 178.4280;
  suva_point.eta_utc = fiji_cache_time;
  helm::tides::TideSourceResolution suva_resolution =
      engine->ResolveSources({suva_point}, fiji_cache_time, 25.0);
  if (!Check(suva_resolution.ok, "resolver failed for Suva", error)) {
    return false;
  }
  const bool fiji_cached =
      !suva_resolution.points.empty() &&
      suva_resolution.points[0].official_prediction_cached;
  const helm::tides::OfficialPredictionRequest *fiji_request =
      !suva_resolution.points.empty()
          ? &suva_resolution.points[0].official_prediction_request
          : nullptr;
  if (!Check(fiji_request && fiji_request->ok &&
                 fiji_request->provider_region_id == "fiji-met-cosppac" &&
                 fiji_request->station_id == "FJ-SUVA-WHARF" &&
                 fiji_request->date_utc == "2026-06-18" &&
                 fiji_request->manual_import_required &&
                 fiji_request->time_zone == "Pacific/Fiji",
             "Fiji official prediction request metadata changed", error)) {
    return false;
  }
  if (expect_official_cache) {
    if (!Check(fiji_cached,
               "Suva resolver should find the Fiji calendar cache", error)) {
      return false;
    }
    const helm::tides::OfficialPredictionCacheInfo &cache =
        suva_resolution.points[0].official_prediction_cache;
    if (!Check(cache.provider_region_id == "fiji-met-cosppac" &&
                   cache.station_id == "FJ-SUVA-WHARF" &&
                   cache.datum_name == "Tide Prediction Datum" &&
                   cache.time_zone == "Pacific/Fiji" &&
                   !cache.time_basis.empty() && cache.valid_for_time &&
                   !cache.data_path.empty() &&
                   !cache.redistribution_cleared && cache.sample_count >= 1,
               "Fiji official calendar cache metadata changed", error)) {
      return false;
    }
    if (!Check(fiji_request->cached &&
                   fiji_request->action == "use-cache" &&
                   fiji_request->needed == false,
               "Fiji official prediction request should use cache", error)) {
      return false;
    }
  }

  helm::tides::TideResolvePoint remote_point;
  remote_point.id = "remote-pass";
  remote_point.name = "Remote off-grid pass";
  remote_point.role = "route-waypoint";
  remote_point.lat = -15.0;
  remote_point.lon = -147.0;
  remote_point.eta_utc = search;
  helm::tides::TideSourceResolution remote_resolution =
      engine->ResolveSources({remote_point}, search, 25.0);
  if (!Check(remote_resolution.ok, "resolver failed for remote point", error)) {
    return false;
  }
  if (!Check(!remote_resolution.offline_ready,
             "remote resolver should not claim offline-ready coverage", error)) {
    return false;
  }
  if (!Check(remote_resolution.needs_attention,
             "remote resolver should require attention", error)) {
    return false;
  }
  if (!Check(remote_resolution.confidence_tier == "very_low" ||
                 remote_resolution.confidence_tier == "low",
             "remote resolver did not downgrade confidence: " +
                 remote_resolution.confidence_tier,
             error)) {
    return false;
  }
  if (!Check(!remote_resolution.official_coverage_ready,
             "remote resolver should not claim cached official coverage",
             error)) {
    return false;
  }
  if (!Check(!remote_resolution.points.empty() &&
                 HasProviderRegion(remote_resolution.points[0].provider_regions,
                                   "shom-spm-refmar-fr-polynesia"),
             "remote resolver did not attach SHOM provider catalog match",
             error)) {
    return false;
  }
  const helm::tides::OfficialPredictionRequest *remote_request =
      !remote_resolution.points.empty()
          ? &remote_resolution.points[0].official_prediction_request
          : nullptr;
  if (!Check(remote_request && remote_request->ok &&
                 remote_request->provider_region_id ==
                     "shom-spm-refmar-fr-polynesia" &&
                 remote_request->requires_subscription &&
                 remote_request->blocked &&
                 remote_request->action == "configure-subscription",
             "remote resolver did not expose SHOM subscription request",
             error)) {
    return false;
  }

  std::string remote_provider_region;
  if (!remote_resolution.points.empty() &&
      !remote_resolution.points[0].provider_regions.empty()) {
    remote_provider_region = remote_resolution.points[0].provider_regions[0].id;
  }

  std::cout << std::fixed << std::setprecision(6)
            << "{\"ok\":true,\"regression\":true"
            << ",\"station\":\"" << JsonEscape(station.name) << "\""
            << ",\"source\":\"" << JsonEscape(Basename(station.source))
            << "\""
            << ",\"official_reference\":\""
            << JsonEscape(suva_ref.station_id) << "\""
            << ",\"resolver_offline_ready\":"
            << (honolulu_resolution.offline_ready ? "true" : "false")
            << ",\"official_prediction_cached\":"
            << (honolulu_cached ? "true" : "false")
            << ",\"fiji_prediction_cached\":"
            << (fiji_cached ? "true" : "false")
            << ",\"official_request_action\":\""
            << JsonEscape(honolulu_request ? honolulu_request->action : "")
            << "\""
            << ",\"fiji_request_action\":\""
            << JsonEscape(fiji_request ? fiji_request->action : "") << "\""
            << ",\"remote_request_action\":\""
            << JsonEscape(remote_request ? remote_request->action : "")
            << "\""
            << ",\"resolver_remote_tier\":\""
            << JsonEscape(remote_resolution.confidence_tier) << "\""
            << ",\"provider_catalog_count\":" << provider_catalog.size()
            << ",\"resolver_remote_provider_region\":\""
            << JsonEscape(remote_provider_region) << "\""
            << ",\"checks\":"
            << (static_cast<int>(sizeof(goldens) / sizeof(goldens[0])) + 25)
            << ",\"next_event\":";
  PrintEvent(event);
  std::cout << "}\n";
  return true;
}

}  // namespace

int main(int argc, char **argv) {
  wxInitializer wx_init;
  if (!wx_init.IsOk()) {
    PrintError("wxWidgets initialization failed");
    return 2;
  }
  wxLog::SetLogLevel(wxLOG_Error);

  bool all_local_sources = false;
  bool regression = false;
  std::string official_cache_dir;
  std::vector<std::string> positional;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--all-local-sources") {
      all_local_sources = true;
    } else if (arg == "--regression") {
      regression = true;
    } else if (arg == "--official-cache-dir" && i + 1 < argc) {
      official_cache_dir = argv[++i];
    } else {
      positional.push_back(arg);
    }
  }

  std::string tcdata_dir =
      positional.size() > 0 ? positional[0] : "/tmp/helm-opencpn/data/tcdata";
  double lat = positional.size() > 1 ? std::atof(positional[1].c_str())
                                     : 21.3069;  // Honolulu, free source
  double lon = positional.size() > 2 ? std::atof(positional[2].c_str())
                                     : -157.8583;
  std::string iso = positional.size() > 3 ? positional[3]
                                          : "2026-06-26T00:00:00Z";

  std::time_t utc = 0;
  if (!ParseTimeOrFail(iso, &utc)) {
    return 2;
  }

  helm::tides::TideEngine engine;
  if (!official_cache_dir.empty()) {
    engine.SetOfficialPredictionCacheDir(official_cache_dir);
  }
  std::string error;
  helm::tides::TideSourcePolicy policy =
      all_local_sources ? helm::tides::TideSourcePolicy::kAllLocal
                        : helm::tides::TideSourcePolicy::kRedistributableOnly;
  if (!engine.LoadDefaultSources(tcdata_dir, policy, &error)) {
    PrintError(error);
    return 1;
  }

  if (regression) {
    if (!RunRegression(&engine, &error)) {
      PrintError(error);
      return 1;
    }
    return 0;
  }

  helm::tides::TidePrediction prediction =
      engine.PredictNearest(lat, lon, utc);
  if (!prediction.ok) {
    PrintError(prediction.error);
    return 1;
  }

  helm::tides::TideEvent next_event =
      engine.NextHighLowEvent(prediction.station.index, utc);
  PrintPrediction(prediction, engine.LoadedSources(), next_event,
                  all_local_sources);
  return 0;
}

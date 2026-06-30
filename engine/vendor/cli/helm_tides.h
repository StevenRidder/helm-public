#ifndef HELM_TIDES_H
#define HELM_TIDES_H

#include <ctime>
#include <memory>
#include <string>
#include <vector>

namespace helm {
namespace tides {

enum class TideSourcePolicy {
  kRedistributableOnly,
  kAllLocal,
};

struct TideSourceInfo {
  std::string path;
  std::string basename;
  std::string license;
  std::string provenance;
  std::string redistribution_status;
  bool redistribution_cleared = false;
  bool enabled_by_default = false;
};

struct OfficialTideReference {
  std::string provider_region_id;
  std::string provider;
  std::string product;
  std::string station_id;
  std::string station_name;
  std::string country;
  std::string source_url;
  std::string observed_url;
  std::string datum_name;
  std::string issue_date;
  std::string valid_start_utc;
  std::string valid_end_utc;
  std::string interpolation_method;
  double lat = 0.0;
  double lon = 0.0;
  double distance_nm = -1.0;
  bool official = false;
  bool prediction_calendar = false;
  bool observed_water_level_available = false;
  bool valid_for_time = false;
};

struct TideProviderRegion {
  std::string id;
  std::string provider;
  std::string authority;
  std::string product;
  std::string region_name;
  std::string country;
  std::string source_url;
  std::string metadata_url;
  std::string prediction_url_template;
  std::string observed_url_template;
  std::string datum_name;
  std::string license;
  std::string provenance;
  std::string redistribution_status;
  std::string cache_policy;
  std::string update_cadence;
  std::string adapter_status;
  std::string intended_use;
  std::string notes;
  double min_lat = 0.0;
  double max_lat = 0.0;
  double min_lon = 0.0;
  double max_lon = 0.0;
  bool official = false;
  bool predictions_available = false;
  bool observations_available = false;
  bool currents_available = false;
  bool requires_api_key = false;
  bool requires_subscription = false;
  bool redistribution_cleared = false;
  bool enabled_by_default = false;
};

struct OfficialPredictionCacheInfo {
  bool ok = false;
  std::string provider_region_id;
  std::string provider;
  std::string station_id;
  std::string station_name;
  std::string datum_name;
  std::string source_url;
  std::string cache_path;
  std::string data_path;
  std::string fetched_utc;
  std::string issue_date;
  std::string valid_start_utc;
  std::string valid_end_utc;
  std::string refresh_after_utc;
  std::string time_zone;
  std::string time_basis;
  std::string license;
  std::string provenance;
  std::string redistribution_status;
  std::string cache_status;
  int sample_count = 0;
  bool official = false;
  bool valid_for_time = false;
  bool refresh_due = false;
  bool redistribution_cleared = false;
};

struct OfficialPredictionRequest {
  bool ok = false;
  bool needed = false;
  bool cached = false;
  bool cache_refresh_due = false;
  bool can_fetch_live = false;
  bool manual_import_required = false;
  bool requires_api_key = false;
  bool requires_subscription = false;
  bool blocked = false;
  std::string action;
  std::string status;
  std::string provider_region_id;
  std::string provider;
  std::string adapter_status;
  std::string station_id;
  std::string station_name;
  std::string datum_name;
  std::string date_utc;
  std::string time_zone;
  std::string source_url;
  std::string fetch_url;
  std::string cache_key;
  std::string cache_path;
  std::string data_path;
  std::string license;
  std::string provenance;
  std::string redistribution_status;
  bool redistribution_cleared = false;
};

struct TideConfidence {
  std::string tier;
  std::string summary;
  std::string basis;
  std::vector<std::string> factors;
  double score = 0.0;
  double harmonic_station_distance_nm = -1.0;
  double official_station_distance_nm = -1.0;
  bool has_official_reference = false;
  bool official_reference_valid_for_time = false;
  bool live_observation_available = false;
  OfficialTideReference official_reference;
};

struct TideStation {
  int index = -1;
  char type = '?';
  std::string name;
  std::string reference_name;
  std::string source;
  std::string source_license;
  std::string source_provenance;
  std::string source_redistribution_status;
  std::string unit;
  std::string units_abbrev;
  double lat = 0.0;
  double lon = 0.0;
  double datum_m = 0.0;
  double distance_nm = -1.0;
  int timezone_minutes = 0;
  bool usable = false;
  bool has_datum = false;
  bool source_redistribution_cleared = false;
  bool source_enabled_by_default = false;

  bool is_tide() const { return type == 'T' || type == 't'; }
  bool is_current() const { return type == 'C' || type == 'c'; }
};

struct TidePrediction {
  bool ok = false;
  std::string error;
  std::string engine = "opencpn-tcmgr";
  std::time_t time_utc = 0;
  double value_m = 0.0;
  double direction_deg = 0.0;
  bool has_direction = false;
  bool is_current = false;
  TideStation station;
  TideConfidence confidence;
};

struct CurrentObservationComponent {
  bool available = false;
  bool applied = false;
  std::string source;
  std::string status;
  std::string valid_time_utc;
  double speed_kn = 0.0;
  double direction_deg = 0.0;
  bool has_direction = false;
};

struct CurrentResidualFactor {
  std::string name;
  std::string source;
  std::string status;
  bool available = false;
  bool applied = false;
};

struct TideCurrentCondition {
  bool ok = false;
  std::string error;
  std::string engine = "opencpn-tcmgr";
  std::time_t time_utc = 0;
  double lat = 0.0;
  double lon = 0.0;
  bool theoretical_available = false;
  bool theoretical_applied = false;
  double speed_kn = 0.0;
  double signed_speed_kn = 0.0;
  double direction_deg = 0.0;
  bool has_direction = false;
  TideStation station;
  CurrentObservationComponent observed;
  std::vector<CurrentResidualFactor> residual_factors;
  TideConfidence confidence;
  std::vector<TideProviderRegion> provider_regions;
  std::vector<std::string> warnings;
};

struct TideEvent {
  bool ok = false;
  std::string error;
  std::string engine = "opencpn-tcmgr";
  std::string kind;
  std::time_t search_start_utc = 0;
  std::time_t event_utc = 0;
  double value_m = 0.0;
  TideStation station;
};

struct TideResolvePoint {
  std::string id;
  std::string name;
  std::string role;
  double lat = 0.0;
  double lon = 0.0;
  std::time_t eta_utc = 0;
};

struct TideResolvedPoint {
  TideResolvePoint point;
  bool has_harmonic_station = false;
  bool has_official_reference = false;
  bool harmonic_offline_available = false;
  bool official_metadata_available = false;
  bool official_prediction_cached = false;
  bool observed_feed_available = false;
  bool offline_ready = false;
  bool provider_catalog_available = false;
  std::string cache_status;
  std::vector<std::string> warnings;
  TideStation harmonic_station;
  OfficialTideReference official_reference;
  OfficialPredictionCacheInfo official_prediction_cache;
  OfficialPredictionRequest official_prediction_request;
  std::vector<TideProviderRegion> provider_regions;
  TideConfidence confidence;
};

struct TideSourceResolution {
  bool ok = false;
  std::string error;
  std::string engine = "opencpn-tcmgr";
  std::string summary;
  std::string confidence_tier;
  std::string cache_summary;
  std::time_t generated_utc = 0;
  double corridor_nm = 25.0;
  double min_confidence_score = 0.0;
  double max_harmonic_station_distance_nm = -1.0;
  double max_official_station_distance_nm = -1.0;
  bool offline_ready = false;
  bool official_coverage_ready = false;
  bool needs_attention = false;
  std::vector<std::string> warnings;
  std::vector<TideResolvedPoint> points;
  std::vector<TideSourceInfo> loaded_sources;
  std::vector<TideProviderRegion> provider_regions;
};

class TideEngine {
public:
  TideEngine();
  ~TideEngine();

  TideEngine(TideEngine &&) noexcept;
  TideEngine &operator=(TideEngine &&) noexcept;

  TideEngine(const TideEngine &) = delete;
  TideEngine &operator=(const TideEngine &) = delete;

  bool LoadSources(const std::vector<std::string> &sources,
                   std::string *error);
  bool LoadDefaultSources(const std::string &tcdata_dir,
                          TideSourcePolicy policy,
                          std::string *error);
  void SetOfficialPredictionCacheDir(const std::string &cache_dir);
  std::string OfficialPredictionCacheDir() const;
  std::vector<TideSourceInfo> LoadedSources() const;
  std::vector<OfficialTideReference> OfficialReferences() const;
  std::vector<TideProviderRegion> ProviderRegions() const;
  std::vector<TideProviderRegion> ProviderRegionsForPoint(double lat,
                                                          double lon) const;
  std::vector<TideStation> Stations() const;
  TideStation StationAt(int index) const;
  bool NearestTideStation(double lat, double lon, TideStation *out) const;
  bool NearestCurrentStation(double lat, double lon, TideStation *out) const;
  bool NearestOfficialReference(double lat, double lon, std::time_t utc,
                                OfficialTideReference *out) const;
  bool CachedOfficialPrediction(const OfficialTideReference &reference,
                                std::time_t utc,
                                OfficialPredictionCacheInfo *out) const;
  OfficialPredictionRequest PlanOfficialPredictionRequest(
      double lat, double lon, std::time_t utc,
      double ready_radius_nm = 60.0) const;
  TideConfidence AssessConfidence(double lat, double lon, std::time_t utc,
                                  const TideStation &station) const;
  TidePrediction Predict(int station_index, std::time_t utc) const;
  TidePrediction PredictNearest(double lat, double lon, std::time_t utc) const;
  TidePrediction PredictNearestCurrent(double lat, double lon,
                                       std::time_t utc) const;
  TideCurrentCondition CurrentCondition(double lat, double lon,
                                        std::time_t utc) const;
  TideEvent NextHighLowEvent(int station_index, std::time_t after_utc) const;
  TideEvent NextHighLowEventNearest(double lat, double lon,
                                    std::time_t after_utc) const;
  TideSourceResolution ResolveSources(
      const std::vector<TideResolvePoint> &points,
      std::time_t fallback_utc,
      double corridor_nm = 25.0) const;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

TideSourceInfo ClassifySourcePath(const std::string &path);
std::vector<TideSourceInfo> DefaultSourceCatalog(const std::string &tcdata_dir);
std::vector<OfficialTideReference> DefaultOfficialReferences();
std::vector<TideProviderRegion> DefaultProviderRegions();
std::vector<std::string> DefaultSourcePaths(
    const std::string &tcdata_dir,
    TideSourcePolicy policy = TideSourcePolicy::kRedistributableOnly);
std::string NoaaCoopsPredictionUrl(const OfficialTideReference &reference,
                                   std::time_t day_utc,
                                   int interval_minutes = 60);
bool WriteNoaaCoopsPredictionCache(const OfficialTideReference &reference,
                                   const std::string &cache_dir,
                                   std::time_t day_utc,
                                   const std::string &json_body,
                                   const std::string &source_url,
                                   const std::string &fetched_utc,
                                   OfficialPredictionCacheInfo *out,
                                   std::string *error);
bool WriteFijiMetCalendarCache(const OfficialTideReference &reference,
                               const std::string &cache_dir,
                               std::time_t day_utc,
                               const std::string &calendar_body,
                               const std::string &source_url,
                               const std::string &fetched_utc,
                               OfficialPredictionCacheInfo *out,
                               std::string *error);
bool ParseUtcIso8601(const std::string &text, std::time_t *out);
std::string FormatUtcIso8601(std::time_t t);

}  // namespace tides
}  // namespace helm

#endif  // HELM_TIDES_H

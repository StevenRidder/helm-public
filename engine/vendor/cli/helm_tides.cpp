#include "helm_tides.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cctype>
#include <fstream>
#include <limits>
#include <map>
#include <sstream>
#include <sys/stat.h>
#include <utility>

#include "rapidjson/document.h"
#include "tc_data_factory.h"
#include "tcmgr.h"

namespace helm {
namespace tides {

namespace {

constexpr double kEarthRadiusNm = 3440.065;
constexpr double kDegToRad = 3.14159265358979323846 / 180.0;

std::string Basename(const std::string &path) {
  size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

double Clamp(double value, double lo, double hi) {
  return std::max(lo, std::min(hi, value));
}

double UnitFactorToMeters(const Station_Data *station_data) {
  if (!station_data) return 1.0;
  int unit_idx = TCDataFactory::findunit(station_data->unit);
  if (unit_idx < 0) return 1.0;
  return TCDataFactory::known_units[unit_idx].conv_factor;
}

double DistanceNm(double lat0, double lon0, double lat1, double lon1) {
  double phi0 = lat0 * kDegToRad;
  double phi1 = lat1 * kDegToRad;
  double dphi = (lat1 - lat0) * kDegToRad;
  double dlambda = (lon1 - lon0) * kDegToRad;
  double a = std::sin(dphi / 2.0) * std::sin(dphi / 2.0) +
             std::cos(phi0) * std::cos(phi1) *
                 std::sin(dlambda / 2.0) * std::sin(dlambda / 2.0);
  double c = 2.0 * std::atan2(std::sqrt(a), std::sqrt(1.0 - a));
  return kEarthRadiusNm * c;
}

time_t TimegmPortable(std::tm *tm) {
#if defined(_WIN32)
  return _mkgmtime(tm);
#else
  return timegm(tm);
#endif
}

bool ReferenceValidForTime(const OfficialTideReference &ref, std::time_t utc) {
  std::time_t start = 0;
  std::time_t end = 0;
  if (!ref.valid_start_utc.empty() &&
      ParseUtcIso8601(ref.valid_start_utc, &start) && utc < start) {
    return false;
  }
  if (!ref.valid_end_utc.empty() &&
      ParseUtcIso8601(ref.valid_end_utc, &end) && utc > end) {
    return false;
  }
  return true;
}

bool LongitudeInRange(double lon, double min_lon, double max_lon) {
  if (min_lon <= max_lon) return lon >= min_lon && lon <= max_lon;
  return lon >= min_lon || lon <= max_lon;  // bbox crosses the dateline.
}

bool RegionContainsPoint(const TideProviderRegion &region,
                         double lat,
                         double lon) {
  return lat >= region.min_lat && lat <= region.max_lat &&
         LongitudeInRange(lon, region.min_lon, region.max_lon);
}

void AddUniqueRegion(std::vector<TideProviderRegion> *regions,
                     const TideProviderRegion &region) {
  if (!regions) return;
  for (const TideProviderRegion &existing : *regions) {
    if (existing.id == region.id) return;
  }
  regions->push_back(region);
}

std::string Trim(const std::string &s) {
  size_t first = 0;
  while (first < s.size() &&
         std::isspace(static_cast<unsigned char>(s[first]))) {
    ++first;
  }
  size_t last = s.size();
  while (last > first &&
         std::isspace(static_cast<unsigned char>(s[last - 1]))) {
    --last;
  }
  return s.substr(first, last - first);
}

std::map<std::string, std::string> ReadKeyValueFile(const std::string &path) {
  std::map<std::string, std::string> values;
  std::ifstream in(path);
  std::string line;
  while (std::getline(in, line)) {
    std::string trimmed = Trim(line);
    if (trimmed.empty() || trimmed[0] == '#') continue;
    size_t eq = trimmed.find('=');
    if (eq == std::string::npos) continue;
    values[Trim(trimmed.substr(0, eq))] = Trim(trimmed.substr(eq + 1));
  }
  return values;
}

std::string ValueOr(const std::map<std::string, std::string> &values,
                    const std::string &key,
                    const std::string &fallback) {
  auto it = values.find(key);
  return it == values.end() || it->second.empty() ? fallback : it->second;
}

bool BoolValueOr(const std::map<std::string, std::string> &values,
                 const std::string &key,
                 bool fallback) {
  auto it = values.find(key);
  if (it == values.end()) return fallback;
  std::string v = it->second;
  std::transform(v.begin(), v.end(), v.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  if (v == "1" || v == "true" || v == "yes") return true;
  if (v == "0" || v == "false" || v == "no") return false;
  return fallback;
}

int IntValueOr(const std::map<std::string, std::string> &values,
               const std::string &key,
               int fallback) {
  auto it = values.find(key);
  if (it == values.end()) return fallback;
  char *end = nullptr;
  long v = std::strtol(it->second.c_str(), &end, 10);
  return end && *end == '\0' ? static_cast<int>(v) : fallback;
}

std::string SanitizePathToken(const std::string &token) {
  std::string out;
  out.reserve(token.size());
  for (unsigned char c : token) {
    if (std::isalnum(c) || c == '-' || c == '_') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('_');
    }
  }
  return out.empty() ? "_" : out;
}

std::string JoinPath(std::string base, const std::string &child) {
  if (base.empty()) return child;
  if (base.back() != '/') base.push_back('/');
  return base + child;
}

std::string UtcDateKey(std::time_t t) {
  std::string iso = FormatUtcIso8601(t);
  return iso.size() >= 10 ? iso.substr(0, 10) : iso;
}

std::string NoaaDateParam(std::time_t t) {
  std::string key = UtcDateKey(t);
  std::string out;
  out.reserve(8);
  for (char c : key) {
    if (c != '-') out.push_back(c);
  }
  return out;
}

std::time_t AddSeconds(std::time_t t, long seconds) {
  return static_cast<std::time_t>(t + seconds);
}

std::string DayStartUtc(std::time_t t) {
  return UtcDateKey(t) + "T00:00:00Z";
}

std::string DayEndUtc(std::time_t t) {
  return UtcDateKey(t) + "T23:59:59Z";
}

std::string CacheMetaPath(const std::string &cache_dir,
                          const OfficialTideReference &reference,
                          std::time_t utc) {
  std::string path = cache_dir;
  path = JoinPath(path, SanitizePathToken(reference.provider_region_id));
  path = JoinPath(path, SanitizePathToken(reference.station_id));
  return JoinPath(path, UtcDateKey(utc) + ".meta");
}

std::string CacheDataPath(const std::string &cache_dir,
                          const OfficialTideReference &reference,
                          std::time_t utc) {
  std::string path = cache_dir;
  path = JoinPath(path, SanitizePathToken(reference.provider_region_id));
  path = JoinPath(path, SanitizePathToken(reference.station_id));
  return JoinPath(path, UtcDateKey(utc) + ".json");
}

std::string FijiCalendarDataPath(const std::string &cache_dir,
                                 const OfficialTideReference &reference,
                                 const std::string &year) {
  std::string path = cache_dir;
  path = JoinPath(path, SanitizePathToken(reference.provider_region_id));
  path = JoinPath(path, SanitizePathToken(reference.station_id));
  return JoinPath(path, year + "-calendar.csv");
}

std::string ParentDir(const std::string &path) {
  size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? std::string() : path.substr(0, slash);
}

bool DirectoryExists(const std::string &path) {
  struct stat st {};
  return ::stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

bool MkdirIfNeeded(const std::string &path, std::string *error) {
  if (path.empty() || DirectoryExists(path)) return true;
  if (::mkdir(path.c_str(), 0755) == 0 || errno == EEXIST) return true;
  if (error) {
    *error = "could not create directory: " + path + " errno=" +
             std::to_string(errno);
  }
  return false;
}

bool EnsureDirRecursive(const std::string &path, std::string *error) {
  if (path.empty()) return true;
  size_t pos = path[0] == '/' ? 1 : 0;
  while (true) {
    pos = path.find('/', pos);
    std::string part = pos == std::string::npos ? path : path.substr(0, pos);
    if (!part.empty() && !MkdirIfNeeded(part, error)) return false;
    if (pos == std::string::npos) break;
    ++pos;
  }
  return true;
}

bool WriteTextFile(const std::string &path,
                   const std::string &body,
                   std::string *error) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out.good()) {
    if (error) *error = "could not open for write: " + path;
    return false;
  }
  out << body;
  if (!out.good()) {
    if (error) *error = "could not write: " + path;
    return false;
  }
  return true;
}

std::string KeyValueLine(const std::string &key, const std::string &value) {
  return key + "=" + value + "\n";
}

std::vector<std::string> SplitCsvLine(const std::string &line) {
  std::vector<std::string> fields;
  std::string field;
  bool in_quotes = false;
  for (size_t i = 0; i < line.size(); ++i) {
    char c = line[i];
    if (c == '"') {
      if (in_quotes && i + 1 < line.size() && line[i + 1] == '"') {
        field.push_back('"');
        ++i;
      } else {
        in_quotes = !in_quotes;
      }
    } else if (c == ',' && !in_quotes) {
      fields.push_back(Trim(field));
      field.clear();
    } else {
      field.push_back(c);
    }
  }
  fields.push_back(Trim(field));
  return fields;
}

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool ValidHourMinute(const std::string &text) {
  size_t colon = text.find(':');
  if (colon == std::string::npos || colon == 0 || colon + 1 >= text.size()) {
    return false;
  }
  std::string hour_text = text.substr(0, colon);
  std::string minute_text = text.substr(colon + 1);
  if (minute_text.size() != 2) return false;
  for (char c : hour_text + minute_text) {
    if (!std::isdigit(static_cast<unsigned char>(c))) return false;
  }
  int hour = std::atoi(hour_text.c_str());
  int minute = std::atoi(minute_text.c_str());
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

struct FijiCalendarRow {
  std::string date;
  std::string time;
  std::string height_m;
  std::string event;
  std::string source_note;
  std::time_t day_utc = 0;
};

bool ParseFijiMetCalendarRows(const std::string &calendar_body,
                              std::vector<FijiCalendarRow> *rows,
                              std::string *error) {
  if (!rows) return false;
  rows->clear();
  std::istringstream input(calendar_body);
  std::string line;
  bool saw_header = false;
  int line_no = 0;
  while (std::getline(input, line)) {
    ++line_no;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::string trimmed = Trim(line);
    if (trimmed.empty() || trimmed[0] == '#') continue;

    std::vector<std::string> fields = SplitCsvLine(trimmed);
    if (!saw_header) {
      saw_header = true;
      if (fields.size() < 4 || Lower(fields[0]) != "date" ||
          Lower(fields[1]) != "time" || Lower(fields[2]) != "height_m" ||
          Lower(fields[3]) != "event") {
        if (error) {
          *error =
              "Fiji calendar CSV header must be date,time,height_m,event";
        }
        return false;
      }
      continue;
    }

    if (fields.size() < 4) {
      if (error) {
        *error = "Fiji calendar CSV row has too few fields at line " +
                 std::to_string(line_no);
      }
      return false;
    }

    FijiCalendarRow row;
    row.date = fields[0];
    row.time = fields[1];
    row.height_m = fields[2];
    row.event = Lower(fields[3]);
    if (fields.size() >= 5) row.source_note = fields[4];

    if (row.date.size() != 10 ||
        !ParseUtcIso8601(row.date + "T00:00:00Z", &row.day_utc)) {
      if (error) {
        *error = "Fiji calendar row has bad YYYY-MM-DD date at line " +
                 std::to_string(line_no);
      }
      return false;
    }
    if (!ValidHourMinute(row.time)) {
      if (error) {
        *error = "Fiji calendar row has bad HH:MM time at line " +
                 std::to_string(line_no);
      }
      return false;
    }
    char *height_end = nullptr;
    std::strtod(row.height_m.c_str(), &height_end);
    if (!height_end || *height_end != '\0') {
      if (error) {
        *error = "Fiji calendar row has bad height_m at line " +
                 std::to_string(line_no);
      }
      return false;
    }
    if (row.event != "high" && row.event != "low") {
      if (error) {
        *error = "Fiji calendar event must be high or low at line " +
                 std::to_string(line_no);
      }
      return false;
    }
    rows->push_back(row);
  }

  if (rows->empty()) {
    if (error) *error = "Fiji calendar CSV contained no tide events";
    return false;
  }
  return true;
}

int CountNoaaPredictionSamples(const std::string &json_body,
                               std::string *error) {
  rapidjson::Document d;
  if (d.Parse(json_body.c_str()).HasParseError() || !d.IsObject()) {
    if (error) *error = "NOAA response is not a JSON object";
    return -1;
  }
  if (d.HasMember("error")) {
    if (error) *error = "NOAA response contained an error object";
    return -1;
  }
  if (!d.HasMember("predictions") || !d["predictions"].IsArray()) {
    if (error) *error = "NOAA response missing predictions array";
    return -1;
  }
  const rapidjson::Value &predictions = d["predictions"];
  int count = 0;
  for (rapidjson::SizeType i = 0; i < predictions.Size(); ++i) {
    const rapidjson::Value &p = predictions[i];
    if (!p.IsObject() || !p.HasMember("t") || !p["t"].IsString() ||
        !p.HasMember("v") ||
        !(p["v"].IsString() || p["v"].IsNumber())) {
      if (error) *error = "NOAA prediction sample has unexpected shape";
      return -1;
    }
    ++count;
  }
  if (count <= 0) {
    if (error) *error = "NOAA response contained no prediction samples";
    return -1;
  }
  return count;
}

bool CacheValidForTime(const OfficialPredictionCacheInfo &cache,
                       std::time_t utc) {
  std::time_t start = 0;
  std::time_t end = 0;
  if (!cache.valid_start_utc.empty() &&
      ParseUtcIso8601(cache.valid_start_utc, &start) && utc < start) {
    return false;
  }
  if (!cache.valid_end_utc.empty() &&
      ParseUtcIso8601(cache.valid_end_utc, &end) && utc > end) {
    return false;
  }
  return true;
}

OfficialPredictionRequest BuildOfficialPredictionRequest(
    const OfficialTideReference *reference,
    const TideProviderRegion *region,
    std::time_t utc,
    const std::string &cache_dir,
    const OfficialPredictionCacheInfo *cache) {
  OfficialPredictionRequest request;
  const bool has_reference = reference != nullptr;
  const bool has_region = region != nullptr;
  if (!has_reference && !has_region) {
    request.status = "no official provider or station reference matched";
    return request;
  }

  request.ok = true;
  request.cached = cache && cache->ok;
  request.cache_refresh_due = cache && cache->refresh_due;
  request.needed = !request.cached || request.cache_refresh_due;

  if (has_reference) {
    request.provider_region_id = reference->provider_region_id;
    request.provider = reference->provider;
    request.station_id = reference->station_id;
    request.station_name = reference->station_name;
    request.datum_name = reference->datum_name;
    request.source_url = reference->source_url;
  } else {
    request.provider_region_id = region->id;
    request.provider = region->provider;
    request.datum_name = region->datum_name;
    request.source_url = region->source_url;
  }

  if (has_region) {
    if (request.provider.empty()) request.provider = region->provider;
    if (request.datum_name.empty()) request.datum_name = region->datum_name;
    if (request.source_url.empty()) request.source_url = region->source_url;
    request.adapter_status = region->adapter_status;
    request.requires_api_key = region->requires_api_key;
    request.requires_subscription = region->requires_subscription;
    request.license = region->license;
    request.provenance = region->provenance;
    request.redistribution_status = region->redistribution_status;
    request.redistribution_cleared = region->redistribution_cleared;
  }

  request.date_utc = UtcDateKey(utc);
  if (has_reference && !cache_dir.empty()) {
    request.cache_path = CacheMetaPath(cache_dir, *reference, utc);
    request.cache_key = SanitizePathToken(reference->provider_region_id) +
                        "/" + SanitizePathToken(reference->station_id) +
                        "/" + request.date_utc;
  } else if (!request.provider_region_id.empty()) {
    request.cache_key = SanitizePathToken(request.provider_region_id) +
                        "/<station>/" + request.date_utc;
  }

  if (cache) {
    if (!cache->cache_path.empty()) request.cache_path = cache->cache_path;
    request.data_path = cache->data_path;
    if (!cache->time_zone.empty()) request.time_zone = cache->time_zone;
    if (!cache->source_url.empty()) request.source_url = cache->source_url;
  }

  if (request.provider_region_id == "noaa-coops-us") {
    request.can_fetch_live = true;
    request.time_zone = request.time_zone.empty() ? "GMT" : request.time_zone;
    if (has_reference) {
      request.fetch_url = NoaaCoopsPredictionUrl(*reference, utc, 60);
      if (request.source_url.empty()) request.source_url = request.fetch_url;
    }
  } else if (request.provider_region_id == "fiji-met-cosppac") {
    request.manual_import_required = true;
    request.time_zone =
        request.time_zone.empty() ? "Pacific/Fiji" : request.time_zone;
  }

  if (request.cached && !request.cache_refresh_due) {
    request.action = "use-cache";
    request.status = "official prediction cache is present for this date";
    return request;
  }

  if (!has_reference) {
    request.needed = true;
    request.blocked = true;
    if (request.requires_subscription) {
      request.action = "configure-subscription";
      request.status =
          "provider region matched, but subscription credentials and station selection are required";
    } else if (request.requires_api_key) {
      request.action = "configure-api-key";
      request.status =
          "provider region matched, but API credentials and station selection are required";
    } else {
      request.action = "select-station";
      request.status =
          "provider region matched, but no station/calendar reference is available yet";
    }
    return request;
  }

  if (!reference->valid_for_time) {
    request.blocked = true;
    request.action = "refresh-reference";
    request.status =
        "official station reference is outside its advertised validity window";
    return request;
  }

  if (request.requires_subscription) {
    request.blocked = true;
    request.action = "configure-subscription";
    request.status =
        "official provider requires subscription credentials before caching";
  } else if (request.requires_api_key) {
    request.blocked = true;
    request.action = "configure-api-key";
    request.status =
        "official provider requires API credentials before caching";
  } else if (request.can_fetch_live) {
    request.action = request.cache_refresh_due ? "refresh-live" : "fetch-live";
    request.status =
        request.cache_refresh_due ? "cached official prediction is stale; refresh when online" :
                                    "official prediction can be fetched when online";
  } else if (request.manual_import_required) {
    request.action =
        request.cache_refresh_due ? "refresh-calendar" : "import-calendar";
    request.status =
        request.cache_refresh_due ? "cached official calendar is stale; re-import the latest publication" :
                                    "official calendar publication must be imported for this date";
  } else if (!request.adapter_status.empty() &&
             request.adapter_status != "api-ready") {
    request.blocked = true;
    request.action = "implement-adapter";
    request.status =
        "provider is cataloged, but the adapter is not ready for automatic caching";
  } else {
    request.blocked = true;
    request.action = "manual-review";
    request.status =
        "official provider cache path needs manual review before use";
  }
  return request;
}

const TideProviderRegion *FindRegion(
    const std::vector<TideProviderRegion> &regions,
    const std::string &id) {
  for (const TideProviderRegion &region : regions) {
    if (region.id == id) return &region;
  }
  return nullptr;
}

}  // namespace

struct TideEngine::Impl {
  TCMgr manager;
  bool loaded = false;
  std::vector<TideSourceInfo> loaded_sources;
  std::vector<OfficialTideReference> official_references =
      DefaultOfficialReferences();
  std::vector<TideProviderRegion> provider_regions = DefaultProviderRegions();
  std::string official_prediction_cache_dir;
};

TideEngine::TideEngine() : impl_(new Impl()) {}
TideEngine::~TideEngine() = default;
TideEngine::TideEngine(TideEngine &&) noexcept = default;
TideEngine &TideEngine::operator=(TideEngine &&) noexcept = default;

bool TideEngine::LoadSources(const std::vector<std::string> &sources,
                             std::string *error) {
  if (sources.empty()) {
    if (error) *error = "no tide/current harmonic sources supplied";
    return false;
  }

  std::vector<std::string> mutable_sources = sources;
  TC_Error_Code code = impl_->manager.LoadDataSources(mutable_sources);
  if (code != TC_NO_ERROR) {
    if (error) {
      char buf[96];
      std::snprintf(buf, sizeof(buf), "TCMgr LoadDataSources failed: %d", code);
      *error = buf;
    }
    return false;
  }

  impl_->loaded = true;
  impl_->loaded_sources.clear();
  for (const std::string &source : sources) {
    impl_->loaded_sources.push_back(ClassifySourcePath(source));
  }
  if (impl_->manager.Get_max_IDX() < 1) {
    if (error) *error = "harmonic sources loaded, but no stations were indexed";
    return false;
  }

  return true;
}

bool TideEngine::LoadDefaultSources(const std::string &tcdata_dir,
                                    TideSourcePolicy policy,
                                    std::string *error) {
  return LoadSources(DefaultSourcePaths(tcdata_dir, policy), error);
}

void TideEngine::SetOfficialPredictionCacheDir(const std::string &cache_dir) {
  impl_->official_prediction_cache_dir = cache_dir;
}

std::string TideEngine::OfficialPredictionCacheDir() const {
  return impl_->official_prediction_cache_dir;
}

std::vector<TideSourceInfo> TideEngine::LoadedSources() const {
  return impl_->loaded_sources;
}

std::vector<OfficialTideReference> TideEngine::OfficialReferences() const {
  return impl_->official_references;
}

std::vector<TideProviderRegion> TideEngine::ProviderRegions() const {
  return impl_->provider_regions;
}

std::vector<TideProviderRegion> TideEngine::ProviderRegionsForPoint(
    double lat, double lon) const {
  std::vector<TideProviderRegion> matches;
  if (!std::isfinite(lat) || !std::isfinite(lon)) return matches;
  for (const TideProviderRegion &region : impl_->provider_regions) {
    if (RegionContainsPoint(region, lat, lon)) matches.push_back(region);
  }
  return matches;
}

TideStation TideEngine::StationAt(int index) const {
  TideStation station;
  const IDX_entry *entry = impl_->manager.GetIDX_entry(index);
  if (!entry) return station;

  station.index = index;
  station.type = entry->IDX_type;
  station.name = entry->IDX_station_name;
  station.reference_name = entry->IDX_reference_name;
  station.source = entry->source_ident;
  TideSourceInfo source_info = ClassifySourcePath(station.source);
  station.source_license = source_info.license;
  station.source_provenance = source_info.provenance;
  station.source_redistribution_status = source_info.redistribution_status;
  station.source_redistribution_cleared = source_info.redistribution_cleared;
  station.source_enabled_by_default = source_info.enabled_by_default;
  station.lat = entry->IDX_lat;
  station.lon = entry->IDX_lon;
  station.timezone_minutes = entry->IDX_time_zone;
  station.usable = entry->IDX_Useable != 0;

  const Station_Data *station_data = entry->pref_sta_data;
  if (station_data) {
    station.has_datum = true;
    station.unit = station_data->unit;
    station.units_abbrev = station_data->units_abbrv;
    station.datum_m = station_data->DATUM * UnitFactorToMeters(station_data);
  }

  return station;
}

std::vector<TideStation> TideEngine::Stations() const {
  std::vector<TideStation> stations;
  if (!impl_->loaded) return stations;

  int max_idx = impl_->manager.Get_max_IDX();
  for (int index = 1; index <= max_idx; ++index) {
    TideStation station = StationAt(index);
    if (station.index >= 0) stations.push_back(station);
  }
  return stations;
}

bool TideEngine::NearestTideStation(double lat, double lon,
                                    TideStation *out) const {
  if (!impl_->loaded || !out) return false;

  double best_nm = std::numeric_limits<double>::infinity();
  TideStation best;
  int max_idx = impl_->manager.Get_max_IDX();
  for (int index = 1; index <= max_idx; ++index) {
    TideStation station = StationAt(index);
    if (!station.is_tide() || !station.usable) continue;
    double dist_nm = DistanceNm(lat, lon, station.lat, station.lon);
    if (dist_nm < best_nm) {
      best_nm = dist_nm;
      best = std::move(station);
      best.distance_nm = dist_nm;
    }
  }

  if (best.index < 0) return false;
  *out = std::move(best);
  return true;
}

bool TideEngine::NearestCurrentStation(double lat, double lon,
                                       TideStation *out) const {
  if (!impl_->loaded || !out) return false;

  double best_nm = std::numeric_limits<double>::infinity();
  TideStation best;
  int max_idx = impl_->manager.Get_max_IDX();
  for (int index = 1; index <= max_idx; ++index) {
    TideStation station = StationAt(index);
    if (!station.is_current() || !station.usable) continue;
    double dist_nm = DistanceNm(lat, lon, station.lat, station.lon);
    if (dist_nm < best_nm) {
      best_nm = dist_nm;
      best = std::move(station);
      best.distance_nm = dist_nm;
    }
  }

  if (best.index < 0) return false;
  *out = std::move(best);
  return true;
}

bool TideEngine::NearestOfficialReference(double lat, double lon,
                                          std::time_t utc,
                                          OfficialTideReference *out) const {
  if (!out || impl_->official_references.empty()) return false;

  double best_nm = std::numeric_limits<double>::infinity();
  OfficialTideReference best;
  for (OfficialTideReference ref : impl_->official_references) {
    double dist_nm = DistanceNm(lat, lon, ref.lat, ref.lon);
    if (dist_nm < best_nm) {
      ref.distance_nm = dist_nm;
      ref.valid_for_time = ReferenceValidForTime(ref, utc);
      best = std::move(ref);
      best_nm = dist_nm;
    }
  }

  if (best.distance_nm < 0.0) return false;
  *out = std::move(best);
  return true;
}

bool TideEngine::CachedOfficialPrediction(
    const OfficialTideReference &reference,
    std::time_t utc,
    OfficialPredictionCacheInfo *out) const {
  if (!out || impl_->official_prediction_cache_dir.empty() ||
      reference.provider_region_id.empty() || reference.station_id.empty()) {
    return false;
  }

  std::string path = impl_->official_prediction_cache_dir;
  path = JoinPath(path, SanitizePathToken(reference.provider_region_id));
  path = JoinPath(path, SanitizePathToken(reference.station_id));
  path = JoinPath(path, UtcDateKey(utc) + ".meta");
  std::ifstream probe(path);
  if (!probe.good()) return false;
  probe.close();

  std::map<std::string, std::string> kv = ReadKeyValueFile(path);
  OfficialPredictionCacheInfo cache;
  const TideProviderRegion *region =
      FindRegion(impl_->provider_regions, reference.provider_region_id);
  cache.provider_region_id =
      ValueOr(kv, "provider_region_id", reference.provider_region_id);
  cache.provider = ValueOr(kv, "provider", reference.provider);
  cache.station_id = ValueOr(kv, "station_id", reference.station_id);
  cache.station_name = ValueOr(kv, "station_name", reference.station_name);
  cache.datum_name = ValueOr(kv, "datum_name", reference.datum_name);
  cache.source_url = ValueOr(kv, "source_url", reference.source_url);
  cache.cache_path = path;
  cache.data_path = ValueOr(kv, "data_path", "");
  cache.fetched_utc = ValueOr(kv, "fetched_utc", "");
  cache.issue_date = ValueOr(kv, "issue_date", reference.issue_date);
  cache.valid_start_utc =
      ValueOr(kv, "valid_start_utc", reference.valid_start_utc);
  cache.valid_end_utc = ValueOr(kv, "valid_end_utc", reference.valid_end_utc);
  cache.refresh_after_utc = ValueOr(kv, "refresh_after_utc", "");
  cache.time_zone = ValueOr(kv, "time_zone", "");
  cache.time_basis = ValueOr(kv, "time_basis", "");
  cache.license = ValueOr(kv, "license", region ? region->license : "");
  cache.provenance =
      ValueOr(kv, "provenance", region ? region->provenance : "");
  cache.redistribution_status = ValueOr(
      kv, "redistribution_status",
      region ? region->redistribution_status : "unknown");
  cache.cache_status =
      ValueOr(kv, "cache_status", "official predictions cached for query day");
  cache.sample_count = IntValueOr(kv, "sample_count", 0);
  cache.official = BoolValueOr(kv, "official", reference.official);
  cache.redistribution_cleared = BoolValueOr(
      kv, "redistribution_cleared",
      region ? region->redistribution_cleared : false);
  cache.valid_for_time = CacheValidForTime(cache, utc);
  std::time_t refresh_after = 0;
  cache.refresh_due =
      !cache.refresh_after_utc.empty() &&
      ParseUtcIso8601(cache.refresh_after_utc, &refresh_after) &&
      std::time(nullptr) > refresh_after;
  if (cache.refresh_due &&
      cache.cache_status.find("refresh due") == std::string::npos) {
    cache.cache_status += "; refresh due when online";
  }

  if (cache.provider_region_id != reference.provider_region_id ||
      cache.station_id != reference.station_id || !cache.valid_for_time) {
    return false;
  }

  cache.ok = true;
  *out = std::move(cache);
  return true;
}

OfficialPredictionRequest TideEngine::PlanOfficialPredictionRequest(
    double lat, double lon, std::time_t utc, double ready_radius_nm) const {
  OfficialPredictionRequest request;
  if (!std::isfinite(lat) || !std::isfinite(lon) || lat < -90.0 ||
      lat > 90.0 || lon < -180.0 || lon > 180.0) {
    request.blocked = true;
    request.action = "invalid-coordinate";
    request.status = "invalid coordinate";
    return request;
  }
  if (utc == 0) utc = std::time(nullptr);
  if (!std::isfinite(ready_radius_nm) || ready_radius_nm <= 0.0) {
    ready_radius_nm = 60.0;
  }

  std::vector<TideProviderRegion> provider_regions =
      ProviderRegionsForPoint(lat, lon);
  OfficialTideReference official;
  if (NearestOfficialReference(lat, lon, utc, &official)) {
    const TideProviderRegion *official_region =
        FindRegion(impl_->provider_regions, official.provider_region_id);
    OfficialPredictionCacheInfo cache;
    const bool cached = CachedOfficialPrediction(official, utc, &cache);

    bool official_matches_provider_region = provider_regions.empty();
    for (const TideProviderRegion &region : provider_regions) {
      if (region.id == official.provider_region_id) {
        official_matches_provider_region = true;
        break;
      }
    }
    if (!official_matches_provider_region &&
        official.distance_nm > ready_radius_nm && !provider_regions.empty()) {
      return BuildOfficialPredictionRequest(
          nullptr, &provider_regions[0], utc, impl_->official_prediction_cache_dir,
          nullptr);
    }

    return BuildOfficialPredictionRequest(
        &official, official_region, utc, impl_->official_prediction_cache_dir,
        cached ? &cache : nullptr);
  }

  if (!provider_regions.empty()) {
    return BuildOfficialPredictionRequest(
        nullptr, &provider_regions[0], utc, impl_->official_prediction_cache_dir,
        nullptr);
  }

  request.status = "no official provider or station reference matched";
  return request;
}

TideConfidence TideEngine::AssessConfidence(double lat, double lon,
                                            std::time_t utc,
                                            const TideStation &station) const {
  TideConfidence c;
  c.harmonic_station_distance_nm = station.distance_nm;
  c.basis = "nearest-station harmonic prediction with official reference metadata";
  c.score = 0.35;

  if (station.has_datum) {
    c.score += 0.10;
    c.factors.push_back("harmonic station exposes datum");
  } else {
    c.factors.push_back("harmonic station has no datum metadata");
    c.score -= 0.10;
  }

  if (station.source_redistribution_cleared) {
    c.score += 0.05;
    c.factors.push_back("harmonic source is redistributable by default");
  } else {
    c.score -= 0.10;
    c.factors.push_back("harmonic source is explicit opt-in/commercial-review");
  }

  if (station.distance_nm >= 0.0) {
    if (station.distance_nm <= 5.0) {
      c.score += 0.15;
      c.factors.push_back("harmonic station is within 5 nm");
    } else if (station.distance_nm <= 25.0) {
      c.score += 0.07;
      c.factors.push_back("harmonic station is within 25 nm");
    } else if (station.distance_nm <= 60.0) {
      c.factors.push_back("harmonic station is remote but within 60 nm");
    } else {
      c.score -= 0.15;
      c.factors.push_back("harmonic station is more than 60 nm away");
    }
  } else {
    c.factors.push_back("prediction was by station id; query distance unknown");
  }

  OfficialTideReference official;
  if (NearestOfficialReference(lat, lon, utc, &official)) {
    c.has_official_reference = true;
    c.official_reference = official;
    c.official_station_distance_nm = official.distance_nm;
    c.official_reference_valid_for_time = official.valid_for_time;
    c.live_observation_available = false;

    if (official.valid_for_time) {
      c.score += 0.25;
      c.factors.push_back("nearest official tide reference is valid for query time");
    } else {
      c.score -= 0.15;
      c.factors.push_back("nearest official tide reference is outside its validity window");
    }

    if (official.distance_nm <= 5.0) {
      c.score += 0.15;
      c.factors.push_back("official reference station is within 5 nm");
    } else if (official.distance_nm <= 25.0) {
      c.score += 0.07;
      c.factors.push_back("official reference station is within 25 nm");
    } else if (official.distance_nm <= 60.0) {
      c.factors.push_back("official reference station is remote but within 60 nm");
    } else {
      c.score -= 0.20;
      c.factors.push_back("official reference station is more than 60 nm away");
    }

    if (!official.observed_url.empty()) {
      c.factors.push_back("official/partner observed-water feed exists but residual is not yet applied");
    }
  } else {
    c.factors.push_back("no official/government station reference matched this area");
  }

  c.score = Clamp(c.score, 0.0, 1.0);
  if (!c.has_official_reference) c.score = std::min(c.score, 0.45);
  if (!c.official_reference_valid_for_time && c.has_official_reference)
    c.score = std::min(c.score, 0.50);
  if (!station.source_redistribution_cleared)
    c.score = std::min(c.score, 0.75);

  if (c.score >= 0.80) {
    c.tier = "high";
  } else if (c.score >= 0.55) {
    c.tier = "medium";
  } else if (c.score >= 0.35) {
    c.tier = "low";
  } else {
    c.tier = "very_low";
  }

  if (c.tier == "high") {
    c.summary = "official station/datum metadata is close and current";
  } else if (c.tier == "medium") {
    c.summary = "usable tide estimate; verify locally before pass/bar decisions";
  } else {
    c.summary = "remote or incomplete tide basis; visual verification required";
  }
  return c;
}

namespace {

TideConfidence AssessCurrentConfidenceFromContext(
    const TideStation &station,
    const std::vector<TideProviderRegion> &provider_regions,
    bool theoretical_available) {
  TideConfidence c;
  c.basis =
      "nearest harmonic current station; observed and weather/swell residuals are reported separately";
  c.harmonic_station_distance_nm = station.distance_nm;
  c.score = theoretical_available ? 0.30 : 0.05;

  if (!theoretical_available) {
    c.factors.push_back("no harmonic current station is available for this point");
  } else {
    c.factors.push_back("theoretical tidal current comes from an OpenCPN harmonic current station");
    if (station.source_redistribution_cleared) {
      c.score += 0.05;
      c.factors.push_back("harmonic current source is redistributable by default");
    } else {
      c.score -= 0.10;
      c.factors.push_back("harmonic current source is local/opt-in and needs license review");
    }

    if (station.distance_nm >= 0.0) {
      if (station.distance_nm <= 2.0) {
        c.score += 0.15;
        c.factors.push_back("current station is within 2 nm");
      } else if (station.distance_nm <= 10.0) {
        c.score += 0.10;
        c.factors.push_back("current station is within 10 nm");
      } else if (station.distance_nm <= 25.0) {
        c.score += 0.05;
        c.factors.push_back("current station is within 25 nm");
      } else {
        c.score -= 0.15;
        c.factors.push_back("current station is more than 25 nm away");
      }
    }
  }

  bool provider_currents_available = false;
  for (const TideProviderRegion &region : provider_regions) {
    if (region.currents_available) {
      provider_currents_available = true;
      break;
    }
  }
  if (provider_currents_available) {
    c.score += 0.10;
    c.factors.push_back("official provider catalog advertises current data in this region");
  } else if (!provider_regions.empty()) {
    c.factors.push_back("official provider catalog does not yet advertise current data here");
  } else {
    c.factors.push_back("no official provider region covers this point");
  }

  c.factors.push_back("observed current reports are not yet applied");
  c.factors.push_back("wind, swell, lagoon-fill, ocean-current, and pressure residuals are not yet applied");
  c.live_observation_available = false;
  c.score = Clamp(c.score, 0.0, theoretical_available ? 0.60 : 0.25);

  if (c.score >= 0.80) {
    c.tier = "high";
  } else if (c.score >= 0.55) {
    c.tier = "medium";
  } else if (c.score >= 0.35) {
    c.tier = "low";
  } else {
    c.tier = "very_low";
  }

  if (!theoretical_available) {
    c.summary = "no current station available; do not infer pass current from tide height";
  } else if (c.tier == "medium") {
    c.summary = "theoretical current only; compare with local observations and weather";
  } else {
    c.summary = "current estimate lacks observed/residual correction; verify locally";
  }
  return c;
}

}  // namespace

TidePrediction TideEngine::Predict(int station_index, std::time_t utc) const {
  TidePrediction prediction;
  prediction.time_utc = utc;
  if (!impl_->loaded) {
    prediction.error = "tide engine has not loaded harmonic sources";
    return prediction;
  }

  float value_m = 0.0f;
  float direction = 0.0f;
  bool ok = impl_->manager.GetTideOrCurrentMeters(
      utc, station_index, value_m, direction);
  if (!ok) {
    prediction.error = "OpenCPN TCMgr could not predict the requested station";
    prediction.station = StationAt(station_index);
    return prediction;
  }

  prediction.ok = true;
  prediction.value_m = value_m;
  prediction.station = StationAt(station_index);
  prediction.station.distance_nm = 0.0;
  prediction.is_current = prediction.station.is_current();
  if (prediction.is_current && direction >= 0.0f && direction <= 360.0f) {
    prediction.direction_deg = direction;
    prediction.has_direction = true;
  }
  prediction.confidence = AssessConfidence(prediction.station.lat,
                                           prediction.station.lon, utc,
                                           prediction.station);
  return prediction;
}

TidePrediction TideEngine::PredictNearest(double lat, double lon,
                                          std::time_t utc) const {
  TideStation nearest;
  if (!NearestTideStation(lat, lon, &nearest)) {
    TidePrediction prediction;
    prediction.time_utc = utc;
    prediction.error = "no usable tide station found in loaded sources";
    return prediction;
  }

  TidePrediction prediction = Predict(nearest.index, utc);
  prediction.station.distance_nm = nearest.distance_nm;
  prediction.confidence = AssessConfidence(lat, lon, utc, prediction.station);
  return prediction;
}

TidePrediction TideEngine::PredictNearestCurrent(double lat, double lon,
                                                 std::time_t utc) const {
  TideStation nearest;
  if (!NearestCurrentStation(lat, lon, &nearest)) {
    TidePrediction prediction;
    prediction.time_utc = utc;
    prediction.error = "no usable current station found in loaded sources";
    return prediction;
  }

  TidePrediction prediction = Predict(nearest.index, utc);
  prediction.station.distance_nm = nearest.distance_nm;
  prediction.confidence =
      AssessCurrentConfidenceFromContext(prediction.station,
                                         ProviderRegionsForPoint(lat, lon),
                                         prediction.ok);
  return prediction;
}

TideCurrentCondition TideEngine::CurrentCondition(double lat, double lon,
                                                  std::time_t utc) const {
  TideCurrentCondition condition;
  condition.lat = lat;
  condition.lon = lon;
  condition.time_utc = utc == 0 ? std::time(nullptr) : utc;
  condition.observed.status =
      "no observed current report is attached to this point yet";

  const CurrentResidualFactor factors[] = {
      {"local_observation_log", "helm-pass-estimator", "no local observation log applied", false, false},
      {"wind_duration", "wx-valid-time", "wind setup/downwind outflow residual not applied", false, false},
      {"swell_lagoon_fill", "wx-valid-time", "swell/lagoon-fill residual not applied", false, false},
      {"ocean_current", "model-context", "background ocean current residual not applied", false, false},
      {"pressure", "wx-valid-time", "barometric residual not applied", false, false},
      {"pass_geometry", "local-pass-model", "pass geometry/slack-delay model not applied", false, false},
  };
  condition.residual_factors.assign(
      factors, factors + sizeof(factors) / sizeof(factors[0]));

  if (!std::isfinite(lat) || !std::isfinite(lon) || lat < -90.0 ||
      lat > 90.0 || lon < -180.0 || lon > 180.0) {
    condition.error = "invalid coordinate";
    condition.confidence =
        AssessCurrentConfidenceFromContext(condition.station,
                                           condition.provider_regions, false);
    return condition;
  }

  if (!impl_->loaded) {
    condition.error = "tide engine has not loaded harmonic sources";
    condition.confidence =
        AssessCurrentConfidenceFromContext(condition.station,
                                           condition.provider_regions, false);
    return condition;
  }

  condition.provider_regions = ProviderRegionsForPoint(lat, lon);

  TidePrediction prediction = PredictNearestCurrent(lat, lon, condition.time_utc);
  if (!prediction.ok) {
    condition.ok = true;
    condition.warnings.push_back(prediction.error);
    condition.warnings.push_back(
        "do not derive pass current from tide height alone");
    condition.confidence =
        AssessCurrentConfidenceFromContext(condition.station,
                                           condition.provider_regions, false);
    return condition;
  }

  condition.ok = true;
  condition.theoretical_available = true;
  condition.theoretical_applied = true;
  condition.signed_speed_kn = prediction.value_m;
  condition.speed_kn = std::fabs(prediction.value_m);
  condition.has_direction = prediction.has_direction;
  condition.direction_deg = prediction.direction_deg;
  condition.station = prediction.station;
  condition.confidence =
      AssessCurrentConfidenceFromContext(condition.station,
                                         condition.provider_regions, true);

  if (!condition.has_direction) {
    condition.warnings.push_back(
        "current station did not return a direction; suppress map arrow");
  }
  if (!condition.station.source_redistribution_cleared) {
    condition.warnings.push_back(
        "current harmonic source is local/opt-in and needs license review");
  }
  condition.warnings.push_back(
      "observed current and wind/swell residual corrections are not applied yet");
  return condition;
}

TideEvent TideEngine::NextHighLowEvent(int station_index,
                                       std::time_t after_utc) const {
  TideEvent event;
  event.search_start_utc = after_utc;
  if (!impl_->loaded) {
    event.error = "tide engine has not loaded harmonic sources";
    return event;
  }

  TideStation station = StationAt(station_index);
  event.station = station;
  if (!station.is_tide()) {
    event.error = "high/low events are only available for tide stations";
    return event;
  }

  std::time_t event_time = after_utc;
  int kind = impl_->manager.GetNextBigEvent(&event_time, station_index);
  if (kind != 1 && kind != 2) {
    event.error = "OpenCPN TCMgr could not find the next high/low event";
    return event;
  }

  float source_value = 0.0f;
  float direction = 0.0f;
  if (impl_->manager.GetTideOrCurrent(event_time, station_index, source_value,
                                      direction)) {
    float refined_source_value = 0.0f;
    std::time_t refined_time = event_time;
    impl_->manager.GetHightOrLowTide(event_time, 600, 60, source_value,
                                     kind == 2, station_index,
                                     refined_source_value, refined_time);
    if (refined_time > 0) event_time = refined_time;
  }

  float value_m = 0.0f;
  if (!impl_->manager.GetTideOrCurrentMeters(event_time, station_index, value_m,
                                             direction)) {
    event.error = "OpenCPN TCMgr could not predict the event water level";
    return event;
  }

  event.ok = true;
  event.kind = kind == 1 ? "low_water" : "high_water";
  event.event_utc = event_time;
  event.value_m = value_m;
  return event;
}

TideEvent TideEngine::NextHighLowEventNearest(double lat, double lon,
                                              std::time_t after_utc) const {
  TideStation nearest;
  if (!NearestTideStation(lat, lon, &nearest)) {
    TideEvent event;
    event.search_start_utc = after_utc;
    event.error = "no usable tide station found in loaded sources";
    return event;
  }

  TideEvent event = NextHighLowEvent(nearest.index, after_utc);
  event.station.distance_nm = nearest.distance_nm;
  return event;
}

TideSourceResolution TideEngine::ResolveSources(
    const std::vector<TideResolvePoint> &points,
    std::time_t fallback_utc,
    double corridor_nm) const {
  TideSourceResolution resolution;
  resolution.generated_utc = std::time(nullptr);
  resolution.corridor_nm = corridor_nm > 0.0 ? corridor_nm : 25.0;
  resolution.loaded_sources = LoadedSources();
  if (!impl_->loaded) {
    resolution.error = "tide engine has not loaded harmonic sources";
    return resolution;
  }
  if (points.empty()) {
    resolution.error = "no GPS, route, viewport, or explicit tide-resolve points supplied";
    return resolution;
  }

  const double ready_radius_nm = std::max(60.0, resolution.corridor_nm);
  resolution.ok = true;
  resolution.offline_ready = true;
  resolution.official_coverage_ready = true;
  resolution.min_confidence_score = 1.0;

  for (const TideResolvePoint &point : points) {
    TideResolvedPoint out;
    out.point = point;
    std::time_t utc = point.eta_utc != 0 ? point.eta_utc : fallback_utc;
    if (utc == 0) utc = resolution.generated_utc;

    if (!std::isfinite(point.lat) || !std::isfinite(point.lon) ||
        point.lat < -90.0 || point.lat > 90.0 ||
        point.lon < -180.0 || point.lon > 180.0) {
      out.warnings.push_back("invalid coordinate; no tide source resolved");
      out.confidence.tier = "very_low";
      out.confidence.summary = "invalid coordinate";
      resolution.offline_ready = false;
      resolution.official_coverage_ready = false;
      resolution.needs_attention = true;
      resolution.min_confidence_score = 0.0;
      resolution.points.push_back(out);
      continue;
    }

    out.provider_regions = ProviderRegionsForPoint(point.lat, point.lon);
    out.provider_catalog_available = !out.provider_regions.empty();
    for (const TideProviderRegion &region : out.provider_regions) {
      AddUniqueRegion(&resolution.provider_regions, region);
      if (region.official && !region.predictions_available) {
        out.warnings.push_back("matched official provider catalog, but no tide predictions are advertised");
      }
      if (region.requires_subscription) {
        out.warnings.push_back(
            "matched official provider requires subscription/licensed adapter before caching");
      } else if (region.requires_api_key) {
        out.warnings.push_back(
            "matched official provider requires API credentials before caching");
      } else if (region.adapter_status != "api-ready") {
        out.warnings.push_back(
            "matched official provider needs a format-specific adapter before caching");
      }
      if (!region.redistribution_cleared) {
        out.warnings.push_back(
            "matched official provider has redistribution/license review pending");
      }
    }
    if (out.provider_regions.empty()) {
      out.warnings.push_back(
          "no official/provider region catalog entry covers this point");
    }

    TideStation station;
    if (NearestTideStation(point.lat, point.lon, &station)) {
      out.has_harmonic_station = true;
      out.harmonic_station = station;
      out.harmonic_offline_available = true;
      out.confidence = AssessConfidence(point.lat, point.lon, utc, station);
      out.cache_status = "local harmonic fallback available";
      if (out.provider_catalog_available)
        out.cache_status += "; official provider catalog selected";

      if (!station.source_redistribution_cleared) {
        out.warnings.push_back(
            "nearest harmonic source is local/opt-in and needs license review");
      }
      if (station.distance_nm > ready_radius_nm) {
        out.offline_ready = false;
        out.warnings.push_back(
            "nearest harmonic tide station is outside the offline-ready radius");
      } else if (out.confidence.score < 0.35) {
        out.offline_ready = false;
        out.warnings.push_back("harmonic fallback confidence is very low");
      } else {
        out.offline_ready = true;
      }
      if (station.distance_nm > resolution.max_harmonic_station_distance_nm)
        resolution.max_harmonic_station_distance_nm = station.distance_nm;
    } else {
      out.cache_status = "no local harmonic fallback";
      if (out.provider_catalog_available)
        out.cache_status += "; official provider catalog selected";
      out.warnings.push_back("no usable local harmonic tide station found");
      out.confidence.tier = "very_low";
      out.confidence.summary = "no local harmonic tide station";
      out.confidence.score = 0.0;
      out.offline_ready = false;
    }

    OfficialTideReference official;
    if (NearestOfficialReference(point.lat, point.lon, utc, &official)) {
      out.has_official_reference = true;
      out.official_reference = official;
      out.official_metadata_available = true;
      out.observed_feed_available = official.observed_water_level_available;
      const TideProviderRegion *official_region =
          FindRegion(impl_->provider_regions, official.provider_region_id);
      OfficialPredictionCacheInfo cache;
      if (CachedOfficialPrediction(official, utc, &cache)) {
        out.official_prediction_cached = true;
        out.official_prediction_cache = cache;
        if (!out.cache_status.empty()) out.cache_status += "; ";
        out.cache_status += cache.cache_status;
        if (official.distance_nm <= ready_radius_nm) out.offline_ready = true;
      }
      bool official_matches_provider_region = out.provider_regions.empty();
      for (const TideProviderRegion &region : out.provider_regions) {
        if (region.id == official.provider_region_id) {
          official_matches_provider_region = true;
          break;
        }
      }
      if (!official_matches_provider_region &&
          official.distance_nm > ready_radius_nm &&
          !out.provider_regions.empty()) {
        out.official_prediction_request = BuildOfficialPredictionRequest(
            nullptr, &out.provider_regions[0], utc,
            impl_->official_prediction_cache_dir, nullptr);
      } else {
        out.official_prediction_request = BuildOfficialPredictionRequest(
            &official, official_region, utc,
            impl_->official_prediction_cache_dir,
            out.official_prediction_cached ? &out.official_prediction_cache :
                                            nullptr);
      }
      if (!official.valid_for_time) {
        out.warnings.push_back(
            "nearest official tide reference is outside its validity window");
      }
      if (official.distance_nm > ready_radius_nm) {
        out.warnings.push_back(
            "nearest official tide reference is outside the offline-ready radius");
      }
      if (official.distance_nm > resolution.max_official_station_distance_nm)
        resolution.max_official_station_distance_nm = official.distance_nm;
    } else {
      out.warnings.push_back("no official/government tide reference matched");
      if (!out.provider_regions.empty()) {
        out.official_prediction_request = BuildOfficialPredictionRequest(
            nullptr, &out.provider_regions[0], utc,
            impl_->official_prediction_cache_dir, nullptr);
      }
    }

    if (out.provider_catalog_available && !out.has_official_reference) {
      out.warnings.push_back(
          "official region provider is known, but no cached station/calendar reference is available yet");
    }

    if (!out.has_official_reference || !out.official_reference.valid_for_time ||
        out.official_reference.distance_nm > ready_radius_nm) {
      resolution.official_coverage_ready = false;
    }
    if (!out.offline_ready) resolution.offline_ready = false;
    if (!out.warnings.empty() || out.confidence.score < 0.55)
      resolution.needs_attention = true;
    resolution.min_confidence_score =
        std::min(resolution.min_confidence_score, out.confidence.score);

    resolution.points.push_back(out);
  }

  if (resolution.points.empty()) {
    resolution.ok = false;
    resolution.error = "no tide-source coverage points could be evaluated";
    resolution.offline_ready = false;
    resolution.official_coverage_ready = false;
    resolution.min_confidence_score = 0.0;
    return resolution;
  }

  if (resolution.min_confidence_score >= 0.80) {
    resolution.confidence_tier = "high";
  } else if (resolution.min_confidence_score >= 0.55) {
    resolution.confidence_tier = "medium";
  } else if (resolution.min_confidence_score >= 0.35) {
    resolution.confidence_tier = "low";
  } else {
    resolution.confidence_tier = "very_low";
  }

  if (resolution.offline_ready) {
    resolution.cache_summary =
        "local harmonic tide fallback is cached for every requested point";
  } else {
    resolution.cache_summary =
        "one or more requested points need source download, closer station data, or local observations before relying offline";
    resolution.warnings.push_back(
        "route/area is not fully offline-ready for tide guidance");
  }

  if (resolution.official_coverage_ready) {
    resolution.summary =
        "official tide reference metadata and local harmonic fallback cover the requested route/area";
  } else if (resolution.offline_ready) {
    resolution.summary =
        "local harmonic fallback is available, but official coverage is incomplete or remote";
  } else {
    resolution.summary =
        "tide source coverage is incomplete; verify visually and cache better regional data";
  }

  return resolution;
}

TideSourceInfo ClassifySourcePath(const std::string &path) {
  TideSourceInfo info;
  info.path = path;
  info.basename = Basename(path);

  if (info.basename == "harmonics-dwf-20210110-free.tcd") {
    info.license = "Harmonics/public-domain";
    info.provenance = "XTide dwf free harmonic subset packaged by OpenCPN";
    info.redistribution_status = "redistributable";
    info.redistribution_cleared = true;
    info.enabled_by_default = true;
  } else if (info.basename == "ticon-europe-global.tcd") {
    info.license = "CC-BY-SA-4.0";
    info.provenance = "DGFI-TUM TICON Europe data packaged by OpenCPN";
    info.redistribution_status = "attribution-sharealike-commercial-review";
  } else if (info.basename == "HARMONICS_NO_US.IDX" ||
             info.basename == "HARMONICS_NO_US") {
    info.license = "XTide/OpenCPN legacy harmonics";
    info.provenance = "OpenCPN legacy ASCII harmonic source";
    info.redistribution_status = "unverified-commercial-review";
  } else {
    info.license = "unknown";
    info.provenance = "local harmonic source";
    info.redistribution_status = "unverified";
  }

  return info;
}

std::vector<TideSourceInfo> DefaultSourceCatalog(const std::string &tcdata_dir) {
  std::string base = tcdata_dir;
  if (!base.empty() && base.back() != '/') base.push_back('/');
  return {
      ClassifySourcePath(base + "harmonics-dwf-20210110-free.tcd"),
      ClassifySourcePath(base + "HARMONICS_NO_US.IDX"),
      ClassifySourcePath(base + "ticon-europe-global.tcd"),
  };
}

std::vector<TideProviderRegion> DefaultProviderRegions() {
  TideProviderRegion noaa;
  noaa.id = "noaa-coops-us";
  noaa.provider = "NOAA CO-OPS";
  noaa.authority = "NOAA Center for Operational Oceanographic Products and Services";
  noaa.product = "CO-OPS metadata, datums, predictions, water levels, currents";
  noaa.region_name = "United States coastal waters, territories, and Great Lakes";
  noaa.country = "United States";
  noaa.source_url = "https://tidesandcurrents.noaa.gov/";
  noaa.metadata_url = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/";
  noaa.prediction_url_template =
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
      "?begin_date={begin_yyyymmdd}&end_date={end_yyyymmdd}"
      "&station={station}&product=predictions&datum={datum}&time_zone=gmt"
      "&interval=60&units=metric&application=Helm&format=json";
  noaa.observed_url_template =
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
      "?station={station}&product=water_level&datum={datum}&time_zone=gmt"
      "&units=metric&format=json";
  noaa.datum_name = "station datum, commonly MLLW for predictions";
  noaa.license = "US government public data";
  noaa.provenance = "NOAA CO-OPS Data API and Metadata API";
  noaa.redistribution_status = "redistributable-public-domain";
  noaa.cache_policy =
      "cache station metadata/datums by station; cache predictions by station/day; "
      "refresh observed water levels only when online";
  noaa.update_cadence =
      "metadata on demand; predictions by request window; observed water levels near-real-time";
  noaa.adapter_status = "api-ready";
  noaa.intended_use = "official-station";
  noaa.notes =
      "No spatial interpolation; resolver must pick a station and expose distance/datum.";
  noaa.min_lat = 13.0;
  noaa.max_lat = 72.0;
  noaa.min_lon = -180.0;
  noaa.max_lon = -64.0;
  noaa.official = true;
  noaa.predictions_available = true;
  noaa.observations_available = true;
  noaa.currents_available = true;
  noaa.redistribution_cleared = true;
  noaa.enabled_by_default = true;

  TideProviderRegion fiji;
  fiji.id = "fiji-met-cosppac";
  fiji.provider = "Fiji Meteorological Service / COSPPac";
  fiji.authority = "Fiji Meteorological Service";
  fiji.product = "annual tide prediction calendars and COSPPac observed water levels";
  fiji.region_name = "Fiji";
  fiji.country = "Fiji";
  fiji.source_url =
      "https://www.met.gov.fj/climate-services/suva-tide-prediction/";
  fiji.metadata_url = "https://www.met.gov.fj/climate-services/";
  fiji.prediction_url_template =
      "https://www.met.gov.fj/climate-services/{station}-tide-prediction/";
  fiji.observed_url_template = "https://www.bom.gov.au/cosppac/rtdd/";
  fiji.datum_name = "Tide Prediction Datum";
  fiji.license = "public web calendar; redistribution review required";
  fiji.provenance =
      "Fiji Meteorological Service tide prediction pages and COSPPac RTDD";
  fiji.redistribution_status = "official-publication-license-review";
  fiji.cache_policy =
      "cache annual station calendars after parser verifies issue date and station";
  fiji.update_cadence = "annual prediction calendar; observed feed when available";
  fiji.adapter_status = "manual-calendar";
  fiji.intended_use = "official-station";
  fiji.notes =
      "Catalog match is not enough for pass advice; station/calendar parser must cache the departure window.";
  fiji.min_lat = -22.0;
  fiji.max_lat = -15.0;
  fiji.min_lon = 172.0;
  fiji.max_lon = -176.0;
  fiji.official = true;
  fiji.predictions_available = true;
  fiji.observations_available = true;
  fiji.redistribution_cleared = false;
  fiji.enabled_by_default = true;

  TideProviderRegion shom;
  shom.id = "shom-spm-refmar-fr-polynesia";
  shom.provider = "SHOM / REFMAR";
  shom.authority = "Service hydrographique et oceanographique de la Marine";
  shom.product =
      "official tide predictions, sea-level observations, and station metadata";
  shom.region_name = "French Polynesia";
  shom.country = "France / French Polynesia";
  shom.source_url = "https://refmar.shom.fr/";
  shom.metadata_url = "https://data.shom.fr/";
  shom.prediction_url_template =
      "https://services.data.shom.fr/{key}/spm/prediction/maree";
  shom.observed_url_template = "https://refmar.shom.fr/";
  shom.datum_name = "SHOM station datum";
  shom.license = "SHOM public/service terms; subscription key required for prediction service";
  shom.provenance = "SHOM/REFMAR public portals and SHOM data services";
  shom.redistribution_status = "subscription-required-license-review";
  shom.cache_policy =
      "cache itinerary prediction windows only with a configured SHOM key and retained source terms";
  shom.update_cadence =
      "predictions by request window; observed stations as published by REFMAR";
  shom.adapter_status = "subscription-api";
  shom.intended_use = "official-station-or-point";
  shom.notes =
      "This is the Tuamotu/French Polynesia official-source hook; do not treat Copernicus/Open-Meteo as equivalent.";
  shom.min_lat = -28.0;
  shom.max_lat = -5.0;
  shom.min_lon = -155.0;
  shom.max_lon = -134.0;
  shom.official = true;
  shom.predictions_available = true;
  shom.observations_available = true;
  shom.requires_subscription = true;
  shom.redistribution_cleared = false;
  shom.enabled_by_default = false;

  return {noaa, fiji, shom};
}

std::vector<OfficialTideReference> DefaultOfficialReferences() {
  OfficialTideReference suva;
  suva.provider_region_id = "fiji-met-cosppac";
  suva.provider = "Fiji Meteorological Service / COSPPac";
  suva.product = "Suva 2026 tide prediction calendar";
  suva.station_id = "FJ-SUVA-WHARF";
  suva.station_name = "Suva Wharf";
  suva.country = "Fiji";
  suva.source_url =
      "https://www.met.gov.fj/climate-services/suva-tide-prediction/";
  suva.observed_url = "https://www.bom.gov.au/cosppac/rtdd/q1c7o0hj48yu/";
  suva.datum_name = "Tide Prediction Datum";
  suva.issue_date = "2026-04-08";
  suva.valid_start_utc = "2026-01-01T00:00:00Z";
  suva.valid_end_utc = "2026-12-31T23:59:59Z";
  suva.interpolation_method =
      "nearest official station; no spatial interpolation";
  suva.lat = -18.1330;
  suva.lon = 178.4280;
  suva.official = true;
  suva.prediction_calendar = true;
  suva.observed_water_level_available = true;

  OfficialTideReference honolulu;
  honolulu.provider_region_id = "noaa-coops-us";
  honolulu.provider = "NOAA CO-OPS";
  honolulu.product = "CO-OPS station metadata, datums, water levels, predictions";
  honolulu.station_id = "1612340";
  honolulu.station_name = "Honolulu, Honolulu Harbor";
  honolulu.country = "United States";
  honolulu.source_url =
      "https://tidesandcurrents.noaa.gov/stationhome.html?id=1612340";
  honolulu.observed_url =
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
      "?station=1612340&product=water_level&datum=MLLW&time_zone=gmt"
      "&units=metric&format=json";
  honolulu.datum_name = "MLLW";
  honolulu.interpolation_method =
      "NOAA station datum; no spatial interpolation";
  honolulu.lat = 21.3067;
  honolulu.lon = -157.8670;
  honolulu.official = true;
  honolulu.prediction_calendar = false;
  honolulu.observed_water_level_available = true;

  return {suva, honolulu};
}

std::vector<std::string> DefaultSourcePaths(const std::string &tcdata_dir,
                                           TideSourcePolicy policy) {
  std::vector<std::string> paths;
  for (const TideSourceInfo &source : DefaultSourceCatalog(tcdata_dir)) {
    if (policy == TideSourcePolicy::kAllLocal || source.enabled_by_default) {
      paths.push_back(source.path);
    }
  }
  return paths;
}

std::string NoaaCoopsPredictionUrl(const OfficialTideReference &reference,
                                   std::time_t day_utc,
                                   int interval_minutes) {
  int interval = interval_minutes > 0 ? interval_minutes : 60;
  std::string url =
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  url += "?begin_date=" + NoaaDateParam(day_utc);
  url += "&end_date=" + NoaaDateParam(day_utc);
  url += "&station=" + reference.station_id;
  url += "&product=predictions";
  url += "&datum=" + (reference.datum_name.empty() ? "MLLW" :
                                                   reference.datum_name);
  url += "&time_zone=gmt";
  url += "&interval=" + std::to_string(interval);
  url += "&units=metric";
  url += "&application=Helm";
  url += "&format=json";
  return url;
}

bool WriteNoaaCoopsPredictionCache(const OfficialTideReference &reference,
                                   const std::string &cache_dir,
                                   std::time_t day_utc,
                                   const std::string &json_body,
                                   const std::string &source_url,
                                   const std::string &fetched_utc,
                                   OfficialPredictionCacheInfo *out,
                                   std::string *error) {
  if (reference.provider_region_id != "noaa-coops-us") {
    if (error) *error = "NOAA cache writer requires provider noaa-coops-us";
    return false;
  }
  if (cache_dir.empty()) {
    if (error) *error = "cache directory is required";
    return false;
  }
  if (reference.station_id.empty()) {
    if (error) *error = "NOAA station id is required";
    return false;
  }

  int sample_count = CountNoaaPredictionSamples(json_body, error);
  if (sample_count < 0) return false;

  std::string meta_path = CacheMetaPath(cache_dir, reference, day_utc);
  std::string data_path = CacheDataPath(cache_dir, reference, day_utc);
  std::string parent = ParentDir(meta_path);
  if (!EnsureDirRecursive(parent, error)) return false;
  if (!WriteTextFile(data_path, json_body, error)) return false;

  std::string fetched =
      fetched_utc.empty() ? FormatUtcIso8601(std::time(nullptr)) : fetched_utc;
  std::time_t fetched_time = 0;
  std::string refresh_after;
  if (ParseUtcIso8601(fetched, &fetched_time)) {
    refresh_after = FormatUtcIso8601(AddSeconds(fetched_time, 30L * 86400L));
  }

  TideProviderRegion region;
  for (const TideProviderRegion &candidate : DefaultProviderRegions()) {
    if (candidate.id == reference.provider_region_id) {
      region = candidate;
      break;
    }
  }

  std::ostringstream meta;
  meta << KeyValueLine("provider_region_id", reference.provider_region_id);
  meta << KeyValueLine("provider",
                       reference.provider.empty() ? "NOAA CO-OPS" :
                                                    reference.provider);
  meta << KeyValueLine("station_id", reference.station_id);
  meta << KeyValueLine("station_name", reference.station_name);
  meta << KeyValueLine("datum_name",
                       reference.datum_name.empty() ? "MLLW" :
                                                     reference.datum_name);
  meta << KeyValueLine("source_url", source_url);
  meta << KeyValueLine("data_path", data_path);
  meta << KeyValueLine("fetched_utc", fetched);
  meta << KeyValueLine("issue_date", fetched.size() >= 10 ?
                                         fetched.substr(0, 10) : "");
  meta << KeyValueLine("valid_start_utc", DayStartUtc(day_utc));
  meta << KeyValueLine("valid_end_utc", DayEndUtc(day_utc));
  if (!refresh_after.empty())
    meta << KeyValueLine("refresh_after_utc", refresh_after);
  meta << KeyValueLine("time_zone", "GMT");
  meta << KeyValueLine("time_basis", "NOAA CO-OPS GMT API predictions");
  meta << KeyValueLine("license", region.license.empty() ?
                                      "US government public data" :
                                      region.license);
  meta << KeyValueLine("provenance", region.provenance.empty() ?
                                         "NOAA CO-OPS Data API" :
                                         region.provenance);
  meta << KeyValueLine("redistribution_status",
                       region.redistribution_status.empty() ?
                           "redistributable-public-domain" :
                           region.redistribution_status);
  meta << KeyValueLine("cache_status",
                       "official NOAA CO-OPS predictions cached for query day");
  meta << KeyValueLine("sample_count", std::to_string(sample_count));
  meta << KeyValueLine("official", "true");
  meta << KeyValueLine("redistribution_cleared", "true");

  if (!WriteTextFile(meta_path, meta.str(), error)) return false;

  if (out) {
    TideEngine engine;
    engine.SetOfficialPredictionCacheDir(cache_dir);
    OfficialPredictionCacheInfo cache;
    if (engine.CachedOfficialPrediction(reference, day_utc, &cache)) {
      *out = cache;
    } else {
      cache.provider_region_id = reference.provider_region_id;
      cache.provider = reference.provider;
      cache.station_id = reference.station_id;
      cache.station_name = reference.station_name;
      cache.datum_name = reference.datum_name;
      cache.source_url = source_url;
      cache.cache_path = meta_path;
      cache.data_path = data_path;
      cache.fetched_utc = fetched;
      cache.valid_start_utc = DayStartUtc(day_utc);
      cache.valid_end_utc = DayEndUtc(day_utc);
      cache.refresh_after_utc = refresh_after;
      cache.time_zone = "GMT";
      cache.time_basis = "NOAA CO-OPS GMT API predictions";
      cache.sample_count = sample_count;
      cache.official = true;
      cache.valid_for_time = true;
      cache.redistribution_cleared = true;
      cache.ok = true;
      *out = cache;
    }
  }
  return true;
}

bool WriteFijiMetCalendarCache(const OfficialTideReference &reference,
                               const std::string &cache_dir,
                               std::time_t day_utc,
                               const std::string &calendar_body,
                               const std::string &source_url,
                               const std::string &fetched_utc,
                               OfficialPredictionCacheInfo *out,
                               std::string *error) {
  if (reference.provider_region_id != "fiji-met-cosppac") {
    if (error) {
      *error = "Fiji calendar writer requires provider fiji-met-cosppac";
    }
    return false;
  }
  if (cache_dir.empty()) {
    if (error) *error = "cache directory is required";
    return false;
  }
  if (reference.station_id.empty()) {
    if (error) *error = "Fiji station id is required";
    return false;
  }

  std::vector<FijiCalendarRow> rows;
  if (!ParseFijiMetCalendarRows(calendar_body, &rows, error)) return false;

  const std::string requested_date = UtcDateKey(day_utc);
  std::map<std::string, int> sample_counts;
  for (const FijiCalendarRow &row : rows) {
    sample_counts[row.date] += 1;
  }
  auto requested = sample_counts.find(requested_date);
  if (requested == sample_counts.end()) {
    if (error) {
      *error = "Fiji calendar CSV has no events for requested date " +
               requested_date;
    }
    return false;
  }

  TideProviderRegion region;
  for (const TideProviderRegion &candidate : DefaultProviderRegions()) {
    if (candidate.id == reference.provider_region_id) {
      region = candidate;
      break;
    }
  }

  std::string year = requested_date.size() >= 4 ? requested_date.substr(0, 4)
                                                : "calendar";
  std::string data_path = FijiCalendarDataPath(cache_dir, reference, year);
  std::string parent = ParentDir(data_path);
  if (!EnsureDirRecursive(parent, error)) return false;
  if (!WriteTextFile(data_path, calendar_body, error)) return false;

  std::string fetched =
      fetched_utc.empty() ? FormatUtcIso8601(std::time(nullptr)) : fetched_utc;
  std::string refresh_after;
  if (year.size() == 4) {
    refresh_after = year;
    char *end = nullptr;
    long y = std::strtol(year.c_str(), &end, 10);
    if (end && *end == '\0') {
      refresh_after = std::to_string(y + 1) + "-01-31T00:00:00Z";
    } else {
      refresh_after.clear();
    }
  }

  for (const auto &entry : sample_counts) {
    std::time_t date_utc = 0;
    if (!ParseUtcIso8601(entry.first + "T00:00:00Z", &date_utc)) continue;
    std::string meta_path = CacheMetaPath(cache_dir, reference, date_utc);
    std::ostringstream meta;
    meta << KeyValueLine("provider_region_id", reference.provider_region_id);
    meta << KeyValueLine("provider", reference.provider.empty() ?
                                         "Fiji Meteorological Service / COSPPac" :
                                         reference.provider);
    meta << KeyValueLine("station_id", reference.station_id);
    meta << KeyValueLine("station_name", reference.station_name);
    meta << KeyValueLine("datum_name", reference.datum_name.empty() ?
                                           "Tide Prediction Datum" :
                                           reference.datum_name);
    meta << KeyValueLine("source_url",
                         source_url.empty() ? reference.source_url : source_url);
    meta << KeyValueLine("data_path", data_path);
    meta << KeyValueLine("fetched_utc", fetched);
    meta << KeyValueLine("issue_date", reference.issue_date.empty() ?
                                           (fetched.size() >= 10 ?
                                                fetched.substr(0, 10) :
                                                "") :
                                           reference.issue_date);
    meta << KeyValueLine("valid_start_utc", DayStartUtc(date_utc));
    meta << KeyValueLine("valid_end_utc", DayEndUtc(date_utc));
    if (!refresh_after.empty())
      meta << KeyValueLine("refresh_after_utc", refresh_after);
    meta << KeyValueLine("time_zone", "Pacific/Fiji");
    meta << KeyValueLine(
        "time_basis",
        "published local Fiji calendar times; not normalized to UTC in this cache slice");
    meta << KeyValueLine("license", region.license.empty() ?
                                        "public web calendar; redistribution review required" :
                                        region.license);
    meta << KeyValueLine("provenance", region.provenance.empty() ?
                                           "Fiji Meteorological Service tide prediction calendar" :
                                           region.provenance);
    meta << KeyValueLine("redistribution_status",
                         region.redistribution_status.empty() ?
                             "official-publication-license-review" :
                             region.redistribution_status);
    meta << KeyValueLine(
        "cache_status",
        "official Fiji Met/COSPPac calendar events cached for query date; redistribution review pending; weather/swell residuals not included");
    meta << KeyValueLine("sample_count", std::to_string(entry.second));
    meta << KeyValueLine("official", "true");
    meta << KeyValueLine("redistribution_cleared", "false");
    if (!WriteTextFile(meta_path, meta.str(), error)) return false;
  }

  if (out) {
    TideEngine engine;
    engine.SetOfficialPredictionCacheDir(cache_dir);
    OfficialPredictionCacheInfo cache;
    if (engine.CachedOfficialPrediction(reference, day_utc, &cache)) {
      *out = cache;
    } else {
      cache.provider_region_id = reference.provider_region_id;
      cache.provider = reference.provider;
      cache.station_id = reference.station_id;
      cache.station_name = reference.station_name;
      cache.datum_name = reference.datum_name;
      cache.source_url = source_url.empty() ? reference.source_url : source_url;
      cache.cache_path = CacheMetaPath(cache_dir, reference, day_utc);
      cache.data_path = data_path;
      cache.fetched_utc = fetched;
      cache.issue_date = reference.issue_date;
      cache.valid_start_utc = DayStartUtc(day_utc);
      cache.valid_end_utc = DayEndUtc(day_utc);
      cache.refresh_after_utc = refresh_after;
      cache.time_zone = "Pacific/Fiji";
      cache.time_basis =
          "published local Fiji calendar times; not normalized to UTC in this cache slice";
      cache.sample_count = requested->second;
      cache.official = true;
      cache.valid_for_time = true;
      cache.redistribution_cleared = false;
      cache.ok = true;
      *out = cache;
    }
  }
  return true;
}

bool ParseUtcIso8601(const std::string &text, std::time_t *out) {
  if (!out) return false;

  std::tm tm {};
  int year = 0;
  int month = 0;
  int day = 0;
  int hour = 0;
  int minute = 0;
  int second = 0;
  if (std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:%dZ", &year, &month, &day,
                  &hour, &minute, &second) != 6 &&
      std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:%d", &year, &month, &day,
                  &hour, &minute, &second) != 6) {
    return false;
  }

  tm.tm_year = year - 1900;
  tm.tm_mon = month - 1;
  tm.tm_mday = day;
  tm.tm_hour = hour;
  tm.tm_min = minute;
  tm.tm_sec = second;
  tm.tm_isdst = 0;
  *out = TimegmPortable(&tm);
  return *out != static_cast<std::time_t>(-1);
}

std::string FormatUtcIso8601(std::time_t t) {
  std::tm tm {};
#if defined(_WIN32)
  gmtime_s(&tm, &t);
#else
  gmtime_r(&t, &tm);
#endif
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buf;
}

}  // namespace tides
}  // namespace helm

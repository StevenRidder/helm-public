#include "helm_tides.h"

#include <cerrno>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "ixwebsocket/IXHttpClient.h"
#include "ixwebsocket/IXNetSystem.h"

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

const char *JsonBool(bool value) {
  return value ? "true" : "false";
}

bool ParseDouble(const std::string &text, double *out) {
  errno = 0;
  char *end = nullptr;
  double value = std::strtod(text.c_str(), &end);
  if (end == text.c_str() || *end != '\0' || errno == ERANGE ||
      !std::isfinite(value)) {
    return false;
  }
  *out = value;
  return true;
}

bool ParseInt(const std::string &text, int *out) {
  errno = 0;
  char *end = nullptr;
  long value = std::strtol(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0' || errno == ERANGE) {
    return false;
  }
  *out = static_cast<int>(value);
  return true;
}

bool ReadFile(const std::string &path, std::string *body, std::string *error) {
  std::ifstream in(path, std::ios::binary);
  if (!in.good()) {
    if (error) *error = "could not read input file: " + path;
    return false;
  }
  std::ostringstream ss;
  ss << in.rdbuf();
  *body = ss.str();
  return true;
}

bool ParseDay(const std::string &date_or_time, std::time_t *utc);

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

std::string LowerAscii(std::string s) {
  for (char &c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

std::vector<std::string> SplitCsvLine(const std::string &line) {
  std::vector<std::string> fields;
  std::string field;
  bool quoted = false;
  for (size_t i = 0; i < line.size(); ++i) {
    char c = line[i];
    if (c == '"') {
      if (quoted && i + 1 < line.size() && line[i + 1] == '"') {
        field.push_back('"');
        ++i;
      } else {
        quoted = !quoted;
      }
    } else if (c == ',' && !quoted) {
      fields.push_back(Trim(field));
      field.clear();
    } else {
      field.push_back(c);
    }
  }
  fields.push_back(Trim(field));
  return fields;
}

struct ManifestPoint {
  std::string id;
  std::string name;
  double lat = 0.0;
  double lon = 0.0;
  std::time_t utc = 0;
};

bool HasCsvHeader(const std::vector<std::string> &fields) {
  bool has_lat = false;
  bool has_lon = false;
  for (const std::string &field : fields) {
    const std::string key = LowerAscii(Trim(field));
    has_lat = has_lat || key == "lat" || key == "latitude";
    has_lon = has_lon || key == "lon" || key == "lng" ||
              key == "longitude";
  }
  return has_lat && has_lon;
}

std::string FieldByName(const std::vector<std::string> &fields,
                        const std::map<std::string, size_t> &header,
                        const std::vector<std::string> &names) {
  for (const std::string &name : names) {
    auto it = header.find(name);
    if (it != header.end() && it->second < fields.size()) {
      return fields[it->second];
    }
  }
  return "";
}

bool ParseManifestCsv(const std::string &path,
                      std::time_t default_utc,
                      std::vector<ManifestPoint> *points,
                      std::string *error) {
  std::ifstream in(path);
  if (!in.good()) {
    if (error) *error = "could not read points CSV: " + path;
    return false;
  }

  std::map<std::string, size_t> header;
  bool saw_layout = false;
  bool has_header = false;
  std::string line;
  int line_no = 0;
  while (std::getline(in, line)) {
    ++line_no;
    line = Trim(line);
    if (line.empty() || line[0] == '#') continue;

    std::vector<std::string> fields = SplitCsvLine(line);
    if (!saw_layout) {
      saw_layout = true;
      has_header = HasCsvHeader(fields);
      if (has_header) {
        for (size_t i = 0; i < fields.size(); ++i) {
          header[LowerAscii(Trim(fields[i]))] = i;
        }
        continue;
      }
    }

    ManifestPoint point;
    std::string lat_text;
    std::string lon_text;
    std::string time_text;
    if (has_header) {
      point.id = FieldByName(fields, header, {"id", "point_id"});
      point.name = FieldByName(fields, header, {"name", "label"});
      lat_text = FieldByName(fields, header, {"lat", "latitude"});
      lon_text = FieldByName(fields, header, {"lon", "lng", "longitude"});
      time_text = FieldByName(fields, header,
                              {"time", "eta", "time_utc", "date"});
    } else if (fields.size() >= 5) {
      point.id = fields[0];
      point.name = fields[1];
      lat_text = fields[2];
      lon_text = fields[3];
      time_text = fields[4];
    } else if (fields.size() >= 3) {
      lat_text = fields[0];
      lon_text = fields[1];
      time_text = fields[2];
    } else if (fields.size() >= 2) {
      lat_text = fields[0];
      lon_text = fields[1];
    } else {
      if (error) {
        *error = "bad points CSV row " + std::to_string(line_no);
      }
      return false;
    }

    if (!ParseDouble(lat_text, &point.lat) ||
        !ParseDouble(lon_text, &point.lon)) {
      if (error) {
        *error = "bad coordinate in points CSV row " +
                 std::to_string(line_no);
      }
      return false;
    }
    if (time_text.empty()) {
      point.utc = default_utc;
    } else if (!ParseDay(time_text, &point.utc)) {
      if (error) {
        *error = "bad time/date in points CSV row " +
                 std::to_string(line_no);
      }
      return false;
    }
    if (point.id.empty()) point.id = "point-" + std::to_string(points->size() + 1);
    points->push_back(point);
  }

  if (points->empty()) {
    if (error) *error = "points CSV contained no route/GPS points";
    return false;
  }
  return true;
}

void WriteCacheJson(std::ostream &out,
                    const helm::tides::OfficialPredictionCacheInfo &cache) {
  out << "{\"cache_path\":\"" << JsonEscape(cache.cache_path) << "\""
      << ",\"data_path\":\"" << JsonEscape(cache.data_path) << "\""
      << ",\"fetched_utc\":\"" << JsonEscape(cache.fetched_utc) << "\""
      << ",\"valid_start_utc\":\"" << JsonEscape(cache.valid_start_utc)
      << "\""
      << ",\"valid_end_utc\":\"" << JsonEscape(cache.valid_end_utc) << "\""
      << ",\"refresh_after_utc\":\"" << JsonEscape(cache.refresh_after_utc)
      << "\""
      << ",\"time_zone\":\"" << JsonEscape(cache.time_zone) << "\""
      << ",\"time_basis\":\"" << JsonEscape(cache.time_basis) << "\""
      << ",\"sample_count\":" << cache.sample_count
      << ",\"valid_for_time\":" << JsonBool(cache.valid_for_time)
      << ",\"refresh_due\":" << JsonBool(cache.refresh_due)
      << ",\"redistribution_cleared\":"
      << JsonBool(cache.redistribution_cleared) << "}";
}

void WriteRequestJson(std::ostream &out,
                      const helm::tides::OfficialPredictionRequest &request) {
  out << "{\"ok\":" << JsonBool(request.ok)
      << ",\"needed\":" << JsonBool(request.needed)
      << ",\"cached\":" << JsonBool(request.cached)
      << ",\"cache_refresh_due\":" << JsonBool(request.cache_refresh_due)
      << ",\"can_fetch_live\":" << JsonBool(request.can_fetch_live)
      << ",\"manual_import_required\":"
      << JsonBool(request.manual_import_required)
      << ",\"requires_api_key\":" << JsonBool(request.requires_api_key)
      << ",\"requires_subscription\":"
      << JsonBool(request.requires_subscription)
      << ",\"blocked\":" << JsonBool(request.blocked)
      << ",\"action\":\"" << JsonEscape(request.action) << "\""
      << ",\"status\":\"" << JsonEscape(request.status) << "\""
      << ",\"provider_region_id\":\""
      << JsonEscape(request.provider_region_id) << "\""
      << ",\"provider\":\"" << JsonEscape(request.provider) << "\""
      << ",\"adapter_status\":\"" << JsonEscape(request.adapter_status)
      << "\""
      << ",\"station_id\":\"" << JsonEscape(request.station_id) << "\""
      << ",\"station_name\":\"" << JsonEscape(request.station_name) << "\""
      << ",\"datum_name\":\"" << JsonEscape(request.datum_name) << "\""
      << ",\"date_utc\":\"" << JsonEscape(request.date_utc) << "\""
      << ",\"time_zone\":\"" << JsonEscape(request.time_zone) << "\""
      << ",\"source_url\":\"" << JsonEscape(request.source_url) << "\""
      << ",\"fetch_url\":\"" << JsonEscape(request.fetch_url) << "\""
      << ",\"cache_key\":\"" << JsonEscape(request.cache_key) << "\""
      << ",\"cache_path\":\"" << JsonEscape(request.cache_path) << "\""
      << ",\"data_path\":\"" << JsonEscape(request.data_path) << "\""
      << ",\"license\":\"" << JsonEscape(request.license) << "\""
      << ",\"provenance\":\"" << JsonEscape(request.provenance) << "\""
      << ",\"redistribution_status\":\""
      << JsonEscape(request.redistribution_status) << "\""
      << ",\"redistribution_cleared\":"
      << JsonBool(request.redistribution_cleared) << "}";
}

void PrintRequestPlan(const helm::tides::OfficialPredictionRequest &request,
                      bool executed,
                      bool dry_run,
                      const std::string &execution_status,
                      const helm::tides::OfficialPredictionCacheInfo *cache) {
  std::cout << "{\"ok\":" << JsonBool(request.ok)
            << ",\"mode\":\"request-plan\""
            << ",\"executed\":" << JsonBool(executed)
            << ",\"dry_run\":" << JsonBool(dry_run)
            << ",\"blocked\":" << JsonBool(request.blocked)
            << ",\"execution_status\":\""
            << JsonEscape(execution_status) << "\""
            << ",\"request\":";
  WriteRequestJson(std::cout, request);
  if (cache) {
    std::cout << ",\"cache\":";
    WriteCacheJson(std::cout, *cache);
  }
  std::cout << "}\n";
}

struct ManifestItem {
  helm::tides::OfficialPredictionRequest request;
  std::vector<ManifestPoint> points;
  std::string schedule_status;
  std::string schedule_reason;
  int planned_count = 0;
  bool eligible_to_execute = false;
};

struct ManifestSummary {
  int use_cache = 0;
  int fetch_live = 0;
  int refresh_live = 0;
  int import_calendar = 0;
  int refresh_calendar = 0;
  int blocked = 0;
  int auto_fetchable = 0;
  int manual_import = 0;
  int needs_credentials = 0;
  int needs_work = 0;
};

struct SchedulerSummary {
  std::string state_path;
  std::string planned_utc;
  int max_live_fetches = 4;
  int cached = 0;
  int pending_fetch = 0;
  int deferred_rate_limit = 0;
  int manual_import = 0;
  int blocked = 0;
  int manual_review = 0;
  bool state_written = false;
};

std::string ManifestKey(
    const helm::tides::OfficialPredictionRequest &request) {
  const std::string station =
      request.station_id.empty() ? "<station>" : request.station_id;
  return request.provider_region_id + "|" + station + "|" +
         request.date_utc + "|" + request.action;
}

void AddManifestSummary(const helm::tides::OfficialPredictionRequest &request,
                        ManifestSummary *summary) {
  if (request.action == "use-cache") {
    ++summary->use_cache;
  } else if (request.action == "fetch-live") {
    ++summary->fetch_live;
  } else if (request.action == "refresh-live") {
    ++summary->refresh_live;
  } else if (request.action == "import-calendar") {
    ++summary->import_calendar;
  } else if (request.action == "refresh-calendar") {
    ++summary->refresh_calendar;
  }
  if (request.blocked) ++summary->blocked;
  if (!request.blocked && request.can_fetch_live &&
      (request.action == "fetch-live" || request.action == "refresh-live")) {
    ++summary->auto_fetchable;
  }
  if (!request.blocked && request.manual_import_required &&
      (request.action == "import-calendar" ||
       request.action == "refresh-calendar")) {
    ++summary->manual_import;
  }
  if (request.requires_api_key || request.requires_subscription) {
    ++summary->needs_credentials;
  }
  if (request.needed || request.blocked) ++summary->needs_work;
}

std::vector<std::string> SplitTabLine(const std::string &line) {
  std::vector<std::string> fields;
  std::string field;
  for (char c : line) {
    if (c == '\t') {
      fields.push_back(field);
      field.clear();
    } else {
      field.push_back(c);
    }
  }
  fields.push_back(field);
  return fields;
}

std::map<std::string, int> ReadSchedulerCounts(const std::string &path) {
  std::map<std::string, int> counts;
  if (path.empty()) return counts;
  std::ifstream in(path);
  if (!in.good()) return counts;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] == '#') continue;
    std::vector<std::string> fields = SplitTabLine(line);
    if (fields.size() < 3) continue;
    int count = 0;
    if (ParseInt(fields[2], &count)) counts[fields[0]] = count;
  }
  return counts;
}

bool WriteSchedulerState(const std::string &path,
                         const std::vector<ManifestItem> &items,
                         const std::string &planned_utc,
                         std::string *error) {
  std::ofstream out(path, std::ios::trunc);
  if (!out.good()) {
    if (error) *error = "could not write scheduler state: " + path;
    return false;
  }
  out << "# helm-tides-fetch scheduler-state-v1\n";
  out << "# key\tstatus\tplanned_count\tlast_planned_utc\tprovider_region_id\tstation_id\tdate_utc\taction\n";
  for (const ManifestItem &item : items) {
    out << ManifestKey(item.request) << "\t"
        << item.schedule_status << "\t"
        << item.planned_count << "\t"
        << planned_utc << "\t"
        << item.request.provider_region_id << "\t"
        << item.request.station_id << "\t"
        << item.request.date_utc << "\t"
        << item.request.action << "\n";
  }
  return true;
}

bool ApplySchedulerState(std::vector<ManifestItem> *items,
                         const std::string &state_path,
                         int max_live_fetches,
                         std::time_t now_utc,
                         SchedulerSummary *summary,
                         std::string *error) {
  summary->state_path = state_path;
  summary->planned_utc = helm::tides::FormatUtcIso8601(now_utc);
  summary->max_live_fetches = max_live_fetches;
  std::map<std::string, int> prior_counts = ReadSchedulerCounts(state_path);

  int live_fetches = 0;
  for (ManifestItem &item : *items) {
    const helm::tides::OfficialPredictionRequest &request = item.request;
    const std::string key = ManifestKey(request);
    item.planned_count = prior_counts[key] + 1;
    item.eligible_to_execute = false;

    if (request.action == "use-cache") {
      item.schedule_status = "cached";
      item.schedule_reason = "official prediction cache already satisfies this request";
      ++summary->cached;
    } else if (request.blocked) {
      item.schedule_status = "blocked";
      item.schedule_reason = request.status;
      ++summary->blocked;
    } else if (request.can_fetch_live &&
               (request.action == "fetch-live" ||
                request.action == "refresh-live")) {
      if (live_fetches < max_live_fetches) {
        item.schedule_status = "pending_fetch";
        item.schedule_reason = "eligible for explicit provider fetch";
        item.eligible_to_execute = true;
        ++live_fetches;
        ++summary->pending_fetch;
      } else {
        item.schedule_status = "deferred_rate_limit";
        item.schedule_reason = "provider live-fetch budget exhausted for this planning run";
        ++summary->deferred_rate_limit;
      }
    } else if (request.manual_import_required &&
               (request.action == "import-calendar" ||
                request.action == "refresh-calendar")) {
      item.schedule_status = "manual_import";
      item.schedule_reason = "official calendar publication requires manual import";
      ++summary->manual_import;
    } else {
      item.schedule_status = "manual_review";
      item.schedule_reason = request.status.empty() ? "request needs review" :
                                                 request.status;
      ++summary->manual_review;
    }
  }

  if (!state_path.empty()) {
    if (!WriteSchedulerState(state_path, *items, summary->planned_utc, error)) {
      return false;
    }
    summary->state_written = true;
  }
  return true;
}

void WriteManifestPointJson(std::ostream &out, const ManifestPoint &point) {
  out << "{\"id\":\"" << JsonEscape(point.id) << "\""
      << ",\"name\":\"" << JsonEscape(point.name) << "\""
      << ",\"lat\":" << point.lat
      << ",\"lon\":" << point.lon
      << ",\"time_utc\":\""
      << JsonEscape(helm::tides::FormatUtcIso8601(point.utc)) << "\"}";
}

void PrintAcquisitionManifest(const std::vector<ManifestPoint> &points,
                              const std::vector<ManifestItem> &items,
                              const ManifestSummary &summary,
                              const SchedulerSummary *scheduler,
                              int lookahead_days) {
  std::cout << "{\"ok\":true"
            << ",\"mode\":\"acquisition-manifest\""
            << ",\"dry_run\":true"
            << ",\"scheduler_status\":\"planner-only; execute eligible requests separately with --resolve-lat/--resolve-lon --execute-request\""
            << ",\"point_count\":" << points.size()
            << ",\"lookahead_days\":" << lookahead_days
            << ",\"item_count\":" << items.size()
            << ",\"summary\":{\"use_cache\":" << summary.use_cache
            << ",\"fetch_live\":" << summary.fetch_live
            << ",\"refresh_live\":" << summary.refresh_live
            << ",\"import_calendar\":" << summary.import_calendar
            << ",\"refresh_calendar\":" << summary.refresh_calendar
            << ",\"blocked\":" << summary.blocked
            << ",\"auto_fetchable\":" << summary.auto_fetchable
            << ",\"manual_import\":" << summary.manual_import
            << ",\"needs_credentials\":" << summary.needs_credentials
            << ",\"needs_work\":" << summary.needs_work << "}"
            << ",\"scheduler\":";
  if (scheduler) {
    std::cout << "{\"state_path\":\"" << JsonEscape(scheduler->state_path)
              << "\""
              << ",\"state_written\":"
              << JsonBool(scheduler->state_written)
              << ",\"planned_utc\":\""
              << JsonEscape(scheduler->planned_utc) << "\""
              << ",\"max_live_fetches\":"
              << scheduler->max_live_fetches
              << ",\"cached\":" << scheduler->cached
              << ",\"pending_fetch\":" << scheduler->pending_fetch
              << ",\"deferred_rate_limit\":"
              << scheduler->deferred_rate_limit
              << ",\"manual_import\":" << scheduler->manual_import
              << ",\"blocked\":" << scheduler->blocked
              << ",\"manual_review\":" << scheduler->manual_review
              << "}";
  } else {
    std::cout << "null";
  }
  std::cout
            << ",\"items\":[";
  for (size_t i = 0; i < items.size(); ++i) {
    const ManifestItem &item = items[i];
    if (i) std::cout << ",";
    std::cout << "{\"point_count\":" << item.points.size()
              << ",\"request\":";
    WriteRequestJson(std::cout, item.request);
    if (!item.schedule_status.empty()) {
      std::cout << ",\"scheduler\":{\"status\":\""
                << JsonEscape(item.schedule_status) << "\""
                << ",\"reason\":\"" << JsonEscape(item.schedule_reason)
                << "\""
                << ",\"eligible_to_execute\":"
                << JsonBool(item.eligible_to_execute)
                << ",\"planned_count\":" << item.planned_count
                << "}";
    }
    std::cout << ",\"points\":[";
    for (size_t j = 0; j < item.points.size(); ++j) {
      if (j) std::cout << ",";
      WriteManifestPointJson(std::cout, item.points[j]);
    }
    std::cout << "]}";
  }
  std::cout << "]}\n";
}

bool ParseDay(const std::string &date_or_time, std::time_t *utc) {
  if (date_or_time.size() == 10) {
    return helm::tides::ParseUtcIso8601(date_or_time + "T00:00:00Z", utc);
  }
  return helm::tides::ParseUtcIso8601(date_or_time, utc);
}

helm::tides::TideProviderRegion ProviderRegion(const std::string &id) {
  for (const helm::tides::TideProviderRegion &region :
       helm::tides::DefaultProviderRegions()) {
    if (region.id == id) return region;
  }
  return helm::tides::TideProviderRegion();
}

helm::tides::OfficialTideReference FindReference(
    const std::string &provider_region_id,
    const std::string &station_id,
    const std::string &station_name,
    const std::string &datum_name) {
  for (helm::tides::OfficialTideReference ref :
       helm::tides::DefaultOfficialReferences()) {
    if (ref.provider_region_id == provider_region_id &&
        ref.station_id == station_id) {
      if (!station_name.empty()) ref.station_name = station_name;
      if (!datum_name.empty()) ref.datum_name = datum_name;
      return ref;
    }
  }

  helm::tides::TideProviderRegion region = ProviderRegion(provider_region_id);
  helm::tides::OfficialTideReference ref;
  ref.provider_region_id = provider_region_id;
  ref.provider = region.provider;
  ref.product = region.product;
  ref.station_id = station_id;
  ref.station_name = station_name.empty() ? station_id : station_name;
  ref.country = region.country;
  ref.datum_name = datum_name.empty() ? "MLLW" : datum_name;
  ref.interpolation_method = "official station; no spatial interpolation";
  ref.official = region.official;
  ref.prediction_calendar = false;
  ref.observed_water_level_available = region.observations_available;
  return ref;
}

bool FetchLive(const std::string &url, std::string *body, std::string *error) {
  ix::HttpClient client;
  auto args = client.createRequest(url);
  args->connectTimeout = 20;
  args->transferTimeout = 30;
  args->followRedirects = true;
  args->maxRedirects = 3;
  args->compress = true;
  args->extraHeaders["Accept"] = "application/json";
  args->extraHeaders["User-Agent"] = "Helm Tides/0.1";

  ix::HttpResponsePtr response = client.get(url, args);
  if (!response) {
    if (error) *error = "NOAA fetch returned no response";
    return false;
  }
  if (response->errorCode != ix::HttpErrorCode::Ok) {
    if (error) {
      *error = "NOAA fetch failed: " + response->errorMsg;
    }
    return false;
  }
  if (response->statusCode != 200) {
    if (error) {
      *error = "NOAA fetch HTTP status " + std::to_string(response->statusCode);
    }
    return false;
  }
  *body = response->body;
  return true;
}

void PrintUsage() {
  std::cerr
      << "usage: helm-tides-fetch --provider noaa-coops-us --station ID "
         "--date YYYY-MM-DD --cache-dir DIR [--datum MLLW] "
         "[--station-name NAME] (--input-json FILE | --live)\n"
         "       helm-tides-fetch --provider fiji-met-cosppac --station ID "
         "--date YYYY-MM-DD --cache-dir DIR --input-calendar FILE\n"
         "       helm-tides-fetch --resolve-lat LAT --resolve-lon LON "
         "--date YYYY-MM-DD --cache-dir DIR "
         "[--ready-radius-nm NM] [--execute-request] "
         "[--input-json FILE | --input-calendar FILE | --live]\n"
         "       helm-tides-fetch --points-csv FILE --date YYYY-MM-DD "
         "--cache-dir DIR [--lookahead-days N] [--ready-radius-nm NM] "
         "[--scheduler-state FILE] [--max-live-fetches N]\n";
}

}  // namespace

int main(int argc, char **argv) {
  std::string provider_region_id = "noaa-coops-us";
  std::string station_id;
  std::string station_name;
  std::string datum_name = "MLLW";
  std::string day_text;
  std::string cache_dir;
  std::string input_json;
  std::string input_calendar;
  std::string points_csv;
  std::string scheduler_state;
  std::string scheduler_now_text;
  std::string source_url;
  std::string fetched_utc;
  int interval_minutes = 60;
  int lookahead_days = 1;
  int max_live_fetches = 4;
  bool live = false;
  bool execute_request = false;
  double resolve_lat = 0.0;
  double resolve_lon = 0.0;
  double ready_radius_nm = 60.0;
  bool has_resolve_lat = false;
  bool has_resolve_lon = false;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if ((arg == "--provider" || arg == "--provider-region") && i + 1 < argc) {
      provider_region_id = argv[++i];
    } else if (arg == "--station" && i + 1 < argc) {
      station_id = argv[++i];
    } else if (arg == "--station-name" && i + 1 < argc) {
      station_name = argv[++i];
    } else if (arg == "--datum" && i + 1 < argc) {
      datum_name = argv[++i];
    } else if ((arg == "--date" || arg == "--time") && i + 1 < argc) {
      day_text = argv[++i];
    } else if (arg == "--cache-dir" && i + 1 < argc) {
      cache_dir = argv[++i];
    } else if (arg == "--input-json" && i + 1 < argc) {
      input_json = argv[++i];
    } else if (arg == "--input-calendar" && i + 1 < argc) {
      input_calendar = argv[++i];
    } else if (arg == "--points-csv" && i + 1 < argc) {
      points_csv = argv[++i];
    } else if (arg == "--scheduler-state" && i + 1 < argc) {
      scheduler_state = argv[++i];
    } else if (arg == "--scheduler-now" && i + 1 < argc) {
      scheduler_now_text = argv[++i];
    } else if (arg == "--source-url" && i + 1 < argc) {
      source_url = argv[++i];
    } else if (arg == "--fetched-utc" && i + 1 < argc) {
      fetched_utc = argv[++i];
    } else if (arg == "--interval-minutes" && i + 1 < argc) {
      interval_minutes = std::atoi(argv[++i]);
    } else if (arg == "--lookahead-days" && i + 1 < argc) {
      if (!ParseInt(argv[++i], &lookahead_days)) {
        PrintError("bad --lookahead-days");
        return 2;
      }
    } else if (arg == "--max-live-fetches" && i + 1 < argc) {
      if (!ParseInt(argv[++i], &max_live_fetches)) {
        PrintError("bad --max-live-fetches");
        return 2;
      }
    } else if (arg == "--resolve-lat" && i + 1 < argc) {
      if (!ParseDouble(argv[++i], &resolve_lat)) {
        PrintError("bad --resolve-lat");
        return 2;
      }
      has_resolve_lat = true;
    } else if (arg == "--resolve-lon" && i + 1 < argc) {
      if (!ParseDouble(argv[++i], &resolve_lon)) {
        PrintError("bad --resolve-lon");
        return 2;
      }
      has_resolve_lon = true;
    } else if (arg == "--ready-radius-nm" && i + 1 < argc) {
      if (!ParseDouble(argv[++i], &ready_radius_nm)) {
        PrintError("bad --ready-radius-nm");
        return 2;
      }
    } else if (arg == "--execute-request") {
      execute_request = true;
    } else if (arg == "--dry-run") {
      execute_request = false;
    } else if (arg == "--live") {
      live = true;
    } else if (arg == "--help" || arg == "-h") {
      PrintUsage();
      return 0;
    } else {
      PrintUsage();
      PrintError("unknown or incomplete argument: " + arg);
      return 2;
    }
  }

  if (cache_dir.empty()) {
    if (const char *env = std::getenv("HELM_TIDES_CACHE_DIR")) cache_dir = env;
  }
  if (!points_csv.empty()) {
    if (has_resolve_lat || has_resolve_lon) {
      PrintError("--points-csv cannot be combined with --resolve-lat/--resolve-lon");
      return 2;
    }
    if (live || execute_request || !input_json.empty() ||
        !input_calendar.empty()) {
      PrintError("--points-csv is planner-only; execute individual requests separately");
      return 2;
    }
    if (day_text.empty()) {
      PrintError("--date YYYY-MM-DD or --time UTC_ISO is required");
      return 2;
    }
    if (cache_dir.empty()) {
      PrintError("--cache-dir or HELM_TIDES_CACHE_DIR is required");
      return 2;
    }
    if (lookahead_days < 1 || lookahead_days > 14) {
      PrintError("--lookahead-days must be between 1 and 14");
      return 2;
    }
    if (max_live_fetches < 0 || max_live_fetches > 100) {
      PrintError("--max-live-fetches must be between 0 and 100");
      return 2;
    }

    std::time_t default_utc = 0;
    if (!ParseDay(day_text, &default_utc)) {
      PrintError("bad date/time; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ");
      return 2;
    }
    std::time_t scheduler_now = std::time(nullptr);
    if (!scheduler_now_text.empty() &&
        !helm::tides::ParseUtcIso8601(scheduler_now_text, &scheduler_now)) {
      PrintError("bad --scheduler-now; use YYYY-MM-DDTHH:MM:SSZ");
      return 2;
    }

    std::vector<ManifestPoint> base_points;
    std::string error;
    if (!ParseManifestCsv(points_csv, default_utc, &base_points, &error)) {
      PrintError(error);
      return 2;
    }

    helm::tides::TideEngine engine;
    engine.SetOfficialPredictionCacheDir(cache_dir);
    std::map<std::string, ManifestItem> grouped;
    std::vector<std::string> order;
    std::vector<ManifestPoint> expanded_points;
    for (const ManifestPoint &base_point : base_points) {
      for (int day = 0; day < lookahead_days; ++day) {
        ManifestPoint point = base_point;
        point.utc += static_cast<std::time_t>(day) * 86400;
        if (lookahead_days > 1) {
          point.id += "+d" + std::to_string(day);
        }
        expanded_points.push_back(point);
        helm::tides::OfficialPredictionRequest request =
            engine.PlanOfficialPredictionRequest(
                point.lat, point.lon, point.utc, ready_radius_nm);
        const std::string key = ManifestKey(request);
        auto it = grouped.find(key);
        if (it == grouped.end()) {
          ManifestItem item;
          item.request = request;
          item.points.push_back(point);
          grouped[key] = item;
          order.push_back(key);
        } else {
          it->second.points.push_back(point);
        }
      }
    }

    std::vector<ManifestItem> items;
    ManifestSummary summary;
    for (const std::string &key : order) {
      items.push_back(grouped[key]);
      AddManifestSummary(items.back().request, &summary);
    }
    SchedulerSummary scheduler_summary;
    SchedulerSummary *scheduler_ptr = nullptr;
    if (!scheduler_state.empty()) {
      if (!ApplySchedulerState(&items, scheduler_state, max_live_fetches,
                               scheduler_now, &scheduler_summary, &error)) {
        PrintError(error);
        return 1;
      }
      scheduler_ptr = &scheduler_summary;
    }
    PrintAcquisitionManifest(expanded_points, items, summary, scheduler_ptr,
                             lookahead_days);
    return 0;
  }

  const bool resolve_mode = has_resolve_lat || has_resolve_lon;
  if (resolve_mode) {
    if (!has_resolve_lat || !has_resolve_lon) {
      PrintError("--resolve-lat and --resolve-lon must be supplied together");
      return 2;
    }
    if (day_text.empty()) {
      PrintError("--date YYYY-MM-DD or --time UTC_ISO is required");
      return 2;
    }
    if (cache_dir.empty()) {
      PrintError("--cache-dir or HELM_TIDES_CACHE_DIR is required");
      return 2;
    }

    std::time_t day_utc = 0;
    if (!ParseDay(day_text, &day_utc)) {
      PrintError("bad date/time; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ");
      return 2;
    }

    helm::tides::TideEngine engine;
    engine.SetOfficialPredictionCacheDir(cache_dir);
    helm::tides::OfficialPredictionRequest request =
        engine.PlanOfficialPredictionRequest(resolve_lat, resolve_lon, day_utc,
                                             ready_radius_nm);

    const bool source_supplied =
        live || !input_json.empty() || !input_calendar.empty();
    const bool should_execute = execute_request || source_supplied;
    if (!request.ok) {
      PrintRequestPlan(request, false, !should_execute, request.status,
                       nullptr);
      return 1;
    }
    if (request.blocked) {
      PrintRequestPlan(request, false, !should_execute, request.status,
                       nullptr);
      return 0;
    }
    if (request.cached && !request.cache_refresh_due) {
      PrintRequestPlan(request, false, !should_execute,
                       "cache already satisfies request", nullptr);
      return 0;
    }
    if (!should_execute) {
      PrintRequestPlan(request, false, true,
                       "dry-run: request was planned but not executed",
                       nullptr);
      return 0;
    }

    if (request.provider_region_id == "noaa-coops-us") {
      if (input_json.empty() && !live) {
        PrintError("NOAA request execution needs --input-json FILE or --live");
        return 2;
      }
      if (!input_calendar.empty()) {
        PrintError("NOAA request execution does not use --input-calendar");
        return 2;
      }
    } else if (request.provider_region_id == "fiji-met-cosppac") {
      if (input_calendar.empty()) {
        PrintError("Fiji request execution needs --input-calendar FILE");
        return 2;
      }
      if (!input_json.empty() || live) {
        PrintError("Fiji request execution does not use --input-json or --live");
        return 2;
      }
    } else {
      PrintRequestPlan(request, false, false,
                       "provider request execution is not implemented",
                       nullptr);
      return 0;
    }

    helm::tides::OfficialTideReference reference =
        FindReference(request.provider_region_id, request.station_id,
                      request.station_name, request.datum_name);
    if (request.provider_region_id == "fiji-met-cosppac" &&
        reference.datum_name == "MLLW") {
      reference.datum_name = "Tide Prediction Datum";
    }

    if (source_url.empty()) {
      source_url = request.provider_region_id == "noaa-coops-us"
                       ? request.fetch_url
                       : request.source_url;
    }

    std::string body;
    std::string error;
    if (!input_json.empty() || !input_calendar.empty()) {
      const std::string input_path =
          !input_json.empty() ? input_json : input_calendar;
      if (!ReadFile(input_path, &body, &error)) {
        PrintError(error);
        return 1;
      }
    } else {
      ix::initNetSystem();
      bool ok = FetchLive(source_url, &body, &error);
      ix::uninitNetSystem();
      if (!ok) {
        PrintError(error);
        return 1;
      }
    }

    helm::tides::OfficialPredictionCacheInfo cache;
    bool wrote_cache = false;
    if (request.provider_region_id == "noaa-coops-us") {
      wrote_cache = helm::tides::WriteNoaaCoopsPredictionCache(
          reference, cache_dir, day_utc, body, source_url, fetched_utc, &cache,
          &error);
    } else {
      wrote_cache = helm::tides::WriteFijiMetCalendarCache(
          reference, cache_dir, day_utc, body, source_url, fetched_utc, &cache,
          &error);
    }
    if (!wrote_cache) {
      PrintError(error);
      return 1;
    }

    PrintRequestPlan(request, true, false, "cache populated", &cache);
    return 0;
  }

  if (station_id.empty()) {
    PrintError("--station is required");
    return 2;
  }
  if (day_text.empty()) {
    PrintError("--date YYYY-MM-DD or --time UTC_ISO is required");
    return 2;
  }
  if (cache_dir.empty()) {
    PrintError("--cache-dir or HELM_TIDES_CACHE_DIR is required");
    return 2;
  }
  if (provider_region_id == "noaa-coops-us" &&
      (input_json.empty() == !live || !input_calendar.empty())) {
    PrintError("NOAA uses exactly one of --input-json FILE or --live");
    return 2;
  }
  if (provider_region_id == "fiji-met-cosppac" &&
      (input_calendar.empty() || !input_json.empty() || live)) {
    PrintError("Fiji Met/COSPPac uses --input-calendar FILE only");
    return 2;
  }
  if (provider_region_id != "noaa-coops-us" &&
      provider_region_id != "fiji-met-cosppac") {
    PrintError("provider fetch is not implemented: " + provider_region_id);
    return 2;
  }

  std::time_t day_utc = 0;
  if (!ParseDay(day_text, &day_utc)) {
    PrintError("bad date/time; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ");
    return 2;
  }

  helm::tides::OfficialTideReference reference =
      FindReference(provider_region_id, station_id, station_name, datum_name);
  if (provider_region_id == "fiji-met-cosppac" && datum_name == "MLLW") {
    reference.datum_name = "Tide Prediction Datum";
  }

  std::string generated_url;
  if (provider_region_id == "noaa-coops-us") {
    generated_url = helm::tides::NoaaCoopsPredictionUrl(reference, day_utc,
                                                        interval_minutes);
    if (source_url.empty()) source_url = generated_url;
  } else if (source_url.empty()) {
    source_url = reference.source_url;
  }

  std::string body;
  std::string error;
  bool used_live = false;
  if (!input_json.empty() || !input_calendar.empty()) {
    std::string input_path =
        !input_json.empty() ? input_json : input_calendar;
    if (!ReadFile(input_path, &body, &error)) {
      PrintError(error);
      return 1;
    }
  } else {
    ix::initNetSystem();
    used_live = true;
    bool ok = FetchLive(source_url, &body, &error);
    ix::uninitNetSystem();
    if (!ok) {
      PrintError(error);
      return 1;
    }
  }

  helm::tides::OfficialPredictionCacheInfo cache;
  bool wrote_cache = false;
  if (provider_region_id == "noaa-coops-us") {
    wrote_cache = helm::tides::WriteNoaaCoopsPredictionCache(
        reference, cache_dir, day_utc, body, source_url, fetched_utc, &cache,
        &error);
  } else {
    wrote_cache = helm::tides::WriteFijiMetCalendarCache(
        reference, cache_dir, day_utc, body, source_url, fetched_utc, &cache,
        &error);
  }
  if (!wrote_cache) {
    PrintError(error);
    return 1;
  }

  std::cout << "{\"ok\":true"
            << ",\"provider_region_id\":\""
            << JsonEscape(reference.provider_region_id) << "\""
            << ",\"provider\":\"" << JsonEscape(reference.provider) << "\""
            << ",\"station_id\":\"" << JsonEscape(reference.station_id)
            << "\""
            << ",\"station_name\":\"" << JsonEscape(reference.station_name)
            << "\""
            << ",\"datum_name\":\"" << JsonEscape(reference.datum_name)
            << "\""
            << ",\"mode\":\""
            << (used_live ? "live" :
                         (!input_calendar.empty() ? "calendar" : "fixture"))
            << "\""
            << ",\"source_url\":\"" << JsonEscape(source_url) << "\""
            << ",\"cache\":";
  WriteCacheJson(std::cout, cache);
  std::cout << "}\n";
  return 0;
}

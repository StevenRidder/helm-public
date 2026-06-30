// helm_packd.cpp -- local-only Helm pack daemon for BYO MBTiles/PMTiles packs.
//
// First OFFLINE-16 slice:
//   GET  /health                     -> daemon health + pack count
//   GET  /catalog                    -> public pack metadata, no filesystem paths
//   HEAD /catalog                    -> catalog probe headers
//   GET  /{pack}/{z}/{x}/{y}.{ext}   -> MBTiles tile_data, XYZ request -> TMS row
//   GET  /{pack}.pmtiles             -> PMTiles archive bytes with HTTP Range
//   HEAD /{pack}.pmtiles             -> PMTiles protocol probe
//
// Python pipeline/mbtiles_server.py remains the reference/oracle until the C++
// service reaches full parity. OFFLINE-17 owns /layers, /prefetch, and /bundle.

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <fstream>
#include <cmath>
#include <ctime>
#include <functional>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

#include <sqlite3.h>

#include "ixwebsocket/IXHttp.h"
#include "ixwebsocket/IXHttpServer.h"
#include "ixwebsocket/IXConnectionState.h"
#include "rapidjson/document.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"

namespace {

struct SqliteCloser {
  void operator()(sqlite3* db) const {
    if (db) sqlite3_close(db);
  }
};

struct PackRecord {
  std::string id;
  std::string title;
  std::string path;
  std::string container;
  std::string format = "png";
  std::string extension = "png";
  std::string type = "raster";
  std::string kind = "raster";
  std::string source = "local";
  std::string license = "local-user-owned";
  std::string attribution;
  std::string bounds;
  std::string description;
  std::string modified_iso;
  std::string renderer;
  std::string palette;
  std::string display_category;
  int minzoom = 0;
  int maxzoom = 17;
  std::uint64_t size_bytes = 0;
  std::uint64_t modified_epoch = 0;
  bool range = false;
  int pmtiles_version = 0;
  std::uint64_t addressed_tiles = 0;
  std::uint64_t tile_entries = 0;
  std::uint64_t tile_contents = 0;
  std::unique_ptr<rapidjson::Document> public_metadata;
  std::unique_ptr<sqlite3, SqliteCloser> db;
  mutable std::mutex db_mutex;
};

using Headers = ix::WebSocketHttpHeaders;
using JsonValue = rapidjson::Value;
using JsonAllocator = rapidjson::Document::AllocatorType;

std::string get_env(const char* name, const std::string& fallback = std::string()) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

bool starts_with(const std::string& s, const std::string& prefix) {
  return s.size() >= prefix.size() && std::equal(prefix.begin(), prefix.end(), s.begin());
}

bool ends_with(const std::string& s, const std::string& suffix) {
  return s.size() >= suffix.size() && std::equal(suffix.rbegin(), suffix.rend(), s.rbegin());
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string dirname_join(const std::string& base, const std::string& name) {
  if (base.empty() || base == ".") return name;
  return base.back() == '/' ? base + name : base + "/" + name;
}

bool is_abs_path(const std::string& path) {
  return !path.empty() && path[0] == '/';
}

std::string expand_user(std::string path) {
  if (path == "~" || starts_with(path, "~/")) {
    const std::string home = get_env("HOME", ".");
    return home + path.substr(1);
  }
  return path;
}

std::string pack_path(const std::string& base, const std::string& filename) {
  const std::string expanded = expand_user(filename);
  if (is_abs_path(expanded)) return expanded;
  return dirname_join(base, expanded);
}

std::string basename_no_ext(const std::string& path) {
  std::string name = path;
  const std::size_t slash = name.find_last_of('/');
  if (slash != std::string::npos) name = name.substr(slash + 1);
  const std::size_t dot = name.find_last_of('.');
  if (dot != std::string::npos) name = name.substr(0, dot);
  return name;
}

std::string extension_of(const std::string& path) {
  const std::size_t dot = path.find_last_of('.');
  return dot == std::string::npos ? std::string() : lower(path.substr(dot));
}

bool stat_file(const std::string& path, struct stat& st) {
  return ::stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

std::string read_file_text(const std::string& path) {
  std::ifstream in(path);
  if (!in) return std::string();
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::string iso_from_epoch(std::uint64_t epoch) {
  std::time_t t = static_cast<std::time_t>(epoch);
  std::tm tm {};
#if defined(_WIN32)
  gmtime_s(&tm, &t);
#else
  gmtime_r(&t, &tm);
#endif
  char buf[32] = {0};
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buf;
}

std::string now_iso() {
  return iso_from_epoch(static_cast<std::uint64_t>(std::time(nullptr)));
}

const std::set<std::string>& private_keys() {
  static const std::set<std::string> keys = {
    "_path", "path", "file_path", "filepath", "local_path", "private_path", "directory", "dir",
  };
  return keys;
}

bool is_private_key(const std::string& key) {
  return !key.empty() && (key[0] == '_' || private_keys().count(lower(key)) > 0);
}

const std::set<std::string>& sidecar_metadata_keys() {
  static const std::set<std::string> keys = {
    "helm_pack_schema", "pack_role", "renderer", "palette", "display_category", "chart_edition",
    "chart_epoch", "render_date", "stale_after_days", "stale_at", "staleness_status", "z_range",
    "tile_count", "tile_count_expected", "no_coverage_tile_count", "missing_tile_count",
    "coverage_status", "coverage_warning", "palette_pack_group", "palette_pack_count",
    "palette_variants", "generated_by", "source_id", "source_url", "source_ref", "source_format",
    "source_created", "source_updated", "source_downloaded", "source_freshness",
    "source_confidence", "edition", "update", "updated", "created", "coverage_note", "name",
    "title", "kind", "source", "license", "attribution", "description", "bounds", "minzoom",
    "maxzoom", "center", "inspection",
  };
  return keys;
}

const std::set<std::string>& inspection_metadata_keys() {
  static const std::set<std::string> keys = {
    "mode", "semantic_objects", "tap_action", "message", "chart_object_query", "depth_source",
    "confidence", "source_ref", "feature_layer", "sidecar_metadata", "sidecar_name",
  };
  return keys;
}

void add_string(JsonValue& obj, const char* key, const std::string& value, JsonAllocator& a) {
  if (value.empty()) return;
  JsonValue name(key, a);
  JsonValue text(value.c_str(), a);
  obj.AddMember(name, text, a);
}

void add_string_allow_empty(JsonValue& obj, const char* key, const std::string& value, JsonAllocator& a) {
  JsonValue name(key, a);
  JsonValue text(value.c_str(), a);
  obj.AddMember(name, text, a);
}

void add_u64(JsonValue& obj, const char* key, std::uint64_t value, JsonAllocator& a) {
  JsonValue name(key, a);
  obj.AddMember(name, value, a);
}

void add_int(JsonValue& obj, const char* key, int value, JsonAllocator& a) {
  JsonValue name(key, a);
  obj.AddMember(name, value, a);
}

void add_bool(JsonValue& obj, const char* key, bool value, JsonAllocator& a) {
  JsonValue name(key, a);
  obj.AddMember(name, value, a);
}

void add_clone(JsonValue& obj, const char* key, const JsonValue& value, JsonAllocator& a) {
  JsonValue name(key, a);
  JsonValue clone(value, a);
  obj.AddMember(name, clone, a);
}

std::string json_stringify(const JsonValue& value) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  value.Accept(writer);
  return buffer.GetString();
}

bool json_has(const PackRecord& rec, const char* key) {
  return rec.public_metadata && rec.public_metadata->IsObject() && rec.public_metadata->HasMember(key);
}

const JsonValue* json_get(const PackRecord& rec, const char* key) {
  if (!json_has(rec, key)) return nullptr;
  return &(*rec.public_metadata)[key];
}

std::string json_str(const PackRecord& rec, const char* key, const std::string& fallback = std::string()) {
  const JsonValue* v = json_get(rec, key);
  if (!v) return fallback;
  if (v->IsString()) return v->GetString();
  if (v->IsInt64()) return std::to_string(v->GetInt64());
  if (v->IsUint64()) return std::to_string(v->GetUint64());
  if (v->IsBool()) return v->GetBool() ? "true" : "false";
  return fallback;
}

bool json_bool(const PackRecord& rec, const char* key, bool fallback = false) {
  const JsonValue* v = json_get(rec, key);
  if (!v) return fallback;
  if (v->IsBool()) return v->GetBool();
  if (v->IsString()) {
    const std::string s = lower(v->GetString());
    if (s == "1" || s == "true" || s == "yes" || s == "on") return true;
    if (s == "0" || s == "false" || s == "no" || s == "off") return false;
  }
  return fallback;
}

bool json_int64(const PackRecord& rec, const char* key, std::int64_t& out) {
  const JsonValue* v = json_get(rec, key);
  if (!v) return false;
  if (v->IsInt64()) {
    out = v->GetInt64();
    return true;
  }
  if (v->IsUint64()) {
    out = static_cast<std::int64_t>(v->GetUint64());
    return true;
  }
  if (v->IsString()) {
    char* end = nullptr;
    long long parsed = std::strtoll(v->GetString(), &end, 10);
    if (end && *end == '\0') {
      out = parsed;
      return true;
    }
  }
  return false;
}

std::unique_ptr<rapidjson::Document> load_json_document(const std::string& path) {
  const std::string text = read_file_text(path);
  if (text.empty()) return nullptr;
  auto doc = std::make_unique<rapidjson::Document>();
  doc->Parse(text.c_str());
  if (doc->HasParseError() || !doc->IsObject()) return nullptr;
  return doc;
}

void copy_public_value(JsonValue& dest, const std::string& key, const JsonValue& src, JsonAllocator& a);

void copy_public_object(JsonValue& dest, const JsonValue& src, JsonAllocator& a) {
  if (!src.IsObject()) return;
  for (auto it = src.MemberBegin(); it != src.MemberEnd(); ++it) {
    if (!it->name.IsString()) continue;
    const std::string key = it->name.GetString();
    if (is_private_key(key)) continue;
    copy_public_value(dest, key, it->value, a);
  }
}

JsonValue public_clone(const JsonValue& src, JsonAllocator& a) {
  if (src.IsObject()) {
    JsonValue obj(rapidjson::kObjectType);
    copy_public_object(obj, src, a);
    return obj;
  }
  if (src.IsArray()) {
    JsonValue arr(rapidjson::kArrayType);
    for (auto& child : src.GetArray()) {
      JsonValue item = public_clone(child, a);
      arr.PushBack(item, a);
    }
    return arr;
  }
  return JsonValue(src, a);
}

void copy_public_value(JsonValue& dest, const std::string& key, const JsonValue& src, JsonAllocator& a) {
  JsonValue name(key.c_str(), a);
  JsonValue value = public_clone(src, a);
  dest.AddMember(name, value, a);
}

std::string json_escape(const std::string& s) {
  std::ostringstream out;
  for (unsigned char c : s) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
        } else {
          out << static_cast<char>(c);
        }
    }
  }
  return out.str();
}

std::string url_decode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) &&
        std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
      const std::string hex = s.substr(i + 1, 2);
      out.push_back(static_cast<char>(std::strtol(hex.c_str(), nullptr, 16)));
      i += 2;
    } else if (s[i] == '+') {
      out.push_back(' ');
    } else {
      out.push_back(s[i]);
    }
  }
  return out;
}

std::string url_encode(const std::string& s) {
  std::ostringstream out;
  out << std::hex << std::uppercase;
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '~') {
      out << static_cast<char>(c);
    } else {
      out << '%' << std::setw(2) << std::setfill('0') << static_cast<int>(c);
    }
  }
  return out.str();
}

std::string request_path(const std::string& uri) {
  const std::size_t q = uri.find('?');
  return q == std::string::npos ? uri : uri.substr(0, q);
}

std::string header_value(const Headers& headers, const std::string& name) {
  const std::string want = lower(name);
  for (const auto& kv : headers) {
    if (lower(kv.first) == want) return kv.second;
  }
  return std::string();
}

std::string origin_for(const ix::HttpRequestPtr& req, const std::string& bind, int port) {
  std::string proto = header_value(req->headers, "X-Forwarded-Proto");
  if (proto.empty()) proto = "http";
  const std::size_t comma = proto.find(',');
  if (comma != std::string::npos) proto = proto.substr(0, comma);
  std::string host = header_value(req->headers, "Host");
  if (host.empty()) {
    host = (bind == "0.0.0.0" || bind.empty()) ? "127.0.0.1" : bind;
    host += ":" + std::to_string(port);
  }
  return proto + "://" + host;
}

std::string content_type_for(const std::string& ext) {
  const std::string e = lower(ext);
  if (e == "png") return "image/png";
  if (e == "jpg" || e == "jpeg") return "image/jpeg";
  if (e == "webp") return "image/webp";
  if (e == "avif") return "image/avif";
  if (e == "mvt" || e == "pbf") return "application/vnd.mapbox-vector-tile";
  if (e == "pmtiles") return "application/vnd.pmtiles";
  return "application/octet-stream";
}

void base_headers(Headers& h) {
  h["Access-Control-Allow-Origin"] = "*";
  h["Access-Control-Allow-Headers"] = "Range, Content-Type";
  h["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
  h["Access-Control-Expose-Headers"] = "Accept-Ranges, Content-Length, Content-Range, ETag";
  h["Cache-Control"] = "no-cache";
}

ix::HttpResponsePtr response(int status, const std::string& reason, Headers h, std::string body) {
  h["Content-Length"] = std::to_string(body.size());
  return std::make_shared<ix::HttpResponse>(status, reason, ix::HttpErrorCode::Ok, h, body);
}

ix::HttpResponsePtr empty_response(int status, const std::string& reason, Headers h) {
  return response(status, reason, std::move(h), std::string());
}

int safe_int(const std::string& value, int fallback) {
  if (value.empty()) return fallback;
  char* end = nullptr;
  long parsed = std::strtol(value.c_str(), &end, 10);
  return end && *end == '\0' ? static_cast<int>(parsed) : fallback;
}

std::string sqlite_text(sqlite3_stmt* stmt, int col) {
  const unsigned char* text = sqlite3_column_text(stmt, col);
  return text ? reinterpret_cast<const char*>(text) : std::string();
}

std::map<std::string, std::string> read_mbtiles_metadata(sqlite3* db) {
  std::map<std::string, std::string> metadata;
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT name, value FROM metadata", -1, &stmt, nullptr) != SQLITE_OK) {
    return metadata;
  }
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    metadata[sqlite_text(stmt, 0)] = sqlite_text(stmt, 1);
  }
  sqlite3_finalize(stmt);
  return metadata;
}

std::uint64_t u64_le(const unsigned char* p) {
  std::uint64_t v = 0;
  for (int i = 7; i >= 0; --i) v = (v << 8) | p[i];
  return v;
}

std::int32_t i32_le(const unsigned char* p) {
  std::uint32_t v = 0;
  for (int i = 3; i >= 0; --i) v = (v << 8) | p[i];
  return static_cast<std::int32_t>(v);
}

std::string bounds_string_from_pmtiles_header(const unsigned char* header) {
  const double west = i32_le(header + 102) / 10000000.0;
  const double south = i32_le(header + 106) / 10000000.0;
  const double east = i32_le(header + 110) / 10000000.0;
  const double north = i32_le(header + 114) / 10000000.0;
  std::ostringstream out;
  out << std::setprecision(8) << west << "," << south << "," << east << "," << north;
  return out.str();
}

std::string pmtiles_format(int tile_type) {
  switch (tile_type) {
    case 1: return "mvt";
    case 2: return "png";
    case 3: return "jpg";
    case 4: return "webp";
    case 5: return "avif";
    default: return "bin";
  }
}

std::string kind_for(const std::string& id, const std::string& title, const std::string& fmt, const std::string& type) {
  const std::string text = lower(id + " " + title + " " + fmt);
  if (text.find("sat") != std::string::npos || text.find("sentinel") != std::string::npos ||
      text.find("imagery") != std::string::npos || text.find("photo") != std::string::npos) {
    return "satellite";
  }
  if (text.find("chart") != std::string::npos || text.find("navionics") != std::string::npos ||
      text.find("noaa") != std::string::npos || text.find("enc") != std::string::npos) {
    return "chart";
  }
  return type == "vector" ? "vector" : "raster";
}

std::vector<std::pair<std::string, std::string>> parse_pack_map(const std::string& base) {
  std::vector<std::pair<std::string, std::string>> packs;
  const std::string raw = get_env("HELM_MBTILES_PACKS");
  if (!raw.empty()) {
    std::size_t pos = 0;
    while (true) {
      const std::size_t k1 = raw.find('"', pos);
      if (k1 == std::string::npos) break;
      const std::size_t k2 = raw.find('"', k1 + 1);
      const std::size_t colon = raw.find(':', k2 == std::string::npos ? k1 : k2);
      const std::size_t v1 = raw.find('"', colon == std::string::npos ? k1 : colon);
      const std::size_t v2 = raw.find('"', v1 == std::string::npos ? k1 : v1 + 1);
      if (k2 == std::string::npos || colon == std::string::npos || v1 == std::string::npos || v2 == std::string::npos) break;
      packs.emplace_back(raw.substr(k1 + 1, k2 - k1 - 1), raw.substr(v1 + 1, v2 - v1 - 1));
      pos = v2 + 1;
    }
    return packs;
  }

  DIR* dir = ::opendir(base.c_str());
  if (!dir) return packs;
  while (dirent* ent = ::readdir(dir)) {
    const std::string filename = ent->d_name;
    const std::string ext = extension_of(filename);
    if (ext == ".mbtiles" || ext == ".pmtiles") {
      packs.emplace_back(basename_no_ext(filename), filename);
    }
  }
  ::closedir(dir);
  std::sort(packs.begin(), packs.end());
  return packs;
}

std::unique_ptr<rapidjson::Document> load_sidecar_metadata(const std::string& path) {
  const std::size_t dot = path.find_last_of('.');
  const std::string base = dot == std::string::npos ? path : path.substr(0, dot);
  const std::vector<std::string> candidates = {
    base + ".metadata.json",
    base + ".sidecar.json",
    path + ".metadata.json",
    path + ".sidecar.json",
  };
  for (const std::string& candidate : candidates) {
    struct stat st {};
    if (!stat_file(candidate, st)) continue;
    auto raw = load_json_document(candidate);
    if (!raw) {
      std::fprintf(stderr, "warning: cannot parse public metadata sidecar for %s\n", path.c_str());
      return nullptr;
    }
    auto doc = std::make_unique<rapidjson::Document>();
    doc->SetObject();
    JsonAllocator& a = doc->GetAllocator();
    for (auto it = raw->MemberBegin(); it != raw->MemberEnd(); ++it) {
      if (!it->name.IsString()) continue;
      const std::string key = it->name.GetString();
      if (!sidecar_metadata_keys().count(key)) continue;
      if (key == "inspection" && it->value.IsObject()) {
        JsonValue inspection(rapidjson::kObjectType);
        for (auto jt = it->value.MemberBegin(); jt != it->value.MemberEnd(); ++jt) {
          if (!jt->name.IsString()) continue;
          const std::string ikey = jt->name.GetString();
          if (inspection_metadata_keys().count(ikey)) copy_public_value(inspection, ikey, jt->value, a);
        }
        JsonValue inspection_name("inspection", a);
        doc->AddMember(inspection_name, inspection, a);
      } else {
        copy_public_value(*doc, key, it->value, a);
      }
    }
    doc->AddMember("sidecar_metadata", true, a);
    std::string name = candidate;
    const std::size_t slash = name.find_last_of('/');
    if (slash != std::string::npos) name = name.substr(slash + 1);
    JsonValue sidecar_name(name.c_str(), a);
    doc->AddMember("sidecar_name", sidecar_name, a);
    return doc;
  }
  return nullptr;
}

void apply_public_metadata(PackRecord& rec) {
  if (!rec.public_metadata) return;
  const std::string title = json_str(rec, "title", json_str(rec, "name"));
  if (!title.empty()) rec.title = title;
  const std::string kind = json_str(rec, "kind");
  if (!kind.empty()) rec.kind = kind;
  const std::string source = json_str(rec, "source");
  if (!source.empty()) rec.source = source;
  const std::string license = json_str(rec, "license");
  if (!license.empty()) rec.license = license;
  const std::string attribution = json_str(rec, "attribution");
  if (!attribution.empty()) rec.attribution = attribution;
  const std::string bounds = json_str(rec, "bounds");
  if (!bounds.empty()) rec.bounds = bounds;
  const std::string description = json_str(rec, "description");
  if (!description.empty()) rec.description = description;
  rec.renderer = json_str(rec, "renderer", rec.renderer);
  rec.palette = json_str(rec, "palette", rec.palette);
  rec.display_category = json_str(rec, "display_category", rec.display_category);
  std::int64_t value = 0;
  if (json_int64(rec, "minzoom", value)) rec.minzoom = static_cast<int>(value);
  if (json_int64(rec, "maxzoom", value)) rec.maxzoom = static_cast<int>(value);
}

bool open_mbtiles_pack(const std::string& id, const std::string& path, const struct stat& st, PackRecord& rec, std::string& error) {
  sqlite3* raw = nullptr;
  const std::string uri = "file:" + path + "?mode=ro&immutable=1";
  if (sqlite3_open_v2(uri.c_str(), &raw, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nullptr) != SQLITE_OK) {
    error = raw ? sqlite3_errmsg(raw) : "sqlite open failed";
    if (raw) sqlite3_close(raw);
    return false;
  }
  rec.db.reset(raw);
  const auto metadata = read_mbtiles_metadata(rec.db.get());
  auto get = [&](const char* key) -> std::string {
    const auto it = metadata.find(key);
    return it == metadata.end() ? std::string() : it->second;
  };

  rec.id = id;
  rec.path = path;
  rec.container = "mbtiles";
  rec.title = get("name").empty() ? id : get("name");
  rec.format = lower(get("format").empty() ? "png" : get("format"));
  if (rec.format == "jpeg") rec.format = "jpg";
  rec.extension = rec.format == "jpg" ? "jpg" : rec.format;
  rec.type = (rec.format == "pbf" || rec.format == "mvt") ? "vector" : "raster";
  rec.kind = get("kind").empty() ? kind_for(rec.id, rec.title, rec.format, rec.type) : get("kind");
  rec.source = get("source").empty() ? "local" : get("source");
  rec.license = get("license").empty() ? "local-user-owned" : get("license");
  rec.attribution = get("attribution");
  rec.bounds = get("bounds");
  rec.minzoom = safe_int(get("minzoom"), 0);
  rec.maxzoom = safe_int(get("maxzoom"), 17);
  rec.size_bytes = static_cast<std::uint64_t>(st.st_size);
  rec.modified_epoch = static_cast<std::uint64_t>(st.st_mtime);
  rec.modified_iso = iso_from_epoch(rec.modified_epoch);
  rec.public_metadata = load_sidecar_metadata(path);
  apply_public_metadata(rec);
  return true;
}

bool open_pmtiles_pack(const std::string& id, const std::string& path, const struct stat& st, PackRecord& rec, std::string& error) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    error = "cannot open file";
    return false;
  }
  unsigned char header[127] = {0};
  in.read(reinterpret_cast<char*>(header), sizeof(header));
  if (in.gcount() != static_cast<std::streamsize>(sizeof(header)) || std::memcmp(header, "PMTiles", 7) != 0) {
    error = "not a PMTiles v3 archive";
    return false;
  }

  rec.id = id;
  rec.path = path;
  rec.container = "pmtiles";
  rec.range = true;
  rec.pmtiles_version = header[7];
  rec.addressed_tiles = u64_le(header + 72);
  rec.tile_entries = u64_le(header + 80);
  rec.tile_contents = u64_le(header + 88);
  rec.format = pmtiles_format(header[99]);
  rec.extension = rec.format == "jpg" ? "jpg" : rec.format;
  rec.type = rec.format == "mvt" ? "vector" : "raster";
  rec.title = id;
  rec.kind = kind_for(rec.id, rec.title, rec.format, rec.type);
  rec.bounds = bounds_string_from_pmtiles_header(header);
  rec.minzoom = header[100];
  rec.maxzoom = header[101];
  rec.size_bytes = static_cast<std::uint64_t>(st.st_size);
  rec.modified_epoch = static_cast<std::uint64_t>(st.st_mtime);
  rec.modified_iso = iso_from_epoch(rec.modified_epoch);
  rec.public_metadata = load_sidecar_metadata(path);
  apply_public_metadata(rec);
  return true;
}

std::map<std::string, std::shared_ptr<PackRecord>> build_pack_index(const std::string& base) {
  std::map<std::string, std::shared_ptr<PackRecord>> records;
  for (const auto& entry : parse_pack_map(base)) {
    const std::string id = entry.first;
    const std::string path = pack_path(base, entry.second);
    struct stat st {};
    if (!stat_file(path, st)) {
      std::fprintf(stderr, "warning: pack %s not found at %s\n", id.c_str(), path.c_str());
      continue;
    }
    const std::string ext = extension_of(path);
    auto rec = std::make_shared<PackRecord>();
    std::string error;
    const bool ok = ext == ".mbtiles"
      ? open_mbtiles_pack(id, path, st, *rec, error)
      : (ext == ".pmtiles" ? open_pmtiles_pack(id, path, st, *rec, error) : false);
    if (ok) {
      records[id] = rec;
    } else {
      std::fprintf(stderr, "warning: cannot open pack %s: %s\n", id.c_str(), error.c_str());
    }
  }
  return records;
}

std::vector<double> parse_bounds_array(const std::string& bounds) {
  std::vector<double> values;
  std::stringstream ss(bounds);
  std::string item;
  while (std::getline(ss, item, ',')) {
    char* end = nullptr;
    const double v = std::strtod(item.c_str(), &end);
    if (!end || *end != '\0') return {};
    values.push_back(v);
  }
  if (values.size() != 4 || values[0] >= values[2] || values[1] >= values[3]) return {};
  return values;
}

JsonValue bounds_array_json(const PackRecord& rec, JsonAllocator& a) {
  JsonValue arr(rapidjson::kArrayType);
  const JsonValue* direct = json_get(rec, "bounds_array");
  if (direct && direct->IsArray() && direct->Size() == 4) return JsonValue(*direct, a);
  for (double v : parse_bounds_array(rec.bounds)) arr.PushBack(v, a);
  return arr;
}

std::string bounds_string(const std::vector<double>& bbox) {
  if (bbox.size() != 4) return std::string();
  std::ostringstream out;
  out << std::setprecision(8) << bbox[0] << "," << bbox[1] << "," << bbox[2] << "," << bbox[3];
  return out.str();
}

std::string pack_tile_url(const PackRecord& rec, const std::string& origin) {
  const std::string quoted_id = url_encode(rec.id);
  if (rec.container == "pmtiles") return origin + "/" + quoted_id + ".pmtiles";
  return origin + "/" + quoted_id + "/{z}/{x}/{y}." + rec.extension;
}

void add_extra_key(JsonValue& obj, const PackRecord& rec, const char* key, JsonAllocator& a) {
  if (obj.HasMember(key)) return;
  const JsonValue* v = json_get(rec, key);
  if (v) add_clone(obj, key, *v, a);
}

JsonValue warning_json(const std::string& code, const std::string& severity, const std::string& message, JsonAllocator& a) {
  JsonValue w(rapidjson::kObjectType);
  add_string_allow_empty(w, "code", code, a);
  add_string_allow_empty(w, "severity", severity, a);
  add_string_allow_empty(w, "message", message, a);
  return w;
}

JsonValue source_info_json(const PackRecord& rec, JsonAllocator& a) {
  JsonValue info(rapidjson::kObjectType);
  add_string(info, "label", rec.source.empty() ? "local" : rec.source, a);
  add_string(info, "kind", rec.kind, a);
  add_string(info, "container", rec.container, a);
  add_string(info, "format", rec.format, a);
  add_string(info, "license", rec.license, a);
  add_string(info, "attribution", rec.attribution, a);
  add_string(info, "modified", rec.modified_iso, a);
  const std::vector<std::pair<const char*, const char*>> fields = {
    {"id", "source_id"}, {"url", "source_url"}, {"ref", "source_ref"},
    {"format", "source_format"}, {"created", "source_created"}, {"updated", "source_updated"},
    {"downloaded", "source_downloaded"}, {"freshness", "source_freshness"},
    {"confidence", "source_confidence"}, {"chart_edition", "chart_edition"},
    {"chart_epoch", "chart_epoch"}, {"render_date", "render_date"}, {"edition", "edition"},
    {"update", "update"}, {"coverage_note", "coverage_note"},
  };
  for (const auto& kv : fields) {
    const std::string value = json_str(rec, kv.second);
    if (!value.empty()) add_string_allow_empty(info, kv.first, value, a);
  }
  return info;
}

JsonValue coverage_json(const PackRecord& rec, JsonAllocator& a, JsonValue* warnings = nullptr) {
  JsonValue coverage(rapidjson::kObjectType);
  std::int64_t tile_count = 0;
  bool has_tile_count = json_int64(rec, "tile_count", tile_count);
  if (!has_tile_count && rec.addressed_tiles > 0) {
    tile_count = static_cast<std::int64_t>(rec.addressed_tiles);
    has_tile_count = true;
  }
  std::int64_t expected = 0;
  const bool has_expected = json_int64(rec, "tile_count_expected", expected);
  std::int64_t no_coverage = 0;
  std::int64_t missing = 0;
  json_int64(rec, "no_coverage_tile_count", no_coverage);
  json_int64(rec, "missing_tile_count", missing);

  std::string status = json_str(rec, "coverage_status");
  if (!has_expected || expected <= 0) {
    if (status.empty()) status = "unknown";
    add_string_allow_empty(coverage, "status", status, a);
    if (has_tile_count) coverage.AddMember("tile_count", tile_count, a);
    return coverage;
  }

  std::int64_t gaps = std::max<std::int64_t>(0, no_coverage) + std::max<std::int64_t>(0, missing);
  if (has_tile_count) gaps = std::max(gaps, expected - tile_count);
  if (status.empty()) status = gaps == 0 ? "complete" : "partial";
  add_string_allow_empty(coverage, "status", status, a);
  if (has_tile_count) coverage.AddMember("tile_count", tile_count, a);
  coverage.AddMember("tile_count_expected", expected, a);
  coverage.AddMember("no_coverage_tile_count", no_coverage, a);
  coverage.AddMember("missing_tile_count", missing, a);
  coverage.AddMember("gap_count", gaps, a);
  coverage.AddMember("gap_ratio", expected ? static_cast<double>(gaps) / static_cast<double>(expected) : 0.0, a);
  if (status != "complete" || gaps > 0) {
    std::string message = json_str(rec, "coverage_warning");
    if (message.empty()) {
      message = "Pack has coverage gaps: " + std::to_string(no_coverage) + " no-coverage tile(s), " +
                std::to_string(missing) + " failed tile request(s), " + std::to_string(expected) +
                " requested tile(s).";
    }
    add_string(coverage, "warning", message, a);
    if (warnings) {
      JsonValue warning = warning_json("pack_out_of_coverage", "warning", message, a);
      warnings->PushBack(warning, a);
    }
  }
  return coverage;
}

JsonValue staleness_json(const PackRecord& rec, JsonAllocator& a, JsonValue* warnings = nullptr) {
  JsonValue staleness(rapidjson::kObjectType);
  const std::string render_date = json_str(rec, "render_date");
  if (render_date.empty()) {
    const std::string message = "Pack has no render_date; freshness cannot be verified.";
    add_string_allow_empty(staleness, "status", "unknown", a);
    add_string(staleness, "warning", message, a);
    if (warnings) {
      JsonValue warning = warning_json("pack_freshness_unknown", "warning", message, a);
      warnings->PushBack(warning, a);
    }
    return staleness;
  }
  const bool forced_stale = lower(json_str(rec, "staleness_status")) == "stale" || json_bool(rec, "is_stale");
  add_string_allow_empty(staleness, "status", forced_stale ? "stale" : "fresh", a);
  add_string_allow_empty(staleness, "render_date", render_date, a);
  std::int64_t stale_after = 0;
  if (json_int64(rec, "stale_after_days", stale_after)) staleness.AddMember("stale_after_days", stale_after, a);
  add_string(staleness, "stale_at", json_str(rec, "stale_at"), a);
  if (forced_stale) {
    const std::string message = "Pack render date is older than the configured freshness window.";
    add_string(staleness, "warning", message, a);
    if (warnings) {
      JsonValue warning = warning_json("pack_stale", "warning", message, a);
      warnings->PushBack(warning, a);
    }
  }
  return staleness;
}

JsonValue inspection_json(const PackRecord& rec, JsonAllocator& a) {
  JsonValue inspection(rapidjson::kObjectType);
  const JsonValue* override = json_get(rec, "inspection");
  if (override && override->IsObject()) {
    copy_public_object(inspection, *override, a);
    if (!inspection.HasMember("sidecar_metadata")) add_bool(inspection, "sidecar_metadata", json_bool(rec, "sidecar_metadata"), a);
    const std::string sidecar_name = json_str(rec, "sidecar_name");
    if (!sidecar_name.empty() && !inspection.HasMember("sidecar_name")) add_string(inspection, "sidecar_name", sidecar_name, a);
  } else {
    const bool is_vector = rec.type == "vector" || rec.format == "mvt" || rec.format == "pbf";
    const bool has_sidecar = json_bool(rec, "sidecar_metadata");
    add_bool(inspection, "sidecar_metadata", has_sidecar, a);
    add_string(inspection, "sidecar_name", json_str(rec, "sidecar_name"), a);
    if (rec.kind == "depth") {
      add_string_allow_empty(inspection, "mode", "depth_sample", a);
      add_string_allow_empty(inspection, "semantic_objects", "depth_values", a);
      add_string_allow_empty(inspection, "tap_action", "show_depth_source_confidence", a);
      add_string_allow_empty(inspection, "message", "Depth packs may expose sampled value/source/confidence; they are not chart-object attributes.", a);
    } else if (is_vector) {
      add_string_allow_empty(inspection, "mode", "vector_features", a);
      add_string_allow_empty(inspection, "semantic_objects", "available", a);
      add_string_allow_empty(inspection, "tap_action", "query_vector_features", a);
      add_string_allow_empty(inspection, "message", "Vector packs may expose feature attributes when the client layer supports picking.", a);
    } else if (has_sidecar) {
      add_string_allow_empty(inspection, "mode", "sidecar_metadata", a);
      add_string_allow_empty(inspection, "semantic_objects", "sidecar", a);
      add_string_allow_empty(inspection, "tap_action", "show_sidecar_then_pack_metadata", a);
      add_string_allow_empty(inspection, "message", "Raster pixels are not semantic objects; sidecar metadata may provide curated object hints.", a);
    } else {
      add_string_allow_empty(inspection, "mode", "raster_metadata", a);
      add_string_allow_empty(inspection, "semantic_objects", "unavailable", a);
      add_string_allow_empty(inspection, "tap_action", "show_pack_source_metadata", a);
      add_string_allow_empty(inspection, "message", "Raster packs contain pixels only; object inspection is unavailable unless a sidecar metadata layer is present.", a);
    }
  }
  if (rec.kind == "chart" && rec.renderer == "s52" && !inspection.HasMember("chart_object_query")) {
    add_string_allow_empty(inspection, "chart_object_query", "use_live_CHART_10_query_when_source_ENC_is_mounted", a);
  }
  return inspection;
}

JsonValue pack_json(const PackRecord& rec, const std::string& origin, JsonAllocator& a) {
  JsonValue out(rapidjson::kObjectType);
  add_string_allow_empty(out, "id", rec.id, a);
  add_string_allow_empty(out, "name", rec.id, a);
  add_string_allow_empty(out, "title", rec.title, a);
  add_string_allow_empty(out, "container", rec.container, a);
  add_string_allow_empty(out, "format", rec.format, a);
  add_string_allow_empty(out, "extension", rec.extension, a);
  add_string_allow_empty(out, "type", rec.type, a);
  add_string_allow_empty(out, "kind", rec.kind, a);
  add_string_allow_empty(out, "source", rec.source, a);
  add_string_allow_empty(out, "license", rec.license, a);
  add_u64(out, "size_bytes", rec.size_bytes, a);
  add_string(out, "modified", rec.modified_iso, a);
  add_u64(out, "modified_epoch", rec.modified_epoch, a);
  add_int(out, "minzoom", rec.minzoom, a);
  add_int(out, "maxzoom", rec.maxzoom, a);
  add_string(out, "bounds", rec.bounds, a);
  JsonValue bounds = bounds_array_json(rec, a);
  if (bounds.IsArray() && bounds.Size() == 4) out.AddMember("bounds_array", bounds, a);
  add_string(out, "attribution", rec.attribution, a);
  add_string(out, "description", rec.description, a);
  add_string(out, "renderer", rec.renderer, a);
  add_string(out, "palette", rec.palette, a);
  add_string(out, "display_category", rec.display_category, a);

  const std::string url = pack_tile_url(rec, origin);
  if (rec.container == "mbtiles") {
    add_string_allow_empty(out, "tile_url", url, a);
    add_string_allow_empty(out, "url", url, a);
  } else {
    add_bool(out, "range", true, a);
    add_int(out, "pmtiles_version", rec.pmtiles_version, a);
    add_u64(out, "addressed_tiles", rec.addressed_tiles, a);
    add_u64(out, "tile_entries", rec.tile_entries, a);
    add_u64(out, "tile_contents", rec.tile_contents, a);
    add_string_allow_empty(out, "pmtiles_url", url, a);
    add_string_allow_empty(out, "protocol_url", "pmtiles://" + url, a);
    add_string_allow_empty(out, "url", url, a);
  }

  const std::vector<const char*> passthrough = {
    "helm_pack_schema", "pack_role", "chart_edition", "chart_epoch", "render_date",
    "stale_after_days", "stale_at", "staleness_status", "z_range", "tile_count",
    "tile_count_expected", "no_coverage_tile_count", "missing_tile_count", "coverage_status",
    "coverage_warning", "palette_pack_group", "palette_pack_count", "palette_variants",
    "generated_by", "source_id", "source_url", "source_ref", "source_format", "source_created",
    "source_updated", "source_downloaded", "source_freshness", "source_confidence", "edition",
    "update", "updated", "created", "coverage_note", "sidecar_metadata", "sidecar_name",
  };
  for (const char* key : passthrough) add_extra_key(out, rec, key, a);

  JsonValue warnings(rapidjson::kArrayType);
  JsonValue coverage = coverage_json(rec, a, &warnings);
  out.AddMember("coverage", coverage, a);
  JsonValue staleness = staleness_json(rec, a, &warnings);
  out.AddMember("staleness", staleness, a);
  JsonValue source = source_info_json(rec, a);
  out.AddMember("source_info", source, a);
  JsonValue inspection = inspection_json(rec, a);
  out.AddMember("inspection", inspection, a);
  out.AddMember("warnings", warnings, a);
  return out;
}

std::string catalog_json(const std::map<std::string, std::shared_ptr<PackRecord>>& packs,
                         const std::string& origin) {
  rapidjson::Document doc;
  doc.SetObject();
  JsonAllocator& a = doc.GetAllocator();
  for (const auto& kv : packs) {
    JsonValue name(kv.first.c_str(), a);
    JsonValue pack = pack_json(*kv.second, origin, a);
    doc.AddMember(name, pack, a);
  }
  return json_stringify(doc);
}

using Query = std::map<std::string, std::vector<std::string>>;
using EnvBundle = std::shared_ptr<rapidjson::Document>;

Query parse_query_string(const std::string& uri) {
  Query query;
  const std::size_t qpos = uri.find('?');
  if (qpos == std::string::npos) return query;
  std::size_t pos = qpos + 1;
  while (pos <= uri.size()) {
    const std::size_t amp = uri.find('&', pos);
    const std::string part = uri.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
    const std::size_t eq = part.find('=');
    const std::string key = url_decode(eq == std::string::npos ? part : part.substr(0, eq));
    const std::string value = url_decode(eq == std::string::npos ? std::string() : part.substr(eq + 1));
    if (!key.empty()) query[key].push_back(value);
    if (amp == std::string::npos) break;
    pos = amp + 1;
  }
  return query;
}

std::string qfirst(const Query& query, const std::string& key, const std::string& fallback = std::string()) {
  const auto it = query.find(key);
  return it == query.end() || it->second.empty() ? fallback : it->second.front();
}

int qint(const Query& query, const std::string& key, int fallback, int min_value, int max_value) {
  const std::string raw = qfirst(query, key, std::to_string(fallback));
  char* end = nullptr;
  long value = std::strtol(raw.c_str(), &end, 10);
  if (!end || *end != '\0' || value < min_value || value > max_value) {
    throw std::runtime_error(key + " must be between " + std::to_string(min_value) + " and " + std::to_string(max_value));
  }
  return static_cast<int>(value);
}

double qdouble(const Query& query, const std::string& key, double fallback, double min_value, double max_value) {
  const std::string raw = qfirst(query, key);
  if (raw.empty()) return fallback;
  char* end = nullptr;
  double value = std::strtod(raw.c_str(), &end);
  if (!end || *end != '\0' || value < min_value || value > max_value) {
    throw std::runtime_error(key + " must be in range");
  }
  return value;
}

bool qbool(const Query& query, const std::string& key, bool fallback) {
  const std::string raw = lower(qfirst(query, key, fallback ? "1" : "0"));
  if (raw == "1" || raw == "true" || raw == "yes" || raw == "on") return true;
  if (raw == "0" || raw == "false" || raw == "no" || raw == "off") return false;
  throw std::runtime_error(key + " must be true/false");
}

std::vector<std::string> split_csv(const std::string& raw) {
  std::vector<std::string> out;
  std::stringstream ss(raw);
  std::string item;
  while (std::getline(ss, item, ',')) {
    item.erase(item.begin(), std::find_if(item.begin(), item.end(), [](unsigned char c) { return !std::isspace(c); }));
    item.erase(std::find_if(item.rbegin(), item.rend(), [](unsigned char c) { return !std::isspace(c); }).base(), item.end());
    if (!item.empty()) out.push_back(item);
  }
  return out;
}

double clamp_lat(double lat) {
  const double limit = 85.05112878;
  return std::max(-limit, std::min(limit, lat));
}

double clamp_lon(double lon) {
  return std::max(-180.0, std::min(180.0, lon));
}

std::vector<double> parse_bbox_query(const std::string& raw) {
  const std::vector<double> bbox = parse_bounds_array(raw);
  if (bbox.empty()) throw std::runtime_error("bbox must be W,S,E,N");
  return {clamp_lon(bbox[0]), clamp_lat(bbox[1]), clamp_lon(bbox[2]), clamp_lat(bbox[3])};
}

std::vector<std::vector<double>> parse_route_query(const std::string& raw) {
  std::vector<std::vector<double>> points;
  std::string normalized = raw;
  std::replace(normalized.begin(), normalized.end(), '|', ';');
  std::stringstream ss(normalized);
  std::string part;
  while (std::getline(ss, part, ';')) {
    if (part.empty()) continue;
    const auto vals = parse_bounds_array(part + "," + part);
    if (!vals.empty()) {
      points.push_back({clamp_lon(vals[0]), clamp_lat(vals[1])});
      continue;
    }
    std::stringstream ps(part);
    std::string a, b;
    if (!std::getline(ps, a, ',') || !std::getline(ps, b, ',')) throw std::runtime_error("route must be lon,lat;lon,lat");
    char* e1 = nullptr;
    char* e2 = nullptr;
    const double lon = std::strtod(a.c_str(), &e1);
    const double lat = std::strtod(b.c_str(), &e2);
    if (!e1 || *e1 != '\0' || !e2 || *e2 != '\0') throw std::runtime_error("route must be lon,lat;lon,lat");
    points.push_back({clamp_lon(lon), clamp_lat(lat)});
  }
  if (points.size() < 2) throw std::runtime_error("route requires at least two lon,lat points");
  return points;
}

std::vector<double> expand_route_bbox(const std::vector<std::vector<double>>& points, double radius_nm) {
  double west = points.front()[0], east = points.front()[0], south = points.front()[1], north = points.front()[1];
  for (const auto& p : points) {
    west = std::min(west, p[0]);
    east = std::max(east, p[0]);
    south = std::min(south, p[1]);
    north = std::max(north, p[1]);
  }
  const double lat_pad = radius_nm / 60.0;
  const double mid_lat = (south + north) / 2.0;
  const double cos_lat = std::max(0.2, std::abs(std::cos(mid_lat * 3.14159265358979323846 / 180.0)));
  const double lon_pad = radius_nm / (60.0 * cos_lat);
  return {clamp_lon(west - lon_pad), clamp_lat(south - lat_pad), clamp_lon(east + lon_pad), clamp_lat(north + lat_pad)};
}

std::vector<double> intersect_bbox(const std::vector<double>& a, const std::vector<double>& b) {
  if (a.size() != 4 || b.size() != 4) return {};
  const double west = std::max(a[0], b[0]);
  const double south = std::max(a[1], b[1]);
  const double east = std::min(a[2], b[2]);
  const double north = std::min(a[3], b[3]);
  if (west >= east || south >= north) return {};
  return {west, south, east, north};
}

JsonValue bbox_json(const std::vector<double>& bbox, JsonAllocator& a) {
  JsonValue arr(rapidjson::kArrayType);
  for (double v : bbox) arr.PushBack(v, a);
  return arr;
}

std::pair<int, int> deg2num(double lon, double lat, int z) {
  lat = clamp_lat(lat);
  const int n = 1 << z;
  int x = static_cast<int>((lon + 180.0) / 360.0 * n);
  const double lat_rad = lat * 3.14159265358979323846 / 180.0;
  int y = static_cast<int>((1.0 - std::asinh(std::tan(lat_rad)) / 3.14159265358979323846) / 2.0 * n);
  return {std::max(0, std::min(n - 1, x)), std::max(0, std::min(n - 1, y))};
}

std::pair<JsonValue, int> tiles_for_bbox(const std::vector<double>& bbox, int minzoom, int maxzoom, int max_tiles, JsonAllocator& a) {
  JsonValue tiles(rapidjson::kArrayType);
  int total = 0;
  for (int z = minzoom; z <= maxzoom; ++z) {
    const auto nw = deg2num(bbox[0], bbox[3], z);
    const auto se = deg2num(bbox[2], bbox[1], z);
    for (int x = std::min(nw.first, se.first); x <= std::max(nw.first, se.first); ++x) {
      for (int y = std::min(nw.second, se.second); y <= std::max(nw.second, se.second); ++y) {
        ++total;
        if (tiles.Size() < static_cast<rapidjson::SizeType>(max_tiles)) {
          JsonValue tile(rapidjson::kObjectType);
          add_int(tile, "z", z, a);
          add_int(tile, "x", x, a);
          add_int(tile, "y", y, a);
          tiles.PushBack(tile, a);
        }
      }
    }
  }
  return {std::move(tiles), std::max(0, total - static_cast<int>(tiles.Size()))};
}

std::vector<std::string> select_pack_ids(const std::map<std::string, std::shared_ptr<PackRecord>>& packs, const Query& query) {
  const std::string raw = qfirst(query, "packs");
  if (raw.empty()) {
    std::vector<std::string> ids;
    for (const auto& kv : packs) ids.push_back(kv.first);
    return ids;
  }
  std::vector<std::string> ids = split_csv(raw);
  for (const std::string& id : ids) {
    if (!packs.count(id)) throw std::runtime_error("unknown pack: " + id);
  }
  return ids;
}

std::string tile_url_for(const PackRecord& rec, const JsonValue& tile, const std::string& origin) {
  const int z = tile["z"].GetInt();
  const int x = tile["x"].GetInt();
  const int y = tile["y"].GetInt();
  if (rec.container == "pmtiles") return "pmtiles://" + pack_tile_url(rec, origin) + "/" + std::to_string(z) + "/" + std::to_string(x) + "/" + std::to_string(y);
  std::string url = pack_tile_url(rec, origin);
  const auto repl = [](std::string& s, const std::string& from, const std::string& to) {
    const std::size_t pos = s.find(from);
    if (pos != std::string::npos) s.replace(pos, from.size(), to);
  };
  repl(url, "{z}", std::to_string(z));
  repl(url, "{x}", std::to_string(x));
  repl(url, "{y}", std::to_string(y));
  return url;
}

int estimate_bytes(const PackRecord& rec, int tile_count) {
  std::int64_t source_tiles = 0;
  if (!json_int64(rec, "tile_count", source_tiles) || source_tiles <= 0) {
    source_tiles = rec.addressed_tiles ? static_cast<std::int64_t>(rec.addressed_tiles) : static_cast<std::int64_t>(rec.tile_entries);
  }
  if (source_tiles <= 0) return -1;
  return static_cast<int>((static_cast<double>(rec.size_bytes) / static_cast<double>(source_tiles)) * tile_count);
}

std::vector<EnvBundle> load_environmental_bundles() {
  std::vector<EnvBundle> bundles;
  const std::string raw = get_env("HELM_ENV_BUNDLE_MANIFESTS");
  for (const std::string& path_raw : split_csv(raw)) {
    const std::string path = expand_user(path_raw);
    auto doc = load_json_document(path);
    if (!doc) {
      std::fprintf(stderr, "warning: cannot read environmental bundle manifest %s\n", path.c_str());
      continue;
    }
    if (doc->HasMember("schema") && (*doc)["schema"].IsString() && std::string((*doc)["schema"].GetString()) == "helm.env.bundle.v1") {
      bundles.push_back(std::move(doc));
    }
  }
  return bundles;
}

std::string rj_string(const JsonValue& obj, const char* key, const std::string& fallback = std::string()) {
  if (!obj.IsObject() || !obj.HasMember(key)) return fallback;
  const JsonValue& v = obj[key];
  if (v.IsString()) return v.GetString();
  if (v.IsBool()) return v.GetBool() ? "true" : "false";
  if (v.IsInt64()) return std::to_string(v.GetInt64());
  if (v.IsUint64()) return std::to_string(v.GetUint64());
  return fallback;
}

const JsonValue* rj_object(const JsonValue& obj, const char* key) {
  if (!obj.IsObject() || !obj.HasMember(key) || !obj[key].IsObject()) return nullptr;
  return &obj[key];
}

JsonValue env_bbox_value(const JsonValue& manifest, JsonAllocator& a, bool* crosses = nullptr) {
  JsonValue out(rapidjson::kArrayType);
  const JsonValue* coverage = rj_object(manifest, "coverage");
  if (!coverage || !coverage->HasMember("bbox")) return out;
  const JsonValue& bbox = (*coverage)["bbox"];
  if (bbox.IsObject()) {
    const double west = bbox.HasMember("west") ? bbox["west"].GetDouble() : 0.0;
    const double south = bbox.HasMember("south") ? bbox["south"].GetDouble() : 0.0;
    const double east = bbox.HasMember("east") ? bbox["east"].GetDouble() : 0.0;
    const double north = bbox.HasMember("north") ? bbox["north"].GetDouble() : 0.0;
    if (crosses) *crosses = (bbox.HasMember("crossesAntimeridian") && bbox["crossesAntimeridian"].GetBool()) || west > east;
    out.PushBack(west, a).PushBack(south, a).PushBack(east, a).PushBack(north, a);
  } else if (bbox.IsArray() && bbox.Size() == 4) {
    if (crosses) *crosses = false;
    for (auto& v : bbox.GetArray()) out.PushBack(v.GetDouble(), a);
  }
  return out;
}

std::vector<std::string> env_layer_names(const JsonValue& manifest, const Query& query) {
  std::vector<std::string> names;
  const JsonValue* layers = rj_object(manifest, "layers");
  if (!layers) return names;
  const std::string raw = qfirst(query, "env_layers", qfirst(query, "weather_layers"));
  if (!raw.empty()) return split_csv(raw);
  for (auto it = layers->MemberBegin(); it != layers->MemberEnd(); ++it) {
    if (it->name.IsString()) names.push_back(it->name.GetString());
  }
  std::sort(names.begin(), names.end());
  return names;
}

JsonValue env_prefetch_entry(const JsonValue& manifest, const Query& query, const std::vector<double>& bbox,
                             int minzoom, int maxzoom, JsonAllocator& a) {
  JsonValue entry(rapidjson::kObjectType);
  const std::string id = rj_string(manifest, "bundleId", rj_string(manifest, "id", "environmental-bundle"));
  const JsonValue* run = rj_object(manifest, "run");
  const JsonValue* source = rj_object(manifest, "source");
  const JsonValue* policy = rj_object(manifest, "cachePolicy");
  const JsonValue* cache = rj_object(manifest, "cacheState");
  add_string_allow_empty(entry, "id", id, a);
  add_string_allow_empty(entry, "title", rj_string(manifest, "title", id), a);
  add_string_allow_empty(entry, "kind", "environmental-bundle", a);
  add_string(entry, "schema", rj_string(manifest, "schema"), a);
  if (source) add_string(entry, "provider", rj_string(*source, "provider"), a);
  if (run) {
    add_string(entry, "model", rj_string(*run, "model"), a);
    add_string(entry, "run_time", rj_string(*run, "runTime"), a);
    if (run->HasMember("validTimes")) add_clone(entry, "valid_times", (*run)["validTimes"], a);
  }
  add_bool(entry, "cache_only_replay", !policy || !policy->HasMember("cacheOnlyReplay") || (*policy)["cacheOnlyReplay"].GetBool(), a);
  add_bool(entry, "upstream_fetches_allowed_during_gesture", policy && policy->HasMember("upstreamFetchesAllowedDuringGesture") && (*policy)["upstreamFetchesAllowedDuringGesture"].GetBool(), a);
  add_bool(entry, "offline_ready", cache && cache->HasMember("offlineReady") && (*cache)["offlineReady"].GetBool(), a);
  JsonValue freshness(rapidjson::kObjectType);
  add_string_allow_empty(freshness, "status", cache ? rj_string(*cache, "state", "unknown") : "unknown", a);
  add_string(freshness, "materialized_at", cache ? rj_string(*cache, "materializedAt", rj_string(manifest, "generatedAt")) : rj_string(manifest, "generatedAt"), a);
  entry.AddMember("freshness", freshness, a);
  bool crosses = false;
  JsonValue ebbox = env_bbox_value(manifest, a, &crosses);
  if (ebbox.IsArray() && ebbox.Size() == 4) {
    add_clone(entry, "coverage", ebbox, a);
    add_bool(entry, "crosses_antimeridian", crosses, a);
    JsonValue prefetch_bbox = bbox_json(bbox, a);
    entry.AddMember("prefetch_bbox", prefetch_bbox, a);
  }
  JsonValue layers(rapidjson::kArrayType);
  const JsonValue* layer_obj = rj_object(manifest, "layers");
  for (const std::string& name : env_layer_names(manifest, query)) {
    if (layer_obj && layer_obj->HasMember(name.c_str())) {
      JsonValue layer_name(name.c_str(), a);
      layers.PushBack(layer_name, a);
    }
  }
  entry.AddMember("layers", layers, a);
  entry.AddMember("layer_count", static_cast<int>(entry["layers"].Size()), a);
  add_int(entry, "minzoom", minzoom, a);
  add_int(entry, "maxzoom", maxzoom, a);
  JsonValue sample(rapidjson::kObjectType);
  add_string_allow_empty(sample, "probe_handle", "weather.bundle", a);
  add_string_allow_empty(sample, "contract", "sample(lat, lon, t)", a);
  entry.AddMember("sample", sample, a);
  return entry;
}

JsonValue prefetch_value(const std::map<std::string, std::shared_ptr<PackRecord>>& packs,
                         const std::vector<EnvBundle>& env_bundles,
                         const std::string& origin,
                         const Query& query,
                         JsonAllocator& a) {
  const int minzoom = qint(query, "minzoom", 0, 0, 24);
  const int maxzoom = qint(query, "maxzoom", 12, 0, 24);
  if (minzoom > maxzoom) throw std::runtime_error("minzoom must be <= maxzoom");
  const int max_tiles = qint(query, "max_tiles", 50000, 1, 250000);
  const double radius_nm = qdouble(query, "radius_nm", 2.0, 0.0, 200.0);
  const bool include_tiles = qbool(query, "include_tiles", true);
  const bool include_environment = qbool(query, "include_environment", true);
  std::string source = "bbox";
  std::vector<double> bbox;
  int route_points = 0;
  if (!qfirst(query, "route").empty()) {
    const auto route = parse_route_query(qfirst(query, "route"));
    route_points = static_cast<int>(route.size());
    bbox = expand_route_bbox(route, radius_nm);
    source = "route";
  } else {
    if (qfirst(query, "bbox").empty()) throw std::runtime_error("provide route=lon,lat;lon,lat or bbox=W,S,E,N");
    bbox = parse_bbox_query(qfirst(query, "bbox"));
  }

  JsonValue payload(rapidjson::kObjectType);
  add_string_allow_empty(payload, "schema", "helm.prefetch.manifest.v1", a);
  add_string_allow_empty(payload, "source", source, a);
  JsonValue request(rapidjson::kObjectType);
  add_int(request, "minzoom", minzoom, a);
  add_int(request, "maxzoom", maxzoom, a);
  request.AddMember("radius_nm", radius_nm, a);
  add_int(request, "max_tiles", max_tiles, a);
  add_bool(request, "include_tiles", include_tiles, a);
  add_bool(request, "include_environment", include_environment, a);
  payload.AddMember("request", request, a);
  JsonValue corridor(rapidjson::kObjectType);
  JsonValue corridor_bbox = bbox_json(bbox, a);
  corridor.AddMember("bbox", corridor_bbox, a);
  add_int(corridor, "route_points", route_points, a);
  payload.AddMember("corridor", corridor, a);

  JsonValue pack_entries(rapidjson::kArrayType);
  int total_tiles = 0;
  int total_truncated = 0;
  int total_estimated = 0;
  bool estimated_known = false;
  for (const std::string& id : select_pack_ids(packs, query)) {
    const PackRecord& rec = *packs.at(id);
    JsonValue entry(rapidjson::kObjectType);
    add_string_allow_empty(entry, "id", id, a);
    add_string_allow_empty(entry, "title", rec.title, a);
    add_string_allow_empty(entry, "container", rec.container, a);
    add_string(entry, "kind", rec.kind, a);
    add_string_allow_empty(entry, "format", rec.format, a);
    const int eff_min = std::max(minzoom, rec.minzoom);
    const int eff_max = std::min(maxzoom, rec.maxzoom);
    add_int(entry, "minzoom", eff_min, a);
    add_int(entry, "maxzoom", eff_max, a);
    std::vector<double> pb = parse_bounds_array(rec.bounds);
    std::vector<double> prefetch_bbox = bbox;
    if (!pb.empty()) {
      JsonValue pack_bounds = bbox_json(pb, a);
      entry.AddMember("pack_bounds", pack_bounds, a);
      prefetch_bbox = intersect_bbox(bbox, pb);
      if (prefetch_bbox.empty()) {
        entry.AddMember("tile_count", 0, a);
        JsonValue empty_tiles(rapidjson::kArrayType);
        entry.AddMember("tiles", empty_tiles, a);
        add_string_allow_empty(entry, "skipped", "outside_pack_bounds", a);
        pack_entries.PushBack(entry, a);
        continue;
      }
    }
    JsonValue entry_prefetch_bbox = bbox_json(prefetch_bbox, a);
    entry.AddMember("prefetch_bbox", entry_prefetch_bbox, a);
    if (rec.container == "pmtiles") {
      const std::string url = pack_tile_url(rec, origin);
      add_string_allow_empty(entry, "url", url, a);
      add_string_allow_empty(entry, "pmtiles_url", url, a);
      add_string_allow_empty(entry, "protocol_url", "pmtiles://" + url, a);
    } else {
      add_string_allow_empty(entry, "url", pack_tile_url(rec, origin), a);
    }
    if (eff_min > eff_max) {
      entry.AddMember("tile_count", 0, a);
      JsonValue empty_tiles(rapidjson::kArrayType);
      entry.AddMember("tiles", empty_tiles, a);
      add_string_allow_empty(entry, "skipped", "outside_pack_zoom_range", a);
      pack_entries.PushBack(entry, a);
      continue;
    }
    auto tiles_pair = tiles_for_bbox(prefetch_bbox, eff_min, eff_max, max_tiles, a);
    JsonValue tiles = std::move(tiles_pair.first);
    const int truncated = tiles_pair.second;
    const int tile_count = static_cast<int>(tiles.Size()) + truncated;
    entry.AddMember("tile_count", tile_count, a);
    entry.AddMember("truncated_tile_count", truncated, a);
    entry.AddMember("truncated", truncated > 0, a);
    const int estimated = estimate_bytes(rec, tile_count);
    if (estimated >= 0) {
      estimated_known = true;
      total_estimated += estimated;
      entry.AddMember("estimated_bytes", estimated, a);
    }
    if (include_tiles) {
      for (auto& tile : tiles.GetArray()) add_string_allow_empty(tile, "url", tile_url_for(rec, tile, origin), a);
      entry.AddMember("tiles", tiles, a);
    }
    total_tiles += tile_count;
    total_truncated += truncated;
    pack_entries.PushBack(entry, a);
  }
  payload.AddMember("packs", pack_entries, a);

  JsonValue env_entries(rapidjson::kArrayType);
  if (include_environment) {
    for (const auto& manifest : env_bundles) {
      JsonValue entry = env_prefetch_entry(*manifest, query, bbox, minzoom, maxzoom, a);
      env_entries.PushBack(entry, a);
    }
  }
  JsonValue totals(rapidjson::kObjectType);
  add_int(totals, "packs", static_cast<int>(payload["packs"].Size()), a);
  add_int(totals, "tiles", total_tiles, a);
  add_int(totals, "truncated_tile_count", total_truncated, a);
  add_bool(totals, "truncated", total_truncated > 0, a);
  add_int(totals, "environmental_bundles", static_cast<int>(env_entries.Size()), a);
  int env_layer_count = 0;
  for (auto& env : env_entries.GetArray()) env_layer_count += env.HasMember("layers") ? static_cast<int>(env["layers"].Size()) : 0;
  add_int(totals, "environmental_layers", env_layer_count, a);
  if (estimated_known) add_int(totals, "estimated_bytes", total_estimated, a);
  payload.AddMember("totals", totals, a);
  if (!env_entries.Empty()) payload.AddMember("environmental_bundles", env_entries, a);
  return payload;
}

std::string component_role(const PackRecord& rec) {
  const std::string role = json_str(rec, "pack_role");
  if (!role.empty()) {
    const std::string l = lower(role);
    if (l.find("depth") != std::string::npos) return "depth";
    if (l.find("sat") != std::string::npos || l.find("imagery") != std::string::npos) return "basemap";
    if (l.find("chart") != std::string::npos) return "chart";
  }
  if (rec.kind == "depth") return "depth";
  if (rec.kind == "satellite" || rec.kind == "imagery") return "basemap";
  if (rec.kind == "chart" || rec.kind == "enc" || rec.kind == "rnc" || rec.renderer == "s52") return "chart";
  if (rec.type == "vector" || rec.format == "mvt" || rec.format == "pbf") return "vector";
  return rec.kind.empty() ? "pack" : rec.kind;
}

std::string pseudo_fingerprint(const JsonValue& value) {
  const std::string data = json_stringify(value);
  const std::hash<std::string> hasher;
  std::ostringstream out;
  for (int i = 0; i < 4; ++i) {
    const std::uint64_t h = static_cast<std::uint64_t>(hasher(data + "#" + std::to_string(i)));
    out << std::hex << std::setw(16) << std::setfill('0') << h;
  }
  return out.str();
}

JsonValue component_status(const JsonValue& component, JsonAllocator& a) {
  JsonValue status(rapidjson::kObjectType);
  std::string freshness = "unknown";
  std::string coverage = "unknown";
  JsonValue codes(rapidjson::kArrayType);
  if (component.HasMember("staleness") && component["staleness"].IsObject()) {
    freshness = rj_string(component["staleness"], "status", "unknown");
  }
  if (component.HasMember("coverage") && component["coverage"].IsObject()) {
    coverage = rj_string(component["coverage"], "status", "unknown");
  }
  if (component.HasMember("warnings") && component["warnings"].IsArray()) {
    for (auto& w : component["warnings"].GetArray()) {
      if (w.IsObject() && w.HasMember("code") && w["code"].IsString()) {
        JsonValue code(w["code"].GetString(), a);
        codes.PushBack(code, a);
      }
    }
  }
  add_string_allow_empty(status, "freshness", freshness, a);
  add_string_allow_empty(status, "coverage", coverage, a);
  status.AddMember("warning_codes", codes, a);
  JsonValue states(rapidjson::kArrayType);
  const bool stale = freshness == "stale";
  const bool out_of_coverage = !(coverage.empty() || coverage == "complete" || coverage == "unknown");
  if (stale) states.PushBack("stale", a);
  if (out_of_coverage) states.PushBack("out_of_coverage", a);
  if (states.Empty()) states.PushBack("current", a);
  status.AddMember("states", states, a);
  return status;
}

Query bundle_query_with_defaults(const std::map<std::string, std::shared_ptr<PackRecord>>& packs, const Query& query) {
  Query q = query;
  if (qfirst(q, "include_tiles").empty()) q["include_tiles"] = {"0"};
  if (qfirst(q, "bbox").empty() && qfirst(q, "route").empty()) {
    std::vector<double> bbox;
    for (const std::string& id : select_pack_ids(packs, q)) {
      const auto b = parse_bounds_array(packs.at(id)->bounds);
      if (b.empty()) continue;
      if (bbox.empty()) bbox = b;
      else bbox = {std::min(bbox[0], b[0]), std::min(bbox[1], b[1]), std::max(bbox[2], b[2]), std::max(bbox[3], b[3])};
    }
    if (bbox.empty()) throw std::runtime_error("provide route=lon,lat;lon,lat or bbox=W,S,E,N; selected packs have no bounds");
    q["bbox"] = {bounds_string(bbox)};
  }
  return q;
}

JsonValue bundle_value(const std::map<std::string, std::shared_ptr<PackRecord>>& packs,
                       const std::vector<EnvBundle>& env_bundles,
                       const std::string& origin,
                       const Query& query,
                       JsonAllocator& a) {
  const Query q = bundle_query_with_defaults(packs, query);
  JsonValue prefetch = prefetch_value(packs, env_bundles, origin, q, a);
  JsonValue bundle(rapidjson::kObjectType);
  add_string_allow_empty(bundle, "schema", "helm.region_bundle.manifest.v1", a);
  add_string_allow_empty(bundle, "id", qfirst(q, "bundle_id", qfirst(q, "id", "local-region")), a);
  add_string_allow_empty(bundle, "title", qfirst(q, "title", "Local Region Bundle"), a);
  add_string_allow_empty(bundle, "generated_at", now_iso(), a);
  JsonValue request(rapidjson::kObjectType);
  JsonValue packs_arr(rapidjson::kArrayType);
  for (const std::string& id : select_pack_ids(packs, q)) {
    JsonValue pack_id(id.c_str(), a);
    packs_arr.PushBack(pack_id, a);
  }
  request.AddMember("packs", packs_arr, a);
  add_string_allow_empty(request, "minzoom", qfirst(q, "minzoom", "0"), a);
  add_string_allow_empty(request, "maxzoom", qfirst(q, "maxzoom", "12"), a);
  add_string_allow_empty(request, "radius_nm", qfirst(q, "radius_nm", "2.0"), a);
  add_string_allow_empty(request, "include_tiles", qfirst(q, "include_tiles", "0"), a);
  if (!qfirst(q, "bbox").empty()) add_string_allow_empty(request, "bbox", qfirst(q, "bbox"), a);
  if (!qfirst(q, "route").empty()) add_string_allow_empty(request, "route", qfirst(q, "route"), a);
  bundle.AddMember("request", request, a);
  add_clone(bundle, "corridor", prefetch["corridor"], a);
  add_clone(bundle, "prefetch", prefetch, a);

  JsonValue components(rapidjson::kArrayType);
  for (const std::string& id : select_pack_ids(packs, q)) {
    const PackRecord& rec = *packs.at(id);
    JsonValue component = pack_json(rec, origin, a);
    component.RemoveMember("id");
    JsonValue component_id(("pack:" + id).c_str(), a);
    component.AddMember("id", component_id, a);
    add_string_allow_empty(component, "pack_id", id, a);
    add_string_allow_empty(component, "role", component_role(rec), a);
    auto pit = prefetch["packs"].GetArray().Begin();
    for (; pit != prefetch["packs"].GetArray().End(); ++pit) {
      if (rj_string(*pit, "id") == id) {
        JsonValue p(rapidjson::kObjectType);
        for (const char* key : {"minzoom", "maxzoom", "pack_bounds", "prefetch_bbox", "tile_count", "truncated_tile_count", "truncated", "estimated_bytes", "skipped"}) {
          if (pit->HasMember(key)) add_clone(p, key, (*pit)[key], a);
        }
        component.AddMember("prefetch", p, a);
        break;
      }
    }
    JsonValue status = component_status(component, a);
    component.AddMember("status", status, a);
    add_string_allow_empty(component, "fingerprint", pseudo_fingerprint(component), a);
    components.PushBack(component, a);
  }
  bundle.AddMember("components", components, a);

  JsonValue summary(rapidjson::kObjectType);
  JsonValue roles(rapidjson::kObjectType);
  int stale = 0, out_of_coverage = 0, warnings = 0;
  for (auto& c : bundle["components"].GetArray()) {
    const std::string role = rj_string(c, "role", "unknown");
    if (!roles.HasMember(role.c_str())) {
      JsonValue name(role.c_str(), a);
      roles.AddMember(name, 0, a);
    }
    roles[role.c_str()].SetInt(roles[role.c_str()].GetInt() + 1);
    if (c.HasMember("warnings") && c["warnings"].IsArray()) warnings += static_cast<int>(c["warnings"].Size());
    if (c.HasMember("status") && c["status"].IsObject() && c["status"].HasMember("states")) {
      for (auto& s : c["status"]["states"].GetArray()) {
        if (s.IsString() && std::string(s.GetString()) == "stale") ++stale;
        if (s.IsString() && std::string(s.GetString()) == "out_of_coverage") ++out_of_coverage;
      }
    }
  }
  summary.AddMember("roles", roles, a);
  add_int(summary, "stale", stale, a);
  add_int(summary, "out_of_coverage", out_of_coverage, a);
  add_int(summary, "warnings", warnings, a);
  add_int(summary, "prefetch_tiles", prefetch["totals"]["tiles"].GetInt(), a);
  add_bool(summary, "prefetch_truncated", prefetch["totals"]["truncated"].GetBool(), a);
  bundle.AddMember("summary", summary, a);
  return bundle;
}

std::string product_identifier_for(const JsonValue& component) {
  const std::string renderer = lower(rj_string(component, "renderer"));
  const std::string role = lower(rj_string(component, "role"));
  const std::string kind = lower(rj_string(component, "kind"));
  const std::string container = lower(rj_string(component, "container"));
  if (renderer == "s52") return "S-52";
  if (role == "depth" || role == "bathymetry" || kind == "depth") return "S-102-style";
  if (role == "surface_current" || role == "currents") return "S-111-style";
  if (role == "weather") return "weather.model-run";
  if (container == "pmtiles") return "PMTiles";
  if (container == "mbtiles") return "MBTiles";
  return "helm.layer";
}

JsonValue sample_contract(const std::string& handle, JsonAllocator& a) {
  JsonValue sample(rapidjson::kObjectType);
  add_string_allow_empty(sample, "status", handle.empty() ? "unavailable" : "available", a);
  if (!handle.empty()) {
    add_string_allow_empty(sample, "probe_handle", handle, a);
    add_string_allow_empty(sample, "contract", "sample(lat, lon, t)", a);
  }
  return sample;
}

JsonValue layer_from_component(const JsonValue& component, JsonAllocator& a) {
  JsonValue layer(rapidjson::kObjectType);
  const std::string cid = rj_string(component, "id");
  const std::string role = rj_string(component, "role", rj_string(component, "kind", "layer"));
  const std::string product = product_identifier_for(component);
  add_string_allow_empty(layer, "id", "layer:" + cid, a);
  add_string(layer, "component_id", cid, a);
  add_string_allow_empty(layer, "role", role, a);
  add_string_allow_empty(layer, "product_identifier", product, a);
  add_string_allow_empty(layer, "product_id", product, a);
  add_string_allow_empty(layer, "dataset_name", rj_string(component, "title", cid), a);
  add_string(layer, "dataset_edition", rj_string(component, "chart_edition"), a);
  add_string(layer, "dataset_reference_date", rj_string(component, "render_date", rj_string(component, "modified")), a);
  if (component.HasMember("source_info")) add_clone(layer, "source", component["source_info"], a);
  if (component.HasMember("coverage")) add_clone(layer, "coverage", component["coverage"], a);
  JsonValue z(rapidjson::kObjectType);
  if (component.HasMember("minzoom")) add_clone(z, "min", component["minzoom"], a);
  if (component.HasMember("maxzoom")) add_clone(z, "max", component["maxzoom"], a);
  if (!z.ObjectEmpty()) layer.AddMember("z_range", z, a);
  JsonValue pack(rapidjson::kObjectType);
  for (const char* key : {"container", "format", "type", "size_bytes"}) {
    if (component.HasMember(key)) add_clone(pack, key, component[key], a);
  }
  if (!pack.ObjectEmpty()) layer.AddMember("pack", pack, a);
  if (component.HasMember("staleness")) add_clone(layer, "freshness", component["staleness"], a);
  const std::string confidence = component.HasMember("source_info") && component["source_info"].IsObject()
    ? rj_string(component["source_info"], "confidence", "unknown")
    : "unknown";
  add_string_allow_empty(layer, "confidence", confidence, a);
  std::string handle;
  if (!(component.HasMember("inspection") && rj_string(component["inspection"], "tap_action") == "show_pack_source_metadata")) {
    if (role == "depth") handle = "depth";
    else if (role == "chart") handle = "chart.objects";
  }
  JsonValue sample = sample_contract(handle, a);
  layer.AddMember("sample", sample, a);
  if (component.HasMember("inspection")) add_clone(layer, "inspection", component["inspection"], a);
  if (component.HasMember("warnings")) add_clone(layer, "warnings", component["warnings"], a);
  add_bool(layer, "not_for_navigation", true, a);
  add_string_allow_empty(layer, "advisory_label", "Local Helm layer inventory; verify official sources for navigation.", a);
  return layer;
}

std::string slug(std::string text) {
  std::string out;
  bool dash = false;
  for (char c : text) {
    const unsigned char u = static_cast<unsigned char>(c);
    if (std::isalnum(u)) {
      out.push_back(static_cast<char>(std::tolower(u)));
      dash = false;
    } else if (!dash && !out.empty()) {
      out.push_back('-');
      dash = true;
    }
  }
  while (!out.empty() && out.back() == '-') out.pop_back();
  return out.empty() ? "layer" : out;
}

JsonValue env_bundle_layer(const JsonValue& manifest, JsonAllocator& a) {
  JsonValue layer(rapidjson::kObjectType);
  const std::string id = rj_string(manifest, "bundleId", rj_string(manifest, "id", "environmental-bundle"));
  const JsonValue* run = rj_object(manifest, "run");
  const JsonValue* policy = rj_object(manifest, "cachePolicy");
  const JsonValue* cache = rj_object(manifest, "cacheState");
  add_string_allow_empty(layer, "id", "env-bundle:" + slug(id), a);
  add_string_allow_empty(layer, "component_id", id, a);
  add_string_allow_empty(layer, "role", "environmental_bundle", a);
  add_string_allow_empty(layer, "product_identifier", rj_string(manifest, "schema", "helm.env.bundle.v1"), a);
  add_string_allow_empty(layer, "product_id", rj_string(manifest, "schema", "helm.env.bundle.v1"), a);
  add_string_allow_empty(layer, "dataset_name", rj_string(manifest, "title", id), a);
  if (run) {
    add_string(layer, "dataset_edition", rj_string(*run, "runLabel"), a);
    add_string(layer, "dataset_reference_date", rj_string(*run, "runTime"), a);
  }
  bool crosses = false;
  JsonValue ebbox = env_bbox_value(manifest, a, &crosses);
  JsonValue coverage(rapidjson::kObjectType);
  add_string_allow_empty(coverage, "status", ebbox.IsArray() && ebbox.Size() == 4 ? "area" : "unknown", a);
  if (ebbox.IsArray() && ebbox.Size() == 4) {
    add_clone(coverage, "bbox", ebbox, a);
    JsonValue bbox_obj(rapidjson::kObjectType);
    add_clone(bbox_obj, "west", ebbox[0], a);
    add_clone(bbox_obj, "south", ebbox[1], a);
    add_clone(bbox_obj, "east", ebbox[2], a);
    add_clone(bbox_obj, "north", ebbox[3], a);
    add_bool(bbox_obj, "crossesAntimeridian", crosses, a);
    add_bool(bbox_obj, "crosses_antimeridian", crosses, a);
    coverage.AddMember("bbox_object", bbox_obj, a);
  }
  layer.AddMember("coverage", coverage, a);
  JsonValue freshness(rapidjson::kObjectType);
  add_string_allow_empty(freshness, "status", cache ? rj_string(*cache, "state", "unknown") : "unknown", a);
  add_string(freshness, "render_date", cache ? rj_string(*cache, "materializedAt", rj_string(manifest, "generatedAt")) : rj_string(manifest, "generatedAt"), a);
  layer.AddMember("freshness", freshness, a);
  JsonValue sample = sample_contract("weather.bundle", a);
  layer.AddMember("sample", sample, a);
  JsonValue env(rapidjson::kObjectType);
  add_string_allow_empty(env, "bundleId", id, a);
  JsonValue layer_names(rapidjson::kArrayType);
  const JsonValue* layers = rj_object(manifest, "layers");
  if (layers) {
    for (auto it = layers->MemberBegin(); it != layers->MemberEnd(); ++it) {
      JsonValue layer_name(it->name.GetString(), a);
      layer_names.PushBack(layer_name, a);
    }
  }
  env.AddMember("layers", layer_names, a);
  if (run && run->HasMember("validTimes")) add_clone(env, "validTimes", (*run)["validTimes"], a);
  if (run) {
    add_string(env, "model", rj_string(*run, "model"), a);
    add_string(env, "marineModel", rj_string(*run, "marineModel"), a);
  }
  add_bool(env, "cacheOnlyReplay", !policy || !policy->HasMember("cacheOnlyReplay") || (*policy)["cacheOnlyReplay"].GetBool(), a);
  add_bool(env, "upstreamFetchesAllowedDuringGesture", policy && policy->HasMember("upstreamFetchesAllowedDuringGesture") && (*policy)["upstreamFetchesAllowedDuringGesture"].GetBool(), a);
  add_bool(env, "offlineReady", cache && cache->HasMember("offlineReady") && (*cache)["offlineReady"].GetBool(), a);
  add_string(env, "state", cache ? rj_string(*cache, "state") : std::string(), a);
  layer.AddMember("environmental_bundle", env, a);
  add_bool(layer, "not_for_navigation", true, a);
  add_string_allow_empty(layer, "advisory_label", "Forecast/advisory met-ocean data. Cross-reference official sources.", a);
  return layer;
}

JsonValue env_data_layer(const JsonValue& manifest, const std::string& name, const JsonValue& source_layer, JsonAllocator& a) {
  JsonValue layer = env_bundle_layer(manifest, a);
  const std::string bundle_id = rj_string(manifest, "bundleId", rj_string(manifest, "id", "environmental-bundle"));
  layer.RemoveMember("id");
  layer.RemoveMember("role");
  layer.RemoveMember("product_identifier");
  layer.RemoveMember("product_id");
  layer.RemoveMember("dataset_name");
  layer.RemoveMember("sample");
  JsonValue layer_id(("env:" + slug(bundle_id) + ":" + slug(name)).c_str(), a);
  layer.AddMember("id", layer_id, a);
  add_string_allow_empty(layer, "role", name == "current" ? "surface_current" : "weather", a);
  std::string product = "S-413";
  if (name == "current") product = "S-111";
  if (source_layer.HasMember("s100") && source_layer["s100"].IsObject()) {
    product = rj_string(source_layer["s100"], "productIdentifier", product);
  }
  add_string_allow_empty(layer, "product_identifier", product, a);
  add_string_allow_empty(layer, "product_id", product, a);
  add_string_allow_empty(layer, "dataset_name", rj_string(manifest, "title", bundle_id) + " · " + name, a);
  JsonValue sample = sample_contract("weather." + name, a);
  layer.AddMember("sample", sample, a);
  JsonValue env(rapidjson::kObjectType);
  add_string_allow_empty(env, "bundleId", bundle_id, a);
  add_string_allow_empty(env, "layer", name, a);
  add_string(env, "kind", rj_string(source_layer, "kind"), a);
  add_string(env, "unit", rj_string(source_layer, "unit"), a);
  if (source_layer.HasMember("fieldTiles")) add_clone(env, "fieldTiles", source_layer["fieldTiles"], a);
  if (source_layer.HasMember("vectorField")) add_clone(env, "vectorField", source_layer["vectorField"], a);
  layer.RemoveMember("environmental_bundle");
  layer.AddMember("environmental_bundle", env, a);
  if (source_layer.HasMember("s100")) add_clone(layer, "s100", source_layer["s100"], a);
  return layer;
}

JsonValue layers_value(const std::map<std::string, std::shared_ptr<PackRecord>>& packs,
                       const std::vector<EnvBundle>& env_bundles,
                       const std::string& origin,
                       const Query& query,
                       JsonAllocator& a) {
  JsonValue bundle = bundle_value(packs, env_bundles, origin, query, a);
  JsonValue inventory(rapidjson::kObjectType);
  add_string_allow_empty(inventory, "schema", "helm.maritime_layer_inventory.v1", a);
  add_string_allow_empty(inventory, "id", qfirst(query, "inventory_id", qfirst(query, "id", "local-maritime-layers")), a);
  add_string_allow_empty(inventory, "title", qfirst(query, "title", "Local Maritime Layer Inventory"), a);
  add_string_allow_empty(inventory, "generated_at", now_iso(), a);
  add_bool(inventory, "advisory", true, a);
  add_bool(inventory, "not_for_navigation", true, a);
  JsonValue source(rapidjson::kObjectType);
  add_string_allow_empty(source, "kind", "local-boat-server", a);
  add_string_allow_empty(source, "name", "Helm local maritime layer inventory", a);
  inventory.AddMember("source", source, a);
  add_clone(inventory, "request", bundle["request"], a);
  JsonValue coverage(rapidjson::kObjectType);
  add_string_allow_empty(coverage, "status", "area", a);
  add_clone(coverage, "bbox", bundle["corridor"]["bbox"], a);
  inventory.AddMember("coverage", coverage, a);
  JsonValue brief_bundle(rapidjson::kObjectType);
  add_string_allow_empty(brief_bundle, "schema", "helm.region_bundle.manifest.v1", a);
  add_clone(brief_bundle, "id", bundle["id"], a);
  add_clone(brief_bundle, "title", bundle["title"], a);
  add_clone(brief_bundle, "summary", bundle["summary"], a);
  inventory.AddMember("bundle", brief_bundle, a);

  JsonValue layers(rapidjson::kArrayType);
  for (auto& c : bundle["components"].GetArray()) {
    JsonValue layer = layer_from_component(c, a);
    layers.PushBack(layer, a);
  }
  for (const auto& manifest : env_bundles) {
    JsonValue bundle_layer = env_bundle_layer(*manifest, a);
    layers.PushBack(bundle_layer, a);
    const JsonValue* m_layers = rj_object(*manifest, "layers");
    if (m_layers) {
      for (auto it = m_layers->MemberBegin(); it != m_layers->MemberEnd(); ++it) {
        if (it->name.IsString() && it->value.IsObject()) {
          JsonValue data_layer = env_data_layer(*manifest, it->name.GetString(), it->value, a);
          layers.PushBack(data_layer, a);
        }
      }
    }
  }
  inventory.AddMember("layers", layers, a);

  JsonValue summary(rapidjson::kObjectType);
  JsonValue roles(rapidjson::kObjectType);
  JsonValue products(rapidjson::kObjectType);
  std::set<std::string> handles;
  int stale = 0, out_of_coverage = 0;
  for (auto& layer : inventory["layers"].GetArray()) {
    const std::string role = rj_string(layer, "role", "unknown");
    const std::string product = rj_string(layer, "product_identifier", "unknown");
    if (!roles.HasMember(role.c_str())) {
      JsonValue name(role.c_str(), a);
      roles.AddMember(name, 0, a);
    }
    roles[role.c_str()].SetInt(roles[role.c_str()].GetInt() + 1);
    if (!products.HasMember(product.c_str())) {
      JsonValue name(product.c_str(), a);
      products.AddMember(name, 0, a);
    }
    products[product.c_str()].SetInt(products[product.c_str()].GetInt() + 1);
    if (layer.HasMember("freshness") && rj_string(layer["freshness"], "status") == "stale") ++stale;
    if (layer.HasMember("coverage")) {
      const std::string status = rj_string(layer["coverage"], "status");
      if (!(status.empty() || status == "complete" || status == "area" || status == "unknown")) ++out_of_coverage;
    }
    if (layer.HasMember("sample") && layer["sample"].IsObject()) {
      const std::string handle = rj_string(layer["sample"], "probe_handle");
      if (!handle.empty()) handles.insert(handle);
    }
  }
  add_int(summary, "layers", static_cast<int>(inventory["layers"].Size()), a);
  summary.AddMember("roles", roles, a);
  summary.AddMember("products", products, a);
  add_int(summary, "stale", stale, a);
  add_int(summary, "out_of_coverage", out_of_coverage, a);
  JsonValue handle_arr(rapidjson::kArrayType);
  for (const std::string& h : handles) {
    JsonValue handle(h.c_str(), a);
    handle_arr.PushBack(handle, a);
  }
  summary.AddMember("sample_handles", handle_arr, a);
  inventory.AddMember("summary", summary, a);
  return inventory;
}

std::string json_endpoint(std::function<JsonValue(JsonAllocator&)> build) {
  rapidjson::Document doc;
  doc.SetObject();
  JsonAllocator& a = doc.GetAllocator();
  JsonValue value = build(a);
  return json_stringify(value);
}

bool parse_uint(const std::string& text, std::uint64_t& value) {
  if (text.empty()) return false;
  char* end = nullptr;
  errno = 0;
  unsigned long long parsed = std::strtoull(text.c_str(), &end, 10);
  if (errno || !end || *end != '\0') return false;
  value = static_cast<std::uint64_t>(parsed);
  return true;
}

struct ByteRange {
  bool partial = false;
  std::uint64_t start = 0;
  std::uint64_t end = 0;
};

bool parse_range(const std::string& value, std::uint64_t size, ByteRange& out, std::string& content_range) {
  if (value.empty()) {
    out.partial = false;
    out.start = 0;
    out.end = size ? size - 1 : 0;
    return true;
  }
  if (!starts_with(value, "bytes=")) return false;
  const std::string spec = value.substr(6);
  const std::size_t dash = spec.find('-');
  if (dash == std::string::npos) return false;
  const std::string a = spec.substr(0, dash);
  const std::string b = spec.substr(dash + 1);
  if (a.empty() && b.empty()) return false;
  std::uint64_t start = 0;
  std::uint64_t end = size ? size - 1 : 0;
  if (a.empty()) {
    std::uint64_t suffix = 0;
    if (!parse_uint(b, suffix) || suffix == 0) return false;
    start = suffix >= size ? 0 : size - suffix;
  } else {
    if (!parse_uint(a, start)) return false;
    if (!b.empty() && !parse_uint(b, end)) return false;
  }
  if (size == 0 || start >= size || start > end) {
    content_range = "bytes */" + std::to_string(size);
    return false;
  }
  end = std::min(end, size - 1);
  out.partial = true;
  out.start = start;
  out.end = end;
  return true;
}

std::string read_file_slice(const std::string& path, std::uint64_t start, std::uint64_t length) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return std::string();
  in.seekg(static_cast<std::streamoff>(start));
  std::string body;
  body.resize(static_cast<std::size_t>(length));
  in.read(&body[0], static_cast<std::streamsize>(length));
  body.resize(static_cast<std::size_t>(in.gcount()));
  return body;
}

std::string etag_for(const PackRecord& rec) {
  std::ostringstream out;
  out << "\"" << std::hex << rec.modified_epoch << "-" << rec.size_bytes << "\"";
  return out.str();
}

ix::HttpResponsePtr serve_pmtiles(const PackRecord& rec, const ix::HttpRequestPtr& req, bool head_only) {
  Headers h;
  base_headers(h);
  h["Content-Type"] = content_type_for("pmtiles");
  h["Accept-Ranges"] = "bytes";
  h["Cache-Control"] = "public, max-age=86400";
  h["ETag"] = etag_for(rec);

  ByteRange range;
  std::string content_range;
  if (!parse_range(header_value(req->headers, "Range"), rec.size_bytes, range, content_range)) {
    if (!content_range.empty()) h["Content-Range"] = content_range;
    return empty_response(416, "Range Not Satisfiable", std::move(h));
  }

  const std::uint64_t length = rec.size_bytes == 0 ? 0 : range.end - range.start + 1;
  if (range.partial) {
    h["Content-Range"] = "bytes " + std::to_string(range.start) + "-" + std::to_string(range.end) +
      "/" + std::to_string(rec.size_bytes);
  }
  if (head_only) {
    h["Content-Length"] = std::to_string(length);
    return std::make_shared<ix::HttpResponse>(range.partial ? 206 : 200,
      range.partial ? "Partial Content" : "OK", ix::HttpErrorCode::Ok, h, std::string());
  }
  return response(range.partial ? 206 : 200, range.partial ? "Partial Content" : "OK", std::move(h),
                  read_file_slice(rec.path, range.start, length));
}

ix::HttpResponsePtr serve_mbtiles(const PackRecord& rec, const std::vector<std::string>& parts) {
  Headers h;
  base_headers(h);
  if (parts.size() != 4 || !rec.db) return empty_response(404, "Not Found", std::move(h));

  std::uint64_t z = 0;
  std::uint64_t x = 0;
  std::string y_ext = parts[3];
  const std::size_t dot = y_ext.find('.');
  if (dot == std::string::npos) return empty_response(404, "Not Found", std::move(h));
  std::uint64_t y = 0;
  if (!parse_uint(parts[1], z) || !parse_uint(parts[2], x) || !parse_uint(y_ext.substr(0, dot), y) || z > 30) {
    return empty_response(404, "Not Found", std::move(h));
  }
  const std::uint64_t limit = 1ULL << z;
  if (x >= limit || y >= limit) return empty_response(404, "Not Found", std::move(h));
  const std::uint64_t tms_y = limit - 1 - y;

  std::string tile;
  {
    std::lock_guard<std::mutex> lock(rec.db_mutex);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(rec.db.get(),
          "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
          -1, &stmt, nullptr) != SQLITE_OK) {
      return empty_response(500, "SQLite Error", std::move(h));
    }
    sqlite3_bind_int64(stmt, 1, static_cast<sqlite3_int64>(z));
    sqlite3_bind_int64(stmt, 2, static_cast<sqlite3_int64>(x));
    sqlite3_bind_int64(stmt, 3, static_cast<sqlite3_int64>(tms_y));
    if (sqlite3_step(stmt) == SQLITE_ROW) {
      const void* blob = sqlite3_column_blob(stmt, 0);
      const int bytes = sqlite3_column_bytes(stmt, 0);
      if (blob && bytes > 0) tile.assign(static_cast<const char*>(blob), static_cast<std::size_t>(bytes));
    }
    sqlite3_finalize(stmt);
  }
  if (tile.empty()) return empty_response(204, "No Content", std::move(h));

  h["Content-Type"] = content_type_for(rec.extension);
  h["Cache-Control"] = "public, max-age=86400";
  return response(200, "OK", std::move(h), std::move(tile));
}

std::vector<std::string> split_path(const std::string& path) {
  std::vector<std::string> parts;
  std::size_t start = 0;
  while (start < path.size()) {
    while (start < path.size() && path[start] == '/') ++start;
    if (start >= path.size()) break;
    const std::size_t slash = path.find('/', start);
    const std::size_t end = slash == std::string::npos ? path.size() : slash;
    parts.push_back(url_decode(path.substr(start, end - start)));
    start = end;
  }
  return parts;
}

class PackDaemon {
public:
  PackDaemon(std::string bind, int port, std::map<std::string, std::shared_ptr<PackRecord>> packs,
             std::vector<EnvBundle> env_bundles)
      : bind_(std::move(bind)), port_(port), packs_(std::move(packs)),
        env_bundles_(std::move(env_bundles)), server_(port_, bind_) {}

  bool start() {
    server_.setOnConnectionCallback(
      [this](ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState>) -> ix::HttpResponsePtr {
        return this->handle(req);
      });
    return server_.listenAndStart();
  }

private:
  ix::HttpResponsePtr handle(const ix::HttpRequestPtr& req) const {
    Headers h;
    base_headers(h);
    const std::string path = request_path(req->uri);
    const bool is_head = req->method == "HEAD";

    if (req->method == "OPTIONS") return empty_response(204, "No Content", std::move(h));

    if (path == "/" || path == "/health") {
      h["Content-Type"] = "application/json";
      h["Cache-Control"] = "no-store";
      std::ostringstream body;
      body << "{\"status\":\"ok\",\"engine\":\"helm-packd\",\"packs\":" << packs_.size() << "}";
      return response(200, "OK", std::move(h), is_head ? std::string() : body.str());
    }

    if (path == "/catalog") {
      h["Content-Type"] = "application/json";
      const std::string body = catalog_json(packs_, origin_for(req, bind_, port_));
      if (is_head) {
        h["Content-Length"] = std::to_string(body.size());
        return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, std::string());
      }
      return response(200, "OK", std::move(h), body);
    }

    if (path == "/prefetch" || path == "/bundle" || path == "/layers") {
      if (req->method != "GET" && !(is_head && path == "/layers")) {
        return empty_response(405, "Method Not Allowed", std::move(h));
      }
      h["Content-Type"] = "application/json";
      try {
        const Query query = parse_query_string(req->uri);
        const std::string origin = origin_for(req, bind_, port_);
        const std::string body = json_endpoint([&](JsonAllocator& a) -> JsonValue {
          if (path == "/prefetch") return prefetch_value(packs_, env_bundles_, origin, query, a);
          if (path == "/bundle") return bundle_value(packs_, env_bundles_, origin, query, a);
          return layers_value(packs_, env_bundles_, origin, query, a);
        });
        if (is_head) {
          h["Content-Length"] = std::to_string(body.size());
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, std::string());
        }
        return response(200, "OK", std::move(h), body);
      } catch (const std::exception& e) {
        const char* code = path == "/prefetch" ? "bad_prefetch_request" :
          (path == "/bundle" ? "bad_bundle_request" : "bad_layer_inventory_request");
        std::string body = std::string("{\"error\":\"") + code + "\",\"message\":\"" + json_escape(e.what()) + "\"}";
        return response(400, "Bad Request", std::move(h), body);
      }
    }

    if (ends_with(path, ".pmtiles")) {
      const std::string id = url_decode(path.substr(1, path.size() - 1 - 8));
      const auto it = packs_.find(id);
      if (it == packs_.end() || it->second->container != "pmtiles") return empty_response(404, "Not Found", std::move(h));
      return serve_pmtiles(*it->second, req, is_head);
    }

    if (req->method != "GET") return empty_response(405, "Method Not Allowed", std::move(h));

    const std::vector<std::string> parts = split_path(path);
    if (parts.empty()) return empty_response(404, "Not Found", std::move(h));
    const auto it = packs_.find(parts[0]);
    if (it == packs_.end() || it->second->container != "mbtiles") return empty_response(404, "Not Found", std::move(h));
    return serve_mbtiles(*it->second, parts);
  }

  std::string bind_;
  int port_;
  std::map<std::string, std::shared_ptr<PackRecord>> packs_;
  std::vector<EnvBundle> env_bundles_;
  ix::HttpServer server_;
};

}  // namespace

int main(int argc, char** argv) {
  const int port = argc > 1 ? std::atoi(argv[1]) : 8091;
  const std::string bind = get_env("HELM_BIND", "0.0.0.0");
  const std::string base = expand_user(get_env("HELM_MBTILES_DIR", "web/data"));
  auto packs = build_pack_index(base);
  auto env_bundles = load_environmental_bundles();
  if (packs.empty()) {
    std::fprintf(stderr, "FATAL: no .mbtiles or .pmtiles packs found under %s\n", base.c_str());
    std::fprintf(stderr, "Set HELM_MBTILES_DIR or HELM_MBTILES_PACKS to point at local packs.\n");
    return 1;
  }

  PackDaemon daemon(bind, port, std::move(packs), std::move(env_bundles));
  if (!daemon.start()) {
    std::fprintf(stderr, "helm-packd listen on %s:%d FAILED\n", bind.c_str(), port);
    return 2;
  }
  std::printf("helm-packd local pack server: http://%s:%d/  (packs from %s)\n", bind.c_str(), port, base.c_str());
  for (;;) std::this_thread::sleep_for(std::chrono::hours(24));
  return 0;
}

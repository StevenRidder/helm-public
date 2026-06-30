// helm_basemap_cache.cpp -- optional C++ cache/proxy for Helm basemap fill.
//
// CHART-18 first slice:
//   GET  /health                                  -> daemon health
//   GET  /stats                                   -> cache count + source ids
//   GET  /basemap/{source}/{z}/{x}/{y}.{ext}      -> online-fill tile cache
//   GET  /<any path> with HELM_BASEMAP_UPSTREAM   -> generic remote-pack proxy/cache
//
// This daemon owns only byte caching and outage behavior. It does not parse chart
// semantics, pick layers, or decide S-52/S-101 presentation policy.

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <netdb.h>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

#include "ixwebsocket/IXConnectionState.h"
#include "ixwebsocket/IXHttp.h"
#include "ixwebsocket/IXHttpClient.h"
#include "ixwebsocket/IXHttpServer.h"

namespace {

using Headers = ix::WebSocketHttpHeaders;

struct Source {
  std::string id;
  std::string url_template;
  std::string extension;
  std::string content_type;
  std::string attribution;
};

struct FetchResult {
  int status = 0;
  std::string body;
  std::string error;
};

struct PlainHttpUrl {
  std::string host;
  std::string port = "80";
  std::string target = "/";
};

std::string get_env(const char* name, const std::string& fallback = std::string()) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

bool env_truthy(const char* name) {
  std::string v = get_env(name);
  std::transform(v.begin(), v.end(), v.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return v == "1" || v == "true" || v == "yes" || v == "on";
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

std::string expand_user(std::string path) {
  if (path == "~" || starts_with(path, "~/")) {
    const std::string home = get_env("HOME", ".");
    return home + path.substr(1);
  }
  return path;
}

std::string trim_slashes(std::string s) {
  while (!s.empty() && s.front() == '/') s.erase(s.begin());
  while (!s.empty() && s.back() == '/') s.pop_back();
  return s;
}

std::string dirname_join(const std::string& base, const std::string& name) {
  if (base.empty() || base == ".") return name;
  return base.back() == '/' ? base + name : base + "/" + name;
}

std::string request_path(const std::string& uri) {
  const std::size_t q = uri.find('?');
  return q == std::string::npos ? uri : uri.substr(0, q);
}

std::string url_decode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) {
      const auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      const int hi = hex(s[i + 1]);
      const int lo = hex(s[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    out.push_back(s[i] == '+' ? ' ' : s[i]);
  }
  return out;
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

bool parse_u64(const std::string& text, std::uint64_t& out) {
  if (text.empty()) return false;
  std::uint64_t value = 0;
  for (char c : text) {
    if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    const std::uint64_t next = value * 10 + static_cast<unsigned>(c - '0');
    if (next < value) return false;
    value = next;
  }
  out = value;
  return true;
}

std::string extension_of_path(const std::string& path) {
  const std::string clean = request_path(path);
  const std::size_t slash = clean.find_last_of('/');
  const std::size_t dot = clean.find_last_of('.');
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) return std::string();
  return lower(clean.substr(dot + 1));
}

std::string content_type_for_ext(const std::string& ext) {
  const std::string e = lower(ext);
  if (e == "jpg" || e == "jpeg") return "image/jpeg";
  if (e == "png") return "image/png";
  if (e == "webp") return "image/webp";
  if (e == "pbf" || e == "mvt") return "application/x-protobuf";
  if (e == "json" || e == "geojson") return "application/json";
  return "application/octet-stream";
}

bool parse_plain_http_url(const std::string& url, PlainHttpUrl& out) {
  const std::string scheme = "http://";
  if (!starts_with(url, scheme)) return false;

  const std::size_t authority_start = scheme.size();
  const std::size_t path_start = url.find('/', authority_start);
  std::string authority =
      path_start == std::string::npos ? url.substr(authority_start)
                                      : url.substr(authority_start, path_start - authority_start);
  if (authority.empty()) return false;
  out.target = path_start == std::string::npos ? "/" : url.substr(path_start);

  if (authority.front() == '[') {
    const std::size_t close = authority.find(']');
    if (close == std::string::npos) return false;
    out.host = authority.substr(1, close - 1);
    if (close + 1 < authority.size()) {
      if (authority[close + 1] != ':') return false;
      out.port = authority.substr(close + 2);
    }
  } else {
    const std::size_t colon = authority.rfind(':');
    if (colon != std::string::npos) {
      out.host = authority.substr(0, colon);
      out.port = authority.substr(colon + 1);
    } else {
      out.host = authority;
    }
  }
  return !out.host.empty() && !out.port.empty() && !out.target.empty();
}

FetchResult fetch_plain_http(const std::string& url, int timeout_seconds) {
  FetchResult out;
  PlainHttpUrl parsed;
  if (!parse_plain_http_url(url, parsed)) {
    out.error = "unsupported plain HTTP URL";
    return out;
  }

  struct addrinfo hints {};
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  struct addrinfo* result = nullptr;
  const int gai = ::getaddrinfo(parsed.host.c_str(), parsed.port.c_str(), &hints, &result);
  if (gai != 0) {
    out.error = std::string("DNS lookup failed: ") + ::gai_strerror(gai);
    return out;
  }

  int fd = -1;
  for (struct addrinfo* ai = result; ai; ai = ai->ai_next) {
    fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    struct timeval tv {};
    tv.tv_sec = timeout_seconds <= 0 ? 12 : timeout_seconds;
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
    ::close(fd);
    fd = -1;
  }
  ::freeaddrinfo(result);

  if (fd < 0) {
    out.error = "plain HTTP connect failed";
    return out;
  }

  const std::string request =
      "GET " + parsed.target + " HTTP/1.0\r\nHost: " + parsed.host +
      "\r\nAccept: image/avif,image/webp,image/*,*/*\r\nUser-Agent: " +
      get_env("HELM_FILL_UA",
              "helm-basemap-cache/0.1 (+https://github.com/StevenRidder/Helm; cached marine client)") +
      "\r\nConnection: close\r\n\r\n";
  const char* p = request.data();
  std::size_t remaining = request.size();
  while (remaining > 0) {
    const ssize_t n = ::send(fd, p, remaining, 0);
    if (n <= 0) {
      out.error = "plain HTTP request write failed";
      ::close(fd);
      return out;
    }
    p += n;
    remaining -= static_cast<std::size_t>(n);
  }

  std::string raw;
  char buffer[8192];
  for (;;) {
    const ssize_t n = ::recv(fd, buffer, sizeof(buffer), 0);
    if (n > 0) {
      raw.append(buffer, static_cast<std::size_t>(n));
      continue;
    }
    if (n == 0) break;
    out.error = std::string("plain HTTP response read failed: ") + std::strerror(errno);
    ::close(fd);
    return out;
  }
  ::close(fd);

  const std::size_t header_end = raw.find("\r\n\r\n");
  if (header_end == std::string::npos) {
    out.error = "plain HTTP response missing headers";
    return out;
  }
  const std::string headers = raw.substr(0, header_end);
  const std::size_t line_end = headers.find("\r\n");
  const std::string status_line = line_end == std::string::npos ? headers : headers.substr(0, line_end);
  if (!starts_with(status_line, "HTTP/1.")) {
    out.error = "plain HTTP response missing status";
    return out;
  }
  std::istringstream status(status_line.substr(9));
  status >> out.status;
  if (out.status == 200) out.body = raw.substr(header_end + 4);
  return out;
}

std::string json_escape(const std::string& s) {
  std::ostringstream out;
  for (char c : s) {
    switch (c) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(static_cast<unsigned char>(c));
        } else {
          out << c;
        }
    }
  }
  return out.str();
}

bool mkdir_p(const std::string& dir) {
  if (dir.empty() || dir == ".") return true;
  std::string cur;
  std::size_t i = 0;
  if (dir[0] == '/') {
    cur = "/";
    i = 1;
  }
  while (i <= dir.size()) {
    const std::size_t slash = dir.find('/', i);
    const std::string part = dir.substr(i, slash == std::string::npos ? std::string::npos : slash - i);
    if (!part.empty()) {
      cur = cur == "/" ? cur + part : dirname_join(cur, part);
      if (::mkdir(cur.c_str(), 0755) != 0 && errno != EEXIST) return false;
    }
    if (slash == std::string::npos) break;
    i = slash + 1;
  }
  return true;
}

bool stat_file(const std::string& path, struct stat& st) {
  return ::stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

bool read_file(const std::string& path, std::string& out, std::time_t* modified = nullptr) {
  struct stat st {};
  if (!stat_file(path, st) || st.st_size <= 0) return false;
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  std::ostringstream ss;
  ss << in.rdbuf();
  out = ss.str();
  if (out.empty()) return false;
  if (modified) *modified = st.st_mtime;
  return true;
}

bool write_file_atomic(const std::string& path, const std::string& data) {
  const std::size_t slash = path.find_last_of('/');
  if (slash != std::string::npos && !mkdir_p(path.substr(0, slash))) return false;
  const std::string tmp = path + ".tmp." + std::to_string(static_cast<long long>(::getpid()));
  {
    std::ofstream out(tmp, std::ios::binary);
    if (!out) return false;
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
    if (!out) return false;
  }
  if (::rename(tmp.c_str(), path.c_str()) != 0) {
    ::unlink(tmp.c_str());
    return false;
  }
  return true;
}

std::uint64_t count_cached_files(const std::string& dir) {
  DIR* d = ::opendir(dir.c_str());
  if (!d) return 0;
  std::uint64_t n = 0;
  while (dirent* ent = ::readdir(d)) {
    const std::string name = ent->d_name;
    if (name == "." || name == "..") continue;
    const std::string path = dirname_join(dir, name);
    struct stat st {};
    if (::stat(path.c_str(), &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) {
      n += count_cached_files(path);
    } else if (S_ISREG(st.st_mode) && !ends_with(name, ".tmp")) {
      ++n;
    }
  }
  ::closedir(d);
  return n;
}

void base_headers(Headers& h) {
  h["Access-Control-Allow-Origin"] = "*";
  h["Access-Control-Allow-Headers"] = "Range, Content-Type";
  h["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
  h["Access-Control-Expose-Headers"] = "Content-Length, X-Helm-Cache, X-Helm-Source";
  h["Cache-Control"] = "public, max-age=86400";
}

ix::HttpResponsePtr response(int status, const std::string& reason, Headers h,
                             const std::string& body, bool head_only = false) {
  h["Content-Length"] = std::to_string(body.size());
  return std::make_shared<ix::HttpResponse>(
      status, reason, ix::HttpErrorCode::Ok, h, head_only ? std::string() : body);
}

ix::HttpResponsePtr empty_response(int status, const std::string& reason, Headers h,
                                   bool head_only = false) {
  (void)head_only;
  h["Content-Length"] = "0";
  return std::make_shared<ix::HttpResponse>(status, reason, ix::HttpErrorCode::Ok, h, std::string());
}

std::string replace_all(std::string s, const std::string& from, const std::string& to) {
  std::size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += to.size();
  }
  return s;
}

std::string tile_url(const Source& src, std::uint64_t z, std::uint64_t x, std::uint64_t y) {
  std::string url = src.url_template;
  url = replace_all(url, "{z}", std::to_string(z));
  url = replace_all(url, "{x}", std::to_string(x));
  url = replace_all(url, "{y}", std::to_string(y));
  return url;
}

std::map<std::string, Source> make_sources() {
  std::map<std::string, Source> sources;
  sources["eox"] = Source{
      "eox",
      get_env("HELM_BASEMAP_EOX_URL",
              "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg"),
      "jpg",
      "image/jpeg",
      "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (CC-BY-4.0)"};
  sources["esri"] = Source{
      "esri",
      get_env("HELM_BASEMAP_ESRI_URL",
              "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"),
      "jpg",
      "image/jpeg",
      "Esri, Maxar, Earthstar Geographics (dev only)"};
  return sources;
}

class TileLocks {
public:
  std::shared_ptr<std::mutex> lock_for(const std::string& key) {
    std::lock_guard<std::mutex> guard(mu_);
    auto it = locks_.find(key);
    if (it != locks_.end()) return it->second;
    auto created = std::make_shared<std::mutex>();
    locks_[key] = created;
    return created;
  }

  bool begin_refresh(const std::string& key) {
    std::lock_guard<std::mutex> guard(mu_);
    return refreshes_.insert(key).second;
  }

  void end_refresh(const std::string& key) {
    std::lock_guard<std::mutex> guard(mu_);
    refreshes_.erase(key);
  }

private:
  std::mutex mu_;
  std::map<std::string, std::shared_ptr<std::mutex>> locks_;
  std::set<std::string> refreshes_;
};

FetchResult fetch_url(const std::string& url, int timeout_seconds) {
  FetchResult out;
  if (env_truthy("HELM_FILL_OFFLINE")) {
    out.error = "offline mode forced by HELM_FILL_OFFLINE";
    return out;
  }

  if (starts_with(url, "http://")) {
    return fetch_plain_http(url, timeout_seconds);
  }

  ix::HttpClient client;
  auto args = client.createRequest(url);
  args->connectTimeout = timeout_seconds;
  args->transferTimeout = timeout_seconds;
  args->followRedirects = true;
  args->maxRedirects = 3;
  args->compress = false;
  args->extraHeaders["Accept"] = "image/avif,image/webp,image/*,*/*";
  args->extraHeaders["User-Agent"] = get_env(
      "HELM_FILL_UA",
      "helm-basemap-cache/0.1 (+https://github.com/StevenRidder/Helm; cached marine client)");

  ix::HttpResponsePtr r = client.get(url, args);
  if (!r) {
    out.error = "upstream returned no response";
    return out;
  }
  if (r->errorCode != ix::HttpErrorCode::Ok) {
    out.error = r->errorMsg.empty() ? "upstream fetch failed" : r->errorMsg;
    std::fprintf(stderr, "helm-basemap-cache fetch failed: status=%d error=%d bytes=%llu url=%s msg=%s\n",
                 r->statusCode, static_cast<int>(r->errorCode),
                 static_cast<unsigned long long>(r->downloadSize), url.c_str(), out.error.c_str());
    return out;
  }
  out.status = r->statusCode;
  if (r->statusCode == 200) out.body = r->body;
  if (out.status != 200 || out.body.empty()) {
    std::fprintf(stderr, "helm-basemap-cache fetch nonstore: status=%d error=%d body=%zu bytes=%llu url=%s\n",
                 r->statusCode, static_cast<int>(r->errorCode), r->body.size(),
                 static_cast<unsigned long long>(r->downloadSize), url.c_str());
  }
  return out;
}

class TileCache {
public:
  TileCache(std::string root, double refresh_days, int timeout_seconds)
      : root_(expand_user(std::move(root))),
        refresh_seconds_(refresh_days <= 0 ? 0 : static_cast<long>(refresh_days * 86400.0)),
        timeout_seconds_(timeout_seconds <= 0 ? 12 : timeout_seconds) {
    mkdir_p(root_);
  }

  std::uint64_t count() const { return count_cached_files(root_); }

  std::string basemap_path(const Source& src, std::uint64_t z, std::uint64_t x, std::uint64_t y) const {
    return dirname_join(dirname_join(dirname_join(dirname_join(root_, "basemap"), src.id),
                                    std::to_string(z) + "/" + std::to_string(x)),
                        std::to_string(y) + "." + src.extension);
  }

  std::string proxy_path(const std::string& path) const {
    std::string clean = trim_slashes(request_path(path));
    if (clean.empty()) clean = "index";
    for (char& c : clean) {
      if (c == '?' || c == '&' || c == ':' || c == '\\') c = '_';
    }
    return dirname_join(dirname_join(root_, "proxy"), clean);
  }

  bool read_cached(const std::string& path, std::string& data, bool* stale) const {
    std::time_t modified = 0;
    if (!read_file(path, data, &modified)) return false;
    if (stale) {
      *stale = refresh_seconds_ > 0 &&
               (std::time(nullptr) - modified) > static_cast<std::time_t>(refresh_seconds_);
    }
    return true;
  }

  bool store(const std::string& path, const std::string& data) const {
    return !data.empty() && write_file_atomic(path, data);
  }

  void refresh_async(const std::string& cache_path, const std::string& url) {
    if (!locks_.begin_refresh(cache_path)) return;
    std::thread([this, cache_path, url]() {
      auto lock = locks_.lock_for(cache_path);
      std::lock_guard<std::mutex> guard(*lock);
      FetchResult fetched = fetch_url(url, timeout_seconds_);
      if (fetched.status == 200 && !fetched.body.empty()) {
        store(cache_path, fetched.body);
      }
      locks_.end_refresh(cache_path);
    }).detach();
  }

  FetchResult fetch(const std::string& url) const { return fetch_url(url, timeout_seconds_); }

  std::shared_ptr<std::mutex> lock_for(const std::string& key) { return locks_.lock_for(key); }

private:
  std::string root_;
  long refresh_seconds_;
  int timeout_seconds_;
  TileLocks locks_;
};

class BasemapCacheDaemon {
public:
  BasemapCacheDaemon(std::string bind, int port, std::string cache_root,
                     double refresh_days, int timeout_seconds)
      : bind_(std::move(bind)),
        port_(port),
        cache_(std::move(cache_root), refresh_days, timeout_seconds),
        sources_(make_sources()),
        upstream_(get_env("HELM_BASEMAP_UPSTREAM")),
        server_(port_, bind_) {}

  bool start() {
    server_.setOnConnectionCallback(
        [this](ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState>) -> ix::HttpResponsePtr {
          return handle(req);
        });
    return server_.listenAndStart();
  }

private:
  ix::HttpResponsePtr handle(const ix::HttpRequestPtr& req) {
    Headers h;
    base_headers(h);
    const std::string path = request_path(req->uri);
    const bool head_only = req->method == "HEAD";

    if (req->method == "OPTIONS") return empty_response(204, "No Content", std::move(h));
    if (req->method != "GET" && req->method != "HEAD") {
      h["Cache-Control"] = "no-store";
      return empty_response(405, "Method Not Allowed", std::move(h));
    }

    if (path == "/" || path == "/health") {
      h["Content-Type"] = "application/json";
      h["Cache-Control"] = "no-store";
      const std::string body = "{\"ok\":true,\"engine\":\"helm-basemap-cache\",\"sources\":" +
                               source_ids_json() + "}";
      return response(200, "OK", std::move(h), body, head_only);
    }

    if (path == "/stats") {
      h["Content-Type"] = "application/json";
      h["Cache-Control"] = "no-store";
      std::ostringstream body;
      body << "{\"cached_tiles\":" << cache_.count()
           << ",\"sources\":" << source_ids_json()
           << ",\"proxy_enabled\":" << (upstream_.empty() ? "false" : "true") << "}";
      return response(200, "OK", std::move(h), body.str(), head_only);
    }

    const std::vector<std::string> parts = split_path(path);
    if (parts.size() == 5 && parts[0] == "basemap") {
      return serve_basemap(parts, std::move(h), head_only);
    }

    if (!upstream_.empty()) {
      return serve_proxy(path, std::move(h), head_only);
    }

    h["Cache-Control"] = "no-store";
    return empty_response(404, "Not Found", std::move(h));
  }

  ix::HttpResponsePtr serve_basemap(const std::vector<std::string>& parts, Headers h, bool head_only) {
    const std::string source_id = parts[1];
    const auto it = sources_.find(source_id);
    if (it == sources_.end()) return empty_response(404, "Not Found", std::move(h));
    const Source& src = it->second;

    std::uint64_t z = 0, x = 0, y = 0;
    const std::string y_ext = parts[4];
    const std::size_t dot = y_ext.find('.');
    if (dot == std::string::npos || !parse_u64(parts[2], z) || !parse_u64(parts[3], x) ||
        !parse_u64(y_ext.substr(0, dot), y) || z > 30) {
      return empty_response(404, "Not Found", std::move(h));
    }
    if (lower(y_ext.substr(dot + 1)) != lower(src.extension)) {
      return empty_response(404, "Not Found", std::move(h));
    }
    const std::uint64_t span = 1ULL << z;
    if (x >= span || y >= span) return empty_response(404, "Not Found", std::move(h));

    const std::string path = cache_.basemap_path(src, z, x, y);
    const std::string url = tile_url(src, z, x, y);
    h["Content-Type"] = src.content_type;
    h["X-Helm-Source"] = src.id;
    return serve_cache_first(path, url, std::move(h), head_only);
  }

  ix::HttpResponsePtr serve_proxy(const std::string& path, Headers h, bool head_only) {
    std::string upstream = upstream_;
    while (!upstream.empty() && upstream.back() == '/') upstream.pop_back();
    const std::string clean = request_path(path);
    const std::string url = upstream + "/" + trim_slashes(clean);
    const std::string ext = extension_of_path(clean);
    h["Content-Type"] = content_type_for_ext(ext);
    h["X-Helm-Source"] = "upstream";
    return serve_cache_first(cache_.proxy_path(clean), url, std::move(h), head_only);
  }

  ix::HttpResponsePtr serve_cache_first(const std::string& cache_path, const std::string& url,
                                        Headers h, bool head_only) {
    std::string data;
    bool stale = false;
    if (cache_.read_cached(cache_path, data, &stale)) {
      h["X-Helm-Cache"] = stale ? "stale" : "hit";
      if (stale) cache_.refresh_async(cache_path, url);
      return response(200, "OK", std::move(h), data, head_only);
    }

    auto lock = cache_.lock_for(cache_path);
    std::lock_guard<std::mutex> guard(*lock);
    if (cache_.read_cached(cache_path, data, &stale)) {
      h["X-Helm-Cache"] = stale ? "stale" : "hit";
      if (stale) cache_.refresh_async(cache_path, url);
      return response(200, "OK", std::move(h), data, head_only);
    }

    FetchResult fetched = cache_.fetch(url);
    if (fetched.status == 200 && !fetched.body.empty()) {
      cache_.store(cache_path, fetched.body);
      h["X-Helm-Cache"] = "miss-store";
      return response(200, "OK", std::move(h), fetched.body, head_only);
    }

    h["X-Helm-Cache"] = "miss-transparent";
    h["Cache-Control"] = "no-store";
    return empty_response(204, "No Content", std::move(h));
  }

  std::string source_ids_json() const {
    std::ostringstream body;
    body << "[";
    bool first = true;
    for (const auto& kv : sources_) {
      if (!first) body << ",";
      first = false;
      body << "\"" << json_escape(kv.first) << "\"";
    }
    body << "]";
    return body.str();
  }

  std::string bind_;
  int port_;
  TileCache cache_;
  std::map<std::string, Source> sources_;
  std::string upstream_;
  ix::HttpServer server_;
};

}  // namespace

int main(int argc, char** argv) {
  const int port = argc > 1 ? std::atoi(argv[1]) : std::atoi(get_env("HELM_FILL_PORT", "8095").c_str());
  const std::string bind = get_env("HELM_BIND", "0.0.0.0");
  const std::string cache_root = get_env("HELM_FILL_CACHE", "~/.helm/basemap-fill-cache");
  const double refresh_days = std::atof(get_env("HELM_FILL_REFRESH_DAYS", "30").c_str());
  const int timeout_seconds = std::atoi(get_env("HELM_FILL_TIMEOUT", "12").c_str());

  BasemapCacheDaemon daemon(bind, port <= 0 ? 8095 : port, cache_root, refresh_days, timeout_seconds);
  if (!daemon.start()) {
    std::fprintf(stderr, "helm-basemap-cache listen on %s:%d FAILED\n", bind.c_str(), port);
    return 2;
  }
  std::printf("helm-basemap-cache: http://%s:%d/  cache=%s\n",
              bind.c_str(), port <= 0 ? 8095 : port, expand_user(cache_root).c_str());
  for (;;) std::this_thread::sleep_for(std::chrono::hours(24));
  return 0;
}

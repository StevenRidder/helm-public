// helm_server.cpp — ONE-ORIGIN Helm server (nav + charts + UI on a single port).
//
// Merges the two Phase-2 halves into one process behind one ix::HttpServer, which
// auto-routes a WebSocket upgrade to the nav handler and everything else to the HTTP
// handler (see IXHttpServer.cpp: `if Upgrade==websocket -> handleUpgrade; else http`):
//
//   ws   /nav                       OpenCPN model/ nav — snapshot+delta, seq, ~1 Hz
//   GET  /chart/{z}/{x}/{y}.png      S-52 ENC tiles (immutable-cached)  [helm_tiles path]
//   GET  /health  /catalog          liveness + chart catalog
//   GET  /* (anything else)         the Helm UI, served from HELM_WEB_ROOT
//
// Because the page is served from the engine, the client resolves the SAME origin for
// nav + tiles with NO ?server= override. The server also advertises itself over Bonjour
// (_helm._tcp) so an iPad/iPhone discovers "Helm Engine" on the WiFi automatically.
//
//   HELM_BIND      bind address (default 127.0.0.1; 0.0.0.0 to serve the LAN)
//   HELM_PORT      one origin port (default 8080)
//   HELM_WEB_ROOT  static UI directory (default ./web)
//   HELM_ENC       ENC cell .000 (default ~/.helm/runtime/enc/US5FL4CR/US5FL4CR.000)
//
// Links ocpn::chart-render (which pulls in model-src) + ixwebsocket — the helm-tiles
// line. Bonjour uses the system dns_sd (libSystem on macOS, no extra link).

#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <cctype>
#include <deque>
#include <set>
#include <map>
#include <mutex>
#include <condition_variable>
#include <string>
#include <thread>
#include <chrono>
#include <vector>
#include <ctime>
#include <fstream>
#include <random>
#include <sstream>
#include <atomic>
#include <algorithm>
#include <array>
#include <cstdint>
#include <iomanip>

#include <wx/app.h>
#include <wx/bitmap.h>
#include <wx/dcmemory.h>
#include <wx/filename.h>
#include <wx/image.h>
#include <wx/mstream.h>
#include <wx/string.h>

#include "gl_headers.h"
#include "chartbase.h"
#include "s57chart.h"
#include "viewport.h"
#include "ocpn_region.h"
#include "ocpn_pixel.h"
#include "color_types.h"
#include "helm_tides.h"
#include "s52plib.h"
#include "chartsymbols.h"
#include "s57registrar_mgr.h"
#include "o_senc.h"
#include "s63_decode.h"   // CHART-12: headless S-63 encrypted-ENC decrypt

#include "model/routeman.h"
#include "model/route.h"
#include "model/route_point.h"
#include "model/own_ship.h"
#include "model/georef.h"
#include "model/ais_decoder.h"
#include "model/ais_target_data.h"
#include "model/ais_state_vars.h"
#include "model/select.h"
#include "model/base_platform.h"
#include "model/navobj_db.h"
#include <sqlite3.h>
#include "pugixml.hpp"
#include "rapidjson/document.h"
#include <iterator>

#include "ixwebsocket/IXHttpServer.h"
#include "ixwebsocket/IXHttp.h"
#include "ixwebsocket/IXHttpClient.h"
#include "ixwebsocket/IXWebSocket.h"
#include "ixwebsocket/IXConnectionState.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <fcntl.h>
#include <termios.h>
#include <functional>
#include <poll.h>
#include <cerrno>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#include <dns_sd.h>

// NOTE: g_pi_manager is provided by chart_stubs.cpp (inside ocpn::chart-render) — do NOT
// redefine it here, or the link fails with a duplicate symbol. (This is the api_shim-vs-
// chart_stubs overlap the README warned about; the merged binary takes the chart_stubs one.)

extern s52plib* ps52plib;
extern wxString g_csv_locn;
extern wxString g_SENCPrefix;
extern wxString g_SData_Locn;
void EnsureHeadlessGlobals();

// ===========================================================================
// Tile rendering (S-52) — from helm_tiles.cpp, unchanged behavior.
// ===========================================================================
// DURABLE runtime paths for the S-52 presentation library (s57data) + the SENC cache. Resolved at
// startup from the environment, defaulting under ~/.helm/runtime, so the engine boots
// after a reboot or on a fresh install (engine/bootstrap.sh installs the s57data there). The old
// hardcoded transient paths were wiped on every reboot, which made cold-starting impossible.
// Override with HELM_S57_DATA (the s57data dir) / HELM_SENC_DIR (the regenerable SENC cache).
static std::string helm_home_dir() {
  const char* home = std::getenv("HOME");
  return home && *home ? home : ".";
}

static std::string helm_runtime_path(const std::string& rel) {
  return helm_home_dir() + "/.helm/runtime/" + rel;
}

static wxString kDataDir, kS57Data, kPLibRLE, kSencDir;
static void resolve_runtime_paths() {
  wxString s57;
  if (const char* e = std::getenv("HELM_S57_DATA")) if (*e) s57 = wxString::FromUTF8(e);
  if (s57.IsEmpty()) s57 = wxString::FromUTF8(helm_runtime_path("s57data").c_str());
  if (!s57.EndsWith(wxT("/"))) s57 += wxT("/");
  kS57Data = s57;
  kPLibRLE = s57 + wxT("S52RAZDS.RLE");
  { wxString d = s57; d.RemoveLast(); kDataDir = d.BeforeLast('/') + wxT("/"); }   // data/ = parent of s57data/
  wxString senc;
  if (const char* e = std::getenv("HELM_SENC_DIR")) if (*e) senc = wxString::FromUTF8(e);
  if (senc.IsEmpty()) senc = wxString::FromUTF8(helm_runtime_path("senc").c_str());
  if (!senc.EndsWith(wxT("/"))) senc += wxT("/");
  kSencDir = senc;
}

static s57chart* g_chart = nullptr;
static Extent    g_ext;
static std::string g_blank;
static std::string g_chart_status = "not-initialized";
static std::string g_chart_unavailable_reason;
static const int TS = 256;

// CHART-8: true engine-side S-52 colour palette (Day/Dusk/Night), NOT a raster reskin. Rendering is
// serialized on the main thread (the job loop), so we switch the global s52plib + chart colour scheme
// per tile and pay the switch cost only when the requested palette actually changes.
static std::string g_cell_name;                               // components of the per-palette ETag
static int g_native_scale = 0;
static ColorScheme g_color_scheme = GLOBAL_COLOR_SCHEME_DAY;  // currently-applied scheme
static const char* palette_name(ColorScheme s) {
  return s == GLOBAL_COLOR_SCHEME_DUSK ? "dusk" : (s == GLOBAL_COLOR_SCHEME_NIGHT ? "night" : "day");
}
static ColorScheme palette_from_query(const std::string& uri) {   // ?p=day|dusk|night (default day)
  const auto q = uri.find("p=");
  if (q != std::string::npos) {
    const std::string v = uri.substr(q + 2);
    if (v.rfind("dusk", 0) == 0)  return GLOBAL_COLOR_SCHEME_DUSK;
    if (v.rfind("night", 0) == 0) return GLOBAL_COLOR_SCHEME_NIGHT;
  }
  return GLOBAL_COLOR_SCHEME_DAY;
}
static void apply_palette(ColorScheme scheme) {               // main-thread only (called from render_tile)
  if (scheme == g_color_scheme) return;
  ps52plib->SetPLIBColorScheme(scheme, ChartCtx(false, 0));
  if (g_chart) g_chart->SetColorScheme(scheme);
  g_color_scheme = scheme;
}

// CHART-9: S-52 display category (Base/Std/All/Mariner) selects WHICH feature classes render
// (DISPLAYBASE = safety-critical only … OTHER = everything). Switched per tile on the serialized
// render thread, only when it changes. Default = the renderer's own default (captured at init) so a
// request without ?cat= is byte-identical to before.
static DisCat g_default_cat = STANDARD;          // captured from ps52plib->GetDisplayCategory() at init
static DisCat g_display_cat = STANDARD;          // currently-applied
static const char* cat_name(DisCat c) {
  return c == DISPLAYBASE ? "base" : (c == OTHER ? "all" : (c == MARINERS_STANDARD ? "mariner" : "std"));
}
static DisCat category_from_query(const std::string& uri) {   // ?cat=base|std|all|mariner (default = renderer default)
  const auto q = uri.find("cat=");
  if (q != std::string::npos) {
    const std::string v = uri.substr(q + 4);
    if (v.rfind("base", 0) == 0)    return DISPLAYBASE;
    if (v.rfind("std", 0) == 0)     return STANDARD;
    if (v.rfind("all", 0) == 0)     return OTHER;
    if (v.rfind("mariner", 0) == 0) return MARINERS_STANDARD;
  }
  return g_default_cat;
}
static void apply_category(DisCat cat) {                      // main-thread only (from render_tile)
  if (cat == g_display_cat) return;
  ps52plib->SetDisplayCategory(cat);
  g_display_cat = cat;
}

static std::string header_ci(const ix::WebSocketHttpHeaders& h, const char* name) {
  std::string want(name);
  for (auto& c : want) c = (char)std::tolower((unsigned char)c);
  for (auto& kv : h) {
    std::string k = kv.first;
    for (auto& c : k) c = (char)std::tolower((unsigned char)c);
    if (k == want) return kv.second;
  }
  return std::string();
}

enum class TileStatus { Ok, NoCoverage, BadRequest, RenderFailed };
// CHART-10: the single main-thread job consumer runs either a tile render or an S-57 object query —
// both touch the non-thread-safe g_chart/ps52plib, so a query is marshalled through the SAME queue.
enum class JobKind { Render, Query };
struct Job { JobKind kind = JobKind::Render;
             int z = 0; long x = 0, y = 0;                       // render inputs (z reused as the query zoom hint)
             double qlat = 0, qlon = 0; int qradius_px = 5;      // query inputs
             ColorScheme palette = GLOBAL_COLOR_SCHEME_DAY; DisCat cat = STANDARD; std::string result;
             TileStatus status = TileStatus::RenderFailed;
             bool done = false; std::mutex m; std::condition_variable cv; };
static std::deque<Job*> g_jobs;
static std::mutex g_jobs_m;
static std::condition_variable g_jobs_cv;

static double tile_lon(double x, int z) { return x / std::pow(2.0, z) * 360.0 - 180.0; }
static double tile_lat(double y, int z) {
  double n = M_PI * (1.0 - 2.0 * y / std::pow(2.0, z));
  return std::atan(std::sinh(n)) * 180.0 / M_PI;
}
// CHART-9: Web-Mercator display-scale denominator (OGC 0.28 mm/px, 256-px tiles) — for the overzoom check.
static double display_scale(int z, double lat) {
  return 559082264.029 * std::cos(lat * M_PI / 180.0) / std::pow(2.0, z);
}

static TileStatus render_tile(int z, long x, long y, ColorScheme palette, DisCat cat, std::string& out) {
  if (z < 0 || z > 24 || x < 0 || y < 0 || x >= (1L << z) || y >= (1L << z)) {
    fprintf(stderr, "tile BAD REQUEST z%d/%ld/%ld\n", z, x, y);
    return TileStatus::BadRequest;
  }
  if (!g_chart) return TileStatus::NoCoverage;
  double west = tile_lon(x, z), east = tile_lon(x + 1, z);
  double north = tile_lat(y, z), south = tile_lat(y + 1, z);
  if (east < g_ext.WLON || west > g_ext.ELON || north < g_ext.SLAT || south > g_ext.NLAT)
    return TileStatus::NoCoverage;
  apply_palette(palette);   // CHART-8: switch the S-52 colour scheme if the requested palette changed
  apply_category(cat);      // CHART-9: switch the S-52 display category if the requested one changed
  double clat = (north + south) / 2.0, clon = (west + east) / 2.0;
  double span_m = (north - south) * 1852.0 * 60.0;
  if (span_m <= 0) { fprintf(stderr, "tile RENDER FAIL z%d/%ld/%ld: span\n", z, x, y); return TileStatus::RenderFailed; }
  double ppm = (double)TS / span_m;
  ViewPort vp;
  vp.clat = clat; vp.clon = clon; vp.view_scale_ppm = ppm;
  vp.pix_width = TS; vp.pix_height = TS;
  vp.rotation = 0; vp.skew = 0; vp.tilt = 0;
  vp.m_projection_type = PROJECTION_MERCATOR;
  vp.chart_scale = g_chart->GetNativeScale();
  vp.ref_scale = vp.chart_scale;
  vp.b_quilt = false;
  vp.rv_rect = wxRect(0, 0, TS, TS);
  vp.SetBoxes(); vp.Validate();
  wxBitmap bmp(TS, TS, BPP);
  if (!bmp.IsOk()) { fprintf(stderr, "tile RENDER FAIL z%d/%ld/%ld: bmp\n", z, x, y); return TileStatus::RenderFailed; }
  wxMemoryDC dc(bmp);
  if (!dc.IsOk()) { fprintf(stderr, "tile RENDER FAIL z%d/%ld/%ld: dc\n", z, x, y); return TileStatus::RenderFailed; }
  OCPNRegion region(0, 0, TS, TS);
  bool ok = g_chart->RenderRegionViewOnDC(dc, vp, region);
  wxBitmap rendered = dc.GetSelectedBitmap();
  dc.SelectObject(wxNullBitmap);
  if (!ok || !rendered.IsOk()) { fprintf(stderr, "tile RENDER FAIL z%d/%ld/%ld: render\n", z, x, y); return TileStatus::RenderFailed; }
  wxImage img = rendered.ConvertToImage();
  if (!img.IsOk()) { fprintf(stderr, "tile RENDER FAIL z%d/%ld/%ld: img\n", z, x, y); return TileStatus::RenderFailed; }
  wxMemoryOutputStream mos;
  if (!img.SaveFile(mos, wxBITMAP_TYPE_PNG)) { fprintf(stderr, "tile RENDER FAIL z%d/%ld/%ld: png\n", z, x, y); return TileStatus::RenderFailed; }
  out.resize(mos.GetSize());
  mos.CopyTo(&out[0], out.size());
  return TileStatus::Ok;
}

static std::string make_blank() {
  wxImage blank(TS, TS); blank.SetAlpha();
  std::memset(blank.GetAlpha(), 0, (size_t)TS * TS);
  wxMemoryOutputStream mos; blank.SaveFile(mos, wxBITMAP_TYPE_PNG);
  std::string out; out.resize(mos.GetSize()); mos.CopyTo(&out[0], out.size());
  return out;
}

static bool mark_chart_unavailable(const char* reason) {
  if (g_chart) { delete g_chart; g_chart = nullptr; }
  g_chart_status = "unavailable";
  g_chart_unavailable_reason = reason ? reason : "chart unavailable";
  g_ext = Extent();
  g_cell_name = "no-enc";
  g_native_scale = 0;
  if (g_blank.empty()) g_blank = make_blank();
  if (g_blank.empty()) {
    printf("FATAL: blank tile gen failed while entering basemap-only mode\n");
    return false;
  }
  printf("chart unavailable: %s — booting basemap-only; /chart returns transparent tiles, /catalog has no cells\n",
         g_chart_unavailable_reason.c_str());
  return true;
}

static bool init_chart(const wxString& enc_path) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  resolve_runtime_paths();   // durable, env-overridable s57data / SENC paths
  wxImage::AddHandler(new wxPNGHandler);
  EnsureHeadlessGlobals();
  ::wxFileName::Mkdir(kSencDir, 0755, wxPATH_MKDIR_FULL);
  g_SENCPrefix = kSencDir; g_csv_locn = kS57Data; g_SData_Locn = kDataDir;
  ps52plib = new s52plib(kPLibRLE, false);
  if (!ps52plib || !ps52plib->m_bOK) {
    printf("s52plib load FAILED — missing S-52 presentation library at %s\n"
           "  fix: run engine/bootstrap.sh (installs it to ~/.helm/runtime/s57data), or set HELM_S57_DATA\n",
           (const char*)kPLibRLE.ToUTF8());
    return false;
  }
  ps52plib->SetPLIBColorScheme(GLOBAL_COLOR_SCHEME_DAY, ChartCtx(false, 0));
  g_default_cat = g_display_cat = ps52plib->GetDisplayCategory();   // still defined in basemap-only mode
  g_blank = make_blank();
  if (g_blank.empty()) { printf("FATAL: blank tile gen failed\n"); return false; }
  m_pRegistrarMan = new s57RegistrarMgr(kS57Data, stderr);
  // CHART-12: if the cell is S-63 encrypted, decrypt it to a plain S-57 temp and load THAT (the
  // catalog id below still uses the original cell name). A plain S-57 cell passes through unchanged.
  wxString load_path = enc_path;
  std::string s63_src = std::string((const char*)enc_path.ToUTF8());
  if (s63::is_encrypted(s63_src)) {
    static s63::Decoder s63dec = s63::Decoder::from_env();
    std::string cn = std::string((const char*)wxFileName(enc_path).GetName().ToUTF8()), err;
    if (!s63dec.enabled()) {
      char msg[256]; std::snprintf(msg, sizeof msg, "S-63 encrypted cell %s but no permit/HW_ID (set HELM_S63_PERMIT + HELM_S63_HWID)", cn.c_str());
      return mark_chart_unavailable(msg);
    }
    std::string s63_dir = helm_runtime_path("s63");
    ::wxFileName::Mkdir(wxString::FromUTF8(s63_dir.c_str()), 0755, wxPATH_MKDIR_FULL);
    std::string tmp = s63_dir + "/" + cn + ".000";
    if (!s63dec.decrypt_to_file(s63_src, cn, tmp, err)) {
      std::string msg = "S-63 decrypt FAILED for " + cn + ": " + err;
      return mark_chart_unavailable(msg.c_str());
    }
    printf("S-63: decrypted %s -> plain S-57\n", cn.c_str());
    load_path = wxString::FromUTF8(tmp.c_str());
  }
  g_chart = new s57chart();
  g_chart->DisableBackgroundSENC();
  if (g_chart->Init(load_path, FULL_INIT) != INIT_OK) {
    printf("chart Init FAILED — could not load ENC cell %s\n"
           "  fix for S-52 charts: set HELM_ENC to a valid .000 cell; continuing basemap-only\n",
           (const char*)load_path.ToUTF8());
    return mark_chart_unavailable("chart Init failed");
  }
  g_chart->SetColorScheme(GLOBAL_COLOR_SCHEME_DAY);
  if (!g_chart->GetChartExtent(&g_ext)) { printf("GetChartExtent FAILED\n"); return mark_chart_unavailable("GetChartExtent failed"); }
  int ns = g_chart->GetNativeScale();
  if (ns <= 1) { printf("chart native scale invalid (%d)\n", ns); return mark_chart_unavailable("chart native scale invalid"); }
  g_chart_status = "loaded";
  g_chart_unavailable_reason.clear();
  g_cell_name = std::string((const char*)wxFileName(enc_path).GetName().ToUTF8());
  g_native_scale = ns;   // CHART-8: ETag is built per-request as "<cell>.<palette>.<cat>.s<scale>"
  printf("ENC loaded: S %.4f N %.4f W %.4f E %.4f  nativeScale=%d\n",
         g_ext.SLAT, g_ext.NLAT, g_ext.WLON, g_ext.ELON, ns);
  return true;
}

static void warmup_render() {
  if (!g_chart) {
    printf("warmup render skipped: no ENC chart loaded (basemap-only)\n");
    return;
  }
  double clat = (g_ext.SLAT + g_ext.NLAT) / 2.0, clon = (g_ext.WLON + g_ext.ELON) / 2.0;
  const int z = 13; const double n = std::pow(2.0, z);
  long x = (long)((clon + 180.0) / 360.0 * n);
  double lr = clat * M_PI / 180.0;
  long y = (long)((1.0 - std::log(std::tan(lr) + 1.0 / std::cos(lr)) / M_PI) / 2.0 * n);
  std::string scratch; TileStatus st = render_tile(z, x, y, GLOBAL_COLOR_SCHEME_DAY, g_default_cat, scratch);
  printf("warmup render z%d/%ld/%ld -> status=%d (%zuB)\n", z, x, y, (int)st, scratch.size());
}

// ===========================================================================
// Static UI serving — the page is served from the engine, so the client's
// resolved origin == the engine. (No ?server= override needed.)
// ===========================================================================
static std::string g_webroot;
static std::string g_user_data_root;
static const char* mime_for(const std::string& path) {
  auto ends = [&](const char* s){ size_t n=strlen(s); return path.size()>=n && path.compare(path.size()-n,n,s)==0; };
  if (ends(".html")) return "text/html; charset=utf-8";
  if (ends(".js"))   return "application/javascript";
  if (ends(".mjs"))  return "application/javascript";
  if (ends(".json")) return "application/json";
  if (ends(".geojson")) return "application/json";
  if (ends(".css"))  return "text/css";
  if (ends(".png"))  return "image/png";
  if (ends(".svg"))  return "image/svg+xml";
  if (ends(".ico"))  return "image/x-icon";
  return "text/plain; charset=utf-8";
}

static std::string helm_config_dir() {
  if (const char* c = std::getenv("HELM_CONFIG")) if (*c) return c;
  const char* home = std::getenv("HOME");
  std::string d = (home && *home) ? home : ".";
  return d + "/.helm";
}

// returns false if the path escapes the root or the file is missing
// Percent-decode a request path so files with spaces/UTF-8 resolve (e.g. the glyph dir
// "fonts/Noto Sans Regular/" arrives as fonts/Noto%20Sans%20Regular/ — without this it 404s
// and the map renders with no labels).
static std::string url_decode(const std::string& s) {
  auto hex = [](char c) -> int { if (c>='0'&&c<='9') return c-'0'; if (c>='a'&&c<='f') return c-'a'+10; if (c>='A'&&c<='F') return c-'A'+10; return -1; };
  std::string o; o.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) { int h = hex(s[i+1]), l = hex(s[i+2]); if (h >= 0 && l >= 0) { o += (char)(h*16 + l); i += 2; continue; } }
    o += s[i];
  }
  return o;
}
static bool serve_static(const std::string& uri, std::string& body, std::string& mime) {
  std::string p = uri;
  size_t q = p.find('?'); if (q != std::string::npos) p = p.substr(0, q);
  p = url_decode(p);                                             // %20 etc. so 'fonts/Noto Sans Regular/' resolves
  if (p == "/" || p.empty()) p = "/index.html";
  if (p.find("..") != std::string::npos) return false;           // no path traversal (checked AFTER decode)
  std::string full = g_webroot + p;
  std::ifstream f(full, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss; ss << f.rdbuf();
  body = ss.str(); mime = mime_for(p);
  return true;
}

static bool serve_user_data(const std::string& uri, std::string& body, std::string& mime) {
  std::string p = uri;
  size_t q = p.find('?'); if (q != std::string::npos) p = p.substr(0, q);
  p = url_decode(p);
  while (!p.empty() && p.front() == '/') p.erase(p.begin());
  if (p.empty() || p.find("..") != std::string::npos) return false;
  std::string full = g_user_data_root + "/" + p;
  std::ifstream f(full, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss; ss << f.rdbuf();
  body = ss.str(); mime = mime_for(p);
  return true;
}

// ===========================================================================
// Nav (model/ Routeman) — from helm_engine.cpp. Runs on its own thread and
// pushes snapshot/delta to the WS clients of the shared ix::HttpServer.
// ===========================================================================
struct WP { double lat, lon; std::string name; };
static std::vector<WP> ROUTE;                 // the ACTIVE route the sim follows — guarded by g_route_mtx
static std::string g_route_name = "Route";
static std::mutex g_route_mtx;                 // guards ROUTE + g_route_name (swapped at runtime by route.create)
static std::atomic<long> g_route_version{0};   // bumped on swap so nav_loop rebuilds the active route
static std::atomic<bool> g_have_fix{false};    // true only with a fresh real GPS fix; used by nav/AIS/tide resolver

// Built-in sample (inside US5FL96M) used when no HELM_ROUTE is given, so the server still
// runs out of the box. Real GPX data parsed by the same loader as a user file.
static const char* SAMPLE_GPX = R"GPX(<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Helm" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>Key West Approach</name>
    <rtept lat="24.770" lon="-81.580"><name>WP1 · start</name></rtept>
    <rtept lat="24.792" lon="-81.515"><name>WP2 · sea buoy</name></rtept>
    <rtept lat="24.812" lon="-81.448"><name>WP3 · channel</name></rtept>
    <rtept lat="24.835" lon="-81.375"><name>WP4 · pass</name></rtept>
    <rtept lat="24.856" lon="-81.302"><name>WP5 · marina</name></rtept>
  </rte>
</gpx>)GPX";

// Minimal JSON string escaper — route/waypoint/AIS names come from user data.
static std::string json_escape(const std::string& s) {
  std::string o; o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;  case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;  case '\r': o += "\\r"; break;  case '\t': o += "\\t"; break;
      default: if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; } else o += (char)c;
    }
  }
  return o;
}

static std::string query_param(const std::string& uri, const std::string& key) {
  const size_t q = uri.find('?');
  if (q == std::string::npos) return "";
  const std::string needle = key + "=";
  for (size_t p = q + 1; p < uri.size();) {
    size_t e = uri.find('&', p);
    if (e == std::string::npos) e = uri.size();
    if (uri.compare(p, needle.size(), needle) == 0)
      return url_decode(uri.substr(p + needle.size(), e - p - needle.size()));
    p = e + 1;
  }
  return "";
}

static double query_double_or(const std::string& uri, const std::string& key,
                              double fallback) {
  std::string v = query_param(uri, key);
  if (v.empty()) return fallback;
  char* end = nullptr;
  double d = std::strtod(v.c_str(), &end);
  return end && *end == '\0' ? d : fallback;
}

static int query_int_or(const std::string& uri, const std::string& key,
                        int fallback) {
  std::string v = query_param(uri, key);
  if (v.empty()) return fallback;
  char* end = nullptr;
  long d = std::strtol(v.c_str(), &end, 10);
  return end && *end == '\0' ? (int)d : fallback;
}

static std::string tide_cache_dir() {
  if (const char* d = std::getenv("HELM_TIDES_CACHE_DIR")) {
    if (*d) return d;
  }
  if (const char* c = std::getenv("HELM_CONFIG")) {
    if (*c) return std::string(c) + "/tides-cache";
  }
  const char* home = std::getenv("HOME");
  std::string base = home && *home ? home : ".";
  return base + "/.helm/tides-cache";
}

static std::string tide_source_json(const helm::tides::TideSourceInfo& s) {
  return "{\"path\":\"" + json_escape(s.path) +
         "\",\"basename\":\"" + json_escape(s.basename) +
         "\",\"license\":\"" + json_escape(s.license) +
         "\",\"provenance\":\"" + json_escape(s.provenance) +
         "\",\"redistribution_status\":\"" +
         json_escape(s.redistribution_status) +
         "\",\"redistribution_cleared\":" +
         (s.redistribution_cleared ? "true" : "false") +
         ",\"enabled_by_default\":" +
         (s.enabled_by_default ? "true" : "false") + "}";
}

static std::string tide_official_prediction_cache_json(
    const helm::tides::OfficialPredictionCacheInfo& c) {
  return "{\"ok\":" + std::string(c.ok ? "true" : "false") +
         ",\"provider_region_id\":\"" +
         json_escape(c.provider_region_id) +
         "\",\"provider\":\"" + json_escape(c.provider) +
         "\",\"station_id\":\"" + json_escape(c.station_id) +
         "\",\"station_name\":\"" + json_escape(c.station_name) +
         "\",\"datum_name\":\"" + json_escape(c.datum_name) +
         "\",\"source_url\":\"" + json_escape(c.source_url) +
         "\",\"cache_path\":\"" + json_escape(c.cache_path) +
         "\",\"data_path\":\"" + json_escape(c.data_path) +
         "\",\"fetched_utc\":\"" + json_escape(c.fetched_utc) +
         "\",\"issue_date\":\"" + json_escape(c.issue_date) +
         "\",\"valid_start_utc\":\"" +
         json_escape(c.valid_start_utc) +
         "\",\"valid_end_utc\":\"" + json_escape(c.valid_end_utc) +
         "\",\"refresh_after_utc\":\"" +
         json_escape(c.refresh_after_utc) +
         "\",\"time_zone\":\"" + json_escape(c.time_zone) +
         "\",\"time_basis\":\"" + json_escape(c.time_basis) +
         "\",\"license\":\"" + json_escape(c.license) +
         "\",\"provenance\":\"" + json_escape(c.provenance) +
         "\",\"redistribution_status\":\"" +
         json_escape(c.redistribution_status) +
         "\",\"cache_status\":\"" + json_escape(c.cache_status) +
         "\",\"sample_count\":" + std::to_string(c.sample_count) +
         ",\"official\":" + (c.official ? "true" : "false") +
         ",\"valid_for_time\":" +
         (c.valid_for_time ? "true" : "false") +
         ",\"refresh_due\":" + (c.refresh_due ? "true" : "false") +
         ",\"redistribution_cleared\":" +
         (c.redistribution_cleared ? "true" : "false") + "}";
}

static std::string tide_provider_region_json(
    const helm::tides::TideProviderRegion& p) {
  std::ostringstream nums;
  nums.setf(std::ios::fixed);
  nums.precision(6);
  nums << "\"bbox\":[" << p.min_lon << "," << p.min_lat << ","
       << p.max_lon << "," << p.max_lat << "]"
       << ",\"official\":" << (p.official ? "true" : "false")
       << ",\"predictions_available\":"
       << (p.predictions_available ? "true" : "false")
       << ",\"observations_available\":"
       << (p.observations_available ? "true" : "false")
       << ",\"currents_available\":"
       << (p.currents_available ? "true" : "false")
       << ",\"requires_api_key\":"
       << (p.requires_api_key ? "true" : "false")
       << ",\"requires_subscription\":"
       << (p.requires_subscription ? "true" : "false")
       << ",\"redistribution_cleared\":"
       << (p.redistribution_cleared ? "true" : "false")
       << ",\"enabled_by_default\":"
       << (p.enabled_by_default ? "true" : "false");
  return "{\"id\":\"" + json_escape(p.id) +
         "\",\"provider\":\"" + json_escape(p.provider) +
         "\",\"authority\":\"" + json_escape(p.authority) +
         "\",\"product\":\"" + json_escape(p.product) +
         "\",\"region_name\":\"" + json_escape(p.region_name) +
         "\",\"country\":\"" + json_escape(p.country) +
         "\",\"source_url\":\"" + json_escape(p.source_url) +
         "\",\"metadata_url\":\"" + json_escape(p.metadata_url) +
         "\",\"prediction_url_template\":\"" +
         json_escape(p.prediction_url_template) +
         "\",\"observed_url_template\":\"" +
         json_escape(p.observed_url_template) +
         "\",\"datum_name\":\"" + json_escape(p.datum_name) +
         "\",\"license\":\"" + json_escape(p.license) +
         "\",\"provenance\":\"" + json_escape(p.provenance) +
         "\",\"redistribution_status\":\"" +
         json_escape(p.redistribution_status) +
         "\",\"cache_policy\":\"" + json_escape(p.cache_policy) +
         "\",\"update_cadence\":\"" + json_escape(p.update_cadence) +
         "\",\"adapter_status\":\"" + json_escape(p.adapter_status) +
         "\",\"intended_use\":\"" + json_escape(p.intended_use) +
         "\",\"notes\":\"" + json_escape(p.notes) +
         "\"," + nums.str() + "}";
}

static std::string tide_provider_regions_json(
    const std::vector<helm::tides::TideProviderRegion>& providers) {
  std::string out = "[";
  for (size_t i = 0; i < providers.size(); ++i) {
    if (i) out += ",";
    out += tide_provider_region_json(providers[i]);
  }
  out += "]";
  return out;
}

static std::string tide_official_prediction_request_json(
    const helm::tides::OfficialPredictionRequest& r) {
  return "{\"ok\":" + std::string(r.ok ? "true" : "false") +
         ",\"needed\":" + (r.needed ? "true" : "false") +
         ",\"cached\":" + (r.cached ? "true" : "false") +
         ",\"cache_refresh_due\":" +
         (r.cache_refresh_due ? "true" : "false") +
         ",\"can_fetch_live\":" + (r.can_fetch_live ? "true" : "false") +
         ",\"manual_import_required\":" +
         (r.manual_import_required ? "true" : "false") +
         ",\"requires_api_key\":" +
         (r.requires_api_key ? "true" : "false") +
         ",\"requires_subscription\":" +
         (r.requires_subscription ? "true" : "false") +
         ",\"blocked\":" + (r.blocked ? "true" : "false") +
         ",\"action\":\"" + json_escape(r.action) +
         "\",\"status\":\"" + json_escape(r.status) +
         "\",\"provider_region_id\":\"" +
         json_escape(r.provider_region_id) +
         "\",\"provider\":\"" + json_escape(r.provider) +
         "\",\"adapter_status\":\"" + json_escape(r.adapter_status) +
         "\",\"station_id\":\"" + json_escape(r.station_id) +
         "\",\"station_name\":\"" + json_escape(r.station_name) +
         "\",\"datum_name\":\"" + json_escape(r.datum_name) +
         "\",\"date_utc\":\"" + json_escape(r.date_utc) +
         "\",\"time_zone\":\"" + json_escape(r.time_zone) +
         "\",\"source_url\":\"" + json_escape(r.source_url) +
         "\",\"fetch_url\":\"" + json_escape(r.fetch_url) +
         "\",\"cache_key\":\"" + json_escape(r.cache_key) +
         "\",\"cache_path\":\"" + json_escape(r.cache_path) +
         "\",\"data_path\":\"" + json_escape(r.data_path) +
         "\",\"license\":\"" + json_escape(r.license) +
         "\",\"provenance\":\"" + json_escape(r.provenance) +
         "\",\"redistribution_status\":\"" +
         json_escape(r.redistribution_status) +
         "\",\"redistribution_cleared\":" +
         (r.redistribution_cleared ? "true" : "false") + "}";
}

static std::string tide_official_reference_json(
    const helm::tides::OfficialTideReference& r) {
  std::ostringstream nums;
  nums.setf(std::ios::fixed);
  nums.precision(6);
  nums << "\"lat\":" << r.lat << ",\"lon\":" << r.lon
       << ",\"distance_nm\":" << r.distance_nm
       << ",\"official\":" << (r.official ? "true" : "false")
       << ",\"prediction_calendar\":"
       << (r.prediction_calendar ? "true" : "false")
       << ",\"observed_water_level_available\":"
       << (r.observed_water_level_available ? "true" : "false")
       << ",\"valid_for_time\":"
       << (r.valid_for_time ? "true" : "false");
  return "{\"provider_region_id\":\"" + json_escape(r.provider_region_id) +
         "\",\"provider\":\"" + json_escape(r.provider) +
         "\",\"product\":\"" + json_escape(r.product) +
         "\",\"station_id\":\"" + json_escape(r.station_id) +
         "\",\"station_name\":\"" + json_escape(r.station_name) +
         "\",\"country\":\"" + json_escape(r.country) +
         "\",\"source_url\":\"" + json_escape(r.source_url) +
         "\",\"observed_url\":\"" + json_escape(r.observed_url) +
         "\",\"datum_name\":\"" + json_escape(r.datum_name) +
         "\",\"issue_date\":\"" + json_escape(r.issue_date) +
         "\",\"valid_start_utc\":\"" + json_escape(r.valid_start_utc) +
         "\",\"valid_end_utc\":\"" + json_escape(r.valid_end_utc) +
         "\",\"interpolation_method\":\"" +
         json_escape(r.interpolation_method) + "\"," + nums.str() + "}";
}

static std::string tide_confidence_json(
    const helm::tides::TideConfidence& c) {
  char nums[512];   // headroom for the confidence numeric block
  std::snprintf(nums, sizeof nums,
    "\"score\":%.3f,\"harmonic_station_distance_nm\":%.6f,"
    "\"official_station_distance_nm\":%.6f,"
    "\"has_official_reference\":%s,"
    "\"official_reference_valid_for_time\":%s,"
    "\"live_observation_available\":%s",
    c.score, c.harmonic_station_distance_nm, c.official_station_distance_nm,
    c.has_official_reference ? "true" : "false",
    c.official_reference_valid_for_time ? "true" : "false",
    c.live_observation_available ? "true" : "false");
  std::string factors = "[";
  for (size_t i = 0; i < c.factors.size(); ++i) {
    if (i) factors += ",";
    factors += "\"" + json_escape(c.factors[i]) + "\"";
  }
  factors += "]";
  return "{\"tier\":\"" + json_escape(c.tier) +
         "\"," + nums +
         ",\"summary\":\"" + json_escape(c.summary) +
         "\",\"basis\":\"" + json_escape(c.basis) +
         "\",\"factors\":" + factors +
         ",\"official_reference\":" +
         (c.has_official_reference
              ? tide_official_reference_json(c.official_reference)
              : std::string("null")) + "}";
}

static std::string tide_station_json(const helm::tides::TideStation& s) {
  char b[512];   // headroom for the station numeric block
  std::snprintf(b, sizeof b,
    "\"index\":%d,\"type\":\"%c\",\"lat\":%.6f,\"lon\":%.6f,"
    "\"distance_nm\":%.6f,\"datum_m\":%.6f,\"has_datum\":%s,"
    "\"source_redistribution_cleared\":%s,\"source_enabled_by_default\":%s",
    s.index, s.type, s.lat, s.lon, s.distance_nm, s.datum_m,
    s.has_datum ? "true" : "false",
    s.source_redistribution_cleared ? "true" : "false",
    s.source_enabled_by_default ? "true" : "false");
  return "{\"name\":\"" + json_escape(s.name) +
         "\",\"reference\":\"" + json_escape(s.reference_name) +
         "\",\"source\":\"" + json_escape(s.source) +
         "\",\"source_license\":\"" + json_escape(s.source_license) +
         "\",\"source_provenance\":\"" + json_escape(s.source_provenance) +
         "\",\"source_redistribution_status\":\"" +
         json_escape(s.source_redistribution_status) +
         "\",\"unit\":\"" + json_escape(s.unit) + "\"," + b + "}";
}

static std::string tide_event_json(const helm::tides::TideEvent& e) {
  if (!e.ok) return "{\"ok\":false,\"error\":\"" + json_escape(e.error) + "\"}";
  char b[96];
  std::snprintf(b, sizeof b, "%.6f", e.value_m);
  return "{\"ok\":true,\"kind\":\"" + json_escape(e.kind) +
         "\",\"search_start_utc\":\"" +
         helm::tides::FormatUtcIso8601(e.search_start_utc) +
         "\",\"event_utc\":\"" + helm::tides::FormatUtcIso8601(e.event_utc) +
         "\",\"value_m\":" + b + "}";
}

static std::string string_array_json(const std::vector<std::string>& values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ",";
    out += "\"" + json_escape(values[i]) + "\"";
  }
  out += "]";
  return out;
}

static std::string tide_resolve_point_json(
    const helm::tides::TideResolvePoint& p) {
  char nums[160];
  std::snprintf(nums, sizeof nums, "\"lat\":%.6f,\"lon\":%.6f",
                p.lat, p.lon);
  return "{\"id\":\"" + json_escape(p.id) +
         "\",\"name\":\"" + json_escape(p.name) +
         "\",\"role\":\"" + json_escape(p.role) +
         "\"," + nums +
         ",\"eta_utc\":" +
         (p.eta_utc ? ("\"" + helm::tides::FormatUtcIso8601(p.eta_utc) + "\"")
                    : std::string("null")) + "}";
}

static std::string tide_resolved_point_json(
    const helm::tides::TideResolvedPoint& p) {
  return "{\"point\":" + tide_resolve_point_json(p.point) +
         ",\"offline_ready\":" + (p.offline_ready ? "true" : "false") +
         ",\"provider_catalog_available\":" +
         (p.provider_catalog_available ? "true" : "false") +
         ",\"cache_status\":\"" + json_escape(p.cache_status) +
         "\",\"cache\":{\"harmonic_offline_available\":" +
         (p.harmonic_offline_available ? "true" : "false") +
         ",\"official_metadata_available\":" +
         (p.official_metadata_available ? "true" : "false") +
         ",\"official_prediction_cached\":" +
         (p.official_prediction_cached ? "true" : "false") +
         ",\"observed_feed_available\":" +
         (p.observed_feed_available ? "true" : "false") + "}" +
         ",\"official_prediction_cache\":" +
         (p.official_prediction_cached
              ? tide_official_prediction_cache_json(
                    p.official_prediction_cache)
              : std::string("null")) +
         ",\"official_prediction_request\":" +
         (p.official_prediction_request.ok
              ? tide_official_prediction_request_json(
                    p.official_prediction_request)
              : std::string("null")) +
         ",\"station\":" +
         (p.has_harmonic_station ? tide_station_json(p.harmonic_station)
                                 : std::string("null")) +
         ",\"official_reference\":" +
         (p.has_official_reference
              ? tide_official_reference_json(p.official_reference)
              : std::string("null")) +
         ",\"confidence\":" + tide_confidence_json(p.confidence) +
         ",\"provider_regions\":" +
         tide_provider_regions_json(p.provider_regions) +
         ",\"warnings\":" + string_array_json(p.warnings) + "}";
}

static std::string tide_resolution_json(
    const helm::tides::TideSourceResolution& r,
    const std::string& mode,
    const std::string& route_name,
    const std::string& source_policy,
    const std::vector<std::string>& request_warnings) {
  if (!r.ok) {
    std::vector<std::string> warnings = request_warnings;
    if (!r.error.empty()) warnings.push_back(r.error);
    return "{\"ok\":false,\"engine\":\"opencpn-tcmgr\",\"mode\":\"" +
           json_escape(mode) + "\",\"error\":\"" + json_escape(r.error) +
           "\",\"warnings\":" + string_array_json(warnings) + "}";
  }
  char nums[256];
  std::snprintf(nums, sizeof nums,
    "\"corridor_nm\":%.1f,\"min_confidence_score\":%.3f,"
    "\"max_harmonic_station_distance_nm\":%.6f,"
    "\"max_official_station_distance_nm\":%.6f",
    r.corridor_nm, r.min_confidence_score,
    r.max_harmonic_station_distance_nm,
    r.max_official_station_distance_nm);

  std::string warnings = "[";
  bool first_warning = true;
  auto add_warning = [&](const std::string& w) {
    if (!first_warning) warnings += ",";
    first_warning = false;
    warnings += "\"" + json_escape(w) + "\"";
  };
  for (const std::string& w : request_warnings) add_warning(w);
  for (const std::string& w : r.warnings) add_warning(w);
  warnings += "]";

  std::string sources = "[";
  for (size_t i = 0; i < r.loaded_sources.size(); ++i) {
    if (i) sources += ",";
    sources += tide_source_json(r.loaded_sources[i]);
  }
  sources += "]";

  std::string providers = tide_provider_regions_json(r.provider_regions);

  std::string points = "[";
  for (size_t i = 0; i < r.points.size(); ++i) {
    if (i) points += ",";
    points += tide_resolved_point_json(r.points[i]);
  }
  points += "]";

  return "{\"ok\":true,\"engine\":\"" + json_escape(r.engine) +
         "\",\"mode\":\"" + json_escape(mode) +
         "\",\"route_name\":\"" + json_escape(route_name) +
         "\",\"source_policy\":\"" + json_escape(source_policy) +
         "\",\"generated_utc\":\"" +
         helm::tides::FormatUtcIso8601(r.generated_utc) +
         "\"," + nums +
         ",\"offline_ready\":" + (r.offline_ready ? "true" : "false") +
         ",\"official_coverage_ready\":" +
         (r.official_coverage_ready ? "true" : "false") +
         ",\"needs_attention\":" +
         (r.needs_attention || !request_warnings.empty() ? "true" : "false") +
         ",\"confidence_tier\":\"" + json_escape(r.confidence_tier) +
         "\",\"summary\":\"" + json_escape(r.summary) +
         "\",\"cache_summary\":\"" + json_escape(r.cache_summary) +
         "\",\"warnings\":" + warnings +
         ",\"loaded_sources\":" + sources +
         ",\"provider_regions\":" + providers +
         ",\"points\":" + points + "}";
}

static std::mutex g_tide_mtx;  // TCMgr is OpenCPN-global state; keep HTTP workers out of each other.

static void tide_add_point(std::vector<helm::tides::TideResolvePoint>& points,
                           const std::string& id,
                           const std::string& name,
                           const std::string& role,
                           double lat,
                           double lon,
                           std::time_t eta_utc) {
  helm::tides::TideResolvePoint p;
  p.id = id;
  p.name = name;
  p.role = role;
  p.lat = lat;
  p.lon = lon;
  p.eta_utc = eta_utc;
  points.push_back(p);
}

static bool tide_parse_request_time(const std::string& text,
                                    std::time_t* utc) {
  if (text.size() == 10)
    return helm::tides::ParseUtcIso8601(text + "T00:00:00Z", utc);
  return helm::tides::ParseUtcIso8601(text, utc);
}

struct TideRequestContext {
  bool ok = true;
  bool all = false;
  std::time_t utc = 0;
  double corridor_nm = 25.0;
  std::string mode = "unresolved";
  std::string route_name;
  std::string source_policy = "redistributable-only";
  std::string error;
  std::vector<helm::tides::TideResolvePoint> points;
  std::vector<std::string> warnings;
};

static TideRequestContext tide_request_context(const std::string& uri) {
  TideRequestContext ctx;
  ctx.all = query_param(uri, "all") == "1";
  ctx.source_policy = ctx.all ? "all-local" : "redistributable-only";

  std::string iso = query_param(uri, "time");
  if (iso.empty()) iso = query_param(uri, "date");
  std::time_t utc = 0;
  if (iso.empty()) {
    utc = std::time(nullptr);
  } else if (!tide_parse_request_time(iso, &utc)) {
    ctx.ok = false;
    ctx.error = "bad UTC time; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ";
    return ctx;
  }
  ctx.utc = utc;
  ctx.corridor_nm = query_double_or(uri, "corridor_nm", 25.0);
  if (ctx.corridor_nm < 1.0) ctx.corridor_nm = 1.0;
  if (ctx.corridor_nm > 250.0) ctx.corridor_nm = 250.0;

  std::vector<std::string> mode_parts;

  const std::string lat_s = query_param(uri, "lat");
  const std::string lon_s = query_param(uri, "lon");
  if (!lat_s.empty() && !lon_s.empty()) {
    tide_add_point(ctx.points, "query-1", "Query position", "query",
                   query_double_or(uri, "lat", 0.0),
                   query_double_or(uri, "lon", 0.0), ctx.utc);
    mode_parts.push_back("query");
  }

  std::string raw_points = query_param(uri, "points");
  if (!raw_points.empty()) {
    std::replace(raw_points.begin(), raw_points.end(), '|', ';');
    std::stringstream ss(raw_points);
    std::string item;
    int n = 0;
    while (std::getline(ss, item, ';')) {
      if (item.empty()) continue;
      double lat = 0.0, lon = 0.0;
      if (std::sscanf(item.c_str(), "%lf,%lf", &lat, &lon) == 2) {
        char id[32]; std::snprintf(id, sizeof id, "point-%d", ++n);
        tide_add_point(ctx.points, id, id, "explicit", lat, lon, ctx.utc);
      } else {
        ctx.warnings.push_back("ignored malformed points entry: " + item);
      }
      if (n >= 128) {
        ctx.warnings.push_back("points list capped at 128 entries");
        break;
      }
    }
    if (n > 0) mode_parts.push_back("points");
  }

  std::string bbox = query_param(uri, "bbox");
  if (!bbox.empty()) {
    double w = 0.0, s = 0.0, e = 0.0, n = 0.0;
    if (std::sscanf(bbox.c_str(), "%lf,%lf,%lf,%lf", &w, &s, &e, &n) == 4) {
      tide_add_point(ctx.points, "bbox-center", "Viewport center", "viewport",
                     (s + n) / 2.0, (w + e) / 2.0, ctx.utc);
      tide_add_point(ctx.points, "bbox-sw", "Viewport SW", "viewport-corner",
                     s, w, ctx.utc);
      tide_add_point(ctx.points, "bbox-ne", "Viewport NE", "viewport-corner",
                     n, e, ctx.utc);
      mode_parts.push_back("viewport");
    } else {
      ctx.warnings.push_back("ignored malformed bbox; expected w,s,e,n");
    }
  }

  std::string route_mode = query_param(uri, "route");
  if (route_mode == "active" || route_mode == "1" || route_mode == "true") {
    std::vector<WP> route;
    { std::lock_guard<std::mutex> lk(g_route_mtx);
      route = ROUTE;
      ctx.route_name = g_route_name;
    }
    if (route.empty()) {
      ctx.warnings.push_back("route=active requested, but no active route is loaded");
    } else {
      for (size_t i = 0; i < route.size() && i < 128; ++i) {
        char id[32]; std::snprintf(id, sizeof id, "route-%zu", i + 1);
        tide_add_point(ctx.points, id,
                       route[i].name.empty() ? id : route[i].name,
                       "route-waypoint", route[i].lat, route[i].lon, ctx.utc);
      }
      if (route.size() > 128) ctx.warnings.push_back("active route capped at 128 waypoints");
      mode_parts.push_back("active-route");
    }
  }

  const bool want_gps = query_param(uri, "gps") == "1" ||
                        query_param(uri, "position") == "1";
  if (want_gps || ctx.points.empty()) {
    if (g_have_fix.load()) {
      tide_add_point(ctx.points, "gps", "Current GPS position", "gps",
                     gLat, gLon, ctx.utc);
      mode_parts.push_back("gps");
    } else if (want_gps || ctx.points.empty()) {
      ctx.warnings.push_back(
          "no fresh GPS fix available; pass lat/lon, points, bbox, or route=active");
    }
  }

  for (size_t i = 0; i < mode_parts.size(); ++i) {
    if (i) ctx.mode += "+";
    if (i == 0) ctx.mode.clear();
    ctx.mode += mode_parts[i];
  }
  if (ctx.mode.empty()) ctx.mode = "unresolved";
  return ctx;
}

static std::string tide_resolve_json(const std::string& uri) {
  std::lock_guard<std::mutex> lock(g_tide_mtx);
  TideRequestContext ctx = tide_request_context(uri);
  if (!ctx.ok)
    return "{\"ok\":false,\"error\":\"" + json_escape(ctx.error) + "\"}";

  const char* tcenv = std::getenv("HELM_TCDATA_DIR");
  std::string tcdata = tcenv && *tcenv ? tcenv : helm_runtime_path("tcdata");
  helm::tides::TideSourcePolicy policy =
      ctx.all ? helm::tides::TideSourcePolicy::kAllLocal
              : helm::tides::TideSourcePolicy::kRedistributableOnly;
  helm::tides::TideEngine engine;
  engine.SetOfficialPredictionCacheDir(tide_cache_dir());
  std::string error;
  if (!engine.LoadDefaultSources(tcdata, policy, &error))
    return "{\"ok\":false,\"mode\":\"" + json_escape(ctx.mode) +
           "\",\"error\":\"" + json_escape(error) +
           "\",\"warnings\":" + string_array_json(ctx.warnings) + "}";

  helm::tides::TideSourceResolution resolution =
      engine.ResolveSources(ctx.points, ctx.utc, ctx.corridor_nm);
  return tide_resolution_json(resolution, ctx.mode, ctx.route_name,
                              ctx.source_policy, ctx.warnings);
}

struct TideAcquisitionItem {
  helm::tides::OfficialPredictionRequest request;
  std::vector<helm::tides::TideResolvePoint> points;
  std::string schedule_status;
  std::string schedule_reason;
  int planned_count = 0;
  bool eligible_to_execute = false;
};

struct TideAcquisitionSummary {
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

struct TideSchedulerSummary {
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

struct TideAcquisitionPlan {
  bool ok = false;
  std::string error;
  TideRequestContext ctx;
  std::vector<helm::tides::TideResolvePoint> points;
  helm::tides::TideSourceResolution resolution;
  std::vector<TideAcquisitionItem> items;
  TideAcquisitionSummary summary;
  TideSchedulerSummary scheduler;
  bool has_scheduler = false;
  int lookahead_days = 1;
};

static std::string tide_acquisition_key(
    const helm::tides::OfficialPredictionRequest& request) {
  const std::string station =
      request.station_id.empty() ? "<station>" : request.station_id;
  return request.provider_region_id + "|" + station + "|" +
         request.date_utc + "|" + request.action;
}

static void tide_add_acquisition_summary(
    const helm::tides::OfficialPredictionRequest& request,
    TideAcquisitionSummary* summary) {
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

static std::vector<std::string> tide_split_tab_line(const std::string& line) {
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

static std::map<std::string, int> tide_read_scheduler_counts(
    const std::string& path) {
  std::map<std::string, int> counts;
  if (path.empty()) return counts;
  std::ifstream in(path);
  if (!in.good()) return counts;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] == '#') continue;
    std::vector<std::string> fields = tide_split_tab_line(line);
    if (fields.size() < 3) continue;
    char* end = nullptr;
    long count = std::strtol(fields[2].c_str(), &end, 10);
    if (end && *end == '\0') counts[fields[0]] = (int)count;
  }
  return counts;
}

static bool tide_write_scheduler_state(
    const std::string& path,
    const std::vector<TideAcquisitionItem>& items,
    const std::string& planned_utc,
    std::string* error) {
  std::ofstream out(path, std::ios::trunc);
  if (!out.good()) {
    if (error) *error = "could not write scheduler state: " + path;
    return false;
  }
  out << "# helm-server tides scheduler-state-v1\n";
  out << "# key\tstatus\tplanned_count\tlast_planned_utc\tprovider_region_id\tstation_id\tdate_utc\taction\n";
  for (const TideAcquisitionItem& item : items) {
    out << tide_acquisition_key(item.request) << "\t"
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

static bool tide_apply_scheduler_state(
    std::vector<TideAcquisitionItem>* items,
    const std::string& state_path,
    int max_live_fetches,
    std::time_t now_utc,
    TideSchedulerSummary* summary,
    std::string* error) {
  summary->state_path = state_path;
  summary->planned_utc = helm::tides::FormatUtcIso8601(now_utc);
  summary->max_live_fetches = max_live_fetches;
  std::map<std::string, int> prior_counts =
      tide_read_scheduler_counts(state_path);

  int live_fetches = 0;
  for (TideAcquisitionItem& item : *items) {
    const helm::tides::OfficialPredictionRequest& request = item.request;
    const std::string key = tide_acquisition_key(request);
    item.planned_count = prior_counts[key] + 1;
    item.eligible_to_execute = false;

    if (request.action == "use-cache") {
      item.schedule_status = "cached";
      item.schedule_reason =
          "official prediction cache already satisfies this request";
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
        item.schedule_reason =
            "provider live-fetch budget exhausted for this planning run";
        ++summary->deferred_rate_limit;
      }
    } else if (request.manual_import_required &&
               (request.action == "import-calendar" ||
                request.action == "refresh-calendar")) {
      item.schedule_status = "manual_import";
      item.schedule_reason =
          "official calendar publication requires manual import";
      ++summary->manual_import;
    } else {
      item.schedule_status = "manual_review";
      item.schedule_reason =
          request.status.empty() ? "request needs review" : request.status;
      ++summary->manual_review;
    }
  }

  if (!state_path.empty()) {
    if (!tide_write_scheduler_state(state_path, *items,
                                    summary->planned_utc, error)) {
      return false;
    }
    summary->state_written = true;
  }
  return true;
}

static std::vector<helm::tides::TideResolvePoint> tide_expand_points(
    const std::vector<helm::tides::TideResolvePoint>& points,
    int lookahead_days) {
  std::vector<helm::tides::TideResolvePoint> expanded;
  for (const helm::tides::TideResolvePoint& base_point : points) {
    for (int day = 0; day < lookahead_days; ++day) {
      helm::tides::TideResolvePoint point = base_point;
      point.eta_utc += static_cast<std::time_t>(day) * 86400;
      if (lookahead_days > 1) point.id += "+d" + std::to_string(day);
      expanded.push_back(point);
    }
  }
  return expanded;
}

static std::string tide_scheduler_json(const TideAcquisitionItem& item) {
  if (item.schedule_status.empty()) return "";
  return ",\"scheduler\":{\"status\":\"" +
         json_escape(item.schedule_status) +
         "\",\"reason\":\"" + json_escape(item.schedule_reason) +
         "\",\"eligible_to_execute\":" +
         (item.eligible_to_execute ? "true" : "false") +
         ",\"planned_count\":" + std::to_string(item.planned_count) + "}";
}

static TideAcquisitionPlan tide_build_acquisition_plan(
    const std::string& uri) {
  TideAcquisitionPlan plan;
  plan.ctx = tide_request_context(uri);
  if (!plan.ctx.ok) {
    plan.error = plan.ctx.error;
    return plan;
  }

  plan.lookahead_days = query_int_or(uri, "lookahead_days", 1);
  if (plan.lookahead_days < 1 || plan.lookahead_days > 14) {
    plan.error = "lookahead_days must be between 1 and 14";
    return plan;
  }
  plan.points = tide_expand_points(plan.ctx.points, plan.lookahead_days);

  const char* tcenv = std::getenv("HELM_TCDATA_DIR");
  std::string tcdata = tcenv && *tcenv ? tcenv : helm_runtime_path("tcdata");
  helm::tides::TideSourcePolicy policy =
      plan.ctx.all ? helm::tides::TideSourcePolicy::kAllLocal
                   : helm::tides::TideSourcePolicy::kRedistributableOnly;
  helm::tides::TideEngine engine;
  const std::string cache_dir = tide_cache_dir();
  engine.SetOfficialPredictionCacheDir(cache_dir);
  std::string error;
  if (!engine.LoadDefaultSources(tcdata, policy, &error)) {
    plan.error = error;
    return plan;
  }

  plan.resolution = engine.ResolveSources(plan.points, plan.ctx.utc,
                                          plan.ctx.corridor_nm);
  if (!plan.resolution.ok) {
    plan.error = plan.resolution.error;
    return plan;
  }

  std::map<std::string, TideAcquisitionItem> grouped;
  std::vector<std::string> order;
  for (const helm::tides::TideResolvedPoint& resolved :
       plan.resolution.points) {
    const helm::tides::OfficialPredictionRequest& request =
        resolved.official_prediction_request;
    if (!request.ok) {
      if (!resolved.point.id.empty()) {
        plan.ctx.warnings.push_back(
            "no official acquisition request for " + resolved.point.id);
      }
      continue;
    }
    const std::string key = tide_acquisition_key(request);
    auto it = grouped.find(key);
    if (it == grouped.end()) {
      TideAcquisitionItem item;
      item.request = request;
      item.points.push_back(resolved.point);
      grouped[key] = item;
      order.push_back(key);
    } else {
      it->second.points.push_back(resolved.point);
    }
  }

  for (const std::string& key : order) {
    plan.items.push_back(grouped[key]);
    tide_add_acquisition_summary(plan.items.back().request, &plan.summary);
  }

  const bool scheduler_requested =
      query_param(uri, "scheduler") == "1" ||
      query_param(uri, "state") == "1" ||
      !query_param(uri, "scheduler_state").empty();
  if (scheduler_requested) {
    int max_live_fetches = query_int_or(uri, "max_live_fetches", 4);
    if (max_live_fetches < 0) max_live_fetches = 0;
    if (max_live_fetches > 100) max_live_fetches = 100;
    std::time_t scheduler_now = std::time(nullptr);
    const std::string scheduler_now_text = query_param(uri, "scheduler_now");
    if (!scheduler_now_text.empty() &&
        !tide_parse_request_time(scheduler_now_text, &scheduler_now)) {
      plan.error =
          "bad scheduler_now; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ";
      return plan;
    }
    std::string scheduler_state = query_param(uri, "scheduler_state");
    if (scheduler_state.empty()) {
      ::mkdir(cache_dir.c_str(), 0700);
      scheduler_state = cache_dir + "/scheduler.tsv";
    }
    if (!tide_apply_scheduler_state(&plan.items, scheduler_state,
                                    max_live_fetches, scheduler_now,
                                    &plan.scheduler, &error)) {
      plan.error = error;
      return plan;
    }
    plan.has_scheduler = true;
  }

  plan.ok = true;
  return plan;
}

static std::string tide_acquisition_manifest_json(
    const helm::tides::TideSourceResolution& resolution,
    const TideRequestContext& ctx,
    const std::vector<helm::tides::TideResolvePoint>& points,
    const std::vector<TideAcquisitionItem>& items,
    const TideAcquisitionSummary& summary,
    const TideSchedulerSummary* scheduler,
    int lookahead_days) {
  std::string sched = "null";
  if (scheduler) {
    sched = "{\"state_path\":\"" + json_escape(scheduler->state_path) +
            "\",\"state_written\":" +
            (scheduler->state_written ? "true" : "false") +
            ",\"planned_utc\":\"" + json_escape(scheduler->planned_utc) +
            "\",\"max_live_fetches\":" +
            std::to_string(scheduler->max_live_fetches) +
            ",\"cached\":" + std::to_string(scheduler->cached) +
            ",\"pending_fetch\":" +
            std::to_string(scheduler->pending_fetch) +
            ",\"deferred_rate_limit\":" +
            std::to_string(scheduler->deferred_rate_limit) +
            ",\"manual_import\":" +
            std::to_string(scheduler->manual_import) +
            ",\"blocked\":" + std::to_string(scheduler->blocked) +
            ",\"manual_review\":" +
            std::to_string(scheduler->manual_review) + "}";
  }

  std::string warnings = "[";
  bool first_warning = true;
  auto add_warning = [&](const std::string& warning) {
    if (!first_warning) warnings += ",";
    first_warning = false;
    warnings += "\"" + json_escape(warning) + "\"";
  };
  for (const std::string& warning : ctx.warnings) add_warning(warning);
  for (const std::string& warning : resolution.warnings) add_warning(warning);
  warnings += "]";

  std::string items_json = "[";
  for (size_t i = 0; i < items.size(); ++i) {
    const TideAcquisitionItem& item = items[i];
    if (i) items_json += ",";
    items_json += "{\"point_count\":" + std::to_string(item.points.size()) +
                  ",\"request\":" +
                  tide_official_prediction_request_json(item.request) +
                  tide_scheduler_json(item) + ",\"points\":[";
    for (size_t j = 0; j < item.points.size(); ++j) {
      if (j) items_json += ",";
      items_json += tide_resolve_point_json(item.points[j]);
    }
    items_json += "]}";
  }
  items_json += "]";

  return "{\"ok\":true,\"engine\":\"" + json_escape(resolution.engine) +
         "\",\"mode\":\"acquisition-manifest\",\"request_mode\":\"" +
         json_escape(ctx.mode) +
         "\",\"route_name\":\"" + json_escape(ctx.route_name) +
         "\",\"source_policy\":\"" + json_escape(ctx.source_policy) +
         "\",\"generated_utc\":\"" +
         helm::tides::FormatUtcIso8601(resolution.generated_utc) +
         "\",\"dry_run\":true"
         ",\"scheduler_status\":\"planner-only; execute eligible requests separately through the explicit provider fetch path\""
         ",\"point_count\":" + std::to_string(points.size()) +
         ",\"lookahead_days\":" + std::to_string(lookahead_days) +
         ",\"item_count\":" + std::to_string(items.size()) +
         ",\"summary\":{\"use_cache\":" + std::to_string(summary.use_cache) +
         ",\"fetch_live\":" + std::to_string(summary.fetch_live) +
         ",\"refresh_live\":" + std::to_string(summary.refresh_live) +
         ",\"import_calendar\":" + std::to_string(summary.import_calendar) +
         ",\"refresh_calendar\":" +
         std::to_string(summary.refresh_calendar) +
         ",\"blocked\":" + std::to_string(summary.blocked) +
         ",\"auto_fetchable\":" +
         std::to_string(summary.auto_fetchable) +
         ",\"manual_import\":" + std::to_string(summary.manual_import) +
         ",\"needs_credentials\":" +
         std::to_string(summary.needs_credentials) +
         ",\"needs_work\":" + std::to_string(summary.needs_work) +
         "},\"scheduler\":" + sched +
         ",\"warnings\":" + warnings +
         ",\"items\":" + items_json + "}";
}

static std::string tide_acquisition_json(const std::string& uri) {
  std::lock_guard<std::mutex> lock(g_tide_mtx);
  TideAcquisitionPlan plan = tide_build_acquisition_plan(uri);
  if (!plan.ok) {
    if (!plan.resolution.ok && !plan.resolution.error.empty()) {
      return tide_resolution_json(plan.resolution, "acquisition-manifest",
                                  plan.ctx.route_name,
                                  plan.ctx.source_policy,
                                  plan.ctx.warnings);
    }
    return "{\"ok\":false,\"mode\":\"acquisition-manifest\",\"request_mode\":\"" +
           json_escape(plan.ctx.mode) + "\",\"error\":\"" +
           json_escape(plan.error) + "\",\"warnings\":" +
           string_array_json(plan.ctx.warnings) + "}";
  }

  return tide_acquisition_manifest_json(
      plan.resolution, plan.ctx, plan.points, plan.items, plan.summary,
      plan.has_scheduler ? &plan.scheduler : nullptr, plan.lookahead_days);
}

struct TideAcquisitionAutoStatus {
  bool enabled = false;
  bool running = false;
  bool last_ok = false;
  long run_count = 0;
  int interval_sec = 0;
  int lookahead_days = 0;
  int max_live_fetches = 0;
  int last_point_count = 0;
  int last_item_count = 0;
  int last_cached = 0;
  int last_pending_fetch = 0;
  int last_deferred_rate_limit = 0;
  int last_manual_import = 0;
  int last_blocked = 0;
  int last_manual_review = 0;
  int last_attempted = 0;
  int last_executed = 0;
  int last_failed = 0;
  std::string last_started_utc;
  std::string last_finished_utc;
  std::string last_error;
  std::string last_request_mode;
  std::string last_route_name;
  std::string scheduler_state_path;
  std::string last_cache_path;
  std::string last_data_path;
  std::vector<std::string> events;
};

static std::mutex g_tide_auto_mtx;
static TideAcquisitionAutoStatus g_tide_auto_status;

static bool tide_env_enabled(const char* name, bool fallback) {
  const char* value = std::getenv(name);
  if (!value || !*value) return fallback;
  return std::strcmp(value, "0") != 0 &&
         std::strcmp(value, "false") != 0 &&
         std::strcmp(value, "FALSE") != 0 &&
         std::strcmp(value, "off") != 0 &&
         std::strcmp(value, "OFF") != 0;
}

static int tide_env_int(const char* name, int fallback, int min_value,
                        int max_value) {
  const char* value = std::getenv(name);
  if (!value || !*value) return fallback;
  char* end = nullptr;
  long parsed = std::strtol(value, &end, 10);
  if (!end || *end != '\0') return fallback;
  if (parsed < min_value) parsed = min_value;
  if (parsed > max_value) parsed = max_value;
  return (int)parsed;
}

static bool tide_read_text_file(const std::string& path, std::string* body,
                                std::string* error) {
  std::ifstream in(path, std::ios::binary);
  if (!in.good()) {
    if (error) *error = "could not read tide fetch fixture: " + path;
    return false;
  }
  std::ostringstream ss;
  ss << in.rdbuf();
  *body = ss.str();
  return true;
}

static helm::tides::TideProviderRegion tide_provider_region_by_id(
    const std::string& id) {
  for (const helm::tides::TideProviderRegion& region :
       helm::tides::DefaultProviderRegions()) {
    if (region.id == id) return region;
  }
  return helm::tides::TideProviderRegion();
}

static helm::tides::OfficialTideReference tide_reference_for_request(
    const helm::tides::OfficialPredictionRequest& request) {
  for (helm::tides::OfficialTideReference ref :
       helm::tides::DefaultOfficialReferences()) {
    if (ref.provider_region_id == request.provider_region_id &&
        ref.station_id == request.station_id) {
      if (!request.station_name.empty()) ref.station_name = request.station_name;
      if (!request.datum_name.empty()) ref.datum_name = request.datum_name;
      return ref;
    }
  }

  helm::tides::TideProviderRegion region =
      tide_provider_region_by_id(request.provider_region_id);
  helm::tides::OfficialTideReference ref;
  ref.provider_region_id = request.provider_region_id;
  ref.provider = request.provider.empty() ? region.provider : request.provider;
  ref.product = region.product;
  ref.station_id = request.station_id;
  ref.station_name =
      request.station_name.empty() ? request.station_id : request.station_name;
  ref.country = region.country;
  ref.datum_name = request.datum_name.empty() ? region.datum_name :
                                                request.datum_name;
  if (ref.datum_name.empty()) ref.datum_name = "MLLW";
  ref.source_url = request.source_url.empty() ? region.source_url :
                                                request.source_url;
  ref.interpolation_method = "official station; no spatial interpolation";
  ref.official = region.official;
  ref.prediction_calendar = false;
  ref.observed_water_level_available = region.observations_available;
  return ref;
}

static bool tide_fetch_http_json(const std::string& url, std::string* body,
                                 std::string* error) {
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
    if (error) *error = "tide fetch returned no response";
    return false;
  }
  if (response->errorCode != ix::HttpErrorCode::Ok) {
    if (error) *error = "tide fetch failed: " + response->errorMsg;
    return false;
  }
  if (response->statusCode != 200) {
    if (error)
      *error = "tide fetch HTTP status " + std::to_string(response->statusCode);
    return false;
  }
  *body = response->body;
  return true;
}

static bool tide_execute_noaa_fetch(
    const helm::tides::OfficialPredictionRequest& request,
    const std::string& cache_dir,
    helm::tides::OfficialPredictionCacheInfo* cache,
    std::string* event,
    std::string* error) {
  std::time_t day_utc = 0;
  if (request.date_utc.empty() ||
      !helm::tides::ParseUtcIso8601(request.date_utc + "T00:00:00Z",
                                    &day_utc)) {
    if (error) *error = "NOAA request has no valid date_utc";
    return false;
  }

  helm::tides::OfficialTideReference reference =
      tide_reference_for_request(request);
  std::string source_url = request.fetch_url.empty()
                               ? helm::tides::NoaaCoopsPredictionUrl(
                                     reference, day_utc, 60)
                               : request.fetch_url;

  std::string body;
  if (const char* fixture = std::getenv("HELM_TIDES_NOAA_FIXTURE")) {
    if (*fixture && !tide_read_text_file(fixture, &body, error)) return false;
  }
  if (body.empty() && !tide_fetch_http_json(source_url, &body, error))
    return false;

  if (!helm::tides::WriteNoaaCoopsPredictionCache(
          reference, cache_dir, day_utc, body, source_url,
          helm::tides::FormatUtcIso8601(std::time(nullptr)), cache, error)) {
    return false;
  }

  if (event) {
    *event = "fetched NOAA CO-OPS " + request.station_id + " " +
             request.date_utc;
  }
  return true;
}

static void tide_auto_status_update(
    const TideAcquisitionAutoStatus& status) {
  std::lock_guard<std::mutex> lk(g_tide_auto_mtx);
  g_tide_auto_status = status;
}

static TideAcquisitionAutoStatus tide_auto_status_snapshot() {
  std::lock_guard<std::mutex> lk(g_tide_auto_mtx);
  return g_tide_auto_status;
}

static void tide_auto_run_once(int interval_sec, int lookahead_days,
                               int max_live_fetches,
                               const std::string& forced_date) {
  TideAcquisitionAutoStatus status = tide_auto_status_snapshot();
  status.enabled = true;
  status.running = true;
  status.interval_sec = interval_sec;
  status.lookahead_days = lookahead_days;
  status.max_live_fetches = max_live_fetches;
  status.run_count += 1;
  status.last_ok = false;
  status.last_error.clear();
  status.events.clear();
  status.last_started_utc = helm::tides::FormatUtcIso8601(std::time(nullptr));
  tide_auto_status_update(status);

  std::string uri = "/tides/acquisition?route=active&gps=1&scheduler=1";
  uri += "&lookahead_days=" + std::to_string(lookahead_days);
  uri += "&max_live_fetches=" + std::to_string(max_live_fetches);
  if (!forced_date.empty()) uri += "&date=" + forced_date;

  TideAcquisitionPlan plan;
  {
    std::lock_guard<std::mutex> lock(g_tide_mtx);
    plan = tide_build_acquisition_plan(uri);
  }

  status.running = false;
  status.last_finished_utc =
      helm::tides::FormatUtcIso8601(std::time(nullptr));
  status.last_point_count = (int)plan.points.size();
  status.last_item_count = (int)plan.items.size();
  status.last_request_mode = plan.ctx.mode;
  status.last_route_name = plan.ctx.route_name;
  status.last_cached = plan.scheduler.cached;
  status.last_pending_fetch = plan.scheduler.pending_fetch;
  status.last_deferred_rate_limit = plan.scheduler.deferred_rate_limit;
  status.last_manual_import = plan.scheduler.manual_import;
  status.last_blocked = plan.scheduler.blocked;
  status.last_manual_review = plan.scheduler.manual_review;
  status.scheduler_state_path = plan.scheduler.state_path;
  status.last_attempted = 0;
  status.last_executed = 0;
  status.last_failed = 0;
  status.last_cache_path.clear();
  status.last_data_path.clear();

  if (!plan.ok) {
    status.last_error =
        plan.error.empty() ? "tide acquisition planning did not produce a run" :
                             plan.error;
    status.events.push_back(status.last_error);
    tide_auto_status_update(status);
    std::fprintf(stderr, "tides acquisition: plan skipped (%s)\n",
                 status.last_error.c_str());
    return;
  }

  const std::string cache_dir = tide_cache_dir();
  for (const TideAcquisitionItem& item : plan.items) {
    const helm::tides::OfficialPredictionRequest& request = item.request;
    if (!item.eligible_to_execute ||
        item.schedule_status != "pending_fetch") {
      if (item.schedule_status == "blocked") {
        status.events.push_back("blocked " + request.provider_region_id +
                                " " + request.action + ": " +
                                request.status);
      }
      continue;
    }

    ++status.last_attempted;
    if (request.provider_region_id != "noaa-coops-us") {
      ++status.last_failed;
      status.events.push_back("manual execution required for " +
                              request.provider_region_id + " " +
                              request.action);
      continue;
    }

    helm::tides::OfficialPredictionCacheInfo cache;
    std::string event;
    std::string error;
    if (tide_execute_noaa_fetch(request, cache_dir, &cache, &event, &error)) {
      ++status.last_executed;
      status.last_cache_path = cache.cache_path;
      status.last_data_path = cache.data_path;
      status.events.push_back(event);
    } else {
      ++status.last_failed;
      status.last_error = error;
      status.events.push_back("NOAA fetch failed: " + error);
    }
  }

  status.last_ok = status.last_failed == 0;
  tide_auto_status_update(status);
  std::printf("tides acquisition: planned %d item(s), executed %d, failed %d\n",
              status.last_item_count, status.last_executed,
              status.last_failed);
}

static std::string tide_auto_status_json() {
  TideAcquisitionAutoStatus s = tide_auto_status_snapshot();
  std::string events = "[";
  for (size_t i = 0; i < s.events.size(); ++i) {
    if (i) events += ",";
    events += "\"" + json_escape(s.events[i]) + "\"";
  }
  events += "]";

  return "{\"ok\":true,\"enabled\":" + std::string(s.enabled ? "true" : "false") +
         ",\"running\":" + (s.running ? "true" : "false") +
         ",\"last_ok\":" + (s.last_ok ? "true" : "false") +
         ",\"run_count\":" + std::to_string(s.run_count) +
         ",\"interval_sec\":" + std::to_string(s.interval_sec) +
         ",\"lookahead_days\":" + std::to_string(s.lookahead_days) +
         ",\"max_live_fetches\":" + std::to_string(s.max_live_fetches) +
         ",\"last_started_utc\":\"" + json_escape(s.last_started_utc) +
         "\",\"last_finished_utc\":\"" + json_escape(s.last_finished_utc) +
         "\",\"last_error\":\"" + json_escape(s.last_error) +
         "\",\"request_mode\":\"" + json_escape(s.last_request_mode) +
         "\",\"route_name\":\"" + json_escape(s.last_route_name) +
         "\",\"scheduler_state_path\":\"" +
         json_escape(s.scheduler_state_path) +
         "\",\"last_cache_path\":\"" + json_escape(s.last_cache_path) +
         "\",\"last_data_path\":\"" + json_escape(s.last_data_path) +
         "\",\"last_point_count\":" + std::to_string(s.last_point_count) +
         ",\"last_item_count\":" + std::to_string(s.last_item_count) +
         ",\"last_cached\":" + std::to_string(s.last_cached) +
         ",\"last_pending_fetch\":" +
         std::to_string(s.last_pending_fetch) +
         ",\"last_deferred_rate_limit\":" +
         std::to_string(s.last_deferred_rate_limit) +
         ",\"last_manual_import\":" +
         std::to_string(s.last_manual_import) +
         ",\"last_blocked\":" + std::to_string(s.last_blocked) +
         ",\"last_manual_review\":" +
         std::to_string(s.last_manual_review) +
         ",\"last_attempted\":" + std::to_string(s.last_attempted) +
         ",\"last_executed\":" + std::to_string(s.last_executed) +
         ",\"last_failed\":" + std::to_string(s.last_failed) +
         ",\"events\":" + events + "}";
}

static void tide_acquisition_loop() {
  // OFFLINE-FIRST: the boat server must NEVER auto-reach the internet unless the operator
  // explicitly opts in. Default OFF; set HELM_TIDES_ACQUISITION=1 only on a networked shore
  // machine. (The out-of-band helm-tides-fetch CLI is the preferred place to populate the cache.)
  const bool enabled = tide_env_enabled("HELM_TIDES_ACQUISITION", false);
  const int interval_sec =
      tide_env_int("HELM_TIDES_ACQUISITION_INTERVAL_SEC", 900, 1, 86400);
  const int lookahead_days =
      tide_env_int("HELM_TIDES_LOOKAHEAD_DAYS", 3, 1, 14);
  const int max_live_fetches =
      tide_env_int("HELM_TIDES_MAX_LIVE_FETCHES", 2, 0, 100);
  const char* date_env = std::getenv("HELM_TIDES_ACQUISITION_DATE");
  const std::string forced_date = date_env && *date_env ? date_env : "";

  TideAcquisitionAutoStatus status = tide_auto_status_snapshot();
  status.enabled = enabled;
  status.interval_sec = interval_sec;
  status.lookahead_days = lookahead_days;
  status.max_live_fetches = max_live_fetches;
  tide_auto_status_update(status);

  if (!enabled) {
    std::printf("tides acquisition: background runner disabled — offline-first default; set HELM_TIDES_ACQUISITION=1 (networked shore machine only) to enable\n");
    return;
  }

  std::printf("tides acquisition: background runner enabled (lookahead=%d day(s), max_live_fetches=%d, interval=%ds)\n",
              lookahead_days, max_live_fetches, interval_sec);
  std::this_thread::sleep_for(std::chrono::seconds(2));
  for (;;) {
    tide_auto_run_once(interval_sec, lookahead_days, max_live_fetches,
                       forced_date);
    std::this_thread::sleep_for(std::chrono::seconds(interval_sec));
  }
}

static std::string tide_providers_json(const std::string& uri) {
  helm::tides::TideEngine engine;
  std::vector<helm::tides::TideProviderRegion> providers;
  std::vector<std::string> warnings;
  std::string mode = "catalog";

  const std::string lat_s = query_param(uri, "lat");
  const std::string lon_s = query_param(uri, "lon");
  if (!lat_s.empty() && !lon_s.empty()) {
    const double lat = query_double_or(uri, "lat", 0.0);
    const double lon = query_double_or(uri, "lon", 0.0);
    providers = engine.ProviderRegionsForPoint(lat, lon);
    mode = "point";
    if (providers.empty())
      warnings.push_back("no provider region catalog entry covers this point");
  } else {
    providers = engine.ProviderRegions();
  }

  std::ostringstream body;
  body << "{\"ok\":true,\"engine\":\"opencpn-tcmgr\",\"mode\":\""
       << json_escape(mode) << "\",\"count\":" << providers.size()
       << ",\"warnings\":" << string_array_json(warnings)
       << ",\"providers\":" << tide_provider_regions_json(providers) << "}";
  return body.str();
}

static std::string tide_current_observed_json(
    const helm::tides::CurrentObservationComponent& c) {
  std::ostringstream out;
  out << "{\"available\":" << (c.available ? "true" : "false")
      << ",\"applied\":" << (c.applied ? "true" : "false")
      << ",\"source\":\"" << json_escape(c.source) << "\""
      << ",\"status\":\"" << json_escape(c.status) << "\""
      << ",\"valid_time_utc\":";
  if (c.valid_time_utc.empty()) {
    out << "null";
  } else {
    out << "\"" << json_escape(c.valid_time_utc) << "\"";
  }
  out << ",\"speed_kn\":";
  if (c.available) {
    out << c.speed_kn;
  } else {
    out << "null";
  }
  out << ",\"direction_deg\":";
  if (c.available && c.has_direction) {
    out << c.direction_deg;
  } else {
    out << "null";
  }
  out << ",\"has_direction\":" << (c.has_direction ? "true" : "false")
      << "}";
  return out.str();
}

static std::string tide_current_residual_factor_json(
    const helm::tides::CurrentResidualFactor& f) {
  return "{\"name\":\"" + json_escape(f.name) +
         "\",\"source\":\"" + json_escape(f.source) +
         "\",\"status\":\"" + json_escape(f.status) +
         "\",\"available\":" + (f.available ? "true" : "false") +
         ",\"applied\":" + (f.applied ? "true" : "false") + "}";
}

static std::string tide_current_condition_json(
    const helm::tides::TideCurrentCondition& c,
    const std::string& source_policy) {
  std::string residuals = "[";
  for (size_t i = 0; i < c.residual_factors.size(); ++i) {
    if (i) residuals += ",";
    residuals += tide_current_residual_factor_json(c.residual_factors[i]);
  }
  residuals += "]";

  std::ostringstream nums;
  nums << "\"lat\":" << c.lat
       << ",\"lon\":" << c.lon
       << ",\"speed_kn\":";
  if (c.theoretical_available) {
    nums << c.speed_kn;
  } else {
    nums << "null";
  }
  nums << ",\"signed_speed_kn\":";
  if (c.theoretical_available) {
    nums << c.signed_speed_kn;
  } else {
    nums << "null";
  }
  nums << ",\"direction_deg\":";
  if (c.theoretical_available && c.has_direction) {
    nums << c.direction_deg;
  } else {
    nums << "null";
  }

  const std::string station =
      c.station.index >= 0 ? tide_station_json(c.station) : "null";
  return "{\"ok\":" + std::string(c.ok ? "true" : "false") +
         ",\"engine\":\"" + json_escape(c.engine) +
         "\",\"mode\":\"current-condition\",\"source_policy\":\"" +
         json_escape(source_policy) +
         "\",\"valid_time_utc\":\"" +
         helm::tides::FormatUtcIso8601(c.time_utc) + "\"," + nums.str() +
         ",\"unit\":\"knots\""
         ",\"theoretical\":{\"available\":" +
         std::string(c.theoretical_available ? "true" : "false") +
         ",\"applied\":" +
         std::string(c.theoretical_applied ? "true" : "false") +
         ",\"source\":\"opencpn-harmonic-current\""
         ",\"speed_kn\":" +
         (c.theoretical_available ? std::to_string(c.speed_kn) : "null") +
         ",\"signed_speed_kn\":" +
         (c.theoretical_available ? std::to_string(c.signed_speed_kn) : "null") +
         ",\"direction_deg\":" +
         (c.theoretical_available && c.has_direction
              ? std::to_string(c.direction_deg)
              : "null") +
         ",\"has_direction\":" +
         std::string(c.has_direction ? "true" : "false") +
         ",\"station\":" + station +
         "},\"observed\":" + tide_current_observed_json(c.observed) +
         ",\"residual\":{\"available\":false,\"applied\":false"
         ",\"status\":\"wind/swell/lagoon-fill/ocean-current/pressure residuals not yet applied\""
         ",\"factors\":" + residuals + "}"
         ",\"station\":" + station +
         ",\"provider_regions\":" +
         tide_provider_regions_json(c.provider_regions) +
         ",\"confidence\":" + tide_confidence_json(c.confidence) +
         ",\"warnings\":" + string_array_json(c.warnings) +
         (c.error.empty() ? "" :
                            (",\"error\":\"" + json_escape(c.error) + "\"")) +
         "}";
}

static std::string tide_currents_json(const std::string& uri) {
  std::lock_guard<std::mutex> lock(g_tide_mtx);
  const bool all = query_param(uri, "all") == "1";
  const double lat = query_double_or(uri, "lat", all ? 50.4075 : 21.3069);
  const double lon = query_double_or(uri, "lon", all ? -125.8509 : -157.8583);
  std::string iso = query_param(uri, "time");
  std::time_t utc = 0;
  if (iso.empty()) {
    utc = std::time(nullptr);
  } else if (!helm::tides::ParseUtcIso8601(iso, &utc)) {
    return "{\"ok\":false,\"mode\":\"current-condition\",\"error\":\"bad UTC time; use YYYY-MM-DDTHH:MM:SSZ\"}";
  }

  const char* tcenv = std::getenv("HELM_TCDATA_DIR");
  std::string tcdata = tcenv && *tcenv ? tcenv : helm_runtime_path("tcdata");
  helm::tides::TideSourcePolicy policy =
      all ? helm::tides::TideSourcePolicy::kAllLocal
          : helm::tides::TideSourcePolicy::kRedistributableOnly;
  helm::tides::TideEngine engine;
  std::string error;
  if (!engine.LoadDefaultSources(tcdata, policy, &error)) {
    return "{\"ok\":false,\"mode\":\"current-condition\",\"error\":\"" +
           json_escape(error) + "\"}";
  }

  helm::tides::TideCurrentCondition current =
      engine.CurrentCondition(lat, lon, utc);
  return tide_current_condition_json(
      current, all ? "all-local" : "redistributable-only");
}

static std::string tide_summary_json(const std::string& uri) {
  std::lock_guard<std::mutex> lock(g_tide_mtx);
  const bool all = query_param(uri, "all") == "1";
  const double lat = query_double_or(uri, "lat", all ? -18.1248 : 21.3069);
  const double lon = query_double_or(uri, "lon", all ? 178.4501 : -157.8583);
  std::string iso = query_param(uri, "time");
  std::time_t utc = 0;
  if (iso.empty()) {
    utc = std::time(nullptr);
    iso = helm::tides::FormatUtcIso8601(utc);
  } else if (!helm::tides::ParseUtcIso8601(iso, &utc)) {
    return "{\"ok\":false,\"error\":\"bad UTC time; use YYYY-MM-DDTHH:MM:SSZ\"}";
  }

  const char* tcenv = std::getenv("HELM_TCDATA_DIR");
  std::string tcdata = tcenv && *tcenv ? tcenv : helm_runtime_path("tcdata");
  helm::tides::TideSourcePolicy policy =
      all ? helm::tides::TideSourcePolicy::kAllLocal
          : helm::tides::TideSourcePolicy::kRedistributableOnly;
  helm::tides::TideEngine engine;
  std::string error;
  if (!engine.LoadDefaultSources(tcdata, policy, &error))
    return "{\"ok\":false,\"error\":\"" + json_escape(error) + "\"}";

  helm::tides::TidePrediction p = engine.PredictNearest(lat, lon, utc);
  if (!p.ok) return "{\"ok\":false,\"error\":\"" + json_escape(p.error) + "\"}";
  helm::tides::TideEvent next = engine.NextHighLowEvent(p.station.index, utc);

  char nums[256];
  std::snprintf(nums, sizeof nums,
    "\"lat\":%.6f,\"lon\":%.6f,\"value_m\":%.6f,\"has_direction\":%s",
    lat, lon, p.value_m, p.has_direction ? "true" : "false");

  std::string sources = "[";
  std::vector<helm::tides::TideSourceInfo> loaded = engine.LoadedSources();
  for (size_t i = 0; i < loaded.size(); ++i) {
    if (i) sources += ",";
    sources += tide_source_json(loaded[i]);
  }
  sources += "]";

  return "{\"ok\":true,\"engine\":\"opencpn-tcmgr\",\"source_policy\":\"" +
         std::string(all ? "all-local" : "redistributable-only") +
         "\",\"time_utc\":\"" + helm::tides::FormatUtcIso8601(utc) +
         "\"," + nums +
         ",\"direction_deg\":" +
         (p.has_direction ? std::to_string(p.direction_deg) : "null") +
         ",\"station\":" + tide_station_json(p.station) +
         ",\"loaded_sources\":" + sources +
         ",\"confidence\":" + tide_confidence_json(p.confidence) +
         ",\"next_event\":" + tide_event_json(next) + "}";
}

// TIDES (UI spec): the whole 24h curve in ONE request — load the engine + resolve the station once,
// then Predict() each sample + walk the high/low events in-window, all under the single tide lock.
// Replaces the dashboard's N serial /tides/summary round-trips (each of which reloaded the engine).
static std::string tide_curve_json(const std::string& uri) {
  std::lock_guard<std::mutex> lock(g_tide_mtx);
  const bool all = query_param(uri, "all") == "1";
  const double lat = query_double_or(uri, "lat", all ? -18.1248 : 21.3069);
  const double lon = query_double_or(uri, "lon", all ? 178.4501 : -157.8583);
  std::string iso = query_param(uri, "start");
  std::time_t start = 0;
  if (iso.empty()) start = std::time(nullptr);
  else if (!helm::tides::ParseUtcIso8601(iso, &start)) return "{\"ok\":false,\"error\":\"bad start time; use YYYY-MM-DDTHH:MM:SSZ\"}";
  double hours = query_double_or(uri, "hours", 24.0); if (hours < 1) hours = 1; if (hours > 96) hours = 96;
  double stepmin = query_double_or(uri, "step", 30.0); if (stepmin < 10) stepmin = 10;
  const std::time_t step_s = (std::time_t)(stepmin * 60.0);
  const std::time_t end = start + (std::time_t)(hours * 3600.0);
  const char* tcenv = std::getenv("HELM_TCDATA_DIR");
  std::string tcdata = tcenv && *tcenv ? tcenv : helm_runtime_path("tcdata");
  helm::tides::TideSourcePolicy policy = all ? helm::tides::TideSourcePolicy::kAllLocal : helm::tides::TideSourcePolicy::kRedistributableOnly;
  helm::tides::TideEngine engine;
  std::string error;
  if (!engine.LoadDefaultSources(tcdata, policy, &error)) return "{\"ok\":false,\"error\":\"" + json_escape(error) + "\"}";
  helm::tides::TidePrediction p0 = engine.PredictNearest(lat, lon, start);
  if (!p0.ok) return "{\"ok\":false,\"error\":\"" + json_escape(p0.error) + "\"}";
  const int idx = p0.station.index;
  std::string samples = "["; bool sf = true;
  for (std::time_t t = start; t <= end; t += step_s) {
    helm::tides::TidePrediction p = engine.Predict(idx, t);
    if (!p.ok) continue;
    char b[112]; std::snprintf(b, sizeof b, "{\"t_utc\":\"%s\",\"value_m\":%.6f}", helm::tides::FormatUtcIso8601(t).c_str(), p.value_m);
    if (!sf) samples += ","; sf = false; samples += b;
  }
  samples += "]";
  std::string events = "["; bool ef = true; std::time_t cursor = start;
  for (int guard = 0; guard < 64; ++guard) {
    helm::tides::TideEvent ev = engine.NextHighLowEvent(idx, cursor);
    if (!ev.ok || ev.event_utc > end) break;
    char b[176]; std::snprintf(b, sizeof b, "{\"kind\":\"%s\",\"event_utc\":\"%s\",\"value_m\":%.6f}", ev.kind.c_str(), helm::tides::FormatUtcIso8601(ev.event_utc).c_str(), ev.value_m);
    if (!ef) events += ","; ef = false; events += b;
    cursor = ev.event_utc + 60;
  }
  events += "]";
  char meta[96]; std::snprintf(meta, sizeof meta, "\"step_min\":%.0f,\"datum_m\":%.6f", stepmin, p0.station.datum_m);
  return "{\"ok\":true,\"engine\":\"opencpn-tcmgr\",\"source_policy\":\"" + std::string(all ? "all-local" : "redistributable-only") +
         "\",\"start_utc\":\"" + helm::tides::FormatUtcIso8601(start) + "\"," + std::string(meta) +
         ",\"unit\":\"meters\",\"station\":" + tide_station_json(p0.station) +
         ",\"samples\":" + samples + ",\"events\":" + events + "}";
}

// TIDES (UI spec): enumerate usable TIDE stations in a bbox as GeoJSON, for the chart-marker layer.
// The C++ engine has Stations(); this is the first HTTP exposure of it.
static std::string tide_stations_json(const std::string& uri) {
  std::lock_guard<std::mutex> lock(g_tide_mtx);
  const bool all = query_param(uri, "all") == "1";
  std::string bbox = query_param(uri, "bbox");
  double w = -180, s = -90, e = 180, n = 90; bool have_bbox = false;
  if (!bbox.empty() && std::sscanf(bbox.c_str(), "%lf,%lf,%lf,%lf", &w, &s, &e, &n) == 4) have_bbox = true;
  int limit = (int)query_double_or(uri, "limit", 200.0); if (limit < 1) limit = 1; if (limit > 1000) limit = 1000;
  const char* tcenv = std::getenv("HELM_TCDATA_DIR");
  std::string tcdata = tcenv && *tcenv ? tcenv : helm_runtime_path("tcdata");
  helm::tides::TideSourcePolicy policy = all ? helm::tides::TideSourcePolicy::kAllLocal : helm::tides::TideSourcePolicy::kRedistributableOnly;
  helm::tides::TideEngine engine;
  std::string error;
  if (!engine.LoadDefaultSources(tcdata, policy, &error)) return "{\"type\":\"FeatureCollection\",\"error\":\"" + json_escape(error) + "\",\"features\":[]}";
  std::vector<helm::tides::TideStation> stations = engine.Stations();
  std::string feats = "["; bool first = true; int count = 0;
  for (const auto& st : stations) {
    if (!st.is_tide() || !st.usable) continue;
    if (have_bbox && (st.lon < w || st.lon > e || st.lat < s || st.lat > n)) continue;
    if (count >= limit) break;
    ++count;
    char geo[80]; std::snprintf(geo, sizeof geo, "[%.6f,%.6f]", st.lon, st.lat);
    char pr[224]; std::snprintf(pr, sizeof pr,
      "\"index\":%d,\"type\":\"%c\",\"datum_m\":%.6f,\"has_datum\":%s,\"source_redistribution_cleared\":%s,\"source_enabled_by_default\":%s",
      st.index, st.type, st.datum_m, st.has_datum ? "true" : "false",
      st.source_redistribution_cleared ? "true" : "false", st.source_enabled_by_default ? "true" : "false");
    if (!first) feats += ","; first = false;
    feats += "{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":" + std::string(geo) +
             "},\"properties\":{\"name\":\"" + json_escape(st.name) + "\",\"source_license\":\"" + json_escape(st.source_license) + "\"," + std::string(pr) + "}}";
  }
  feats += "]";
  return "{\"type\":\"FeatureCollection\",\"source_policy\":\"" + std::string(all ? "all-local" : "redistributable-only") +
         "\",\"count\":" + std::to_string(count) + ",\"features\":" + feats + "}";
}

// CHART-10: S-57 object query at a tapped point. Runs ONLY from the main-thread job loop (it touches
// g_chart/ps52plib, exactly like render_tile), so it is invoked via a Job{kind=Query}, never directly
// from an HTTP worker thread. Returns a JSON array of the picked features (acronym / class / geometry /
// decoded attributes / plain-language lines), built from the structured S57 attribute walk — NOT the
// GUI HTML report (which merges LIGHTS and needs private chart members).
static const char* geo_str(GeoPrim_t t) { return t == GEO_POINT ? "point" : (t == GEO_LINE ? "line" : (t == GEO_AREA ? "area" : "")); }
static TileStatus run_query(double lat, double lon, int zhint, int radius_px,
                            ColorScheme palette, DisCat cat, std::string& out) {
  if (!g_chart) { out = "[]"; return TileStatus::Ok; }
  if (lon < g_ext.WLON || lon > g_ext.ELON || lat < g_ext.SLAT || lat > g_ext.NLAT) { out = "[]"; return TileStatus::Ok; }
  apply_palette(palette); apply_category(cat);              // visibility parity with the tiles (main-thread only)
  double ppm;                                               // pixels/metre — from the zoom hint if given, else the cell span
  if (zhint > 0) {
    double n = std::pow(2.0, zhint);
    double yt = std::floor((1.0 - std::log(std::tan(lat * M_PI / 180.0) + 1.0 / std::cos(lat * M_PI / 180.0)) / M_PI) / 2.0 * n);
    double span_m = (tile_lat(yt, zhint) - tile_lat(yt + 1, zhint)) * 1852.0 * 60.0;
    ppm = span_m > 0 ? (double)TS / span_m : 1.0;
  } else {
    double span_m = (g_ext.NLAT - g_ext.SLAT) * 1852.0 * 60.0;
    ppm = span_m > 0 ? (double)TS / span_m : 1.0;
  }
  ViewPort vp;
  vp.clat = lat; vp.clon = lon; vp.view_scale_ppm = ppm;
  vp.pix_width = TS; vp.pix_height = TS; vp.rotation = 0; vp.skew = 0; vp.tilt = 0;
  vp.m_projection_type = PROJECTION_MERCATOR;
  vp.chart_scale = g_chart->GetNativeScale(); vp.ref_scale = vp.chart_scale;
  vp.b_quilt = false; vp.rv_rect = wxRect(0, 0, TS, TS); vp.SetBoxes(); vp.Validate();
  float sel_deg = (float)(radius_px / (vp.view_scale_ppm * 1852.0 * 60.0));
  ListOfObjRazRules* rl = g_chart->GetObjRuleListAtLatLon((float)lat, (float)lon, sel_deg, &vp, MASK_ALL);
  std::string arr = "[";
  if (rl) {
    const std::string ocPath = std::string(g_csv_locn.mb_str()) + "/s57objectclasses.csv";
    bool first = true; int emitted = 0;
    for (ListOfObjRazRules::Node* node = rl->GetLast(); node && emitted < 100; node = node->GetPrevious()) {
      ObjRazRules* cur = node->GetData(); if (!cur || !cur->obj) continue;
      S57Obj* o = cur->obj;
      if (o->Primitive_type == GEO_META || o->Primitive_type == GEO_PRIM) continue;       // not real features
      if (cur->LUP && std::strncmp(cur->LUP->OBCL, "SOUND", 5) == 0) continue;             // soundings: separate path
      std::string acr(o->FeatureName);
      const char* cd = MyCSVGetField(ocPath.c_str(), "Acronym", acr.c_str(), CC_ExactString, "ObjectClass");
      const char* cc = MyCSVGetField(ocPath.c_str(), "Acronym", acr.c_str(), CC_ExactString, "Code");
      std::string class_desc = (cd && *cd) ? cd : acr;
      int objl = (cc && *cc) ? std::atoi(cc) : -1;
      if (!first) arr += ","; first = false; ++emitted;
      arr += "{\"objl_code\":" + std::to_string(objl) + ",\"acronym\":\"" + json_escape(acr) +
             "\",\"class_desc\":\"" + json_escape(class_desc) + "\",\"geometry\":\"" + geo_str(o->Primitive_type) + "\"";
      std::string attrs = ",\"attributes\":{";
      std::string plain = ",\"plain_language\":[\"" + json_escape(class_desc + " (" + acr + ")") + "\"";
      bool af = true; char* ca = o->att_array;
      for (int i = 0; o->att_array && i < o->n_attr; ++i, ca += 6) {
        wxString an = wxString(ca, wxConvUTF8, 6); an.Trim();
        std::string ak = std::string(an.ToUTF8());
        std::string av = std::string(g_chart->GetObjectAttributeValueAsString(o, i, an).ToUTF8());
        if (!af) attrs += ","; af = false;
        attrs += "\"" + json_escape(ak) + "\":{\"decoded\":\"" + json_escape(av) + "\"}";
        plain += ",\"" + json_escape(ak + ": " + av) + "\"";
      }
      arr += attrs + "}" + plain + "]}";
    }
    rl->Clear(); delete rl;
  }
  arr += "]";
  out.swap(arr);
  return TileStatus::Ok;
}

static bool read_file(const char* path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return true;
}

// REPO-4: Helm consumes the shared renderer as an adapter boundary. The code
// below owns only HTTP/runtime policy: feature flag selection, render command
// invocation, cache keys, ETags, and diagnostics. Renderer semantics stay in
// the OpenCPN-shaped renderer command stream/offscreen renderer.
class TileSha256 {
 public:
  TileSha256() {
    h_[0] = 0x6a09e667u; h_[1] = 0xbb67ae85u; h_[2] = 0x3c6ef372u; h_[3] = 0xa54ff53au;
    h_[4] = 0x510e527fu; h_[5] = 0x9b05688cu; h_[6] = 0x1f83d9abu; h_[7] = 0x5be0cd19u;
  }
  void update(const unsigned char* data, std::size_t len) {
    bit_len_ += static_cast<std::uint64_t>(len) * 8u;
    for (std::size_t i = 0; i < len; ++i) {
      buffer_[buffer_len_++] = data[i];
      if (buffer_len_ == 64) { transform(buffer_.data()); buffer_len_ = 0; }
    }
  }
  void update(const std::string& data) {
    update(reinterpret_cast<const unsigned char*>(data.data()), data.size());
  }
  std::string hex_digest() {
    const std::uint64_t input_bits = bit_len_;
    buffer_[buffer_len_++] = 0x80u;
    if (buffer_len_ > 56) {
      while (buffer_len_ < 64) buffer_[buffer_len_++] = 0;
      transform(buffer_.data());
      buffer_len_ = 0;
    }
    while (buffer_len_ < 56) buffer_[buffer_len_++] = 0;
    for (int i = 7; i >= 0; --i)
      buffer_[buffer_len_++] = static_cast<unsigned char>((input_bits >> (i * 8)) & 0xffu);
    transform(buffer_.data());
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (std::uint32_t word : h_) out << std::setw(8) << word;
    return out.str();
  }

 private:
  static std::uint32_t rotr(std::uint32_t v, std::uint32_t n) { return (v >> n) | (v << (32 - n)); }
  static std::uint32_t ch(std::uint32_t x, std::uint32_t y, std::uint32_t z) { return (x & y) ^ (~x & z); }
  static std::uint32_t maj(std::uint32_t x, std::uint32_t y, std::uint32_t z) { return (x & y) ^ (x & z) ^ (y & z); }
  static std::uint32_t big0(std::uint32_t x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
  static std::uint32_t big1(std::uint32_t x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
  static std::uint32_t small0(std::uint32_t x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3); }
  static std::uint32_t small1(std::uint32_t x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10); }
  void transform(const unsigned char block[64]) {
    static const std::uint32_t k[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
      0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
      0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
      0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
      0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
      0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
      0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
      0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
      0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
      0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
      0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u };
    std::uint32_t w[64];
    for (std::size_t i = 0; i < 16; ++i)
      w[i] = (static_cast<std::uint32_t>(block[i * 4]) << 24) |
             (static_cast<std::uint32_t>(block[i * 4 + 1]) << 16) |
             (static_cast<std::uint32_t>(block[i * 4 + 2]) << 8) |
             static_cast<std::uint32_t>(block[i * 4 + 3]);
    for (std::size_t i = 16; i < 64; ++i) w[i] = small1(w[i - 2]) + w[i - 7] + small0(w[i - 15]) + w[i - 16];
    std::uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], hh = h_[7];
    for (std::size_t i = 0; i < 64; ++i) {
      const std::uint32_t t1 = hh + big1(e) + ch(e, f, g) + k[i] + w[i];
      const std::uint32_t t2 = big0(a) + maj(a, b, c);
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d; h_[4] += e; h_[5] += f; h_[6] += g; h_[7] += hh;
  }
  std::array<std::uint32_t, 8> h_{};
  std::array<unsigned char, 64> buffer_{};
  std::uint64_t bit_len_ = 0;
  std::size_t buffer_len_ = 0;
};

static std::string sha256_hex(const std::string& data) {
  TileSha256 sha;
  sha.update(data);
  return sha.hex_digest();
}

static std::string lower_ascii(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

static bool env_true(const char* name, bool fallback = false) {
  const char* value = std::getenv(name);
  if (!value || !*value) return fallback;
  std::string v = lower_ascii(value);
  return v == "1" || v == "true" || v == "yes" || v == "on";
}

static std::string env_or(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

static std::string shell_quote(const std::string& s) {
  std::string out = "'";
  for (char c : s) out += c == '\'' ? "'\\''" : std::string(1, c);
  out += "'";
  return out;
}

static std::string header_safe(std::string s) {
  for (char& c : s) if (c == '\r' || c == '\n' || static_cast<unsigned char>(c) < 0x20) c = ' ';
  if (s.size() > 180) s.resize(180);
  return s;
}

static bool png_signature_ok(const std::string& bytes) {
  static const unsigned char sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  return bytes.size() >= sizeof(sig) &&
         std::memcmp(bytes.data(), sig, sizeof(sig)) == 0;
}

enum class ChartRendererChoice { Legacy, Vulkan };

struct VulkanTileMeta {
  std::string renderer_branch;
  std::string renderer_sha;
  std::string scene_schema;
  std::string chart_epoch;
  std::string palette;
  std::string category;
  std::string bbox;
  std::string scale_denom;
  std::string overscan_px;
  std::string cache_key;
  std::string cache_key_hash;
};

static ChartRendererChoice chart_renderer_default() {
  const std::string value = lower_ascii(env_or("HELM_CHART_RENDERER", "legacy"));
  return value == "vulkan" ? ChartRendererChoice::Vulkan : ChartRendererChoice::Legacy;
}

static bool chart_renderer_query_override_enabled() {
  return env_true("HELM_CHART_RENDERER_QUERY_OVERRIDE", false);
}

static ChartRendererChoice chart_renderer_for_request(const std::string& uri) {
  if (chart_renderer_query_override_enabled()) {
    const std::string q = lower_ascii(query_param(uri, "renderer"));
    if (q == "legacy") return ChartRendererChoice::Legacy;
    if (q == "vulkan") return ChartRendererChoice::Vulkan;
  }
  return chart_renderer_default();
}

static bool vulkan_fallback_to_legacy_requested(const std::string& uri) {
  const std::string q = lower_ascii(query_param(uri, "fallback"));
  return q == "legacy" || lower_ascii(env_or("HELM_VULKAN_FALLBACK", "")) == "legacy";
}

static std::string fixed_double(double v, int precision = 8) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(precision) << v;
  return out.str();
}

static VulkanTileMeta make_vulkan_tile_meta(int z, long x, long y, ColorScheme pal, DisCat cat) {
  const double west = tile_lon(x, z), east = tile_lon(x + 1, z);
  const double north = tile_lat(y, z), south = tile_lat(y + 1, z);
  const double center_lat = (north + south) / 2.0;
  VulkanTileMeta meta;
  meta.renderer_branch = env_or("HELM_VULKAN_RENDERER_BRANCH", "vulkan/render-core-poc");
  meta.renderer_sha = env_or("HELM_VULKAN_RENDERER_SHA", env_or("HELM_OPENCPN_RENDERER_SHA", "unknown"));
  meta.scene_schema = env_or("HELM_VULKAN_SCENE_SCHEMA", "vulkan.render_scene.v0");
  meta.chart_epoch = env_or("HELM_VULKAN_CHART_EPOCH",
                            g_cell_name + ".s" + std::to_string(g_native_scale));
  meta.palette = palette_name(pal);
  meta.category = cat_name(cat);
  meta.bbox = fixed_double(west) + "," + fixed_double(south) + "," +
              fixed_double(east) + "," + fixed_double(north);
  meta.scale_denom = fixed_double(display_scale(z, center_lat), 3);
  meta.overscan_px = env_or("HELM_VULKAN_OVERSCAN_PX", "16");

  std::ostringstream key;
  key << "renderer=vulkan\n"
      << "renderer_branch=" << meta.renderer_branch << "\n"
      << "renderer_sha=" << meta.renderer_sha << "\n"
      << "scene_schema=" << meta.scene_schema << "\n"
      << "chart_epoch=" << meta.chart_epoch << "\n"
      << "z=" << z << "\n"
      << "x=" << x << "\n"
      << "y=" << y << "\n"
      << "bbox=" << meta.bbox << "\n"
      << "tile_size=" << TS << "\n"
      << "scale_denom=" << meta.scale_denom << "\n"
      << "palette=" << meta.palette << "\n"
      << "category=" << meta.category << "\n"
      << "safety=" << env_or("HELM_CHART_SAFETY_DEPTHS", "default") << "\n"
      << "text=" << env_or("HELM_CHART_TEXT", "default") << "\n"
      << "soundings=" << env_or("HELM_CHART_SOUNDINGS", "default") << "\n"
      << "overscan=" << meta.overscan_px << "\n"
      << "target=offscreen-rgba8\n";
  meta.cache_key = key.str();
  meta.cache_key_hash = sha256_hex(meta.cache_key);
  return meta;
}

static bool run_vulkan_renderer_command(int z, long x, long y, const VulkanTileMeta& meta,
                                        const std::string& output_path, std::string* error) {
  const std::string renderer = env_or(
      "HELM_VULKAN_RENDERER_BIN",
      env_or("HELM_VULKAN_RENDER_FIXTURE_BIN", "scripts/vulkan-render-fixture"));
  const std::string fixture_dir = env_or(
      "HELM_VULKAN_FIXTURE_DIR", "engine/test/fixtures/vulkan-render/chart-1");
  const std::string log_path = output_path + ".log";
  std::ostringstream cmd;
  cmd << "HELM_RENDER_VIEW_PROJECTION=web_mercator_tile "
      << "HELM_TILE_Z=" << z << " "
      << "HELM_TILE_X=" << x << " "
      << "HELM_TILE_Y=" << y << " "
      << "HELM_TILE_SIZE=" << TS << " "
      << "HELM_TILE_BBOX=" << shell_quote(meta.bbox) << " "
      << "HELM_DISPLAY_PALETTE=" << shell_quote(meta.palette) << " "
      << "HELM_DISPLAY_CATEGORY=" << shell_quote(meta.category) << " "
      << "HELM_RENDER_CACHE_KEY_SHA256=" << shell_quote(meta.cache_key_hash) << " "
      << shell_quote(renderer) << " " << shell_quote(fixture_dir)
      << " --tile-size " << TS
      << " --format png --output " << shell_quote(output_path)
      << " > " << shell_quote(log_path) << " 2>&1";
  const int rc = std::system(cmd.str().c_str());
  if (rc != 0) {
    std::string log;
    read_file(log_path.c_str(), log);
    if (error) *error = "shared renderer command failed: " + header_safe(log.empty() ? cmd.str() : log);
    ::unlink(log_path.c_str());
    return false;
  }
  ::unlink(log_path.c_str());
  return true;
}

static TileStatus render_vulkan_tile(int z, long x, long y, const VulkanTileMeta& meta,
                                     std::string& out_png, std::string& out_error) {
  if (z < 0 || z > 24 || x < 0 || y < 0 || x >= (1L << z) || y >= (1L << z)) {
    out_error = "invalid tile coordinates";
    return TileStatus::BadRequest;
  }
  const std::string tmpdir = env_or("TMPDIR", "/tmp");
  std::string tmpl = tmpdir + "/helm-vulkan-tile-XXXXXX";
  std::vector<char> path(tmpl.begin(), tmpl.end());
  path.push_back('\0');
  int fd = ::mkstemp(path.data());
  if (fd < 0) {
    out_error = "could not create temporary Vulkan tile output";
    return TileStatus::RenderFailed;
  }
  ::close(fd);
  const std::string output_path(path.data());
  if (!run_vulkan_renderer_command(z, x, y, meta, output_path, &out_error)) {
    ::unlink(output_path.c_str());
    return TileStatus::RenderFailed;
  }
  if (!read_file(output_path.c_str(), out_png)) {
    out_error = "shared renderer produced no readable PNG output";
    ::unlink(output_path.c_str());
    return TileStatus::RenderFailed;
  }
  ::unlink(output_path.c_str());
  if (!png_signature_ok(out_png)) {
    out_error = "shared renderer output was not PNG";
    return TileStatus::RenderFailed;
  }
  return TileStatus::Ok;
}

static std::string vulkan_etag(const VulkanTileMeta& meta, const std::string& output_sha) {
  return "\"vulkan:" + sha256_hex(meta.cache_key + "output_sha=" + output_sha + "\n") + "\"";
}
// Parse the first <rte> of a GPX doc into ROUTE + the route name (pugixml, namespace-tolerant).
static bool load_gpx_route(const std::string& xml, std::vector<WP>& out, std::string& routeName) {
  pugi::xml_document doc;
  if (!doc.load_buffer(xml.data(), xml.size())) { std::fprintf(stderr, "GPX parse error\n"); return false; }
  pugi::xml_node gpx = doc.child("gpx"); if (!gpx) gpx = doc.first_child();
  pugi::xml_node rte = gpx.child("rte"); if (!rte) { std::fprintf(stderr, "GPX has no <rte>\n"); return false; }
  if (pugi::xml_node nm = rte.child("name")) routeName = nm.text().get();
  out.clear();
  for (pugi::xml_node pt = rte.child("rtept"); pt; pt = pt.next_sibling("rtept")) {
    pugi::xml_attribute la = pt.attribute("lat"), lo = pt.attribute("lon");
    if (!la || !lo) continue;
    WP w; w.lat = la.as_double(); w.lon = lo.as_double();
    if (pugi::xml_node nm = pt.child("name")) w.name = nm.text().get();
    if (w.name.empty()) { char b[24]; std::snprintf(b, sizeof b, "WP%zu", out.size() + 1); w.name = b; }
    out.push_back(w);
  }
  return out.size() >= 2;
}
// Build an OpenCPN Route from waypoints (named WP1..n) — used for navobj persistence + active-nav.
static Route* build_route(const std::vector<WP>& pts, const std::string& name) {
  Route* r = new Route();
  for (auto& w : pts) r->AddPoint(new RoutePoint(w.lat, w.lon, wxT("circle"), wxString::FromUTF8(w.name.c_str())));
  r->m_RouteNameString = wxString::FromUTF8(name.c_str());
  r->UpdateSegmentDistances(6.0);
  return r;
}
// Read the most-recently-created route + its ordered points straight from navobj.db (the SAME SQLite
// schema OpenCPN's NavObj_dB writes). Read directly rather than via LoadAllRoutes() so we don't need
// pWayPointMan headless. Returns false (→ fall back to GPX) if the db/route isn't there yet.
static bool load_latest_route_from_db(std::vector<WP>& out, std::string& name) {
  if (!g_BasePlatform) return false;
  std::string dbpath = std::string(g_BasePlatform->GetPrivateDataDir().ToUTF8()) + "/navobj.db";
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(dbpath.c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) { if (db) sqlite3_close(db); return false; }
  std::string guid; sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT guid, name FROM routes ORDER BY created_at DESC, rowid DESC LIMIT 1", -1, &st, nullptr) == SQLITE_OK) {
    if (sqlite3_step(st) == SQLITE_ROW) {
      const unsigned char* g = sqlite3_column_text(st, 0); guid = g ? reinterpret_cast<const char*>(g) : "";
      const unsigned char* nm = sqlite3_column_text(st, 1); name = nm ? reinterpret_cast<const char*>(nm) : "Route";
    }
    sqlite3_finalize(st);
  }
  if (!guid.empty()) {
    out.clear();
    const char* q = "SELECT rp.lat, rp.lon, rp.Name FROM routepoints rp "
                    "JOIN routepoints_link l ON rp.guid = l.point_guid "
                    "WHERE l.route_guid = ? ORDER BY l.point_order";
    if (sqlite3_prepare_v2(db, q, -1, &st, nullptr) == SQLITE_OK) {
      sqlite3_bind_text(st, 1, guid.c_str(), -1, SQLITE_TRANSIENT);
      while (sqlite3_step(st) == SQLITE_ROW) {
        WP w; w.lat = sqlite3_column_double(st, 0); w.lon = sqlite3_column_double(st, 1);
        const unsigned char* nm = sqlite3_column_text(st, 2); w.name = nm ? reinterpret_cast<const char*>(nm) : "";
        out.push_back(w);
      }
      sqlite3_finalize(st);
    }
  }
  sqlite3_close(db);
  return out.size() >= 2;
}
// Load a SPECIFIC saved route (by guid) + its name from navobj.db. Mirrors load_latest_route_from_db.
static bool load_route_by_guid(const std::string& guid, std::vector<WP>& out, std::string& name) {
  if (!g_BasePlatform || guid.empty()) return false;
  std::string dbpath = std::string(g_BasePlatform->GetPrivateDataDir().ToUTF8()) + "/navobj.db";
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(dbpath.c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) { if (db) sqlite3_close(db); return false; }
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT name FROM routes WHERE guid = ?", -1, &st, nullptr) == SQLITE_OK) {
    sqlite3_bind_text(st, 1, guid.c_str(), -1, SQLITE_TRANSIENT);
    if (sqlite3_step(st) == SQLITE_ROW) { const unsigned char* nm = sqlite3_column_text(st, 0); name = nm ? reinterpret_cast<const char*>(nm) : "Route"; }
    sqlite3_finalize(st);
  }
  out.clear();
  const char* q = "SELECT rp.lat, rp.lon, rp.Name FROM routepoints rp "
                  "JOIN routepoints_link l ON rp.guid = l.point_guid "
                  "WHERE l.route_guid = ? ORDER BY l.point_order";
  if (sqlite3_prepare_v2(db, q, -1, &st, nullptr) == SQLITE_OK) {
    sqlite3_bind_text(st, 1, guid.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(st) == SQLITE_ROW) {
      WP w; w.lat = sqlite3_column_double(st, 0); w.lon = sqlite3_column_double(st, 1);
      const unsigned char* nm = sqlite3_column_text(st, 2); w.name = nm ? reinterpret_cast<const char*>(nm) : "";
      out.push_back(w);
    }
    sqlite3_finalize(st);
  }
  sqlite3_close(db);
  return out.size() >= 2;
}
static void bd(double lat1, double lon1, double lat0, double lon0, double* brg, double* nm) {
  DistanceBearingMercator(lat1, lon1, lat0, lon0, brg, nm);
}
static std::string fmtPos(double lat, double lon) {
  auto one = [](double v, const char* p, const char* n) {
    const char* h = v >= 0 ? p : n; v = std::fabs(v);
    int d = (int)v; double m = (v - d) * 60.0;
    char b[64]; std::snprintf(b, sizeof b, "%d\xC2\xB0%.1f\xE2\x80\xB2%s", d, m, h);
    return std::string(b);
  };
  return one(lat, "N", "S") + " \xC2\xB7 " + one(lon, "E", "W");
}
static std::string fmtNM(double nm) { char b[32]; std::snprintf(b, sizeof b, "%.1f NM", nm); return b; }
static std::string fmtDur(double hours) {
  if (!(hours >= 0)) hours = 0;
  long mins = (long)std::lround(hours * 60.0); char b[24];
  if (mins < 60) std::snprintf(b, sizeof b, "%ldm", mins);
  else if (mins < 24 * 60) std::snprintf(b, sizeof b, "%ldh %02ldm", mins / 60, mins % 60);
  else std::snprintf(b, sizeof b, "%ldd %ldh", mins / 1440, (mins % 1440) / 60);
  return b;
}

// NMEA 0183 over TCP (real data overrides the sim per-field; source flags stay truthful)
static int relay_port() { if (const char* s = std::getenv("HELM_RELAY_PORT")) { if (*s) { int p = std::atoi(s); if (p > 0 && p < 65536) return p; } } return 10110; }
static const int kNmeaPort = relay_port();   // NMEA relay listen port (HELM_RELAY_PORT override → hermetic tests + coexistence with a live :8080)
static const double kStaleSec = 5.0;
struct RField { double v = 0; std::time_t t = 0; const char* src = "nmea"; int prio = 0; };
struct RealFeed { std::mutex m; double lat = 0, lon = 0; std::time_t pos_t = 0; const char* pos_src = "nmea"; int pos_prio = 0;
                  RField sog, cog, hdg, depth, wspd, wdir; };
static RealFeed g_real;

// AIS — OpenCPN's real AisDecoder driven headless (decode + CPA/TCPA stay in its code). We
// snapshot the decoded targets into our own set at decode time and age on our own clock.
extern Select* pSelectAIS;                 // model global (ais_decoder.cpp), seeded in OnInit
static AisDecoder* g_ais = nullptr;
static std::mutex  g_ais_mtx;
struct AisRow { int mmsi; double lat, lon, cog, sog, hdg, range, brg, cpa, tcpa;
                bool cpaValid; int cls; std::string name; std::time_t seen;   // seen = TRUE last-report time (PositionReportTicks)
                // forwarded from OpenCPN's already-decoded AisTargetData for the rich target card
                int navStatus, shipType, rot, imo, length, beam, etaMo, etaDay, etaHr, etaMin;
                std::string callsign, destination; double draft;
                std::string source; std::time_t prt;   // source = feed id; prt = raw OpenCPN report tick (internal per-target "just reported" change-detector)
                bool posDoubtful, sarAircraft; int altitude;   // b_positionDoubtful (degraded GNSS), SAR-aircraft msg-9 + altitude (m)
                std::string metJson; };   // AIS-11: pre-built met-station JSON for AIS_METEO (msg 8) targets, "" otherwise
// Per-thread "current AIS source": each connection driver thread stamps its conn id here before parsing,
// so the !AIVDM harvest can tag the just-heard target with the feed it arrived on (set in conn_feed_*).
static thread_local std::string g_cur_source;
// Active collision profile, pushed live by the client (ais.risk command) so the per-target risk tier +
// CPA alarm re-band when the skipper switches Harbor/Bay/Ocean (or anchored auto-tighten kicks in).
// g_CPAWarn_NM / g_TCPA_Max are OpenCPN globals (set at startup); g_minTargetSog is Helm's profile speed gate.
static double g_minTargetSog = 2.0;   // vessels slower than this aren't flagged as a collision risk (declutter; guard zone still catches close ones)
static std::string ais_trim(std::string s) {     // AIS text fields are right-padded with '@' (6-bit 0) / spaces
  size_t e = s.find_last_not_of("@ "); return e == std::string::npos ? std::string() : s.substr(0, e + 1);
}
static std::map<int, AisRow> g_ais_rows;
static bool fresh(std::time_t t) { return t != 0 && std::difftime(std::time(nullptr), t) <= kStaleSec; }
static const long kFixOfflineSec = 30;     // health moves stale -> offline after a quiet feed is clearly gone
static long field_age(std::time_t t, std::time_t now) { return t ? (long)std::max(0.0, std::difftime(now, t)) : -1; }
static std::string nav_health_json() {
  std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_real.m);
  long posAge = field_age(g_real.pos_t, now);
  long sogAge = field_age(g_real.sog.t, now);
  long cogAge = field_age(g_real.cog.t, now);
  bool posFresh = fresh(g_real.pos_t);
  bool sogFresh = fresh(g_real.sog.t);
  bool cogFresh = fresh(g_real.cog.t);
  bool anySeen = g_real.pos_t || g_real.sog.t || g_real.cog.t;
  bool complete = g_real.pos_t && g_real.sog.t && g_real.cog.t;
  long maxAge = std::max(posAge, std::max(sogAge, cogAge));

  const char* status = "offline";
  const char* reason = "no_required_fix_fields";
  if (complete && posFresh && sogFresh && cogFresh) {
    status = "live";
    reason = "ok";
  } else if (anySeen && (!complete || maxAge <= kFixOfflineSec)) {
    status = "stale";
    reason = complete ? "fix_stale" : "missing_required_fix_fields";
  }

  std::string missing = "[";
  bool first = true;
  auto add_missing = [&](const char* k, bool seen) {
    if (seen) return;
    missing += std::string(first ? "" : ",") + "\"" + k + "\"";
    first = false;
  };
  add_missing("pos", g_real.pos_t != 0);
  add_missing("sog", g_real.sog.t != 0);
  add_missing("cog", g_real.cog.t != 0);
  missing += "]";

  char ages[128];
  std::snprintf(ages, sizeof ages,
                "\"ageSec\":%ld,\"fields\":{\"posAgeSec\":%ld,\"sogAgeSec\":%ld,\"cogAgeSec\":%ld}",
                complete ? maxAge : -1, posAge, sogAge, cogAge);
  return std::string("{\"fix_status\":\"") + status + "\",\"reason\":\"" + reason +
         "\",\"required\":[\"pos\",\"sog\",\"cog\"],\"missing\":" + missing +
         ",\"sources\":{\"pos\":\"" + json_escape(g_real.pos_t ? g_real.pos_src : "missing") +
         "\",\"sog\":\"" + json_escape(g_real.sog.t ? g_real.sog.src : "missing") +
         "\",\"cog\":\"" + json_escape(g_real.cog.t ? g_real.cog.src : "missing") +
         "\"}," + ages + "}";
}
// CONN-6 source-priority merge: a fresh, higher-or-equal-priority source wins; a lower-priority
// source only fills a field in when the current holder has gone stale. Higher number = preferred,
// so a backup feed takes over on failover and the primary reclaims when it returns. (caller holds g_real.m)
static void setf(RField& f, double v, std::time_t now, const char* src, int prio) {
  if (prio >= f.prio || !fresh(f.t)) { f.v = v; f.t = now; f.src = src; f.prio = prio; }
}
static std::vector<std::string> splitc(const std::string& s) {
  std::vector<std::string> out; std::string cur;
  for (char c : s) { if (c == ',') { out.push_back(cur); cur.clear(); } else cur += c; }
  out.push_back(cur); return out;
}
static bool nmea_csum_ok(const std::string& s) {
  if (s.size() < 4 || s[0] != '$') return false;
  size_t star = s.rfind('*');
  if (star == std::string::npos || star + 2 >= s.size()) return false;
  unsigned char cs = 0; for (size_t i = 1; i < star; ++i) cs ^= (unsigned char)s[i];
  return cs == (unsigned char)std::strtoul(s.substr(star + 1, 2).c_str(), nullptr, 16);
}
static double nmea_ll(const std::string& v, const std::string& hemi) {
  if (v.empty()) return 0;
  double raw = std::atof(v.c_str()); int deg = (int)(raw / 100); double mn = raw - deg * 100;
  double dec = deg + mn / 60.0; if (hemi == "S" || hemi == "W") dec = -dec; return dec;
}
static void nmea_parse(const std::string& line, int prio) {
  // AIS (!AIVDM/!AIVDO) -> OpenCPN's decoder (own checksum + multipart reassembly). Routed BEFORE
  // the $-only checksum gate. Snapshot the decoded targets (range/brg/CPA/TCPA) into g_ais_rows.
  if (g_ais && line.size() >= 6 && (line.compare(0, 6, "!AIVDM") == 0 || line.compare(0, 6, "!AIVDO") == 0)) {
    std::lock_guard<std::mutex> lk(g_ais_mtx);
    g_ais->DecodeN0183(wxString::FromUTF8(line.c_str()));
    std::time_t snap = std::time(nullptr);
    for (auto& kv : g_ais->GetTargetList()) {
      auto& t = kv.second;
      AisRow& row = g_ais_rows[t->MMSI];                          // existing entry (default if new)
      // OpenCPN's PositionReportTicks uses wxDateTime's epoch, which is NOT std::time's base in this
      // headless build — so use it ONLY as a per-target "did this target just report?" change flag and
      // stamp freshness with reliable std::time(). seen then = TRUE time this target last reported.
      std::time_t prt = std::max(t->PositionReportTicks, t->StaticReportTicks);
      bool justHeard = (prt != row.prt) || (row.seen == 0);       // changed report tick (or brand new) = heard now
      std::time_t seen = justHeard ? snap : row.seen;             // refresh on report; else keep so age grows truthfully
      std::string src = justHeard ? g_cur_source : row.source;    // tag the just-heard target's feed; preserve others'
      std::string metJson;                                        // AIS-11: weather-station met data (AIS msg 8) — only for AIS_METEO targets
      if (t->Class == AIS_METEO) {
        auto& mt = t->met_data; std::string mj = "{";             // OpenCPN's decoder already applies units; we just honor each field's NaN marker
        auto aI = [&](const char* k, int v, int nan){ if (v != nan) mj += std::string("\"") + k + "\":" + std::to_string(v) + ","; };
        auto aD = [&](const char* k, double v, double nan){ if (std::fabs(v - nan) > 0.05) { char b[40]; std::snprintf(b, sizeof b, "\"%s\":%.1f,", k, v); mj += b; } };
        aI("windKn", mt.wind_kn, 127); aI("gustKn", mt.wind_gust_kn, 127); aI("windDir", mt.wind_dir, 360);
        aD("airTemp", mt.air_temp, -102.4); aI("humid", mt.rel_humid, 101); aI("press", mt.airpress, 1310);
        aD("waterTemp", mt.water_temp, 50.1); aD("waveM", mt.wave_height, 25.5); aI("wavePer", mt.wave_period, 63); aI("waveDir", mt.wave_dir, 360);
        aD("curKn", mt.current, 25.5); aI("curDir", mt.curr_dir, 360); aI("seaState", mt.seastate, 13);
        if (mj.size() > 1) mj.pop_back(); mj += "}"; metJson = mj;
      }
      row = { t->MMSI, t->Lat, t->Lon, t->COG, t->SOG, t->HDG, t->Range_NM, t->Brg,
        t->CPA, t->TCPA, (g_have_fix.load() ? t->bCPA_Valid : false), (int)t->Class, ais_trim(t->ShipName), seen,
        t->NavStatus, (int)t->ShipType, t->ROTAIS, t->IMO, t->DimA + t->DimB, t->DimC + t->DimD,
        t->ETA_Mo, t->ETA_Day, t->ETA_Hr, t->ETA_Min, ais_trim(t->CallSign), ais_trim(t->Destination), t->Draft, src, prt,
        t->b_positionDoubtful, t->b_SarAircraftPosnReport, t->altitude, metJson };
    }
    return;
  }
  if (!nmea_csum_ok(line)) { std::fprintf(stderr, "NMEA rejected (bad checksum): %s\n", line.c_str()); return; }
  std::vector<std::string> f = splitc(line.substr(0, line.rfind('*')));
  if (f.empty() || f[0].size() < 6) return;
  std::string type = f[0].substr(3); std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_real.m);
  if (type == "RMC" && f.size() >= 9 && f[2] == "A") {
    if (prio >= g_real.pos_prio || !fresh(g_real.pos_t)) {
      g_real.lat = nmea_ll(f[3], f[4]); g_real.lon = nmea_ll(f[5], f[6]); g_real.pos_t = now; g_real.pos_src = "nmea"; g_real.pos_prio = prio;
    }
    if (!f[7].empty()) setf(g_real.sog, std::atof(f[7].c_str()), now, "nmea", prio);
    if (!f[8].empty()) setf(g_real.cog, std::atof(f[8].c_str()), now, "nmea", prio);
  } else if (type == "DPT" && f.size() >= 2 && !f[1].empty()) setf(g_real.depth, std::atof(f[1].c_str()), now, "nmea", prio);
  else if (type == "DBT" && f.size() >= 4 && !f[3].empty()) setf(g_real.depth, std::atof(f[3].c_str()), now, "nmea", prio);
  else if (type == "MWV" && f.size() >= 6 && f[5] == "A") {
    if (!f[1].empty()) setf(g_real.wdir, std::atof(f[1].c_str()), now, "nmea", prio);
    if (!f[3].empty()) { double sp = std::atof(f[3].c_str()); if (f[4] == "K") sp *= 0.539957; else if (f[4] == "M") sp *= 1.943844; setf(g_real.wspd, sp, now, "nmea", prio); }
  } else if (type == "HDT" && f.size() >= 2 && !f[1].empty()) setf(g_real.hdg, std::atof(f[1].c_str()), now, "nmea", prio);   // Heading, True
  else if (type == "THS" && f.size() >= 2 && !f[1].empty()) setf(g_real.hdg, std::atof(f[1].c_str()), now, "nmea", prio);     // True Heading & Status (modern)
  else if (type == "HDG" && f.size() >= 2 && !f[1].empty()) {   // Heading, Magnetic — apply deviation + variation → TRUE so it matches the GPS-true COG/route (e.g. Vesper $AIHDG,240.1,,,12.9,E → 253.0°)
    double h = std::atof(f[1].c_str());
    if (f.size() >= 4 && !f[2].empty()) { double dev = std::atof(f[2].c_str()); if (f[3] == "W") dev = -dev; h += dev; }   // deviation E+/W−
    if (f.size() >= 6 && !f[4].empty()) { double var = std::atof(f[4].c_str()); if (f[5] == "W") var = -var; h += var; }   // variation E+/W− (magnetic → true)
    setf(g_real.hdg, std::fmod(h + 360.0, 360.0), now, "nmea", prio);
  }
}
// SignalK overlay — consume a SignalK server's WS delta stream as a CLIENT. Maps self-vessel
// paths onto the SAME g_real per-field override, tagged "signalk". SI units -> kn/deg/m.
static ix::WebSocket* g_sk = nullptr;
static std::string g_sk_self;
static void sk_apply(const std::string& path, const rapidjson::Value& v, std::time_t now, int prio) {
  auto set = [&](RField& f, double val) { setf(f, val, now, "signalk", prio); };
  const double MS2KN = 1.943844, R2D = 180.0 / M_PI;
  if (path == "navigation.position" && v.IsObject() && v.HasMember("latitude") && v.HasMember("longitude") &&
      v["latitude"].IsNumber() && v["longitude"].IsNumber()) {
    if (prio >= g_real.pos_prio || !fresh(g_real.pos_t)) {
      g_real.lat = v["latitude"].GetDouble(); g_real.lon = v["longitude"].GetDouble();
      g_real.pos_t = now; g_real.pos_src = "signalk"; g_real.pos_prio = prio;
    }
  } else if (path == "navigation.speedOverGround" && v.IsNumber()) set(g_real.sog, v.GetDouble() * MS2KN);
  else if (path == "navigation.courseOverGroundTrue" && v.IsNumber()) set(g_real.cog, v.GetDouble() * R2D);
  else if (path == "navigation.headingTrue" && v.IsNumber()) set(g_real.hdg, v.GetDouble() * R2D);
  else if (path == "environment.depth.belowTransducer" && v.IsNumber()) set(g_real.depth, v.GetDouble());
  else if (path == "environment.wind.speedApparent" && v.IsNumber()) set(g_real.wspd, v.GetDouble() * MS2KN);
  else if (path == "environment.wind.angleApparent" && v.IsNumber()) { double d = v.GetDouble() * R2D; if (d < 0) d += 360.0; set(g_real.wdir, d); }
}
static void sk_on_message(const std::string& msg, int prio) {
  rapidjson::Document d;
  if (d.Parse(msg.c_str()).HasParseError() || !d.IsObject()) return;
  if (d.HasMember("self") && d["self"].IsString()) { g_sk_self = d["self"].GetString(); return; }
  if (!d.HasMember("updates") || !d["updates"].IsArray()) return;
  if (d.HasMember("context") && d["context"].IsString()) {     // own-ship only; other vessels = AIS
    std::string ctx = d["context"].GetString();
    if (ctx != "vessels.self" && (g_sk_self.empty() || ctx != g_sk_self)) return;
  }
  std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_real.m);
  for (auto& u : d["updates"].GetArray()) {
    if (!u.HasMember("values") || !u["values"].IsArray()) continue;
    for (auto& val : u["values"].GetArray())
      if (val.HasMember("path") && val["path"].IsString() && val.HasMember("value"))
        sk_apply(val["path"].GetString(), val["value"], now, prio);
  }
}
static void sk_start(std::string url) {
  if (url.find("://") == std::string::npos) url = "ws://" + url + "/signalk/v1/stream?subscribe=self";
  g_sk = new ix::WebSocket(); g_sk->setUrl(url); g_sk->setPingInterval(20); g_sk->enableAutomaticReconnection();
  g_sk->setOnMessageCallback([](const ix::WebSocketMessagePtr& m) {
    if (m->type == ix::WebSocketMessageType::Message) sk_on_message(m->str, 0);   // env HELM_SIGNALK = base priority
    else if (m->type == ix::WebSocketMessageType::Open) std::printf("SignalK: connected\n");
  });
  std::printf("SignalK input: %s (self-vessel nav overrides sim per-field)\n", url.c_str());
  g_sk->start();
}
// ===========================================================================
// Track recording (ownship breadcrumb) — the ENGINE owns the trail; thin clients
// just display it (single source of truth, native inherits it). Records the displayed
// fix when armed (default on), thinned by distance/time so an overnight swing at anchor
// stays compact. In-memory + capped here; GPX export is a later step.
// ===========================================================================
struct TrackPt { double lat, lon; std::time_t t; };
static std::mutex g_track_mtx;
static std::vector<TrackPt> g_track;            // recorded points (rolling, capped) — guard: g_track_mtx
static size_t g_track_emitted = 0;              // points already streamed (for trackAdd deltas) — g_track_mtx
static std::atomic<bool> g_track_armed{true};   // recording on by default
static const size_t kTrackCap = 3000;
static const double kTrackMinNM  = 0.002;       // ~3.7 m — OpenCPN "Medium" min-move (model/src/track.cpp SetPrecision)
static const double kTrackMinSec = 4.0;         // ...and >= this long since the last point (OpenCPN "Medium")
static std::string g_track_src;                 // source of the last recorded fix — g_track_mtx
static void track_record(double lat, double lon, const char* src) {
  if (!g_track_armed.load()) return;            // always-on by default — recording is automatic, like OpenCPN
  std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_track_mtx);
  std::string s = src ? src : "";
  if (!g_track.empty() && s != g_track_src) {   // source changed (e.g. demo-origin sim → real fix) — the
    g_track.clear(); g_track_emitted = 0;       // position teleports, so start a CLEAN track, don't draw across it
  }
  g_track_src = s;
  if (!g_track.empty()) {
    const TrackPt& last = g_track.back();
    double brg, nm; bd(lat, lon, last.lat, last.lon, &brg, &nm);
    // OpenCPN-style commit: BOTH enough time elapsed AND moved beyond the min delta. Distance-gated
    // (NOT speed) so the anchor SWING is captured (it's movement) while a dead-still boat adds nothing.
    if (std::difftime(now, last.t) < kTrackMinSec || nm < kTrackMinNM) return;
  }
  g_track.push_back({lat, lon, now});
  if (g_track.size() > kTrackCap) {
    size_t drop = g_track.size() - kTrackCap;
    g_track.erase(g_track.begin(), g_track.begin() + drop);
    g_track_emitted = (g_track_emitted > drop) ? (g_track_emitted - drop) : 0;
  }
}

// ===========================================================================
// Connections — runtime-configurable, persisted, multi-source live-data input.
// Each connection is an independent driver thread feeding the SAME nmea_parse →
// g_real / AisDecoder pipeline, so per-field source tags stay truthful. The engine
// does NOT pump a wxWidgets event loop, so we use plain BSD sockets with our own
// reconnect/backoff — and crucially support TCP-CLIENT (connect-out), which marine
// WiFi gateways require (Garmin Vesper Cortex :39150, PredictWind DataHub, …).
// Config is owned by the ENGINE and persisted to ~/.helm/connections.json; clients
// edit it over the nav-WS command-plane (conn.list / conn.upsert / conn.delete) and
// read live status back in the nav frame. (SignalK input stays on HELM_SIGNALK for now.)
// ===========================================================================
enum class ConnStatus { Disabled, Connecting, Connected, NoData, Error };
static const char* conn_status_str(ConnStatus s) {
  switch (s) {
    case ConnStatus::Disabled:   return "disabled";
    case ConnStatus::Connecting: return "connecting";
    case ConnStatus::Connected:  return "connected";
    case ConnStatus::NoData:     return "nodata";
    default:                     return "error";
  }
}
struct ConnConfig { std::string id, name, type, address, dataProtocol, comment; int port = 0; bool enabled = true; int priority = 0; };
struct ConnRuntime {
  std::atomic<bool> want_stop{false};
  std::atomic<int>  status{(int)ConnStatus::Connecting};
  std::atomic<long> last_rx{0};
  std::atomic<long> sentences{0};
  std::string last_error;                          // guarded by g_conns_mtx
};
static std::mutex g_conns_mtx;
static std::map<std::string, ConnConfig> g_conns;                       // id -> config
static std::map<std::string, std::shared_ptr<ConnRuntime>> g_conn_rt;   // id -> runtime
static std::string g_owner_token;                                       // optional write gate (HELM_OWNER_TOKEN)
static long g_conn_counter = 0;

// --- CONN-7: raw-NMEA monitor — capture incoming sentences + stream to subscribed clients ---
struct RawLine { std::string conn, line; long ts; };
static std::mutex g_raw_mtx;
static std::vector<RawLine> g_raw_pending;                  // accumulated between nav ticks, flushed to monitors
static std::atomic<bool> g_monitoring_any{false};           // capture gate — zero overhead when nobody is watching
static std::mutex g_monitors_mtx;
static std::set<ix::WebSocket*> g_monitors;                 // clients subscribed via nmea.monitor{on:true}
static void raw_capture(const std::string& conn, const std::string& line) {
  if (!g_monitoring_any.load()) return;                     // nobody monitoring → don't even buffer
  std::lock_guard<std::mutex> lk(g_raw_mtx);
  if (g_raw_pending.size() < 1000) g_raw_pending.push_back({conn, line, (long)std::time(nullptr)});
}

static std::string conn_dir() {
  if (const char* c = std::getenv("HELM_CONFIG")) if (*c) return c;
  const char* home = std::getenv("HOME"); std::string d = (home && *home) ? home : ".";
  return d + "/.helm";
}
static std::string conn_path() { return conn_dir() + "/connections.json"; }

// Non-blocking TCP connect-out with a bounded timeout; resolves host (IP or name) via getaddrinfo.
static int tcp_connect(const std::string& host, int port, int timeout_sec, std::string& err) {
  addrinfo hints{}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr; char ports[16]; std::snprintf(ports, sizeof ports, "%d", port);
  int g = ::getaddrinfo(host.c_str(), ports, &hints, &res);
  if (g != 0 || !res) { err = std::string("resolve: ") + gai_strerror(g); return -1; }
  int fd = -1;
  for (addrinfo* p = res; p; p = p->ai_next) {
    fd = ::socket(p->ai_family, p->ai_socktype, p->ai_protocol); if (fd < 0) continue;
    int fl = ::fcntl(fd, F_GETFL, 0); ::fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    int rc = ::connect(fd, p->ai_addr, p->ai_addrlen);
    if (rc == 0) { ::fcntl(fd, F_SETFL, fl); break; }
    if (errno == EINPROGRESS) {
      pollfd pfd{fd, POLLOUT, 0}; int pr = ::poll(&pfd, 1, timeout_sec * 1000);
      if (pr > 0) { int se = 0; socklen_t sl = sizeof se; ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &se, &sl);
        if (se == 0) { ::fcntl(fd, F_SETFL, fl); break; } err = std::string("connect: ") + std::strerror(se); }
      else err = (pr == 0) ? "connect: timeout" : "connect: poll error";
    } else err = std::string("connect: ") + std::strerror(errno);
    ::close(fd); fd = -1;
  }
  ::freeaddrinfo(res);
  if (fd >= 0) { timeval tv{5, 0}; ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); }
  else if (err.empty()) err = "connect: failed";
  return fd;
}
// TCP server: bind+listen, wait (interruptibly) for ONE client, return its fd. Re-binds per client.
static int tcp_server_accept(const std::string& host, int port, const std::shared_ptr<ConnRuntime>& rt, std::string& err) {
  int srv = ::socket(AF_INET, SOCK_STREAM, 0); if (srv < 0) { err = "socket"; return -1; }
  int yes = 1; ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = (host == "0.0.0.0" || host.empty()) ? INADDR_ANY : inet_addr(host.c_str());
  if (::bind(srv, (sockaddr*)&a, sizeof a) < 0 || ::listen(srv, 4) < 0) { err = "bind/listen :" + std::to_string(port); ::close(srv); return -1; }
  for (;;) {
    if (rt->want_stop) { ::close(srv); err = "stopped"; return -1; }
    pollfd pfd{srv, POLLIN, 0}; int pr = ::poll(&pfd, 1, 1000);
    if (pr > 0) { int c = ::accept(srv, nullptr, nullptr); ::close(srv);
      if (c < 0) { err = "accept"; return -1; }
      timeval tv{5, 0}; ::setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); return c; }
    if (pr < 0) { ::close(srv); err = "poll"; return -1; }
  }
}
static int udp_bind(const std::string& host, int port, std::string& err) {
  int fd = ::socket(AF_INET, SOCK_DGRAM, 0); if (fd < 0) { err = "socket"; return -1; }
  int yes = 1; ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = (host.empty() || host == "0.0.0.0") ? INADDR_ANY : inet_addr(host.c_str());
  if (::bind(fd, (sockaddr*)&a, sizeof a) < 0) { err = "bind :" + std::to_string(port); ::close(fd); return -1; }
  timeval tv{5, 0}; ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); return fd;
}
// Read NMEA lines off a connected fd until EOF/error/stop, feeding nmea_parse and updating status.
// Generic line reader: poll+read an fd (works for sockets AND serial ttys), split on '\n', and
// hand each trimmed line to on_line. Interruptible via want_stop; marks NoData after 10 s idle.
// A live feed (the Vesper streams continuously) that goes silent is usually a HALF-OPEN socket: TCP
// is still up but the peer stopped sending, so poll() just keeps timing out forever and the driver
// never reconnects. Detect prolonged silence and RETURN so conn_thread closes the fd and reconnects
// — the automatic equivalent of the manual disable/enable "kick".
static const long kRxStaleReconnect = 20;     // seconds of silence after which we drop + reconnect
static void conn_read_lines(int fd, const std::shared_ptr<ConnRuntime>& rt,
                            const std::function<void(const std::string&)>& on_line) {
  std::string buf; char rb[2048];
  long connected_at = (long)std::time(nullptr);
  for (;;) {
    if (rt->want_stop) return;
    pollfd pfd{fd, POLLIN, 0}; int pr = ::poll(&pfd, 1, 1000);
    if (pr == 0) {
      long idle = (long)std::time(nullptr) - (rt->last_rx ? (long)rt->last_rx : connected_at);
      if (idle > 10) rt->status = (int)ConnStatus::NoData;
      if (idle > kRxStaleReconnect) { rt->status = (int)ConnStatus::NoData; return; }   // half-open / silent peer → drop + reconnect
      continue;
    }
    if (pr < 0) { if (errno == EINTR) continue; return; }
    ssize_t n = ::read(fd, rb, sizeof rb);
    if (n > 0) {
      rt->last_rx = (long)std::time(nullptr); rt->status = (int)ConnStatus::Connected;
      buf.append(rb, (size_t)n); size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, nl); buf.erase(0, nl + 1);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (!line.empty()) on_line(line);
      }
      if (buf.size() > (1u << 16)) buf.clear();          // runaway guard (never a newline)
    } else if (n == 0) { return; }                       // peer closed / device gone
    else { if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue; return; }
  }
}
static void conn_feed_fd(int fd, const std::shared_ptr<ConnRuntime>& rt, int prio, const std::string& conn_id) {
  conn_read_lines(fd, rt, [&](const std::string& line) { g_cur_source = conn_id; raw_capture(conn_id, line); nmea_parse(line, prio); rt->sentences++; });
}
// SignalK driver as a managed connection (CONN-5): a per-connection WebSocket that feeds the SAME
// sk_on_message → g_real per-field overrides as the HELM_SIGNALK path, but lifecycle-bound to the
// ConnRuntime so conn.upsert/disable/delete start+stop it, with live status in the nav frame.
// SignalK is JSON-over-WS, not line NMEA, so it does NOT use conn_feed_fd.
static void conn_feed_signalk(const ConnConfig& cfg, const std::shared_ptr<ConnRuntime>& rt) {
  std::string url = cfg.address;
  if (url.find("://") == std::string::npos) {            // bare host[:port] → SignalK stream URL
    std::string host = cfg.address;
    if (cfg.port > 0 && host.find(':') == std::string::npos) host += ":" + std::to_string(cfg.port);
    url = "ws://" + host + "/signalk/v1/stream?subscribe=self";
  }
  ix::WebSocket ws; ws.setUrl(url); ws.setPingInterval(20); ws.enableAutomaticReconnection();
  ws.setOnMessageCallback([rt, prio = cfg.priority](const ix::WebSocketMessagePtr& m) {
    if (m->type == ix::WebSocketMessageType::Message) {
      sk_on_message(m->str, prio);
      rt->last_rx = (long)std::time(nullptr); rt->sentences++;
      rt->status = (int)ConnStatus::Connected;
    } else if (m->type == ix::WebSocketMessageType::Open) {
      rt->status = (int)ConnStatus::Connected;
      { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error.clear(); }
    } else if (m->type == ix::WebSocketMessageType::Error) {
      rt->status = (int)ConnStatus::Error;
      { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error = m->errorInfo.reason; }
    } else if (m->type == ix::WebSocketMessageType::Close) {
      if (!rt->want_stop) rt->status = (int)ConnStatus::NoData;
    }
  });
  ws.start();
  for (;;) {                                             // hold the thread until asked to stop
    if (rt->want_stop) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    if (rt->last_rx && (long)std::time(nullptr) - rt->last_rx > 10 &&
        rt->status == (int)ConnStatus::Connected)
      rt->status = (int)ConnStatus::NoData;              // connected but deltas stalled
  }
  ws.stop();
}

// ---- CONN-9: serial NMEA (macOS boat-server; iOS has no serial path) ----
static speed_t baud_const(int b) {
  switch (b) { case 4800: return B4800; case 9600: return B9600; case 19200: return B19200;
    case 38400: return B38400; case 57600: return B57600; case 115200: return B115200; default: return B4800; }
}
static int serial_open(const std::string& dev, int baud, std::string& err) {        // address=device, port=baud
  int fd = ::open(dev.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) { err = std::string("open ") + dev + ": " + std::strerror(errno); return -1; }
  termios t{};
  if (::tcgetattr(fd, &t) != 0) { err = "tcgetattr (not a serial device?)"; ::close(fd); return -1; }
  cfmakeraw(&t);
  speed_t sp = baud_const(baud > 0 ? baud : 4800);                                   // NMEA-0183 = 4800; AIS = 38400
  cfsetispeed(&t, sp); cfsetospeed(&t, sp);
  t.c_cflag |= (CLOCAL | CREAD); t.c_cflag &= ~CRTSCTS;
  t.c_cc[VMIN] = 0; t.c_cc[VTIME] = 0;
  if (::tcsetattr(fd, TCSANOW, &t) != 0) { err = "tcsetattr"; ::close(fd); return -1; }
  return fd;
}

// ---- CONN-8: NMEA 2000 over IP — decode the common single-frame PGNs from a YDWG/Actisense RAW
//      stream (one CAN frame per line: "<time> <dir> <canid-hex> <b0..b7>") into the priority-aware
//      g_real fields. Fast-packet PGNs + native CAN (socketcan/Actisense USB) are a separate task. ----
static void n2k_decode_line(const std::string& line, int prio) {
  std::vector<std::string> tok; { std::string c; for (char ch : line) { if (ch==' '||ch=='\t') { if(!c.empty()){tok.push_back(c);c.clear();} } else c+=ch; } if(!c.empty()) tok.push_back(c); }
  auto ishex = [](const std::string& s){ return !s.empty() && s.find_first_not_of("0123456789abcdefABCDEF")==std::string::npos; };
  int idIdx = -1; for (size_t i=0;i<tok.size();++i) if (tok[i].size()==8 && ishex(tok[i])) { idIdx=(int)i; break; }
  if (idIdx < 0) return;
  unsigned long canid = std::strtoul(tok[idIdx].c_str(), nullptr, 16);
  std::vector<uint8_t> b; for (size_t i=idIdx+1; i<tok.size() && b.size()<8; ++i) if (tok[i].size()<=2 && ishex(tok[i])) b.push_back((uint8_t)std::strtoul(tok[i].c_str(),nullptr,16));
  if (b.size() < 8) return;
  uint8_t dp = (canid>>24)&1, pf = (canid>>16)&0xFF, ps = (canid>>8)&0xFF;     // J1939/N2K id: DP|PF|PS|SA
  unsigned pgn = ((unsigned)dp<<16) | ((unsigned)pf<<8) | ((pf < 240) ? 0u : (unsigned)ps);
  auto u16 = [&](int i){ return (uint16_t)(b[i] | (b[i+1]<<8)); };
  auto i32 = [&](int i){ return (int32_t)((uint32_t)b[i]|((uint32_t)b[i+1]<<8)|((uint32_t)b[i+2]<<16)|((uint32_t)b[i+3]<<24)); };
  auto u32 = [&](int i){ return (uint32_t)b[i]|((uint32_t)b[i+1]<<8)|((uint32_t)b[i+2]<<16)|((uint32_t)b[i+3]<<24); };
  const double R2D = 180.0/M_PI, MS2KN = 1.943844; std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_real.m);
  if (pgn == 129025) {                                                  // Position, Rapid Update
    if (i32(0) == 0x7FFFFFFF || i32(4) == 0x7FFFFFFF) return;           // not-available sentinel
    double lat = i32(0)*1e-7, lon = i32(4)*1e-7;
    if (lat>=-90&&lat<=90&&lon>=-180&&lon<=180 && (prio>=g_real.pos_prio||!fresh(g_real.pos_t)))
      { g_real.lat=lat; g_real.lon=lon; g_real.pos_t=now; g_real.pos_src="nmea2000"; g_real.pos_prio=prio; }
  } else if (pgn == 129026) {                                           // COG & SOG, Rapid Update
    uint16_t cog=u16(2), sog=u16(4);
    if (cog!=0xFFFF) setf(g_real.cog, cog*1e-4*R2D, now, "nmea2000", prio);
    if (sog!=0xFFFF) setf(g_real.sog, sog*1e-2*MS2KN, now, "nmea2000", prio);
  } else if (pgn == 127250) {                                           // Vessel Heading
    uint16_t h=u16(1); if (h!=0xFFFF) setf(g_real.hdg, h*1e-4*R2D, now, "nmea2000", prio);
  } else if (pgn == 128267) {                                           // Water Depth
    uint32_t d=u32(1); if (d!=0xFFFFFFFF) setf(g_real.depth, d*1e-2, now, "nmea2000", prio);
  } else if (pgn == 130306) {                                           // Wind Data
    uint16_t ws=u16(1), wa=u16(3);
    if (ws!=0xFFFF) setf(g_real.wspd, ws*1e-2*MS2KN, now, "nmea2000", prio);
    if (wa!=0xFFFF) setf(g_real.wdir, wa*1e-4*R2D, now, "nmea2000", prio);          // 0..2π → 0..360°
  }
}
static void conn_feed_n2k(int fd, const std::shared_ptr<ConnRuntime>& rt, int prio, const std::string& conn_id) {
  conn_read_lines(fd, rt, [&](const std::string& line){ g_cur_source = conn_id; raw_capture(conn_id, line); n2k_decode_line(line, prio); rt->sentences++; });
}

// ---- CONN-10: internet AIS. Raw !AIVDM over TCP already works via tcp-client (→ AisDecoder); this
//      adds JSON/WS providers (aisstream.io): translate each JSON PositionReport into a Type-1 AIVDM
//      sentence and feed it through OpenCPN's AisDecoder, so CPA/TCPA + the full target card stay
//      OpenCPN's — we never reimplement collision math. ----
static std::string ais_aivdm_type1(int mmsi, double lat, double lon, double sog_kn, double cog_deg, double hdg_deg) {
  std::vector<int> bits;
  auto put = [&](long v, int n){ for (int i=n-1;i>=0;--i) bits.push_back((v>>i)&1); };
  auto puts = [&](long v, int n){ put(v & ((1L<<n)-1), n); };                       // two's-complement fit
  put(1,6); put(0,2); put(mmsi,30); put(0,4); puts(-128,8);                          // type, repeat, mmsi, navstat, rot=n/a
  // clamp the untrusted feed values to each field's valid range so garbage can't collide with the
  // not-available sentinels (sog 1023 / cog 3600 / hdg 511) or trigger UB in llround on huge inputs.
  put((sog_kn>=0 && sog_kn<=102.2) ? std::min((long)llround(sog_kn*10), 1022L) : 1023, 10); put(0,1);   // sog, accuracy
  puts((long)llround(lon*600000.0), 28); puts((long)llround(lat*600000.0), 27);      // lon, lat (1/600000 deg; bounds-checked by caller)
  put((cog_deg>=0 && cog_deg<=360) ? std::min((long)llround(std::fmod(cog_deg,360.0)*10), 3599L) : 3600, 12);   // cog
  put((hdg_deg>=0 && hdg_deg<=360) ? std::min((long)llround(std::fmod(hdg_deg,360.0)), 359L) : 511, 9);          // true heading
  put(60,6); put(0,2); put(0,3); put(0,1); put(0,19);                               // timestamp, maneuver, spare, raim, radio
  while (bits.size() % 6) bits.push_back(0);
  std::string payload; for (size_t i=0;i<bits.size();i+=6){ int v=0; for(int j=0;j<6;++j) v=(v<<1)|bits[i+j]; payload += (char)(v<40 ? v+48 : v+56); }
  std::string body = "AIVDM,1,1,,A," + payload + ",0";
  int cs=0; for (char c : body) cs ^= (unsigned char)c; char hx[4]; std::snprintf(hx,sizeof hx,"%02X",cs);
  return "!" + body + "*" + hx;
}
static void ais_on_message(const std::string& msg, int prio) {
  rapidjson::Document d; if (d.Parse(msg.c_str()).HasParseError() || !d.IsObject()) return;
  if (!d.HasMember("MessageType") || !d["MessageType"].IsString() || std::string(d["MessageType"].GetString()) != "PositionReport") return;
  if (!d.HasMember("Message") || !d["Message"].IsObject() || !d["Message"].HasMember("PositionReport") || !d["Message"]["PositionReport"].IsObject()) return;
  const rapidjson::Value& p = d["Message"]["PositionReport"];
  auto num = [&](const char* k)->double{ return (p.HasMember(k) && p[k].IsNumber()) ? p[k].GetDouble() : -1; };
  long mmsi = (p.HasMember("UserID") && p["UserID"].IsInt()) ? p["UserID"].GetInt() : 0; if (!mmsi) return;
  double lat = (p.HasMember("Latitude")&&p["Latitude"].IsNumber())?p["Latitude"].GetDouble():91;
  double lon = (p.HasMember("Longitude")&&p["Longitude"].IsNumber())?p["Longitude"].GetDouble():181;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;   // full bounds — untrusted feed; also rejects the 91/181 missing-field sentinels
  nmea_parse(ais_aivdm_type1((int)mmsi, lat, lon, num("Sog"), num("Cog"), num("TrueHeading")), prio);
}
static void conn_feed_aisws(const ConnConfig& cfg, const std::shared_ptr<ConnRuntime>& rt) {     // aisstream.io JSON/WS
  std::string sub = std::string("{\"APIKey\":\"") + json_escape(cfg.comment) + "\",\"BoundingBoxes\":[[[-90,-180],[90,180]]]}";
  int prio = cfg.priority;
  ix::WebSocket ws; ws.setUrl(cfg.address); ws.setPingInterval(20); ws.enableAutomaticReconnection();
  ws.setOnMessageCallback([rt, prio, sub, &ws](const ix::WebSocketMessagePtr& m) {
    if (m->type == ix::WebSocketMessageType::Message) { ais_on_message(m->str, prio); rt->last_rx = (long)std::time(nullptr); rt->sentences++; rt->status = (int)ConnStatus::Connected; }
    else if (m->type == ix::WebSocketMessageType::Open) { ws.send(sub); rt->status = (int)ConnStatus::Connected; { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error.clear(); } }
    else if (m->type == ix::WebSocketMessageType::Error) { rt->status = (int)ConnStatus::Error; { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error = m->errorInfo.reason; } }
    else if (m->type == ix::WebSocketMessageType::Close) { if (!rt->want_stop) rt->status = (int)ConnStatus::NoData; }
  });
  ws.start();
  for (;;) { if (rt->want_stop) break; std::this_thread::sleep_for(std::chrono::milliseconds(200)); }
  ws.stop();   // LOAD-BEARING: the OnMessage lambda captures &ws (ws.send on Open); ws.stop() joins the
               // ws thread before ws is destroyed, so the &ws capture can never dangle. Keep no early return above.
}
static void conn_thread(std::string id, std::shared_ptr<ConnRuntime> rt) {
  int backoff = 1;
  for (;;) {
    if (rt->want_stop) return;
    ConnConfig cfg;
    { std::lock_guard<std::mutex> lk(g_conns_mtx);
      auto it = g_conns.find(id); if (it == g_conns.end()) return;          // deleted
      cfg = it->second; if (!cfg.enabled) { rt->status = (int)ConnStatus::Disabled; return; } }
    rt->status = (int)ConnStatus::Connecting;
    if (cfg.type == "signalk") { conn_feed_signalk(cfg, rt); return; }   // SignalK WS driver — self-managed lifecycle + reconnect
    if (cfg.type == "internet-ais" && (cfg.address.rfind("ws://",0)==0 || cfg.address.rfind("wss://",0)==0)) { conn_feed_aisws(cfg, rt); return; }  // CONN-10 JSON/WS provider (aisstream)
    std::string err; int fd = -1;
    if (cfg.type == "tcp-client" || cfg.type == "internet-ais") fd = tcp_connect(cfg.address, cfg.port, 6, err);  // internet-ais over TCP = raw !AIVDM → AisDecoder
    else if (cfg.type == "tcp-server") fd = tcp_server_accept(cfg.address.empty() ? "127.0.0.1" : cfg.address, cfg.port, rt, err);
    else if (cfg.type == "udp")        fd = udp_bind(cfg.address, cfg.port, err);
    else if (cfg.type == "serial")     fd = serial_open(cfg.address, cfg.port, err);                    // CONN-9 (port field = baud)
    else if (cfg.type == "nmea2000")   fd = (cfg.dataProtocol == "udp") ? udp_bind(cfg.address, cfg.port, err) : tcp_connect(cfg.address, cfg.port, 6, err);  // CONN-8 N2K-over-IP
    else { { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error = "unsupported type: " + cfg.type; } rt->status = (int)ConnStatus::Error; return; }
    if (fd < 0) {
      { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error = err; }
      rt->status = (int)ConnStatus::Error;
      for (int i = 0; i < backoff * 10 && !rt->want_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
      backoff = std::min(backoff * 2, 15); continue;
    }
    backoff = 1; rt->status = (int)ConnStatus::Connected;
    { std::lock_guard<std::mutex> lk(g_conns_mtx); rt->last_error.clear(); }
    if (cfg.type == "nmea2000") conn_feed_n2k(fd, rt, cfg.priority, id);
    else                        conn_feed_fd(fd, rt, cfg.priority, id);
    ::close(fd);
    if (rt->want_stop) return;
    rt->status = (int)ConnStatus::NoData;
    std::printf("connection %s: link dropped (closed or %lds silent) — reconnecting\n", id.c_str(), kRxStaleReconnect);
    for (int i = 0; i < 10 && !rt->want_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}
static void conn_kill_locked(const std::string& id) {                 // caller holds g_conns_mtx
  auto it = g_conn_rt.find(id);
  if (it != g_conn_rt.end()) { it->second->want_stop = true; g_conn_rt.erase(it); }
}
static void conn_spawn_locked(const std::string& id) {                 // caller holds g_conns_mtx
  auto rt = std::make_shared<ConnRuntime>(); g_conn_rt[id] = rt;
  std::thread(conn_thread, id, rt).detach();
}
static void conn_upsert(const ConnConfig& c) {
  std::lock_guard<std::mutex> lk(g_conns_mtx);
  g_conns[c.id] = c; conn_kill_locked(c.id);
  if (c.enabled) conn_spawn_locked(c.id);
}
static void conn_delete(const std::string& id) {
  std::lock_guard<std::mutex> lk(g_conns_mtx);
  conn_kill_locked(id); g_conns.erase(id);
}
static std::string conn_status_array() {
  std::string out = "["; std::lock_guard<std::mutex> lk(g_conns_mtx);
  long now = (long)std::time(nullptr); bool first = true;
  for (auto& kv : g_conns) {
    const ConnConfig& c = kv.second; auto itr = g_conn_rt.find(c.id);
    std::shared_ptr<ConnRuntime> rt = (itr != g_conn_rt.end()) ? itr->second : nullptr;
    ConnStatus st = !c.enabled ? ConnStatus::Disabled : (rt ? (ConnStatus)rt->status.load() : ConnStatus::Connecting);
    long lrx = rt ? rt->last_rx.load() : 0; long age = lrx ? now - lrx : -1;
    long sent = rt ? rt->sentences.load() : 0; std::string lerr = rt ? rt->last_error : std::string();
    out += std::string(first ? "" : ",") +
      "{\"id\":\"" + json_escape(c.id) + "\",\"name\":\"" + json_escape(c.name) +
      "\",\"type\":\"" + json_escape(c.type) + "\",\"address\":\"" + json_escape(c.address) +
      "\",\"port\":" + std::to_string(c.port) + ",\"enabled\":" + (c.enabled ? "true" : "false") +
      ",\"priority\":" + std::to_string(c.priority) +
      ",\"status\":\"" + conn_status_str(st) + "\",\"ageSec\":" + std::to_string(age) +
      ",\"sentences\":" + std::to_string(sent) + (lerr.empty() ? "" : (",\"error\":\"" + json_escape(lerr) + "\"")) + "}";
    first = false;
  }
  out += "]"; return out;
}
static std::string conn_list_msg() { return std::string("{\"t\":\"conn.list\",\"conns\":") + conn_status_array() + "}"; }
static std::string conn_ack(bool ok, const std::string& id, const std::string& err) {
  return std::string("{\"t\":\"conn.ack\",\"ok\":") + (ok ? "true" : "false") +
         ",\"id\":\"" + json_escape(id) + "\"" + (err.empty() ? "" : (",\"error\":\"" + json_escape(err) + "\"")) + "}";
}
static std::string conn_slug(const std::string& s) {
  std::string o; for (unsigned char c : s) { if (std::isalnum(c)) o += (char)std::tolower(c); else if (!o.empty() && o.back() != '-') o += '-'; }
  while (!o.empty() && o.back() == '-') o.pop_back(); if (o.size() > 24) o.resize(24); return o;
}
static bool conn_from_json(const rapidjson::Value& v, ConnConfig& c, std::string& err) {
  auto gs = [&](const char* k) -> std::string { return (v.HasMember(k) && v[k].IsString()) ? v[k].GetString() : std::string(); };
  c.id = gs("id"); c.name = gs("name"); c.type = gs("type"); c.address = gs("address");
  c.dataProtocol = gs("dataProtocol"); c.comment = gs("comment");
  if (v.HasMember("port") && v["port"].IsInt()) c.port = v["port"].GetInt();
  else if (v.HasMember("port") && v["port"].IsString()) c.port = std::atoi(v["port"].GetString());
  if (v.HasMember("priority") && v["priority"].IsInt()) c.priority = v["priority"].GetInt();           // CONN-6
  else if (v.HasMember("priority") && v["priority"].IsString()) c.priority = std::atoi(v["priority"].GetString());
  c.enabled = !(v.HasMember("enabled") && v["enabled"].IsBool()) || v["enabled"].GetBool();
  if (c.dataProtocol.empty()) c.dataProtocol = (c.type == "signalk") ? "signalk" : "nmea0183";
  static const std::set<std::string> kConnTypes = {"tcp-client","tcp-server","udp","signalk","serial","nmea2000","internet-ais"};
  if (!kConnTypes.count(c.type)) { err = "type must be one of: tcp-client | tcp-server | udp | signalk | serial | nmea2000 | internet-ais"; return false; }
  bool urlAddr = (c.address.rfind("ws://",0)==0 || c.address.rfind("wss://",0)==0);   // WS providers carry the port in the URL
  if (!urlAddr && (c.port < 1 || c.port > 65535)) { err = std::string("port must be 1-65535") + (c.type=="serial" ? " (serial: this is the baud rate)" : ""); return false; }
  if ((c.type=="tcp-client"||c.type=="signalk"||c.type=="serial"||c.type=="nmea2000"||c.type=="internet-ais") && c.address.empty()) { err = "address required for " + c.type; return false; }
  if (c.id.empty()) { std::string b = conn_slug(c.name.empty() ? c.type : c.name); if (b.empty()) b = "conn"; c.id = b + "-" + std::to_string(++g_conn_counter); }
  return true;
}
static void conn_save() {
  std::string js = "[";
  { std::lock_guard<std::mutex> lk(g_conns_mtx); bool first = true;
    for (auto& kv : g_conns) { const ConnConfig& c = kv.second;
      js += std::string(first ? "" : ",") +
        "{\"id\":\"" + json_escape(c.id) + "\",\"name\":\"" + json_escape(c.name) +
        "\",\"type\":\"" + json_escape(c.type) + "\",\"address\":\"" + json_escape(c.address) +
        "\",\"port\":" + std::to_string(c.port) + ",\"dataProtocol\":\"" + json_escape(c.dataProtocol) +
        "\",\"enabled\":" + (c.enabled ? "true" : "false") + ",\"priority\":" + std::to_string(c.priority) +
        ",\"comment\":\"" + json_escape(c.comment) + "\"}";
      first = false; } }
  js += "]";
  std::string dir = conn_dir(); ::mkdir(dir.c_str(), 0700);
  std::string path = conn_path(), tmp = path + ".tmp";
  { std::ofstream f(tmp, std::ios::binary | std::ios::trunc); if (!f) { std::fprintf(stderr, "conn_save: cannot write %s\n", tmp.c_str()); return; } f << js; }
  ::chmod(tmp.c_str(), 0600);
  if (::rename(tmp.c_str(), path.c_str()) != 0) std::fprintf(stderr, "conn_save: rename %s failed\n", path.c_str());
}
static void conn_load() {
  std::string body; if (!read_file(conn_path().c_str(), body)) return;       // none yet
  rapidjson::Document d;
  if (d.Parse(body.c_str()).HasParseError() || !d.IsArray()) { std::fprintf(stderr, "conn_load: %s corrupt — ignoring\n", conn_path().c_str()); return; }
  std::lock_guard<std::mutex> lk(g_conns_mtx);
  for (auto& e : d.GetArray()) {
    if (!e.IsObject()) continue; ConnConfig c;
    auto gs = [&](const char* k) -> std::string { return (e.HasMember(k) && e[k].IsString()) ? e[k].GetString() : std::string(); };
    c.id = gs("id"); c.name = gs("name"); c.type = gs("type"); c.address = gs("address");
    c.dataProtocol = gs("dataProtocol"); c.comment = gs("comment");
    if (e.HasMember("port") && e["port"].IsInt()) c.port = e["port"].GetInt();
    if (e.HasMember("priority") && e["priority"].IsInt()) c.priority = e["priority"].GetInt();          // CONN-6
    c.enabled = !(e.HasMember("enabled") && e["enabled"].IsBool()) || e["enabled"].GetBool();
    if (c.id.empty() || c.type.empty()) continue;
    g_conns[c.id] = c; if (c.enabled) conn_spawn_locked(c.id);
  }
  std::printf("connections: loaded %zu from %s\n", g_conns.size(), conn_path().c_str());
}
// ---------------------------------------------------------------------------
// CONTRACT-14: TOFU pairing. A fresh 6-digit PIN per boot (printed to the console, where the owner has
// physical access) mints bearer tokens over POST /pair; tokens persist in ~/.helm/tokens.json with a
// role (owner today; viewer in CONTRACT-15). No CA — the client TOFU-pins the cert fingerprint (in the
// Bonjour TXT, CONTRACT-13). This file ISSUES tokens; ENFORCEMENT on /nav,/chart,/catalog is CONTRACT-15.
// ---------------------------------------------------------------------------
struct Token { std::string role, name; long issuedAt; };
static std::map<std::string, Token> g_tokens;
static std::mutex g_tokens_mtx;
static std::string g_pair_pin;                    // current boot PIN; empty ⇒ pairing CLOSED (too many bad tries / restart to reopen)
static int g_pair_fails = 0;
static std::string tokens_path() { return conn_dir() + "/tokens.json"; }
static std::string rand_hex(int nbytes) {
  static std::mt19937_64 rng((uint64_t)std::random_device{}() ^ (uint64_t)std::time(nullptr));
  static const char* hx = "0123456789abcdef"; std::string s; s.reserve((size_t)nbytes * 2);
  for (int i = 0; i < nbytes; ++i) { unsigned b = (unsigned)(rng() & 0xFF); s += hx[b >> 4]; s += hx[b & 0xF]; }
  return s;
}
static std::string gen_pin() {
  static std::mt19937 rng((unsigned)std::random_device{}()); std::uniform_int_distribution<int> d(0, 999999);
  char b[8]; std::snprintf(b, sizeof b, "%06d", d(rng)); return b;
}
static void tokens_save() {
  std::string js = "["; bool first = true;
  { std::lock_guard<std::mutex> lk(g_tokens_mtx);
    for (auto& kv : g_tokens) { js += std::string(first ? "" : ",") + "{\"token\":\"" + json_escape(kv.first) + "\",\"role\":\"" + json_escape(kv.second.role) + "\",\"name\":\"" + json_escape(kv.second.name) + "\",\"issuedAt\":" + std::to_string(kv.second.issuedAt) + "}"; first = false; } }
  js += "]";
  std::string dir = conn_dir(); ::mkdir(dir.c_str(), 0700);
  std::string path = tokens_path(), tmp = path + ".tmp";
  { std::ofstream f(tmp, std::ios::binary | std::ios::trunc); if (!f) { std::fprintf(stderr, "tokens_save: cannot write %s\n", tmp.c_str()); return; } f << js; }
  if (::rename(tmp.c_str(), path.c_str()) != 0) std::fprintf(stderr, "tokens_save: rename %s failed\n", path.c_str());
}
static void tokens_load() {
  std::string body; if (!read_file(tokens_path().c_str(), body)) return;
  rapidjson::Document d;
  if (d.Parse(body.c_str()).HasParseError() || !d.IsArray()) { std::fprintf(stderr, "tokens_load: %s corrupt — ignoring\n", tokens_path().c_str()); return; }
  std::lock_guard<std::mutex> lk(g_tokens_mtx);
  for (auto& e : d.GetArray()) {
    if (!e.IsObject() || !e.HasMember("token") || !e["token"].IsString()) continue;
    Token t; t.role = (e.HasMember("role") && e["role"].IsString()) ? e["role"].GetString() : "owner";
    t.name = (e.HasMember("name") && e["name"].IsString()) ? e["name"].GetString() : "";
    t.issuedAt = (e.HasMember("issuedAt") && e["issuedAt"].IsInt64()) ? (long)e["issuedAt"].GetInt64() : 0;
    g_tokens[e["token"].GetString()] = t;
  }
  std::printf("pairing: loaded %zu token(s) from %s\n", g_tokens.size(), tokens_path().c_str());
}
// Redeem a PIN for a fresh owner token. Returns "" on bad/closed PIN (and closes pairing after 10 bad tries).
static std::string pair_redeem(const std::string& pin, const std::string& name) {
  std::string tok;
  { std::lock_guard<std::mutex> lk(g_tokens_mtx);
    if (g_pair_pin.empty()) return "";
    if (pin != g_pair_pin) { if (++g_pair_fails >= 10) { g_pair_pin.clear(); std::fprintf(stderr, "pairing: too many bad PINs — pairing CLOSED until restart\n"); } return ""; }
    tok = rand_hex(24); g_tokens[tok] = { "owner", name, (long)std::time(nullptr) };
  }
  tokens_save();                                  // locks g_tokens_mtx itself — called after the scope above releases it
  std::printf("pairing: issued owner token to \"%s\"\n", name.c_str());
  return tok;
}
// CONTRACT-15: bearer-role enforcement. HELM_REQUIRE_AUTH gates /nav + /chart + /catalog on a paired
// token (CONTRACT-14); the UI shell + /pair + /health stay OPEN so a fresh client can load and pair.
// Token rides ?token= (baked into navUrl()/tileTemplate() by server-endpoint.js) or Authorization: Bearer.
static bool g_require_auth = false;
static std::string token_role(const std::string& tok) {
  if (tok.empty()) return "";
  std::lock_guard<std::mutex> lk(g_tokens_mtx);
  auto it = g_tokens.find(tok); return it == g_tokens.end() ? std::string() : it->second.role;
}
static std::string extract_token(const std::string& uri, const ix::WebSocketHttpHeaders& headers) {
  for (std::size_t q = uri.find("token="); q != std::string::npos; q = uri.find("token=", q + 1)) {
    if (q != 0 && uri[q - 1] != '?' && uri[q - 1] != '&') continue;   // a real query key (?token=/&token=), not a suffix like ?mytoken=
    std::string t = uri.substr(q + 6); std::size_t amp = t.find('&'); return amp == std::string::npos ? t : t.substr(0, amp);
  }
  std::string a = header_ci(headers, "Authorization");   // Authorization: Bearer <token>
  if (a.rfind("Bearer ", 0) == 0) return a.substr(7);
  return "";
}
// ---------------------------------------------------------------------------
// CONTRACT-7: per-client channel subscriptions + client-chosen nav rate.
// The client DECLARES channels + a nav rate (1–4 Hz) in the hello and re-negotiates via sub.update;
// the server filters frame content to the subscription and paces nav to the EFFECTIVE rate. The
// effective rate is min(requested, the ~1 Hz nav-loop source) — the server NEVER streams faster than
// its data source (that would mean faking interpolated fixes, against Helm's honesty rule). When a
// faster source/loop is wired, higher effective rates follow with no contract change.
// See docs/CONTRACT-CHANNELS.md.
// ---------------------------------------------------------------------------
static const int NAV_SOURCE_HZ = 1;             // nav_loop tick rate; caps the effective client rate
struct ClientCfg {
  std::set<std::string> channels{ "nav", "route", "alarms", "ais", "track", "conns" };  // default: ALL
  int rate = 1;                                  // effective Hz (1..NAV_SOURCE_HZ)
  long lastSentTick = -1000;                     // last nav tick sent to this client (rate pacing)
  std::string role = "owner";                    // CONTRACT-15: "owner"|"viewer" from the paired token (owner when auth off)
  bool forceSnapshot = false;                    // CONTRACT-6: next frame must be a fresh snapshot (re-baseline)
  long lastSeq = 0;                              // CONTRACT-6: client's last-seen seq from hello (advisory)
  bool hasBbox = false;                          // CONTRACT-8: cull the 'ais' channel to a viewport bbox
  double bw = 0, bs = 0, be = 0, bn = 0;         // west, south, east, north (deg)
  std::map<std::string, std::string> alarmAcked; // CONTRACT-10: alarm id -> "gen.rev" this client transport-ACKed
  // 'ais'-channel viewport test ONLY — nav core / alarms / route / track / conns are never bbox-filtered.
  bool inBbox(double lat, double lon) const {
    if (!hasBbox) return true;
    if (lat < bs || lat > bn) return false;
    return (bw <= be) ? (lon >= bw && lon <= be) : (lon >= bw || lon <= be);  // bw>be ⇒ wraps the antimeridian
  }
};
static std::map<ix::WebSocket*, ClientCfg> g_client_cfg;
static std::mutex g_client_cfg_mtx;
static int clamp_rate(int r) { return r < 1 ? 1 : (r > 4 ? 4 : r); }
static int effective_rate(int requested) { int r = clamp_rate(requested); return r < NAV_SOURCE_HZ ? r : NAV_SOURCE_HZ; }
static void parse_sub(const rapidjson::Document& d, ClientCfg& cfg) {
  if (d.HasMember("subscribe") && d["subscribe"].IsArray()) {
    cfg.channels.clear();
    for (auto& v : d["subscribe"].GetArray()) if (v.IsString()) cfg.channels.insert(v.GetString());
    cfg.channels.insert("nav");                  // 'nav' (position/instruments) is the safety core — never droppable
  }
  if (d.HasMember("rate")) {
    if (d["rate"].IsInt()) cfg.rate = effective_rate(d["rate"].GetInt());
    else if (d["rate"].IsNumber()) cfg.rate = effective_rate((int)std::lround(d["rate"].GetDouble()));
  }
  if (d.HasMember("bbox")) {                      // CONTRACT-8: [w,s,e,n] sets the AIS viewport; null/[] clears it
    const auto& b = d["bbox"];
    if (b.IsArray() && b.Size() == 4 && b[0].IsNumber() && b[1].IsNumber() && b[2].IsNumber() && b[3].IsNumber()) {
      double w = b[0].GetDouble(), s = b[1].GetDouble(), e = b[2].GetDouble(), n = b[3].GetDouble();
      if (std::isfinite(w) && std::isfinite(s) && std::isfinite(e) && std::isfinite(n) && s <= n && s >= -90 && n <= 90)
        { cfg.hasBbox = true; cfg.bw = w; cfg.bs = s; cfg.be = e; cfg.bn = n; }
      else { cfg.hasBbox = false; std::fprintf(stderr, "CONTRACT-8: ignoring malformed bbox [%g,%g,%g,%g]\n", w, s, e, n); }
    } else { cfg.hasBbox = false; }              // null / [] / wrong shape ⇒ clear the viewport (stream all targets)
  }
}
static std::string sub_ack_msg(const ClientCfg& c) {
  std::string s = "{\"t\":\"sub.ack\",\"subscribe\":[";
  bool first = true;
  for (auto& ch : c.channels) { s += std::string(first ? "" : ",") + "\"" + json_escape(ch) + "\""; first = false; }
  s += "],\"rate\":" + std::to_string(c.rate);
  if (c.hasBbox) { char bb[96]; std::snprintf(bb, sizeof bb, ",\"bbox\":[%.5f,%.5f,%.5f,%.5f]", c.bw, c.bs, c.be, c.bn); s += bb; }
  s += "}";
  return s;
}

// ---------------------------------------------------------------------------
// ENGINE/ALARM + CONTRACT-10 PRODUCER: server-side alarm GENERATION over the frozen
// alarm wire schema (docs/CONTRACT-ALARM-SCHEMA.md). The engine keeps watch even with
// NO phone connected — anchor-drag / depth fire on the boat, persist, and re-send every
// tick until the client transport-ACKs (id,gen,rev). This is the dormant "persist+resend"
// half of CONTRACT-10 that the client reliability tier (nav-client.js) was already waiting on.
// ---------------------------------------------------------------------------
struct AlarmState {
  std::string id, kind, sev, msg;
  long gen = 0, rev = 0;
  bool hasPos = false; double lat = 0, lon = 0;
  bool silenceable = true;
  long raisedTs = 0;
  bool active = true; long clearedAt = 0;          // active=false => pending-clear delivery
};
static std::map<std::string, AlarmState> g_alarms; // id -> active OR pending-clear
static std::mutex g_alarm_mtx;
static long g_alarm_gen = 0;                        // process generation = start epoch (set in OnInit)

// Anchor watch setpoint — server-side + persisted, so the watch survives a closed phone / restart.
struct AnchorState { bool set = false; double lat = 0, lon = 0; double radiusM = 40; };
static AnchorState g_anchor;
static std::mutex g_anchor_mtx;
static std::string anchor_path() { return conn_dir() + "/anchor.json"; }
static void anchor_save() {
  std::string js; { std::lock_guard<std::mutex> lk(g_anchor_mtx);
    char b[160]; std::snprintf(b, sizeof b, "{\"set\":%s,\"lat\":%.6f,\"lon\":%.6f,\"radiusM\":%.1f}",
      g_anchor.set ? "true" : "false", g_anchor.lat, g_anchor.lon, g_anchor.radiusM); js = b; }
  std::string dir = conn_dir(); ::mkdir(dir.c_str(), 0700);
  std::string path = anchor_path(), tmp = path + ".tmp";
  { std::ofstream f(tmp, std::ios::binary | std::ios::trunc); if (!f) return; f << js; }
  ::chmod(tmp.c_str(), 0600); ::rename(tmp.c_str(), path.c_str());
}
static void anchor_load() {
  std::string body; if (!read_file(anchor_path().c_str(), body)) return;
  rapidjson::Document d; if (d.Parse(body.c_str()).HasParseError() || !d.IsObject()) return;
  std::lock_guard<std::mutex> lk(g_anchor_mtx);
  if (d.HasMember("set") && d["set"].IsBool()) g_anchor.set = d["set"].GetBool();
  if (d.HasMember("lat") && d["lat"].IsNumber()) g_anchor.lat = d["lat"].GetDouble();
  if (d.HasMember("lon") && d["lon"].IsNumber()) g_anchor.lon = d["lon"].GetDouble();
  if (d.HasMember("radiusM") && d["radiusM"].IsNumber()) g_anchor.radiusM = d["radiusM"].GetDouble();
  if (g_anchor.set) std::printf("anchor: watch restored @ %.5f,%.5f r=%.0fm\n", g_anchor.lat, g_anchor.lon, g_anchor.radiusM);
}

// raise/update — full-state revision: rev bumps only when sev or msg changes. Caller holds g_alarm_mtx.
static void alarm_raise(const std::string& id, const char* kind, const char* sev, const std::string& msg,
                        bool hasPos, double lat, double lon, bool silenceable) {
  long now = (long)std::time(nullptr);
  auto it = g_alarms.find(id);
  if (it == g_alarms.end() || !it->second.active) {
    AlarmState a; a.id = id; a.kind = kind; a.sev = sev; a.msg = msg; a.gen = g_alarm_gen; a.rev = 1;
    a.hasPos = hasPos; a.lat = lat; a.lon = lon; a.silenceable = silenceable; a.raisedTs = now; a.active = true;
    g_alarms[id] = a;
  } else {
    AlarmState& a = it->second;
    if (a.sev != sev || a.msg != msg) { a.sev = sev; a.msg = msg; ++a.rev; }   // escalation / text change => new rev
    a.kind = kind; a.hasPos = hasPos; a.lat = lat; a.lon = lon; a.silenceable = silenceable;
  }
}
static void alarm_clear_id(const std::string& id) {   // caller holds g_alarm_mtx
  auto it = g_alarms.find(id);
  if (it != g_alarms.end() && it->second.active) { it->second.active = false; ++it->second.rev; it->second.clearedAt = (long)std::time(nullptr); }
}

// Per-tick evaluator: anchor-drag (from the persisted setpoint) + depth (REAL source only — never sim).
static int g_drag_over = 0;
static void alarm_eval(double oLat, double oLon, double depth, const char* src_depth) {
  std::lock_guard<std::mutex> lk(g_alarm_mtx);
  AnchorState anc; { std::lock_guard<std::mutex> la(g_anchor_mtx); anc = g_anchor; }
  if (anc.set) {
    double brg, nm; bd(oLat, oLon, anc.lat, anc.lon, &brg, &nm); double driftM = nm * 1852.0;
    if (driftM > anc.radiusM) { if (g_drag_over < 1000) ++g_drag_over; } else g_drag_over = 0;
    if (g_drag_over >= 8) {                                    // ~8 s beyond the circle before we sound (rides out GPS jitter)
      char msg[96]; std::snprintf(msg, sizeof msg, "Anchor dragging — beyond %.0f m watch circle", anc.radiusM);
      alarm_raise("anchor", "anchor", "critical", msg, true, anc.lat, anc.lon, true);
    } else if (driftM <= anc.radiusM) alarm_clear_id("anchor");
  } else { g_drag_over = 0; alarm_clear_id("anchor"); }

  bool depthReal = src_depth && std::strcmp(src_depth, "simulated") != 0 && std::strcmp(src_depth, "missing") != 0;   // NEVER alarm on synthetic or absent depth (fail-loud policy)
  if (depthReal && depth > 0) {
    const double limit = 3.0, clearAt = 3.3;                  // 0.3 m hysteresis so it doesn't chatter at the threshold
    if (depth < limit) {
      char msg[80]; std::snprintf(msg, sizeof msg, "Shallow water — %.1f m (limit %.1f m)", depth, limit);
      alarm_raise("depth", "depth", "critical", msg, false, 0, 0, true);
    } else if (depth >= clearAt) alarm_clear_id("depth");
  } else alarm_clear_id("depth");

  long now = (long)std::time(nullptr);                         // drop fully-delivered clears after a TTL
  for (auto it = g_alarms.begin(); it != g_alarms.end(); )
    if (!it->second.active && now - it->second.clearedAt > 20) it = g_alarms.erase(it); else ++it;
}

static std::string alarm_raise_json(const AlarmState& a) {
  std::string pos; if (a.hasPos) { char pb[64]; std::snprintf(pb, sizeof pb, ",\"lat\":%.6f,\"lon\":%.6f", a.lat, a.lon); pos = pb; }
  char buf[420];
  std::snprintf(buf, sizeof buf,
    "{\"t\":\"alarm\",\"op\":\"%s\",\"id\":\"%s\",\"rev\":%ld,\"gen\":%ld,\"kind\":\"%s\",\"sev\":\"%s\",\"msg\":\"%s\",\"silenceable\":%s,\"raisedTs\":%ld%s}",
    a.rev <= 1 ? "raise" : "update", json_escape(a.id).c_str(), a.rev, a.gen, json_escape(a.kind).c_str(),
    a.sev.c_str(), json_escape(a.msg).c_str(), a.silenceable ? "true" : "false", a.raisedTs, pos.c_str());
  return buf;
}
static std::string alarm_clear_json(const AlarmState& a) {
  char buf[160];
  std::snprintf(buf, sizeof buf, "{\"t\":\"alarm.clear\",\"id\":\"%s\",\"gen\":%ld,\"rev\":%ld,\"reason\":\"resolved\"}",
    json_escape(a.id).c_str(), a.gen, a.rev);
  return buf;
}

// Command-plane: inbound nav-WS messages from a client. (Replaces the old push-only lambda.)
static void handle_command(const std::string& msg, const std::shared_ptr<ix::WebSocket>& ws) {
  rapidjson::Document d;
  if (d.Parse(msg.c_str()).HasParseError() || !d.IsObject() || !d.HasMember("t") || !d["t"].IsString()) return;
  std::string t = d["t"].GetString();
  if (t == "hello" || t == "sub.update") {                   // CONTRACT-7: declare/renegotiate channels + rate
    std::string ack;
    { std::lock_guard<std::mutex> lk(g_client_cfg_mtx);
      ClientCfg& cfg = g_client_cfg[ws.get()];
      parse_sub(d, cfg);
      if (t == "hello") {                                     // CONTRACT-6: (re)connect → re-baseline with a fresh snapshot
        cfg.lastSentTick = -1000;                             // due immediately for the first frame
        cfg.forceSnapshot = true;                             // deliberately a full snapshot, NOT a delta-replay (safety: the
                                                              // client refuses a delta with no baseline; keyframes make a
                                                              // reconnect snapshot near-free, so delta-since isn't worth the risk)
        if (d.HasMember("lastSeq") && d["lastSeq"].IsNumber()) cfg.lastSeq = (long)d["lastSeq"].GetDouble();
        cfg.alarmAcked.clear();                              // CONTRACT-10: reconnect re-asserts every active alarm
      }
      ack = sub_ack_msg(cfg); }
    ws->send(ack);
    return;
  }
  if (t == "alarm.ack" && d.HasMember("acks") && d["acks"].IsArray()) {   // CONTRACT-10 transport-ACK (ungated, like hello)
    std::lock_guard<std::mutex> lk(g_client_cfg_mtx);
    ClientCfg& cfg = g_client_cfg[ws.get()];
    for (auto& e : d["acks"].GetArray()) {
      if (!e.IsObject() || !e.HasMember("id") || !e["id"].IsString()) continue;
      long gen = (e.HasMember("gen") && e["gen"].IsNumber()) ? (long)e["gen"].GetDouble() : 0;
      long rev = (e.HasMember("rev") && e["rev"].IsNumber()) ? (long)e["rev"].GetDouble() : 0;
      cfg.alarmAcked[e["id"].GetString()] = std::to_string(gen) + "." + std::to_string(rev);
    }
    return;
  }
  if (g_require_auth) {                            // CONTRACT-15: writes require the OWNER role (viewers are read-only)
    std::lock_guard<std::mutex> lk(g_client_cfg_mtx);
    if (g_client_cfg[ws.get()].role != "owner") { ws->send(conn_ack(false, "", "viewer is read-only")); return; }
  } else if (!g_owner_token.empty()) {             // legacy env gate (when not in token mode)
    std::string tok = (d.HasMember("token") && d["token"].IsString()) ? d["token"].GetString() : std::string();
    if (tok != g_owner_token) { ws->send(conn_ack(false, "", "unauthorized")); return; }
  }
  if (t == "conn.list") { ws->send(conn_list_msg()); return; }
  if (t == "conn.upsert" && d.HasMember("conn") && d["conn"].IsObject()) {
    ConnConfig c; std::string err;
    if (!conn_from_json(d["conn"], c, err)) { ws->send(conn_ack(false, "", err)); return; }
    conn_upsert(c); conn_save();
    std::printf("connections: upsert \"%s\" %s %s:%d (%s)\n", c.name.c_str(), c.type.c_str(), c.address.c_str(), c.port, c.enabled ? "enabled" : "disabled");
    ws->send(conn_ack(true, c.id, "")); ws->send(conn_list_msg()); return;
  }
  if (t == "conn.delete" && d.HasMember("id") && d["id"].IsString()) {
    std::string id = d["id"].GetString(); conn_delete(id); conn_save();
    std::printf("connections: delete %s\n", id.c_str());
    ws->send(conn_ack(true, id, "")); ws->send(conn_list_msg()); return;
  }
  if (t == "nmea.monitor" && d.HasMember("on") && d["on"].IsBool()) {     // CONN-7 raw-NMEA monitor subscribe
    bool on = d["on"].GetBool();
    { std::lock_guard<std::mutex> lk(g_monitors_mtx);
      if (on) g_monitors.insert(ws.get()); else g_monitors.erase(ws.get());
      g_monitoring_any.store(!g_monitors.empty());
    }
    ws->send(std::string("{\"t\":\"nmea.monitor.ack\",\"on\":") + (on ? "true" : "false") + "}");
    return;
  }
  if (t == "track.arm" && d.HasMember("on") && d["on"].IsBool()) {          // arm/pause breadcrumb recording
    g_track_armed = d["on"].GetBool();
    std::printf("track: recording %s\n", g_track_armed.load() ? "ON" : "paused");
    ws->send(std::string("{\"t\":\"track.ack\",\"armed\":") + (g_track_armed.load() ? "true" : "false") + "}"); return;
  }
  if (t == "track.clear") {                                                 // wipe the recorded trail
    { std::lock_guard<std::mutex> lk(g_track_mtx); g_track.clear(); g_track_emitted = 0; }
    std::printf("track: cleared\n");
    ws->send("{\"t\":\"track.ack\",\"cleared\":true}"); return;
  }
  if (t == "ais.risk") {   // client pushes the active collision profile so the per-target risk tier + CPA alarm re-band live
    if (d.HasMember("cpa")    && d["cpa"].IsNumber())    g_CPAWarn_NM   = d["cpa"].GetDouble();
    if (d.HasMember("tcpa")   && d["tcpa"].IsNumber())   g_TCPA_Max     = d["tcpa"].GetDouble();
    if (d.HasMember("minSog") && d["minSog"].IsNumber()) g_minTargetSog = d["minSog"].GetDouble();
    std::printf("ais.risk: collision profile -> CPA<%.1f NM, TCPA<%.0f min, vessels>=%.1f kn\n", g_CPAWarn_NM, g_TCPA_Max, g_minTargetSog);
    ws->send("{\"t\":\"ais.risk.ack\",\"ok\":true}"); return;
  }
  if (t == "anchor.set" && d.HasMember("lat") && d["lat"].IsNumber() && d.HasMember("lon") && d["lon"].IsNumber()) {
    { std::lock_guard<std::mutex> lk(g_anchor_mtx);
      g_anchor.set = true; g_anchor.lat = d["lat"].GetDouble(); g_anchor.lon = d["lon"].GetDouble();
      if (d.HasMember("radius") && d["radius"].IsNumber()) g_anchor.radiusM = d["radius"].GetDouble(); }
    anchor_save();
    std::printf("anchor: watch set @ %.5f,%.5f r=%.0fm\n", g_anchor.lat, g_anchor.lon, g_anchor.radiusM);
    ws->send("{\"t\":\"anchor.ack\",\"set\":true}"); return;
  }
  if (t == "anchor.clear") {
    { std::lock_guard<std::mutex> lk(g_anchor_mtx); g_anchor.set = false; } anchor_save();
    { std::lock_guard<std::mutex> lk(g_alarm_mtx); alarm_clear_id("anchor"); }
    std::printf("anchor: watch cleared\n");
    ws->send("{\"t\":\"anchor.ack\",\"set\":false}"); return;
  }
  if (t == "route.create" && d.HasMember("points") && d["points"].IsArray()) {   // create/replace the active route
    std::vector<WP> pts;
    for (auto& p : d["points"].GetArray())
      if (p.IsArray() && p.Size() >= 2 && p[0].IsNumber() && p[1].IsNumber()) {
        std::string wn = (p.Size() >= 3 && p[2].IsString()) ? p[2].GetString() : "";   // optional 3rd element: [lat, lon, name]
        pts.push_back({ p[0].GetDouble(), p[1].GetDouble(), wn });
      }
    if (pts.size() < 2) { ws->send("{\"t\":\"route.ack\",\"ok\":false,\"error\":\"need >=2 points\"}"); return; }
    std::string name = (d.HasMember("name") && d["name"].IsString() && *d["name"].GetString()) ? d["name"].GetString() : "Route";
    for (size_t i = 0; i < pts.size(); ++i) if (pts[i].name.empty()) { char b[16]; std::snprintf(b, sizeof b, "WP%zu", i + 1); pts[i].name = b; }   // auto-name only UNnamed points; custom waypoint names preserved (OpenCPN RoutePoint::m_MarkName)
    Route* nr = build_route(pts, name);
    NavObj_dB::GetInstance().InsertRoute(nr);   // persist to navobj.db (route + points + links). nr then leaked (rare; see rebuild_route)
    { std::lock_guard<std::mutex> lk(g_route_mtx); ROUTE = pts; g_route_name = name; }
    g_route_version++;                          // nav_loop swaps to it on the next tick
    std::printf("route: created \"%s\" (%zu wp) — persisted to navobj.db + activated\n", name.c_str(), pts.size());
    ws->send(std::string("{\"t\":\"route.ack\",\"ok\":true,\"name\":\"") + json_escape(name) + "\"}"); return;
  }
  if (t == "route.list") {                                                    // list saved routes from navobj.db
    std::string rn; { std::lock_guard<std::mutex> lk(g_route_mtx); rn = g_route_name; }
    std::string arr = "[";
    if (g_BasePlatform) {
      std::string dbpath = std::string(g_BasePlatform->GetPrivateDataDir().ToUTF8()) + "/navobj.db";
      sqlite3* db = nullptr;
      if (sqlite3_open_v2(dbpath.c_str(), &db, SQLITE_OPEN_READONLY, nullptr) == SQLITE_OK) {
        sqlite3_stmt* st = nullptr;
        const char* q = "SELECT r.guid, r.name, COUNT(l.point_guid) FROM routes r "
                        "LEFT JOIN routepoints_link l ON r.guid = l.route_guid "
                        "GROUP BY r.guid, r.name ORDER BY r.created_at DESC, r.rowid DESC";
        if (sqlite3_prepare_v2(db, q, -1, &st, nullptr) == SQLITE_OK) {
          bool first = true;
          while (sqlite3_step(st) == SQLITE_ROW) {
            const unsigned char* g = sqlite3_column_text(st, 0);
            const unsigned char* nm = sqlite3_column_text(st, 1);
            std::string guid = g ? reinterpret_cast<const char*>(g) : "";
            std::string nme = nm ? reinterpret_cast<const char*>(nm) : "Route";
            char tail[48]; std::snprintf(tail, sizeof tail, ",\"points\":%d,\"active\":%s}",
              sqlite3_column_int(st, 2), (nme == rn) ? "true" : "false");
            arr += (first ? "" : ",");
            arr += "{\"guid\":\"" + json_escape(guid) + "\",\"name\":\"" + json_escape(nme) + "\"" + tail;
            first = false;
          }
          sqlite3_finalize(st);
        }
        sqlite3_close(db);
      }
    }
    arr += "]";
    ws->send(std::string("{\"t\":\"route.list\",\"routes\":") + arr + "}"); return;
  }
  if (t == "route.activate" && d.HasMember("guid") && d["guid"].IsString()) {  // switch the active route
    std::vector<WP> pts; std::string name = "Route";
    if (load_route_by_guid(d["guid"].GetString(), pts, name)) {
      { std::lock_guard<std::mutex> lk(g_route_mtx); ROUTE = pts; g_route_name = name; }
      g_route_version++;
      std::printf("route: activated \"%s\" (%zu wp)\n", name.c_str(), pts.size());
      ws->send(std::string("{\"t\":\"route.ack\",\"ok\":true,\"name\":\"") + json_escape(name) + "\"}");
    } else ws->send("{\"t\":\"route.ack\",\"ok\":false,\"error\":\"route not found\"}");
    return;
  }
  if (t == "route.delete" && d.HasMember("guid") && d["guid"].IsString()) {    // remove a saved route + its points
    std::string guid = d["guid"].GetString(); bool ok = false;
    if (g_BasePlatform) {
      std::string dbpath = std::string(g_BasePlatform->GetPrivateDataDir().ToUTF8()) + "/navobj.db";
      sqlite3* db = nullptr;
      if (sqlite3_open_v2(dbpath.c_str(), &db, SQLITE_OPEN_READWRITE, nullptr) == SQLITE_OK) {
        const char* stmts[] = {
          "DELETE FROM routepoints WHERE guid IN (SELECT point_guid FROM routepoints_link WHERE route_guid=?1) "
          "AND guid NOT IN (SELECT point_guid FROM routepoints_link WHERE route_guid<>?1)",  // points exclusive to this route
          "DELETE FROM routepoints_link WHERE route_guid=?1",
          "DELETE FROM routes WHERE guid=?1" };
        ok = true;
        for (const char* s : stmts) {
          sqlite3_stmt* st = nullptr;
          if (sqlite3_prepare_v2(db, s, -1, &st, nullptr) == SQLITE_OK) {
            sqlite3_bind_text(st, 1, guid.c_str(), -1, SQLITE_TRANSIENT);
            if (sqlite3_step(st) != SQLITE_DONE) ok = false;
            sqlite3_finalize(st);
          } else ok = false;
        }
        sqlite3_close(db);
      }
    }
    std::printf("route: delete %s -> %s\n", guid.c_str(), ok ? "ok" : "failed");
    ws->send(std::string("{\"t\":\"route.ack\",\"ok\":") + (ok ? "true" : "false") + ",\"deleted\":\"" + json_escape(guid) + "\"}");
    return;
  }
}
static void conn_init() {
  if (const char* tok = std::getenv("HELM_OWNER_TOKEN")) if (*tok) g_owner_token = tok;
  g_alarm_gen = (long)std::time(nullptr);   // CONTRACT-10: process generation for alarm (gen,rev) ordering across restarts
  anchor_load();                            // restore a persisted anchor watch so it survives a restart
  conn_load();
  { std::lock_guard<std::mutex> lk(g_conns_mtx);
    if (g_conns.empty()) {                                    // first run: seed the legacy local relay (and a UI template)
      ConnConfig c; c.id = "local-nmea"; c.name = "Local NMEA (relay)"; c.type = "tcp-server";
      c.address = "127.0.0.1"; c.port = kNmeaPort; c.dataProtocol = "nmea0183"; c.enabled = true;
      c.comment = "socat/multiplexer relay target";
      g_conns[c.id] = c; conn_spawn_locked(c.id);
      std::printf("connections: seeded default Local NMEA relay tcp://127.0.0.1:%d\n", kNmeaPort);
    } }
  if (!g_owner_token.empty()) std::printf("connections: writes gated by HELM_OWNER_TOKEN\n");
  tokens_load();                            // CONTRACT-14: restore issued tokens; mint a fresh boot PIN
  g_pair_pin = gen_pin();
  if (const char* ra = std::getenv("HELM_REQUIRE_AUTH")) g_require_auth = (*ra != '\0' && std::strcmp(ra, "0") != 0);  // CONTRACT-15
  if (g_require_auth) std::printf("CONTRACT-15: HELM_REQUIRE_AUTH on — /nav,/chart,/catalog require a paired token (owner=write, viewer=read-only)\n");
}

static long g_seq = 0;
static std::set<ix::WebSocket*> g_seen;   // clients already given a snapshot baseline (nav thread only)

static void nav_loop(ix::HttpServer* server) {
  g_pRouteMan = new Routeman(RoutePropDlgCtx(), RoutemanDlgCtx());
  // Live-data-only by default. HELM_SIM=1 re-enables the route-walking simulator (demos/dev only).
  const bool g_sim = []{ const char* s = std::getenv("HELM_SIM"); return s && *s; }();
  std::printf(g_sim ? "HELM_SIM=1: simulator ENABLED (synthetic data when no live feed)\n"
                    : "live-data-only: no simulator; nav idles until a real fix (pos+SOG+COG)\n");
  // Active route: explicit HELM_ROUTE at boot, or route.create/route.activate over the command plane.
  // Boot NEVER auto-activates a saved route — no surprise demo line on the chart. Saved routes stay
  // listable via route.list. HELM_SIM falls back to the built-in sample so the simulator has a path.
  { const char* rp = std::getenv("HELM_ROUTE"); std::string gpx;
    if (rp && *rp) {
      if (!read_file(rp, gpx)) { std::fprintf(stderr, "FATAL: cannot read GPX route '%s'\n", rp); std::exit(3); }
      std::vector<WP> g; std::string gn;
      if (!load_gpx_route(gpx, g, gn)) { std::fprintf(stderr, "FATAL: GPX route unusable (need <rte> with >=2 <rtept>)\n"); std::exit(4); }
      std::lock_guard<std::mutex> lk(g_route_mtx); ROUTE = g; g_route_name = gn;
      std::printf("route source: %s\n", rp);
    } else if (g_sim) {
      gpx = SAMPLE_GPX; std::vector<WP> g; std::string gn; load_gpx_route(gpx, g, gn);
      std::lock_guard<std::mutex> lk(g_route_mtx); ROUTE = g; g_route_name = gn;
      std::printf("route source: built-in sample (HELM_SIM demo)\n");
    } else {
      std::lock_guard<std::mutex> lk(g_route_mtx); ROUTE.clear(); g_route_name = "";
      std::printf("route source: none (no HELM_ROUTE); waiting for route.create/route.activate\n");
    } }

  // Local working snapshot of the active route + its Route object, rebuilt whenever it's swapped.
  std::vector<WP> route; std::string rname; Route* r = nullptr;
  std::vector<double> legLen; double total = 0;
  double along = 0; size_t lastLeg = 0; long seenVer = -1;
  auto rebuild_route = [&]() {
    { std::lock_guard<std::mutex> lk(g_route_mtx); route = ROUTE; rname = g_route_name; }
    legLen.clear(); total = 0; along = 0; lastLeg = 0; r = nullptr;
    if (route.size() < 2) { std::printf("route idle: no active route — position + AIS only until a route is created/activated\n"); return; }
    r = build_route(route, rname);   // prior r intentionally leaked (rare swap; deleting while Routeman-active is unsafe)
    g_pRouteMan->ActivateRoute(r); g_pRouteMan->ActivateNextPoint(r, false);
    double b, d;
    for (size_t i = 0; i + 1 < route.size(); ++i) { bd(route[i + 1].lat, route[i + 1].lon, route[i].lat, route[i].lon, &b, &d); legLen.push_back(d); total += d; }
    std::printf("route activated: \"%s\" %zu waypoints; Routeman live (no GUI).\n", rname.c_str(), route.size());
  };

  for (long tick = 0;; ++tick) {
    long ver = g_route_version.load();
    if (ver != seenVer) { seenVer = ver; rebuild_route(); }
    // LIVE-DATA-ONLY gate. Require a fresh real fix; no sim unless HELM_SIM. bGPSValid drives the
    // AisDecoder's CPA, so clearing it on no-fix invalidates collision math (no plausible-but-wrong
    // CPA against a frozen / demo-origin ownship). On no-fix we emit NO nav frame, so browser
    // clients age into STALE/OFFLINE instead of seeing a frozen position as live; /health exposes
    // the engine-side fix_status for native clients and watchdogs.
    bool have_fix = fresh(g_real.pos_t) && fresh(g_real.sog.t) && fresh(g_real.cog.t);
    g_have_fix.store(have_fix);
    bGPSValid = have_fix || g_sim;
    if (!have_fix && !g_sim) {
      if (tick % 10 == 0) std::printf("nav idle: waiting for fresh live position, SOG, and COG\n");
      std::this_thread::sleep_for(std::chrono::seconds(1));
      continue;
    }
    // route-walk simulation — only meaningful with an active route. In live mode real data overrides
    // these; a route-less live vessel skips it entirely and just shows position + AIS (no demo line).
    bool have_route = (route.size() >= 2 && r != nullptr);
    double sim_sog = 5.6 + std::sin(tick / 9.0) * 0.9;
    double sim_lat = gLat, sim_lon = gLon, sim_wspd = 14, sim_depth = 0, legBrg = 0;
    int sim_cog = 0, sim_hdg = 0, sim_wdir = 95; size_t li = 0;
    if (have_route) {
      along += sim_sog / 3600.0;
      if (along >= total) { along = 0; lastLeg = 0; g_pRouteMan->ActivateRoute(r); g_pRouteMan->ActivateNextPoint(r, false); }
      double acc = 0;
      while (li + 1 < legLen.size() && acc + legLen[li] < along) { acc += legLen[li]; ++li; }
      double f = legLen[li] ? (along - acc) / legLen[li] : 0;
      const WP& A = route[li]; const WP& B = route[li + 1];
      while (lastLeg < li) { g_pRouteMan->ActivateNextPoint(r, false); ++lastLeg; }
      sim_lat = A.lat + (B.lat - A.lat) * f; sim_lon = A.lon + (B.lon - A.lon) * f;
      double segNM; bd(B.lat, B.lon, A.lat, A.lon, &legBrg, &segNM);
      sim_cog = (int)std::lround(legBrg);
      sim_hdg = ((int)std::lround(legBrg) + (int)std::lround(std::sin(tick / 7.0) * 4) + 360) % 360;
      sim_wspd = 14 + std::sin(tick / 11.0) * 3;
      sim_wdir = ((int)std::lround(95 + std::sin(tick / 13.0) * 10) + 360) % 360;
      sim_depth = 6 + (1 - f) * 8 + std::sin(tick / 5.0) * 0.6;
    }

    double sog, depth, wspd; int cog, hdg, wdir;
    const char *src_pos, *src_sog, *src_cog, *src_hdg, *src_depth, *src_wind;
    { std::lock_guard<std::mutex> lk(g_real.m);
      if (fresh(g_real.pos_t)) { gLat = g_real.lat; gLon = g_real.lon; src_pos = g_real.pos_src; } else { gLat = sim_lat; gLon = sim_lon; src_pos = "simulated"; }
      if (fresh(g_real.sog.t)) { sog = g_real.sog.v; src_sog = g_real.sog.src; } else { sog = sim_sog; src_sog = "simulated"; }
      if (fresh(g_real.cog.t)) { cog = (int)std::lround(g_real.cog.v); src_cog = g_real.cog.src; } else { cog = sim_cog; src_cog = "simulated"; }
      if (fresh(g_real.hdg.t)) { hdg = (int)std::lround(g_real.hdg.v) % 360; src_hdg = g_real.hdg.src; } else if (g_sim) { hdg = sim_hdg; src_hdg = "simulated"; } else { hdg = 0; src_hdg = "missing"; }
      if (fresh(g_real.depth.t)) { depth = g_real.depth.v; src_depth = g_real.depth.src; } else if (g_sim) { depth = sim_depth; src_depth = "simulated"; } else { depth = 0; src_depth = "missing"; }
      if (fresh(g_real.wspd.t)) { wspd = g_real.wspd.v; src_wind = g_real.wspd.src; } else if (g_sim) { wspd = sim_wspd; src_wind = "simulated"; } else { wspd = 0; src_wind = "missing"; }
      wdir = fresh(g_real.wdir.t) ? (int)std::lround(g_real.wdir.v) : (g_sim ? sim_wdir : 0);
    }
    gCog = (double)cog; gSog = sog;   // own-ship course/speed -> OpenCPN's UpdateOneCPA (gLat/gLon set above)
    track_record(gLat, gLon, src_pos);  // ownship breadcrumb trail (auto; resets on source change so sim→real doesn't draw across the ocean)
    alarm_eval(gLat, gLon, depth, src_depth);   // CONTRACT-10 producer: headless anchor-drag / depth watch (runs even with no client)
    // Route metrics (DTG/XTE/ETA/legs) only exist with an active route; default to none otherwise so
    // a route-less boat still emits a valid position frame (no route line, no fabricated waypoint math).
    std::time_t now = std::time(nullptr);
    double dtg = 0, xteNM = 0, vmg = 0, dtw = 0;
    char etabuf[40]; std::snprintf(etabuf, sizeof etabuf, "—");
    std::string ttg = "—", legs = "[]", nextShort = "—";
    if (have_route) {
      RoutePoint* act = g_pRouteMan->GetpActivePoint();
      double brgW = 0; if (act) bd(act->GetLatitude(), act->GetLongitude(), gLat, gLon, &brgW, &dtw);
      dtg = dtw; for (size_t k = li + 1; k < legLen.size(); ++k) dtg += legLen[k];
      double brgAP, dAP; bd(gLat, gLon, route[li].lat, route[li].lon, &brgAP, &dAP);
      xteNM = std::fabs(std::asin(std::sin(dAP / 3440.065) * std::sin((brgAP - legBrg) * M_PI / 180.0)) * 3440.065);
      double hoursToGo = dtg / std::max(0.1, sog);
      std::time_t etaT = now + (std::time_t)(hoursToGo * 3600.0);
      std::strftime(etabuf, sizeof etabuf, "%I:%M %p \xC2\xB7 %a %d %b", std::localtime(&etaT));
      ttg = fmtDur(hoursToGo);
      vmg = sog * std::cos((brgW - cog) * M_PI / 180.0);
      std::string actName = act ? std::string(act->GetName().ToUTF8()) : "—";
      nextShort = actName.substr(0, actName.find(" \xC2\xB7 "));
      legs = "[";
      for (size_t k = li + 1; k < route.size() && k <= li + 2; ++k) {
        const WP& from = (k == li + 1) ? WP{gLat, gLon, ""} : route[k - 1];
        double lb, ld; bd(route[k].lat, route[k].lon, from.lat, from.lon, &lb, &ld);
        char lbuf[160];
        std::snprintf(lbuf, sizeof lbuf, "%s{\"name\":\"%s\",\"brg\":\"%ld\xC2\xB0\",\"active\":%s}",
                      k == li + 1 ? "" : ",", json_escape(route[k].name).c_str(), std::lround(lb), k == li + 1 ? "true" : "false");
        legs += lbuf;
      }
      legs += "]";
    }

    long seq = ++g_seq; double ts = (double)now; bool keyframe = (tick % 10 == 0);
    char snap[1700];
    int snlen = std::snprintf(snap, sizeof snap,
      "{\"t\":\"snapshot\",\"seq\":%ld,\"ts\":%.3f,\"type\":\"nav\",\"posSource\":\"%s\","
      "\"sources\":{\"pos\":\"%s\",\"sog\":\"%s\",\"cog\":\"%s\",\"hdg\":\"%s\",\"depth\":\"%s\",\"wind\":\"%s\"},"
      "\"pos\":{\"lat\":%.5f,\"lon\":%.5f},\"posStr\":\"%s\","
      "\"sog\":%.1f,\"cog\":%d,\"hdg\":%d,\"depth\":%.1f,"
      "\"wind\":{\"spd\":%.0f,\"dir\":%d,\"range\":\"%ld\xE2\x80\x93%ld kt\"},"
      "\"active\":{\"name\":\"%s\",\"eta\":\"%s\",\"ttg\":\"%s\",\"vmg\":\"%.1f kn\","
      "\"dtg\":\"%s\",\"xte\":\"%d m\",\"legs\":%s,\"nextWp\":\"%s \xC2\xB7 %s\"}}",
      seq, ts, src_pos, src_pos, src_sog, src_cog, src_hdg, src_depth, src_wind,
      gLat, gLon, fmtPos(gLat, gLon).c_str(), sog, cog, hdg, depth,
      wspd, wdir, std::lround(wspd - 4), std::lround(wspd + 8),
      json_escape(g_route_name).c_str(),
      etabuf, ttg.c_str(), vmg, fmtNM(dtg).c_str(), (int)std::lround(xteNM * 1852),
      legs.c_str(), json_escape(nextShort).c_str(), fmtNM(dtw).c_str());

    std::string frame; bool truncated = (snlen < 0 || (size_t)snlen >= sizeof snap);
    if (keyframe) { frame = snap; }
    else {
      char dlt[1100];
      int dlen = std::snprintf(dlt, sizeof dlt,
        "{\"t\":\"delta\",\"seq\":%ld,\"ts\":%.3f,\"posSource\":\"%s\","
        "\"sources\":{\"pos\":\"%s\",\"sog\":\"%s\",\"cog\":\"%s\",\"hdg\":\"%s\",\"depth\":\"%s\",\"wind\":\"%s\"},"
        "\"pos\":{\"lat\":%.5f,\"lon\":%.5f},\"posStr\":\"%s\","
        "\"sog\":%.1f,\"cog\":%d,\"hdg\":%d,\"depth\":%.1f,"
        "\"active\":{\"dtg\":\"%s\",\"xte\":\"%d m\",\"eta\":\"%s\",\"ttg\":\"%s\",\"vmg\":\"%.1f kn\",\"nextWp\":\"%s \xC2\xB7 %s\"}}",
        seq, ts, src_pos, src_pos, src_sog, src_cog, src_hdg, src_depth, src_wind,
        gLat, gLon, fmtPos(gLat, gLon).c_str(), sog, cog, hdg, depth,
        fmtNM(dtg).c_str(), (int)std::lround(xteNM * 1852), etabuf, ttg.c_str(), vmg, json_escape(nextShort).c_str(), fmtNM(dtw).c_str());
      truncated = truncated || dlen < 0 || (size_t)dlen >= sizeof dlt;
      frame = dlt;
      if (tick % 5 == 0) {
        char wbuf[160];
        int wlen = std::snprintf(wbuf, sizeof wbuf, "\"wind\":{\"spd\":%.0f,\"dir\":%d,\"range\":\"%ld\xE2\x80\x93%ld kt\"},",
          wspd, wdir, std::lround(wspd - 4), std::lround(wspd + 8));
        truncated = truncated || wlen < 0 || (size_t)wlen >= sizeof wbuf;
        frame.insert(frame.find("\"active\""), wbuf);
      }
    }
    if (truncated) { std::fprintf(stderr, "ERROR: nav frame seq %ld truncated; NOT sending.\n", seq); std::this_thread::sleep_for(std::chrono::seconds(1)); continue; }

    // AIS targets (OpenCPN-computed range/brg/CPA/TCPA). CONTRACT-8: build a per-target {lat,lon,json}
    // vector ONCE, then each client gets either the full set or only the targets inside its viewport
    // bbox. (Dynamic strings, not fixed buffers, so a busy harbour can't truncate the nav frame.)
    struct AisJ { double lat, lon; std::string j; };
    std::vector<AisJ> aisTargets;
    { std::lock_guard<std::mutex> lk(g_ais_mtx);
      std::time_t aisNow = std::time(nullptr);
      for (auto it = g_ais_rows.begin(); it != g_ais_rows.end(); ) {
        AisRow& t = it->second; long age = (long)(aisNow - t.seen);
        if (age > 600) { it = g_ais_rows.erase(it); continue; }
        if ((t.lat == 0.0 && t.lon == 0.0) || t.lat < -90 || t.lat > 90) { ++it; continue; }  // no real position yet (static-only target) — don't emit a ghost at (0,0)
        char eta[16] = "";                            // MM-DD HH:MM when the voyage ETA is set
        if (t.etaMo >= 1 && t.etaMo <= 12 && t.etaDay >= 1 && t.etaDay <= 31)
          std::snprintf(eta, sizeof eta, "%02d-%02d %02d:%02d", t.etaMo, t.etaDay, t.etaHr, t.etaMin);
        char rotj[16] = "null";                       // AIS ROT units -> deg/min; -128/128 = not available
        if (t.rot != -128 && t.rot != 128) {
          double a = std::fabs((double)t.rot) / 4.733, dm = (t.rot < 0 ? -1.0 : 1.0) * a * a;
          if (dm > 720) dm = 720; if (dm < -720) dm = -720;
          std::snprintf(rotj, sizeof rotj, "%.0f", dm);
        }
        // AIS "not available" sentinels -> JSON null so a client never renders them as REAL data:
        // SOG 1023 decodes to 102.3 kn (a moored Class-B with no GPS-speed source), COG 3600 -> 360 deg.
        // A target with no real speed also has no meaningful CPA, so report cpaValid=false for it rather
        // than feed a 102.3-kn ghost into the collision math (which would raise false CPA alarms).
        bool sog_ok = (t.sog >= 0.0 && t.sog <= 102.2);
        char sogj[16] = "null"; if (sog_ok) std::snprintf(sogj, sizeof sogj, "%.1f", t.sog);
        char cogj[16] = "null"; if (t.cog >= 0.0 && t.cog < 360.0) std::snprintf(cogj, sizeof cogj, "%.0f", t.cog);
        bool cpaEff = (t.cpaValid && sog_ok);     // effective CPA validity (a no-real-speed target has no real CPA)
        // ENGINE-13: per-target collision-risk tier, computed from the SAME g_CPAWarn_NM/g_TCPA_Max alarm
        // band the client uses (web/ais-risk.js tier()); caution = the 2x pre-alarm watch band. Clients
        // prefer this engine value over recomputing locally, so the thresholds live in ONE authoritative place.
        const char* risk = (!cpaEff || t.tcpa <= 0.0 || t.sog < g_minTargetSog) ? "normal"   // profile speed gate: slow/moored vessels aren't a collision risk (guard zone still catches close ones)
          : (t.cpa < g_CPAWarn_NM && t.tcpa < g_TCPA_Max) ? "danger"
          : (t.cpa < 2.0 * g_CPAWarn_NM && t.tcpa < 2.0 * g_TCPA_Max) ? "caution" : "normal";
        char tb[800];
        std::snprintf(tb, sizeof tb,
          "{\"mmsi\":%d,\"lat\":%.5f,\"lon\":%.5f,\"cog\":%s,\"sog\":%s,\"hdg\":%.0f,"
          "\"range\":%.2f,\"brg\":%.0f,\"cpa\":%.2f,\"tcpa\":%.1f,\"cpaValid\":%s,\"risk\":\"%s\","
          "\"class\":%d,\"name\":\"%s\",\"ageSec\":%ld,\"source\":\"%s\","
          "\"navStatus\":%d,\"shipType\":%d,\"callsign\":\"%s\",\"destination\":\"%s\","
          "\"eta\":\"%s\",\"length\":%d,\"beam\":%d,\"draught\":%.1f,\"rot\":%s,\"imo\":%d,"
          "\"posDoubtful\":%s,\"sar\":%s,\"altitude\":%d}",
          t.mmsi, t.lat, t.lon, cogj, sogj, t.hdg,
          t.range, t.brg, t.cpa, t.tcpa, cpaEff ? "true" : "false", risk,
          t.cls, json_escape(t.name).c_str(), age, json_escape(t.source).c_str(),
          t.navStatus, t.shipType, json_escape(t.callsign).c_str(), json_escape(t.destination).c_str(),
          eta, t.length, t.beam, t.draft, rotj, t.imo,
          t.posDoubtful ? "true" : "false", t.sarAircraft ? "true" : "false", t.altitude);
        std::string tj(tb);
        if (!t.metJson.empty()) tj.insert(tj.size() - 1, ",\"met\":" + t.metJson);   // AIS-11: splice the weather-station block in before the closing brace
        aisTargets.push_back({ t.lat, t.lon, tj }); ++it;
      }
    }
    std::string connsArr = conn_status_array();   // live per-connection status, streamed to clients
    // Track (ownship breadcrumb): full trail into snapshots (new/reloaded clients get the whole line),
    // only the newly-added points into deltas (tiny). g_track_emitted advances once per tick.
    std::string trackFull = "[", trackAdd = "[";
    std::string armedJson = g_track_armed.load() ? "true" : "false";
    { std::lock_guard<std::mutex> lk(g_track_mtx);
      for (size_t i = 0; i < g_track.size(); ++i) { char tb[48]; std::snprintf(tb, sizeof tb, "%s[%.5f,%.5f]", i ? "," : "", g_track[i].lat, g_track[i].lon); trackFull += tb; }
      size_t from = std::min(g_track_emitted, g_track.size());
      for (size_t i = from; i < g_track.size(); ++i) { char tb[48]; std::snprintf(tb, sizeof tb, "%s[%.5f,%.5f]", (i == from) ? "" : ",", g_track[i].lat, g_track[i].lon); trackAdd += tb; }
      g_track_emitted = g_track.size();
    }
    trackFull += "]"; trackAdd += "]";
    // Active route geometry (full line + active-leg index) so the client redraws the line on change.
    // Routes are small (a handful of waypoints), so it rides every frame — coords are [lon,lat].
    std::string routeArr = "[", namesArr = "[";
    for (size_t i = 0; i < route.size(); ++i) {
      char rb[40]; std::snprintf(rb, sizeof rb, "%s[%.5f,%.5f]", i ? "," : "", route[i].lon, route[i].lat); routeArr += rb;
      namesArr += (i ? "," : "") + ("\"" + json_escape(route[i].name) + "\"");   // per-waypoint names → editor round-trip
    }
    routeArr += "]"; namesArr += "]";
    std::string routeJson = "{\"coords\":" + routeArr + ",\"names\":" + namesArr + ",\"activeLeg\":" + std::to_string((long)li) + ",\"name\":\"" + json_escape(rname) + "\"}";
    // CONTRACT-7: per-client channel filtering + rate pacing. Build each channel as a FRAGMENT once;
    // every client gets nav-core (always) plus only the fragments for the channels it subscribed to,
    // paced to its effective rate. A new client always gets its first snapshot immediately.
    const std::string coreSnap(snap);                       // nav core (the 'nav' channel) — snapshot form
    const std::string coreDelta = keyframe ? std::string() : frame;   // 'frame' here is the nav-core delta (+wind)
    const std::string fConns  = ",\"conns\":" + connsArr;   // ('ais' is built per-client below — CONTRACT-8 bbox cull)
    const std::string fTrackS = ",\"track\":" + trackFull + ",\"trackArmed\":" + armedJson;
    const std::string fTrackD = ",\"trackAdd\":" + trackAdd + ",\"trackArmed\":" + armedJson;
    const std::string fRoute  = ",\"route\":" + routeJson;

    auto clients = server->getClients();
    std::set<ix::WebSocket*> live;
    for (auto& c : clients) live.insert(c.get());
    std::vector<std::pair<std::shared_ptr<ix::WebSocket>, std::string>> outbox;
    {
      std::lock_guard<std::mutex> lk(g_client_cfg_mtx);
      for (auto& c : clients) {
        ix::WebSocket* key = c.get();
        ClientCfg& cfg = g_client_cfg[key];                 // hello-less clients default to ALL channels @ 1 Hz
        const bool isNew = !g_seen.count(key) || cfg.forceSnapshot;   // CONTRACT-6: hello/lastSeq forces a snapshot
        cfg.forceSnapshot = false;
        int everyN = NAV_SOURCE_HZ / (cfg.rate < 1 ? 1 : cfg.rate); if (everyN < 1) everyN = 1;
        if (!isNew && cfg.lastSentTick >= 0 && (tick - cfg.lastSentTick) < everyN) continue;   // rate pacing
        cfg.lastSentTick = tick;
        std::string out = (isNew || coreDelta.empty()) ? coreSnap : coreDelta;   // new client / keyframe → snapshot
        const bool snapVariant = isNew || keyframe;
        if (cfg.channels.count("route")) out.insert(out.size() - 1, fRoute);
        if (cfg.channels.count("ais")) {                 // CONTRACT-8: bbox-cull the AIS array per client
          std::string ais = "[";
          for (size_t i = 0, n = 0; i < aisTargets.size(); ++i)
            if (cfg.inBbox(aisTargets[i].lat, aisTargets[i].lon)) ais += std::string(n++ ? "," : "") + aisTargets[i].j;
          ais += "]";
          out.insert(out.size() - 1, ",\"ais\":" + ais);
        }
        if (cfg.channels.count("conns")) out.insert(out.size() - 1, fConns);
        if (cfg.channels.count("track")) out.insert(out.size() - 1, snapVariant ? fTrackS : fTrackD);
        outbox.emplace_back(c, std::move(out));
      }
      for (auto it = g_client_cfg.begin(); it != g_client_cfg.end(); )   // drop disconnected clients
        it = live.count(it->first) ? std::next(it) : g_client_cfg.erase(it);
    }
    for (auto& p : outbox) p.first->send(p.second);

    // CONTRACT-10 producer: per-client alarm delivery — resend each active alarm (and pending clears)
    // until THIS client transport-ACKs its (gen,rev). New/reconnected clients re-get every active alarm.
    std::vector<std::pair<std::shared_ptr<ix::WebSocket>, std::string>> alarmOut;
    { std::lock_guard<std::mutex> lkA(g_alarm_mtx);
      std::lock_guard<std::mutex> lkC(g_client_cfg_mtx);
      for (auto& c : clients) {
        ClientCfg& cfg = g_client_cfg[c.get()];
        if (!cfg.channels.count("alarms")) continue;
        for (auto& kv : g_alarms) {
          const AlarmState& a = kv.second;
          std::string tok = std::to_string(a.gen) + "." + std::to_string(a.rev);
          auto ai = cfg.alarmAcked.find(a.id);
          if (ai != cfg.alarmAcked.end() && ai->second == tok) continue;   // already ACKed this rev
          alarmOut.emplace_back(c, a.active ? alarm_raise_json(a) : alarm_clear_json(a));
        }
      }
    }
    for (auto& p : alarmOut) p.first->send(p.second);
    g_seen.swap(live);

    // CONN-7: reconcile raw-monitor subscribers against the current clients (self-heals on
    // disconnect), then flush the sentences captured since the last tick to those still monitoring.
    { std::set<ix::WebSocket*> cur; for (auto& c : clients) cur.insert(c.get());
      std::lock_guard<std::mutex> lk(g_monitors_mtx);
      for (auto it = g_monitors.begin(); it != g_monitors.end(); )
        it = cur.count(*it) ? std::next(it) : g_monitors.erase(it);
      g_monitoring_any.store(!g_monitors.empty());
    }
    if (g_monitoring_any.load()) {
      std::vector<RawLine> batch;
      { std::lock_guard<std::mutex> lk(g_raw_mtx); batch.swap(g_raw_pending); }
      if (!batch.empty()) {
        std::string rj = "{\"t\":\"nmea.raw\",\"lines\":[";
        for (size_t i = 0; i < batch.size(); ++i)
          rj += std::string(i ? "," : "") + "{\"conn\":\"" + json_escape(batch[i].conn) +
                "\",\"ts\":" + std::to_string(batch[i].ts) + ",\"line\":\"" + json_escape(batch[i].line) + "\"}";
        rj += "]}";
        std::lock_guard<std::mutex> lk(g_monitors_mtx);
        for (auto& c : clients) if (g_monitors.count(c.get())) c->send(rj);
      }
    }
    if (tick % 10 == 0)
      std::printf("  [%ld] seq %ld %-5s %s [%s]  SOG %.1f  DTG %s  -> %s  (clients: %zu)\n",
                  tick, seq, keyframe ? "snap" : "delta", fmtPos(gLat, gLon).c_str(), src_pos, sog,
                  fmtNM(dtg).c_str(), nextShort.c_str(), clients.size());
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}

// ===========================================================================
// Bonjour (_helm._tcp) — system dns_sd; lets an iPad discover "Helm Engine".
// ===========================================================================
static std::string g_tls_fingerprint;            // SHA-256 of the serving cert (set by setup_tls below; empty if plaintext)
static void bonjour_advertise(int port) {
  static DNSServiceRef ref = nullptr;
  // CONTRACT-13: TXT record so a discovering client (native NWBrowser) can label the boat and decide
  // transport BEFORE connecting. v=protocol version, name=human boat name, tls=1 + fp=<cert sha256>
  // when the TLS origin (CONTRACT-12) is on so the client can TOFU-pin the cert ahead of connecting.
  const char* nmEnv = std::getenv("HELM_NAME");
  std::string name = (nmEnv && *nmEnv) ? nmEnv : "Helm Engine";
  const bool tlsOn = !g_tls_fingerprint.empty();
  TXTRecordRef txt; TXTRecordCreate(&txt, 0, nullptr);
  TXTRecordSetValue(&txt, "v", 1, "1");
  TXTRecordSetValue(&txt, "name", (uint8_t)std::min(name.size(), (size_t)255), name.c_str());
  TXTRecordSetValue(&txt, "tls", 1, tlsOn ? "1" : "0");
  if (tlsOn) TXTRecordSetValue(&txt, "fp", (uint8_t)std::min(g_tls_fingerprint.size(), (size_t)255), g_tls_fingerprint.c_str());
  DNSServiceErrorType err = DNSServiceRegister(
    &ref, 0, 0, name.c_str(), "_helm._tcp", nullptr, nullptr, htons((uint16_t)port),
    TXTRecordGetLength(&txt), TXTRecordGetBytesPtr(&txt), nullptr, nullptr);
  TXTRecordDeallocate(&txt);
  if (err != kDNSServiceErr_NoError) { std::fprintf(stderr, "Bonjour: register failed (%d) — discovery off\n", err); return; }
  std::printf("Bonjour: advertising _helm._tcp on %d as \"%s\" (v=1 tls=%s%s)\n", port, name.c_str(), tlsOn ? "1" : "0", tlsOn ? " +fp" : "");
  std::thread([] { for (;;) { if (DNSServiceProcessResult(ref) != kDNSServiceErr_NoError) break; } }).detach();
}

// ===========================================================================
// CONTRACT-12: one TLS origin. The whole stack (nav WS + chart HTTP + catalog/health/pair) rides a
// single ix::HttpServer; setting TLS on its SocketServer base makes that ONE port wss+https. Opt-in
// via HELM_TLS_CERT + HELM_TLS_KEY (PEM); HELM_TLS_AUTO=1 self-signs a no-CA cert (TOFU model — the
// client pins the fingerprint, there is no CA). The cert SHA-256 fingerprint is exposed for the
// Bonjour TXT (CONTRACT-13) and TOFU pairing (CONTRACT-14). Plain HTTP when unset (dev). ixwebsocket
// is built USE_TLS+USE_OPEN_SSL, so this is a front-door wrapper, not new infra.
// ===========================================================================
static bool setup_tls(ix::HttpServer* server, const char* bindHost) {   // sets g_tls_fingerprint (declared above, near bonjour)
  const char* certEnv = std::getenv("HELM_TLS_CERT");
  const char* keyEnv  = std::getenv("HELM_TLS_KEY");
  if (!certEnv || !*certEnv || !keyEnv || !*keyEnv) {
    std::printf("TLS: disabled (set HELM_TLS_CERT + HELM_TLS_KEY for one wss/https origin; +HELM_TLS_AUTO=1 to self-sign)\n");
    return false;
  }
  std::string cert = certEnv, key = keyEnv;
  if (access(cert.c_str(), R_OK) != 0 || access(key.c_str(), R_OK) != 0) {     // missing → self-sign if allowed
    if (!std::getenv("HELM_TLS_AUTO")) { std::fprintf(stderr, "TLS: FATAL — cert/key not readable (%s) and HELM_TLS_AUTO unset\n", cert.c_str()); return false; }
    std::string san = "DNS:helm.local,DNS:localhost,IP:127.0.0.1";
    if (std::strcmp(bindHost, "127.0.0.1") && std::strcmp(bindHost, "0.0.0.0")) san += ",IP:" + std::string(bindHost);
    std::string cmd = "openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=Helm' -addext 'subjectAltName=" + san + "' -keyout '" + key + "' -out '" + cert + "' >/dev/null 2>&1";
    std::printf("TLS: self-signing cert -> %s (no CA; TOFU fingerprint pinning)\n", cert.c_str());
    if (std::system(cmd.c_str()) != 0 || access(cert.c_str(), R_OK) != 0) { std::fprintf(stderr, "TLS: FATAL — self-sign failed (is openssl on PATH?)\n"); return false; }
  }
  // SHA-256 fingerprint via the openssl CLI (no extra link deps) — for Bonjour TXT + TOFU pairing.
  std::string fpcmd = "openssl x509 -in '" + cert + "' -noout -fingerprint -sha256 2>/dev/null";
  if (FILE* f = popen(fpcmd.c_str(), "r")) {
    char buf[256]; if (fgets(buf, sizeof buf, f)) { std::string s = buf; size_t eq = s.find('=');
      if (eq != std::string::npos) { g_tls_fingerprint = s.substr(eq + 1);
        while (!g_tls_fingerprint.empty() && (g_tls_fingerprint.back() == '\n' || g_tls_fingerprint.back() == '\r')) g_tls_fingerprint.pop_back(); } }
    pclose(f);
  }
  ix::SocketTLSOptions opts; opts.tls = true; opts.certFile = cert; opts.keyFile = key;
  opts.caFile = "NONE";   // no mTLS — clients pin the SERVER cert fingerprint (TOFU); default "SYSTEM" would demand a client cert
  server->setTLSOptions(opts);
  std::printf("TLS: ENABLED — one wss+https origin (cert=%s)\n     fingerprint(sha256)=%s\n", cert.c_str(), g_tls_fingerprint.c_str());
  return true;
}

// ===========================================================================
// One ix::HttpServer; HTTP callback routes tiles/health/catalog/static, WS
// callback handles /nav. Tiles render on the MAIN thread (CoreGraphics).
// ===========================================================================
class ServerApp : public wxApp {
public:
  ix::HttpServer* server = nullptr;
  bool OnInit() override {
    SetAppName(wxT("opencpn"));
    const char* enc = std::getenv("HELM_ENC");
    wxString encPath = enc && *enc ? wxString::FromUTF8(enc) : wxString::FromUTF8(helm_runtime_path("enc/US5FL4CR/US5FL4CR.000").c_str());
    if (!init_chart(encPath)) return false;
    if (!std::getenv("HELM_TILES_NO_WARMUP")) warmup_render();

    const char* webroot = std::getenv("HELM_WEB_ROOT");
    g_webroot = webroot && *webroot ? webroot : "web";
    const char* userDataRoot = std::getenv("HELM_USER_DATA_ROOT");
    g_user_data_root = userDataRoot && *userDataRoot ? userDataRoot : helm_config_dir() + "/data";

    const char* bindHost = std::getenv("HELM_BIND"); if (!bindHost || !*bindHost) bindHost = "127.0.0.1";
    int port = 8080;
    if (const char* p = std::getenv("HELM_PORT")) {
      char* end = nullptr; long v = std::strtol(p, &end, 10);
      if (end == p || *end != '\0' || v < 1 || v > 65535) { printf("FATAL: HELM_PORT=\"%s\" invalid (1-65535)\n", p); return false; }
      port = (int)v;
    }

    server = new ix::HttpServer(port, bindHost);
    const bool tls = setup_tls(server, bindHost);   // CONTRACT-12: one wss+https origin when configured

    // WS side (/nav): set on the WebSocketServer base (HttpServer::handleUpgrade uses it).
    server->WebSocketServer::setOnConnectionCallback(
      [](std::weak_ptr<ix::WebSocket> wptr, std::shared_ptr<ix::ConnectionState> cs) {
        if (auto ws = wptr.lock()) {
          std::weak_ptr<ix::WebSocket> wk = ws;                  // capture weak to avoid a ref cycle
          ws->setOnMessageCallback([wk](const ix::WebSocketMessagePtr& m) {
            if (m->type == ix::WebSocketMessageType::Open) {     // CONTRACT-15: resolve the bearer token → role (or reject)
              if (auto s = wk.lock()) {
                std::string role = g_require_auth ? token_role(extract_token(m->openInfo.uri, m->openInfo.headers)) : std::string("owner");
                if (g_require_auth && role.empty()) { s->close(4401, "unauthorized — pair first"); return; }
                std::lock_guard<std::mutex> lk(g_client_cfg_mtx); g_client_cfg[s.get()].role = role;
              }
            } else if (m->type == ix::WebSocketMessageType::Message)    // command-plane: conn.list/upsert/delete
              if (auto s = wk.lock()) handle_command(m->str, s);
          });
        }
        std::printf("nav client connected: %s\n", cs->getId().c_str()); std::fflush(stdout);
      });

    // HTTP side: tiles, health, catalog, then the static UI.
    server->setOnConnectionCallback(
      [](ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState>) -> ix::HttpResponsePtr {
        ix::WebSocketHttpHeaders h; h["Access-Control-Allow-Origin"] = "*";
        const std::string path = req->uri.substr(0, req->uri.find('?'));   // route on the PATH — a ?token= query must not break exact-match routes
        if (g_require_auth) {                        // CONTRACT-15: gate chart tiles + catalog on a paired token (UI/health/pair stay open)
          bool prot = (path.rfind("/chart/", 0) == 0) || (path == "/catalog");
          if (prot && token_role(extract_token(req->uri, req->headers)).empty()) {
            h["Content-Type"] = "application/json";
            return std::make_shared<ix::HttpResponse>(401, "Unauthorized", ix::HttpErrorCode::Ok, h, std::string("{\"ok\":false,\"error\":\"unauthorized — pair first\"}"));
          }
        }
        int z; long x, y;
        if (std::sscanf(req->uri.c_str(), "/chart/%d/%ld/%ld.png", &z, &x, &y) == 3) {
          const ColorScheme pal = palette_from_query(req->uri);   // CHART-8: ?p=day|dusk|night
          const DisCat cat = category_from_query(req->uri);       // CHART-9: ?cat=base|std|all|mariner
          auto serve_legacy_tile = [&](const char* fallback_reason) -> ix::HttpResponsePtr {
            h.erase("X-Helm-Renderer-Sha");
            h.erase("X-Helm-Scene-Schema");
            h.erase("X-Helm-Chart-Epoch");
            h.erase("X-Helm-Renderer-Cache-Key");
            h.erase("X-Helm-Renderer-Output-Sha");
            h.erase("X-Helm-Renderer-Error");
            h["X-Helm-Renderer"] = "legacy";
            h["X-Helm-Chart-Status"] = g_chart_status;
            if (!g_chart_unavailable_reason.empty()) h["X-Helm-Chart-Unavailable-Reason"] = header_safe(g_chart_unavailable_reason);
            if (fallback_reason && *fallback_reason) h["X-Helm-Renderer-Fallback"] = fallback_reason;
            else h.erase("X-Helm-Renderer-Fallback");
            char et[128]; std::snprintf(et, sizeof et, "\"%s.%s.%s.s%d\"", g_cell_name.c_str(), palette_name(pal), cat_name(cat), g_native_scale);
            const std::string etag(et);
            h["Cache-Control"] = "public, max-age=31536000, immutable"; h["ETag"] = etag;
            if (header_ci(req->headers, "If-None-Match") == etag)
              return std::make_shared<ix::HttpResponse>(304, "Not Modified", ix::HttpErrorCode::Ok, h, std::string());
            Job job; job.z = z; job.x = x; job.y = y; job.palette = pal; job.cat = cat;
            { std::lock_guard<std::mutex> lk(g_jobs_m); g_jobs.push_back(&job); }
            g_jobs_cv.notify_one();
            { std::unique_lock<std::mutex> lk(job.m); job.cv.wait(lk, [&]{ return job.done; }); }
            switch (job.status) {
              case TileStatus::Ok: h["Content-Type"] = "image/png";
                // CHART-9: overzoom warning — viewing finer than the cell's survey scale (SCAMIN hides detail).
                { double ds = display_scale(z, tile_lat(y + 0.5, z));
                  if (g_native_scale > 0 && ds > 0 && (double)g_native_scale / ds >= 2.0) {
                    char oz[32]; std::snprintf(oz, sizeof oz, "%.1fx", (double)g_native_scale / ds);
                    h["X-Helm-Overzoom"] = oz; } }
                return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, job.result);
              case TileStatus::NoCoverage: h["Content-Type"] = "image/png";
                if (!g_chart) h["X-Helm-Chart-Status"] = "unavailable";
                return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, g_blank);
              case TileStatus::BadRequest: h["Content-Type"] = "text/plain"; h["Cache-Control"] = "no-store"; h.erase("ETag");
                return std::make_shared<ix::HttpResponse>(400, "Bad Request", ix::HttpErrorCode::Ok, h, std::string("invalid tile coordinates\n"));
              default: h["Content-Type"] = "text/plain"; h["Cache-Control"] = "no-store"; h.erase("ETag");
                return std::make_shared<ix::HttpResponse>(500, "Render Failed", ix::HttpErrorCode::Ok, h, std::string("S-52 tile render failed; see server log\n"));
            }
          };

          if (chart_renderer_for_request(req->uri) == ChartRendererChoice::Vulkan) {
            if (z < 0 || z > 24 || x < 0 || y < 0 || x >= (1L << z) || y >= (1L << z)) {
              h["Content-Type"] = "text/plain"; h["Cache-Control"] = "no-store"; h.erase("ETag");
              h["X-Helm-Renderer"] = "vulkan";
              return std::make_shared<ix::HttpResponse>(400, "Bad Request", ix::HttpErrorCode::Ok, h, std::string("invalid tile coordinates\n"));
            }
            const VulkanTileMeta meta = make_vulkan_tile_meta(z, x, y, pal, cat);
            h["X-Helm-Renderer"] = "vulkan";
            h["X-Helm-Renderer-Sha"] = header_safe(meta.renderer_sha);
            h["X-Helm-Scene-Schema"] = header_safe(meta.scene_schema);
            h["X-Helm-Chart-Epoch"] = header_safe(meta.chart_epoch);
            h["X-Helm-Renderer-Cache-Key"] = meta.cache_key_hash;
            std::string png, error;
            const TileStatus vst = render_vulkan_tile(z, x, y, meta, png, error);
            if (vst == TileStatus::Ok) {
              const std::string output_sha = sha256_hex(png);
              const std::string etag = vulkan_etag(meta, output_sha);
              h["Content-Type"] = "image/png";
              h["Cache-Control"] = "public, max-age=31536000, immutable";
              h["ETag"] = etag;
              h["X-Helm-Renderer-Output-Sha"] = output_sha;
              if (header_ci(req->headers, "If-None-Match") == etag)
                return std::make_shared<ix::HttpResponse>(304, "Not Modified", ix::HttpErrorCode::Ok, h, std::string());
              return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, png);
            }
            if (vst == TileStatus::BadRequest) {
              h["Content-Type"] = "text/plain"; h["Cache-Control"] = "no-store"; h.erase("ETag");
              h["X-Helm-Renderer-Error"] = header_safe(error);
              return std::make_shared<ix::HttpResponse>(400, "Bad Request", ix::HttpErrorCode::Ok, h, std::string("invalid tile coordinates\n"));
            }
            h["X-Helm-Renderer-Error"] = header_safe(error);
            if (vulkan_fallback_to_legacy_requested(req->uri))
              return serve_legacy_tile("vulkan-render-failed");
            h["Content-Type"] = "text/plain"; h["Cache-Control"] = "no-store"; h.erase("ETag");
            return std::make_shared<ix::HttpResponse>(500, "Render Failed", ix::HttpErrorCode::Ok, h,
              std::string("Vulkan tile render failed; see server log\n"));
          }
          return serve_legacy_tile(nullptr);
        }
        if (req->uri.rfind("/query", 0) == 0) {   // CHART-10: GET /query?lat=&lon=[&z=][&radius=][&p=][&cat=] (worker thread: parse + marshal ONLY)
          const std::string& u = req->uri;
          auto getd = [&](const char* k, double& v) -> bool {   // key must follow '?' or '&' — no substring collisions
            const std::string key = k;
            for (size_t p = u.find(key); p != std::string::npos; p = u.find(key, p + 1))
              if (p > 0 && (u[p - 1] == '?' || u[p - 1] == '&'))
                return std::sscanf(u.c_str() + p + key.size(), "%lf", &v) == 1;
            return false;
          };
          double qlat, qlon, tmp;
          h["Cache-Control"] = "no-store";   // dynamic, unlike the immutable tiles
          if (!getd("lat=", qlat) || !getd("lon=", qlon)) { h["Content-Type"] = "text/plain";
            return std::make_shared<ix::HttpResponse>(400, "Bad Request", ix::HttpErrorCode::Ok, h, std::string("bad query params (need lat,lon)\n")); }
          Job job; job.kind = JobKind::Query; job.qlat = qlat; job.qlon = qlon;
          if (getd("z=", tmp)) job.z = (int)tmp;
          if (getd("radius=", tmp)) job.qradius_px = (int)tmp;
          job.palette = palette_from_query(u); job.cat = category_from_query(u);
          { std::lock_guard<std::mutex> lk(g_jobs_m); g_jobs.push_back(&job); }   // marshal onto the main thread, like /chart
          g_jobs_cv.notify_one();
          { std::unique_lock<std::mutex> lk(job.m); job.cv.wait(lk, [&]{ return job.done; }); }
          if (job.status == TileStatus::Ok) { h["Content-Type"] = "application/json";
            return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, job.result); }
          h["Content-Type"] = "text/plain";
          return std::make_shared<ix::HttpResponse>(job.status == TileStatus::BadRequest ? 400 : 500,
            job.status == TileStatus::BadRequest ? "Bad Request" : "Query Failed", ix::HttpErrorCode::Ok, h,
            std::string(job.status == TileStatus::BadRequest ? "no chart loaded\n" : "S-57 query failed; see server log\n"));
        }
        if (req->method == "POST" && path == "/pair") {   // CONTRACT-14: redeem a boot PIN for an owner bearer token
          h["Content-Type"] = "application/json";
          rapidjson::Document pd; std::string pin, nm;
          if (!pd.Parse(req->body.c_str()).HasParseError() && pd.IsObject()) {
            if (pd.HasMember("pin") && pd["pin"].IsString()) pin = pd["pin"].GetString();
            if (pd.HasMember("name") && pd["name"].IsString()) nm = pd["name"].GetString();
          }
          std::string tok = pair_redeem(pin, nm);
          if (tok.empty()) return std::make_shared<ix::HttpResponse>(403, "Forbidden", ix::HttpErrorCode::Ok, h, std::string("{\"ok\":false,\"error\":\"bad or closed pin\"}"));
          std::string pbody = "{\"ok\":true,\"token\":\"" + tok + "\",\"role\":\"owner\",\"fingerprint\":\"" + json_escape(g_tls_fingerprint) + "\",\"name\":\"" + json_escape(nm) + "\"}";
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, pbody);
        }
        if (path == "/health") { h["Content-Type"] = "application/json";
          std::string body = "{\"status\":\"ok\",\"engine\":\"helm-server\",\"chart_loaded\":" +
            std::string(g_chart ? "true" : "false") +
            ",\"chart_status\":\"" + json_escape(g_chart_status) + "\"";
          if (!g_chart_unavailable_reason.empty())
            body += ",\"chart_unavailable_reason\":\"" + json_escape(g_chart_unavailable_reason) + "\"";
          body += ",\"nav\":" + nav_health_json();
          body += "}";
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, body); }
        if (path == "/tides/summary") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_summary_json(req->uri)); }
        if (path == "/tides/providers") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES-9: audited official/provider region catalog
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_providers_json(req->uri)); }
        if (path == "/tides/currents") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES-3: valid-time current + observed/residual honesty contract
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_currents_json(req->uri)); }
        if (path == "/tides/resolve") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES-8: GPS/route/viewport source resolver + offline readiness
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_resolve_json(req->uri)); }
        if (path == "/tides/acquisition") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES-9: planner-only official cache acquisition manifest
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_acquisition_json(req->uri)); }
        if (path == "/tides/acquisition/status") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES-9: background official-cache acquisition runner status
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_auto_status_json()); }
        if (path == "/tides/curve") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES: batched 24h curve + events in one call
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_curve_json(req->uri)); }
        if (path == "/tides/stations") { h["Content-Type"] = "application/json"; h["Cache-Control"] = "no-store";   // TIDES: station markers (GeoJSON)
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, tide_stations_json(req->uri)); }
        if (path == "/catalog") { h["Content-Type"] = "application/json";   // CHART-11 inventory + CONTRACT-5b edition
          if (!g_chart) {
            std::string cb = "{\"cells\":[],\"count\":0,\"chart_loaded\":false,\"chart_status\":\"" +
              json_escape(g_chart_status) + "\"";
            if (!g_chart_unavailable_reason.empty())
              cb += ",\"chart_unavailable_reason\":\"" + json_escape(g_chart_unavailable_reason) + "\"";
            cb += "}";
            return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, cb);
          }
          int band = (g_cell_name.size() >= 3 && g_cell_name[2] >= '0' && g_cell_name[2] <= '9') ? g_cell_name[2] - '0' : -1;
          std::string edtn, eddate;                                             // CONTRACT-5b: cell edition from the loaded chart
          if (g_chart) { edtn = std::string(g_chart->GetSE().ToUTF8());
            wxDateTime ed = g_chart->GetEditionDate(); if (ed.IsValid()) eddate = std::string(ed.FormatISODate().ToUTF8()); }
          char cb[420]; std::snprintf(cb, sizeof cb,
            "{\"cells\":[{\"id\":\"%s\",\"scale\":%d,\"band\":%d,\"edition\":\"%s\",\"editionDate\":\"%s\",\"bbox\":[%.6f,%.6f,%.6f,%.6f]}],\"count\":1}",
            g_cell_name.c_str(), g_native_scale, band, json_escape(edtn).c_str(), eddate.c_str(), g_ext.WLON, g_ext.SLAT, g_ext.ELON, g_ext.NLAT);
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, std::string(cb)); }
        if (path.rfind("/user-data/", 0) == 0) {   // user-owned chart/depth/weather overlays live under HELM_USER_DATA_ROOT or HELM_CONFIG/data
          std::string body, mime;
          if (serve_user_data(path.substr(std::strlen("/user-data/")), body, mime)) {
            h["Content-Type"] = mime;
            h["Cache-Control"] = "no-cache, must-revalidate";
            return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, body);
          }
          h["Content-Type"] = "text/plain";
          h["Cache-Control"] = "no-store";
          return std::make_shared<ix::HttpResponse>(404, "Not Found", ix::HttpErrorCode::Ok, h, std::string("not found\n"));
        }
        // static UI (the page is served from the engine → same origin → no ?server=)
        std::string body, mime;
        if (serve_static(path, body, mime)) { h["Content-Type"] = mime;
          h["Cache-Control"] = "no-cache, must-revalidate";   // the UI ships live; never let a browser pin a stale index.html/JS (the "my card reverted" trap). Tiles stay immutable above.
          return std::make_shared<ix::HttpResponse>(200, "OK", ix::HttpErrorCode::Ok, h, body); }
        h["Content-Type"] = "text/plain";
        return std::make_shared<ix::HttpResponse>(404, "Not Found", ix::HttpErrorCode::Ok, h, std::string("not found\n"));
      });

    if (!server->listenAndStart()) { printf("listen on %s:%d FAILED\n", bindHost, port); return false; }
    printf("Helm one-origin server: %s://%s:%d/  (UI + /chart S-52 tiles + ws /nav)\n", tls ? "https" : "http", bindHost, port);
    if (std::strcmp(bindHost, "127.0.0.1") != 0)
      printf("  serving the LAN — iPad/iPhone: open http://<this-host>:%d/  (no ?server= needed)\n", port);

    // --- AIS: stand up OpenCPN's real AisDecoder headless (decode + CPA/TCPA stay in its code) ---
    g_CPAMax_NM = 20.0; g_CPAWarn_NM = 2.0; g_TCPA_Max = 30.0;
    g_ShowMoored_Kts = 0.2; g_AISShowTracks_Mins = 20.0;
    g_bMarkLost = false; g_MarkLost_Mins = 10.0; g_bRemoveLost = false; g_RemoveLost_Mins = 20.0;
    g_bInlandEcdis = false; g_benableAISNameCache = false;
    bGPSValid = true; gCog = 0; gSog = 0;
    if (!g_BasePlatform) g_BasePlatform = new BasePlatform();   // Select reads GetSelectRadiusPix() from it
    pSelectAIS = new Select();
    g_ais = new AisDecoder(AisDecoderCallbacks());
    std::printf("AIS: OpenCPN AisDecoder live — !AIVDM from any connection feeds CPA/TCPA\n");
    if (const char* sk = std::getenv("HELM_SIGNALK")) if (*sk) sk_start(sk);   // opt-in SignalK overlay

    std::thread(nav_loop, server).detach();
    conn_init();   // load/seed persisted connections; each enabled one runs its own driver thread
    std::thread(tide_acquisition_loop).detach();   // TIDES-9: route/GPS-driven official-cache planner/executor
    bonjour_advertise(port);
    // CONTRACT-14: print the boot PIN + a scannable pairing payload (host/port/tls/fp/pin) for QR/manual entry.
    printf("Pairing: PIN %s  —  POST /pair {\"pin\":\"%s\",\"name\":\"<device>\"} for an owner token\n", g_pair_pin.c_str(), g_pair_pin.c_str());
    printf("Pairing payload: helm://pair?host=%s&port=%d&tls=%d&fp=%s&pin=%s\n", bindHost, port, g_tls_fingerprint.empty() ? 0 : 1, g_tls_fingerprint.c_str(), g_pair_pin.c_str());
    return false;  // no wx event loop; main() runs the render job loop
  }
};
wxIMPLEMENT_APP_NO_MAIN(ServerApp);

int main(int argc, char** argv) {
  wxEntryStart(argc, argv);
  wxTheApp->CallOnInit();
  ServerApp* app = static_cast<ServerApp*>(wxTheApp);
  if (!app->server) { printf("startup failed\n"); wxEntryCleanup(); return 1; }
  for (;;) {
    Job* j = nullptr;
    { std::unique_lock<std::mutex> lk(g_jobs_m); g_jobs_cv.wait(lk, [] { return !g_jobs.empty(); });
      j = g_jobs.front(); g_jobs.pop_front(); }
    if (j->kind == JobKind::Query) j->status = run_query(j->qlat, j->qlon, j->z, j->qradius_px, j->palette, j->cat, j->result);
    else                           j->status = render_tile(j->z, j->x, j->y, j->palette, j->cat, j->result);
    { std::lock_guard<std::mutex> lk(j->m); j->done = true; } j->cv.notify_one();
  }
  wxEntryCleanup();
  return 0;
}

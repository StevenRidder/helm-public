// Helm Engine — skeleton (Phase 2).
//
// Links OpenCPN's model/ nav core (ocpn::model-src) and drives a REAL Routeman
// headless: builds the Key West route, activates it, advances own-ship, auto-advances
// waypoints, and computes BRG/DTW/XTE per fix (the model/-vs-gui/ "UpdateProgress"
// relocation). Streams the nav state as JSON over ws://127.0.0.1:8081 — the SAME shape
// web/nav-source.js (HelmNav) emits, so the UI swaps the JS sim for this socket unchanged.
//
// This is the nav half of the engine. The S-52 chart-tile HTTP server (proven separately
// in spike/opencpn-headless/chart-render) is the next increment.
#include <wx/init.h>
#include <wx/string.h>
#include "model/routeman.h"
#include "model/route.h"
#include "model/route_point.h"
#include "model/own_ship.h"
#include "model/georef.h"
#include "model/config_vars.h"
#include "ixwebsocket/IXWebSocketServer.h"
#include "ixwebsocket/IXWebSocket.h"
#include <thread>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <ctime>
#include <mutex>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fstream>
#include <iterator>
#include "pugixml.hpp"
#include "model/ais_decoder.h"
#include "model/ais_target_data.h"
#include "model/ais_state_vars.h"
#include "model/select.h"
#include "model/base_platform.h"
#include "rapidjson/document.h"

void* g_pi_manager = reinterpret_cast<void*>(1L);

// OpenCPN's real AIS decoder, driven headless. We add NO nav logic: DecodeN0183 does
// checksum + multipart reassembly + per-target range/brg/CPA/TCPA (UpdateOneCPA reads
// the own-ship gLat/gLon/gCog/gSog globals). We only feed sentences and format the result.
extern Select* pSelectAIS;              // model global (defined in ais_decoder.cpp), seeded in main()
static AisDecoder* g_ais = nullptr;
static std::mutex  g_ais_mtx;           // guards the decoder calls + our snapshot below

// Our display snapshot of OpenCPN's decoded targets. We copy the decoder's results at decode
// time (range/brg/CPA/TCPA already computed by its UpdateOneCPA) into our own map and age them
// on our own clock — so the served set is stable and independent of the decoder's internal
// target lifecycle (its wxTimer-driven pruning can't run in a headless tick loop anyway).
struct AisRow { int mmsi; double lat, lon, cog, sog, hdg, range, brg, cpa, tcpa;
                bool cpaValid; int cls; std::string name; std::time_t seen; };
static std::map<int, AisRow> g_ais_rows;

struct WP { double lat, lon; std::string name; };
static std::vector<WP> ROUTE;                 // loaded from GPX at startup — no hardcoded route
static std::string g_route_name = "Route";

// Built-in sample (Key West approach), used only when no route file is given so the
// engine still runs out of the box. It is REAL GPX data parsed by the same loader as a
// user file — not a special-cased C++ route. Kept in sync with engine/sample-route-keywest.gpx.
static const char* SAMPLE_GPX = R"GPX(<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Helm" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>Key West Approach</name>
    <rtept lat="24.458" lon="-81.808"><name>WP1 · start</name></rtept>
    <rtept lat="24.485" lon="-81.800"><name>WP2 · sea buoy</name></rtept>
    <rtept lat="24.515" lon="-81.793"><name>WP3 · channel</name></rtept>
    <rtept lat="24.540" lon="-81.786"><name>WP4 · pass</name></rtept>
    <rtept lat="24.557" lon="-81.781"><name>WP5 · marina</name></rtept>
  </rte>
</gpx>)GPX";

// Minimal JSON string escaper — route/waypoint names now come from a user GPX file.
static std::string json_escape(const std::string& s) {
  std::string o; o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  return o;
}

// Parse the first <rte> of a GPX document into ROUTE waypoints + the route name.
// pugixml-based (robust), namespace-tolerant. Returns false if there is no usable route.
static bool load_gpx_route(const std::string& xml, std::vector<WP>& out, std::string& routeName) {
  pugi::xml_document doc;
  pugi::xml_parse_result res = doc.load_buffer(xml.data(), xml.size());
  if (!res) { std::fprintf(stderr, "GPX parse error: %s\n", res.description()); return false; }
  pugi::xml_node gpx = doc.child("gpx");
  if (!gpx) gpx = doc.first_child();                 // tolerate a missing/namespaced root
  pugi::xml_node rte = gpx.child("rte");
  if (!rte) { std::fprintf(stderr, "GPX has no <rte> route\n"); return false; }
  if (pugi::xml_node nm = rte.child("name")) routeName = nm.text().get();
  out.clear();
  for (pugi::xml_node pt = rte.child("rtept"); pt; pt = pt.next_sibling("rtept")) {
    pugi::xml_attribute la = pt.attribute("lat"), lo = pt.attribute("lon");
    if (!la || !lo) continue;                        // skip malformed points — never fabricate
    WP w; w.lat = la.as_double(); w.lon = lo.as_double();
    if (pugi::xml_node nm = pt.child("name")) w.name = nm.text().get();
    if (w.name.empty()) { char b[24]; std::snprintf(b, sizeof b, "WP%zu", out.size() + 1); w.name = b; }
    out.push_back(w);
  }
  return out.size() >= 2;                            // a route needs at least 2 waypoints
}

static bool read_file(const char* path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return true;
}

// bearing + great-circle distance (NM) from own-ship (lat0,lon0) to target (lat1,lon1)
static void bd(double lat1, double lon1, double lat0, double lon0, double* brg, double* nm) {
  DistanceBearingMercator(lat1, lon1, lat0, lon0, brg, nm);
}
static std::string fmtPos(double lat, double lon) {
  auto one = [](double v, const char* p, const char* n) {
    const char* h = v >= 0 ? p : n; v = std::fabs(v);
    int d = (int)v; double m = (v - d) * 60.0;
    char b[64]; std::snprintf(b, sizeof b, "%d\xC2\xB0%.1f\xE2\x80\xB2%s", d, m, h); // d°m′H
    return std::string(b);
  };
  return one(lat, "N", "S") + " \xC2\xB7 " + one(lon, "E", "W");                      // · separator
}
static std::string fmtNM(double nm) {
  char b[32]; std::snprintf(b, sizeof b, "%.1f NM", nm); return b;
}
static std::string fmtDur(double hours) {              // time-to-go as a human duration
  if (!(hours >= 0)) hours = 0;
  long mins = (long)std::lround(hours * 60.0);
  char b[24];
  if (mins < 60)            std::snprintf(b, sizeof b, "%ldm", mins);
  else if (mins < 24 * 60)  std::snprintf(b, sizeof b, "%ldh %02ldm", mins / 60, mins % 60);
  else                      std::snprintf(b, sizeof b, "%ldd %ldh", mins / 1440, (mins % 1440) / 60);
  return b;
}

// ---------------------------------------------------------------------------
// Real-data overlay — NMEA 0183 over TCP (port 10110, the standard boat feed).
//
// The sim is only scaffolding. Any real sentence overrides the matching field
// and stamps its source; a field with no fresh real sentence falls back to sim
// — but the per-field source flag ALWAYS tells the truth, so a simulated value
// is never reported as real. Corrupt (bad-checksum) sentences are rejected, not
// trusted. To take the boat off sim later, stop emitting the sim fallbacks.
// (Production should route this through OpenCPN's NavMsgBus / model-comms for
// full sentence coverage; this minimal listener proves the override path.)
// ---------------------------------------------------------------------------
// Port resolver: env override with a sane default. Lets multiple engines coexist on
// one host and makes the test harness hermetic. (fail-and-fix-early: a hardcoded
// :10110 silently lost to another process turned real NMEA ingest off with only a
// stderr line — see nmea_listener's bind-failure path.)
static int helm_env_port(const char* name, int def) {
  if (const char* s = std::getenv(name)) {
    if (*s) { int p = std::atoi(s); if (p > 0 && p < 65536) return p; }
  }
  return def;
}
static const int kNmeaPort = helm_env_port("HELM_NMEA_PORT", 10110);
static const double kStaleSec = 5.0;

struct RField { double v = 0; std::time_t t = 0; const char* src = "nmea"; };  // t==0 => never received
struct RealFeed {
  std::mutex m;
  double lat = 0, lon = 0; std::time_t pos_t = 0; const char* pos_src = "nmea";
  RField sog, cog, hdg, depth, wspd, wdir;
};
static RealFeed g_real;
static bool fresh(std::time_t t) {
  return t != 0 && std::difftime(std::time(nullptr), t) <= kStaleSec;
}

static std::vector<std::string> splitc(const std::string& s) {
  std::vector<std::string> out; std::string cur;
  for (char c : s) { if (c == ',') { out.push_back(cur); cur.clear(); } else cur += c; }
  out.push_back(cur); return out;
}
static bool nmea_csum_ok(const std::string& s) {           // reject corrupt sentences
  if (s.size() < 4 || s[0] != '$') return false;
  size_t star = s.rfind('*');
  if (star == std::string::npos || star + 2 >= s.size()) return false;
  unsigned char cs = 0; for (size_t i = 1; i < star; ++i) cs ^= (unsigned char)s[i];
  return cs == (unsigned char)std::strtoul(s.substr(star + 1, 2).c_str(), nullptr, 16);
}
static double nmea_ll(const std::string& v, const std::string& hemi) {  // ddmm.mmm -> deg
  if (v.empty()) return 0;
  double raw = std::atof(v.c_str());
  int deg = (int)(raw / 100); double min = raw - deg * 100;
  double dec = deg + min / 60.0;
  if (hemi == "S" || hemi == "W") dec = -dec;
  return dec;
}
static void nmea_parse(const std::string& line) {
  // AIS (!AIVDM / !AIVDO) -> OpenCPN's decoder (it does its own checksum + multipart reassembly).
  // Note: AIS sentences begin with '!', so they must be routed BEFORE the $-only checksum gate.
  if (g_ais && line.size() >= 6 &&
      (line.compare(0, 6, "!AIVDM") == 0 || line.compare(0, 6, "!AIVDO") == 0)) {
    std::lock_guard<std::mutex> lk(g_ais_mtx);
    g_ais->DecodeN0183(wxString::FromUTF8(line.c_str()));     // decode + per-target CPA/TCPA (OpenCPN)
    std::time_t snap = std::time(nullptr);
    for (auto& kv : g_ais->GetTargetList()) {                 // snapshot the decoded results into our set
      auto& t = kv.second;
      g_ais_rows[t->MMSI] = { t->MMSI, t->Lat, t->Lon, t->COG, t->SOG, t->HDG,
        t->Range_NM, t->Brg, t->CPA, t->TCPA, t->bCPA_Valid, (int)t->Class,
        std::string(t->ShipName), snap };
    }
    return;
  }
  if (!nmea_csum_ok(line)) {
    std::fprintf(stderr, "NMEA rejected (bad checksum): %s\n", line.c_str());
    return;
  }
  std::vector<std::string> f = splitc(line.substr(0, line.rfind('*')));
  if (f.empty() || f[0].size() < 6) return;
  std::string type = f[0].substr(3);                       // drop "$tt" talker id
  std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_real.m);
  if (type == "RMC" && f.size() >= 9 && f[2] == "A") {     // valid GPS fix: pos + sog + cog
    g_real.lat = nmea_ll(f[3], f[4]); g_real.lon = nmea_ll(f[5], f[6]); g_real.pos_t = now; g_real.pos_src = "nmea";
    if (!f[7].empty()) { g_real.sog.v = std::atof(f[7].c_str()); g_real.sog.t = now; g_real.sog.src = "nmea"; }
    if (!f[8].empty()) { g_real.cog.v = std::atof(f[8].c_str()); g_real.cog.t = now; g_real.cog.src = "nmea"; }
  } else if (type == "DPT" && f.size() >= 2 && !f[1].empty()) {       // depth, metres
    g_real.depth.v = std::atof(f[1].c_str()); g_real.depth.t = now; g_real.depth.src = "nmea";
  } else if (type == "DBT" && f.size() >= 4 && !f[3].empty()) {       // depth below transducer (m in f[3])
    g_real.depth.v = std::atof(f[3].c_str()); g_real.depth.t = now; g_real.depth.src = "nmea";
  } else if (type == "MWV" && f.size() >= 6 && f[5] == "A") {         // wind angle + speed
    if (!f[1].empty()) { g_real.wdir.v = std::atof(f[1].c_str()); g_real.wdir.t = now; g_real.wdir.src = "nmea"; }
    if (!f[3].empty()) {
      double sp = std::atof(f[3].c_str());
      if (f[4] == "K") sp *= 0.539957;        // km/h -> kn
      else if (f[4] == "M") sp *= 1.943844;   // m/s  -> kn
      g_real.wspd.v = sp; g_real.wspd.t = now; g_real.wspd.src = "nmea";
    }
  } else if (type == "HDT" && f.size() >= 2 && !f[1].empty()) {       // true heading
    g_real.hdg.v = std::atof(f[1].c_str()); g_real.hdg.t = now; g_real.hdg.src = "nmea";
  }
}

// ---------------------------------------------------------------------------
// SignalK overlay — consume a SignalK server's WebSocket delta stream as a CLIENT.
//
// SignalK is just another truthful real-data source: we map its self-vessel paths onto
// the SAME g_real per-field override the NMEA listener feeds, tagged source "signalk".
// All units are SI (m/s, radians, metres) -> converted to the engine's kn/deg/m.
// Opt-in via HELM_SIGNALK (full ws:// URL, or host[:port] which we expand). Other-vessel
// contexts (AIS) are skipped for now — own-ship nav is this increment.
// ---------------------------------------------------------------------------
static ix::WebSocket* g_sk = nullptr;
static std::string g_sk_self;            // self context learned from the server hello

static void sk_apply(const std::string& path, const rapidjson::Value& v, std::time_t now) {
  auto set = [&](RField& f, double val) { f.v = val; f.t = now; f.src = "signalk"; };
  const double MS2KN = 1.943844, R2D = 180.0 / M_PI;
  if (path == "navigation.position" && v.IsObject() &&
      v.HasMember("latitude") && v.HasMember("longitude") &&
      v["latitude"].IsNumber() && v["longitude"].IsNumber()) {
    g_real.lat = v["latitude"].GetDouble(); g_real.lon = v["longitude"].GetDouble();
    g_real.pos_t = now; g_real.pos_src = "signalk";
  } else if (path == "navigation.speedOverGround" && v.IsNumber()) {
    set(g_real.sog, v.GetDouble() * MS2KN);
  } else if (path == "navigation.courseOverGroundTrue" && v.IsNumber()) {
    set(g_real.cog, v.GetDouble() * R2D);
  } else if (path == "navigation.headingTrue" && v.IsNumber()) {
    set(g_real.hdg, v.GetDouble() * R2D);
  } else if (path == "environment.depth.belowTransducer" && v.IsNumber()) {
    set(g_real.depth, v.GetDouble());
  } else if (path == "environment.wind.speedApparent" && v.IsNumber()) {
    set(g_real.wspd, v.GetDouble() * MS2KN);
  } else if (path == "environment.wind.angleApparent" && v.IsNumber()) {
    double d = v.GetDouble() * R2D; if (d < 0) d += 360.0; set(g_real.wdir, d);
  }
}

static void sk_on_message(const std::string& msg) {
  rapidjson::Document d;
  if (d.Parse(msg.c_str()).HasParseError() || !d.IsObject()) return;
  if (d.HasMember("self") && d["self"].IsString()) {        // server hello announces the self context
    g_sk_self = d["self"].GetString(); return;
  }
  if (!d.HasMember("updates") || !d["updates"].IsArray()) return;
  if (d.HasMember("context") && d["context"].IsString()) {  // own-ship only; other vessels = AIS (deferred)
    std::string ctx = d["context"].GetString();
    if (ctx != "vessels.self" && (g_sk_self.empty() || ctx != g_sk_self)) return;
  }
  std::time_t now = std::time(nullptr);
  std::lock_guard<std::mutex> lk(g_real.m);
  for (auto& u : d["updates"].GetArray()) {
    if (!u.HasMember("values") || !u["values"].IsArray()) continue;
    for (auto& val : u["values"].GetArray())
      if (val.HasMember("path") && val["path"].IsString() && val.HasMember("value"))
        sk_apply(val["path"].GetString(), val["value"], now);
  }
}

static void sk_start(std::string url) {
  if (url.find("://") == std::string::npos)               // bare host[:port] -> full stream URL
    url = "ws://" + url + "/signalk/v1/stream?subscribe=self";
  g_sk = new ix::WebSocket();
  g_sk->setUrl(url);
  g_sk->setPingInterval(20);
  g_sk->enableAutomaticReconnection();                     // resilient: WiFi drops auto-recover
  g_sk->setOnMessageCallback([](const ix::WebSocketMessagePtr& m) {
    if (m->type == ix::WebSocketMessageType::Message) sk_on_message(m->str);
    else if (m->type == ix::WebSocketMessageType::Open) std::printf("SignalK: connected\n");
    else if (m->type == ix::WebSocketMessageType::Error)
      std::fprintf(stderr, "SignalK error: %s\n", m->errorInfo.reason.c_str());
  });
  std::printf("SignalK input: %s  (self-vessel nav overrides sim per-field)\n", url.c_str());
  g_sk->start();
}
static void nmea_listener() {
  int srv = -1;
  // Retry the bind with capped backoff instead of giving up after one shot. A transiently held
  // :10110 (another helm-server/instance) would otherwise PERMANENTLY disable real-data override
  // until restart, with only a single stderr line — a broken feed that never recovers and never
  // surfaces. (fail-and-fix-early hardening; the frame-level feed-health signal is a separate
  // CONTRACT-10/ALARM-9 item, not this change.)
  for (int backoff = 1; ; backoff = std::min(backoff * 2, 30)) {
    srv = ::socket(AF_INET, SOCK_STREAM, 0);
    if (srv >= 0) {
      int yes = 1; ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
      sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(kNmeaPort);
      a.sin_addr.s_addr = inet_addr("127.0.0.1");
      if (::bind(srv, (sockaddr*)&a, sizeof a) == 0 && ::listen(srv, 4) == 0) break;   // bound
      ::close(srv); srv = -1;
    }
    std::fprintf(stderr, "NMEA: bind/listen on %d failed; real-data override paused, retrying in %ds\n", kNmeaPort, backoff);
    std::this_thread::sleep_for(std::chrono::seconds(backoff));
  }
  std::printf("NMEA 0183 input: tcp://127.0.0.1:%d  (real data overrides sim per-field)\n", kNmeaPort);
  std::fflush(stdout);
  std::string buf;
  for (;;) {
    int c = ::accept(srv, nullptr, nullptr);
    if (c < 0) continue;
    buf.clear(); char rb[1024];
    for (;;) {
      ssize_t n = ::recv(c, rb, sizeof rb, 0);
      if (n <= 0) break;
      buf.append(rb, (size_t)n);
      size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, nl); buf.erase(0, nl + 1);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (!line.empty()) nmea_parse(line);
      }
    }
    ::close(c);
  }
}

int main(int argc, char** argv) {
  wxInitializer init;
  if (!init) { std::printf("wx init failed\n"); return 1; }
  std::printf("== Helm Engine (skeleton): OpenCPN model/ nav core -> WebSocket ==\n");

  // --- load the active route from GPX (no hardcoded route) ---
  const char* routePath = (argc >= 2) ? argv[1] : std::getenv("HELM_ROUTE");
  std::string gpx;
  if (routePath && *routePath) {
    if (!read_file(routePath, gpx)) {
      std::fprintf(stderr, "FATAL: cannot read GPX route '%s'\n", routePath); return 3;
    }
    std::printf("route source: %s\n", routePath);
  } else {
    gpx = SAMPLE_GPX;
    std::printf("route source: built-in sample (Key West) — override: helm-engine <route.gpx>  or  HELM_ROUTE=...\n");
  }
  if (!load_gpx_route(gpx, ROUTE, g_route_name)) {
    std::fprintf(stderr, "FATAL: GPX route unusable (need a <rte> with >= 2 <rtept>)\n"); return 4;
  }
  std::printf("loaded route \"%s\": %zu waypoints\n", g_route_name.c_str(), ROUTE.size());

  // Headless default for the arrival-circle radius. OpenCPN's g_n_arrival_circle_radius
  // global defaults to 0 (normally set from the GUI options dialog, which never runs
  // here); at 0 the model's Routeman::UpdateProgress arrival test is disabled and the
  // active waypoint never auto-advances. Seed OpenCPN's usual default so the relocated
  // UpdateProgress (ENGINE-10) advances when own-ship reaches a waypoint's arrival
  // circle. Must precede RoutePoint construction — each waypoint inherits this value.
  if (g_n_arrival_circle_radius <= 0) g_n_arrival_circle_radius = 0.05;  // NM (~93 m)

  // --- real model/ route + route manager, headless ---
  Route* r = new Route();
  for (auto& w : ROUTE)
    r->AddPoint(new RoutePoint(w.lat, w.lon, wxT("circle"), wxString::FromUTF8(w.name.c_str())));
  r->UpdateSegmentDistances(6.0);
  g_pRouteMan = new Routeman(RoutePropDlgCtx(), RoutemanDlgCtx());
  gLat = ROUTE[0].lat; gLon = ROUTE[0].lon;
  g_pRouteMan->ActivateRoute(r);
  g_pRouteMan->ActivateNextPoint(r, false);  // own-ship starts at WP1 → target the first destination
  std::printf("route activated: %d waypoints; Routeman live (no GUI).\n", r->GetnPoints());

  // --- AIS: stand up OpenCPN's real AisDecoder headless (decode + CPA/TCPA stay in its code) ---
  // ais_state_vars globals are plain extern doubles/bools (default 0) — seed the ones the CPA path
  // reads so UpdateOneCPA computes a real CPA window, not a degenerate one.
  g_CPAMax_NM = 20.0; g_CPAWarn_NM = 2.0; g_TCPA_Max = 30.0;       // CPA compute window + warn thresholds
  g_ShowMoored_Kts = 0.2; g_AISShowTracks_Mins = 20.0;
  g_bMarkLost = false; g_MarkLost_Mins = 10.0;
  g_bRemoveLost = false; g_RemoveLost_Mins = 20.0;                 // OnTimerAIS can't fire headless; we age in the tick
  g_bInlandEcdis = false; g_benableAISNameCache = false;
  bGPSValid = true; gCog = 0; gSog = 0;                            // own-ship valid -> UpdateOneCPA can compute CPA
  if (!g_BasePlatform) g_BasePlatform = new BasePlatform();        // Select reads GetSelectRadiusPix() from it
  pSelectAIS = new Select();                                       // target selectable store (model, no GUI)
  g_ais = new AisDecoder(AisDecoderCallbacks());
  std::printf("AIS: OpenCPN AisDecoder live — feed !AIVDM on tcp://127.0.0.1:%d\n", kNmeaPort);

  // precompute leg lengths (NM) for the own-ship sim
  std::vector<double> legLen; double total = 0, b, d;
  for (size_t i = 0; i + 1 < ROUTE.size(); ++i) {
    bd(ROUTE[i + 1].lat, ROUTE[i + 1].lon, ROUTE[i].lat, ROUTE[i].lon, &b, &d);
    legLen.push_back(d); total += d;
  }

  // --- WebSocket server: push nav state to all clients ---
  const int kEnginePort = helm_env_port("HELM_ENGINE_PORT", 8081);
  ix::WebSocketServer server(kEnginePort, "127.0.0.1");
  server.setOnConnectionCallback(
    [](std::weak_ptr<ix::WebSocket> wptr, std::shared_ptr<ix::ConnectionState> cs) {
      if (auto ws = wptr.lock())
        ws->setOnMessageCallback([](const ix::WebSocketMessagePtr&) {}); // push-only; ignore inbound
      std::printf("client connected: %s\n", cs->getId().c_str());
      std::fflush(stdout);
    });
  if (!server.listenAndStart()) { std::printf("WS listen on %d FAILED\n", kEnginePort); return 2; }
  std::printf("nav-state WebSocket: ws://127.0.0.1:%d  (streaming 1 Hz)\n", kEnginePort);

  std::thread(nmea_listener).detach();   // real NMEA (port 10110) overrides the sim per-field
  if (const char* sk = std::getenv("HELM_SIGNALK"))   // opt-in SignalK overlay (e.g. ws://pi.local:3000/signalk/v1/stream?subscribe=self)
    if (*sk) sk_start(sk);

  double along = 0;
  for (long tick = 0;; ++tick) {
    double sim_sog = 5.6 + std::sin(tick / 9.0) * 0.9;    // gentle 4.7-6.5 kn (scaffolding)
    along += sim_sog / 3600.0;                            // sim own-ship advances along the route
    // Loop the demo at end-of-route, OR re-activate if Routeman::UpdateProgress
    // deactivated the route on arrival at the final waypoint. Waypoint advance is now
    // the model's job (ENGINE-10) — there is no sim leg-index force-sync to reset.
    if (along >= total || !g_pRouteMan->IsAnyRouteActive()) {
      along = 0;
      g_pRouteMan->ActivateRoute(r); g_pRouteMan->ActivateNextPoint(r, false);
    }

    // sim own-ship position interpolates along the route polyline; it is the fallback
    // shown only when there is no fresh real fix (the active leg + advance is the model's).
    size_t li = 0; double acc = 0;
    while (li + 1 < legLen.size() && acc + legLen[li] < along) { acc += legLen[li]; ++li; }
    double f = legLen[li] ? (along - acc) / legLen[li] : 0;
    const WP& A = ROUTE[li]; const WP& B = ROUTE[li + 1];

    // ---- sim values (fallback scaffolding only) ----
    double sim_lat = A.lat + (B.lat - A.lat) * f;
    double sim_lon = A.lon + (B.lon - A.lon) * f;
    double legBrg, segNM; bd(B.lat, B.lon, A.lat, A.lon, &legBrg, &segNM);   // leg bearing (route geometry)
    int    sim_cog = (int)std::lround(legBrg);
    int    sim_hdg = ((int)std::lround(legBrg) + (int)std::lround(std::sin(tick / 7.0) * 4) + 360) % 360;
    double sim_wspd = 14 + std::sin(tick / 11.0) * 3;
    int    sim_wdir = ((int)std::lround(95 + std::sin(tick / 13.0) * 10) + 360) % 360;
    double sim_depth = 6 + (1 - f) * 8 + std::sin(tick / 5.0) * 0.6;

    // ---- merge: fresh real data (NMEA or SignalK) overrides sim; EACH field reports its true source ----
    double sog, depth, wspd; int cog, hdg, wdir;
    const char *src_pos, *src_sog, *src_cog, *src_hdg, *src_depth, *src_wind;
    { std::lock_guard<std::mutex> lk(g_real.m);
      if (fresh(g_real.pos_t)) { gLat = g_real.lat; gLon = g_real.lon; src_pos = g_real.pos_src; }
      else                     { gLat = sim_lat;    gLon = sim_lon;    src_pos = "simulated"; }
      if (fresh(g_real.sog.t))   { sog = g_real.sog.v;                   src_sog = g_real.sog.src; }   else { sog = sim_sog;     src_sog = "simulated"; }
      if (fresh(g_real.cog.t))   { cog = (int)std::lround(g_real.cog.v); src_cog = g_real.cog.src; }   else { cog = sim_cog;     src_cog = "simulated"; }
      if (fresh(g_real.hdg.t))   { hdg = (int)std::lround(g_real.hdg.v); src_hdg = g_real.hdg.src; }   else { hdg = sim_hdg;     src_hdg = "simulated"; }
      if (fresh(g_real.depth.t)) { depth = g_real.depth.v;              src_depth = g_real.depth.src; } else { depth = sim_depth; src_depth = "simulated"; }
      if (fresh(g_real.wspd.t))  { wspd = g_real.wspd.v;                src_wind = g_real.wspd.src; }   else { wspd = sim_wspd;   src_wind = "simulated"; }
      wdir = fresh(g_real.wdir.t) ? (int)std::lround(g_real.wdir.v) : sim_wdir;
    }
    gCog = (double)cog; gSog = sog;   // own-ship course/speed -> OpenCPN's UpdateOneCPA (gLat/gLon set above)

    // ENGINE-10: the per-fix active-route geometry + arrival/auto-advance is now the
    // model's job. Routeman::UpdateProgress() (relocated headless from RoutemanGui)
    // recomputes BRG/RNG/XTE off the canonical active route/leg from own-ship gLat/gLon
    // and advances the active waypoint on arrival-circle crossing. We consume its result
    // here instead of recomputing the geometry app-side.
    g_pRouteMan->UpdateProgress();

    RoutePoint* act = g_pRouteMan->GetpActivePoint();
    double brgW  = g_pRouteMan->GetCurrentBrgToActivePoint();            // bearing to active WP (Mercator sailing)
    double dtw   = g_pRouteMan->GetCurrentRngToActivePoint();            // great-circle range to active WP (NM)
    double xteNM = std::fabs(g_pRouteMan->GetCurrentXTEToActivePoint()); // cross-track magnitude (NM); side via GetXTEDir()

    // total distance-to-go = range to the active WP + the remaining whole legs, indexed
    // by the model's active leg so DTG tracks the model's (real-position-correct) advance.
    int actIdx = act ? r->GetIndexOf(act) : (int)(li + 1);
    size_t mli = actIdx > 0 ? (size_t)(actIdx - 1) : li;                 // current leg index from the model
    double dtg = dtw; for (size_t k = mli + 1; k < legLen.size(); ++k) dtg += legLen[k];

    double hoursToGo = dtg / std::max(0.1, sog);
    std::time_t now = std::time(nullptr);
    std::time_t etaT = now + (std::time_t)(hoursToGo * 3600.0);
    char etabuf[40]; std::strftime(etabuf, sizeof etabuf, "%I:%M %p \xC2\xB7 %a %d %b", std::localtime(&etaT));
    std::string ttg = fmtDur(hoursToGo);
    double vmg = sog * std::cos((brgW - cog) * M_PI / 180.0);   // velocity made good toward the active WP

    std::string actName = act ? std::string(act->GetName().ToUTF8()) : "—";
    std::string nextShort = actName.substr(0, actName.find(" \xC2\xB7 "));

    // legs: active waypoint then the one after
    std::string legs = "[";
    for (size_t k = mli + 1; k < ROUTE.size() && k <= mli + 2; ++k) {
      const WP& from = (k == mli + 1) ? WP{gLat, gLon, ""} : ROUTE[k - 1];
      double lb, ld; bd(ROUTE[k].lat, ROUTE[k].lon, from.lat, from.lon, &lb, &ld);
      char lbuf[160];
      std::snprintf(lbuf, sizeof lbuf, "%s{\"name\":\"%s\",\"brg\":\"%ld\xC2\xB0\",\"active\":%s}",
                    k == mli + 1 ? "" : ",", json_escape(ROUTE[k].name).c_str(), std::lround(lb),
                    k == mli + 1 ? "true" : "false");
      legs += lbuf;
    }
    legs += "]";

    // Per-field `sources` carry the truth: "nmea" where a fresh real sentence
    // overrode the value, "simulated" where the demo scaffolding is still showing.
    char json[1500];
    std::snprintf(json, sizeof json,
      "{\"type\":\"nav\",\"posSource\":\"%s\","
      "\"sources\":{\"pos\":\"%s\",\"sog\":\"%s\",\"cog\":\"%s\",\"hdg\":\"%s\",\"depth\":\"%s\",\"wind\":\"%s\"},"
      "\"pos\":{\"lat\":%.5f,\"lon\":%.5f},\"posStr\":\"%s\","
      "\"sog\":%.1f,\"cog\":%d,\"hdg\":%d,\"depth\":%.1f,"
      "\"wind\":{\"spd\":%.0f,\"dir\":%d,\"range\":\"%ld\xE2\x80\x93%ld kt\"},"
      "\"active\":{\"name\":\"%s\",\"eta\":\"%s\",\"ttg\":\"%s\",\"vmg\":\"%.1f kn\","
      "\"dtg\":\"%s\",\"xte\":\"%d m\","
      "\"legs\":%s,\"nextWp\":\"%s \xC2\xB7 %s\"}}",
      src_pos,
      src_pos, src_sog, src_cog, src_hdg, src_depth, src_wind,
      gLat, gLon, fmtPos(gLat, gLon).c_str(),
      sog, cog, hdg, depth,
      wspd, wdir, std::lround(wspd - 4), std::lround(wspd + 8),
      json_escape(g_route_name).c_str(),
      etabuf, ttg.c_str(), vmg, fmtNM(dtg).c_str(), (int)std::lround(xteNM * 1852),
      legs.c_str(), json_escape(nextShort).c_str(), fmtNM(dtw).c_str());

    // ---- AIS targets: OpenCPN computed range/brg/CPA/TCPA at decode time; we format + age-out ----
    std::string aisArr = "[";
    {
      std::lock_guard<std::mutex> lk(g_ais_mtx);
      std::time_t aisNow = std::time(nullptr);
      bool first = true;
      for (auto it = g_ais_rows.begin(); it != g_ais_rows.end(); ) {
        AisRow& t = it->second;
        long age = (long)(aisNow - t.seen);
        if (age > 600) { it = g_ais_rows.erase(it); continue; }   // drop targets silent >10 min
        // ENGINE-13: per-target collision-risk tier from the same g_CPAWarn_NM/g_TCPA_Max alarm band the
        // client uses (web/ais-risk.js tier()); caution = the 2x watch band. (this binary gates on raw cpaValid.)
        const char* risk = (!t.cpaValid || t.tcpa <= 0.0) ? "normal"
          : (t.cpa < g_CPAWarn_NM && t.tcpa < g_TCPA_Max) ? "danger"
          : (t.cpa < 2.0 * g_CPAWarn_NM && t.tcpa < 2.0 * g_TCPA_Max) ? "caution" : "normal";
        char tb[480];
        std::snprintf(tb, sizeof tb,
          "%s{\"mmsi\":%d,\"lat\":%.5f,\"lon\":%.5f,\"cog\":%.0f,\"sog\":%.1f,\"hdg\":%.0f,"
          "\"range\":%.2f,\"brg\":%.0f,\"cpa\":%.2f,\"tcpa\":%.1f,\"cpaValid\":%s,\"risk\":\"%s\","
          "\"class\":%d,\"name\":\"%s\",\"ageSec\":%ld}",
          first ? "" : ",", t.mmsi, t.lat, t.lon, t.cog, t.sog, t.hdg,
          t.range, t.brg, t.cpa, t.tcpa, t.cpaValid ? "true" : "false", risk,
          t.cls, json_escape(t.name).c_str(), age);
        aisArr += tb; first = false; ++it;
      }
    }
    aisArr += "]";

    // ---- active route geometry: drive the UI's route line from the model route, not a static
    //      file. coords are the real waypoints we're navigating; activeLeg = the leg own-ship is
    //      on (ROUTE[li]->ROUTE[li+1]) so the cockpit can highlight it. ----
    std::string routeJson = "{\"name\":\"" + json_escape(g_route_name) +
                            "\",\"activeLeg\":" + std::to_string((long)mli) + ",\"coords\":[";
    for (size_t i = 0; i < ROUTE.size(); ++i) {
      char rb[48];
      std::snprintf(rb, sizeof rb, "%s[%.6f,%.6f]", i ? "," : "", ROUTE[i].lon, ROUTE[i].lat);
      routeJson += rb;
    }
    routeJson += "]}";

    std::string frame(json);
    if (!frame.empty()) frame.insert(frame.size() - 1, ",\"ais\":" + aisArr);       // additive: top-level key, before final }
    if (!frame.empty()) frame.insert(frame.size() - 1, ",\"route\":" + routeJson);  // additive: live route geometry
    for (auto& c : server.getClients()) c->send(frame);
    if (tick % 10 == 0)
      std::printf("  [%ld] %s [%s]  SOG %.1f  COG %d  DTG %s  -> %s  (clients: %zu)\n",
                  tick, fmtPos(gLat, gLon).c_str(), src_pos, sog, cog,
                  fmtNM(dtg).c_str(), nextShort.c_str(), server.getClients().size());

    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
  return 0;
}

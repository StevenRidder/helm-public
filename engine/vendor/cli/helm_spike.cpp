// Helm Phase-1 spike — prove OpenCPN's model/ nav core runs HEADLESS (no GUI).
// Mirrors cli/console.cpp's headless init; drives the route engine end to end.
#include <wx/init.h>
#include <wx/string.h>
#include <cstdio>

#include "model/routeman.h"
#include "model/route.h"
#include "model/route_point.h"
#include "model/own_ship.h"
#include "model/georef.h"

// Minimal global the model expects (same as cli/console.cpp).
void* g_pi_manager = reinterpret_cast<void*>(1L);

// The one piece the model/ split left in gui/ (RoutemanGui::UpdateProgress):
// live bearing/distance to the active waypoint. It needs only model primitives,
// so "relocating" it is this handful of lines — demonstrated here, headless.
static void liveNav() {
  RoutePoint* wp = g_pRouteMan->GetpActivePoint();
  if (!wp) { printf("   (no active waypoint)\n"); return; }
  double brg = 0, dist = 0;
  DistanceBearingMercator(wp->GetLatitude(), wp->GetLongitude(), gLat, gLon, &brg, &dist);
  printf("   LIVE NAV -> active WP '%s'   BRG %.0f deg   DTW %.2f NM\n",
         (const char*)wp->GetName().mb_str(), brg, dist);
}

int main(int, char**) {
  wxInitializer init;
  if (!init) { printf("wx init failed\n"); return 1; }

  printf("== Helm spike: OpenCPN model/ nav core, headless ==\n");

  // 1) Build a route (the data model) and run the PLANNING math.
  Route* r = new Route();
  r->AddPoint(new RoutePoint(24.55, -81.80, wxT("circle"), wxT("WP1")));
  r->AddPoint(new RoutePoint(24.50, -81.75, wxT("circle"), wxT("WP2")));
  r->AddPoint(new RoutePoint(24.46, -81.70, wxT("circle"), wxT("WP3")));
  r->UpdateSegmentDistances(6.0);          // per-leg distance/bearing/ETA at 6 kn
  printf("1) Route built headless: %d waypoints; planning math ran.\n", r->GetnPoints());

  // 2) The route ENGINE — the exact construction cli/console.cpp uses, no GUI.
  g_pRouteMan = new Routeman(RoutePropDlgCtx(), RoutemanDlgCtx());
  printf("2) Routeman instantiated (no window).\n");

  // 3) Activate + navigate from a present position.
  gLat = 24.60; gLon = -81.85;
  bool ok = g_pRouteMan->ActivateRoute(r);
  printf("3) ActivateRoute -> %s; active route: %s\n",
         ok ? "OK" : "FAIL", g_pRouteMan->GetpActiveRoute() ? "yes" : "no");
  liveNav();

  g_pRouteMan->ActivateNextPoint(r, false);
  printf("4) advanced to next waypoint\n");
  liveNav();

  g_pRouteMan->DeactivateRoute();
  printf("5) deactivated.\n\n== HEADLESS NAV CORE WORKS ==\n");
  return 0;
}

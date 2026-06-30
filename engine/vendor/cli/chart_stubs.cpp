// /tmp/opencpn/cli/chart_stubs.cpp
//
// Linkage shims for the headless S-52 / s57chart render spike.
//
// This file provides the small tail of app-level globals and the three
// app-provided hook functions that the hand-picked gui/src slice
// (s57chart.cpp, s57obj.cpp, senc_manager.cpp, o_senc.cpp, ocpndc.cpp,
// viewport.cpp, ocpn_region.cpp, s57_ocpn_utils.cpp, color_handler.cpp)
// references but that normally live in the monolithic opencpn executable
// (ocpn_app.cpp / ocpn_platform.cpp / s57_load.cpp / ocpn_frame.cpp).
//
// DO NOT redefine here (already in model/src/config_vars.cpp, compiled into
// ocpn::model-src): g_bopengl, g_bDebugS57, g_bGDAL_Debug,
// g_GLMinSymbolLineWidth, g_nCPUCount, g_SENC_LOD_pixels, g_UserPresLibData.
// g_poRegistrar is defined in libs/s57-charts (s57classregistrar.cpp) and set
// by the s57RegistrarMgr ctor we call in the harness -- do NOT define it here.
// GetGlobalColor(wxString) comes from the compiled color_handler.cpp -- do NOT
// stub it.
//
// The list below is "best effort": if the linker reports a symbol here as a
// DUPLICATE, delete that line; if it reports one MISSING, add a one-liner.

#include <wx/string.h>
#include <wx/window.h>
#include <wx/frame.h>
#include <wx/filename.h>
#include <cstdio>
#include <cstdlib>

#include "gl_headers.h"

// ---------------------------------------------------------------------------
// App globals referenced by the gui slice but NOT in config_vars.cpp.
// ---------------------------------------------------------------------------

// The following are NOT defined here -- they already have a single definition in
// the linked libs/model and defining them again is a DUPLICATE SYMBOL:
//   ps52plib              -> libS52PLIB.a (the s52plib lib owns the global)
//   g_SencThreadManager   -> gui/src/senc_manager.cpp (in our slice)
//   g_csv_locn            -> model/src/gui_vars.cpp
//   g_SENCPrefix          -> model/src/gui_vars.cpp
//   g_b_overzoom_x        -> model/src/gui_vars.cpp
//   g_b_EnableVBO         -> model/src/gui_vars.cpp
//   g_bportable           -> model/src/cmdline.cpp
// The harness still ASSIGNS to ps52plib / g_csv_locn / g_SENCPrefix via their
// extern declarations.

// These three have no definition anywhere in the linked set, so we own them:
class PlugInManager;
PlugInManager* g_pi_manager = nullptr;   // optional plugin/light overlay; unused headless
wxString g_SData_Locn;                   // shared-data dir
bool     g_OsencVerbose = false;

// Shared-data location hook (s52plib uses it during init to find s57data/). The
// chart-render LIBRARY owns it now (was duplicated per-main), so the library has
// no back-reference to its host executable. Defaults to the in-repo data dir.
wxString g_helm_shared_data = wxT("/tmp/opencpn/data/");
extern "C" wxString* GetpSharedDataLocation() { return &g_helm_shared_data; }

// ---------------------------------------------------------------------------
// ChartBase ctor/dtor/GetHashKey -- lifted from gui/src/chartimg.cpp:122-178 so
// that chartimg.cpp (the large BSB raster reader) is NOT compiled into the
// target. s57chart derives from ChartBase, so these are required for linkage.
// (Continue_BackgroundHiDefRender is commented out in chartbase.h, so omitted.)
// ---------------------------------------------------------------------------

#include "chartbase.h"

// Verbatim from gui/src/chartimg.cpp:122-178.
ChartBase::ChartBase() {
  m_depth_unit_id = DEPTH_UNIT_UNKNOWN;

  pThumbData = new ThumbData;

  m_global_color_scheme = GLOBAL_COLOR_SCHEME_RGB;

  bReadyToRender = false;

  Chart_Error_Factor = 0;

  m_Chart_Scale = 10000;  // a benign value
  m_Chart_Skew = 0.0;

  m_nCOVREntries = 0;
  m_pCOVRTable = NULL;
  m_pCOVRTablePoints = NULL;

  m_nNoCOVREntries = 0;
  m_pNoCOVRTable = NULL;
  m_pNoCOVRTablePoints = NULL;

  m_EdDate = wxInvalidDateTime;

  m_lon_datum_adjust = 0.;
  m_lat_datum_adjust = 0.;

  m_projection = PROJECTION_MERCATOR;  // default
}

ChartBase::~ChartBase() {
  delete pThumbData;

  //    Free the COVR tables

  for (unsigned int j = 0; j < (unsigned int)m_nCOVREntries; j++)
    free(m_pCOVRTable[j]);

  free(m_pCOVRTable);
  free(m_pCOVRTablePoints);

  //    Free the No COVR tables

  for (unsigned int j = 0; j < (unsigned int)m_nNoCOVREntries; j++)
    free(m_pNoCOVRTable[j]);

  free(m_pNoCOVRTable);
  free(m_pNoCOVRTablePoints);
}

wxString ChartBase::GetHashKey() const {
  wxString key = GetFullPath();
  wxChar separator = wxFileName::GetPathSeparator();
  for (unsigned int pos = 0; pos < key.size(); pos = key.find(separator, pos))
    key.replace(pos, 1, "!");
  return key;
}

// ---------------------------------------------------------------------------
// gFrame
//
// gFrame (the `MyFrame*` global) is referenced by name from some model/gui TUs;
// we define it as nullptr with a forward decl and never dereference it. The
// abstract top_frame::Get() seam that used to live here was removed in Step 6
// (see the seam note below) — the headless render path needs no AbstractTopFrame.
// ---------------------------------------------------------------------------

#include "top_frame.h"
#include "abstract_chart.h"

class MyFrame;
MyFrame* gFrame = nullptr;

// Step 6 seam: the headless renderer needs no AbstractTopFrame at all.
// A HeadlessTopFrame (~79 no-op overrides) used to be defined here solely to
// satisfy top_frame::Get(). Its only render-path caller (s57chart GetBestVPScale)
// is compiled out under OCPN_HEADLESS, and the background-SENC callers in
// senc_manager.cpp are now #ifndef OCPN_HEADLESS-guarded (see patches/), so NO
// compiled TU references top_frame::Get(). HeadlessTopFrame, its singleton
// storage, and the top_frame::Get() definition are therefore deleted outright —
// the library carries no frame object and no abort-tripwire stub.

// ---------------------------------------------------------------------------
// g_Platform / HeadlessPlatform
//
// s57chart.cpp only ever calls g_Platform->GetDisplayDPmm() (line 4046). The
// declared type is `OCPNPlatform*`. We subclass OCPNPlatform and override the
// one method. RISK: OCPNPlatform's base ctor (ocpn_platform.cpp) runs
// EnumerateMonitors() and may force pulling in ocpn_platform.cpp + displays.cpp
// at link time; the documented fallback is to add gui/src/ocpn_platform.cpp to
// CHART_SPIKE_GUI_SRC and just `g_Platform = new OCPNPlatform()`.
// ---------------------------------------------------------------------------

#include "ocpn_platform.h"

// OCPNPlatform has only FOUR virtuals (~OCPNPlatform, ShowBusySpinner,
// HideBusySpinner, GetDisplayDPmm) over BasePlatform (which IS in the linked
// model lib). Rather than compile gui/src/ocpn_platform.cpp (2333 LOC dragging
// about/options/styles/fonts/displays -- the "20+ gui files" trap), we provide
// our OWN minimal definitions of OCPNPlatform here. Defining the key function
// (~OCPNPlatform) in this TU emits the vtable + `typeinfo for OCPNPlatform`.
// The real ctor calls EnumerateMonitors(); ours is a no-op.
OCPNPlatform::OCPNPlatform() {}
OCPNPlatform::~OCPNPlatform() {}
// Use the REAL platform computation, not a magic constant. BasePlatform (linked
// from model-src) computes the actual display DPmm for a GUI app and returns the
// 12.0 console convention otherwise — never a hardcoded value. Inert today
// (g_SENC_LOD_pixels == 0 gates all LOD decimation off); production tile-LOD
// parity would pin this to the SENC build environment.
double OCPNPlatform::GetDisplayDPmm() { return BasePlatform::GetDisplayDPmm(); }
void   OCPNPlatform::ShowBusySpinner(void) {}
void   OCPNPlatform::HideBusySpinner(void) {}
wxSize OCPNPlatform::getDisplaySize() { return wxSize(1024, 768); }
double OCPNPlatform::GetDisplaySizeMM() { return 270.0; }
unsigned int OCPNPlatform::GetSelectRadiusPix() { return 8; }
float OCPNPlatform::GetChartScaleFactorExp(float /*scale_linear*/) { return 1.0f; }

OCPNPlatform* g_Platform = nullptr;

// ---------------------------------------------------------------------------
// GetOCPNCanvasWindow()
//
// PrepareForRender (s57chart.cpp:192) calls
// GetOCPNCanvasWindow()->GetContentScaleFactor(); a real (offscreen) wxWindow
// satisfies it. Built lazily in EnsureHeadlessGlobals().
// ---------------------------------------------------------------------------

static wxFrame*  s_offscreen_frame = nullptr;
static wxWindow* s_canvas_window = nullptr;

extern "C" wxWindow* GetOCPNCanvasWindow() { return s_canvas_window; }

// ---------------------------------------------------------------------------
// EnsureHeadlessGlobals()
//
// One-time builder for the offscreen canvas window, the platform object, and
// the headless top frame. Called by main() BEFORE plib init / chart Init.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GL plumbing referenced by the slice (because ocpnUSE_GL is ON tree-wide) but
// NEVER executed on the wxDC raster path. These only need to EXIST at link.
// We do NOT compile gl_chart_canvas.cpp / quilt.cpp / pluginmanager.cpp /
// ocpn_frame.cpp (each would cascade into the full GUI), so we stub the few
// referenced symbols here.
// ---------------------------------------------------------------------------

#include "viewport.h"
#include "LLRegion.h"
#include "model/georef.h"

#include "gl_chart_canvas.h"

bool glChartCanvas::s_b_useScissorTest = true;
bool glChartCanvas::CanClipViewport(const ViewPort& /*vp*/) { return false; }
ViewPort glChartCanvas::ClippedViewport(const ViewPort& vp,
                                        const LLRegion& /*region*/) {
  return vp;
}
void glChartCanvas::DisableClipRegion() {}

// Quilt::GetChartAtPix is reached only through the (unused) light-sector helper.
#include "quilt.h"
ChartBase* Quilt::GetChartAtPix(ViewPort& /*VPoint*/, wxPoint /*p*/) {
  return nullptr;
}

// g_texture_rectangle_format normally lives in ocpn_frame.cpp.
typedef unsigned int GLenum_t;
GLenum g_texture_rectangle_format = 0;

// ThumbData ctor/dtor -- lifted from chartimg.cpp:97-99 (chartimg.cpp itself is
// not compiled). Used by the lifted ChartBase ctor (new ThumbData).
ThumbData::ThumbData() { pDIBThumb = NULL; }
ThumbData::~ThumbData() { delete pDIBThumb; }

// fromSM_Plugin -- lifted from ocpn_plugin_gui.cpp:649 (wraps model fromSM()).
void fromSM_Plugin(double x, double y, double lat0, double lon0, double* lat,
                   double* lon) {
  fromSM(x, y, lat0, lon0, lat, lon);
}

// ---------------------------------------------------------------------------
// App-provided hook functions that the libs (s52plib) and the gui slice call,
// normally living in gui/src/ocpn_plugin_gui.cpp / gui_lib.cpp / navutil.cpp /
// font_mgr. We provide minimal headless implementations.
// ---------------------------------------------------------------------------

#include <wx/colour.h>
#include <wx/font.h>
#include <wx/fileconf.h>

// s52plib externs this 2-arg "C" form (s52plib.cpp:99). The compiled
// color_handler.cpp provides the C++ `wxColour GetGlobalColor(wxString)`, which
// resolves out of ps52plib; we forward to it.
wxColour GetGlobalColor(wxString colorName);  // from color_handler.cpp
extern "C" bool GetGlobalColor(wxString colorName, wxColour* pcolour) {
  if (pcolour) *pcolour = GetGlobalColor(colorName);
  return true;
}

// navutil.cpp:2918
bool LogMessageOnce(const wxString& /*msg*/) { return true; }

// gui_lib.cpp:117  (default-arg-free definition; callers pass all args)
int OCPNMessageBox(wxWindow* /*parent*/, const wxString& /*message*/,
                   const wxString& /*caption*/, int /*style*/,
                   int /*timeout_sec*/, int /*x*/, int /*y*/) {
  return 0;  // wxID_NONE-ish; never reached on the render path
}

// gui_lib.cpp:61  -- a persistent wxFont* (s52plib/o_senc keep the pointer).
wxFont* GetOCPNScaledFont(wxString /*item*/, int default_size) {
  static wxFont* f = nullptr;
  if (!f) {
    int sz = default_size > 0 ? default_size : 10;
    f = new wxFont(sz, wxFONTFAMILY_SWISS, wxFONTSTYLE_NORMAL,
                   wxFONTWEIGHT_NORMAL);
  }
  return f;
}

// ocpn_plugin_gui.cpp:1480
wxFont* FindOrCreateFont_PlugIn(int point_size, wxFontFamily family,
                                wxFontStyle style, wxFontWeight weight,
                                bool underline, const wxString& facename,
                                wxFontEncoding encoding) {
  return wxTheFontList->FindOrCreateFont(point_size, family, style, weight,
                                         underline, facename, encoding);
}

// ocpn_plugin_gui.cpp:335
wxColour GetFontColour_PlugIn(wxString /*TextElement*/) {
  return wxColour(0, 0, 0);
}

// ocpn_plugin_gui.cpp:399
wxString GetLocaleCanonicalName() { return wxT("en_US"); }

// ocpn_plugin_gui.cpp:292
float GetOCPNChartScaleFactor_Plugin() { return 1.0f; }

// ocpn_plugin_gui.cpp:199
wxFileConfig* GetOCPNConfigObject() { return nullptr; }

// ---------------------------------------------------------------------------
// Methods on heavy GUI classes (ChartCanvas / PlugInManager / glChartCanvas)
// that the slice references ONLY from the never-executed light-sector helpers.
// We stub them so we don't compile chcanv.cpp / pluginmanager.cpp.
// Including the headers is compile-only; it adds no link deps.
// ---------------------------------------------------------------------------

#include "chcanv.h"
#include "pluginmanager.h"

ChartBase* ChartCanvas::GetChartAtCursor() { return nullptr; }
void ChartCanvas::GetCanvasPixPoint(double /*x*/, double /*y*/, double& lat,
                                    double& lon) {
  lat = 0;
  lon = 0;
}

ListOfPI_S57Obj* PlugInManager::GetPlugInObjRuleListAtLatLon(
    ChartPlugInWrapper* /*target*/, float /*zlat*/, float /*zlon*/,
    float /*SelectRadius*/, const ViewPort& /*vp*/) {
  return nullptr;
}
ListOfPI_S57Obj* PlugInManager::GetLightsObjRuleListVisibleAtLatLon(
    ChartPlugInWrapper* /*target*/, float /*zlat*/, float /*zlon*/,
    const ViewPort& /*vp*/) {
  return nullptr;
}

void glChartCanvas::SetClipRect(const ViewPort& /*vp*/, const wxRect& /*rect*/,
                                bool /*g_clear*/) {}
int glChartCanvas::GetCanvasIndex() { return 0; }

// `typeinfo for ChartPlugInWrapper` (__ZTI18ChartPlugInWrapper) is referenced
// ONLY by the dynamic_cast in s57_GetVisibleLightSectors, which is never on the
// DC render path. Emitting it normally drags ~ChartBaseBSB() from the uncompiled
// chartimg.cpp. We instead allow this single symbol to remain undefined at link
// via `-Wl,-U,__ZTI18ChartPlugInWrapper` (see cli/CMakeLists.txt). It is never
// dereferenced at runtime on this path.

// ---------------------------------------------------------------------------

void EnsureHeadlessGlobals() {
  if (s_canvas_window) return;  // idempotent

  // Offscreen 1x1 frame + child window standing in for the chart canvas.
  s_offscreen_frame =
      new wxFrame(nullptr, wxID_ANY, wxT("ocpn-headless"), wxDefaultPosition,
                  wxSize(1, 1), wxFRAME_NO_TASKBAR | wxBORDER_NONE);
  s_canvas_window = new wxWindow(s_offscreen_frame, wxID_ANY);

  // Platform (only GetDisplayDPmm() is exercised).
  if (!g_Platform) g_Platform = new OCPNPlatform();

}

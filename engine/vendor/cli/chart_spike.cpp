// /tmp/opencpn/cli/chart_spike.cpp
//
// Headless S-52 ENC -> PNG spike. Proves OpenCPN's s52plib + s57chart wxDC
// raster render path runs with NO GUI window and NO GL context, rendering a
// real NOAA ENC cell to a PNG.
//
// Pipeline:
//   1. wxApp (GUI) so wxBitmap/wxMemoryDC/wxImage work (CoreGraphics on macOS).
//   2. EnsureHeadlessGlobals() -> offscreen canvas window + g_Platform + gFrame.
//   3. Init ps52plib DIRECTLY (new s52plib(S52RAZDS.RLE), DAY scheme) -- we do
//      NOT call LoadS57() (it drags pConfig / monitor / GL wiring). The shared-
//      data path is split: ctor arg = full .RLE path; GetpSharedDataLocation()
//      returns the PARENT of s57data ("/tmp/opencpn/data/").
//   4. s57RegistrarMgr(s57data, stderr) -> allocates g_poRegistrar.
//   5. new s57chart; DisableBackgroundSENC() (forces synchronous createSenc200);
//      Init(.000, FULL_INIT); SetColorScheme(DAY).
//   6. ViewPort fitted over GetChartExtent; SetBoxes()+Validate().
//   7. wxBitmap(W,H,BPP) + wxMemoryDC; RenderRegionViewOnDC; SaveFile PNG.
//   8. Count non-white / non-blank pixels; print PASS/FAIL.

#include <cstdio>
#include <cstdlib>

#include <wx/app.h>
#include <wx/bitmap.h>
#include <wx/cmdline.h>
#include <wx/dcmemory.h>
#include <wx/filename.h>
#include <wx/image.h>
#include <wx/string.h>

#include "gl_headers.h"

#include "chartbase.h"          // FULL_INIT, INIT_OK, Extent, ColorScheme
#include "s57chart.h"
#include "viewport.h"
#include "ocpn_region.h"
#include "ocpn_pixel.h"         // BPP
#include "color_types.h"        // GLOBAL_COLOR_SCHEME_DAY

#include "s52plib.h"
#include "chartsymbols.h"       // ChartCtx
#include "s57registrar_mgr.h"
#include "o_senc.h"             // extern m_pRegistrarMan

// ---- provided by chart_stubs.cpp / linked libs -----------------------------
extern s52plib* ps52plib;       // owned by libS52PLIB.a
extern wxString g_csv_locn;     // owned by model gui_vars.cpp
extern wxString g_SENCPrefix;   // owned by model gui_vars.cpp
extern wxString g_SData_Locn;   // owned by chart_stubs.cpp
// m_pRegistrarMan is declared extern in o_senc.h and DEFINED (uninitialised) in
// the compiled o_senc.cpp; Osenc::CreateSENCRecord200 calls
// m_pRegistrarMan->getAttributeID() UNGUARDED -> we MUST set it.
void EnsureHeadlessGlobals();

// GetpSharedDataLocation() is provided by the chart-render library (chart_stubs.cpp).

// ---------------------------------------------------------------------------

static const wxString kDataDir   = wxT("/tmp/opencpn/data/");
static const wxString kS57Data   = wxT("/tmp/opencpn/data/s57data/");
static const wxString kPLibRLE   = wxT("/tmp/opencpn/data/s57data/S52RAZDS.RLE");
static const wxString kSencDir   = wxT("/tmp/ocpn_senc/");

static int run_spike(const wxString& enc_path, const wxString& png_path) {
  setvbuf(stdout, nullptr, _IONBF, 0);  // unbuffered so output survives a crash
  printf("== chart-spike: headless S-52 ENC -> PNG ==\n");
  printf("   ENC : %s\n", (const char*)enc_path.mb_str());
  printf("   PNG : %s\n", (const char*)png_path.mb_str());

  // PNG handler for rastersymbols-day.png and our output save.
  wxImage::AddHandler(new wxPNGHandler);

  // Offscreen canvas window + g_Platform + gFrame (used during Init/render).
  EnsureHeadlessGlobals();

  // SENC output dir (must be writable).
  ::wxFileName::Mkdir(kSencDir, 0755, wxPATH_MKDIR_FULL);
  g_SENCPrefix = kSencDir;
  g_csv_locn   = kS57Data;
  g_SData_Locn = kDataDir;

  // ---- 1. Presentation library (DAY scheme), constructed directly. ----------
  printf("1) new s52plib(%s)\n", (const char*)kPLibRLE.mb_str());
  ps52plib = new s52plib(kPLibRLE, /*b_forceLegacy=*/false);
  if (!ps52plib || !ps52plib->m_bOK) {
    printf("   FAIL: s52plib load failed (m_bOK=%d). Check chartsymbols.xml.\n",
           ps52plib ? ps52plib->m_bOK : 0);
    return 2;
  }
  // ocpnUSE_GL is defined for this build, so ChartCtx exposes the 2-arg
  // (use_opengl, rect_format) ctor; pass (false, 0) to take the wxImage/wxBitmap
  // (non-GL) raster-symbol branch -- calling glGenTextures with no context
  // would crash.
  ps52plib->SetPLIBColorScheme(GLOBAL_COLOR_SCHEME_DAY, ChartCtx(false, 0));
  int objl = ps52plib->pOBJLArray ? (int)ps52plib->pOBJLArray->GetCount() : -1;
  printf("   plib OK; OBJL classes loaded = %d\n", objl);

  // ---- 2. S57 class registrar (allocates g_poRegistrar) + the registrar
  //         MANAGER global m_pRegistrarMan (used unguarded by Osenc). ----------
  printf("2) s57RegistrarMgr(%s)\n", (const char*)kS57Data.mb_str());
  m_pRegistrarMan = new s57RegistrarMgr(kS57Data, stderr);  // sets g_poRegistrar
                                                            // + attr/feature CSVs

  // ---- 3. Construct + synchronous SENC + Init. ------------------------------
  printf("3) new s57chart + DisableBackgroundSENC + Init(FULL_INIT)\n");
  s57chart* chart = new s57chart();
  chart->DisableBackgroundSENC();  // force in-process createSenc200()
  InitReturn ir = chart->Init(enc_path, FULL_INIT);
  printf("   Init -> %d (INIT_OK=%d)\n", (int)ir, (int)INIT_OK);
  if (ir != INIT_OK) {
    printf("   FAIL: chart Init did not return INIT_OK.\n");
    return 3;
  }

  // ---- 4. Color scheme on the chart. ----------------------------------------
  chart->SetColorScheme(GLOBAL_COLOR_SCHEME_DAY);

  // ---- 5. ViewPort fitted over the cell extent. -----------------------------
  Extent ext;
  if (!chart->GetChartExtent(&ext)) {
    printf("   FAIL: GetChartExtent failed.\n");
    return 4;
  }
  printf("4) extent  S %.5f  N %.5f  W %.5f  E %.5f  nativeScale=%d\n",
         ext.SLAT, ext.NLAT, ext.WLON, ext.ELON, chart->GetNativeScale());

  const int W = 1024, H = 768;
  double clat = (ext.NLAT + ext.SLAT) / 2.0;
  double clon = (ext.WLON + ext.ELON) / 2.0;

  // physical pixels per meter so the lat span fits H (1 deg lat ~= 60 NM).
  double span_m = (ext.NLAT - ext.SLAT) * 1852.0 * 60.0;
  if (span_m <= 0) span_m = 1000.0;
  double ppm = (double)H / span_m;

  ViewPort vp;
  vp.clat = clat;
  vp.clon = clon;
  vp.view_scale_ppm = ppm;
  vp.pix_width = W;
  vp.pix_height = H;
  vp.rotation = 0.0;
  vp.skew = 0.0;
  vp.tilt = 0.0;
  vp.m_projection_type = PROJECTION_MERCATOR;
  vp.chart_scale = chart->GetNativeScale();  // keep < 1e8 to use normal path
  vp.ref_scale = vp.chart_scale;
  vp.b_quilt = false;
  vp.rv_rect = wxRect(0, 0, W, H);
  vp.SetBoxes();
  vp.Validate();
  printf("5) viewport  clat %.5f  clon %.5f  ppm %.6f  %dx%d\n",
         clat, clon, ppm, W, H);

  // ---- 6. Target bitmap + memory DC + render. -------------------------------
  wxBitmap bmp(W, H, BPP);
  if (!bmp.IsOk()) {
    printf("   FAIL: wxBitmap(%d,%d,%d) not ok (no display?).\n", W, H, BPP);
    return 5;
  }
  wxMemoryDC dc(bmp);
  if (!dc.IsOk()) {
    printf("   FAIL: wxMemoryDC not ok (no display?).\n");
    return 5;
  }

  OCPNRegion region(0, 0, W, H);
  printf("6) RenderRegionViewOnDC ...\n");
  bool ok = chart->RenderRegionViewOnDC(dc, vp, region);
  printf("   RenderRegionViewOnDC -> %s\n", ok ? "true" : "false");

  // ---- 7. Detach + save PNG. ------------------------------------------------
  // IMPORTANT: for a single (non-quilt) cell, RenderRegionViewOnDC ends with
  // `pDIB->SelectIntoDC(dc)` -- i.e. it SELECTS the chart's internal pDIB
  // bitmap INTO our dc, replacing the blank `bmp` we selected earlier. So the
  // rendered chart lives in the dc's *currently selected* bitmap, NOT in `bmp`.
  // Grab that one before deselecting.
  wxBitmap rendered = dc.GetSelectedBitmap();
  dc.SelectObject(wxNullBitmap);
  if (!rendered.IsOk()) rendered = bmp;  // fallback
  wxImage img = rendered.ConvertToImage();
  if (!img.IsOk()) {
    printf("   FAIL: ConvertToImage failed.\n");
    return 6;
  }
  if (!img.SaveFile(png_path, wxBITMAP_TYPE_PNG)) {
    printf("   FAIL: SaveFile(%s) failed.\n", (const char*)png_path.mb_str());
    return 6;
  }

  // ---- 8. Count non-white / non-blank pixels. -------------------------------
  long total = (long)img.GetWidth() * img.GetHeight();
  long nonwhite = 0, nonblack = 0;
  const unsigned char* d = img.GetData();
  for (long i = 0; i < total; i++) {
    unsigned char r = d[3 * i], g = d[3 * i + 1], b = d[3 * i + 2];
    if (!(r >= 250 && g >= 250 && b >= 250)) nonwhite++;
    if (!(r <= 5 && g <= 5 && b <= 5)) nonblack++;
  }
  printf("7) saved %dx%d PNG; total=%ld  non-white=%ld  non-black=%ld\n",
         img.GetWidth(), img.GetHeight(), total, nonwhite, nonblack);

  bool rendered_content = ok && nonwhite > 0 && nonblack > 0;
  printf("== %s ==\n", rendered_content ? "PASS (chart content rendered)"
                                        : "FAIL (blank / no content)");
  return rendered_content ? 0 : 7;
}

// ---------------------------------------------------------------------------
// wxApp (GUI) so the wxDC raster path has a graphics context. OnInit runs the
// spike and returns false to exit immediately (no event loop / window shown).
// ---------------------------------------------------------------------------
class ChartSpikeApp : public wxApp {
public:
  int m_rc = 0;
  bool OnInit() override {
    SetAppName(wxT("opencpn"));
    if (argc < 3) {
      printf("usage: chart-spike <ENC.000> <out.png>\n");
      m_rc = 1;
      return false;
    }
    wxString enc = argv[1];
    wxString png = argv[2];
    m_rc = run_spike(enc, png);
    return false;  // do not enter the main loop
  }
  int OnExit() override { return m_rc; }
};

wxIMPLEMENT_APP_NO_MAIN(ChartSpikeApp);

int main(int argc, char** argv) {
  wxEntryStart(argc, argv);
  wxTheApp->CallOnInit();
  int rc = static_cast<ChartSpikeApp*>(wxTheApp)->m_rc;
  wxEntryCleanup();
  return rc;
}

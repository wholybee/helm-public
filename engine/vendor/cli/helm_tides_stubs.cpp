#include <cmath>

#include <wx/datetime.h>
#include <wx/defs.h>
#include <wx/string.h>
#include <wx/window.h>

// Fallback stubs for standalone tides tools. Three of them (gTimeSource,
// OCPNMessageBox, DistanceBearingMercator) are ALSO provided by the real OpenCPN
// model/gui (gui_vars / chart_stubs / georef). On GCC/clang the weak attribute
// lets the real ones win when both are linked; MSVC has no weak-function
// attribute (selectany is data-only), so on MSVC we defer those three to
// chart-render, which helm-server always links. (Standalone Windows tides tools
// would need them re-provided - not a Phase 1 target.)
#if defined(__GNUC__)
#define HELM_WEAK __attribute__((weak))
#else
#define HELM_WEAK
#endif

#ifndef _MSC_VER   // gTimeSource + OCPNMessageBox come from chart-render on MSVC
HELM_WEAK wxDateTime gTimeSource;

HELM_WEAK int OCPNMessageBox(wxWindow *, const wxString &, const wxString &,
                             int style, int, int, int) {
  return (style & wxYES_NO) ? wxID_NO : wxID_OK;
}
#endif

HELM_WEAK wxDateTime toUsrDateTime(const wxDateTime ts, const int,
                                   const double) {
  return ts;
}

#ifndef _MSC_VER   // DistanceBearingMercator comes from chart-render (georef) on MSVC
extern "C" HELM_WEAK void DistanceBearingMercator(double lat1, double lon1,
                                                  double lat0, double lon0,
                                                  double *brg, double *dist) {
  constexpr double kPi = 3.14159265358979323846;
  constexpr double kDegToRad = kPi / 180.0;
  constexpr double kRadToDeg = 180.0 / kPi;
  constexpr double kEarthRadiusNm = 3440.065;

  double phi0 = lat0 * kDegToRad;
  double phi1 = lat1 * kDegToRad;
  double dphi = (lat1 - lat0) * kDegToRad;
  double dlambda = (lon1 - lon0) * kDegToRad;
  double a = std::sin(dphi / 2.0) * std::sin(dphi / 2.0) +
             std::cos(phi0) * std::cos(phi1) *
                 std::sin(dlambda / 2.0) * std::sin(dlambda / 2.0);
  double c = 2.0 * std::atan2(std::sqrt(a), std::sqrt(1.0 - a));
  if (dist) *dist = kEarthRadiusNm * c;

  if (brg) {
    double y = std::sin(dlambda) * std::cos(phi1);
    double x = std::cos(phi0) * std::sin(phi1) -
               std::sin(phi0) * std::cos(phi1) * std::cos(dlambda);
    double deg = std::fmod(std::atan2(y, x) * kRadToDeg + 360.0, 360.0);
    *brg = deg;
  }
}
#endif  // !_MSC_VER (DistanceBearingMercator from chart-render)

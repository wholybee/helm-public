#include "helm_symbol_render_handoff.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void Fail(const std::string &message) {
  std::cerr << "FAIL symbol-render-handoff-smoke: " << message << "\n";
  std::exit(1);
}

void Check(bool condition, const std::string &message) {
  if (!condition) Fail(message);
}

helm::symbols::SymbolRenderRequest BaseRequest(
    const helm::symbols::SymbolRenderInputFiles &files,
    helm::symbols::SymbolRenderAdapterKind adapter_kind) {
  helm::symbols::SymbolRenderRequest request;
  request.adapter_kind = adapter_kind;
  request.input_files = files;
  request.palette = "day";
  request.symbol_id = "ACCEPT_CHART";
  request.runtime_scope = "chart_portrayal";
  request.source_chart_id = "SYNTH-ADAPTER-1";
  request.source_feature_id = "fixture.accept-chart";
  request.s57_object_class = "TESTOBJ";
  request.s57_geometry = "point";
  request.s57_attributes = {
      {"colour", {"red"}},
      {"category", {"synthetic"}},
  };
  request.s101_feature_type = "SyntheticFeature";
  request.s101_rule_file = "PortrayalCatalog/Rules/SyntheticFeature.lua";
  request.s101_mapping_type = "direct_asset_match";
  request.s101_crosswalk_class = "s101_feature_equivalent";
  request.diagnostic_mode = true;
  return request;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: helm-symbol-render-handoff-smoke "
              << "<runtime-evidence-snapshot.json> <proof-manifest.json>\n";
    return 2;
  }

  helm::symbols::SymbolPackage package;
  std::string error;
  Check(helm::symbols::LoadSymbolPackage(argv[1], argv[2], &package, &error),
        error);

  helm::symbols::SymbolRenderInputFiles files;
  files.runtime_evidence_snapshot = argv[1];
  files.proof_manifest = argv[2];
  files.symbol_selection_fixtures =
      "engine/test/fixtures/symbol-selection/fixtures.json";
  files.atlas_manifest = "s52_atlas_manifest.json";

  helm::symbols::SymbolRenderRequest opencpn_request =
      BaseRequest(files, helm::symbols::SymbolRenderAdapterKind::OpenCpnNative);
  helm::symbols::SymbolRenderRequest helm_request =
      BaseRequest(files, helm::symbols::SymbolRenderAdapterKind::HelmOffscreen);

  const helm::symbols::SymbolRenderHandoff opencpn =
      helm::symbols::ResolveSymbolRenderHandoff(package, opencpn_request);
  const helm::symbols::SymbolRenderHandoff helm =
      helm::symbols::ResolveSymbolRenderHandoff(package, helm_request);

  Check(opencpn.status == helm::symbols::SymbolRenderHandoffStatus::Resolved,
        "OpenCPN adapter did not resolve accepted chart symbol");
  Check(helm.status == helm::symbols::SymbolRenderHandoffStatus::Resolved,
        "Helm/offscreen adapter did not resolve accepted chart symbol");
  Check(helm::symbols::SymbolRenderHandoffSemanticKey(opencpn) ==
            helm::symbols::SymbolRenderHandoffSemanticKey(helm),
        "OpenCPN and Helm/offscreen handoffs diverged");

  Check(opencpn.schema == helm::symbols::kSymbolRenderHandoffSchema,
        "schema version mismatch");
  Check(opencpn.input_files.runtime_evidence_snapshot == argv[1],
        "runtime evidence input file missing from handoff");
  Check(opencpn.input_files.proof_manifest == argv[2],
        "proof manifest input file missing from handoff");
  Check(opencpn.palette == "day", "palette missing from handoff");
  Check(opencpn.symbol_id == "ACCEPT_CHART", "symbol id mismatch");
  Check(opencpn.s57_object_class == "TESTOBJ", "S-57 object class mismatch");
  Check(opencpn.s57_attributes.size() == 2, "S-57 attributes missing");
  Check(opencpn.s101_feature_type == "SyntheticFeature",
        "S-101 feature type mismatch");
  Check(opencpn.s101_rule_file ==
            "PortrayalCatalog/Rules/SyntheticFeature.lua",
        "S-101 rule file mismatch");
  Check(opencpn.s101_mapping_type == "direct_asset_match",
        "S-101 mapping type mismatch");
  Check(opencpn.s101_crosswalk_class == "s101_feature_equivalent",
        "S-101 crosswalk class mismatch");
  Check(opencpn.runtime_approved && opencpn.runtime_eligible_default &&
            opencpn.runtime_eligible_db && !opencpn.fail_closed,
        "runtime eligibility flags did not resolve to approved/default");
  Check(opencpn.resource_id == "sym.ACCEPT_CHART",
        "resource id output handle mismatch");
  Check(opencpn.texture_handle ==
            "texture://helm-symbol-package/day/ACCEPT_CHART",
        "texture handle mismatch");
  Check(opencpn.svg_handle ==
            "symbol-package://svg/day/ACCEPT_CHART.svg",
        "SVG handle mismatch");
  Check(opencpn.atlas_handle ==
            "atlas://helm-clean-room-symbol-package/day/sym.ACCEPT_CHART",
        "atlas handle mismatch");

  const std::string trace = helm::symbols::SymbolRenderHandoffTraceJson(opencpn);
  Check(trace.find("source_object") != std::string::npos,
        "trace omits source object stage");
  Check(trace.find("colour=red") != std::string::npos,
        "trace omits source attributes");
  Check(trace.find("atlas://helm-clean-room-symbol-package/day/sym.ACCEPT_CHART") !=
            std::string::npos,
        "trace omits rendered output handle");

  helm::symbols::SymbolRenderRequest pending_request = opencpn_request;
  pending_request.symbol_id = "PENDING_CHART";
  const helm::symbols::SymbolRenderHandoff pending =
      helm::symbols::ResolveSymbolRenderHandoff(package, pending_request);
  Check(pending.status ==
            helm::symbols::SymbolRenderHandoffStatus::DiagnosticOnly,
        "pending chart symbol should stay diagnostic-only");
  Check(!pending.runtime_eligible_default,
        "pending chart symbol leaked into default runtime rendering");
  Check(!pending.runtime_block_reasons.empty(),
        "pending chart symbol did not explain runtime block reasons");

  helm::symbols::SymbolRenderRequest conflicting_request = opencpn_request;
  conflicting_request.s101_crosswalk_class = "wrong_crosswalk";
  const helm::symbols::SymbolRenderHandoff conflicting =
      helm::symbols::ResolveSymbolRenderHandoff(package, conflicting_request);
  Check(conflicting.status == helm::symbols::SymbolRenderHandoffStatus::Blocked,
        "conflicting S-101 evidence should block the handoff");

  helm::symbols::SymbolRenderRequest missing_request = opencpn_request;
  missing_request.symbol_id = "NO_SUCH_SYMBOL";
  const helm::symbols::SymbolRenderHandoff missing =
      helm::symbols::ResolveSymbolRenderHandoff(package, missing_request);
  Check(missing.status == helm::symbols::SymbolRenderHandoffStatus::Missing,
        "missing symbol should report missing status");

  std::cout << "ok symbol-render-handoff-smoke: OpenCPN and Helm/offscreen "
            << "share one C++ resolver result with traceable artifact handles\n";
  return 0;
}

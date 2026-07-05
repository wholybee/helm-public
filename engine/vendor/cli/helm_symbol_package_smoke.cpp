#include "helm_symbol_package.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void Fail(const std::string &message) {
  std::cerr << "FAIL symbol-package-smoke: " << message << "\n";
  std::exit(1);
}

void Check(bool condition, const std::string &message) {
  if (!condition) Fail(message);
}

int CountCategory(const helm::symbols::SymbolRecord &record,
                  const std::string &category) {
  std::map<std::string, int>::const_iterator it =
      record.blocker_categories.find(category);
  return it == record.blocker_categories.end() ? 0 : it->second;
}

bool HasReason(const helm::symbols::SymbolRecord &record,
               const std::string &reason) {
  for (const std::string &candidate : record.runtime_gate_reason_codes) {
    if (candidate == reason) return true;
  }
  return false;
}

bool HasApprovalBlockReason(const helm::symbols::SymbolRecord &record,
                            const std::string &reason) {
  for (const std::string &candidate : record.runtime_approval_block_reasons) {
    if (candidate == reason) return true;
  }
  return false;
}

bool HasEvidenceLayer(const helm::symbols::SymbolRecord &record,
                      const std::string &layer) {
  for (const helm::symbols::SourceEvidence &evidence :
       record.authority_source_evidence) {
    if (evidence.source_layer == layer) return true;
  }
  return false;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: helm-symbol-package-smoke "
              << "<runtime-evidence-snapshot.json> <proof-manifest.json>\n";
    return 2;
  }

  helm::symbols::SymbolPackage package;
  std::string error;
  Check(helm::symbols::LoadSymbolPackage(argv[1], argv[2], &package, &error),
        error);
  Check(package.snapshot_schema == "helm.iconforge.runtime_evidence_snapshot.v1",
        "snapshot schema not preserved");
  Check(package.manifest_schema == "helm.symbol.cleanroom-package.v1" ||
            package.manifest_schema == "helm.forge.public_cleanroom_symbol_package.v1",
        "proof manifest schema not preserved");
  Check(package.records.size() == 3057, "expected 3057 runtime evidence rows");
  Check(package.default_render_records.empty(),
        "default render path must expose no rows while runtime export is fail-closed");
  Check(package.diagnostic_records.size() == 3057,
        "diagnostic row count should preserve every blocked row");
  Check(package.runtime_rows == 0 && package.hard_pile_rows == 3057,
        "runtime export counts were not preserved");

  const helm::symbols::SymbolRecord *boypil60 =
      helm::symbols::FindSymbol(package, "BOYPIL60", true);
  Check(boypil60 != nullptr, "missing BOYPIL60 diagnostic record");
  Check(!boypil60->runtime_eligible_default,
        "BOYPIL60 must not enter default render path before gates pass");
  Check(!boypil60->runtime_approved,
        "BOYPIL60 must not be runtime-approved before gates pass");
  Check(boypil60->proof_manifest_present,
        "BOYPIL60 proof manifest metadata missing");
  Check(boypil60->package_status == "needs_human_review",
        "BOYPIL60 package review status not preserved");
  Check(!boypil60->proof_final_approved,
        "BOYPIL60 final approval should remain false");
  Check(!boypil60->chartplotter_runtime_eligible,
        "BOYPIL60 chartplotter runtime flag should remain false");
  Check(boypil60->runtime_scope == "chart_portrayal",
        "BOYPIL60 runtime scope should be chart portrayal");
  Check(boypil60->clean_room_generated &&
            boypil60->third_party_artwork_not_source,
        "BOYPIL60 clean-room provenance not preserved");
  Check(boypil60->s57_object_class == "BOYLAT",
        "BOYPIL60 S-57 object class mismatch");
  Check(boypil60->s101_feature_type == "LateralBuoy",
        "BOYPIL60 S-101 feature mismatch");
  Check(CountCategory(*boypil60, "runtime_eligibility_blocker") == 1,
        "BOYPIL60 runtime blocker category missing");
  Check(CountCategory(*boypil60, "s101_feature_catalogue_source_missing") == 1,
        "BOYPIL60 S-101 FeatureCatalogue blocker missing");
  Check(HasEvidenceLayer(*boypil60, "s101_feature_catalogue"),
        "BOYPIL60 source evidence did not expose FeatureCatalogue gap");
  Check(HasReason(*boypil60, "authority_trace:runtime_candidate_not_eligible"),
        "BOYPIL60 runtime reason missing");
  Check(HasApprovalBlockReason(*boypil60, "package_status_not_accepted"),
        "BOYPIL60 package-status block reason missing");
  Check(HasApprovalBlockReason(*boypil60, "final_approved_false"),
        "BOYPIL60 final-approval block reason missing");
  Check(HasApprovalBlockReason(*boypil60, "chartplotter_runtime_not_eligible"),
        "BOYPIL60 chartplotter-runtime block reason missing");
  Check(HasApprovalBlockReason(*boypil60, "runtime_eligible_db_false"),
        "BOYPIL60 DB runtime block reason missing");
  Check(HasApprovalBlockReason(*boypil60, "fail_closed_true"),
        "BOYPIL60 fail-closed block reason missing");

  const helm::symbols::SymbolRecord *topshq28 =
      helm::symbols::FindSymbol(package, "TOPSHQ28", true);
  Check(topshq28 != nullptr, "missing TOPSHQ28 diagnostic record");
  Check(topshq28->s101_feature_type == "Daymark",
        "TOPSHQ28 S-101 feature mismatch");
  Check(CountCategory(*topshq28, "visual_special_case_blocker") >= 1,
        "TOPSHQ28 special-case blocker missing");

  const helm::symbols::SymbolRecord *vrmebl01 =
      helm::symbols::FindSymbol(package, "VRMEBL01", true);
  Check(vrmebl01 != nullptr, "missing VRMEBL01 diagnostic record");
  Check(CountCategory(*vrmebl01, "non_s101_scope_boundary") >= 1,
        "VRMEBL01 non-S-101 scope boundary missing");
  Check(vrmebl01->kind == "conditional-procedure",
        "VRMEBL01 proof manifest kind not preserved");

  const helm::symbols::SymbolRecord *rdocal02 =
      helm::symbols::FindSymbol(package, "rdocal02", true);
  Check(rdocal02 != nullptr, "missing rdocal02 diagnostic record");
  Check(rdocal02->proof_manifest_present,
        "rdocal02 should resolve through public proof row provenance");
  Check(!rdocal02->runtime_eligible_default,
        "rdocal02 must not enter default render path while runtime gate is fail-closed");
  Check(HasApprovalBlockReason(*rdocal02, "package_status_not_accepted"),
        "rdocal02 package-status block reason absent");
  Check(HasApprovalBlockReason(*rdocal02, "final_approved_false"),
        "rdocal02 final-approval block reason absent");

  Check(helm::symbols::FindSymbol(package, "BOYPIL60", false) == nullptr,
        "diagnostic-only BOYPIL60 leaked into default lookup");

  std::cout << "ok symbol-package-smoke: " << package.records.size()
            << " records, " << package.default_render_records.size()
            << " default-render rows, " << package.diagnostic_records.size()
            << " diagnostics\n";
  return 0;
}

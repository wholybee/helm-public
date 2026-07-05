#include "helm_symbol_package.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void Fail(const std::string &message) {
  std::cerr << "FAIL symbol-runtime-gate-smoke: " << message << "\n";
  std::exit(1);
}

void Check(bool condition, const std::string &message) {
  if (!condition) Fail(message);
}

bool HasBlockReason(const helm::symbols::SymbolRecord &record,
                    const std::string &reason) {
  for (const std::string &candidate : record.runtime_approval_block_reasons) {
    if (candidate == reason) return true;
  }
  return false;
}

const helm::symbols::SymbolRecord &RequiredDiagnostic(
    const helm::symbols::SymbolPackage &package,
    const std::string &symbol_id) {
  const helm::symbols::SymbolRecord *record =
      helm::symbols::FindSymbol(package, symbol_id, true);
  Check(record != nullptr, symbol_id + " missing from diagnostic lookup");
  return *record;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: helm-symbol-runtime-gate-smoke "
              << "<runtime-evidence-snapshot.json> <proof-manifest.json>\n";
    return 2;
  }

  helm::symbols::SymbolPackage package;
  std::string error;
  Check(helm::symbols::LoadSymbolPackage(argv[1], argv[2], &package, &error),
        error);

  Check(package.records.size() == 7, "expected seven synthetic gate rows");
  Check(package.default_render_records.size() == 1,
        "only one row should enter default chart rendering");
  Check(package.diagnostic_records.size() == 6,
        "six rows should remain diagnostic-only");

  const helm::symbols::SymbolRecord *accepted_chart =
      helm::symbols::FindSymbol(package, "ACCEPT_CHART", false);
  Check(accepted_chart != nullptr,
        "accepted chart row missing from default lookup");
  Check(accepted_chart->runtime_approved,
        "accepted chart row should be runtime-approved");
  Check(accepted_chart->runtime_eligible_default,
        "accepted chart row should be default-chart eligible");
  Check(accepted_chart->runtime_scope == "chart_portrayal",
        "accepted chart row scope mismatch");
  Check(accepted_chart->runtime_approval_block_reasons.empty(),
        "accepted chart row should have no block reasons");

  Check(helm::symbols::FindSymbolForScope(
            package, "ACCEPT_CHART", "chart_portrayal", false) != nullptr,
        "accepted chart row missing from chart scope lookup");
  Check(helm::symbols::FindSymbolForScope(
            package, "ACCEPT_CHART", "renderer_overlay_or_ui", false) == nullptr,
        "accepted chart row leaked into overlay scope");

  const helm::symbols::SymbolRecord &pending =
      RequiredDiagnostic(package, "PENDING_CHART");
  Check(!pending.runtime_approved && !pending.runtime_eligible_default,
        "pending row leaked into approved/default state");
  Check(helm::symbols::FindSymbol(package, "PENDING_CHART", false) == nullptr,
        "pending row leaked into default lookup");
  Check(HasBlockReason(pending, "package_status_not_accepted"),
        "pending row missing status block reason");
  Check(HasBlockReason(pending, "final_approved_false"),
        "pending row missing final approval block reason");
  Check(HasBlockReason(pending, "chartplotter_runtime_not_eligible"),
        "pending row missing chartplotter runtime block reason");

  const helm::symbols::SymbolRecord &rejected =
      RequiredDiagnostic(package, "REJECTED_CHART");
  Check(!rejected.runtime_approved,
        "rejected row should not be runtime-approved");
  Check(HasBlockReason(rejected, "package_status_not_accepted"),
        "rejected row missing status block reason");

  const helm::symbols::SymbolRecord &fail_closed =
      RequiredDiagnostic(package, "FAIL_CLOSED");
  Check(!fail_closed.runtime_approved,
        "fail-closed row should not be runtime-approved");
  Check(HasBlockReason(fail_closed, "fail_closed_true"),
        "fail-closed row missing fail-closed block reason");

  const helm::symbols::SymbolRecord &missing_proof =
      RequiredDiagnostic(package, "MISSING_PROOF");
  Check(!missing_proof.runtime_approved,
        "missing-proof row should not be runtime-approved");
  Check(HasBlockReason(missing_proof, "proof_manifest_missing"),
        "missing-proof row missing proof block reason");
  Check(HasBlockReason(missing_proof, "runtime_scope_missing"),
        "missing-proof row missing scope block reason");

  const helm::symbols::SymbolRecord *overlay_default =
      helm::symbols::FindSymbol(package, "ACCEPT_OVERLAY", false);
  Check(overlay_default == nullptr,
        "approved overlay row leaked into default chart lookup");
  const helm::symbols::SymbolRecord *overlay_scoped =
      helm::symbols::FindSymbolForScope(
          package, "ACCEPT_OVERLAY", "renderer_overlay_or_ui", false);
  Check(overlay_scoped != nullptr,
        "approved overlay row missing from explicit overlay scope");
  Check(overlay_scoped->runtime_approved &&
            !overlay_scoped->runtime_eligible_default,
        "overlay row should be approved but not default-chart eligible");

  const helm::symbols::SymbolRecord *extension_default =
      helm::symbols::FindSymbol(package, "ACCEPT_EXTENSION", false);
  Check(extension_default == nullptr,
        "approved extension row leaked into default chart lookup");
  const helm::symbols::SymbolRecord *extension_scoped =
      helm::symbols::FindSymbolForScope(
          package, "ACCEPT_EXTENSION", "extension_profile_or_manual_mapping", false);
  Check(extension_scoped != nullptr,
        "approved extension row missing from explicit extension scope");
  Check(extension_scoped->runtime_approved &&
            !extension_scoped->runtime_eligible_default,
        "extension row should be approved but not default-chart eligible");

  std::cout << "ok symbol-runtime-gate-smoke: default chart eligibility is "
            << "accepted/final-approved only, explicit scopes stay separate\n";
  return 0;
}

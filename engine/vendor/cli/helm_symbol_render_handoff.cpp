#include "helm_symbol_render_handoff.h"

#include <algorithm>
#include <sstream>

namespace helm {
namespace symbols {
namespace {

std::string Join(const std::vector<std::string> &values,
                 const std::string &separator) {
  std::ostringstream out;
  for (size_t i = 0; i < values.size(); ++i) {
    if (i != 0) out << separator;
    out << values[i];
  }
  return out.str();
}

std::string EscapeJson(const std::string &value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out.push_back(c); break;
    }
  }
  return out;
}

std::string AttributeSummary(const std::vector<SymbolRenderAttribute> &attributes) {
  std::vector<std::string> pairs;
  for (const SymbolRenderAttribute &attribute : attributes) {
    pairs.push_back(attribute.name + "=" + Join(attribute.values, "|"));
  }
  std::sort(pairs.begin(), pairs.end());
  return Join(pairs, ",");
}

void AddTrace(SymbolRenderHandoff *handoff,
              const std::string &stage,
              const std::string &detail) {
  handoff->trace.push_back(SymbolRenderTraceStep{stage, detail});
}

bool FieldConflicts(const std::string &expected,
                    const std::string &actual) {
  return !expected.empty() && !actual.empty() && expected != actual;
}

std::string BuildResourceId(const std::string &symbol_id) {
  return "sym." + symbol_id;
}

std::string BuildTextureHandle(const std::string &palette,
                               const std::string &symbol_id) {
  return "texture://helm-symbol-package/" + palette + "/" + symbol_id;
}

std::string BuildSvgHandle(const std::string &palette,
                           const std::string &symbol_id) {
  return "symbol-package://svg/" + palette + "/" + symbol_id + ".svg";
}

std::string BuildAtlasHandle(const std::string &palette,
                             const std::string &symbol_id) {
  return "atlas://helm-clean-room-symbol-package/" + palette + "/sym." + symbol_id;
}

}  // namespace

const char *SymbolRenderAdapterKindName(SymbolRenderAdapterKind kind) {
  switch (kind) {
    case SymbolRenderAdapterKind::OpenCpnNative: return "opencpn_native";
    case SymbolRenderAdapterKind::HelmOffscreen: return "helm_offscreen";
  }
  return "unknown";
}

const char *SymbolRenderHandoffStatusName(SymbolRenderHandoffStatus status) {
  switch (status) {
    case SymbolRenderHandoffStatus::Resolved: return "resolved";
    case SymbolRenderHandoffStatus::DiagnosticOnly: return "diagnostic_only";
    case SymbolRenderHandoffStatus::Blocked: return "blocked";
    case SymbolRenderHandoffStatus::Missing: return "missing";
  }
  return "unknown";
}

SymbolRenderHandoff ResolveSymbolRenderHandoff(
    const SymbolPackage &package,
    const SymbolRenderRequest &request) {
  SymbolRenderHandoff out;
  out.adapter_kind = request.adapter_kind;
  out.input_files = request.input_files;
  out.palette = request.palette;
  out.symbol_id = request.symbol_id;
  out.s57_object_class = request.s57_object_class;
  out.s57_geometry = request.s57_geometry;
  out.s57_attributes = request.s57_attributes;
  out.s101_feature_type = request.s101_feature_type;
  out.s101_rule_file = request.s101_rule_file;
  out.s101_mapping_type = request.s101_mapping_type;
  out.s101_crosswalk_class = request.s101_crosswalk_class;
  out.runtime_scope = request.runtime_scope;

  AddTrace(&out, "adapter",
           std::string(SymbolRenderAdapterKindName(request.adapter_kind)) +
               " requested shared symbol handoff");
  AddTrace(&out, "inputs",
           "runtime_evidence_snapshot=" + request.input_files.runtime_evidence_snapshot +
               "; proof_manifest=" + request.input_files.proof_manifest +
               "; symbol_selection_fixtures=" +
               request.input_files.symbol_selection_fixtures +
               "; atlas_manifest=" + request.input_files.atlas_manifest);
  AddTrace(&out, "source_object",
           "chart=" + request.source_chart_id +
               "; feature=" + request.source_feature_id +
               "; object_class=" + request.s57_object_class +
               "; geometry=" + request.s57_geometry +
               "; attributes={" + AttributeSummary(request.s57_attributes) + "}");

  const bool include_diagnostics = true;
  const SymbolRecord *record = nullptr;
  if (!request.runtime_scope.empty()) {
    record = FindSymbolForScope(package, request.symbol_id,
                                request.runtime_scope, include_diagnostics);
  }
  if (record == nullptr) {
    record = FindSymbol(package, request.symbol_id, include_diagnostics);
  }

  if (record == nullptr) {
    out.status = SymbolRenderHandoffStatus::Missing;
    AddTrace(&out, "resolver", "symbol_id not present in package evidence");
    return out;
  }

  out.resource_id = BuildResourceId(record->symbol_id);
  out.texture_handle = BuildTextureHandle(request.palette, record->symbol_id);
  out.svg_handle = BuildSvgHandle(request.palette, record->symbol_id);
  out.atlas_handle = BuildAtlasHandle(request.palette, record->symbol_id);
  out.resolver_row_key = record->row_key;
  out.helm_catalog_id = record->helm_catalog_id;
  out.symbol_id = record->symbol_id;
  out.s57_object_class = record->s57_object_class;
  out.s57_geometry = record->s57_geometry;
  out.s101_feature_type = record->s101_feature_type;
  out.s101_rule_file = record->s101_rule_file;
  out.s101_mapping_type = record->s101_mapping_type;
  out.s101_crosswalk_class = record->s101_crosswalk_class;
  out.runtime_scope = record->runtime_scope;
  out.runtime_approved = record->runtime_approved;
  out.runtime_eligible_default = record->runtime_eligible_default;
  out.runtime_eligible_db = record->runtime_eligible_db;
  out.fail_closed = record->fail_closed;
  out.runtime_block_reasons = record->runtime_approval_block_reasons;

  AddTrace(&out, "resolver",
           "row_key=" + record->row_key +
               "; helm_catalog_id=" + record->helm_catalog_id +
               "; package_schema=" + package.snapshot_schema +
               "; manifest_schema=" + package.manifest_schema +
               "; runtime_scope=" + record->runtime_scope +
               "; crosswalk_class=" + record->s101_crosswalk_class);
  AddTrace(&out, "output",
           "resource_id=" + out.resource_id +
               "; texture_handle=" + out.texture_handle +
               "; svg_handle=" + out.svg_handle +
               "; atlas_handle=" + out.atlas_handle);

  if (request.palette.empty()) {
    out.status = SymbolRenderHandoffStatus::Blocked;
    out.runtime_block_reasons.push_back("palette_missing");
    AddTrace(&out, "blocked", "palette is required for palette-specific artifact handles");
    return out;
  }

  if (FieldConflicts(request.s57_object_class, record->s57_object_class) ||
      FieldConflicts(request.s101_feature_type, record->s101_feature_type) ||
      FieldConflicts(request.s101_rule_file, record->s101_rule_file) ||
      FieldConflicts(request.s101_mapping_type, record->s101_mapping_type) ||
      FieldConflicts(request.s101_crosswalk_class, record->s101_crosswalk_class)) {
    out.status = SymbolRenderHandoffStatus::Blocked;
    out.runtime_block_reasons.push_back("request_evidence_conflicts_with_resolver");
    AddTrace(&out, "blocked",
             "request S-57/S-101 evidence does not match package resolver row");
    return out;
  }

  if (record->runtime_eligible_default) {
    out.status = SymbolRenderHandoffStatus::Resolved;
  } else {
    out.status = SymbolRenderHandoffStatus::DiagnosticOnly;
  }
  return out;
}

std::string SymbolRenderHandoffSemanticKey(const SymbolRenderHandoff &handoff) {
  std::ostringstream out;
  out << handoff.schema
      << "|status=" << SymbolRenderHandoffStatusName(handoff.status)
      << "|palette=" << handoff.palette
      << "|symbol_id=" << handoff.symbol_id
      << "|resource_id=" << handoff.resource_id
      << "|texture=" << handoff.texture_handle
      << "|svg=" << handoff.svg_handle
      << "|atlas=" << handoff.atlas_handle
      << "|row_key=" << handoff.resolver_row_key
      << "|catalog=" << handoff.helm_catalog_id
      << "|s57=" << handoff.s57_object_class
      << "|s101_feature=" << handoff.s101_feature_type
      << "|s101_rule=" << handoff.s101_rule_file
      << "|mapping=" << handoff.s101_mapping_type
      << "|crosswalk=" << handoff.s101_crosswalk_class
      << "|scope=" << handoff.runtime_scope
      << "|runtime_approved=" << (handoff.runtime_approved ? "true" : "false")
      << "|runtime_default=" << (handoff.runtime_eligible_default ? "true" : "false")
      << "|runtime_db=" << (handoff.runtime_eligible_db ? "true" : "false")
      << "|fail_closed=" << (handoff.fail_closed ? "true" : "false");
  return out.str();
}

std::string SymbolRenderHandoffTraceJson(const SymbolRenderHandoff &handoff) {
  std::ostringstream out;
  out << "{";
  out << "\"schema\":\"" << EscapeJson(handoff.schema) << "\",";
  out << "\"adapter\":\"" << SymbolRenderAdapterKindName(handoff.adapter_kind) << "\",";
  out << "\"status\":\"" << SymbolRenderHandoffStatusName(handoff.status) << "\",";
  out << "\"symbol_id\":\"" << EscapeJson(handoff.symbol_id) << "\",";
  out << "\"palette\":\"" << EscapeJson(handoff.palette) << "\",";
  out << "\"runtime_eligible_default\":"
      << (handoff.runtime_eligible_default ? "true" : "false") << ",";
  out << "\"trace\":[";
  for (size_t i = 0; i < handoff.trace.size(); ++i) {
    if (i != 0) out << ",";
    out << "{\"stage\":\"" << EscapeJson(handoff.trace[i].stage)
        << "\",\"detail\":\"" << EscapeJson(handoff.trace[i].detail) << "\"}";
  }
  out << "]}";
  return out.str();
}

}  // namespace symbols
}  // namespace helm

#pragma once

#include "helm_symbol_package.h"

#include <string>
#include <vector>

namespace helm {
namespace symbols {

inline constexpr const char *kSymbolRenderHandoffSchema =
    "helm.symbol.render_handoff.v1";

enum class SymbolRenderAdapterKind {
  OpenCpnNative,
  HelmOffscreen
};

enum class SymbolRenderHandoffStatus {
  Resolved,
  DiagnosticOnly,
  Blocked,
  Missing
};

struct SymbolRenderInputFiles {
  std::string runtime_evidence_snapshot;
  std::string proof_manifest;
  std::string symbol_selection_fixtures;
  std::string atlas_manifest;
};

struct SymbolRenderAttribute {
  std::string name;
  std::vector<std::string> values;
};

struct SymbolRenderRequest {
  SymbolRenderAdapterKind adapter_kind = SymbolRenderAdapterKind::HelmOffscreen;
  SymbolRenderInputFiles input_files;
  std::string palette;
  std::string symbol_id;
  std::string runtime_scope = "chart_portrayal";
  std::string source_chart_id;
  std::string source_feature_id;
  std::string s57_object_class;
  std::string s57_geometry;
  std::vector<SymbolRenderAttribute> s57_attributes;
  std::string s101_feature_type;
  std::string s101_rule_file;
  std::string s101_mapping_type;
  std::string s101_crosswalk_class;
  bool diagnostic_mode = false;
};

struct SymbolRenderTraceStep {
  std::string stage;
  std::string detail;
};

struct SymbolRenderHandoff {
  std::string schema = kSymbolRenderHandoffSchema;
  SymbolRenderHandoffStatus status = SymbolRenderHandoffStatus::Missing;
  SymbolRenderAdapterKind adapter_kind = SymbolRenderAdapterKind::HelmOffscreen;
  SymbolRenderInputFiles input_files;
  std::string palette;
  std::string symbol_id;
  std::string resource_id;
  std::string texture_handle;
  std::string svg_handle;
  std::string atlas_handle;
  std::string resolver_row_key;
  std::string helm_catalog_id;
  std::string s57_object_class;
  std::string s57_geometry;
  std::vector<SymbolRenderAttribute> s57_attributes;
  std::string s101_feature_type;
  std::string s101_rule_file;
  std::string s101_mapping_type;
  std::string s101_crosswalk_class;
  std::string runtime_scope;
  bool runtime_approved = false;
  bool runtime_eligible_default = false;
  bool runtime_eligible_db = false;
  bool fail_closed = true;
  std::vector<std::string> runtime_block_reasons;
  std::vector<SymbolRenderTraceStep> trace;
};

const char *SymbolRenderAdapterKindName(SymbolRenderAdapterKind kind);

const char *SymbolRenderHandoffStatusName(SymbolRenderHandoffStatus status);

SymbolRenderHandoff ResolveSymbolRenderHandoff(
    const SymbolPackage &package,
    const SymbolRenderRequest &request);

std::string SymbolRenderHandoffSemanticKey(const SymbolRenderHandoff &handoff);

std::string SymbolRenderHandoffTraceJson(const SymbolRenderHandoff &handoff);

}  // namespace symbols
}  // namespace helm

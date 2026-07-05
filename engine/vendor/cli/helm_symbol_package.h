#pragma once

#include <map>
#include <string>
#include <vector>

namespace helm {
namespace symbols {

struct SourceEvidence {
  std::string reason_code;
  std::string blocker_category;
  std::string source_layer;
  std::string path;
  std::string sha256;
  std::string parse_status;
  std::string feature_type;
  std::string rule_file;
  std::string gate_name;
  std::string gate_status;
};

struct SymbolRecord {
  int row_id = 0;
  std::string row_key;
  std::string symbol_id;
  std::string helm_catalog_id;
  std::string kind;
  std::string name;
  std::string family;
  std::string package_status;
  std::string runtime_scope;
  std::string runtime_state;
  std::string candidate_status;
  bool runtime_eligible_db = false;
  bool runtime_approved = false;
  bool runtime_eligible_default = false;
  bool proof_final_approved = false;
  bool chartplotter_runtime_eligible = false;
  bool fail_closed = true;
  bool proof_manifest_present = false;
  bool clean_room_generated = false;
  bool comparison_refs_only = false;
  bool third_party_artwork_not_source = false;
  std::string s57_object_class;
  std::string s57_geometry;
  std::string s52_instruction;
  std::string s52_ast_status;
  std::string s101_mapping_type;
  std::string s101_crosswalk_class;
  std::string s101_feature_type;
  std::string s101_rule_file;
  std::map<std::string, int> blocker_categories;
  std::map<std::string, int> runtime_effects;
  std::vector<std::string> runtime_gate_reason_codes;
  std::vector<std::string> runtime_approval_block_reasons;
  std::vector<std::string> remediation_hints;
  std::vector<SourceEvidence> authority_source_evidence;
};

struct SymbolPackage {
  std::string snapshot_schema;
  std::string snapshot_status;
  std::string manifest_schema;
  std::string manifest_status;
  int snapshot_rows = 0;
  int runtime_rows = 0;
  int hard_pile_rows = 0;
  int warning_only_rows = 0;
  bool matches_runtime_promotion_gate = false;
  std::vector<SymbolRecord> records;
  std::vector<const SymbolRecord *> default_render_records;
  std::vector<const SymbolRecord *> diagnostic_records;
};

bool LoadSymbolPackage(const std::string &runtime_evidence_snapshot_path,
                       const std::string &proof_manifest_path,
                       SymbolPackage *package,
                       std::string *error);

const SymbolRecord *FindSymbol(const SymbolPackage &package,
                               const std::string &symbol_id,
                               bool include_diagnostics);

const SymbolRecord *FindSymbolForScope(const SymbolPackage &package,
                                       const std::string &symbol_id,
                                       const std::string &runtime_scope,
                                       bool include_diagnostics);

}  // namespace symbols
}  // namespace helm

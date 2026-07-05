CREATE TABLE s52_portrayal_lookup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL DEFAULT 'OpenCPN',
  source_git_sha TEXT NOT NULL,
  source_file TEXT NOT NULL DEFAULT 'data/s57data/chartsymbols.xml',
  lookup_id INTEGER NOT NULL,
  rcid INTEGER NOT NULL,
  sequence_order INTEGER NOT NULL,
  object_acronym TEXT NOT NULL,
  object_code INTEGER,
  object_name TEXT,
  primitive_type TEXT NOT NULL CHECK (primitive_type IN ('Point', 'Line', 'Area')),
  lookup_table TEXT NOT NULL CHECK (lookup_table IN ('Simplified', 'Paper', 'Lines', 'Plain', 'Symbolized')),
  display_category TEXT CHECK (display_category IN ('Displaybase', 'Standard', 'Other', 'Mariners') OR display_category IS NULL),
  display_priority TEXT NOT NULL,
  radar_priority TEXT,
  attribute_predicates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attribute_predicates)),
  instruction TEXT NOT NULL DEFAULT '',
  symbol_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(symbol_refs)),
  line_style_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(line_style_refs)),
  pattern_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pattern_refs)),
  color_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(color_refs)),
  conditional_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conditional_refs)),
  text_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(text_refs)),
  comment_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_git_sha, lookup_id, rcid, sequence_order)
);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE s52_portrayal_resource (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_git_sha TEXT NOT NULL,
  resource_order INTEGER NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('symbol', 'line_style', 'pattern', 'palette_color')),
  name TEXT NOT NULL,
  rcid INTEGER,
  description TEXT,
  definition_type TEXT,
  color_ref TEXT,
  hpgl TEXT,
  bitmap TEXT CHECK (bitmap IS NULL OR json_valid(bitmap)),
  vector TEXT CHECK (vector IS NULL OR json_valid(vector)),
  palette TEXT CHECK (palette IS NULL OR json_valid(palette)),
  UNIQUE (source_git_sha, resource_type, resource_order)
);
CREATE TABLE s52_source_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX s52_portrayal_lookup_object_idx ON s52_portrayal_lookup (object_acronym);
CREATE INDEX s52_portrayal_lookup_match_idx ON s52_portrayal_lookup (object_acronym, primitive_type, lookup_table, display_category);
CREATE INDEX s52_portrayal_lookup_rcid_idx ON s52_portrayal_lookup (rcid);
CREATE INDEX s52_portrayal_resource_name_idx ON s52_portrayal_resource (name);
CREATE INDEX s52_portrayal_resource_type_idx ON s52_portrayal_resource (resource_type);
CREATE TABLE iconforge_s101_topmark_mapping_row (
          s52_lookup_id integer primary key references runtime_symbol_candidate(s52_lookup_id) on delete cascade,
          row_key text not null,
          asset text,
          object_class text not null,
          source_topmark_shape_code integer,
          source_topmark_shape_label text,
          source_topmark_normalized_name text,
          topmark_context text not null check (topmark_context in ('rigid', 'floating', 'context_required')),
          context_basis text not null,
          s101_symbol_id text,
          s101_symbol_file text,
          s101_local_reference_path text,
          s101_rule_file text not null,
          s101_rule_context text,
          shape_safe integer not null check (shape_safe in (0, 1)),
          map_status text not null,
          semantic_json text not null check (json_valid(semantic_json)),
          s101_attributes_json text not null check (json_valid(s101_attributes_json)),
          evidence_json text not null check (json_valid(evidence_json)),
          source_boundary text not null default 'reference_only_not_bundled',
          created_at text not null default current_timestamp
        );
CREATE INDEX idx_iconforge_s101_topmark_mapping_asset
          on iconforge_s101_topmark_mapping_row(asset);
CREATE TABLE iconforge_s101_topmark_asset_map (
          asset text primary key,
          asset_status text not null,
          preferred_s52_lookup_id integer references runtime_symbol_candidate(s52_lookup_id) on delete set null,
          source_topmark_shape_code integer,
          source_topmark_shape_label text,
          topmark_context text,
          context_basis text,
          s101_symbol_id text,
          s101_symbol_file text,
          s101_local_reference_path text,
          shape_safe integer not null check (shape_safe in (0, 1)),
          row_count integer not null,
          safe_row_count integer not null,
          context_required_count integer not null,
          evidence_json text not null check (json_valid(evidence_json)),
          source_boundary text not null default 'reference_only_not_bundled',
          created_at text not null default current_timestamp
        );
CREATE TABLE s52_topmark_shape_decode (
          source_attribute TEXT NOT NULL DEFAULT 'TOPSHP',
          code INTEGER PRIMARY KEY,
          source_label TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          decode_status TEXT NOT NULL,
          is_standard_s57 INTEGER NOT NULL CHECK (is_standard_s57 IN (0, 1)),
          applies_to TEXT NOT NULL DEFAULT 'TOPMAR,topmar,DAYMAR',
          source_file TEXT NOT NULL,
          source_boundary TEXT NOT NULL DEFAULT 'OpenCPN/S-57 decode metadata'
        );
CREATE TABLE s52_semantic_tuple (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          s52_lookup_id INTEGER NOT NULL REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          row_key TEXT NOT NULL,
          tuple_generator TEXT NOT NULL DEFAULT 'scripts/augment-opencpn-s52-s101-semantics.py',
          tuple_status TEXT NOT NULL CHECK (tuple_status IN ('complete', 'partial')),
          object_class TEXT NOT NULL,
          original_object_acronym TEXT NOT NULL,
          geometry TEXT NOT NULL CHECK (geometry IN ('point', 'line', 'area')),
          s52_symbol_id TEXT,
          s52_asset_kind TEXT NOT NULL,
          category TEXT NOT NULL,
          shape TEXT,
          colour_sequence TEXT NOT NULL CHECK (json_valid(colour_sequence)),
          colour_pattern TEXT,
          topmark TEXT,
          topmark_shape_code INTEGER REFERENCES s52_topmark_shape_decode(code),
          topmark_shape_label TEXT,
          topmark_shape_source_attribute TEXT,
          topmark_context TEXT CHECK (topmark_context IN ('topmark', 'daymark') OR topmark_context IS NULL),
          status_condition TEXT NOT NULL CHECK (json_valid(status_condition)),
          display_mode TEXT NOT NULL,
          missing_data_reasons TEXT NOT NULL CHECK (json_valid(missing_data_reasons)),
          semantic_tuple TEXT NOT NULL CHECK (json_valid(semantic_tuple)),
          source_refs TEXT NOT NULL CHECK (json_valid(source_refs)),
          s101_resolution_policy TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (s52_lookup_id)
        );
CREATE TABLE s101_portrayal_equivalence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          s52_semantic_tuple_id INTEGER NOT NULL REFERENCES s52_semantic_tuple(id) ON DELETE CASCADE,
          s52_lookup_id INTEGER NOT NULL REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          row_key TEXT NOT NULL,
          s52_symbol_id TEXT,
          mapping_type TEXT NOT NULL CHECK (mapping_type IN ('rule_derived_equivalent', 'acceptable_deviation', 'semantic_only', 'unresolved')),
          s101_feature_type TEXT,
          s101_attributes TEXT NOT NULL CHECK (json_valid(s101_attributes)),
          portrayal_evidence TEXT CHECK (portrayal_evidence IS NULL OR json_valid(portrayal_evidence)),
          direct_asset_match TEXT CHECK (direct_asset_match IS NULL OR json_valid(direct_asset_match)),
          unresolved_reasons TEXT NOT NULL CHECK (json_valid(unresolved_reasons)),
          policy TEXT NOT NULL CHECK (json_valid(policy)),
          standards_references TEXT NOT NULL CHECK (json_valid(standards_references)),
          source_refs TEXT NOT NULL CHECK (json_valid(source_refs)),
          source_boundary TEXT NOT NULL DEFAULT 'reference_only_not_bundled',
          runtime_eligible INTEGER NOT NULL DEFAULT 0 CHECK (runtime_eligible IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (s52_lookup_id)
        );
CREATE TABLE s52_instruction_ast (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          s52_lookup_id INTEGER NOT NULL REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          raw_instruction TEXT NOT NULL,
          parser_version TEXT NOT NULL DEFAULT 's52-instruction-ast.v1',
          parse_status TEXT NOT NULL CHECK (parse_status IN ('complete', 'partial')),
          command_count INTEGER NOT NULL,
          command_sequence TEXT NOT NULL CHECK (json_valid(command_sequence)),
          ast TEXT NOT NULL CHECK (json_valid(ast)),
          symbol_refs TEXT NOT NULL CHECK (json_valid(symbol_refs)),
          line_style_refs TEXT NOT NULL CHECK (json_valid(line_style_refs)),
          pattern_refs TEXT NOT NULL CHECK (json_valid(pattern_refs)),
          color_refs TEXT NOT NULL CHECK (json_valid(color_refs)),
          conditional_refs TEXT NOT NULL CHECK (json_valid(conditional_refs)),
          text_refs TEXT NOT NULL CHECK (json_valid(text_refs)),
          parse_errors TEXT NOT NULL CHECK (json_valid(parse_errors)),
          source_boundary TEXT NOT NULL DEFAULT 'OpenCPN S-52 instruction grammar mirror',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (s52_lookup_id)
        );
CREATE TABLE s52_s101_import_audit (
          check_name TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
          expected TEXT NOT NULL,
          actual TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE iconforge_approval_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          source_root TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE iconforge_standard_source_row (
          asset TEXT PRIMARY KEY,
          object_class TEXT,
          helm_catalog_id TEXT,
          candidate_status TEXT,
          s57_structure TEXT CHECK (s57_structure IS NULL OR json_valid(s57_structure)),
          row_json TEXT NOT NULL CHECK (json_valid(row_json)),
          source_root TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE iconforge_s101_resolver_row (
          asset TEXT PRIMARY KEY,
          helm_catalog_id TEXT,
          object_class TEXT,
          resolver_status TEXT NOT NULL,
          s101_mapping_type TEXT NOT NULL,
          s101_crosswalk_class TEXT,
          basis TEXT,
          runtime_scope TEXT,
          s101_feature_type TEXT,
          s101_rule_file TEXT,
          s101_direct_symbol_id TEXT,
          exact_filename_match INTEGER CHECK (exact_filename_match IN (0, 1)),
          false_filename_gap INTEGER CHECK (false_filename_gap IN (0, 1)),
          s101_attributes TEXT NOT NULL CHECK (json_valid(s101_attributes)),
          portrayal_evidence TEXT NOT NULL CHECK (json_valid(portrayal_evidence)),
          semantic_tuple TEXT CHECK (semantic_tuple IS NULL OR json_valid(semantic_tuple)),
          unresolved_reasons TEXT NOT NULL CHECK (json_valid(unresolved_reasons)),
          raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
          source_root TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE iconforge_topmark_gate_row (
          asset TEXT PRIMARY KEY,
          gate_status TEXT NOT NULL,
          recommended_status TEXT,
          candidate_status TEXT,
          expected_shape_code INTEGER,
          expected_shape_id TEXT,
          expected_shape_name TEXT,
          primary_s101_symbol_id TEXT,
          primary_s101_description TEXT,
          finding_codes TEXT NOT NULL CHECK (json_valid(finding_codes)),
          raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
          source_root TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE iconforge_s52_lookup_link (
          asset TEXT NOT NULL,
          s52_lookup_id INTEGER NOT NULL REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          link_reason TEXT NOT NULL,
          PRIMARY KEY (asset, s52_lookup_id, link_reason)
        );
CREATE TABLE runtime_symbol_gate (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          s52_lookup_id INTEGER NOT NULL REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          gate_name TEXT NOT NULL,
          gate_status TEXT NOT NULL CHECK (gate_status IN ('pass', 'warn', 'pending', 'blocked')),
          severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocker')),
          detail TEXT NOT NULL,
          evidence TEXT NOT NULL CHECK (json_valid(evidence)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (s52_lookup_id, gate_name)
        );
CREATE TABLE runtime_symbol_candidate (
          s52_lookup_id INTEGER PRIMARY KEY REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          row_key TEXT NOT NULL,
          object_class TEXT NOT NULL,
          s52_symbol_id TEXT,
          s52_asset_kind TEXT NOT NULL,
          category TEXT NOT NULL,
          geometry TEXT NOT NULL,
          display_mode TEXT NOT NULL,
          candidate_status TEXT NOT NULL CHECK (candidate_status IN ('runtime_eligible', 'review_candidate', 'blocked')),
          runtime_eligible INTEGER NOT NULL CHECK (runtime_eligible IN (0, 1)),
          blocking_gate_count INTEGER NOT NULL,
          pending_gate_count INTEGER NOT NULL,
          warning_gate_count INTEGER NOT NULL,
          gate_summary TEXT NOT NULL CHECK (json_valid(gate_summary)),
          semantic_tuple TEXT NOT NULL CHECK (json_valid(semantic_tuple)),
          s101_feature_type TEXT,
          s101_attributes TEXT NOT NULL CHECK (json_valid(s101_attributes)),
          s52_instruction TEXT NOT NULL,
          source_refs TEXT NOT NULL CHECK (json_valid(source_refs)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE electronic_chart1_entry (
          s52_lookup_id INTEGER PRIMARY KEY REFERENCES s52_portrayal_lookup(id) ON DELETE CASCADE,
          row_key TEXT NOT NULL,
          chart1_row_id TEXT NOT NULL UNIQUE,
          row_taxonomy TEXT NOT NULL CHECK (
            row_taxonomy IN (
              'point_symbol',
              'line_style',
              'area_fill',
              'conditional_rule',
              'text_rule',
              'runtime_overlay',
              'placeholder_manual',
              'non_reviewable_construct'
            )
          ),
          taxonomy_reason TEXT NOT NULL,
          evidence_status TEXT NOT NULL CHECK (evidence_status IN ('green', 'yellow', 'red')),
          render_eligibility TEXT NOT NULL CHECK (render_eligibility = 'fail_closed_not_runtime_eligible'),
          reason_codes TEXT NOT NULL CHECK (json_valid(reason_codes)),
          s57_object_class TEXT NOT NULL,
          s57_attribute_tuple TEXT NOT NULL CHECK (json_valid(s57_attribute_tuple)),
          s52_instruction TEXT NOT NULL,
          s52_instruction_evidence TEXT NOT NULL CHECK (json_valid(s52_instruction_evidence)),
          s101_evidence TEXT NOT NULL CHECK (json_valid(s101_evidence)),
          helm_art_path TEXT,
          helm_art_status TEXT NOT NULL,
          colour_authority TEXT NOT NULL CHECK (json_valid(colour_authority)),
          shape_family_authority TEXT NOT NULL CHECK (json_valid(shape_family_authority)),
          human_qa_status TEXT NOT NULL CHECK (json_valid(human_qa_status)),
          provenance TEXT NOT NULL CHECK (json_valid(provenance)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE VIEW runtime_symbol_candidate_v1 AS
        SELECT
          c.s52_lookup_id,
          c.row_key,
          c.object_class,
          c.s52_symbol_id,
          c.s52_asset_kind,
          c.category,
          c.geometry,
          c.display_mode,
          c.candidate_status,
          c.runtime_eligible,
          c.blocking_gate_count,
          c.pending_gate_count,
          c.warning_gate_count,
          c.gate_summary,
          c.semantic_tuple,
          c.s101_feature_type,
          c.s101_attributes,
          c.s52_instruction,
          c.source_refs
        FROM runtime_symbol_candidate c
/* runtime_symbol_candidate_v1(s52_lookup_id,row_key,object_class,s52_symbol_id,s52_asset_kind,category,geometry,display_mode,candidate_status,runtime_eligible,blocking_gate_count,pending_gate_count,warning_gate_count,gate_summary,semantic_tuple,s101_feature_type,s101_attributes,s52_instruction,source_refs) */;
CREATE VIEW runtime_symbol_blocker_v1 AS
        SELECT
          g.s52_lookup_id,
          l.object_acronym,
          c.s52_symbol_id,
          c.category,
          g.gate_name,
          g.gate_status,
          g.severity,
          g.detail,
          g.evidence
        FROM runtime_symbol_gate g
        JOIN s52_portrayal_lookup l ON l.id = g.s52_lookup_id
        JOIN runtime_symbol_candidate c ON c.s52_lookup_id = g.s52_lookup_id
        WHERE g.gate_status IN ('blocked', 'pending')
/* runtime_symbol_blocker_v1(s52_lookup_id,object_acronym,s52_symbol_id,category,gate_name,gate_status,severity,detail,evidence) */;
CREATE VIEW electronic_chart1_entry_v1 AS
        SELECT
          s52_lookup_id,
          row_key,
          chart1_row_id,
          row_taxonomy,
          taxonomy_reason,
          evidence_status,
          render_eligibility,
          reason_codes,
          s57_object_class,
          s57_attribute_tuple,
          s52_instruction,
          s52_instruction_evidence,
          s101_evidence,
          helm_art_path,
          helm_art_status,
          colour_authority,
          shape_family_authority,
          human_qa_status,
          provenance
        FROM electronic_chart1_entry
/* electronic_chart1_entry_v1(s52_lookup_id,row_key,chart1_row_id,row_taxonomy,taxonomy_reason,evidence_status,render_eligibility,reason_codes,s57_object_class,s57_attribute_tuple,s52_instruction,s52_instruction_evidence,s101_evidence,helm_art_path,helm_art_status,colour_authority,shape_family_authority,human_qa_status,provenance) */;
CREATE INDEX s52_semantic_tuple_lookup_idx ON s52_semantic_tuple (s52_lookup_id);
CREATE INDEX s52_semantic_tuple_object_idx ON s52_semantic_tuple (object_class);
CREATE INDEX s52_semantic_tuple_category_idx ON s52_semantic_tuple (category);
CREATE INDEX s101_equivalence_lookup_idx ON s101_portrayal_equivalence (s52_lookup_id);
CREATE INDEX s101_equivalence_mapping_idx ON s101_portrayal_equivalence (mapping_type);
CREATE INDEX s101_equivalence_feature_idx ON s101_portrayal_equivalence (s101_feature_type);
CREATE INDEX s52_instruction_ast_lookup_idx ON s52_instruction_ast (s52_lookup_id);
CREATE INDEX s52_instruction_ast_status_idx ON s52_instruction_ast (parse_status);
CREATE INDEX iconforge_resolver_status_idx ON iconforge_s101_resolver_row (resolver_status);
CREATE INDEX iconforge_resolver_crosswalk_idx ON iconforge_s101_resolver_row (s101_crosswalk_class);
CREATE INDEX iconforge_topmark_gate_status_idx ON iconforge_topmark_gate_row (gate_status);
CREATE INDEX iconforge_lookup_link_lookup_idx ON iconforge_s52_lookup_link (s52_lookup_id);
CREATE INDEX runtime_symbol_gate_lookup_idx ON runtime_symbol_gate (s52_lookup_id);
CREATE INDEX runtime_symbol_gate_name_status_idx ON runtime_symbol_gate (gate_name, gate_status);
CREATE INDEX runtime_symbol_candidate_status_idx ON runtime_symbol_candidate (candidate_status);
CREATE INDEX electronic_chart1_entry_taxonomy_idx ON electronic_chart1_entry (row_taxonomy);
CREATE INDEX electronic_chart1_entry_status_idx ON electronic_chart1_entry (evidence_status);
CREATE INDEX electronic_chart1_entry_object_idx ON electronic_chart1_entry (s57_object_class);
CREATE VIEW runtime_symbol_portrayal_v1 AS
        SELECT c.*
        FROM runtime_symbol_candidate_v1 c
        WHERE c.runtime_eligible = 1
          AND c.candidate_status = 'runtime_eligible'
          AND c.blocking_gate_count = 0
          AND c.pending_gate_count = 0
          AND (
            SELECT COUNT(DISTINCT g.gate_name)
            FROM runtime_symbol_gate g
            WHERE g.s52_lookup_id = c.s52_lookup_id
              AND g.gate_name IN ('source_provenance', 's57_semantic_tuple', 's52_instruction_ast', 's101_crosswalk_evidence', 'topmark_daymark_special_cases', 'visual_approval')
          ) = 6
          AND NOT EXISTS (
            SELECT 1
            FROM runtime_symbol_gate g
            WHERE g.s52_lookup_id = c.s52_lookup_id
              AND g.gate_status IN ('blocked', 'pending')
          )
/* runtime_symbol_portrayal_v1(s52_lookup_id,row_key,object_class,s52_symbol_id,s52_asset_kind,category,geometry,display_mode,candidate_status,runtime_eligible,blocking_gate_count,pending_gate_count,warning_gate_count,gate_summary,semantic_tuple,s101_feature_type,s101_attributes,s52_instruction,source_refs) */;

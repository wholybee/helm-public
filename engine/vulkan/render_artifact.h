#pragma once

#include "render_model.h"

#include <cstdint>
#include <string>
#include <vector>

namespace helm::render {

struct ArtifactCacheRecord;

inline constexpr const char* kRenderArtifactSchemaVersion = "helm.render.artifact.v1";
inline constexpr const char* kRenderArtifactVertexFormat = "helm.vertex.target_xy_material_pick.v1";

struct TileRef {
  std::uint32_t z = 0;
  std::uint32_t x = 0;
  std::uint32_t y = 0;
};

struct ArtifactViewport {
  std::string projection;
  double west = 0;
  double south = 0;
  double east = 0;
  double north = 0;
  std::uint32_t pixel_width = 0;
  std::uint32_t pixel_height = 0;
  double device_pixel_ratio = 1;
  TileRef tile;
};

struct ArtifactChecksums {
  std::string source_model_json_sha256;
  std::string geometry_sha256;
  std::string tables_sha256;
  std::string packet_sha256;
};

struct MaterialTableEntry {
  std::string material_id;
  std::string style_key;
  std::string shader_family;
  std::string palette_ref;
  std::string symbol_ref;
  std::string line_style_ref;
  std::string pattern_ref;
  std::string font_ref;
  std::string raster_texture_ref;
  std::string blend_mode;
};

struct AtlasRef {
  std::string atlas_id;
  std::string kind;
  std::string content_hash;
  std::int32_t slot = -1;
};

struct DrawBatchRecord {
  std::string batch_id;
  std::string shader_family;
  std::string topology;
  std::int32_t material_index = -1;
  std::int32_t atlas_index = -1;
  std::uint32_t first_index = 0;
  std::uint32_t index_count = 0;
  std::uint32_t first_vertex = 0;
  std::uint32_t vertex_count = 0;
  std::int32_t order_bucket = 0;
  std::vector<std::string> primitive_ids;
};

struct PickRecord {
  std::string primitive_id;
  std::vector<std::string> inspection_handles;
  std::uint32_t first_index = 0;
  std::uint32_t index_count = 0;
  std::uint32_t pick_id = 0;
};

struct RenderArtifact {
  std::string schema_version = kRenderArtifactSchemaVersion;
  std::string artifact_id;
  std::string source_model_id;
  std::string source_epoch;
  ArtifactViewport viewport;
  ArtifactChecksums checksums;
  std::vector<MaterialTableEntry> material_table;
  std::vector<AtlasRef> atlas_refs;
  std::vector<float> vertices;
  std::vector<std::uint32_t> indices;
  std::vector<DrawBatchRecord> draw_batches;
  std::vector<PickRecord> pick_records;
  std::vector<Diagnostic> diagnostics;
};

[[nodiscard]] RenderArtifact CompileRenderArtifact(const RenderModel& model,
                                                   const std::string& source_model_json_sha256,
                                                   const TileRef& tile = {});

[[nodiscard]] std::string RenderArtifactToJson(const RenderArtifact& artifact,
                                               const ArtifactCacheRecord* cache = nullptr);

[[nodiscard]] std::string RenderArtifactBinary(const RenderArtifact& artifact);

[[nodiscard]] bool ValidateRenderArtifact(const RenderArtifact& artifact, std::string* error);

}  // namespace helm::render

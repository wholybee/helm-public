#pragma once

#include "render_artifact.h"

#include <string>
#include <vector>

namespace helm::render {

inline constexpr const char* kRenderArtifactCacheSchemaVersion = "helm.render.artifact_cache.v1";
inline constexpr const char* kArtifactCacheRebuildPolicy = "machine_local_rebuildable";

struct SourceEditionRef {
  std::string source_chart_id;
  std::string source_chart_edition;
  std::string source_update;
};

struct ArtifactDisplayCacheState {
  std::string palette;
  std::string display_category;
  std::string symbol_style;
  std::string boundary_style;
  double safety_depth_m = 0;
  double safety_contour_m = 0;
  bool show_text = true;
  bool show_soundings = true;
  bool use_scamin = true;
};

struct ArtifactCacheRecord {
  std::string schema_version = kRenderArtifactCacheSchemaVersion;
  std::string backend_target;
  std::string rebuild_policy = kArtifactCacheRebuildPolicy;
  std::string chart_epoch;
  std::string invalidation_epoch;
  std::vector<SourceEditionRef> source_edition_chain;
  ArtifactDisplayCacheState display_state;
  std::string projection;
  TileRef tile;
  std::uint32_t pixel_width = 0;
  std::uint32_t pixel_height = 0;
  std::string render_model_schema_version;
  std::string render_artifact_schema_version;
  std::string vertex_format;
  std::string artifact_packet_sha256;
  std::string cache_key;
  std::string cache_key_sha256;
};

struct ArtifactCacheInvalidation {
  bool valid = true;
  std::vector<std::string> reasons;
};

[[nodiscard]] std::vector<SourceEditionRef> CollectSourceEditionChain(const RenderModel& model);

[[nodiscard]] ArtifactCacheRecord BuildArtifactCacheRecord(const RenderModel& model,
                                                             const RenderArtifact& artifact,
                                                             std::string_view backend_target);

[[nodiscard]] std::string ArtifactCacheKey(const ArtifactCacheRecord& record);

[[nodiscard]] std::string ArtifactInvalidationEpoch(const ArtifactCacheRecord& record);

void FinalizeArtifactCacheRecord(ArtifactCacheRecord& record);

[[nodiscard]] ArtifactCacheInvalidation EvaluateArtifactCacheInvalidation(
    const ArtifactCacheRecord& stored,
    const ArtifactCacheRecord& candidate);

[[nodiscard]] std::string ArtifactCacheRecordToJson(const ArtifactCacheRecord& record);

[[nodiscard]] bool ValidateArtifactCacheRecord(const ArtifactCacheRecord& record, std::string* error);

}  // namespace helm::render

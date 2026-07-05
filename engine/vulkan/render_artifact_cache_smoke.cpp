#include "render_artifact_cache.h"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {

void require(bool ok, const std::string& message) {
  if (!ok) throw std::runtime_error(message);
}

helm::render::ArtifactCacheRecord sample_record() {
  helm::render::ArtifactCacheRecord record;
  record.backend_target = "webgpu";
  record.chart_epoch = "synthetic-chart-1@2026-06-28";
  record.source_edition_chain = {{"SYNTH-CHART-1", "1", "0"}};
  record.display_state.palette = "day";
  record.display_state.display_category = "standard";
  record.display_state.symbol_style = "paper_chart";
  record.display_state.boundary_style = "plain";
  record.display_state.safety_depth_m = 10;
  record.display_state.safety_contour_m = 10;
  record.display_state.show_text = true;
  record.display_state.show_soundings = true;
  record.display_state.use_scamin = true;
  record.projection = "web_mercator_tile";
  record.tile = {12, 1120, 1756};
  record.pixel_width = 8;
  record.pixel_height = 8;
  record.render_model_schema_version = helm::render::kRenderModelSchemaVersion;
  record.render_artifact_schema_version = helm::render::kRenderArtifactSchemaVersion;
  record.vertex_format = helm::render::kRenderArtifactVertexFormat;
  record.artifact_packet_sha256 = "15cd1497e408a6d2373ffb315dd39581ad8029550c928d767592b9994db1fe1c";
  helm::render::FinalizeArtifactCacheRecord(record);
  return record;
}

}  // namespace

int main() {
  try {
    helm::render::ArtifactCacheRecord webgpu = sample_record();
    std::string error;
    require(helm::render::ValidateArtifactCacheRecord(webgpu, &error), error);

    helm::render::ArtifactCacheRecord vulkan = webgpu;
    vulkan.backend_target = "vulkan_native";
    helm::render::FinalizeArtifactCacheRecord(vulkan);
    require(webgpu.cache_key != vulkan.cache_key, "backend targets must produce distinct cache keys");

    helm::render::ArtifactCacheInvalidation same =
        helm::render::EvaluateArtifactCacheInvalidation(webgpu, webgpu);
    require(same.valid && same.reasons.empty(), "identical cache records must stay valid");

    helm::render::ArtifactCacheRecord changed_palette = webgpu;
    changed_palette.display_state.palette = "night";
    helm::render::FinalizeArtifactCacheRecord(changed_palette);
    helm::render::ArtifactCacheInvalidation palette_hit =
        helm::render::EvaluateArtifactCacheInvalidation(webgpu, changed_palette);
    require(!palette_hit.valid, "palette change must invalidate cache");
    require(!palette_hit.reasons.empty(), "palette invalidation must name a reason");

    helm::render::ArtifactCacheRecord changed_epoch = webgpu;
    changed_epoch.source_edition_chain.front().source_update = "1";
    helm::render::FinalizeArtifactCacheRecord(changed_epoch);
    helm::render::ArtifactCacheInvalidation edition_hit =
        helm::render::EvaluateArtifactCacheInvalidation(webgpu, changed_epoch);
    require(!edition_hit.valid, "source edition change must invalidate cache");

    std::cout << "ok render-artifact-cache-smoke: invalidation policy and backend-specific keys\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL render-artifact-cache-smoke: " << e.what() << "\n";
    return 1;
  }
}

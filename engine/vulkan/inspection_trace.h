#pragma once

#include "render_model.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace helm::inspect {

inline constexpr const char* kInspectionTraceSchemaVersion = "helm.inspect.trace.v1";

enum class ResolutionKind {
  VectorFeature,
  RasterFallback,
  NoHit
};

struct PickRequest {
  std::uint32_t pixel_x = 0;
  std::uint32_t pixel_y = 0;
  double device_pixel_ratio = 1;
  std::string viewport_id;
  std::string backend;
  std::string scene_id;
  std::string model_id;
};

struct DrawRecord {
  std::string draw_record_id;
  std::string command_id;
  std::string command_type;
  std::string primitive_id;
  std::string primitive_kind;
  std::string artifact_id;
  std::string layer_id;
  std::vector<std::string> provenance_refs;
};

struct PresentationBinding {
  std::string presentation_authority;
  std::string presentation_rule_id;
  std::string material_id;
  std::string style_key;
  std::string conversion_stage;
};

struct RasterFallbackHonesty {
  bool active = false;
  std::string reason;
  std::string message;
  bool sidecar_metadata_available = false;
  std::string sidecar_name;
};

struct SourceBinding {
  std::string source_chart_id;
  std::string source_chart_edition;
  std::string source_update;
  std::optional<std::string> source_feature_id;
  std::optional<std::string> source_feature_sub_id;
  std::optional<std::string> object_class;
  std::vector<helm::render::SourceAttribute> attributes;
  std::string source_geometry_hash;
  std::vector<std::string> transform_chain;
  std::string quilt_decision_id;
};

struct InspectionTrace {
  std::string schema_version = kInspectionTraceSchemaVersion;
  std::string trace_id;
  PickRequest pick;
  ResolutionKind resolution_kind = ResolutionKind::NoHit;
  bool feature_metadata_available = false;
  DrawRecord draw;
  PresentationBinding presentation;
  SourceBinding source;
  RasterFallbackHonesty raster_fallback;
  std::vector<std::string> inspection_handles;
  std::vector<std::string> warnings;
};

[[nodiscard]] inline const char* ResolutionKindName(ResolutionKind kind) {
  switch (kind) {
    case ResolutionKind::VectorFeature: return "vector_feature";
    case ResolutionKind::RasterFallback: return "raster_fallback";
    case ResolutionKind::NoHit: return "no_hit";
  }
  return "unknown";
}

[[nodiscard]] inline bool FeatureMetadataAvailable(const InspectionTrace& trace) {
  return trace.feature_metadata_available &&
         trace.source.source_feature_id.has_value() &&
         !trace.source.source_feature_id->empty() &&
         trace.source.object_class.has_value() &&
         !trace.source.object_class->empty();
}

[[nodiscard]] inline bool RasterFallbackHonest(const InspectionTrace& trace) {
  if (trace.resolution_kind != ResolutionKind::RasterFallback) return true;
  return trace.raster_fallback.active &&
         !trace.raster_fallback.reason.empty() &&
         !trace.raster_fallback.message.empty() &&
         !trace.feature_metadata_available;
}

[[nodiscard]] inline bool TraceIsComplete(const InspectionTrace& trace) {
  if (trace.schema_version != kInspectionTraceSchemaVersion) return false;
  if (trace.trace_id.empty()) return false;
  if (trace.pick.backend.empty()) return false;

  switch (trace.resolution_kind) {
    case ResolutionKind::NoHit:
      return true;
    case ResolutionKind::RasterFallback:
      return RasterFallbackHonest(trace) &&
             !trace.draw.draw_record_id.empty() &&
             !trace.draw.command_id.empty();
    case ResolutionKind::VectorFeature:
      return FeatureMetadataAvailable(trace) &&
             !trace.draw.primitive_id.empty() &&
             !trace.draw.command_id.empty() &&
             !trace.presentation.presentation_rule_id.empty() &&
             !trace.source.source_chart_id.empty();
  }
  return false;
}

}  // namespace helm::inspect

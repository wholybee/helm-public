#pragma once

#include <array>
#include <cstdint>
#include <cstddef>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace helm::render {

inline constexpr const char* kRenderModelSchemaVersion = "helm.render.model.v1";

enum class PrimitiveKind {
  AreaFill,
  LineStroke,
  SymbolInstance,
  TextLabel,
  Sounding,
  RasterPatch,
  ContourLine,
  CoverageMask
};

enum class CoordinateSpace {
  Geographic,
  Projected,
  Target,
  Glyph,
  Raster
};

enum class WindingRule {
  NonZero,
  EvenOdd
};

struct Vec2 {
  double x = 0;
  double y = 0;
};

using LinearRing = std::vector<Vec2>;
using Polyline = std::vector<Vec2>;
using Quad = std::array<Vec2, 4>;

struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

struct RenderView {
  std::string projection;
  double west = 0;
  double south = 0;
  double east = 0;
  double north = 0;
  double center_lon = 0;
  double center_lat = 0;
  std::uint32_t scale_denom = 0;
  double rotation_deg = 0;
  std::uint32_t pixel_width = 0;
  std::uint32_t pixel_height = 0;
  double device_pixel_ratio = 1;
  bool overzoom = false;
  std::uint32_t overscan_px = 0;
};

struct DisplayState {
  std::string palette;
  std::string display_category;
  std::string symbol_style;
  std::string boundary_style;
  double safety_depth_m = 0;
  double shallow_contour_m = 0;
  double safety_contour_m = 0;
  double deep_contour_m = 0;
  bool show_text = true;
  bool show_important_text_only = false;
  bool show_national_text = false;
  bool show_aton_text = false;
  bool show_light_descriptions = false;
  bool show_soundings = true;
  bool show_lights = true;
  bool show_meta = false;
  bool show_quality_of_data = false;
  bool simplified_symbols = false;
  bool two_shade_depth = false;
  bool use_scamin = true;
  bool use_super_scamin = false;
  double chart_zoom_modifier_vector = 0;
  std::string language;
  std::string units;
};

struct StableOrder {
  std::int32_t chart_priority = 0;
  std::int32_t quilt_rank = 0;
  std::int32_t display_priority = 0;
  std::int32_t render_pass_rank = 0;
  std::int64_t source_sequence = 0;
  std::vector<std::int64_t> extension;

  [[nodiscard]] std::vector<std::int64_t> tuple() const {
    std::vector<std::int64_t> out{
        chart_priority,
        quilt_rank,
        display_priority,
        render_pass_rank,
        source_sequence};
    out.insert(out.end(), extension.begin(), extension.end());
    return out;
  }
};

struct MaterialKey {
  std::string material_id;
  std::string style_key;
  std::string palette_ref;
  std::string symbol_ref;
  std::string line_style_ref;
  std::string pattern_ref;
  std::string font_ref;
  std::string raster_texture_ref;
};

struct SourceAttribute {
  std::string code;
  std::string value;
};

struct SourceTrace {
  std::string source_chart_id;
  std::string source_chart_edition;
  std::string source_update;
  std::string source_feature_id;
  std::string source_feature_sub_id;
  std::string object_class;
  std::vector<SourceAttribute> attributes;
  std::string source_geometry_hash;
  std::string presentation_authority;
  std::string presentation_rule_id;
  std::string conversion_stage;
  std::vector<std::string> transform_chain;
  std::string quilt_decision_id;
  Rect target_bounds;
  std::vector<std::string> provenance_refs;
  std::vector<std::string> inspection_handles;
};

struct ScaleRange {
  std::uint32_t native_scale = 0;
  std::optional<std::uint32_t> min_scale_denom;
  std::optional<std::uint32_t> max_scale_denom;
  std::optional<std::uint32_t> scamin_max_scale;
  bool use_scamin = true;
  bool use_super_scamin = false;
  bool overzoom = false;
};

struct SafetyDisplayState {
  std::string display_category;
  std::string safety_class;
  std::string contour_role;
  std::string danger_class;
  std::string display_state;
  bool safety_relevant = false;
};

struct FillStyle {
  std::string color;
  std::string pattern_ref;
  double opacity = 1;
};

struct StrokeStyle {
  std::string color;
  std::string line_style_ref;
  double width_px = 1;
  std::string join;
  std::string cap;
  double dash_phase = 0;
  std::optional<double> symbol_spacing_px;
};

struct HaloStyle {
  std::string color;
  double width_px = 0;
};

struct AreaFill {
  std::vector<LinearRing> rings;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  WindingRule winding_rule = WindingRule::NonZero;
  FillStyle fill;
  std::string clip_ref;
};

struct LineStroke {
  Polyline polyline;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  StrokeStyle stroke;
};

struct SymbolInstance {
  std::string symbol_ref;
  Vec2 position;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  Vec2 anchor;
  double rotation_deg = 0;
  double scale = 1;
  std::string declutter_key;
  std::int32_t priority = 0;
};

struct TextLabel {
  std::string text;
  std::vector<std::string> text_run_refs;
  Vec2 position;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  Vec2 anchor;
  double rotation_deg = 0;
  std::string font_ref;
  HaloStyle halo;
  std::int32_t priority = 0;
  Rect collision_box;
};

struct Sounding {
  double depth_m = 0;
  std::string formatted_text;
  Vec2 position;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  std::string font_ref;
  std::int32_t priority = 0;
  std::string safety_class;
};

struct RasterPatch {
  std::string texture_ref;
  Quad source_quad{};
  Quad target_quad{};
  CoordinateSpace source_space = CoordinateSpace::Raster;
  CoordinateSpace target_space = CoordinateSpace::Target;
  double opacity = 1;
  std::string collar_policy;
  std::string coverage_policy;
};

struct ContourLine {
  Polyline polyline;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  double contour_m = 0;
  std::string contour_role;
  StrokeStyle stroke;
};

struct CoverageMask {
  std::vector<LinearRing> rings;
  CoordinateSpace coordinate_space = CoordinateSpace::Target;
  std::string coverage_role;
  std::string coverage_policy;
  std::string clip_ref;
};

using PrimitivePayload = std::variant<AreaFill,
                                      LineStroke,
                                      SymbolInstance,
                                      TextLabel,
                                      Sounding,
                                      RasterPatch,
                                      ContourLine,
                                      CoverageMask>;

struct RenderPrimitive {
  std::string primitive_id;
  PrimitiveKind kind = PrimitiveKind::AreaFill;
  StableOrder order;
  MaterialKey material;
  SourceTrace source;
  ScaleRange scale;
  SafetyDisplayState safety;
  PrimitivePayload payload;
};

struct ResourceRecord {
  std::string resource_id;
  std::string kind;
  std::string material_key;
  std::string content_hash;
  std::vector<std::string> provenance_refs;
};

struct RenderLayer {
  std::string layer_id;
  std::string kind;
  std::string authority;
  std::int32_t order_bucket = 0;
  std::vector<RenderPrimitive> primitives;
};

struct Diagnostic {
  std::string severity;
  std::string code;
  std::string message;
  std::vector<std::string> provenance_refs;
  std::string suggested_action;
};

struct RenderModel {
  std::string schema_version = kRenderModelSchemaVersion;
  std::string model_id;
  std::string source_epoch;
  RenderView render_view;
  DisplayState display_state;
  std::vector<ResourceRecord> resources;
  std::vector<RenderLayer> layers;
  std::vector<Diagnostic> diagnostics;
};

[[nodiscard]] inline const char* PrimitiveKindName(PrimitiveKind kind) {
  switch (kind) {
    case PrimitiveKind::AreaFill: return "AreaFill";
    case PrimitiveKind::LineStroke: return "LineStroke";
    case PrimitiveKind::SymbolInstance: return "SymbolInstance";
    case PrimitiveKind::TextLabel: return "TextLabel";
    case PrimitiveKind::Sounding: return "Sounding";
    case PrimitiveKind::RasterPatch: return "RasterPatch";
    case PrimitiveKind::ContourLine: return "ContourLine";
    case PrimitiveKind::CoverageMask: return "CoverageMask";
  }
  return "Unknown";
}

[[nodiscard]] inline bool StableOrderLess(const RenderPrimitive& lhs,
                                          const RenderPrimitive& rhs) {
  const std::vector<std::int64_t> left = lhs.order.tuple();
  const std::vector<std::int64_t> right = rhs.order.tuple();
  return left < right || (left == right && lhs.primitive_id < rhs.primitive_id);
}

[[nodiscard]] inline bool HasInspectionTrace(const RenderPrimitive& primitive) {
  return !primitive.source.source_chart_id.empty() &&
         !primitive.source.source_feature_id.empty() &&
         !primitive.source.object_class.empty() &&
         !primitive.source.provenance_refs.empty() &&
         !primitive.source.inspection_handles.empty();
}

[[nodiscard]] inline std::size_t PrimitiveCount(const RenderModel& model) {
  std::size_t count = 0;
  for (const RenderLayer& layer : model.layers) count += layer.primitives.size();
  return count;
}

}  // namespace helm::render

#include "render_model.h"

#include <array>
#include <cstdint>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>

namespace {

using helm::render::AreaFill;
using helm::render::ContourLine;
using helm::render::CoverageMask;
using helm::render::DisplayState;
using helm::render::FillStyle;
using helm::render::HasInspectionTrace;
using helm::render::LineStroke;
using helm::render::MaterialKey;
using helm::render::PrimitiveCount;
using helm::render::PrimitiveKind;
using helm::render::PrimitiveKindName;
using helm::render::RasterPatch;
using helm::render::RenderLayer;
using helm::render::RenderModel;
using helm::render::RenderPrimitive;
using helm::render::RenderView;
using helm::render::SafetyDisplayState;
using helm::render::ScaleRange;
using helm::render::Sounding;
using helm::render::SourceAttribute;
using helm::render::SourceTrace;
using helm::render::StableOrder;
using helm::render::StableOrderLess;
using helm::render::StrokeStyle;
using helm::render::SymbolInstance;
using helm::render::TextLabel;
using helm::render::Vec2;

[[noreturn]] void fail(const std::string& message) {
  throw std::runtime_error(message);
}

void require(bool ok, const std::string& message) {
  if (!ok) fail(message);
}

SourceTrace trace_for(const std::string& feature_id,
                      const std::string& object_class,
                      const std::string& stage) {
  SourceTrace trace;
  trace.source_chart_id = "SYNTH-CHART-1";
  trace.source_chart_edition = "1";
  trace.source_update = "0";
  trace.source_feature_id = feature_id;
  trace.object_class = object_class;
  trace.attributes.push_back(SourceAttribute{"CATZOC", "A1"});
  trace.source_geometry_hash = "hash." + feature_id;
  trace.presentation_authority = "s52";
  trace.presentation_rule_id = "rule." + object_class;
  trace.conversion_stage = stage;
  trace.transform_chain = {"wgs84", "web-mercator", "target-pixels"};
  trace.quilt_decision_id = "quilt.synthetic.primary";
  trace.provenance_refs = {"prov." + feature_id};
  trace.inspection_handles = {"inspect." + feature_id};
  return trace;
}

ScaleRange scale_range(std::uint32_t sequence) {
  ScaleRange scale;
  scale.native_scale = 12000;
  scale.min_scale_denom = 4000;
  scale.max_scale_denom = 50000;
  scale.scamin_max_scale = 50000 + sequence;
  scale.use_scamin = true;
  scale.use_super_scamin = false;
  scale.overzoom = false;
  return scale;
}

SafetyDisplayState safety_state(const std::string& safety_class,
                                const std::string& display_state,
                                bool safety_relevant) {
  SafetyDisplayState safety;
  safety.display_category = "standard";
  safety.safety_class = safety_class;
  safety.display_state = display_state;
  safety.safety_relevant = safety_relevant;
  return safety;
}

MaterialKey material(const std::string& id) {
  MaterialKey key;
  key.material_id = id;
  key.style_key = "style." + id;
  key.palette_ref = "palette.day";
  return key;
}

RenderPrimitive primitive(const std::string& id,
                          PrimitiveKind kind,
                          StableOrder order,
                          MaterialKey key,
                          SourceTrace trace,
                          ScaleRange scale,
                          SafetyDisplayState safety,
                          helm::render::PrimitivePayload payload) {
  RenderPrimitive out;
  out.primitive_id = id;
  out.kind = kind;
  out.order = std::move(order);
  out.material = std::move(key);
  out.source = std::move(trace);
  out.scale = scale;
  out.safety = std::move(safety);
  out.payload = std::move(payload);
  return out;
}

void assert_payload_matches_kind(const RenderPrimitive& primitive) {
  switch (primitive.kind) {
    case PrimitiveKind::AreaFill:
      require(std::holds_alternative<AreaFill>(primitive.payload), "AreaFill payload mismatch");
      break;
    case PrimitiveKind::LineStroke:
      require(std::holds_alternative<LineStroke>(primitive.payload), "LineStroke payload mismatch");
      break;
    case PrimitiveKind::SymbolInstance:
      require(std::holds_alternative<SymbolInstance>(primitive.payload), "SymbolInstance payload mismatch");
      break;
    case PrimitiveKind::TextLabel:
      require(std::holds_alternative<TextLabel>(primitive.payload), "TextLabel payload mismatch");
      break;
    case PrimitiveKind::Sounding:
      require(std::holds_alternative<Sounding>(primitive.payload), "Sounding payload mismatch");
      break;
    case PrimitiveKind::RasterPatch:
      require(std::holds_alternative<RasterPatch>(primitive.payload), "RasterPatch payload mismatch");
      break;
    case PrimitiveKind::ContourLine:
      require(std::holds_alternative<ContourLine>(primitive.payload), "ContourLine payload mismatch");
      break;
    case PrimitiveKind::CoverageMask:
      require(std::holds_alternative<CoverageMask>(primitive.payload), "CoverageMask payload mismatch");
      break;
  }
}

RenderModel build_model() {
  RenderModel model;
  model.model_id = "render-model-smoke";
  model.source_epoch = "synthetic-chart-1@render-model-v1";
  model.render_view = RenderView{"web_mercator_tile", -81.805, 24.495, -81.795, 24.505,
                                 -81.8, 24.5, 12000, 0, 8, 8, 1, false, 1};
  DisplayState display;
  display.palette = "day";
  display.display_category = "standard";
  display.symbol_style = "paper_chart";
  display.boundary_style = "plain";
  display.safety_depth_m = 10;
  display.shallow_contour_m = 5;
  display.safety_contour_m = 10;
  display.deep_contour_m = 20;
  display.language = "en";
  display.units = "metric";
  model.display_state = display;

  RenderLayer layer;
  layer.layer_id = "official-chart";
  layer.kind = "nautical-primitives";
  layer.authority = "presentation-compiler";
  layer.order_bucket = 10;

  AreaFill area;
  area.rings = {{{Vec2{1, 1}, Vec2{7, 1}, Vec2{7, 7}, Vec2{1, 7}, Vec2{1, 1}}}};
  area.fill = FillStyle{"#b9d7e8", "", 1};
  layer.primitives.push_back(primitive("prim.area.depare",
                                       PrimitiveKind::AreaFill,
                                       StableOrder{1, 1, 1, 0, 10, {}},
                                       material("mat.depth-area"),
                                       trace_for("DEPARE-1", "DEPARE", "area-fill"),
                                       scale_range(10),
                                       safety_state("shoal", "visible", true),
                                       area));

  LineStroke line;
  line.polyline = {Vec2{1, 2}, Vec2{7, 2}};
  line.stroke = StrokeStyle{"#222222", "line.coast", 1, "round", "round", 0, {}};
  layer.primitives.push_back(primitive("prim.line.coaln",
                                       PrimitiveKind::LineStroke,
                                       StableOrder{1, 1, 2, 1, 20, {}},
                                       material("mat.coast-line"),
                                       trace_for("COALNE-1", "COALNE", "line-stroke"),
                                       scale_range(20),
                                       safety_state("land", "visible", false),
                                       line));

  ContourLine contour;
  contour.polyline = {Vec2{1, 5}, Vec2{3, 4}, Vec2{7, 5}};
  contour.contour_m = 10;
  contour.contour_role = "safety_contour";
  contour.stroke = StrokeStyle{"#4a6f8a", "line.safety-contour", 1, "round", "round", 0, {}};
  layer.primitives.push_back(primitive("prim.contour.depcnt",
                                       PrimitiveKind::ContourLine,
                                       StableOrder{1, 1, 3, 2, 30, {}},
                                       material("mat.safety-contour"),
                                       trace_for("DEPCNT-10", "DEPCNT", "contour-line"),
                                       scale_range(30),
                                       safety_state("safety_contour", "visible", true),
                                       contour));

  SymbolInstance symbol;
  symbol.symbol_ref = "sym.boyspp";
  symbol.position = Vec2{5, 3};
  symbol.anchor = Vec2{6, 6};
  symbol.declutter_key = "boy-standard";
  symbol.priority = 70;
  MaterialKey symbol_material = material("mat.buoy-symbol");
  symbol_material.symbol_ref = symbol.symbol_ref;
  layer.primitives.push_back(primitive("prim.symbol.boyspp",
                                       PrimitiveKind::SymbolInstance,
                                       StableOrder{1, 1, 7, 3, 40, {}},
                                       symbol_material,
                                       trace_for("BOYSPP-1", "BOYSPP", "symbol-instance"),
                                       scale_range(40),
                                       safety_state("aid_to_navigation", "visible", true),
                                       symbol));

  TextLabel label;
  label.text = "Fixture buoy";
  label.position = Vec2{5, 2};
  label.anchor = Vec2{0, 0};
  label.font_ref = "font.chart-label";
  label.priority = 75;
  label.collision_box = helm::render::Rect{4, 1, 3, 1};
  MaterialKey text_material = material("mat.chart-label");
  text_material.font_ref = label.font_ref;
  layer.primitives.push_back(primitive("prim.text.buoy-label",
                                       PrimitiveKind::TextLabel,
                                       StableOrder{1, 1, 7, 4, 50, {}},
                                       text_material,
                                       trace_for("BOYSPP-1-TEXT", "BOYSPP", "text-label"),
                                       scale_range(50),
                                       safety_state("label", "visible", false),
                                       label));

  Sounding sounding;
  sounding.depth_m = 7.4;
  sounding.formatted_text = "7.4";
  sounding.position = Vec2{3, 6};
  sounding.font_ref = "font.chart-label";
  sounding.priority = 80;
  sounding.safety_class = "shoal";
  MaterialKey sounding_material = material("mat.sounding");
  sounding_material.font_ref = sounding.font_ref;
  layer.primitives.push_back(primitive("prim.sounding.soundg",
                                       PrimitiveKind::Sounding,
                                       StableOrder{1, 1, 8, 5, 60, {}},
                                       sounding_material,
                                       trace_for("SOUNDG-1", "SOUNDG", "sounding"),
                                       scale_range(60),
                                       safety_state("shoal", "visible", true),
                                       sounding));

  RasterPatch raster;
  raster.texture_ref = "raster.debug-collar";
  raster.source_quad = {Vec2{0, 0}, Vec2{8, 0}, Vec2{8, 8}, Vec2{0, 8}};
  raster.target_quad = raster.source_quad;
  raster.collar_policy = "retained-for-debug";
  raster.coverage_policy = "fixture-full-tile";
  MaterialKey raster_material = material("mat.raster");
  raster_material.raster_texture_ref = raster.texture_ref;
  layer.primitives.push_back(primitive("prim.raster.patch",
                                       PrimitiveKind::RasterPatch,
                                       StableOrder{1, 1, 9, 6, 70, {}},
                                       raster_material,
                                       trace_for("RASTER-1", "RASTER", "raster-patch"),
                                       scale_range(70),
                                       safety_state("raster", "visible", false),
                                       raster));

  CoverageMask mask;
  mask.rings = {{{Vec2{0, 0}, Vec2{8, 0}, Vec2{8, 8}, Vec2{0, 8}, Vec2{0, 0}}}};
  mask.coverage_role = "valid-data";
  mask.coverage_policy = "mask-no-data-outside-ring";
  layer.primitives.push_back(primitive("prim.coverage.mask",
                                       PrimitiveKind::CoverageMask,
                                       StableOrder{1, 1, 10, 7, 80, {}},
                                       material("mat.coverage-mask"),
                                       trace_for("M_COVR-1", "M_COVR", "coverage-mask"),
                                       scale_range(80),
                                       safety_state("coverage", "visible", true),
                                       mask));

  model.layers.push_back(layer);
  return model;
}

}  // namespace

int main() {
  try {
    const RenderModel model = build_model();
    require(model.schema_version == helm::render::kRenderModelSchemaVersion,
            "unexpected render model schema version");
    require(PrimitiveCount(model) == 8, "smoke model must cover all eight primitive families");
    require(model.layers.size() == 1, "smoke model must use one deterministic layer");

    std::set<PrimitiveKind> kinds;
    const auto& primitives = model.layers.front().primitives;
    for (std::size_t i = 0; i < primitives.size(); ++i) {
      const RenderPrimitive& current = primitives[i];
      kinds.insert(current.kind);
      assert_payload_matches_kind(current);
      require(!current.primitive_id.empty(), "primitive id is required");
      require(!current.material.material_id.empty(), current.primitive_id + ": material id is required");
      require(!current.material.style_key.empty(), current.primitive_id + ": style key is required");
      require(current.scale.native_scale > 0, current.primitive_id + ": native scale is required");
      require(current.scale.scamin_max_scale.has_value(), current.primitive_id + ": SCAMIN scale range is required");
      require(!current.safety.display_category.empty(), current.primitive_id + ": display category is required");
      require(HasInspectionTrace(current), current.primitive_id + ": inspection trace is incomplete");
      if (i > 0) {
        require(!StableOrderLess(current, primitives[i - 1]),
                current.primitive_id + ": primitives are not in stable order");
      }
    }

    const std::array<PrimitiveKind, 8> required{
        PrimitiveKind::AreaFill,
        PrimitiveKind::LineStroke,
        PrimitiveKind::SymbolInstance,
        PrimitiveKind::TextLabel,
        PrimitiveKind::Sounding,
        PrimitiveKind::RasterPatch,
        PrimitiveKind::ContourLine,
        PrimitiveKind::CoverageMask};
    for (PrimitiveKind kind : required) {
      require(kinds.count(kind) == 1, std::string("missing primitive family ") + PrimitiveKindName(kind));
    }

    std::cout << "ok render-model smoke: " << PrimitiveCount(model)
              << " primitives, schema " << model.schema_version << "\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL render-model smoke: " << e.what() << "\n";
    return 1;
  }
}

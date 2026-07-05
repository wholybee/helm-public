#include "render_model.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace {

using helm::render::AreaFill;
using helm::render::ContourLine;
using helm::render::CoordinateSpace;
using helm::render::DisplayState;
using helm::render::FillStyle;
using helm::render::HasInspectionTrace;
using helm::render::LineStroke;
using helm::render::MaterialKey;
using helm::render::PrimitiveKind;
using helm::render::PrimitiveKindName;
using helm::render::PrimitivePayload;
using helm::render::RasterPatch;
using helm::render::Rect;
using helm::render::RenderLayer;
using helm::render::RenderModel;
using helm::render::RenderPrimitive;
using helm::render::RenderView;
using helm::render::ResourceRecord;
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

struct Json;
using JsonArray = std::vector<Json>;
using JsonObject = std::map<std::string, Json>;

struct Json {
  using Storage = std::variant<std::nullptr_t, bool, double, std::string, JsonArray, JsonObject>;
  Storage value;

  [[nodiscard]] bool is_null() const { return std::holds_alternative<std::nullptr_t>(value); }
  [[nodiscard]] bool is_bool() const { return std::holds_alternative<bool>(value); }
  [[nodiscard]] bool is_number() const { return std::holds_alternative<double>(value); }
  [[nodiscard]] bool is_string() const { return std::holds_alternative<std::string>(value); }
  [[nodiscard]] bool is_array() const { return std::holds_alternative<JsonArray>(value); }
  [[nodiscard]] bool is_object() const { return std::holds_alternative<JsonObject>(value); }

  [[nodiscard]] const JsonObject& object() const {
    if (!is_object()) throw std::runtime_error("expected JSON object");
    return std::get<JsonObject>(value);
  }

  [[nodiscard]] const JsonArray& array() const {
    if (!is_array()) throw std::runtime_error("expected JSON array");
    return std::get<JsonArray>(value);
  }

  [[nodiscard]] const std::string& string() const {
    if (!is_string()) throw std::runtime_error("expected JSON string");
    return std::get<std::string>(value);
  }

  [[nodiscard]] double number() const {
    if (!is_number()) throw std::runtime_error("expected JSON number");
    return std::get<double>(value);
  }

  [[nodiscard]] bool boolean() const {
    if (!is_bool()) throw std::runtime_error("expected JSON bool");
    return std::get<bool>(value);
  }

  [[nodiscard]] const Json& at(std::string_view key) const {
    const auto& obj = object();
    const auto it = obj.find(std::string(key));
    if (it == obj.end()) throw std::runtime_error("missing JSON key: " + std::string(key));
    return it->second;
  }
};

class JsonParser {
 public:
  explicit JsonParser(std::string text) : text_(std::move(text)) {}

  Json parse() {
    Json out = parse_value();
    skip_ws();
    if (pos_ != text_.size()) throw error("trailing data");
    return out;
  }

 private:
  [[nodiscard]] std::runtime_error error(std::string_view message) const {
    return std::runtime_error("JSON parse error at byte " + std::to_string(pos_) + ": " +
                              std::string(message));
  }

  void skip_ws() {
    while (pos_ < text_.size()) {
      const char ch = text_[pos_];
      if (ch != ' ' && ch != '\n' && ch != '\r' && ch != '\t') break;
      ++pos_;
    }
  }

  [[nodiscard]] char peek() {
    skip_ws();
    if (pos_ >= text_.size()) throw error("unexpected end of input");
    return text_[pos_];
  }

  [[nodiscard]] bool consume(char ch) {
    skip_ws();
    if (pos_ < text_.size() && text_[pos_] == ch) {
      ++pos_;
      return true;
    }
    return false;
  }

  void expect(char ch) {
    if (!consume(ch)) throw error(std::string("expected '") + ch + "'");
  }

  [[nodiscard]] Json parse_value() {
    const char ch = peek();
    if (ch == '{') return Json{parse_object()};
    if (ch == '[') return Json{parse_array()};
    if (ch == '"') return Json{parse_string()};
    if (ch == 't') return parse_literal("true", Json{true});
    if (ch == 'f') return parse_literal("false", Json{false});
    if (ch == 'n') return parse_literal("null", Json{nullptr});
    if (ch == '-' || (ch >= '0' && ch <= '9')) return Json{parse_number()};
    throw error("unexpected value");
  }

  [[nodiscard]] Json parse_literal(std::string_view literal, Json value) {
    if (text_.compare(pos_, literal.size(), literal) != 0) throw error("invalid literal");
    pos_ += literal.size();
    return value;
  }

  [[nodiscard]] JsonObject parse_object() {
    expect('{');
    JsonObject obj;
    if (consume('}')) return obj;
    while (true) {
      if (peek() != '"') throw error("expected object key");
      std::string key = parse_string();
      expect(':');
      obj.emplace(std::move(key), parse_value());
      if (consume('}')) return obj;
      expect(',');
    }
  }

  [[nodiscard]] JsonArray parse_array() {
    expect('[');
    JsonArray arr;
    if (consume(']')) return arr;
    while (true) {
      arr.push_back(parse_value());
      if (consume(']')) return arr;
      expect(',');
    }
  }

  [[nodiscard]] std::string parse_string() {
    expect('"');
    std::string out;
    while (pos_ < text_.size()) {
      const unsigned char ch = static_cast<unsigned char>(text_[pos_++]);
      if (ch == '"') return out;
      if (ch != '\\') {
        if (ch < 0x20) throw error("control character in string");
        out.push_back(static_cast<char>(ch));
        continue;
      }
      if (pos_ >= text_.size()) throw error("unterminated escape");
      const char esc = text_[pos_++];
      switch (esc) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u':
          throw error("unicode escapes are not supported in render-model fixture JSON");
        default:
          throw error("invalid escape");
      }
    }
    throw error("unterminated string");
  }

  [[nodiscard]] double parse_number() {
    skip_ws();
    const std::size_t start = pos_;
    if (text_[pos_] == '-') ++pos_;
    if (pos_ >= text_.size()) throw error("invalid number");
    if (text_[pos_] == '0') {
      ++pos_;
    } else if (text_[pos_] >= '1' && text_[pos_] <= '9') {
      while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
    } else {
      throw error("invalid number");
    }
    if (pos_ < text_.size() && text_[pos_] == '.') {
      ++pos_;
      if (pos_ >= text_.size() || text_[pos_] < '0' || text_[pos_] > '9') {
        throw error("invalid number");
      }
      while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
    }
    if (pos_ < text_.size() && (text_[pos_] == 'e' || text_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < text_.size() && (text_[pos_] == '+' || text_[pos_] == '-')) ++pos_;
      if (pos_ >= text_.size() || text_[pos_] < '0' || text_[pos_] > '9') {
        throw error("invalid number");
      }
      while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
    }
    return std::stod(text_.substr(start, pos_ - start));
  }

  std::string text_;
  std::size_t pos_ = 0;
};

[[nodiscard]] std::string read_file(const std::filesystem::path& path, bool binary = false) {
  std::ifstream in(path, binary ? std::ios::binary : std::ios::in);
  if (!in) throw std::runtime_error("cannot read " + path.string());
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

void write_file(const std::filesystem::path& path, const std::string& bytes, bool binary = false) {
  std::filesystem::create_directories(path.parent_path());
  std::ofstream out(path, binary ? std::ios::binary : std::ios::out);
  if (!out) throw std::runtime_error("cannot write " + path.string());
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

[[nodiscard]] Json load_json(const std::filesystem::path& path) {
  try {
    return JsonParser(read_file(path)).parse();
  } catch (const std::exception& e) {
    throw std::runtime_error(path.string() + ": " + e.what());
  }
}

[[nodiscard]] const Json* object_get(const Json& object, std::string_view key) {
  if (!object.is_object()) return nullptr;
  const auto& obj = object.object();
  const auto it = obj.find(std::string(key));
  return it == obj.end() ? nullptr : &it->second;
}

[[nodiscard]] std::string string_value(const Json* value, std::string fallback = {}) {
  return value && value->is_string() ? value->string() : std::move(fallback);
}

[[nodiscard]] double number_value(const Json* value, double fallback = 0) {
  return value && value->is_number() ? value->number() : fallback;
}

[[nodiscard]] std::uint32_t uint_value(const Json* value, std::uint32_t fallback = 0) {
  const double n = number_value(value, fallback);
  return n < 0 ? fallback : static_cast<std::uint32_t>(n);
}

[[nodiscard]] std::int32_t int_value(const Json* value, std::int32_t fallback = 0) {
  return static_cast<std::int32_t>(number_value(value, fallback));
}

[[nodiscard]] bool bool_value(const Json* value, bool fallback = false) {
  return value && value->is_bool() ? value->boolean() : fallback;
}

[[nodiscard]] const JsonArray& array_value(const Json* value) {
  static const JsonArray empty;
  return value && value->is_array() ? value->array() : empty;
}

[[nodiscard]] std::string number_to_string(double value) {
  if (std::abs(value) == 0) value = 0;
  std::ostringstream out;
  out << std::setprecision(15) << value;
  return out.str();
}

[[nodiscard]] std::string scalar_to_string(const Json& value) {
  if (value.is_string()) return value.string();
  if (value.is_number()) return number_to_string(value.number());
  if (value.is_bool()) return value.boolean() ? "true" : "false";
  if (value.is_null()) return "null";
  return "<complex>";
}

[[nodiscard]] std::vector<std::string> string_array(const Json* value) {
  std::vector<std::string> out;
  for (const Json& item : array_value(value)) {
    if (item.is_string()) out.push_back(item.string());
  }
  return out;
}

[[nodiscard]] Vec2 vec2_from_array(const Json& value) {
  const JsonArray& array = value.array();
  if (array.size() < 2) throw std::runtime_error("expected [x,y]");
  return Vec2{number_value(&array[0]), number_value(&array[1])};
}

[[nodiscard]] Vec2 anchor_from_json(const Json* value) {
  if (!value) return Vec2{0, 0};
  if (value->is_array()) return vec2_from_array(*value);
  if (value->is_string() && value->string() == "center") return Vec2{0.5, 0.5};
  return Vec2{0, 0};
}

[[nodiscard]] Rect rect_from_bounds(const Json* value) {
  const JsonArray& array = array_value(value);
  if (array.size() < 4) return Rect{};
  const double x0 = number_value(&array[0]);
  const double y0 = number_value(&array[1]);
  const double x1 = number_value(&array[2]);
  const double y1 = number_value(&array[3]);
  return Rect{x0, y0, x1 - x0, y1 - y0};
}

[[nodiscard]] std::vector<Vec2> points_from_array(const Json* value) {
  std::vector<Vec2> out;
  for (const Json& point : array_value(value)) {
    if (point.is_array()) out.push_back(vec2_from_array(point));
  }
  return out;
}

[[nodiscard]] std::vector<std::vector<Vec2>> rings_from_array(const Json* value) {
  std::vector<std::vector<Vec2>> out;
  for (const Json& ring : array_value(value)) {
    out.push_back(points_from_array(&ring));
  }
  return out;
}

[[nodiscard]] std::array<Vec2, 4> quad_from_array(const Json* value) {
  const std::vector<Vec2> points = points_from_array(value);
  if (points.size() != 4) throw std::runtime_error("expected four quad points");
  return {points[0], points[1], points[2], points[3]};
}

[[nodiscard]] CoordinateSpace coordinate_space_from_string(const std::string& value) {
  if (value == "geographic") return CoordinateSpace::Geographic;
  if (value == "projected") return CoordinateSpace::Projected;
  if (value == "glyph") return CoordinateSpace::Glyph;
  if (value == "raster") return CoordinateSpace::Raster;
  return CoordinateSpace::Target;
}

[[nodiscard]] const char* coordinate_space_name(CoordinateSpace value) {
  switch (value) {
    case CoordinateSpace::Geographic: return "geographic";
    case CoordinateSpace::Projected: return "projected";
    case CoordinateSpace::Target: return "target";
    case CoordinateSpace::Glyph: return "glyph";
    case CoordinateSpace::Raster: return "raster";
  }
  return "target";
}

[[nodiscard]] std::string fixture_id_from_dir(const std::filesystem::path& fixture_dir) {
  return fixture_dir.filename().string();
}

struct ProvenanceRecord {
  std::string id;
  SourceTrace trace;
  std::vector<std::string> warnings;
};

struct SourceObjectRecord {
  std::string source_object_id;
  std::string source_object_class;
  std::vector<SourceAttribute> attributes;
};

struct SourceChartRecord {
  std::string source_chart_id;
  std::string source_chart_edition;
  std::string source_update;
  std::uint32_t native_scale = 0;
  std::map<std::string, SourceObjectRecord> objects;
};

struct FixtureContext {
  std::string fixture_id;
  std::string scene_id;
  std::string source_epoch;
  std::map<std::string, ProvenanceRecord> provenance_by_id;
  std::map<std::string, SourceChartRecord> chart_by_id;
  std::map<std::string, SourceObjectRecord> source_object_by_id;
  std::uint32_t native_scale = 0;
};

[[nodiscard]] SourceObjectRecord parse_source_object(const Json& object) {
  SourceObjectRecord out;
  out.source_object_id = string_value(object_get(object, "source_object_id"));
  out.source_object_class = string_value(object_get(object, "source_object_class"));
  for (const auto& [key, value] : object.object()) {
    if (key == "source_object_id" || key == "source_object_class") continue;
    if (value.is_array()) {
      std::vector<std::string> parts;
      for (const Json& item : value.array()) parts.push_back(scalar_to_string(item));
      std::ostringstream joined;
      for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i) joined << ",";
        joined << parts[i];
      }
      out.attributes.push_back(SourceAttribute{key, joined.str()});
    } else if (!value.is_object()) {
      out.attributes.push_back(SourceAttribute{key, scalar_to_string(value)});
    }
  }
  return out;
}

[[nodiscard]] std::map<std::string, SourceChartRecord> parse_source_charts(const Json& source,
                                                                           FixtureContext& context) {
  std::map<std::string, SourceChartRecord> charts;
  for (const Json& chart_json : array_value(object_get(source, "charts"))) {
    SourceChartRecord chart;
    chart.source_chart_id = string_value(object_get(chart_json, "source_chart_id"));
    chart.source_chart_edition = string_value(object_get(chart_json, "source_chart_edition"));
    chart.source_update = string_value(object_get(chart_json, "source_update"));
    chart.native_scale = uint_value(object_get(chart_json, "native_scale"));
    if (!chart.native_scale) chart.native_scale = context.native_scale;
    if (context.native_scale == 0) context.native_scale = chart.native_scale;
    for (const Json& object_json : array_value(object_get(chart_json, "objects"))) {
      SourceObjectRecord object = parse_source_object(object_json);
      if (!object.source_object_id.empty()) {
        context.source_object_by_id[object.source_object_id] = object;
        chart.objects[object.source_object_id] = std::move(object);
      }
    }
    if (!chart.source_chart_id.empty()) charts[chart.source_chart_id] = std::move(chart);
  }
  return charts;
}

[[nodiscard]] std::map<std::string, ProvenanceRecord> parse_provenance(const Json& provenance) {
  std::map<std::string, ProvenanceRecord> out;
  for (const Json& record_json : array_value(object_get(provenance, "provenance_table"))) {
    ProvenanceRecord record;
    record.id = string_value(object_get(record_json, "provenance_id"));
    record.trace.source_chart_id = string_value(object_get(record_json, "source_chart_id"));
    record.trace.source_chart_edition = string_value(object_get(record_json, "source_chart_edition"));
    record.trace.source_update = string_value(object_get(record_json, "source_update"));
    record.trace.source_feature_id = string_value(object_get(record_json, "source_object_id"));
    record.trace.object_class = string_value(object_get(record_json, "source_object_class"));
    record.trace.source_geometry_hash = string_value(object_get(record_json, "source_geometry_hash"));
    record.trace.conversion_stage = string_value(object_get(record_json, "conversion_stage"));
    record.trace.transform_chain = string_array(object_get(record_json, "transform_chain"));
    record.trace.quilt_decision_id = string_value(object_get(record_json, "quilt_decision_id"));
    record.trace.target_bounds = rect_from_bounds(object_get(record_json, "target_bounds"));
    record.warnings = string_array(object_get(record_json, "warnings"));
    if (!record.id.empty()) out[record.id] = std::move(record);
  }
  return out;
}

[[nodiscard]] RenderView parse_render_view(const Json& scene) {
  const Json& view = scene.at("render_view");
  const Json& bbox = view.at("geographic_bbox");
  const Json& center = view.at("center");
  const JsonArray& pixel_size = view.at("pixel_size").array();
  RenderView out;
  out.projection = string_value(object_get(view, "projection"));
  out.west = number_value(object_get(bbox, "west"));
  out.south = number_value(object_get(bbox, "south"));
  out.east = number_value(object_get(bbox, "east"));
  out.north = number_value(object_get(bbox, "north"));
  out.center_lon = number_value(object_get(center, "lon"));
  out.center_lat = number_value(object_get(center, "lat"));
  out.scale_denom = uint_value(object_get(view, "scale_denom"));
  out.rotation_deg = number_value(object_get(view, "rotation_deg"));
  out.pixel_width = pixel_size.size() >= 1 ? uint_value(&pixel_size[0]) : 0;
  out.pixel_height = pixel_size.size() >= 2 ? uint_value(&pixel_size[1]) : 0;
  out.device_pixel_ratio = number_value(object_get(view, "device_pixel_ratio"), 1);
  out.overzoom = bool_value(object_get(view, "overzoom"));
  out.overscan_px = uint_value(object_get(view, "overscan_px"));
  return out;
}

[[nodiscard]] DisplayState parse_display_state(const Json& scene) {
  const Json& state = scene.at("display_state");
  DisplayState out;
  out.palette = string_value(object_get(state, "palette"));
  out.display_category = string_value(object_get(state, "display_category"));
  out.symbol_style = string_value(object_get(state, "symbol_style"), "paper_chart");
  out.boundary_style = string_value(object_get(state, "boundary_style"), "plain");
  out.safety_depth_m = number_value(object_get(state, "safety_depth_m"));
  out.shallow_contour_m = number_value(object_get(state, "shallow_contour_m"));
  out.safety_contour_m = number_value(object_get(state, "safety_contour_m"));
  out.deep_contour_m = number_value(object_get(state, "deep_contour_m"));
  out.show_text = bool_value(object_get(state, "show_text"), true);
  out.show_important_text_only = bool_value(object_get(state, "show_important_text_only"));
  out.show_national_text = bool_value(object_get(state, "show_national_text"));
  out.show_aton_text = bool_value(object_get(state, "show_aton_text"));
  out.show_light_descriptions = bool_value(object_get(state, "show_light_descriptions"));
  out.show_soundings = bool_value(object_get(state, "show_soundings"), true);
  out.show_lights = bool_value(object_get(state, "show_lights"), true);
  out.show_meta = bool_value(object_get(state, "show_meta"));
  out.show_quality_of_data = bool_value(object_get(state, "show_quality_of_data"));
  out.simplified_symbols = bool_value(object_get(state, "simplified_symbols"));
  out.two_shade_depth = bool_value(object_get(state, "two_shade_depth"));
  out.use_scamin = bool_value(object_get(state, "use_scamin"), true);
  out.use_super_scamin = bool_value(object_get(state, "use_super_scamin"));
  out.chart_zoom_modifier_vector = number_value(object_get(state, "chart_zoom_modifier_vector"));
  out.language = string_value(object_get(state, "language"), "en");
  out.units = string_value(object_get(state, "units"), "metric");
  return out;
}

void append_resource_records(const Json& scene, RenderModel& model) {
  const Json* resource_table = object_get(scene, "resource_table");
  if (!resource_table || !resource_table->is_object()) return;
  for (const auto& [kind, resources] : resource_table->object()) {
    for (const Json& resource_json : array_value(&resources)) {
      ResourceRecord record;
      record.resource_id = string_value(object_get(resource_json, "resource_id"));
      if (record.resource_id.empty()) continue;
      record.kind = kind;
      record.material_key = record.resource_id;
      record.content_hash = "fixture-resource:" + record.resource_id;
      model.resources.push_back(std::move(record));
    }
  }
  std::sort(model.resources.begin(), model.resources.end(), [](const auto& lhs, const auto& rhs) {
    return std::tie(lhs.kind, lhs.resource_id) < std::tie(rhs.kind, rhs.resource_id);
  });
}

[[nodiscard]] PrimitiveKind kind_for_command(const Json& command) {
  const std::string type = string_value(object_get(command, "type"));
  if (type == "fill_area") return PrimitiveKind::AreaFill;
  if (type == "place_symbol") return PrimitiveKind::SymbolInstance;
  if (type == "draw_text") return PrimitiveKind::TextLabel;
  if (type == "draw_sounding") return PrimitiveKind::Sounding;
  if (type == "draw_raster_sheet") return PrimitiveKind::RasterPatch;
  if (type == "stroke_line" && (string_value(object_get(command, "role")) == "depth_contour" ||
                                object_get(command, "contour_m"))) {
    return PrimitiveKind::ContourLine;
  }
  if (type == "stroke_line") return PrimitiveKind::LineStroke;
  throw std::runtime_error("unsupported command type: " + type);
}

[[nodiscard]] std::int32_t render_pass_rank(const std::string& type, PrimitiveKind kind) {
  if (type == "draw_raster_sheet") return 0;
  if (kind == PrimitiveKind::AreaFill) return 10;
  if (kind == PrimitiveKind::CoverageMask) return 15;
  if (kind == PrimitiveKind::ContourLine) return 20;
  if (kind == PrimitiveKind::LineStroke) return 30;
  if (kind == PrimitiveKind::SymbolInstance) return 70;
  if (kind == PrimitiveKind::TextLabel) return 80;
  if (kind == PrimitiveKind::Sounding) return 90;
  return 100;
}

[[nodiscard]] StrokeStyle stroke_from_command(const Json& command) {
  StrokeStyle out;
  const Json* stroke = object_get(command, "stroke");
  out.color = stroke ? string_value(object_get(*stroke, "color")) : std::string();
  out.line_style_ref = string_value(object_get(command, "line_style_ref"));
  out.width_px = number_value(object_get(command, "width_px"), 1);
  out.join = string_value(object_get(command, "join"), "round");
  out.cap = string_value(object_get(command, "cap"), "round");
  out.dash_phase = number_value(object_get(command, "dash_phase"));
  if (const Json* spacing = object_get(command, "symbol_spacing"); spacing && spacing->is_number()) {
    out.symbol_spacing_px = spacing->number();
  }
  return out;
}

[[nodiscard]] MaterialKey material_for_command(const Json& command, const DisplayState& display_state) {
  const std::string command_id = string_value(object_get(command, "command_id"));
  const std::string type = string_value(object_get(command, "type"));
  MaterialKey out;
  out.material_id = "mat." + command_id;
  out.style_key = type;
  out.palette_ref = display_state.palette.empty() ? "palette.day" : "palette." + display_state.palette;
  if (const Json* fill = object_get(command, "fill")) {
    out.palette_ref = string_value(object_get(*fill, "palette_ref"), out.palette_ref);
  }
  out.symbol_ref = string_value(object_get(command, "symbol_ref"));
  out.line_style_ref = string_value(object_get(command, "line_style_ref"));
  out.pattern_ref = string_value(object_get(command, "pattern_ref"));
  out.font_ref = string_value(object_get(command, "font_ref"));
  out.raster_texture_ref = string_value(object_get(command, "texture_ref"));
  return out;
}

[[nodiscard]] ScaleRange scale_for_command(const FixtureContext& context,
                                           const RenderView& view,
                                           const DisplayState& display_state) {
  ScaleRange out;
  out.native_scale = context.native_scale ? context.native_scale : view.scale_denom;
  out.min_scale_denom = std::max<std::uint32_t>(1, view.scale_denom / 4);
  out.max_scale_denom = view.scale_denom * 4;
  out.scamin_max_scale = out.max_scale_denom;
  out.use_scamin = display_state.use_scamin;
  out.use_super_scamin = display_state.use_super_scamin;
  out.overzoom = view.overzoom;
  return out;
}

[[nodiscard]] SafetyDisplayState safety_for_command(const Json& command,
                                                    const SourceTrace& trace,
                                                    const DisplayState& display_state) {
  SafetyDisplayState out;
  out.display_category = display_state.display_category;
  out.safety_class = string_value(object_get(command, "safety_class"));
  out.contour_role = string_value(object_get(command, "role"));
  out.display_state = "visible";
  out.safety_relevant = false;

  if (trace.object_class == "DEPARE") {
    out.safety_class = "shoal";
    out.contour_role = "depth_area";
    out.safety_relevant = true;
  } else if (trace.object_class == "DEPCNT") {
    out.safety_class = "safety_contour";
    out.contour_role = "safety_contour";
    out.safety_relevant = true;
  } else if (trace.object_class == "SOUNDG") {
    if (out.safety_class.empty()) out.safety_class = "shoal";
    out.safety_relevant = true;
  } else if (trace.object_class.rfind("BOY", 0) == 0 || trace.object_class.rfind("BCN", 0) == 0) {
    out.safety_class = "aid_to_navigation";
    out.safety_relevant = true;
  } else if (trace.object_class == "RASTER") {
    out.safety_class = "raster";
  }

  if (out.safety_class.empty()) out.safety_class = "standard";
  return out;
}

[[nodiscard]] SourceTrace trace_for_command(const Json& command,
                                            const FixtureContext& context,
                                            const std::vector<std::string>& refs) {
  if (refs.empty()) throw std::runtime_error("command missing provenance refs");
  const auto it = context.provenance_by_id.find(refs.front());
  if (it == context.provenance_by_id.end()) {
    throw std::runtime_error("command references missing provenance " + refs.front());
  }

  SourceTrace trace = it->second.trace;
  trace.presentation_authority = "vulkan.render_scene.v0";
  trace.presentation_rule_id = string_value(object_get(command, "type"));
  trace.source_feature_sub_id = string_value(object_get(command, "command_id"));
  trace.provenance_refs = refs;
  trace.inspection_handles = {
      "fixture:" + context.fixture_id,
      "scene:" + context.scene_id,
      "command:" + trace.source_feature_sub_id};
  for (const std::string& ref : refs) trace.inspection_handles.push_back("provenance:" + ref);

  const auto object_it = context.source_object_by_id.find(trace.source_feature_id);
  if (object_it != context.source_object_by_id.end()) {
    trace.attributes = object_it->second.attributes;
  }
  return trace;
}

[[nodiscard]] PrimitivePayload payload_for_command(const Json& command, PrimitiveKind kind) {
  const std::string coordinate_space = string_value(object_get(command, "coordinate_space"), "target");
  switch (kind) {
    case PrimitiveKind::AreaFill: {
      AreaFill out;
      out.rings = rings_from_array(object_get(command, "rings"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      if (const Json* fill = object_get(command, "fill")) {
        out.fill.color = string_value(object_get(*fill, "color"));
        out.fill.pattern_ref = string_value(object_get(command, "pattern_ref"));
        out.fill.opacity = number_value(object_get(command, "opacity"), 1);
      }
      out.clip_ref = string_value(object_get(command, "clip_ref"));
      return out;
    }
    case PrimitiveKind::LineStroke: {
      LineStroke out;
      out.polyline = points_from_array(object_get(command, "polyline"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      out.stroke = stroke_from_command(command);
      return out;
    }
    case PrimitiveKind::SymbolInstance: {
      SymbolInstance out;
      out.symbol_ref = string_value(object_get(command, "symbol_ref"));
      out.position = vec2_from_array(command.at("position"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      out.anchor = anchor_from_json(object_get(command, "anchor"));
      out.rotation_deg = number_value(object_get(command, "rotation_deg"));
      out.scale = number_value(object_get(command, "scale"), 1);
      out.declutter_key = string_value(object_get(command, "declutter_key"));
      out.priority = int_value(object_get(command, "priority"));
      return out;
    }
    case PrimitiveKind::TextLabel: {
      TextLabel out;
      out.text = string_value(object_get(command, "text"));
      out.text_run_refs = string_array(object_get(command, "text_run_refs"));
      out.position = vec2_from_array(command.at("position"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      out.anchor = anchor_from_json(object_get(command, "anchor"));
      out.rotation_deg = number_value(object_get(command, "rotation_deg"));
      out.font_ref = string_value(object_get(command, "font_ref"));
      if (const Json* halo = object_get(command, "halo")) {
        out.halo.color = string_value(object_get(*halo, "color"));
        out.halo.width_px = number_value(object_get(*halo, "width_px"));
      }
      out.priority = int_value(object_get(command, "priority"));
      out.collision_box = rect_from_bounds(object_get(command, "collision_box"));
      return out;
    }
    case PrimitiveKind::Sounding: {
      Sounding out;
      out.depth_m = number_value(object_get(command, "depth_m"));
      out.formatted_text = string_value(object_get(command, "formatted_text"));
      out.position = vec2_from_array(command.at("position"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      out.font_ref = string_value(object_get(command, "font_ref"));
      out.priority = int_value(object_get(command, "priority"));
      out.safety_class = string_value(object_get(command, "safety_class"));
      return out;
    }
    case PrimitiveKind::RasterPatch: {
      RasterPatch out;
      out.texture_ref = string_value(object_get(command, "texture_ref"));
      out.source_quad = quad_from_array(object_get(command, "source_quad"));
      out.target_quad = quad_from_array(object_get(command, "target_quad"));
      out.source_space = CoordinateSpace::Raster;
      out.target_space = coordinate_space_from_string(coordinate_space);
      out.opacity = number_value(object_get(command, "opacity"), 1);
      out.collar_policy = string_value(object_get(command, "collar_policy"));
      out.coverage_policy = string_value(object_get(command, "coverage_policy"));
      return out;
    }
    case PrimitiveKind::ContourLine: {
      ContourLine out;
      out.polyline = points_from_array(object_get(command, "polyline"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      out.contour_m = number_value(object_get(command, "contour_m"));
      out.contour_role = string_value(object_get(command, "role"));
      out.stroke = stroke_from_command(command);
      return out;
    }
    case PrimitiveKind::CoverageMask: {
      helm::render::CoverageMask out;
      out.rings = rings_from_array(object_get(command, "rings"));
      out.coordinate_space = coordinate_space_from_string(coordinate_space);
      out.coverage_role = string_value(object_get(command, "coverage_role"));
      out.coverage_policy = string_value(object_get(command, "coverage_policy"));
      out.clip_ref = string_value(object_get(command, "clip_ref"));
      return out;
    }
  }
  throw std::runtime_error("unsupported primitive kind");
}

[[nodiscard]] RenderPrimitive primitive_for_command(const Json& command,
                                                    const Json& group,
                                                    const FixtureContext& context,
                                                    const RenderView& view,
                                                    const DisplayState& display_state,
                                                    std::int32_t group_index,
                                                    std::int64_t sequence) {
  RenderPrimitive out;
  const std::string command_id = string_value(object_get(command, "command_id"));
  const std::string type = string_value(object_get(command, "type"));
  if (command_id.empty()) throw std::runtime_error("command missing command_id");
  out.primitive_id = command_id;
  out.kind = kind_for_command(command);
  const std::int32_t pass_rank = render_pass_rank(type, out.kind);
  out.order = StableOrder{
      int_value(object_get(group, "chart_priority")),
      int_value(object_get(group, "quilt_rank")),
      group_index * 100 + pass_rank,
      pass_rank,
      sequence,
      {int_value(object_get(command, "priority"), 0)}};
  out.material = material_for_command(command, display_state);
  const std::vector<std::string> provenance_refs = string_array(object_get(command, "provenance_refs"));
  out.source = trace_for_command(command, context, provenance_refs);
  out.scale = scale_for_command(context, view, display_state);
  out.safety = safety_for_command(command, out.source, display_state);
  out.payload = payload_for_command(command, out.kind);
  return out;
}

[[nodiscard]] RenderModel build_render_model(const std::filesystem::path& fixture_dir) {
  const Json manifest = load_json(fixture_dir / "manifest.json");
  const Json source = load_json(fixture_dir / string_value(object_get(manifest, "source_file"), "source.json"));
  const Json scene = load_json(fixture_dir / string_value(object_get(manifest, "scene_file"), "scene.commands.json"));
  const Json provenance = load_json(fixture_dir / string_value(object_get(manifest, "provenance_file"),
                                                               "provenance.json"));

  FixtureContext context;
  context.fixture_id = string_value(object_get(manifest, "fixture_id"), fixture_id_from_dir(fixture_dir));
  context.scene_id = string_value(object_get(scene, "scene_id"));
  context.source_epoch = string_value(object_get(scene, "source_epoch"));
  context.provenance_by_id = parse_provenance(provenance);
  context.chart_by_id = parse_source_charts(source, context);

  RenderModel model;
  model.model_id = context.scene_id;
  model.source_epoch = context.source_epoch;
  model.render_view = parse_render_view(scene);
  model.display_state = parse_display_state(scene);
  append_resource_records(scene, model);

  const JsonArray& groups = array_value(object_get(scene, "command_groups"));
  std::int64_t sequence = 0;
  for (std::size_t group_index = 0; group_index < groups.size(); ++group_index) {
    const Json& group = groups[group_index];
    RenderLayer layer;
    layer.layer_id = string_value(object_get(group, "group_id"));
    layer.kind = string_value(object_get(group, "s52_layer"));
    layer.authority = "vulkan.render_scene.v0";
    layer.order_bucket = static_cast<std::int32_t>(group_index);
    for (const Json& command : array_value(object_get(group, "commands"))) {
      layer.primitives.push_back(primitive_for_command(command,
                                                       group,
                                                       context,
                                                       model.render_view,
                                                       model.display_state,
                                                       static_cast<std::int32_t>(group_index),
                                                       sequence++));
    }
    std::sort(layer.primitives.begin(), layer.primitives.end(), StableOrderLess);
    model.layers.push_back(std::move(layer));
  }

  for (const Json& diagnostic_json : array_value(object_get(scene, "diagnostics"))) {
    helm::render::Diagnostic diagnostic;
    diagnostic.severity = string_value(object_get(diagnostic_json, "severity"));
    diagnostic.code = string_value(object_get(diagnostic_json, "code"));
    diagnostic.message = string_value(object_get(diagnostic_json, "message"));
    diagnostic.provenance_refs = string_array(object_get(diagnostic_json, "provenance_refs"));
    diagnostic.suggested_action = string_value(object_get(diagnostic_json, "suggested_action"));
    model.diagnostics.push_back(std::move(diagnostic));
  }
  return model;
}

void require_model_invariants(const RenderModel& model) {
  if (model.schema_version != helm::render::kRenderModelSchemaVersion) {
    throw std::runtime_error("unexpected render-model schema version");
  }
  if (model.model_id.empty()) throw std::runtime_error("model_id is required");
  if (model.layers.empty()) throw std::runtime_error("at least one layer is required");
  std::set<std::string> ids;
  std::size_t count = 0;
  for (const RenderLayer& layer : model.layers) {
    for (std::size_t i = 0; i < layer.primitives.size(); ++i) {
      const RenderPrimitive& primitive = layer.primitives[i];
      ++count;
      if (primitive.primitive_id.empty()) throw std::runtime_error("primitive id is required");
      if (!ids.insert(primitive.primitive_id).second) {
        throw std::runtime_error("duplicate primitive id: " + primitive.primitive_id);
      }
      if (!HasInspectionTrace(primitive)) {
        throw std::runtime_error(primitive.primitive_id + ": source trace is incomplete");
      }
      if (i > 0 && StableOrderLess(primitive, layer.primitives[i - 1])) {
        throw std::runtime_error(primitive.primitive_id + ": primitive order is unstable");
      }
    }
  }
  if (count == 0) throw std::runtime_error("at least one primitive is required");
}

void indent(std::ostream& out, int depth) {
  for (int i = 0; i < depth; ++i) out << "  ";
}

void write_string(std::ostream& out, const std::string& value) {
  out << '"';
  for (const unsigned char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c)
              << std::dec << std::setfill(' ');
        } else {
          out << static_cast<char>(c);
        }
    }
  }
  out << '"';
}

void write_key(std::ostream& out, int depth, const std::string& key) {
  indent(out, depth);
  write_string(out, key);
  out << ": ";
}

void write_number(std::ostream& out, double value) {
  out << number_to_string(value);
}

void write_vec2(std::ostream& out, const Vec2& value) {
  out << '[';
  write_number(out, value.x);
  out << ", ";
  write_number(out, value.y);
  out << ']';
}

void write_rect(std::ostream& out, const Rect& rect) {
  out << '[';
  write_number(out, rect.x);
  out << ", ";
  write_number(out, rect.y);
  out << ", ";
  write_number(out, rect.width);
  out << ", ";
  write_number(out, rect.height);
  out << ']';
}

void write_string_array(std::ostream& out, const std::vector<std::string>& values) {
  out << '[';
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ", ";
    write_string(out, values[i]);
  }
  out << ']';
}

void write_vec2_array(std::ostream& out, const std::vector<Vec2>& values) {
  out << '[';
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ", ";
    write_vec2(out, values[i]);
  }
  out << ']';
}

void write_rings(std::ostream& out, const std::vector<std::vector<Vec2>>& rings) {
  out << '[';
  for (std::size_t i = 0; i < rings.size(); ++i) {
    if (i) out << ", ";
    write_vec2_array(out, rings[i]);
  }
  out << ']';
}

template <typename T>
void write_optional_uint(std::ostream& out, const std::optional<T>& value) {
  if (value) {
    out << *value;
  } else {
    out << "null";
  }
}

void write_source_trace(std::ostream& out, const SourceTrace& trace, int depth) {
  out << "{\n";
  write_key(out, depth + 1, "source_chart_id"); write_string(out, trace.source_chart_id); out << ",\n";
  write_key(out, depth + 1, "source_chart_edition"); write_string(out, trace.source_chart_edition); out << ",\n";
  write_key(out, depth + 1, "source_update"); write_string(out, trace.source_update); out << ",\n";
  write_key(out, depth + 1, "source_feature_id"); write_string(out, trace.source_feature_id); out << ",\n";
  write_key(out, depth + 1, "source_feature_sub_id"); write_string(out, trace.source_feature_sub_id); out << ",\n";
  write_key(out, depth + 1, "object_class"); write_string(out, trace.object_class); out << ",\n";
  write_key(out, depth + 1, "attributes"); out << "[";
  for (std::size_t i = 0; i < trace.attributes.size(); ++i) {
    if (i) out << ", ";
    out << "{\"code\": ";
    write_string(out, trace.attributes[i].code);
    out << ", \"value\": ";
    write_string(out, trace.attributes[i].value);
    out << "}";
  }
  out << "],\n";
  write_key(out, depth + 1, "source_geometry_hash"); write_string(out, trace.source_geometry_hash); out << ",\n";
  write_key(out, depth + 1, "presentation_authority"); write_string(out, trace.presentation_authority); out << ",\n";
  write_key(out, depth + 1, "presentation_rule_id"); write_string(out, trace.presentation_rule_id); out << ",\n";
  write_key(out, depth + 1, "conversion_stage"); write_string(out, trace.conversion_stage); out << ",\n";
  write_key(out, depth + 1, "transform_chain"); write_string_array(out, trace.transform_chain); out << ",\n";
  write_key(out, depth + 1, "quilt_decision_id"); write_string(out, trace.quilt_decision_id); out << ",\n";
  write_key(out, depth + 1, "target_bounds"); write_rect(out, trace.target_bounds); out << ",\n";
  write_key(out, depth + 1, "provenance_refs"); write_string_array(out, trace.provenance_refs); out << ",\n";
  write_key(out, depth + 1, "inspection_handles"); write_string_array(out, trace.inspection_handles); out << "\n";
  indent(out, depth); out << "}";
}

void write_payload(std::ostream& out, const PrimitivePayload& payload, PrimitiveKind kind, int depth) {
  out << "{\n";
  write_key(out, depth + 1, "type"); write_string(out, PrimitiveKindName(kind)); out << ",\n";
  std::visit([&](const auto& value) {
    using T = std::decay_t<decltype(value)>;
    if constexpr (std::is_same_v<T, AreaFill>) {
      write_key(out, depth + 1, "rings"); write_rings(out, value.rings); out << ",\n";
      write_key(out, depth + 1, "coordinate_space"); write_string(out, coordinate_space_name(value.coordinate_space)); out << ",\n";
      write_key(out, depth + 1, "fill"); out << "{\"color\": "; write_string(out, value.fill.color);
      out << ", \"pattern_ref\": "; write_string(out, value.fill.pattern_ref);
      out << ", \"opacity\": "; write_number(out, value.fill.opacity); out << "},\n";
      write_key(out, depth + 1, "clip_ref"); write_string(out, value.clip_ref); out << "\n";
    } else if constexpr (std::is_same_v<T, LineStroke>) {
      write_key(out, depth + 1, "polyline"); write_vec2_array(out, value.polyline); out << ",\n";
      write_key(out, depth + 1, "coordinate_space"); write_string(out, coordinate_space_name(value.coordinate_space)); out << ",\n";
      write_key(out, depth + 1, "stroke"); out << "{\"color\": "; write_string(out, value.stroke.color);
      out << ", \"line_style_ref\": "; write_string(out, value.stroke.line_style_ref);
      out << ", \"width_px\": "; write_number(out, value.stroke.width_px);
      out << ", \"join\": "; write_string(out, value.stroke.join);
      out << ", \"cap\": "; write_string(out, value.stroke.cap);
      out << ", \"dash_phase\": "; write_number(out, value.stroke.dash_phase); out << "}\n";
    } else if constexpr (std::is_same_v<T, SymbolInstance>) {
      write_key(out, depth + 1, "symbol_ref"); write_string(out, value.symbol_ref); out << ",\n";
      write_key(out, depth + 1, "position"); write_vec2(out, value.position); out << ",\n";
      write_key(out, depth + 1, "coordinate_space"); write_string(out, coordinate_space_name(value.coordinate_space)); out << ",\n";
      write_key(out, depth + 1, "anchor"); write_vec2(out, value.anchor); out << ",\n";
      write_key(out, depth + 1, "rotation_deg"); write_number(out, value.rotation_deg); out << ",\n";
      write_key(out, depth + 1, "scale"); write_number(out, value.scale); out << ",\n";
      write_key(out, depth + 1, "declutter_key"); write_string(out, value.declutter_key); out << ",\n";
      write_key(out, depth + 1, "priority"); out << value.priority << "\n";
    } else if constexpr (std::is_same_v<T, TextLabel>) {
      write_key(out, depth + 1, "text"); write_string(out, value.text); out << ",\n";
      write_key(out, depth + 1, "text_run_refs"); write_string_array(out, value.text_run_refs); out << ",\n";
      write_key(out, depth + 1, "position"); write_vec2(out, value.position); out << ",\n";
      write_key(out, depth + 1, "coordinate_space"); write_string(out, coordinate_space_name(value.coordinate_space)); out << ",\n";
      write_key(out, depth + 1, "anchor"); write_vec2(out, value.anchor); out << ",\n";
      write_key(out, depth + 1, "rotation_deg"); write_number(out, value.rotation_deg); out << ",\n";
      write_key(out, depth + 1, "font_ref"); write_string(out, value.font_ref); out << ",\n";
      write_key(out, depth + 1, "halo"); out << "{\"color\": "; write_string(out, value.halo.color);
      out << ", \"width_px\": "; write_number(out, value.halo.width_px); out << "},\n";
      write_key(out, depth + 1, "priority"); out << value.priority << ",\n";
      write_key(out, depth + 1, "collision_box"); write_rect(out, value.collision_box); out << "\n";
    } else if constexpr (std::is_same_v<T, Sounding>) {
      write_key(out, depth + 1, "depth_m"); write_number(out, value.depth_m); out << ",\n";
      write_key(out, depth + 1, "formatted_text"); write_string(out, value.formatted_text); out << ",\n";
      write_key(out, depth + 1, "position"); write_vec2(out, value.position); out << ",\n";
      write_key(out, depth + 1, "coordinate_space"); write_string(out, coordinate_space_name(value.coordinate_space)); out << ",\n";
      write_key(out, depth + 1, "font_ref"); write_string(out, value.font_ref); out << ",\n";
      write_key(out, depth + 1, "priority"); out << value.priority << ",\n";
      write_key(out, depth + 1, "safety_class"); write_string(out, value.safety_class); out << "\n";
    } else if constexpr (std::is_same_v<T, RasterPatch>) {
      write_key(out, depth + 1, "texture_ref"); write_string(out, value.texture_ref); out << ",\n";
      write_key(out, depth + 1, "source_quad"); out << '[';
      for (std::size_t i = 0; i < value.source_quad.size(); ++i) { if (i) out << ", "; write_vec2(out, value.source_quad[i]); }
      out << "],\n";
      write_key(out, depth + 1, "target_quad"); out << '[';
      for (std::size_t i = 0; i < value.target_quad.size(); ++i) { if (i) out << ", "; write_vec2(out, value.target_quad[i]); }
      out << "],\n";
      write_key(out, depth + 1, "source_space"); write_string(out, coordinate_space_name(value.source_space)); out << ",\n";
      write_key(out, depth + 1, "target_space"); write_string(out, coordinate_space_name(value.target_space)); out << ",\n";
      write_key(out, depth + 1, "opacity"); write_number(out, value.opacity); out << ",\n";
      write_key(out, depth + 1, "collar_policy"); write_string(out, value.collar_policy); out << ",\n";
      write_key(out, depth + 1, "coverage_policy"); write_string(out, value.coverage_policy); out << "\n";
    } else if constexpr (std::is_same_v<T, ContourLine>) {
      write_key(out, depth + 1, "polyline"); write_vec2_array(out, value.polyline); out << ",\n";
      write_key(out, depth + 1, "coordinate_space"); write_string(out, coordinate_space_name(value.coordinate_space)); out << ",\n";
      write_key(out, depth + 1, "contour_m"); write_number(out, value.contour_m); out << ",\n";
      write_key(out, depth + 1, "contour_role"); write_string(out, value.contour_role); out << ",\n";
      write_key(out, depth + 1, "stroke"); out << "{\"color\": "; write_string(out, value.stroke.color);
      out << ", \"line_style_ref\": "; write_string(out, value.stroke.line_style_ref);
      out << ", \"width_px\": "; write_number(out, value.stroke.width_px);
      out << ", \"join\": "; write_string(out, value.stroke.join);
      out << ", \"cap\": "; write_string(out, value.stroke.cap);
      out << ", \"dash_phase\": "; write_number(out, value.stroke.dash_phase); out << "}\n";
    } else {
      write_key(out, depth + 1, "unsupported"); out << "true\n";
    }
  }, payload);
  indent(out, depth); out << "}";
}

void write_primitive(std::ostream& out, const RenderPrimitive& primitive, int depth) {
  out << "{\n";
  write_key(out, depth + 1, "primitive_id"); write_string(out, primitive.primitive_id); out << ",\n";
  write_key(out, depth + 1, "kind"); write_string(out, PrimitiveKindName(primitive.kind)); out << ",\n";
  write_key(out, depth + 1, "order"); out << "{";
  out << "\"chart_priority\": " << primitive.order.chart_priority
      << ", \"quilt_rank\": " << primitive.order.quilt_rank
      << ", \"display_priority\": " << primitive.order.display_priority
      << ", \"render_pass_rank\": " << primitive.order.render_pass_rank
      << ", \"source_sequence\": " << primitive.order.source_sequence
      << ", \"extension\": [";
  for (std::size_t i = 0; i < primitive.order.extension.size(); ++i) {
    if (i) out << ", ";
    out << primitive.order.extension[i];
  }
  out << "]},\n";
  write_key(out, depth + 1, "material"); out << "{";
  out << "\"material_id\": "; write_string(out, primitive.material.material_id);
  out << ", \"style_key\": "; write_string(out, primitive.material.style_key);
  out << ", \"palette_ref\": "; write_string(out, primitive.material.palette_ref);
  out << ", \"symbol_ref\": "; write_string(out, primitive.material.symbol_ref);
  out << ", \"line_style_ref\": "; write_string(out, primitive.material.line_style_ref);
  out << ", \"pattern_ref\": "; write_string(out, primitive.material.pattern_ref);
  out << ", \"font_ref\": "; write_string(out, primitive.material.font_ref);
  out << ", \"raster_texture_ref\": "; write_string(out, primitive.material.raster_texture_ref);
  out << "},\n";
  write_key(out, depth + 1, "source_trace"); write_source_trace(out, primitive.source, depth + 1); out << ",\n";
  write_key(out, depth + 1, "scale"); out << "{\"native_scale\": " << primitive.scale.native_scale
      << ", \"min_scale_denom\": "; write_optional_uint(out, primitive.scale.min_scale_denom);
  out << ", \"max_scale_denom\": "; write_optional_uint(out, primitive.scale.max_scale_denom);
  out << ", \"scamin_max_scale\": "; write_optional_uint(out, primitive.scale.scamin_max_scale);
  out << ", \"use_scamin\": " << (primitive.scale.use_scamin ? "true" : "false")
      << ", \"use_super_scamin\": " << (primitive.scale.use_super_scamin ? "true" : "false")
      << ", \"overzoom\": " << (primitive.scale.overzoom ? "true" : "false") << "},\n";
  write_key(out, depth + 1, "safety"); out << "{";
  out << "\"display_category\": "; write_string(out, primitive.safety.display_category);
  out << ", \"safety_class\": "; write_string(out, primitive.safety.safety_class);
  out << ", \"contour_role\": "; write_string(out, primitive.safety.contour_role);
  out << ", \"danger_class\": "; write_string(out, primitive.safety.danger_class);
  out << ", \"display_state\": "; write_string(out, primitive.safety.display_state);
  out << ", \"safety_relevant\": " << (primitive.safety.safety_relevant ? "true" : "false") << "},\n";
  write_key(out, depth + 1, "payload"); write_payload(out, primitive.payload, primitive.kind, depth + 1); out << "\n";
  indent(out, depth); out << "}";
}

[[nodiscard]] std::string render_model_json(const RenderModel& model) {
  std::ostringstream out;
  out << "{\n";
  write_key(out, 1, "schema_version"); write_string(out, model.schema_version); out << ",\n";
  write_key(out, 1, "model_id"); write_string(out, model.model_id); out << ",\n";
  write_key(out, 1, "source_epoch"); write_string(out, model.source_epoch); out << ",\n";
  write_key(out, 1, "render_view"); out << "{";
  out << "\"projection\": "; write_string(out, model.render_view.projection);
  out << ", \"geographic_bbox\": {\"west\": "; write_number(out, model.render_view.west);
  out << ", \"south\": "; write_number(out, model.render_view.south);
  out << ", \"east\": "; write_number(out, model.render_view.east);
  out << ", \"north\": "; write_number(out, model.render_view.north);
  out << "}, \"center\": {\"lon\": "; write_number(out, model.render_view.center_lon);
  out << ", \"lat\": "; write_number(out, model.render_view.center_lat);
  out << "}, \"scale_denom\": " << model.render_view.scale_denom
      << ", \"rotation_deg\": "; write_number(out, model.render_view.rotation_deg);
  out << ", \"pixel_size\": [" << model.render_view.pixel_width << ", " << model.render_view.pixel_height << "]"
      << ", \"device_pixel_ratio\": "; write_number(out, model.render_view.device_pixel_ratio);
  out << ", \"overzoom\": " << (model.render_view.overzoom ? "true" : "false")
      << ", \"overscan_px\": " << model.render_view.overscan_px << "},\n";
  write_key(out, 1, "display_state"); out << "{";
  out << "\"palette\": "; write_string(out, model.display_state.palette);
  out << ", \"display_category\": "; write_string(out, model.display_state.display_category);
  out << ", \"symbol_style\": "; write_string(out, model.display_state.symbol_style);
  out << ", \"boundary_style\": "; write_string(out, model.display_state.boundary_style);
  out << ", \"safety_depth_m\": "; write_number(out, model.display_state.safety_depth_m);
  out << ", \"shallow_contour_m\": "; write_number(out, model.display_state.shallow_contour_m);
  out << ", \"safety_contour_m\": "; write_number(out, model.display_state.safety_contour_m);
  out << ", \"deep_contour_m\": "; write_number(out, model.display_state.deep_contour_m);
  out << ", \"show_text\": " << (model.display_state.show_text ? "true" : "false")
      << ", \"show_soundings\": " << (model.display_state.show_soundings ? "true" : "false")
      << ", \"show_lights\": " << (model.display_state.show_lights ? "true" : "false")
      << ", \"simplified_symbols\": " << (model.display_state.simplified_symbols ? "true" : "false")
      << ", \"two_shade_depth\": " << (model.display_state.two_shade_depth ? "true" : "false")
      << ", \"use_scamin\": " << (model.display_state.use_scamin ? "true" : "false")
      << ", \"use_super_scamin\": " << (model.display_state.use_super_scamin ? "true" : "false");
  out << ", \"language\": "; write_string(out, model.display_state.language);
  out << ", \"units\": "; write_string(out, model.display_state.units);
  out << "},\n";
  write_key(out, 1, "resources"); out << "[\n";
  for (std::size_t i = 0; i < model.resources.size(); ++i) {
    const auto& resource = model.resources[i];
    indent(out, 2); out << "{";
    out << "\"resource_id\": "; write_string(out, resource.resource_id);
    out << ", \"kind\": "; write_string(out, resource.kind);
    out << ", \"material_key\": "; write_string(out, resource.material_key);
    out << ", \"content_hash\": "; write_string(out, resource.content_hash);
    out << ", \"provenance_refs\": "; write_string_array(out, resource.provenance_refs);
    out << "}";
    out << (i + 1 == model.resources.size() ? "\n" : ",\n");
  }
  indent(out, 1); out << "],\n";
  write_key(out, 1, "layers"); out << "[\n";
  for (std::size_t layer_i = 0; layer_i < model.layers.size(); ++layer_i) {
    const RenderLayer& layer = model.layers[layer_i];
    indent(out, 2); out << "{\n";
    write_key(out, 3, "layer_id"); write_string(out, layer.layer_id); out << ",\n";
    write_key(out, 3, "kind"); write_string(out, layer.kind); out << ",\n";
    write_key(out, 3, "authority"); write_string(out, layer.authority); out << ",\n";
    write_key(out, 3, "order_bucket"); out << layer.order_bucket << ",\n";
    write_key(out, 3, "primitives"); out << "[\n";
    for (std::size_t primitive_i = 0; primitive_i < layer.primitives.size(); ++primitive_i) {
      indent(out, 4);
      write_primitive(out, layer.primitives[primitive_i], 4);
      out << (primitive_i + 1 == layer.primitives.size() ? "\n" : ",\n");
    }
    indent(out, 3); out << "]\n";
    indent(out, 2); out << "}" << (layer_i + 1 == model.layers.size() ? "\n" : ",\n");
  }
  indent(out, 1); out << "],\n";
  write_key(out, 1, "diagnostics"); out << "[\n";
  for (std::size_t i = 0; i < model.diagnostics.size(); ++i) {
    const auto& diagnostic = model.diagnostics[i];
    indent(out, 2); out << "{";
    out << "\"severity\": "; write_string(out, diagnostic.severity);
    out << ", \"code\": "; write_string(out, diagnostic.code);
    out << ", \"message\": "; write_string(out, diagnostic.message);
    out << ", \"provenance_refs\": "; write_string_array(out, diagnostic.provenance_refs);
    out << ", \"suggested_action\": "; write_string(out, diagnostic.suggested_action);
    out << "}" << (i + 1 == model.diagnostics.size() ? "\n" : ",\n");
  }
  indent(out, 1); out << "]\n";
  out << "}\n";
  return out.str();
}

class BinaryWriter {
 public:
  void u8(std::uint8_t value) { bytes_.push_back(static_cast<char>(value)); }

  void u32(std::uint32_t value) {
    for (int i = 0; i < 4; ++i) u8(static_cast<std::uint8_t>((value >> (i * 8)) & 0xffu));
  }

  void i32(std::int32_t value) { u32(static_cast<std::uint32_t>(value)); }

  void u64(std::uint64_t value) {
    for (int i = 0; i < 8; ++i) u8(static_cast<std::uint8_t>((value >> (i * 8)) & 0xffu));
  }

  void i64(std::int64_t value) { u64(static_cast<std::uint64_t>(value)); }

  void f64(double value) {
    static_assert(sizeof(double) == sizeof(std::uint64_t), "double must be 64-bit");
    std::uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    u64(bits);
  }

  void str(const std::string& value) {
    u32(static_cast<std::uint32_t>(value.size()));
    bytes_ += value;
  }

  void strv(const std::vector<std::string>& values) {
    u32(static_cast<std::uint32_t>(values.size()));
    for (const std::string& value : values) str(value);
  }

  void vec2(const Vec2& value) {
    f64(value.x);
    f64(value.y);
  }

  void rect(const Rect& value) {
    f64(value.x);
    f64(value.y);
    f64(value.width);
    f64(value.height);
  }

  [[nodiscard]] const std::string& bytes() const { return bytes_; }

 private:
  std::string bytes_;
};

void write_binary_payload(BinaryWriter& out, const PrimitivePayload& payload) {
  std::visit([&](const auto& value) {
    using T = std::decay_t<decltype(value)>;
    if constexpr (std::is_same_v<T, AreaFill>) {
      out.u32(static_cast<std::uint32_t>(value.rings.size()));
      for (const auto& ring : value.rings) {
        out.u32(static_cast<std::uint32_t>(ring.size()));
        for (const Vec2& point : ring) out.vec2(point);
      }
      out.str(coordinate_space_name(value.coordinate_space));
      out.str(value.fill.color);
      out.str(value.fill.pattern_ref);
      out.f64(value.fill.opacity);
      out.str(value.clip_ref);
    } else if constexpr (std::is_same_v<T, LineStroke>) {
      out.u32(static_cast<std::uint32_t>(value.polyline.size()));
      for (const Vec2& point : value.polyline) out.vec2(point);
      out.str(coordinate_space_name(value.coordinate_space));
      out.str(value.stroke.color);
      out.str(value.stroke.line_style_ref);
      out.f64(value.stroke.width_px);
    } else if constexpr (std::is_same_v<T, SymbolInstance>) {
      out.str(value.symbol_ref);
      out.vec2(value.position);
      out.str(coordinate_space_name(value.coordinate_space));
      out.vec2(value.anchor);
      out.f64(value.rotation_deg);
      out.f64(value.scale);
      out.str(value.declutter_key);
      out.i32(value.priority);
    } else if constexpr (std::is_same_v<T, TextLabel>) {
      out.str(value.text);
      out.strv(value.text_run_refs);
      out.vec2(value.position);
      out.str(coordinate_space_name(value.coordinate_space));
      out.vec2(value.anchor);
      out.f64(value.rotation_deg);
      out.str(value.font_ref);
      out.str(value.halo.color);
      out.f64(value.halo.width_px);
      out.i32(value.priority);
      out.rect(value.collision_box);
    } else if constexpr (std::is_same_v<T, Sounding>) {
      out.f64(value.depth_m);
      out.str(value.formatted_text);
      out.vec2(value.position);
      out.str(coordinate_space_name(value.coordinate_space));
      out.str(value.font_ref);
      out.i32(value.priority);
      out.str(value.safety_class);
    } else if constexpr (std::is_same_v<T, RasterPatch>) {
      out.str(value.texture_ref);
      for (const Vec2& point : value.source_quad) out.vec2(point);
      for (const Vec2& point : value.target_quad) out.vec2(point);
      out.str(coordinate_space_name(value.source_space));
      out.str(coordinate_space_name(value.target_space));
      out.f64(value.opacity);
      out.str(value.collar_policy);
      out.str(value.coverage_policy);
    } else if constexpr (std::is_same_v<T, ContourLine>) {
      out.u32(static_cast<std::uint32_t>(value.polyline.size()));
      for (const Vec2& point : value.polyline) out.vec2(point);
      out.str(coordinate_space_name(value.coordinate_space));
      out.f64(value.contour_m);
      out.str(value.contour_role);
      out.str(value.stroke.color);
      out.str(value.stroke.line_style_ref);
      out.f64(value.stroke.width_px);
    } else {
      out.u32(0);
    }
  }, payload);
}

[[nodiscard]] std::string render_model_binary(const RenderModel& model) {
  BinaryWriter out;
  out.u32(0x4d524d48u);  // HMRM little-endian.
  out.u32(1);
  out.str(model.schema_version);
  out.str(model.model_id);
  out.str(model.source_epoch);
  out.str(model.render_view.projection);
  out.f64(model.render_view.west);
  out.f64(model.render_view.south);
  out.f64(model.render_view.east);
  out.f64(model.render_view.north);
  out.u32(model.render_view.scale_denom);
  out.str(model.display_state.palette);
  out.str(model.display_state.display_category);
  out.u32(static_cast<std::uint32_t>(model.resources.size()));
  for (const auto& resource : model.resources) {
    out.str(resource.resource_id);
    out.str(resource.kind);
    out.str(resource.material_key);
    out.str(resource.content_hash);
  }
  std::uint32_t primitive_count = 0;
  for (const auto& layer : model.layers) primitive_count += static_cast<std::uint32_t>(layer.primitives.size());
  out.u32(primitive_count);
  for (const RenderLayer& layer : model.layers) {
    for (const RenderPrimitive& primitive : layer.primitives) {
      out.str(layer.layer_id);
      out.str(primitive.primitive_id);
      out.u32(static_cast<std::uint32_t>(primitive.kind));
      out.i32(primitive.order.chart_priority);
      out.i32(primitive.order.quilt_rank);
      out.i32(primitive.order.display_priority);
      out.i32(primitive.order.render_pass_rank);
      out.i64(primitive.order.source_sequence);
      out.str(primitive.material.material_id);
      out.str(primitive.material.style_key);
      out.str(primitive.material.palette_ref);
      out.str(primitive.material.symbol_ref);
      out.str(primitive.material.line_style_ref);
      out.str(primitive.material.font_ref);
      out.str(primitive.source.source_chart_id);
      out.str(primitive.source.source_chart_edition);
      out.str(primitive.source.source_update);
      out.str(primitive.source.source_feature_id);
      out.str(primitive.source.source_feature_sub_id);
      out.str(primitive.source.object_class);
      out.str(primitive.source.source_geometry_hash);
      out.str(primitive.source.presentation_authority);
      out.str(primitive.source.presentation_rule_id);
      out.str(primitive.source.conversion_stage);
      out.strv(primitive.source.transform_chain);
      out.strv(primitive.source.provenance_refs);
      out.strv(primitive.source.inspection_handles);
      out.u32(primitive.scale.native_scale);
      out.u32(primitive.scale.scamin_max_scale.value_or(0));
      out.str(primitive.safety.display_category);
      out.str(primitive.safety.safety_class);
      out.str(primitive.safety.contour_role);
      out.u8(primitive.safety.safety_relevant ? 1 : 0);
      write_binary_payload(out, primitive.payload);
    }
  }
  return out.bytes();
}

std::uint32_t rotr(std::uint32_t v, std::uint32_t n) {
  return (v >> n) | (v << (32 - n));
}

void append_canonical_json(const Json& value, std::string& out) {
  if (value.is_null()) {
    out += "null";
  } else if (value.is_bool()) {
    out += value.boolean() ? "true" : "false";
  } else if (value.is_number()) {
    out += number_to_string(value.number());
  } else if (value.is_string()) {
    std::ostringstream quoted;
    write_string(quoted, value.string());
    out += quoted.str();
  } else if (value.is_array()) {
    out.push_back('[');
    const JsonArray& array = value.array();
    for (std::size_t i = 0; i < array.size(); ++i) {
      if (i) out.push_back(',');
      append_canonical_json(array[i], out);
    }
    out.push_back(']');
  } else {
    out.push_back('{');
    const JsonObject& object = value.object();
    for (JsonObject::const_iterator it = object.begin(); it != object.end(); ++it) {
      if (it != object.begin()) out.push_back(',');
      std::ostringstream quoted;
      write_string(quoted, it->first);
      out += quoted.str();
      out.push_back(':');
      append_canonical_json(it->second, out);
    }
    out.push_back('}');
  }
}

std::string sha256_bytes(const std::string& bytes) {
  std::uint32_t h[8] = {
      0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
      0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  static const std::uint32_t k[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
      0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
      0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
      0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
      0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
      0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
      0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
      0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
      0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
      0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
      0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

  std::string padded = bytes;
  const std::uint64_t bit_len = static_cast<std::uint64_t>(padded.size()) * 8u;
  padded.push_back(static_cast<char>(0x80));
  while ((padded.size() % 64) != 56) padded.push_back('\0');
  for (int i = 7; i >= 0; --i) padded.push_back(static_cast<char>((bit_len >> (i * 8)) & 0xffu));

  for (std::size_t block = 0; block < padded.size(); block += 64) {
    std::uint32_t w[64];
    for (std::size_t i = 0; i < 16; ++i) {
      const auto p = reinterpret_cast<const unsigned char*>(padded.data() + block + i * 4);
      w[i] = (static_cast<std::uint32_t>(p[0]) << 24) |
             (static_cast<std::uint32_t>(p[1]) << 16) |
             (static_cast<std::uint32_t>(p[2]) << 8) |
             static_cast<std::uint32_t>(p[3]);
    }
    for (std::size_t i = 16; i < 64; ++i) {
      const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
    std::uint32_t e = h[4], f = h[5], g = h[6], hh = h[7];
    for (std::size_t i = 0; i < 64; ++i) {
      const std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const std::uint32_t ch = (e & f) ^ (~e & g);
      const std::uint32_t temp1 = hh + s1 + ch + k[i] + w[i];
      const std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t temp2 = s0 + maj;
      hh = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }

  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (std::uint32_t word : h) out << std::setw(8) << word;
  return out.str();
}

std::string json_sha256(const std::string& json) {
  std::string canonical;
  append_canonical_json(JsonParser(json).parse(), canonical);
  canonical.push_back('\n');
  return sha256_bytes(canonical);
}

void usage(const char* argv0) {
  std::cerr << "usage: " << argv0
            << " [fixture-dir] [--output-dir DIR] [--check] [--print-hashes]\n";
}

struct Options {
  std::filesystem::path fixture_dir = "engine/test/fixtures/vulkan-render/chart-1";
  std::filesystem::path output_dir;
  bool check = false;
  bool print_hashes = false;
};

[[nodiscard]] Options parse_args(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--check") {
      options.check = true;
    } else if (arg == "--print-hashes") {
      options.print_hashes = true;
    } else if (arg == "--output-dir") {
      if (++i >= argc) throw std::runtime_error("--output-dir requires a value");
      options.output_dir = argv[i];
    } else if (arg == "--help" || arg == "-h") {
      usage(argv[0]);
      std::exit(0);
    } else if (!arg.empty() && arg[0] == '-') {
      throw std::runtime_error("unknown option: " + arg);
    } else {
      options.fixture_dir = arg;
    }
  }
  if (options.output_dir.empty()) options.output_dir = options.fixture_dir;
  return options;
}

}  // namespace

#ifndef HELM_RENDER_ARTIFACT_COMPILER
int main(int argc, char** argv) {
  try {
    const Options options = parse_args(argc, argv);
    const RenderModel model = build_render_model(options.fixture_dir);
    require_model_invariants(model);

    const std::string json = render_model_json(model);
    const std::string binary = render_model_binary(model);
    const std::filesystem::path json_path = options.output_dir / "render-model.json";
    const std::filesystem::path binary_path = options.output_dir / "render-model.bin";

    if (options.check) {
      const std::string actual_json = read_file(json_path);
      const std::string actual_binary = read_file(binary_path, true);
      if (actual_json != json) throw std::runtime_error(json_path.string() + " is not up to date");
      if (actual_binary != binary) throw std::runtime_error(binary_path.string() + " is not up to date");
    } else {
      write_file(json_path, json);
      write_file(binary_path, binary, true);
    }

    if (options.print_hashes) {
      std::cout << "render_model_json_sha256: " << json_sha256(json) << "\n";
      std::cout << "render_model_binary_sha256: " << sha256_bytes(binary) << "\n";
    }
    std::cout << "ok render-model fixture export: " << model.model_id << ", "
              << helm::render::PrimitiveCount(model) << " primitives\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL render-model fixture export: " << e.what() << "\n";
    return 1;
  }
}
#endif  // HELM_RENDER_ARTIFACT_COMPILER

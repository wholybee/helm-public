#include "inspection_trace.h"

#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace {

using helm::inspect::FeatureMetadataAvailable;
using helm::inspect::InspectionTrace;
using helm::inspect::RasterFallbackHonest;
using helm::inspect::ResolutionKind;
using helm::inspect::ResolutionKindName;
using helm::inspect::TraceIsComplete;
using helm::inspect::kInspectionTraceSchemaVersion;

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

  [[nodiscard]] bool boolean() const {
    if (!is_bool()) throw std::runtime_error("expected JSON bool");
    return std::get<bool>(value);
  }

  [[nodiscard]] double number() const {
    if (!is_number()) throw std::runtime_error("expected JSON number");
    return std::get<double>(value);
  }

  [[nodiscard]] const Json& at(std::string_view key) const {
    const auto& obj = object();
    const auto it = obj.find(std::string(key));
    if (it == obj.end()) throw std::runtime_error("missing JSON key: " + std::string(key));
    return it->second;
  }

  [[nodiscard]] bool has(std::string_view key) const {
    if (!is_object()) return false;
    return object().count(std::string(key)) > 0;
  }
};

[[noreturn]] void fail(const std::string& message) {
  throw std::runtime_error(message);
}

void require(bool ok, const std::string& message) {
  if (!ok) fail(message);
}

void skip_ws(std::istream& in) {
  while (in && std::isspace(static_cast<unsigned char>(in.peek()))) in.get();
}

Json parse_value(std::istream& in);

Json parse_string(std::istream& in) {
  char quote = 0;
  in >> quote;
  require(quote == '"', "expected opening quote");
  std::string out;
  while (in) {
    const char ch = static_cast<char>(in.get());
    if (ch == '"') break;
    if (ch == '\\') {
      const char esc = static_cast<char>(in.get());
      if (esc == '"' || esc == '\\' || esc == '/') out.push_back(esc);
      else if (esc == 'n') out.push_back('\n');
      else if (esc == 't') out.push_back('\t');
      else if (esc == 'r') out.push_back('\r');
      else fail("unsupported escape");
      continue;
    }
    out.push_back(ch);
  }
  return Json{out};
}

Json parse_number(std::istream& in) {
  std::string token;
  while (in && (std::isdigit(static_cast<unsigned char>(in.peek())) || in.peek() == '-' ||
                in.peek() == '+' || in.peek() == '.' || in.peek() == 'e' || in.peek() == 'E')) {
    token.push_back(static_cast<char>(in.get()));
  }
  return Json{std::stod(token)};
}

Json parse_array(std::istream& in) {
  in.get();
  JsonArray items;
  skip_ws(in);
  if (in.peek() == ']') {
    in.get();
    return Json{items};
  }
  while (in) {
    items.push_back(parse_value(in));
    skip_ws(in);
    const char ch = static_cast<char>(in.get());
    if (ch == ']') break;
    require(ch == ',', "expected comma in array");
    skip_ws(in);
  }
  return Json{items};
}

Json parse_object(std::istream& in) {
  in.get();
  JsonObject items;
  skip_ws(in);
  if (in.peek() == '}') {
    in.get();
    return Json{items};
  }
  while (in) {
    skip_ws(in);
    Json key_json = parse_string(in);
    skip_ws(in);
    require(in.get() == ':', "expected colon");
    skip_ws(in);
    items.emplace(key_json.string(), parse_value(in));
    skip_ws(in);
    const char ch = static_cast<char>(in.get());
    if (ch == '}') break;
    require(ch == ',', "expected comma in object");
  }
  return Json{items};
}

Json parse_value(std::istream& in) {
  skip_ws(in);
  const int ch = in.peek();
  if (ch == '"') return parse_string(in);
  if (ch == '{') return parse_object(in);
  if (ch == '[') return parse_array(in);
  if (ch == 't') {
    std::string lit;
    lit.resize(4);
    in.read(lit.data(), 4);
    require(lit == "true", "expected true");
    return Json{true};
  }
  if (ch == 'f') {
    std::string lit;
    lit.resize(5);
    in.read(lit.data(), 5);
    require(lit == "false", "expected false");
    return Json{false};
  }
  if (ch == 'n') {
    std::string lit;
    lit.resize(4);
    in.read(lit.data(), 4);
    require(lit == "null", "expected null");
    return Json{nullptr};
  }
  return parse_number(in);
}

Json read_json_file(const std::filesystem::path& path) {
  std::ifstream in(path);
  require(in.good(), "unable to read " + path.string());
  return parse_value(in);
}

std::vector<std::string> string_array(const Json& value) {
  std::vector<std::string> out;
  if (value.is_null()) return out;
  for (const Json& item : value.array()) out.push_back(item.string());
  return out;
}

std::optional<std::string> optional_string(const Json& object, std::string_view key) {
  if (!object.has(key)) return std::nullopt;
  const Json& value = object.at(key);
  if (value.is_null()) return std::nullopt;
  return value.string();
}

ResolutionKind parse_resolution_kind(const std::string& value) {
  if (value == "vector_feature") return ResolutionKind::VectorFeature;
  if (value == "raster_fallback") return ResolutionKind::RasterFallback;
  if (value == "no_hit") return ResolutionKind::NoHit;
  fail("unknown resolution kind: " + value);
}

InspectionTrace parse_trace(const Json& root) {
  InspectionTrace trace;
  trace.schema_version = root.at("schema_version").string();
  trace.trace_id = root.at("trace_id").string();

  const Json& pick = root.at("pick");
  trace.pick.pixel_x = static_cast<std::uint32_t>(pick.at("pixel").array().at(0).number());
  trace.pick.pixel_y = static_cast<std::uint32_t>(pick.at("pixel").array().at(1).number());
  trace.pick.device_pixel_ratio = pick.has("device_pixel_ratio") ? pick.at("device_pixel_ratio").number() : 1;
  trace.pick.viewport_id = pick.has("viewport_id") ? pick.at("viewport_id").string() : "";
  trace.pick.backend = pick.at("backend").string();
  trace.pick.scene_id = pick.has("scene_id") ? pick.at("scene_id").string() : "";
  trace.pick.model_id = pick.has("model_id") ? pick.at("model_id").string() : "";

  const Json& resolution = root.at("resolution");
  trace.resolution_kind = parse_resolution_kind(resolution.at("kind").string());
  trace.feature_metadata_available = resolution.at("feature_metadata_available").boolean();

  if (root.has("draw_record")) {
    const Json& draw = root.at("draw_record");
    trace.draw.draw_record_id = draw.at("draw_record_id").string();
    trace.draw.command_id = draw.at("command_id").string();
    trace.draw.command_type = draw.has("command_type") ? draw.at("command_type").string() : "";
    trace.draw.primitive_id = draw.has("primitive_id") ? draw.at("primitive_id").string() : "";
    trace.draw.primitive_kind = draw.has("primitive_kind") ? draw.at("primitive_kind").string() : "";
    trace.draw.artifact_id = draw.has("artifact_id") ? draw.at("artifact_id").string() : "";
    trace.draw.layer_id = draw.has("layer_id") ? draw.at("layer_id").string() : "";
    trace.draw.provenance_refs = draw.has("provenance_refs") ? string_array(draw.at("provenance_refs")) : std::vector<std::string>{};
  }

  if (root.has("presentation")) {
    const Json& presentation = root.at("presentation");
    trace.presentation.presentation_authority =
        presentation.has("presentation_authority") ? presentation.at("presentation_authority").string() : "";
    trace.presentation.presentation_rule_id =
        presentation.has("presentation_rule_id") ? presentation.at("presentation_rule_id").string() : "";
    trace.presentation.material_id =
        presentation.has("material_id") ? presentation.at("material_id").string() : "";
    trace.presentation.style_key = presentation.has("style_key") ? presentation.at("style_key").string() : "";
    trace.presentation.conversion_stage =
        presentation.has("conversion_stage") ? presentation.at("conversion_stage").string() : "";
  }

  if (root.has("source")) {
    const Json& source = root.at("source");
    trace.source.source_chart_id = source.has("source_chart_id") ? source.at("source_chart_id").string() : "";
    trace.source.source_chart_edition =
        source.has("source_chart_edition") ? source.at("source_chart_edition").string() : "";
    trace.source.source_update = source.has("source_update") ? source.at("source_update").string() : "";
    trace.source.source_feature_id = optional_string(source, "source_feature_id");
    trace.source.source_feature_sub_id = optional_string(source, "source_feature_sub_id");
    trace.source.object_class = optional_string(source, "object_class");
    trace.source.source_geometry_hash =
        source.has("source_geometry_hash") ? source.at("source_geometry_hash").string() : "";
    trace.source.quilt_decision_id =
        source.has("quilt_decision_id") ? source.at("quilt_decision_id").string() : "";
    trace.source.transform_chain = source.has("transform_chain") ? string_array(source.at("transform_chain")) : std::vector<std::string>{};
    if (source.has("attributes")) {
      for (const Json& attr : source.at("attributes").array()) {
        trace.source.attributes.push_back(
            helm::render::SourceAttribute{attr.at("code").string(), attr.at("value").string()});
      }
    }
  }

  if (root.has("raster_fallback")) {
    const Json& raster = root.at("raster_fallback");
    trace.raster_fallback.active = raster.at("active").boolean();
    trace.raster_fallback.reason = optional_string(raster, "reason").value_or("");
    trace.raster_fallback.message = optional_string(raster, "message").value_or("");
    trace.raster_fallback.sidecar_metadata_available =
        raster.has("sidecar_metadata_available") ? raster.at("sidecar_metadata_available").boolean() : false;
    trace.raster_fallback.sidecar_name = optional_string(raster, "sidecar_name").value_or("");
  }

  trace.inspection_handles = root.has("inspection_handles") ? string_array(root.at("inspection_handles")) : std::vector<std::string>{};
  trace.warnings = root.has("warnings") ? string_array(root.at("warnings")) : std::vector<std::string>{};
  return trace;
}

void validate_trace_fixture(const std::filesystem::path& path) {
  const Json root = read_json_file(path);
  require(root.at("schema_version").string() == kInspectionTraceSchemaVersion,
          path.string() + ": schema_version must be " + kInspectionTraceSchemaVersion);

  const InspectionTrace trace = parse_trace(root);
  require(TraceIsComplete(trace), path.string() + ": trace failed completeness checks");

  if (trace.resolution_kind == ResolutionKind::VectorFeature) {
    require(FeatureMetadataAvailable(trace), path.string() + ": vector_feature must expose feature metadata");
    require(!trace.draw.provenance_refs.empty(), path.string() + ": vector_feature must carry provenance_refs");
  }

  if (trace.resolution_kind == ResolutionKind::RasterFallback) {
    require(RasterFallbackHonest(trace), path.string() + ": raster_fallback must be explicit and honest");
    require(!trace.raster_fallback.message.empty(), path.string() + ": raster_fallback message required");
  }

  if (trace.resolution_kind == ResolutionKind::NoHit) {
    require(!trace.feature_metadata_available, path.string() + ": no_hit must not claim feature metadata");
  }

  std::cout << "ok " << path.string() << " kind=" << ResolutionKindName(trace.resolution_kind)
            << " trace_id=" << trace.trace_id << '\n';
}

}  // namespace

int main(int argc, char** argv) {
  try {
    std::vector<std::filesystem::path> paths;
    if (argc > 1) {
      for (int i = 1; i < argc; ++i) paths.emplace_back(argv[i]);
    } else {
      const std::filesystem::path root =
          std::filesystem::path("engine/test/fixtures/vulkan-render/inspection-trace/traces");
      for (const auto& entry : std::filesystem::directory_iterator(root)) {
        if (entry.path().extension() == ".json") paths.push_back(entry.path());
      }
    }

    require(!paths.empty(), "no inspection trace fixtures found");
    for (const auto& path : paths) validate_trace_fixture(path);
    std::cout << "inspection-trace-smoke: " << paths.size() << " fixture(s) passed\n";
    return 0;
  } catch (const std::exception& ex) {
    std::cerr << "inspection-trace-smoke failed: " << ex.what() << '\n';
    return 1;
  }
}

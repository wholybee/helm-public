#define HELM_RENDER_ARTIFACT_COMPILER
#include "render_model_fixture_export.cpp"

#include "render_artifact.h"

#include "render_artifact_cache.h"

#include <algorithm>
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
#include <utility>
#include <variant>
#include <vector>

namespace helm::render {
namespace {

struct CompilerState {
  std::vector<float> vertices;
  std::vector<std::uint32_t> indices;
  std::map<std::string, std::int32_t> material_index;
  std::vector<MaterialTableEntry> material_table;
  std::map<std::string, std::int32_t> atlas_index;
  std::vector<AtlasRef> atlas_refs;
  std::vector<DrawBatchRecord> draw_batches;
  std::vector<PickRecord> pick_records;
  std::uint32_t next_pick_id = 1;
};

[[nodiscard]] std::string shader_family_for_kind(PrimitiveKind kind) {
  switch (kind) {
    case PrimitiveKind::AreaFill: return "AreaFill";
    case PrimitiveKind::LineStroke: return "LineStyle";
    case PrimitiveKind::SymbolInstance: return "SymbolInstanced";
    case PrimitiveKind::TextLabel: return "TextGlyph";
    case PrimitiveKind::Sounding: return "TextGlyph";
    case PrimitiveKind::RasterPatch: return "RasterSheet";
    case PrimitiveKind::ContourLine: return "ContourLine";
    case PrimitiveKind::CoverageMask: return "CoverageMask";
  }
  return "Unknown";
}

[[nodiscard]] std::string topology_for_kind(PrimitiveKind kind) {
  switch (kind) {
    case PrimitiveKind::LineStroke:
    case PrimitiveKind::ContourLine:
      return "line_list";
    case PrimitiveKind::SymbolInstance:
    case PrimitiveKind::TextLabel:
    case PrimitiveKind::Sounding:
      return "points";
    case PrimitiveKind::AreaFill:
    case PrimitiveKind::RasterPatch:
    case PrimitiveKind::CoverageMask:
      return "triangles";
  }
  return "triangles";
}

[[nodiscard]] std::string blend_mode_for_kind(PrimitiveKind kind) {
  if (kind == PrimitiveKind::RasterPatch) return "opaque";
  if (kind == PrimitiveKind::AreaFill) return "alpha";
  return "alpha";
}

void append_vertex(CompilerState& state, double x, double y, std::int32_t material_index,
                   std::uint32_t pick_id) {
  state.vertices.push_back(static_cast<float>(x));
  state.vertices.push_back(static_cast<float>(y));
  state.vertices.push_back(static_cast<float>(material_index));
  state.vertices.push_back(static_cast<float>(pick_id));
}

[[nodiscard]] std::int32_t material_index_for(CompilerState& state, const RenderPrimitive& primitive) {
  const auto it = state.material_index.find(primitive.material.material_id);
  if (it != state.material_index.end()) return it->second;

  MaterialTableEntry entry;
  entry.material_id = primitive.material.material_id;
  entry.style_key = primitive.material.style_key;
  entry.shader_family = shader_family_for_kind(primitive.kind);
  entry.palette_ref = primitive.material.palette_ref;
  entry.symbol_ref = primitive.material.symbol_ref;
  entry.line_style_ref = primitive.material.line_style_ref;
  entry.pattern_ref = primitive.material.pattern_ref;
  entry.font_ref = primitive.material.font_ref;
  entry.raster_texture_ref = primitive.material.raster_texture_ref;
  entry.blend_mode = blend_mode_for_kind(primitive.kind);

  const std::int32_t index = static_cast<std::int32_t>(state.material_table.size());
  state.material_index.emplace(entry.material_id, index);
  state.material_table.push_back(std::move(entry));
  return index;
}

[[nodiscard]] std::optional<std::int32_t> atlas_index_for(CompilerState& state,
                                                            const std::string& atlas_id,
                                                            const std::string& kind,
                                                            const std::string& content_hash) {
  if (atlas_id.empty()) return std::nullopt;
  const auto it = state.atlas_index.find(atlas_id);
  if (it != state.atlas_index.end()) return it->second;

  AtlasRef ref;
  ref.atlas_id = atlas_id;
  ref.kind = kind;
  ref.content_hash = content_hash.empty() ? ("fixture-atlas:" + atlas_id) : content_hash;
  ref.slot = static_cast<std::int32_t>(state.atlas_refs.size());
  const std::int32_t index = ref.slot;
  state.atlas_index.emplace(atlas_id, index);
  state.atlas_refs.push_back(std::move(ref));
  return index;
}

[[nodiscard]] std::string atlas_kind_for_ref(const std::string& ref, const RenderModel& model) {
  for (const ResourceRecord& resource : model.resources) {
    if (resource.resource_id == ref) return resource.kind;
  }
  if (ref.rfind("sym.", 0) == 0) return "symbols";
  if (ref.rfind("line.", 0) == 0) return "line_styles";
  if (ref.rfind("font.", 0) == 0) return "fonts";
  if (ref.rfind("raster.", 0) == 0) return "raster_textures";
  if (ref.rfind("palette.", 0) == 0) return "palettes";
  return "resources";
}

[[nodiscard]] std::string content_hash_for_ref(const std::string& ref, const RenderModel& model) {
  for (const ResourceRecord& resource : model.resources) {
    if (resource.resource_id == ref) return resource.content_hash;
  }
  return "fixture-atlas:" + ref;
}

void triangulate_ring(CompilerState& state,
                      const LinearRing& ring,
                      std::int32_t material_index,
                      std::uint32_t pick_id,
                      std::uint32_t& first_index,
                      std::uint32_t& index_count) {
  if (ring.size() < 3) return;
  const std::uint32_t base_vertex = static_cast<std::uint32_t>(state.vertices.size() / 4);
  for (const Vec2& point : ring) append_vertex(state, point.x, point.y, material_index, pick_id);
  first_index = static_cast<std::uint32_t>(state.indices.size());
  for (std::size_t i = 1; i + 1 < ring.size(); ++i) {
    state.indices.push_back(base_vertex);
    state.indices.push_back(base_vertex + static_cast<std::uint32_t>(i));
    state.indices.push_back(base_vertex + static_cast<std::uint32_t>(i + 1));
  }
  index_count = static_cast<std::uint32_t>(state.indices.size()) - first_index;
}

void append_line_polyline(CompilerState& state,
                          const Polyline& polyline,
                          std::int32_t material_index,
                          std::uint32_t pick_id,
                          std::uint32_t& first_index,
                          std::uint32_t& index_count) {
  if (polyline.size() < 2) return;
  const std::uint32_t base_vertex = static_cast<std::uint32_t>(state.vertices.size() / 4);
  for (const Vec2& point : polyline) append_vertex(state, point.x, point.y, material_index, pick_id);
  first_index = static_cast<std::uint32_t>(state.indices.size());
  for (std::size_t i = 0; i + 1 < polyline.size(); ++i) {
    state.indices.push_back(base_vertex + static_cast<std::uint32_t>(i));
    state.indices.push_back(base_vertex + static_cast<std::uint32_t>(i + 1));
  }
  index_count = static_cast<std::uint32_t>(state.indices.size()) - first_index;
}

void append_quad(CompilerState& state,
                 const Quad& quad,
                 std::int32_t material_index,
                 std::uint32_t pick_id,
                 std::uint32_t& first_index,
                 std::uint32_t& index_count) {
  const std::uint32_t base_vertex = static_cast<std::uint32_t>(state.vertices.size() / 4);
  for (const Vec2& point : quad) append_vertex(state, point.x, point.y, material_index, pick_id);
  first_index = static_cast<std::uint32_t>(state.indices.size());
  state.indices.push_back(base_vertex);
  state.indices.push_back(base_vertex + 1);
  state.indices.push_back(base_vertex + 2);
  state.indices.push_back(base_vertex);
  state.indices.push_back(base_vertex + 2);
  state.indices.push_back(base_vertex + 3);
  index_count = 6;
}

void append_point(CompilerState& state,
                  const Vec2& point,
                  std::int32_t material_index,
                  std::uint32_t pick_id,
                  std::uint32_t& first_index,
                  std::uint32_t& index_count) {
  append_vertex(state, point.x, point.y, material_index, pick_id);
  first_index = static_cast<std::uint32_t>(state.indices.size());
  state.indices.push_back(static_cast<std::uint32_t>((state.vertices.size() / 4) - 1));
  index_count = 1;
}

void append_primitive_geometry(CompilerState& state,
                               const RenderPrimitive& primitive,
                               std::int32_t material_index,
                               std::uint32_t pick_id,
                               std::uint32_t& first_index,
                               std::uint32_t& index_count,
                               std::uint32_t& first_vertex,
                               std::uint32_t& vertex_count) {
  first_vertex = static_cast<std::uint32_t>(state.vertices.size() / 4);
  first_index = static_cast<std::uint32_t>(state.indices.size());
  index_count = 0;

  std::visit([&](const auto& payload) {
    using T = std::decay_t<decltype(payload)>;
    if constexpr (std::is_same_v<T, AreaFill>) {
      for (const LinearRing& ring : payload.rings) {
        std::uint32_t ring_first = 0;
        std::uint32_t ring_count = 0;
        triangulate_ring(state, ring, material_index, pick_id, ring_first, ring_count);
        if (index_count == 0) {
          first_index = ring_first;
          index_count = ring_count;
        } else {
          index_count += ring_count;
        }
      }
    } else if constexpr (std::is_same_v<T, LineStroke> || std::is_same_v<T, ContourLine>) {
      append_line_polyline(state, payload.polyline, material_index, pick_id, first_index, index_count);
    } else if constexpr (std::is_same_v<T, SymbolInstance>) {
      const double half = 4.0 * payload.scale;
      Quad quad{
          Vec2{payload.position.x - half, payload.position.y - half},
          Vec2{payload.position.x + half, payload.position.y - half},
          Vec2{payload.position.x + half, payload.position.y + half},
          Vec2{payload.position.x - half, payload.position.y + half}};
      append_quad(state, quad, material_index, pick_id, first_index, index_count);
    } else if constexpr (std::is_same_v<T, TextLabel> || std::is_same_v<T, Sounding>) {
      const Vec2 position = std::is_same_v<T, TextLabel> ? payload.position : payload.position;
      append_point(state, position, material_index, pick_id, first_index, index_count);
    } else if constexpr (std::is_same_v<T, RasterPatch>) {
      append_quad(state, payload.target_quad, material_index, pick_id, first_index, index_count);
    } else if constexpr (std::is_same_v<T, CoverageMask>) {
      for (const LinearRing& ring : payload.rings) {
        std::uint32_t ring_first = 0;
        std::uint32_t ring_count = 0;
        triangulate_ring(state, ring, material_index, pick_id, ring_first, ring_count);
        if (index_count == 0) {
          first_index = ring_first;
          index_count = ring_count;
        } else {
          index_count += ring_count;
        }
      }
    }
  }, primitive.payload);

  vertex_count = static_cast<std::uint32_t>(state.vertices.size() / 4) - first_vertex;
}

[[nodiscard]] std::optional<std::string> primary_atlas_ref(const RenderPrimitive& primitive) {
  if (!primitive.material.symbol_ref.empty()) return primitive.material.symbol_ref;
  if (!primitive.material.line_style_ref.empty()) return primitive.material.line_style_ref;
  if (!primitive.material.font_ref.empty()) return primitive.material.font_ref;
  if (!primitive.material.raster_texture_ref.empty()) return primitive.material.raster_texture_ref;
  if (!primitive.material.pattern_ref.empty()) return primitive.material.pattern_ref;
  return std::nullopt;
}

void seed_atlas_refs(CompilerState& state, const RenderModel& model) {
  for (const ResourceRecord& resource : model.resources) {
    (void)atlas_index_for(state, resource.resource_id, resource.kind, resource.content_hash);
  }
}

void compile_primitive(CompilerState& state, const RenderPrimitive& primitive, const RenderModel& model) {
  const std::int32_t material_index = material_index_for(state, primitive);
  const std::uint32_t pick_id = state.next_pick_id++;

  std::optional<std::int32_t> atlas_index;
  if (const std::optional<std::string> atlas_ref = primary_atlas_ref(primitive)) {
    atlas_index = atlas_index_for(state,
                                  *atlas_ref,
                                  atlas_kind_for_ref(*atlas_ref, model),
                                  content_hash_for_ref(*atlas_ref, model));
  }

  std::uint32_t first_index = 0;
  std::uint32_t index_count = 0;
  std::uint32_t first_vertex = 0;
  std::uint32_t vertex_count = 0;
  append_primitive_geometry(state,
                            primitive,
                            material_index,
                            pick_id,
                            first_index,
                            index_count,
                            first_vertex,
                            vertex_count);
  if (index_count == 0) return;

  DrawBatchRecord batch;
  batch.batch_id = "batch." + primitive.primitive_id;
  batch.shader_family = shader_family_for_kind(primitive.kind);
  batch.topology = topology_for_kind(primitive.kind);
  batch.material_index = material_index;
  batch.atlas_index = atlas_index.value_or(-1);
  batch.first_index = first_index;
  batch.index_count = index_count;
  batch.first_vertex = first_vertex;
  batch.vertex_count = vertex_count;
  batch.order_bucket = primitive.order.render_pass_rank;
  batch.primitive_ids = {primitive.primitive_id};
  state.draw_batches.push_back(std::move(batch));

  PickRecord pick;
  pick.primitive_id = primitive.primitive_id;
  pick.inspection_handles = primitive.source.inspection_handles;
  pick.first_index = first_index;
  pick.index_count = index_count;
  pick.pick_id = pick_id;
  state.pick_records.push_back(std::move(pick));
}

[[nodiscard]] std::string float_bytes(const std::vector<float>& values) {
  std::string out;
  out.resize(values.size() * sizeof(float));
  if (!values.empty()) {
    std::memcpy(out.data(), values.data(), out.size());
  }
  return out;
}

[[nodiscard]] std::string index_bytes(const std::vector<std::uint32_t>& values) {
  std::string out;
  out.resize(values.size() * sizeof(std::uint32_t));
  if (!values.empty()) {
    std::memcpy(out.data(), values.data(), out.size());
  }
  return out;
}

void write_string(std::ostream& out, const std::string& value) {
  out << '"';
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(ch) << std::dec
              << std::setfill('0');
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  out << '"';
}

void write_string_array(std::ostream& out, const std::vector<std::string>& values) {
  out << '[';
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ", ";
    write_string(out, values[i]);
  }
  out << ']';
}

void write_float_array(std::ostream& out, const std::vector<float>& values) {
  out << '[';
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ", ";
    out << std::setprecision(17) << values[i];
  }
  out << ']';
}

void write_u32_array(std::ostream& out, const std::vector<std::uint32_t>& values) {
  out << '[';
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out << ", ";
    out << values[i];
  }
  out << ']';
}

[[nodiscard]] RenderArtifact ArtifactForBinaryHash(const RenderArtifact& artifact) {
  RenderArtifact out = artifact;
  out.checksums.packet_sha256.clear();
  return out;
}

}  // namespace

std::string RenderArtifactToJson(const RenderArtifact& artifact,
                                 const ArtifactCacheRecord* cache) {
  std::ostringstream out;
  out << std::setprecision(17);
  out << "{\n";
  out << "  \"schema_version\": ";
  write_string(out, artifact.schema_version);
  out << ",\n  \"artifact_id\": ";
  write_string(out, artifact.artifact_id);
  out << ",\n  \"source_model_id\": ";
  write_string(out, artifact.source_model_id);
  out << ",\n  \"source_epoch\": ";
  write_string(out, artifact.source_epoch);
  out << ",\n  \"viewport\": {\n";
  out << "    \"projection\": ";
  write_string(out, artifact.viewport.projection);
  out << ",\n    \"geographic_bbox\": {\"west\": " << artifact.viewport.west << ", \"south\": "
      << artifact.viewport.south << ", \"east\": " << artifact.viewport.east << ", \"north\": "
      << artifact.viewport.north << "},\n";
  out << "    \"pixel_size\": [" << artifact.viewport.pixel_width << ", " << artifact.viewport.pixel_height
      << "],\n";
  out << "    \"device_pixel_ratio\": " << artifact.viewport.device_pixel_ratio << ",\n";
  out << "    \"tile\": {\"z\": " << artifact.viewport.tile.z << ", \"x\": " << artifact.viewport.tile.x
      << ", \"y\": " << artifact.viewport.tile.y << "}\n";
  out << "  },\n  \"checksums\": {\n";
  out << "    \"source_model_json_sha256\": ";
  write_string(out, artifact.checksums.source_model_json_sha256);
  out << ",\n    \"geometry_sha256\": ";
  write_string(out, artifact.checksums.geometry_sha256);
  out << ",\n    \"tables_sha256\": ";
  write_string(out, artifact.checksums.tables_sha256);
  out << ",\n    \"packet_sha256\": ";
  write_string(out, artifact.checksums.packet_sha256);
  out << "\n  },\n  \"vertex_format\": ";
  write_string(out, kRenderArtifactVertexFormat);
  out << ",\n  \"material_table\": [\n";
  for (std::size_t i = 0; i < artifact.material_table.size(); ++i) {
    const MaterialTableEntry& entry = artifact.material_table[i];
    out << "    {\"material_id\": ";
    write_string(out, entry.material_id);
    out << ", \"style_key\": ";
    write_string(out, entry.style_key);
    out << ", \"shader_family\": ";
    write_string(out, entry.shader_family);
    out << ", \"palette_ref\": ";
    write_string(out, entry.palette_ref);
    out << ", \"symbol_ref\": ";
    write_string(out, entry.symbol_ref);
    out << ", \"line_style_ref\": ";
    write_string(out, entry.line_style_ref);
    out << ", \"pattern_ref\": ";
    write_string(out, entry.pattern_ref);
    out << ", \"font_ref\": ";
    write_string(out, entry.font_ref);
    out << ", \"raster_texture_ref\": ";
    write_string(out, entry.raster_texture_ref);
    out << ", \"blend_mode\": ";
    write_string(out, entry.blend_mode);
    out << "}" << (i + 1 == artifact.material_table.size() ? "\n" : ",\n");
  }
  out << "  ],\n  \"atlas_refs\": [\n";
  for (std::size_t i = 0; i < artifact.atlas_refs.size(); ++i) {
    const AtlasRef& ref = artifact.atlas_refs[i];
    out << "    {\"atlas_id\": ";
    write_string(out, ref.atlas_id);
    out << ", \"kind\": ";
    write_string(out, ref.kind);
    out << ", \"content_hash\": ";
    write_string(out, ref.content_hash);
    out << ", \"slot\": " << ref.slot << "}" << (i + 1 == artifact.atlas_refs.size() ? "\n" : ",\n");
  }
  out << "  ],\n  \"geometry\": {\n";
  out << "    \"vertices_f32\": ";
  write_float_array(out, artifact.vertices);
  out << ",\n    \"indices_u32\": ";
  write_u32_array(out, artifact.indices);
  out << "\n  },\n  \"draw_batches\": [\n";
  for (std::size_t i = 0; i < artifact.draw_batches.size(); ++i) {
    const DrawBatchRecord& batch = artifact.draw_batches[i];
    out << "    {\"batch_id\": ";
    write_string(out, batch.batch_id);
    out << ", \"shader_family\": ";
    write_string(out, batch.shader_family);
    out << ", \"topology\": ";
    write_string(out, batch.topology);
    out << ", \"material_index\": " << batch.material_index << ", \"atlas_index\": " << batch.atlas_index
        << ", \"first_index\": " << batch.first_index << ", \"index_count\": " << batch.index_count
        << ", \"first_vertex\": " << batch.first_vertex << ", \"vertex_count\": " << batch.vertex_count
        << ", \"order_bucket\": " << batch.order_bucket << ", \"primitive_ids\": ";
    write_string_array(out, batch.primitive_ids);
    out << "}" << (i + 1 == artifact.draw_batches.size() ? "\n" : ",\n");
  }
  out << "  ],\n  \"pick_records\": [\n";
  for (std::size_t i = 0; i < artifact.pick_records.size(); ++i) {
    const PickRecord& pick = artifact.pick_records[i];
    out << "    {\"primitive_id\": ";
    write_string(out, pick.primitive_id);
    out << ", \"inspection_handles\": ";
    write_string_array(out, pick.inspection_handles);
    out << ", \"first_index\": " << pick.first_index << ", \"index_count\": " << pick.index_count
        << ", \"pick_id\": " << pick.pick_id << "}"
        << (i + 1 == artifact.pick_records.size() ? "\n" : ",\n");
  }
  out << "  ],\n  \"diagnostics\": [\n";
  for (std::size_t i = 0; i < artifact.diagnostics.size(); ++i) {
    const Diagnostic& diagnostic = artifact.diagnostics[i];
    out << "    {\"severity\": ";
    write_string(out, diagnostic.severity);
    out << ", \"code\": ";
    write_string(out, diagnostic.code);
    out << ", \"message\": ";
    write_string(out, diagnostic.message);
    out << ", \"provenance_refs\": ";
    write_string_array(out, diagnostic.provenance_refs);
    out << ", \"suggested_action\": ";
    write_string(out, diagnostic.suggested_action);
    out << "}" << (i + 1 == artifact.diagnostics.size() ? "\n" : ",\n");
  }
  out << "  ]";
  if (cache != nullptr) {
    out << ",\n  \"cache\": " << ArtifactCacheRecordToJson(*cache) << "\n";
  } else {
    out << "\n";
  }
  out << "}\n";
  return out.str();
}

namespace {

[[nodiscard]] std::string RenderArtifactTablesJson(const RenderArtifact& artifact) {
  RenderArtifact tables_only = artifact;
  tables_only.vertices.clear();
  tables_only.indices.clear();
  tables_only.checksums.packet_sha256.clear();
  return RenderArtifactToJson(tables_only, nullptr);
}

}  // namespace

std::string RenderArtifactBinary(const RenderArtifact& artifact) {
  std::string out;
  auto append_u32 = [&](std::uint32_t value) {
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<char>((value >> (i * 8)) & 0xffu));
  };
  auto append_f32 = [&](float value) {
    std::uint32_t bits = 0;
    static_assert(sizeof(float) == sizeof(std::uint32_t));
    std::memcpy(&bits, &value, sizeof(bits));
    append_u32(bits);
  };
  auto append_str = [&](const std::string& value) {
    append_u32(static_cast<std::uint32_t>(value.size()));
    out += value;
  };

  append_u32(0x54415248u);  // HRAT little-endian
  append_u32(1);
  append_str(artifact.schema_version);
  append_str(artifact.artifact_id);
  append_str(artifact.source_model_id);
  append_str(artifact.source_epoch);
  append_str(artifact.checksums.source_model_json_sha256);
  append_str(artifact.checksums.geometry_sha256);
  append_str(artifact.checksums.tables_sha256);
  append_u32(artifact.viewport.pixel_width);
  append_u32(artifact.viewport.pixel_height);
  append_u32(artifact.viewport.tile.z);
  append_u32(artifact.viewport.tile.x);
  append_u32(artifact.viewport.tile.y);
  append_u32(static_cast<std::uint32_t>(artifact.vertices.size()));
  for (float value : artifact.vertices) append_f32(value);
  append_u32(static_cast<std::uint32_t>(artifact.indices.size()));
  for (std::uint32_t value : artifact.indices) append_u32(value);
  append_u32(static_cast<std::uint32_t>(artifact.draw_batches.size()));
  for (const DrawBatchRecord& batch : artifact.draw_batches) {
    append_str(batch.batch_id);
    append_str(batch.shader_family);
    append_u32(batch.first_index);
    append_u32(batch.index_count);
    append_u32(static_cast<std::uint32_t>(batch.material_index));
    append_u32(static_cast<std::uint32_t>(batch.atlas_index));
  }
  return out;
}

RenderArtifact CompileRenderArtifact(const RenderModel& model,
                                     const std::string& source_model_json_sha256,
                                     const TileRef& tile) {
  CompilerState state;
  seed_atlas_refs(state, model);

  std::vector<RenderPrimitive> ordered;
  for (const RenderLayer& layer : model.layers) {
    for (const RenderPrimitive& primitive : layer.primitives) ordered.push_back(primitive);
  }
  std::sort(ordered.begin(), ordered.end(), StableOrderLess);

  for (const RenderPrimitive& primitive : ordered) compile_primitive(state, primitive, model);

  RenderArtifact artifact;
  artifact.artifact_id = model.model_id + ".webgpu";
  artifact.source_model_id = model.model_id;
  artifact.source_epoch = model.source_epoch;
  artifact.viewport.projection = model.render_view.projection;
  artifact.viewport.west = model.render_view.west;
  artifact.viewport.south = model.render_view.south;
  artifact.viewport.east = model.render_view.east;
  artifact.viewport.north = model.render_view.north;
  artifact.viewport.pixel_width = model.render_view.pixel_width;
  artifact.viewport.pixel_height = model.render_view.pixel_height;
  artifact.viewport.device_pixel_ratio = model.render_view.device_pixel_ratio;
  artifact.viewport.tile = tile;
  artifact.material_table = std::move(state.material_table);
  artifact.atlas_refs = std::move(state.atlas_refs);
  artifact.vertices = std::move(state.vertices);
  artifact.indices = std::move(state.indices);
  artifact.draw_batches = std::move(state.draw_batches);
  artifact.pick_records = std::move(state.pick_records);
  artifact.diagnostics = model.diagnostics;

  const std::string geometry_bytes = float_bytes(artifact.vertices) + index_bytes(artifact.indices);
  const std::string tables_json = RenderArtifactTablesJson(artifact);

  artifact.checksums.source_model_json_sha256 = source_model_json_sha256;
  artifact.checksums.geometry_sha256 = sha256_bytes(geometry_bytes);
  artifact.checksums.tables_sha256 = json_sha256(tables_json);
  artifact.checksums.packet_sha256 = sha256_bytes(RenderArtifactBinary(ArtifactForBinaryHash(artifact)));
  return artifact;
}

bool ValidateRenderArtifact(const RenderArtifact& artifact, std::string* error) {
  if (artifact.schema_version != kRenderArtifactSchemaVersion) {
    if (error) *error = "unexpected artifact schema version";
    return false;
  }
  if (artifact.artifact_id.empty() || artifact.source_model_id.empty()) {
    if (error) *error = "artifact_id and source_model_id are required";
    return false;
  }
  if (artifact.vertices.empty() || artifact.indices.empty()) {
    if (error) *error = "artifact geometry must not be empty";
    return false;
  }
  if (artifact.vertices.size() % 4 != 0) {
    if (error) *error = "vertices_f32 must be a multiple of 4 floats";
    return false;
  }
  if (artifact.material_table.empty()) {
    if (error) *error = "material_table must not be empty";
    return false;
  }
  if (artifact.draw_batches.empty()) {
    if (error) *error = "draw_batches must not be empty";
    return false;
  }
  if (artifact.checksums.packet_sha256.empty()) {
    if (error) *error = "packet_sha256 is required";
    return false;
  }
  if (artifact.checksums.packet_sha256 != sha256_bytes(RenderArtifactBinary(ArtifactForBinaryHash(artifact)))) {
    if (error) *error = "packet_sha256 does not match binary payload";
    return false;
  }
  return true;
}

}  // namespace helm::render

namespace {

struct ArtifactOptions {
  std::filesystem::path fixture_dir = "engine/test/fixtures/vulkan-render/chart-1";
  std::filesystem::path output_dir;
  bool check = false;
  bool print_hashes = false;
};

[[nodiscard]] ArtifactOptions parse_artifact_args(int argc, char** argv) {
  ArtifactOptions options;
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
      std::cerr << "usage: render-artifact-compile [fixture-dir] [--output-dir DIR] [--check] [--print-hashes]\n";
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

[[nodiscard]] helm::render::TileRef tile_from_manifest(const std::filesystem::path& fixture_dir) {
  helm::render::TileRef tile;
  const std::filesystem::path manifest_path = fixture_dir / "manifest.json";
  const std::string manifest_text = read_file(manifest_path);
  const Json manifest = JsonParser(manifest_text).parse();
  const JsonArray& matrix = array_value(object_get(manifest, "capture_matrix"));
  if (matrix.empty()) return tile;
  const Json& entry = matrix.front();
  const Json* tile_json = object_get(entry, "tile");
  if (tile_json == nullptr) return tile;
  tile.z = static_cast<std::uint32_t>(int_value(object_get(*tile_json, "z")));
  tile.x = static_cast<std::uint32_t>(int_value(object_get(*tile_json, "x")));
  tile.y = static_cast<std::uint32_t>(int_value(object_get(*tile_json, "y")));
  return tile;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const ArtifactOptions options = parse_artifact_args(argc, argv);
    const helm::render::RenderModel model = build_render_model(options.fixture_dir);
    require_model_invariants(model);

    const std::string source_model_json = render_model_json(model);
    const std::string source_model_json_sha256 = json_sha256(source_model_json);
    const helm::render::TileRef tile = tile_from_manifest(options.fixture_dir);
    helm::render::RenderArtifact artifact =
        helm::render::CompileRenderArtifact(model, source_model_json_sha256, tile);

    std::string validation_error;
    if (!helm::render::ValidateRenderArtifact(artifact, &validation_error)) {
      throw std::runtime_error(validation_error);
    }

    const helm::render::ArtifactCacheRecord cache =
        helm::render::BuildArtifactCacheRecord(model, artifact, "webgpu");
    if (!helm::render::ValidateArtifactCacheRecord(cache, &validation_error)) {
      throw std::runtime_error(validation_error);
    }
    if (cache.artifact_packet_sha256 != artifact.checksums.packet_sha256) {
      throw std::runtime_error("cache artifact_packet_sha256 does not match packet_sha256");
    }

    const std::string json = helm::render::RenderArtifactToJson(artifact, &cache);
    const std::string binary = helm::render::RenderArtifactBinary(artifact);
    const std::filesystem::path json_path = options.output_dir / "render-artifact.json";
    const std::filesystem::path binary_path = options.output_dir / "render-artifact.bin";

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
      std::cout << "render_artifact_json_sha256: " << json_sha256(json) << "\n";
      std::cout << "render_artifact_binary_sha256: " << sha256_bytes(binary) << "\n";
      std::cout << "render_artifact_geometry_sha256: " << artifact.checksums.geometry_sha256 << "\n";
      std::cout << "render_artifact_tables_sha256: " << artifact.checksums.tables_sha256 << "\n";
      std::cout << "render_artifact_cache_key_sha256: " << cache.cache_key_sha256 << "\n";
      std::cout << "source_model_json_sha256: " << source_model_json_sha256 << "\n";
    }

    std::cout << "ok render-artifact compile: " << artifact.artifact_id << ", "
              << artifact.draw_batches.size() << " draw batches, "
              << artifact.vertices.size() / 4 << " vertices, " << artifact.indices.size()
              << " indices\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL render-artifact compile: " << e.what() << "\n";
    return 1;
  }
}

#include "render_artifact_cache.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <map>
#include <sstream>
#include <string_view>

namespace helm::render {
namespace {

[[nodiscard]] std::uint32_t rotr(std::uint32_t value, std::uint32_t bits) {
  return (value >> bits) | (value << (32 - bits));
}

[[nodiscard]] std::string sha256_hex(const std::string& bytes) {
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
      const auto* p = reinterpret_cast<const unsigned char*>(padded.data() + block + i * 4);
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
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }

  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (std::uint32_t word : h) out << std::setw(8) << word;
  return out.str();
}

[[nodiscard]] std::string fixed_double(double value) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6) << value;
  return out.str();
}

[[nodiscard]] std::string bool_token(bool value) { return value ? "1" : "0"; }

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

[[nodiscard]] std::string source_chain_token(const std::vector<SourceEditionRef>& chain) {
  std::ostringstream out;
  for (std::size_t i = 0; i < chain.size(); ++i) {
    if (i) out << ',';
    out << chain[i].source_chart_id << '@' << chain[i].source_chart_edition << '+'
        << chain[i].source_update;
  }
  return out.str();
}

[[nodiscard]] bool source_chain_equal(const std::vector<SourceEditionRef>& lhs,
                                      const std::vector<SourceEditionRef>& rhs) {
  if (lhs.size() != rhs.size()) return false;
  for (std::size_t i = 0; i < lhs.size(); ++i) {
    if (lhs[i].source_chart_id != rhs[i].source_chart_id ||
        lhs[i].source_chart_edition != rhs[i].source_chart_edition ||
        lhs[i].source_update != rhs[i].source_update) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] bool display_state_equal(const ArtifactDisplayCacheState& lhs,
                                       const ArtifactDisplayCacheState& rhs) {
  return lhs.palette == rhs.palette && lhs.display_category == rhs.display_category &&
         lhs.symbol_style == rhs.symbol_style && lhs.boundary_style == rhs.boundary_style &&
         std::abs(lhs.safety_depth_m - rhs.safety_depth_m) < 1e-9 &&
         std::abs(lhs.safety_contour_m - rhs.safety_contour_m) < 1e-9 &&
         lhs.show_text == rhs.show_text && lhs.show_soundings == rhs.show_soundings &&
         lhs.use_scamin == rhs.use_scamin;
}

}  // namespace

std::vector<SourceEditionRef> CollectSourceEditionChain(const RenderModel& model) {
  std::map<std::string, SourceEditionRef> unique;
  for (const RenderLayer& layer : model.layers) {
    for (const RenderPrimitive& primitive : layer.primitives) {
      const SourceTrace& trace = primitive.source;
      if (trace.source_chart_id.empty()) continue;
      const std::string key = trace.source_chart_id + "@" + trace.source_chart_edition + "+" +
                              trace.source_update;
      unique.emplace(key, SourceEditionRef{
                              trace.source_chart_id,
                              trace.source_chart_edition,
                              trace.source_update});
    }
  }
  std::vector<SourceEditionRef> out;
  out.reserve(unique.size());
  for (const auto& entry : unique) out.push_back(entry.second);
  std::sort(out.begin(), out.end(), [](const SourceEditionRef& lhs, const SourceEditionRef& rhs) {
    return std::tie(lhs.source_chart_id, lhs.source_chart_edition, lhs.source_update) <
           std::tie(rhs.source_chart_id, rhs.source_chart_edition, rhs.source_update);
  });
  return out;
}

ArtifactCacheRecord BuildArtifactCacheRecord(const RenderModel& model,
                                             const RenderArtifact& artifact,
                                             std::string_view backend_target) {
  ArtifactCacheRecord record;
  record.backend_target = std::string(backend_target);
  record.chart_epoch = model.source_epoch;
  record.source_edition_chain = CollectSourceEditionChain(model);
  record.display_state.palette = model.display_state.palette;
  record.display_state.display_category = model.display_state.display_category;
  record.display_state.symbol_style = model.display_state.symbol_style;
  record.display_state.boundary_style = model.display_state.boundary_style;
  record.display_state.safety_depth_m = model.display_state.safety_depth_m;
  record.display_state.safety_contour_m = model.display_state.safety_contour_m;
  record.display_state.show_text = model.display_state.show_text;
  record.display_state.show_soundings = model.display_state.show_soundings;
  record.display_state.use_scamin = model.display_state.use_scamin;
  record.projection = artifact.viewport.projection;
  record.tile = artifact.viewport.tile;
  record.pixel_width = artifact.viewport.pixel_width;
  record.pixel_height = artifact.viewport.pixel_height;
  record.render_model_schema_version = model.schema_version;
  record.render_artifact_schema_version = artifact.schema_version;
  record.vertex_format = kRenderArtifactVertexFormat;
  record.artifact_packet_sha256 = artifact.checksums.packet_sha256;
  FinalizeArtifactCacheRecord(record);
  return record;
}

void FinalizeArtifactCacheRecord(ArtifactCacheRecord& record) {
  record.invalidation_epoch = ArtifactInvalidationEpoch(record);
  record.cache_key = ArtifactCacheKey(record);
  record.cache_key_sha256 = sha256_hex(record.cache_key);
}

std::string ArtifactCacheKey(const ArtifactCacheRecord& record) {
  std::ostringstream key;
  key << "backend_target=" << record.backend_target << '\n'
      << "chart_epoch=" << record.chart_epoch << '\n'
      << "source_chain=" << source_chain_token(record.source_edition_chain) << '\n'
      << "display_palette=" << record.display_state.palette << '\n'
      << "display_category=" << record.display_state.display_category << '\n'
      << "symbol_style=" << record.display_state.symbol_style << '\n'
      << "boundary_style=" << record.display_state.boundary_style << '\n'
      << "safety_depth_m=" << fixed_double(record.display_state.safety_depth_m) << '\n'
      << "safety_contour_m=" << fixed_double(record.display_state.safety_contour_m) << '\n'
      << "show_text=" << bool_token(record.display_state.show_text) << '\n'
      << "show_soundings=" << bool_token(record.display_state.show_soundings) << '\n'
      << "use_scamin=" << bool_token(record.display_state.use_scamin) << '\n'
      << "projection=" << record.projection << '\n'
      << "tile_z=" << record.tile.z << '\n'
      << "tile_x=" << record.tile.x << '\n'
      << "tile_y=" << record.tile.y << '\n'
      << "pixel_width=" << record.pixel_width << '\n'
      << "pixel_height=" << record.pixel_height << '\n'
      << "render_model_schema=" << record.render_model_schema_version << '\n'
      << "render_artifact_schema=" << record.render_artifact_schema_version << '\n'
      << "vertex_format=" << record.vertex_format << '\n'
      << "artifact_packet_sha256=" << record.artifact_packet_sha256 << '\n';
  return key.str();
}

std::string ArtifactInvalidationEpoch(const ArtifactCacheRecord& record) {
  std::ostringstream out;
  out << record.chart_epoch << ':' << record.display_state.palette << ':'
      << record.display_state.display_category << ':' << record.backend_target << ':'
      << record.tile.z << '/' << record.tile.x << '/' << record.tile.y << ':'
      << source_chain_token(record.source_edition_chain);
  return sha256_hex(out.str()).substr(0, 16);
}

std::string ArtifactCacheRecordToJson(const ArtifactCacheRecord& record) {
  std::ostringstream out;
  out << std::setprecision(17);
  out << "{\n";
  out << "    \"schema_version\": ";
  write_string(out, record.schema_version);
  out << ",\n    \"backend_target\": ";
  write_string(out, record.backend_target);
  out << ",\n    \"rebuild_policy\": ";
  write_string(out, record.rebuild_policy);
  out << ",\n    \"chart_epoch\": ";
  write_string(out, record.chart_epoch);
  out << ",\n    \"invalidation_epoch\": ";
  write_string(out, record.invalidation_epoch);
  out << ",\n    \"source_edition_chain\": [\n";
  for (std::size_t i = 0; i < record.source_edition_chain.size(); ++i) {
    const SourceEditionRef& ref = record.source_edition_chain[i];
    out << "      {\"source_chart_id\": ";
    write_string(out, ref.source_chart_id);
    out << ", \"source_chart_edition\": ";
    write_string(out, ref.source_chart_edition);
    out << ", \"source_update\": ";
    write_string(out, ref.source_update);
    out << "}" << (i + 1 == record.source_edition_chain.size() ? "\n" : ",\n");
  }
  out << "    ],\n    \"display_state\": {\n";
  out << "      \"palette\": ";
  write_string(out, record.display_state.palette);
  out << ",\n      \"display_category\": ";
  write_string(out, record.display_state.display_category);
  out << ",\n      \"symbol_style\": ";
  write_string(out, record.display_state.symbol_style);
  out << ",\n      \"boundary_style\": ";
  write_string(out, record.display_state.boundary_style);
  out << ",\n      \"safety_depth_m\": " << record.display_state.safety_depth_m
      << ",\n      \"safety_contour_m\": " << record.display_state.safety_contour_m
      << ",\n      \"show_text\": " << (record.display_state.show_text ? "true" : "false")
      << ",\n      \"show_soundings\": " << (record.display_state.show_soundings ? "true" : "false")
      << ",\n      \"use_scamin\": " << (record.display_state.use_scamin ? "true" : "false")
      << "\n    },\n    \"schema_versions\": {\n";
  out << "      \"render_model\": ";
  write_string(out, record.render_model_schema_version);
  out << ",\n      \"render_artifact\": ";
  write_string(out, record.render_artifact_schema_version);
  out << ",\n      \"vertex_format\": ";
  write_string(out, record.vertex_format);
  out << "\n    },\n    \"artifact_packet_sha256\": ";
  write_string(out, record.artifact_packet_sha256);
  out << ",\n    \"cache_key\": ";
  write_string(out, record.cache_key);
  out << ",\n    \"cache_key_sha256\": ";
  write_string(out, record.cache_key_sha256);
  out << "\n  }";
  return out.str();
}

ArtifactCacheInvalidation EvaluateArtifactCacheInvalidation(const ArtifactCacheRecord& stored,
                                                            const ArtifactCacheRecord& candidate) {
  ArtifactCacheInvalidation out;
  if (stored.backend_target != candidate.backend_target) {
    out.valid = false;
    out.reasons.push_back("backend_target_changed");
  }
  if (stored.chart_epoch != candidate.chart_epoch) {
    out.valid = false;
    out.reasons.push_back("chart_epoch_changed");
  }
  if (!source_chain_equal(stored.source_edition_chain, candidate.source_edition_chain)) {
    out.valid = false;
    out.reasons.push_back("source_edition_chain_changed");
  }
  if (!display_state_equal(stored.display_state, candidate.display_state)) {
    out.valid = false;
    out.reasons.push_back("display_state_changed");
  }
  if (stored.render_model_schema_version != candidate.render_model_schema_version) {
    out.valid = false;
    out.reasons.push_back("render_model_schema_changed");
  }
  if (stored.render_artifact_schema_version != candidate.render_artifact_schema_version) {
    out.valid = false;
    out.reasons.push_back("render_artifact_schema_changed");
  }
  if (stored.vertex_format != candidate.vertex_format) {
    out.valid = false;
    out.reasons.push_back("vertex_format_changed");
  }
  if (stored.projection != candidate.projection || stored.tile.z != candidate.tile.z ||
      stored.tile.x != candidate.tile.x || stored.tile.y != candidate.tile.y ||
      stored.pixel_width != candidate.pixel_width || stored.pixel_height != candidate.pixel_height) {
    out.valid = false;
    out.reasons.push_back("viewport_changed");
  }
  if (stored.artifact_packet_sha256 != candidate.artifact_packet_sha256) {
    out.valid = false;
    out.reasons.push_back("artifact_checksum_changed");
  }
  return out;
}

bool ValidateArtifactCacheRecord(const ArtifactCacheRecord& record, std::string* error) {
  if (record.schema_version != kRenderArtifactCacheSchemaVersion) {
    if (error) *error = "unexpected artifact cache schema version";
    return false;
  }
  if (record.backend_target.empty()) {
    if (error) *error = "backend_target is required";
    return false;
  }
  if (record.chart_epoch.empty()) {
    if (error) *error = "chart_epoch is required";
    return false;
  }
  if (record.source_edition_chain.empty()) {
    if (error) *error = "source_edition_chain must not be empty";
    return false;
  }
  if (record.artifact_packet_sha256.empty()) {
    if (error) *error = "artifact_packet_sha256 is required";
    return false;
  }
  if (record.cache_key.empty() || record.cache_key_sha256.empty()) {
    if (error) *error = "cache_key and cache_key_sha256 are required";
    return false;
  }
  if (record.cache_key_sha256 != sha256_hex(record.cache_key)) {
    if (error) *error = "cache_key_sha256 does not match cache_key";
    return false;
  }
  if (record.rebuild_policy != kArtifactCacheRebuildPolicy) {
    if (error) *error = "unexpected rebuild_policy";
    return false;
  }
  return true;
}

}  // namespace helm::render

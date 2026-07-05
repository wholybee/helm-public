#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace helm::schedule {

inline constexpr const char* kScheduleRequestSchema = "helm.render.schedule.request.v1";
inline constexpr const char* kScheduleResponseSchema = "helm.render.schedule.response.v1";

enum class ScheduleIntent {
  Visible,
  Prefetch,
  Revalidate
};

enum class EntryRole {
  Visible,
  Overscan,
  Neighbor,
  ZoomAdjacent,
  Prefetch
};

enum class StalePolicy {
  Strict,
  StaleWhileRevalidate,
  StaleOk
};

enum class EntryKind {
  Tile,
  ArtifactPacket,
  RenderModel
};

struct LonLat {
  double lon = 0;
  double lat = 0;
};

struct TileCoord {
  std::uint32_t z = 0;
  std::uint32_t x = 0;
  std::uint32_t y = 0;

  [[nodiscard]] bool operator<(const TileCoord& other) const {
    if (z != other.z) return z < other.z;
    if (x != other.x) return x < other.x;
    return y < other.y;
  }

  [[nodiscard]] bool operator==(const TileCoord& other) const {
    return z == other.z && x == other.x && y == other.y;
  }

  [[nodiscard]] bool operator!=(const TileCoord& other) const {
    return !(*this == other);
  }
};

struct VisibleViewport {
  std::string projection = "web_mercator_tile";
  std::uint32_t z = 0;
  LonLat center;
  std::optional<TileCoord> anchor_tile;
  std::uint32_t viewport_width_px = 0;
  std::uint32_t viewport_height_px = 0;
  double device_pixel_ratio = 1;
  double rotation_deg = 0;
};

struct OverscanPolicy {
  std::uint32_t margin_px = 16;
  std::uint32_t margin_tiles = 1;
};

struct NeighborPolicy {
  bool cardinal = true;
  bool diagonal = true;
  std::uint32_t ring_count = 1;
};

struct ZoomPolicy {
  std::vector<int> adjacent_offsets;
  bool include_children = true;
  bool include_parent = true;
};

struct RendererIdentity {
  std::string backend = "vulkan";
  std::string scene_schema = "helm.render.model.v1";
  std::string renderer_sha;
};

struct ScheduleRequest {
  std::string schema_version = kScheduleRequestSchema;
  std::string request_id;
  ScheduleIntent intent = ScheduleIntent::Visible;
  VisibleViewport visible;
  OverscanPolicy overscan;
  NeighborPolicy neighbor_policy;
  ZoomPolicy zoom_policy;
  std::string display_fingerprint;
  std::string source_epoch_hint;
  std::uint64_t client_epoch = 0;
  RendererIdentity renderer;
};

struct ScheduleEntry {
  std::string entry_id;
  EntryKind kind = EntryKind::Tile;
  EntryRole role = EntryRole::Visible;
  std::int32_t priority = 0;
  TileCoord tile;
  std::uint32_t overscan_px = 0;
  std::string cache_key;
  StalePolicy stale_policy = StalePolicy::Strict;
  double blend_weight = 1;
};

struct ScheduleTotals {
  std::uint32_t entries = 0;
  std::uint32_t visible = 0;
  std::uint32_t overscan = 0;
  std::uint32_t neighbor = 0;
  std::uint32_t zoom_adjacent = 0;
};

struct ScheduleDiagnostic {
  std::string severity;
  std::string code;
  std::string message;
};

struct ScheduleResponse {
  std::string schema_version = kScheduleResponseSchema;
  std::string request_id;
  std::string source_epoch;
  std::string cache_epoch;
  std::vector<ScheduleEntry> entries;
  ScheduleTotals totals;
  std::vector<ScheduleDiagnostic> diagnostics;
};

[[nodiscard]] inline const char* ScheduleIntentName(ScheduleIntent intent) {
  switch (intent) {
    case ScheduleIntent::Visible: return "visible";
    case ScheduleIntent::Prefetch: return "prefetch";
    case ScheduleIntent::Revalidate: return "revalidate";
  }
  return "unknown";
}

[[nodiscard]] inline const char* EntryRoleName(EntryRole role) {
  switch (role) {
    case EntryRole::Visible: return "visible";
    case EntryRole::Overscan: return "overscan";
    case EntryRole::Neighbor: return "neighbor";
    case EntryRole::ZoomAdjacent: return "zoom_adjacent";
    case EntryRole::Prefetch: return "prefetch";
  }
  return "unknown";
}

[[nodiscard]] inline const char* StalePolicyName(StalePolicy policy) {
  switch (policy) {
    case StalePolicy::Strict: return "strict";
    case StalePolicy::StaleWhileRevalidate: return "stale_while_revalidate";
    case StalePolicy::StaleOk: return "stale_ok";
  }
  return "unknown";
}

[[nodiscard]] inline bool EntryLess(const ScheduleEntry& lhs, const ScheduleEntry& rhs) {
  if (lhs.priority != rhs.priority) return lhs.priority < rhs.priority;
  if (lhs.tile != rhs.tile) return lhs.tile < rhs.tile;
  return lhs.entry_id < rhs.entry_id;
}

[[nodiscard]] inline bool HasBlankEdgeCoverage(const ScheduleResponse& response) {
  return response.totals.visible > 0 && response.totals.overscan > 0;
}

}  // namespace helm::schedule

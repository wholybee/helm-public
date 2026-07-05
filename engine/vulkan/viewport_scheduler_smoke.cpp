#include "viewport_scheduler.h"

#include <algorithm>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using helm::schedule::EntryRole;
using helm::schedule::EntryRoleName;
using helm::schedule::HasBlankEdgeCoverage;
using helm::schedule::ScheduleEntry;
using helm::schedule::ScheduleIntent;
using helm::schedule::ScheduleIntentName;
using helm::schedule::ScheduleRequest;
using helm::schedule::ScheduleResponse;
using helm::schedule::StalePolicy;
using helm::schedule::StalePolicyName;
using helm::schedule::TileCoord;
using helm::schedule::kScheduleRequestSchema;
using helm::schedule::kScheduleResponseSchema;

[[noreturn]] void fail(const std::string& message) {
  throw std::runtime_error(message);
}

void require(bool ok, const std::string& message) {
  if (!ok) fail(message);
}

ScheduleRequest sample_request() {
  ScheduleRequest request;
  request.schema_version = kScheduleRequestSchema;
  request.request_id = "smoke-visible-z12";
  request.intent = ScheduleIntent::Visible;
  request.visible.projection = "web_mercator_tile";
  request.visible.z = 12;
  request.visible.center = {-81.8, 24.5};
  request.visible.anchor_tile = TileCoord{12, 1120, 1756};
  request.visible.viewport_width_px = 256;
  request.visible.viewport_height_px = 256;
  request.visible.device_pixel_ratio = 1;
  request.overscan.margin_px = 16;
  request.overscan.margin_tiles = 1;
  request.neighbor_policy.ring_count = 1;
  request.zoom_policy.adjacent_offsets = {-1, 1};
  request.display_fingerprint = "day:standard:10:5:10:20:text:on:soundings:on";
  request.source_epoch_hint = "synthetic-chart-1@2026-06-28";
  request.client_epoch = 42;
  request.renderer.backend = "vulkan";
  request.renderer.scene_schema = "helm.render.model.v1";
  request.renderer.renderer_sha = "fixture-renderer-sha";
  return request;
}

ScheduleResponse sample_response(const ScheduleRequest& request) {
  ScheduleResponse response;
  response.schema_version = kScheduleResponseSchema;
  response.request_id = request.request_id;
  response.source_epoch = request.source_epoch_hint;
  response.cache_epoch = response.source_epoch + ":" + request.renderer.scene_schema + ":" +
                         request.display_fingerprint;

  ScheduleEntry visible;
  visible.entry_id = "tile.z12.x1120.y1756.visible";
  visible.role = EntryRole::Visible;
  visible.priority = 0;
  visible.tile = TileCoord{12, 1120, 1756};
  visible.overscan_px = request.overscan.margin_px;
  visible.cache_key =
      "display_fp=day:standard:10:5:10:20:text:on:soundings:on;"
      "overscan=16;renderer=vulkan;renderer_sha=fixture-renderer-sha;"
      "scene_schema=helm.render.model.v1;source_epoch=synthetic-chart-1@2026-06-28;"
      "x=1120;y=1756;z=12";
  visible.stale_policy = StalePolicy::Strict;
  visible.blend_weight = 1.0;
  response.entries.push_back(visible);

  ScheduleEntry overscan;
  overscan.entry_id = "tile.z12.x1119.y1756.overscan";
  overscan.role = EntryRole::Overscan;
  overscan.priority = 10;
  overscan.tile = TileCoord{12, 1119, 1756};
  overscan.overscan_px = request.overscan.margin_px;
  overscan.cache_key = visible.cache_key;
  overscan.stale_policy = StalePolicy::StaleWhileRevalidate;
  overscan.blend_weight = 1.0;
  response.entries.push_back(overscan);

  response.totals.entries = static_cast<std::uint32_t>(response.entries.size());
  response.totals.visible = 1;
  response.totals.overscan = 1;
  return response;
}

void validate_request(const ScheduleRequest& request) {
  require(request.schema_version == kScheduleRequestSchema, "request schema mismatch");
  require(!request.request_id.empty(), "request_id required");
  require(request.visible.z > 0, "visible zoom required");
  require(request.visible.viewport_width_px > 0, "viewport width required");
  require(request.visible.viewport_height_px > 0, "viewport height required");
  require(!request.display_fingerprint.empty(), "display_fingerprint required");
  require(!request.source_epoch_hint.empty(), "source_epoch_hint required");
  require(request.overscan.margin_px > 0, "overscan margin_px required");
}

void validate_response(const ScheduleResponse& response) {
  require(response.schema_version == kScheduleResponseSchema, "response schema mismatch");
  require(!response.source_epoch.empty(), "source_epoch required");
  require(!response.cache_epoch.empty(), "cache_epoch required");
  require(!response.entries.empty(), "entries required");
  require(HasBlankEdgeCoverage(response), "visible+overscan coverage required");

  std::vector<ScheduleEntry> sorted = response.entries;
  std::sort(sorted.begin(), sorted.end(), helm::schedule::EntryLess);
  for (std::size_t i = 0; i < response.entries.size(); ++i) {
    require(sorted[i].entry_id == response.entries[i].entry_id, "entries must be priority sorted");
  }

  for (const ScheduleEntry& entry : response.entries) {
    require(!entry.entry_id.empty(), "entry_id required");
    require(!entry.cache_key.empty(), "cache_key required");
    require(entry.blend_weight > 0 && entry.blend_weight <= 1.0, "blend_weight out of range");
    if (entry.role == EntryRole::Visible) {
      require(entry.stale_policy == StalePolicy::Strict, "visible entries must be strict");
    }
  }
}

}  // namespace

int main() {
  try {
    const ScheduleRequest request = sample_request();
    validate_request(request);
    const ScheduleResponse response = sample_response(request);
    validate_response(response);

    std::cout << "schema=" << response.schema_version << "\n";
    std::cout << "intent=" << ScheduleIntentName(request.intent) << "\n";
    std::cout << "entries=" << response.totals.entries << "\n";
    std::cout << "visible=" << response.totals.visible << "\n";
    std::cout << "overscan=" << response.totals.overscan << "\n";
    std::cout << "cache_epoch=" << response.cache_epoch << "\n";
    std::cout << "first_role=" << EntryRoleName(response.entries.front().role) << "\n";
    std::cout << "first_stale=" << StalePolicyName(response.entries.front().stale_policy) << "\n";
    std::cout << "ok\n";
    return 0;
  } catch (const std::exception& ex) {
    std::cerr << "viewport-scheduler-smoke failed: " << ex.what() << "\n";
    return 1;
  }
}

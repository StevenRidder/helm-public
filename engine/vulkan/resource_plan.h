#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace helm::vulkan {

enum class ResourceOwner {
  Atlas,
  Frame,
  CommandStream,
  Backend
};

struct AtlasRegion {
  std::string resource_id;
  std::string kind;
  std::string owner;
};

struct BufferReservation {
  std::string owner;
  std::uint32_t vertices = 0;
  std::uint32_t indices = 0;
  std::uint32_t instances = 0;
  std::uint32_t uniforms = 0;
};

struct BatchKey {
  std::string shader_family;
  std::string topology;
  std::string atlas_id;
  std::string material_id;
  std::string blend_mode;
  std::int32_t order_bucket = 0;

  [[nodiscard]] std::string stable_key() const;
};

struct DrawBatch {
  BatchKey key;
  BufferReservation reservation;
  std::vector<std::string> command_ids;
  std::vector<std::string> resource_ids;
};

struct PlanDiagnostic {
  std::string severity;
  std::string code;
  std::string command_id;
  std::string message;
};

struct RenderResourcePlan {
  std::string schema_version = "vulkan.vsg.resource_plan.v0";
  std::vector<AtlasRegion> atlas_regions;
  std::vector<DrawBatch> batches;
  std::vector<PlanDiagnostic> diagnostics;
};

RenderResourcePlan BuildResourcePlanFromSceneJson(const std::string& scene_json);

std::string RenderResourcePlanToJson(const RenderResourcePlan& plan);

bool ValidateResourcePlan(const RenderResourcePlan& plan,
                          std::string* error);

bool ValidateResourcePlanSmoke(const RenderResourcePlan& plan,
                               std::string* error);

}  // namespace helm::vulkan

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace helm::vulkan {

struct TextAnchor {
  double x = 0.0;
  double y = 0.0;
};

struct TextPlacementRecord {
  std::string command_id;
  std::string label_kind;
  std::string text;
  std::string object_class;
  std::string font_ref;
  std::string resource_key;
  TextAnchor anchor;
  std::uint32_t priority = 0;
  double rotation_deg = 0.0;
  std::vector<int> order_key;
  std::string collision_policy;
  std::string safety_class;
  std::uint32_t glyph_count = 0;
  std::uint32_t vertices = 0;
  std::uint32_t indices = 0;
};

struct TextPlacementResourceNeed {
  std::string resource_key;
  std::string font_ref;
  std::string owner;
  std::uint32_t label_count = 0;
  std::uint32_t glyph_count = 0;
  std::uint32_t vertices = 0;
  std::uint32_t indices = 0;
};

struct TextPlacementDiagnostic {
  std::string severity;
  std::string code;
  std::string command_id;
  std::string message;
};

struct TextPlacementPlan {
  std::string schema_version = "vulkan.text_placement_contract.v0";
  std::vector<TextPlacementRecord> placements;
  std::vector<TextPlacementResourceNeed> resource_needs;
  std::vector<TextPlacementDiagnostic> diagnostics;
};

TextPlacementPlan BuildTextPlacementPlanFromSceneJson(const std::string& scene_json);

std::string TextPlacementPlanToJson(const TextPlacementPlan& plan);

bool ValidateTextPlacementSmoke(const TextPlacementPlan& plan,
                                std::string* error);

}  // namespace helm::vulkan

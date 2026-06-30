#include "resource_plan.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iomanip>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <variant>

namespace helm::vulkan {
namespace {

struct Json;
using JsonArray = std::vector<Json>;
using JsonObject = std::map<std::string, Json>;

struct Json {
  using Storage = std::variant<std::nullptr_t, bool, double, std::string, JsonArray, JsonObject>;

  Storage value;

  [[nodiscard]] bool is_null() const { return std::holds_alternative<std::nullptr_t>(value); }

  [[nodiscard]] const JsonObject& object() const {
    if (!std::holds_alternative<JsonObject>(value)) throw std::runtime_error("expected JSON object");
    return std::get<JsonObject>(value);
  }

  [[nodiscard]] const JsonArray& array() const {
    if (!std::holds_alternative<JsonArray>(value)) throw std::runtime_error("expected JSON array");
    return std::get<JsonArray>(value);
  }

  [[nodiscard]] const std::string& string() const {
    if (!std::holds_alternative<std::string>(value)) throw std::runtime_error("expected JSON string");
    return std::get<std::string>(value);
  }

  [[nodiscard]] double number() const {
    if (!std::holds_alternative<double>(value)) throw std::runtime_error("expected JSON number");
    return std::get<double>(value);
  }

  [[nodiscard]] const Json* find(std::string_view key) const {
    const auto& obj = object();
    auto it = obj.find(std::string(key));
    return it == obj.end() ? nullptr : &it->second;
  }

  [[nodiscard]] const Json& at(std::string_view key) const {
    const Json* value = find(key);
    if (value == nullptr) throw std::runtime_error("missing JSON key: " + std::string(key));
    return *value;
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
    return std::runtime_error("JSON parse error at byte " + std::to_string(pos_) + ": " + std::string(message));
  }

  void skip_ws() {
    while (pos_ < text_.size() && std::isspace(static_cast<unsigned char>(text_[pos_]))) ++pos_;
  }

  char peek() {
    skip_ws();
    if (pos_ >= text_.size()) throw error("unexpected end of input");
    return text_[pos_];
  }

  bool consume(char ch) {
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

  Json parse_value() {
    char ch = peek();
    if (ch == '{') return Json{parse_object()};
    if (ch == '[') return Json{parse_array()};
    if (ch == '"') return Json{parse_string()};
    if (ch == 't') return parse_literal("true", Json{true});
    if (ch == 'f') return parse_literal("false", Json{false});
    if (ch == 'n') return parse_literal("null", Json{nullptr});
    if (ch == '-' || std::isdigit(static_cast<unsigned char>(ch))) return Json{parse_number()};
    throw error("unexpected value");
  }

  Json parse_literal(std::string_view literal, Json value) {
    if (text_.compare(pos_, literal.size(), literal) != 0) throw error("invalid literal");
    pos_ += literal.size();
    return value;
  }

  JsonObject parse_object() {
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

  JsonArray parse_array() {
    expect('[');
    JsonArray arr;
    if (consume(']')) return arr;
    while (true) {
      arr.push_back(parse_value());
      if (consume(']')) return arr;
      expect(',');
    }
  }

  std::string parse_string() {
    expect('"');
    std::string out;
    while (pos_ < text_.size()) {
      char ch = text_[pos_++];
      if (ch == '"') return out;
      if (ch != '\\') {
        out.push_back(ch);
        continue;
      }
      if (pos_ >= text_.size()) throw error("unterminated escape");
      char esc = text_[pos_++];
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
          throw error("unicode escapes are not supported in this fixture parser");
        default:
          throw error("invalid escape");
      }
    }
    throw error("unterminated string");
  }

  double parse_number() {
    skip_ws();
    const size_t start = pos_;
    if (text_[pos_] == '-') ++pos_;
    while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) ++pos_;
    if (pos_ < text_.size() && text_[pos_] == '.') {
      ++pos_;
      while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) ++pos_;
    }
    if (pos_ < text_.size() && (text_[pos_] == 'e' || text_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < text_.size() && (text_[pos_] == '+' || text_[pos_] == '-')) ++pos_;
      while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) ++pos_;
    }
    return std::stod(text_.substr(start, pos_ - start));
  }

  std::string text_;
  size_t pos_ = 0;
};

[[nodiscard]] std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

[[nodiscard]] std::optional<std::string> optional_string(const Json& obj, std::string_view key) {
  const Json* value = obj.find(key);
  if (value == nullptr || value->is_null()) return std::nullopt;
  return value->string();
}

[[nodiscard]] std::string string_or(const Json& obj, std::string_view key, std::string fallback) {
  std::optional<std::string> value = optional_string(obj, key);
  return value ? *value : std::move(fallback);
}

[[nodiscard]] std::uint32_t count_points(const Json* array_value) {
  if (array_value == nullptr || array_value->is_null()) return 0;
  return static_cast<std::uint32_t>(array_value->array().size());
}

[[nodiscard]] std::uint32_t count_ring_points(const Json* rings_value) {
  if (rings_value == nullptr || rings_value->is_null()) return 0;
  std::uint32_t total = 0;
  for (const Json& ring : rings_value->array()) {
    total += static_cast<std::uint32_t>(ring.array().size());
  }
  return total;
}

[[nodiscard]] std::uint32_t area_index_count(std::uint32_t vertices) {
  return vertices >= 3 ? (vertices - 2) * 3 : 0;
}

[[nodiscard]] int pass_rank(const std::string& type, bool pattern_fill) {
  if (type == "fill_area") return pattern_fill ? 1 : 0;
  if (type == "stroke_line") return 2;
  if (type == "place_symbol") return 3;
  if (type == "draw_text" || type == "draw_sounding") return 4;
  if (type == "draw_raster_sheet") return 5;
  return 9;
}

[[nodiscard]] std::string owner_label(ResourceOwner owner) {
  switch (owner) {
    case ResourceOwner::Atlas: return "atlas-owned";
    case ResourceOwner::Frame: return "frame-owned";
    case ResourceOwner::CommandStream: return "command-stream-owned";
    case ResourceOwner::Backend: return "backend-owned";
  }
  return "unknown";
}

struct CommandPlan {
  BatchKey key;
  BufferReservation reservation;
  std::vector<std::string> resources;
};

class ResourcePlanner {
 public:
  RenderResourcePlan build(const Json& scene) {
    collect_resources(scene);
    const JsonArray& groups = scene.at("command_groups").array();
    for (size_t group_index = 0; group_index < groups.size(); ++group_index) {
      const Json& group = groups[group_index];
      for (const Json& command : group.at("commands").array()) {
        plan_command(command, static_cast<int>(group_index));
      }
    }
    return std::move(plan_);
  }

 private:
  void collect_resources(const Json& scene) {
    const Json* table = scene.find("resource_table");
    if (table == nullptr || table->is_null()) return;
    collect_resource_array(*table, "symbols", "symbol");
    collect_resource_array(*table, "area_patterns", "pattern");
    collect_resource_array(*table, "line_styles", "line_style");
    collect_resource_array(*table, "fonts", "font");
    collect_resource_array(*table, "raster_textures", "raster_texture");
  }

  void collect_resource_array(const Json& table, std::string_view key, std::string kind) {
    const Json* array = table.find(key);
    if (array == nullptr || array->is_null()) return;
    for (const Json& record : array->array()) {
      std::optional<std::string> id = optional_string(record, "resource_id");
      if (!id) continue;
      resource_kind_[*id] = kind;
    }
  }

  bool require_resource(const std::string& command_id,
                        const std::string& resource_id,
                        std::string_view field_name,
                        bool required) {
    if (resource_id.empty()) {
      if (required) {
        plan_.diagnostics.push_back(PlanDiagnostic{
            "warning",
            "resource.missing",
            command_id,
            "command is missing required resource field " + std::string(field_name)});
      }
      return !required;
    }
    auto kind = resource_kind_.find(resource_id);
    if (kind == resource_kind_.end()) {
      plan_.diagnostics.push_back(PlanDiagnostic{
          "warning",
          "resource.missing",
          command_id,
          "command references missing resource " + resource_id});
      return false;
    }
    if (atlas_region_ids_.insert(resource_id).second) {
      plan_.atlas_regions.push_back(AtlasRegion{resource_id, kind->second, owner_label(ResourceOwner::Atlas)});
    }
    return true;
  }

  void plan_command(const Json& command, int group_index) {
    const std::string type = command.at("type").string();
    const std::string command_id = command.at("command_id").string();
    std::optional<CommandPlan> command_plan;

    if (type == "fill_area") {
      std::optional<std::string> pattern = optional_string(command, "pattern_ref");
      const bool pattern_fill = pattern && !pattern->empty();
      if (pattern_fill && !require_resource(command_id, *pattern, "pattern_ref", true)) return;
      std::uint32_t vertices = count_ring_points(command.find("rings"));
      CommandPlan out;
      out.key.shader_family = pattern_fill ? "PatternFill" : "AreaFill";
      out.key.topology = "triangles";
      out.key.atlas_id = pattern_fill ? *pattern : "";
      out.key.material_id = pattern_fill ? *pattern : string_or(command, "command_id", "solid-area");
      out.key.blend_mode = "opaque";
      out.key.order_bucket = group_index * 100 + pass_rank(type, pattern_fill);
      out.reservation = BufferReservation{owner_label(ResourceOwner::CommandStream), vertices, area_index_count(vertices), 0, 1};
      if (pattern_fill) out.resources.push_back(*pattern);
      command_plan = std::move(out);
    } else if (type == "stroke_line") {
      std::string line_style = string_or(command, "line_style_ref", "");
      if (!require_resource(command_id, line_style, "line_style_ref", false)) return;
      std::uint32_t points = count_points(command.find("polyline"));
      CommandPlan out;
      out.key.shader_family = "LineStyle";
      out.key.topology = "line_strip";
      out.key.atlas_id = line_style;
      out.key.material_id = line_style.empty() ? command_id : line_style;
      out.key.blend_mode = "alpha";
      out.key.order_bucket = group_index * 100 + pass_rank(type, false);
      out.reservation = BufferReservation{owner_label(ResourceOwner::CommandStream), points, points > 1 ? points - 1 : 0, 0, 1};
      if (!line_style.empty()) out.resources.push_back(line_style);
      command_plan = std::move(out);
    } else if (type == "place_symbol") {
      std::string symbol = string_or(command, "symbol_ref", "");
      if (!require_resource(command_id, symbol, "symbol_ref", true)) return;
      CommandPlan out;
      out.key.shader_family = "SymbolInstanced";
      out.key.topology = "triangles";
      out.key.atlas_id = symbol;
      out.key.material_id = symbol;
      out.key.blend_mode = "alpha";
      out.key.order_bucket = group_index * 100 + pass_rank(type, false);
      out.reservation = BufferReservation{owner_label(ResourceOwner::Frame), 4, 6, 1, 1};
      out.resources.push_back(symbol);
      command_plan = std::move(out);
    } else if (type == "draw_text" || type == "draw_sounding") {
      std::string font = string_or(command, "font_ref", "");
      if (!require_resource(command_id, font, "font_ref", false)) return;
      CommandPlan out;
      out.key.shader_family = "TextPlaceholder";
      out.key.topology = "triangles";
      out.key.atlas_id = font;
      out.key.material_id = font.empty() ? "dynamic-text" : font;
      out.key.blend_mode = "alpha";
      out.key.order_bucket = group_index * 100 + pass_rank(type, false);
      out.reservation = BufferReservation{owner_label(ResourceOwner::Frame), 4, 6, 1, 1};
      if (!font.empty()) out.resources.push_back(font);
      command_plan = std::move(out);
    } else if (type == "draw_raster_sheet") {
      std::string texture = string_or(command, "texture_ref", "");
      if (!require_resource(command_id, texture, "texture_ref", false)) return;
      CommandPlan out;
      out.key.shader_family = "RasterSheet";
      out.key.topology = "triangles";
      out.key.atlas_id = texture;
      out.key.material_id = texture.empty() ? command_id : texture;
      out.key.blend_mode = "opaque";
      out.key.order_bucket = group_index * 100 + pass_rank(type, false);
      out.reservation = BufferReservation{owner_label(ResourceOwner::Backend), 4, 6, 0, 1};
      if (!texture.empty()) out.resources.push_back(texture);
      command_plan = std::move(out);
    } else {
      plan_.diagnostics.push_back(PlanDiagnostic{
          "warning",
          "command.unsupported",
          command_id,
          "no VSG resource plan mapping for command type " + type});
      return;
    }

    add_to_batch(command_id, *command_plan);
  }

  void add_to_batch(const std::string& command_id, const CommandPlan& command_plan) {
    const std::string key = command_plan.key.stable_key();
    if (plan_.batches.empty() || plan_.batches.back().key.stable_key() != key) {
      DrawBatch batch;
      batch.key = command_plan.key;
      batch.reservation = command_plan.reservation;
      batch.command_ids.push_back(command_id);
      batch.resource_ids = command_plan.resources;
      plan_.batches.push_back(std::move(batch));
      return;
    }

    DrawBatch& batch = plan_.batches.back();
    batch.command_ids.push_back(command_id);
    batch.reservation.vertices += command_plan.reservation.vertices;
    batch.reservation.indices += command_plan.reservation.indices;
    batch.reservation.instances += command_plan.reservation.instances;
    batch.reservation.uniforms += command_plan.reservation.uniforms;
    for (const std::string& resource : command_plan.resources) {
      if (std::find(batch.resource_ids.begin(), batch.resource_ids.end(), resource) == batch.resource_ids.end()) {
        batch.resource_ids.push_back(resource);
      }
    }
  }

  RenderResourcePlan plan_;
  std::map<std::string, std::string> resource_kind_;
  std::set<std::string> atlas_region_ids_;
};

void write_string_array(std::ostream& out, const std::vector<std::string>& values) {
  out << "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out << ",";
    out << "\"" << json_escape(values[i]) << "\"";
  }
  out << "]";
}

}  // namespace

std::string BatchKey::stable_key() const {
  return std::to_string(order_bucket) + "|" + shader_family + "|" + topology + "|" + atlas_id + "|" +
         material_id + "|" + blend_mode;
}

RenderResourcePlan BuildResourcePlanFromSceneJson(const std::string& scene_json) {
  Json scene = JsonParser(scene_json).parse();
  return ResourcePlanner().build(scene);
}

std::string RenderResourcePlanToJson(const RenderResourcePlan& plan) {
  std::ostringstream out;
  out << "{\n";
  out << "  \"schema_version\": \"" << json_escape(plan.schema_version) << "\",\n";
  out << "  \"atlas_regions\": [\n";
  for (size_t i = 0; i < plan.atlas_regions.size(); ++i) {
    const AtlasRegion& region = plan.atlas_regions[i];
    out << "    {\"resource_id\":\"" << json_escape(region.resource_id)
        << "\",\"kind\":\"" << json_escape(region.kind)
        << "\",\"owner\":\"" << json_escape(region.owner) << "\"}";
    out << (i + 1 == plan.atlas_regions.size() ? "\n" : ",\n");
  }
  out << "  ],\n";
  out << "  \"batches\": [\n";
  for (size_t i = 0; i < plan.batches.size(); ++i) {
    const DrawBatch& batch = plan.batches[i];
    out << "    {\"key\":\"" << json_escape(batch.key.stable_key())
        << "\",\"shader_family\":\"" << json_escape(batch.key.shader_family)
        << "\",\"topology\":\"" << json_escape(batch.key.topology)
        << "\",\"atlas_id\":\"" << json_escape(batch.key.atlas_id)
        << "\",\"material_id\":\"" << json_escape(batch.key.material_id)
        << "\",\"blend_mode\":\"" << json_escape(batch.key.blend_mode)
        << "\",\"order_bucket\":" << batch.key.order_bucket
        << ",\"reservation\":{\"owner\":\"" << json_escape(batch.reservation.owner)
        << "\",\"vertices\":" << batch.reservation.vertices
        << ",\"indices\":" << batch.reservation.indices
        << ",\"instances\":" << batch.reservation.instances
        << ",\"uniforms\":" << batch.reservation.uniforms << "}"
        << ",\"command_ids\":";
    write_string_array(out, batch.command_ids);
    out << ",\"resource_ids\":";
    write_string_array(out, batch.resource_ids);
    out << "}";
    out << (i + 1 == plan.batches.size() ? "\n" : ",\n");
  }
  out << "  ],\n";
  out << "  \"diagnostics\": [\n";
  for (size_t i = 0; i < plan.diagnostics.size(); ++i) {
    const PlanDiagnostic& diagnostic = plan.diagnostics[i];
    out << "    {\"severity\":\"" << json_escape(diagnostic.severity)
        << "\",\"code\":\"" << json_escape(diagnostic.code)
        << "\",\"command_id\":\"" << json_escape(diagnostic.command_id)
        << "\",\"message\":\"" << json_escape(diagnostic.message) << "\"}";
    out << (i + 1 == plan.diagnostics.size() ? "\n" : ",\n");
  }
  out << "  ]\n";
  out << "}\n";
  return out.str();
}

bool ValidateResourcePlan(const RenderResourcePlan& plan, std::string* error) {
  for (const AtlasRegion& region : plan.atlas_regions) {
    if (region.resource_id.empty()) {
      if (error) *error = "atlas/resource region has an empty resource_id";
      return false;
    }
    if (region.kind.empty()) {
      if (error) *error = "atlas/resource region " + region.resource_id + " has an empty kind";
      return false;
    }
  }

  for (const DrawBatch& batch : plan.batches) {
    if (batch.command_ids.empty()) {
      if (error) *error = "batch " + batch.key.stable_key() + " has no command ids";
      return false;
    }
    for (const std::string& resource_id : batch.resource_ids) {
      if (resource_id.empty()) {
        if (error) *error = "batch " + batch.key.stable_key() + " has an empty resource id";
        return false;
      }
    }
  }

  return true;
}

bool ValidateResourcePlanSmoke(const RenderResourcePlan& plan, std::string* error) {
  if (!ValidateResourcePlan(plan, error)) return false;
  if (plan.batches.size() != 6) {
    if (error) *error = "expected 6 batches, got " + std::to_string(plan.batches.size());
    return false;
  }
  if (plan.atlas_regions.size() != 4) {
    if (error) *error = "expected 4 unique atlas/resource regions, got " + std::to_string(plan.atlas_regions.size());
    return false;
  }
  bool saw_symbol_batch = false;
  bool saw_pattern_batch = false;
  bool saw_line_batch = false;
  bool saw_text_batch = false;
  bool saw_area_batch = false;
  int symbol_batches = 0;
  int symbol_instances = 0;
  for (const DrawBatch& batch : plan.batches) {
    if (batch.key.shader_family == "SymbolInstanced") {
      saw_symbol_batch = true;
      ++symbol_batches;
      symbol_instances += batch.reservation.instances;
      if (symbol_batches == 1 &&
          (batch.command_ids.size() != 2 || batch.reservation.instances != 2)) {
        if (error) *error = "expected repeated symbols to share one instanced batch";
        return false;
      }
      if (symbol_batches == 2 &&
          (batch.command_ids.size() != 1 || batch.reservation.instances != 1)) {
        if (error) *error = "expected non-contiguous symbol to stay in draw order";
        return false;
      }
    } else if (batch.key.shader_family == "PatternFill") {
      saw_pattern_batch = true;
    } else if (batch.key.shader_family == "LineStyle") {
      saw_line_batch = true;
    } else if (batch.key.shader_family == "TextPlaceholder") {
      saw_text_batch = true;
      if (batch.command_ids.size() != 2) {
        if (error) *error = "expected text and sounding placeholders to share font batch";
        return false;
      }
    } else if (batch.key.shader_family == "AreaFill") {
      saw_area_batch = true;
    }
  }
  if (!saw_symbol_batch || !saw_pattern_batch || !saw_line_batch || !saw_text_batch || !saw_area_batch) {
    if (error) *error = "missing one or more required shader families";
    return false;
  }
  if (symbol_batches != 2 || symbol_instances != 3) {
    if (error) *error = "expected two ordered symbol batches with three total instances";
    return false;
  }
  bool saw_missing_resource = false;
  for (const PlanDiagnostic& diagnostic : plan.diagnostics) {
    if (diagnostic.code == "resource.missing") saw_missing_resource = true;
  }
  if (!saw_missing_resource) {
    if (error) *error = "expected missing resource diagnostic";
    return false;
  }
  return true;
}

}  // namespace helm::vulkan

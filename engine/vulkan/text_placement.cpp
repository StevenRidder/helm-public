#include "text_placement.h"

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

  [[nodiscard]] bool boolean() const {
    if (!std::holds_alternative<bool>(value)) throw std::runtime_error("expected JSON boolean");
    return std::get<bool>(value);
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

[[nodiscard]] std::string number_to_json(double value) {
  if (!std::isfinite(value)) throw std::runtime_error("cannot serialize non-finite number");
  std::ostringstream out;
  out << std::fixed << std::setprecision(3) << value;
  std::string text = out.str();
  while (text.size() > 1 && text.back() == '0') text.pop_back();
  if (!text.empty() && text.back() == '.') text.pop_back();
  return text.empty() ? "0" : text;
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

[[nodiscard]] std::optional<bool> optional_bool(const Json& obj, std::string_view key) {
  const Json* value = obj.find(key);
  if (value == nullptr || value->is_null()) return std::nullopt;
  return value->boolean();
}

[[nodiscard]] bool bool_or(const Json* obj, std::string_view key, bool fallback) {
  if (obj == nullptr || obj->is_null()) return fallback;
  std::optional<bool> value = optional_bool(*obj, key);
  return value ? *value : fallback;
}

[[nodiscard]] std::uint32_t uint_or(const Json* obj, std::string_view key, std::uint32_t fallback) {
  if (obj == nullptr || obj->is_null()) return fallback;
  const Json* value = obj->find(key);
  if (value == nullptr || value->is_null()) return fallback;
  double number = value->number();
  if (number < 0) return fallback;
  return static_cast<std::uint32_t>(number);
}

[[nodiscard]] double double_or(const Json* obj, std::string_view key, double fallback) {
  if (obj == nullptr || obj->is_null()) return fallback;
  const Json* value = obj->find(key);
  if (value == nullptr || value->is_null()) return fallback;
  return value->number();
}

[[nodiscard]] std::string nested_string_or(const Json* obj,
                                           std::string_view key,
                                           const std::string& fallback) {
  if (obj == nullptr || obj->is_null()) return fallback;
  return string_or(*obj, key, fallback);
}

[[nodiscard]] TextAnchor parse_anchor(const Json& command) {
  const Json* position = command.find("position");
  if (position == nullptr || position->is_null()) return TextAnchor{};
  const JsonArray& values = position->array();
  if (values.size() < 2) return TextAnchor{};
  return TextAnchor{values[0].number(), values[1].number()};
}

[[nodiscard]] std::vector<int> parse_order_key(const Json* semantics, int group_index, int command_index) {
  const Json* order = semantics == nullptr || semantics->is_null() ? nullptr : semantics->find("order_key");
  if (order == nullptr || order->is_null()) return {group_index, command_index};
  std::vector<int> out;
  for (const Json& value : order->array()) {
    out.push_back(static_cast<int>(value.number()));
  }
  return out.empty() ? std::vector<int>{group_index, command_index} : out;
}

[[nodiscard]] std::uint32_t count_utf8_codepoints(const std::string& text) {
  std::uint32_t count = 0;
  for (unsigned char ch : text) {
    if ((ch & 0xC0U) != 0x80U) ++count;
  }
  return count;
}

[[nodiscard]] std::string default_collision_policy(const std::string& label_kind) {
  if (label_kind == "sounding") return "sounding-grid";
  if (label_kind == "light_label") return "light-description";
  return "declutter-box";
}

[[nodiscard]] bool order_key_less(const TextPlacementRecord& lhs, const TextPlacementRecord& rhs) {
  return std::lexicographical_compare(lhs.order_key.begin(), lhs.order_key.end(),
                                      rhs.order_key.begin(), rhs.order_key.end()) ||
         (lhs.order_key == rhs.order_key && lhs.command_id < rhs.command_id);
}

void write_int_array(std::ostream& out, const std::vector<int>& values) {
  out << "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out << ",";
    out << values[i];
  }
  out << "]";
}

class TextPlacementPlanner {
 public:
  TextPlacementPlan build(const Json& scene) {
    collect_fonts(scene);
    const JsonArray& groups = scene.at("command_groups").array();
    for (size_t group_index = 0; group_index < groups.size(); ++group_index) {
      const Json& group = groups[group_index];
      const JsonArray& commands = group.at("commands").array();
      for (size_t command_index = 0; command_index < commands.size(); ++command_index) {
        plan_command(commands[command_index], static_cast<int>(group_index), static_cast<int>(command_index));
      }
    }

    std::sort(plan_.placements.begin(), plan_.placements.end(), order_key_less);
    for (const auto& entry : resource_needs_by_key_) {
      plan_.resource_needs.push_back(entry.second);
    }
    return std::move(plan_);
  }

 private:
  void collect_fonts(const Json& scene) {
    const Json* table = scene.find("resource_table");
    if (table == nullptr || table->is_null()) return;
    const Json* fonts = table->find("fonts");
    if (fonts == nullptr || fonts->is_null()) return;
    for (const Json& record : fonts->array()) {
      std::optional<std::string> id = optional_string(record, "resource_id");
      if (id) font_ids_.insert(*id);
    }
  }

  void add_diagnostic(std::string severity,
                      std::string code,
                      const std::string& command_id,
                      std::string message) {
    plan_.diagnostics.push_back(TextPlacementDiagnostic{
        std::move(severity),
        std::move(code),
        command_id,
        std::move(message)});
  }

  void plan_command(const Json& command, int group_index, int command_index) {
    const std::string type = command.at("type").string();
    const std::string command_id = command.at("command_id").string();
    if (type != "draw_text" && type != "draw_sounding") return;

    const Json* placement = command.find("placement");
    const Json* semantics = command.find("s52_semantics");

    if (!bool_or(placement, "visible", true) || !bool_or(semantics, "visible", true)) {
      const std::string reason = nested_string_or(placement, "cull_reason", "visibility");
      add_diagnostic("info", "placement.culled", command_id,
                     "text command culled by semantic visibility gate: " + reason);
      return;
    }

    if (bool_or(placement, "requires_shaping", false)) {
      const std::string reason = nested_string_or(placement, "defer_reason", "complex_shaping");
      add_diagnostic("warning", "placement.deferred.shaping", command_id,
                     "text command deferred; shaping/ligature placement is outside SYM-4: " + reason);
      return;
    }

    const std::string font_ref = string_or(command, "font_ref", "");
    if (font_ref.empty() || font_ids_.find(font_ref) == font_ids_.end()) {
      add_diagnostic("warning", "resource.missing_font", command_id,
                     font_ref.empty() ? "text command has no font_ref"
                                      : "text command references missing font " + font_ref);
      return;
    }

    TextPlacementRecord record;
    record.command_id = command_id;
    record.label_kind = nested_string_or(placement, "label_kind", type == "draw_sounding" ? "sounding" : "text");
    record.text = type == "draw_sounding" ? string_or(command, "formatted_text", "") : string_or(command, "text", "");
    record.object_class = nested_string_or(semantics, "object_class", string_or(command, "object_class", ""));
    record.font_ref = font_ref;
    record.resource_key = "glyphs:" + font_ref;
    record.anchor = parse_anchor(command);
    record.priority = uint_or(placement, "priority", uint_or(&command, "priority", 0));
    record.rotation_deg = double_or(placement, "rotation_deg", double_or(&command, "rotation_deg", 0.0));
    record.order_key = parse_order_key(semantics, group_index, command_index);
    record.collision_policy = nested_string_or(placement, "collision_policy", default_collision_policy(record.label_kind));
    record.safety_class = nested_string_or(placement, "safety_class", nested_string_or(semantics, "safety_class", ""));
    record.glyph_count = count_utf8_codepoints(record.text);
    record.vertices = 4;
    record.indices = 6;

    TextPlacementResourceNeed& need = resource_needs_by_key_[record.resource_key];
    if (need.resource_key.empty()) {
      need.resource_key = record.resource_key;
      need.font_ref = record.font_ref;
      need.owner = "frame-owned";
    }
    need.label_count += 1;
    need.glyph_count += record.glyph_count;
    need.vertices += record.vertices;
    need.indices += record.indices;

    plan_.placements.push_back(std::move(record));
  }

  TextPlacementPlan plan_;
  std::set<std::string> font_ids_;
  std::map<std::string, TextPlacementResourceNeed> resource_needs_by_key_;
};

}  // namespace

TextPlacementPlan BuildTextPlacementPlanFromSceneJson(const std::string& scene_json) {
  Json scene = JsonParser(scene_json).parse();
  return TextPlacementPlanner().build(scene);
}

std::string TextPlacementPlanToJson(const TextPlacementPlan& plan) {
  std::ostringstream out;
  out << "{\n";
  out << "  \"schema_version\": \"" << json_escape(plan.schema_version) << "\",\n";
  out << "  \"placements\": [\n";
  for (size_t i = 0; i < plan.placements.size(); ++i) {
    const TextPlacementRecord& placement = plan.placements[i];
    out << "    {\"command_id\":\"" << json_escape(placement.command_id)
        << "\",\"label_kind\":\"" << json_escape(placement.label_kind)
        << "\",\"text\":\"" << json_escape(placement.text)
        << "\",\"object_class\":\"" << json_escape(placement.object_class)
        << "\",\"font_ref\":\"" << json_escape(placement.font_ref)
        << "\",\"resource_key\":\"" << json_escape(placement.resource_key)
        << "\",\"anchor\":{\"x\":" << number_to_json(placement.anchor.x)
        << ",\"y\":" << number_to_json(placement.anchor.y) << "}"
        << ",\"priority\":" << placement.priority
        << ",\"rotation_deg\":" << number_to_json(placement.rotation_deg)
        << ",\"order_key\":";
    write_int_array(out, placement.order_key);
    out << ",\"collision_policy\":\"" << json_escape(placement.collision_policy)
        << "\",\"safety_class\":\"" << json_escape(placement.safety_class)
        << "\",\"reservation\":{\"glyphs\":" << placement.glyph_count
        << ",\"vertices\":" << placement.vertices
        << ",\"indices\":" << placement.indices << "}}";
    out << (i + 1 == plan.placements.size() ? "\n" : ",\n");
  }
  out << "  ],\n";
  out << "  \"resource_needs\": [\n";
  for (size_t i = 0; i < plan.resource_needs.size(); ++i) {
    const TextPlacementResourceNeed& need = plan.resource_needs[i];
    out << "    {\"resource_key\":\"" << json_escape(need.resource_key)
        << "\",\"font_ref\":\"" << json_escape(need.font_ref)
        << "\",\"owner\":\"" << json_escape(need.owner)
        << "\",\"label_count\":" << need.label_count
        << ",\"glyph_count\":" << need.glyph_count
        << ",\"vertices\":" << need.vertices
        << ",\"indices\":" << need.indices << "}";
    out << (i + 1 == plan.resource_needs.size() ? "\n" : ",\n");
  }
  out << "  ],\n";
  out << "  \"diagnostics\": [\n";
  for (size_t i = 0; i < plan.diagnostics.size(); ++i) {
    const TextPlacementDiagnostic& diagnostic = plan.diagnostics[i];
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

bool ValidateTextPlacementSmoke(const TextPlacementPlan& plan, std::string* error) {
  if (plan.placements.size() != 3) {
    if (error) *error = "expected 3 placed text records, got " + std::to_string(plan.placements.size());
    return false;
  }
  if (plan.resource_needs.size() != 1) {
    if (error) *error = "expected one shared glyph resource need, got " + std::to_string(plan.resource_needs.size());
    return false;
  }

  bool saw_text = false;
  bool saw_sounding = false;
  bool saw_light = false;
  for (const TextPlacementRecord& placement : plan.placements) {
    if (placement.label_kind == "text" && placement.command_id == "cmd.text.harbor") saw_text = true;
    if (placement.label_kind == "sounding" && placement.command_id == "cmd.sounding.shoal") saw_sounding = true;
    if (placement.label_kind == "light_label" && placement.command_id == "cmd.light.label") saw_light = true;
  }
  if (!saw_text || !saw_sounding || !saw_light) {
    if (error) *error = "expected normal label, sounding, and light label placements";
    return false;
  }

  const TextPlacementResourceNeed& need = plan.resource_needs.front();
  if (need.resource_key != "glyphs:font.chart-label" || need.owner != "frame-owned" ||
      need.label_count != 3 || need.glyph_count != 24 || need.vertices != 12 || need.indices != 18) {
    if (error) *error = "unexpected glyph resource reservation totals";
    return false;
  }

  bool saw_culled = false;
  bool saw_deferred = false;
  for (const TextPlacementDiagnostic& diagnostic : plan.diagnostics) {
    if (diagnostic.code == "placement.culled") saw_culled = true;
    if (diagnostic.code == "placement.deferred.shaping") saw_deferred = true;
  }
  if (!saw_culled || !saw_deferred) {
    if (error) *error = "expected culled and deferred shaping diagnostics";
    return false;
  }
  return true;
}

}  // namespace helm::vulkan

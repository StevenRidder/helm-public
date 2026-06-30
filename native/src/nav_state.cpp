#include "helm/native/nav_state.hpp"

#include <stdexcept>

namespace helm::native_core {
namespace {

[[nodiscard]] std::runtime_error kind_error(const char* wanted) {
  return std::runtime_error(std::string("helm_native_core: value is not ") + wanted);
}

}  // namespace

Value::Value() = default;
Value::Value(std::nullptr_t) : kind_(Kind::Null) {}
Value::Value(bool value) : kind_(Kind::Bool), bool_(value) {}
Value::Value(double value) : kind_(Kind::Number), number_(value) {}
Value::Value(int value) : kind_(Kind::Number), number_(static_cast<double>(value)) {}
Value::Value(std::string value) : kind_(Kind::String), string_(std::move(value)) {}
Value::Value(const char* value) : Value(std::string(value == nullptr ? "" : value)) {}
Value::Value(Object value) : kind_(Kind::Object), object_(std::move(value)) {}
Value::Value(Array value) : kind_(Kind::Array), array_(std::move(value)) {}

const Value::Object& Value::object() const {
  if (!is_object()) throw kind_error("an object");
  return object_;
}

Value::Object& Value::object() {
  if (!is_object()) throw kind_error("an object");
  return object_;
}

const Value::Array& Value::array() const {
  if (!is_array()) throw kind_error("an array");
  return array_;
}

const std::string& Value::string() const {
  if (!is_string()) throw kind_error("a string");
  return string_;
}

double Value::number() const {
  if (!is_number()) throw kind_error("a number");
  return number_;
}

bool Value::boolean() const {
  if (!is_bool()) throw kind_error("a bool");
  return bool_;
}

bool Value::operator==(const Value& other) const {
  if (kind_ != other.kind_) return false;
  switch (kind_) {
    case Kind::Null:
      return true;
    case Kind::Bool:
      return bool_ == other.bool_;
    case Kind::Number:
      return number_ == other.number_;
    case Kind::String:
      return string_ == other.string_;
    case Kind::Object:
      return object_ == other.object_;
    case Kind::Array:
      return array_ == other.array_;
  }
  return false;
}

State merge_state(const State& base, const State& patch) {
  State out = base;
  for (const auto& [key, patch_value] : patch) {
    const auto existing = out.find(key);
    if (existing != out.end() && existing->second.is_object() && patch_value.is_object()) {
      State nested = existing->second.object();
      for (const auto& [nested_key, nested_value] : patch_value.object()) {
        nested[nested_key] = nested_value;
      }
      out[key] = Value(std::move(nested));
    } else {
      out[key] = patch_value;
    }
  }
  return out;
}

ConnectionPhase classify_age(std::optional<std::chrono::milliseconds> age) {
  if (!age.has_value()) return ConnectionPhase::Offline;
  if (*age < std::chrono::seconds(3)) return ConnectionPhase::Live;
  if (*age < std::chrono::seconds(10)) return ConnectionPhase::Lagging;
  return ConnectionPhase::Stale;
}

const char* to_string(ConnectionPhase phase) noexcept {
  switch (phase) {
    case ConnectionPhase::Offline:
      return "offline";
    case ConnectionPhase::Live:
      return "live";
    case ConnectionPhase::Lagging:
      return "lagging";
    case ConnectionPhase::Stale:
      return "stale";
  }
  return "unknown";
}

const char* to_string(ApplyStatus status) noexcept {
  switch (status) {
    case ApplyStatus::Applied:
      return "applied";
    case ApplyStatus::Ignored:
      return "ignored";
    case ApplyStatus::NeedsSnapshot:
      return "needs_snapshot";
    case ApplyStatus::NonNavFrame:
      return "non_nav_frame";
  }
  return "unknown";
}

ApplyResult NavReducer::apply(const Frame& frame) {
  switch (frame.type) {
    case FrameType::Snapshot:
    case FrameType::LegacyFull:
      state_ = merge_state(State{}, frame.payload);
      has_baseline_ = true;
      if (frame.seq.has_value()) last_seq_ = *frame.seq;
      last_frame_at_ = std::chrono::steady_clock::now();
      return {ApplyStatus::Applied, ""};

    case FrameType::Delta:
      if (!has_baseline_) {
        if (frame.seq.has_value()) last_seq_ = *frame.seq;
        return {ApplyStatus::NeedsSnapshot, "delta arrived before any snapshot baseline"};
      }
      state_ = merge_state(state_, frame.payload);
      if (frame.seq.has_value()) last_seq_ = *frame.seq;
      last_frame_at_ = std::chrono::steady_clock::now();
      return {ApplyStatus::Applied, ""};

    case FrameType::Ping:
      if (frame.seq.has_value()) last_seq_ = *frame.seq;
      last_frame_at_ = std::chrono::steady_clock::now();
      return {ApplyStatus::Ignored, "ping"};

    case FrameType::Alarm:
    case FrameType::AlarmClear:
      return {ApplyStatus::NonNavFrame, "alarm frames use the reliable alarm path"};

    case FrameType::Unknown:
      return {ApplyStatus::Ignored, "unknown frame type"};
  }
  return {ApplyStatus::Ignored, "unhandled frame type"};
}

void NavReducer::reset() {
  state_.clear();
  last_seq_ = 0;
  has_baseline_ = false;
  last_frame_at_.reset();
}

ConnectionPhase NavReducer::classify(std::chrono::steady_clock::time_point now) const {
  if (!last_frame_at_.has_value()) return ConnectionPhase::Offline;
  return classify_age(std::chrono::duration_cast<std::chrono::milliseconds>(now - *last_frame_at_));
}

}  // namespace helm::native_core


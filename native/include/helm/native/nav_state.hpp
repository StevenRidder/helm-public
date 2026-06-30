#pragma once

#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace helm::native_core {

class Value {
public:
  enum class Kind {
    Null,
    Bool,
    Number,
    String,
    Object,
    Array,
  };

  using Object = std::map<std::string, Value>;
  using Array = std::vector<Value>;

  Value();
  Value(std::nullptr_t);
  Value(bool value);
  Value(double value);
  Value(int value);
  Value(std::string value);
  Value(const char* value);
  Value(Object value);
  Value(Array value);

  [[nodiscard]] Kind kind() const noexcept { return kind_; }
  [[nodiscard]] bool is_object() const noexcept { return kind_ == Kind::Object; }
  [[nodiscard]] bool is_array() const noexcept { return kind_ == Kind::Array; }
  [[nodiscard]] bool is_string() const noexcept { return kind_ == Kind::String; }
  [[nodiscard]] bool is_number() const noexcept { return kind_ == Kind::Number; }
  [[nodiscard]] bool is_bool() const noexcept { return kind_ == Kind::Bool; }
  [[nodiscard]] bool is_null() const noexcept { return kind_ == Kind::Null; }

  [[nodiscard]] const Object& object() const;
  [[nodiscard]] Object& object();
  [[nodiscard]] const Array& array() const;
  [[nodiscard]] const std::string& string() const;
  [[nodiscard]] double number() const;
  [[nodiscard]] bool boolean() const;

  [[nodiscard]] bool operator==(const Value& other) const;
  [[nodiscard]] bool operator!=(const Value& other) const { return !(*this == other); }

private:
  Kind kind_{Kind::Null};
  bool bool_{false};
  double number_{0.0};
  std::string string_;
  Object object_;
  Array array_;
};

using State = Value::Object;

enum class FrameType {
  Snapshot,
  Delta,
  LegacyFull,
  Ping,
  Alarm,
  AlarmClear,
  Unknown,
};

struct Frame {
  FrameType type{FrameType::Unknown};
  std::optional<std::uint64_t> seq;
  State payload;
};

enum class ApplyStatus {
  Applied,
  Ignored,
  NeedsSnapshot,
  NonNavFrame,
};

struct ApplyResult {
  ApplyStatus status{ApplyStatus::Ignored};
  std::string reason;
};

enum class ConnectionPhase {
  Offline,
  Live,
  Lagging,
  Stale,
};

struct EndpointTrust {
  std::string host;
  std::uint16_t port{0};
  std::string token;
  std::string certificate_fingerprint_sha256;

  [[nodiscard]] bool is_paired() const noexcept {
    return !host.empty() && port != 0 && !token.empty() &&
           !certificate_fingerprint_sha256.empty();
  }
};

struct HelloResume {
  std::uint64_t last_seq{0};
};

[[nodiscard]] State merge_state(const State& base, const State& patch);
[[nodiscard]] ConnectionPhase classify_age(std::optional<std::chrono::milliseconds> age);
[[nodiscard]] const char* to_string(ConnectionPhase phase) noexcept;
[[nodiscard]] const char* to_string(ApplyStatus status) noexcept;

class NavReducer {
public:
  ApplyResult apply(const Frame& frame);
  void reset();

  [[nodiscard]] const State& state() const noexcept { return state_; }
  [[nodiscard]] std::uint64_t last_seq() const noexcept { return last_seq_; }
  [[nodiscard]] bool has_baseline() const noexcept { return has_baseline_; }
  [[nodiscard]] std::optional<std::chrono::steady_clock::time_point> last_frame_at() const {
    return last_frame_at_;
  }
  [[nodiscard]] HelloResume hello_resume() const noexcept { return HelloResume{last_seq_}; }

  [[nodiscard]] ConnectionPhase classify(std::chrono::steady_clock::time_point now) const;

private:
  State state_;
  std::uint64_t last_seq_{0};
  bool has_baseline_{false};
  std::optional<std::chrono::steady_clock::time_point> last_frame_at_;
};

}  // namespace helm::native_core


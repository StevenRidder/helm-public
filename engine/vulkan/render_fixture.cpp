// Minimal command-stream fixture renderer for the Vulkan/VSG POC.
//
// This is a C++17 dependency-free reference path. It consumes the same JSON
// RenderScene fixture the VulkanSceneGraph backend will consume, then emits
// deterministic ASCII PPM pixels for regression checks. It deliberately does
// not claim to be the final VSG backend.

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

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
    if (!std::holds_alternative<bool>(value)) throw std::runtime_error("expected JSON bool");
    return std::get<bool>(value);
  }

  [[nodiscard]] bool contains(std::string_view key) const {
    const auto& obj = object();
    return obj.find(std::string(key)) != obj.end();
  }

  [[nodiscard]] const Json& at(std::string_view key) const {
    const auto& obj = object();
    auto it = obj.find(std::string(key));
    if (it == obj.end()) throw std::runtime_error("missing JSON key: " + std::string(key));
    return it->second;
  }

  [[nodiscard]] const Json& get(std::string_view key, const Json& fallback) const {
    const auto& obj = object();
    auto it = obj.find(std::string(key));
    return it == obj.end() ? fallback : it->second;
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
          // The current fixture is ASCII-only. Keep the parser honest without
          // adding a half-implemented Unicode transcoder.
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

[[nodiscard]] std::string read_file(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot read " + path.string());
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

[[nodiscard]] Json load_json(const std::filesystem::path& path) {
  return JsonParser(read_file(path)).parse();
}

struct Color {
  int r = 0;
  int g = 0;
  int b = 0;

  friend bool operator==(const Color& lhs, const Color& rhs) {
    return lhs.r == rhs.r && lhs.g == rhs.g && lhs.b == rhs.b;
  }
};

struct Point {
  int x = 0;
  int y = 0;

  friend bool operator==(const Point& lhs, const Point& rhs) {
    return lhs.x == rhs.x && lhs.y == rhs.y;
  }
};

constexpr Color kBackground{80, 120, 160};
constexpr Color kBlack{0, 0, 0};
constexpr Color kWhite{255, 255, 255};
constexpr Color kRed{255, 0, 0};

[[nodiscard]] Color parse_hex_color(const std::string* value, Color fallback = kBlack) {
  if (value == nullptr || value->empty()) return fallback;
  if (value->size() != 7 || (*value)[0] != '#') {
    throw std::runtime_error("unsupported fixture color " + *value + "; expected #rrggbb");
  }
  auto hex = [](char ch) -> int {
    if ('0' <= ch && ch <= '9') return ch - '0';
    if ('a' <= ch && ch <= 'f') return 10 + ch - 'a';
    if ('A' <= ch && ch <= 'F') return 10 + ch - 'A';
    throw std::runtime_error("invalid hex color digit");
  };
  return Color{
      hex((*value)[1]) * 16 + hex((*value)[2]),
      hex((*value)[3]) * 16 + hex((*value)[4]),
      hex((*value)[5]) * 16 + hex((*value)[6]),
  };
}

[[nodiscard]] const std::string* maybe_string(const Json& object, std::string_view key) {
  if (!object.contains(key)) return nullptr;
  const auto& value = object.at(key);
  if (value.is_null()) return nullptr;
  return &value.string();
}

class Image {
 public:
  Image(int width, int height, Color fill = kBackground) : width_(width), height_(height), pixels_(width * height, fill) {}

  [[nodiscard]] int width() const { return width_; }
  [[nodiscard]] int height() const { return height_; }

  void set_pixel(int x, int y, Color color) {
    if (0 <= x && x < width_ && 0 <= y && y < height_) pixels_[static_cast<size_t>(y * width_ + x)] = color;
  }

  void fill_rect(int x0, int y0, int x1, int y1, Color color) {
    for (int y = std::max(0, y0); y < std::min(height_, y1); ++y) {
      for (int x = std::max(0, x0); x < std::min(width_, x1); ++x) {
        set_pixel(x, y, color);
      }
    }
  }

  [[nodiscard]] const std::vector<Color>& pixels() const { return pixels_; }

  [[nodiscard]] Image scaled_to(int target_width, int target_height) const {
    if (target_width <= 0 || target_height <= 0) throw std::runtime_error("target size must be positive");
    Image out(target_width, target_height);
    for (int y = 0; y < target_height; ++y) {
      const int src_y = std::min(height_ - 1, (y * height_) / target_height);
      for (int x = 0; x < target_width; ++x) {
        const int src_x = std::min(width_ - 1, (x * width_) / target_width);
        out.set_pixel(x, y, pixels_[static_cast<size_t>(src_y * width_ + src_x)]);
      }
    }
    return out;
  }

  [[nodiscard]] std::string ppm() const {
    std::ostringstream out;
    out << "P3\n";
    out << "# Synthetic chart-1 placeholder golden.\n";
    out << width_ << ' ' << height_ << "\n";
    out << "255\n";
    for (int y = 0; y < height_; ++y) {
      for (int x = 0; x < width_; ++x) {
        if (x != 0) out << ' ';
        const auto& pixel = pixels_[static_cast<size_t>(y * width_ + x)];
        out << pixel.r << ' ' << pixel.g << ' ' << pixel.b;
      }
      out << '\n';
    }
    return out.str();
  }

 private:
  int width_ = 0;
  int height_ = 0;
  std::vector<Color> pixels_;
};

void append_be32(std::vector<unsigned char>& out, uint32_t value) {
  out.push_back(static_cast<unsigned char>((value >> 24) & 0xff));
  out.push_back(static_cast<unsigned char>((value >> 16) & 0xff));
  out.push_back(static_cast<unsigned char>((value >> 8) & 0xff));
  out.push_back(static_cast<unsigned char>(value & 0xff));
}

[[nodiscard]] uint32_t crc32_bytes(const std::string& type, const std::vector<unsigned char>& data) {
  uint32_t crc = 0xffffffffU;
  auto step = [&crc](unsigned char byte) {
    crc ^= byte;
    for (int i = 0; i < 8; ++i) crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
  };
  for (unsigned char byte : type) step(byte);
  for (unsigned char byte : data) step(byte);
  return crc ^ 0xffffffffU;
}

[[nodiscard]] uint32_t adler32_bytes(const std::vector<unsigned char>& data) {
  constexpr uint32_t mod = 65521U;
  uint32_t a = 1;
  uint32_t b = 0;
  for (unsigned char byte : data) {
    a = (a + byte) % mod;
    b = (b + a) % mod;
  }
  return (b << 16) | a;
}

void append_png_chunk(std::vector<unsigned char>& out, const std::string& type, const std::vector<unsigned char>& data) {
  append_be32(out, static_cast<uint32_t>(data.size()));
  out.insert(out.end(), type.begin(), type.end());
  out.insert(out.end(), data.begin(), data.end());
  append_be32(out, crc32_bytes(type, data));
}

[[nodiscard]] std::vector<unsigned char> zlib_store_blocks(const std::vector<unsigned char>& data) {
  std::vector<unsigned char> out;
  out.push_back(0x78);  // zlib header: deflate, 32K window
  out.push_back(0x01);  // fastest/no compression

  size_t offset = 0;
  while (offset < data.size()) {
    const size_t remaining = data.size() - offset;
    const uint16_t len = static_cast<uint16_t>(std::min<size_t>(remaining, 65535));
    const bool final = offset + len == data.size();
    out.push_back(final ? 0x01 : 0x00);  // BFINAL + stored-block type.
    out.push_back(static_cast<unsigned char>(len & 0xff));
    out.push_back(static_cast<unsigned char>((len >> 8) & 0xff));
    const uint16_t nlen = static_cast<uint16_t>(~len);
    out.push_back(static_cast<unsigned char>(nlen & 0xff));
    out.push_back(static_cast<unsigned char>((nlen >> 8) & 0xff));
    out.insert(out.end(), data.begin() + static_cast<std::ptrdiff_t>(offset), data.begin() + static_cast<std::ptrdiff_t>(offset + len));
    offset += len;
  }

  append_be32(out, adler32_bytes(data));
  return out;
}

[[nodiscard]] std::vector<unsigned char> png_bytes(const Image& image) {
  std::vector<unsigned char> filtered;
  filtered.reserve(static_cast<size_t>(image.height()) * (1 + static_cast<size_t>(image.width()) * 3));
  const auto& pixels = image.pixels();
  for (int y = 0; y < image.height(); ++y) {
    filtered.push_back(0);  // PNG filter type 0: none. Deterministic, cache-friendly.
    for (int x = 0; x < image.width(); ++x) {
      const auto& pixel = pixels[static_cast<size_t>(y * image.width() + x)];
      filtered.push_back(static_cast<unsigned char>(pixel.r));
      filtered.push_back(static_cast<unsigned char>(pixel.g));
      filtered.push_back(static_cast<unsigned char>(pixel.b));
    }
  }

  std::vector<unsigned char> out = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};

  std::vector<unsigned char> ihdr;
  append_be32(ihdr, static_cast<uint32_t>(image.width()));
  append_be32(ihdr, static_cast<uint32_t>(image.height()));
  ihdr.push_back(8);  // bit depth
  ihdr.push_back(2);  // truecolor RGB
  ihdr.push_back(0);  // compression
  ihdr.push_back(0);  // filter
  ihdr.push_back(0);  // interlace
  append_png_chunk(out, "IHDR", ihdr);
  append_png_chunk(out, "IDAT", zlib_store_blocks(filtered));
  append_png_chunk(out, "IEND", {});
  return out;
}

[[nodiscard]] std::string bytes_to_string(const std::vector<unsigned char>& bytes) {
  return std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

[[nodiscard]] std::vector<double> number_pair(const Json& value) {
  const auto& arr = value.array();
  if (arr.size() != 2) throw std::runtime_error("expected coordinate pair");
  return {arr[0].number(), arr[1].number()};
}

[[nodiscard]] std::vector<std::vector<double>> coordinate_list(const Json& value) {
  std::vector<std::vector<double>> out;
  for (const auto& point : value.array()) out.push_back(number_pair(point));
  return out;
}

[[nodiscard]] bool point_in_ring(double x, double y, const std::vector<std::vector<double>>& ring) {
  bool inside = false;
  size_t j = ring.size() - 1;
  for (size_t i = 0; i < ring.size(); ++i) {
    const double xi = ring[i][0];
    const double yi = ring[i][1];
    const double xj = ring[j][0];
    const double yj = ring[j][1];
    if (((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) == 0.0 ? std::numeric_limits<double>::epsilon() : (yj - yi)) + xi)) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

void draw_fill_area(Image& image, const Json& command) {
  const auto& rings_json = command.at("rings").array();
  if (rings_json.empty()) return;

  std::vector<std::vector<std::vector<double>>> rings;
  rings.reserve(rings_json.size());
  for (const auto& ring : rings_json) rings.push_back(coordinate_list(ring));

  const auto& outer = rings.front();
  std::vector<double> xs;
  std::vector<double> ys;
  for (const auto& point : outer) {
    xs.push_back(point[0]);
    ys.push_back(point[1]);
  }

  const auto& fill = command.at("fill");
  const Color color = parse_hex_color(maybe_string(fill, "color"), kBackground);
  const int min_x = static_cast<int>(std::floor(*std::min_element(xs.begin(), xs.end())));
  const int max_x = static_cast<int>(std::ceil(*std::max_element(xs.begin(), xs.end())));
  const int min_y = static_cast<int>(std::floor(*std::min_element(ys.begin(), ys.end())));
  const int max_y = static_cast<int>(std::ceil(*std::max_element(ys.begin(), ys.end())));

  for (int y = min_y; y < max_y; ++y) {
    for (int x = min_x; x < max_x; ++x) {
      const double cx = static_cast<double>(x) + 0.5;
      const double cy = static_cast<double>(y) + 0.5;
      bool in_hole = false;
      for (size_t i = 1; i < rings.size(); ++i) {
        if (point_in_ring(cx, cy, rings[i])) {
          in_hole = true;
          break;
        }
      }
      if (point_in_ring(cx, cy, outer) && !in_hole) image.set_pixel(x, y, color);
    }
  }
}

[[nodiscard]] std::vector<Point> rounded_line_points(const std::vector<double>& start, const std::vector<double>& end) {
  const double x0 = start[0];
  const double y0 = start[1];
  const double x1 = end[0];
  const double y1 = end[1];
  const double dx = x1 - x0;
  const double dy = y1 - y0;
  std::vector<Point> points;

  if (std::abs(dx) >= std::abs(dy)) {
    const int step = dx >= 0.0 ? 1 : -1;
    for (int x = static_cast<int>(std::round(x0)); x != static_cast<int>(std::round(x1)) + step; x += step) {
      const double t = dx == 0.0 ? 0.0 : (static_cast<double>(x) - x0) / dx;
      const double y = y0 + dy * t;
      int py = 0;
      if (dy < 0.0 && std::abs(y - std::floor(y) - 0.5) < 1e-9) {
        py = static_cast<int>(std::ceil(y));
      } else if (dy > 0.0 && std::abs(y - std::floor(y) - 0.5) < 1e-9) {
        py = static_cast<int>(std::floor(y));
      } else {
        py = static_cast<int>(std::round(y));
      }
      points.push_back(Point{x, py});
    }
  } else {
    const int step = dy >= 0.0 ? 1 : -1;
    for (int y = static_cast<int>(std::round(y0)); y != static_cast<int>(std::round(y1)) + step; y += step) {
      const double t = dy == 0.0 ? 0.0 : (static_cast<double>(y) - y0) / dy;
      points.push_back(Point{static_cast<int>(std::round(x0 + dx * t)), y});
    }
  }
  return points;
}

void draw_stroke_line(Image& image, const Json& command) {
  const auto polyline_json = coordinate_list(command.at("polyline"));
  if (polyline_json.size() < 2) return;

  std::vector<Point> points;
  for (size_t i = 0; i + 1 < polyline_json.size(); ++i) {
    for (const auto& point : rounded_line_points(polyline_json[i], polyline_json[i + 1])) {
      if (points.empty() || !(points.back() == point)) points.push_back(point);
    }
  }

  if (points.size() > 2) {
    points.erase(points.begin());
    points.pop_back();
  }

  const auto& stroke = command.at("stroke");
  const Color color = parse_hex_color(maybe_string(stroke, "color"), kBlack);
  for (const auto& point : points) image.set_pixel(point.x, point.y, color);
}

void draw_symbol(Image& image, const Json& command) {
  auto point = number_pair(command.at("position"));
  image.set_pixel(static_cast<int>(std::round(point[0])) - 1, static_cast<int>(std::round(point[1])), kRed);
}

void draw_text(Image& image, const Json& command) {
  auto point = number_pair(command.at("position"));
  const int x = static_cast<int>(std::round(point[0])) - 1;
  const int y = static_cast<int>(std::round(point[1]));
  Color halo_color = kWhite;
  if (command.contains("halo") && !command.at("halo").is_null()) {
    halo_color = parse_hex_color(maybe_string(command.at("halo"), "color"), kWhite);
  }
  for (int hx : {x - 2, x - 1, x + 1}) image.set_pixel(hx, y, halo_color);
  image.set_pixel(x, y, kBlack);
}

void draw_sounding(Image& image, const Json& command) {
  auto point = number_pair(command.at("position"));
  image.set_pixel(static_cast<int>(std::round(point[0])), static_cast<int>(std::round(point[1])), kBlack);
}

void draw_raster_sheet(Image& image, const Json& command) {
  if (!command.contains("target_quad")) {
    image.fill_rect(0, 0, image.width(), image.height(), kBackground);
    return;
  }
  const auto quad = coordinate_list(command.at("target_quad"));
  std::vector<double> xs;
  std::vector<double> ys;
  for (const auto& point : quad) {
    xs.push_back(point[0]);
    ys.push_back(point[1]);
  }
  image.fill_rect(
      static_cast<int>(std::floor(*std::min_element(xs.begin(), xs.end()))),
      static_cast<int>(std::floor(*std::min_element(ys.begin(), ys.end()))),
      static_cast<int>(std::ceil(*std::max_element(xs.begin(), xs.end()))),
      static_cast<int>(std::ceil(*std::max_element(ys.begin(), ys.end()))),
      kBackground);
}

[[nodiscard]] Image render_scene(const Json& scene) {
  const auto& pixel_size = scene.at("render_view").at("pixel_size").array();
  Image image(static_cast<int>(pixel_size[0].number()), static_cast<int>(pixel_size[1].number()));

  for (const auto& group : scene.at("command_groups").array()) {
    for (const auto& command : group.at("commands").array()) {
      const std::string type = command.at("type").string();
      if (type == "draw_raster_sheet") {
        draw_raster_sheet(image, command);
      } else if (type == "fill_area") {
        draw_fill_area(image, command);
      } else if (type == "stroke_line") {
        draw_stroke_line(image, command);
      } else if (type == "place_symbol") {
        draw_symbol(image, command);
      } else if (type == "draw_text") {
        draw_text(image, command);
      } else if (type == "draw_sounding") {
        draw_sounding(image, command);
      } else {
        throw std::runtime_error("unsupported command type: " + type);
      }
    }
  }
  return image;
}

[[nodiscard]] std::filesystem::path scene_path_for_fixture(const std::filesystem::path& fixture_dir) {
  const auto manifest_path = fixture_dir / "manifest.json";
  if (!std::filesystem::exists(manifest_path)) return fixture_dir / "scene.commands.json";
  const Json manifest = load_json(manifest_path);
  return fixture_dir / manifest.get("scene_file", Json{std::string("scene.commands.json")}).string();
}

[[nodiscard]] std::vector<std::string> ppm_tokens(const std::filesystem::path& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot read " + path.string());
  std::vector<std::string> tokens;
  std::string line;
  while (std::getline(in, line)) {
    if (auto hash = line.find('#'); hash != std::string::npos) line.resize(hash);
    std::istringstream words(line);
    std::string word;
    while (words >> word) tokens.push_back(word);
  }
  return tokens;
}

[[nodiscard]] std::vector<Color> read_ppm_pixels(const std::filesystem::path& path, int& width, int& height) {
  const auto tokens = ppm_tokens(path);
  if (tokens.size() < 4 || tokens[0] != "P3") throw std::runtime_error(path.string() + ": expected ASCII P3 PPM");
  width = std::stoi(tokens[1]);
  height = std::stoi(tokens[2]);
  const int max_value = std::stoi(tokens[3]);
  if (max_value != 255) throw std::runtime_error(path.string() + ": unsupported PPM max value");
  if (tokens.size() != static_cast<size_t>(4 + width * height * 3)) {
    throw std::runtime_error(path.string() + ": unexpected PPM sample count");
  }
  std::vector<Color> pixels;
  pixels.reserve(static_cast<size_t>(width * height));
  for (size_t i = 4; i < tokens.size(); i += 3) {
    pixels.push_back(Color{std::stoi(tokens[i]), std::stoi(tokens[i + 1]), std::stoi(tokens[i + 2])});
  }
  return pixels;
}

void check_expected(const Image& image, const std::filesystem::path& expected_path) {
  int width = 0;
  int height = 0;
  const auto expected = read_ppm_pixels(expected_path, width, height);
  if (width != image.width() || height != image.height()) {
    throw std::runtime_error(expected_path.string() + ": dimensions mismatch");
  }
  if (expected == image.pixels()) return;

  std::ostringstream detail;
  int shown = 0;
  for (size_t i = 0; i < expected.size() && i < image.pixels().size(); ++i) {
    if (!(expected[i] == image.pixels()[i])) {
      const int x = static_cast<int>(i % static_cast<size_t>(width));
      const int y = static_cast<int>(i / static_cast<size_t>(width));
      detail << "(" << x << "," << y << ") expected=(" << expected[i].r << "," << expected[i].g << "," << expected[i].b
             << ") actual=(" << image.pixels()[i].r << "," << image.pixels()[i].g << "," << image.pixels()[i].b << ") ";
      if (++shown == 5) break;
    }
  }
  throw std::runtime_error(expected_path.string() + ": rendered pixels differ: " + detail.str());
}

// Tiny SHA-256 for printing stable artifact hashes without external deps.
class Sha256 {
 public:
  void update(const std::string& data) {
    for (unsigned char byte : data) {
      buffer_[buffer_size_++] = byte;
      bit_len_ += 8;
      if (buffer_size_ == 64) {
        transform(buffer_.data());
        buffer_size_ = 0;
      }
    }
  }

  [[nodiscard]] std::string hex_digest() {
    std::array<unsigned char, 64> final_block = buffer_;
    size_t final_size = buffer_size_;
    final_block[final_size++] = 0x80;
    if (final_size > 56) {
      while (final_size < 64) final_block[final_size++] = 0;
      transform(final_block.data());
      final_block.fill(0);
      final_size = 0;
    }
    while (final_size < 56) final_block[final_size++] = 0;
    for (int i = 7; i >= 0; --i) final_block[final_size++] = static_cast<unsigned char>((bit_len_ >> (i * 8)) & 0xff);
    transform(final_block.data());

    std::ostringstream out;
    for (uint32_t word : state_) out << std::hex << std::setfill('0') << std::setw(8) << word;
    return out.str();
  }

 private:
  static constexpr std::array<uint32_t, 64> k = {
      0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
      0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
      0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
      0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
      0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
      0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
      0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
      0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};

  static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

  void transform(const unsigned char* chunk) {
    std::array<uint32_t, 64> w{};
    for (size_t i = 0; i < 16; ++i) {
      w[i] = (static_cast<uint32_t>(chunk[i * 4]) << 24) | (static_cast<uint32_t>(chunk[i * 4 + 1]) << 16) |
             (static_cast<uint32_t>(chunk[i * 4 + 2]) << 8) | static_cast<uint32_t>(chunk[i * 4 + 3]);
    }
    for (size_t i = 16; i < 64; ++i) {
      const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (size_t i = 0; i < 64; ++i) {
      const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const uint32_t ch = (e & f) ^ ((~e) & g);
      const uint32_t temp1 = h + s1 + ch + k[i] + w[i];
      const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temp2 = s0 + maj;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::array<uint32_t, 8> state_ = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
                                    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  std::array<unsigned char, 64> buffer_{};
  size_t buffer_size_ = 0;
  uint64_t bit_len_ = 0;
};

void usage(const char* argv0) {
  std::cerr << "usage: " << argv0
            << " <fixture-dir> [--output <path>] [--format ppm|png] [--tile-size N]"
            << " [--check] [--print-hash] [--backend fixture-cpu|vsg]\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 2) {
      usage(argv[0]);
      return 2;
    }

    std::filesystem::path fixture_dir;
    std::optional<std::filesystem::path> output;
    std::optional<int> tile_size;
    std::string format;
    bool check = false;
    bool print_hash = false;
    std::string backend = "fixture-cpu";

    for (int i = 1; i < argc; ++i) {
      std::string arg = argv[i];
      if (arg == "--output") {
        if (++i >= argc) throw std::runtime_error("--output requires a path");
        output = std::filesystem::path(argv[i]);
      } else if (arg == "--format") {
        if (++i >= argc) throw std::runtime_error("--format requires ppm or png");
        format = argv[i];
      } else if (arg == "--tile-size") {
        if (++i >= argc) throw std::runtime_error("--tile-size requires a positive integer");
        tile_size = std::stoi(argv[i]);
        if (*tile_size <= 0) throw std::runtime_error("--tile-size must be positive");
      } else if (arg == "--check") {
        check = true;
      } else if (arg == "--print-hash") {
        print_hash = true;
      } else if (arg == "--backend") {
        if (++i >= argc) throw std::runtime_error("--backend requires a value");
        backend = argv[i];
      } else if (arg.rfind("--", 0) == 0) {
        throw std::runtime_error("unknown option: " + arg);
      } else if (fixture_dir.empty()) {
        fixture_dir = std::filesystem::path(arg);
      } else {
        throw std::runtime_error("unexpected argument: " + arg);
      }
    }

    if (fixture_dir.empty()) throw std::runtime_error("missing fixture directory");
    if (backend == "vsg") {
      std::cerr << "VSG backend is not available in this fixture reference renderer; build the real VulkanSceneGraph target on a supported platform.\n";
      return 2;
    }
    if (backend != "fixture-cpu") throw std::runtime_error("unknown backend: " + backend);

    const Json scene = load_json(scene_path_for_fixture(fixture_dir));
    const Image image = render_scene(scene);
    const Image output_image = tile_size ? image.scaled_to(*tile_size, *tile_size) : image;

    if (format.empty()) {
      format = output && output->extension() == ".png" ? "png" : "ppm";
    }
    if (format != "ppm" && format != "png") throw std::runtime_error("--format must be ppm or png");

    const std::string ppm = output_image.ppm();
    const std::vector<unsigned char> png = format == "png" ? png_bytes(output_image) : std::vector<unsigned char>{};
    const std::string artifact = format == "png" ? bytes_to_string(png) : ppm;

    if (output) {
      if (output->has_parent_path()) std::filesystem::create_directories(output->parent_path());
      std::ofstream out(*output, std::ios::binary);
      if (!out) throw std::runtime_error("cannot write " + output->string());
      out.write(artifact.data(), static_cast<std::streamsize>(artifact.size()));
    }

    if (print_hash) {
      Sha256 sha;
      sha.update(artifact);
      std::cout << sha.hex_digest() << '\n';
    }

    if (check) {
      const Json manifest = load_json(fixture_dir / "manifest.json");
      int checked = 0;
      for (const auto& expected : manifest.at("expected_images").array()) {
        if (expected.at("format").string() != "ppm-ascii") continue;
        check_expected(image, fixture_dir / expected.at("path").string());
        ++checked;
      }
      if (checked == 0) throw std::runtime_error(fixture_dir.string() + ": no ppm-ascii expected images to check");
      std::cout << "ok " << manifest.get("fixture_id", Json{fixture_dir.filename().string()}).string()
                << ": rendered " << checked << " expected PPM image(s)\n";
    }

    if (!output && !check && !print_hash) std::cout.write(artifact.data(), static_cast<std::streamsize>(artifact.size()));
    return 0;
  } catch (const std::exception& exc) {
    std::cerr << exc.what() << '\n';
    return 1;
  }
}

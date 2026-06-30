#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <vector>

namespace {

std::string join_path(const std::string& a, const std::string& b) {
  if (a.empty() || a == ".") return b;
  if (a[a.size() - 1] == '/') return a + b;
  return a + "/" + b;
}

std::string base_name(const std::string& path) {
  const std::string::size_type slash = path.find_last_of('/');
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

std::string dir_name(const std::string& path) {
  const std::string::size_type slash = path.find_last_of('/');
  return slash == std::string::npos ? "." : path.substr(0, slash);
}

bool is_dir(const std::string& path) {
  struct stat st;
  return stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

std::string read_file(const std::string& path, bool binary = false) {
  std::ifstream in(path.c_str(), binary ? std::ios::binary : std::ios::in);
  if (!in) throw std::runtime_error(path + ": " + std::strerror(errno));
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

class Sha256 {
 public:
  Sha256() : bit_len_(0), buffer_len_(0) {
    h_[0] = 0x6a09e667u;
    h_[1] = 0xbb67ae85u;
    h_[2] = 0x3c6ef372u;
    h_[3] = 0xa54ff53au;
    h_[4] = 0x510e527fu;
    h_[5] = 0x9b05688cu;
    h_[6] = 0x1f83d9abu;
    h_[7] = 0x5be0cd19u;
  }

  void update(const unsigned char* data, std::size_t len) {
    bit_len_ += static_cast<std::uint64_t>(len) * 8u;
    for (std::size_t i = 0; i < len; ++i) {
      buffer_[buffer_len_++] = data[i];
      if (buffer_len_ == 64) {
        transform(buffer_);
        buffer_len_ = 0;
      }
    }
  }

  std::string hex_digest() {
    const std::uint64_t input_bits = bit_len_;
    buffer_[buffer_len_++] = 0x80u;
    if (buffer_len_ > 56) {
      while (buffer_len_ < 64) buffer_[buffer_len_++] = 0;
      transform(buffer_);
      buffer_len_ = 0;
    }
    while (buffer_len_ < 56) buffer_[buffer_len_++] = 0;
    for (int i = 7; i >= 0; --i) {
      buffer_[buffer_len_++] = static_cast<unsigned char>((input_bits >> (i * 8)) & 0xffu);
    }
    transform(buffer_);

    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (std::size_t i = 0; i < 8; ++i) {
      out << std::setw(8) << h_[i];
    }
    return out.str();
  }

 private:
  static std::uint32_t rotr(std::uint32_t v, std::uint32_t n) {
    return (v >> n) | (v << (32 - n));
  }

  static std::uint32_t ch(std::uint32_t x, std::uint32_t y, std::uint32_t z) {
    return (x & y) ^ (~x & z);
  }

  static std::uint32_t maj(std::uint32_t x, std::uint32_t y, std::uint32_t z) {
    return (x & y) ^ (x & z) ^ (y & z);
  }

  static std::uint32_t big0(std::uint32_t x) {
    return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
  }

  static std::uint32_t big1(std::uint32_t x) {
    return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
  }

  static std::uint32_t small0(std::uint32_t x) {
    return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3);
  }

  static std::uint32_t small1(std::uint32_t x) {
    return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10);
  }

  void transform(const unsigned char block[64]) {
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

    std::uint32_t w[64];
    for (std::size_t i = 0; i < 16; ++i) {
      w[i] = (static_cast<std::uint32_t>(block[i * 4]) << 24) |
             (static_cast<std::uint32_t>(block[i * 4 + 1]) << 16) |
             (static_cast<std::uint32_t>(block[i * 4 + 2]) << 8) |
             static_cast<std::uint32_t>(block[i * 4 + 3]);
    }
    for (std::size_t i = 16; i < 64; ++i) {
      w[i] = small1(w[i - 2]) + w[i - 7] + small0(w[i - 15]) + w[i - 16];
    }

    std::uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3];
    std::uint32_t e = h_[4], f = h_[5], g = h_[6], h = h_[7];
    for (std::size_t i = 0; i < 64; ++i) {
      const std::uint32_t t1 = h + big1(e) + ch(e, f, g) + k[i] + w[i];
      const std::uint32_t t2 = big0(a) + maj(a, b, c);
      h = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h_[0] += a;
    h_[1] += b;
    h_[2] += c;
    h_[3] += d;
    h_[4] += e;
    h_[5] += f;
    h_[6] += g;
    h_[7] += h;
  }

  std::uint32_t h_[8];
  std::uint64_t bit_len_;
  unsigned char buffer_[64];
  std::size_t buffer_len_;
};

std::string sha256_bytes(const std::string& bytes) {
  Sha256 sha;
  sha.update(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size());
  return sha.hex_digest();
}

struct Json {
  enum Type { NIL, BOOL, NUMBER, STRING, ARRAY, OBJECT };
  Type type = NIL;
  bool bool_value = false;
  std::string text;
  std::vector<Json> array_value;
  std::map<std::string, Json> object_value;
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& input) : input_(input), pos_(0) {}

  Json parse() {
    skip_ws();
    Json out = parse_value();
    skip_ws();
    if (pos_ != input_.size()) fail("trailing characters");
    return out;
  }

 private:
  Json parse_value() {
    skip_ws();
    if (pos_ >= input_.size()) fail("unexpected end of input");
    const char c = input_[pos_];
    if (c == '{') return parse_object();
    if (c == '[') return parse_array();
    if (c == '"') return parse_string_value();
    if (c == 't') return parse_literal("true", true);
    if (c == 'f') return parse_literal("false", false);
    if (c == 'n') return parse_null();
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
    std::ostringstream message;
    message << "unexpected character byte 0x" << std::hex << std::setw(2) << std::setfill('0')
            << static_cast<unsigned>(static_cast<unsigned char>(c));
    fail(message.str());
    return Json();
  }

  Json parse_object() {
    Json out;
    out.type = Json::OBJECT;
    expect('{');
    skip_ws();
    if (consume('}')) return out;
    while (true) {
      skip_ws();
      if (pos_ >= input_.size() || input_[pos_] != '"') fail("object key must be a string");
      const std::string key = parse_string();
      skip_ws();
      expect(':');
      out.object_value[key] = parse_value();
      skip_ws();
      if (consume('}')) break;
      expect(',');
    }
    return out;
  }

  Json parse_array() {
    Json out;
    out.type = Json::ARRAY;
    expect('[');
    skip_ws();
    if (consume(']')) return out;
    while (true) {
      out.array_value.push_back(parse_value());
      skip_ws();
      if (consume(']')) break;
      expect(',');
    }
    return out;
  }

  Json parse_string_value() {
    Json out;
    out.type = Json::STRING;
    out.text = parse_string();
    return out;
  }

  Json parse_literal(const char* literal, bool value) {
    const std::size_t len = std::strlen(literal);
    if (input_.compare(pos_, len, literal) != 0) fail("invalid literal");
    pos_ += len;
    Json out;
    out.type = Json::BOOL;
    out.bool_value = value;
    return out;
  }

  Json parse_null() {
    if (input_.compare(pos_, 4, "null") != 0) fail("invalid literal");
    pos_ += 4;
    Json out;
    out.type = Json::NIL;
    return out;
  }

  Json parse_number() {
    const std::size_t start = pos_;
    consume('-');
    if (pos_ >= input_.size()) fail("invalid number");
    if (input_[pos_] == '0') {
      ++pos_;
    } else if (input_[pos_] >= '1' && input_[pos_] <= '9') {
      while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
    } else {
      fail("invalid number");
    }
    if (consume('.')) {
      if (pos_ >= input_.size() || input_[pos_] < '0' || input_[pos_] > '9') fail("invalid number");
      while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
    }
    if (pos_ < input_.size() && (input_[pos_] == 'e' || input_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < input_.size() && (input_[pos_] == '+' || input_[pos_] == '-')) ++pos_;
      if (pos_ >= input_.size() || input_[pos_] < '0' || input_[pos_] > '9') fail("invalid number");
      while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
    }
    Json out;
    out.type = Json::NUMBER;
    out.text = input_.substr(start, pos_ - start);
    return out;
  }

  std::string parse_string() {
    expect('"');
    std::string out;
    while (pos_ < input_.size()) {
      const unsigned char c = static_cast<unsigned char>(input_[pos_++]);
      if (c == '"') return out;
      if (c != '\\') {
        if (c < 0x20) fail("control character in string");
        out.push_back(static_cast<char>(c));
        continue;
      }
      if (pos_ >= input_.size()) fail("unterminated escape");
      const char esc = input_[pos_++];
      switch (esc) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': append_codepoint(read_hex4(), out); break;
        default: fail("invalid escape");
      }
    }
    fail("unterminated string");
    return std::string();
  }

  unsigned read_hex4() {
    if (pos_ + 4 > input_.size()) fail("short unicode escape");
    unsigned value = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = input_[pos_++];
      value <<= 4;
      if (c >= '0' && c <= '9') value += static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') value += static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') value += static_cast<unsigned>(c - 'A' + 10);
      else fail("invalid unicode escape");
    }
    return value;
  }

  static void append_codepoint(unsigned cp, std::string& out) {
    if (cp <= 0x7f) {
      out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7ff) {
      out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    } else {
      out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    }
  }

  void skip_ws() {
    while (pos_ < input_.size()) {
      const char c = input_[pos_];
      if (c != ' ' && c != '\n' && c != '\r' && c != '\t') break;
      ++pos_;
    }
  }

  bool consume(char c) {
    if (pos_ < input_.size() && input_[pos_] == c) {
      ++pos_;
      return true;
    }
    return false;
  }

  void expect(char c) {
    if (!consume(c)) fail(std::string("expected '") + c + "'");
  }

  void fail(const std::string& message) const {
    std::ostringstream out;
    out << "JSON parse error at byte " << pos_ << ": " << message;
    throw std::runtime_error(out.str());
  }

  const std::string input_;
  std::size_t pos_;
};

const Json* object_get(const Json* object, const std::string& key) {
  if (!object || object->type != Json::OBJECT) return nullptr;
  std::map<std::string, Json>::const_iterator it = object->object_value.find(key);
  return it == object->object_value.end() ? nullptr : &it->second;
}

const Json* object_get(const Json& object, const std::string& key) {
  return object_get(&object, key);
}

std::string string_value(const Json* value, const std::string& fallback = std::string()) {
  return value && value->type == Json::STRING ? value->text : fallback;
}

const std::vector<Json>& array_value(const Json* value) {
  static const std::vector<Json> empty;
  return value && value->type == Json::ARRAY ? value->array_value : empty;
}

void append_json_string(const std::string& value, std::string& out) {
  static const char hex[] = "0123456789abcdef";
  out.push_back('"');
  for (std::size_t i = 0; i < value.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(value[i]);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20 || c >= 0x80) {
          out += "\\u00";
          out.push_back(hex[(c >> 4) & 0x0f]);
          out.push_back(hex[c & 0x0f]);
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

void append_canonical(const Json& value, std::string& out) {
  switch (value.type) {
    case Json::NIL:
      out += "null";
      break;
    case Json::BOOL:
      out += value.bool_value ? "true" : "false";
      break;
    case Json::NUMBER:
      out += value.text;
      break;
    case Json::STRING:
      append_json_string(value.text, out);
      break;
    case Json::ARRAY:
      out.push_back('[');
      for (std::size_t i = 0; i < value.array_value.size(); ++i) {
        if (i) out.push_back(',');
        append_canonical(value.array_value[i], out);
      }
      out.push_back(']');
      break;
    case Json::OBJECT:
      out.push_back('{');
      for (std::map<std::string, Json>::const_iterator it = value.object_value.begin();
           it != value.object_value.end(); ++it) {
        if (it != value.object_value.begin()) out.push_back(',');
        append_json_string(it->first, out);
        out.push_back(':');
        append_canonical(it->second, out);
      }
      out.push_back('}');
      break;
  }
}

Json load_json(const std::string& path) {
  try {
    JsonParser parser(read_file(path));
    return parser.parse();
  } catch (const std::exception& e) {
    throw std::runtime_error(path + ": " + e.what());
  }
}

std::string json_sha256(const std::string& path) {
  const Json value = load_json(path);
  std::string canonical;
  append_canonical(value, canonical);
  canonical.push_back('\n');
  return sha256_bytes(canonical);
}

std::string file_sha256(const std::string& path) {
  return sha256_bytes(read_file(path, true));
}

void collect_manifest_dirs(const std::string& root, std::vector<std::string>& out) {
  DIR* dir = opendir(root.c_str());
  if (!dir) throw std::runtime_error(root + ": " + std::strerror(errno));
  while (dirent* entry = readdir(dir)) {
    const std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    const std::string path = join_path(root, name);
    if (is_dir(path)) {
      collect_manifest_dirs(path, out);
    } else if (name == "manifest.json") {
      out.push_back(dir_name(path));
    }
  }
  closedir(dir);
}

void add_error(std::vector<std::string>& errors, const std::string& message) {
  errors.push_back(message);
}

std::pair<int, int> check_fixture(const std::string& fixture_dir, bool print_hashes) {
  std::vector<std::string> errors;
  const std::string manifest_path = join_path(fixture_dir, "manifest.json");
  Json manifest;
  try {
    manifest = load_json(manifest_path);
  } catch (const std::exception& e) {
    std::cerr << e.what() << "\n";
    return std::make_pair(1, 0);
  }

  const std::string fixture_id = string_value(object_get(manifest, "fixture_id"), base_name(fixture_dir));
  const std::string source_path = join_path(fixture_dir, string_value(object_get(manifest, "source_file"), "source.json"));
  const std::string scene_path = join_path(fixture_dir, string_value(object_get(manifest, "scene_file"), "scene.commands.json"));
  const std::string provenance_path = join_path(fixture_dir, string_value(object_get(manifest, "provenance_file"), "provenance.json"));

  if (!std::ifstream(source_path.c_str())) add_error(errors, fixture_id + ": missing " + base_name(source_path));
  if (!std::ifstream(scene_path.c_str())) add_error(errors, fixture_id + ": missing " + base_name(scene_path));
  if (!std::ifstream(provenance_path.c_str())) add_error(errors, fixture_id + ": missing " + base_name(provenance_path));
  if (!errors.empty()) {
    for (std::size_t i = 0; i < errors.size(); ++i) std::cerr << errors[i] << "\n";
    return std::make_pair(1, 0);
  }

  Json source, scene, provenance;
  try {
    source = load_json(source_path);
    scene = load_json(scene_path);
    provenance = load_json(provenance_path);
  } catch (const std::exception& e) {
    std::cerr << e.what() << "\n";
    return std::make_pair(1, 0);
  }

  const Json* expected = object_get(manifest, "expected_hashes");
  const std::map<std::string, std::string> actual_hashes = {
      std::make_pair("source_json_sha256", json_sha256(source_path)),
      std::make_pair("scene_commands_json_sha256", json_sha256(scene_path)),
      std::make_pair("provenance_json_sha256", json_sha256(provenance_path))};

  for (std::map<std::string, std::string>::const_iterator it = actual_hashes.begin();
       it != actual_hashes.end(); ++it) {
    const std::string want = string_value(object_get(expected, it->first));
    if (want != it->second) {
      add_error(errors, fixture_id + ": " + it->first + " mismatch: manifest=" +
                            (want.empty() ? "<missing>" : want) + " actual=" + it->second);
    }
  }

  if (string_value(object_get(source, "fixture_id")) != fixture_id) {
    add_error(errors, fixture_id + ": source fixture_id mismatch");
  }
  if (string_value(object_get(scene, "scene_id")) != string_value(object_get(manifest, "scene_id"))) {
    add_error(errors, fixture_id + ": scene_id mismatch");
  }
  if (string_value(object_get(scene, "schema_version")) != string_value(object_get(manifest, "schema_version"))) {
    add_error(errors, fixture_id + ": schema_version mismatch");
  }

  std::vector<const Json*> commands;
  const std::vector<Json>& groups = array_value(object_get(scene, "command_groups"));
  for (std::size_t i = 0; i < groups.size(); ++i) {
    const std::vector<Json>& group_commands = array_value(object_get(groups[i], "commands"));
    for (std::size_t j = 0; j < group_commands.size(); ++j) commands.push_back(&group_commands[j]);
  }

  std::set<std::string> command_types;
  for (std::size_t i = 0; i < commands.size(); ++i) {
    command_types.insert(string_value(object_get(*commands[i], "type")));
  }
  const std::vector<Json>& required = array_value(object_get(manifest, "required_command_types"));
  for (std::size_t i = 0; i < required.size(); ++i) {
    const std::string required_type = string_value(&required[i]);
    if (!required_type.empty() && command_types.find(required_type) == command_types.end()) {
      add_error(errors, fixture_id + ": missing command type " + required_type);
    }
  }

  std::set<std::string> provenance_ids;
  const std::vector<Json>& provenance_table = array_value(object_get(provenance, "provenance_table"));
  for (std::size_t i = 0; i < provenance_table.size(); ++i) {
    const std::string id = string_value(object_get(provenance_table[i], "provenance_id"));
    if (!id.empty()) provenance_ids.insert(id);
  }

  for (std::size_t i = 0; i < commands.size(); ++i) {
    const std::string command_id = string_value(object_get(*commands[i], "command_id"));
    const std::string type = string_value(object_get(*commands[i], "type"));
    if (command_id.empty()) add_error(errors, fixture_id + ": command missing command_id");
    if (type.empty()) add_error(errors, fixture_id + ": command " + command_id + " missing type");
    const std::vector<Json>& refs = array_value(object_get(*commands[i], "provenance_refs"));
    for (std::size_t j = 0; j < refs.size(); ++j) {
      const std::string prov_id = string_value(&refs[j]);
      if (provenance_ids.find(prov_id) == provenance_ids.end()) {
        add_error(errors, fixture_id + ": command " + command_id + " references missing provenance " + prov_id);
      }
    }
  }

  const std::vector<Json>& expected_images = array_value(object_get(manifest, "expected_images"));
  for (std::size_t i = 0; i < expected_images.size(); ++i) {
    const std::string rel_path = string_value(object_get(expected_images[i], "path"));
    if (rel_path.empty()) {
      add_error(errors, fixture_id + ": expected image missing path");
      continue;
    }
    const std::string image_path = join_path(fixture_dir, rel_path);
    if (!std::ifstream(image_path.c_str(), std::ios::binary)) {
      add_error(errors, fixture_id + ": missing expected image " + rel_path);
      continue;
    }
    const std::string actual = file_sha256(image_path);
    const std::string want = string_value(object_get(expected_images[i], "sha256"));
    if (want != actual) {
      add_error(errors, fixture_id + ": image " + rel_path + " sha256 mismatch: manifest=" +
                            (want.empty() ? "<missing>" : want) + " actual=" + actual);
    }
  }

  if (print_hashes) {
    std::cout << fixture_id << ":\n";
    const char* order[] = {"source_json_sha256", "scene_commands_json_sha256", "provenance_json_sha256"};
    for (std::size_t i = 0; i < 3; ++i) {
      std::cout << "  " << order[i] << ": " << actual_hashes.find(order[i])->second << "\n";
    }
    for (std::size_t i = 0; i < expected_images.size(); ++i) {
      const std::string rel_path = string_value(object_get(expected_images[i], "path"));
      const std::string image_path = join_path(fixture_dir, rel_path);
      if (!rel_path.empty() && std::ifstream(image_path.c_str(), std::ios::binary)) {
        std::cout << "  " << rel_path << ": " << file_sha256(image_path) << "\n";
      }
    }
  }

  if (!errors.empty()) {
    for (std::size_t i = 0; i < errors.size(); ++i) std::cerr << errors[i] << "\n";
    return std::make_pair(1, 0);
  }

  std::cout << "ok " << fixture_id << ": " << commands.size() << " commands, "
            << provenance_ids.size() << " provenance records\n";
  return std::make_pair(0, 1);
}

void usage(const char* argv0) {
  std::cerr << "usage: " << argv0 << " [--print-hashes] [fixture-root]\n";
}

}  // namespace

int main(int argc, char** argv) {
  bool print_hashes = false;
  std::string root = "engine/test/fixtures/vulkan-render";
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--print-hashes") {
      print_hashes = true;
    } else if (arg == "--help" || arg == "-h") {
      usage(argv[0]);
      return 0;
    } else if (!arg.empty() && arg[0] == '-') {
      std::cerr << "unknown option: " << arg << "\n";
      usage(argv[0]);
      return 2;
    } else {
      root = arg;
    }
  }

  if (!is_dir(root)) {
    std::cerr << "fixture root does not exist: " << root << "\n";
    return 2;
  }

  try {
    std::vector<std::string> fixture_dirs;
    collect_manifest_dirs(root, fixture_dirs);
    std::sort(fixture_dirs.begin(), fixture_dirs.end());

    int failures = 0;
    int checked = 0;
    for (std::size_t i = 0; i < fixture_dirs.size(); ++i) {
      const std::pair<int, int> result = check_fixture(fixture_dirs[i], print_hashes);
      failures += result.first;
      checked += result.second;
    }
    if (checked == 0 && failures == 0) {
      std::cerr << "no fixtures found under " << root << "\n";
      return 2;
    }
    return failures ? 1 : 0;
  } catch (const std::exception& e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
}

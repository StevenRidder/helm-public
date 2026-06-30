#include "helm_s52_atlas.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <set>
#include <sstream>
#include <sys/stat.h>

namespace helm {
namespace s52 {
namespace {

const int kAtlasWidth = 64;

std::string Trim(const std::string &s) {
  size_t first = 0;
  while (first < s.size() &&
         std::isspace(static_cast<unsigned char>(s[first]))) {
    ++first;
  }
  size_t last = s.size();
  while (last > first &&
         std::isspace(static_cast<unsigned char>(s[last - 1]))) {
    --last;
  }
  return s.substr(first, last - first);
}

std::string LowerAscii(std::string s) {
  for (char &c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

std::string JsonEscape(const std::string &s) {
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
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

bool ParseInt(const std::string &text, int *out) {
  errno = 0;
  char *end = nullptr;
  long value = std::strtol(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0' || errno == ERANGE) {
    return false;
  }
  *out = static_cast<int>(value);
  return true;
}

bool ParseHexColor(const std::string &text, Rgb *out) {
  std::string s = text;
  if (!s.empty() && s[0] == '#') s = s.substr(1);
  if (s.size() == 2 + 6 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    s = s.substr(2);
  }
  if (s.size() != 6) return false;
  char *end = nullptr;
  long value = std::strtol(s.c_str(), &end, 16);
  if (end == s.c_str() || *end != '\0' || errno == ERANGE) return false;
  out->r = static_cast<int>((value >> 16) & 0xff);
  out->g = static_cast<int>((value >> 8) & 0xff);
  out->b = static_cast<int>(value & 0xff);
  return true;
}

std::vector<int> ParseDash(const std::string &text, bool *ok) {
  std::vector<int> dash;
  *ok = true;
  if (text == "-" || text == "none") return dash;
  for (const std::string &part : SplitCommaList(text)) {
    int value = 0;
    if (!ParseInt(part, &value) || value <= 0) {
      *ok = false;
      return dash;
    }
    dash.push_back(value);
  }
  return dash;
}

std::string KindPlural(const std::string &kind) {
  if (kind == "symbol") return "symbols";
  if (kind == "pattern") return "patterns";
  if (kind == "line") return "lines";
  return kind + "s";
}

int KindRank(const std::string &kind) {
  if (kind == "symbol") return 0;
  if (kind == "pattern") return 1;
  if (kind == "line") return 2;
  return 99;
}

bool EntryLess(const FixtureEntry &a, const FixtureEntry &b) {
  if (KindRank(a.kind) != KindRank(b.kind)) {
    return KindRank(a.kind) < KindRank(b.kind);
  }
  return a.name < b.name;
}

std::string JoinPath(const std::string &dir, const std::string &file) {
  if (dir.empty() || dir == ".") return file;
  if (dir[dir.size() - 1] == '/') return dir + file;
  return dir + "/" + file;
}

bool EnsureDir(const std::string &path, std::string *error) {
  if (::mkdir(path.c_str(), 0755) == 0 || errno == EEXIST) return true;
  if (error) *error = "could not create output directory: " + path;
  return false;
}

void FillRect(std::vector<Rgb> *pixels,
              int image_width,
              const Rect &rect,
              const Rgb &color) {
  for (int y = rect.y; y < rect.y + rect.height; ++y) {
    for (int x = rect.x; x < rect.x + rect.width; ++x) {
      (*pixels)[static_cast<size_t>(y * image_width + x)] = color;
    }
  }
}

void DrawLineStyle(std::vector<Rgb> *pixels,
                   int image_width,
                   const Rect &rect,
                   const std::vector<int> &dash,
                   const Rgb &color) {
  if (dash.empty()) {
    FillRect(pixels, image_width, rect, color);
    return;
  }
  int y0 = rect.y + rect.height / 2;
  int x = rect.x;
  size_t dash_index = 0;
  bool on = true;
  while (x < rect.x + rect.width) {
    int length = dash[dash_index % dash.size()];
    for (int i = 0; i < length && x + i < rect.x + rect.width; ++i) {
      if (on) {
        (*pixels)[static_cast<size_t>(y0 * image_width + x + i)] = color;
      }
    }
    x += length;
    ++dash_index;
    on = !on;
  }
}

bool WritePpm(const std::string &path,
              int width,
              int height,
              const std::vector<Rgb> &pixels,
              std::string *error) {
  std::ofstream out(path, std::ios::binary);
  if (!out.good()) {
    if (error) *error = "could not write atlas image: " + path;
    return false;
  }
  out << "P3\n" << width << " " << height << "\n255\n";
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const Rgb &p = pixels[static_cast<size_t>(y * width + x)];
      out << p.r << " " << p.g << " " << p.b;
      out << (x + 1 == width ? '\n' : ' ');
    }
  }
  return true;
}

std::string FormatUv(double value) {
  std::ostringstream ss;
  ss << std::fixed << std::setprecision(6) << value;
  return ss.str();
}

void WriteIntArray(std::ostream &out, const std::vector<int> &values) {
  out << "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out << ",";
    out << values[i];
  }
  out << "]";
}

bool WriteManifest(const AtlasManifest &manifest,
                   const std::string &path,
                   std::string *error) {
  std::ofstream out(path, std::ios::binary);
  if (!out.good()) {
    if (error) *error = "could not write manifest: " + path;
    return false;
  }

  out << "{\n";
  out << "  \"schema_version\": " << manifest.schema_version << ",\n";
  out << "  \"generator\": \"helm-s52-atlas-builder.poc\",\n";
  out << "  \"palettes\": [";
  for (size_t i = 0; i < manifest.palettes.size(); ++i) {
    if (i) out << ", ";
    out << "\"" << JsonEscape(manifest.palettes[i]) << "\"";
  }
  out << "],\n";
  out << "  \"atlases\": [\n";
  for (size_t i = 0; i < manifest.atlases.size(); ++i) {
    const AtlasImage &a = manifest.atlases[i];
    out << "    {\"kind\":\"" << JsonEscape(a.kind)
        << "\",\"palette\":\"" << JsonEscape(a.palette)
        << "\",\"image\":\"" << JsonEscape(a.image)
        << "\",\"format\":\"" << JsonEscape(a.format)
        << "\",\"width\":" << a.width
        << ",\"height\":" << a.height << "}";
    out << (i + 1 == manifest.atlases.size() ? "\n" : ",\n");
  }
  out << "  ],\n";
  out << "  \"entries\": [\n";
  for (size_t i = 0; i < manifest.entries.size(); ++i) {
    const AtlasEntry &e = manifest.entries[i];
    out << "    {\"name\":\"" << JsonEscape(e.name)
        << "\",\"kind\":\"" << JsonEscape(e.kind)
        << "\",\"palette\":\"" << JsonEscape(e.palette)
        << "\",\"atlas\":\"" << JsonEscape(e.atlas)
        << "\",\"pixel_rect\":[" << e.pixel_rect.x << "," << e.pixel_rect.y
        << "," << e.pixel_rect.width << "," << e.pixel_rect.height << "]"
        << ",\"uv\":[" << FormatUv(e.uv_rect.u0) << ","
        << FormatUv(e.uv_rect.v0) << "," << FormatUv(e.uv_rect.u1) << ","
        << FormatUv(e.uv_rect.v1) << "]"
        << ",\"anchor\":[" << e.anchor_x << "," << e.anchor_y << "]"
        << ",\"repeat\":[" << e.repeat_x << "," << e.repeat_y << "]"
        << ",\"dash\":";
    WriteIntArray(out, e.dash);
    out << ",\"color\":[" << e.color.r << "," << e.color.g << ","
        << e.color.b << "]}";
    out << (i + 1 == manifest.entries.size() ? "\n" : ",\n");
  }
  out << "  ]\n";
  out << "}\n";
  return true;
}

bool ReadFile(const std::string &path, std::string *body, std::string *error) {
  std::ifstream in(path, std::ios::binary);
  if (!in.good()) {
    if (error) *error = "could not read file: " + path;
    return false;
  }
  std::ostringstream ss;
  ss << in.rdbuf();
  *body = ss.str();
  return true;
}

bool ExtractString(const std::string &object,
                   const std::string &key,
                   std::string *out) {
  const std::string needle = "\"" + key + "\":\"";
  size_t pos = object.find(needle);
  if (pos == std::string::npos) return false;
  pos += needle.size();
  size_t end = object.find("\"", pos);
  if (end == std::string::npos) return false;
  *out = object.substr(pos, end - pos);
  return true;
}

bool ExtractInt(const std::string &object, const std::string &key, int *out) {
  const std::string needle = "\"" + key + "\":";
  size_t pos = object.find(needle);
  if (pos == std::string::npos) return false;
  pos += needle.size();
  size_t end = pos;
  while (end < object.size() &&
         (std::isdigit(static_cast<unsigned char>(object[end])) ||
          object[end] == '-')) {
    ++end;
  }
  return ParseInt(object.substr(pos, end - pos), out);
}

bool ExtractIntArray(const std::string &object,
                     const std::string &key,
                     std::vector<int> *values) {
  const std::string needle = "\"" + key + "\":[";
  size_t pos = object.find(needle);
  if (pos == std::string::npos) return false;
  pos += needle.size();
  size_t end = object.find("]", pos);
  if (end == std::string::npos) return false;
  values->clear();
  std::string inner = object.substr(pos, end - pos);
  if (Trim(inner).empty()) return true;
  for (const std::string &part : SplitCommaList(inner)) {
    int value = 0;
    if (!ParseInt(part, &value)) return false;
    values->push_back(value);
  }
  return true;
}

bool ExtractStringArray(const std::string &json,
                        const std::string &key,
                        std::vector<std::string> *values) {
  const std::string needle = "\"" + key + "\":";
  size_t pos = json.find(needle);
  if (pos == std::string::npos) return false;
  pos = json.find("[", pos);
  if (pos == std::string::npos) return false;
  size_t end = json.find("]", pos);
  if (end == std::string::npos) return false;

  values->clear();
  size_t cursor = pos + 1;
  while (cursor < end) {
    size_t quote = json.find("\"", cursor);
    if (quote == std::string::npos || quote >= end) break;
    size_t close = json.find("\"", quote + 1);
    if (close == std::string::npos || close > end) return false;
    values->push_back(json.substr(quote + 1, close - quote - 1));
    cursor = close + 1;
  }
  return !values->empty();
}

std::vector<std::string> ExtractObjects(const std::string &json,
                                        const std::string &array_key) {
  std::vector<std::string> objects;
  const std::string needle = "\"" + array_key + "\":";
  size_t pos = json.find(needle);
  if (pos == std::string::npos) return objects;
  pos = json.find("[", pos);
  if (pos == std::string::npos) return objects;

  int depth = 0;
  size_t object_start = std::string::npos;
  for (size_t i = pos + 1; i < json.size(); ++i) {
    if (json[i] == '{') {
      if (depth == 0) object_start = i;
      ++depth;
    } else if (json[i] == '}') {
      --depth;
      if (depth == 0 && object_start != std::string::npos) {
        objects.push_back(json.substr(object_start, i - object_start + 1));
        object_start = std::string::npos;
      }
    } else if (json[i] == ']' && depth == 0) {
      break;
    }
  }
  return objects;
}

}  // namespace

std::vector<std::string> SplitCommaList(const std::string &text) {
  std::vector<std::string> out;
  std::string field;
  std::istringstream in(text);
  while (std::getline(in, field, ',')) {
    out.push_back(Trim(field));
  }
  return out;
}

bool LoadFixtureFile(const std::string &path,
                     FixtureSet *fixture,
                     std::string *error) {
  fixture->entries.clear();
  std::ifstream in(path);
  if (!in.good()) {
    if (error) *error = "could not read fixture: " + path;
    return false;
  }

  std::set<std::string> keys;
  std::string line;
  int line_no = 0;
  while (std::getline(in, line)) {
    ++line_no;
    line = Trim(line);
    if (line.empty() || line[0] == '#') continue;
    std::istringstream fields(line);
    FixtureEntry entry;
    std::string dash;
    std::string day;
    std::string dusk;
    std::string night;
    fields >> entry.kind >> entry.name >> entry.width >> entry.height >>
        entry.anchor_x >> entry.anchor_y >> entry.repeat_x >> entry.repeat_y >>
        dash >> day >> dusk >> night;
    if (!fields || !fields.eof()) {
      if (error) {
        *error = "bad atlas fixture line " + std::to_string(line_no);
      }
      return false;
    }

    entry.kind = LowerAscii(entry.kind);
    if (entry.kind != "symbol" && entry.kind != "pattern" &&
        entry.kind != "line") {
      if (error) *error = "unsupported atlas fixture kind: " + entry.kind;
      return false;
    }
    if (entry.width <= 0 || entry.height <= 0) {
      if (error) *error = "fixture entry has non-positive size: " + entry.name;
      return false;
    }

    bool dash_ok = false;
    entry.dash = ParseDash(dash, &dash_ok);
    if (!dash_ok) {
      if (error) *error = "bad dash pattern for fixture entry: " + entry.name;
      return false;
    }
    if (!ParseHexColor(day, &entry.palette_colors["day"]) ||
        !ParseHexColor(dusk, &entry.palette_colors["dusk"]) ||
        !ParseHexColor(night, &entry.palette_colors["night"])) {
      if (error) *error = "bad palette color for fixture entry: " + entry.name;
      return false;
    }

    const std::string key = entry.kind + ":" + entry.name;
    if (!keys.insert(key).second) {
      if (error) *error = "duplicate atlas fixture key: " + key;
      return false;
    }
    fixture->entries.push_back(entry);
  }
  if (fixture->entries.empty()) {
    if (error) *error = "fixture has no atlas entries";
    return false;
  }
  return true;
}

bool BuildAtlas(const FixtureSet &fixture,
                const std::vector<std::string> &palettes,
                AtlasBuildResult *result,
                std::string *error) {
  result->manifest = AtlasManifest();
  result->manifest.palettes = palettes;
  result->images.clear();

  std::vector<FixtureEntry> entries = fixture.entries;
  std::sort(entries.begin(), entries.end(), EntryLess);

  const std::vector<std::string> kinds = {"symbol", "pattern", "line"};
  std::set<std::string> emitted_keys;
  for (const std::string &palette : palettes) {
    for (const std::string &kind : kinds) {
      std::vector<const FixtureEntry *> subset;
      for (const FixtureEntry &entry : entries) {
        if (entry.kind == kind) subset.push_back(&entry);
      }
      if (subset.empty()) continue;

      AtlasImage atlas;
      atlas.kind = kind;
      atlas.palette = palette;
      atlas.image = "s52_" + KindPlural(kind) + "_" + palette + ".ppm";
      atlas.format = "ppm-p3";
      atlas.width = kAtlasWidth;

      int x = 0;
      int y = 0;
      int row_height = 0;
      std::vector<AtlasEntry> new_entries;
      for (const FixtureEntry *src : subset) {
        std::map<std::string, Rgb>::const_iterator color =
            src->palette_colors.find(palette);
        if (color == src->palette_colors.end()) {
          if (error) {
            *error = "fixture entry missing palette " + palette + ": " +
                     src->name;
          }
          return false;
        }
        if (src->width > kAtlasWidth) {
          if (error) *error = "fixture entry wider than atlas: " + src->name;
          return false;
        }
        if (x + src->width > kAtlasWidth) {
          x = 0;
          y += row_height;
          row_height = 0;
        }

        AtlasEntry entry;
        entry.name = src->name;
        entry.kind = src->kind;
        entry.palette = palette;
        entry.atlas = atlas.image;
        entry.pixel_rect = Rect(x, y, src->width, src->height);
        entry.anchor_x = src->anchor_x;
        entry.anchor_y = src->anchor_y;
        entry.repeat_x = src->repeat_x;
        entry.repeat_y = src->repeat_y;
        entry.dash = src->dash;
        entry.color = color->second;

        x += src->width;
        if (src->height > row_height) row_height = src->height;
        new_entries.push_back(entry);
      }

      atlas.height = y + row_height;
      if (atlas.height <= 0) atlas.height = 1;
      std::vector<Rgb> pixels(static_cast<size_t>(atlas.width * atlas.height),
                              Rgb(0, 0, 0));
      for (AtlasEntry &entry : new_entries) {
        entry.uv_rect.u0 = static_cast<double>(entry.pixel_rect.x) /
                           static_cast<double>(atlas.width);
        entry.uv_rect.v0 = static_cast<double>(entry.pixel_rect.y) /
                           static_cast<double>(atlas.height);
        entry.uv_rect.u1 =
            static_cast<double>(entry.pixel_rect.x + entry.pixel_rect.width) /
            static_cast<double>(atlas.width);
        entry.uv_rect.v1 =
            static_cast<double>(entry.pixel_rect.y + entry.pixel_rect.height) /
            static_cast<double>(atlas.height);

        if (entry.kind == "line") {
          DrawLineStyle(&pixels, atlas.width, entry.pixel_rect, entry.dash,
                        entry.color);
        } else {
          FillRect(&pixels, atlas.width, entry.pixel_rect, entry.color);
        }

        const std::string key =
            entry.name + ":" + entry.kind + ":" + entry.palette;
        if (!emitted_keys.insert(key).second) {
          if (error) *error = "duplicate atlas manifest key: " + key;
          return false;
        }
        result->manifest.entries.push_back(entry);
      }

      result->manifest.atlases.push_back(atlas);
      result->images[atlas.image] = pixels;
    }
  }
  return true;
}

bool WriteAtlasArtifacts(const AtlasBuildResult &result,
                         const std::string &output_dir,
                         std::string *error) {
  if (!EnsureDir(output_dir, error)) return false;
  for (const AtlasImage &atlas : result.manifest.atlases) {
    std::map<std::string, std::vector<Rgb> >::const_iterator image =
        result.images.find(atlas.image);
    if (image == result.images.end()) {
      if (error) *error = "missing generated image buffer: " + atlas.image;
      return false;
    }
    if (!WritePpm(JoinPath(output_dir, atlas.image), atlas.width, atlas.height,
                  image->second, error)) {
      return false;
    }
  }
  return WriteManifest(result.manifest,
                       JoinPath(output_dir, "s52_atlas_manifest.json"),
                       error);
}

bool LoadManifest(const std::string &path,
                  AtlasManifest *manifest,
                  std::string *error) {
  std::string json;
  if (!ReadFile(path, &json, error)) return false;

  manifest->atlases.clear();
  manifest->entries.clear();
  if (!ExtractStringArray(json, "palettes", &manifest->palettes)) {
    if (error) *error = "could not parse palette list from manifest";
    return false;
  }

  for (const std::string &object : ExtractObjects(json, "atlases")) {
    AtlasImage atlas;
    if (!ExtractString(object, "kind", &atlas.kind) ||
        !ExtractString(object, "palette", &atlas.palette) ||
        !ExtractString(object, "image", &atlas.image) ||
        !ExtractString(object, "format", &atlas.format) ||
        !ExtractInt(object, "width", &atlas.width) ||
        !ExtractInt(object, "height", &atlas.height)) {
      if (error) *error = "could not parse atlas object from manifest";
      return false;
    }
    manifest->atlases.push_back(atlas);
  }

  for (const std::string &object : ExtractObjects(json, "entries")) {
    AtlasEntry entry;
    std::vector<int> rect;
    std::vector<int> anchor;
    std::vector<int> repeat;
    std::vector<int> color;
    if (!ExtractString(object, "name", &entry.name) ||
        !ExtractString(object, "kind", &entry.kind) ||
        !ExtractString(object, "palette", &entry.palette) ||
        !ExtractString(object, "atlas", &entry.atlas) ||
        !ExtractIntArray(object, "pixel_rect", &rect) || rect.size() != 4 ||
        !ExtractIntArray(object, "anchor", &anchor) || anchor.size() != 2 ||
        !ExtractIntArray(object, "repeat", &repeat) || repeat.size() != 2 ||
        !ExtractIntArray(object, "dash", &entry.dash) ||
        !ExtractIntArray(object, "color", &color) || color.size() != 3) {
      if (error) *error = "could not parse entry object from manifest";
      return false;
    }
    entry.pixel_rect = Rect(rect[0], rect[1], rect[2], rect[3]);
    entry.anchor_x = anchor[0];
    entry.anchor_y = anchor[1];
    entry.repeat_x = repeat[0];
    entry.repeat_y = repeat[1];
    entry.color = Rgb(color[0], color[1], color[2]);
    manifest->entries.push_back(entry);
  }

  if (manifest->atlases.empty() || manifest->entries.empty()) {
    if (error) *error = "manifest has no atlas images or entries";
    return false;
  }
  return true;
}

const AtlasEntry *FindEntry(const AtlasManifest &manifest,
                            const std::string &name,
                            const std::string &kind,
                            const std::string &palette) {
  for (const AtlasEntry &entry : manifest.entries) {
    if (entry.name == name && entry.kind == kind &&
        entry.palette == palette) {
      return &entry;
    }
  }
  return nullptr;
}

}  // namespace s52
}  // namespace helm

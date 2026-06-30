#pragma once

#include <map>
#include <string>
#include <vector>

namespace helm {
namespace s52 {

struct Rgb {
  int r = 0;
  int g = 0;
  int b = 0;

  Rgb() {}
  Rgb(int red, int green, int blue) : r(red), g(green), b(blue) {}
};

struct FixtureEntry {
  std::string kind;
  std::string name;
  int width = 0;
  int height = 0;
  int anchor_x = 0;
  int anchor_y = 0;
  int repeat_x = 0;
  int repeat_y = 0;
  std::vector<int> dash;
  std::map<std::string, Rgb> palette_colors;
};

struct FixtureSet {
  std::vector<FixtureEntry> entries;
};

struct Rect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  Rect() {}
  Rect(int left, int top, int w, int h)
      : x(left), y(top), width(w), height(h) {}
};

struct UvRect {
  double u0 = 0.0;
  double v0 = 0.0;
  double u1 = 0.0;
  double v1 = 0.0;
};

struct AtlasImage {
  std::string kind;
  std::string palette;
  std::string image;
  std::string format;
  int width = 0;
  int height = 0;
};

struct AtlasEntry {
  std::string name;
  std::string kind;
  std::string palette;
  std::string atlas;
  Rect pixel_rect;
  UvRect uv_rect;
  int anchor_x = 0;
  int anchor_y = 0;
  int repeat_x = 0;
  int repeat_y = 0;
  std::vector<int> dash;
  Rgb color;
};

struct AtlasManifest {
  int schema_version = 1;
  std::vector<std::string> palettes;
  std::vector<AtlasImage> atlases;
  std::vector<AtlasEntry> entries;
};

struct AtlasBuildResult {
  AtlasManifest manifest;
  std::map<std::string, std::vector<Rgb> > images;
};

bool LoadFixtureFile(const std::string &path,
                     FixtureSet *fixture,
                     std::string *error);

bool BuildAtlas(const FixtureSet &fixture,
                const std::vector<std::string> &palettes,
                AtlasBuildResult *result,
                std::string *error);

bool WriteAtlasArtifacts(const AtlasBuildResult &result,
                         const std::string &output_dir,
                         std::string *error);

bool LoadManifest(const std::string &path,
                  AtlasManifest *manifest,
                  std::string *error);

const AtlasEntry *FindEntry(const AtlasManifest &manifest,
                            const std::string &name,
                            const std::string &kind,
                            const std::string &palette);

std::vector<std::string> SplitCommaList(const std::string &text);

}  // namespace s52
}  // namespace helm

#include "helm_s52_atlas.h"

#include <cstdlib>
#include <iostream>
#include <set>
#include <string>

namespace {

void Fail(const std::string &message) {
  std::cerr << "FAIL s52-atlas-smoke: " << message << "\n";
  std::exit(1);
}

void Check(bool condition, const std::string &message) {
  if (!condition) Fail(message);
}

bool InBounds(const helm::s52::AtlasEntry &entry,
              const helm::s52::AtlasManifest &manifest) {
  for (const helm::s52::AtlasImage &atlas : manifest.atlases) {
    if (atlas.image != entry.atlas) continue;
    return entry.pixel_rect.x >= 0 && entry.pixel_rect.y >= 0 &&
           entry.pixel_rect.width > 0 && entry.pixel_rect.height > 0 &&
           entry.pixel_rect.x + entry.pixel_rect.width <= atlas.width &&
           entry.pixel_rect.y + entry.pixel_rect.height <= atlas.height;
  }
  return false;
}

std::string JoinPath(const std::string &dir, const std::string &file) {
  if (dir.empty() || dir == ".") return file;
  if (dir[dir.size() - 1] == '/') return dir + file;
  return dir + "/" + file;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: helm-s52-atlas-smoke <fixture> <output-dir>\n";
    return 2;
  }

  const std::string fixture_path = argv[1];
  const std::string output_dir = argv[2];
  std::string error;

  helm::s52::FixtureSet fixture;
  Check(helm::s52::LoadFixtureFile(fixture_path, &fixture, &error), error);

  helm::s52::AtlasBuildResult result;
  const std::vector<std::string> palettes =
      helm::s52::SplitCommaList("day,dusk,night");
  Check(helm::s52::BuildAtlas(fixture, palettes, &result, &error), error);
  Check(result.manifest.atlases.size() == 9,
        "expected 9 atlas images: 3 kinds x 3 palettes");
  Check(result.manifest.entries.size() == 9,
        "expected 9 atlas entries: 3 assets x 3 palettes");
  Check(helm::s52::WriteAtlasArtifacts(result, output_dir, &error), error);

  helm::s52::AtlasManifest loaded;
  Check(helm::s52::LoadManifest(JoinPath(output_dir, "s52_atlas_manifest.json"),
                                &loaded, &error),
        error);
  Check(loaded.atlases.size() == 9, "loaded manifest atlas count mismatch");
  Check(loaded.entries.size() == 9, "loaded manifest entry count mismatch");

  std::set<std::string> keys;
  for (const helm::s52::AtlasEntry &entry : loaded.entries) {
    const std::string key =
        entry.name + ":" + entry.kind + ":" + entry.palette;
    Check(keys.insert(key).second, "duplicate loaded manifest key: " + key);
    Check(InBounds(entry, loaded), "entry rect outside atlas: " + key);
  }

  const helm::s52::AtlasEntry *symbol =
      helm::s52::FindEntry(loaded, "BOYSPP", "symbol", "day");
  Check(symbol != nullptr, "missing BOYSPP day symbol");
  Check(symbol->anchor_x == 6 && symbol->anchor_y == 6,
        "BOYSPP anchor did not survive manifest load");

  const helm::s52::AtlasEntry *pattern =
      helm::s52::FindEntry(loaded, "DEPARE01", "pattern", "night");
  Check(pattern != nullptr, "missing DEPARE01 night pattern");
  Check(pattern->repeat_x == 8 && pattern->repeat_y == 8,
        "pattern repeat metadata did not survive manifest load");

  const helm::s52::AtlasEntry *line =
      helm::s52::FindEntry(loaded, "DEPCNT02", "line", "dusk");
  Check(line != nullptr, "missing DEPCNT02 dusk line style");
  Check(line->dash.size() == 2 && line->dash[0] == 3 && line->dash[1] == 2,
        "line dash metadata did not survive manifest load");

  const helm::s52::AtlasEntry *symbol_night =
      helm::s52::FindEntry(loaded, "BOYSPP", "symbol", "night");
  Check(symbol_night != nullptr, "missing BOYSPP night symbol");
  Check(symbol->color.r != symbol_night->color.r ||
            symbol->color.g != symbol_night->color.g ||
            symbol->color.b != symbol_night->color.b,
        "day/night palette variants collapsed to the same color");

  std::cout << "ok s52-atlas-smoke: " << loaded.entries.size()
            << " entries, " << loaded.atlases.size() << " atlas images\n";
  return 0;
}

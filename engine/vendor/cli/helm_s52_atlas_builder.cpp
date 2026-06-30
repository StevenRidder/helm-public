#include "helm_s52_atlas.h"

#include <iostream>
#include <string>
#include <vector>

namespace {

void Usage() {
  std::cerr << "usage: helm-s52-atlas-builder --input <fixture> "
               "--output <dir> [--palettes day,dusk,night]\n";
}

}  // namespace

int main(int argc, char **argv) {
  std::string input;
  std::string output;
  std::vector<std::string> palettes =
      helm::s52::SplitCommaList("day,dusk,night");

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--input" && i + 1 < argc) {
      input = argv[++i];
    } else if (arg == "--output" && i + 1 < argc) {
      output = argv[++i];
    } else if (arg == "--palettes" && i + 1 < argc) {
      palettes = helm::s52::SplitCommaList(argv[++i]);
    } else if (arg == "--help" || arg == "-h") {
      Usage();
      return 0;
    } else {
      Usage();
      return 2;
    }
  }

  if (input.empty() || output.empty() || palettes.empty()) {
    Usage();
    return 2;
  }

  std::string error;
  helm::s52::FixtureSet fixture;
  if (!helm::s52::LoadFixtureFile(input, &fixture, &error)) {
    std::cerr << "helm-s52-atlas-builder: " << error << "\n";
    return 1;
  }

  helm::s52::AtlasBuildResult result;
  if (!helm::s52::BuildAtlas(fixture, palettes, &result, &error)) {
    std::cerr << "helm-s52-atlas-builder: " << error << "\n";
    return 1;
  }

  if (!helm::s52::WriteAtlasArtifacts(result, output, &error)) {
    std::cerr << "helm-s52-atlas-builder: " << error << "\n";
    return 1;
  }

  std::cout << "ok s52-atlas: " << result.manifest.entries.size()
            << " entries, " << result.manifest.atlases.size()
            << " atlas images\n";
  return 0;
}

#include "text_placement.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

[[nodiscard]] std::string read_file(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot read " + path.string());
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

void usage() {
  std::cerr << "usage: vulkan-text-placement <scene.commands.json> [--json]\n";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2 || argc > 3) {
    usage();
    return 2;
  }

  const std::filesystem::path scene_path = argv[1];
  const bool print_json = argc == 3 && std::string(argv[2]) == "--json";
  if (argc == 3 && !print_json) {
    usage();
    return 2;
  }

  try {
    helm::vulkan::TextPlacementPlan plan =
        helm::vulkan::BuildTextPlacementPlanFromSceneJson(read_file(scene_path));
    if (print_json) {
      std::cout << helm::vulkan::TextPlacementPlanToJson(plan);
      return 0;
    }

    std::string error;
    if (!helm::vulkan::ValidateTextPlacementSmoke(plan, &error)) {
      std::cerr << "FAIL vulkan-text-placement: " << error << "\n";
      std::cerr << helm::vulkan::TextPlacementPlanToJson(plan);
      return 1;
    }

    std::cout << "ok vulkan-text-placement: " << plan.placements.size()
              << " placements, " << plan.resource_needs.size()
              << " resource need, " << plan.diagnostics.size()
              << " diagnostics\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL vulkan-text-placement: " << e.what() << "\n";
    return 1;
  }
}

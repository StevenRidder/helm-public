#include "resource_plan.h"

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
  std::cerr << "usage: vulkan-resource-plan <scene.commands.json> [--json] [--smoke]\n";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    usage();
    return 2;
  }

  const std::filesystem::path scene_path = argv[1];
  bool print_json = false;
  bool smoke_fixture = false;
  for (int i = 2; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--json") {
      print_json = true;
    } else if (arg == "--smoke") {
      smoke_fixture = true;
    } else {
      usage();
      return 2;
    }
  }

  try {
    helm::vulkan::RenderResourcePlan plan =
        helm::vulkan::BuildResourcePlanFromSceneJson(read_file(scene_path));
    std::string error;
    if (print_json) {
      if (!helm::vulkan::ValidateResourcePlan(plan, &error)) {
        std::cerr << "FAIL vulkan-resource-plan: " << error << "\n";
        return 1;
      }
      std::cout << helm::vulkan::RenderResourcePlanToJson(plan);
      return 0;
    }

    const bool valid = smoke_fixture
                           ? helm::vulkan::ValidateResourcePlanSmoke(plan, &error)
                           : helm::vulkan::ValidateResourcePlan(plan, &error);
    if (!valid) {
      std::cerr << "FAIL vulkan-resource-plan: " << error << "\n";
      std::cerr << helm::vulkan::RenderResourcePlanToJson(plan);
      return 1;
    }

    std::cout << "ok vulkan-resource-plan: " << plan.batches.size()
              << " batches, " << plan.atlas_regions.size()
              << " atlas/resource regions, " << plan.diagnostics.size()
              << " diagnostics\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL vulkan-resource-plan: " << e.what() << "\n";
    return 1;
  }
}

// VulkanSceneGraph swapchain/viewport proof for VSG-3.
//
// This executable keeps the fixture replay renderer dependency-free while
// proving the interactive VSG path separately: read the fixture PPM, upload it
// as a VSG texture, open a small swapchain window, present a scripted sequence
// of viewport resize and pan/zoom states, and emit a deterministic report.

#include <vsg/all.h>

#if defined(__APPLE__)
#include <vulkan/vulkan_macos.h>

#import <Cocoa/Cocoa.h>
#import <QuartzCore/CAMetalLayer.h>
#endif

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Rgba {
  unsigned char r = 0;
  unsigned char g = 0;
  unsigned char b = 0;
  unsigned char a = 255;
};

struct RgbaImage {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<Rgba> pixels;
};

struct ViewportFrame {
  std::string name;
  int32_t x = 0;
  int32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  double pan_x = 0.0;
  double pan_y = 0.0;
  double zoom = 1.0;
};

struct ProjectionBounds {
  double left = 0.0;
  double right = 0.0;
  double bottom = 0.0;
  double top = 0.0;
};

struct InteractiveWindow {
  vsg::ref_ptr<vsg::Window> window;
  std::string adapter;
#if defined(__APPLE__)
  NSWindow* native_window = nil;
  NSView* native_view = nil;
#endif
};

[[nodiscard]] std::string next_ppm_token(std::istream& in) {
  std::string token;
  while (in >> token) {
    if (!token.empty() && token[0] == '#') {
      std::string discard;
      std::getline(in, discard);
      continue;
    }
    return token;
  }
  throw std::runtime_error("unexpected end of PPM");
}

[[nodiscard]] RgbaImage read_ppm(const std::filesystem::path& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot read " + path.string());
  if (next_ppm_token(in) != "P3") throw std::runtime_error(path.string() + ": expected P3 PPM");

  const uint32_t width = static_cast<uint32_t>(std::stoul(next_ppm_token(in)));
  const uint32_t height = static_cast<uint32_t>(std::stoul(next_ppm_token(in)));
  const int max_value = std::stoi(next_ppm_token(in));
  if (width == 0 || height == 0) throw std::runtime_error(path.string() + ": image dimensions must be positive");
  if (max_value <= 0) throw std::runtime_error(path.string() + ": invalid max value");

  RgbaImage image;
  image.width = width;
  image.height = height;
  image.pixels.resize(static_cast<size_t>(width) * height);

  for (auto& pixel : image.pixels) {
    const int r = std::stoi(next_ppm_token(in));
    const int g = std::stoi(next_ppm_token(in));
    const int b = std::stoi(next_ppm_token(in));
    auto scale = [max_value](int value) {
      value = std::max(0, std::min(max_value, value));
      return static_cast<unsigned char>((value * 255 + max_value / 2) / max_value);
    };
    pixel = Rgba{scale(r), scale(g), scale(b), 255};
  }

  return image;
}

[[nodiscard]] RgbaImage scaled_to(const RgbaImage& image, uint32_t width, uint32_t height) {
  if (width == 0 || height == 0) throw std::runtime_error("target size must be positive");
  RgbaImage out;
  out.width = width;
  out.height = height;
  out.pixels.resize(static_cast<size_t>(width) * height);
  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t src_y = std::min(image.height - 1, (y * image.height) / height);
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t src_x = std::min(image.width - 1, (x * image.width) / width);
      out.pixels[static_cast<size_t>(y) * width + x] = image.pixels[static_cast<size_t>(src_y) * image.width + src_x];
    }
  }
  return out;
}

[[nodiscard]] vsg::ref_ptr<vsg::Data> to_vsg_image(const RgbaImage& image) {
  auto data = vsg::ubvec4Array2D::create(image.width, image.height, vsg::Data::Properties{VK_FORMAT_R8G8B8A8_UNORM});
  data->properties.origin = vsg::TOP_LEFT;
  for (uint32_t y = 0; y < image.height; ++y) {
    for (uint32_t x = 0; x < image.width; ++x) {
      const auto& pixel = image.pixels[static_cast<size_t>(y) * image.width + x];
      data->set(x, y, vsg::ubvec4{pixel.r, pixel.g, pixel.b, pixel.a});
    }
  }
  return data;
}

[[nodiscard]] vsg::ref_ptr<vsg::Node> create_textured_quad(vsg::ref_ptr<vsg::Data> texture_data,
                                                            vsg::ref_ptr<vsg::Options> options) {
  auto sampler = vsg::Sampler::create();
  sampler->magFilter = VK_FILTER_NEAREST;
  sampler->minFilter = VK_FILTER_NEAREST;
  sampler->mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;
  sampler->addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
  sampler->addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
  sampler->maxLod = 0.0f;

  auto shader_set = vsg::createFlatShadedShaderSet(options);
  auto config = vsg::GraphicsPipelineConfigurator::create(shader_set);
  config->assignTexture("diffuseMap", texture_data, sampler);

  auto vertices = vsg::vec3Array::create({
      {-1.0f, 0.0f, -1.0f},
      {1.0f, 0.0f, -1.0f},
      {1.0f, 0.0f, 1.0f},
      {-1.0f, 0.0f, 1.0f},
  });
  auto normals = vsg::vec3Array::create({{0.0f, -1.0f, 0.0f}});
  auto texcoords = vsg::vec2Array::create({
      {0.0f, 1.0f},
      {1.0f, 1.0f},
      {1.0f, 0.0f},
      {0.0f, 0.0f},
  });
  auto colors = vsg::vec4Value::create(vsg::vec4{1.0f, 1.0f, 1.0f, 1.0f});
  auto indices = vsg::ushortArray::create({0, 1, 2, 2, 3, 0});

  vsg::DataList vertex_arrays;
  config->assignArray(vertex_arrays, "vsg_Vertex", VK_VERTEX_INPUT_RATE_VERTEX, vertices);
  config->assignArray(vertex_arrays, "vsg_Normal", VK_VERTEX_INPUT_RATE_INSTANCE, normals);
  config->assignArray(vertex_arrays, "vsg_TexCoord0", VK_VERTEX_INPUT_RATE_VERTEX, texcoords);
  config->assignArray(vertex_arrays, "vsg_Color", VK_VERTEX_INPUT_RATE_INSTANCE, colors);

  auto draw = vsg::Commands::create();
  draw->addChild(vsg::BindVertexBuffers::create(config->baseAttributeBinding, vertex_arrays));
  draw->addChild(vsg::BindIndexBuffer::create(indices));
  draw->addChild(vsg::DrawIndexed::create(6, 1, 0, 0, 0));

  config->init();
  auto state_group = vsg::StateGroup::create();
  config->copyTo(state_group);
  state_group->addChild(draw);
  return state_group;
}

[[nodiscard]] std::vector<ViewportFrame> scripted_frames(uint32_t window_width, uint32_t window_height) {
  const uint32_t inset_width = std::max<uint32_t>(64, window_width * 3 / 4);
  const uint32_t inset_height = std::max<uint32_t>(64, window_height * 3 / 4);
  const int32_t inset_x = static_cast<int32_t>((window_width - inset_width) / 2);
  const int32_t inset_y = static_cast<int32_t>((window_height - inset_height) / 2);

  return {
      {"initial-full-viewport", 0, 0, window_width, window_height, 0.0, 0.0, 1.0},
      {"viewport-resize-inset", inset_x, inset_y, inset_width, inset_height, 0.0, 0.0, 1.0},
      {"pan-east-south", 0, 0, window_width, window_height, 0.28, -0.18, 1.0},
      {"zoom-in-pan-held", inset_x, inset_y, inset_width, inset_height, 0.28, -0.18, 0.58},
  };
}

[[nodiscard]] ProjectionBounds projection_bounds(const ViewportFrame& frame) {
  const double aspect = static_cast<double>(frame.width) / static_cast<double>(frame.height);
  const double half_height = frame.zoom;
  const double half_width = frame.zoom * aspect;
  return ProjectionBounds{frame.pan_x - half_width, frame.pan_x + half_width,
                          frame.pan_y - half_height, frame.pan_y + half_height};
}

void apply_frame(vsg::ref_ptr<vsg::Camera> camera, const ViewportFrame& frame) {
  const ProjectionBounds bounds = projection_bounds(frame);
  camera->projectionMatrix = vsg::Orthographic::create(bounds.left, bounds.right, bounds.bottom, bounds.top, 0.1, 10.0);
  if (!camera->viewportState) {
    camera->viewportState = vsg::ViewportState::create(frame.x, frame.y, frame.width, frame.height);
  } else {
    camera->viewportState->set(frame.x, frame.y, frame.width, frame.height);
  }
}

[[nodiscard]] vsg::ref_ptr<vsg::WindowTraits> create_window_traits(uint32_t window_width, uint32_t window_height) {
  auto window_traits = vsg::WindowTraits::create(window_width, window_height, "Helm VSG-3 swapchain probe");
  window_traits->x = 64;
  window_traits->y = 64;
  window_traits->decoration = false;
  window_traits->hdpi = false;
  window_traits->swapchainPreferences.presentMode = VK_PRESENT_MODE_FIFO_KHR;
  window_traits->swapchainPreferences.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
  return window_traits;
}

#if defined(__APPLE__)
void pump_macos_events() {
  @autoreleasepool {
    for (;;) {
      NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                         untilDate:[NSDate distantPast]
                                            inMode:NSDefaultRunLoopMode
                                           dequeue:YES];
      if (!event) break;
      [NSApp sendEvent:event];
    }
  }
}

[[nodiscard]] InteractiveWindow create_macos_adapter_window(vsg::ref_ptr<vsg::WindowTraits> window_traits) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

    const NSRect content_rect =
        NSMakeRect(window_traits->x, window_traits->y, window_traits->width, window_traits->height);
    NSWindow* ns_window = [[NSWindow alloc] initWithContentRect:content_rect
                                                      styleMask:NSWindowStyleMaskBorderless
                                                        backing:NSBackingStoreBuffered
                                                          defer:NO];
    if (!ns_window) throw std::runtime_error("could not create NSWindow for VSG adapter");
    [ns_window setReleasedWhenClosed:NO];
    [ns_window setTitle:[NSString stringWithUTF8String:window_traits->windowTitle.c_str()]];
    [ns_window setOpaque:YES];
    [ns_window setBackgroundColor:[NSColor blackColor]];

    NSView* ns_view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, window_traits->width, window_traits->height)];
    if (!ns_view) throw std::runtime_error("could not create NSView for VSG adapter");
    [ns_view setWantsLayer:YES];

    CAMetalLayer* metal_layer = [[CAMetalLayer alloc] init];
    if (!metal_layer) throw std::runtime_error("could not create CAMetalLayer for VSG adapter");
    [metal_layer setContentsScale:1.0];
    [metal_layer setDrawableSize:CGSizeMake(window_traits->width, window_traits->height)];
    [ns_view setLayer:metal_layer];
    [ns_window setContentView:ns_view];
    [ns_window orderFrontRegardless];
    [ns_window displayIfNeeded];

    vsg::Names instance_extensions{VK_KHR_SURFACE_EXTENSION_NAME, VK_MVK_MACOS_SURFACE_EXTENSION_NAME};
    auto instance = vsg::Instance::create(instance_extensions, vsg::Names{}, VK_API_VERSION_1_0);
    if (!instance) throw std::runtime_error("could not create Vulkan instance for macOS VSG adapter");

    auto create_surface = reinterpret_cast<PFN_vkCreateMacOSSurfaceMVK>(
        vkGetInstanceProcAddr(*instance, "vkCreateMacOSSurfaceMVK"));
    if (!create_surface) throw std::runtime_error("vkCreateMacOSSurfaceMVK is not available");

    VkMacOSSurfaceCreateInfoMVK surface_info = {};
    surface_info.sType = VK_STRUCTURE_TYPE_MACOS_SURFACE_CREATE_INFO_MVK;
    surface_info.pView = ns_view;

    VkSurfaceKHR vk_surface = VK_NULL_HANDLE;
    const VkResult surface_result =
        create_surface(*instance, &surface_info, instance->getAllocationCallbacks(), &vk_surface);
    if (surface_result != VK_SUCCESS || vk_surface == VK_NULL_HANDLE) {
      throw std::runtime_error("vkCreateMacOSSurfaceMVK failed with VkResult " + std::to_string(surface_result));
    }

    auto surface = vsg::Surface::create(vk_surface, instance.get());
    auto adapter = vsg::WindowAdapter::create(surface, window_traits);
    adapter->windowValid = true;
    adapter->windowVisible = true;

    return InteractiveWindow{adapter, "macos-window-adapter", ns_window, ns_view};
  }
}
#endif

[[nodiscard]] InteractiveWindow create_interactive_window(uint32_t window_width, uint32_t window_height) {
  auto window_traits = create_window_traits(window_width, window_height);

#if defined(VSG_SUPPORTS_Windowing) && VSG_SUPPORTS_Windowing
  auto native_window = vsg::Window::create(window_traits);
  if (native_window && native_window->valid()) {
    return InteractiveWindow{native_window, "vsg-native"};
  }
#endif

#if defined(__APPLE__)
  return create_macos_adapter_window(window_traits);
#else
  throw std::runtime_error("this VSG build has no native window backend and no platform adapter is available");
#endif
}

[[nodiscard]] std::string present_interactive_sequence(vsg::ref_ptr<vsg::Data> texture_data,
                                                        uint32_t texture_size,
                                                        uint32_t window_width,
                                                        uint32_t window_height) {
  auto options = vsg::Options::create();
  options->sharedObjects = vsg::SharedObjects::create();

  auto interactive_window = create_interactive_window(window_width, window_height);
  auto window = interactive_window.window;
  if (!window || !window->valid()) throw std::runtime_error("could not create VSG swapchain window");

  auto swapchain = window->getOrCreateSwapchain();
  if (!swapchain || swapchain->getImageViews().empty()) throw std::runtime_error("VSG window did not create a swapchain");

  auto viewer = vsg::Viewer::create();
  viewer->addWindow(window);

  const auto frames = scripted_frames(window_width, window_height);
  auto scene = create_textured_quad(texture_data, options);
  auto look_at = vsg::LookAt::create(vsg::dvec3(0.0, -2.0, 0.0), vsg::dvec3(0.0, 0.0, 0.0), vsg::dvec3(0.0, 0.0, 1.0));
  auto camera = vsg::Camera::create(vsg::Orthographic::create(-1.0, 1.0, -1.0, 1.0, 0.1, 10.0), look_at,
                                    vsg::ViewportState::create(window->extent2D()));
  apply_frame(camera, frames.front());

  auto command_graph = vsg::createCommandGraphForView(window, camera, scene);
  viewer->assignRecordAndSubmitTaskAndPresentation({command_graph});
  viewer->compile();

  std::ostringstream report;
  report << "helm_vsg_interactive_probe v1\n";
  report << "texture=" << texture_size << "x" << texture_size << "\n";
  report << "window_adapter=" << interactive_window.adapter << "\n";
  report << "window_traits=" << window_width << "x" << window_height << " decoration=false hdpi=false present_mode=fifo\n";
  report << "swapchain_extent=" << swapchain->getExtent().width << "x" << swapchain->getExtent().height
         << " format=" << static_cast<int>(swapchain->getImageFormat())
         << " image_views=" << swapchain->getImageViews().size()
         << " window_frames=" << window->numFrames() << "\n";
  report << std::fixed << std::setprecision(3);

  for (size_t index = 0; index < frames.size(); ++index) {
    const auto& frame = frames[index];
    apply_frame(camera, frame);

    if (!viewer->advanceToNextFrame(static_cast<double>(index))) {
      throw std::runtime_error("VSG viewer stopped before scripted frame " + std::to_string(index));
    }
    viewer->handleEvents();
#if defined(__APPLE__)
    pump_macos_events();
#endif
    viewer->update();
    viewer->recordAndSubmit();
    viewer->present();

    const VkResult fence_result = viewer->waitForFences(0, 1000000000);
    if (fence_result != VK_SUCCESS) {
      throw std::runtime_error("VSG frame fence wait failed for frame " + std::to_string(index));
    }

    const ProjectionBounds bounds = projection_bounds(frame);
    report << "frame=" << index
           << " name=" << frame.name
           << " viewport=" << frame.x << "," << frame.y << "," << frame.width << "x" << frame.height
           << " pan=" << frame.pan_x << "," << frame.pan_y
           << " zoom=" << frame.zoom
           << " ortho=" << bounds.left << "," << bounds.right << "," << bounds.bottom << "," << bounds.top
           << " presented=true\n";
  }

  viewer->deviceWaitIdle();
  viewer->close();
#if defined(__APPLE__)
  if (interactive_window.native_window) [interactive_window.native_window close];
#endif
  return report.str();
}

void usage(const char* argv0) {
  std::cerr << "usage: " << argv0
            << " <fixture-dir> [--input <ppm>] [--texture-size N] [--window-width N] [--window-height N] [--report <path>]\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 2) {
      usage(argv[0]);
      return 2;
    }

    std::filesystem::path fixture_dir;
    std::optional<std::filesystem::path> input;
    std::optional<std::filesystem::path> report_path;
    uint32_t texture_size = 256;
    uint32_t window_width = 256;
    uint32_t window_height = 192;

    for (int i = 1; i < argc; ++i) {
      const std::string arg = argv[i];
      if (arg == "--input") {
        if (++i >= argc) throw std::runtime_error("--input requires a path");
        input = std::filesystem::path(argv[i]);
      } else if (arg == "--texture-size") {
        if (++i >= argc) throw std::runtime_error("--texture-size requires a positive integer");
        texture_size = static_cast<uint32_t>(std::stoul(argv[i]));
        if (texture_size == 0) throw std::runtime_error("--texture-size must be positive");
      } else if (arg == "--window-width") {
        if (++i >= argc) throw std::runtime_error("--window-width requires a positive integer");
        window_width = static_cast<uint32_t>(std::stoul(argv[i]));
      } else if (arg == "--window-height") {
        if (++i >= argc) throw std::runtime_error("--window-height requires a positive integer");
        window_height = static_cast<uint32_t>(std::stoul(argv[i]));
      } else if (arg == "--report") {
        if (++i >= argc) throw std::runtime_error("--report requires a path");
        report_path = std::filesystem::path(argv[i]);
      } else if (arg.rfind("--", 0) == 0) {
        throw std::runtime_error("unknown option: " + arg);
      } else if (fixture_dir.empty()) {
        fixture_dir = std::filesystem::path(arg);
      } else {
        throw std::runtime_error("unexpected argument: " + arg);
      }
    }

    if (fixture_dir.empty()) throw std::runtime_error("missing fixture directory");
    if (!input) input = fixture_dir / "expected.ppm";
    if (window_width < 96 || window_height < 96) throw std::runtime_error("window dimensions must be at least 96 pixels");

    const RgbaImage source = read_ppm(*input);
    const RgbaImage uploaded = scaled_to(source, texture_size, texture_size);
    const std::string report = present_interactive_sequence(to_vsg_image(uploaded), texture_size, window_width, window_height);

    if (report_path) {
      if (report_path->has_parent_path()) std::filesystem::create_directories(report_path->parent_path());
      std::ofstream out(*report_path);
      if (!out) throw std::runtime_error("cannot write " + report_path->string());
      out << report;
    } else {
      std::cout << report;
    }

    return 0;
  } catch (const std::exception& exc) {
    std::cerr << exc.what() << '\n';
    return 1;
  }
}

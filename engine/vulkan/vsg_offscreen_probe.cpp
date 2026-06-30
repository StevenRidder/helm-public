// Headless VulkanSceneGraph offscreen framebuffer/readback proof for VSG-2.
//
// This executable keeps the fixture replay renderer dependency-free while
// proving the VSG path separately: read a fixture PPM, upload it as a VSG
// texture, render it into a windowless framebuffer, copy the color attachment
// back to host-visible memory, and emit deterministic PNG bytes.
//
// Offscreen render-pass and readback plumbing follows the vsgExamples
// vsgheadless pattern, which is MIT licensed:
// Copyright(c) 2018 Robert Osfield
// Copyright(c) 2020 Tim Moore
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

#include <vsg/all.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
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
  out.push_back(0x78);
  out.push_back(0x01);

  size_t offset = 0;
  while (offset < data.size()) {
    const size_t remaining = data.size() - offset;
    const uint16_t len = static_cast<uint16_t>(std::min<size_t>(remaining, 65535));
    const bool final = offset + len == data.size();
    out.push_back(final ? 0x01 : 0x00);
    out.push_back(static_cast<unsigned char>(len & 0xff));
    out.push_back(static_cast<unsigned char>((len >> 8) & 0xff));
    const uint16_t nlen = static_cast<uint16_t>(~len);
    out.push_back(static_cast<unsigned char>(nlen & 0xff));
    out.push_back(static_cast<unsigned char>((nlen >> 8) & 0xff));
    out.insert(out.end(), data.begin() + static_cast<std::ptrdiff_t>(offset),
               data.begin() + static_cast<std::ptrdiff_t>(offset + len));
    offset += len;
  }

  append_be32(out, adler32_bytes(data));
  return out;
}

[[nodiscard]] std::vector<unsigned char> png_bytes(const RgbaImage& image) {
  std::vector<unsigned char> filtered;
  filtered.reserve(static_cast<size_t>(image.height) * (1 + static_cast<size_t>(image.width) * 3));
  for (uint32_t y = 0; y < image.height; ++y) {
    filtered.push_back(0);
    for (uint32_t x = 0; x < image.width; ++x) {
      const auto& pixel = image.pixels[static_cast<size_t>(y) * image.width + x];
      filtered.push_back(pixel.r);
      filtered.push_back(pixel.g);
      filtered.push_back(pixel.b);
    }
  }

  std::vector<unsigned char> out = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  std::vector<unsigned char> ihdr;
  append_be32(ihdr, image.width);
  append_be32(ihdr, image.height);
  ihdr.push_back(8);
  ihdr.push_back(2);
  ihdr.push_back(0);
  ihdr.push_back(0);
  ihdr.push_back(0);
  append_png_chunk(out, "IHDR", ihdr);
  append_png_chunk(out, "IDAT", zlib_store_blocks(filtered));
  append_png_chunk(out, "IEND", {});
  return out;
}

[[nodiscard]] vsg::ref_ptr<vsg::RenderPass> create_offscreen_render_pass(vsg::Device* device, VkFormat image_format) {
  auto color_attachment = vsg::defaultColorAttachment(image_format);
  color_attachment.finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;

  vsg::AttachmentReference color_ref = {};
  color_ref.attachment = 0;
  color_ref.layout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;

  vsg::SubpassDescription subpass = {};
  subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
  subpass.colorAttachments.emplace_back(color_ref);

  vsg::SubpassDependency color_dependency = {};
  color_dependency.srcSubpass = VK_SUBPASS_EXTERNAL;
  color_dependency.dstSubpass = 0;
  color_dependency.srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
  color_dependency.dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
  color_dependency.srcAccessMask = 0;
  color_dependency.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;

  return vsg::RenderPass::create(device, vsg::RenderPass::Attachments{color_attachment},
                                 vsg::RenderPass::Subpasses{subpass},
                                 vsg::RenderPass::Dependencies{color_dependency});
}

[[nodiscard]] vsg::ref_ptr<vsg::ImageView> create_color_image_view(vsg::ref_ptr<vsg::Device> device,
                                                                    const VkExtent2D& extent,
                                                                    VkFormat image_format) {
  auto image = vsg::Image::create();
  image->imageType = VK_IMAGE_TYPE_2D;
  image->format = image_format;
  image->extent = VkExtent3D{extent.width, extent.height, 1};
  image->mipLevels = 1;
  image->arrayLayers = 1;
  image->samples = VK_SAMPLE_COUNT_1_BIT;
  image->tiling = VK_IMAGE_TILING_OPTIMAL;
  image->usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
  image->initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
  image->sharingMode = VK_SHARING_MODE_EXCLUSIVE;

  return vsg::createImageView(device, image, VK_IMAGE_ASPECT_COLOR_BIT);
}

[[nodiscard]] std::pair<vsg::ref_ptr<vsg::Commands>, vsg::ref_ptr<vsg::Image>> create_color_capture(
    vsg::ref_ptr<vsg::Device> device,
    const VkExtent2D& extent,
    vsg::ref_ptr<vsg::Image> source_image,
    VkFormat image_format) {
  auto destination_image = vsg::Image::create();
  destination_image->imageType = VK_IMAGE_TYPE_2D;
  destination_image->format = image_format;
  destination_image->extent = VkExtent3D{extent.width, extent.height, 1};
  destination_image->arrayLayers = 1;
  destination_image->mipLevels = 1;
  destination_image->initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
  destination_image->samples = VK_SAMPLE_COUNT_1_BIT;
  destination_image->tiling = VK_IMAGE_TILING_LINEAR;
  destination_image->usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT;
  destination_image->sharingMode = VK_SHARING_MODE_EXCLUSIVE;
  destination_image->compile(device);

  auto memory = vsg::DeviceMemory::create(device, destination_image->getMemoryRequirements(device->deviceID),
                                          VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  destination_image->bind(memory, 0);

  auto commands = vsg::Commands::create();
  auto destination_to_transfer = vsg::ImageMemoryBarrier::create(
      0, VK_ACCESS_TRANSFER_WRITE_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
      VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, destination_image,
      VkImageSubresourceRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1});
  auto source_to_transfer = vsg::ImageMemoryBarrier::create(
      VK_ACCESS_MEMORY_READ_BIT, VK_ACCESS_TRANSFER_READ_BIT, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
      VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, source_image,
      VkImageSubresourceRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1});

  commands->addChild(vsg::PipelineBarrier::create(VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0,
                                                  destination_to_transfer, source_to_transfer));

  VkImageCopy region = {};
  region.srcSubresource.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
  region.srcSubresource.layerCount = 1;
  region.dstSubresource.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
  region.dstSubresource.layerCount = 1;
  region.extent = VkExtent3D{extent.width, extent.height, 1};

  auto copy = vsg::CopyImage::create();
  copy->srcImage = source_image;
  copy->srcImageLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  copy->dstImage = destination_image;
  copy->dstImageLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
  copy->regions.push_back(region);
  commands->addChild(copy);

  auto destination_to_read = vsg::ImageMemoryBarrier::create(
      VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_MEMORY_READ_BIT, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
      VK_IMAGE_LAYOUT_GENERAL, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, destination_image,
      VkImageSubresourceRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1});
  commands->addChild(vsg::PipelineBarrier::create(VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0,
                                                  destination_to_read));

  return {commands, destination_image};
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

[[nodiscard]] RgbaImage readback_image(vsg::ref_ptr<vsg::Device> device,
                                       vsg::ref_ptr<vsg::Image> image,
                                       const VkExtent2D& extent) {
  VkImageSubresource subresource{VK_IMAGE_ASPECT_COLOR_BIT, 0, 0};
  VkSubresourceLayout layout;
  vkGetImageSubresourceLayout(*device, image->vk(device->deviceID), &subresource, &layout);

  auto memory = image->getDeviceMemory(device->deviceID);
  auto mapped = vsg::MappedData<vsg::ubyteArray>::create(
      memory, layout.offset, 0, vsg::Data::Properties{image->format},
      static_cast<uint32_t>(layout.rowPitch * extent.height));
  const auto* bytes = static_cast<const unsigned char*>(mapped->dataPointer());

  RgbaImage out;
  out.width = extent.width;
  out.height = extent.height;
  out.pixels.resize(static_cast<size_t>(extent.width) * extent.height);
  for (uint32_t y = 0; y < extent.height; ++y) {
    const unsigned char* row = bytes + static_cast<size_t>(y) * layout.rowPitch;
    for (uint32_t x = 0; x < extent.width; ++x) {
      const unsigned char* px = row + static_cast<size_t>(x) * 4;
      out.pixels[static_cast<size_t>(y) * extent.width + x] = Rgba{px[0], px[1], px[2], px[3]};
    }
  }
  return out;
}

[[nodiscard]] RgbaImage render_vsg_offscreen(vsg::ref_ptr<vsg::Data> texture_data, uint32_t tile_size) {
  const VkExtent2D extent{tile_size, tile_size};
  constexpr VkFormat image_format = VK_FORMAT_R8G8B8A8_UNORM;

  auto options = vsg::Options::create();
  options->sharedObjects = vsg::SharedObjects::create();

  auto instance = vsg::Instance::create(vsg::Names{}, vsg::Names{}, VK_API_VERSION_1_0);
  auto physical_and_queue = instance->getPhysicalDeviceAndQueueFamily(VK_QUEUE_GRAPHICS_BIT);
  auto physical_device = physical_and_queue.first;
  const int queue_family = physical_and_queue.second;
  if (!physical_device || queue_family < 0) throw std::runtime_error("no Vulkan graphics queue available");

  vsg::QueueSettings queue_settings{vsg::QueueSetting{queue_family, {1.0}}};
  auto features = vsg::DeviceFeatures::create();
  auto device = vsg::Device::create(physical_device, queue_settings, vsg::Names{}, vsg::Names{}, features);

  auto color_view = create_color_image_view(device, extent, image_format);
  auto render_pass = create_offscreen_render_pass(device, image_format);
  auto framebuffer = vsg::Framebuffer::create(render_pass, vsg::ImageViews{color_view}, extent.width, extent.height, 1);

  auto scene = create_textured_quad(texture_data, options);
  auto projection = vsg::Orthographic::create(-1.0, 1.0, -1.0, 1.0, 0.1, 10.0);
  auto look_at = vsg::LookAt::create(vsg::dvec3(0.0, -2.0, 0.0), vsg::dvec3(0.0, 0.0, 0.0), vsg::dvec3(0.0, 0.0, 1.0));
  auto camera = vsg::Camera::create(projection, look_at, vsg::ViewportState::create(extent));

  auto render_graph = vsg::RenderGraph::create();
  render_graph->framebuffer = framebuffer;
  render_graph->renderArea.offset = {0, 0};
  render_graph->renderArea.extent = extent;
  render_graph->setClearValues({{0.0f, 0.0f, 0.0f, 1.0f}});
  render_graph->addChild(vsg::View::create(camera, scene));

  vsg::ref_ptr<vsg::Commands> capture_commands;
  vsg::ref_ptr<vsg::Image> capture_image;
  std::tie(capture_commands, capture_image) = create_color_capture(device, extent, color_view->image, image_format);

  auto command_graph = vsg::CommandGraph::create(device, queue_family);
  command_graph->addChild(render_graph);
  command_graph->addChild(capture_commands);

  auto viewer = vsg::Viewer::create();
  viewer->assignRecordAndSubmitTaskAndPresentation(vsg::CommandGraphs{command_graph});
  viewer->compile();
  if (!viewer->advanceToNextFrame()) throw std::runtime_error("VSG viewer did not advance");
  viewer->handleEvents();
  viewer->update();
  viewer->recordAndSubmit();
  viewer->waitForFences(0, 1000000000);

  return readback_image(device, capture_image, extent);
}

void usage(const char* argv0) {
  std::cerr << "usage: " << argv0
            << " <fixture-dir> [--input <ppm>] [--tile-size N] [--output <png>]\n";
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
    std::optional<std::filesystem::path> output;
    uint32_t tile_size = 256;

    for (int i = 1; i < argc; ++i) {
      const std::string arg = argv[i];
      if (arg == "--input") {
        if (++i >= argc) throw std::runtime_error("--input requires a path");
        input = std::filesystem::path(argv[i]);
      } else if (arg == "--output") {
        if (++i >= argc) throw std::runtime_error("--output requires a path");
        output = std::filesystem::path(argv[i]);
      } else if (arg == "--tile-size") {
        if (++i >= argc) throw std::runtime_error("--tile-size requires a positive integer");
        tile_size = static_cast<uint32_t>(std::stoul(argv[i]));
        if (tile_size == 0) throw std::runtime_error("--tile-size must be positive");
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

    const RgbaImage source = read_ppm(*input);
    const RgbaImage uploaded = scaled_to(source, tile_size, tile_size);
    const RgbaImage rendered = render_vsg_offscreen(to_vsg_image(uploaded), tile_size);
    const std::vector<unsigned char> png = png_bytes(rendered);

    if (output) {
      if (output->has_parent_path()) std::filesystem::create_directories(output->parent_path());
      std::ofstream out(*output, std::ios::binary);
      if (!out) throw std::runtime_error("cannot write " + output->string());
      out.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
    } else {
      std::cout.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
    }

    return 0;
  } catch (const std::exception& exc) {
    std::cerr << exc.what() << '\n';
    return 1;
  }
}

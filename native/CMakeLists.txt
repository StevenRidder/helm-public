cmake_minimum_required(VERSION 3.20)

project(HelmNativeCore VERSION 0.1.0 LANGUAGES CXX)

option(HELM_NATIVE_BUILD_TESTS "Build Helm native-core tests" ON)

add_library(helm_native_core STATIC
  src/nav_state.cpp)
add_library(Helm::NativeCore ALIAS helm_native_core)

target_include_directories(helm_native_core
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)

target_compile_features(helm_native_core PUBLIC cxx_std_17)

if(MSVC)
  target_compile_options(helm_native_core PRIVATE /W4 /permissive-)
else()
  target_compile_options(helm_native_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(APPLE)
  set_target_properties(helm_native_core PROPERTIES
    XCODE_ATTRIBUTE_SKIP_INSTALL YES
    XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED NO)
endif()

if(HELM_NATIVE_BUILD_TESTS)
  enable_testing()

  add_executable(helm_native_core_tests
    tests/nav_state_test.cpp)
  target_link_libraries(helm_native_core_tests PRIVATE Helm::NativeCore)

  if(MSVC)
    target_compile_options(helm_native_core_tests PRIVATE /W4 /permissive-)
  else()
    target_compile_options(helm_native_core_tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()

  add_test(NAME helm_native_core_tests COMMAND helm_native_core_tests)
endif()


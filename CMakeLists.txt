cmake_minimum_required(VERSION 3.21)

# Configures your project.
project(native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PROJECT_ROOT_DIR ${CMAKE_CURRENT_SOURCE_DIR})
cmake_path(ABSOLUTE_PATH PROJECT_ROOT_DIR NORMALIZE)

# Imports the MōBrowser app configuration and setups the auxiliary targets, resources, etc.
# Important: Do not move this include above the project declaration.
include(${PROJECT_ROOT_DIR}/node_modules/@mobrowser/native/cmake/MoBrowser.cmake)

# The source files of your app.
set(APP_SOURCES
        src/native/main.cc
        src/native/temperature_probe.h
        src/native/temperature_probe.cc)

# Defines the main target of the application.
add_library(mobrowser_lib STATIC ${APP_SOURCES} ${GENERATED_SOURCES})

target_include_directories(mobrowser_lib PUBLIC
        ${PROJECT_SOURCE_DIR}/src/native
        ${PROJECT_SOURCE_DIR}/src/native/gen
        ${MOBROWSER_SDK_NATIVE_DIR}/include
        ${protobuf_SOURCE_DIR}/src
        ${protobuf_SOURCE_DIR}/third_party/utf8_range
        ${absl_SOURCE_DIR})

# The CPU-temperature probe reads the private IOKit HID temperature sensors, so
# the native module links IOKit and CoreFoundation. The network probe uses only
# libSystem (POSIX) and needs no framework.
target_link_libraries(mobrowser_lib PRIVATE
        "-framework IOKit"
        "-framework CoreFoundation")

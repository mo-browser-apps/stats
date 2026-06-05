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
        src/native/temperature_probe.cc
        src/native/processes/process_collector.h
        src/native/processes/process_collector.cc
        src/native/processes/app_metadata.h
        src/native/processes/app_metadata.mm)

# The AppKit/NSWorkspace bridge uses Objective-C objects while rasterizing icons.
# Scope ARC to this Objective-C++ file so native C++ sources stay unchanged.
set_source_files_properties(src/native/processes/app_metadata.mm
        PROPERTIES COMPILE_OPTIONS "-fobjc-arc")

# Defines the main target of the application.
add_library(mobrowser_lib STATIC ${APP_SOURCES} ${GENERATED_SOURCES})

target_include_directories(mobrowser_lib PUBLIC
        ${PROJECT_SOURCE_DIR}/src/native
        ${PROJECT_SOURCE_DIR}/src/native/gen
        ${MOBROWSER_SDK_NATIVE_DIR}/include
        ${protobuf_SOURCE_DIR}/src
        ${protobuf_SOURCE_DIR}/third_party/utf8_range
        ${absl_SOURCE_DIR})

# Framework links: IOKit + CoreFoundation for the CPU-temperature HID sensor
# probe, and AppKit for the NSWorkspace GUI-app icon/metadata enrichment in the
# process collector. The network probe uses only libSystem (POSIX).
target_link_libraries(mobrowser_lib PRIVATE
        "-framework IOKit"
        "-framework CoreFoundation"
        "-framework AppKit")

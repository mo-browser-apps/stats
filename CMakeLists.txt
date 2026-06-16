cmake_minimum_required(VERSION 3.21)

# Configures your project.
if(APPLE)
    project(native LANGUAGES CXX OBJCXX)
else()
    project(native LANGUAGES CXX)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PROJECT_ROOT_DIR ${CMAKE_CURRENT_SOURCE_DIR})
cmake_path(ABSOLUTE_PATH PROJECT_ROOT_DIR NORMALIZE)

# Imports the MoBrowser app configuration and sets up the auxiliary targets, resources, etc.
# Important: Do not move this include above the project declaration.
include(${PROJECT_ROOT_DIR}/node_modules/@mobrowser/native/cmake/MoBrowser.cmake)

# The source files of your app. The native implementation is macOS-only; on
# other platforms CI still builds the generated Protobuf/RPC glue used by
# TypeScript checks.
if(APPLE)
    set(APP_SOURCES
            src/native/main.cc
            src/native/metrics/memory_probe.h
            src/native/metrics/memory_probe.cc
            src/native/metrics/network_probe.h
            src/native/metrics/network_probe.cc
            src/native/metrics/temperature_probe.h
            src/native/metrics/temperature_probe.cc
            src/native/processes/process_collector.h
            src/native/processes/process_collector.cc
            src/native/processes/app_metadata.h
            src/native/processes/app_metadata.mm
            src/native/processes/responsiveness.h
            src/native/processes/responsiveness.cc)

    # The AppKit/NSWorkspace bridge uses Objective-C objects while rasterizing
    # icons. Scope ARC to this Objective-C++ file so native C++ sources stay
    # unchanged.
    set_source_files_properties(src/native/processes/app_metadata.mm
            PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
endif()

# Defines the main target of the application.
add_library(mobrowser_lib STATIC ${APP_SOURCES} ${GENERATED_SOURCES})

if(APPLE)
    # The native sources hand-roll kernel ABI structs and parse raw sysctl
    # buffers; keep the standard warning set on for them.
    target_compile_options(mobrowser_lib PRIVATE -Wall -Wextra)
endif()

target_include_directories(mobrowser_lib PUBLIC
        ${PROJECT_SOURCE_DIR}/src/native
        ${PROJECT_SOURCE_DIR}/src/native/gen
        ${MOBROWSER_SDK_NATIVE_DIR}/include
        ${protobuf_SOURCE_DIR}/src
        ${protobuf_SOURCE_DIR}/third_party/utf8_range
        ${absl_SOURCE_DIR})

# Framework links: IOKit + CoreFoundation for the CPU-temperature probe (AppleSMC
# core keys plus the HID CPU-core sensors), and AppKit for the NSWorkspace
# GUI-app icon/metadata enrichment in the process collector. The network probe
# uses only libSystem (POSIX). ApplicationServices contributes no link-time
# symbols (the responsiveness probe resolves its private CGS/Process Manager
# entry points with dlsym), but linking it guarantees the HIServices image is
# loaded so GetProcessForPID resolves at runtime.
if(APPLE)
    target_link_libraries(mobrowser_lib PRIVATE
            "-framework IOKit"
            "-framework CoreFoundation"
            "-framework AppKit"
            "-framework ApplicationServices")
endif()

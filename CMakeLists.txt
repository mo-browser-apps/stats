cmake_minimum_required(VERSION 3.21)

# Configures your project. MoStats is a macOS-only utility, so the native module
# already targets Apple unconditionally (IOKit/CoreFoundation for the temperature
# probe). Objective-C++ is enabled for the NSWorkspace process app-metadata/icon
# enricher (the only Objective-C++ in the module); everything else is plain C++.
project(native LANGUAGES CXX OBJCXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PROJECT_ROOT_DIR ${CMAKE_CURRENT_SOURCE_DIR})
cmake_path(ABSOLUTE_PATH PROJECT_ROOT_DIR NORMALIZE)

# Imports the MōBrowser app configuration and setups the auxiliary targets, resources, etc.
# Important: Do not move this include above the project declaration.
include(${PROJECT_ROOT_DIR}/node_modules/@mobrowser/native/cmake/MoBrowser.cmake)

# The source files of your app. The process collector has a plain-C++ core
# (libproc/sysctl/proc_pid_rusage) plus one Objective-C++ NSWorkspace enricher.
set(APP_SOURCES
        src/native/main.cc
        src/native/temperature_probe.h
        src/native/temperature_probe.cc
        src/native/processes/native_availability.cc
        src/native/processes/libproc_process_enumerator.cc
        src/native/processes/process_arguments_reader.cc
        src/native/processes/process_metrics_reader.cc
        src/native/processes/workspace_app_enricher.mm
        src/native/processes/native_process_collector.cc
        src/native/processes/process_collector_service.cc)

# Defines the main target of the application.
add_library(mobrowser_lib STATIC ${APP_SOURCES} ${GENERATED_SOURCES})

target_include_directories(mobrowser_lib PUBLIC
        ${PROJECT_SOURCE_DIR}/src/native
        ${PROJECT_SOURCE_DIR}/src/native/gen
        ${MOBROWSER_SDK_NATIVE_DIR}/include
        ${protobuf_SOURCE_DIR}/src
        ${protobuf_SOURCE_DIR}/third_party/utf8_range
        ${absl_SOURCE_DIR})

# Framework links: IOKit/CoreFoundation for the CPU-temperature HID probe, and
# AppKit for the NSWorkspace process app-metadata/icon enricher. The network and
# core process probes use only libSystem (POSIX/libproc) and need no framework.
target_link_libraries(mobrowser_lib PRIVATE
        "-framework IOKit"
        "-framework CoreFoundation"
        "-framework AppKit")

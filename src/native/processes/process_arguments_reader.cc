#include "processes/process_arguments_reader.h"

#include <sys/sysctl.h>

#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

#include "processes/native_availability.h"

namespace mostats::processes {
namespace {

// Guards the parser against a corrupt argc that would over-allocate.
constexpr int kMaximumReasonableArgCount = 4096;

NativeProcessArguments UnavailableArguments(
    const NativeAvailabilityReason availability) {
  NativeProcessArguments result;
  result.availability = availability;
  return result;
}

// Joins argv with single spaces for a display-ready command line.
std::string JoinArgumentsForDisplay(const std::vector<std::string>& arguments) {
  std::string display_text;
  for (const std::string& argument : arguments) {
    if (!display_text.empty()) {
      display_text += ' ';
    }
    display_text += argument;
  }
  return display_text;
}

// Finds the next NUL at or after `start`, returning its absolute offset.
bool FindNullTerminator(const char* data,
                        const size_t size,
                        const size_t start,
                        size_t* terminator) {
  if (start >= size) {
    return false;
  }
  const void* found = std::memchr(data + start, '\0', size - start);
  if (found == nullptr) {
    return false;
  }
  *terminator = static_cast<const char*>(found) - data;
  return true;
}

// Reads KERN_ARGMAX, the buffer size KERN_PROCARGS2 needs.
NativeAvailabilityReason ReadArgumentBufferSize(int* argument_buffer_size) {
  int mib[] = {CTL_KERN, KERN_ARGMAX};
  size_t size = sizeof(*argument_buffer_size);
  errno = 0;
  if (sysctl(mib, 2, argument_buffer_size, &size, nullptr, 0) != 0) {
    return AvailabilityFromErrno(errno);
  }
  if (*argument_buffer_size <= 0) {
    return NATIVE_AVAILABILITY_REASON_UNAVAILABLE;
  }
  return NATIVE_AVAILABILITY_REASON_AVAILABLE;
}

}  // namespace

NativeProcessArguments ProcessArgumentsReader::Read(const pid_t pid) const {
  int argument_buffer_size = 0;
  const NativeAvailabilityReason size_availability =
      ReadArgumentBufferSize(&argument_buffer_size);
  if (size_availability != NATIVE_AVAILABILITY_REASON_AVAILABLE) {
    return UnavailableArguments(size_availability);
  }

  std::vector<char> buffer(static_cast<size_t>(argument_buffer_size));
  size_t buffer_size = buffer.size();
  int mib[] = {CTL_KERN, KERN_PROCARGS2, static_cast<int>(pid)};

  errno = 0;
  if (sysctl(mib, 3, buffer.data(), &buffer_size, nullptr, 0) != 0) {
    return UnavailableArguments(AvailabilityFromErrno(errno));
  }

  return ParseKernProcArgs2Buffer(buffer.data(), buffer_size);
}

// KERN_PROCARGS2 layout: [int argc][exec path\0][padding NULs][argv[0]\0]...
NativeProcessArguments ProcessArgumentsReader::ParseKernProcArgs2Buffer(
    const char* data,
    const size_t size) {
  if (data == nullptr || size < sizeof(int)) {
    return UnavailableArguments(NATIVE_AVAILABILITY_REASON_PARSE_FAILED);
  }

  int argument_count = 0;
  std::memcpy(&argument_count, data, sizeof(argument_count));
  // Every real process has at least argv[0]; argc <= 0 means the buffer was not
  // the expected KERN_PROCARGS2 layout, so treat it as a parse failure rather
  // than an available-but-empty command line.
  if (argument_count <= 0 || argument_count > kMaximumReasonableArgCount) {
    return UnavailableArguments(NATIVE_AVAILABILITY_REASON_PARSE_FAILED);
  }

  // Skip the leading argc and the executable path string that follows it.
  size_t offset = sizeof(argument_count);
  size_t terminator = 0;
  if (!FindNullTerminator(data, size, offset, &terminator)) {
    return UnavailableArguments(NATIVE_AVAILABILITY_REASON_PARSE_FAILED);
  }

  // Skip the NUL padding between the exec path and argv[0].
  offset = terminator + 1;
  while (offset < size && data[offset] == '\0') {
    ++offset;
  }

  std::vector<std::string> arguments;
  arguments.reserve(static_cast<size_t>(argument_count));
  for (int index = 0; index < argument_count; ++index) {
    if (!FindNullTerminator(data, size, offset, &terminator)) {
      return UnavailableArguments(NATIVE_AVAILABILITY_REASON_PARSE_FAILED);
    }
    arguments.emplace_back(data + offset, terminator - offset);
    offset = terminator + 1;
  }

  NativeProcessArguments result;
  result.availability = NATIVE_AVAILABILITY_REASON_AVAILABLE;
  result.arguments = std::move(arguments);
  result.display_text = JoinArgumentsForDisplay(result.arguments);
  return result;
}

}  // namespace mostats::processes

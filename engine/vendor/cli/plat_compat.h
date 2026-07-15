#pragma once
// -----------------------------------------------------------------------------
// plat_compat.h - small file/process portability helpers for the Helm daemons.
// Covers the handful of POSIX-only calls outside the socket layer (popen, access,
// and a unique temp-path helper). Directory creation and file removal use
// std::filesystem directly at the call sites. See docs/proposals/WINDOWS-PORT.md.
// -----------------------------------------------------------------------------

#include <string>
#include <cstdio>
#include <atomic>
#include <ctime>
#include <filesystem>
#include <system_error>

#ifdef _WIN32
  #include <io.h>
  #define HELM_POPEN  _popen
  #define HELM_PCLOSE _pclose
  inline int helm_access_r(const char* p) { return _access(p, 4); }   // 4 == R_OK
#else
  #include <unistd.h>
  #define HELM_POPEN  popen
  #define HELM_PCLOSE pclose
  inline int helm_access_r(const char* p) { return ::access(p, R_OK); }
#endif

// Portable replacement for mkstemp-style scratch paths: a unique file path under
// the system temp dir. Does NOT create the file (callers write it themselves).
inline std::string helm_temp_path(const std::string& prefix, const std::string& ext) {
  static std::atomic<std::uint64_t> ctr{0};
  std::error_code ec;
  std::filesystem::path dir = std::filesystem::temp_directory_path(ec);
  if (ec) dir = ".";
  std::string name = prefix + std::to_string((std::uint64_t)std::time(nullptr)) + "-" +
                     std::to_string(ctr.fetch_add(1)) + ext;
  return (dir / name).string();
}

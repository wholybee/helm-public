#pragma once
// -----------------------------------------------------------------------------
// net_compat.h - cross-platform raw-socket shim for the Helm daemons.
//
// The HTTP/WebSocket server itself rides IXWebSocket (already cross-platform), so
// this shim only covers the hand-rolled raw-socket NMEA/AIS *feed* paths that were
// written against POSIX. On POSIX it is a thin pass-through; on Windows it maps to
// Winsock2. See docs/proposals/WINDOWS-PORT.md (Phase 1).
//
// IMPORTANT: include this BEFORE <windows.h> / any wx header. On Windows it pulls
// <winsock2.h> first (with WIN32_LEAN_AND_MEAN) so a later <windows.h> cannot drag
// in the incompatible winsock v1 and break the build.
// -----------------------------------------------------------------------------

#include <cstddef>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
  #define NOMINMAX
  #endif
  #ifndef _WINSOCK_DEPRECATED_NO_WARNINGS
  #define _WINSOCK_DEPRECATED_NO_WARNINGS   // inet_addr/gai_strerror are fine for our use
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <mutex>
  #pragma comment(lib, "ws2_32.lib")

  namespace helm_net {
    using sock_t = SOCKET;
    inline constexpr sock_t BAD_SOCK = INVALID_SOCKET;

    // Winsock needs one-time process init. Idempotent (WSAStartup is refcounted).
    inline void init() {
      static std::once_flag once;
      std::call_once(once, [] { WSADATA w; ::WSAStartup(MAKEWORD(2, 2), &w); });
    }
    inline int  close_sock(sock_t s)                 { return ::closesocket(s); }
    inline int  poll(pollfd* f, unsigned long n, int ms) { return ::WSAPoll(f, n, ms); }
    inline long recv_bytes(sock_t s, void* b, size_t n)  { return ::recv(s, (char*)b, (int)n, 0); }
    inline bool set_nonblock(sock_t s, bool on)      { u_long m = on ? 1u : 0u; return ::ioctlsocket(s, FIONBIO, &m) == 0; }
    inline bool would_block()                        { int e = ::WSAGetLastError(); return e == WSAEWOULDBLOCK; }
    inline bool in_progress()                        { int e = ::WSAGetLastError(); return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS; }
    inline bool interrupted()                        { return false; } // no EINTR on Winsock
    inline int  last_error()                         { return ::WSAGetLastError(); }
    // SO_ERROR / SO_RCVTIMEO / SO_REUSEADDR wrappers: Winsock takes char* optvals,
    // and SO_RCVTIMEO is a DWORD of milliseconds (not struct timeval).
    inline int  so_error(sock_t s)                   { int e = 0; int sl = sizeof e; ::getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&e, &sl); return e; }
    inline void set_rcv_timeout(sock_t s, int secs)  { DWORD ms = (DWORD)secs * 1000; ::setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&ms, sizeof ms); }
    inline void set_reuseaddr(sock_t s)              { int yes = 1; ::setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof yes); }
  }
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <netdb.h>
  #include <poll.h>
  #include <fcntl.h>
  #include <unistd.h>
  #include <sys/time.h>
  #include <cerrno>

  namespace helm_net {
    using sock_t = int;
    inline constexpr sock_t BAD_SOCK = -1;

    inline void init() {}
    inline int  close_sock(sock_t s)                 { return ::close(s); }
    inline int  poll(pollfd* f, unsigned long n, int ms) { return ::poll(f, (nfds_t)n, ms); }
    inline long recv_bytes(sock_t s, void* b, size_t n)  { return ::recv(s, b, n, 0); }
    inline bool set_nonblock(sock_t s, bool on) {
      int fl = ::fcntl(s, F_GETFL, 0); if (fl < 0) return false;
      fl = on ? (fl | O_NONBLOCK) : (fl & ~O_NONBLOCK);
      return ::fcntl(s, F_SETFL, fl) == 0;
    }
    inline bool would_block()                        { return errno == EAGAIN || errno == EWOULDBLOCK; }
    inline bool in_progress()                        { return errno == EINPROGRESS; }
    inline bool interrupted()                        { return errno == EINTR; }
    inline int  last_error()                         { return errno; }
    inline int  so_error(sock_t s)                   { int e = 0; socklen_t sl = sizeof e; ::getsockopt(s, SOL_SOCKET, SO_ERROR, &e, &sl); return e; }
    inline void set_rcv_timeout(sock_t s, int secs)  { timeval tv{secs, 0}; ::setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); }
    inline void set_reuseaddr(sock_t s)              { int yes = 1; ::setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes); }
  }
#endif

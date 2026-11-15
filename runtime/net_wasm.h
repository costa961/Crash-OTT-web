#pragma once
// The browser build's virtual LAN (runtime/net_wasm.cpp): UDP datagrams between the players' browsers through the
// page (web/src/net.ts) and the server's switch (tools/netswitch.mjs), each browser with an address of its own
// (10.77.x.y). crashott-pc's online code (online/mp_net.cpp, mp_lobby.cpp) keeps its BSD socket calls: the
// patch (patches/crashott-pc-web.patch) points the few it makes at these.

#include <cstddef>
#include <cstdint>
#include <string>

#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>

// What WASI preview 1's headers may leave out (only these calls take them, and they ignore them).
#ifndef SO_BROADCAST
#define SO_BROADCAST 6
#endif
#ifndef IPPROTO_UDP
#define IPPROTO_UDP 17
#endif
#ifndef INADDR_ANY
#define INADDR_ANY ((in_addr_t)0)
#endif

// One socket (the game opens one): a datagram socket bound to a port of this browser's address.
int vnet_socket(int domain, int type, int protocol);
int vnet_bind(int sock, const sockaddr* address, socklen_t size);
int vnet_setsockopt(int sock, int level, int name, const void* value, socklen_t size);
int vnet_getsockname(int sock, sockaddr* address, socklen_t* size);
// Waits (at most the timeout) for a datagram; 1 when one is there.
int vnet_select(int count, fd_set* read, fd_set* write, fd_set* error, timeval* timeout);
long vnet_recvfrom(int sock, void* buffer, size_t size, int flags, sockaddr* from, socklen_t* fromSize);
long vnet_sendto(int sock, const void* data, size_t size, int flags, const sockaddr* to, socklen_t toSize);
void vnet_close(int sock);
// This browser's address on the virtual LAN (host order; 0 until the switch gave one).
uint32_t vnet_local_ip();

namespace vnet
{
    // The page's connection to the switch: connected (it gave this browser an address), and why not.
    bool Connected();
    // Waits until the page is connected (at most `ms`); false if it never was.
    bool WaitConnected(uint32_t ms);
    // The session's state for the page's panel (a JSON object), and a command the page sent ("" = none).
    void SetStatus(const std::string& json);
    bool TakeCommand(std::string& command);
}

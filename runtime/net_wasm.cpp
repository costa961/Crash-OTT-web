// The virtual LAN's mailbox (net_wasm.h): datagrams between the runtime and the page, in shared memory.
// The page (web/src/net.ts) relays them to the server's switch (tools/netswitch.mjs) over a WebSocket.
//
// The block (WebNet, registered with the host through crashott.net_register), little-endian u32 words:
//   0 magic 'WNET'   4 version   8 state (page: 0 connecting, 1 connected, 2 failed)   12 this browser's address
//   16 TX head (runtime)   20 TX tail (page)   24 TX bell (runtime: +1 and a notify after queuing)
//   28 RX head (page)      32 RX tail (runtime) 36 RX bell (page: +1 and a notify after queuing)
//   40 status sequence (runtime)  44 its length  48.. the status (a JSON object for the page's panel)
//   STATUS_END: command sequence (page)  +4 its length  +8.. the command (text)
// then TX_SLOTS slots (runtime -> page) and RX_SLOTS slots (page -> runtime) of SLOT_BYTES:
//   u32 payload length, u32 the other end's address (TX: to, RX: from), u16 its port, u16 this end's port, payload.
// Both rings are single-producer single-consumer with free-running counters (slot = counter % slots); the
// runtime's producers (the game thread and the lobby's I/O thread both send) take a mutex.
#include "net_wasm.h"

#include "diagnostics.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>

#include <arpa/inet.h>

__attribute__((import_module("crashott"), import_name("net_register"))) extern "C" void crashott_net_register(uint32_t block);

namespace
{
    constexpr uint32_t MAGIC = 0x54454E57u, VERSION = 1;
    constexpr uint32_t STATUS_AT = 48, STATUS_BYTES = 4096, COMMAND_AT = STATUS_AT + STATUS_BYTES, COMMAND_BYTES = 1024;
    constexpr uint32_t HEADER_BYTES = 8192;
    constexpr uint32_t SLOT_BYTES = 1536, SLOT_HEADER = 12, MAX_PAYLOAD = SLOT_BYTES - SLOT_HEADER;
    constexpr uint32_t TX_SLOTS = 128, RX_SLOTS = 256;
    constexpr uint32_t BLOCK_BYTES = HEADER_BYTES + (TX_SLOTS + RX_SLOTS) * SLOT_BYTES;
    enum Word { W_MAGIC, W_VERSION, W_STATE, W_IP, W_TX_HEAD, W_TX_TAIL, W_TX_BELL, W_RX_HEAD, W_RX_TAIL, W_RX_BELL, W_STATUS_SEQ, W_STATUS_LEN };
    constexpr int SOCKET_FD = 77;  // the one socket's descriptor (any number the game never compares)

    uint8_t* g_block;
    std::mutex g_txMutex, g_statusMutex;
    int g_boundPort = 0;
    uint32_t g_commandSeen = 0;

    uint32_t* W(uint32_t word) { return reinterpret_cast<uint32_t*>(g_block) + word; }
    uint32_t Load(uint32_t word) { return __atomic_load_n(W(word), __ATOMIC_ACQUIRE); }
    void Store(uint32_t word, uint32_t v) { __atomic_store_n(W(word), v, __ATOMIC_RELEASE); }

    void Ensure()
    {
        static std::once_flag once;
        std::call_once(once, [] {
            g_block = static_cast<uint8_t*>(aligned_alloc(64, BLOCK_BYTES));
            memset(g_block, 0, BLOCK_BYTES);
            Store(W_VERSION, VERSION);
            Store(W_MAGIC, MAGIC);
            crashott_net_register(uint32_t(reinterpret_cast<uintptr_t>(g_block)));
            Log("[net] virtual LAN mailbox at 0x%08X (%u KB)", uint32_t(reinterpret_cast<uintptr_t>(g_block)), BLOCK_BYTES >> 10);
        });
    }

    uint8_t* TxSlot(uint32_t n) { return g_block + HEADER_BYTES + (n % TX_SLOTS) * SLOT_BYTES; }
    uint8_t* RxSlot(uint32_t n) { return g_block + HEADER_BYTES + TX_SLOTS * SLOT_BYTES + (n % RX_SLOTS) * SLOT_BYTES; }

    bool Send(uint32_t ip, uint16_t port, const void* data, size_t size)
    {
        Ensure();
        if (size > MAX_PAYLOAD || Load(W_STATE) != 1)
            return false;
        if ((ip >> 24) == 127)
            return false;  // the PC build also asks 127.0.0.1 (a host on this machine): none here
        std::lock_guard lock(g_txMutex);
        uint32_t head = Load(W_TX_HEAD), tail = Load(W_TX_TAIL);
        if (head - tail >= TX_SLOTS)
            return false;  // the page is behind: the datagram is lost, as UDP's would be
        uint8_t* slot = TxSlot(head);
        uint32_t words[2] = { uint32_t(size), ip };
        memcpy(slot, words, 8);
        uint16_t ports[2] = { port, uint16_t(g_boundPort) };
        memcpy(slot + 8, ports, 4);
        memcpy(slot + SLOT_HEADER, data, size);
        Store(W_TX_HEAD, head + 1);
        __atomic_fetch_add(W(W_TX_BELL), 1, __ATOMIC_RELEASE);
        __builtin_wasm_memory_atomic_notify(reinterpret_cast<int*>(W(W_TX_BELL)), 1);
        return true;
    }
}

int vnet_socket(int, int, int)
{
    Ensure();
    return SOCKET_FD;
}

int vnet_bind(int, const sockaddr* address, socklen_t)
{
    int port = ntohs(reinterpret_cast<const sockaddr_in*>(address)->sin_port);
    // Port 0: any free one (a client's); this browser's address has only this socket.
    g_boundPort = port ? port : 40000 + int(uint32_t(std::chrono::steady_clock::now().time_since_epoch().count()) % 20000);
    return 0;
}

int vnet_setsockopt(int, int, int, const void*, socklen_t) { return 0; }

int vnet_getsockname(int, sockaddr* address, socklen_t* size)
{
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(vnet_local_ip());
    local.sin_port = htons(uint16_t(g_boundPort));
    memcpy(address, &local, std::min<size_t>(*size, sizeof(local)));
    *size = sizeof(local);
    return 0;
}

int vnet_select(int, fd_set*, fd_set*, fd_set*, timeval* timeout)
{
    Ensure();
    int64_t ns = timeout ? int64_t(timeout->tv_sec) * 1000000000 + int64_t(timeout->tv_usec) * 1000 : -1;
    uint32_t bell = Load(W_RX_BELL);
    if (Load(W_RX_HEAD) != Load(W_RX_TAIL))
        return 1;
    __builtin_wasm_memory_atomic_wait32(reinterpret_cast<int*>(W(W_RX_BELL)), int(bell), ns);
    return Load(W_RX_HEAD) != Load(W_RX_TAIL) ? 1 : 0;
}

long vnet_recvfrom(int, void* buffer, size_t size, int, sockaddr* from, socklen_t* fromSize)
{
    Ensure();
    uint32_t tail = Load(W_RX_TAIL);
    if (Load(W_RX_HEAD) == tail)
        return -1;  // EWOULDBLOCK: the loop stops reading
    const uint8_t* slot = RxSlot(tail);
    uint32_t words[2];
    uint16_t ports[2];
    memcpy(words, slot, 8);
    memcpy(ports, slot + 8, 4);
    size_t got = std::min<size_t>(std::min<size_t>(words[0], MAX_PAYLOAD), size);
    memcpy(buffer, slot + SLOT_HEADER, got);
    Store(W_RX_TAIL, tail + 1);
    if (from && fromSize)
    {
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(words[1]);
        a.sin_port = htons(ports[0]);
        memcpy(from, &a, std::min<size_t>(*fromSize, sizeof(a)));
        *fromSize = sizeof(a);
    }
    return long(got);
}

long vnet_sendto(int, const void* data, size_t size, int, const sockaddr* to, socklen_t)
{
    const sockaddr_in* a = reinterpret_cast<const sockaddr_in*>(to);
    return Send(ntohl(a->sin_addr.s_addr), ntohs(a->sin_port), data, size) ? long(size) : -1;
}

void vnet_close(int)
{
    g_boundPort = 0;
}

uint32_t vnet_local_ip()
{
    Ensure();
    return Load(W_STATE) == 1 ? Load(W_IP) : 0;
}

namespace vnet
{
    bool Connected()
    {
        Ensure();
        return Load(W_STATE) == 1 && Load(W_IP) != 0;
    }

    bool WaitConnected(uint32_t ms)
    {
        for (uint32_t waited = 0; waited < ms; waited += 50)
        {
            if (Connected())
                return true;
            if (Load(W_STATE) == 2)
                return false;
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        return Connected();
    }

    void SetStatus(const std::string& json)
    {
        Ensure();
        std::lock_guard lock(g_statusMutex);
        size_t n = std::min<size_t>(json.size(), STATUS_BYTES);
        memcpy(g_block + STATUS_AT, json.data(), n);
        Store(W_STATUS_LEN, uint32_t(n));
        __atomic_fetch_add(W(W_STATUS_SEQ), 1, __ATOMIC_RELEASE);
    }

    bool TakeCommand(std::string& command)
    {
        Ensure();
        uint32_t* seq = reinterpret_cast<uint32_t*>(g_block + COMMAND_AT);
        uint32_t now = __atomic_load_n(seq, __ATOMIC_ACQUIRE);
        if (now == g_commandSeen)
            return false;
        g_commandSeen = now;
        uint32_t n = std::min<uint32_t>(__atomic_load_n(seq + 1, __ATOMIC_ACQUIRE), COMMAND_BYTES - 8);
        command.assign(reinterpret_cast<const char*>(g_block + COMMAND_AT + 8), n);
        return true;
    }
}

// Online co-op in the browser: crashott-pc's online code (online/, MIT) with the page in place of its
// MULTIPLAYER screens (online/mp_menu.cpp, drawn with the PC build's menu art, which the browser build doesn't
// have) and of its internet plumbing (online/mp_nat.cpp: UPnP, STUN; here every browser is on the server's
// virtual LAN, runtime/net_wasm.cpp).
//
// The session is the page's choice at start (CRASHOTT_MP = host | join, CRASHOTT_MP_NAME, CRASHOTT_MP_JOIN =
// the host's address on the virtual LAN): a host opens it (mp::lobby::Host) and plays as usual, a new game
// going to the HUB, and every level it starts is followed by the clients (mp::lobby::Join), who wait at the main
// menu. What mp_menu.cpp does on the game's side stays as it is (OverrideExit, from the frontend hook
// runtime/frontend_web.cpp; the pause and two-player hooks below). The page's panel reads the session's state
// (vnet::SetStatus, a JSON object) and sends commands (vnet::TakeCommand: leave, quit-level, resume).
#include "net_wasm.h"

#include "diagnostics.h"
#include "kernel/kernel.h"
#include "kernel/memory.h"
#include "online/mp.h"
#include "online/mp_lobby.h"
#include "online/mp_menu.h"
#include "online/mp_nat.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

PPC_EXTERN_FUNC(sub_820F5D58);  // Frontend:StartLevel(index)
extern "C" PPC_FUNC(__imp__sub_820F8918);  // Frontend:PauseGame(paused)
extern "C" PPC_FUNC(__imp__sub_821DAAB0);  // CFrontendManager::HaveBothPlayersJoinedGame
extern "C" PPC_FUNC(__imp__sub_821DB680);  // CFrontendManager::UpdateInputAndCheats
extern "C" PPC_FUNC(__imp__sub_8224E068);  // CStreamManager::vf05 (the level load)
extern "C" PPC_FUNC(__imp__sub_8224FAD8);  // CStreamManager::vf04 (the level unload)
PPC_EXTERN_FUNC(sub_823C9530);  // luaL_loadbuffer
PPC_EXTERN_FUNC(sub_822995E8);  // lua_pcall
PPC_EXTERN_FUNC(sub_82298360);  // lua_gettop
PPC_EXTERN_FUNC(sub_82298450);  // lua_settop
PPC_EXTERN_FUNC(sub_822989A0);  // lua_tostring
PPC_EXTERN_FUNC(sub_82298EA0);  // lua_pushcclosure
PPC_EXTERN_FUNC(sub_822992D0);  // lua_setfield

namespace mp::menu
{
    namespace
    {
        // The frontend's nodes and exits (online/mp_menu.cpp, Frontend.bfig).
        constexpr uint32_t NODE_MAIN_MENU = 70, NODE_OPTIONS = 99, NODE_NEW_GAME_FADE = 322, NODE_HUB = 575, NODE_IN_GAME = 630;
        constexpr int32_t EXIT_NEW_GAME = 88, EXIT_FIRST_LEVEL = 323, EXIT_TO_HUB = 309, EXIT_SKIP_TO_LEVEL = 51;
        constexpr uint32_t NODE_GAME_RUNNING = 638, NODE_PAUSE = 1081, NODE_LEAVING_LEVEL = 1088;
        constexpr uint32_t NODE_PAUSE_NO_SAVE = 1109, NODE_LEAVING_LEVEL_NO_SAVE = 1115;
        constexpr int32_t EXIT_DROP_OUT = 1098, EXIT_LEAVE_LEVEL = 1099, EXIT_SAVE_AND_EXIT = 1087;
        constexpr int32_t EXIT_DROP_OUT_NO_SAVE = 1123, EXIT_LEAVE_LEVEL_NO_SAVE = 1124, EXIT_EXIT_NO_SAVE = 1114;
        constexpr int32_t EXIT_CONTINUE_NO_SAVE = 1116;
        constexpr int32_t EXIT_HUB_WITHOUT_SAVING = 1179, EXIT_HUB_TO_MAIN_MENU = 598;
        constexpr int32_t EXIT_PAUSE = 651;
        constexpr uint32_t NODE_CINEMATICS = 655;
        constexpr int32_t FIRST_CUTSCENE_EXIT = 657, LAST_CUTSCENE_EXIT = 748;
        constexpr int32_t SAVE_EXITS[] = { 1090, 1091, 1177, 1178, 1185, 1186, 1199, 1200 };
        constexpr uint32_t MANAGERS = 0x824A7A24, LEVEL_INDEX = 24;

        std::atomic<bool> g_hostNewGame{ false };  // a hosted new game goes to the HUB
        enum class Leaving { None, Quit, ToLobby };
        std::atomic<bool> g_clientInLevel{ false };
        std::atomic<Leaving> g_leaving{ Leaving::None };
        std::atomic<bool> g_quitLevel{ false };       // the page's "leave": the client out of the level
        std::atomic<bool> g_levelMenu{ false };       // a client's START in a level: the page's menu shows
        std::atomic<bool> g_hostReachedHub{ false };
        // The host's level choice (the page's "level:N", crashott-pc's LEVEL row at the HUB): -1 = none.
        std::atomic<int32_t> g_hostGo{ -1 };
        bool g_cutsceneHold = false;
        std::atomic<uint32_t> g_node{ UINT32_MAX };
        std::atomic<uint64_t> g_nodeAt{ 0 };          // when the frontend last ran its conditions (InMenus)

        uint64_t Now() { return uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
        bool InSession(lobby::State s) { return s == lobby::State::Hosting || s == lobby::State::Joined; }
    }

    void Init() {}
    void RequestOpen() {}
    bool ReopensLobby() { return false; }
    void JoinInvite(const std::string&) {}
    bool BlocksGameInput() { return false; }
    bool TakesTouch() { return false; }
    uint16_t GameButtons() { return 0; }
    uint16_t HiddenButtons() { return 0; }
    bool PickerOpen() { return false; }
    int PreviewColour() { return -1; }

    // online/mp_menu.cpp's OverrideExit without its screens (the skin picker, Discord invites, the lobby over the
    // options screen): the hosted new game to the HUB, a client's level start, its way out, the host's level start
    // and return, the cutscenes that start together.
    int32_t OverrideExit(PPCContext& ctx, uint8_t* base, uint32_t tree, uint32_t node, int32_t exit)
    {
        uint32_t previous = g_node.exchange(node);
        g_nodeAt = Now();
        lobby::State state = lobby::GetState();
        // Host: NEW GAME on the main menu (the page opened the session at start): it goes to the HUB.
        if (state == lobby::State::Hosting && node == NODE_MAIN_MENU && exit == EXIT_NEW_GAME)
        {
            g_hostNewGame = true;
            Log("[mp] web: hosted new game: it goes to the HUB");
        }
        if (node == NODE_NEW_GAME_FADE && exit == EXIT_FIRST_LEVEL && g_hostNewGame.exchange(false) && state == lobby::State::Hosting)
        {
            Log("[mp] web: hosted new game: to the HUB (exit %d instead of %d)", EXIT_TO_HUB, exit);
            return EXIT_TO_HUB;
        }
        // Client in a level: START opens the page's menu over the game (which goes on) instead of the pause.
        if (g_clientInLevel && state == lobby::State::Joined && node == NODE_GAME_RUNNING && exit == EXIT_PAUSE)
        {
            if (g_leaving == Leaving::None && !g_levelMenu.exchange(true))
                Log("[mp] web: the client's menu in the level");
            return -1;
        }
        if (state == lobby::State::Hosting)
        {
            if (node == NODE_HUB)
                g_hostReachedHub = true;
            else if (node == NODE_MAIN_MENU && g_hostReachedHub.exchange(false))
            {
                Log("[mp] web: the host is back at the main menu: the session closes");
                lobby::Leave();
                state = lobby::GetState();
            }
        }
        if ((exit == EXIT_DROP_OUT || exit == EXIT_DROP_OUT_NO_SAVE) && InSession(state))
        {
            Log("[mp] web: DROP OUT is EXIT LEVEL online");
            exit = exit == EXIT_DROP_OUT ? EXIT_LEAVE_LEVEL : EXIT_LEAVE_LEVEL_NO_SAVE;
        }
        if (state == lobby::State::Hosting && node == NODE_PAUSE && exit == EXIT_SAVE_AND_EXIT)
            lobby::HostBackInMenus();
        // Client: only the host saves; out of the level by the end screen's way to the HUB, then to the main menu,
        // where it waits for the host's next level (or left the session).
        if (g_clientInLevel)
        {
            for (int32_t save : SAVE_EXITS)
                if (exit == save)
                {
                    Log("[mp] web: client: no save (exit %d -> %d)", exit, EXIT_HUB_WITHOUT_SAVING);
                    exit = EXIT_HUB_WITHOUT_SAVING;
                }
            Leaving leaving = g_leaving;
            if (leaving == Leaving::None)
            {
                if (exit == EXIT_SAVE_AND_EXIT || exit == EXIT_EXIT_NO_SAVE || g_quitLevel.exchange(false))
                    leaving = Leaving::Quit;
                else if (state != lobby::State::Joined)
                    leaving = Leaving::Quit;
                else if (lobby::TakeHostLeftLevel() || (node == NODE_HUB && !lobby::HostInGame()))
                    leaving = Leaving::ToLobby;
                if (leaving != Leaving::None)
                {
                    g_leaving = leaving;
                    g_levelMenu = false;
                    net::SetRole(net::Role::None, 0, 1, 0, 0);
                    Log("[mp] web: client leaving the level (%s)", leaving == Leaving::Quit ? "out of the session" : "back to the wait");
                }
            }
            if (leaving != Leaving::None)
            {
                if ((node == NODE_GAME_RUNNING || node == NODE_PAUSE || node == NODE_PAUSE_NO_SAVE) && exit < 0)
                    return EXIT_EXIT_NO_SAVE;
                if (node == NODE_LEAVING_LEVEL)
                    return EXIT_HUB_WITHOUT_SAVING;
                if (node == NODE_LEAVING_LEVEL_NO_SAVE)
                    return EXIT_CONTINUE_NO_SAVE;
                if (node == NODE_HUB)
                {
                    g_clientInLevel = false;
                    g_leaving = Leaving::None;
                    if (leaving == Leaving::Quit)
                        lobby::Leave();
                    Log("[mp] web: client at the HUB: to the main menu (exit %d)", EXIT_HUB_TO_MAIN_MENU);
                    return EXIT_HUB_TO_MAIN_MENU;
                }
            }
        }
        // Host: the level start the clients follow, and the way back.
        if (state == lobby::State::Hosting)
        {
            // A level the page asked for, from the HUB or the main menu (StartLevel + SkipToLevel, as a client follows).
            if ((node == NODE_HUB || node == NODE_MAIN_MENU) && exit < 0)
            {
                int32_t go = g_hostGo.exchange(-1);
                if (go >= 0)
                {
                    PPCContext call = ctx;
                    call.r3.u64 = tree;
                    call.r4.s64 = go;
                    sub_820F5D58(call, base);
                    Log("[mp] web: the host starts level %d (from node %u)", go, node);
                    return EXIT_SKIP_TO_LEVEL;
                }
            }
            if (node == NODE_IN_GAME && previous != NODE_IN_GAME && !lobby::HostInGame())
                lobby::HostLevelStarted(int32_t(LoadBE32(MANAGERS + LEVEL_INDEX)));
            else if (node == NODE_HUB && lobby::HostInGame())
                lobby::HostBackInMenus();
        }
        // The cutscenes start together (lobby::HoldAtCutscene).
        if (InSession(state))
        {
            bool load = node == NODE_IN_GAME && exit >= 0;
            bool cutscene = (node == NODE_GAME_RUNNING || node == NODE_CINEMATICS) && exit >= FIRST_CUTSCENE_EXIT && exit <= LAST_CUTSCENE_EXIT;
            if (load || cutscene)
            {
                g_cutsceneHold = true;
                if (lobby::HoldAtCutscene(load ? NODE_IN_GAME : uint32_t(exit), load))
                    return -1;
            }
            else if (g_cutsceneHold && node != NODE_IN_GAME)
            {
                g_cutsceneHold = false;
                lobby::CutsceneHoldDone();
            }
        }
        // Client: the host started a level.
        if (state == lobby::State::Joined && exit < 0 && (node == NODE_OPTIONS || node == NODE_MAIN_MENU || node == NODE_HUB))
        {
            int32_t level;
            if (lobby::TakeStart(level))
            {
                PPCContext call = ctx;
                call.r3.u64 = tree;
                call.r4.s64 = level;
                sub_820F5D58(call, base);
                g_clientInLevel = true;
                g_leaving = Leaving::None;
                g_quitLevel = false;
                g_levelMenu = false;
                lobby::TakeHostLeftLevel();
                Log("[mp] web: following the host into level %d (StartLevel + SkipToLevel from node %u)", level, node);
                return EXIT_SKIP_TO_LEVEL;
            }
        }
        return exit;
    }

    // For the page (mp_web's session thread below).
    bool LevelMenu() { return g_levelMenu; }
    void CloseLevelMenu() { g_levelMenu = false; }
    void QuitLevel()
    {
        g_levelMenu = false;
        g_quitLevel = true;
        Log("[mp] web: client: leave the level and the session");
    }
    bool ClientInLevel() { return g_clientInLevel; }
    void HostGo(int32_t level) { g_hostGo = level; }
    uint32_t Node() { return g_node; }
    uint64_t NodeAt() { return g_nodeAt; }
}

// Frontend:PauseGame(paused): in a session the game never stops (online/mp_menu.cpp).
PPC_FUNC(sub_820F8918)
{
    mp::lobby::State state = mp::lobby::GetState();
    bool session = state == mp::lobby::State::Hosting || state == mp::lobby::State::Joined;
    if (ctx.r4.u8 && session && mp::menu::Node() == 638)
        return;
    __imp__sub_820F8918(ctx, base);
}

// CFrontendManager::HaveBothPlayersJoinedGame: the one-player pause in a session (online/mp_menu.cpp); not for
// UpdateInputAndCheats, where "not both joined" lets a controller drop in.
static thread_local bool t_inputUpdate = false;

PPC_FUNC(sub_821DB680)
{
    t_inputUpdate = true;
    __imp__sub_821DB680(ctx, base);
    t_inputUpdate = false;
}

PPC_FUNC(sub_821DAAB0)
{
    mp::lobby::State state = mp::lobby::GetState();
    if (!t_inputUpdate && (state == mp::lobby::State::Hosting || state == mp::lobby::State::Joined))
    {
        ctx.r3.u64 = 0;
        return;
    }
    __imp__sub_821DAAB0(ctx, base);
}

// CStreamManager::vf05 / vf04, the level load and unload (dev/dev_skins.cpp's hooks, its online part): the other
// players' skins, and the spawned actors' names start again (the same on every machine).
PPC_FUNC(sub_8224E068)
{
    mp::skins::LevelLoad(ctx, base);
    mp::LevelLoaded();
    __imp__sub_8224E068(ctx, base);
}

PPC_FUNC(sub_8224FAD8)
{
    mp::skins::LevelUnload(ctx, base);
    __imp__sub_8224FAD8(ctx, base);
}

// No UPnP nor STUN: every browser is on the server's virtual LAN.
namespace mp::nat
{
    void Open(int, uint32_t) {}
    void Close() {}
    State GetState() { return State::Off; }
    bool PublicAddress(uint32_t&, int&) { return false; }
    bool OnPacket(const uint8_t*, size_t) { return false; }
}

// dev/dev_tools.h: a chunk of Lua in the game's script state (dev/dev_tools.cpp's RunLua, without its library):
// the online code names the spawned actors and spawns players 3-8 with it.
namespace dev
{
    bool RunLua(PPCContext& ctx, uint8_t* base, const char* code, const char* chunkName, std::string* error)
    {
        constexpr uint32_t SCRIPT_MANAGER_PTR = 0x824FBFE8, SCRIPT_MANAGER_LUA_STATE = 1056, LUA_BASE_PRINT = 0x823CCF40;
        constexpr int64_t LUA_GLOBALSINDEX = -10001;
        static uint32_t buffer = 0, bufferSize = 0, nameBuffer = 0, printName = 0, printState = 0;
        uint32_t manager = LoadBE32(SCRIPT_MANAGER_PTR);
        uint32_t L = manager ? LoadBE32(manager + SCRIPT_MANAGER_LUA_STATE) : 0;
        if (!L)
            return false;
        size_t size = strlen(code);
        if (size + 1 > bufferSize)
        {
            bufferSize = uint32_t(std::max<size_t>(size + 1, std::max<uint32_t>(64 * 1024, bufferSize * 2)));
            buffer = GuestAlloc(bufferSize);
        }
        if (!nameBuffer)
            nameBuffer = GuestAlloc(64);
        if (!buffer || !nameBuffer)
            return false;
        if (printState != L)
        {
            // devprint = the base library's print (the online code's traces use it)
            if (!printName)
                printName = GuestAlloc(16);
            memcpy(g_memory.Translate(printName), "devprint", 9);
            PPCContext call = ctx;
            call.r3.u64 = L, call.r4.u64 = LUA_BASE_PRINT, call.r5.u64 = 0;
            sub_82298EA0(call, base);
            call = ctx;
            call.r3.u64 = L, call.r4.u64 = uint64_t(LUA_GLOBALSINDEX), call.r5.u64 = printName;
            sub_822992D0(call, base);
            printState = L;
        }
        memcpy(g_memory.Translate(buffer), code, size + 1);
        std::string name = std::string("=") + (chunkName ? chunkName : "mp");
        name.resize(std::min<size_t>(name.size(), 63));
        memcpy(g_memory.Translate(nameBuffer), name.c_str(), name.size() + 1);
        PPCContext call = ctx;
        call.r3.u64 = L;
        sub_82298360(call, base);
        uint32_t top = call.r3.u32;
        call = ctx;
        call.r3.u64 = L, call.r4.u64 = buffer, call.r5.u64 = size, call.r6.u64 = nameBuffer;
        sub_823C9530(call, base);
        int status = int(call.r3.s32);
        if (status == 0)
        {
            call = ctx;
            call.r3.u64 = L, call.r4.u64 = 0, call.r5.u64 = 0, call.r6.u64 = 0;
            sub_822995E8(call, base);
            status = int(call.r3.s32);
        }
        if (status != 0)
        {
            call = ctx;
            call.r3.u64 = L, call.r4.u64 = uint64_t(-1), call.r5.u64 = 0;
            sub_822989A0(call, base);
            const char* text = call.r3.u32 ? reinterpret_cast<const char*>(g_memory.Translate(call.r3.u32)) : "";
            std::string message(text, strnlen(text, 4096));
            Log("[mp] lua error (%d) in %s: %s", status, name.c_str() + 1, message.c_str());
            if (error)
                *error = message;
        }
        call = ctx;
        call.r3.u64 = L, call.r4.u64 = top;
        sub_82298450(call, base);
        return status == 0;
    }
}

// dev/dev_skins.h: the skins a player can wear (dev/dev_skins.cpp's table: the ESkin values with a model and
// a name; Cortex has no model on the disc, Yuktopus / Uka Uka / Nina no name).
namespace dev::skins
{
    bool Wearable(int skin)
    {
        return (skin >= 0 && skin <= 24) && skin != 1 && skin != 18 && skin != 19 && skin != 20;
    }
}

// kernel/pc_input.h: a menu of the frontend over the game (its conditions ran a moment ago, on a screen that
// is not the running level): the remote players' pads stay off it.
namespace input::pc
{
    bool InMenus()
    {
        uint64_t at = mp::menu::NodeAt();
        uint32_t node = mp::menu::Node();
        auto now = uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
        return at && now - at <= 250 && node != 630 && node != 638 && node != 655;
    }
}

// kernel/input.h: controllers 5-8 (players 5-8, experimental): none in the browser.
namespace input
{
    bool ReadExtraController(uint32_t, void*) { return false; }
}

// ---- the session the page asked for, and its panel ---------------------------------------------------------

namespace
{
    std::string Escape(const std::string& s)
    {
        std::string out;
        for (char c : s)
        {
            if (c == '"' || c == '\\')
                out += '\\', out += c;
            else if (uint8_t(c) >= 0x20)
                out += c;
        }
        return out;
    }

    const char* StateName(mp::lobby::State s)
    {
        switch (s)
        {
        case mp::lobby::State::Hosting: return "hosting";
        case mp::lobby::State::Searching: return "searching";
        case mp::lobby::State::Joining: return "joining";
        case mp::lobby::State::Joined: return "joined";
        case mp::lobby::State::Failed: return "failed";
        default: return "off";
        }
    }

    std::string Status(const char* role)
    {
        using namespace mp::lobby;
        State state = GetState();
        std::string json = std::string("{\"role\":\"") + role + "\",\"state\":\"" + StateName(state) + "\"";
        if (state == State::Failed || state == State::Off)
            json += std::string(",\"reason\":\"") + Escape(ReasonText(LastReason(), false)) + "\"";
        json += ",\"address\":\"" + Escape(Address()) + "\",\"code\":\"" + Escape(InviteCode()) + "\"";
        json += std::string(",\"inGame\":") + (HostInGame() ? "true" : "false");
        json += std::string(",\"clientInLevel\":") + (mp::menu::ClientInLevel() ? "true" : "false");
        json += std::string(",\"levelMenu\":") + (mp::menu::LevelMenu() ? "true" : "false");
        json += ",\"maxPlayers\":" + std::to_string(GetOptions().maxPlayers);
        json += ",\"players\":[";
        bool first = true;
        for (const Player& p : Players())
        {
            json += (first ? "" : ",");
            first = false;
            json += "{\"slot\":" + std::to_string(p.slot) + ",\"name\":\"" + Escape(p.name) + "\",\"ping\":" + std::to_string(p.pingMs) +
                    ",\"me\":" + (p.me ? "true" : "false") + "}";
        }
        return json + "]}";
    }

    void SessionThread(std::string role, std::string name, std::string join)
    {
        if (!vnet::WaitConnected(20000))
        {
            Log("[mp] web: the server's virtual LAN is not reachable: no online session");
            vnet::SetStatus("{\"role\":\"" + role + "\",\"state\":\"failed\",\"reason\":\"The server's virtual LAN is not reachable\"}");
            return;
        }
        mp::lobby::SetLocalName(name);
        bool ok = role == "host" ? mp::lobby::Host() : mp::lobby::Join(join, "");
        Log("[mp] web: %s %s as %s: %s", role == "host" ? "hosting" : "joining", role == "host" ? "" : join.c_str(), name.c_str(),
            ok ? "ok" : mp::lobby::ReasonText(mp::lobby::LastReason(), false));
        for (;;)
        {
            std::string command;
            while (vnet::TakeCommand(command))
            {
                if (command == "leave")
                {
                    if (mp::menu::ClientInLevel())
                        mp::menu::QuitLevel();
                    else
                        mp::lobby::Leave();
                }
                else if (command == "quit-level")
                    mp::menu::QuitLevel();
                else if (command == "resume")
                    mp::menu::CloseLevelMenu();
                else if (command.rfind("max:", 0) == 0)
                {
                    mp::lobby::Options o = mp::lobby::GetOptions();
                    o.maxPlayers = uint32_t(std::clamp(atoi(command.c_str() + 4), 2, int(mp::lobby::MAX_PLAYERS)));
                    mp::lobby::SetOptions(o);
                }
                else if (command.rfind("level:", 0) == 0 && mp::lobby::GetState() == mp::lobby::State::Hosting)
                    mp::menu::HostGo(std::clamp(atoi(command.c_str() + 6), 0, 19));
                else if (command.rfind("kick:", 0) == 0)
                    mp::lobby::Kick(uint32_t(atoi(command.c_str() + 5)));
            }
            vnet::SetStatus(Status(role.c_str()));
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
        }
    }
}

// main_wasm.cpp, at start: the session the page chose (none without CRASHOTT_MP).
void StartWebSession()
{
    const char* role = getenv("CRASHOTT_MP");
    if (!role || (strcmp(role, "host") && strcmp(role, "join")))
        return;
    const char* name = getenv("CRASHOTT_MP_NAME");
    const char* join = getenv("CRASHOTT_MP_JOIN");
    if (!strcmp(role, "join") && (!join || !*join))
    {
        Log("[mp] web: CRASHOTT_MP=join without CRASHOTT_MP_JOIN: no online session");
        return;
    }
    Log("[mp] web: online co-op: %s", role);
    std::thread(SessionThread, std::string(role), std::string(name && *name ? name : "PLAYER"), std::string(join ? join : "")).detach();
}

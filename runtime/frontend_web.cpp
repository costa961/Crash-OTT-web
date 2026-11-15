// The title's frontend for the browser build: the hook on its node-exit evaluation (sub_820F9BA8),
// reduced from crashott-pc's settings/frontend_hooks.cpp to what the browser build has: the direct
// boot (settings/direct_boot.cpp: CRASH_SKIP_INTROS skips the logos and the title screen to the main
// menu). The PC build's own menus, online, Discord and achievements hooks are left out.
#include "settings/direct_boot.h"

#include <ppc_config.h>
#include <ppc_context.h>

extern "C" PPC_FUNC(__imp__sub_820F9BA8);

namespace
{
    // The evaluation recurses (conditions): only the outermost one is a screen's exit.
    thread_local int t_conditionDepth = 0;
}

// s32 sub_820F9BA8(tree, node): the exit a frontend node takes this frame (-1: stays).
PPC_FUNC(sub_820F9BA8)
{
    uint32_t tree = ctx.r3.u32, node = ctx.r4.u32;
    if (t_conditionDepth == 0)
        boot::NoteFrontendNode(node);
    t_conditionDepth++;
    __imp__sub_820F9BA8(ctx, base);
    int32_t exit = int32_t(ctx.r3.u32);
    if (t_conditionDepth == 1)
        exit = boot::OverrideExit(ctx, base, tree, node, exit);
    ctx.r3.s64 = exit;
    t_conditionDepth--;
}

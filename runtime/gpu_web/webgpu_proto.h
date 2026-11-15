// The contract between the WebGPU recorder (runtime/gpu_web/rhi_webgpu.cpp, on the command processor
// thread) and the page's executor (web/src/gpu/). Everything lives in the wasm memory; the page reads
// it zero-copy. web/src/gpu/proto.ts mirrors these numbers.
//
// - WgCtl: one per process, handed to the host at start (import crashott.gpu_register).
// - The command ring: variable-size records (WgRecord header + payload, 4-byte aligned) that never
//   straddle the end; a WG_PAD record fills the end before a wrap. The producer advances writePos,
//   the page readPos (both byte counters modulo 2^32, the ring size a power of two).
// - The upload ring: vertex data, indices, constants and texture levels, written by the CPU. Every
//   WG_SUBMIT / WG_PRESENT names the ranges written since the previous one; the page copies them
//   into its GPU mirror of the ring (queue.writeBuffer) before it submits the batch, then stores the
//   record's fence in consumedFence, which frees those ranges for reuse.
// - Resources are numbered by the producer: textures, buffers, shaders, pipelines share one id space.
//   Texture 1 is the canvas's current texture (BeginPresent), 2 the 1x1 transparent black texture.
// Only fixed-width fields: wasm32 and the TypeScript views agree byte for byte.
#pragma once
#include <stdint.h>

#define WG_MAGIC 0x43475757u   // "WWGC"
#define WG_VERSION 1u

#define WG_TEXTURE_BACKBUFFER 1u
#define WG_TEXTURE_NULL 2u
#define WG_FIRST_ID 16u

typedef struct
{
    uint32_t magic, version;
    uint32_t cmdRing, cmdSize;        // wasm address and size (power of two) of the command ring
    uint32_t uploadRing, uploadSize;  // wasm address and size of the upload ring
    // Written by the page.
    uint32_t attached;                // 1 while an executor consumes the ring (0: records are dropped)
    uint32_t canvasWidth, canvasHeight;
    uint32_t presentFormat;           // DXGI format of the canvas (B8G8R8A8_UNORM)
    uint32_t features;                // WG_FEATURE_* the device has
    uint32_t reserved0;
    // Atomics (Int32Array indices 12..15).
    uint32_t writePos;                // producer
    uint32_t readPos;                 // page
    uint32_t consumedFence;           // page: last WG_SUBMIT / WG_PRESENT fence executed
    uint32_t presentedFrames;         // page: frames shown
} WgCtl;

#define WG_CTL_WRITEPOS 12
#define WG_CTL_READPOS 13
#define WG_CTL_FENCE 14
#define WG_CTL_PRESENTED 15

#define WG_FEATURE_BC 1u              // texture-compression-bc

typedef struct
{
    uint16_t op;
    uint16_t flags;
    uint32_t size;                    // bytes, header included, multiple of 4
} WgRecord;

enum WgOp
{
    WG_PAD = 0,
    WG_CREATE_TEXTURE = 1,            // WgCreateTexture
    WG_DESTROY = 2,                   // WgId (any resource)
    WG_CREATE_BUFFER = 3,             // WgCreateBuffer
    WG_COPY_UPLOAD_TO_TEXTURE = 4,    // WgCopyUpload
    WG_COPY_TEXTURE = 5,              // WgCopyTexture
    WG_CLEAR_COLOR = 6,               // WgClear
    WG_CLEAR_DEPTH_STENCIL = 7,       // WgClear
    WG_CREATE_SHADER = 8,             // WgCreateShader + name + source (UTF-8)
    WG_CREATE_DRAW_PIPELINE = 9,      // WgDrawPipeline
    WG_CREATE_PASS_PIPELINE = 10,     // WgPassPipeline + name + vs + ps sources
    WG_DRAW = 11,                     // WgDraw + textureCount x WgBinding
    WG_DRAW_PASS = 12,                // WgDrawPass + textureCount x WgBinding
    WG_SUBMIT = 13,                   // WgSubmit
    WG_PRESENT = 14,                  // WgSubmit
    WG_RESIZE = 15,                   // WgResize: the back buffer's new size
};

typedef struct { uint32_t id; } WgId;

typedef struct
{
    uint32_t id, width, height, levels;
    uint32_t format, renderFormat;    // DXGI_FORMAT
    uint32_t usage;                   // rhi::TextureUsage bits
} WgCreateTexture;

typedef struct { uint32_t id, address, size; } WgCreateBuffer;  // host-visible: the page reads wasm memory

typedef struct
{
    uint32_t texture, level, uploadOffset, rowPitch;
    uint32_t width, height;           // the level's size in texels
} WgCopyUpload;

typedef struct
{
    uint32_t destination, source;
    uint32_t hasRect;
    int32_t left, top, right, bottom;
} WgCopyTexture;

typedef struct
{
    uint32_t texture;
    float color[4];                   // WG_CLEAR_COLOR
    float depth;                      // WG_CLEAR_DEPTH_STENCIL
    uint32_t stencil;
    uint32_t hasRect;
    int32_t left, top, right, bottom;
} WgClear;

typedef struct
{
    uint32_t id;
    uint32_t stage;                   // rhi::Stage: 0 vertex, 1 pixel, 2 geometry
    uint32_t layout;                  // rhi::Layout: 0 draw, 1 pass
    uint32_t language;                // WG_LANG_*
    uint32_t nameBytes, sourceBytes;  // then the name and the source, each padded to 4 bytes
} WgCreateShader;

#define WG_LANG_WGSL 0u
#define WG_LANG_HLSL 1u               // not compilable by the page (a translator gap): logged and skipped

typedef struct
{
    uint32_t id;
    uint32_t vs, ps, gs;              // shader ids (0 = none)
    uint32_t colorFormats[4];
    uint32_t depthFormat;
    uint32_t colorCount;
    uint32_t blend[4];                // RB_BLENDCONTROL0-3
    uint32_t colorMask;
    uint32_t depthControl;            // RB_DEPTHCONTROL
    uint32_t stencilMasks;
    int32_t depthBias;
    float slopeBias;
    uint32_t cull, topology, depthClip, stripCut, keepFormats;
} WgDrawPipeline;

typedef struct
{
    uint32_t id;
    uint32_t targets[4];              // DXGI formats
    uint32_t targetCount;
    uint32_t blend;                   // rhi::Blend
    uint32_t textureCount, bufferInput, constantBytes;
    uint8_t samplers[2][16];          // rhi::SamplerDesc
    uint32_t samplerCount;
    uint32_t nameBytes, vsBytes, psBytes;
} WgPassPipeline;

typedef struct
{
    uint32_t texture;                 // id (0: the null texture)
    uint32_t view;                    // rhi::View
    uint8_t sampler[16];              // rhi::SamplerDesc (draws only)
} WgBinding;

typedef struct
{
    uint32_t pipeline;
    uint32_t colorTargets[4];
    uint32_t colorCount;
    uint32_t depthTarget;
    float viewport[6];                // x, y, width, height, minDepth, maxDepth
    int32_t scissor[4];               // left, top, right, bottom
    float blendFactor[4];
    uint32_t stencilRef;
    uint32_t systemConstants, vertexConstants, pixelConstants, effectConstants;  // upload ring offsets
    uint32_t systemConstantBytes;
    uint32_t topology;
    uint32_t firstIndex, indexCount;
    uint32_t textureCount;            // then textureCount x WgBinding (slot i = binding i)
} WgDraw;

typedef struct
{
    uint32_t pipeline;
    uint32_t targets[4];
    uint32_t targetCount;
    float viewport[6];
    int32_t scissor[4];
    uint32_t buffer, bufferOffset, bufferBytes;
    uint32_t constants, constantBytes;  // upload ring offset of b0
    uint32_t vertexCount;
    uint32_t textureCount;            // then textureCount x WgBinding
} WgDrawPass;

typedef struct
{
    uint32_t fence;
    uint32_t vsync;                   // WG_PRESENT
    uint32_t syncCount;               // upload ranges written since the last submit (0-2)
    uint32_t sync[2][2];              // offset, bytes
} WgSubmit;

typedef struct { uint32_t width, height; } WgResize;

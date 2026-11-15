// rhi::Device (third_party/crashott-pc/runtime/gpu/rhi.h) for the browser: a recorder. Every call
// becomes a record in the command ring of webgpu_proto.h, which the page's executor (web/src/gpu/)
// replays with WebGPU. Resources get their ids here, so nothing ever waits for the page except for
// ring space. With no page attached (the Node runner) the records are dropped and the uploads freed
// at once: the renderer still does all its CPU work, which keeps the headless boot a useful test.
//
// The renderer asks for "CreateVulkan": this file provides that symbol (the only backend here).

#include "webgpu_proto.h"

#include "diagnostics.h"
#include "gpu/rhi.h"
#include "gpu/rhi_ring.h"

#include <array>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <chrono>
#include <unordered_map>
#include <vector>

// Hands the control block to the host. Returns nonzero when a page will attach an executor (the
// browser), 0 when none will (the Node runner: records are dropped from the start).
__attribute__((import_module("crashott"), import_name("gpu_register"))) extern "C" int32_t crashott_gpu_register(uint32_t ctl);

namespace gpu::rhi
{
    namespace
    {
        WgCtl* g_ctl;  // the device's control block (CanvasSize)

        constexpr uint32_t COMMAND_RING_BYTES = 16u << 20;
        constexpr uint64_t UPLOAD_RING_BYTES = 128ull << 20;

        struct WgTexture final : Texture
        {
            uint32_t id = 0;
        };
        struct WgBuffer final : Buffer
        {
            uint32_t id = 0;
        };
        struct WgShader final : Shader
        {
            uint32_t id = 0;
        };
        struct WgPipeline final : Pipeline
        {
            uint32_t id = 0;
        };

        uint32_t Id(const Texture* texture) { return texture ? static_cast<const WgTexture*>(texture)->id : 0; }
        uint32_t Id(const Shader* shader) { return shader ? static_cast<const WgShader*>(shader)->id : 0; }
        uint32_t Id(const Pipeline* pipeline) { return pipeline ? static_cast<const WgPipeline*>(pipeline)->id : 0; }

        int32_t* Atom(WgCtl* ctl, int index) { return reinterpret_cast<int32_t*>(ctl) + index; }

        class WebGpuDevice final : public Device
        {
        public:
            explicit WebGpuDevice(const DeviceInfo& info)
            {
                m_ctl = static_cast<WgCtl*>(aligned_alloc(64, sizeof(WgCtl)));
                memset(m_ctl, 0, sizeof(WgCtl));
                m_commands = static_cast<uint8_t*>(aligned_alloc(256, COMMAND_RING_BYTES));
                m_upload = static_cast<uint8_t*>(aligned_alloc(256, UPLOAD_RING_BYTES));
                if (!m_ctl || !m_commands || !m_upload)
                    Fatal("[webgpu] could not allocate the command and upload rings");
                m_ctl->magic = WG_MAGIC;
                m_ctl->version = WG_VERSION;
                m_ctl->cmdRing = uint32_t(reinterpret_cast<uintptr_t>(m_commands));
                m_ctl->cmdSize = COMMAND_RING_BYTES;
                m_ctl->uploadRing = uint32_t(reinterpret_cast<uintptr_t>(m_upload));
                m_ctl->uploadSize = uint32_t(UPLOAD_RING_BYTES);
                m_ctl->canvasWidth = info.width;
                m_ctl->canvasHeight = info.height;
                g_ctl = m_ctl;
                m_ring.Init(UPLOAD_RING_BYTES);

                m_backBuffer.id = WG_TEXTURE_BACKBUFFER;
                m_backBuffer.desc.width = info.width;
                m_backBuffer.desc.height = info.height;
                m_backBuffer.desc.format = DXGI_FORMAT_B8G8R8A8_UNORM;
                m_backBuffer.desc.usage = USAGE_RENDER_TARGET;
                m_backBuffer.desc.name = "back buffer";
                m_null.id = WG_TEXTURE_NULL;
                m_null.desc.format = DXGI_FORMAT_R8G8B8A8_UNORM;
                m_null.desc.name = "null";

                // The renderer creates its pipelines right after this: in the browser, wait for the
                // page's executor so none of those records is dropped.
                if (crashott_gpu_register(uint32_t(reinterpret_cast<uintptr_t>(m_ctl))))
                {
                    for (int i = 0; i < 300 && !Attached(); i++)
                        __builtin_wasm_memory_atomic_wait32(reinterpret_cast<int32_t*>(&m_ctl->attached), 0, 100000000);
                    if (!Attached())
                        Log("[webgpu] the page did not attach an executor within 30 s: drawing nothing");
                }
                Log("[webgpu] recorder ready: command ring %u MB, upload ring %llu MB, control block 0x%08X",
                    COMMAND_RING_BYTES >> 20, (unsigned long long)(UPLOAD_RING_BYTES >> 20), m_ctl->cmdRing ? uint32_t(uintptr_t(m_ctl)) : 0);
            }

            const std::string& AdapterName() const override { return m_name; }

            // ---- submission ----
            void Submit() override { EndBatch(WG_SUBMIT, false); }

            void WaitIdle() override
            {
                Submit();
                while (Attached() && int32_t(m_fence - uint32_t(__atomic_load_n(Atom(m_ctl, WG_CTL_FENCE), __ATOMIC_ACQUIRE))) > 0)
                    __builtin_wasm_memory_atomic_wait32(Atom(m_ctl, WG_CTL_FENCE), int32_t(m_ctl->consumedFence), 1000000);
            }

            Upload AllocateUpload(uint64_t size, uint64_t alignment) override
            {
                Retire();
                uint64_t offset = m_ring.TryAllocate(size, alignment);
                for (int attempt = 0; offset == UINT64_MAX && attempt < 2000; attempt++)
                {
                    // Full: submit what is recorded and wait for the page to take it.
                    if (attempt == 0)
                        Submit();
                    if (Attached())
                    {
                        auto t0 = std::chrono::steady_clock::now();
                        __builtin_wasm_memory_atomic_wait32(Atom(m_ctl, WG_CTL_FENCE), int32_t(m_ctl->consumedFence), 1000000);
                        m_uploadWaitNs += uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - t0).count());
                    }
                    Retire();
                    offset = m_ring.TryAllocate(size, alignment);
                }
                if (offset == UINT64_MAX)
                {
                    Log("[webgpu] upload ring: no room for %llu bytes", (unsigned long long)size);
                    return {};
                }
                NoteDirty(uint32_t(offset), uint32_t(size));
                return { m_upload + offset, offset };
            }

            void HoldUploads(bool hold) override
            {
                if (hold)
                    m_ring.Hold();
                else
                    m_ring.Release();
            }

            // ---- resources ----
            Texture* CreateTexture(const TextureDesc& desc) override
            {
                auto* texture = new WgTexture;
                texture->desc = desc;
                texture->id = NextId();
                WgCreateTexture r{ texture->id, desc.width, desc.height, desc.levels, uint32_t(desc.format), uint32_t(desc.renderFormat), desc.usage };
                Record(WG_CREATE_TEXTURE, &r, sizeof(r));
                return texture;
            }

            void DestroyTexture(Texture* texture) override
            {
                if (!texture || texture == &m_backBuffer || texture == &m_null)
                    return;
                WgId r{ Id(texture) };
                Record(WG_DESTROY, &r, sizeof(r));
                delete static_cast<WgTexture*>(texture);
            }

            Texture* NullTexture() override { return &m_null; }

            Buffer* CreateBuffer(uint64_t size) override
            {
                auto* buffer = new WgBuffer;
                buffer->cpu = static_cast<uint8_t*>(aligned_alloc(256, (size + 255) & ~uint64_t(255)));
                buffer->size = size;
                buffer->id = NextId();
                WgCreateBuffer r{ buffer->id, uint32_t(reinterpret_cast<uintptr_t>(buffer->cpu)), uint32_t(size) };
                Record(WG_CREATE_BUFFER, &r, sizeof(r));
                return buffer;
            }

            void DestroyBuffer(Buffer* buffer) override
            {
                if (!buffer)
                    return;
                auto* b = static_cast<WgBuffer*>(buffer);
                WgId r{ b->id };
                Record(WG_DESTROY, &r, sizeof(r));
                // The page may still read it for a recorded draw: freed once that batch is executed.
                m_lateFrees.push_back({ m_fence + 1, b->cpu });
                delete b;
            }

            void CopyUploadToTexture(Texture* texture, uint32_t level, uint64_t offset, uint32_t rowPitch) override
            {
                const TextureDesc& d = texture->desc;
                WgCopyUpload r{ Id(texture), level, uint32_t(offset), rowPitch, std::max(1u, d.width >> level), std::max(1u, d.height >> level) };
                Record(WG_COPY_UPLOAD_TO_TEXTURE, &r, sizeof(r));
            }

            void CopyTexture(Texture* destination, Texture* source, const Rect* region) override
            {
                WgCopyTexture r{ Id(destination), Id(source), region ? 1u : 0u, 0, 0, 0, 0 };
                if (region)
                {
                    r.left = region->left;
                    r.top = region->top;
                    r.right = region->right;
                    r.bottom = region->bottom;
                }
                Record(WG_COPY_TEXTURE, &r, sizeof(r));
            }

            void ClearColor(Texture* texture, const float color[4], const Rect* rect) override
            {
                WgClear r{};
                r.texture = Id(texture);
                memcpy(r.color, color, sizeof(r.color));
                SetRect(r, rect);
                Record(WG_CLEAR_COLOR, &r, sizeof(r));
            }

            void ClearDepthStencil(Texture* texture, float depth, uint8_t stencil, const Rect* rect) override
            {
                WgClear r{};
                r.texture = Id(texture);
                r.depth = depth;
                r.stencil = stencil;
                SetRect(r, rect);
                Record(WG_CLEAR_DEPTH_STENCIL, &r, sizeof(r));
            }

            // ---- shaders and pipelines ----
            Shader* CreateShader(Stage stage, const std::string& source, const char* name, Layout layout) override
            {
                // WebGPU has no geometry shaders: the renderer then expands rectangle lists itself
                // (SupportsGeometryShaders is false), so only an optional one would get here.
                if (stage == Stage::Geometry)
                    return nullptr;
                auto* shader = new WgShader;
                shader->id = NextId();
                // Draw shaders come from the WGSL translator (runtime/gpu_web); the built-in passes'
                // HLSL is replaced by the page's WGSL of the same name.
                bool wgsl = source.find("@fragment") != std::string::npos || source.find("@vertex") != std::string::npos;
                WgCreateShader r{ shader->id, uint32_t(stage), uint32_t(layout), wgsl ? WG_LANG_WGSL : WG_LANG_HLSL,
                                  uint32_t(strlen(name)), uint32_t(source.size()) };
                RecordWithStrings(WG_CREATE_SHADER, &r, sizeof(r), { std::string(name), source });
                return shader;
            }

            // The key as bytes, its padding zeroed: it is compared and hashed as bytes. It stays bytes
            // (KeyBytes) from here on: a copy of the struct (the renderer's by value, the cache's own
            // m_lastKey = key or CachedPipeline{ key }) copies the fields but not the padding, so
            // keys kept as structs compared unequal to themselves (made every draw a new pipeline,
            // then ~3 of 4 pipelines duplicates of one already made).
            using KeyBytes = std::array<uint8_t, sizeof(DrawPipelineKey)>;
            static KeyBytes Normalized(const DrawPipelineKey& in)
            {
                DrawPipelineKey k;
                memset(&k, 0, sizeof(k));
                k.vs = in.vs;
                k.ps = in.ps;
                k.gs = in.gs;
                k.vsHash = in.vsHash;
                k.psHash = in.psHash;
                for (int i = 0; i < 4; i++)
                {
                    k.colorFormats[i] = in.colorFormats[i];
                    k.blend[i] = in.blend[i];
                }
                k.depthFormat = in.depthFormat;
                k.colorCount = in.colorCount;
                k.colorMask = in.colorMask;
                k.depthControl = in.depthControl;
                k.stencilMasks = in.stencilMasks;
                k.depthBias = in.depthBias;
                k.slopeBias = in.slopeBias;
                k.cull = in.cull;
                k.topology = in.topology;
                k.depthClip = in.depthClip;
                k.stripCut = in.stripCut;
                k.keepFormats = in.keepFormats;
                KeyBytes bytes;
                memcpy(bytes.data(), &k, sizeof(k));
                return bytes;
            }

            Pipeline* GetDrawPipeline(const DrawPipelineKey& rendererKey, bool, bool* deferred) override
            {
                if (deferred)
                    *deferred = false;
                const KeyBytes bytes = Normalized(rendererKey);
                std::lock_guard lock(m_pipelineMutex);
                // Consecutive draws mostly share their pipeline.
                if (m_lastPipeline && m_lastKey == bytes)
                    return m_lastPipeline;
                uint64_t hash = HashBytes(bytes.data(), bytes.size());
                auto range = m_drawPipelines.equal_range(hash);
                for (auto it = range.first; it != range.second; ++it)
                {
                    if (it->second.key == bytes)
                    {
                        m_lastKey = bytes;
                        m_lastPipeline = it->second.pipeline;
                        return m_lastPipeline;
                    }
                }
                m_pipelineMisses++;
                DrawPipelineKey key;
                memcpy(&key, bytes.data(), sizeof(key));
                auto* pipeline = new WgPipeline;
                pipeline->id = NextId();
                RecordPipeline(pipeline->id, key);
                m_drawPipelines.emplace(hash, CachedPipeline{ bytes, pipeline });
                m_lastKey = bytes;
                m_lastPipeline = pipeline;
                return pipeline;
            }

            void RecordPipeline(uint32_t id, const DrawPipelineKey& key)
            {
                WgDrawPipeline r{};
                r.id = id;
                r.vs = Id(key.vs);
                r.ps = Id(key.ps);
                r.gs = Id(key.gs);
                memcpy(r.colorFormats, key.colorFormats, sizeof(r.colorFormats));
                r.depthFormat = key.depthFormat;
                r.colorCount = key.colorCount;
                memcpy(r.blend, key.blend, sizeof(r.blend));
                r.colorMask = key.colorMask;
                r.depthControl = key.depthControl;
                r.stencilMasks = key.stencilMasks;
                r.depthBias = key.depthBias;
                r.slopeBias = key.slopeBias;
                r.cull = uint32_t(key.cull);
                r.topology = uint32_t(key.topology);
                r.depthClip = key.depthClip;
                r.stripCut = key.stripCut;
                r.keepFormats = key.keepFormats;
                Record(WG_CREATE_DRAW_PIPELINE, &r, sizeof(r));
            }

            void PrecompileProgress(uint32_t& done, uint32_t& total) override { done = total = 0; }
            void SetShaderCompilation(ShaderCompilation) override {}
            void PrewarmShader(Stage, const std::string&) override {}

            Pipeline* CreatePassPipeline(const PassPipelineDesc& desc) override
            {
                auto* pipeline = new WgPipeline;
                pipeline->id = NextId();
                WgPassPipeline r{};
                r.id = pipeline->id;
                for (uint32_t i = 0; i < 4; i++)
                    r.targets[i] = uint32_t(desc.targets[i]);
                r.targetCount = desc.targetCount;
                r.blend = uint32_t(desc.blend);
                r.textureCount = desc.textureCount;
                r.bufferInput = desc.bufferInput;
                r.constantBytes = desc.constantBytes;
                memcpy(r.samplers, desc.samplers, sizeof(r.samplers));
                r.samplerCount = desc.samplerCount;
                r.nameBytes = uint32_t(desc.name.size());
                r.vsBytes = uint32_t(desc.vs.size());
                r.psBytes = uint32_t(desc.ps.size());
                RecordWithStrings(WG_CREATE_PASS_PIPELINE, &r, sizeof(r), { desc.name, desc.vs, desc.ps });
                return pipeline;
            }

            // ---- draws ----
            void Draw(const DrawCall& draw) override
            {
                // The effect constants (b3) are root constants in Vulkan: here they go through the ring.
                Upload effects = AllocateUpload(256, 256);
                if (effects.cpu)
                    memcpy(effects.cpu, &draw.effects, std::min<size_t>(sizeof(draw.effects), 256));
                WgDraw r{};
                r.pipeline = Id(draw.pipeline);
                for (uint32_t i = 0; i < 4; i++)
                    r.colorTargets[i] = Id(draw.colorTargets[i]);
                r.colorCount = draw.colorCount;
                r.depthTarget = Id(draw.depthTarget);
                SetViewport(r.viewport, draw.viewport);
                SetScissor(r.scissor, draw.scissor);
                memcpy(r.blendFactor, draw.blendFactor, sizeof(r.blendFactor));
                r.stencilRef = draw.stencilRef;
                r.systemConstants = uint32_t(draw.systemConstants);
                r.vertexConstants = uint32_t(draw.vertexConstants);
                r.pixelConstants = uint32_t(draw.pixelConstants);
                r.effectConstants = uint32_t(effects.offset);
                r.systemConstantBytes = draw.systemConstantBytes;
                r.topology = uint32_t(draw.topology);
                r.firstIndex = draw.firstIndex;
                r.indexCount = draw.indexCount;
                r.textureCount = std::min<uint32_t>(draw.textureCount, 32);
                WgBinding bindings[32];
                for (uint32_t i = 0; i < r.textureCount; i++)
                {
                    bindings[i].texture = Id(draw.textures[i].texture);
                    bindings[i].view = uint32_t(draw.textures[i].view);
                    memcpy(bindings[i].sampler, &draw.samplers[i], 16);
                }
                RecordTwo(WG_DRAW, &r, sizeof(r), bindings, sizeof(WgBinding) * r.textureCount);
            }

            void DrawPass(const PassDraw& pass) override
            {
                Upload constants{};
                if (pass.constants && pass.constantBytes)
                {
                    constants = AllocateUpload(AlignUp64(pass.constantBytes, 256), 256);
                    if (constants.cpu)
                        memcpy(constants.cpu, pass.constants, pass.constantBytes);
                }
                WgDrawPass r{};
                r.pipeline = Id(pass.pipeline);
                for (uint32_t i = 0; i < 4; i++)
                    r.targets[i] = Id(pass.targets[i]);
                r.targetCount = pass.targetCount;
                SetViewport(r.viewport, pass.viewport);
                SetScissor(r.scissor, pass.scissor);
                r.buffer = pass.buffer ? static_cast<WgBuffer*>(pass.buffer)->id : 0;
                r.bufferOffset = uint32_t(pass.bufferOffset);
                r.bufferBytes = uint32_t(pass.bufferBytes);
                r.constants = uint32_t(constants.offset);
                r.constantBytes = constants.cpu ? pass.constantBytes : 0;
                r.vertexCount = pass.vertexCount;
                r.textureCount = std::min<uint32_t>(pass.textureCount, 8);
                WgBinding bindings[8]{};
                for (uint32_t i = 0; i < r.textureCount; i++)
                {
                    bindings[i].texture = Id(pass.textures[i].texture);
                    bindings[i].view = uint32_t(pass.textures[i].view);
                }
                RecordTwo(WG_DRAW_PASS, &r, sizeof(r), bindings, sizeof(WgBinding) * r.textureCount);
            }

            // WebGPU: BC textures with the texture-compression-bc feature (desktop GPUs); no geometry
            // shaders; implicit derivatives only in uniform control flow (the translator uses
            // explicit gradients everywhere).
            bool SupportsBlockCompression() const override { return (m_ctl->features & WG_FEATURE_BC) != 0; }
            bool SupportsGeometryShaders() const override { return false; }
            bool SupportsImplicitDerivatives() const override { return false; }

            // ---- presentation ----
            DXGI_FORMAT BackBufferFormat() const override { return DXGI_FORMAT_B8G8R8A8_UNORM; }
            void BackBufferSize(uint32_t& width, uint32_t& height) const override
            {
                width = m_backBuffer.desc.width;
                height = m_backBuffer.desc.height;
            }
            bool Resize(uint32_t width, uint32_t height) override
            {
                m_backBuffer.desc.width = width;
                m_backBuffer.desc.height = height;
                WgResize r{ width, height };
                Record(WG_RESIZE, &r, sizeof(r));
                return true;
            }
            Texture* BeginPresent() override
            {
                // The canvas's size can change between frames (the page resizes it).
                uint32_t w = m_ctl->canvasWidth, h = m_ctl->canvasHeight;
                if (w && h && (w != m_backBuffer.desc.width || h != m_backBuffer.desc.height))
                {
                    m_backBuffer.desc.width = w;
                    m_backBuffer.desc.height = h;
                }
                return &m_backBuffer;
            }
            void Present(bool vsync) override
            {
                EndBatch(WG_PRESENT, vsync);
                m_frames++;
            }
            void UpdateFullscreen(bool, bool) override {}
            void LeaveFullscreen() override {}

            bool ReadBack(Texture*, std::vector<uint8_t>&, uint32_t&, uint32_t&) override { return false; }

            void WriteTimestamp(uint32_t) override {}
            void ResolveTimestamps(uint32_t, uint32_t) override {}
            bool ReadTimestamps(uint32_t, uint32_t, uint64_t*) override { return false; }
            double TimestampFrequency() const override { return 1e9; }

            NativeHandles Native() override { return {}; }
            bool DeviceExtensionEnabled(const char*) const override { return false; }
            void* NativeTexture(Texture*) override { return nullptr; }
            void* NativeView(Texture*) override { return nullptr; }
            void PrepareNative(Texture*, NativeState) override {}
            void InvalidateState() override {}
            Timing TakeTiming() override { return {}; }

            void LogStats() override
            {
                Log("[webgpu] %llu frame(s) recorded, %u presented by the page, %s, upload ring %llu KB in use; "
                    "%zu draw pipelines (%llu created since the last report); %.1f ms waiting for command ring room, "
                    "%.1f ms for upload ring room since the last report",
                    (unsigned long long)m_frames, m_ctl->presentedFrames, Attached() ? "page attached" : "no page (records dropped)",
                    (unsigned long long)(m_ring.Used() >> 10), m_drawPipelines.size(), (unsigned long long)m_pipelineMisses,
                    double(m_ringWaitNs) / 1e6, double(m_uploadWaitNs) / 1e6);
                m_pipelineMisses = 0;
                m_ringWaitNs = 0;
                m_uploadWaitNs = 0;
            }

        private:
            WgCtl* m_ctl = nullptr;
            uint8_t* m_commands = nullptr;
            uint8_t* m_upload = nullptr;
            Ring m_ring;
            std::atomic<uint32_t> m_nextId{ WG_FIRST_ID };
            uint32_t m_fence = 0;
            uint64_t m_frames = 0;
            std::string m_name = "WebGPU";
            WgTexture m_backBuffer, m_null;
            std::mutex m_pipelineMutex;
            struct CachedPipeline
            {
                KeyBytes key;
                WgPipeline* pipeline;
            };
            std::unordered_multimap<uint64_t, CachedPipeline> m_drawPipelines;  // by HashBytes of the key
            KeyBytes m_lastKey{};
            WgPipeline* m_lastPipeline = nullptr;
            uint64_t m_pipelineMisses = 0;
            // Time the command processor spent waiting for the page (ring room), between reports.
            std::atomic<uint64_t> m_ringWaitNs{ 0 }, m_uploadWaitNs{ 0 };
            struct LateFree
            {
                uint32_t fence;
                void* memory;
            };
            std::vector<LateFree> m_lateFrees;
            // Upload ranges written since the last submit (the ring hands out offsets in order, so
            // at most two: before and after a wrap).
            bool m_dirty = false;
            uint32_t m_dirtyBegin = 0, m_dirtyEnd = 0;
            bool m_wrapped = false;
            uint32_t m_wrapEnd = 0;

            bool Attached() const { return __atomic_load_n(&m_ctl->attached, __ATOMIC_ACQUIRE) != 0; }
            uint32_t NextId() { return m_nextId.fetch_add(1); }

            static void SetRect(WgClear& r, const Rect* rect)
            {
                if (!rect)
                    return;
                r.hasRect = 1;
                r.left = rect->left;
                r.top = rect->top;
                r.right = rect->right;
                r.bottom = rect->bottom;
            }
            static void SetViewport(float out[6], const Viewport& v)
            {
                out[0] = v.x;
                out[1] = v.y;
                out[2] = v.width;
                out[3] = v.height;
                out[4] = v.minDepth;
                out[5] = v.maxDepth;
            }
            static void SetScissor(int32_t out[4], const Rect& r)
            {
                out[0] = r.left;
                out[1] = r.top;
                out[2] = r.right;
                out[3] = r.bottom;
            }

            void NoteDirty(uint32_t offset, uint32_t size)
            {
                uint32_t end = offset + size;
                if (!m_dirty)
                {
                    m_dirty = true;
                    m_wrapped = false;
                    m_dirtyBegin = offset;
                    m_dirtyEnd = end;
                    return;
                }
                if (!m_wrapped && offset >= m_dirtyEnd)
                    m_dirtyEnd = end;
                else if (!m_wrapped)
                {
                    m_wrapped = true;   // the ring wrapped: a second range from 0
                    m_wrapEnd = end;
                }
                else
                    m_wrapEnd = std::max(m_wrapEnd, end);
            }

            void Retire()
            {
                uint32_t done = Attached() ? uint32_t(__atomic_load_n(Atom(m_ctl, WG_CTL_FENCE), __ATOMIC_ACQUIRE)) : m_fence;
                m_ring.Retire(done);
                while (!m_lateFrees.empty() && int32_t(done - m_lateFrees.front().fence) >= 0)
                {
                    free(m_lateFrees.front().memory);
                    m_lateFrees.erase(m_lateFrees.begin());
                }
            }

            void EndBatch(WgOp op, bool vsync)
            {
                WgSubmit r{};
                r.fence = ++m_fence;
                r.vsync = vsync;
                if (m_dirty)
                {
                    r.sync[0][0] = m_dirtyBegin;
                    r.sync[0][1] = m_dirtyEnd - m_dirtyBegin;
                    r.syncCount = 1;
                    if (m_wrapped)
                    {
                        r.sync[1][0] = 0;
                        r.sync[1][1] = m_wrapEnd;
                        r.syncCount = 2;
                    }
                }
                m_dirty = false;
                m_ring.OnSubmit(r.fence);
                Record(op, &r, sizeof(r));
            }

            // ---- the command ring ----
            void Record(WgOp op, const void* payload, uint32_t bytes) { RecordTwo(op, payload, bytes, nullptr, 0); }

            void RecordTwo(WgOp op, const void* a, uint32_t aBytes, const void* b, uint32_t bBytes)
            {
                uint32_t size = (uint32_t(sizeof(WgRecord)) + aBytes + bBytes + 3) & ~3u;
                uint8_t* p = Reserve(size);
                if (!p)
                    return;
                WgRecord header{ uint16_t(op), 0, size };
                memcpy(p, &header, sizeof(header));
                memcpy(p + sizeof(header), a, aBytes);
                if (bBytes)
                    memcpy(p + sizeof(header) + aBytes, b, bBytes);
                Commit(size);
            }

            void RecordWithStrings(WgOp op, const void* fixed, uint32_t fixedBytes, std::initializer_list<std::string> strings)
            {
                std::vector<uint8_t> payload(static_cast<const uint8_t*>(fixed), static_cast<const uint8_t*>(fixed) + fixedBytes);
                for (const std::string& s : strings)
                {
                    payload.insert(payload.end(), s.begin(), s.end());
                    payload.resize((payload.size() + 3) & ~size_t(3), 0);
                }
                RecordTwo(op, payload.data(), uint32_t(payload.size()), nullptr, 0);
            }

            // Room for `size` contiguous bytes at the write position (a pad record first if the end
            // of the ring is too short), or null when no page consumes the ring.
            uint8_t* Reserve(uint32_t size)
            {
                if (!Attached())
                    return nullptr;
                if (size > COMMAND_RING_BYTES / 2)
                {
                    Log("[webgpu] record of %u bytes dropped (too large)", size);
                    return nullptr;
                }
                for (;;)
                {
                    uint32_t write = m_ctl->writePos;
                    uint32_t at = write & (COMMAND_RING_BYTES - 1);
                    uint32_t tail = COMMAND_RING_BYTES - at;
                    uint32_t need = tail < size ? tail + size : size;
                    uint32_t read = uint32_t(__atomic_load_n(Atom(m_ctl, WG_CTL_READPOS), __ATOMIC_ACQUIRE));
                    if (COMMAND_RING_BYTES - (write - read) >= need)
                    {
                        if (tail < size)
                        {
                            WgRecord pad{ WG_PAD, 0, tail };
                            memcpy(m_commands + at, &pad, sizeof(pad));
                            Commit(tail);
                            return m_commands;
                        }
                        return m_commands + at;
                    }
                    if (!Attached())
                        return nullptr;
                    auto t0 = std::chrono::steady_clock::now();
                    __builtin_wasm_memory_atomic_wait32(Atom(m_ctl, WG_CTL_READPOS), int32_t(read), 1000000);
                    m_ringWaitNs += uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - t0).count());
                }
            }

            void Commit(uint32_t size)
            {
                __atomic_store_n(Atom(m_ctl, WG_CTL_WRITEPOS), int32_t(m_ctl->writePos + size), __ATOMIC_RELEASE);
            }
        };
    }

    Device* CreateVulkan(const DeviceInfo& info)
    {
        return new WebGpuDevice(info);
    }

    // The canvas's size in pixels, as the page last set it (it follows the page's size: full screen
    // draws at the screen's resolution); 0 x 0 before the executor attaches.
    void CanvasSize(uint32_t& width, uint32_t& height)
    {
        width = g_ctl ? __atomic_load_n(&g_ctl->canvasWidth, __ATOMIC_ACQUIRE) : 0;
        height = g_ctl ? __atomic_load_n(&g_ctl->canvasHeight, __ATOMIC_ACQUIRE) : 0;
    }

    bool TestCompile(Stage, const std::string&, const char*, Layout, const std::filesystem::path&)
    {
        return true;
    }
}

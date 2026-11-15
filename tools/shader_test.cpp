// Offline check of the Xenos -> WGSL translator (runtime/gpu_web/shader_translator_wgsl.cpp)
// against crashott-pc's Xenos -> HLSL one. Built and run by tools/shader_test.sh.
//
//   shader_test <out dir> <ucode dir> [<game shaders dir>]
//
// Corpus:
// - <ucode dir>/{vs,ps}_<hash>.bin: microcode the runtime captured (host-order dwords).
// - <game shaders dir>/*.out: the game's own compiled shaders (XDK shader containers, big-endian
//   dwords: 0 magic 0x102A1101 vertex / 0x102A1100 pixel, 1 size of the header ("virtual") part,
//   2 size of the physical part that follows it, 6 offset of the shader descriptor in the header,
//   whose dword 0 is the microcode's offset in the physical part and dword 1 its size in bytes;
//   the physical part starts with the literal constants of the shader's def instructions).
// - syn_*: synthetic microcode for the paths the game's shaders don't take (AddSynthetic).
// Writes <out dir>/<name>.hlsl (original translator, gradients mode, as the WGSL one) and
// <out dir>/<name>.wgsl, and prints one line per shader.

#include "gpu/shader_translator.h"
#include "gpu_web/shader_translator_wgsl.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace
{
    struct Shader
    {
        std::string name;
        gpu::ShaderStage stage;
        std::vector<uint32_t> ucode;
    };

    std::vector<uint8_t> ReadFile(const fs::path& path)
    {
        std::ifstream file(path, std::ios::binary);
        return std::vector<uint8_t>(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    }

    uint32_t BigEndian(const uint8_t* p)
    {
        return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
    }

    void WriteFile(const fs::path& path, const std::string& text)
    {
        std::ofstream file(path, std::ios::binary);
        file << text;
    }

    void AddCaptured(const fs::path& dir, std::vector<Shader>& shaders)
    {
        if (!fs::is_directory(dir))
            return;
        for (const auto& entry : fs::directory_iterator(dir))
        {
            std::string name = entry.path().filename().string();
            if (entry.path().extension() != ".bin" || name.size() < 4 || (name.compare(0, 3, "vs_") && name.compare(0, 3, "ps_")))
                continue;
            std::vector<uint8_t> bytes = ReadFile(entry.path());
            Shader shader;
            shader.name = entry.path().stem().string();
            shader.stage = name[0] == 'p' ? gpu::ShaderStage::Pixel : gpu::ShaderStage::Vertex;
            shader.ucode.resize(bytes.size() / 4);
            memcpy(shader.ucode.data(), bytes.data(), shader.ucode.size() * 4);
            shaders.push_back(std::move(shader));
        }
    }

    void AddGameShaders(const fs::path& dir, std::vector<Shader>& shaders)
    {
        if (dir.empty() || !fs::is_directory(dir))
            return;
        for (const auto& entry : fs::directory_iterator(dir))
        {
            if (entry.path().extension() != ".out")
                continue;
            std::vector<uint8_t> bytes = ReadFile(entry.path());
            if (bytes.size() < 12)
                continue;
            uint32_t magic = BigEndian(&bytes[0]), headerSize = BigEndian(&bytes[4]);
            uint32_t descriptor = bytes.size() >= 28 ? BigEndian(&bytes[24]) : UINT32_MAX;
            uint64_t offset = 0, size = 1;
            if (uint64_t(descriptor) + 8 <= bytes.size())
            {
                offset = uint64_t(headerSize) + BigEndian(&bytes[descriptor]);
                size = BigEndian(&bytes[descriptor + 4]);
            }
            if ((magic != 0x102A1100 && magic != 0x102A1101) || offset % 4 || size % 4 || offset + size > bytes.size())
            {
                fprintf(stderr, "%s: not an XDK shader container, skipped\n", entry.path().filename().string().c_str());
                continue;
            }
            Shader shader;
            shader.name = "game_" + entry.path().stem().string();
            shader.stage = magic == 0x102A1101 ? gpu::ShaderStage::Vertex : gpu::ShaderStage::Pixel;
            for (uint64_t i = 0; i < size; i += 4)
                shader.ucode.push_back(BigEndian(&bytes[offset + i]));
            shaders.push_back(std::move(shader));
        }
    }

    // Synthetic microcode -------------------------------------------------------------------
    // Paths the game's shaders don't take (every ALU opcode, vertex format and fetch variant,
    // relative addressing, nested loops, jumps, calls / the state machine), assembled here with
    // the encodings of shader_translator.cpp's Cf / Alu / Fetch.

    struct Instr
    {
        uint32_t w[3];
        bool fetch;
    };

    struct CfSpec
    {
        uint32_t d0 = 0, d1 = 0;  // exec: address / count / sequence filled in by Assemble
        std::vector<Instr> body;
        bool exec = false;
    };

    enum : uint32_t
    {
        EXEC = 1, EXEC_END = 2, COND_EXEC = 3, COND_EXEC_END = 4, COND_EXEC_PRED = 5, COND_EXEC_PRED_END = 6,
        LOOP_START = 7, LOOP_END = 8, COND_CALL = 9, RETURN = 10, COND_JMP = 11, ALLOC = 12,
        COND_EXEC_PRED_CLEAN = 13, COND_EXEC_PRED_CLEAN_END = 14,
    };

    CfSpec Exec(uint32_t op, std::vector<Instr> body, uint32_t boolAddress = 0, bool condition = true)
    {
        CfSpec cf;
        cf.exec = true;
        cf.d1 = (op << 12) | (boolAddress << 2) | (uint32_t(condition) << 10);
        cf.body = std::move(body);
        return cf;
    }
    CfSpec Loop(uint32_t op, uint32_t target, uint32_t loopId, bool repeatOrBreak = false, bool condition = false)
    {
        CfSpec cf;
        cf.d0 = target | (loopId << 16) | (op == LOOP_START ? uint32_t(repeatOrBreak) << 13 : uint32_t(repeatOrBreak) << 21);
        cf.d1 = (op << 12) | (uint32_t(condition) << 10);
        return cf;
    }
    CfSpec Jump(uint32_t op, uint32_t target, bool unconditional, bool predicated, bool condition, uint32_t boolAddress = 0)
    {
        CfSpec cf;
        cf.d0 = target | (uint32_t(unconditional) << 13) | (uint32_t(predicated) << 14);
        cf.d1 = (op << 12) | (boolAddress << 2) | (uint32_t(condition) << 10);
        return cf;
    }
    CfSpec Simple(uint32_t op)
    {
        CfSpec cf;
        cf.d1 = op << 12;
        return cf;
    }

    struct A
    {
        uint32_t vop = 0, sop = 50, vdst = 0, sdst = 0, vmask = 0, smask = 0;
        bool vrel = false, srel = false, exp = false, absC = false, vclamp = false, sclamp = false;
        uint32_t src[4] = { 0, 0, 0, 0 }, swz[4] = { 0, 0, 0, 0 };
        bool temp[4] = { true, true, true, true }, neg[4] = { false, false, false, false };
        bool pred = false, predCond = false, addrRel = false, c0rel = false, c1rel = false;

        Instr Encode() const
        {
            Instr in{};
            in.fetch = false;
            in.w[0] = vdst | (uint32_t(vrel) << 6) | (uint32_t(absC) << 7) | (sdst << 8) | (uint32_t(srel) << 14) | (uint32_t(exp) << 15) |
                      (vmask << 16) | (smask << 20) | (uint32_t(vclamp) << 24) | (uint32_t(sclamp) << 25) | (sop << 26);
            in.w[1] = swz[3] | (swz[2] << 8) | (swz[1] << 16) | (uint32_t(neg[3]) << 24) | (uint32_t(neg[2]) << 25) | (uint32_t(neg[1]) << 26) |
                      (uint32_t(predCond) << 27) | (uint32_t(pred) << 28) | (uint32_t(addrRel) << 29) | (uint32_t(c1rel) << 30) | (uint32_t(c0rel) << 31);
            in.w[2] = src[3] | (src[2] << 8) | (src[1] << 16) | (vop << 24) | (uint32_t(temp[3]) << 29) | (uint32_t(temp[2]) << 30) | (uint32_t(temp[1]) << 31);
            return in;
        }
    };

    constexpr uint32_t XYZW = 0 | (1 << 3) | (2 << 6) | (3 << 9);

    Instr VFetch(uint32_t dst, uint32_t src, uint32_t fc, uint32_t format, bool mini, int32_t offset, uint32_t stride,
                 bool isSigned = false, bool integer = false, int32_t exp = 0, uint32_t dstSwizzle = XYZW, bool srcRel = false,
                 bool dstRel = false, bool pred = false, bool predCond = false, uint32_t srcComp = 0, bool rounded = false)
    {
        Instr in{};
        in.fetch = true;
        in.w[0] = 0 | (src << 5) | (uint32_t(srcRel) << 11) | (dst << 12) | (uint32_t(dstRel) << 18) | ((fc / 3) << 20) | ((fc % 3) << 25) | (srcComp << 30);
        in.w[1] = dstSwizzle | (uint32_t(isSigned) << 12) | (uint32_t(integer) << 13) | (uint32_t(rounded) << 15) | (format << 16) |
                  ((uint32_t(exp) & 0x3F) << 24) | (uint32_t(mini) << 30) | (uint32_t(pred) << 31);
        in.w[2] = stride | ((uint32_t(offset) & 0x7FFFFF) << 8) | (uint32_t(predCond) << 31);
        return in;
    }

    struct T
    {
        uint32_t op = 1, dst = 0, src = 0, fc = 0, srcSwizzle = 0 | (1 << 2) | (2 << 4), dstSwizzle = XYZW, dim = 1;
        bool unnormalized = false, computedLod = true, registerLod = false, srcRel = false, dstRel = false, pred = false, predCond = false;
        int32_t lodBias = 0, offX = 0, offY = 0;
        uint32_t mag = 0, min = 0, mip = 0, aniso = 0;

        Instr Encode() const
        {
            Instr in{};
            in.fetch = true;
            in.w[0] = op | (src << 5) | (uint32_t(srcRel) << 11) | (dst << 12) | (uint32_t(dstRel) << 18) | (fc << 20) | (uint32_t(unnormalized) << 25) | (srcSwizzle << 26);
            in.w[1] = dstSwizzle | (mag << 12) | (min << 14) | (mip << 16) | (aniso << 18) | (uint32_t(computedLod) << 28) | (uint32_t(registerLod) << 29) | (uint32_t(pred) << 31);
            in.w[2] = ((uint32_t(lodBias) & 0x7F) << 2) | (dim << 14) | ((uint32_t(offX) & 0x1F) << 16) | ((uint32_t(offY) & 0x1F) << 21) | (uint32_t(predCond) << 31);
            return in;
        }
    };

    Shader Assemble(const std::string& name, gpu::ShaderStage stage, std::vector<CfSpec> cfs)
    {
        if (cfs.size() & 1)
            cfs.push_back(Simple(0));
        uint32_t slot = uint32_t(cfs.size() / 2);
        std::vector<Instr> instructions;
        for (CfSpec& cf : cfs)
        {
            if (!cf.exec)
                continue;
            if (cf.body.size() > 6)
            {
                fprintf(stderr, "%s: exec with %zu instructions\n", name.c_str(), cf.body.size());
                exit(1);
            }
            uint32_t sequence = 0;
            for (size_t i = 0; i < cf.body.size(); i++)
                sequence |= uint32_t(cf.body[i].fetch) << (2 * i);
            cf.d0 = slot | (uint32_t(cf.body.size()) << 12) | (sequence << 16);
            slot += uint32_t(cf.body.size());
            instructions.insert(instructions.end(), cf.body.begin(), cf.body.end());
        }
        Shader shader;
        shader.name = name;
        shader.stage = stage;
        for (size_t i = 0; i < cfs.size(); i += 2)
        {
            const CfSpec& a = cfs[i];
            const CfSpec& b = cfs[i + 1];
            shader.ucode.push_back(a.d0);
            shader.ucode.push_back((a.d1 & 0xFFFF) | (b.d0 << 16));
            shader.ucode.push_back((b.d0 >> 16) | (b.d1 << 16));
        }
        for (const Instr& in : instructions)
            shader.ucode.insert(shader.ucode.end(), in.w, in.w + 3);
        return shader;
    }

    // Splits instructions into execs of 6 (the last one ending the shader when `end`).
    std::vector<CfSpec> Execs(const std::vector<Instr>& instructions, bool end)
    {
        std::vector<CfSpec> cfs;
        for (size_t i = 0; i < instructions.size(); i += 6)
        {
            std::vector<Instr> body(instructions.begin() + i, instructions.begin() + std::min(i + 6, instructions.size()));
            bool last = i + 6 >= instructions.size();
            cfs.push_back(Exec(last && end ? EXEC_END : EXEC, body));
        }
        return cfs;
    }

    Instr Export(uint32_t target, uint32_t src, uint32_t mask = 0xF)
    {
        A a;
        a.vop = 0;  // add src + 0 constant
        a.exp = true;
        a.vdst = target;
        a.vmask = mask;
        a.src[1] = src;
        a.src[2] = 0;
        a.temp[2] = false;
        return a.Encode();
    }

    // Every vector opcode co-issued with every scalar opcode, with the source / destination forms.
    std::vector<Instr> AluSweep(bool pixel)
    {
        std::vector<Instr> out;
        for (uint32_t k = 0; k < 64; k++)
        {
            A a;
            a.vop = k & 31;
            a.sop = k;
            if (pixel && ((a.vop >= 24 && a.vop <= 27) || (a.sop >= 35 && a.sop <= 39)))
                a.pred = true;  // kills under a predicate, so the rest still runs
            a.predCond = (k & 1) != 0;
            a.vdst = 1 + (k % 9);
            a.sdst = 2 + (k % 7);
            a.vmask = (k * 7) & 0xF;
            a.smask = (k * 5 + 1) & 0xF;
            a.vclamp = (k & 2) != 0;
            a.sclamp = (k & 4) != 0;
            a.absC = (k & 8) != 0;
            for (uint32_t s = 1; s <= 3; s++)
            {
                a.src[s] = (k * 3 + s * 11) & 0x3F;
                a.temp[s] = ((k >> s) & 1) != 0;
                a.swz[s] = (k * 37 + s * 101) & 0xFF;
                a.neg[s] = ((k + s) % 3) == 0;
                if (a.temp[s] && (k % 5) == s)
                    a.src[s] |= 0x40;  // relative temp
                if (a.temp[s] && (k % 7) == s)
                    a.src[s] |= 0x80;  // abs temp
            }
            a.c0rel = (k % 4) == 1;
            a.c1rel = (k % 4) == 2;
            a.addrRel = (k & 16) != 0;
            a.vrel = (k % 11) == 3;
            a.srel = (k % 13) == 5;
            out.push_back(a.Encode());
        }
        // Exports with the scalar unit: constant 1 / 0 lanes, oDepth (pixel) and oPos / misc (vertex).
        uint32_t targets[] = { 0, 1, 2, 3, 61, 62, 63, 32 };
        for (uint32_t t : targets)
        {
            A a;
            a.exp = true;
            a.vop = 1;
            a.vdst = t;
            a.vmask = 0x3;
            a.smask = 0x6;
            a.sop = 0;
            a.srel = t == 1;
            a.src[1] = 1; a.src[2] = 2; a.src[3] = 3;
            out.push_back(a.Encode());
        }
        return out;
    }

    void AddSynthetic(std::vector<Shader>& shaders)
    {
        using gpu::ShaderStage;
        const uint32_t formats[] = { 6, 7, 16, 17, 25, 26, 31, 32, 33, 34, 35, 36, 37, 38, 57, 10 };

        // Vertex formats: a full fetch then minis, signed / integer / exponent variants.
        {
            std::vector<Instr> body;
            uint32_t i = 0;
            for (uint32_t format : formats)
            {
                bool mini = i % 4 != 0;
                body.push_back(VFetch(1 + i % 14, 0, 3 + i / 4, format, mini, int32_t(i) - 2, 16, i & 1, (i >> 1) & 1, (i % 3) ? int32_t(i) - 8 : 0,
                                      i == 5 ? (0 | (4 << 3) | (5 << 6) | (7 << 9)) : XYZW, false, i == 7, i == 9, i == 10, i == 11 ? 1 : 0, i == 12));
                i++;
            }
            body.push_back(VFetch(2, 1, 95, 38, false, 0, 4, false, false, 0, XYZW, true));  // relative source
            body.push_back(Export(62, 1));
            body.push_back(Export(0, 2));
            body.push_back(Export(15, 3, 0x5));
            std::vector<CfSpec> cfs = Execs(body, true);
            shaders.push_back(Assemble("syn_vs_formats", ShaderStage::Vertex, cfs));
        }

        // ALU sweep in both stages, with bool constant and predicate conditioned execs.
        for (int pixel = 0; pixel < 2; pixel++)
        {
            std::vector<Instr> body = AluSweep(pixel != 0);
            std::vector<CfSpec> cfs;
            uint32_t ops[] = { EXEC, COND_EXEC, COND_EXEC_PRED, COND_EXEC_PRED_CLEAN };
            uint32_t n = 0;
            for (size_t i = 0; i < body.size(); i += 6, n++)
            {
                std::vector<Instr> part(body.begin() + i, body.begin() + std::min(i + 6, body.size()));
                bool last = i + 6 >= body.size();
                cfs.push_back(Exec(last ? COND_EXEC_PRED_END : ops[n % 4], part, (n * 29) & 0xFF, (n & 1) != 0));
            }
            cfs.push_back(Exec(EXEC_END, { Export(pixel ? 0 : 62, 1) }));
            shaders.push_back(Assemble(pixel ? "syn_ps_alu" : "syn_vs_alu", pixel ? ShaderStage::Pixel : ShaderStage::Vertex, cfs));
        }

        // Texture fetch variants (pixel: gradients for the pristine inputs; vertex: LOD 0).
        for (int pixel = 0; pixel < 2; pixel++)
        {
            std::vector<Instr> body;
            T t;
            t.dst = 20; t.src = 1; t.fc = 0;  body.push_back(t.Encode());                  // gradients (r1 pristine)
            t = T(); t.dst = 21; t.src = 2; t.fc = 1; t.unnormalized = true; t.offX = 3; t.offY = -2; t.lodBias = -9;
            t.srcSwizzle = 1 | (0 << 2) | (3 << 4); body.push_back(t.Encode());           // gradients, unnormalized, offsets
            t = T(); t.dst = 22; t.src = 3; t.fc = 2; t.dim = 0; body.push_back(t.Encode());     // 1D
            t = T(); t.dst = 23; t.src = 3; t.fc = 3; t.dim = 3; body.push_back(t.Encode());     // cube
            t = T(); t.dst = 24; t.src = 4; t.fc = 4; t.dim = 2; t.pred = true; body.push_back(t.Encode());  // 3D, predicated
            t = T(); t.dst = 25; t.src = 5; t.fc = 5; t.registerLod = true; t.dstSwizzle = 3 | (4 << 3) | (5 << 6) | (7 << 9); body.push_back(t.Encode());
            t = T(); t.op = 19; t.dst = 26; t.src = 6; t.fc = 6; body.push_back(t.Encode());     // getWeights
            t = T(); t.op = 17; t.dst = 27; t.src = 6; t.fc = 7; body.push_back(t.Encode());     // getComputedLOD
            t = T(); t.op = 18; t.dst = 28; t.src = 7; t.fc = 8; body.push_back(t.Encode());     // getGradients
            t = T(); t.op = 16; t.dst = 29; t.src = 7; t.fc = 9; body.push_back(t.Encode());     // getBorderColorFrac
            t = T(); t.op = 24; t.dst = 0; t.src = 8; body.push_back(t.Encode());               // setTexLOD
            t = T(); t.op = 25; t.dst = 0; t.src = 8; body.push_back(t.Encode());               // setGradientH
            t = T(); t.dst = 1; t.src = 9; t.fc = 31; t.srcRel = true; body.push_back(t.Encode());  // relative source (a relative destination disables gradients)
            t = T(); t.dst = 30; t.src = 1; t.fc = 0; body.push_back(t.Encode());               // r1 now written: LOD 0
            body.push_back(Export(pixel ? 0 : 62, 20));
            body.push_back(Export(pixel ? 1 : 0, 21));
            shaders.push_back(Assemble(pixel ? "syn_ps_tex" : "syn_vs_tex", pixel ? ShaderStage::Pixel : ShaderStage::Vertex, Execs(body, true)));
        }

        // Structured control flow: nested loops with relative addressing, forward jumps inside a
        // loop and at the top level, a predicated loop break.
        for (int pixel = 0; pixel < 2; pixel++)
        {
            A rel;  // r[aL + 2] = c[aL + 4] * r[aL + 5]
            rel.vop = 1; rel.vdst = 2; rel.vrel = true; rel.vmask = 0xF; rel.src[1] = 4; rel.temp[1] = false; rel.c0rel = true;
            rel.src[2] = 5 | 0x40; rel.sop = 27; rel.src[3] = 1;  // setp_eq
            A maxa;  // a0 = r1.w
            maxa.vop = 29; maxa.vdst = 3; maxa.vmask = 1; maxa.src[1] = 1; maxa.src[2] = 1;
            A addr;  // c[a0 + 7]
            addr.vop = 0; addr.vdst = 6; addr.vmask = 0xF; addr.src[1] = 7; addr.temp[1] = false; addr.c0rel = true; addr.addrRel = true; addr.src[2] = 6;
            T tex; tex.dst = 8; tex.src = 1; tex.fc = 2;  // pixel: gradients would apply outside the loop, not here (r1 not written: still pristine)
            std::vector<CfSpec> cfs;
            cfs.push_back(Exec(EXEC, { maxa.Encode(), addr.Encode() }));          // 0
            cfs.push_back(Jump(COND_JMP, 4, false, false, true, 3));               // 1: bool 3 skips 2-3
            cfs.push_back(Exec(EXEC, { rel.Encode() }));                           // 2
            cfs.push_back(Exec(COND_EXEC_PRED, { addr.Encode() }));                // 3
            cfs.push_back(Loop(LOOP_START, 12, 0));                                // 4 -> loop end 11
            cfs.push_back(Exec(EXEC, { rel.Encode(), tex.Encode() }));             // 5
            cfs.push_back(Jump(COND_JMP, 8, false, true, false));                  // 6: !p0 skips 7
            cfs.push_back(Exec(EXEC, { addr.Encode() }));                          // 7
            cfs.push_back(Loop(LOOP_START, 11, 1, true));                          // 8 (repeat) -> loop end 10
            cfs.push_back(Exec(EXEC, { rel.Encode() }));                           // 9
            cfs.push_back(Loop(LOOP_END, 9, 1, true, true));                       // 10: break on p0
            cfs.push_back(Loop(LOOP_END, 5, 0));                                   // 11
            cfs.push_back(Exec(EXEC_END, { Export(pixel ? 0 : 62, 2), Export(pixel ? 61 : 0, 8) }));  // 12
            shaders.push_back(Assemble(pixel ? "syn_ps_loops" : "syn_vs_loops", pixel ? ShaderStage::Pixel : ShaderStage::Vertex, cfs));
        }

        // General control flow (state machine): a call / return, a backward jump, loops.
        for (int pixel = 0; pixel < 2; pixel++)
        {
            A rel;
            rel.vop = 11; rel.vdst = 2; rel.vrel = true; rel.vmask = 0xF; rel.src[1] = 4; rel.temp[1] = false; rel.c1rel = true;
            rel.src[2] = 5 | 0x40; rel.src[3] = 2; rel.sop = 30; rel.temp[3] = true;  // setp_ge
            A kill;
            kill.vop = 25; kill.src[1] = 2; kill.src[2] = 3; kill.pred = true;
            T tex; tex.dst = 9; tex.src = 1; tex.fc = 4;
            std::vector<CfSpec> cfs;
            cfs.push_back(Exec(EXEC, { tex.Encode(), rel.Encode() }));             // 0
            cfs.push_back(Jump(COND_CALL, 8, true, false, false));                 // 1: call 8
            cfs.push_back(Loop(LOOP_START, 5, 2));                                 // 2 -> 4
            cfs.push_back(Exec(COND_EXEC_PRED, { rel.Encode(), kill.Encode() }));  // 3
            cfs.push_back(Loop(LOOP_END, 3, 2, true, false));                      // 4
            cfs.push_back(Jump(COND_JMP, 0, false, true, true));                   // 5: p0 jumps back to 0
            cfs.push_back(Exec(COND_EXEC_END, { Export(pixel ? 0 : 62, 2) }, 7, false));  // 6
            cfs.push_back(Exec(EXEC_END, { Export(pixel ? 0 : 62, 9) }));          // 7
            cfs.push_back(Exec(EXEC, { rel.Encode() }));                           // 8
            cfs.push_back(Simple(RETURN));                                         // 9
            shaders.push_back(Assemble(pixel ? "syn_ps_machine" : "syn_vs_machine", pixel ? ShaderStage::Pixel : ShaderStage::Vertex, cfs));
        }
    }
}

int main(int argc, char** argv)
{
    if (argc < 3)
    {
        fprintf(stderr, "usage: %s <out dir> <ucode dir> [<game shaders dir>]\n", argv[0]);
        return 2;
    }
    fs::path outDir = argv[1];
    fs::create_directories(outDir);
    std::vector<Shader> shaders;
    AddCaptured(argv[2], shaders);
    AddGameShaders(argc > 3 ? argv[3] : "", shaders);
    AddSynthetic(shaders);
    std::sort(shaders.begin(), shaders.end(), [](const Shader& a, const Shader& b) { return a.name < b.name; });

    // The WGSL translator samples as the HLSL one's "gradients" mode.
    gpu::SetImplicitDerivatives(false);
    for (const Shader& shader : shaders)
    {
        gpu::TranslatedShader hlsl = gpu::TranslateShader(shader.stage, shader.ucode.data(), uint32_t(shader.ucode.size()));
        gpu::TranslatedShader wgsl = gpu::wgsl::TranslateShader(shader.stage, shader.ucode.data(), uint32_t(shader.ucode.size()));
        WriteFile(outDir / (shader.name + ".hlsl"), hlsl.hlsl);
        WriteFile(outDir / (shader.name + ".wgsl"), wgsl.hlsl);
        bool same = hlsl.colorTargetsWritten == wgsl.colorTargetsWritten && hlsl.writesDepth == wgsl.writesDepth &&
                    hlsl.hasKill == wgsl.hasKill && hlsl.usesControlFlowMachine == wgsl.usesControlFlowMachine &&
                    hlsl.instructionCount == wgsl.instructionCount && hlsl.textures.size() == wgsl.textures.size() &&
                    hlsl.vertexFetches.size() == wgsl.vertexFetches.size() && hlsl.hash == wgsl.hash;
        printf("%-32s %s %4zu dwords %3u instr, %zu tex, %zu vfetch%s%s%s\n", shader.name.c_str(),
               shader.stage == gpu::ShaderStage::Pixel ? "ps" : "vs", shader.ucode.size(), wgsl.instructionCount,
               wgsl.textures.size(), wgsl.vertexFetches.size(), wgsl.usesControlFlowMachine ? ", control flow" : "",
               wgsl.hasKill ? ", kill" : "", same ? "" : "  METADATA MISMATCH");
        if (!same)
            return 1;
    }
    printf("%zu shaders translated\n", shaders.size());
    return 0;
}

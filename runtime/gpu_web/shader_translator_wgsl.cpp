// Xenos microcode -> WGSL. See shader_translator_wgsl.h for the interface with the renderer.
//
// Forked from crashott-pc's runtime/gpu/shader_translator.cpp (MIT license, Xenos -> HLSL), which
// follows Xenia's ucode.h and shader_interpreter.cc (BSD license) for the instruction formats and
// ALU/fetch semantics. The generated code mirrors the HLSL one statement for statement; the
// differences are WGSL's: no multi-component swizzle assignment (one statement per component),
// select() instead of vector ternaries, explicit conversions, loop/switch instead of [loop] for,
// and only explicit-gradient / explicit-LOD sampling (FindGradientFetches) because the uniformity
// analysis rejects implicit derivatives inside the translated control flow.
//
// Microcode layout (Xenia ucode.h): control flow instructions (48 bits, packed in pairs into 3
// dwords) come first; exec instructions point at ALU/fetch instruction slots (3 dwords each)
// further on.

#include "shader_translator_wgsl.h"
#include "gpu/xenos.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace gpu::wgsl
{
    namespace
    {
        void Append(std::string& out, const char* format, ...)
        {
            char buffer[1024];
            va_list args;
            va_start(args, format);
            int length = vsnprintf(buffer, sizeof(buffer), format, args);
            va_end(args);
            if (length > 0)
                out.append(buffer, std::min<size_t>(size_t(length), sizeof(buffer) - 1));
        }

        // A WGSL float literal (always with a decimal point or an exponent).
        std::string FloatLiteral(double value)
        {
            char buffer[64];
            snprintf(buffer, sizeof(buffer), "%.9g", value);
            std::string text = buffer;
            if (text.find_first_of(".e") == std::string::npos)
                text += ".0";
            return text;
        }

        constexpr const char* COMPONENTS = "xyzw";

        // Control flow -------------------------------------------------------------------------

        enum CfOpcode : uint32_t
        {
            CF_NOP = 0,
            CF_EXEC = 1,
            CF_EXEC_END = 2,
            CF_COND_EXEC = 3,
            CF_COND_EXEC_END = 4,
            CF_COND_EXEC_PRED = 5,
            CF_COND_EXEC_PRED_END = 6,
            CF_LOOP_START = 7,
            CF_LOOP_END = 8,
            CF_COND_CALL = 9,
            CF_RETURN = 10,
            CF_COND_JMP = 11,
            CF_ALLOC = 12,
            CF_COND_EXEC_PRED_CLEAN = 13,
            CF_COND_EXEC_PRED_CLEAN_END = 14,
            CF_MARK_VS_FETCH_DONE = 15,
        };

        struct Cf
        {
            uint32_t dword0; // bits 0-31
            uint32_t dword1; // bits 32-47 (low 16 bits)

            uint32_t Opcode() const { return (dword1 >> 12) & 0xF; }
            bool IsExec() const
            {
                switch (Opcode())
                {
                case CF_EXEC: case CF_EXEC_END: case CF_COND_EXEC: case CF_COND_EXEC_END:
                case CF_COND_EXEC_PRED: case CF_COND_EXEC_PRED_END:
                case CF_COND_EXEC_PRED_CLEAN: case CF_COND_EXEC_PRED_CLEAN_END:
                    return true;
                default:
                    return false;
                }
            }
            bool EndsShader() const
            {
                uint32_t op = Opcode();
                return op == CF_EXEC_END || op == CF_COND_EXEC_END || op == CF_COND_EXEC_PRED_END || op == CF_COND_EXEC_PRED_CLEAN_END;
            }
            // Exec.
            uint32_t ExecAddress() const { return dword0 & 0xFFF; }
            uint32_t ExecCount() const { return (dword0 >> 12) & 7; }
            uint32_t ExecSequence() const { return (dword0 >> 16) & 0xFFF; }
            // Cond exec (bool constant) / cond call / cond jmp.
            uint32_t BoolAddress() const { return (dword1 >> 2) & 0xFF; }
            bool Condition() const { return (dword1 >> 10) & 1; }
            // Loop / call / jump.
            uint32_t TargetAddress() const { return dword0 & 0x1FFF; }
            bool LoopIsRepeat() const { return (dword0 >> 13) & 1; }
            uint32_t LoopId() const { return (dword0 >> 16) & 0x1F; }
            bool LoopEndPredicatedBreak() const { return (dword0 >> 21) & 1; }
            bool IsUnconditional() const { return (dword0 >> 13) & 1; }
            bool IsPredicated() const { return (dword0 >> 14) & 1; }
        };

        // ALU ----------------------------------------------------------------------------------

        enum VectorOpcode : uint32_t
        {
            V_ADD = 0, V_MUL = 1, V_MAX = 2, V_MIN = 3, V_SEQ = 4, V_SGT = 5, V_SGE = 6, V_SNE = 7,
            V_FRC = 8, V_TRUNC = 9, V_FLOOR = 10, V_MAD = 11, V_CNDEQ = 12, V_CNDGE = 13, V_CNDGT = 14,
            V_DP4 = 15, V_DP3 = 16, V_DP2ADD = 17, V_CUBE = 18, V_MAX4 = 19,
            V_SETP_EQ_PUSH = 20, V_SETP_NE_PUSH = 21, V_SETP_GT_PUSH = 22, V_SETP_GE_PUSH = 23,
            V_KILL_EQ = 24, V_KILL_GT = 25, V_KILL_GE = 26, V_KILL_NE = 27, V_DST = 28, V_MAXA = 29,
        };

        enum ScalarOpcode : uint32_t
        {
            S_ADDS = 0, S_ADDS_PREV = 1, S_MULS = 2, S_MULS_PREV = 3, S_MULS_PREV2 = 4, S_MAXS = 5,
            S_MINS = 6, S_SEQS = 7, S_SGTS = 8, S_SGES = 9, S_SNES = 10, S_FRCS = 11, S_TRUNCS = 12,
            S_FLOORS = 13, S_EXP = 14, S_LOGC = 15, S_LOG = 16, S_RCPC = 17, S_RCPF = 18, S_RCP = 19,
            S_RSQC = 20, S_RSQF = 21, S_RSQ = 22, S_MAXAS = 23, S_MAXASF = 24, S_SUBS = 25,
            S_SUBS_PREV = 26, S_SETP_EQ = 27, S_SETP_NE = 28, S_SETP_GT = 29, S_SETP_GE = 30,
            S_SETP_INV = 31, S_SETP_POP = 32, S_SETP_CLR = 33, S_SETP_RSTR = 34, S_KILLS_EQ = 35,
            S_KILLS_GT = 36, S_KILLS_GE = 37, S_KILLS_NE = 38, S_KILLS_ONE = 39, S_SQRT = 40,
            S_MULSC0 = 42, S_MULSC1 = 43, S_ADDSC0 = 44, S_ADDSC1 = 45, S_SUBSC0 = 46, S_SUBSC1 = 47,
            S_SIN = 48, S_COS = 49, S_RETAIN_PREV = 50,
        };

        // Number of vector operands (src1..src3) each vector opcode reads.
        uint32_t VectorOperandCount(uint32_t op)
        {
            switch (op)
            {
            case V_FRC: case V_TRUNC: case V_FLOOR: case V_MAX4: case V_CUBE:
                return 1;
            case V_MAD: case V_CNDEQ: case V_CNDGE: case V_CNDGT: case V_DP2ADD:
                return 3;
            default:
                return 2;
            }
        }

        // Scalar operand form: 0 none, 1 = src3.a, 2 = src3.ab, 3 = constant.a + temp.b.
        uint32_t ScalarOperandForm(uint32_t op)
        {
            switch (op)
            {
            case S_ADDS: case S_MULS: case S_MULS_PREV2: case S_MAXS: case S_MINS: case S_MAXAS:
            case S_MAXASF: case S_SUBS:
                return 2;
            case S_SETP_CLR: case S_RETAIN_PREV:
                return 0;
            case S_MULSC0: case S_MULSC1: case S_ADDSC0: case S_ADDSC1: case S_SUBSC0: case S_SUBSC1:
                return 3;
            default:
                return 1;
            }
        }

        struct Alu
        {
            uint32_t d0, d1, d2;

            uint32_t VectorDest() const { return d0 & 0x3F; }
            bool VectorDestRelative() const { return (d0 >> 6) & 1; }
            bool AbsConstants() const { return (d0 >> 7) & 1; }
            uint32_t ScalarDest() const { return (d0 >> 8) & 0x3F; }
            bool ScalarDestRelative() const { return (d0 >> 14) & 1; }
            bool IsExport() const { return (d0 >> 15) & 1; }
            uint32_t VectorMask() const { return (d0 >> 16) & 0xF; }
            uint32_t ScalarMask() const { return (d0 >> 20) & 0xF; }
            bool VectorClamp() const { return (d0 >> 24) & 1; }
            bool ScalarClamp() const { return (d0 >> 25) & 1; }
            uint32_t ScalarOp() const { return (d0 >> 26) & 0x3F; }
            uint32_t SrcSwizzle(uint32_t i) const { return (d1 >> (8 * (3 - i))) & 0xFF; }
            bool SrcNegate(uint32_t i) const { return (d1 >> (24 + 3 - i)) & 1; }
            bool PredCondition() const { return (d1 >> 27) & 1; }
            bool IsPredicated() const { return (d1 >> 28) & 1; }
            bool ConstAddressRegisterRelative() const { return (d1 >> 29) & 1; }
            bool Const1RelAbs() const { return (d1 >> 30) & 1; }
            bool Const0RelAbs() const { return (d1 >> 31) & 1; }
            uint32_t SrcReg(uint32_t i) const { return (d2 >> (8 * (3 - i))) & 0xFF; }
            uint32_t VectorOp() const { return (d2 >> 24) & 0x1F; }
            bool SrcIsTemp(uint32_t i) const { return (d2 >> (29 + 3 - i)) & 1; }

            // Which of const_0/const_1 addressing bits applies to constant operand i (Xenia).
            bool SrcConstIsAddressed(uint32_t i) const
            {
                switch (i)
                {
                case 1: return Const0RelAbs();
                case 2: return SrcIsTemp(1) ? Const0RelAbs() : Const1RelAbs();
                default: return (SrcIsTemp(1) && SrcIsTemp(2)) ? Const0RelAbs() : Const1RelAbs();
                }
            }
        };

        // Absolute component selected by a relative ALU swizzle for result component `i`.
        uint32_t SwizzledComponent(uint32_t swizzle, uint32_t i)
        {
            return ((swizzle >> (2 * i)) + i) & 3;
        }

        // Fetch --------------------------------------------------------------------------------

        enum FetchOpcode : uint32_t
        {
            F_VERTEX = 0,
            F_TEXTURE = 1,
            F_GET_BORDER_COLOR_FRAC = 16,
            F_GET_COMPUTED_LOD = 17,
            F_GET_GRADIENTS = 18,
            F_GET_WEIGHTS = 19,
            F_SET_LOD = 24,
            F_SET_GRADIENTS_H = 25,
            F_SET_GRADIENTS_V = 26,
        };

        struct Fetch
        {
            uint32_t d0, d1, d2;

            uint32_t Opcode() const { return d0 & 0x1F; }
            uint32_t SrcReg() const { return (d0 >> 5) & 0x3F; }
            bool SrcRelative() const { return (d0 >> 11) & 1; }
            uint32_t DstReg() const { return (d0 >> 12) & 0x3F; }
            bool DstRelative() const { return (d0 >> 18) & 1; }
            uint32_t DstSwizzle() const { return d1 & 0xFFF; }
            bool IsPredicated() const { return (d1 >> 31) & 1; }
            bool PredCondition() const { return (d2 >> 31) & 1; }

            // Vertex fetch.
            uint32_t VertexFetchConstant() const { return ((d0 >> 20) & 0x1F) * 3 + ((d0 >> 25) & 3); }
            uint32_t VertexSrcComponent() const { return (d0 >> 30) & 3; }
            bool VertexSigned() const { return (d1 >> 12) & 1; }
            bool VertexInteger() const { return (d1 >> 13) & 1; } // num_format_all: 0 = normalized
            bool VertexIndexRounded() const { return (d1 >> 15) & 1; }
            uint32_t VertexFormat() const { return (d1 >> 16) & 0x3F; }
            int32_t VertexExpAdjust() const { return xenos::SignedBits(d1, 24, 6); }
            bool VertexIsMini() const { return (d1 >> 30) & 1; }
            uint32_t VertexStride() const { return d2 & 0xFF; }
            int32_t VertexOffset() const { return xenos::SignedBits(d2, 8, 23); }

            // Texture fetch.
            uint32_t TextureFetchConstant() const { return (d0 >> 20) & 0x1F; }
            bool TextureUnnormalized() const { return (d0 >> 25) & 1; }
            uint32_t TextureSrcSwizzle() const { return (d0 >> 26) & 0x3F; }
            uint32_t TextureMagFilter() const { return (d1 >> 12) & 3; }
            uint32_t TextureMinFilter() const { return (d1 >> 14) & 3; }
            uint32_t TextureMipFilter() const { return (d1 >> 16) & 3; }
            uint32_t TextureAnisoFilter() const { return (d1 >> 18) & 7; }
            bool TextureUseComputedLod() const { return (d1 >> 28) & 1; }
            bool TextureUseRegisterLod() const { return (d1 >> 29) & 1; }
            int32_t TextureLodBias() const { return xenos::SignedBits(d2, 2, 7); } // 1/16
            uint32_t TextureDimension() const { return (d2 >> 14) & 3; }
            int32_t TextureOffset(uint32_t i) const { return xenos::SignedBits(d2, 16 + 5 * i, 5); } // 1/2
        };

        // Translator ---------------------------------------------------------------------------

        class Translator
        {
        public:
            Translator(ShaderStage stage, const uint32_t* ucode, uint32_t dwordCount)
                : m_stage(stage), m_ucode(ucode), m_dwordCount(dwordCount)
            {
            }

            TranslatedShader Run();

        private:
            ShaderStage m_stage;
            const uint32_t* m_ucode;
            uint32_t m_dwordCount;
            TranslatedShader m_out;
            std::vector<Cf> m_cf;
            std::string m_body;
            int m_indent = 1;
            uint32_t m_maxRegister = 0;
            bool m_relativeTemps = false;
            bool m_r0Dirty = false;
            // vfetch_mini reuses the address of the last vfetch_full.
            uint32_t m_lastFullFetchConstant = 0;
            bool m_haveFullFetch = false;
            // Pixel shader texture fetches sampled with gradients (by instruction slot): their
            // coordinates are still the unmodified input register, whose derivatives main()
            // computes before running the shader (m_gradientRegisters, bit per register).
            std::vector<uint8_t> m_gradientFetch;
            uint32_t m_gradientRegisters = 0;
            uint32_t m_currentSlot = 0;
            // Structured control flow (FindStructuredFlow): the loop end of each loop start, and
            // the instructions a forward jump can skip.
            std::vector<uint32_t> m_loopEnd;
            std::vector<uint8_t> m_skippable;
            bool m_hasLoops = false;

            bool IsPixel() const { return m_stage == ShaderStage::Pixel; }

            void Line(const char* format, ...);
            void ParseControlFlow();
            void ScanRegisters();
            void FindGradientFetches();
            void EmitExec(const Cf& cf, const std::string& condition);
            void EmitStructured();
            bool FindStructuredFlow();
            void EmitStructuredFlow();
            void EmitStructuredRange(uint32_t begin, uint32_t end, uint32_t depth);
            void EmitStateMachine();
            void EmitExecBody(const Cf& cf);
            std::string ExecCondition(const Cf& cf) const;
            std::string BoolConstant(uint32_t index) const;

            void EmitAlu(const Alu& alu);
            void EmitFetch(const Fetch& fetch);
            void EmitVertexFetch(const Fetch& fetch);
            void EmitTextureFetch(const Fetch& fetch);

            std::string TempRegister(uint32_t index, bool relative) const;
            std::string AluSource(const Alu& alu, uint32_t i) const;      // full vec4f with swizzle/abs/negate
            // forceConstant: read src i as a float constant whatever its sel bit says (the
            // constant operand of MULSC/ADDSC/SUBSC, whose src3 sel bit is part of the temp index).
            std::string AluSourceRaw(const Alu& alu, uint32_t i, bool& absolute, bool forceConstant = false) const;
            // `destination.c = value.c` for each component of `mask` (WGSL has no multi-component
            // swizzle assignment); `value` empty: `destination.c = constant`.
            void WriteMasked(const std::string& destination, uint32_t mask, const char* value, const char* constant = nullptr);
            void WriteFetchResult(const Fetch& fetch, const char* value);
            void NoteTempWrite(uint32_t reg, bool relative)
            {
                if (relative || reg == 0)
                    m_r0Dirty = true;
            }

            VertexFetchBinding& VertexBinding(uint32_t fetchConstant);
            TextureBinding& TextureBindingFor(uint32_t fetchConstant);
        };

        void Translator::Line(const char* format, ...)
        {
            m_body.append(size_t(m_indent) * 4, ' ');
            char buffer[2048];
            va_list args;
            va_start(args, format);
            int length = vsnprintf(buffer, sizeof(buffer), format, args);
            va_end(args);
            if (length > 0)
                m_body.append(buffer, std::min<size_t>(size_t(length), sizeof(buffer) - 1));
            m_body.push_back('\n');
        }

        void Translator::ParseControlFlow()
        {
            // Control flow ends where the first exec's instructions begin (3 dwords per slot).
            uint32_t maxDword = m_dwordCount;
            for (uint32_t i = 0; i + 3 <= maxDword; i += 3)
            {
                Cf pair[2];
                pair[0].dword0 = m_ucode[i];
                pair[0].dword1 = m_ucode[i + 1] & 0xFFFF;
                pair[1].dword0 = (m_ucode[i + 1] >> 16) | (m_ucode[i + 2] << 16);
                pair[1].dword1 = m_ucode[i + 2] >> 16;
                for (const Cf& cf : pair)
                {
                    if (cf.IsExec())
                        maxDword = std::min(maxDword, cf.ExecAddress() * 3);
                    m_cf.push_back(cf);
                    uint32_t op = cf.Opcode();
                    if (op == CF_LOOP_START || op == CF_LOOP_END || op == CF_COND_CALL || op == CF_RETURN || op == CF_COND_JMP)
                        m_out.usesControlFlowMachine = true;
                }
            }
        }

        // Finds the highest temp register index and whether relative addressing is used.
        void Translator::ScanRegisters()
        {
            auto note = [&](uint32_t reg) { m_maxRegister = std::max(m_maxRegister, reg); };
            for (const Cf& cf : m_cf)
            {
                if (!cf.IsExec())
                    continue;
                for (uint32_t i = 0; i < cf.ExecCount(); i++)
                {
                    uint32_t slot = cf.ExecAddress() + i;
                    if (slot * 3 + 3 > m_dwordCount)
                        break;
                    const uint32_t* words = m_ucode + slot * 3;
                    if ((cf.ExecSequence() >> (i * 2)) & 1)
                    {
                        Fetch fetch{ words[0], words[1], words[2] };
                        note(fetch.SrcReg());
                        note(fetch.DstReg());
                        m_relativeTemps |= fetch.SrcRelative() || fetch.DstRelative();
                    }
                    else
                    {
                        Alu alu{ words[0], words[1], words[2] };
                        if (!alu.IsExport())
                        {
                            note(alu.VectorDest());
                            note(alu.ScalarDest());
                            m_relativeTemps |= alu.VectorDestRelative() || alu.ScalarDestRelative();
                        }
                        for (uint32_t s = 1; s <= 3; s++)
                        {
                            if (alu.SrcIsTemp(s))
                            {
                                note(alu.SrcReg(s) & 0x3F);
                                m_relativeTemps |= (alu.SrcReg(s) & 0x40) != 0;
                            }
                        }
                        uint32_t form = ScalarOperandForm(alu.ScalarOp());
                        if (form == 3)
                            note((alu.ScalarOp() & 1) | (uint32_t(alu.SrcIsTemp(3)) << 1) | (alu.SrcSwizzle(3) & 0x3C));
                    }
                }
            }
        }

        // Mipmapped sampling needs derivatives, which WGSL only takes in uniform control flow (not
        // the state machine loop, the instructions a jump can skip, a loop, a predicated exec...).
        // The derivative of a coordinate that is still exactly a pixel shader input (interpolator
        // or param gen) can be taken at the top of main() instead. Finds the 2D fetches with
        // computed LOD whose coordinate components are not written by any instruction that can
        // run before them (earlier in control flow order, or anywhere in a loop / backward jump
        // range containing them). The other fetches sample LOD 0.
        void Translator::FindGradientFetches()
        {
            m_gradientFetch.assign(m_dwordCount / 3 + 1, 0);
            if (!IsPixel())
                return;
            struct Entry
            {
                uint32_t slot;
                uint32_t cf;
                bool isFetch;
            };
            std::vector<Entry> order;
            std::vector<std::pair<uint32_t, uint32_t>> repeats;
            for (uint32_t c = 0; c < uint32_t(m_cf.size()); c++)
            {
                const Cf& cf = m_cf[c];
                uint32_t op = cf.Opcode();
                if (op == CF_COND_CALL || op == CF_RETURN)
                    return;
                if ((op == CF_LOOP_END || op == CF_COND_JMP) && cf.TargetAddress() <= c)
                    repeats.push_back({ cf.TargetAddress(), c });
                if (!cf.IsExec())
                    continue;
                for (uint32_t i = 0; i < cf.ExecCount(); i++)
                {
                    uint32_t slot = cf.ExecAddress() + i;
                    if (slot * 3 + 3 > m_dwordCount)
                        break;
                    bool isFetch = ((cf.ExecSequence() >> (i * 2)) & 1) != 0;
                    const uint32_t* words = m_ucode + slot * 3;
                    // A relative write (r[aL + n]) can change any register: give up.
                    if (isFetch)
                    {
                        if (Fetch{ words[0], words[1], words[2] }.DstRelative())
                            return;
                    }
                    else
                    {
                        Alu alu{ words[0], words[1], words[2] };
                        if (!alu.IsExport() && (alu.VectorDestRelative() || alu.ScalarDestRelative()))
                            return;
                    }
                    order.push_back({ slot, c, isFetch });
                }
            }
            // Components of `reg` an instruction writes.
            auto writes = [&](const Entry& entry, uint32_t reg) -> uint32_t {
                const uint32_t* words = m_ucode + entry.slot * 3;
                if (entry.isFetch)
                {
                    Fetch fetch{ words[0], words[1], words[2] };
                    uint32_t op = fetch.Opcode();
                    if (fetch.DstReg() != reg || op == F_SET_LOD || op == F_SET_GRADIENTS_H || op == F_SET_GRADIENTS_V)
                        return 0;
                    uint32_t mask = 0;
                    for (uint32_t i = 0; i < 4; i++)
                        mask |= (((fetch.DstSwizzle() >> (3 * i)) & 7) != 7 ? 1u : 0u) << i;
                    return mask;
                }
                Alu alu{ words[0], words[1], words[2] };
                if (alu.IsExport())
                    return 0;
                uint32_t mask = 0;
                if (alu.VectorDest() == reg)
                    mask |= alu.VectorMask();
                if (alu.ScalarDest() == reg)
                    mask |= alu.ScalarMask();
                return mask;
            };
            for (size_t k = 0; k < order.size(); k++)
            {
                if (!order[k].isFetch)
                    continue;
                const uint32_t* words = m_ucode + order[k].slot * 3;
                Fetch fetch{ words[0], words[1], words[2] };
                if (fetch.Opcode() != F_TEXTURE || fetch.TextureDimension() != 1 || !fetch.TextureUseComputedLod() ||
                    fetch.TextureUseRegisterLod() || fetch.SrcRelative() || fetch.SrcReg() >= 16)
                    continue;
                uint32_t reg = fetch.SrcReg();
                uint32_t used = 0;
                for (uint32_t c = 0; c < 2; c++)
                    used |= 1u << ((fetch.TextureSrcSwizzle() >> (2 * c)) & 3);
                bool pristine = true;
                for (size_t j = 0; j < k && pristine; j++)
                    pristine = !(writes(order[j], reg) & used);
                for (const auto& [first, last] : repeats)
                {
                    if (!pristine || order[k].cf < first || order[k].cf > last)
                        continue;
                    for (const Entry& entry : order)
                    {
                        if (entry.cf >= first && entry.cf <= last && (writes(entry, reg) & used))
                            pristine = false;
                    }
                }
                if (pristine)
                {
                    m_gradientFetch[order[k].slot] = 1;
                    m_gradientRegisters |= 1u << reg;
                }
            }
        }

        std::string Translator::BoolConstant(uint32_t index) const
        {
            char buffer[96];
            uint32_t dword = index >> 5;
            snprintf(buffer, sizeof(buffer), "((xe_system.bool_consts[%u].%c >> %uu) & 1u)", dword >> 2, COMPONENTS[dword & 3], index & 31);
            return buffer;
        }

        std::string Translator::ExecCondition(const Cf& cf) const
        {
            switch (cf.Opcode())
            {
            case CF_COND_EXEC:
            case CF_COND_EXEC_END:
            case CF_COND_EXEC_PRED_CLEAN:
            case CF_COND_EXEC_PRED_CLEAN_END:
                return BoolConstant(cf.BoolAddress()) + (cf.Condition() ? " != 0u" : " == 0u");
            case CF_COND_EXEC_PRED:
            case CF_COND_EXEC_PRED_END:
                return cf.Condition() ? "xe_p0" : "!xe_p0";
            default:
                return "";
            }
        }

        std::string Translator::TempRegister(uint32_t index, bool relative) const
        {
            char buffer[64];
            if (relative)
                snprintf(buffer, sizeof(buffer), "r[clamp(xe_aL + %u, 0, 63)]", index);
            else
                snprintf(buffer, sizeof(buffer), "r[%u]", index);
            return buffer;
        }

        std::string Translator::AluSourceRaw(const Alu& alu, uint32_t i, bool& absolute, bool forceConstant) const
        {
            uint32_t reg = alu.SrcReg(i);
            char buffer[96];
            if (alu.SrcIsTemp(i) && !forceConstant)
            {
                absolute = (reg & 0x80) != 0;
                return TempRegister(reg & 0x3F, (reg & 0x40) != 0);
            }
            absolute = alu.AbsConstants();
            if (alu.SrcConstIsAddressed(i))
                snprintf(buffer, sizeof(buffer), "xe_c[clamp(%u + %s, 0, 255)]", reg, alu.ConstAddressRegisterRelative() ? "xe_a0" : "xe_aL");
            else
                snprintf(buffer, sizeof(buffer), "xe_c[%u]", reg);
            return buffer;
        }

        std::string Translator::AluSource(const Alu& alu, uint32_t i) const
        {
            bool absolute;
            std::string value = AluSourceRaw(alu, i, absolute);
            if (absolute)
                value = "abs(" + value + ")";
            uint32_t swizzle = alu.SrcSwizzle(i);
            value += '.';
            for (uint32_t c = 0; c < 4; c++)
                value += COMPONENTS[SwizzledComponent(swizzle, c)];
            if (alu.SrcNegate(i))
                value = "(-" + value + ")";
            return value;
        }

        VertexFetchBinding& Translator::VertexBinding(uint32_t fetchConstant)
        {
            for (auto& binding : m_out.vertexFetches)
            {
                if (binding.fetchConstant == fetchConstant)
                    return binding;
            }
            VertexFetchBinding binding;
            binding.fetchConstant = fetchConstant;
            binding.minOffsetDwords = INT32_MAX;
            binding.maxEndDwords = INT32_MIN;
            m_out.vertexFetches.push_back(binding);
            return m_out.vertexFetches.back();
        }

        TextureBinding& Translator::TextureBindingFor(uint32_t fetchConstant)
        {
            for (auto& binding : m_out.textures)
            {
                if (binding.fetchConstant == fetchConstant)
                    return binding;
            }
            TextureBinding binding;
            binding.fetchConstant = fetchConstant;
            m_out.textures.push_back(binding);
            return m_out.textures.back();
        }

        void Translator::WriteMasked(const std::string& destination, uint32_t mask, const char* value, const char* constant)
        {
            if (mask == 0xF && value)
            {
                Line("%s = %s;", destination.c_str(), value);
                return;
            }
            for (uint32_t c = 0; c < 4; c++)
            {
                if (!(mask & (1u << c)))
                    continue;
                if (value)
                    Line("%s.%c = %s.%c;", destination.c_str(), COMPONENTS[c], value, COMPONENTS[c]);
                else
                    Line("%s.%c = %s;", destination.c_str(), COMPONENTS[c], constant);
            }
        }

        void Translator::EmitAlu(const Alu& alu)
        {
            uint32_t vectorOp = alu.VectorOp();
            uint32_t scalarOp = alu.ScalarOp();
            bool isExport = alu.IsExport();
            uint32_t vectorMask = alu.VectorMask();
            uint32_t scalarMask = alu.ScalarMask();
            uint32_t vectorResultMask = isExport ? (vectorMask & ~scalarMask) : vectorMask;
            uint32_t scalarResultMask = isExport ? (scalarMask & ~vectorMask) : scalarMask;
            uint32_t constant1Mask = isExport ? (vectorMask & scalarMask) : 0;
            uint32_t constant0Mask = (isExport && alu.ScalarDestRelative()) ? (0xF & ~(vectorMask | scalarMask)) : 0;

            bool vectorChangesState = vectorOp == V_MAXA || (vectorOp >= V_SETP_EQ_PUSH && vectorOp <= V_KILL_NE);
            bool needVector = vectorResultMask || vectorChangesState;

            if (alu.IsPredicated())
                Line("if (%sxe_p0) {", alu.PredCondition() ? "" : "!");
            else
                Line("{");
            m_indent++;

            // Sources are read before any result is written (co-issued vector + scalar).
            if (needVector)
            {
                uint32_t count = VectorOperandCount(vectorOp);
                for (uint32_t i = 1; i <= count; i++)
                    Line("let s%u = %s;", i, AluSource(alu, i).c_str());
            }

            // Scalar operands.
            uint32_t form = ScalarOperandForm(scalarOp);
            if (form == 1 || form == 2)
            {
                bool absolute;
                std::string raw = AluSourceRaw(alu, 3, absolute);
                uint32_t swizzle = alu.SrcSwizzle(3);
                const char* neg = alu.SrcNegate(3) ? "-" : "";
                Line("let sa = %s%s%s.%c%s;", neg, absolute ? "abs(" : "", raw.c_str(), COMPONENTS[SwizzledComponent(swizzle, 3)], absolute ? ")" : "");
                if (form == 2)
                    Line("let sb = %s%s%s.%c%s;", neg, absolute ? "abs(" : "", raw.c_str(), COMPONENTS[SwizzledComponent(swizzle, 0)], absolute ? ")" : "");
            }
            else if (form == 3)
            {
                // Constant (src3, a = W swizzle) and temp register built from the opcode/sel/swizzle bits.
                bool unused;
                std::string constant = AluSourceRaw(alu, 3, unused, true);
                uint32_t swizzle = alu.SrcSwizzle(3);
                uint32_t temp = (scalarOp & 1) | (uint32_t(alu.SrcIsTemp(3)) << 1) | (swizzle & 0x3C);
                const char* neg = alu.SrcNegate(3) ? "-" : "";
                bool absolute = alu.AbsConstants();
                Line("let sa = %s%s%s.%c%s;", neg, absolute ? "abs(" : "", constant.c_str(), COMPONENTS[SwizzledComponent(swizzle, 3)], absolute ? ")" : "");
                Line("let sb = %s%sr[%u].%c%s;", neg, absolute ? "abs(" : "", temp, COMPONENTS[SwizzledComponent(swizzle, 0)], absolute ? ")" : "");
            }

            // Vector operation.
            if (needVector)
            {
                switch (vectorOp)
                {
                case V_ADD: Line("var v = s1 + s2;"); break;
                case V_MUL: Line("var v = xe_mul(s1, s2);"); break;
                case V_MAX: Line("var v = xe_max(s1, s2);"); break;
                case V_MIN: Line("var v = xe_min(s1, s2);"); break;
                case V_SEQ: Line("var v = vec4f(s1 == s2);"); break;
                case V_SGT: Line("var v = vec4f(s1 > s2);"); break;
                case V_SGE: Line("var v = vec4f(s1 >= s2);"); break;
                case V_SNE: Line("var v = vec4f(s1 != s2);"); break;
                case V_FRC: Line("var v = s1 - floor(s1);"); break;
                case V_TRUNC: Line("var v = trunc(s1);"); break;
                case V_FLOOR: Line("var v = floor(s1);"); break;
                case V_MAD: Line("var v = xe_mul(s1, s2) + s3;"); break;
                case V_CNDEQ: Line("var v = select(s3, s2, s1 == vec4f(0.0));"); break;
                case V_CNDGE: Line("var v = select(s3, s2, s1 >= vec4f(0.0));"); break;
                case V_CNDGT: Line("var v = select(s3, s2, s1 > vec4f(0.0));"); break;
                case V_DP4: Line("var v = vec4f(xe_dp4(s1, s2));"); break;
                case V_DP3: Line("var v = vec4f(xe_dp3(s1, s2));"); break;
                case V_DP2ADD: Line("var v = vec4f(xe_dp2(s1, s2) + s3.x);"); break;
                case V_CUBE: Line("var v = xe_cube(s1);"); break;
                case V_MAX4: Line("var v = vec4f(xe_max4(s1));"); break;
                case V_SETP_EQ_PUSH:
                    Line("xe_p0 = s1.w == 0.0 && s2.w == 0.0;");
                    Line("var v = vec4f(select(s1.x + 1.0, 0.0, s1.x == 0.0 && s2.x == 0.0));");
                    break;
                case V_SETP_NE_PUSH:
                    Line("xe_p0 = s1.w == 0.0 && s2.w != 0.0;");
                    Line("var v = vec4f(select(s1.x + 1.0, 0.0, s1.x == 0.0 && s2.x != 0.0));");
                    break;
                case V_SETP_GT_PUSH:
                    Line("xe_p0 = s1.w == 0.0 && s2.w > 0.0;");
                    Line("var v = vec4f(select(s1.x + 1.0, 0.0, s1.x == 0.0 && s2.x > 0.0));");
                    break;
                case V_SETP_GE_PUSH:
                    Line("xe_p0 = s1.w == 0.0 && s2.w >= 0.0;");
                    Line("var v = vec4f(select(s1.x + 1.0, 0.0, s1.x == 0.0 && s2.x >= 0.0));");
                    break;
                case V_KILL_EQ: case V_KILL_GT: case V_KILL_GE: case V_KILL_NE:
                {
                    const char* op = vectorOp == V_KILL_EQ ? "==" : vectorOp == V_KILL_GT ? ">" : vectorOp == V_KILL_GE ? ">=" : "!=";
                    Line("var v = vec4f(f32(any(s1 %s s2)));", op);
                    if (IsPixel())
                    {
                        Line("if (v.x != 0.0) { discard; }");
                        m_out.hasKill = true;
                    }
                    break;
                }
                case V_DST: Line("var v = vec4f(1.0, xe_mul(s1, s2).y, s1.z, s2.w);"); break;
                case V_MAXA:
                    Line("xe_a0 = i32(floor(clamp(s1.w, -256.0, 255.0) + 0.5));");
                    Line("var v = xe_max(s1, s2);");
                    break;
                default:
                    Line("var v = vec4f(0.0); // unknown vector opcode %u", vectorOp);
                    break;
                }
                if (alu.VectorClamp())
                    Line("v = saturate(v);");
            }

            // Scalar operation (updates ps).
            switch (scalarOp)
            {
            case S_ADDS: case S_ADDSC0: case S_ADDSC1: Line("xe_ps = sa + sb;"); break;
            case S_ADDS_PREV: Line("xe_ps = sa + xe_ps;"); break;
            case S_MULS: case S_MULSC0: case S_MULSC1: Line("xe_ps = xe_muls(sa, sb);"); break;
            case S_MULS_PREV: Line("xe_ps = xe_muls(sa, xe_ps);"); break;
            case S_MULS_PREV2:
                Line("xe_ps = select(xe_muls(sa, xe_ps), -XE_FLT_MAX, xe_ps == -XE_FLT_MAX || !xe_isfinite(xe_ps) || !xe_isfinite(sb) || sb <= 0.0);");
                break;
            case S_MAXS: Line("xe_ps = select(sb, sa, sa >= sb);"); break;
            case S_MINS: Line("xe_ps = select(sb, sa, sa < sb);"); break;
            case S_SEQS: Line("xe_ps = f32(sa == 0.0);"); break;
            case S_SGTS: Line("xe_ps = f32(sa > 0.0);"); break;
            case S_SGES: Line("xe_ps = f32(sa >= 0.0);"); break;
            case S_SNES: Line("xe_ps = f32(sa != 0.0);"); break;
            case S_FRCS: Line("xe_ps = sa - floor(sa);"); break;
            case S_TRUNCS: Line("xe_ps = trunc(sa);"); break;
            case S_FLOORS: Line("xe_ps = floor(sa);"); break;
            case S_EXP: Line("xe_ps = exp2(sa);"); break;
            case S_LOGC: Line("xe_ps = log2(sa); if (xe_isinf(xe_ps) && xe_ps < 0.0) { xe_ps = -XE_FLT_MAX; }"); break;
            case S_LOG: Line("xe_ps = log2(sa);"); break;
            case S_RCPC: Line("xe_ps = clamp(1.0 / sa, -XE_FLT_MAX, XE_FLT_MAX);"); break;
            case S_RCPF: Line("xe_ps = 1.0 / sa; if (xe_isinf(xe_ps)) { xe_ps = 0.0; }"); break;
            case S_RCP: Line("xe_ps = 1.0 / sa;"); break;
            case S_RSQC: Line("xe_ps = clamp(inverseSqrt(sa), -XE_FLT_MAX, XE_FLT_MAX);"); break;
            case S_RSQF: Line("xe_ps = inverseSqrt(sa); if (xe_isinf(xe_ps)) { xe_ps = 0.0; }"); break;
            case S_RSQ: Line("xe_ps = inverseSqrt(sa);"); break;
            case S_MAXAS:
                Line("xe_a0 = i32(floor(clamp(sa, -256.0, 255.0) + 0.5));");
                Line("xe_ps = select(sb, sa, sa >= sb);");
                break;
            case S_MAXASF:
                Line("xe_a0 = i32(floor(clamp(sa, -256.0, 255.0)));");
                Line("xe_ps = select(sb, sa, sa >= sb);");
                break;
            case S_SUBS: case S_SUBSC0: case S_SUBSC1: Line("xe_ps = sa - sb;"); break;
            case S_SUBS_PREV: Line("xe_ps = sa - xe_ps;"); break;
            case S_SETP_EQ: Line("xe_p0 = sa == 0.0; xe_ps = select(1.0, 0.0, xe_p0);"); break;
            case S_SETP_NE: Line("xe_p0 = sa != 0.0; xe_ps = select(1.0, 0.0, xe_p0);"); break;
            case S_SETP_GT: Line("xe_p0 = sa > 0.0; xe_ps = select(1.0, 0.0, xe_p0);"); break;
            case S_SETP_GE: Line("xe_p0 = sa >= 0.0; xe_ps = select(1.0, 0.0, xe_p0);"); break;
            case S_SETP_INV: Line("xe_p0 = sa == 1.0; xe_ps = select(select(sa, 1.0, sa == 0.0), 0.0, xe_p0);"); break;
            case S_SETP_POP: Line("xe_p0 = (sa - 1.0) <= 0.0; xe_ps = select(sa - 1.0, 0.0, xe_p0);"); break;
            case S_SETP_CLR: Line("xe_p0 = false; xe_ps = XE_FLT_MAX;"); break;
            case S_SETP_RSTR: Line("xe_p0 = sa == 0.0; xe_ps = select(sa, 0.0, xe_p0);"); break;
            case S_KILLS_EQ: case S_KILLS_GT: case S_KILLS_GE: case S_KILLS_NE: case S_KILLS_ONE:
            {
                const char* condition = scalarOp == S_KILLS_EQ ? "sa == 0.0" : scalarOp == S_KILLS_GT ? "sa > 0.0" :
                                        scalarOp == S_KILLS_GE ? "sa >= 0.0" : scalarOp == S_KILLS_NE ? "sa != 0.0" : "sa == 1.0";
                Line("xe_ps = f32(%s);", condition);
                if (IsPixel())
                {
                    Line("if (xe_ps != 0.0) { discard; }");
                    m_out.hasKill = true;
                }
                break;
            }
            case S_SQRT: Line("xe_ps = sqrt(sa);"); break;
            case S_SIN: Line("xe_ps = sin(sa);"); break;
            case S_COS: Line("xe_ps = cos(sa);"); break;
            case S_RETAIN_PREV: break;
            default:
                Line("// unknown scalar opcode %u", scalarOp);
                break;
            }
            if (scalarResultMask)
                Line("let s = %s;", alu.ScalarClamp() ? "saturate(xe_ps)" : "xe_ps");

            // Results.
            if (isExport)
            {
                uint32_t target = alu.VectorDest();
                std::string destination;
                bool scalarDestination = false;
                if (!IsPixel())
                {
                    if (target < 16)
                        destination = "xe_o[" + std::to_string(target) + "]";
                    else if (target == 62)
                        destination = "xe_o_pos";
                    else if (target == 63)
                        destination = "xe_o_misc";
                    else if (target >= 32 && target <= 37)
                        m_out.hasMemExport = true;
                }
                else
                {
                    if (target < 4)
                    {
                        destination = "xe_oC[" + std::to_string(target) + "]";
                        m_out.colorTargetsWritten |= 1u << target;
                    }
                    else if (target == 61)
                    {
                        destination = "xe_oDepth";
                        scalarDestination = true;
                        m_out.writesDepth = true;
                    }
                    else if (target >= 32 && target <= 37)
                        m_out.hasMemExport = true;
                }

                if (scalarDestination)
                {
                    // Depth (a float): its X component (the HLSL's xe_oDepth.x).
                    if (vectorResultMask & 1)
                        Line("%s = v.x;", destination.c_str());
                    else if (scalarResultMask & 1)
                        Line("%s = s;", destination.c_str());
                    else if (constant1Mask & 1)
                        Line("%s = 1.0;", destination.c_str());
                    else if (constant0Mask & 1)
                        Line("%s = 0.0;", destination.c_str());
                }
                else if (!destination.empty())
                {
                    if (vectorResultMask)
                        WriteMasked(destination, vectorResultMask, "v");
                    if (scalarResultMask)
                        WriteMasked(destination, scalarResultMask, nullptr, "s");
                    if (constant1Mask)
                        WriteMasked(destination, constant1Mask, nullptr, "1.0");
                    if (constant0Mask)
                        WriteMasked(destination, constant0Mask, nullptr, "0.0");
                }
            }
            else
            {
                if (vectorResultMask)
                {
                    WriteMasked(TempRegister(alu.VectorDest(), alu.VectorDestRelative()), vectorResultMask, "v");
                    NoteTempWrite(alu.VectorDest(), alu.VectorDestRelative());
                }
                if (scalarResultMask)
                {
                    WriteMasked(TempRegister(alu.ScalarDest(), alu.ScalarDestRelative()), scalarResultMask, nullptr, "s");
                    NoteTempWrite(alu.ScalarDest(), alu.ScalarDestRelative());
                }
            }

            m_indent--;
            Line("}");
        }

        void Translator::WriteFetchResult(const Fetch& fetch, const char* value)
        {
            std::string destination = TempRegister(fetch.DstReg(), fetch.DstRelative());
            uint32_t swizzle = fetch.DstSwizzle();
            for (uint32_t c = 0; c < 4; c++)
            {
                uint32_t select = (swizzle >> (3 * c)) & 7;
                if (select == 7)
                    continue;
                if (select < 4)
                    Line("%s.%c = %s.%c;", destination.c_str(), COMPONENTS[c], value, COMPONENTS[select]);
                else
                    Line("%s.%c = %s;", destination.c_str(), COMPONENTS[c], select == 5 ? "1.0" : "0.0");
            }
            NoteTempWrite(fetch.DstReg(), fetch.DstRelative());
        }

        void Translator::EmitVertexFetch(const Fetch& fetch)
        {
            if (IsPixel())
                return;

            uint32_t format = fetch.VertexFormat();
            bool mini = fetch.VertexIsMini();
            uint32_t fetchConstant;
            if (!mini || !m_haveFullFetch)
            {
                fetchConstant = fetch.VertexFetchConstant();
                m_lastFullFetchConstant = fetchConstant;
                m_haveFullFetch = true;

                VertexFetchBinding& binding = VertexBinding(fetchConstant);
                binding.strideDwords = fetch.VertexStride();
                bool isVertexIndex = fetch.SrcReg() == 0 && !fetch.SrcRelative() && fetch.VertexSrcComponent() == 0 && !m_r0Dirty;
                if (!isVertexIndex)
                    binding.indexedByVertexIndex = false;

                Line("xe_vf_address = xe_vb_base(%uu) + i32(floor(%s.%c%s)) * %d;", fetchConstant,
                     TempRegister(fetch.SrcReg(), fetch.SrcRelative()).c_str(), COMPONENTS[fetch.VertexSrcComponent()],
                     fetch.VertexIndexRounded() ? " + 0.5" : "", int(fetch.VertexStride() * 4));
            }
            else
            {
                fetchConstant = m_lastFullFetchConstant;
            }

            VertexFetchBinding& binding = VertexBinding(fetchConstant);
            int32_t offset = fetch.VertexOffset();
            uint32_t dwords = xenos::VertexFormatDwords(format);
            binding.minOffsetDwords = std::min(binding.minOffsetDwords, offset);
            binding.maxEndDwords = std::max(binding.maxEndDwords, offset + int32_t(dwords));

            if (fetch.IsPredicated())
                Line("if (%sxe_p0) {", fetch.PredCondition() ? "" : "!");
            else
                Line("{");
            m_indent++;

            Line("let a = xe_vf_address + (%d);", offset * 4);
            const char* sign = fetch.VertexSigned() ? "true" : "false";
            const char* norm = !fetch.VertexInteger() ? "true" : "false";
            switch (xenos::VertexFormat(format))
            {
            case xenos::VertexFormat::k_8_8_8_8:
                Line("var f = xe_unpack(vec4u(xe_load(a)), vec4u(0u, 8u, 16u, 24u), vec4u(8u, 8u, 8u, 8u), %s, %s);", sign, norm);
                break;
            case xenos::VertexFormat::k_2_10_10_10:
                Line("var f = xe_unpack(vec4u(xe_load(a)), vec4u(0u, 10u, 20u, 30u), vec4u(10u, 10u, 10u, 2u), %s, %s);", sign, norm);
                break;
            case xenos::VertexFormat::k_10_11_11:
                Line("var f = vec4f(xe_unpack(vec4u(xe_load(a)), vec4u(0u, 11u, 22u, 0u), vec4u(11u, 11u, 10u, 1u), %s, %s).xyz, 1.0);", sign, norm);
                break;
            case xenos::VertexFormat::k_11_11_10:
                Line("var f = vec4f(xe_unpack(vec4u(xe_load(a)), vec4u(0u, 10u, 21u, 0u), vec4u(10u, 11u, 11u, 1u), %s, %s).xyz, 1.0);", sign, norm);
                break;
            case xenos::VertexFormat::k_16_16:
                Line("var f = vec4f(xe_unpack(vec4u(xe_load(a)), vec4u(0u, 16u, 0u, 0u), vec4u(16u, 16u, 1u, 1u), %s, %s).xy, 0.0, 1.0);", sign, norm);
                break;
            case xenos::VertexFormat::k_16_16_16_16:
                Line("var f = xe_unpack(xe_load2(a).xxyy, vec4u(0u, 16u, 0u, 16u), vec4u(16u, 16u, 16u, 16u), %s, %s);", sign, norm);
                break;
            case xenos::VertexFormat::k_16_16_FLOAT:
                Line("var f = vec4f(unpack2x16float(xe_load(a)), 0.0, 1.0);");
                break;
            case xenos::VertexFormat::k_16_16_16_16_FLOAT:
                Line("let w = xe_load2(a);");
                Line("var f = vec4f(unpack2x16float(w.x), unpack2x16float(w.y));");
                break;
            case xenos::VertexFormat::k_32:
                Line("var f = vec4f(xe_unpack32(vec4u(xe_load(a)), %s, %s).x, 0.0, 0.0, 1.0);", sign, norm);
                break;
            case xenos::VertexFormat::k_32_32:
                Line("var f = vec4f(xe_unpack32(xe_load2(a).xyxy, %s, %s).xy, 0.0, 1.0);", sign, norm);
                break;
            case xenos::VertexFormat::k_32_32_32_32:
                Line("var f = xe_unpack32(xe_load4(a), %s, %s);", sign, norm);
                break;
            case xenos::VertexFormat::k_32_FLOAT:
                Line("var f = vec4f(bitcast<f32>(xe_load(a)), 0.0, 0.0, 1.0);");
                break;
            case xenos::VertexFormat::k_32_32_FLOAT:
                Line("var f = vec4f(bitcast<vec2f>(xe_load2(a)), 0.0, 1.0);");
                break;
            case xenos::VertexFormat::k_32_32_32_FLOAT:
                Line("var f = vec4f(bitcast<vec3f>(xe_load3(a)), 1.0);");
                break;
            case xenos::VertexFormat::k_32_32_32_32_FLOAT:
                Line("var f = bitcast<vec4f>(xe_load4(a));");
                break;
            default:
                Line("var f = vec4f(0.0, 0.0, 0.0, 1.0); // unknown vertex format %u", format);
                break;
            }
            if (int32_t exp = fetch.VertexExpAdjust())
                Line("f = f * %s;", FloatLiteral(double(ldexpf(1.0f, exp))).c_str());
            WriteFetchResult(fetch, "f");

            m_indent--;
            Line("}");
        }

        void Translator::EmitTextureFetch(const Fetch& fetch)
        {
            uint32_t opcode = fetch.Opcode();
            uint32_t fc = fetch.TextureFetchConstant();
            uint32_t dimension = fetch.TextureDimension();

            if (fetch.IsPredicated())
                Line("if (%sxe_p0) {", fetch.PredCondition() ? "" : "!");
            else
                Line("{");
            m_indent++;

            std::string src = TempRegister(fetch.SrcReg(), fetch.SrcRelative());
            uint32_t srcSwizzle = fetch.TextureSrcSwizzle();
            std::string coords = src + ".";
            for (uint32_t c = 0; c < 3; c++)
                coords += COMPONENTS[(srcSwizzle >> (2 * c)) & 3];

            switch (opcode)
            {
            case F_TEXTURE:
            case F_GET_WEIGHTS:
            case F_GET_COMPUTED_LOD:
            {
                TextureBinding& binding = TextureBindingFor(fc);
                if (binding.magFilter == 3 && binding.minFilter == 3)
                {
                    binding.dimension = dimension;
                    binding.magFilter = fetch.TextureMagFilter();
                    binding.minFilter = fetch.TextureMinFilter();
                    binding.mipFilter = fetch.TextureMipFilter();
                    binding.anisoFilter = fetch.TextureAnisoFilter();
                }
                Line("var uvw = %s;", coords.c_str());
                Line("let size = vec2f(textureDimensions(xe_t%u));", fc);
                if (fetch.TextureUnnormalized())
                    Line("uvw = vec3f(uvw.xy / size, uvw.z);");
                float offsetX = fetch.TextureOffset(0) * 0.5f, offsetY = fetch.TextureOffset(1) * 0.5f;
                if (offsetX != 0.0f || offsetY != 0.0f)
                    Line("uvw = vec3f(uvw.xy + vec2f(%s, %s) / size, uvw.z);", FloatLiteral(offsetX).c_str(), FloatLiteral(offsetY).c_str());
                if (dimension == 0)
                    Line("uvw.y = 0.5;");
                else if (dimension == 3)
                    Line("uvw = vec3f(uvw.xy - 1.0, uvw.z); // cube: face 0 only");

                if (opcode == F_TEXTURE && m_currentSlot < m_gradientFetch.size() && m_gradientFetch[m_currentSlot])
                {
                    // Mipmapped (and anisotropic) sampling with the derivatives of the input
                    // register taken in main() (FindGradientFetches), scaled by the LOD biases of
                    // the fetch constant and the instruction and by the texture LOD scale of the
                    // graphics options (xe_effects.effect.w).
                    uint32_t reg = fetch.SrcReg();
                    char c0 = COMPONENTS[srcSwizzle & 3], c1 = COMPONENTS[(srcSwizzle >> 2) & 3];
                    Line("var gx = vec2f(xe_gx_r%u.%c, xe_gx_r%u.%c);", reg, c0, reg, c1);
                    Line("var gy = vec2f(xe_gy_r%u.%c, xe_gy_r%u.%c);", reg, c0, reg, c1);
                    if (fetch.TextureUnnormalized())
                        Line("gx = gx / size; gy = gy / size;");
                    Line("let gs = exp2(xe_lod_bias(%uu) + %s) * xe_effects.effect.w;", fc, FloatLiteral(double(fetch.TextureLodBias()) / 16.0).c_str());
                    Line("let t = xe_swizzle(textureSampleGrad(xe_t%u, xe_s%u, uvw.xy, gx * gs, gy * gs), %uu);", fc, fc, fc);
                }
                else if (opcode == F_TEXTURE)
                {
                    // Explicit LOD 0: no derivatives here (control flow, computed coordinates).
                    Line("let t = xe_swizzle(textureSampleLevel(xe_t%u, xe_s%u, uvw.xy, 0.0), %uu);", fc, fc, fc);
                }
                else if (opcode == F_GET_WEIGHTS)
                {
                    Line("let t = vec4f(fract(uvw.xy * size - 0.5), 0.0, 0.0);");
                }
                else
                {
                    Line("let t = vec4f(0.0);");
                }
                WriteFetchResult(fetch, "t");
                break;
            }
            case F_GET_GRADIENTS:
                // The HLSL takes ddx/ddy here in straight-line control flow; WGSL's uniformity
                // analysis rejects derivatives inside xe_main: zero, as the HLSL in the state machine.
                Line("let t = vec4f(0.0); // getGradients: no derivatives in xe_main");
                WriteFetchResult(fetch, "t");
                break;
            case F_GET_BORDER_COLOR_FRAC:
                Line("let t = vec4f(0.0);");
                WriteFetchResult(fetch, "t");
                break;
            default:
                // setTexLOD / setGradientH/V: state only used by later fetches; ignored.
                break;
            }

            m_indent--;
            Line("}");
        }

        void Translator::EmitFetch(const Fetch& fetch)
        {
            if (fetch.Opcode() == F_VERTEX)
                EmitVertexFetch(fetch);
            else
                EmitTextureFetch(fetch);
        }

        void Translator::EmitExecBody(const Cf& cf)
        {
            for (uint32_t i = 0; i < cf.ExecCount(); i++)
            {
                uint32_t slot = cf.ExecAddress() + i;
                if (slot * 3 + 3 > m_dwordCount)
                {
                    Line("// instruction slot %u is outside the microcode", slot);
                    break;
                }
                const uint32_t* words = m_ucode + slot * 3;
                m_currentSlot = slot;
                m_out.instructionCount++;
                bool isFetch = ((cf.ExecSequence() >> (i * 2)) & 1) != 0;
                if (isFetch)
                {
                    Line("// %u: fetch %08X %08X %08X", slot, words[0], words[1], words[2]);
                    EmitFetch(Fetch{ words[0], words[1], words[2] });
                }
                else
                {
                    Line("// %u: alu %08X %08X %08X", slot, words[0], words[1], words[2]);
                    EmitAlu(Alu{ words[0], words[1], words[2] });
                }
            }
        }

        // An exec under `condition` (ExecCondition).
        void Translator::EmitExec(const Cf& cf, const std::string& condition)
        {
            if (!condition.empty())
            {
                Line("if (%s) {", condition.c_str());
                m_indent++;
            }
            EmitExecBody(cf);
            if (cf.EndsShader())
                Line("return;");
            if (!condition.empty())
            {
                m_indent--;
                Line("}");
            }
        }

        // Straight-line control flow (no loops, calls or jumps): execs become optional blocks.
        void Translator::EmitStructured()
        {
            for (size_t index = 0; index < m_cf.size(); index++)
            {
                const Cf& cf = m_cf[index];
                if (!cf.IsExec())
                    continue;
                std::string condition = ExecCondition(cf);
                EmitExec(cf, condition);
                if (cf.EndsShader() && condition.empty())
                    break;
            }
        }

        // Control flow that can be emitted structured: no calls, loops nested with the loop start's
        // target just past its loop end and the loop end's just past its start, and only forward
        // jumps that land in the loop they leave from (not out of a loop nor into one).
        bool Translator::FindStructuredFlow()
        {
            uint32_t count = uint32_t(m_cf.size());
            m_loopEnd.assign(count, UINT32_MAX);
            m_skippable.assign(count, 0);
            std::vector<uint32_t> container(count + 1, UINT32_MAX);  // innermost loop start with start < i <= end
            std::vector<uint32_t> stack;
            for (uint32_t i = 0; i < count; i++)
            {
                uint32_t op = m_cf[i].Opcode();
                if (op == CF_COND_CALL || op == CF_RETURN)
                    return false;
                if (op == CF_LOOP_END)
                {
                    if (stack.empty())
                        return false;
                    uint32_t start = stack.back();
                    stack.pop_back();
                    if (m_cf[start].TargetAddress() != i + 1 || m_cf[i].TargetAddress() != start + 1)
                        return false;
                    m_loopEnd[start] = i;
                    m_hasLoops = true;
                    container[i] = start;
                }
                else
                {
                    container[i] = stack.empty() ? UINT32_MAX : stack.back();
                }
                if (op == CF_LOOP_START)
                    stack.push_back(i);
            }
            if (!stack.empty())
                return false;
            for (uint32_t i = 0; i < count; i++)
            {
                if (m_cf[i].Opcode() != CF_COND_JMP)
                    continue;
                uint32_t target = m_cf[i].TargetAddress();
                if (target <= i || container[std::min(target, count)] != container[i])
                    return false;
                for (uint32_t k = i + 1; k < std::min(target, count); k++)
                    m_skippable[k] = 1;
            }
            return true;
        }

        // Structured control flow: loops as WGSL loops, forward jumps as straight-line code where
        // xe_resume is the control flow instruction execution goes on at (the instructions a jump
        // can skip run only once it is reached).
        void Translator::EmitStructuredFlow()
        {
            if (std::find(m_skippable.begin(), m_skippable.end(), 1) != m_skippable.end())
                Line("var xe_resume : i32 = 0;");
            if (m_hasLoops)
            {
                Line("var xe_loop_iterator : array<i32, 4>;");
                Line("var xe_loop_start : array<i32, 4>;");
                Line("var xe_loop_step : array<i32, 4>;");
            }
            EmitStructuredRange(0, uint32_t(m_cf.size()), 0);
        }

        void Translator::EmitStructuredRange(uint32_t begin, uint32_t end, uint32_t depth)
        {
            for (uint32_t index = begin; index < end; index++)
            {
                const Cf& cf = m_cf[index];
                std::string guard = m_skippable[index] ? "xe_resume <= " + std::to_string(index) : "";
                if (cf.Opcode() == CF_COND_JMP)
                {
                    std::string condition;
                    if (!cf.IsUnconditional())
                    {
                        if (cf.IsPredicated())
                            condition = cf.Condition() ? "xe_p0" : "!xe_p0";
                        else
                            condition = BoolConstant(cf.BoolAddress()) + (cf.Condition() ? " != 0u" : " == 0u");
                    }
                    if (!guard.empty() && !condition.empty())
                        condition = guard + " && (" + condition + ")";
                    else if (!guard.empty())
                        condition = guard;
                    if (condition.empty())
                        Line("xe_resume = %u;", cf.TargetAddress());
                    else
                        Line("if (%s) { xe_resume = %u; }", condition.c_str(), cf.TargetAddress());
                    continue;
                }
                if (cf.Opcode() == CF_LOOP_START)
                {
                    // As the state machine's loop start and end, with the loop depth known here.
                    uint32_t loopEnd = m_loopEnd[index];
                    const Cf& endCf = m_cf[loopEnd];
                    uint32_t d = std::min(depth, 3u);
                    if (!guard.empty())
                    {
                        Line("if (%s) {", guard.c_str());
                        m_indent++;
                    }
                    Line("{");
                    m_indent++;
                    uint32_t id = cf.LoopId(), endId = endCf.LoopId();
                    Line("let xe_lc%u = xe_system.loop_consts[%u].%c;", index, id >> 2, COMPONENTS[id & 3]);
                    if (!cf.LoopIsRepeat())
                        Line("xe_loop_iterator[%u] = 0;", d);
                    Line("xe_loop_start[%u] = i32(xe_lc%u >> 8u) & 0xFF;", d, index);
                    Line("xe_loop_step[%u] = i32(xe_lc%u << 8u) >> 24u;", d, index);
                    Line("xe_aL = xe_loop_iterator[%u] * xe_loop_step[%u] + xe_loop_start[%u];", d, d, d);
                    Line("if (u32(xe_loop_iterator[%u]) < (xe_lc%u & 0xFFu)) {", d, index);
                    m_indent++;
                    Line("loop {");
                    m_indent++;
                    bool jumps = std::find(m_skippable.begin() + index + 1, m_skippable.begin() + loopEnd, 1) != m_skippable.begin() + loopEnd;
                    if (jumps)
                        Line("xe_resume = 0;");
                    EmitStructuredRange(index + 1, loopEnd, depth + 1);
                    Line("let xe_lc%u = xe_system.loop_consts[%u].%c;", loopEnd, endId >> 2, COMPONENTS[endId & 3]);
                    Line("xe_loop_iterator[%u] += 1;", d);
                    Line("xe_aL = xe_loop_iterator[%u] * xe_loop_step[%u] + xe_loop_start[%u];", d, d, d);
                    std::string breakCondition = endCf.LoopEndPredicatedBreak() ? (endCf.Condition() ? "xe_p0" : "!xe_p0") : "false";
                    Line("if (!(u32(xe_loop_iterator[%u]) < (xe_lc%u & 0xFFu) && !(%s))) { break; }", d, loopEnd, breakCondition.c_str());
                    m_indent--;
                    Line("}");
                    m_indent--;
                    Line("}");
                    if (d > 0)
                        Line("xe_aL = xe_loop_iterator[%u] * xe_loop_step[%u] + xe_loop_start[%u];", d - 1, d - 1, d - 1);
                    m_indent--;
                    Line("}");
                    if (!guard.empty())
                    {
                        m_indent--;
                        Line("}");
                    }
                    index = loopEnd;
                    continue;
                }
                if (!cf.IsExec())
                    continue;
                if (!guard.empty())
                {
                    Line("if (%s) {", guard.c_str());
                    m_indent++;
                }
                std::string condition = ExecCondition(cf);
                EmitExec(cf, condition);
                if (!guard.empty())
                {
                    m_indent--;
                    Line("}");
                }
                if (cf.EndsShader() && condition.empty() && guard.empty() && depth == 0)
                    break;
            }
        }

        // General control flow: a program counter over the control flow instructions.
        void Translator::EmitStateMachine()
        {
            Line("var xe_pc : i32 = 0;");
            Line("var xe_loop_depth : i32 = -1;");
            Line("var xe_call_depth : i32 = 0;");
            Line("var xe_loop_iterator : array<i32, 4>;");
            Line("var xe_loop_start : array<i32, 4>;");
            Line("var xe_loop_step : array<i32, 4>;");
            Line("var xe_call_return : array<i32, 4>;");
            Line("for (var xe_guard : i32 = 0; xe_guard < 65536; xe_guard++) {");
            m_indent++;
            Line("switch (xe_pc) {");
            for (size_t index = 0; index < m_cf.size(); index++)
            {
                const Cf& cf = m_cf[index];
                uint32_t next = uint32_t(index + 1);
                Line("case %u: {", uint32_t(index));
                m_indent++;
                switch (cf.Opcode())
                {
                case CF_EXEC: case CF_EXEC_END: case CF_COND_EXEC: case CF_COND_EXEC_END:
                case CF_COND_EXEC_PRED: case CF_COND_EXEC_PRED_END:
                case CF_COND_EXEC_PRED_CLEAN: case CF_COND_EXEC_PRED_CLEAN_END:
                {
                    std::string condition = ExecCondition(cf);
                    if (!condition.empty())
                    {
                        Line("if (%s) {", condition.c_str());
                        m_indent++;
                    }
                    EmitExecBody(cf);
                    if (cf.EndsShader())
                        Line("return;");
                    if (!condition.empty())
                    {
                        m_indent--;
                        Line("}");
                    }
                    Line("xe_pc = %u;", next);
                    break;
                }
                case CF_LOOP_START:
                {
                    uint32_t id = cf.LoopId();
                    Line("let lc = xe_system.loop_consts[%u].%c;", id >> 2, COMPONENTS[id & 3]);
                    Line("xe_loop_depth = min(xe_loop_depth + 1, 3);");
                    if (!cf.LoopIsRepeat())
                        Line("xe_loop_iterator[xe_loop_depth] = 0;");
                    Line("xe_loop_start[xe_loop_depth] = i32(lc >> 8u) & 0xFF;");
                    Line("xe_loop_step[xe_loop_depth] = i32(lc << 8u) >> 24u;");
                    Line("xe_aL = xe_loop_iterator[xe_loop_depth] * xe_loop_step[xe_loop_depth] + xe_loop_start[xe_loop_depth];");
                    Line("if (u32(xe_loop_iterator[xe_loop_depth]) >= (lc & 0xFFu)) {");
                    Line("    xe_loop_depth--;");
                    Line("    if (xe_loop_depth >= 0) { xe_aL = xe_loop_iterator[xe_loop_depth] * xe_loop_step[xe_loop_depth] + xe_loop_start[xe_loop_depth]; }");
                    Line("    xe_pc = %u;", cf.TargetAddress());
                    Line("} else {");
                    Line("    xe_pc = %u;", next);
                    Line("}");
                    break;
                }
                case CF_LOOP_END:
                {
                    uint32_t id = cf.LoopId();
                    Line("let lc = xe_system.loop_consts[%u].%c;", id >> 2, COMPONENTS[id & 3]);
                    Line("if (xe_loop_depth < 0) { xe_pc = %u; break; }", next);
                    Line("xe_loop_iterator[xe_loop_depth] += 1;");
                    Line("xe_aL = xe_loop_iterator[xe_loop_depth] * xe_loop_step[xe_loop_depth] + xe_loop_start[xe_loop_depth];");
                    std::string breakCondition = cf.LoopEndPredicatedBreak() ? (cf.Condition() ? "xe_p0" : "!xe_p0") : "false";
                    Line("if (u32(xe_loop_iterator[xe_loop_depth]) < (lc & 0xFFu) && !(%s)) {", breakCondition.c_str());
                    Line("    xe_pc = %u;", cf.TargetAddress());
                    Line("} else {");
                    Line("    xe_loop_depth--;");
                    Line("    if (xe_loop_depth >= 0) { xe_aL = xe_loop_iterator[xe_loop_depth] * xe_loop_step[xe_loop_depth] + xe_loop_start[xe_loop_depth]; }");
                    Line("    xe_pc = %u;", next);
                    Line("}");
                    break;
                }
                case CF_COND_CALL:
                case CF_COND_JMP:
                {
                    std::string condition = "true";
                    if (!cf.IsUnconditional())
                    {
                        if (cf.IsPredicated())
                            condition = cf.Condition() ? "xe_p0" : "!xe_p0";
                        else
                            condition = BoolConstant(cf.BoolAddress()) + (cf.Condition() ? " != 0u" : " == 0u");
                    }
                    Line("if (%s) {", condition.c_str());
                    if (cf.Opcode() == CF_COND_CALL)
                        Line("    if (xe_call_depth < 4) { xe_call_return[xe_call_depth] = %u; xe_call_depth++; }", next);
                    Line("    xe_pc = %u;", cf.TargetAddress());
                    Line("} else {");
                    Line("    xe_pc = %u;", next);
                    Line("}");
                    break;
                }
                case CF_RETURN:
                    Line("if (xe_call_depth > 0) { xe_call_depth--; xe_pc = xe_call_return[xe_call_depth]; } else { xe_pc = %u; }", next);
                    break;
                default:
                    Line("xe_pc = %u;", next);
                    break;
                }
                m_indent--;
                Line("}");
            }
            Line("default: {");
            Line("    return;");
            Line("}");
            Line("}");
            m_indent--;
            Line("}");
        }

        // Shared WGSL: bindings and helper functions.
        const char* COMMON_WGSL = R"(
struct XeSystem {
    ndc_scale : vec4f,                   // xyz
    ndc_offset : vec4f,                  // xyz
    flags : vec4u,                       // x: flags, y: alpha test function, z: param gen register, w: unused
    alpha_ref : vec4f,                   // x: alpha reference
    color_exp_bias : vec4f,              // multiplier per color target
    bool_consts : array<vec4u, 2>,
    loop_consts : array<vec4u, 8>,
    vb_bases : array<vec4i, 24>,         // byte offset of vertex fetch constant N's base in xe_vertex_data
    tex_swizzles : array<vec4u, 8>,      // texture fetch constant swizzles (12 bits)
    tex_lod_bias : array<vec4f, 8>,      // texture fetch constant LOD biases
}
@group(0) @binding(0) var<uniform> xe_system : XeSystem;

// Graphics options (gpu/graphics_options.h), per draw.
struct XeEffects {
    effect : vec4f,                      // x: motion blur, y: depth of field, z: shadow softness (scales), w: texture LOD scale
    jitter : vec4f,                      // xy: sub-pixel jitter in NDC for perspective draws (temporal upscaling)
    hud : vec4f,                         // wide screens (gpu/widescreen.h): xy scale of the 2D around the centre, z: mode bits, w: anchor shift
    hud_target : vec4f,                  // xy: the target's guest size of the NDC, zw: the screen's (1280x720)
}
@group(0) @binding(3) var<uniform> xe_effects : XeEffects;

// Wide screens: a 2D vertex (NDC) back into the middle 16:9 area of the screen (see the HLSL
// translator's xe_hud_transform).
fn xe_hud_transform(ndc : vec2f) -> vec2f {
    let hud = xe_effects.hud;
    let tgt = xe_effects.hud_target;
    let mode = u32(hud.z + 0.5);
    let px = vec2f((ndc.x + 1.0) * 0.5 * tgt.x, (1.0 - ndc.y) * 0.5 * tgt.y);
    let centre = tgt.zw * 0.5;
    let d = px - centre;
    var result = centre + d * hud.xy;
    if ((mode & 4u) == 0u) {
        let edge_x = px.x <= 2.0 || px.x >= tgt.z - 2.0;
        let edge_y = px.y <= 2.0 || px.y >= tgt.w - 2.0;
        if ((mode & 8u) != 0u) { result.x += hud.w; }
        if (edge_x) { result.x = px.x; }
        if (edge_y) { result.y = px.y; }
        if ((mode & 2u) != 0u && edge_x && edge_y) { result = centre + d * vec2f(1.0 / hud.y, 1.0 / hud.x); }
    }
    return vec2f(result.x / tgt.x * 2.0 - 1.0, 1.0 - result.y / tgt.y * 2.0);
}

const XE_FLAG_XY_DIVIDED_BY_W : u32 = 1u;
const XE_FLAG_Z_DIVIDED_BY_W : u32 = 2u;
const XE_FLAG_W_NOT_RECIPROCAL : u32 = 4u;
const XE_FLAG_PARAM_GEN : u32 = 8u;
const XE_FLAG_ALPHA_TEST : u32 = 16u;
const XE_FLT_MAX : f32 = 3.402823466e+38;

var<private> xe_o : array<vec4f, 16>;
var<private> xe_o_pos : vec4f;
var<private> xe_o_misc : vec4f;
var<private> xe_oC : array<vec4f, 4>;
var<private> xe_oDepth : f32;
var<private> xe_ps : f32;
var<private> xe_p0 : bool;
var<private> xe_a0 : i32;
var<private> xe_aL : i32;
var<private> xe_vf_address : i32;

fn xe_vb_base(index : u32) -> i32 { return xe_system.vb_bases[index >> 2u][index & 3u]; }
fn xe_lod_bias(index : u32) -> f32 { return xe_system.tex_lod_bias[index >> 2u][index & 3u]; }
fn xe_isinf(x : f32) -> bool { return (bitcast<u32>(x) & 0x7FFFFFFFu) == 0x7F800000u; }
fn xe_isfinite(x : f32) -> bool { return (bitcast<u32>(x) & 0x7F800000u) != 0x7F800000u; }

fn xe_mul(a : vec4f, b : vec4f) -> vec4f { return select(a * b, vec4f(0.0), (a == vec4f(0.0)) | (b == vec4f(0.0))); }
fn xe_muls(a : f32, b : f32) -> f32 { return select(a * b, 0.0, a == 0.0 || b == 0.0); }
fn xe_max(a : vec4f, b : vec4f) -> vec4f { return select(b, a, a >= b); }
fn xe_min(a : vec4f, b : vec4f) -> vec4f { return select(b, a, a < b); }
fn xe_dp4(a : vec4f, b : vec4f) -> f32 { let m = xe_mul(a, b); return m.x + m.y + m.z + m.w; }
fn xe_dp3(a : vec4f, b : vec4f) -> f32 { let m = xe_mul(a, b); return m.x + m.y + m.z; }
fn xe_dp2(a : vec4f, b : vec4f) -> f32 { let m = xe_mul(a, b); return m.x + m.y; }
fn xe_max4(a : vec4f) -> f32 {
    if (a.x >= a.y && a.x >= a.z && a.x >= a.w) { return a.x; }
    if (a.y >= a.z && a.y >= a.w) { return a.y; }
    return select(a.w, a.z, a.z >= a.w);
}
fn xe_cube(s : vec4f) -> vec4f {
    let x = s.z;
    let y = s.w;
    let z = s.x;
    var r : vec4f;
    if (abs(z) >= abs(x) && abs(z) >= abs(y)) {
        r = vec4f(-y, select(x, -x, z < 0.0), z, select(4.0, 5.0, z < 0.0));
    } else if (abs(y) >= abs(x)) {
        r = vec4f(select(z, -z, y < 0.0), x, y, select(2.0, 3.0, y < 0.0));
    } else {
        r = vec4f(-y, select(-z, z, x < 0.0), x, select(0.0, 1.0, x < 0.0));
    }
    r.z *= 2.0;
    return r;
}
fn xe_select(v : vec4f, s : u32) -> f32 {
    if (s >= 4u) { return select(0.0, 1.0, s == 5u); }
    return dot(v, vec4f(f32(s == 0u), f32(s == 1u), f32(s == 2u), f32(s == 3u)));
}
fn xe_swizzle(v : vec4f, index : u32) -> vec4f {
    let s = xe_system.tex_swizzles[index >> 2u][index & 3u];
    return vec4f(xe_select(v, s & 7u), xe_select(v, (s >> 3u) & 7u), xe_select(v, (s >> 6u) & 7u), xe_select(v, (s >> 9u) & 7u));
}
)";

        // Vertex shaders: vertex data and its unpacking.
        const char* VERTEX_WGSL = R"(
@group(0) @binding(4) var<storage, read> xe_vertex_data : array<u32>;

// A dword of the vertex data at byte offset a (0 outside the buffer, as a ByteAddressBuffer).
fn xe_load(a : i32) -> u32 {
    let i = u32(a) >> 2u;
    if (a < 0 || i >= arrayLength(&xe_vertex_data)) { return 0u; }
    return xe_vertex_data[i];
}
fn xe_load2(a : i32) -> vec2u { return vec2u(xe_load(a), xe_load(a + 4)); }
fn xe_load3(a : i32) -> vec3u { return vec3u(xe_load(a), xe_load(a + 4), xe_load(a + 8)); }
fn xe_load4(a : i32) -> vec4u { return vec4u(xe_load(a), xe_load(a + 4), xe_load(a + 8), xe_load(a + 12)); }

fn xe_unpack(w : vec4u, offset : vec4u, width : vec4u, is_signed : bool, normalized : bool) -> vec4f {
    var f : vec4f;
    if (is_signed) {
        let v = bitcast<vec4i>(w << (vec4u(32u) - offset - width)) >> (vec4u(32u) - width);
        f = vec4f(v);
        if (normalized) { f = max(f / vec4f((vec4u(1u) << (width - vec4u(1u))) - vec4u(1u)), vec4f(-1.0)); }
    } else {
        let v = (w >> offset) & ((vec4u(1u) << width) - vec4u(1u));
        f = vec4f(v);
        if (normalized) { f = f / vec4f((vec4u(1u) << width) - vec4u(1u)); }
    }
    return f;
}
fn xe_unpack32(w : vec4u, is_signed : bool, normalized : bool) -> vec4f {
    var f = select(vec4f(w), vec4f(bitcast<vec4i>(w)), is_signed);
    if (normalized) { f = f / select(4294967295.0, 2147483647.0, is_signed); }
    return f;
}
)";

        // Vertex output = pixel shader input.
        const char* VERTEX_OUTPUT_WGSL = R"(struct XeVertexOutput {
    @builtin(position) position : vec4f,
    @location(0) i0 : vec4f,
    @location(1) i1 : vec4f,
    @location(2) i2 : vec4f,
    @location(3) i3 : vec4f,
    @location(4) i4 : vec4f,
    @location(5) i5 : vec4f,
    @location(6) i6 : vec4f,
    @location(7) i7 : vec4f,
    @location(8) i8 : vec4f,
    @location(9) i9 : vec4f,
    @location(10) i10 : vec4f,
    @location(11) i11 : vec4f,
    @location(12) i12 : vec4f,
    @location(13) i13 : vec4f,
    @location(14) i14 : vec4f,
    @location(15) i15 : vec4f,
}

)";
    }

    TranslatedShader Translator::Run()
    {
        m_out.stage = m_stage;
        m_out.hash = HashUcode(m_stage, m_ucode, m_dwordCount);
        ParseControlFlow();
        ScanRegisters();
        FindGradientFetches();

        uint32_t registerCount = m_relativeTemps ? 64 : m_maxRegister + 1;
        if (IsPixel())
            registerCount = std::max(registerCount, 16u);

        if (!m_out.usesControlFlowMachine)
            EmitStructured();
        else if (FindStructuredFlow())
            EmitStructuredFlow();
        else
            EmitStateMachine();

        std::string& wgsl = m_out.hlsl;
        Append(wgsl, "// Xenos %s shader %016llX, %u control flow instructions (WGSL)\n", IsPixel() ? "pixel" : "vertex",
               (unsigned long long)m_out.hash, uint32_t(m_cf.size()));
        wgsl += COMMON_WGSL;
        if (!IsPixel())
            wgsl += VERTEX_WGSL;
        Append(wgsl, "\n@group(0) @binding(%u) var<uniform> xe_c : array<vec4f, 256>;\n", IsPixel() ? 2u : 1u);
        for (const TextureBinding& binding : m_out.textures)
            Append(wgsl, "@group(1) @binding(%u) var xe_t%u : texture_2d<f32>;\n@group(1) @binding(%u) var xe_s%u : sampler;\n",
                   binding.fetchConstant, binding.fetchConstant, 32 + binding.fetchConstant, binding.fetchConstant);
        Append(wgsl, "var<private> r : array<vec4f, %u>;\n", registerCount);
        for (uint32_t reg = 0; reg < 16; reg++)
        {
            if (m_gradientRegisters & (1u << reg))
                Append(wgsl, "var<private> xe_gx_r%u : vec4f;  // derivatives of input register %u\nvar<private> xe_gy_r%u : vec4f;\n", reg, reg, reg);
        }
        wgsl += "\n";

        wgsl += "fn xe_main() {\n";
        wgsl += m_body;
        wgsl += "}\n\n";

        wgsl += VERTEX_OUTPUT_WGSL;

        if (!IsPixel())
        {
            // Private variables start zeroed.
            wgsl += R"(@vertex
fn main(@builtin(vertex_index) vertex_index : u32) -> XeVertexOutput {
    xe_o_pos = vec4f(0.0, 0.0, 0.0, 1.0);
    r[0].x = f32(vertex_index);
    xe_main();
    var output : XeVertexOutput;
)";
            for (uint32_t i = 0; i < 16; i++)
                Append(wgsl, "    output.i%u = xe_o[%u];\n", i, i);
            wgsl += R"(    var p = xe_o_pos;
    let flags = xe_system.flags.x;
    // PA_CL_VTE_CNTL.vtx_w0_fmt = 1: the shader wrote W itself; 0: it wrote 1/W.
    if ((flags & XE_FLAG_W_NOT_RECIPROCAL) == 0u) { p.w = 1.0 / p.w; }
    if ((flags & XE_FLAG_XY_DIVIDED_BY_W) != 0u) { p.x *= p.w; p.y *= p.w; }
    if ((flags & XE_FLAG_Z_DIVIDED_BY_W) != 0u) { p.z *= p.w; }
    p = vec4f(p.xyz * xe_system.ndc_scale.xyz + xe_system.ndc_offset.xyz * p.w, p.w);
    // Wide screens: 2D (W = 1) into the middle 16:9 area.
    if (xe_effects.hud.z > 0.5 && xe_effects.hud.z < 31.5 && abs(p.w - 1.0) <= 1e-5) {
        let h = xe_hud_transform(p.xy);
        p.x = h.x;
        p.y = h.y;
    }
    // Temporal upscaling: jitter perspective geometry only (screen-space quads have W = 1).
    if (abs(p.w - 1.0) > 1e-5) {
        p.x += xe_effects.jitter.x * p.w;
        p.y += xe_effects.jitter.y * p.w;
    }
    output.position = p;
    return output;
}
)";
        }
        else
        {
            wgsl += "struct XePixelOutput {\n";
            for (uint32_t i = 0; i < 4; i++)
            {
                if (m_out.colorTargetsWritten & (1u << i))
                    Append(wgsl, "    @location(%u) color%u : vec4f,\n", i, i);
            }
            if (m_out.writesDepth)
                wgsl += "    @builtin(frag_depth) depth : f32,\n";
            if (!m_out.colorTargetsWritten && !m_out.writesDepth)
                wgsl += "    @location(0) color0 : vec4f,\n";
            wgsl += "}\n\n";
            wgsl += "@fragment\nfn main(input : XeVertexOutput, @builtin(front_facing) front_face : bool) -> XePixelOutput {\n";
            for (uint32_t i = 0; i < 16; i++)
                Append(wgsl, "    r[%u] = input.i%u;\n", i, i);
            wgsl += R"(    xe_oDepth = input.position.z;
    let flags = xe_system.flags.x;
    if ((flags & XE_FLAG_PARAM_GEN) != 0u) {
        var param = vec4f(input.position.xy - 0.5, 0.0, 0.0);
        if (!front_face) { param.x = -param.x; }
        let k = xe_system.flags.z;
        if (k < 16u) { r[k] = param; }
    }
)";
            for (uint32_t reg = 0; reg < 16; reg++)
            {
                if (m_gradientRegisters & (1u << reg))
                    Append(wgsl, "    xe_gx_r%u = dpdx(r[%u]);\n    xe_gy_r%u = dpdy(r[%u]);\n", reg, reg, reg, reg);
            }
            wgsl += R"(    xe_main();
    if ((flags & XE_FLAG_ALPHA_TEST) != 0u) {
        let alpha = xe_oC[0].w;
        let alpha_ref = xe_system.alpha_ref.x;
        var alpha_pass = true;
        switch (xe_system.flags.y) {
            case 0u: { alpha_pass = false; }
            case 1u: { alpha_pass = alpha < alpha_ref; }
            case 2u: { alpha_pass = alpha == alpha_ref; }
            case 3u: { alpha_pass = alpha <= alpha_ref; }
            case 4u: { alpha_pass = alpha > alpha_ref; }
            case 5u: { alpha_pass = alpha != alpha_ref; }
            case 6u: { alpha_pass = alpha >= alpha_ref; }
            default: { alpha_pass = true; }
        }
        if (!alpha_pass) { discard; }
    }
    var output : XePixelOutput;
)";
            for (uint32_t i = 0; i < 4; i++)
            {
                if (m_out.colorTargetsWritten & (1u << i))
                    Append(wgsl, "    output.color%u = xe_oC[%u] * xe_system.color_exp_bias[%u];\n", i, i, i);
            }
            if (m_out.writesDepth)
                wgsl += "    output.depth = saturate(xe_oDepth);\n";
            if (!m_out.colorTargetsWritten && !m_out.writesDepth)
                wgsl += "    output.color0 = vec4f(0.0);\n";
            wgsl += "    return output;\n}\n";
        }
        return std::move(m_out);
    }

    TranslatedShader TranslateShader(ShaderStage stage, const uint32_t* ucode, uint32_t dwordCount)
    {
        return Translator(stage, ucode, dwordCount).Run();
    }
}

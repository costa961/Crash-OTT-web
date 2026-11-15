// audio/audio_device.h for the browser: crashott-pc's mixer (audio/audio_output.cpp) queues its
// interleaved float frames into a ring in shared memory, and the page's AudioWorklet
// (web/src/audio-worklet.ts) plays them. Stereo: Open answers 2 channels, and the mixer downmixes.
// With no page attached (the Node runner), the frames are consumed at the real rate and dropped,
// so the mixer's clock and the title's audio callbacks keep their pace.
//
// The ring (WebAudio, registered with the host through crashott.audio_register): fixed fields, then
// `capacity` frames of `channels` floats. The producer advances `write`, the worklet `read` (frame
// counters modulo 2^32, capacity a power of two).
#include "audio/audio_device.h"
#include "diagnostics.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>

__attribute__((import_module("crashott"), import_name("audio_register"))) extern "C" void crashott_audio_register(uint32_t ring);

namespace
{
    constexpr uint32_t CAPACITY = 1u << 14;   // frames: ~340 ms at 48 kHz
    constexpr uint32_t CHANNELS = 2;
    constexpr uint32_t FRAME_SAMPLES = 256;   // the mixer's frame (audio_output.h)

    struct WebAudio
    {
        uint32_t magic;       // 'WAUD'
        uint32_t sampleRate;
        uint32_t channels;
        uint32_t capacity;
        uint32_t samples;     // wasm address of the ring's floats
        uint32_t attached;    // the page's worklet plays the ring
        uint32_t write;       // producer, frames
        uint32_t read;        // worklet, frames
        uint32_t underruns;   // worklet: render quanta it padded with silence
        uint32_t reserved[7];
    };

    WebAudio g_ring{ 0x44554157u, 48000, CHANNELS, CAPACITY, 0, 0, 0, 0, 0, {} };
    float g_samples[CAPACITY * CHANNELS];
    bool g_registered;

    std::atomic<int64_t> g_lastPlayed{ 0 };
    uint32_t g_lastRead;

    // no page: the frames "played" since the last call
    std::chrono::steady_clock::time_point g_clock;
    int64_t g_pending;

    int64_t Now() { return std::chrono::steady_clock::now().time_since_epoch().count(); }
    bool Attached() { return __atomic_load_n(&g_ring.attached, __ATOMIC_ACQUIRE) != 0; }

    void DrainWithoutPage()
    {
        auto now = std::chrono::steady_clock::now();
        if (g_clock == std::chrono::steady_clock::time_point{})
            g_clock = now;
        int64_t played = std::chrono::duration_cast<std::chrono::microseconds>(now - g_clock).count() * g_ring.sampleRate / 1000000;
        if (played <= 0)
            return;
        g_clock += std::chrono::microseconds(played * 1000000 / g_ring.sampleRate);
        if (g_pending > 0)
        {
            g_pending = g_pending > played ? g_pending - played : 0;
            g_lastPlayed = Now();
        }
    }
}

namespace audio::device
{
    uint32_t Open(uint32_t sampleRate, uint32_t)
    {
        g_ring.sampleRate = sampleRate ? sampleRate : 48000;
        g_ring.samples = uint32_t(reinterpret_cast<uintptr_t>(g_samples));
        if (!g_registered)
        {
            g_registered = true;
            crashott_audio_register(uint32_t(reinterpret_cast<uintptr_t>(&g_ring)));
        }
        g_pending = 0;
        g_clock = {};
        g_lastPlayed = Now();
        g_lastRead = __atomic_load_n(&g_ring.read, __ATOMIC_ACQUIRE);
        Log("[audio] web output: %u Hz stereo, ring of %u frames", g_ring.sampleRate, CAPACITY);
        return CHANNELS;
    }

    bool Queue(const float* samples, uint32_t frames)
    {
        if (!Attached())
        {
            DrainWithoutPage();
            g_pending += frames;
            return true;
        }
        uint32_t write = g_ring.write, read = __atomic_load_n(&g_ring.read, __ATOMIC_ACQUIRE);
        if (CAPACITY - (write - read) < frames)
            return false;  // the worklet is behind: dropped (the mixer counts it)
        for (uint32_t i = 0; i < frames; i++)
        {
            uint32_t at = (write + i) & (CAPACITY - 1);
            memcpy(&g_samples[at * CHANNELS], &samples[i * CHANNELS], sizeof(float) * CHANNELS);
        }
        __atomic_store_n(&g_ring.write, write + frames, __ATOMIC_RELEASE);
        return true;
    }

    int Queued()
    {
        if (!Attached())
        {
            DrainWithoutPage();
            return int(g_pending / FRAME_SAMPLES);
        }
        uint32_t read = __atomic_load_n(&g_ring.read, __ATOMIC_ACQUIRE);
        if (read != g_lastRead)
        {
            g_lastRead = read;
            g_lastPlayed = Now();
        }
        return int((g_ring.write - read) / FRAME_SAMPLES);
    }

    int64_t LastPlayed()
    {
        // A page that attached late, or a tab in the background, must not read as a stalled device.
        if (!Attached())
            return Now();
        return g_lastPlayed.load();
    }

    void Stop() {}
    void Close() {}
}

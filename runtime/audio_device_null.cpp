// audio/audio_device.h for the browser, for now: a device that plays nothing but consumes the frames
// at the real rate (48 kHz), so audio_output.cpp's clock and the title's audio callbacks keep their
// pace. The page's AudioWorklet replaces it later.
#include "audio/audio_device.h"

#include <atomic>
#include <chrono>
#include <cstdint>

namespace
{
    std::atomic<uint32_t> g_rate{ 48000 };
    std::atomic<int64_t> g_queuedFrames{ 0 };
    std::atomic<int64_t> g_lastPlayed{ 0 };
    std::chrono::steady_clock::time_point g_last;

    int64_t Now() { return std::chrono::steady_clock::now().time_since_epoch().count(); }

    // Drains what would have been played since the last call.
    void Drain()
    {
        auto now = std::chrono::steady_clock::now();
        if (g_last == std::chrono::steady_clock::time_point{})
            g_last = now;
        int64_t played = std::chrono::duration_cast<std::chrono::microseconds>(now - g_last).count() * g_rate / 1000000;
        if (played <= 0)
            return;
        g_last += std::chrono::microseconds(played * 1000000 / g_rate);
        int64_t queued = g_queuedFrames.load();
        if (queued > 0)
        {
            g_queuedFrames = queued > played ? queued - played : 0;
            g_lastPlayed = Now();
        }
    }
}

namespace audio::device
{
    uint32_t Open(uint32_t sampleRate, uint32_t channels)
    {
        g_rate = sampleRate ? sampleRate : 48000;
        g_queuedFrames = 0;
        g_last = {};
        g_lastPlayed = Now();
        return channels ? channels : 2;
    }

    bool Queue(const float*, uint32_t frames)
    {
        Drain();
        g_queuedFrames += frames;
        return true;
    }

    int Queued()
    {
        Drain();
        // audio_output.cpp counts in its 256-sample frames
        return int(g_queuedFrames.load() / 256);
    }

    int64_t LastPlayed() { return g_lastPlayed.load(); }
    void Stop() { g_queuedFrames = 0; }
    void Close() { g_queuedFrames = 0; }
}

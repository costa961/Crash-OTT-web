// FFmpeg for the browser build, in place of crashott-pc's audio/ffmpeg.cpp (which loads the DLLs at
// run time): the WMA Pro decoder is linked statically (tools/ffmpeg_wasm.sh builds it into
// out/ffmpeg), so Load() just fills the table with its functions. Built only with CRASH_HAVE_FFMPEG.
#include "audio/ffmpeg.h"
#include "diagnostics.h"

#include <mutex>

#if CRASH_HAVE_FFMPEG
namespace ffmpeg
{
    const Api* Load()
    {
        static Api api;
        static const Api* result = nullptr;
        static std::once_flag once;
        std::call_once(once, [] {
            api = Api{ avcodec_version, avcodec_find_decoder, avcodec_alloc_context3, avcodec_open2, avcodec_send_packet,
                       avcodec_receive_frame, avcodec_flush_buffers, avcodec_free_context, av_packet_alloc, av_packet_free,
                       av_frame_alloc, av_frame_free, av_mallocz, av_channel_layout_from_mask, av_log_set_level };
            if (!avcodec_find_decoder(AV_CODEC_ID_WMAPRO))
            {
                Log("[ffmpeg] the WMA Pro decoder is missing from the linked libavcodec: XMA decodes to silence");
                return;
            }
            av_log_set_level(AV_LOG_QUIET);
            unsigned version = avcodec_version();
            Log("[ffmpeg] libavcodec %u.%u.%u (static, WMA Pro)", version >> 16, (version >> 8) & 0xFF, version & 0xFF);
            result = &api;
        });
        return result;
    }
}
#endif

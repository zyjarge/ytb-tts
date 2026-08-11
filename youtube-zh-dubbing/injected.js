/**
 * 注入页面主世界(MAIN world)的脚本
 *
 * 背景:YouTube 的字幕轨道信息保存在页面主世界的 window.ytInitialPlayerResponse 中,
 * 而 Content Script 运行在隔离世界(ISOLATED world)无法访问该变量。
 * 本脚本运行于主世界,负责读取该数据并通过 window.postMessage 回传给 Content Script。
 *
 * 注意:MAIN world 中无法使用 chrome.* API,因此通信只能依赖 postMessage。
 */
(function () {
  'use strict';

  const SOURCE = 'ytb-tts-injected';
  const MESSAGE_NAME = 'ytb-tts-player-response';

  /** 读取并回传 ytInitialPlayerResponse 的关键字段,成功返回 true */
  function sendPlayerResponse() {
    const data = window.ytInitialPlayerResponse;
    if (!data || !data.videoDetails || !data.videoDetails.videoId) {
      return false;
    }
    const tracks =
      data.captions &&
      data.captions.playerCaptionsTracklistRenderer &&
      data.captions.playerCaptionsTracklistRenderer.captionTracks;
    window.postMessage(
      {
        source: SOURCE,
        type: MESSAGE_NAME,
        data: {
          videoId: data.videoDetails.videoId,
          title: data.videoDetails.title || '',
          captionTracks: Array.isArray(tracks) ? tracks : [],
        },
      },
      '*'
    );
    return true;
  }

  // 首次注入(document_start)时数据可能尚未就绪,轮询等待
  let attempts = 0;
  const maxAttempts = 60; // 最多等 30 秒
  (function poll() {
    if (sendPlayerResponse()) return;
    attempts += 1;
    if (attempts >= maxAttempts) return;
    setTimeout(poll, 500);
  })();

  // SPA 导航完成后数据会更新,延迟重发一次(由 Content Script 端按 videoId 去重)
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(sendPlayerResponse, 1200);
  });
})();

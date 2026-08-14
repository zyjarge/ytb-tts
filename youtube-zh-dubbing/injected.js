/**
 * 注入页面主世界(MAIN world)的脚本
 *
 * 职责:
 * 1. 读取 ytInitialPlayerResponse(字幕轨道信息等),经 window.postMessage 回传给 Content Script
 * 2. 在页面脚本执行前 hook fetch / XHR,捕获 YouTube 播放器自己发起的字幕(timedtext)请求
 * 3. 响应 Content Script 指令:开启 / 恢复播放器 CC 字幕轨道
 *
 * 为什么需要 hook:
 *   YouTube 对 timedtext 接口强制要求 pot(PO Token)参数,该 token 由页面播放器内的
 *   BotGuard 动态生成,扩展无法自行计算;直接用 captionTracks.baseUrl 请求只会得到
 *   200 空响应。播放器开启 CC 后会携带 pot 自行请求字幕,hook 捕获这次请求即可拿到数据。
 *
 * 注意:MAIN world 中无法使用 chrome.* API,因此通信只能依赖 postMessage。
 */
(function () {
  'use strict';

  const SOURCE = 'ytb-tts-injected';            // 本脚本 → Content Script
  const MSG_PLAYER_RESPONSE = 'ytb-tts-player-response';
  const MSG_TIMEDTEXT = 'ytb-tts-timedtext';    // 捕获到的字幕响应
  const CMD_SOURCE = 'ytb-tts-content';         // Content Script → 本脚本
  const MSG_CMD = 'ytb-tts-cmd';

  /* ---------------- ytInitialPlayerResponse 回传 ---------------- */

  /** 当前页面的视频 ID(watch 页取 v 参数;Shorts 页取 /shorts/{id};其他页返回 null) */
  function currentPageVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname.indexOf('/shorts/') === 0) {
        return u.pathname.split('/')[2] || null;
      }
      return u.searchParams.get('v');
    } catch (e) {
      return null;
    }
  }

  /**
   * 当前激活的播放器 API 元素(供字幕轨道 setOption 等)。
   * Shorts 滚动后页面会存在多个 #movie_player(相邻 reel 预加载),
   * 且新版 reel 没有 is-active 属性;先取"可视面积最大的 video"
   * (与 content.js 同一判定),再定位到同 reel 内的 #movie_player
   */
  function getActivePlayer() {
    const videos = Array.from(document.querySelectorAll('video.html5-main-video'));
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if (w * h > bestArea) {
        bestArea = w * h;
        best = v;
      }
    }
    if (best) {
      const reel = best.closest ? best.closest('ytd-reel-video-renderer') : null;
      if (reel) {
        const p = reel.querySelector('#movie_player');
        if (p) return p;
      }
      const direct = best.closest ? best.closest('#movie_player') : null;
      if (direct) return direct;
    }
    return document.getElementById('movie_player');
  }

  /**
   * 读取当前视频的 playerResponse。
   * 优先用 ytInitialPlayerResponse;Shorts 滚动切换时它不一定随之更新,
   * 此时改从激活播放器实例的 getPlayerResponse() 取
   */
  function readPlayerData() {
    const pageId = currentPageVideoId();
    const initial = window.ytInitialPlayerResponse;
    if (initial && initial.videoDetails && initial.videoDetails.videoId &&
        (!pageId || initial.videoDetails.videoId === pageId)) {
      return initial;
    }
    try {
      const player = getActivePlayer();
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr && pr.videoDetails && pr.videoDetails.videoId &&
            (!pageId || pr.videoDetails.videoId === pageId)) {
          return pr;
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /** 读取并回传当前视频 playerResponse 的关键字段,成功返回 true */
  function sendPlayerResponse() {
    // SPA/Shorts 切换视频的瞬间,数据可能还是上一个视频的;
    // readPlayerData 只在与页面 URL 视频一致时才返回,否则 Content Script 会拿到陈旧字幕
    const data = readPlayerData();
    if (!data) {
      return false;
    }
    const tracks =
      data.captions &&
      data.captions.playerCaptionsTracklistRenderer &&
      data.captions.playerCaptionsTracklistRenderer.captionTracks;
    window.postMessage(
      {
        source: SOURCE,
        type: MSG_PLAYER_RESPONSE,
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

  // SPA 导航完成后数据会更新;新视频数据就绪前 sendPlayerResponse 会持续返回 false,
  // 轮询重发直至与页面 URL 一致(由 Content Script 端按 videoId 去重)
  document.addEventListener('yt-navigate-finish', () => {
    let retries = 0;
    (function retrySend() {
      if (sendPlayerResponse()) return;
      retries += 1;
      if (retries < 12) setTimeout(retrySend, 500); // 最多再等 6 秒
    })();
  });

  /* ---------------- timedtext 请求捕获 ---------------- */

  // 捕获缓存:`${videoId}|${lang}` → { url, body }
  // 播放器可能在 Content Script 监听之前就请求过字幕(如用户默认开 CC),需缓存备查
  const captured = new Map();

  // 保存原始 fetch,重拉字幕时绕过下面的 hook,避免自触发
  const origFetch = window.fetch.bind(window);

  function isTimedTextUrl(u) {
    return typeof u === 'string' && u.indexOf('/api/timedtext') !== -1;
  }

  function cacheKeyOf(url) {
    try {
      const u = new URL(url);
      return (u.searchParams.get('v') || '') + '|' + (u.searchParams.get('lang') || '');
    } catch (e) {
      return null;
    }
  }

  /**
   * 处理一次捕获到的 timedtext 请求
   * @param {string} url  播放器请求的完整 URL(带 pot)
   * @param {string|null} body 响应体(可能为空或非 json3 格式)
   */
  async function handleCaptured(url, body) {
    let text = body;
    // 响应不可用或不是 json3 时,借带 pot 的 URL 自行重拉 json3(主世界请求带页面凭据)
    if (!text || url.indexOf('fmt=json3') === -1) {
      try {
        const u = new URL(url);
        u.searchParams.set('fmt', 'json3');
        const resp = await origFetch(u.toString(), { credentials: 'include' });
        if (!resp.ok) return;
        text = await resp.text();
      } catch (e) {
        return;
      }
    }
    if (!text) return;
    const key = cacheKeyOf(url);
    if (key) captured.set(key, { url, body: text });
    window.postMessage({ source: SOURCE, type: MSG_TIMEDTEXT, data: { url, body: text } }, '*');
  }

  /* ---- hook window.fetch(透明转发,仅旁路读取 timedtext 响应) ---- */
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const result = origFetch(input, init);
    if (isTimedTextUrl(url)) {
      result
        .then((resp) => {
          try {
            resp.clone().text().then((t) => handleCaptured(url, t));
          } catch (e) { /* 忽略 */ }
        })
        .catch(() => {});
    }
    return result;
  };

  /* ---- hook XMLHttpRequest(播放器可能用 XHR 拉字幕) ---- */
  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isTimedTextUrl(String(url))) {
      this.addEventListener('load', () => {
        try {
          let body = null;
          if (!this.responseType || this.responseType === 'text') {
            body = this.responseText;
          } else if (this.responseType === 'json') {
            body = JSON.stringify(this.response);
          }
          // body 为空(如 arraybuffer)也交给 handleCaptured 走重拉逻辑
          handleCaptured(String(url), body);
        } catch (e) { /* 忽略 */ }
      });
    }
    return origXhrOpen.apply(this, arguments);
  };

  /* ---------------- CC 字幕轨道控制(响应 Content Script 指令) ---------------- */

  let prevTrackSaved = false; // 是否已记录用户原字幕轨道
  let prevTrack = null;       // 用户开启配音前的字幕轨道(用于恢复)

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== CMD_SOURCE || d.type !== MSG_CMD) return;
    if (d.cmd === 'enable-captions') {
      enableCaptions(d.videoId, d.track || {});
    } else if (d.cmd === 'restore-captions') {
      restoreCaptions();
    }
  });

  /**
   * 让播放器开启指定字幕轨道,触发其带 pot 的 timedtext 请求
   * @param {string} videoId 当前视频 ID(用于命中捕获缓存)
   * @param {object} track   { languageCode, kind }
   */
  function enableCaptions(videoId, track) {
    const lang = track.languageCode || 'en';

    // 已有该视频该语言的捕获缓存,直接重发,无需再操作播放器
    const hit = captured.get((videoId || '') + '|' + lang);
    if (hit) {
      window.postMessage({ source: SOURCE, type: MSG_TIMEDTEXT, data: hit }, '*');
      return;
    }

    const player = getActivePlayer();
    if (!player || typeof player.setOption !== 'function') return;
    try {
      if (typeof player.loadModule === 'function') player.loadModule('captions');

      // 记录用户原字幕轨道,配音取词结束后恢复
      if (!prevTrackSaved) {
        try {
          prevTrack = player.getOption('captions', 'track') || null;
        } catch (e) {
          prevTrack = null;
        }
        prevTrackSaved = true;
      }

      const target = { languageCode: lang };
      if (track.kind === 'asr') target.kind = 'asr';

      // 该轨道若已在显示(用户本来就开着这条 CC),setOption 不会触发新请求,
      // 先关再开,强制播放器重新拉取
      let current = null;
      try {
        current = player.getOption('captions', 'track');
      } catch (e) { /* 忽略 */ }
      if (current && current.languageCode === lang && (current.kind || '') === (target.kind || '')) {
        player.setOption('captions', 'track', {});
        setTimeout(() => {
          try {
            player.setOption('captions', 'track', target);
          } catch (e) { /* 忽略 */ }
        }, 300);
        return;
      }
      player.setOption('captions', 'track', target);
    } catch (e) { /* 忽略 */ }
  }

  /** 恢复用户开启配音前的字幕轨道状态 */
  function restoreCaptions() {
    if (!prevTrackSaved) return;
    const player = getActivePlayer();
    if (player && typeof player.setOption === 'function') {
      try {
        player.setOption('captions', 'track', prevTrack || {});
      } catch (e) { /* 忽略 */ }
    }
    prevTrackSaved = false;
    prevTrack = null;
  }
})();

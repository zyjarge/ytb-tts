/**
 * Content Script:UI 按钮、字幕抓取、同步播放引擎集成
 *
 * 职责:
 * 1. 在 YouTube 视频页注入「中文配音」按钮与状态提示
 * 2. 接收 injected.js(主世界)回传的 ytInitialPlayerResponse 信息
 * 3. 点击按钮:抓取英文字幕 → 发 DUB_START 给 Background → 启动 SyncPlayer 同步播放
 * 4. 接收 DUB_CUE_READY 音频并缓存;接收 DUB_ERROR 显示提示
 * 5. 处理:静音原声、seek 位置同步、广告暂停、SPA 导航重置
 */
(function () {
  'use strict';

  const BAR_ID = 'ytb-tts-bar';
  const BTN_ID = 'ytb-tts-toggle';
  const STATUS_ID = 'ytb-tts-status';
  const MSG_SOURCE = 'ytb-tts-injected';
  const MSG_NAME = 'ytb-tts-player-response';

  let playerInfo = null;        // injected 回传的 {videoId, title, captionTracks}
  let state = 'idle';           // idle | loading | active | error
  let activeVideoId = null;
  let cues = [];
  let syncPlayer = null;
  let cueAudioCache = new Map(); // index → {url, duration}
  let adObserver = null;
  let positionTimer = null;

  /* ---------------- UI ---------------- */

  function injectBar() {
    if (document.getElementById(BAR_ID)) return true;
    const bar = document.createElement('div');
    bar.id = BAR_ID;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '中文配音';
    btn.addEventListener('click', onToggleClick);

    const status = document.createElement('span');
    status.id = STATUS_ID;

    bar.appendChild(btn);
    bar.appendChild(status);

    // 插入到视频信息区顶部
    const below = document.querySelector('#below, ytd-watch-metadata');
    if (below && below.parentNode) {
      below.parentNode.insertBefore(bar, below);
      return true;
    }
    return false;
  }

  function setStatus(text, color) {
    const el = document.getElementById(STATUS_ID);
    if (el) {
      el.textContent = text || '';
      el.style.color = color || '';
    }
  }

  function setState(next) {
    state = next;
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.textContent = next === 'active' ? '停止配音' : '中文配音';
      btn.disabled = next === 'loading';
    }
    if (next === 'idle' || next === 'error') {
      const status = document.getElementById(STATUS_ID);
      if (status && next === 'error' && !status.textContent) {
        status.textContent = '配音已停止';
      }
    }
  }

  /* ---------------- 消息:主世界 → Content Script ---------------- */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE || data.type !== MSG_NAME) return;
    // 同一视频重复推送时保留已有字幕信息即可
    if (playerInfo && playerInfo.videoId === data.data.videoId && playerInfo.captionTracks.length > 0) {
      return;
    }
    playerInfo = data.data;
  });

  /* ---------------- 字幕抓取 ---------------- */

  async function fetchSubtitles() {
    if (!playerInfo) throw new Error('未获取到播放器数据,请刷新页面重试');
    const tracks = Subtitles.extractCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: playerInfo.captionTracks } } });
    const track = Subtitles.selectTrack(tracks);
    if (!track) throw new Error('该视频无可用英文字幕');

    const url = Subtitles.buildTimedTextUrl(track);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`字幕抓取失败(HTTP ${resp.status})`);
    const json = await resp.json();

    const parsed = Subtitles.parseTimedText(json);
    if (parsed.length === 0) throw new Error('字幕内容为空');
    const merged = Subtitles.mergeCues(parsed);
    return Subtitles.assignIndexes(merged);
  }

  /* ---------------- 主流程:开始 / 停止 ---------------- */

  async function onToggleClick() {
    if (state === 'active') {
      await stopDubbing();
      return;
    }
    try {
      await startDubbing();
    } catch (e) {
      setState('error');
      setStatus((e && e.message) || String(e), '#c00');
    }
  }

  async function startDubbing() {
    setState('loading');
    setStatus('正在抓取字幕...');

    cues = await fetchSubtitles();
    setStatus(`共 ${cues.length} 句,正在合成语音...`);

    const video = getVideoElement();
    if (!video) throw new Error('未找到视频播放器');

    activeVideoId = playerInfo.videoId;
    cueAudioCache = new Map();

    syncPlayer = new SyncPlayer({
      cues,
      getAudio: (index) => {
        const entry = cueAudioCache.get(index);
        return entry ? { url: entry.url, duration: entry.duration } : null;
      },
      speed: 1.0, // 真实语速由 Background 在 TTS 合成时使用;此处仅播放速率
    });
    syncPlayer.attach(video);

    // 静音原声
    video.muted = true;

    const resp = await chrome.runtime.sendMessage({
      type: 'DUB_START',
      videoId: activeVideoId,
      cues: cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })),
    });
    if (!resp || !resp.ok) {
      video.muted = false;
      throw new Error((resp && resp.error) || '启动失败');
    }

    // 报告初始播放位置,推进预生成窗口
    reportPosition(true);
    syncPlayer.start();
    watchVideoPosition();
    watchAds();
    setState('active');
    setStatus('', '');
  }

  async function stopDubbing() {
    chrome.runtime.sendMessage({ type: 'DUB_STOP', videoId: activeVideoId }).catch(() => {});
    if (syncPlayer) {
      syncPlayer.stop();
      syncPlayer = null;
    }
    const video = getVideoElement();
    if (video) video.muted = false;
    clearInterval(positionTimer);
    positionTimer = null;
    if (adObserver) {
      adObserver.disconnect();
      adObserver = null;
    }
    // 释放 Blob URL
    for (const entry of cueAudioCache.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cueAudioCache = new Map();
    activeVideoId = null;
    cues = [];
    setState('idle');
    setStatus('已恢复原声');
  }

  /* ---------------- 音频接收与缓存 ---------------- */

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'DUB_CUE_READY': {
        if (msg.videoId !== activeVideoId) return;
        if (cueAudioCache.has(msg.index)) return;
        try {
          const bytes = base64ToBytes(msg.base64);
          const blob = new Blob([bytes], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          cueAudioCache.set(msg.index, { url, duration: 0 });
          probeDuration(msg.index, url);
        } catch (e) {
          console.error('[ytb-tts] 音频解码失败:', e);
        }
        break;
      }
      case 'DUB_ERROR': {
        if (msg.videoId !== activeVideoId) return;
        stopDubbing();
        setState('error');
        setStatus(msg.message || '合成失败', '#c00');
        break;
      }
      default:
        break;
    }
  });

  /** 预取音频时长(供溢出加速判断) */
  function probeDuration(index, url) {
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = url;
    probe.onloadedmetadata = () => {
      const entry = cueAudioCache.get(index);
      if (entry) entry.duration = probe.duration;
    };
  }

  /* ---------------- 辅助 ---------------- */

  function getVideoElement() {
    return document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video');
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** 定期报告播放位置,保持预生成窗口领先 */
  function watchVideoPosition() {
    clearInterval(positionTimer);
    positionTimer = setInterval(() => reportPosition(false), 2000);
    const video = getVideoElement();
    if (video) {
      video.removeEventListener('seeked', onVideoSeeked);
      video.addEventListener('seeked', onVideoSeeked);
    }
  }

  function onVideoSeeked() {
    reportPosition(true);
  }

  function reportPosition(force) {
    if (state !== 'active' || !activeVideoId) return;
    const video = getVideoElement();
    if (!video) return;
    const t = video.currentTime;
    // 找当前应播句子
    let idx = -1;
    for (let i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t < cues[i].end) { idx = i; break; }
      if (cues[i].start > t) break;
    }
    if (idx >= 0 || force) {
      chrome.runtime.sendMessage({ type: 'DUB_POSITION', videoId: activeVideoId, index: idx }).catch(() => {});
    }
  }

  /** 广告检测:播放器进入 ad-showing 时暂停配音调度 */
  function watchAds() {
    if (adObserver) adObserver.disconnect();
    const moviePlayer = document.querySelector('#movie_player');
    if (!moviePlayer) return;
    adObserver = new MutationObserver(() => {
      const inAd = moviePlayer.classList.contains('ad-showing');
      if (inAd && syncPlayer) {
        syncPlayer.pauseSchedule();
      } else if (!inAd && syncPlayer) {
        syncPlayer.resumeSchedule();
      }
    });
    adObserver.observe(moviePlayer, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------------- 启动与 SPA 导航 ---------------- */

  // document_idle 时页面结构可能未就绪,重试注入
  let injectAttempts = 0;
  (function tryInject() {
    if (injectBar()) {
      setState('idle');
      return;
    }
    injectAttempts += 1;
    if (injectAttempts < 40) setTimeout(tryInject, 500);
  })();

  // SPA 导航:切视频时重置全部状态
  document.addEventListener('yt-navigate-finish', () => {
    if (state === 'active') {
      stopDubbing();
    } else {
      setState('idle');
      setStatus('');
    }
    playerInfo = null;
  });
})();

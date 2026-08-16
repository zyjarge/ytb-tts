/**
 * B 站视频页 Content Script:中文配音
 *
 * 与 YouTube 路径(content.js)的差异:
 * - 字幕获取简单得多:无 pot 动态 token,登录态下直接调公开 JSON API
 *   (view → player/v2 → subtitle_url),无需主世界 hook,因此没有 injected.js
 * - B 站 AI 字幕(ai-zh)已是中文:跳过翻译,DUB_START 带 skipTranslate,
 *   字幕文本直通 MiniMax TTS(时间轴与原语音天然对齐)
 * - 分 P / 切视频是 pushState 无刷新导航,没有 yt-navigate-finish,
 *   由 2 秒巡检比较 URL 变化来重置状态
 *
 * 流程:点击按钮 → 暂停视频 + 加载浮层 → 拉取中文字幕 → DUB_START →
 * 首批缓冲(3 句)就绪自动续播;播放中某句未就绪同样暂停缓冲等待
 */
(function () {
  'use strict';

  console.log('[ytb-tts] bilibili content script loaded');

  const BTN_CLASS = 'ytb-tts-player-btn'; // 与 YouTube 端同名(两站脚本不会同时加载)
  const STATUS_ID = 'ytb-tts-status';
  const STYLE_ID = 'ytb-tts-style';
  const LOADING_ID = 'ytb-tts-loading';
  const HIDE_SUB_ID = 'ytb-tts-hide-sub'; // 配音期间隐藏 B 站原生字幕的 style 元素
  const INITIAL_BUFFER_CUES = 3;          // 开播前至少就绪的句数(首批缓冲)
  const LOADING_WATCHDOG_MS = 60000;      // 首批缓冲看门狗:超时兜底开播

  let playerData = null;       // { bvid, page, cid, subtitleUrl }
  let state = 'idle';          // idle | loading | active | error
  let activeVideoId = null;
  let cues = [];
  let syncPlayer = null;
  let cueAudioCache = new Map(); // index → {url, duration}
  let allReady = false;
  let pendingStartIndex = 0;
  let loadingWatchdog = null;
  let lastVideoKey = null;     // 巡检用:检测分 P / 切视频

  /* ---------------- UI ---------------- */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return true;
    const root = document.documentElement || document.head || document.body;
    if (!root) return false;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.ytb-tts-player-btn{display:flex;align-items:center;justify-content:center;',
      'width:34px;height:34px;cursor:pointer;border:none;background:transparent}',
      '.ytb-tts-player-btn img{width:20px;height:20px;border-radius:3px;opacity:.9;pointer-events:none}',
      '.ytb-tts-player-btn:hover img{opacity:1}',
      '.ytb-tts-player-btn.ytb-tts-active img{opacity:1;filter:drop-shadow(0 0 3px #00a1d6)}',
      // 控制栏缺失时的兜底:播放器右上角圆形浮动按钮
      '.ytb-tts-player-btn.ytb-tts-float-btn{position:absolute;top:56px;right:12px;',
      'z-index:60;width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,.55)}',
      '.ytb-tts-player-btn.ytb-tts-float-btn:hover{background:rgba(0,0,0,.75)}',
      '.ytb-tts-player-btn.ytb-tts-float-btn img{width:22px;height:22px}',
      '#ytb-tts-status{position:absolute;top:12px;left:12px;z-index:60;padding:4px 10px;',
      'border-radius:4px;background:rgba(0,0,0,.7);color:#fff;font-size:13px;',
      'pointer-events:none;display:none}',
      // 加载浮层:暂停期间的视觉提示;层级低于按钮(60),保证加载中按钮可点取消
      '#ytb-tts-loading{position:absolute;inset:0;z-index:59;display:none;',
      'flex-direction:column;align-items:center;justify-content:center;gap:14px;',
      'background:rgba(0,0,0,.35);pointer-events:none}',
      '.ytb-tts-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.25);',
      'border-top-color:#fff;border-radius:50%;animation:ytb-tts-spin .8s linear infinite}',
      '@keyframes ytb-tts-spin{to{transform:rotate(360deg)}}',
      '.ytb-tts-loading-text{color:#fff;font-size:14px;padding:4px 12px;',
      'border-radius:4px;background:rgba(0,0,0,.6)}',
    ].join('\n');
    root.appendChild(style);
    return true;
  }

  function getVideoElement() {
    return document.querySelector('.bpx-player-video-wrap video') ||
      document.querySelector('#bilibili-player video') ||
      document.querySelector('video');
  }

  /** 浮层挂载点:B 站播放器容器(实测 position:relative 且有实际尺寸) */
  function getPlayerContainer() {
    return document.querySelector('.bpx-player-container') ||
      document.getElementById('playerWrap') ||
      document.getElementById('bilibili-player');
  }

  function mountInPlayer(el) {
    const player = getPlayerContainer();
    if (!player) return false;
    if (el.parentNode !== player) player.appendChild(el);
    return true;
  }

  function ensureStatus() {
    let el = document.getElementById(STATUS_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = STATUS_ID;
    }
    return mountInPlayer(el);
  }

  function showLoadingOverlay(text) {
    let el = document.getElementById(LOADING_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = LOADING_ID;
      el.innerHTML =
        '<div class="ytb-tts-spinner"></div><div class="ytb-tts-loading-text"></div>';
    }
    if (!mountInPlayer(el)) return;
    el.querySelector('.ytb-tts-loading-text').textContent = text || '';
    el.style.display = 'flex';
  }

  function hideLoadingOverlay() {
    const el = document.getElementById(LOADING_ID);
    if (el) el.style.display = 'none';
  }

  /**
   * 注入配音按钮:优先嵌入控制栏右下区(.bpx-player-control-bottom-right 最左侧,
   * 与画质/倍速/字幕等原生按钮同排);控制栏未就绪时退回播放器右上角浮动按钮
   */
  function injectButton() {
    injectStyles();
    const controls = document.querySelector('.bpx-player-control-bottom-right');
    const controlsUsable = controls && controls.getBoundingClientRect().width > 0 ? controls : null;

    const existing = document.querySelector('.' + BTN_CLASS);
    if (existing) {
      // 控制栏重建后按钮可能丢失或挂错位置,搬家修正
      if (controlsUsable) {
        existing.classList.remove('ytb-tts-float-btn');
        if (existing.parentNode !== controlsUsable) controlsUsable.insertBefore(existing, controlsUsable.firstChild);
      } else {
        existing.classList.add('ytb-tts-float-btn');
        mountInPlayer(existing);
      }
      return ensureStatus();
    }

    const btn = document.createElement('button');
    btn.className = BTN_CLASS;
    btn.title = '中文配音';
    btn.setAttribute('aria-label', '中文配音');
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/button.png');
    img.alt = '';
    btn.appendChild(img);
    btn.addEventListener('click', onToggleClick);

    if (controlsUsable) {
      controlsUsable.insertBefore(btn, controlsUsable.firstChild);
      return ensureStatus();
    }
    btn.classList.add('ytb-tts-float-btn');
    if (!mountInPlayer(btn)) return false;
    return ensureStatus();
  }

  function setStatus(text, color) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#fff';
    el.style.display = text ? 'block' : 'none';
  }

  function setState(next) {
    state = next;
    const btn = document.querySelector('.' + BTN_CLASS);
    if (btn) {
      const active = next === 'active';
      btn.classList.toggle('ytb-tts-active', active);
      btn.title = (active || next === 'loading') ? '停止配音' : '中文配音';
      btn.setAttribute('aria-label', btn.title);
    }
    if (next === 'error') {
      const status = document.getElementById(STATUS_ID);
      if (status && !status.textContent) setStatus('配音已停止');
    }
  }

  /* ---------------- 视频标识与字幕抓取 ---------------- */

  /** 当前视频标识:{ bvid, page, key };/video 页外返回 null */
  function getVideoKey() {
    try {
      const u = new URL(location.href);
      const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
      if (!m) return null;
      const page = parseInt(u.searchParams.get('p') || '1', 10) || 1;
      const bvid = m[1];
      return { bvid, page, key: `bili:${bvid}:p${page}` };
    } catch (e) {
      return null;
    }
  }

  /**
   * 经 Background 代取 B 站 JSON 接口。
   * Content Script 直接 fetch 跨域(api.bilibili.com / aisubtitle.hdslb.com)受 CORS
   * 限制(实测报 Failed to fetch);Background 带 host_permissions 无此限制且能带登录 cookie
   */
  async function biliFetchJson(url) {
    const resp = await DubCommon.safeSendMessage({ type: 'BILI_FETCH', url });
    if (!resp) throw new Error('扩展通信失败,请刷新页面后重试');
    if (resp.error) throw new Error('网络请求失败:' + resp.error);
    if (!resp.ok) throw new Error(`请求失败(HTTP ${resp.status})`);
    try {
      return JSON.parse(resp.text);
    } catch (e) {
      throw new Error('响应解析失败');
    }
  }

  /**
   * 取播放器信息(wbi 签名接口,经 Background)。
   * 免签名接口会被 B 站风控返回张冠李戴的字幕轨道(实测踩坑),必须用签名版
   */
  async function biliPlayerV2(aid, cid) {
    const resp = await DubCommon.safeSendMessage({ type: 'BILI_PLAYER_V2', aid, cid });
    if (!resp) throw new Error('扩展通信失败,请刷新页面后重试');
    if (resp.error) throw new Error('网络请求失败:' + resp.error);
    if (!resp.ok) throw new Error(`播放器信息请求失败(HTTP ${resp.status})`);
    try {
      return JSON.parse(resp.text);
    } catch (e) {
      throw new Error('播放器信息解析失败');
    }
  }

  /**
   * 双语字幕清洗:B 站部分 AI 字幕一条里同时含中文行和英文行(实测 p4 分 P),
   * 英文行若送去 TTS 会被一并朗读。按行拆分,只保留含中文字符的行;
   * 单行混合或全英文时保留原文(避免误伤纯英文内容场景)
   */
  function stripBilingual(text) {
    const t = (text || '').trim();
    const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length <= 1) return t;
    const zhLines = lines.filter((l) => /[一-鿿]/.test(l));
    return (zhLines.length ? zhLines : lines).join(' ');
  }

  /**
   * 抓取中文字幕。链路(均为公开 JSON API,登录态 cookie 由 Background 携带):
   * view(bvid → 分 P 列表 → cid)→ player/wbi/v2(wbi 签名 → 字幕轨道)→ subtitle_url(字幕 JSON)
   * 返回 [{index, start, end, text}]
   */
  async function fetchSubtitles() {
    const vk = getVideoKey();
    if (!vk) throw new Error('不在视频页');
    if (!playerData || playerData.bvid !== vk.bvid || playerData.page !== vk.page) {
      const view = await biliFetchJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${vk.bvid}`
      );
      if (view.code !== 0 || !view.data) throw new Error('视频信息获取失败');
      const pages = view.data.pages || [];
      const pageInfo = pages.find((p) => p.page === vk.page) || pages[0];
      if (!pageInfo) throw new Error('分 P 信息获取失败');

      const player = await biliPlayerV2(view.data.aid, pageInfo.cid);
      if (player.code !== 0 || !player.data) throw new Error('播放器信息获取失败');

      const sub = player.data.subtitle || {};
      const tracks = sub.subtitles || [];
      // 中文字幕优先(ai-zh 为 AI 生成字幕;也兼容人工上传的 zh 轨道)
      const track = tracks.find((t) => t.lan === 'ai-zh') ||
        tracks.find((t) => (t.lan || '').indexOf('zh') === 0);
      if (!track) {
        if (player.data.need_login_subtitle) {
          throw new Error('B 站字幕需要登录后可见,请登录后刷新重试');
        }
        throw new Error('该视频无可用中文字幕(AI 字幕可能尚未生成)');
      }
      if (!track.subtitle_url) throw new Error('字幕地址为空');
      playerData = {
        bvid: vk.bvid,
        page: vk.page,
        cid: pageInfo.cid,
        subtitleUrl: track.subtitle_url.indexOf('//') === 0 ? 'https:' + track.subtitle_url : track.subtitle_url,
      };
    }

    const subJson = await biliFetchJson(playerData.subtitleUrl);
    const body = subJson.body || [];
    if (!body.length) throw new Error('字幕内容为空');
    return body.map((item, i) => ({
      index: i,
      start: typeof item.from === 'number' ? item.from : 0,
      end: typeof item.to === 'number' ? item.to : 0,
      text: stripBilingual(item.content),
    })).filter((c) => c.text && c.end > c.start);
  }

  /** 配音期间隐藏 B 站原生字幕面板(用户可能开着 CC) */
  function hideNativeSubtitle() {
    if (document.getElementById(HIDE_SUB_ID)) return;
    const style = document.createElement('style');
    style.id = HIDE_SUB_ID;
    style.textContent = '.bpx-player-subtitle-panel,.bilibili-player-video-subtitle{display:none!important}';
    document.documentElement.appendChild(style);
  }

  function showNativeSubtitle() {
    const el = document.getElementById(HIDE_SUB_ID);
    if (el) el.remove();
  }

  /* ---------------- 主流程:开始 / 停止 ---------------- */

  async function onToggleClick() {
    console.log('[ytb-tts] 配音按钮被点击(B站), 当前状态:', state);
    if (!DubCommon.isContextValid()) {
      setState('error');
      setStatus('扩展已更新,请刷新页面后重试', '#c00');
      return;
    }
    if (state === 'active' || state === 'loading') {
      // loading 中点击 = 取消加载;active 中点击 = 停止配音
      await stopDubbing();
      return;
    }
    try {
      await startDubbing();
    } catch (e) {
      console.error('[ytb-tts] 启动配音失败:', e);
      clearTimeout(loadingWatchdog);
      loadingWatchdog = null;
      hideLoadingOverlay();
      const v = getVideoElement();
      if (v && v.paused) v.play().catch(() => {}); // 加载阶段的暂停由我们发起,失败时恢复
      showNativeSubtitle();
      setState('error');
      setStatus((e && e.message) || String(e), '#c00');
    }
  }

  async function startDubbing() {
    setState('loading');
    setStatus('正在抓取字幕...');
    hideNativeSubtitle();

    const video = getVideoElement();
    if (!video) throw new Error('未找到视频播放器');

    // 先暂停视频并展示加载浮层,待首批语音缓冲就绪后自动续播
    video.pause();
    showLoadingOverlay('正在抓取字幕...');

    const vk = getVideoKey();
    const dubVideoId = vk ? vk.key : null;
    cues = await fetchSubtitles();
    // 打印首句便于核对字幕与视频是否对应(B 站风控曾返回过其他视频的字幕)
    console.log('[ytb-tts] 字幕首句:', cues[0] && cues[0].text, '| 共', cues.length, '句');

    // 抓字幕期间可能切换了分 P / 视频
    const vkAfter = getVideoKey();
    if (!vkAfter || vkAfter.key !== dubVideoId) {
      throw new Error('页面视频已切换,请重新点击「中文配音」');
    }
    setStatus(`共 ${cues.length} 句,启动流水线...`);
    showLoadingOverlay(`共 ${cues.length} 句,语音合成中...`);

    activeVideoId = dubVideoId;
    cueAudioCache = new Map();

    const now = video.currentTime || 0;
    const startCue = cues.find((c) => c.end > now);
    const startIndex = startCue ? startCue.index : 0;
    pendingStartIndex = startIndex;

    syncPlayer = new SyncPlayer({
      cues,
      getAudio: (index) => {
        const entry = cueAudioCache.get(index);
        return entry ? { url: entry.url, duration: entry.duration } : null;
      },
      speed: 1.0, // 真实语速由 Background 在 TTS 合成时使用;此处仅播放速率
      onBuffering: (buffering) => {
        // 播放中缓冲(某句合成跟不上):同样给暂停一个视觉提示
        if (state !== 'active') return;
        if (buffering) {
          showLoadingOverlay('语音合成中,缓冲等待...');
          setStatus('正在等待语音合成(缓冲中)...', '#f90');
        } else {
          hideLoadingOverlay();
          setStatus('', '');
        }
      },
    });
    syncPlayer.attach(video);

    // 静音原声;配音期间用户通过音量控件取消静音时重新静音(恢复原声请点「停止配音」)
    video.muted = true;
    video.removeEventListener('volumechange', onVolumeChange);
    video.addEventListener('volumechange', onVolumeChange);

    const resp = await DubCommon.safeSendMessage({
      type: 'DUB_START',
      videoId: activeVideoId,
      startIndex,
      skipTranslate: true, // B 站字幕已是中文,直通 TTS
      cues: cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })),
    });
    if (!resp || !resp.ok) {
      video.muted = false;
      throw new Error((resp && resp.error) || '启动失败');
    }

    // 不立即开播:视频保持暂停+加载浮层,等首批缓冲就绪后由 beginPlayback() 续播;
    // 看门狗超时兜底,防止流水线异常时永远卡在加载态
    allReady = false;
    clearTimeout(loadingWatchdog);
    loadingWatchdog = setTimeout(() => {
      if (state === 'loading') {
        console.warn('[ytb-tts] 首批缓冲超时,兜底开播(后续句走单句缓冲)');
        beginPlayback();
      }
    }, LOADING_WATCHDOG_MS);
    checkInitialBuffer();
  }

  /** 首批缓冲目标:从起始句起的连续 INITIAL_BUFFER_CUES 句(不足则取剩余全部) */
  function initialBufferTarget() {
    const remaining = cues.filter((c) => c.index >= pendingStartIndex);
    return remaining.slice(0, INITIAL_BUFFER_CUES);
  }

  /** 检查首批缓冲进度;就绪则自动开播(loading 态下由音频到达事件驱动) */
  function checkInitialBuffer() {
    if (state !== 'loading' || !activeVideoId) return;
    const target = initialBufferTarget();
    const ready = target.filter((c) => cueAudioCache.has(c.index)).length;
    if (target.length === 0 || ready >= target.length) {
      beginPlayback();
    } else {
      showLoadingOverlay(`语音加载中... 首批 ${ready}/${target.length}`);
    }
  }

  /** 首批缓冲就绪:收起加载浮层,启动播放引擎并自动续播视频 */
  function beginPlayback() {
    if (state !== 'loading') return;
    clearTimeout(loadingWatchdog);
    loadingWatchdog = null;
    hideLoadingOverlay();
    syncPlayer.start();
    const video = getVideoElement();
    if (video && video.paused) video.play().catch(() => {});
    setState('active');
    setStatus('首批语音已就绪,后续边合成边播', '#0a7d33');
    setTimeout(() => {
      if (state === 'active') setStatus('', '');
    }, 3000);
  }

  async function stopDubbing() {
    const wasLoading = state === 'loading';
    DubCommon.safeSendMessage({ type: 'DUB_STOP', videoId: activeVideoId });
    clearTimeout(loadingWatchdog);
    loadingWatchdog = null;
    hideLoadingOverlay();
    if (syncPlayer) {
      syncPlayer.stop();
      syncPlayer = null;
    }
    const video = getVideoElement();
    if (video) {
      video.muted = false;
      video.removeEventListener('volumechange', onVolumeChange);
      // 加载阶段被取消:视频是我们暂停的,恢复播放,避免画面卡在暂停态
      if (wasLoading && video.paused) video.play().catch(() => {});
    }
    allReady = false;
    // 释放 Blob URL
    for (const entry of cueAudioCache.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cueAudioCache = new Map();
    activeVideoId = null;
    cues = [];
    showNativeSubtitle();
    setState('idle');
    setStatus('已恢复原声');
  }

  /* ---------------- 音频接收与缓存 ---------------- */

  const chunkHandler = DubCommon.createChunkHandler({
    getCache: () => cueAudioCache,
    onProgress: () => {
      if (state === 'loading') checkInitialBuffer();
    },
  });

  chrome.runtime.onMessage.addListener((msg) => {
    // 上下文失效(扩展被重载)时,回调内的 chrome API 调用可能同步抛错,
    // 包一层 try/catch 防止其变成页面 Uncaught 错误
    try {
      switch (msg.type) {
      case 'DUB_CUE_READY': {
        if (msg.videoId !== activeVideoId) return;
        if (cueAudioCache.has(msg.index)) return;
        try {
          const bytes = DubCommon.base64ToBytes(msg.base64);
          const blob = new Blob([bytes], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          cueAudioCache.set(msg.index, { url, duration: 0 });
          probeDuration(msg.index, url);
          console.log('[ytb-tts] 收到音频:', msg.index, '(已缓存', cueAudioCache.size, '句)');
          if (state === 'loading') checkInitialBuffer();
        } catch (e) {
          console.error('[ytb-tts] 音频解码失败:', e);
        }
        break;
      }
      case 'DUB_CHUNK_READY': {
        // 合并块:整段音频 + 每句时间区间,切分回逐句 WAV 后入缓存
        if (msg.videoId !== activeVideoId) return;
        chunkHandler(msg).catch((e) => console.error('[ytb-tts] 合并音频切分失败:', e));
        break;
      }
      case 'DUB_ALL_READY': {
        if (msg.videoId !== activeVideoId) return;
        allReady = true;
        if (state === 'active') {
          setStatus('全部语音已就绪', '#0a7d33');
          setTimeout(() => {
            if (state === 'active') setStatus('', '');
          }, 3000);
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
    } catch (e) {
      // 上下文失效等场景:静默忽略
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

  /** 配音期间保持原声静音(用户调音量导致取消静音时自动恢复静音) */
  function onVolumeChange() {
    if (state !== 'active') return;
    const video = getVideoElement();
    if (video && !video.muted) video.muted = true;
  }

  /* ---------------- 启动与分 P / 切视频巡检 ---------------- */

  injectStyles();

  /**
   * 持续保证按钮存在 + 检测分 P / 视频切换:
   * B 站切分 P 是 pushState 无刷新导航,没有 yt-navigate-finish,
   * 通过比较 URL 视频标识变化来重置配音状态
   */
  function ensureInjected() {
    const vk = getVideoKey();
    if (!vk) return;
    if (lastVideoKey && vk.key !== lastVideoKey) {
      // 分 P / 视频已切换:重置全部状态
      if (state === 'active' || state === 'loading') {
        stopDubbing();
      } else {
        setState('idle');
        setStatus('');
      }
      playerData = null;
    }
    lastVideoKey = vk.key;
    injectButton();
  }
  ensureInjected();
  setInterval(ensureInjected, 2000);
})();

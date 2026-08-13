/**
 * Service Worker:翻译 + TTS 调度 + 缓存
 *
 * 职责:
 * 1. 接收 Content Script 的 DUB_START / DUB_STOP 消息
 * 2. 流式管线:从当前播放位置开始,按批「翻译 → 合成 → 即时推送 DUB_CUE_READY」,
 *    页面侧第一句就绪即可开播(由 SyncPlayer 的缓冲机制等待),无需整片合成完;
 *    全部完成后发送 DUB_ALL_READY 仅作状态通知
 * 3. 两级缓存:内存 Map + chrome.storage.local(翻译文本持久化,音频带容量上限的 LRU),
 *    同一视频中断后重开可命中缓存,成本很低
 *
 * 注意:MV3 下 Service Worker 可能随时休眠;合成结果全部通过
 * chrome.tabs.sendMessage 即时推送,不依赖 SW 长期存活。
 */
importScripts('lib/translate.js', 'lib/minimax_tts.js');

'use strict';

const TRANSLATE_BATCH = 25;             // 每批翻译句数
const FIRST_BATCH = 5;                  // 首批小批量翻译:缩短"开口"延迟
const AUDIO_CACHE_LIMIT = 4 * 1024 * 1024; // 音频持久化缓存上限 4MB(配额为 10MB,留余量)

// 任务表:videoId → 任务对象
const tasks = new Map();

/** 全局唯一的 TTS 队列(所有视频共享,天然全局限流) */
const ttsQueue = new MiniMaxTTS.TtsQueue();

/** 内存缓存:音频 base64(Map key → base64 字符串) */
const memAudioCache = new Map();

/** 读取设置(chrome.storage.local 的 options 键) */
async function getOptions() {
  const { options } = await chrome.storage.local.get('options');
  return options || {};
}

/** 翻译缓存 key:videoId:index */
function transKey(videoId, index) {
  return `${videoId}:${index}:zh`;
}

/** 音频缓存 key:含音色/语速,避免换设置后命中旧音频 */
function audioKey(videoId, index, options) {
  return `audio:${videoId}:${options.voiceId || 'default'}:${options.speed || 1}:${index}`;
}

/** 从缓存取翻译文本(内存 → storage) */
async function getTranslation(videoId, index) {
  const key = transKey(videoId, index);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

/** 写翻译缓存(storage 持久化 + 内存) */
async function setTranslation(videoId, index, text) {
  const key = transKey(videoId, index);
  await chrome.storage.local.set({ [key]: text });
}

/** 从缓存取音频 base64(内存 → storage,带容量管理) */
async function getAudioBase64(key) {
  if (memAudioCache.has(key)) return memAudioCache.get(key);
  const stored = await chrome.storage.local.get(key);
  if (stored[key]) memAudioCache.set(key, stored[key]);
  return stored[key] || null;
}

/** 写音频缓存:内存 + storage(超出容量上限时淘汰最旧) */
async function setAudioBase64(key, base64) {
  memAudioCache.set(key, base64);
  const stored = await chrome.storage.local.get(null);
  const sizeOf = (s) => s.length * 0.75;
  let total = Object.keys(stored).reduce((sum, k) => sum + sizeOf(stored[k] || ''), 0);
  if (total + sizeOf(base64) > AUDIO_CACHE_LIMIT) {
    // 淘汰 audio: 前缀中最旧的一条(按 key 字典序即按 index 序)
    const audioKeys = Object.keys(stored)
      .filter((k) => k.startsWith('audio:'))
      .sort((a, b) => (a > b ? 1 : -1));
    const drop = audioKeys.slice(0, Math.max(1, Math.floor(audioKeys.length * 0.3)));
    const dropObj = {};
    for (const k of drop) dropObj[k] = undefined;
    await chrome.storage.local.remove(drop);
    for (const k of drop) memAudioCache.delete(k);
  }
  await chrome.storage.local.set({ [key]: base64 });
}

/**
 * Blob → base64 字符串
 * 注意:Service Worker 环境没有 FileReader(window API),必须用 Blob.arrayBuffer + btoa
 */
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * 建任务并启动流水线
 * @param {object} msg { videoId, cues:[{index,start,end,text}], tabId }
 */
async function handleStart(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return { ok: false, error: '无法定位标签页' };

  const options = await getOptions();
  if (!options.minimaxApiKey) {
    return { ok: false, error: '请先在设置页填写 MiniMax API Key' };
  }

  // 停止该标签页上的所有旧任务(含上一个视频的:SPA 切换后旧任务若不停止,
  // 会继续空烧 TTS 配额并推送旧视频音频)
  for (const [vid, t] of tasks) {
    if (t.tabId === tabId) {
      t.stopped = true;
      tasks.delete(vid);
    }
  }

  const task = {
    videoId: msg.videoId,
    tabId,
    cues: msg.cues,
    options,
    startIndex: typeof msg.startIndex === 'number' ? msg.startIndex : 0,
    stopped: false,
  };
  tasks.set(msg.videoId, task);
  console.log('[ytb-tts] 任务启动:', msg.videoId, '共', msg.cues.length, '句');

  // 流水线在后台推进,不阻塞响应
  runPipeline(task).catch((e) => {
    console.error('[ytb-tts] 流水线异常:', e);
    pushError(task, e);
  });

  return { ok: true };
}

function handleStop(msg) {
  const task = tasks.get(msg.videoId);
  if (task) {
    task.stopped = true;
    tasks.delete(msg.videoId);
  }
  return { ok: true };
}

/**
 * 主流水线(流式):
 * 处理顺序:从当前播放位置对应的句子(startIndex)开始向后,最后回填前面的
 * 句子(seek 回开头也能播)。每批先翻译再逐句合成并即时推送,页面侧边收边播。
 * 阶段 3:全部推送完后发 DUB_ALL_READY,仅作状态通知(不影响开播时机)
 */
async function runPipeline(task) {
  const { cues, videoId, options } = task;
  const startPos = Math.max(0, Math.min(task.startIndex, cues.length));
  const ordered = cues.slice(startPos).concat(cues.slice(0, startPos));

  let from = 0;
  while (from < ordered.length && !task.stopped) {
    const batchSize = from === 0 ? FIRST_BATCH : TRANSLATE_BATCH;
    const slice = ordered.slice(from, from + batchSize);
    from += batchSize;

    // 翻译本批(先查缓存)
    const needTranslate = [];
    for (const cue of slice) {
      const cached = await getTranslation(videoId, cue.index);
      if (cached) {
        cue.zh = cached;
      } else {
        needTranslate.push(cue);
      }
    }

    if (needTranslate.length > 0) {
      const batch = needTranslate.map((c) => c.text);
      const results = await Translate.translateBatch(batch, {
        baseUrl: options.translateBaseUrl,
        apiKey: options.translateApiKey,
        model: options.translateModel,
      });
      needTranslate.forEach((cue, i) => {
        cue.zh = results[i];
        setTranslation(videoId, cue.index, results[i]).catch(() => {});
      });
    }

    // 合成并即时推送本批
    await advanceSynthesis(task, slice);
  }

  // 阶段 3:通知全部就绪
  if (!task.stopped) {
    console.log('[ytb-tts] 全部句子已推送:', videoId, '共', cues.length, '句');
    chrome.tabs
      .sendMessage(task.tabId, { type: 'DUB_ALL_READY', videoId, total: cues.length })
      .catch(() => {});
  }
}

/** 合成 list 中已翻译且未发送的句子并推送(幂等) */
async function advanceSynthesis(task, list) {
  const { videoId, options, tabId } = task;

  for (const cue of list) {
    if (task.stopped) break;
    if (!cue.zh || cue.audioSent) continue;

    const aKey = audioKey(videoId, cue.index, options);
    let base64 = await getAudioBase64(aKey);

    if (!base64) {
      const blob = await ttsQueue.enqueue(cue.zh, {
        apiKey: options.minimaxApiKey,
        groupId: options.minimaxGroupId,
        voiceId: options.voiceId,
        speed: options.speed,
        model: options.ttsModel,
      });
      base64 = await blobToBase64(blob);
      setAudioBase64(aKey, base64).catch(() => {});
    }

    cue.audioSent = true;
    console.log('[ytb-tts] 推送音频:', videoId, 'index =', cue.index, base64 ? '' : '(空)');
    chrome.tabs
      .sendMessage(tabId, {
        type: 'DUB_CUE_READY',
        videoId,
        index: cue.index,
        start: cue.start,
        end: cue.end,
        base64,
      })
      .catch(() => {});
  }
}

function pushError(task, err) {
  chrome.tabs
    .sendMessage(task.tabId, {
      type: 'DUB_ERROR',
      videoId: task.videoId,
      message: (err && err.message) || String(err),
    })
    .catch(() => {});
}

/* ---------------- 消息路由 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'DUB_START':
        return await handleStart(msg, sender);
      case 'DUB_STOP':
        return handleStop(msg);
      default:
        return { ok: false, error: '未知消息类型' };
    }
  })().then(sendResponse);
  return true; // 异步响应
});

/**
 * Service Worker:翻译 + TTS 调度 + 缓存
 *
 * 职责:
 * 1. 接收 Content Script 的 DUB_START / DUB_STOP / DUB_POSITION 消息
 * 2. 维护每个视频的合成任务:翻译(分块)→ TTS(串行队列)→ 推送音频到 Content Script
 * 3. 两级缓存:内存 Map + chrome.storage.local(翻译文本持久化,音频带容量上限的 LRU)
 *
 * 注意:MV3 下 Service Worker 可能随时休眠,任务进度需在每次消息时重建;
 * 合成结果全部通过 chrome.tabs.sendMessage 即时推送,不依赖 SW 长期存活。
 */
importScripts('lib/translate.js', 'lib/minimax_tts.js');

'use strict';

const PREFETCH_AHEAD = 10;              // 预生成窗口:领先当前播放位置 10 句
const TRANSLATE_BATCH = 25;             // 每批翻译句数
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

/** Blob → base64 字符串 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // data:audio/mpeg;base64,xxx
      resolve(String(result).split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('Blob 转 Base64 失败'));
    reader.readAsDataURL(blob);
  });
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

  // 停止旧的同视频任务
  if (tasks.has(msg.videoId)) {
    tasks.get(msg.videoId).stopped = true;
    tasks.delete(msg.videoId);
  }

  const task = {
    videoId: msg.videoId,
    tabId,
    cues: msg.cues,
    options,
    stopped: false,
    translatedUpTo: 0,    // 已翻译到的 index(不含)
    targetIndex: Math.min(PREFETCH_AHEAD, msg.cues.length), // 预生成目标
    positionIndex: 0,     // Content Script 报告的最新播放位置
  };
  tasks.set(msg.videoId, task);

  // 流水线在后台推进,不阻塞响应
  runPipeline(task).catch((e) => {
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

/** 播放位置更新:推进预生成窗口 */
function handlePosition(msg) {
  const task = tasks.get(msg.videoId);
  if (task) {
    task.positionIndex = msg.index;
    task.targetIndex = Math.min(Math.max(msg.index + PREFETCH_AHEAD, 0), task.cues.length);
  }
  return { ok: true };
}

/** 主流水线:翻译 + 合成 + 推送 */
async function runPipeline(task) {
  const { cues, videoId } = task;

  while (!task.stopped) {
    const translateTarget = Math.min(task.targetIndex, cues.length);

    // 阶段 1:推进翻译(分块,先查缓存)
    while (!task.stopped && task.translatedUpTo < translateTarget) {
      const from = task.translatedUpTo;
      const to = Math.min(from + TRANSLATE_BATCH, translateTarget);
      const slice = cues.slice(from, to);

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
          baseUrl: task.options.translateBaseUrl,
          apiKey: task.options.translateApiKey,
          model: task.options.translateModel,
        });
        needTranslate.forEach((cue, i) => {
          cue.zh = results[i];
          setTranslation(videoId, cue.index, results[i]).catch(() => {});
        });
      }
      task.translatedUpTo = to;
    }

    // 阶段 2:合成 [0, translateTarget) 内已翻译未合成的句子
    await advanceSynthesis(task, translateTarget);

    if (task.translatedUpTo >= cues.length && cues.every((c) => c.audioSent)) break;
    await sleep(500);
  }
}

/** 合成 [0, limit) 内已翻译且未发送的句子(每次全量扫描,幂等) */
async function advanceSynthesis(task, limit) {
  const { cues, videoId, options, tabId } = task;
  limit = Math.min(limit, cues.length);

  for (let i = 0; i < limit && !task.stopped; i++) {
    const cue = cues[i];
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 消息路由 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'DUB_START':
        return await handleStart(msg, sender);
      case 'DUB_STOP':
        return handleStop(msg);
      case 'DUB_POSITION':
        return handlePosition(msg);
      default:
        return { ok: false, error: '未知消息类型' };
    }
  })().then(sendResponse);
  return true; // 异步响应
});

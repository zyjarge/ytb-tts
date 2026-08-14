/**
 * Service Worker:翻译 + TTS 调度 + 缓存
 *
 * 职责:
 * 1. 接收 Content Script 的 DUB_START / DUB_STOP 消息
 * 2. 流式管线:从当前播放位置开始,按批「翻译 → 合成 → 即时推送」,
 *    页面侧首批缓冲就绪即开播,无需整片合成完;
 *    合成为多句合并模式:连续 5 句一次 TTS 请求(带句级字幕时间戳),
 *    整段音频推 DUB_CHUNK_READY 由页面切分;失败回退逐句(DUB_CUE_READY);
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
const TTS_CHUNK_SIZE = 5;               // 每次 TTS 请求合并的句数(限流按请求次数,合并即提速)
const TTS_CHUNK_MAX_CHARS = 800;        // 单次合成字符上限(远低于 10000 硬限制)
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

/** 合并块缓存 key:以首尾句 index 标识一个块 */
function chunkKey(videoId, chunk, options) {
  return `chunk:${videoId}:${options.voiceId || 'default'}:${options.speed || 1}:` +
    `${chunk[0].index}-${chunk[chunk.length - 1].index}`;
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
    // 淘汰 audio:/chunk: 前缀中最旧的条目(按 key 字典序即按 index 序)
    const audioKeys = Object.keys(stored)
      .filter((k) => k.startsWith('audio:') || k.startsWith('chunk:'))
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

/**
 * 合成 list 中已翻译且未发送的句子并推送(幂等)。
 * 主路径:把连续待合成句子按块(默认 5 句)合并成一次 TTS 请求
 * (限流按请求次数、计费按字符,合并后吞吐成倍提升而成本不变),
 * 整段音频 + 句级时间戳一次推送给页面,由 Content Script 切分回逐句;
 * 合并合成失败时回退逐句合成(兼容旧行为)
 */
async function advanceSynthesis(task, list) {
  const { videoId, options } = task;

  let i = 0;
  while (i < list.length && !task.stopped) {
    const cue = list[i];
    if (cue.audioSent || !cue.zh) {
      i++;
      continue;
    }
    // 逐句缓存命中(旧版本缓存):直接推送
    const cached = await getAudioBase64(audioKey(videoId, cue.index, options));
    if (cached) {
      sendCueAudio(task, cue, cached);
      i++;
      continue;
    }
    // 收集连续待合成段(遇逐句缓存即断开)
    const group = [];
    let j = i;
    while (j < list.length) {
      const c = list[j];
      if (c.audioSent || !c.zh) break;
      if (await getAudioBase64(audioKey(videoId, c.index, options))) break;
      group.push(c);
      j++;
    }
    // 按块大小/字符数切成若干块依次合成
    let from = 0;
    while (from < group.length && !task.stopped) {
      const chunk = [];
      let chars = 0;
      while (from < group.length && chunk.length < TTS_CHUNK_SIZE) {
        const c = group[from];
        if (chunk.length > 0 && chars + c.zh.length > TTS_CHUNK_MAX_CHARS) break;
        chunk.push(c);
        chars += c.zh.length;
        from++;
      }
      if (chunk.length === 1) {
        await synthesizeSingle(task, chunk[0]);
      } else {
        const ok = await synthesizeChunkAndPush(task, chunk);
        if (!ok) {
          // 回退逐句合成(合并路径失败,如字幕服务异常/字幕域名无权限)
          for (const c of chunk) {
            if (task.stopped) break;
            await synthesizeSingle(task, c);
          }
        }
      }
    }
    i = j;
  }
}

/** 推送单句音频(逐句路径) */
function sendCueAudio(task, cue, base64) {
  cue.audioSent = true;
  console.log('[ytb-tts] 推送音频:', task.videoId, 'index =', cue.index);
  chrome.tabs
    .sendMessage(task.tabId, {
      type: 'DUB_CUE_READY',
      videoId: task.videoId,
      index: cue.index,
      start: cue.start,
      end: cue.end,
      base64,
    })
    .catch(() => {});
}

/** 逐句合成并推送(兼容路径/回退路径) */
async function synthesizeSingle(task, cue) {
  const { videoId, options } = task;
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
  sendCueAudio(task, cue, base64);
}

/**
 * 合并合成一组句子并整块推送。成功返回 true。
 * 块音频与切分结果按块缓存,重开页面/重播时直接命中
 */
async function synthesizeChunkAndPush(task, chunk) {
  const { videoId, options } = task;
  const cKey = chunkKey(videoId, chunk, options);

  // 块缓存命中:直接重放推送
  const cachedRaw = await getAudioBase64(cKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      pushChunk(task, chunk, cached.base64, cached.segments);
      return true;
    } catch (e) { /* 缓存损坏,继续重新合成 */ }
  }

  try {
    const text = chunk.map((c) => c.zh).join('\n'); // 官方约定:段落用换行符分隔
    const { blob, subtitles } = await ttsQueue.enqueueChunk(text, {
      apiKey: options.minimaxApiKey,
      groupId: options.minimaxGroupId,
      voiceId: options.voiceId,
      speed: options.speed,
      model: options.ttsModel,
    });
    const segments = alignSegments(chunk, subtitles);
    if (!segments) throw new Error('字幕与句子对齐失败');
    const base64 = await blobToBase64(blob);
    setAudioBase64(cKey, JSON.stringify({ base64, segments })).catch(() => {});
    pushChunk(task, chunk, base64, segments);
    return true;
  } catch (e) {
    console.warn('[ytb-tts] 合并合成失败,回退逐句:', (e && e.message) || e);
    return false;
  }
}

/** 推送合并块:整段音频 + 每句在音频内的时间区间(秒) */
function pushChunk(task, chunk, base64, segments) {
  chunk.forEach((c) => { c.audioSent = true; });
  console.log('[ytb-tts] 推送合并音频:', task.videoId,
    `index ${chunk[0].index}-${chunk[chunk.length - 1].index}`, `共 ${chunk.length} 句`);
  chrome.tabs
    .sendMessage(task.tabId, {
      type: 'DUB_CHUNK_READY',
      videoId: task.videoId,
      base64,
      segments,
    })
    .catch(() => {});
}

/**
 * 把 MiniMax 句级字幕时间戳对齐到我们的句子块。
 * 字幕分句与我们句子的边界可能不同(字幕每句 ≤50 字,且 MiniMax 会做文本规范化),
 * 因此按字符位置比例映射:整段文本第 N 个字符 → 落在字幕第几句 → 句内按比例插值时间
 * @returns {Array<{index, begin, end}>} 每句在整段音频内的时间区间(秒);无法对齐返回 null
 */
function alignSegments(chunk, subtitles) {
  if (!subtitles || !subtitles.length) return null;
  const norm = (s) => (s || '').replace(/\s+/g, '');

  const entries = [];
  let totalSub = 0;
  for (const s of subtitles) {
    const len = norm(s.text).length;
    if (typeof s.begin !== 'number' || typeof s.end !== 'number') return null;
    entries.push({ acc: totalSub, len: Math.max(1, len), begin: s.begin, end: s.end });
    totalSub += len;
  }
  if (!totalSub) return null;

  const timeAt = (pos) => {
    const p = Math.max(0, Math.min(pos, totalSub - 1e-6));
    for (const e of entries) {
      if (p < e.acc + e.len) {
        return e.begin + (e.end - e.begin) * ((p - e.acc) / e.len);
      }
    }
    return entries[entries.length - 1].end;
  };

  const cueLens = chunk.map((c) => norm(c.zh).length);
  const totalCue = cueLens.reduce((a, b) => a + b, 0);
  if (!totalCue) return null;
  const scale = totalSub / totalCue; // 文本规范化导致的长度差按比例吸收

  const segments = [];
  let acc = 0;
  for (let i = 0; i < chunk.length; i++) {
    const begin = timeAt(acc * scale);
    acc += cueLens[i];
    const end = timeAt(acc * scale);
    if (end - begin < 0.05) return null; // 区间异常,判定对齐失败
    segments.push({ index: chunk[i].index, begin, end });
  }
  return segments;
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

/**
 * MiniMax TTS 封装
 *
 * 关键点(依据 2026-08 官方文档核对结果):
 * 1. 接口 POST https://api.minimaxi.chat/v1/t2a_v2(备用域名 api.minimaxi.com / api-bj.minimaxi.com)
 *    认证:Header Authorization: Bearer {api_key}
 *    GroupId 为旧版参数,当前文档仅用 Bearer Token;为兼容旧账号,填了 GroupId 才追加到查询串
 * 2. 返回 JSON 中 data.audio 是 HEX 编码字符串(不是 Base64),需解码为二进制后构造 mp3 Blob
 * 3. 限流:免费用户 10 次/分钟,充值用户 20 次/分钟(status_code 1002/1039)。
 *    队列初始按 20 RPM 乐观调度,触发限流后自动加倍退避(上限 12 秒/次)。
 *    注意限流按【请求次数】而计费按字符:多句合并成一次请求(subtitle_enable 开句级
 *    字幕,返回 subtitle_file URL,句级毫秒时间戳)即可成倍提升吞吐而成本不变
 * 4. 模型:当前推荐 speech-2.8-turbo(极速);旧版 speech-02-turbo 仍可用
 */
(function () {
  'use strict';

  // 域名顺序:实测 2026-08 起 api.minimaxi.chat 对新版 key 返回 2049 invalid,
  // 新 key 只认 api.minimaxi.com / api-bj.minimaxi.com,故 .com 优先
  const ENDPOINTS = [
    'https://api.minimaxi.com/v1/t2a_v2',
    'https://api-bj.minimaxi.com/v1/t2a_v2',
    'https://api.minimaxi.chat/v1/t2a_v2',
  ];
  const DEFAULT_MODEL = 'speech-2.8-turbo';
  const DEFAULT_VOICE = 'male-qn-qingse';
  const BASE_INTERVAL_MS = 3000;      // 20 RPM(充值用户),乐观初始值
  const MAX_INTERVAL_MS = 12000;      // 限流退避上限
  const MAX_RETRIES = 3;

  /** HEX 字符串 → Uint8Array */
  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length === 0) {
      throw new Error('TTS 返回的音频数据为空');
    }
    const even = hex.length % 2 === 0 ? hex : '0' + hex;
    const bytes = new Uint8Array(even.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(even.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  /**
   * 合成单句中文语音
   * @param {string} text 要合成的中文句子
   * @param {object} options { apiKey, groupId, voiceId, speed, model }
   * @returns {Promise<Blob>} mp3 音频 Blob
   */
  async function synthesize(text, { apiKey, groupId, voiceId, speed, model }) {
    if (!apiKey) throw new Error('MiniMax API Key 未配置,请在设置页填写');

    // 主域名失败时自动尝试备用域名
    let lastError = null;
    for (const endpoint of ENDPOINTS) {
      let url = endpoint;
      if (groupId) {
        url += `?GroupId=${encodeURIComponent(groupId)}`;
      }
      const body = {
        model: model || DEFAULT_MODEL,
        text,
        stream: false,
        voice_setting: {
          voice_id: voiceId || DEFAULT_VOICE,
          speed: typeof speed === 'number' ? speed : 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          format: 'mp3',
          sample_rate: 32000,
          bitrate: 128000,
        },
      };

      try {
        const json = await _requestOnce(url, body, apiKey);
        return audioBlobOf(json);
      } catch (e) {
        lastError = e;
        // 限流/鉴权类错误在备用域名上重试无意义,直接抛
        if (e.isRateLimit || e.isAuthError) throw e;
      }
    }
    throw lastError || new Error('TTS 请求失败');
  }

  /** 解析句级字幕 JSON(官方格式:[{text, time_begin, time_end}],毫秒),输出秒 */
  function parseSubtitles(data) {
    const arr = Array.isArray(data)
      ? data
      : (data && (data.subtitles || data.list || data.data)) || [];
    const out = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const text = item.text || item.sentence || item.content || '';
      const beginMs = typeof item.time_begin === 'number' ? item.time_begin : item.begin_time;
      const endMs = typeof item.time_end === 'number' ? item.time_end : item.end_time;
      if (typeof beginMs !== 'number' || typeof endMs !== 'number' || endMs <= beginMs) continue;
      out.push({ text, begin: beginMs / 1000, end: endMs / 1000 });
    }
    return out;
  }

  /** 拉取 subtitle_file 字幕 URL 并解析为 [{text, begin, end}](秒) */
  async function fetchSubtitles(url) {
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new Error(`字幕文件请求失败:${e.message}(域名可能未在 host_permissions 中: ${url.slice(0, 80)})`);
    }
    if (!resp.ok) throw new Error(`字幕文件下载失败(HTTP ${resp.status})`);
    const subtitles = parseSubtitles(await resp.json());
    if (!subtitles.length) throw new Error('字幕文件为空或格式无法识别');
    return subtitles;
  }

  /**
   * 合并合成:多句文本(换行分隔)一次请求,开启句级字幕。
   * 限流按请求次数计费按字符,合并后吞吐成倍提升而成本不变。
   * @returns {Promise<{blob: Blob, subtitles: Array<{text, begin, end}>}>}
   *   blob 为整段 mp3;subtitles 为句级时间戳(秒),供调用方切分回逐句
   */
  async function synthesizeChunk(text, { apiKey, groupId, voiceId, speed, model }) {
    if (!apiKey) throw new Error('MiniMax API Key 未配置,请在设置页填写');

    let lastError = null;
    for (const endpoint of ENDPOINTS) {
      let url = endpoint;
      if (groupId) {
        url += `?GroupId=${encodeURIComponent(groupId)}`;
      }
      const body = {
        model: model || DEFAULT_MODEL,
        text,
        stream: false,
        voice_setting: {
          voice_id: voiceId || DEFAULT_VOICE,
          speed: typeof speed === 'number' ? speed : 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          format: 'mp3',
          sample_rate: 32000,
          bitrate: 128000,
        },
        subtitle_enable: true,
        subtitle_type: 'sentence',
      };

      try {
        const json = await _requestOnce(url, body, apiKey);
        const subUrl = json.data && json.data.subtitle_file;
        if (!subUrl) throw new Error('TTS 响应缺少 subtitle_file(无法切分合并音频)');
        const subtitles = await fetchSubtitles(subUrl);
        return { blob: audioBlobOf(json), subtitles };
      } catch (e) {
        lastError = e;
        if (e.isRateLimit || e.isAuthError) throw e;
      }
    }
    throw lastError || new Error('TTS 合并合成失败');
  }

  /** 单次 HTTP 请求,解析响应并校验错误码;返回完整响应 JSON */
  async function _requestOnce(url, body, apiKey) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`TTS 请求失败:${e.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      const err = new Error(`TTS 鉴权失败(HTTP ${response.status}),请检查 API Key`);
      err.isAuthError = true;
      throw err;
    }

    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error(`TTS 响应解析失败:${e.message}`);
    }

    const code = json.base_resp && json.base_resp.status_code;
    if (code !== undefined && code !== 0) {
      const msg = (json.base_resp && json.base_resp.status_msg) || String(code);
      const err = new Error(`TTS 失败:${msg}(${code})`);
      if (code === 1002 || code === 1039 || response.status === 429) {
        err.isRateLimit = true; // 触发限流,队列应加大间隔
      }
      throw err;
    }

    return json;
  }

  /** 从响应 JSON 中取音频并构造 mp3 Blob */
  function audioBlobOf(json) {
    const hex = json.data && json.data.audio;
    if (!hex) throw new Error('TTS 响应中缺少 data.audio');
    return new Blob([hexToBytes(hex)], { type: 'audio/mpeg' });
  }

  /**
   * 带重试的单次合成(指数退避)
   * @returns {Promise<Blob>}
   */
  async function synthesizeWithRetry(text, options) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s / 2s / 4s
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await synthesize(text, options);
      } catch (e) {
        lastError = e;
        // 限流错误直接重试(重试本身已带退避)
        if (!e.isRateLimit) throw e;
      }
    }
    throw lastError || new Error('TTS 合成失败');
  }

  /** 带重试的合并合成(语义同 synthesizeWithRetry) */
  async function synthesizeChunkWithRetry(text, options) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await synthesizeChunk(text, options);
      } catch (e) {
        lastError = e;
        if (!e.isRateLimit) throw e;
      }
    }
    throw lastError || new Error('TTS 合并合成失败');
  }

  /**
   * 串行 TTS 请求队列
   * - 保证两次请求最小间隔(初始 20 RPM 乐观调度)
   * - 触发限流(1002/1039/429)时自动加倍间隔,上限 12 秒(收敛到免费用户的 10 RPM 水平)
   */
  class TtsQueue {
    constructor() {
      this._chain = Promise.resolve();
      this._lastStart = 0;
      this._interval = BASE_INTERVAL_MS;
    }

    /** 公用调度:限间隔串行执行,限流自动退避 */
    _schedule(fn) {
      const run = async () => {
        const wait = this._lastStart + this._interval - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this._lastStart = Date.now();
        try {
          return await fn();
        } catch (e) {
          if (e.isRateLimit) {
            this._interval = Math.min(this._interval * 2, MAX_INTERVAL_MS);
          }
          throw e;
        }
      };
      const result = this._chain.then(run, run);
      this._chain = result.catch(() => {});
      return result;
    }

    /** 入队单句合成 @returns {Promise<Blob>} */
    enqueue(text, options) {
      return this._schedule(() => synthesizeWithRetry(text, options));
    }

    /** 入队合并合成 @returns {Promise<{blob, subtitles}>} */
    enqueueChunk(text, options) {
      return this._schedule(() => synthesizeChunkWithRetry(text, options));
    }
  }

  globalThis.MiniMaxTTS = { synthesize, synthesizeWithRetry, synthesizeChunk, synthesizeChunkWithRetry, TtsQueue, DEFAULT_MODEL, DEFAULT_VOICE };
})();

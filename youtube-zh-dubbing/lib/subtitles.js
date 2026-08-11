/**
 * 字幕轨道解析工具
 *
 * 功能:
 * 1. 解析 YouTube timedtext 接口返回的 JSON3 格式字幕 → 句子序列 [{index, start, end, text}]
 * 2. 合并过碎的片段,减少 TTS 调用次数
 * 3. 从 ytInitialPlayerResponse 中提取字幕轨道列表并挑选合适的英文轨道
 *
 * 时间单位统一为「秒」(小数)。
 */
(function () {
  'use strict';

  /** HTML 实体与空白清理 */
  function cleanText(raw) {
    if (!raw) return '';
    return raw
      .replace(/\\n/g, ' ')           // 字面 \n → 空格
      .replace(/\\"/g, '"')           // 转义引号
      .replace(/\\\\/g, '\\')         // 转义反斜杠
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/[\u00a0\u200b]/g, ' ') // 不间断空格 / 零宽空格 → 普通空格
      .replace(/\s+/g, ' ')           // 连续空白 → 单个空格
      .trim();
  }

  /**
   * 解析 timedtext JSON3 → [{index, start, end, text}]
   * @param {object} json 接口返回的 JSON(含 events 数组)
   */
  function parseTimedText(json) {
    const cues = [];
    const events = json && json.events;
    if (!Array.isArray(events)) {
      throw new Error('字幕数据格式不正确(缺少 events)');
    }

    for (const ev of events) {
      if (typeof ev.tStartMs !== 'number') continue;
      if (!Array.isArray(ev.segs) || ev.segs.length === 0) continue;

      // 拼接该事件内所有文本段(兼容卡拉OK式分段)
      let text = '';
      for (const seg of ev.segs) {
        text += seg.utf8 || '';
      }
      text = cleanText(text);
      if (!text) continue;

      const start = ev.tStartMs / 1000;
      const dur = (typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0) / 1000;
      cues.push({ start, end: start + dur, text });
    }
    return cues;
  }

  /**
   * 合并过碎的片段
   * 规则:相邻两条间隔 < maxGap 秒,且合并后总字符数 <= maxChars 时合并
   * @param {Array} cues [{start, end, text}]
   */
  function mergeCues(cues, { maxGap = 0.3, maxChars = 12 } = {}) {
    const result = [];
    for (const cue of cues) {
      const last = result[result.length - 1];
      if (last && cue.start - last.end < maxGap) {
        const merged = last.text + cue.text;
        if (merged.length <= maxChars) {
          last.text = merged;
          last.end = cue.end;
          continue;
        }
      }
      result.push({ start: cue.start, end: cue.end, text: cue.text });
    }
    return result;
  }

  /** 按顺序补上 index 字段 */
  function assignIndexes(cues) {
    return cues.map((cue, index) => ({ index, start: cue.start, end: cue.end, text: cue.text }));
  }

  /**
   * 从 ytInitialPlayerResponse 提取字幕轨道列表
   * @returns {Array} [{baseUrl, languageCode, kind, name}]
   */
  function extractCaptionTracks(playerResponse) {
    const list =
      playerResponse &&
      playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer &&
      playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    return Array.isArray(list) ? list : [];
  }

  /**
   * 选择适合配音的英文轨道
   * 优先级:英文人工字幕 → 英文自动生成(asr);无英文字幕返回 null
   * @param {Array} tracks extractCaptionTracks 的结果
   * @returns {object|null} 选中的轨道,或 null(无可用英文字幕)
   */
  function selectTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;
    const isEn = (t) => t && (t.languageCode === 'en' || (t.languageCode || '').startsWith('en-'));
    const enTracks = tracks.filter(isEn);
    if (enTracks.length === 0) return null;
    const manual = enTracks.find((t) => t.kind !== 'asr');
    return manual || enTracks[0] || null;
  }

  /**
   * 构造 timedtext 抓取 URL:强制 JSON3 格式并明确语言
   * @param {object} track extractCaptionTracks 中的一项
   */
  function buildTimedTextUrl(track) {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    url.searchParams.set('lang', track.languageCode || 'en');
    return url.toString();
  }

  globalThis.Subtitles = {
    parseTimedText,
    mergeCues,
    assignIndexes,
    extractCaptionTracks,
    selectTrack,
    buildTimedTextUrl,
  };
})();

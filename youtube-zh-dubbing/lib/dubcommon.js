/**
 * 站点无关的配音公共工具(YouTube content.js 与 B 站 bilibili.js 共用)
 *
 * 内容:base64 解码、合并块音频切分(AudioContext + PCM16 WAV 编码)、
 * 安全消息发送、扩展上下文自检。
 * 通过 globalThis.DubCommon 暴露,需在站点脚本之前加载。
 */
(function () {
  'use strict';

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** AudioBuffer 的 [startFrame, endFrame) 区间编码为 PCM16 WAV Blob */
  function encodeWav(audioBuffer, startFrame, endFrame) {
    const numCh = audioBuffer.numberOfChannels;
    const sr = audioBuffer.sampleRate;
    const frames = endFrame - startFrame;
    const dataSize = frames * numCh * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);             // fmt 块大小
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * 2, true); // 字节率
    view.setUint16(32, numCh * 2, true);      // 块对齐
    view.setUint16(34, 16, true);             // 位深
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));
    let off = 44;
    for (let f = startFrame; f < endFrame; f++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][f]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /**
   * 创建合并块处理器:解码整段 mp3,按句级时间区间切成逐句 WAV 入缓存。
   * 在页面上下文做切分是因为 Service Worker 没有可用的音频解码 API。
   * @param {object} hooks
   * @param {Function} hooks.getCache  返回当前 cueAudioCache(Map,可能被重建,故用 getter)
   * @param {Function} [hooks.onProgress] 切分完成回调(驱动首批缓冲进度)
   */
  function createChunkHandler(hooks) {
    let audioCtx = null; // 解码复用的 AudioContext(decodeAudioData 不要求 running 状态)
    return async function handleChunk(msg) {
      const cache = hooks.getCache();
      const bytes = base64ToBytes(msg.base64);
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
      }
      // decodeAudioData 会 detach 输入 buffer,必须传副本
      const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
      const sr = audioBuffer.sampleRate;
      let added = 0;
      for (const seg of msg.segments || []) {
        if (cache.has(seg.index)) continue;
        const startFrame = Math.max(0, Math.floor(seg.begin * sr));
        const endFrame = Math.min(audioBuffer.length, Math.ceil(seg.end * sr));
        if (endFrame - startFrame < sr * 0.05) continue; // 不足 50ms 视为空句
        const wav = encodeWav(audioBuffer, startFrame, endFrame);
        const url = URL.createObjectURL(wav);
        cache.set(seg.index, { url, duration: (endFrame - startFrame) / sr });
        added++;
      }
      console.log('[ytb-tts] 合并音频切分完成:新增', added, '句 (已缓存', cache.size, '句)');
      if (hooks.onProgress) hooks.onProgress();
    };
  }

  /**
   * 安全发送消息到 Background。
   * 扩展被重新加载后,旧 Content Script 上下文失效,chrome.runtime.sendMessage
   * 会【同步抛出】Error: Extension context invalidated(此时 .catch 接不住),
   * 必须 try/catch 包裹,静默忽略,避免页面控制台刷 Uncaught 错误。
   */
  function safeSendMessage(msg) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
    } catch (e) {
      return Promise.resolve();
    }
  }

  /** 扩展上下文是否仍然有效(用于残留脚本自检) */
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  globalThis.DubCommon = {
    base64ToBytes,
    encodeWav,
    createChunkHandler,
    safeSendMessage,
    isContextValid,
  };
})();

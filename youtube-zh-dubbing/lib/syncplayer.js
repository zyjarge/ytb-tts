/**
 * 时间戳对齐播放引擎
 *
 * 职责:轮询 video.currentTime,按字幕时间戳依次播放对应的中文语音 Audio,
 * 并正确处理 pause / seek / playbackRate / 广告暂停等场景。
 *
 * 用法:
 *   const player = new SyncPlayer({ cues, getAudio, speed });
 *   player.attach(videoElement);
 *   player.start();          // 开始配音
 *   player.pauseSchedule();  // 广告等场景暂停调度
 *   player.resumeSchedule();
 *   player.stop();           // 停止配音,恢复原声
 */
(function () {
  'use strict';

  const TICK_MS = 100;          // 轮询间隔
  const MAX_LAG_SKIP = 1.0;     // 进入句子区间超过该秒数则跳过该句(避免追半句话)
  const OVERFLOW_LIMIT = 1.5;   // 音频时长超过时间窗该倍数时触发加速
  const MAX_SPEEDUP = 2.0;      // 溢出时音频最高加速倍数

  class SyncPlayer {
    /**
     * @param {object} options
     * @param {Array}  options.cues     [{index, start, end, text}] 按 start 升序
     * @param {Function} options.getAudio  (index) => {url, duration} | null(同步返回)
     * @param {number} options.speed    默认语速(设置项),用于 TTS 与播放微调
     */
    constructor({ cues, getAudio, speed }) {
      this.cues = cues || [];
      this.getAudio = getAudio || (() => null);
      this.speed = typeof speed === 'number' ? speed : 1.0;

      this.video = null;
      this.audio = null;              // 当前播放的 Audio 元素
      this.currentIndex = -1;         // 当前应播句子的 index
      this.lastLookup = 0;            // 二分/游标查找的起始位置
      this.timer = null;
      this.retryTimer = null;
      this.running = false;           // start/stop
      this.schedulePaused = false;    // 广告暂停
      this._handlers = {};
    }

    attach(video) {
      this.video = video;
      const on = (event, fn) => {
        this._handlers[event] = fn;
        video.addEventListener(event, fn);
      };
      on('seeked', () => this._onSeeked());
      on('ratechange', () => this._onRateChange());
      on('pause', () => this._onPause());
      on('playing', () => this._onPlaying());
    }

    start() {
      if (!this.video || this.running) return;
      this.running = true;
      this.schedulePaused = false;
      this._tick();
    }

    stop() {
      this.running = false;
      clearTimeout(this.timer);
      clearTimeout(this.retryTimer);
      this.timer = null;
      this._stopAudio();
      if (this.video && this._handlers) {
        for (const [event, fn] of Object.entries(this._handlers)) {
          this.video.removeEventListener(event, fn);
        }
      }
      this._handlers = {};
    }

    /** 更新语速设置(设置页修改后调用) */
    setSpeed(speed) {
      this.speed = typeof speed === 'number' ? speed : 1.0;
      this._applyPlaybackRate();
    }

    /** 广告等场景:暂停配音调度,但不停止已播音频(立即静音) */
    pauseSchedule() {
      this.schedulePaused = true;
      this._stopAudio();
    }

    resumeSchedule() {
      if (!this.schedulePaused) return;
      this.schedulePaused = false;
      this.currentIndex = -1; // 强制下一 tick 重新对齐
      if (this.running && this.video && !this.video.paused) {
        this._tick();
      }
    }

    /* ---------------- 内部实现 ---------------- */

    _tick() {
      if (!this.running || this.schedulePaused) return;
      const video = this.video;
      if (!video || video.paused || video.ended) {
        this._stopAudio();
        this.timer = setTimeout(() => this._tick(), TICK_MS);
        return;
      }
      // 广告检测兜底(Content Script 层已有 MutationObserver,此处防御)
      if (video.closest && video.closest('#movie_player') &&
          video.closest('#movie_player').classList.contains('ad-showing')) {
        this._stopAudio();
        this.timer = setTimeout(() => this._tick(), TICK_MS);
        return;
      }

      const t = video.currentTime;
      const idx = this._findCue(t);
      if (idx !== this.currentIndex) {
        this.currentIndex = idx;
        if (idx >= 0) {
          this._switchTo(idx, t);
        } else {
          this._stopAudio();
        }
      }
      this.timer = setTimeout(() => this._tick(), TICK_MS);
    }

    /** 查找 t 所在的句子 index;无匹配返回 -1 */
    _findCue(t) {
      const cues = this.cues;
      if (!cues.length) return -1;

      // 游标优化:时间通常前进,从上次位置向后扫
      let idx = Math.max(0, Math.min(this.lastLookup, cues.length - 1));
      while (idx < cues.length && t >= cues[idx].end) idx++;
      if (idx < cues.length && t >= cues[idx].start && t < cues[idx].end) {
        this.lastLookup = idx;
        return idx;
      }
      // seek 回退:向前找
      while (idx > 0 && t < cues[idx].start) idx--;
      if (idx >= 0 && t >= cues[idx].start && t < cues[idx].end) {
        this.lastLookup = idx;
        return idx;
      }
      this.lastLookup = idx;
      return -1;
    }

    /** 切换到播放句子 idx */
    async _switchTo(idx, t) {
      const cue = this.cues[idx];
      if (!cue) return;

      // 已进入区间过久,追不上半句话,直接跳过
      if (t - cue.start > MAX_LAG_SKIP) return;

      this._stopAudio();

      let audio;
      try {
        audio = this.getAudio(idx);
      } catch (e) {
        audio = null;
      }

      if (!audio) {
        // 该句尚未合成完成:稍后重试(仍在区间内才生效)
        this._scheduleRetry(idx);
        return;
      }

      const el = new Audio();
      el.preload = 'auto';
      el.src = audio.url;
      el.playbackRate = this._calcPlaybackRate(audio.duration, cue);
      this.audio = el;
      try {
        await el.play();
      } catch (e) {
        // 播放被用户手势策略阻断等场景:静默等待下一句
        this.audio = null;
      }
    }

    _scheduleRetry(idx) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (!this.running || this.schedulePaused || !this.video) return;
        const cue = this.cues[idx];
        if (!cue) return;
        const t = this.video.currentTime;
        // 仍在区间内且未暂停
        if (t >= cue.start && t < cue.end && !this.video.paused) {
          this.currentIndex = -1; // 允许再次切换
          this._switchTo(idx, t);
        }
      }, 400);
    }

    /** 计算音频播放速率:视频倍速 × 溢出加速 */
    _calcPlaybackRate(audioDuration, cue) {
      const videoRate = this.video ? this.video.playbackRate : 1;
      const window = cue.end - cue.start;
      let overflow = 1;
      if (audioDuration && window > 0 && audioDuration > window * OVERFLOW_LIMIT) {
        overflow = Math.min(audioDuration / window, MAX_SPEEDUP);
      }
      return Math.min(videoRate * overflow, 4);
    }

    _applyPlaybackRate() {
      if (this.audio && this.video) {
        const cue = this.cues[this.currentIndex];
        if (cue) {
          this.audio.playbackRate = this._calcPlaybackRate(this.audio.duration || 0, cue);
        }
      }
    }

    _stopAudio() {
      if (this.audio) {
        this.audio.pause();
        this.audio.src = '';
        this.audio = null;
      }
    }

    /* ---------------- 视频事件 ---------------- */

    _onSeeked() {
      this.lastLookup = 0;
      this._stopAudio();
      this.currentIndex = -1;
      // 立即对齐一次
      if (this.running && !this.schedulePaused && !this.video.paused) {
        const t = this.video.currentTime;
        const idx = this._findCue(t);
        this.currentIndex = idx;
        if (idx >= 0) this._switchTo(idx, t);
      }
    }

    _onRateChange() {
      this._applyPlaybackRate();
    }

    _onPause() {
      this._stopAudio();
    }

    _onPlaying() {
      // 恢复时重新对齐(上一句可能已过期)
      this.currentIndex = -1;
    }
  }

  globalThis.SyncPlayer = SyncPlayer;
})();

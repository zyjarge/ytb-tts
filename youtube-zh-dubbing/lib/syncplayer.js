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
 *
 * 缓冲机制:当前句音频未就绪时自动暂停视频等待(TTS 限流下合成慢于语速,
 * 不缓冲会永远追不上导致全程无声),就绪后自动续播;缓冲期间用户手动播放
 * 则尊重用户,该句跳过缓冲。
 *
 * 音画同步(借鉴商业插件 YouTube Dubbing 的实测机制):
 * 1. 双向调速:音频比字幕窗口长时,不硬截断也不只加速音频,而是
 *    视频减速(钳制 [0.75,1.25])与音频加速(钳制 [0.9,1.5])各承担一半误差,
 *    两者在窗口中点"会师",人耳几乎无感
 * 2. +0.001 速率指纹:插件设置的 playbackRate 永远 +0.001(如 1.001),
 *    据此区分"用户手动调速"(整洁值:1 / 1.25 / 2 ...)与"插件调速",
 *    用户调速时立即采纳为新基准,不与用户拉锯
 * 3. 尾部对齐:进入句子区间超过 1 秒才起播时,牺牲句首、对齐句尾
 *    (从 audioDuration - 剩余窗口 处起播),保证下一句仍能准时进场
 */
(function () {
  'use strict';

  const TICK_MS = 100;            // 轮询间隔
  const MAX_LAG_SKIP = 1.0;       // 进入句子区间超过该秒数触发尾部对齐
  const MIN_TAIL_SECONDS = 0.3;   // 尾部对齐后剩余音频不足该秒数则跳过该句
  const VIDEO_RATE_MIN = 0.75;    // 视频调速钳制(相对用户倍速的系数)
  const VIDEO_RATE_MAX = 1.25;
  const AUDIO_RATE_MIN = 0.9;     // 音频调速钳制(相对用户倍速的系数)
  const AUDIO_RATE_MAX = 1.5;
  const RATE_FINGERPRINT = 0.001; // 插件调速指纹:+0.001 区分用户手动调速

  class SyncPlayer {
    /**
     * @param {object} options
     * @param {Array}  options.cues     [{index, start, end, text}] 按 start 升序
     * @param {Function} options.getAudio  (index) => {url, duration} | null(同步返回)
     * @param {number} options.speed    默认语速(设置项),用于 TTS 与播放微调
     * @param {Function} [options.onBuffering] (buffering:boolean) => void 缓冲状态回调
     */
    constructor({ cues, getAudio, speed, onBuffering }) {
      this.cues = cues || [];
      this.getAudio = getAudio || (() => null);
      this.speed = typeof speed === 'number' ? speed : 1.0;
      this.onBuffering = typeof onBuffering === 'function' ? onBuffering : null;

      this.video = null;
      this.audio = null;              // 当前播放的 Audio 元素
      this._audioIndex = -1;          // this.audio 所属的句子 index(幂等判断用)
      this.currentIndex = -1;         // 当前应播句子的 index
      this.lastLookup = 0;            // 二分/游标查找的起始位置
      this.timer = null;
      this.retryTimer = null;
      this.running = false;           // start/stop
      this.schedulePaused = false;    // 广告暂停
      this.buffering = false;         // 缓冲中(音频未就绪,视频被我们暂停)
      this._pausedByUs = false;       // 视频暂停是否由缓冲逻辑发起
      this._noBuffer = false;         // 用户在缓冲中手动继续:本句不再强制缓冲
      this._suppressRealign = false;  // 缓冲恢复播放时抑制 playing 事件的重对齐(防音频重播)
      this.originRate = 1;            // 用户倍速基准(插件调速在此基础上叠加)
      this._appliedVideoRate = 0;     // 插件最近一次设置的视频速率(指纹值,回声识别用)
      this._curVFactor = 1;           // 当前句的视频调速系数
      this._curAFactor = 1;           // 当前句的音频调速系数
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
      this.originRate = this.video.playbackRate || 1; // 采纳用户当前倍速为基准
      this._tick();
    }

    stop() {
      this.running = false;
      clearTimeout(this.timer);
      clearTimeout(this.retryTimer);
      this.timer = null;
      this._stopAudio();
      // 恢复用户原始倍速(不带指纹,保持整洁值)
      if (this.video && this._appliedVideoRate) {
        try { this.video.playbackRate = this.originRate; } catch (e) { /* 忽略 */ }
        this._appliedVideoRate = 0;
      }
      // 若视频是被缓冲逻辑暂停的,停止配音时恢复播放,避免画面卡住
      if (this._pausedByUs && this.video && this.video.paused) {
        this.video.play().catch(() => {});
      }
      this._pausedByUs = false;
      this.buffering = false;
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
      // 强制下一 tick 重新对齐;但缓冲暂停中(视频是我们暂停的)不能重置,
      // 否则 tick 的缓冲轮询失去目标句,引擎卡死
      if (!this.video || !this.video.paused) {
        this.currentIndex = -1;
      }
    }

    /* ---------------- 内部实现 ---------------- */

    /**
     * 主循环。设计原则:tick 链一旦 start 就永不中断(只有 stop() 能停),
     * 任何暂停/广告/异常都只是"本轮不干活",定时器照常续上,
     * 避免引擎因边界情况静默死亡(表现为只播一两句后永远无声)。
     */
    _tick() {
      if (!this.running) return;
      try {
        const video = this.video;
        const inAd = this.schedulePaused ||
          !!(video && video.closest && video.closest('#movie_player') &&
             video.closest('#movie_player').classList.contains('ad-showing'));

        if (!video || video.ended || inAd) {
          this._stopAudio();
        } else if (video.paused) {
          // 缓冲暂停中:轮询当前句音频是否就绪,就绪即切换并恢复播放
          // (重试定时器是一次性的,可能被广告窗口等打断,此处兜底)
          if (this.buffering && this._pausedByUs && this.currentIndex >= 0) {
            const cue = this.cues[this.currentIndex];
            let audio = null;
            if (cue) {
              try { audio = this.getAudio(this.currentIndex); } catch (e) { audio = null; }
            }
            if (audio) this._switchTo(this.currentIndex, video.currentTime);
          } else {
            this._stopAudio();
          }
        } else {
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
        }
      } catch (e) {
        // 任何异常都不能杀死 tick 链
        console.error('[ytb-tts] 播放引擎异常(已自动恢复):', e);
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
      // seek 回退:向前找(注意 idx 可能越界到 cues.length,需先收回界内)
      if (idx >= cues.length) idx = cues.length - 1;
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
      // 同一句已在起播/播放中,直接返回(重试定时器与缓冲轮询可能并发触发,防双播)
      if (this._audioIndex === idx && this.audio) return;
      this.currentIndex = idx; // 幂等标记,避免 tick 重复触发同一句

      this._stopAudio();

      let audio;
      try {
        audio = this.getAudio(idx);
      } catch (e) {
        audio = null;
      }

      if (!audio) {
        // 该句尚未合成完成:暂停视频缓冲等待(TTS 限流下合成必然慢于语速,
        // 不缓冲就会永远追不上而全程无声);用户手动继续过的句子不再强制缓冲
        if (!this._noBuffer) this._enterBuffering();
        this._scheduleRetry(idx);
        return;
      }

      this._noBuffer = false;
      this._exitBuffering();

      // 剩余时间窗(下限 0.1s 防除零)
      const h = Math.max(cue.end - t, 0.1);
      const d = audio.duration || 0;

      // 双向调速:音频比窗口长时,差值对半分摊 —— 视频减速、音频加速,
      // 两者在窗口中点会师;各自钳制在人耳不易察觉的范围内
      let vFactor = 1;
      let aFactor = 1;
      if (d > h) {
        const diff = d - h;
        vFactor = Math.min(Math.max(h / (h + diff / 2), VIDEO_RATE_MIN), VIDEO_RATE_MAX);
        aFactor = Math.min(Math.max(d / (d - diff / 2), AUDIO_RATE_MIN), AUDIO_RATE_MAX);
      }
      this._curVFactor = vFactor;
      this._curAFactor = aFactor;
      this._setVideoRate(this.originRate * vFactor);
      const audioRate = Math.min(this.originRate * aFactor, 4);

      // 尾部对齐:已进入区间较久才起播时,牺牲句首、对齐句尾
      // (从「音频末尾 - 剩余窗口」处起播),保证下一句仍能准时进场
      let offset = 0;
      if (t - cue.start > MAX_LAG_SKIP) {
        if (d > 0) {
          offset = Math.min(Math.max(d - h * audioRate, 0), d);
          if (d - offset < MIN_TAIL_SECONDS) {
            console.debug('[ytb-tts] 音频剩余过短,跳过句子:', idx);
            this._restoreVideoRate();
            return;
          }
        } else {
          // 时长未知且已严重迟到,无法计算对齐点,维持跳过策略
          console.debug('[ytb-tts] 音频迟到,跳过句子:', idx);
          this._exitBuffering();
          return;
        }
      }

      const el = new Audio();
      el.preload = 'auto';
      el.src = audio.url;
      el.playbackRate = audioRate;
      if (offset > 0) {
        el.addEventListener('loadedmetadata', () => {
          try { el.currentTime = Math.min(offset, el.duration || offset); } catch (e) { /* 忽略 */ }
        }, { once: true });
      }
      // 音频自然播完(早于窗口结束)时,立刻把视频速率恢复到用户基准
      el.addEventListener('ended', () => this._restoreVideoRate(), { once: true });
      this.audio = el;
      this._audioIndex = idx;
      try {
        await el.play();
        console.debug('[ytb-tts] 播放句子:', idx);
      } catch (e) {
        // 播放被用户手势策略阻断等场景:静默等待下一句
        console.warn('[ytb-tts] 音频播放被阻止:', idx, e && e.message);
        this.audio = null;
        this._audioIndex = -1;
        this._restoreVideoRate();
      }
    }

    /** 进入缓冲:暂停视频,等待当前句音频就绪 */
    _enterBuffering() {
      if (this.buffering) return;
      this.buffering = true;
      if (this.video && !this.video.paused) {
        this._pausedByUs = true;
        this.video.pause();
      }
      if (this.onBuffering) {
        try { this.onBuffering(true); } catch (e) { /* 忽略 */ }
      }
      console.debug('[ytb-tts] 缓冲中:等待语音合成');
    }

    /** 退出缓冲:恢复视频播放(仅当暂停是我们发起的) */
    _exitBuffering() {
      if (!this.buffering) return;
      this.buffering = false;
      if (this.onBuffering) {
        try { this.onBuffering(false); } catch (e) { /* 忽略 */ }
      }
      if (this._pausedByUs) {
        this._pausedByUs = false;
        if (this.video && this.video.paused) {
          this._suppressRealign = true; // 缓冲恢复:playing 事件不要重置对齐,避免音频重播
          this.video.play().catch(() => {});
        }
      }
    }

    _scheduleRetry(idx) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (!this.running || this.schedulePaused || !this.video) return;
        const cue = this.cues[idx];
        if (!cue) return;
        const t = this.video.currentTime;
        // 仍在区间内(缓冲时视频被暂停,时间冻结在区间内,同样允许重试)
        if (t >= cue.start && t < cue.end && (!this.video.paused || this.buffering)) {
          this._switchTo(idx, t);
        }
      }, 400);
    }

    /**
     * 设置视频速率(带 +0.001 指纹)。
     * 指纹使插件所设速率(如 1.001 / 0.881)与用户的整洁值(1 / 1.25)可区分,
     * 见 _onRateChange
     */
    _setVideoRate(rate) {
      if (!this.video) return;
      const target = rate + RATE_FINGERPRINT;
      this._appliedVideoRate = target;
      if (Math.abs(this.video.playbackRate - target) > 1e-6) {
        this.video.playbackRate = target;
      }
    }

    /** 恢复视频速率为用户基准(带指纹,避免被误判为用户调速) */
    _restoreVideoRate() {
      if (this._appliedVideoRate) this._setVideoRate(this.originRate);
    }

    /** 用户基准倍速变化后,按当前句系数重算音频/视频速率 */
    _applyPlaybackRate() {
      if (this.audio) {
        this.audio.playbackRate = Math.min(this.originRate * this._curAFactor, 4);
      }
      if (this._curVFactor !== 1) {
        this._setVideoRate(this.originRate * this._curVFactor);
      }
    }

    _stopAudio() {
      if (this.audio) {
        this.audio.pause();
        this.audio.src = '';
        this.audio = null;
        this._audioIndex = -1;
      }
      this._curVFactor = 1;
      this._curAFactor = 1;
      this._restoreVideoRate();
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
      const r = this.video ? this.video.playbackRate : 1;
      // 插件自己设的速率(±0.005 容差吸收浏览器舍入):速率回声,不是用户行为
      if (this._appliedVideoRate && Math.abs(r - this._appliedVideoRate) < 0.005) {
        return;
      }
      // "整洁"速率(r===1 或字符串长度 ≤4,如 0.75 / 1.25 / 2)视为用户手动调速:
      // 立即采纳为新基准,插件后续在此基础上叠加微调,不与用户拉锯
      if (r === 1 || r.toString().length <= 4) {
        this.originRate = r;
      }
      this._applyPlaybackRate();
    }

    _onPause() {
      this._stopAudio();
    }

    _onPlaying() {
      // 缓冲恢复播放触发的 playing:音频刚起播,跳过重对齐(否则同一句会重播)
      if (this._suppressRealign) {
        this._suppressRealign = false;
      } else {
        // 恢复时重新对齐(上一句可能已过期)
        this.currentIndex = -1;
      }
      // 用户在缓冲期间手动按了播放:尊重其选择,本句不再强制缓冲
      if (this.buffering) {
        this.buffering = false;
        this._pausedByUs = false;
        this._noBuffer = true;
        if (this.onBuffering) {
          try { this.onBuffering(false); } catch (e) { /* 忽略 */ }
        }
      }
    }
  }

  globalThis.SyncPlayer = SyncPlayer;
})();

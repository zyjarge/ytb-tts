# ytb-tts — YouTube 中文配音

把 YouTube 英文视频**实时配上中文语音**的 Chrome 扩展（MV3)：抓取视频自带字幕 → 批量翻译为中文（DeepSeek 等 OpenAI 兼容服务）→ MiniMax TTS 逐句合成 → 按时间戳与原画面同步播放，原声自动静音。

本仓库包含两部分内容：

1. **对商业插件「YouTube中文配音 4.3.1」的逆向分析**（know-how 见下）
2. **自研 MVP 扩展** [`youtube-zh-dubbing/`](youtube-zh-dubbing/README.md)，复刻其核心体验

## 快速开始

详见 [youtube-zh-dubbing/README.md](youtube-zh-dubbing/README.md)。简要：

1. `chrome://extensions` 开启开发者模式，加载 `youtube-zh-dubbing/` 目录
2. 设置页填入 MiniMax API Key 与翻译 API（默认 DeepSeek）配置
3. 打开带英文字幕的 YouTube 视频，点播放器控制栏右侧的「中文配音」按钮
4. 视频暂停并显示加载浮层，首批 3 句语音缓冲就绪后自动续播，后续边合成边播

## 逆向结论：商业插件的「丝滑」是如何做到的

逆向对象：`YouTube中文配音 – AI字幕翻译与配音 / Translate & Dub 4.3.1`（本地 crx 解包分析，未入库）。核心机制：

- **事件驱动而非轮询**:通过 hidden textTrack 的 `VTTCue enter` 事件感知播放进度，比定时轮询 `currentTime` 更精准省耗
- **前瞻预取**：以当前播放位置为起点，提前约 300 秒做翻译 + TTS 预取，每批 3 句小步快跑，开播延迟压到最低
- **未就绪宁可暂停**：当前句语音未合成完时主动暂停视频缓冲等待，配加载视觉提示，就绪后自动续播——绝不"哑播"
- **双向调速对齐**：语音比字幕窗口长时，不硬截断，而是视频轻微减速（约 [0.75, 1.25]）与语音轻微加速（约 [0.9, 1.5]）各承担一半误差，人耳几乎无感
- **尾部对齐**：起播严重迟到时牺牲句首、对齐句尾，保证下一句准时进场，不丢内容
- **伪静音**：原声不 `muted`，而是 `volume = 1e-5`，规避部分浏览器对 muted 媒体的自动播放策略差异
- **+0.001 速率指纹**：插件设置的 `playbackRate` 永远加 0.001（如 1.001)，借此区分"用户手动调速"（整洁值 1 / 1.25 / 2）与"插件自己调的"，不与用户拉锯
- **字幕抓取绕 pot 校验**:YouTube 对 timedtext 接口强制 PO Token 校验，裸请求返回空；做法是"逼"播放器自己发字幕请求并 hook 捕获，再改参数（如 `fmt=json3`）重取
- **TTS 通道**：商业版白嫖微软 Edge 大声朗读接口（`dev.microsofttranslator.com` 换 JWT)；本 MVP 改用用户自备的 MiniMax Key，合规且稳定

## 仓库结构

```
├── PRD.md                 # 产品需求文档(MVP 范围、技术架构、验收标准)
└── youtube-zh-dubbing/    # 自研 Chrome 扩展(MV3)
    ├── manifest.json
    ├── background.js      # Service Worker:流式翻译 + TTS 调度 + 持久缓存
    ├── content.js         # Content Script:播放器内嵌按钮、加载浮层、字幕抓取
    ├── injected.js        # 主世界脚本:hook 播放器带 pot 的字幕请求
    ├── options.html/js    # 设置页(API Key、音色、语速)
    └── lib/
        ├── subtitles.js   # timedtext JSON3 解析、片段合并、轨道选择
        ├── translate.js   # OpenAI 兼容翻译封装(分块、按行对应)
        ├── minimax_tts.js # MiniMax TTS 封装(hex 解码、限流自适应队列)
        └── syncplayer.js  # 时间戳对齐播放引擎(双向调速/尾部对齐/缓冲等待)
```

## 合规说明

- 仅供个人学习与研究使用；API Key 仅存本机 `chrome.storage.local`
- 逆向分析仅用于理解交互机制，未复制商业插件的任何代码与素材
- 不下载、不分发 YouTube 音视频内容；字幕数据仅在浏览器内实时处理

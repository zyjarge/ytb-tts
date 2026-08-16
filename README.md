# ytb-tts — YouTube / B 站中文配音

把英文视频**实时配上中文语音**的 Chrome 扩展（MV3)：抓取视频字幕 → 翻译为中文（YouTube 走 DeepSeek;B 站 AI 字幕已是中文则直通）→ MiniMax TTS 逐句合成 → 按时间戳与原画面同步播放，原声自动静音。

**支持站点**:YouTube（普通视频 + Shorts，需英文 CC/ASR 字幕）、B 站（`/video/` 播放页，需登录，需 ai-zh 中文 AI 字幕）。

## 快速开始

详见 [youtube-zh-dubbing/README.md](youtube-zh-dubbing/README.md)。简要：

1. `chrome://extensions` 开启开发者模式，加载 `youtube-zh-dubbing/` 目录
2. 设置页填入 MiniMax API Key 与翻译 API（默认 DeepSeek）配置
3. 打开带英文字幕的 YouTube 视频，点播放器控制栏右侧的「中文配音」按钮
4. 视频暂停并显示加载浮层，首批 3 句语音缓冲就绪后自动续播，后续边合成边播

## 核心机制

- **流式管线**：从当前播放位置开始，按批翻译 + 逐句合成即时推送，首批缓冲就绪即开播，末尾回填跳过的句子
- **加载体验**：点击后先暂停视频并显示加载浮层（转圈 + 进度），缓冲就绪自动续播；播放中某句未就绪时同样暂停缓冲等待，绝不"哑播"
- **双向调速对齐**：语音比字幕窗口长时，不硬截断，而是视频轻微减速（[0.75, 1.25]）与语音轻微加速（[0.9, 1.5]）各承担一半误差，人耳几乎无感
- **尾部对齐**：起播严重迟到时牺牲句首、对齐句尾，保证下一句准时进场，不丢内容
- **+0.001 速率指纹**：插件设置的 `playbackRate` 永远加 0.001（如 1.001)，借此区分"用户手动调速"（整洁值 1 / 1.25 / 2）与"插件自己调的"，不与用户拉锯
- **字幕抓取**:YouTube 对 timedtext 接口强制 PO Token 校验，裸请求返回空；插件借助播放器自身携带 pot 的字幕请求获取数据，配音期间原字幕窗口被 CSS 隐藏
- **持久缓存**：翻译与音频均有本地持久缓存，同一视频第二次点击近乎即时开播

## 仓库结构

```
├── PRD.md                 # 产品需求文档(MVP 范围、技术架构、验收标准)
└── youtube-zh-dubbing/    # Chrome 扩展(MV3)
    ├── manifest.json
    ├── background.js      # Service Worker:流式翻译(可跳过)+ TTS 合并调度 + 持久缓存
    ├── content.js         # YouTube Content Script:播放器内嵌按钮、加载浮层、字幕抓取
    ├── injected.js        # YouTube 主世界脚本:hook 播放器带 pot 的字幕请求
    ├── bilibili.js        # B 站 Content Script:字幕 API(wbi 签名)、ai-zh 直通、分 P 巡检
    ├── options.html/js    # 设置页(API Key、音色、语速)
    └── lib/
        ├── subtitles.js   # YouTube timedtext JSON3 解析、片段合并、轨道选择
        ├── translate.js   # OpenAI 兼容翻译封装(分块、按行对应)
        ├── minimax_tts.js # MiniMax TTS 封装(hex 解码、限流自适应队列、多句合并+句级字幕)
        ├── syncplayer.js  # 时间戳对齐播放引擎(双向调速/尾部对齐/缓冲等待,两站共用)
        ├── dubcommon.js   # 站点无关公共件(base64/WAV 编码、合并块切分、安全消息)
        └── wbi.js         # B 站 wbi 签名(内置 MD5)
```

## 合规说明

- 仅供个人学习与研究使用；API Key 仅存本机 `chrome.storage.local`
- 不下载、不分发 YouTube 音视频内容；字幕数据仅在浏览器内实时处理

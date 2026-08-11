# 项目:YouTube 视频中文配音 Chrome 插件(MVP)

## 一、项目背景

用户在 YouTube 上学习英文课程视频。虽然视频有中文字幕,但用户希望**直接听到中文语音**,以提升学习效率。参考产品"YouTube Dubbing"(浏览器插件,点击按钮后自动翻译字幕并用中文朗读)。现需从零开发一款功能相同的 Chrome 扩展(MVP 版本)。

核心技术思路:**不下载、不处理原始音频**。直接抓取 YouTube 视频自带的字幕轨道(带时间戳的文本),经机器翻译为中文后,调用 TTS API 逐句合成语音,再按时间戳与原视频画面同步播放,同时将原声静音。整条链路绕开了音频下载和语音识别,全部在浏览器内实时完成。

## 二、功能需求(MVP 范围)

### 必须实现
1. 在 YouTube 视频页面注入一个"中文配音"按钮(位于播放器控制栏或视频下方)
2. 点击按钮后:
   - 抓取当前视频的英文字幕轨道(含每句的起止时间戳)
   - 批量翻译为中文(要求语义通顺,而非逐句机翻腔)
   - 逐句调用 MiniMax TTS 合成中文语音(mp3)
   - 将视频原声静音,按字幕时间戳依次播放中文语音,与画面同步
3. 预生成流水线:启动后先合成前若干句即开始播放,后台持续合成后续句子并缓存,保证听感连续
4. 再次点击按钮(或关闭开关)恢复原声、停止配音
5. 设置页面(Options Page):可填写 MiniMax API Key、Group ID、翻译 API 配置,可选择音色、语速
6. 正确处理:暂停、拖动进度条(seek)、倍速播放(playbackRate)

### 明确不做(Out of Scope)
- 无字幕视频的处理(直接提示"该视频无可用字幕"并退出)
- 声音克隆、口型同步、多说话人区分
- 背景音保留/分离(MVP 直接全静音)
- 除 YouTube 以外的平台
- 发布到 Chrome Web Store(仅本地"加载已解压扩展程序"使用)

## 三、技术架构

### 总体数据流
```
YouTube 页面
  └─ Content Script
       1. 从页面提取字幕轨道 URL 并拉取字幕(带时间戳的句子序列)
       2. 发送字幕文本 → Background Service Worker
            ├─ 批量调翻译 API → 中文句子序列
            └─ 逐句调 MiniMax TTS → mp3(hex)→ 解码为音频数据
       3. 音频片段按序传回 Content Script
       4. Content Script 监听 video 元素:
            - 静音原声(video.muted = true)
            - 轮询 video.currentTime,到点播放对应句子的 Audio
            - 处理 pause / seek / playbackRate 事件,重新对齐
```

### 建议文件结构
```
youtube-zh-dubbing/
├── manifest.json          # MV3 清单
├── background.js          # Service Worker:翻译 + TTS 调度 + 缓存队列
├── content.js             # 页面注入:UI 按钮、字幕抓取、同步播放引擎
├── injected.js            # 注入页面主世界,读取 ytInitialPlayerResponse
├── options.html / options.js  # 设置页(API Key、音色、语速)
├── lib/
│   ├── subtitles.js       # 字幕轨道解析(timedtext JSON → [{start,end,text}])
│   ├── translate.js       # 翻译 API 封装
│   ├── minimax_tts.js     # MiniMax TTS 封装(含 hex→Blob 解码)
│   └── syncplayer.js      # 时间戳对齐播放引擎
└── icons/                 # 插件图标
```

### 模块间通信
- Content Script ↔ Background:使用 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`
- 页面主世界读取播放器数据:YouTube 的字幕轨道信息在 `ytInitialPlayerResponse`(页面主世界变量)中,需通过 `injected.js`(script 标签注入主世界)读取后经 `window.postMessage` 传给 Content Script
- 音频数据传递:mp3 转 Base64 通过消息传递,Content Script 端 `atob` 还原为 Blob URL 播放(注意 MV3 下不能加载远程代码,所有逻辑必须打包在插件内)

## 四、外部 API 规范

### 1. MiniMax TTS(语音合成)
- **Endpoint**:`POST https://api.minimaxi.chat/v1/t2a_v2?GroupId={group_id}`
- **认证**:Header `Authorization: Bearer {api_key}`
- **请求体要点**:
  ```json
  {
    "model": "speech-02-turbo",
    "text": "要合成的中文句子",
    "stream": false,
    "voice_setting": { "voice_id": "male-qn-qingse", "speed": 1.0, "vol": 1.0, "pitch": 0 },
    "audio_setting": { "format": "mp3", "sample_rate": 32000, "bitrate": 128000 }
  }
  ```
- **关键坑**:返回 JSON 中 `data.audio` 是 **hex 编码字符串(不是 Base64)**,需将 hex 字符串解码为二进制后构造 mp3 Blob
- **限流**:约 60 次/分钟,需实现请求队列与失败重试(指数退避)
- **音色**:voice_id 做成设置项,默认值 `male-qn-qingse`(青年男声);`speed`(0.5~2.0)同时作为同步微调手段
- 模型与音色 ID 以 MiniMax 官方文档为准,实现前先核对文档,若上述值失效需自行查询最新可用值

### 2. 翻译 API(OpenAI 兼容格式)
- 使用 OpenAI 兼容的 Chat Completions 接口,`base_url`、`api_key`、`model` 三项均做成设置项(默认 base_url 填 DeepSeek 的 `https://api.deepseek.com`,model 填 `deepseek-chat`,用户可自行换成任意兼容服务)
- 翻译策略:将字幕**整批分块**(每块约 20~30 句)发送,prompt 要求"忠实通顺地翻译为简体中文,保留专业术语英文原词并附中文,按行返回与输入一一对应的译文,不要输出序号以外的任何内容"
- 实现结果缓存(以视频 ID + 句索引为 key,存 `chrome.storage.local`),同一视频重复打开不重复调用

## 五、技术约束(必须遵守)

1. **Manifest V3**:禁止远程代码加载,所有 JS 打包在插件内;后台为 Service Worker,注意其休眠机制,长任务状态要可恢复
2. **权限最小化**,仅需:
   - `permissions`: `["storage", "offscreen"]`(如确需 offscreen 播放音频)
   - `host_permissions`: `["*://www.youtube.com/*", "https://api.minimaxi.chat/*", "https://www.youtube.com/api/timedtext/*"]` + 翻译 API 域名(设置页可配时可用 optional_host_permissions 或让用户自行确认)
3. **API Key 安全**:仅存 `chrome.storage.local`,代码中不得硬编码任何 key;README 中注明"仅供个人本地使用,切勿打包分发含 key 的插件"
4. **不下载视频/音频流**,只使用字幕轨道文本,规避 YouTube 风控与版权问题
5. 目标浏览器:最新版 Chrome;不考虑 Firefox/Edge 兼容
6. 不引入需要构建步骤的框架(不强制);如需用 npm 依赖,必须打包为纯静态产物,交付即用的解压目录
7. 代码注释使用中文;UI 文案使用简体中文

## 六、核心逻辑细节与边界情况

1. **字幕抓取**:优先选英文人工字幕,其次英文自动生成字幕(`kind=asr`);解析 timedtext 返回的 JSON 格式(`json3`),得到 `[{start(ms), dur(ms), text}]`;合并过碎的片段(相邻间隔 &lt;300ms 且合计 &lt;12 字的合并),减少 TTS 调用次数
2. **同步播放引擎**:
   - 每 100~200ms 检查一次 `video.currentTime`,找到当前应播句子
   - 若中文语音时长超过字幕时间窗,允许轻微溢出,或以 `speed` 微调重合成(超长 &gt;1.5 倍时)
   - `seeked` 事件:清空当前播放,从新位置的对齐句子继续
   - `ratechange` 事件:按倍速调整音频 `playbackRate`
   - `pause` 事件:立即停止当前音频
3. **广告干扰**:检测到播放器处于广告状态(`ad-showing` class)时暂停配音调度
4. **SPA 导航**:YouTube 是单页应用,监听 `yt-navigate-finish` 事件,切视频时重置全部状态
5. **降级提示**:无字幕、TTS 失败、翻译失败时,在按钮旁给出明确文字提示,不得静默失败
6. **性能**:预生成窗口默认领先当前播放位置 10 句;翻译和 TTS 均带内存 + `chrome.storage` 两级缓存

## 七、使用方式(交付后用户操作)

1. `chrome://extensions` → 开启开发者模式 → "加载已解压的扩展程序" → 选择项目目录
2. 点击插件图标 → 打开设置页 → 填入 MiniMax API Key、Group ID、翻译 API Key → 保存
3. 打开任意带英文字幕的 YouTube 视频 → 点击播放器下方"中文配音"按钮 → 等待 3~10 秒(首批合成)后开始听到中文配音,原声自动静音
4. 再次点击按钮停止配音,恢复原声

## 八、验收标准

1. 在一个 10 分钟以上、带英文字幕的 YouTube 演讲/课程视频上,点击按钮后 15 秒内开始播放中文配音
2. 配音与画面时间戳偏差主观可接受(单句错位不超过 1 秒,不随时间累积漂移)
3. 暂停/拖动/倍速操作后,配音能在 2 秒内重新对齐
4. 无字幕视频给出明确提示,不报错崩溃
5. 连续播放 10 分钟不出现:句子漏播、重复播放、顺序错乱
6. 同一视频第二次打开时翻译结果命中缓存
7. 全程控制台无未捕获异常

## 九、交付物

1. 可直接加载的完整插件目录(含全部源码)
2. `README.md`:安装步骤、设置项说明、已知限制、API 成本估算
3. 一段简短的自测说明(用哪个测试视频、验证了哪些场景)
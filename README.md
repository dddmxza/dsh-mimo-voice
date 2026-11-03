# dsh-mimo-voice

DeepSeek Harness 的语音输出插件。调用 TTS 服务合成语音，写入 `audio/` 目录，由当前浏览器页面播放，也可经 `ffplay` 从本机音频设备播放或推送至远端播放端点。当前支持小米 MiMo 与 Breeze Blue 两家服务商。

功能：

- 通过系统提示词注入，使模型在每次回复时调用 `speak` 输出语音
- 审批请求挂起时播放提醒语音
- 设置面板中配置 API 密钥、音色描述，并支持试听与样本固化

## 安装

```powershell
pnpm --dir C:\Users\<user>\.dsh\profiles\desktop add link:D:/path/to/dsh-mimo-voice
```

随后在 profile 的 `package.json` 中将 `dsh-mimo-voice` 加入 `dsh.profile.bundles`，重启桌面端。

依赖 `ffplay` / `ffmpeg`，默认查找 `C:\ffmpeg\bin\`，也可通过环境变量 `FFPLAY_PATH` / `FFMPEG_PATH` 指定。默认的页面播放不需要这两者；页面未加载时回退才使用 `ffplay`，音色固化与远端推流使用 `ffmpeg`。

## 配置

打开 设置 → 插件 → 语音输出。面板分为 接入、音色、输出、行为 四组，修改后点击底部「保存」写入 `config.json`；「还原」丢弃未保存的修改。顶部状态标记依次表示密钥是否已配置、当前服务商、语音输出是否启用、输出设备。

| 配置项 | 说明 |
| --- | --- |
| 服务商 | 语音合成的提供方。可选 `mimo`（小米 MiMo）与 `breeze`（Breeze Blue），新增服务商需在 `lib/engine.js` 注册 |
| 音色 ID | 仅 Breeze Blue 使用。该服务商的音色须先在平台生成并保存，此处填写其 `voice_id` |
| 语言码 | 仅 Breeze Blue 使用。ISO 639-1 两字母代码，决定发音口音与语言模型，默认 `zh` |
| 指导强度 | 仅 Breeze Blue 使用。对应 `guidance_scale`，取值 1–10，越高越贴合音色描述；留 0 采用服务端默认 |
| 音色描述 | 生成音色所用的自然语言描述。voicedesign 模型每次调用重新生成音色；试听后可将结果固化为克隆样本 |
| 试听文本 | 试听时合成的文本内容 |
| 当前音色 | 显示为「已固化」或「为每次生成」，固化后可切回生成模式 |
| 输出设备 | `local` 在当前浏览器页面播放，`board` 推送远端端点，`both` 两路并行 |
| 语音推送接口 | 远端播放服务的基址，默认 `http://192.168.31.123` |
| 推送失败回退本机 | 远端不可达时改由本机输出，避免该句完全无声 |
| 推送前响度归一 | 推送前将均值提到 -16 LUFS、峰值锁在 -3 dBTP，远端增益保持 100。流式路径改用单遍放大加限幅，见「远端播放」 |
| 启用语音输出 | 总开关。开启时注入提示词规则且 `speak` 正常合成；关闭时既不注入规则，`speak` 也直接拒绝，不发起 TTS 请求 |
| 审批挂起时提醒 | 审批请求挂起时播放提醒语音 |
| 提醒语句 | 候选提醒语句列表，逐条添加与删除，播放时随机选取；列表为空时使用出厂语句。句首可加 `（语速快，很焦急）` 形式的语气标签 |
| API 密钥 | 服务商 API 密钥，以明文存储于插件根目录 `.env`，按服务商分键位：`MIMO_API_KEY`、`BREEZE_API_KEY` |

## 页面播放

`output` 为 `local`（默认）时，音频在浏览器页面内播放：宿主把待播句排入队列，页面以最长 20 秒的长轮询请求 `/api/dsh-mimo-voice.queue` 取句，再经 `AudioContext` 播放；`both` 时页面与远端并行。这种方式不依赖本机安装任何播放器。

页面播放分两条路。引擎实现了 `openStream()` 且输出为 `local` / `both` 时走流式：宿主请求服务商的流式端点，每收到一块裸 PCM 就转给页面，页面按块建 `AudioBuffer` 首尾相接排到声卡上，因此第一块到达即可出声，无需等待整段合成。其余情况走整段：合成完成、落盘、页面用 `decodeAudioData` 解整个文件。两种方式落盘留档的行为一致。

本机输出不再单设页面选项：音频直接入队，由页面取走。若客户端未加载起来（宿主版本更新而页面仍在用旧 bundle），本机输出回落 `ffplay`，并在日志输出一行提示。浏览器要求 `AudioContext` 经用户交互方可启动，页面首次点击或按键时会自动恢复。

## 远端播放

`output` 为 `board` 或 `both` 时，合成的音频经 ffmpeg 转为 16 kHz / 16 bit / 单声道裸 PCM，以 `Transfer-Encoding: chunked` 请求体 `POST` 到远端端点的 `/say?sr=16000`。远端收到一块即写入 I2S，因此第一块到达即可出声。该请求的耗时等于音频时长（32 KB/s 为实时速率），8 秒语音约需 7.5 秒返回；宿主不等待其返回，`speak` 调用在推送开始后即结束。ffmpeg 转码约 100 ms，不构成瓶颈。

流式路径的响度处理使用单遍放大加限幅：`volume=1.8,alimiter=limit=0.72:level=disabled`，峰值约 23600，落在远端软限幅膝点 24000 之下。两遍 `loudnorm` 需攒满约 3 秒才开始输出，与流式目标冲突，故流式路径不采用。

远端固件需支持 `/say` 端点接受 chunked 请求体，并支持 I2S 全双工（收发共用 `I2S_NUM_0`，输出期间丢弃麦克风数据以避免回声自激）。

## 结构

三个职责分层，互不越界：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 协议 | `lib/engine.js` | 向服务商请求音频，返回音频字节与音色元数据。换服务商只改这一个文件 |
| 音色 | `lib/engine.js` 的 `voiceOf()` | 决定用哪副声音：`design` 每次按描述生成，`clone` 使用固定样本 |
| 交付 | `lib/index.js` | 音频落盘至 `audio/`，按 `output` 送往页面队列、本机 `ffplay` 或远端 `/say` |

新增服务商时，在 `lib/engine.js` 中实现 `render(text, cfg, opts)` 并导出 `{ bytes, ext, mime, spoken, voice }`，再注册进 `ENGINES`。`index.js` 无需改动，`config.json` 的 `provider` 字段指定当前使用项。

## 实现

插件不解析、不筛选取要朗读的文本。它向系统提示词注入一个 section，声明本机具备语音输出能力，要求模型在每次回复时调用 `speak` 输出一句，语气以 text 开头的括号表达，正文不出现括号与记号。

输出开关同时控制两处：

- **提示词**：开启时该 section 返回规则正文；关闭时返回空字符串，本轮提示词不含该节。
- **工具**：`speak` 的 `execute` 在入口处读取开关，关闭时返回失败状态且不发起 TTS 请求。

注入使用 `ctx.systemPrompt.section({ name, order: 3250, interpolate: false, text })`。`text` 传入函数而非字符串，每次组装提示词时读取 `config.json`，因此切换开关无需重启 DSH。`interpolate: false` 用于避免规则正文中的花括号被提示词引擎插值。`order: 3250` 使该 section 位于提示词末尾，靠近生成阶段，避免被前文稀释。

规则正文定义于 `lib/index.js` 的 `SPEAK_POLICY`。

### 语气标签

以下是 TTS 服务本身支持的语法，供手动指定语气时参考；插件注入的系统提示词不再要求使用标签，`speak` 的文本按纯文本合成。

按 MiMo 官方文档（`speech-synthesis-v2.5`）的音频标签规范：标签置于 assistant 文本开头、紧接正文首字，半角 `()`、全角 `（）`、方括号 `[]` 均可，多个标签可置于同一对括号内。

标签应使用正向、可执行的描述，不使用否定式。模型对否定词不敏感，`尾音不抬`、`别拖长` 等写法可能产生反向效果；应改为 `尾音收住往下落`、`语速稍慢` 等正向表述。

优先使用官方词表内的词项：

- 整体语调：温柔 / 高冷 / 活泼 / 严肃 / 慵懒 / 俏皮 / 深沉 / 干练 / 凌厉
- 复合情绪：怅然 / 欣慰 / 无奈 / 愧疚 / 释然 / 嫉妒 / 厌倦 / 忐忑 / 动情
- 句中标签：气声 / 叹气 / 深呼吸 / 轻笑 / 冷笑 / 哽咽 / 颤抖 / 鼻音 / 不耐烦 / 心虚 / 撒娇 / 小声 / 提高音量喊话

不应在标签中使用音色词（磁性 / 醇厚 / 清亮 / 空灵 / 稚嫩 / 苍老 / 甜美 / 沙哑 / 醇雅）。音色由 `voiceDesign` 定义，而 voicedesign 模型每次调用重新生成音色，标签中出现音色词会导致该次调用的基础音色一并改变，造成音色漂移。

`voiceDesign` 本身已覆盖长期设定：音色质感、语速、情绪基调均属官方支持的维度。标签仅用于表达与常规不同的临时调整，避免与音色描述产生互斥指令。如需完全固定音色，使用 `voiceMode: 'clone'` 并提供参考样本。

voicedesign 模型不支持唱歌模式，也不支持预置音色与音色复刻，后者需使用 `mimo-v2.5-tts`。

## 版本说明

0.3.0 及更早版本由插件监听 `assistant/message` 事件并截取文本朗读，实现中包含 `pickLine` 函数与 `【念】` 记号。0.4.0 起移除该链路，改为提示词注入方案。0.4.1 起输出开关由「仅控制提示词注入」改为总开关，关闭时 `speak` 同样不可用。0.5.0（待发布）增加输出设备（本机 / 远端 / 同时）、远端 chunked 流式推送、协议层拆分与 Breeze Blue 服务商、设置面板重做、页面内流式播放。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-mimo-voice.config` | 读取配置，密钥仅返回 `hasKey` 布尔值 |
| POST | `/api/dsh-mimo-voice.config` | 写入配置 |
| POST | `/api/dsh-mimo-voice.preview` | 试听，body 可含 `text` / `voiceDesign` |
| POST | `/api/dsh-mimo-voice.pin` | 将最近一次试听结果固化为音色样本 |
| POST | `/api/dsh-mimo-voice.speak` | 朗读指定文本 |
| POST | `/api/dsh-mimo-voice.stop` | 中止当前播放 |
| GET | `/api/dsh-mimo-voice.queue` | 页面取句，`since` 为已取序号，`wait` 为长轮询毫秒数 |
| GET | `/api/dsh-mimo-voice.audio` | 页面取音频文件，`f` 为 `audio/` 下的文件名 |
| GET | `/api/dsh-mimo-voice.stream` | 页面取流式音频，`id` 为句序号。每句只可被取一次，返回裸 PCM 并附 `X-Sample-Rate` / `X-Bits` / `X-Channels` |

工具定义：`speak(text)`。

## 限制

- voicedesign 与 voiceclone 每次调用按描述重新生成音色，结果不完全一致。需要固定音色时应使用克隆模式。
- 小米 MiMo 为非流式接口，音频一次性返回。Breeze Blue 支持流式端点，页面播放与远端推送均为边合成边送出。
- 流式路径下 ffmpeg 只做单遍放大加限幅，不做两遍响度归一，因此句与句之间的平均电平会有小幅差异；整段路径仍使用 `loudnorm`。
- TTS 接口限流 RPM 100，超出返回 429，需等待后重试。

## 测试

```powershell
node test/smoke.mjs          # 仅验证注册，不发起网络请求
node test/smoke.mjs --speak  # 实际合成并播放
```

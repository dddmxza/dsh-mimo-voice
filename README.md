# dsh-mimo-voice

DeepSeek Harness 的本机语音输出插件。调用小米 MiMo TTS 合成语音，写入 `audio/` 目录，经 `ffplay` 由本机音箱播放。

功能：

- 通过系统提示词注入，使模型在每次回复时调用 `speak` 输出语音
- 审批请求挂起时播放提醒语音
- 设置面板中配置 API 密钥、音色描述，并支持试听与样本固化

## 安装

```powershell
pnpm --dir C:\Users\<user>\.dsh\profiles\desktop add link:D:/path/to/dsh-mimo-voice
```

随后在 profile 的 `package.json` 中将 `dsh-mimo-voice` 加入 `dsh.profile.bundles`，重启桌面端。

依赖 `ffplay` / `ffmpeg`，默认查找 `C:\ffmpeg\bin\`，也可通过环境变量 `FFPLAY_PATH` / `FFMPEG_PATH` 指定。

## 配置

打开 设置 → 插件 → dsh-mimo-voice。面板分为 音色、输出行为、密钥 三部分，修改后需点击底部「保存」写入 `config.json`。右上角状态标记表示密钥是否已配置。

| 配置项 | 说明 |
| --- | --- |
| 音色描述 | 生成音色所用的自然语言描述。voicedesign 模型每次调用重新生成音色；试听后可将结果固化为克隆样本 |
| 试听文本 | 试听时合成的文本内容 |
| 当前音色 | 显示为「克隆样本」或「每次生成」，克隆模式可切回生成模式 |
| 输出开关 | 总开关。开启时注入提示词规则且 `speak` 正常合成；关闭时既不注入规则，`speak` 也直接拒绝，不发起 TTS 请求 |
| 审批提醒 | 审批请求挂起时播放提醒语音 |
| 提醒文本 | 候选提醒语句列表，逐条添加与删除，播放时随机选取；列表为空时使用默认语句。句首可加 `（语速快，很焦急）` 形式的语气标签 |
| API 密钥 | MiMo API 密钥，以明文存储于插件根目录 `.env` |

## 实现

插件不解析、不筛选取要朗读的文本。它向系统提示词注入一个 section，声明本机具备语音输出能力，要求模型在每次回复时调用 `speak` 输出一句，语气以 text 开头的括号表达，正文不出现括号与记号。

输出开关同时控制两处：

- **提示词**：开启时该 section 返回规则正文；关闭时返回空字符串，本轮提示词不含该节。
- **工具**：`speak` 的 `execute` 在入口处读取开关，关闭时返回失败状态且不发起 TTS 请求。

注入使用 `ctx.systemPrompt.section({ name, order: 3250, interpolate: false, text })`。`text` 传入函数而非字符串，每次组装提示词时读取 `config.json`，因此切换开关无需重启 DSH。`interpolate: false` 用于避免规则正文中的花括号被提示词引擎插值。`order: 3250` 使该 section 位于提示词末尾，靠近生成阶段，避免被前文稀释。

规则正文定义于 `lib/index.js` 的 `SPEAK_POLICY`。

### 语气标签

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

0.3.0 及更早版本由插件监听 `assistant/message` 事件并截取文本朗读，实现中包含 `pickLine` 函数与 `【念】` 记号。0.4.0 起移除该链路，改为提示词注入方案。0.4.1 起输出开关由「仅控制提示词注入」改为总开关，关闭时 `speak` 同样不可用。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-mimo-voice.config` | 读取配置，密钥仅返回 `hasKey` 布尔值 |
| POST | `/api/dsh-mimo-voice.config` | 写入配置 |
| POST | `/api/dsh-mimo-voice.preview` | 试听，body 可含 `text` / `voiceDesign` |
| POST | `/api/dsh-mimo-voice.pin` | 将最近一次试听结果固化为音色样本 |
| POST | `/api/dsh-mimo-voice.speak` | 朗读指定文本 |
| POST | `/api/dsh-mimo-voice.stop` | 中止当前播放 |

工具定义：`speak(text, wait?)`。

## 限制

- voicedesign 与 voiceclone 每次调用按描述重新生成音色，结果不完全一致。需要固定音色时应使用克隆模式。
- 两个模型均为非流式接口，音频一次性返回，无法边合成边播放。
- TTS 接口限流 RPM 100，超出返回 429，需等待后重试。

## 测试

```powershell
node test/smoke.mjs          # 仅验证注册，不发起网络请求
node test/smoke.mjs --speak  # 实际合成并播放
```

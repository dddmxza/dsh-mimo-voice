# dsh-mimo-voice

给 DeepSeek Harness 用的本机发声插件：调小米 MiMo TTS 合成，落到 `audio/`，再用 `ffplay` 从本机音箱念出来。

- 聊天里自动念回复的第一句（可关）
- 卡在审批等你点确认时，念一句提醒（可关）
- 设置卡片里填密钥、调音色描述、试听、把满意的那条定为音色样本

## 装

```powershell
# 1. 让它对本机可见（profile 里指向这个目录）
pnpm --dir C:\Users\<你>\.dsh\profiles\desktop add link:D:/path/to/dsh-mimo-voice
# 2. 在 profile 的 package.json 里，把 dsh-mimo-voice 加进 dsh.profile.bundles
# 3. 重启桌面端
```

需要本机有 `ffplay` / `ffmpeg`。放在 `C:\ffmpeg\bin\`，或者设环境变量 `FFPLAY_PATH` / `FFMPEG_PATH`。

## 配

设置 → 插件 → dsh-mimo-voice（或「MiMo 声音」那一页）。页面按三块排：**① 声音 → ② 什么时候出声 → ③ 密钥**，改完点最下面「保存」才生效。右上角那个小标写着密钥填没填。

| 项 | 说明 |
| --- | --- |
| ① 音色描述 | 一句话描述声音，每次现造；点「试试这个声音」听，满意的点「就它了」转成克隆，声音就固定了 |
| ① 试听念什么 | 试听时念的文本 |
| ① 现在用的 | 显示当前是「定住的样本」还是「每次现造」；定住后可「切回现造」 |
| ② 自动出声 | 每轮回复挑一句念出来 |
| ② 要你确认时喊我 | 审批弹出来时念一句提醒 |
| ② 审批提醒说什么 | 一条一条往里加，列表里能逐条删；有几条就随机挑一条念。一条都没有就用出厂那句「任务需要权限，请审批。」。句首能加 `（语速快，很焦急）` 这类标签调语气 |
| ③ 密钥 | 小米 MiMo 的 key，存在插件根目录 `.env` 里 |

密钥以明文存在 `.env`（`MIMO_API_KEY=...`），`.env` 在 `.gitignore` 里，不会跟着源码走。
`config.json` 里没有密钥，可以正常提交；首次运行会自动生成，不存在也能跑。

## 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/dsh-mimo-voice.config` | 读设置（密钥只回 `hasKey` 布尔） |
| POST | `/api/dsh-mimo-voice.config` | 写设置 |
| POST | `/api/dsh-mimo-voice.preview` | 试听，body 可带 `text` / `voiceDesign` |
| POST | `/api/dsh-mimo-voice.pin` | 把刚试的那条定为音色样本 |
| POST | `/api/dsh-mimo-voice.speak` | 念指定文本 |
| POST | `/api/dsh-mimo-voice.stop` | 掐掉正在放的那句 |

工具：`speak(text, wait?)`。

## 注意

- MiMo 的 voicedesign / voiceclone 每次按描述现造音色，结果不完全一样；想固定就用克隆。
- 这两个模型没有真流式，音频是一次性返回的，别指望边合成边播。
- TTS 限流 RPM 100，连发会 429，等几十秒。

## 测试

```powershell
node test/smoke.mjs          # 只测注册，不联网
node test/smoke.mjs --speak  # 真合成并播放
```

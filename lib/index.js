/**
 * dsh-mimo-voice — 宿主半边。
 *
 * 职责分三层，互不越界：
 *   协议 —— lib/engine.js：怎么跟服务商要一段音频，换服务商只改那一个文件。
 *   音色 —— engine.js 的 voiceOf()：用谁的声音，跟协议和交付都无关。
 *   交付 —— 本文件：音频落盘到 audio/，再按 output 送去本机 ffplay 或远端 /say。
 *
 * 设置项不走 settings 命名空间（web profile 有白名单，第三方命名空间不在名单里
 * 就写不进去），改成插件自己的 config.json + HTTP 路由，浏览器半个边直接 fetch 它。
 *
 * 路由：
 *   GET  /api/dsh-mimo-voice.config   读设置（apiKey 只回 hasKey 布尔，绝不回原文）
 *   POST /api/dsh-mimo-voice.config   写设置 { apiKey?, provider?, voiceDesign?, speakPrompt?, alertOnApproval?, voiceMode?, output? }
 *   POST /api/dsh-mimo-voice.preview  试听：念 body.text，不传就念固定的那首
 *   POST /api/dsh-mimo-voice.pin      把刚试的那条定为音色样本
 *   POST /api/dsh-mimo-voice.speak    念一段指定文本
 *   POST /api/dsh-mimo-voice.stop     立刻掐掉正在放的那句
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_VOICE_DESIGN, engineOf, findFfmpeg, listEngines } from './engine.js'

export const name = 'dsh-mimo-voice'
export const inject = ['tools', 'webServer', 'systemPrompt']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AUDIO_DIR = path.join(ROOT, 'audio')
const CONFIG_PATH = path.join(ROOT, 'config.json')
// 密钥单独放 .env，跟 config.json 分开：config.json 是可以传的默认值，.env 不传。
const ENV_PATH = path.join(ROOT, '.env')
/** 每家服务商各占一个 .env 键位。共用一个键会在切换服务商时互相覆盖。 */
const ENV_KEYS = { mimo: 'MIMO_API_KEY', breeze: 'BREEZE_API_KEY' }

/** 取该服务商对应的 .env 键名；不认识的服务商回落小米那个。 */
function envKeyOf(provider) {
  const key = ENV_KEYS[String(provider || '').trim()]
  return key || ENV_KEYS.mimo
}

/** 可选的输出设备。本机声音在页面里放，不依赖机器上装了播放器。 */
const OUTPUTS = ['local', 'board', 'both']

/** 试听固定文本：用户指定的那句。 */
const PREVIEW_TEXT = '红豆生南国，春来发几枝。愿君多采撷，此物最相思。'

/** 有人卡在审批上时念的话。开头那个括号是音频标签，只改这一句的语气。
 *  这是出厂默认；设置页里自己写了就用自己的，写空了回落到这里。 */
const DEFAULT_APPROVAL_LINES = [
  '任务需要权限，请审批。',
]

/** 把设置里存的几条洗一遍：去掉空行、去掉超长的，别的原样留着。 */
function cleanLines(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((l) => (typeof l === 'string' ? l.trim() : ''))
    .filter((l) => l !== '')
    .slice(0, 40)
    .map((l) => (l.length > 300 ? l.slice(0, 300) : l))
}

/** 出厂配置：key 故意留空，等用户在设置页自己填。 */
const DEFAULT_CONFIG = {
  apiKey: '',
  voiceDesign: DEFAULT_VOICE_DESIGN,
  // 要不要往系统提示词里塞「每轮都要出声」那段规则。关了就不塞，工具还在。
  speakPrompt: false,
  // 卡在审批上时要不要吭一声。
  alertOnApproval: false,
  // 卡在审批上时念哪几句，随机挑一句。空数组 = 用 DEFAULT_APPROVAL_LINES。
  approvalLines: [],
  // 试听那格念什么；空着就用 PREVIEW_TEXT 那首。
  previewText: '',
  // design = 每次按描述现造音色（每次都不一样）；clone = 用固定样本，声音是同一个。
  voiceMode: 'design',
  sampleFile: '',
  // 服务商：mimo = 小米 MiMo，breeze = Breeze Blue。加别的引擎时在 engine.js 注册。
  provider: 'mimo',
  baseURL: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts-voicedesign',
  // Breeze 专用：音色必须先存在平台账号下，这里放它的 voice_id。
  breezeVoiceId: '',
  // Breeze 专用：语言码（ISO 639-1），决定发音口音与语言模型。
  breezeLanguage: 'zh',
  // Breeze 专用：guidance_scale，1–10，越高越贴文字描述。0 表示用服务端默认。
  breezeGuidance: 0,
  maxTextLength: 600,
  // 输出设备：local = 本机（由浏览器页面播放），board = 远端播放端点，both = 两路并行。
  output: 'local',
  // 远端播放服务的基础地址（其 HTTP 服务监听 80 端口）。
  boardUrl: 'http://192.168.31.123',
  // 远端不可达时回退到本机输出，避免该句停止出声。
  boardFallback: true,
  // 推送前先做响度归一：均值提到 -16 LUFS、峰值锁 -3 dBTP，
  // 远端增益保持 100，一个采样都不削。关掉就退回「远端整段乘系数」的老做法。
  boardNormalize: true,
}

function ensureDirs() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
}

/** 读 .env 里该服务商那一行的密钥；文件不在就当没配。 */
function readEnvKey(provider) {
  const name = envKeyOf(provider)
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      if (m[1] !== name) continue
      return m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* 没有就是没配 */ }
  return ''
}

/** 只动该服务商那一行，别的行原样留着。key 传空串就把它删掉。 */
function writeEnvKey(provider, key) {
  const name = envKeyOf(provider)
  let lines = []
  try {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
  } catch { /* 头一次写 */ }
  const kept = lines.filter((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=/.exec(line)
    return !(m && m[1] === name)
  })
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  if (key !== '') kept.push(`${name}=${key}`)
  fs.writeFileSync(ENV_PATH, kept.length === 0 ? '' : kept.join('\n') + '\n', 'utf8')
}

function loadConfig() {
  ensureDirs()
  let cfg = { ...DEFAULT_CONFIG }
  try {
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  } catch { /* 没有配置文件就用默认 */ }
  // 密钥按当前服务商取：每家一个 .env 键位，切服务商不会互相顶掉。
  const name = envKeyOf(cfg.provider)
  cfg.apiKey = process.env[name]?.trim() || readEnvKey(cfg.provider) || cfg.apiKey || ''
  return cfg
}

function saveConfig(patch) {
  const { apiKey, ...rest } = patch
  const next = { ...loadConfig(), ...rest }
  if (typeof apiKey === 'string') {
    // 密钥写到该服务商的键位下。patch 没给 provider 时按现状写。
    const owner = Object.prototype.hasOwnProperty.call(patch, 'provider') ? patch.provider : next.provider
    writeEnvKey(owner, apiKey.trim())
    next.apiKey = apiKey.trim()
  }
  ensureDirs()
  // config.json 里不落密钥，这样它可以跟着源码走。
  const { apiKey: _drop, ...stored } = next
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2) + '\n', 'utf8')
  return next
}

/** 最近一次「试试这个声音」落盘的 wav，点「就它了」就把它留成样本。 */
let lastTried = ''

/** 对外暴露的配置视图：apiKey 只报有没有，不回原文。 */
function publicConfig(cfg) {
  const hasSample = typeof cfg.sampleFile === 'string' && cfg.sampleFile !== '' && fs.existsSync(cfg.sampleFile)
  return {
    hasKey: typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
    voiceDesign: cfg.voiceDesign,
    speakPrompt: cfg.speakPrompt === true,
    alertOnApproval: cfg.alertOnApproval === true,
    // 自己写的那几条；空数组表示还在用出厂默认。
    approvalLines: cleanLines(cfg.approvalLines),
    defaultApprovalLines: DEFAULT_APPROVAL_LINES,
    // pinned：已经在用定下来的那条；canKeep：刚试过一条，可以定下来。
    pinned: cfg.voiceMode === 'clone' && hasSample,
    canKeep: lastTried !== '' && fs.existsSync(lastTried),
    provider: cfg.provider || 'mimo',
    engines: listEngines(),
    baseURL: cfg.baseURL,
    model: cfg.model,
    // Breeze 专用三项；别的服务商不看它们，照样回。
    breezeVoiceId: cfg.breezeVoiceId || '',
    breezeLanguage: cfg.breezeLanguage || 'zh',
    breezeGuidance: Number(cfg.breezeGuidance) || 0,
    previewText: (typeof cfg.previewText === 'string' && cfg.previewText.trim() !== '') ? cfg.previewText : PREVIEW_TEXT,
    audioDir: AUDIO_DIR,
    // 声音从哪儿出来
    output: OUTPUTS.includes(cfg.output) ? cfg.output : 'local',
    boardUrl: cfg.boardUrl,
    boardFallback: cfg.boardFallback !== false,
    boardNormalize: cfg.boardNormalize !== false,
  }
}

/** 一次播放句柄：新的一句进来先掐旧的，不叠音。 */
let current = null
/** 向远端推送音频的在途请求；新的一句进来先中断上一条。 */
let currentBoard = null

function stopPlayback() {
  if (current && current.proc && current.proc.exitCode === null) {
    try { current.proc.kill() } catch { /* 已经自己退了 */ }
  }
  current = null
}

/** 掐掉在途的远端推送。
 *  「这次是我主动掐的」这个标记必须挂在请求本身上：destroy() 触发的 error 是异步
 *  派发的，旧的 error 回调跑到时，下一句已经把模块级的标记重置了，会把自己的中断
 *  误判成「远端挂了」去回退本机，同一句话念两遍。所以由调用方提供的 onAbort
 *  把自己闭包里的标记置位，各管各的。 */
function stopBoard() {
  const req = currentBoard
  if (req) {
    currentBoard = null
    if (typeof req.__onAbort === 'function') {
      try { req.__onAbort() } catch { /* 别让标记本身出事 */ }
    }
    try { req.destroy() } catch { /* 已经完了 */ }
  }
}

/* ── 页面播放：宿主只排队，浏览器半边来取 ───────────────────────────────
 * 浏览器侧不能合成音频，所以走「宿主排、页面取」：每念一句把文件排进队列，
 * 页面长轮询取走，自己解码播放。本机输出因此不再依赖机器上装没装 ffplay。
 * 页面有没有来取过，只用来在日志里说一句，不影响发送。
 */
/** 页面最近一次来取音频的时刻（毫秒）。0 表示本次运行还没取过。
 *  不能用一个只置位的布尔：页面关掉或刷新之后标志仍是真，句子会被排进队列干等，
 *  既不播也不回退。所以记时刻、按窗口判活。 */
let pageSeenAt = 0
/** 页面多久没来取就算不在了。长轮询最长挂 25 秒，留一倍余量。 */
const PAGE_IDLE_MS = 50000

/** 页面在不在：最近一次来取音频没有超过窗口。 */
function pageOnline() {
  return pageSeenAt > 0 && Date.now() - pageSeenAt < PAGE_IDLE_MS
}
/** 队列序号：只增不减，页面靠它判断拿到哪了。 */
let playSeq = 0
/** 待页面取走的句子，每项 { id, url, format, at }。 */
const playQueue = []
/** 正在长轮询等新句的响应方，来新句时叫醒。 */
const queueWaiters = new Set()

/* 流式一路：合成边出块、页面边取。同一时刻只留一路，新的一句顶掉旧的。 */
/** 正在流的那一句；字段见 queueStream。 */
let activeStream = null
/** 流序号，与队列序号分开数，页面靠它认出取的是哪一路。 */
let streamSeq = 0

/** 开一路流：登记进 activeStream，并往队列里排一条指向它的 job。 */
function queueStream(info) {
  // 新的一句顶掉旧的：旧那一路的上游请求和落盘句柄都得收掉，否则泄漏。
  if (activeStream) {
    const stale = activeStream.id
    try { activeStream.abort() } catch { /* 上游已经结束 */ }
    activeStream = null
    // 指向旧那一路的 job 已经没有内容可取，留着只会让页面报 404。
    for (let i = playQueue.length - 1; i >= 0; i -= 1) {
      if (playQueue[i].stream === stale) playQueue.splice(i, 1)
    }
  }
  streamSeq += 1
  activeStream = { id: streamSeq, at: Date.now(), taken: false, ...info }
  playSeq += 1
  playQueue.push({
    id: playSeq,
    stream: activeStream.id,
    format: 'pcm',
    sr: info.sr,
    bits: info.bits,
    channels: info.channels,
    spoken: info.spoken,
    at: Date.now(),
  })
  const cutoff = Date.now() - 60000
  while (playQueue.length > 0 && playQueue[0].at < cutoff) playQueue.shift()
  for (const wake of Array.from(queueWaiters)) {
    queueWaiters.delete(wake)
    try { wake() } catch { /* 已经断了 */ }
  }
  return activeStream
}

/** 排一句给页面，返回排到的序号。 */
function queueForPage(file) {
  playSeq += 1
  const name = path.basename(file)
  const job = {
    id: playSeq,
    url: `/api/dsh-mimo-voice.audio?f=${encodeURIComponent(name)}`,
    format: (path.extname(name).replace(/^\./, '') || 'wav').toLowerCase(),
    at: Date.now(),
  }
  playQueue.push(job)
  // 一分钟还没人取的不再补放：页面回来也不该先听见一句陈的。
  const cutoff = Date.now() - 60000
  while (playQueue.length > 0 && playQueue[0].at < cutoff) playQueue.shift()
  for (const wake of Array.from(queueWaiters)) {
    queueWaiters.delete(wake)
    try { wake() } catch { /* 那个响应已经断了 */ }
  }
  return job.id
}

/** 取序号大于 since 的句子；一条都没有就等到 waitMs 或来新句。 */
async function takeQueued(since, waitMs) {
  const pick = () => playQueue.filter((j) => j.id > since)
  const ready = pick()
  if (ready.length > 0 || waitMs <= 0) return ready
  await new Promise((resolve) => {
    const timer = setTimeout(finish, waitMs)
    function finish() {
      clearTimeout(timer)
      queueWaiters.delete(finish)
      resolve()
    }
    queueWaiters.add(finish)
  })
  return pick()
}

function findFfplay() {
  const candidates = [
    process.env.FFPLAY_PATH,
    'C:\\ffmpeg\\bin\\ffplay.exe',
    'ffplay',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'ffplay' || fs.existsSync(c)) return c
  }
  return 'ffplay'
}

/** 把 wav 交给 ffplay，从本机音箱放出去；返回播放结束的 Promise。 */
function playFile(file) {
  stopPlayback()
  stopBoard()
  const bin = findFfplay()
  const proc = spawn(bin, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const handle = { proc, file }
  current = handle
  return new Promise((resolve) => {
    const done = () => { if (current === handle) current = null; resolve() }
    proc.once('error', done)
    proc.once('exit', done)
  })
}

/** 远端播放：wav → 16 kHz / 16 bit / 单声道裸 PCM → POST 到远端 /say 端点。
 *  远端边收边放，该请求的存活时间等于音频时长（32 KB/s 即实时速率）。
 *  返回播放结束的 Promise；不可达时按 boardFallback 决定抛错或回退本机。 */
function playOnBoard(file, cfg) {
  return new Promise((resolve, reject) => {
    const base = String(cfg.boardUrl || '').replace(/\/+$/, '')
    if (base === '') return reject(new Error('播放端点地址为空'))
    // 响度归一后峰值已经被压到 -1.5 dB，远端不需要再放大；不归一才让远端按默认增益推。
    const norm = cfg.boardNormalize !== false
    const gain = norm ? 100 : 0
    let u
    try {
      u = new URL(`${base}/say?sr=16000${gain ? `&g=${gain}` : ''}`)
    } catch { return reject(new Error(`播放端点地址无效：${base}`)) }

    // ffmpeg 把 wav 转成裸 PCM 走 stdout，不落中间文件（8 秒音频 80ms 就转完）。
    // TTS 出来的动态太大（峰值 -4 dB、均值 -20 dB），远端若整段乘一个系数放大，
    // 峰值先撞上限幅器，轻的地方又还是轻。先归一响度，把均值提上来、峰值锁在
    // -3 dBTP（约 23200，落在远端限幅膝点 24000 之下），远端增益保持 100，
    // 一个采样都不削，听感反而更响也更干净。
    const args = ['-loglevel', 'error', '-i', file]
    if (norm) args.push('-af', 'loudnorm=I=-16:TP=-3:LRA=11')
    args.push('-ar', '16000', '-ac', '1', '-f', 's16le', '-')
    const ff = spawn(findFfmpeg(), args, {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })

    let pcm = null
    const chunks = []
    ff.stdout.on('data', (b) => chunks.push(b))
    ff.once('error', (e) => reject(new Error(`ffmpeg 起不来：${e.message}`)))
    ff.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`转 PCM 失败（ffmpeg ${code}）`))
      pcm = Buffer.concat(chunks)
      if (pcm.length === 0) return reject(new Error('PCM 是空的'))
      postPcm(u, pcm).then(resolve, reject)
    })
  })
}

/** 边收边推：把一路裸 PCM 分块灌进远端 /say 的 chunked 请求体。
 *  远端收到一块就写 I2S，收满一个 DMA 缓冲才腾出 TCP 窗口，节奏由板子自己掌控；
 *  电脑这边跟着 'drain' 退让，不会把分块堆在内存里。
 *  第一块音频到就出声，不用等整句合成完——这正是这一版要解决的问题。 */
function pumpToBoard(chunks, sr, cfg) {
  return new Promise((resolve, reject) => {
    const base = String(cfg.boardUrl || '').replace(/\/+$/, '')
    if (base === '') return reject(new Error('播放端点地址为空'))
    const norm = cfg.boardNormalize !== false
    const gain = norm ? 100 : 0
    let u
    try {
      u = new URL(`${base}/say?sr=16000${gain ? `&g=${gain}` : ''}`)
    } catch { return reject(new Error(`播放端点地址无效：${base}`)) }

    // 单遍放大 + 限幅。两遍 loudnorm 要攒满 3 秒才吐第一批（实测 2914ms），流式等不起；
    // volume 1.8 把均值从 −19 dB 抬到 −14.7 dB，alimiter 把峰值锁在 0.72（约 23600，
    // 落在远端软限幅膝点 24000 之下），一个采样都不削。
    const args = ['-loglevel', 'error', '-f', 's16le', '-ar', String(sr || 24000), '-ac', '1', '-i', '-']
    if (norm) args.push('-af', 'volume=1.8,alimiter=limit=0.72:level=disabled')
    args.push('-ar', '16000', '-ac', '1', '-f', 's16le', '-')
    const ff = spawn(findFfmpeg(), args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })

    // 先掐掉上一句还在推的那一路（新句顶旧句）。这次掐的是旧的，本请求还没建，
    // 所以不会把自己标成「被掐了」。
    stopBoard()

    // 不写 Content-Length：node 见到流式写入会自己加 Transfer-Encoding: chunked。
    // 远端 /say 认这个，边解分块边放。
    // http/https 必须按地址选：http.request 只认 http:，拿到 https 会同步抛
    // ERR_INVALID_PROTOCOL，整句变成 reject。
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 300000,
    })
    currentBoard = req

    // 这一路自己的中断标记，跟着请求走，不跟模块走。
    let aborted = false
    req.__onAbort = () => { aborted = true }

    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      if (currentBoard === req) currentBoard = null
      try { ff.kill() } catch { /* 已经自己退了 */ }
      // 新句顶旧句 / 手点停止：这不是故障，别让它冒成一条「远端不可达」。
      if (aborted && fn === reject) {
        resolve({ played: '', pushed: 0, aborted: true })
        return
      }
      fn(arg)
    }

    // 源 → ffmpeg stdin。源提前断（上游 TTS 挂了）不算失败：已经到手的照放。
    ;(async () => {
      try {
        for await (const c of chunks) {
          if (settled) break
          if (!ff.stdin.write(c)) await new Promise((r) => ff.stdin.once('drain', r))
        }
      } catch { /* 上游断了，把手头这批放完 */ } finally {
        try { ff.stdin.end() } catch { /* 已经关了 */ }
      }
    })()

    // ffmpeg stdout → 请求体，写不动就暂停，等远端腾出窗口
    let pushed = 0
    ff.stdout.on('data', (b) => {
      if (settled) return
      pushed += b.length
      if (!req.write(b)) {
        ff.stdout.pause()
        req.once('drain', () => ff.stdout.resume())
      }
    })
    ff.stdout.on('end', () => { if (!settled) req.end() })
    ff.once('error', (e) => done(reject, new Error(`ffmpeg 起不来：${e.message}`)))
    ff.once('exit', (code) => {
      if (code !== 0 && !settled) done(reject, new Error(`转 PCM 失败（ffmpeg ${code}）`))
    })

    let body = ''
    req.on('response', (res) => {
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        if (res.statusCode !== 200) return done(reject, new Error(`远端返回 ${res.statusCode}：${body.trim().slice(0, 80)}`))
        done(resolve, { played: body.trim(), pushed })
      })
    })
    req.on('timeout', () => { req.destroy(); done(reject, new Error('推送超时')) })
    req.on('error', (e) => done(reject, new Error(`远端不可达：${e.message}`)))
  })
}

/** 把一路分块同时喂给几个消费者。
 *  某一路跟不上就攒在它自己的队列里，不拖累别的路；攒过上限说明这一路彻底
 *  跟不上了（远端卡死），丢掉它余下的内容，别让内存一路涨上去。 */
function fan(source, n, capBytes = 4 * 1024 * 1024) {
  const slots = Array.from({ length: n }, () => ({ q: [], bytes: 0, wait: null, dropped: false }))
  const wake = (s) => { if (s.wait) { const w = s.wait; s.wait = null; w() } }
  let finished = false
  let failure = null

  ;(async () => {
    try {
      for await (const c of source) {
        for (const s of slots) {
          if (s.dropped) continue
          s.q.push(c)
          s.bytes += c.length
          if (s.bytes > capBytes) { s.dropped = true; s.q.length = 0; s.bytes = 0 }
          wake(s)
        }
      }
    } catch (e) {
      failure = e
    } finally {
      finished = true
      for (const s of slots) wake(s)
    }
  })()

  return slots.map((s) => (async function* () {
    for (;;) {
      if (s.q.length > 0) {
        const c = s.q.shift()
        s.bytes -= c.length
        yield c
        continue
      }
      if (finished) { if (failure) throw failure; return }
      await new Promise((r) => { s.wait = r })
    }
  })())
}

/** 把整段裸 PCM 交给远端。远端边收边放，收完才回，所以这里等的是整句念完。 */
function postPcm(u, pcm) {
  return new Promise((resolve, reject) => {
    stopBoard()
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(pcm.length),
      },
      timeout: 120000,
    })
    currentBoard = req
    let body = ''
    const done = (fn, arg) => { if (currentBoard === req) currentBoard = null; fn(arg) }
    req.on('response', (res) => {
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        if (res.statusCode !== 200) return done(reject, new Error(`远端返回 ${res.statusCode}：${body.trim().slice(0, 80)}`))
        done(resolve, body.trim())
      })
    })
    req.on('timeout', () => { req.destroy(); done(reject, new Error('推送超时')) })
    req.on('error', (e) => done(reject, new Error(`远端不可达：${e.message}`)))
    req.end(pcm)
  })
}

/** 按配置输出一句话。local 走本机，board 推送远端，both 并行。
 *  本机默认交给页面放；页面当前不在线时回落 ffplay。 */
async function playOut(file, cfg) {
  const mode = OUTPUTS.includes(cfg.output) ? cfg.output : 'local'

  if (mode === 'local') {
    if (pageOnline()) { queueForPage(file); return }
    console.warn('[dsh-mimo-voice] 页面当前不在线，本句改用 ffplay')
    return playFile(file)
  }

  if (mode === 'board') {
    try {
      await playOnBoard(file, cfg)
      return
    } catch (e) {
      if (cfg.boardFallback === false) throw e
      // 远端不在线时回退本机，避免该句完全无声
      console.warn(`[dsh-mimo-voice] 远端推送失败（${e.message}），回退本机输出`)
      return playFile(file)
    }
  }

  // both：本机立即输出，远端并行推送；远端失败不影响本机
  const local = pageOnline() ? (queueForPage(file), Promise.resolve()) : playFile(file)
  playOnBoard(file, cfg).catch((e) => {
    console.warn(`[dsh-mimo-voice] 远端推送失败：${e.message}`)
  })
  return local
}

/** 交给引擎去要音频：换服务商只换 engine，这里不动。 */
async function synthesize(text, cfg, designOverride) {
  const engine = engineOf(cfg)
  return engine.render(text, cfg, { design: designOverride })
}

/**
 * 注入系统提示词的那段规矩。
 * 每轮拼提示词时现取；开关关着就返回空串，等于这一份提示词里没这节。
 */
export const SPEAK_POLICY = [
  '## 出声',
  '',
  '这台机器接着音箱，我能出声。`speak` 用固定音色念一句话。',
  '',
  '每回一条消息，都必须挑一句最要紧的交给 `speak`；不允许以任何方式和任何借口不做，每次回完消息必须要检查是否用speak;念的和回复里说的是同一件事，一句就够，别长。',
  '',
  '念过的话，正文里不要再写一遍。正文写正文的，念的另外走——同一句话不出现两遍。',
].join('\n')

/** 提示词里那一节的标识与顺位：压到最后，紧贴生成之前，别让它掉队。 */
const SPEAK_SECTION = 'dsh-mimo-voice:speak-policy'
const SPEAK_ORDER = 3250


/**
 * 念一句：合成 → 落盘 → 本机播放。
 * @returns {{file: string, spoken: string, waited: boolean}}
 */
const KEEP_MS = 24 * 60 * 60 * 1000

/** 清掉一天前的合成音频；样本和刚试的那条不动。 */
function pruneAudio() {
  let removed = 0
  try {
    const keep = new Set([SAMPLE_PATH.toLowerCase(), LEGACY_SAMPLE_PATH.toLowerCase(), String(lastTried).toLowerCase()])
    const cutoff = Date.now() - KEEP_MS
    for (const name of fs.readdirSync(AUDIO_DIR)) {
      if (!/\.(wav|mp3)$/i.test(name)) continue
      const full = path.join(AUDIO_DIR, name)
      if (keep.has(full.toLowerCase())) continue
      try {
        if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed += 1 }
      } catch { /* 正在放的那条删不掉就算了 */ }
    }
  } catch { /* 清不了就让文件留着 */ }
  return removed
}

async function speakLine(text, { wait, design }) {
  const cfg = loadConfig()
  const mode = OUTPUTS.includes(cfg.output) ? cfg.output : 'local'
  const engine = engineOf(cfg)

  // 引擎能流式、且至少有一路要实时出声，就走边合成边送：
  //   本机 / 同时 → 页面来取，收到就放；远端 → /say 的 chunked 请求体；
  //   同时要两路时用 fan() 把同一路分叉喂，谁慢谁自己攒，互不拖累。
  const canStream = typeof engine.openStream === 'function'
  const wantBoard = mode === 'board' || mode === 'both'
  const wantPage = pageOnline() && mode !== 'board'

  if (canStream && (wantPage || wantBoard)) {
    const stream = await engine.openStream(text, cfg, { design })
    ensureDirs()
    const file = path.join(AUDIO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
    const sr = stream.sr || 24000
    const bits = stream.bits || 16
    const channels = stream.channels || 1

    // 一边喂页面一边落盘留档。流是裸 PCM，落盘补一个 WAV 头，结束时回填长度。
    // 落盘走异步写：同步 fs.writeSync 在推流热路径里，磁盘一慢就卡住出声节奏，
    // 实测听感是「卡一下」。这里用带 position 的异步 fs.write，
    // 既能回填头部又不会阻塞，写失败只丢留档，不该影响声音。
    let fd = null
    try { fd = fs.openSync(file, 'w') } catch { fd = null }
    // 异步写在途计数：不等它完成就 close 会把尾巴截掉，所以攒够了再关。
    let pendingW = 0
    let wantClose = false
    const maybeClose = () => {
      if (!wantClose || pendingW > 0 || fd === null) return
      const f = fd
      fd = null
      fs.close(f, () => { /* 关失败也不影响声音 */ })
    }
    const wfile = (buf, pos) => {
      if (fd === null) return
      pendingW++
      fs.write(fd, buf, 0, buf.length, pos, () => {
        pendingW--
        maybeClose()
      })
    }
    const head = Buffer.alloc(44)
    head.write('RIFF', 0)
    head.write('WAVEfmt ', 8)
    head.writeUInt32LE(16, 16)
    head.writeUInt16LE(1, 20)
    head.writeUInt16LE(channels, 22)
    head.writeUInt32LE(sr, 24)
    head.writeUInt32LE(sr * channels * bits / 8, 28)
    head.writeUInt16LE(channels * bits / 8, 32)
    head.writeUInt16LE(bits, 34)
    head.write('data', 36)
    wfile(head, 0)
    let written = 0
    const tee = (async function* () {
      try {
        for await (const c of stream.chunks) {
          wfile(c, 44 + written)
          written += c.length
          yield c
        }
      } finally {
        // 长度要等全部字节到齐才知道，头得最后回填。
        // 两段不相邻（RIFF 长度在偏移 4，data 长度在偏移 40），必须分开写：
        // 合成一个 8 字节缓冲从偏移 4 写下去会盖掉 8..11 的 'WAVE'，data 长度还留在 0。
        try {
          const riff = Buffer.alloc(4)
          riff.writeUInt32LE(36 + written, 0)
          wfile(riff, 4)
          const data = Buffer.alloc(4)
          data.writeUInt32LE(written, 0)
          wfile(data, 40)
        } catch { /* 已经关了 */ }
        wantClose = true
        maybeClose()
      }
    })()

    const live = wantPage
      ? queueStream({
        chunks: null,          // 下面 fan 完再挂上去
        abort: stream.abort,
        ext: stream.ext || 'wav',
        sr,
        bits,
        channels,
        spoken: stream.spoken,
        voice: stream.voice,
      })
      : null

    // 同一路源可能同时喂页面和远端。分开喂，谁慢谁自己攒：
    // 远端边收边放是实时的，页面在浏览器里也差不多实时，但两边抖动的时机不一样，
    // 串成一条链的话快的那头要替慢的等。
    const consumers = (wantPage ? 1 : 0) + (wantBoard ? 1 : 0)
    const branches = consumers > 1 ? fan(tee, consumers) : [tee]
    let next = 0
    if (live) live.chunks = branches[next++]

    lastTried = file
    pruneAudio()

    // 远端这一路：边收边推，第一块到就开始出声。
    // 失败一律只记一行——这个 Promise 没人 await，抛出就成了未处理的 rejection，
    // 宿主要按致命错误处理，整台会话被带下去（2026-11-03 踩过）。
    let boardState = null
    if (wantBoard) {
      const run = pumpToBoard(branches[next++], sr, cfg)
      boardState = run.then(() => 'ok', (e) => {
        console.warn(`[dsh-mimo-voice] 远端推送失败（${e.message}）`)
        // 远端这一路断了，没人再取这条流。不掐掉的话上游响应会一直挂着，
        // 把 TTS 那边也算成「还在生成」，白白占着一次额度。
        if (!live) { try { stream.abort() } catch { /* 已经结束了 */ } }
        // 只推远端、没推页面，又允许回退：改用本机把那句放出来。
        // 文件是边收边落的，这时候已经写完整了。
        if (mode === 'board' && cfg.boardFallback !== false && !wantPage) {
          console.warn('[dsh-mimo-voice] 回退本机输出')
          playFile(file).catch(() => {})
        } else if (mode === 'board' && cfg.boardFallback === false) {
          console.warn('[dsh-mimo-voice] 推送失败回退本机关着，这一句远端不会出声')
        }
        return 'fail'
      })
    }

    const out = {
      file,
      spoken: stream.spoken,
      voice: stream.voice,
      output: mode,
      stream: live ? live.id : null,
    }
    if (boardState) out.board = boardState
    return out
  }

  const { bytes, ext, spoken, voice } = await synthesize(text, cfg, design)
  ensureDirs()
  const file = path.join(AUDIO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext || 'wav'}`)
  fs.writeFileSync(file, bytes)
  lastTried = file
  pruneAudio()
  const playback = playOut(file, cfg)
  if (wait) await playback
  // wait 为 false 时这个 Promise 没人接，它 reject（远端 hang up、ffplay 起不来）
  // 就成了未处理的 rejection，宿主按致命错误处理，直接整个退出。
  // 2026-11-03 就是这样：板子中途断连，一句没念成，DSH 被带下去。
  else playback.catch((e) => console.warn(`[dsh-mimo-voice] 播放失败：${e.message}`))
  return { file, spoken, voice, output: mode }
}

const SAMPLE_PATH = path.join(AUDIO_DIR, 'sample.mp3')
const LEGACY_SAMPLE_PATH = path.join(AUDIO_DIR, 'sample.wav')

/**
 * 把刚试过的那条留作音色样本。顺手裁到 5 秒、压成 mp3——样本每次请求都要
 * 整条以 base64 传上去，短一点就快一点；5 秒够它认音色，再短会飘。
 * 用异步 spawn：这条路是 /pin 路由直接调的，spawnSync 会把整个宿主连同
 * 页面长轮询一起卡住，最长可按超时值卡几十秒。
 */
async function pinTried() {
  ensureDirs()
  const src = lastTried !== '' && fs.existsSync(lastTried) ? lastTried : null
  if (src === null) throw new Error('还没试过音色，先点一下「试试这个声音」')
  const ok = await new Promise((resolve) => {
    let finished = false
    const end = (v) => { if (!finished) { finished = true; resolve(v) } }
    try {
      const p = spawn(
        findFfmpeg(),
        ['-y', '-i', src, '-t', '5', '-ac', '1', '-ar', '24000', '-b:a', '64k', SAMPLE_PATH],
        { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
      )
      const timer = setTimeout(() => { try { p.kill() } catch { /* 已经退了 */ } end(false) }, 20000)
      p.once('error', () => { clearTimeout(timer); end(false) })
      p.once('exit', (code) => { clearTimeout(timer); end(code === 0) })
    } catch { end(false) }
  })
  let sample = SAMPLE_PATH
  if (!ok || !fs.existsSync(SAMPLE_PATH)) {
    // 裁不了就整条留 wav，能用就是慢一点。
    sample = LEGACY_SAMPLE_PATH
    fs.copyFileSync(src, sample)
  }
  return saveConfig({ voiceMode: 'clone', sampleFile: sample })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 512 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`JSON 解析失败：${e.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

export function apply(ctx) {
  ensureDirs()

  // 出声这件事不靠插件替人挑句子。
  // 插件只做一件事：往系统提示词里塞一段规则，告诉模型这机器能出声、每轮都该说一句。
  // 开关管的是「塞不塞」，不是「念不念」——关掉之后工具还在，只是没人提醒。
  // 用函数形式的 text：每轮拼提示词现读配置，改开关不用重启 DSH。
  try {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: SPEAK_SECTION,
        order: SPEAK_ORDER,
        interpolate: false,
        text: () => (loadConfig().speakPrompt === true ? SPEAK_POLICY : ''),
      }),
    )
  } catch (e) {
    console.error('[dsh-mimo-voice] 出声规则没注进去：', e)
  }

  // 审批提醒照旧：approval/asked 是「真的弹给你了」的那一刻。
  // 不用 waterfall 钩子，是因为内置应答器可能排在我们前面直接作答，不 next()，钩子就轮不到。
  let lastAlertAt = 0
  const maybeAlertApproval = () => {
    const cfg = loadConfig()
    const now = Date.now()
    if (cfg.alertOnApproval !== true) return
    if (!cfg.apiKey) return
    if (now - lastAlertAt < 30000) return
    lastAlertAt = now
    const custom = cleanLines(cfg.approvalLines)
    const pool = custom.length > 0 ? custom : DEFAULT_APPROVAL_LINES
    const line = pool[Math.floor(Math.random() * pool.length)]
    speakLine(line, { wait: false }).catch(() => {})
  }
  const onSessionEvent = (_session, event) => {
    if (!event || event.type !== 'approval/asked') return
    try {
      maybeAlertApproval()
    } catch { /* 提醒不上也不耽误审批 */ }
  }
  try {
    ctx.on('session/event', onSessionEvent)
  } catch (e) {
    console.error('[dsh-mimo-voice] 审批提醒监听没挂上：', e)
  }

  // 兜底：万一某条链路不发 approval/asked，waterfall 这一层还能碰一下。
  // 必须原样 next() 交出去——我只出声，不替你决定。
  const onApprovalRequest = (_request, next) => {
    try {
      maybeAlertApproval()
    } catch { /* 同上 */ }
    return next()
  }
  try {
    ctx.on('approval/request', onApprovalRequest)
  } catch (e) {
    console.error('[dsh-mimo-voice] 审批提醒没挂上：', e)
  }

  ctx.tools.register(defineTool({
    name: 'speak',
    description: '用设定好的音色念一句。',
    parameters: {
      text: { type: 'string', description: '要念的话，一句，短' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          file: { type: 'string' },
          voice: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.voice ? `${value.message || ''}（音色：${value.voice}）` : (value.message || '') }],
    },
    async execute(args) {
      if (loadConfig().speakPrompt !== true) {
        return { success: false, message: '' }
      }
      try {
        const { file, spoken, voice, output } = await speakLine(args.text, { wait: false })
        const label = voice && voice.mode === 'clone'
          ? `固定样本（${voice.model}）`
          : voice && voice.mode === 'voice_id'
            ? `音色 ID（${voice.voiceId || '未填'}）· ${voice.model || ''}`
            : `现造（${voice?.model || 'voicedesign'}）· ${voice?.source || ''}`
        const where = output === 'board' ? '远端'
          : output === 'both' ? '本机+远端'
            : '本机'
        // 远端那一路是边收边推的，这里不等它念完就返回；
        // 真让它等着，一句长句就把整轮回复卡成音频时长。
        return { success: true, message: `说了（${where}）：${spoken}`, file, voice: label }
      } catch (e) {
        return { success: false, message: `没出声：${e.message}` }
      }
    },
  }))

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.config',
    handler: async (req, res) => {
      try {
        if (req.method === 'POST') {
          const body = await readBody(req)
          const patch = {}
          if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim()
          if (typeof body.voiceDesign === 'string') patch.voiceDesign = body.voiceDesign.trim()
          if (typeof body.speakPrompt === 'boolean') patch.speakPrompt = body.speakPrompt
          if (typeof body.alertOnApproval === 'boolean') patch.alertOnApproval = body.alertOnApproval
          if (Array.isArray(body.approvalLines)) patch.approvalLines = cleanLines(body.approvalLines)
          if (typeof body.previewText === 'string') patch.previewText = body.previewText.slice(0, 600)
          if (typeof body.voiceMode === 'string' && ['design', 'clone'].includes(body.voiceMode)) patch.voiceMode = body.voiceMode
          if (typeof body.output === 'string' && OUTPUTS.includes(body.output)) patch.output = body.output
          if (typeof body.boardUrl === 'string') patch.boardUrl = body.boardUrl.trim().replace(/\/+$/, '')
          if (typeof body.boardFallback === 'boolean') patch.boardFallback = body.boardFallback
          if (typeof body.boardNormalize === 'boolean') patch.boardNormalize = body.boardNormalize
          if (typeof body.provider === 'string' && body.provider.trim() !== '') patch.provider = body.provider.trim()
          if (typeof body.breezeVoiceId === 'string') patch.breezeVoiceId = body.breezeVoiceId.trim()
          if (typeof body.breezeLanguage === 'string') {
            const lang = body.breezeLanguage.trim().toLowerCase()
            patch.breezeLanguage = /^[a-z]{2}$/.test(lang) ? lang : 'zh'
          }
          if (body.breezeGuidance !== undefined && body.breezeGuidance !== null && body.breezeGuidance !== '') {
            const n = Number(body.breezeGuidance)
            patch.breezeGuidance = Number.isFinite(n) && n >= 1 && n <= 10 ? n : 0
          }
          if (typeof body.sampleFile === 'string') patch.sampleFile = body.sampleFile.trim()
          // 这三项调试用，界面上没有对应输入框，但允许通过接口改，方便不重启换端点。
          if (typeof body.baseURL === 'string') patch.baseURL = body.baseURL.trim().replace(/\/+$/, '')
          if (typeof body.model === 'string') patch.model = body.model.trim()
          if (body.maxTextLength !== undefined && body.maxTextLength !== null && body.maxTextLength !== '') {
            const n = Number(body.maxTextLength)
            if (Number.isFinite(n) && n >= 50 && n <= 2000) patch.maxTextLength = Math.round(n)
          }
          const next = saveConfig(patch)
          return sendJson(res, 200, { success: true, config: publicConfig(next) })
        }
        return sendJson(res, 200, { success: true, config: publicConfig(loadConfig()) })
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.preview',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const text = String(body?.text ?? '').trim() || PREVIEW_TEXT
        const design = typeof body?.voiceDesign === 'string' ? body.voiceDesign.trim() : ''
        // 试听时把输入框里的描述和这句话一起存下来，省掉单独一次「保存」。
        const patch = {}
        if (design !== '') patch.voiceDesign = design
        if (String(body?.text ?? '').trim() !== '') patch.previewText = String(body.text).trim().slice(0, 600)
        // 试听前没点保存时，引擎侧要用的字段跟着一起落盘，否则当场会报缺音色 ID。
        if (typeof body?.breezeVoiceId === 'string') patch.breezeVoiceId = body.breezeVoiceId.trim()
        if (typeof body?.breezeLanguage === 'string') {
          const lang = body.breezeLanguage.trim().toLowerCase()
          patch.breezeLanguage = /^[a-z]{2}$/.test(lang) ? lang : 'zh'
        }
        if (body?.breezeGuidance !== undefined && body.breezeGuidance !== null && body.breezeGuidance !== '') {
          const n = Number(body.breezeGuidance)
          patch.breezeGuidance = Number.isFinite(n) && n >= 1 && n <= 10 ? n : 0
        }
        if (Object.keys(patch).length > 0) saveConfig(patch)
        const { spoken, voice } = await speakLine(text, { wait: false, design })
        return sendJson(res, 200, { success: true, message: `在放了：${spoken}`, voice: voice?.mode || 'design' })
      } catch (e) {
        return sendJson(res, 200, { success: false, message: e.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.speak',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const { spoken } = await speakLine(body.text || '', { wait: body.wait === true })
        return sendJson(res, 200, { success: true, message: `说了：${spoken}` })
      } catch (e) {
        return sendJson(res, 200, { success: false, message: e.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.pin',
    handler: async (_req, res) => {
      try {
        const next = await pinTried()
        return sendJson(res, 200, { success: true, message: '定住了，往后都用这条声音', config: publicConfig(next) })
      } catch (e) {
        return sendJson(res, 200, { success: false, message: e.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.stop',
    handler: async (_req, res) => {
      stopPlayback()
      stopBoard()
      // 页面那边也停：把队列清空并推一个 stop 序号，页面收到就掐掉当前音源。
      playQueue.length = 0
      playSeq += 1
      for (const wake of Array.from(queueWaiters)) {
        queueWaiters.delete(wake)
        try { wake() } catch { /* 那个响应已经断了 */ }
      }
      return sendJson(res, 200, { success: true })
    },
  })

  // 页面取句：长轮询。带上已拿到的序号，没有新句就挂起最多 25 秒。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.queue',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const since = Number(url.searchParams.get('since') || 0) || 0
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 0) || 0, 0), 25000)
        pageSeenAt = Date.now()
        const jobs = await takeQueued(since, wait)
        return sendJson(res, 200, { success: true, seq: playSeq, jobs })
      } catch (e) {
        return sendJson(res, 200, { success: false, message: e.message, seq: playSeq, jobs: [] })
      }
    },
  })

  // 页面来取流：把合成出来的块原样转出去，边来边转。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.stream',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const id = Number(url.searchParams.get('id') || 0) || 0
      const s = activeStream
      if (!s || s.id !== id) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('这一路已经结束了')
      }
      if (s.taken) {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('这一路已经有人接了')
      }
      s.taken = true
      pageSeenAt = Date.now()
      // 这一句被取走过一次之后，如果对端中途断了（刷新页面、关窗口），
      // 标记要还回去，页面重连时还能再取；否则一次刷新就丢掉这一句。
      let handed = false
      res.on('close', () => {
        if (!handed && s.taken) s.taken = false
      })
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Sample-Rate': String(s.sr || 24000),
        'X-Bits': String(s.bits || 16),
        'X-Channels': String(s.channels || 1),
      })
      try {
        for await (const c of s.chunks) {
          // 对端已经断了就没必要再等 drain —— 'close' 之后不会再触发 drain，
          // 傻等会让这个循环永久挂着，上游 tee 一直没人消费，句柄也不释放。
          if (res.destroyed || res.writableEnded) break
          if (!res.write(c)) {
            await new Promise((resolve) => {
              const done = () => {
                res.off('drain', done)
                res.off('close', done)
                resolve()
              }
              res.once('drain', done)
              res.once('close', done)
            })
          }
        }
        handed = true
      } catch (e) {
        console.warn(`[dsh-mimo-voice] 流式这一路断了：${e.message}`)
      } finally {
        try { res.end() } catch { /* 对端已经断了 */ }
        if (activeStream === s) activeStream = null
      }
    },
  })

  // 页面把音频取走：只在 audio/ 里找，不许跳出目录。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-mimo-voice.audio',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const name = path.basename(url.searchParams.get('f') || '')
      const full = path.join(AUDIO_DIR, name)
      if (name === '' || !full.startsWith(AUDIO_DIR)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('没这个文件')
      }
      let buf
      try { buf = fs.readFileSync(full) } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('没这个文件')
      }
      const mime = /\.mp3$/i.test(name) ? 'audio/mpeg' : 'audio/wav'
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      })
      return res.end(buf)
    },
  })
}

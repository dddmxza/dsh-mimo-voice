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
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
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

function stopBoard() {
  if (currentBoard) {
    try { currentBoard.destroy() } catch { /* 已经完了 */ }
    currentBoard = null
  }
}

/* ── 页面播放：宿主只排队，浏览器半边来取 ───────────────────────────────
 * 浏览器侧不能合成音频，所以走「宿主排、页面取」：每念一句把文件排进队列，
 * 页面长轮询取走，自己解码播放。本机输出因此不再依赖机器上装没装 ffplay。
 * 页面有没有来取过，只用来在日志里说一句，不影响发送。
 */
/** 本进程启动以来页面取走过音频没有。只用于日志判断，不做回退。 */
let pageSeen = false
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
/** 等流开头的 waiter，长轮询用。 */
const streamWaiters = new Set()

function wakeStreamWaiters() {
  for (const wake of Array.from(streamWaiters)) {
    streamWaiters.delete(wake)
    try { wake() } catch { /* 那个响应已经断了 */ }
  }
}

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
  wakeStreamWaiters()
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
    let u
    try { u = new URL(`${base}/say?sr=16000`) } catch { return reject(new Error(`播放端点地址无效：${base}`)) }

    // ffmpeg 把 wav 转成裸 PCM 走 stdout，不落中间文件（8 秒音频 80ms 就转完）
    const ff = spawn(findFfmpeg(), [
      '-loglevel', 'error', '-i', file,
      '-ar', '16000', '-ac', '1', '-f', 's16le', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })

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

/** 把整段裸 PCM 交给远端。远端边收边放，收完才回，所以这里等的是整句念完。 */
function postPcm(u, pcm) {
  return new Promise((resolve, reject) => {
    stopBoard()
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 80,
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
 *  本机默认交给页面放；页面一次都没来取过时说明客户端没加载起来，回落 ffplay。 */
async function playOut(file, cfg) {
  const mode = OUTPUTS.includes(cfg.output) ? cfg.output : 'local'

  if (mode === 'local') {
    if (pageSeen) { queueForPage(file); return }
    console.warn('[dsh-mimo-voice] 页面还没有来取过音频，本句改用 ffplay')
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
  const local = pageSeen ? (queueForPage(file), Promise.resolve()) : playFile(file)
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

  // 页面在线、引擎支持流式：边合成边送，页面边收边放，不用等整段落地。
  if (pageSeen && mode !== 'board' && typeof engine.openStream === 'function') {
    const stream = await engine.openStream(text, cfg, { design })
    ensureDirs()
    const file = path.join(AUDIO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
    const sr = stream.sr || 24000
    const bits = stream.bits || 16
    const channels = stream.channels || 1

    // 一边喂页面一边落盘留档。流是裸 PCM，落盘补一个 WAV 头，结束时回填长度。
    const fd = fs.openSync(file, 'w')
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
    fs.writeSync(fd, head, 0, 44, 0)
    let written = 0
    const tee = (async function* () {
      try {
        for await (const c of stream.chunks) {
          try { fs.writeSync(fd, c, 0, c.length, 44 + written); written += c.length } catch { /* 磁盘满了也不该断声音 */ }
          yield c
        }
      } finally {
        try {
          head.writeUInt32LE(36 + written, 4)
          head.writeUInt32LE(written, 40)
          fs.writeSync(fd, head, 0, 44, 0)
          fs.closeSync(fd)
        } catch { /* 已经关了 */ }
      }
    })()

    const live = queueStream({
      chunks: tee,
      abort: stream.abort,
      ext: stream.ext || 'wav',
      sr,
      bits,
      channels,
      spoken: stream.spoken,
      voice: stream.voice,
    })
    lastTried = file
    pruneAudio()

    // 远端并行推一路（both），失败只记一行。
    if (mode === 'both') {
      playOnBoard(file, cfg).catch((e) => {
        console.warn(`[dsh-mimo-voice] 远端推送流式这一路跳过：${e.message}`)
      })
    }
    return { file, spoken: stream.spoken, voice: stream.voice, output: mode, stream: live.id }
  }

  const { bytes, ext, spoken, voice } = await synthesize(text, cfg, design)
  ensureDirs()
  const file = path.join(AUDIO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext || 'wav'}`)
  fs.writeFileSync(file, bytes)
  lastTried = file
  pruneAudio()
  const playback = playOut(file, cfg)
  if (wait) await playback
  return { file, spoken, voice, output: mode }
}

const SAMPLE_PATH = path.join(AUDIO_DIR, 'sample.mp3')
const LEGACY_SAMPLE_PATH = path.join(AUDIO_DIR, 'sample.wav')

/**
 * 把刚试过的那条留作音色样本。顺手裁到 5 秒、压成 mp3——样本每次请求都要
 * 整条以 base64 传上去，短一点就快一点；5 秒够它认音色，再短会飘。
 */
function pinTried() {
  ensureDirs()
  const src = lastTried !== '' && fs.existsSync(lastTried) ? lastTried : null
  if (src === null) throw new Error('还没试过音色，先点一下「试试这个声音」')
  const cropped = spawnSync(
    findFfmpeg(),
    ['-y', '-i', src, '-t', '5', '-ac', '1', '-ar', '24000', '-b:a', '64k', SAMPLE_PATH],
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, timeout: 60000 },
  )
  let sample = SAMPLE_PATH
  if (cropped.error || cropped.status !== 0 || !fs.existsSync(SAMPLE_PATH)) {
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
        const next = pinTried()
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
        pageSeen = true
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
      pageSeen = true
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Sample-Rate': String(s.sr || 24000),
        'X-Bits': String(s.bits || 16),
        'X-Channels': String(s.channels || 1),
      })
      try {
        for await (const c of s.chunks) {
          if (!res.write(c)) await new Promise((r) => res.once('drain', r))
        }
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

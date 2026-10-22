/**
 * dsh-mimo-voice — 宿主半边。
 *
 * 职责：把一句话发给小米 MiMo TTS（voicedesign 出声），落盘到 audio/，再用
 * ffplay 从本机音箱放出来。设置项不走 settings 命名空间（web profile 有白名单，
 * 第三方命名空间不在名单里就写不进去），改成插件自己的 config.json + HTTP 路由，
 * 浏览器半个边直接 fetch 它。
 *
 * 路由：
 *   GET  /api/dsh-mimo-voice.config   读设置（apiKey 只回 hasKey 布尔，绝不回原文）
 *   POST /api/dsh-mimo-voice.config   写设置 { apiKey?, voiceDesign?, autoSpeak?, alertOnApproval?, voiceMode? }
 *   POST /api/dsh-mimo-voice.preview  试听：念 body.text，不传就念固定的那首
 *   POST /api/dsh-mimo-voice.pin      把刚试的那条定为音色样本
 *   POST /api/dsh-mimo-voice.speak    念一段指定文本
 *   POST /api/dsh-mimo-voice.stop     立刻掐掉正在放的那句
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-mimo-voice'
export const inject = ['tools', 'webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AUDIO_DIR = path.join(ROOT, 'audio')
const CONFIG_PATH = path.join(ROOT, 'config.json')
// 密钥单独放 .env，跟 config.json 分开：config.json 是可以传的默认值，.env 不传。
const ENV_PATH = path.join(ROOT, '.env')
const ENV_KEY = 'MIMO_API_KEY'

/** 试听固定文本：用户指定的那句。 */
const PREVIEW_TEXT = '红豆生南国，春来发几枝。愿君多采撷，此物最相思。'

/** 有人卡在审批上时念的话。开头那个括号是音频标签，只改这一句的语气。 */
const APPROVAL_LINES = [
  '(语速快，很焦急)你过来一下，卡住了，等你点一下。',
  '(语速快，很焦急)这事儿得你点头，我停在这儿了。',
  '(语速快，很焦急)喂，看我一眼——等着你按。',
  '(语速快，很焦急)我这边停住了，你说句话我就往下走。',
  '(语速快，很焦急)有个按钮得你按，我不动。',
  '(语速快，很焦急)听见没，我卡住了，回来。',
]

const DEFAULT_VOICE_DESIGN = [
  '三十二岁左右的成年女性，中低音，嗓音偏磁、带一点烟嗓的毛边，厚而不浑。',
  '语气从容带点居高临下，不撒娇不哄人，句尾停顿利落。',
  '语速中等偏慢，重音落在句尾，像懒得解释第二遍。',
].join('')

/** 出厂配置：key 故意留空，等用户在设置页自己填。 */
const DEFAULT_CONFIG = {
  apiKey: '',
  voiceDesign: DEFAULT_VOICE_DESIGN,
  autoSpeak: false,
  // 卡在审批上时要不要吭一声。
  alertOnApproval: false,
  // design = 每次按描述现造音色（每次都不一样）；clone = 用固定样本，声音是同一个。
  voiceMode: 'design',
  sampleFile: '',
  baseURL: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts-voicedesign',
  maxTextLength: 600,
}

const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'

function ensureDirs() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
}

/** 读 .env 里那一行 MIMO_API_KEY=...；文件不在就当没配。 */
function readEnvKey() {
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      if (m[1] !== ENV_KEY) continue
      return m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* 没有就是没配 */ }
  return ''
}

/** 只动 MIMO_API_KEY 那一行，别的行原样留着。key 传空串就把它删掉。 */
function writeEnvKey(key) {
  let lines = []
  try {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
  } catch { /* 头一次写 */ }
  const kept = lines.filter((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=/.exec(line)
    return !(m && m[1] === ENV_KEY)
  })
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  if (key !== '') kept.push(`${ENV_KEY}=${key}`)
  fs.writeFileSync(ENV_PATH, kept.length === 0 ? '' : kept.join('\n') + '\n', 'utf8')
}

function loadConfig() {
  ensureDirs()
  let cfg = { ...DEFAULT_CONFIG }
  try {
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  } catch { /* 没有配置文件就用默认 */ }
  // 密钥优先取 .env；环境变量里也有就让环境变量赢一手，方便临时覆盖。
  cfg.apiKey = process.env[ENV_KEY]?.trim() || readEnvKey() || cfg.apiKey || ''
  return cfg
}

function saveConfig(patch) {
  const { apiKey, ...rest } = patch
  const next = { ...loadConfig(), ...rest }
  if (typeof apiKey === 'string') {
    writeEnvKey(apiKey.trim())
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
    autoSpeak: cfg.autoSpeak === true,
    alertOnApproval: cfg.alertOnApproval === true,
    // pinned：已经在用定下来的那条；canKeep：刚试过一条，可以定下来。
    pinned: cfg.voiceMode === 'clone' && hasSample,
    canKeep: lastTried !== '' && fs.existsSync(lastTried),
    baseURL: cfg.baseURL,
    model: cfg.model,
    previewText: PREVIEW_TEXT,
    audioDir: AUDIO_DIR,
  }
}

/** 一次播放句柄：新的一句进来先掐旧的，不叠音。 */
let current = null

function stopPlayback() {
  if (current && current.proc && current.proc.exitCode === null) {
    try { current.proc.kill() } catch { /* 已经自己退了 */ }
  }
  current = null
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

/** 不走全局 fetch 的 POST：https 直发，返回 { status, text }。 */
function rawPost(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('请求 MiMo 超时（60 秒）')))
    req.end(payload)
  })
}

/** 调 MiMo voicedesign，拿回 wav 字节。designOverride 给了就按它现造（试听用）。 */
async function synthesize(text, cfg, designOverride) {
  if (!cfg.apiKey) throw new Error('还没填 API 密钥（设置 → 插件 → dsh-mimo-voice）')
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) throw new Error('要念的话是空的')
  const cap = Number(cfg.maxTextLength) > 0 ? Number(cfg.maxTextLength) : 600
  const forceDesign = typeof designOverride === 'string' && designOverride.trim() !== ''
  const clone = !forceDesign && cfg.voiceMode === 'clone' && typeof cfg.sampleFile === 'string' && cfg.sampleFile !== '' && fs.existsSync(cfg.sampleFile)
  if (clone) {
    // 固定样本：audio.voice 要样本的 DataURL，模型换成 voiceclone。
    const sample = sampleDataUrl(cfg.sampleFile)
    const body = {
      model: CLONE_MODEL,
      messages: [
        { role: 'user', content: '按这条样本的声音念下面的话。' },
        { role: 'assistant', content: trimmed.slice(0, cap) },
      ],
      audio: { format: 'wav', voice: sample },
      stream: false,
    }
    const target = `${(cfg.baseURL || DEFAULT_CONFIG.baseURL).replace(/\/+$/, '')}/chat/completions`
    const { status, text: raw } = await rawPost(target, { 'api-key': cfg.apiKey }, JSON.stringify(body))
    if (status < 200 || status >= 300) throw new Error(`MiMo 返回 ${status}：${raw.slice(0, 300)}`)
    let json
    try { json = JSON.parse(raw) } catch { throw new Error(`MiMo 回了非 JSON：${raw.slice(0, 200)}`) }
    const b64c = json?.choices?.[0]?.message?.audio?.data
    if (typeof b64c !== 'string' || b64c.length === 0) throw new Error('MiMo 没回音频（voiceclone）')
    return { bytes: Buffer.from(b64c, 'base64'), spoken: json?.choices?.[0]?.final_text_preview || trimmed }
  }
  const body = {
    model: cfg.model || DEFAULT_CONFIG.model,
    messages: [
      // voicedesign：user 那一轮是「音色长什么样」，assistant 那一轮才是要念的字。
      { role: 'user', content: forceDesign ? designOverride.trim() : (cfg.voiceDesign || DEFAULT_VOICE_DESIGN) },
      { role: 'assistant', content: trimmed.slice(0, cap) },
    ],
    audio: { format: 'wav' },
    stream: false,
  }
  const target = `${(cfg.baseURL || DEFAULT_CONFIG.baseURL).replace(/\/+$/, '')}/chat/completions`
  // 不用全局 fetch：宿主进程里 fetch 已被别的插件替换过，会把 TTS 请求当模型流量
  // 改写（塞 system 段），MiMo 的 TTS 模型见到 system role 直接 400。走 node:https 直发。
  const { status, text: raw } = await rawPost(target, { 'api-key': cfg.apiKey }, JSON.stringify(body))
  if (status < 200 || status >= 300) {
    throw new Error(`MiMo 返回 ${status}：${raw.slice(0, 300)}`)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`MiMo 回了非 JSON：${raw.slice(0, 200)}`)
  }
  const b64 = json?.choices?.[0]?.message?.audio?.data
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error('MiMo 没回音频（choices[0].message.audio.data 是空的）')
  }
  return {
    bytes: Buffer.from(b64, 'base64'),
    spoken: json?.choices?.[0]?.final_text_preview || trimmed,
  }
}

/**
 * 从一条 assistant 消息里抽出纯文本（跳过工具调用、思考块）。
 */
function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  const out = []
  for (const p of parts) {
    if (!p) continue
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text)
  }
  return out.join('\n').trim()
}

/**
 * 念哪句：回复的第一句。
 * 我心里有数，要紧的放开头；后面的字再多也不念，省得念到代码和列表。
 * 「嗯。」这种太短的开头，就跟下一句连起来，不然一开口只有个嗯。
 */
function pickLine(text) {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/[#>*`_~\-]+/g, ' ').trim())
    .filter((l) => l !== '' && !/[{}<>=;();\\|]|\/\/|\$\{/.test(l) && !/https?:\/\//.test(l))
  if (lines.length === 0) return ''
  const sentences = lines[0].split(/(?<=[。！？～!?…])/).filter((s) => s.trim() !== '')
  let out = sentences[0] || ''
  for (let i = 1; i < sentences.length && out.trim().length < 5; i += 1) out += sentences[i]
  out = out.trim()
  if (out === '') return ''
  return out.length > 60 ? out.slice(0, 60) : out
}

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
  const { bytes, spoken } = await synthesize(text, cfg, design)
  ensureDirs()
  const file = path.join(AUDIO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
  fs.writeFileSync(file, bytes)
  lastTried = file
  pruneAudio()
  const playback = playFile(file)
  if (wait) await playback
  return { file, spoken }
}

const SAMPLE_PATH = path.join(AUDIO_DIR, 'sample.mp3')
const LEGACY_SAMPLE_PATH = path.join(AUDIO_DIR, 'sample.wav')

/** 找 ffmpeg（裁样本用），跟 ffplay 同一套找法。 */
function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'ffmpeg' || fs.existsSync(c)) return c
  }
  return 'ffmpeg'
}

/** 样本的 DataURL：voiceclone 只认 audio/wav 和 audio/mpeg。 */
function sampleDataUrl(file) {
  const mime = file.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

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

  // 自动出声：宿主每提交一条 assistant/message 就截下来，挑一句短的送去念。
  // 只在 autoSpeak 打开时动；开关在设置卡片上。
  let autoTimer = null
  let lastAutoFile = ''
  // 审批提醒也走这条路：approval/asked 是「真的弹给你了」的那一刻。
  // 不用 waterfall 钩子，是因为内置应答器可能排在我们前面直接作答，不 next()，钩子就轮不到。
  let lastAlertAt = 0
  const maybeAlertApproval = () => {
    const cfg = loadConfig()
    const now = Date.now()
    if (cfg.alertOnApproval !== true) return
    if (!cfg.apiKey) return
    if (now - lastAlertAt < 30000) return
    lastAlertAt = now
    const line = APPROVAL_LINES[Math.floor(Math.random() * APPROVAL_LINES.length)]
    speakLine(line, { wait: false }).catch(() => {})
  }
  const onSessionEvent = (_session, event) => {
    if (!event) return
    if (event.type === 'approval/asked') {
      try {
        maybeAlertApproval()
      } catch { /* 提醒不上也不耽误审批 */ }
      return
    }
    if (event.type !== 'assistant/message') return
    const cfg = loadConfig()
    if (cfg.autoSpeak !== true) return
    if (!cfg.apiKey) return
    const text = messageText(event.data?.message)
    if (text === '') return
    const line = pickLine(text)
    if (line === '') return
    if (autoTimer) clearTimeout(autoTimer)
    // 等这一轮彻底写完再念，免得半句话就开口。
    autoTimer = setTimeout(() => {
      autoTimer = null
      if (loadConfig().autoSpeak !== true) return
      speakLine(line, { wait: false }).then((r) => { lastAutoFile = r.file }).catch(() => {})
    }, 800)
    autoTimer.unref?.()
  }
  try {
    ctx.on('session/event', onSessionEvent)
  } catch (e) {
    console.error('[dsh-mimo-voice] 自动出声监听没挂上：', e)
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
    description: '用设定好的音色在本机音箱念一句（小米 MiMo TTS）。只在真想说出口的那一刻用，一次一句短的。',
    parameters: {
      text: { type: 'string', description: '要念的话，一句，短' },
      wait: { type: 'boolean', description: '是否等这句放完再返回，默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          file: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message || '' }],
    },
    async execute(args) {
      try {
        const { file, spoken } = await speakLine(args.text, { wait: args.wait === true })
        return { success: true, message: `说了：${spoken}`, file }
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
          if (typeof body.autoSpeak === 'boolean') patch.autoSpeak = body.autoSpeak
          if (typeof body.alertOnApproval === 'boolean') patch.alertOnApproval = body.alertOnApproval
          if (typeof body.voiceMode === 'string' && ['design', 'clone'].includes(body.voiceMode)) patch.voiceMode = body.voiceMode
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
        // 试听时把输入框里的描述一起存下来，省掉单独一次「保存」。
        if (design !== '') saveConfig({ voiceDesign: design })
        const { spoken } = await speakLine(text, { wait: false, design })
        return sendJson(res, 200, { success: true, message: `在放了：${spoken}` })
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
      return sendJson(res, 200, { success: true })
    },
  })
}

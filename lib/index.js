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
 *   POST /api/dsh-mimo-voice.config   写设置 { apiKey?, voiceDesign?, speakPrompt?, alertOnApproval?, voiceMode? }
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
export const inject = ['tools', 'webServer', 'systemPrompt']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AUDIO_DIR = path.join(ROOT, 'audio')
const CONFIG_PATH = path.join(ROOT, 'config.json')
// 密钥单独放 .env，跟 config.json 分开：config.json 是可以传的默认值，.env 不传。
const ENV_PATH = path.join(ROOT, '.env')
const ENV_KEY = 'MIMO_API_KEY'

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

const DEFAULT_VOICE_DESIGN = [
  '三十二岁左右的成年女性，中低音，嗓音偏磁、带一点烟嗓的毛边，厚而不浑。',
  '语气从容带点居高临下，不撒娇不哄人，句尾停顿利落。',
  '语速中等偏慢，重音落在句尾，像懒得解释第二遍。',
].join('')

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
    speakPrompt: cfg.speakPrompt === true,
    alertOnApproval: cfg.alertOnApproval === true,
    // 自己写的那几条；空数组表示还在用出厂默认。
    approvalLines: cleanLines(cfg.approvalLines),
    defaultApprovalLines: DEFAULT_APPROVAL_LINES,
    // pinned：已经在用定下来的那条；canKeep：刚试过一条，可以定下来。
    pinned: cfg.voiceMode === 'clone' && hasSample,
    canKeep: lastTried !== '' && fs.existsSync(lastTried),
    baseURL: cfg.baseURL,
    model: cfg.model,
    previewText: (typeof cfg.previewText === 'string' && cfg.previewText.trim() !== '') ? cfg.previewText : PREVIEW_TEXT,
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
    return {
      bytes: Buffer.from(b64c, 'base64'),
      spoken: json?.choices?.[0]?.final_text_preview || trimmed,
      voice: { mode: 'clone', model: CLONE_MODEL, design: '', sample: cfg.sampleFile },
    }
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
    voice: {
      mode: 'design',
      model: cfg.model || DEFAULT_CONFIG.model,
      design: forceDesign ? designOverride.trim() : (cfg.voiceDesign || DEFAULT_VOICE_DESIGN),
      source: forceDesign ? '试听临时填的' : (cfg.voiceDesign ? '设置里存的' : '代码里的默认'),
    },
  }
}

/**
 * 注入系统提示词的那段规矩。
 * 每轮拼提示词时现取；开关关着就返回空串，等于这一份提示词里没这节。
 */
export const SPEAK_POLICY = [
  '## 出声',
  '',
  '这台机器接着音箱，你能出声。`speak` 用固定音色念一句话。',
  '',
  '每回一条消息，都挑一句最要紧的交给 `speak`；念的和回复里说的是同一件事，一句就够，别长。',
  '',
  '话分两处写，别混：',
  '',
  '开头那对括号定**整句基调**，放情绪加语调，叠两三个词、逗号隔开。',
  '',
  '**句中标签**是另一回事——叹气、轻笑、小声、气声、颤抖、哽咽这几个插在句子里，管的是它后面那半句。位置长这样：（基调）（句子前半）（句中标签）句子后半',
  '',
  '句中标签插在半句中间最稳，贴句尾容易拖；一条里塞两个，后一个常被吞掉，只留前一个。塞进开头括号等于叠一串基调，会打架，那个「抖」就没了。',
  '',
  '词从这套里挑：',
  '',
  '- 情绪：开心、悲伤、愤怒、恐惧、惊讶、兴奋、委屈、平静、冷漠、怅然、欣慰、无奈、愧疚、释然、嫉妒、厌倦、忐忑、动情',
  '- 语调：温柔、高冷、活泼、严肃、慵懒、俏皮、深沉、干练、凌厉',
  '- 句中标签：气声、叹气、长叹一口气、深呼吸、轻笑、笑、冷笑、抽泣、哽咽、呜咽、颤抖、鼻音、不耐烦、心虚、撒娇、小声、提高音量喊话、语速加快、碎碎念、有气无力',
  '',
  '音色不用写，设置里已经定死了。语速也归设置，括号只管这一句的调子。',
  '',
  '这几套只是常用的一部分，别被它框死；意思对了，自己造词也行。不是每句都得加，也不是每句都用同一个，这句什么调子自己看着定。',
  '',
  '正文里不写括号、不写记号。想说的只有 speak 里那一遍。',
].join('\n')

/** 提示词里那一节的标识与顺位：排在工具说明之后。 */
const SPEAK_SECTION = 'dsh-mimo-voice:speak-policy'
const SPEAK_ORDER = 300


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
  const { bytes, spoken, voice } = await synthesize(text, cfg, design)
  ensureDirs()
  const file = path.join(AUDIO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
  fs.writeFileSync(file, bytes)
  lastTried = file
  pruneAudio()
  const playback = playFile(file)
  if (wait) await playback
  return { file, spoken, voice }
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
    description: '用设定好的音色在本机音箱念一句（小米 MiMo TTS）。每回一条消息都挑一句最要紧的念出来，一次一句短的；语气写在 text 开头的括号里。',
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
          voice: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.voice ? `${value.message || ''}（音色：${value.voice}）` : (value.message || '') }],
    },
    async execute(args) {
      try {
        const { file, spoken, voice } = await speakLine(args.text, { wait: args.wait === true })
        const label = voice && voice.mode === 'clone'
          ? `固定样本（${voice.model}）`
          : `现造（${voice?.model || 'voicedesign'}）· ${voice?.source || ''}`
        return { success: true, message: `说了：${spoken}`, file, voice: label }
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
      return sendJson(res, 200, { success: true })
    },
  })
}

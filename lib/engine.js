/**
 * dsh-mimo-voice — 引擎层。
 *
 * 这一层只回答一个问题：给定一段文字和一份配置，怎么拿回一段音频。
 * 它不管音频存到哪、也不管从哪个喇叭放出去——那是 index.js 里 sink 的事。
 *
 * 换一家服务商 = 在这里加一个实现，导出同样的 render()，别的代码不动。
 * 现在只有一个：小米 MiMo。
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'

/** 固定样本模式用的模型。 */
export const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'

export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
export const DEFAULT_MODEL = 'mimo-v2.5-tts-voicedesign'

/** 出厂音色描述：设置里没填时用这段。 */
export const DEFAULT_VOICE_DESIGN = [
  '三十二岁左右的成年女性，中低音，嗓音偏磁、带一点烟嗓的毛边，厚而不浑。',
  '语气从容带点居高临下，不撒娇不哄人，句尾停顿利落。',
  '语速中等偏慢，重音落在句尾，像懒得解释第二遍。',
].join('')

/** 找 ffmpeg（转码、裁样本用）。 */
export function findFfmpeg() {
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
    req.setTimeout(60000, () => req.destroy(new Error('请求 TTS 超时（60 秒）')))
    req.end(payload)
  })
}

/** 样本的 DataURL：voiceclone 只认 audio/wav 和 audio/mpeg。 */
function sampleDataUrl(file) {
  const mime = file.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

/**
 * 音色：从配置里取出「用谁的声音」，跟引擎无关。
 * design = 每次都按这段描述现造；clone = 用固定样本，声音不变。
 */
export function voiceOf(cfg) {
  const sample = typeof cfg.sampleFile === 'string' ? cfg.sampleFile : ''
  const hasSample = sample !== '' && fs.existsSync(sample)
  return {
    mode: cfg.voiceMode === 'clone' && hasSample ? 'clone' : 'design',
    design: String(cfg.voiceDesign || ''),
    sampleFile: hasSample ? sample : '',
  }
}

/**
 * 取实际要用的接口地址。
 *
 * config.json 里只有一份 baseURL，切换服务商时它会留着上一家的值。若那个值
 * 正好是另一家的出厂地址，说明是没清掉的残留，回落到本家默认；用户自己填的
 * 第三方地址不在此列，照用。
 */
function resolveBase(cfg, engine) {
  const raw = String(cfg.baseURL || '').trim().replace(/\/+$/, '')
  if (raw === '') return engine.defaultBaseURL
  if (raw.startsWith(engine.defaultBaseURL)) return raw
  for (const other of Object.values(ENGINES)) {
    if (other.id !== engine.id && raw.startsWith(other.defaultBaseURL)) {
      return engine.defaultBaseURL
    }
  }
  return raw
}

/** 模型名同理：留着别家的出厂模型名就当没写。 */
function resolveModel(cfg, engine) {
  const raw = String(cfg.model || '').trim()
  if (raw === '') return engine.defaultModel
  if (raw === engine.defaultModel) return raw
  for (const other of Object.values(ENGINES)) {
    if (other.id !== engine.id && raw === other.defaultModel) return engine.defaultModel
  }
  return raw
}

/** 要二进制响应的 POST：返回 { status, bytes, text }。Breeze 这类直接吐音频的用它。 */
function rawPostBinary(url, headers, payload) {
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
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          const type = String(res.headers['content-type'] || '')
          resolve({
            status: res.statusCode || 0,
            bytes: type.startsWith('application/json') || type.startsWith('text/') ? null : body,
            text: body.toString('utf8'),
            contentType: type,
            headers: res.headers,
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('请求 TTS 超时（120 秒）')))
    req.end(payload)
  })
}

/** 流式请求：先把响应头拿到手，正文交给调用方按块读。Breeze 的 /stream 用它。 */
function requestStream(url, headers, payload) {
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
      (res) => resolve({ res, req }),
    )
    req.on('error', reject)
    req.setTimeout(180000, () => req.destroy(new Error('请求 TTS 超时（180 秒）')))
    req.end(payload)
  })
}

/**
 * 小米 MiMo。
 *
 * voiceclone / voicedesign 两轮的 messages 布局是这家独有的：user 那轮写音色，
 * assistant 那轮才是要念的字。别的服务商不是这个形状，所以这段不外提。
 */
const mimo = {
  id: 'mimo',
  label: '小米 MiMo',
  defaultBaseURL: DEFAULT_BASE_URL,
  defaultModel: DEFAULT_MODEL,

  /**
   * @returns {Promise<{bytes: Buffer, ext: string, mime: string, spoken: string, voice: object}>}
   *   bytes 是完整的音频文件内容；ext 决定落盘用什么后缀。
   */
  async render(text, cfg, opts = {}) {
    if (!cfg.apiKey) throw new Error('还没填 API 密钥（设置 → 插件 → dsh-mimo-voice）')
    const trimmed = String(text ?? '').trim()
    if (trimmed.length === 0) throw new Error('要念的话是空的')
    const cap = Number(cfg.maxTextLength) > 0 ? Number(cfg.maxTextLength) : 600
    const designOverride = typeof opts.design === 'string' ? opts.design.trim() : ''
    const forceDesign = designOverride !== ''
    const voice = voiceOf(cfg)
    const base = resolveBase(cfg, mimo)
    const target = `${base}/chat/completions`

    if (!forceDesign && voice.mode === 'clone') {
      const body = {
        model: CLONE_MODEL,
        messages: [
          { role: 'user', content: '按这条样本的声音念下面的话。' },
          { role: 'assistant', content: trimmed.slice(0, cap) },
        ],
        audio: { format: 'wav', voice: sampleDataUrl(voice.sampleFile) },
        stream: false,
      }
      const { status, text: raw } = await rawPost(target, { 'api-key': cfg.apiKey }, JSON.stringify(body))
      if (status < 200 || status >= 300) throw new Error(`MiMo 返回 ${status}：${raw.slice(0, 300)}`)
      let json
      try { json = JSON.parse(raw) } catch { throw new Error(`MiMo 回了非 JSON：${raw.slice(0, 200)}`) }
      const b64 = json?.choices?.[0]?.message?.audio?.data
      if (typeof b64 !== 'string' || b64.length === 0) throw new Error('MiMo 没回音频（voiceclone）')
      return {
        bytes: Buffer.from(b64, 'base64'),
        ext: 'wav',
        mime: 'audio/wav',
        spoken: json?.choices?.[0]?.final_text_preview || trimmed,
        voice: { mode: 'clone', model: CLONE_MODEL, design: '', sample: voice.sampleFile },
      }
    }

    const body = {
      model: resolveModel(cfg, mimo),
      messages: [
        // voicedesign：user 那一轮是「音色长什么样」，assistant 那一轮才是要念的字。
        { role: 'user', content: forceDesign ? designOverride : (voice.design || DEFAULT_VOICE_DESIGN) },
        { role: 'assistant', content: trimmed.slice(0, cap) },
      ],
      audio: { format: 'wav' },
      stream: false,
    }
    const { status, text: raw } = await rawPost(target, { 'api-key': cfg.apiKey }, JSON.stringify(body))
    if (status < 200 || status >= 300) throw new Error(`MiMo 返回 ${status}：${raw.slice(0, 300)}`)
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
      ext: 'wav',
      mime: 'audio/wav',
      spoken: json?.choices?.[0]?.final_text_preview || trimmed,
      voice: {
        mode: 'design',
        model: resolveModel(cfg, mimo),
        design: forceDesign ? designOverride : (voice.design || ''),
        source: forceDesign ? '试听临时填的' : (cfg.voiceDesign ? '设置里存的' : '代码里的默认'),
      },
    }
  },
}

/**
 * Breeze Blue。
 *
 * 跟 MiMo 完全是两套形状：地址里带 voice_id，鉴权头是 xi-api-key，音色得先在
 * 平台上存成长期对象，返回直接是二进制音频而不是 JSON 里套 base64。
 */
const breeze = {
  id: 'breeze',
  label: 'Breeze Blue',
  defaultBaseURL: 'https://api.breeze.blue',
  defaultModel: 'breeze-tts-2',
  // 这家没有「现造音色」这一档：音色必须先存在平台账号下，拿到 voice_id 才能念。
  needsVoiceId: true,

  async render(text, cfg, opts = {}) {
    if (!cfg.apiKey) throw new Error('还没填 API 密钥（设置 → 插件 → 语音输出）')
    const trimmed = String(text ?? '').trim()
    if (trimmed.length === 0) throw new Error('要念的话是空的')
    const voiceId = String(cfg.breezeVoiceId || '').trim()
    if (voiceId === '') {
      throw new Error('还没填音色 ID：Breeze 需先在平台生成并保存一个音色，把它的 voice_id 填进设置')
    }
    const cap = Number(cfg.maxTextLength) > 0 ? Number(cfg.maxTextLength) : 1000
    const base = resolveBase(cfg, breeze)
    const model = resolveModel(cfg, breeze)
    const lang = String(cfg.breezeLanguage || 'zh').trim().toLowerCase()

    // instructions 用与正文同语言写；配置里那套音色描述本来就是中文，直接复用。
    const instruction = String(opts.design || cfg.voiceDesign || '').trim()
    const settings = { speed: 1.0, use_speaker_boost: true }
    const scale = Number(cfg.breezeGuidance)
    if (Number.isFinite(scale) && scale >= 1 && scale <= 10) settings.guidance_scale = scale

    const body = {
      text: trimmed.slice(0, cap),
      model_id: model,
      language_code: /^[a-z]{2}$/.test(lang) ? lang : 'zh',
      voice_settings: settings,
    }
    if (instruction !== '') body.instructions = instruction.slice(0, 1000)

    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3`
    const { status, bytes, text: raw } = await rawPostBinary(
      url,
      { 'xi-api-key': cfg.apiKey },
      JSON.stringify(body),
    )
    if (status < 200 || status >= 300) throw new Error(`Breeze 返回 ${status}：${raw.slice(0, 300)}`)
    if (!bytes || bytes.length === 0) throw new Error('Breeze 没回音频')
    return {
      bytes,
      ext: 'mp3',
      mime: 'audio/mpeg',
      spoken: trimmed.slice(0, cap),
      voice: {
        mode: 'voice_id',
        model,
        design: instruction,
        voiceId,
        source: '设置里存的',
      },
    }
  },

  /**
   * 流式合成：请求 /stream 端点，响应一到就交给调用方按块取。
   * 返回的 chunks 是可 async 迭代的分片；abort() 用来中途掐断。
   * 不支持流式的引擎不实现这个方法，调用方据此回落 render()。
   */
  async openStream(text, cfg, opts = {}) {
    if (!cfg.apiKey) throw new Error('还没填 API 密钥（设置 → 插件 → 语音输出）')
    const trimmed = String(text ?? '').trim()
    if (trimmed.length === 0) throw new Error('要念的话是空的')
    const voiceId = String(cfg.breezeVoiceId || '').trim()
    if (voiceId === '') {
      throw new Error('还没填音色 ID：Breeze 需先在平台生成并保存一个音色，把它的 voice_id 填进设置')
    }
    const cap = Number(cfg.maxTextLength) > 0 ? Number(cfg.maxTextLength) : 1000
    const base = resolveBase(cfg, breeze)
    const model = resolveModel(cfg, breeze)
    const lang = String(cfg.breezeLanguage || 'zh').trim().toLowerCase()
    const instruction = String(opts.design || cfg.voiceDesign || '').trim()
    const settings = { speed: 1.0, use_speaker_boost: true }
    const scale = Number(cfg.breezeGuidance)
    if (Number.isFinite(scale) && scale >= 1 && scale <= 10) settings.guidance_scale = scale

    const spoken = trimmed.slice(0, cap)
    const body = {
      text: spoken,
      model_id: model,
      language_code: /^[a-z]{2}$/.test(lang) ? lang : 'zh',
      voice_settings: settings,
    }
    if (instruction !== '') body.instructions = instruction.slice(0, 1000)

    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm`
    const { res, req } = await requestStream(url, { 'xi-api-key': cfg.apiKey }, JSON.stringify(body))
    const status = res.statusCode || 0
    if (status < 200 || status >= 300) {
      const parts = []
      for await (const c of res) parts.push(c)
      const detail = Buffer.concat(parts).toString('utf8').slice(0, 300)
      req.destroy()
      throw new Error(`Breeze 返回 ${status}：${detail}`)
    }
    return {
      ext: 'pcm',
      mime: 'application/octet-stream',
      sr: 24000,
      bits: 16,
      channels: 1,
      spoken,
      voice: {
        mode: 'voice_id',
        model,
        design: instruction,
        voiceId,
        source: '设置里存的',
      },
      chunks: (async function* () { for await (const c of res) yield c })(),
      abort: () => { try { req.destroy() } catch { /* 已经断了 */ } },
    }
  },
}

/** 注册表：加一家服务商就在这里加一个键。 */
export const ENGINES = { mimo, breeze }

/** 取当前配置指定的引擎；不认识的值回落小米。 */
export function engineOf(cfg) {
  const key = typeof cfg.provider === 'string' ? cfg.provider : ''
  return ENGINES[key] || ENGINES.mimo
}

/** 设置页要展示的服务商清单。needsVoiceId 表示音色要先在平台存好、填 id 才能用。 */
export function listEngines() {
  return Object.values(ENGINES).map((e) => ({
    id: e.id,
    label: e.label,
    needsVoiceId: e.needsVoiceId === true,
  }))
}

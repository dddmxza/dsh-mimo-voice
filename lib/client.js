/**
 * dsh-mimo-voice — 浏览器半边（客户端 bundle）。
 *
 * 职责：在 设置 → 插件 里挂一张配置卡片。数据不走 settings 命名空间（web profile
 * 有白名单，第三方命名空间写不进去），直接打宿主注册的 /api/dsh-mimo-voice.* 路由。
 *
 * 打包形式是宿主 __ModuleLoader__ 的约定：一个自执行函数，返回 { apply, inject }。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mimo-voice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/dsh-mimo-voice'
    const NAMESPACE = 'dsh-mimo-voice'
    const DEFAULT_PREVIEW_TEXT = '红豆生南国，春来发几枝。愿君多采撷，此物最相思。'

    function injectStyles() {
      if (document.getElementById('dsh-mimo-voice-style')) return
      const tag = document.createElement('style')
      tag.id = 'dsh-mimo-voice-style'
      tag.textContent = `
.dmv-card {
  display: flex; flex-direction: column; gap: 16px;
  font-size: 13px; line-height: 1.55;
  /* 全部用自足的中性灰：宿主主题变量在不同皮肤下取值不定，兜底成 #fff 会
     在深色面板上翻出白块。灰阶叠在任意底色上都能看。 */
  --dmv-line: rgba(128,128,128,.28);
  --dmv-strong: rgba(128,128,128,.5);
  --dmv-elev: rgba(128,128,128,.1);
  --dmv-fill: rgba(128,128,128,.15);
  --dmv-brand: #4a7cf0;
  --dmv-ok: var(--dsw-alias-state-success-primary, #2f9e6a);
  --dmv-bad: var(--dsw-alias-state-error-primary, #d1534b);
}

/* 顶部：标题 + 状态摘要 */
.dmv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.dmv-head-main { min-width: 0; }
.dmv-title { font-size: 15px; font-weight: 650; letter-spacing: .01em; }
.dmv-sub { font-size: 12px; opacity: .55; margin-top: 3px; }
.dmv-chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; flex: none; }
.dmv-chip {
  font-size: 11px; line-height: 1; padding: 5px 9px; border-radius: 6px; white-space: nowrap;
  border: 1px solid var(--dmv-line); opacity: .62;
}
.dmv-chip-on { opacity: 1; color: var(--dmv-ok); border-color: currentColor; }
.dmv-chip-warn { opacity: 1; color: var(--dmv-bad); border-color: currentColor; }

/* 分组：细线分隔，不用卡片堆 */
.dmv-group { display: flex; flex-direction: column; gap: 11px; }
.dmv-group + .dmv-group { border-top: 1px solid var(--dmv-line); padding-top: 15px; }
.dmv-group-title {
  font-size: 11px; font-weight: 650; letter-spacing: .06em; opacity: .5;
}

/* 行：左标签右控件，窄了自动塌成一列 */
.dmv-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 14px; align-items: start; }
@media (max-width: 560px) { .dmv-row { grid-template-columns: 1fr; gap: 6px; } }
.dmv-label { font-size: 12px; font-weight: 600; opacity: .78; padding-top: 7px; }
@media (max-width: 560px) { .dmv-label { padding-top: 0; } }
.dmv-control { display: flex; flex-direction: column; gap: 6px; min-width: 0; }

.dmv-hint { font-size: 12px; opacity: .52; line-height: 1.5; }
.dmv-hint-warn { color: var(--dmv-bad); opacity: .9; }
.dmv-divider { height: 1px; background: var(--dmv-line); }

.dmv-input, .dmv-textarea {
  width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 7px;
  border: 1px solid var(--dmv-line);
  background: var(--dmv-elev); color: inherit;
  font-size: 13px; font-family: inherit; line-height: 1.5;
}
.dmv-input::placeholder, .dmv-textarea::placeholder { color: inherit; opacity: .38; }
.dmv-input:focus, .dmv-textarea:focus {
  outline: none; border-color: var(--dmv-strong); background: var(--dmv-fill);
}
.dmv-textarea { min-height: 68px; resize: vertical; }

/* 分段选择器 */
.dmv-seg {
  display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px;
  background: rgba(128,128,128,.1); border: 1px solid var(--dmv-line);
  align-self: flex-start; max-width: 100%; flex-wrap: wrap;
}
.dmv-seg button {
  padding: 5px 13px; border-radius: 6px; border: 1px solid transparent; cursor: pointer;
  background: transparent; color: inherit; font-size: 12px; font-family: inherit;
  opacity: .62; transition: opacity .14s, background .14s;
}
.dmv-seg button:hover:not(:disabled) { opacity: .88; }
.dmv-seg button:disabled { cursor: not-allowed; opacity: .35; }
.dmv-seg button.dmv-seg-on {
  opacity: 1; background: rgba(128,128,128,.34);
  border-color: var(--dmv-strong); font-weight: 600;
}

/* 按钮 */
.dmv-btn {
  padding: 6px 14px; border-radius: 7px; cursor: pointer; font-size: 12.5px;
  border: 1px solid var(--dmv-line); background: transparent; color: inherit;
  font-family: inherit; transition: border-color .14s, background .14s, opacity .14s;
}
.dmv-btn:hover:not(:disabled) { border-color: var(--dmv-strong); }
.dmv-btn:disabled { opacity: .38; cursor: not-allowed; }
.dmv-btn-primary { background: var(--dmv-brand); border-color: transparent; color: #fff; }
.dmv-btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
/* 禁用时不留实心底：实心底 + 白字在深色面板上会糊成一块灰砖。 */
.dmv-btn:disabled, .dmv-btn-primary:disabled {
  background: transparent; border-color: var(--dmv-line); color: inherit;
  opacity: .42; filter: none;
}
.dmv-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 开关 */
.dmv-toggle {
  display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border-radius: 8px;
  border: 1px solid var(--dmv-line); cursor: pointer; transition: border-color .14s;
}
.dmv-toggle:hover { border-color: var(--dmv-strong); }
.dmv-toggle-on { border-color: var(--dmv-brand); }
.dmv-toggle input { margin: 3px 0 0; flex: none; cursor: pointer; }
.dmv-toggle-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dmv-toggle-title { font-size: 12.5px; font-weight: 600; }
.dmv-toggle-note { font-size: 11.5px; opacity: .52; line-height: 1.5; }

/* 列表条目 */
.dmv-lines { display: flex; flex-direction: column; gap: 5px; }
.dmv-line {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 9px; border-radius: 7px;
  border: 1px solid var(--dmv-line); font-size: 12.5px; line-height: 1.5;
}
.dmv-line-text { flex: 1; min-width: 0; word-break: break-word; }
.dmv-line-del {
  flex: none; padding: 0 7px; border-radius: 5px; cursor: pointer; font-size: 11.5px;
  border: 1px solid var(--dmv-line); background: transparent; color: inherit; opacity: .6;
  font-family: inherit;
}
.dmv-line-del:hover { opacity: 1; color: var(--dmv-bad); border-color: currentColor; }
.dmv-empty { font-size: 12px; opacity: .5; }
.dmv-add { display: flex; gap: 8px; align-items: stretch; }
.dmv-add .dmv-input { flex: 1; }

/* 底部操作条 */
.dmv-footer {
  display: flex; gap: 9px; align-items: center; flex-wrap: wrap;
  border-top: 1px solid var(--dmv-line); padding-top: 14px;
}
.dmv-status { flex: 1; min-width: 0; font-size: 12px; }
.dmv-ok { color: var(--dmv-ok); }
.dmv-bad { color: var(--dmv-bad); }
.dmv-dirty { font-size: 11.5px; opacity: .6; }
`
      document.head.appendChild(tag)
    }

    async function callConfig(patch) {
      const res = await fetch(`${API}.config`, {
        method: patch === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: patch === undefined ? undefined : JSON.stringify(patch),
      })
      return res.json()
    }

    function Card() {
      const [loaded, setLoaded] = useState(false)
      const [hasKey, setHasKey] = useState(false)
      const [keyDraft, setKeyDraft] = useState('')
      const [voice, setVoice] = useState('')
      const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT)
      const [speakPrompt, setSpeakPrompt] = useState(false)
      const [alertOnApproval, setAlertOnApproval] = useState(false)
      // 自定义提醒语，一条一项；空数组表示使用出厂语句。
      const [alertList, setAlertList] = useState([])
      const [alertDraft, setAlertDraft] = useState('')
      const [defaultAlertLines, setDefaultAlertLines] = useState([])
      const [pinned, setPinned] = useState(false)
      const [canKeep, setCanKeep] = useState(false)
      const [status, setStatus] = useState('')
      const [statusBad, setStatusBad] = useState(false)
      const [busy, setBusy] = useState(false)

      // 接入层
      const [provider, setProvider] = useState('mimo')
      const [engines, setEngines] = useState([{ id: 'mimo', label: '小米 MiMo' }])
      const engineNow = engines.find((e) => e.id === provider) || {}
      const engineLabel = engineNow.label || '服务商'
      // 有些服务商的音色得先在平台上存成对象、拿 id 才能用，不能每次用文字现造。
      const needVoiceId = engineNow.needsVoiceId === true
      const [breezeVoiceId, setBreezeVoiceId] = useState('')
      const [breezeLanguage, setBreezeLanguage] = useState('zh')
      const [breezeGuidance, setBreezeGuidance] = useState(0)

      // 输出层：local 本机 / board 远端 / both 并行
      const [output, setOutput] = useState('local')
      const [boardUrl, setBoardUrl] = useState('')
      const [boardFallback, setBoardFallback] = useState(true)

      // 已保存的形态，用来判断有没有未保存改动
      const baseline = useRef(null)

      const report = useCallback((text, bad) => {
        setStatus(text)
        setStatusBad(bad === true)
      }, [])

      const adopt = useCallback((cfg) => {
        if (!cfg) return
        const next = {
          provider: typeof cfg.provider === 'string' ? cfg.provider : 'mimo',
          voice: typeof cfg.voiceDesign === 'string' ? cfg.voiceDesign : '',
          previewText: typeof cfg.previewText === 'string' && cfg.previewText.trim() !== '' ? cfg.previewText : DEFAULT_PREVIEW_TEXT,
          speakPrompt: cfg.speakPrompt === true,
          alertOnApproval: cfg.alertOnApproval === true,
          alertList: Array.isArray(cfg.approvalLines) ? cfg.approvalLines : [],
          output: typeof cfg.output === 'string' && cfg.output !== 'browser' ? cfg.output : 'local',
          boardUrl: typeof cfg.boardUrl === 'string' ? cfg.boardUrl : '',
          boardFallback: cfg.boardFallback !== false,
          breezeVoiceId: typeof cfg.breezeVoiceId === 'string' ? cfg.breezeVoiceId : '',
          breezeLanguage: typeof cfg.breezeLanguage === 'string' ? cfg.breezeLanguage : 'zh',
          breezeGuidance: Number(cfg.breezeGuidance) || 0,
        }
        setHasKey(cfg.hasKey === true)
        setProvider(next.provider)
        if (Array.isArray(cfg.engines) && cfg.engines.length > 0) setEngines(cfg.engines)
        setVoice(next.voice)
        setPreviewText(next.previewText)
        setSpeakPrompt(next.speakPrompt)
        setAlertOnApproval(next.alertOnApproval)
        setAlertList(next.alertList)
        if (Array.isArray(cfg.defaultApprovalLines)) setDefaultAlertLines(cfg.defaultApprovalLines)
        setOutput(next.output)
        setBoardUrl(next.boardUrl)
        setBoardFallback(next.boardFallback)
        setBreezeVoiceId(next.breezeVoiceId)
        setBreezeLanguage(next.breezeLanguage)
        setBreezeGuidance(next.breezeGuidance)
        setPinned(cfg.pinned === true)
        setCanKeep(cfg.canKeep === true)
        baseline.current = JSON.stringify(next)
      }, [])

      useEffect(() => {
        let alive = true
        callConfig()
          .then((json) => {
            if (!alive) return
            adopt(json.config)
            setLoaded(true)
          })
          .catch((e) => {
            if (!alive) return
            report(`读取配置失败：${e.message}`, true)
            setLoaded(true)
          })
        return () => { alive = false }
      }, [adopt, report])

      const currentForm = {
        provider,
        voice,
        previewText,
        speakPrompt,
        alertOnApproval,
        alertList,
        output,
        boardUrl,
        boardFallback,
        breezeVoiceId,
        breezeLanguage,
        breezeGuidance,
      }
      const dirty = baseline.current !== null &&
        (JSON.stringify(currentForm) !== baseline.current || keyDraft.trim() !== '')

      const save = useCallback(async () => {
        setBusy(true)
        report('')
        try {
          const patch = {
            provider,
            voiceDesign: voice,
            speakPrompt,
            alertOnApproval,
            approvalLines: alertList,
            previewText: previewText.trim(),
            output,
            boardUrl: boardUrl.trim(),
            boardFallback,
            breezeVoiceId: breezeVoiceId.trim(),
            breezeLanguage,
            breezeGuidance,
          }
          if (keyDraft.trim().length > 0) patch.apiKey = keyDraft.trim()
          const json = await callConfig(patch)
          if (json.success) {
            adopt(json.config)
            setKeyDraft('')
            report('已保存')
          } else {
            report(`保存失败：${json.message}`, true)
          }
        } catch (e) {
          report(`保存失败：${e.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [provider, voice, speakPrompt, alertOnApproval, alertList, previewText, output, boardUrl, boardFallback, breezeVoiceId, breezeLanguage, breezeGuidance, keyDraft, adopt, report])

      const revert = useCallback(() => {
        if (baseline.current === null) return
        const base = JSON.parse(baseline.current)
        setProvider(base.provider)
        setVoice(base.voice)
        setPreviewText(base.previewText)
        setSpeakPrompt(base.speakPrompt)
        setAlertOnApproval(base.alertOnApproval)
        setAlertList(base.alertList)
        setOutput(base.output)
        setBoardUrl(base.boardUrl)
        setBoardFallback(base.boardFallback)
        setBreezeVoiceId(base.breezeVoiceId)
        setBreezeLanguage(base.breezeLanguage)
        setBreezeGuidance(base.breezeGuidance)
        setKeyDraft('')
        report('已还原')
      }, [report])

      const addAlertLine = useCallback(() => {
        const text = alertDraft.trim()
        if (text === '') { report('语句不能为空', true); return }
        if (alertList.includes(text)) { report('该语句已存在', true); return }
        if (alertList.length >= 40) { report('最多 40 条', true); return }
        setAlertList((prev) => [...prev, text])
        setAlertDraft('')
        report('已添加，保存后生效')
      }, [alertDraft, alertList, report])

      const removeAlertLine = useCallback((text) => {
        setAlertList((prev) => prev.filter((l) => l !== text))
        report('已删除，保存后生效')
      }, [report])

      const resetAlertLines = useCallback(() => {
        setAlertList(defaultAlertLines.slice())
        report('已恢复出厂语句，保存后生效')
      }, [defaultAlertLines, report])

      const clearAlertLines = useCallback(() => {
        setAlertList([])
        report('已清空，保存后生效')
      }, [report])

      // 试听：按输入框里的描述现造一条，当场播放。
      const tryVoice = useCallback(async () => {
        const text = previewText.trim()
        if (text === '') { report('试听文本不能为空', true); return }
        if (!needVoiceId && voice.trim() === '') { report('音色描述不能为空', true); return }
        if (needVoiceId && breezeVoiceId.trim() === '') { report('音色 ID 不能为空', true); return }
        setBusy(true)
        report('正在生成音色…')
        try {
          const res = await fetch(`${API}.preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              voiceDesign: voice.trim(),
              breezeVoiceId: breezeVoiceId.trim(),
              breezeLanguage,
              breezeGuidance,
            }),
          })
          const json = await res.json()
          if (json.success) {
            report('已播放。不满意可重复试听')
            setCanKeep(true)
            setPinned(false)
            // 试听接口会顺带把音色描述与试听文本写入配置，基线同步到当前表单，
            // 免得刚试听就被判定为「有未保存的修改」。
            baseline.current = JSON.stringify({
              provider, voice, previewText, speakPrompt, alertOnApproval, alertList, output, boardUrl, boardFallback,
              breezeVoiceId, breezeLanguage, breezeGuidance,
            })
          } else {
            report(`生成失败：${json.message}`, true)
          }
        } catch (e) {
          report(`生成失败：${e.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [provider, voice, previewText, speakPrompt, alertOnApproval, alertList, output, boardUrl, boardFallback, breezeVoiceId, breezeLanguage, breezeGuidance, needVoiceId, report])

      const keep = useCallback(async () => {
        setBusy(true)
        report('正在固化…')
        try {
          const res = await fetch(`${API}.pin`, { method: 'POST' })
          const json = await res.json()
          if (json.success) {
            setPinned(true)
            setCanKeep(false)
            report('已固化为固定音色')
          } else {
            report(`固化失败：${json.message}`, true)
          }
        } catch (e) {
          report(`固化失败：${e.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [report])

      const unpin = useCallback(async () => {
        setBusy(true)
        report('正在切换…')
        try {
          const json = await callConfig({ voiceMode: 'design' })
          if (json.success) {
            setPinned(false)
            report('已切换为每次生成')
          } else {
            report(`切换失败：${json.message}`, true)
          }
        } catch (e) {
          report(`切换失败：${e.message}`, true)
        } finally {
          setBusy(false)
        }
      }, [report])

      const stop = useCallback(async () => {
        try { await fetch(`${API}.stop`, { method: 'POST' }) } catch { /* 已结束 */ }
        report('已停止播放')
      }, [report])

      if (!loaded) {
        return h('div', { className: 'dmv-card' }, h('div', { className: 'dmv-hint' }, '正在读取配置…'))
      }

      const group = (title, ...body) => h('div', { className: 'dmv-group' },
        h('div', { className: 'dmv-group-title' }, title),
        ...body,
      )

      const row = (label, ...control) => h('div', { className: 'dmv-row' },
        h('div', { className: 'dmv-label' }, label),
        h('div', { className: 'dmv-control' }, ...control),
      )

      const seg = (value, options, onPick) => h('div', { className: 'dmv-seg' },
        options.map(([val, label]) => h('button', {
          key: val,
          type: 'button',
          className: value === val ? 'dmv-seg-on' : undefined,
          disabled: busy,
          onClick: () => onPick(val),
        }, label)),
      )

      const toggle = (on, title, note, onToggle) => h('label', {
        className: `dmv-toggle${on ? ' dmv-toggle-on' : ''}`,
      },
        h('input', { type: 'checkbox', checked: on, onChange: (e) => onToggle(e.target.checked) }),
        h('span', { className: 'dmv-toggle-main' },
          h('span', { className: 'dmv-toggle-title' }, title),
          note ? h('span', { className: 'dmv-toggle-note' }, note) : null,
        ),
      )

      const outputLabel = output === 'board' ? '远端'
        : output === 'both' ? '本机 + 远端'
          : '本机'

      return h('div', { className: 'dmv-card' },

        // ── 顶部：标题与状态摘要 ──
        h('div', { className: 'dmv-head' },
          h('div', { className: 'dmv-head-main' },
            h('div', { className: 'dmv-title' }, '语音输出'),
            h('div', { className: 'dmv-sub' }, '设置修改后需保存，保存即生效。'),
          ),
          h('div', { className: 'dmv-chips' },
            h('span', { className: `dmv-chip${hasKey ? ' dmv-chip-on' : ' dmv-chip-warn'}` },
              hasKey ? '密钥已配置' : '缺少密钥'),
            h('span', { className: 'dmv-chip' }, engineLabel),
            h('span', { className: `dmv-chip${speakPrompt ? ' dmv-chip-on' : ''}` },
              speakPrompt ? '出声已开启' : '出声已关闭'),
            h('span', { className: 'dmv-chip' }, outputLabel),
          ),
        ),

        // ── 接入：服务商与凭据 ──
        group('接入',
          row('服务商',
            seg(provider, engines.map((e) => [e.id, e.label]), setProvider),
            h('span', { className: 'dmv-hint' }, '语音合成由所选服务商提供。切换后需按该服务商重新配置密钥与音色。'),
          ),
          row('密钥',
            h('input', {
              className: 'dmv-input',
              type: 'password',
              value: keyDraft,
              placeholder: hasKey ? '已保存，如需更换请输入新密钥' : `填写${engineLabel}的 API 密钥`,
              onChange: (e) => setKeyDraft(e.target.value),
            }),
            h('span', { className: 'dmv-hint' }, hasKey ? '密钥已保存，留空表示保持不变。' : '尚未配置密钥，配置前无法合成语音。'),
          ),
        ),

        // ── 音色 ──
        group('音色',
          row('试听文本',
            h('textarea', {
              className: 'dmv-textarea',
              value: previewText,
              placeholder: DEFAULT_PREVIEW_TEXT,
              onChange: (e) => setPreviewText(e.target.value),
            }),
          ),
          ...(needVoiceId
            ? [
                row('音色 ID',
                  h('input', {
                    className: 'dmv-input',
                    value: breezeVoiceId,
                    placeholder: 'voc_xxxxxxxxxxxx',
                    onChange: (e) => setBreezeVoiceId(e.target.value),
                  }),
                  h('span', { className: 'dmv-hint' }, '该服务商的音色需先在平台生成并保存，此处仅填写其 ID。'),
                ),
                row('语言码',
                  h('input', {
                    className: 'dmv-input',
                    value: breezeLanguage,
                    placeholder: 'zh',
                    onChange: (e) => setBreezeLanguage(e.target.value),
                  }),
                  h('span', { className: 'dmv-hint' }, 'ISO 639-1 两字母代码，决定发音口音与语言模型。'),
                ),
                row('指导强度',
                  h('input', {
                    className: 'dmv-input',
                    type: 'number',
                    min: 1,
                    max: 10,
                    value: String(breezeGuidance),
                    onChange: (e) => setBreezeGuidance(Number(e.target.value) || 0),
                  }),
                  h('span', { className: 'dmv-hint' }, '取值 1–10，越高越贴合音色描述。留 0 表示采用服务端默认。'),
                ),
                row('音色描述',
                  h('textarea', {
                    className: 'dmv-textarea',
                    value: voice,
                    placeholder: '例如：三十二岁左右的成年女性，中低音，带一点烟嗓',
                    onChange: (e) => setVoice(e.target.value),
                  }),
                  h('span', { className: 'dmv-hint' }, '作为 instructions 随请求提交，用于约束发音风格，不生成新音色。'),
                ),
              ]
            : [
                row('音色描述',
                  h('textarea', {
                    className: 'dmv-textarea',
                    value: voice,
                    placeholder: '例如：三十二岁左右的成年女性，中低音，带一点烟嗓',
                    onChange: (e) => setVoice(e.target.value),
                  }),
                  h('span', { className: 'dmv-hint' }, '每次合成按该描述生成音色。固化后改用固定样本，不再逐次变化。'),
                ),
                row('当前音色',
                  h('span', { className: 'dmv-hint' }, pinned
                    ? '已固化，音色保持不变。'
                    : canKeep
                      ? '为每次生成，音色逐次变化。满意即可固化。'
                      : '为每次生成，音色逐次变化，响应较快。先试听再决定是否固化。'),
                  h('div', { className: 'dmv-inline' },
                    h('button', {
                      className: 'dmv-btn dmv-btn-primary',
                      disabled: busy || !canKeep || pinned,
                      onClick: keep,
                    }, '固化为固定音色'),
                    pinned
                      ? h('button', { className: 'dmv-btn', disabled: busy, onClick: unpin }, '改回每次生成')
                      : null,
                  ),
                ),
              ]),
          row('',
            h('div', { className: 'dmv-inline' },
              h('button', { className: 'dmv-btn', disabled: busy, onClick: tryVoice }, '试听'),
              h('span', { className: 'dmv-hint' }, needVoiceId
                ? '按当前音色 ID 合成一句。'
                : '重复试听会重新生成音色。'),
            ),
          ),
        ),

        // ── 输出 ──
        group('输出',
          row('输出设备',
            seg(output, [['local', '本机'], ['board', '远端'], ['both', '同时']], setOutput),
            h('span', { className: 'dmv-hint' }, '合成音频的播放位置。本机指当前浏览器窗口，远端指推送接口，同时表示两路并行。'),
          ),
          row('推送接口',
            h('input', {
              className: 'dmv-input',
              value: boardUrl,
              placeholder: 'http://192.168.31.123',
              onChange: (e) => setBoardUrl(e.target.value),
            }),
            h('span', { className: 'dmv-hint' }, '远端播放服务的基址，插件向其推送音频流。设备更换或地址变更时修改。'),
          ),
          row('',
            toggle(boardFallback, '推送失败时回退本机', '远端不可达时改由本机输出，避免该句完全无声。', setBoardFallback),
          ),
          row('',
            h('span', { className: 'dmv-hint' }, '远端为边收边放，单次请求耗时等于音频时长。'),
          ),
        ),

        // ── 行为 ──
        group('行为',
          row('',
            toggle(speakPrompt, '启用语音输出', '开启后向系统提示词注入出声规则，并允许调用语音工具。关闭后两者同时失效。', setSpeakPrompt),
          ),
          row('',
            toggle(alertOnApproval, '审批挂起时提醒', '有操作等待确认时播放一句提示。', setAlertOnApproval),
          ),
          row('提醒语句',
            alertList.length === 0
              ? h('div', { className: 'dmv-empty' },
                  `未自定义，使用出厂语句：${defaultAlertLines[0] || '任务需要权限，请审批。'}`)
              : h('div', { className: 'dmv-lines' },
                  alertList.map((line, i) => h('div', { className: 'dmv-line', key: `${i}-${line}` },
                    h('span', { className: 'dmv-line-text' }, line),
                    h('button', {
                      className: 'dmv-line-del',
                      disabled: busy,
                      onClick: () => removeAlertLine(line),
                    }, '删除'),
                  )),
                ),
            h('div', { className: 'dmv-add' },
              h('input', {
                className: 'dmv-input',
                value: alertDraft,
                placeholder: '输入一句，按回车添加',
                onChange: (e) => setAlertDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addAlertLine() } },
              }),
              h('button', { className: 'dmv-btn', disabled: busy, onClick: addAlertLine }, '添加'),
            ),
            h('div', { className: 'dmv-inline' },
              h('button', { className: 'dmv-btn', disabled: busy, onClick: resetAlertLines }, '恢复出厂语句'),
              h('button', { className: 'dmv-btn', disabled: busy || alertList.length === 0, onClick: clearAlertLines }, '清空'),
            ),
            h('span', { className: 'dmv-hint' }, '多条时随机选取一条播放。句首可加（语速快，很焦急）形式的语气标签。'),
          ),
        ),

        // ── 底部操作 ──
        h('div', { className: 'dmv-footer' },
          h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy || !dirty, onClick: save }, '保存'),
          h('button', { className: 'dmv-btn', disabled: busy || !dirty, onClick: revert }, '还原'),
          h('button', { className: 'dmv-btn', disabled: busy, onClick: stop }, '停止播放'),
          status
            ? h('div', { className: `dmv-status ${statusBad ? 'dmv-bad' : 'dmv-ok'}` }, status)
            : (dirty ? h('div', { className: 'dmv-dirty' }, '有未保存的修改') : null),
        ),
      )
    }

    /* ── 页面播放 ──────────────────────────────────────────────
       声音在页面里放，宿主只把音频排进队列。页面每几秒打一次心跳，
       再长轮询取句；AudioContext 未经交互起不来，所以首次点击或按键
       时补一次 resume。 */
    const player = (() => {
      let audio = null
      let since = 0
      let seq = 0
      let alive = false
      let chain = Promise.resolve()
      let current = null

      function ctxOf() {
        if (audio && audio.state !== 'closed') return audio
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        audio = new Ctor()
        return audio
      }

      function stopNow() {
        if (current) {
          try { current.stop() } catch { /* 已经停了 */ }
          current = null
        }
        chain = Promise.resolve()
      }

      function enqueue(job) {
        chain = chain.then(() => playJob(job)).catch((e) => {
          console.warn('[dsh-mimo-voice] 播放失败：', e && e.message ? e.message : e)
        })
      }

      function playJob(job) {
        if (job && job.stream) return playStream(job)
        if (!job || !job.url) return Promise.resolve()
        return playOne(job.url)
      }

      async function playOne(url) {
        const ac = ctxOf()
        if (!ac) return
        if (ac.state === 'suspended') { try { await ac.resume() } catch { /* 还没交互 */ } }
        const r = await fetch(url, { cache: 'no-store' })
        if (!r.ok) throw new Error(`取音频失败 ${r.status}`)
        const decoded = await ac.decodeAudioData(await r.arrayBuffer())
        await new Promise((resolve) => {
          const src = ac.createBufferSource()
          src.buffer = decoded
          src.connect(ac.destination)
          current = src
          src.onended = () => { if (current === src) current = null; resolve() }
          src.start()
        })
      }

      /** 流式播放：PCM 边到边排，块与块首尾相接，不等整段合成完。
       *
       *  坑一：AudioBufferSourceNode.start() 的起播时刻会被取整到渲染量子（128 帧），
       *  块长不是量子的整数倍时每个接缝漏一小段静音，听起来像电流声。
       *  坑二：把 24k 的 AudioBuffer 交给 48k 的上下文，浏览器会对**每个块单独**
       *  做一次重采样，块的边缘必然有滤波器起停的瞬态，22 块/秒就是一片沙沙声。
       *  坑三：每块首尾加淡入淡出能盖住接缝，但那本身是 22Hz 的振幅调制，
       *  声音会发虚、像对着话筒喘气。
       *
       *  做法：自己按上下文采样率重采样（线性插值，跨块保留相位和上一采样），
       *  输出块长取量子整数倍、不做淡入淡出。这样拼出来是一条连续的曲线，
       *  浏览器不用再碰它，也就没有接缝可漏。 */
      async function playStream(job) {
        const ac = ctxOf()
        if (!ac) return
        if (ac.state === 'suspended') { try { await ac.resume() } catch { /* 还没交互 */ } }
        const id = Number(job.stream) || 0
        const r = await fetch(`/api/dsh-mimo-voice.stream?id=${id}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(`取流失败 ${r.status}`)
        if (!r.body || typeof r.body.getReader !== 'function') {
          throw new Error('当前环境不支持分段读取')
        }
        const rate = Number(r.headers.get('X-Sample-Rate')) || Number(job.sr) || 24000
        const ctxRate = ac.sampleRate || 48000

        // 输出块长：量子的整数倍，且落在 20ms 以上，别碎成一片。
        const EMIT = 128 * Math.max(1, Math.round((ctxRate * 0.04) / 128))
        const step = rate / ctxRate       // 每输出一个采样，输入位置前进多少

        const reader = r.body.getReader()
        let rest = null
        let pos = 0                       // 输入块内的浮点位置
        let prev = 0                      // 上一个输入采样，跨块插值要用
        let acc = new Float32Array(0)     // 还没凑够 EMIT 的输出
        let cursor = 0                    // 上下文帧（小数）：下一块该从哪儿起
        let last = null

        const emit = (data) => {
          const buffer = ac.createBuffer(1, data.length, ctxRate)
          buffer.getChannelData(0).set(data)
          const src = ac.createBufferSource()
          src.buffer = buffer
          src.connect(ac.destination)
          const now = ac.currentTime * ctxRate
          if (cursor < now) cursor = now   // 落后了就把缺口跳过去，别叠着放
          src.start(cursor / ctxRate)
          cursor += data.length
          current = src
          last = src
          src.onended = () => { if (current === src) current = null }
        }

        const push = (out) => {
          if (!out.length) return
          const merged = new Float32Array(acc.length + out.length)
          merged.set(acc)
          merged.set(out, acc.length)
          let off = 0
          while (merged.length - off >= EMIT) {
            emit(merged.subarray(off, off + EMIT))
            off += EMIT
          }
          acc = merged.slice(off)
        }

        // 把一块输入采样按上下文采样率重采样。块内位置 pos 可以跨到负数，
        // 那表示要用上一块留下的采样 prev 来插值——接缝就藏在这里。
        const convert = (samples) => {
          const n = samples.length
          if (!n) return new Float32Array(0)
          const at0 = (i) => (i < 0 ? prev : (i < n ? samples[i] : samples[n - 1]))
          const out = []
          let at = pos
          while (at < n - 1) {
            const i0 = Math.floor(at)
            const frac = at - i0
            const a = at0(i0)
            const b = at0(i0 + 1)
            out.push(a + (b - a) * frac)
            at += step
          }
          pos = at - n
          prev = samples[n - 1]
          return Float32Array.from(out)
        }

        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          let chunk = value
          if (rest) {
            const joined = new Uint8Array(rest.length + chunk.length)
            joined.set(rest)
            joined.set(chunk, rest.length)
            chunk = joined
          }
          const usable = chunk.length - (chunk.length % 2)
          rest = usable < chunk.length ? chunk.slice(usable) : null
          if (usable === 0) continue
          const ab = new ArrayBuffer(usable)
          new Uint8Array(ab).set(chunk.subarray(0, usable))
          const pcm = new Int16Array(ab)
          const samples = new Float32Array(pcm.length)
          for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768
          push(convert(samples))
        }
        if (acc.length) emit(acc)   // 尾巴不够一块，也放出去

        // 等最后一块放完再让下一句进来，别叠着放。
        if (last) {
          await new Promise((resolve) => {
            const timer = setInterval(() => {
              if (cursor <= ac.currentTime * ctxRate) { clearInterval(timer); resolve() }
            }, 120)
            setTimeout(() => { clearInterval(timer); resolve() }, 180000)
          })
        }
      }

      async function beat() {
        while (alive) {
          try {
            const r = await fetch(`/api/dsh-mimo-voice.queue?since=${since}&wait=20000`, { cache: 'no-store' })
            if (!r.ok) throw new Error(String(r.status))
            const json = await r.json()
            const next = Number(json.seq) || 0
            const jobs = Array.isArray(json.jobs) ? json.jobs : []
            if (jobs.length === 0 && next > seq && next > since) stopNow()
            seq = next
            for (const job of jobs) {
              const id = Number(job.id) || 0
              if (id > since) { since = id; enqueue(job) }
            }
          } catch { await new Promise((r) => setTimeout(r, 3000)) }
        }
      }

      function start() {
        if (alive) return
        alive = true
        const wake = () => {
          const ac = ctxOf()
          if (ac && ac.state === 'suspended') ac.resume().catch(() => {})
        }
        try {
          document.addEventListener('click', wake, true)
          document.addEventListener('keydown', wake, true)
        } catch { /* 没有 document 就算了 */ }
        beat()
      }

      return { start }
    })()

    const CARD_KEYS = ['dsh-mimo-voice', 'include:dsh-mimo-voice']

    const renderCard = (props) => (props && props.view === 'summary' ? null : h(Card))

    function apply(ctx) {
      injectStyles()

      // 播放器随插件启动，与卡片是否渲染无关：设置页开着不开着都能出声。
      try { player.start() } catch (e) { console.error('[dsh-mimo-voice] 页面播放启动失败：', e) }

      // 三个位置都挂一遍。keyed 槽位只认「包的安装名」，而 Desktop 可能把同一个包
      // 以 `include:<name>` 的形式挂在 Loader 里，于是两种拼法都注册，冲突不了。
      try {
        ctx.slots.inject('plugins.bundle.config', () => {
          const done = []
          for (const key of CARD_KEYS) {
            done.push(ctx.slots.register({ name: 'plugins.bundle.config', key }, renderCard))
          }
          return done
        })
      } catch (e) {
        console.error('[dsh-mimo-voice] bundle.config 挂载失败：', e)
      }

      // 独立一页：设置 → 插件 →「语音输出」。
      try {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
          { name: 'settings.plugins.tab', id: NAMESPACE, order: 61, label: () => '语音输出' },
          () => h(Card),
        ))
      } catch (e) {
        console.error('[dsh-mimo-voice] 插件页挂载失败：', e)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})

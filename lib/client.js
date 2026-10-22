/**
 * dsh-mimo-voice — 浏览器半边（客户端 bundle）。
 *
 * 只做一件事：在 设置 → 插件 里挂一张卡片，让人填 API 密钥、改音色描述、
 * 点试听。数据不走 settings 命名空间（web profile 有白名单，第三方命名空间
 * 写不进去），直接打宿主自己注册的 /api/dsh-mimo-voice.* 路由。
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
    const { useState, useEffect, useCallback } = React

    const API = '/api/dsh-mimo-voice'
    const NAMESPACE = 'dsh-mimo-voice'
    const DEFAULT_PREVIEW_TEXT = '红豆生南国，春来发几枝。愿君多采撷，此物最相思。'

    function injectStyles() {
      if (document.getElementById('dsh-mimo-voice-style')) return
      const tag = document.createElement('style')
      tag.id = 'dsh-mimo-voice-style'
      tag.textContent = `
.dmv-card { display: flex; flex-direction: column; gap: 12px; }
.dmv-row { display: flex; flex-direction: column; gap: 6px; }
.dmv-label { font-size: 13px; font-weight: 600; opacity: .9; }
.dmv-hint { font-size: 12px; opacity: .6; line-height: 1.5; }
.dmv-input, .dmv-textarea {
  width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-input, transparent); color: inherit;
  font-size: 13px; font-family: inherit;
}
.dmv-textarea { min-height: 76px; resize: vertical; line-height: 1.6; }
.dmv-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dmv-btn {
  padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-elevated, transparent); color: inherit;
}
.dmv-btn:disabled { opacity: .45; cursor: not-allowed; }
.dmv-btn-primary { background: var(--dsw-alias-brand-bg, #4a7cf0); color: #fff; border-color: transparent; }
.dmv-status { font-size: 12px; line-height: 1.5; }
.dmv-ok { color: #2f9e6a; }
.dmv-bad { color: #d1534b; }
.dmv-saved { font-size: 12px; opacity: .65; }
.dmv-switch { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
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
      const [autoSpeak, setAutoSpeak] = useState(false)
      const [alertOnApproval, setAlertOnApproval] = useState(false)
      const [pinned, setPinned] = useState(false)
      const [canKeep, setCanKeep] = useState(false)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)

      const adopt = useCallback((cfg) => {
        if (!cfg) return
        setHasKey(cfg.hasKey === true)
        setAutoSpeak(cfg.autoSpeak === true)
        setAlertOnApproval(cfg.alertOnApproval === true)
        setPinned(cfg.pinned === true)
        setCanKeep(cfg.canKeep === true)
        if (typeof cfg.voiceDesign === 'string') setVoice(cfg.voiceDesign)
      }, [])

      useEffect(() => {
        let alive = true
        callConfig()
          .then((json) => {
            if (!alive) return
            adopt(json.config)
            setLoaded(true)
          })
          .catch((e) => { if (alive) { setStatus(`读取设置失败：${e.message}`); setLoaded(true) } })
        return () => { alive = false }
      }, [adopt])

      const save = useCallback(async () => {
        setBusy(true)
        setStatus('')
        try {
          const patch = { autoSpeak, alertOnApproval }
          if (keyDraft.trim().length > 0) patch.apiKey = keyDraft.trim()
          const json = await callConfig(patch)
          if (json.success) {
            adopt(json.config)
            setKeyDraft('')
            setStatus('存好了')
          } else {
            setStatus(`保存失败：${json.message}`)
          }
        } catch (e) {
          setStatus(`保存失败：${e.message}`)
        } finally {
          setBusy(false)
        }
      }, [keyDraft, autoSpeak, alertOnApproval, adopt])

      // 「试试这个声音」「换一个」都是这一件事：拿框里的描述现造一条，当场放。
      const tryVoice = useCallback(async () => {
        const text = previewText.trim()
        if (text === '') { setStatus('先写点要念的字'); return }
        if (voice.trim() === '') { setStatus('先写一句音色描述'); return }
        setBusy(true)
        setStatus('在造声音…')
        try {
          const res = await fetch(`${API}.preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voiceDesign: voice.trim() }),
          })
          const json = await res.json()
          setStatus(json.success ? '在放了——不满意就点「换一个」' : `没造出来：${json.message}`)
          if (json.success) {
            setCanKeep(true)
            setPinned(false)
          }
        } catch (e) {
          setStatus(`没造出来：${e.message}`)
        } finally {
          setBusy(false)
        }
      }, [previewText, voice])

      const keep = useCallback(async () => {
        setBusy(true)
        setStatus('在定…')
        try {
          const res = await fetch(`${API}.pin`, { method: 'POST' })
          const json = await res.json()
          if (json.success) {
            setPinned(true)
            setCanKeep(false)
            setStatus('就它了，往后都是这个声音')
          } else {
            setStatus(`没定上：${json.message}`)
          }
        } catch (e) {
          setStatus(`没定上：${e.message}`)
        } finally {
          setBusy(false)
        }
      }, [])

      // 切回现造：快，但声音每回不一样。
      const unpin = useCallback(async () => {
        setBusy(true)
        setStatus('在切…')
        try {
          const json = await callConfig({ voiceMode: 'design' })
          if (json.success) {
            setPinned(false)
            setStatus('切回现造了，快是快，声音每回不一样')
          } else {
            setStatus(`没切上：${json.message}`)
          }
        } catch (e) {
          setStatus(`没切上：${e.message}`)
        } finally {
          setBusy(false)
        }
      }, [])

      const stop = useCallback(async () => {
        try { await fetch(`${API}.stop`, { method: 'POST' }) } catch { /* 断了就断了 */ }
        setStatus('停了')
      }, [])

      if (!loaded) return h('div', { className: 'dmv-card' }, h('div', { className: 'dmv-hint' }, '读设置…'))

      return h('div', { className: 'dmv-card' },
        h('div', { className: 'dmv-row' },
          h('span', { className: 'dmv-label' }, '音色描述'),
          h('textarea', {
            className: 'dmv-textarea',
            value: voice,
            onChange: (e) => setVoice(e.target.value),
          }),
          h('div', { className: 'dmv-actions' },
            h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy, onClick: tryVoice }, '试试这个声音'),
            h('button', { className: 'dmv-btn', disabled: busy, onClick: tryVoice }, '换一个'),
          ),
          h('span', { className: 'dmv-hint' }, '点一下就按这段描述现造一条念给你听。不满意换个词，或者直接再点一次。'),
        ),
        h('div', { className: 'dmv-row' },
          h('span', { className: 'dmv-label' }, '试听要说的话'),
          h('textarea', {
            className: 'dmv-textarea',
            value: previewText,
            placeholder: DEFAULT_PREVIEW_TEXT,
            onChange: (e) => setPreviewText(e.target.value),
          }),
        ),
        h('div', { className: 'dmv-row' },
          h('span', { className: 'dmv-label' }, '现在用的'),
          h('span', { className: 'dmv-hint' }, pinned ? '刚定下来的那条，往后一直用它。' : '现造，每次声音会变，但快。'),
          h('div', { className: 'dmv-actions' },
            h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy || !canKeep, onClick: keep }, '就它了'),
            pinned ? h('button', { className: 'dmv-btn', disabled: busy, onClick: unpin }, '切回现造') : null,
          ),
          h('span', { className: 'dmv-hint' }, canKeep ? '听着满意就点「就它了」，把刚那条留成样本。' : '先点「试试这个声音」，听到满意的再点这里。'),
        ),
        h('div', { className: 'dmv-row' },
          h('label', { className: 'dmv-switch' },
            h('input', {
              type: 'checkbox',
              checked: autoSpeak,
              onChange: (e) => setAutoSpeak(e.target.checked),
            }),
            h('span', null, '自动出声'),
          ),
          h('span', { className: 'dmv-hint' }, '打开后我每段话挑一句念出来。改完点保存。'),
        ),
        h('div', { className: 'dmv-row' },
          h('label', { className: 'dmv-switch' },
            h('input', {
              type: 'checkbox',
              checked: alertOnApproval,
              onChange: (e) => setAlertOnApproval(e.target.checked),
            }),
            h('span', null, '要你确认时喊我'),
          ),
          h('span', { className: 'dmv-hint' }, '我卡在审批上等你点的时候，念一句提醒你。改完点保存。'),
        ),
        h('div', { className: 'dmv-row' },
          h('span', { className: 'dmv-label' }, 'API 密钥'),
          h('input', {
            className: 'dmv-input',
            type: 'password',
            value: keyDraft,
            placeholder: hasKey ? '已经存了，要换就填新的' : 'sk-… 填小米 MiMo 的密钥',
            onChange: (e) => setKeyDraft(e.target.value),
          }),
          h('span', { className: 'dmv-hint' }, hasKey ? '密钥已保存，不会回显。' : '还没填，先在这里填一次。'),
        ),
        h('div', { className: 'dmv-actions' },
          h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy, onClick: save }, '保存'),
          h('button', { className: 'dmv-btn', disabled: busy, onClick: stop }, '停'),
        ),
        status ? h('div', { className: `dmv-status ${status.includes('失败') || status.includes('没') ? 'dmv-bad' : 'dmv-ok'}` }, status) : null,
      )
    }

    const CARD_KEYS = ['dsh-mimo-voice', 'include:dsh-mimo-voice']

    const renderCard = (props) => (props && props.view === 'summary' ? null : h(Card))

    function apply(ctx) {
      injectStyles()

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

      // 再给一个自己的一页，位置最显眼：设置 → 插件 →「MiMo 声音」。
      try {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
          { name: 'settings.plugins.tab', id: NAMESPACE, order: 61, label: () => 'MiMo 声音' },
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

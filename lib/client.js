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
.dmv-card { display: flex; flex-direction: column; gap: 14px; }

/* 顶部：标题 + 当前是哪种声音 */
.dmv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dmv-title { font-size: 15px; font-weight: 700; line-height: 1.4; }
.dmv-sub { font-size: 12px; opacity: .55; line-height: 1.6; margin-top: 4px; }
.dmv-badge {
  flex: none; font-size: 11px; line-height: 1; padding: 5px 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35));
  opacity: .65; white-space: nowrap;
}
.dmv-badge-on { opacity: 1; color: #2f9e6a; border-color: #2f9e6a; }

/* 分区：一个框一件事 */
.dmv-section {
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.28));
  border-radius: 12px; overflow: hidden;
}
.dmv-section-head {
  display: flex; align-items: center; gap: 9px; padding: 10px 14px;
  background: var(--dsw-alias-bg-elevated, rgba(128,128,128,.06));
  font-size: 13px; font-weight: 600;
}
.dmv-step {
  flex: none; width: 18px; height: 18px; border-radius: 999px; font-size: 11px;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-border-default, rgba(128,128,128,.3)); opacity: .8;
}
.dmv-section-body { display: flex; flex-direction: column; gap: 11px; padding: 14px; }

.dmv-field { display: flex; flex-direction: column; gap: 6px; }
.dmv-field-label { font-size: 12px; font-weight: 600; opacity: .8; }
.dmv-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dmv-divider { height: 1px; background: var(--dsw-alias-border-default, rgba(128,128,128,.28)); }

/* 开关做成整块可点，比小方框好点中 */
.dmv-toggle {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.28));
  cursor: pointer; transition: border-color .15s;
}
.dmv-toggle:hover { border-color: var(--dsw-alias-border-strong, rgba(128,128,128,.55)); }
.dmv-toggle-on { border-color: var(--dsw-alias-brand-bg, #4a7cf0); }
.dmv-toggle input { margin: 2px 0 0; flex: none; }
.dmv-toggle-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dmv-toggle-title { display: block; font-size: 13px; font-weight: 600; line-height: 1.4; }
.dmv-toggle-note { display: block; font-size: 12px; opacity: .55; line-height: 1.55; }

/* 底部：保存 + 状态，跟着滚到底 */
.dmv-footer {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-elevated, rgba(128,128,128,.06));
}
.dmv-footer .dmv-status { flex: 1; min-width: 0; }

.dmv-hint { font-size: 12px; opacity: .6; line-height: 1.5; }
.dmv-input, .dmv-textarea {
  width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-input, transparent); color: inherit;
  font-size: 13px; font-family: inherit;
}
.dmv-textarea { min-height: 76px; resize: vertical; line-height: 1.6; }
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
.dmv-lines { display: flex; flex-direction: column; gap: 6px; }
.dmv-line {
  display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35));
  font-size: 13px; line-height: 1.5;
}
.dmv-line-text { flex: 1; min-width: 0; word-break: break-word; }
.dmv-line-del {
  flex: none; padding: 0 8px; border-radius: 6px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35));
  background: transparent; color: inherit; opacity: .7;
}
.dmv-line-del:hover { opacity: 1; color: #d1534b; border-color: #d1534b; }
.dmv-empty { font-size: 12px; opacity: .55; padding: 4px 0; }
.dmv-add { display: flex; gap: 8px; align-items: stretch; }
.dmv-add .dmv-input { flex: 1; }
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
      // 自己写的提醒语，一条一个；空数组表示还在用出厂那句。
      const [alertList, setAlertList] = useState([])
      const [alertDraft, setAlertDraft] = useState('')
      const [defaultAlertLines, setDefaultAlertLines] = useState([])
      const [pinned, setPinned] = useState(false)
      const [canKeep, setCanKeep] = useState(false)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)

      const adopt = useCallback((cfg) => {
        if (!cfg) return
        setHasKey(cfg.hasKey === true)
        setAutoSpeak(cfg.autoSpeak === true)
        setAlertOnApproval(cfg.alertOnApproval === true)
        if (Array.isArray(cfg.approvalLines)) setAlertList(cfg.approvalLines)
        if (Array.isArray(cfg.defaultApprovalLines)) setDefaultAlertLines(cfg.defaultApprovalLines)
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
          const patch = {
            autoSpeak,
            alertOnApproval,
            approvalLines: alertList,
          }
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
      }, [keyDraft, autoSpeak, alertOnApproval, alertList, adopt])

      // 加一条：写进框里，按「加进去」。重复的不再加。
      const addAlertLine = useCallback(() => {
        const text = alertDraft.trim()
        if (text === '') { setStatus('先写一句要念的话'); return }
        if (alertList.includes(text)) { setStatus('这句已经有了'); return }
        if (alertList.length >= 40) { setStatus('最多 40 条，先删几条'); return }
        setAlertList((prev) => [...prev, text])
        setAlertDraft('')
        setStatus('加上了，记得点保存')
      }, [alertDraft, alertList])

      // 删一条：按内容删，删完点保存才落到磁盘。
      const removeAlertLine = useCallback((text) => {
        setAlertList((prev) => prev.filter((l) => l !== text))
        setStatus('删了，记得点保存')
      }, [])

      const resetAlertLines = useCallback(() => {
        setAlertList(defaultAlertLines.slice())
        setStatus('填回默认了，记得点保存')
      }, [defaultAlertLines])

      const clearAlertLines = useCallback(() => {
        setAlertList([])
        setStatus('清空了，记得点保存')
      }, [])

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

      // 一行小工具：分区外壳。step 是左上角那个小圈里的序号。
      const section = (step, title, ...body) => h('div', { className: 'dmv-section' },
        h('div', { className: 'dmv-section-head' },
          step ? h('span', { className: 'dmv-step' }, step) : null,
          h('span', null, title),
        ),
        h('div', { className: 'dmv-section-body' }, ...body),
      )

      // 开关整块都能点，比只点小方框省事。
      const toggle = (on, title, note, onToggle) => h('label', {
        className: `dmv-toggle${on ? ' dmv-toggle-on' : ''}`,
      },
        h('input', { type: 'checkbox', checked: on, onChange: (e) => onToggle(e.target.checked) }),
        h('span', { className: 'dmv-toggle-main' },
          h('span', { className: 'dmv-toggle-title' }, title),
          note ? h('span', { className: 'dmv-toggle-note' }, note) : null,
        ),
      )

      return h('div', { className: 'dmv-card' },

        // ── 头部：这是干什么的，现在是什么状态 ──
        h('div', { className: 'dmv-head' },
          h('div', null,
            h('div', { className: 'dmv-title' }, 'MiMo 声音'),
            h('div', { className: 'dmv-sub' }, hasKey
              ? '调好点「保存」，之后就按这里的设置出声。'
              : '先在下面填小米 MiMo 的密钥，填完才能发声。'),
          ),
          h('span', { className: `dmv-badge${hasKey ? ' dmv-badge-on' : ''}` }, hasKey ? '密钥已填' : '缺密钥'),
        ),

        // ── 一、声音长什么样 ──
        section('1', '声音',
          h('div', { className: 'dmv-field' },
            h('span', { className: 'dmv-field-label' }, '音色描述'),
            h('textarea', {
              className: 'dmv-textarea',
              value: voice,
              placeholder: '比如：三十二岁左右的成年女性，中低音，带一点烟嗓',
              onChange: (e) => setVoice(e.target.value),
            }),
            h('span', { className: 'dmv-hint' }, '按这段字现造一条念给你听。不满意就改词，或直接再点一次。'),
          ),
          h('div', { className: 'dmv-field' },
            h('span', { className: 'dmv-field-label' }, '试听念什么'),
            h('textarea', {
              className: 'dmv-textarea',
              value: previewText,
              placeholder: DEFAULT_PREVIEW_TEXT,
              onChange: (e) => setPreviewText(e.target.value),
            }),
          ),
          h('div', { className: 'dmv-inline' },
            h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy, onClick: tryVoice }, '试试这个声音'),
            h('button', { className: 'dmv-btn', disabled: busy, onClick: tryVoice }, '换一个'),
          ),
          h('div', { className: 'dmv-divider' }),
          h('div', { className: 'dmv-field' },
            h('span', { className: 'dmv-field-label' }, '现在用的'),
            h('span', { className: 'dmv-hint' }, pinned
              ? '定下来那条，往后一直用，声音不变。'
              : canKeep
                ? '还是现造的，每次不一样。听着满意就点「就它了」定住。'
                : '现造，每次声音会变，但快。先试听再决定要不要定住。'),
            h('div', { className: 'dmv-inline' },
              h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy || !canKeep, onClick: keep }, '就它了'),
              pinned ? h('button', { className: 'dmv-btn', disabled: busy, onClick: unpin }, '切回现造') : null,
            ),
          ),
        ),

        // ── 二、什么时候出声 ──
        section('2', '什么时候出声',
          toggle(autoSpeak, '自动出声', '每段回复挑一句念出来。', setAutoSpeak),
          toggle(alertOnApproval, '要你确认时喊我', '卡在审批上等你点的时候，念一句提醒。', setAlertOnApproval),
          h('div', { className: 'dmv-divider' }),
          h('div', { className: 'dmv-field' },
            h('span', { className: 'dmv-field-label' }, '审批提醒说什么'),
            alertList.length === 0
              ? h('div', { className: 'dmv-empty' }, `还没加，现在念的是出厂那句：${defaultAlertLines[0] || '任务需要权限，请审批。'}`)
              : h('div', { className: 'dmv-lines' },
                  alertList.map((line, i) => h('div', { className: 'dmv-line', key: `${i}-${line}` },
                    h('span', { className: 'dmv-line-text' }, line),
                    h('button', {
                      className: 'dmv-line-del',
                      disabled: busy,
                      onClick: () => removeAlertLine(line),
                      title: '删掉这条',
                    }, '删'),
                  )),
                ),
            h('div', { className: 'dmv-add' },
              h('input', {
                className: 'dmv-input',
                value: alertDraft,
                placeholder: '写一句，回车加进去',
                onChange: (e) => setAlertDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addAlertLine() } },
              }),
              h('button', { className: 'dmv-btn', disabled: busy, onClick: addAlertLine }, '加进去'),
            ),
            h('div', { className: 'dmv-inline' },
              h('button', { className: 'dmv-btn', disabled: busy, onClick: resetAlertLines }, '填回出厂那句'),
              h('button', { className: 'dmv-btn', disabled: busy || alertList.length === 0, onClick: clearAlertLines }, '清空'),
            ),
            h('span', { className: 'dmv-hint' }, '加几条就随机挑一条念；一条没有就用出厂那句。句首可加（语速快，很焦急）调语气。'),
          ),
        ),

        // ── 三、密钥 ──
        section('3', '密钥',
          h('div', { className: 'dmv-field' },
            h('span', { className: 'dmv-field-label' }, '小米 MiMo 的密钥'),
            h('input', {
              className: 'dmv-input',
              type: 'password',
              value: keyDraft,
              placeholder: hasKey ? '已经存了，要换就填新的' : 'sk-… 填小米 MiMo 的密钥',
              onChange: (e) => setKeyDraft(e.target.value),
            }),
            hasKey ? h('span', { className: 'dmv-hint' }, '密钥已保存') : h('span', { className: 'dmv-hint' }, '还没填，填一次就好。'),
          ),
        ),

        // ── 底部：保存 ──
        h('div', { className: 'dmv-footer' },
          h('button', { className: 'dmv-btn dmv-btn-primary', disabled: busy, onClick: save }, '保存'),
          h('button', { className: 'dmv-btn', disabled: busy, onClick: stop }, '停'),
          status ? h('div', { className: `dmv-status ${status.includes('失败') || status.includes('没') ? 'dmv-bad' : 'dmv-ok'}` }, status) : null,
        ),
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

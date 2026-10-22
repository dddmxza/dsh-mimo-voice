/**
 * 冒烟测试：用假 ctx 跑 apply()，确认工具注册和四条路由都能落地，
 * 再走一遍「合成 → 落盘 → 播放」的真实链路（需要 config.json 里有 key）。
 *
 * 用法：
 *   node test/smoke.mjs          只测注册，不联网
 *   node test/smoke.mjs --speak  真的合成一句并播出去
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const tools = []
const routes = []
const events = []
const ctx = {
  on: (name, fn) => { events.push({ name, fn }); return () => {} },
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
}

const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)
mod.apply(ctx)

assert.equal(mod.name, 'dsh-mimo-voice')
assert.equal(typeof mod.inject, 'object')
console.log('监听 OK：', events.map((e) => e.name).join(' | '))

assert.equal(tools.length, 1, '应当注册 1 个工具')
const speak = tools[0]
assert.equal(speak.name, 'speak')
assert.equal(typeof speak.execute, 'function')
assert.ok(speak.parameters.properties.text, 'speak 要有 text 参数')
assert.deepEqual(speak.parameters.required ?? [], [], '两个参数都可省')
assert.equal(typeof speak.output.render, 'function')
console.log('工具 OK：', speak.name, '参数', Object.keys(speak.parameters.properties).join('/'))

const wantPaths = [
  '/api/dsh-mimo-voice.config',
  '/api/dsh-mimo-voice.preview',
  '/api/dsh-mimo-voice.speak',
  '/api/dsh-mimo-voice.stop',
]
for (const p of wantPaths) {
  const hit = routes.find((r) => r.path === p)
  assert.ok(hit, `缺路由 ${p}`)
  assert.equal(hit.kind, 'exact')
  assert.equal(typeof hit.handler, 'function')
}
console.log('路由 OK：', routes.map((r) => `${r.kind} ${r.path}`).join(' | '))

// 配置视图不能把 key 原文吐出来
const cfgRoute = routes.find((r) => r.path === '/api/dsh-mimo-voice.config')
const captured = await new Promise((resolve) => {
  const res = {
    writeHead: () => {},
    end: (body) => resolve(JSON.parse(body)),
  }
  cfgRoute.handler({ method: 'GET' }, res)
})
assert.equal(typeof captured.config.hasKey, 'boolean')
assert.ok(!('apiKey' in captured.config), 'apiKey 原文不能出现在响应里')
assert.ok(captured.config.previewText.includes('红豆生南国'))
console.log('配置 OK：hasKey =', captured.config.hasKey, '| 音频目录', captured.config.audioDir)

if (process.argv.includes('--speak')) {
  const result = await speak.execute({ text: '嗯，我在。', wait: true }, {})
  console.log('合成结果：', result.success, '|', result.message)
  if (!result.success) process.exitCode = 1
  else console.log('文件：', result.file)
}

console.log('\n全部通过')

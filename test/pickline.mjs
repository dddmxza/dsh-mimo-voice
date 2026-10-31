/**
 * pickLine 的单元测试：自动出声到底念哪句。
 * 不联网，只验挑选规则。
 *
 * 用法：node test/pickline.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)
const { pickLine, SPEAK_MARK, SPEAK_MAX } = mod

const cases = [
  // 记号优先
  [`${SPEAK_MARK}端着多累啊。`, '端着多累啊。', '只写记号那行'],
  [`前面一句。\n${SPEAK_MARK}真正该念的。\n后面一句。`, '真正该念的。', '记号不在第一行也能找到'],
  [`${SPEAK_MARK}（小声）我在这儿。`, '（小声）我在这儿。', '记号后紧跟的括号算语气，留着送 TTS'],
  [`${SPEAK_MARK}（懒懒地，尾音压着）真不用急。`, '（懒懒地，尾音压着）真不用急。', '语气可以带逗号'],
  [`${SPEAK_MARK}端着多累啊。（这句注释得删）`, '端着多累啊。', '没语气时括号照旧删'],
  [`${SPEAK_MARK}\n正文第一句在这儿。`, '正文第一句在这儿。', '记号那行是空的，退回老规矩'],

  // 没记号，退回第一句
  ['对，这个我记着。后面还有一句。', '对，这个我记着。', '取第一句'],
  ['嗯。这话得慢慢说。', '嗯。这话得慢慢说。', '太短的开头并下一句'],

  // 括号
  ['（懒懒地）端着多累啊。', '端着多累啊。', '行首括号去掉，不整行扔'],
  ['不算优秀，只能算够用。（它靠的是约定，不是判断。）', '不算优秀，只能算够用。', '句中括号去掉'],
  ['一，带括号的正文（注释）照样能念。', '一，带括号的正文照样能念。', '括号留在句中也不整行扔'],
  ['(小声)ok，这句可以念。', 'ok，这句可以念。', '半角括号同样只删括号'],

  // 过滤
  ['```\nconst a = 1\n```\n真正的第一句在这儿。', '真正的第一句在这儿。', '跳过代码块'],
  ['https://example.com 这句不该念。', '', '带链接的行跳过'],
]

let pass = 0
for (const [input, want, name] of cases) {
  const got = pickLine(input)
  assert.equal(got, want, `【${name}】期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  pass += 1
}

// 超长退到标点，不要把词切断
const long = '行。' + '后面这句要短一点说完，'.repeat(6) + '。'
const cut = pickLine(long)
assert.ok(cut.length <= SPEAK_MAX, `超长应当被截到 ${SPEAK_MAX} 以内，实得 ${cut.length}`)
assert.ok(/[。！？～…；，]$/.test(cut), `截断应当落在标点上，实得结尾 ${JSON.stringify(cut.slice(-2))}`)
pass += 1

// 全是代码时不念
assert.equal(pickLine('```\nconst x = 1\n```'), '', '只有代码块就不念')
pass += 1

console.log(`pickLine 全过：${pass} 条`)

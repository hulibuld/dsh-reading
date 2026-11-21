/**
 * humanizeError 的守卫（0.13.1）。
 *
 * 起因：书源导入失败时界面弹的是「出了点问题，请稍后再试。」——宿主明明回的是
 * 「E_LEGADO_BAD_JSON: 这个文件不是合法的书源 JSON，检查一下有没有复制全。」，
 * 一句话也没漏出来。根因在 humanizeError 里：它先查已知码表，命中就把整段交给
 * 表里的固定文案；一旦这个码没进表，后面的 MACHINE_PATTERNS 又会命中
 * /\bE_[A-Z][A-Z0-9_]+\b/，整句被顶成 GENERIC，后半段的中文一句都没用上。
 *
 * 这组测试钉三件事：
 *   1. 「码 + 人话」这种标准信封，人话必须原样出来（表里有没有这个码都一样）；
 *   2. 幂等 —— 把输出再喂回去，还是同一句话（界面会重复渲染同一段错误）；
 *   3. 真正该藏的东西仍然藏住：JSON、堆栈、绝对路径、未翻译的码、英文异常。
 */

import assert from 'node:assert/strict'
import { humanizeError } from '../client/src/api.js'

const GENERIC = '出了点问题，请稍后再试。'

export default async function run() {
  let passed = 0
  const cases = {
    '没收录的码也能把后面那句人话放出来'() {
      // 这一条就是这次的 bug 本身：码不在表里，但 message 是好中文。
      const out = humanizeError('E_SOMETHING_NEW: 这个文件夹里没有找到书源。')
      assert.equal(out, '这个文件夹里没有找到书源。')
      assert.ok(!out.includes('E_'), '不该把码透到界面上')
    },

    '表里有的码：码后面的人话优先于固定文案'() {
      // 宿主给的「书库目录不可写」比表里的通用说法更具体，应当用它。
      const out = humanizeError('E_FORBIDDEN: 书库目录不可写，检查一下权限。')
      assert.equal(out, '书库目录不可写，检查一下权限。')
    },

    '表里有的码、后面没跟人话时，退回表里的文案'() {
      assert.equal(
        humanizeError('E_LEGADO_BAD_JSON:'),
        '这个文件不是合法的书源 JSON，检查一下有没有复制全。',
      )
      assert.equal(
        humanizeError('E_IMPORT_UNKNOWN_FORMAT'),
        '这个格式还不支持。目前能读 EPUB、MOBI、AZW3、TXT、PDF 五种。',
      )
    },

    '幂等：输出再喂回去还是同一句话'() {
      const sources = [
        'E_SOMETHING_NEW: 这个文件夹里没有找到书源。',
        'E_LEGADO_BAD_JSON: 这个文件不是合法的书源 JSON，检查一下有没有复制全。',
        'E_FORBIDDEN: 书库目录不可写，检查一下权限。',
        GENERIC,
      ]
      for (const input of sources) {
        const once = humanizeError(input)
        assert.equal(humanizeError(once), once, '第二次不该变：' + input)
      }
    },

    '码后面跟的是机器语言时，一个字都不透出去'() {
      // 后半段是 JSON / 路径 / 英文异常 —— 这些仍然必须被挡住，只回表里的文案。
      const out = humanizeError('E_FORBIDDEN: {"path":"/Users/someone/book.epub","errno":-13}')
      assert.equal(out, '没有权限访问书库目录，请检查文件夹权限。')
      assert.ok(!out.includes('joyfon620'), '绝对路径不能出现在界面上')

      const stack = humanizeError('E_INTERNAL: TypeError: x is not a function at foo (/a/b.js:1:2)')
      assert.equal(stack, '后台出了点问题，请稍后再试。')
      assert.ok(!stack.includes('TypeError'))
    },

    '纯机器语言（没有码）仍然回落到通用文案'() {
      for (const input of [
        '{"ok":false,"error":{"code":"E_X"}}',
        'TypeError: Cannot read properties of undefined',
        'at file:///Users/someone/x.mjs:12:5',
        '/Users/someone/Documents/my vault',
      ]) {
        assert.equal(humanizeError(input), GENERIC, '应被挡住：' + input)
      }
    },

    '已经是人话的原文原样返回'() {
      assert.equal(humanizeError('磁盘空间不够了，腾出一些空间再试。'), '磁盘空间不够了，腾出一些空间再试。')
    },

    '断网类英文换成「连不上后台」'() {
      for (const input of ['Failed to fetch', 'ECONNREFUSED', 'ETIMEDOUT', 'fetch failed']) {
        const out = humanizeError(input)
        assert.ok(out.includes('连不上后台'), '应翻成离线文案：' + input + ' → ' + out)
      }
    },

    '空输入返回空串（表示没有可显示的信息）'() {
      assert.equal(humanizeError(''), '')
      assert.equal(humanizeError('   '), '')
      assert.equal(humanizeError(null), '')
      assert.equal(humanizeError(undefined), '')
    },

    '非字符串输入（真 Error 对象）也走同一条路'() {
      const err = new Error('E_LEGADO_EMPTY: 没有收到书源内容。')
      assert.equal(humanizeError(err), '没有收到书源内容。')
      // 传 Error 自己包装过的一句中文
      assert.equal(humanizeError(new Error(GENERIC)), GENERIC)
    },
  }

  for (const [name, fn] of Object.entries(cases)) {
    try {
      fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      console.error(`  ✗ ${name}`)
      throw error
    }
  }
  console.log(`humanize: ${passed} 项通过`)
}

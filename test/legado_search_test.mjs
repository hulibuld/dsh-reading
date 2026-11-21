#!/usr/bin/env node
/**
 * 书源搜索的三道守卫（0.13.2）。
 *
 * 起因：用户说「书源什么都搜不到」。实测根因有四层，全部是静默失败——
 * 界面上不报错，就是 0 条结果，所以用户只能得出「这功能没用」。
 *
 *   1. 路由写的是 `wanted.slice(0, 6)`：5086 个启用源里**永远只试前 6 个**，
 *      而文件里前 6 个恰好是坚果云（没搜索地址）、百度网盘（搜网盘不是搜书）、
 *      晋江和悸花（@js 规则跑不了）。于是搜什么都返回 0 条；
 *   2. searchUrl 里的尾部 JSON 配置（`,{"method":"POST","body":"kw={{key}}"}`）
 *      被当成地址的一部分丢给 fetch —— 1485 个源（占可用源 35%）永远打不中；
 *   3. 只写 body 不写 method 的源被当 GET 发，Node 直接抛
 *      「Request with GET/HEAD method cannot have body」；
 *   4. 规则写松的源把页头导航选成「书」，结果里一半是「首页 / 将本站设为首页 /
 *      玄幻小说」这种，真书被埋掉。
 *
 * 这组测试逐条钉住这四层。全部纯函数，不联网。
 */

import assert from 'node:assert/strict'
import { parseSearchUrl, fillBodyTemplate, fillUrlTemplate, sourceHealth, looksLikeBook, tidyResultText } from '../lib/legado.js'

export default async function run() {
  let passed = 0
  const cases = {
    '纯 URL：原样返回，不被误判成带配置'() {
      const spec = parseSearchUrl('https://a.test/search?key={{key}}')
      assert.equal(spec.url, 'https://a.test/search?key={{key}}')
      assert.equal(spec.config, null)
      assert.equal(spec.error, '')
    },

    '尾部 JSON 配置被拆出来，不再当地址的一部分'() {
      const raw = 'https://a.test/search, {"method":"POST","body":"kw={{key}}"}'
      const spec = parseSearchUrl(raw)
      assert.equal(spec.url, 'https://a.test/search')
      assert.equal(spec.config.method, 'POST')
      assert.equal(spec.config.body, 'kw={{key}}')
    },

    '地址本身带逗号不被误切'() {
      const spec = parseSearchUrl('https://a.test/s?tags=a,b&q={{key}}')
      assert.equal(spec.url, 'https://a.test/s?tags=a,b&q={{key}}')
      assert.equal(spec.config, null)
    },

    '配置里嵌套对象也能解析'() {
      const raw = 'https://a.test/s, {"method":"POST","body":"k={{key}}","headers":{"referer":"https://a.test/"}}'
      const spec = parseSearchUrl(raw)
      assert.equal(spec.config.headers.referer, 'https://a.test/')
    },

    '@js / <js> 形式的搜索地址被识别成脚本，不是地址'() {
      assert.equal(parseSearchUrl('@js:\nresult = \'x\'').error, 'script')
      assert.equal(parseSearchUrl('<js>return 1</js>').error, 'script')
    },

    '空地址不炸'() {
      const spec = parseSearchUrl('   ')
      assert.equal(spec.url, '')
      assert.equal(spec.error, '')
    },

    'body 模板换变量但不二次编码'() {
      const body = fillBodyTemplate('searchkey={{key}}&page={{page}}', { key: '三体', page: 2 })
      assert.equal(body, 'searchkey=三体&page=2')
    },

    'URL 模板照旧编码关键词'() {
      const url = fillUrlTemplate('https://a.test/s?q={{key}}', { key: '三体', page: 1 })
      assert.equal(url, 'https://a.test/s?q=' + encodeURIComponent('三体'))
    },

    '体检分档：能跑 / 要脚本 / 缺字段'() {
      const ok = { searchUrl: 'https://a.test/s?q={{key}}', ruleSearch: { bookList: 'class.item' } }
      assert.equal(sourceHealth(ok), 'ok')

      const post = { searchUrl: 'https://a.test/s, {"method":"POST","body":"k={{key}}"}', ruleSearch: { bookList: 'class.item' } }
      assert.equal(sourceHealth(post), 'ok')

      const jsUrl = { searchUrl: '@js:result=\'x\'', ruleSearch: { bookList: 'class.item' } }
      assert.equal(sourceHealth(jsUrl), 'script')

      const jsRule = { searchUrl: 'https://a.test/s?q={{key}}', ruleSearch: { bookList: '<js>result</js>' } }
      assert.equal(sourceHealth(jsRule), 'script')

      const noUrl = { searchUrl: '', ruleSearch: { bookList: 'class.item' } }
      assert.equal(sourceHealth(noUrl), 'broken')

      const noList = { searchUrl: 'https://a.test/s', ruleSearch: {} }
      assert.equal(sourceHealth(noList), 'broken')
    },

    '目录页导航词不是书'() {
      const nav = ['首页', '将本站设为首页', '加入收藏', '全本小说', '玄幻小说', '我的书架']
      for (const name of nav) {
        assert.equal(looksLikeBook({ name, author: '', bookUrl: 'http://a.test/b/1' }), false, name + ' 不该算书')
      }
    },

    '真书放过去'() {
      assert.equal(looksLikeBook({ name: '三体', author: '刘慈欣', bookUrl: 'http://a.test/b/1' }), true)
      assert.equal(looksLikeBook({ name: '盗墓笔记', author: '南派三叔', bookUrl: 'http://a.test/b/2' }), true)
      assert.equal(looksLikeBook({ name: '哈利波特与死亡圣器', author: 'JK罗琳', bookUrl: 'http://a.test/b/3' }), true)
    },

    '整页 HTML / 脚本被挡掉'() {
      assert.equal(looksLikeBook({ name: '<div>搜索结果</div>', author: '', bookUrl: 'http://a.test/b' }), false)
      assert.equal(looksLikeBook({ name: 'function(){}', author: '', bookUrl: 'http://a.test/b' }), false)
      assert.equal(looksLikeBook({ name: 'padding: 0', author: '', bookUrl: 'http://a.test/b' }), false)
    },

    '同一句刷屏被挡（覆盖九成以上才判）'() {
      assert.equal(looksLikeBook({ name: '搜索结果搜索结果搜索结果', author: 'x', bookUrl: 'http://a.test/b' }), false)
      assert.equal(looksLikeBook({ name: '武侠仙侠武侠仙侠', author: 'x', bookUrl: 'http://a.test/b' }), false)
      assert.equal(looksLikeBook({ name: '三体三体', author: 'x', bookUrl: 'http://a.test/b' }), false)
    },

    '作者字段抓到整块卡片时挡掉'() {
      // 真实样本：规则把卡片整段文本给了 author
      assert.equal(looksLikeBook({ name: '锦鲤娘娘', author: '锦鲤娘娘519.20万字武侠仙侠锦鲤娘娘', bookUrl: 'http://a.test/b' }), false)
    },

    '资源链接不是书'() {
      assert.equal(looksLikeBook({ name: 'style', author: '', bookUrl: 'http://a.test/css/bootstrap.min.css' }), false)
      assert.equal(looksLikeBook({ name: 'logo', author: '', bookUrl: 'http://a.test/logo.png' }), false)
      assert.equal(looksLikeBook({ name: '书', author: '', bookUrl: 'javascript:T.home()' }), false)
    },

    '字数与分类尾巴被切掉，书名本身不动'() {
      assert.equal(tidyResultText('九转霸体519.20万字武侠仙侠'), '九转霸体')
      assert.equal(tidyResultText('  多余   空白  '), '多余 空白')
      assert.equal(tidyResultText('三体'), '三体')
      assert.equal(tidyResultText('1984'), '1984', '书名里的纯数字不能被当成字数切掉')
    },
  }

  for (const [name, fn] of Object.entries(cases)) {
    try {
      fn()
      passed += 1
      console.log('  ✓ ' + name)
    } catch (error) {
      console.error('  ✗ ' + name)
      throw error
    }
  }
  console.log('legado search: ' + passed + ' 项通过')
}

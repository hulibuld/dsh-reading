/**
 * 模型与思考强度（0.8.1）的单元测试。
 *
 * 这一层最容易悄悄错的不是「选了哪个模型」，而是**强度**：
 * 塞一个模型不支持的档，用户看到的是「AI 报错」而不是「设置没生效」。
 * 所以下面一半用例都在钉「不支持的档怎么退、退到哪儿、有没有说清楚」。
 */

import assert from 'node:assert/strict'
import {
  EFFORT_ORDER,
  DEFAULT_EFFORT,
  effortLabel,
  modelCatalogOf,
  pickSelection,
  describeSelection,
} from '../lib/aimodel.js'
import { mergeSettings } from '../lib/store.js'

const CATALOG = {
  available: true,
  default: { provider: 'host', model: 'luna' },
  groups: [
    {
      id: 'host',
      name: '宿主',
      models: [
        {
          id: 'luna',
          name: 'Luna',
          efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }],
          defaultEffort: 'medium',
        },
        { id: 'plain', name: 'Plain', efforts: [] , defaultEffort: '' },
      ],
    },
    {
      id: 'other',
      name: '另一个供应商',
      models: [{ id: 'big', name: 'Big', efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'high' }],
    },
  ],
  failures: [],
}

async function catalogDegradesWithoutHostService() {
  assert.deepEqual(await modelCatalogOf({ get: () => undefined }), { available: false, groups: [], failures: [] })
  assert.deepEqual(await modelCatalogOf(null), { available: false, groups: [], failures: [] })

  const throwing = await modelCatalogOf({
    get: () => ({
      modelCatalog: async () => {
        throw new Error('宿主挂了')
      },
    }),
  })
  assert.equal(throwing.available, false, '宿主读名单抛错时必须降级而不是抛出去')
  assert.equal(throwing.failures.length, 1)
}

async function catalogDropsEmptyPlaceholders() {
  const catalog = await modelCatalogOf({
    get: () => ({
      modelCatalog: async () => ({
        groups: [
          { id: 'a', models: [{ id: 'ok' }, { id: '' }, null] },
          { id: '', models: [{ id: 'x' }] },
          { id: 'empty', models: [] },
        ],
        failures: [{ id: 'p', message: '供应商超时' }],
      }),
    }),
  })
  assert.equal(catalog.available, true)
  assert.deepEqual(catalog.groups.map((group) => group.id), ['a'], '空 id 的组和模型都要丢掉')
  assert.deepEqual(catalog.groups[0].models.map((model) => model.id), ['ok'])
  assert.equal(catalog.failures[0].message, '供应商超时')
}

async function userPinnedModelWins() {
  const selection = pickSelection({
    settings: { aiProvider: 'other', aiModel: 'big', aiEffort: 'max' },
    catalog: CATALOG,
    parentOptions: { provider: 'host', model: 'luna' },
  })
  assert.equal(selection.source, 'user')
  assert.equal(selection.provider, 'other')
  assert.equal(selection.model, 'big')
  assert.equal(selection.reasoningEffort, 'max', '模型声明了 max 就该用 max')
}

async function pinnedButGoneFallsBackToSession() {
  const selection = pickSelection({
    settings: { aiProvider: 'other', aiModel: 'deleted', aiEffort: 'high' },
    catalog: CATALOG,
    parentOptions: { provider: 'host', model: 'luna' },
  })
  assert.equal(selection.source, 'session', '名单里没有的模型要退回会话模型，而不是硬用')
  assert.equal(selection.provider, 'host')
  assert.equal(selection.reasoningEffort, 'high')
}

async function unsupportedEffortFallsBackAndSaysWhy() {
  // luna 声明了 low/medium/high，没有 xhigh
  const selection = pickSelection({
    settings: { aiProvider: 'host', aiModel: 'luna', aiEffort: 'xhigh' },
    catalog: CATALOG,
    parentOptions: {},
  })
  assert.equal(selection.reasoningEffort, 'medium', '退到该模型声明的默认档（medium）')
  assert.match(selection.effortNote, /没有「很高」档/)
  assert.match(selection.effortNote, /退到「中」/)
}

async function modelWithoutEffortGetsNone() {
  const selection = pickSelection({
    settings: { aiProvider: 'host', aiModel: 'plain', aiEffort: 'high' },
    catalog: CATALOG,
    parentOptions: {},
  })
  assert.equal(selection.reasoningEffort, '', '模型不声明档位就不要塞')
  assert.match(selection.effortNote, /不提供思考强度/)
}

async function followModelDefaultWhenSettingEmpty() {
  const selection = pickSelection({
    settings: { aiProvider: 'host', aiModel: 'luna', aiEffort: '' },
    catalog: CATALOG,
    parentOptions: {},
  })
  assert.equal(selection.reasoningEffort, 'medium')
  assert.match(selection.effortNote, /跟随模型默认档/)
}

async function hostDefaultWhenNothingElse() {
  const selection = pickSelection({ settings: {}, catalog: CATALOG, parentOptions: {} })
  assert.equal(selection.source, 'host')
  assert.equal(selection.provider, 'host')
  assert.equal(selection.model, 'luna')
  assert.equal(selection.reasoningEffort, DEFAULT_EFFORT, '默认档 high 在 luna 的声明里，所以生效')
}

async function unknownWithoutCatalogKeepsHandsOff() {
  const selection = pickSelection({
    settings: { aiProvider: 'x', aiModel: 'y', aiEffort: 'high' },
    catalog: { available: false, groups: [], failures: [] },
    parentOptions: { provider: 'p', model: 'm' },
  })
  assert.equal(selection.source, 'session')
  assert.equal(selection.reasoningEffort, '', '没有名单时不能瞎传强度')
  assert.match(selection.effortNote, /没给模型名单/)
  assert.equal(describeSelection(selection), 'p/m')
}

async function settingsAcceptEffortButRejectJunk() {
  const ok = mergeSettings({}, { aiProvider: 'host', aiModel: 'luna', aiEffort: 'high' }, { strict: true })
  assert.equal(ok.aiProvider, 'host')
  assert.equal(ok.aiEffort, 'high')
  assert.equal(mergeSettings({}, {}, { strict: true }).aiEffort, DEFAULT_EFFORT, '新装默认就是 high')

  assert.throws(
    () => mergeSettings({}, { aiEffort: 'ultra' }, { strict: true }),
    /设置/,
    '不认识的档位必须拒绝，不能静默存下去',
  )
  assert.equal(EFFORT_ORDER.includes('high'), true)
  assert.equal(effortLabel('high'), '高')
  assert.equal(effortLabel(''), '跟随宿主')
}

export default async function run() {
  await catalogDegradesWithoutHostService()
  await catalogDropsEmptyPlaceholders()
  await userPinnedModelWins()
  await pinnedButGoneFallsBackToSession()
  await unsupportedEffortFallsBackAndSaysWhy()
  await modelWithoutEffortGetsNone()
  await followModelDefaultWhenSettingEmpty()
  await hostDefaultWhenNothingElse()
  await unknownWithoutCatalogKeepsHandsOff()
  await settingsAcceptEffortButRejectJunk()
}

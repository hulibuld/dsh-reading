/**
 * aicall.js —— 每次 AI 调用的账本 + 调用包装。
 *
 * 用户的原话（m02260）：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍
 * 去重试，非常浪费。这里解决三件事：
 *
 *   1. **记下来**：每次调用写一行 JSONL（时间、用途、书/章、耗时、模型、成败、错误码、
 *      一句人话原因），放在书库根目录，不跟着单本书走——AI 挂了是全站的事。
 *   2. **说得清**：失败原因存错误码 + 人话；界面集中显示，用户不用猜。
 *   3. **能重试**：失败请求的原始内容（prompt 前 120 字预览 + 完整入参留在客户端）
 *      在客户端保留，重试就是「同一份输入再发一次」，不会丢工作。
 *
 * 为什么只留最近 300 条：这是排障用的最近记录，不是审计流水。无上限增长的文件
 * 迟早变成几百 MB 的垃圾，而用户真正会看的就是刚才那几次。
 */

import { promises as fs } from 'node:fs'

/** 读回来的上限（也是裁剪后保留的条数）。 */
export const MAX_AI_RECORDS = 300

/** 存进账本的 prompt 预览长度。够认出「这是哪一次调用」就行。 */
const PREVIEW_CHARS = 120

/** 单条记录里允许出现的字段。多余的一律丢掉，防止把整章正文写进账本。 */
function normalize(entry) {
  const pick = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
  return {
    id: pick(entry?.id, 64),
    at: pick(entry?.at, 40),
    kind: pick(entry?.kind, 40) || 'complete',
    label: pick(entry?.label, 120),
    bookHash: pick(entry?.bookHash, 64),
    bookTitle: pick(entry?.bookTitle, 120),
    chapterLabel: pick(entry?.chapterLabel, 120),
    promptChars: Number.isFinite(entry?.promptChars) ? entry.promptChars : 0,
    answerChars: Number.isFinite(entry?.answerChars) ? entry.answerChars : 0,
    model: pick(entry?.model, 120),
    latencyMs: Number.isFinite(entry?.latencyMs) ? entry.latencyMs : 0,
    ok: entry?.ok === true,
    code: pick(entry?.code, 60),
    status: Number.isFinite(entry?.status) ? entry.status : 0,
    message: pick(entry?.message, 400),
    preview: pick(entry?.preview, PREVIEW_CHARS),
  }
}

/**
 * AI 调用账本。
 *
 * @param {{ paths: { file: (name: string) => string }, logger?: object }} deps
 */
export function createAiCallLog({ paths, logger = console }) {
  const file = paths.file('ai-calls.jsonl')
  // 串行写：并发的 append 交错会让 JSONL 断行，读回来就是一堆坏行。
  let queue = Promise.resolve()

  const append = (record) => {
    queue = queue
      .then(() => fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8'))
      .catch((error) => {
        try {
          logger?.warn?.(`[dsh-reading] AI 调用记录写盘失败：${String(error?.message ?? error)}`)
        } catch {
          // 日志失败不能再抛
        }
      })
    return queue
  }

  const readAll = async () => {
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const out = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') out.push(normalize(parsed))
      } catch {
        // 坏行跳过：一行坏了不代表整本账本不能用
      }
    }
    return out
  }

  return {
    file,

    /** 记一次调用，返回写入的记录。 */
    async record(entry) {
      const record = normalize({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        ...entry,
      })
      await append(record)
      await this.trim()
      return record
    },

    /** 最近 limit 条，最新在前。 */
    async list(limit = 50) {
      const all = await readAll()
      const size = Math.min(MAX_AI_RECORDS, Math.max(1, Number(limit) || 50))
      return all.slice(-size).reverse()
    },

    /** 只留最近 MAX_AI_RECORDS 条。文件不大时不动它，避免每写一次都重写整份。 */
    async trim() {
      try {
        const stat = await fs.stat(file)
        // 一条记录约 400 字节，超过 4 倍上限才裁剪
        if (stat.size < MAX_AI_RECORDS * 400 * 4) return
        const all = await readAll()
        const keep = all.slice(-MAX_AI_RECORDS)
        const body = keep.map((item) => JSON.stringify(item)).join('\n') + '\n'
        const tmp = `${file}.tmp`
        await fs.writeFile(tmp, body, 'utf8')
        await fs.rename(tmp, file)
      } catch (error) {
        if (error?.code === 'ENOENT') return
        try {
          logger?.warn?.(`[dsh-reading] AI 账本裁剪失败：${String(error?.message ?? error)}`)
        } catch {
          // 忽略
        }
      }
    },

    async clear() {
      await queue.catch(() => {})
      await fs.rm(file, { force: true })
      return { cleared: true }
    },

    /** 最近一段时间内的失败统计，给「状态」用：连续失败说明供应商或网络出问题了。 */
    async summary(windowMs = 10 * 60 * 1000) {
      const all = await readAll()
      const since = Date.now() - Math.max(60_000, windowMs)
      const recent = all.filter((item) => Date.parse(item.at) >= since)
      const failed = recent.filter((item) => item.ok === false)
      const last = all.length > 0 ? all[all.length - 1] : null
      let consecutiveFailures = 0
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (all[i].ok === false) consecutiveFailures += 1
        else break
      }
      const byCode = new Map()
      for (const item of failed) {
        const code = item.code || 'E_UNKNOWN'
        byCode.set(code, (byCode.get(code) ?? 0) + 1)
      }
      return {
        windowMs: Math.max(60_000, windowMs),
        total: recent.length,
        failed: failed.length,
        consecutiveFailures,
        last,
        codes: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      }
    },
  }
}

/**
 * 给 ask 服务套一层账本。
 *
 * 只包两个入口（complete / ask），其余方法原样透传：将来 ask 服务加方法时，
 * 忘记包一层最多是「那次没记账」，不会变成「调用不了」。
 */
export function withAiLog(ask, log) {
  if (!ask || !log) return ask

  const meta = (input, extra) => ({
    kind: typeof input?.kind === 'string' && input.kind !== '' ? input.kind : 'complete',
    label: typeof input?.label === 'string' ? input.label : '',
    bookHash: typeof input?.bookHash === 'string' ? input.bookHash : '',
    bookTitle: typeof input?.bookTitle === 'string' ? input.bookTitle : '',
    chapterLabel: typeof input?.chapterLabel === 'string' ? input.chapterLabel : '',
    promptChars: String(input?.prompt ?? input?.selectedText ?? '').length,
    preview: String(input?.prompt ?? input?.selectedText ?? '').slice(0, PREVIEW_CHARS),
    ...extra,
  })

  const run = async (info, task) => {
    const startedAt = Date.now()
    try {
      const result = await task()
      const answer = typeof result === 'string' ? result : result?.answer
      await log.record({
        ...info,
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: (result && typeof result === 'object' && typeof result.model === 'string' ? result.model : '') || '',
        answerChars: String(answer ?? '').length,
      })
      return result
    } catch (error) {
      await log.record({
        ...info,
        ok: false,
        latencyMs: Date.now() - startedAt,
        code: typeof error?.code === 'string' ? error.code : 'E_UNKNOWN',
        status: Number.isFinite(error?.status) ? error.status : 0,
        message: String(error?.message ?? error ?? '未知错误'),
      })
      throw error
    }
  }

  return {
    ...ask,
    complete(input) {
      return run(meta(input), () => ask.complete(input))
    },
    ask(input) {
      return run(
        meta(input, {
          kind: 'ask',
          label: typeof input?.question === 'string' ? input.question.slice(0, 120) : '问 AI',
        }),
        () => ask.ask(input),
      )
    },
  }
}

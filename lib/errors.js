/**
 * 统一的错误类型（宿主侧）。
 *
 * 为什么单独一个文件：路由层、书库层、解析层都要抛「能直接给用户看」的错误，
 * 而调用方只需要判断两件事——「这是不是业务错误」、「要不要换成兜底文案」。
 *
 * 规则（与 docs/05 §3.3 对齐）：
 *   - code 机器可读，界面不发愁判断；
 *   - message 一律中文、已经能直接显示，**不出现内部字段名**（bookHash / href 之类）；
 *   - 只有 expose !== false 的错误才把 message 原样返回给浏览器，其余统一兜底。
 *
 * 什么时候会失败、失败给谁看：
 *   - 解析层（zip/xml/epub）抛 AppError，由 store 映射成书库语义，再由 routes 落成
 *     `{ ok:false, error:{ code, message } }`，最终给用户看 message。
 *   - 任何非 AppError 的异常都当成内部错误（500），只记日志、不回显细节。
 */

export class AppError extends Error {
  /**
   * @param {string} code - 机器可读错误码，例如 `E_EPUB_ENCRYPTED`。
   * @param {string} message - 给用户看的中文文案，不出现内部字段名。
   * @param {{ status?: number, expose?: boolean, detail?: string, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'AppError'
    this.code = String(code)
    this.status = Number.isInteger(options.status) ? options.status : 400
    this.expose = options.expose !== false
    /** 只进日志、不回显：具体越界偏移、标签名之类的排查信息。 */
    this.detail = options.detail ?? ''
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * 造一个业务错误。比 `new AppError` 少写一次 `new`，且强制要求 code + 中文 message。
 * @param {string} code
 * @param {string} message
 * @param {{ status?: number, expose?: boolean, detail?: string, cause?: unknown }} [options]
 */
export function fail(code, message, options) {
  return new AppError(code, message, options)
}

/** 判断一个异常是不是「我们自己抛的、可以按 code 处理」的错误。 */
export function isAppError(error) {
  return (
    error instanceof AppError ||
    (Boolean(error) &&
      error.name === 'AppError' &&
      typeof error.code === 'string' &&
      typeof error.message === 'string')
  )
}

/**
 * 把任意异常翻译成响应需要的三元组。
 *
 * 非业务异常一律 500 + 固定文案——内部异常里常带本机路径、字段名，直接回显
 * 既不好看也是信息泄露。真正的排查信息由调用方 console.warn 出去。
 *
 * @param {unknown} error
 * @returns {{ status: number, code: string, message: string }}
 */
export function publicError(error) {
  if (isAppError(error) && error.expose !== false) {
    return { status: error.status || 400, code: error.code, message: error.message }
  }
  return {
    status: 500,
    code: 'internal',
    message: '服务器内部出错了，请稍后重试。',
  }
}

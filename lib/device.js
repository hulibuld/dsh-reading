/**
 * 稳定的本机设备标识。
 *
 * 契约要求 `deviceId` 形如 `mac-7f3a91`（docs/01 §2.2）：`os-shortid`，一旦生成
 * 永不改变——它会被写进每一条标注、每一次进度，换了就等于换了台设备。
 *
 * 存放位置：`<libraryDir>/dsh-reading/device.json`，**只属于本机**。
 * 它不出现在 docs/05 §3.2 的同步文件清单里，是有意的：两台机器同步同一个书库
 * 目录时，各自必须保留自己的 id，否则「谁改的」就永远分不清了。
 *
 * 为什么不用随机数每次都生成：标注要能跨重启聚合，换了 id 会让同一个人分成两台设备。
 * 为什么用 `wx` 独占创建：两个请求同时到达时，只有一个能写成功，另一个读回同一条，
 * 这样并发首启也不会分裂出两个 id。
 *
 * 什么时候会失败、失败给谁看：
 *   - 磁盘不可写 → 退化成「进程内临时 id」并 console.warn 一次，阅读本身还能用；
 *     不抛错，因为拿不到 deviceId 不该让整个面板打不开。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname, platform } from 'node:os'

/** deviceId 的合法形态（与 schema/contract.schema.json 的 $defs.deviceId 一致）。 */
export const DEVICE_ID_PATTERN = /^[a-z0-9]{2,12}-[a-z0-9]{4,12}$/

/** 平台前缀：只用来让人一眼认出是哪台机器，不承担唯一性。 */
function osPrefix() {
  const p = platform()
  if (p === 'darwin') return 'mac'
  if (p === 'win32') return 'win'
  if (p === 'linux') return 'linux'
  if (p === 'android') return 'android'
  if (p === 'ios') return 'ios'
  // 少数平台名带数字/下划线（例如 freebsd），统一清洗成小写字母数字。
  return p.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'dev'
}

/**
 * 生成一个新的 deviceId。
 *
 * 后缀取 6 位 hex：同一台机器上重复生成的概率极低，长度又刚好在 schema 的
 * 4–12 位窗口内。主机名不进 id——它是个人信息，不能进任何交付物。
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeDeviceId(prefix = osPrefix()) {
  const safePrefix = String(prefix).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'dev'
  const suffix = randomBytes(3).toString('hex').slice(0, 6)
  return `${safePrefix}-${suffix}`
}

/**
 * 读取（或首次生成）本机 deviceId。
 *
 * @param {string} root - 书库根目录（`<libraryDir>/dsh-reading`）。
 * @returns {Promise<string>}
 */
export async function ensureDeviceId(root) {
  const file = path.join(root, 'device.json')
  const existing = await readDeviceFile(file)
  if (existing) return existing

  const generated = makeDeviceId()
  const payload = `${JSON.stringify(
    { schema: 'dsh-reading/1', deviceId: generated, createdAt: new Date().toISOString() },
    null,
    2,
  )}\n`
  try {
    await fs.mkdir(root, { recursive: true })
    // wx：文件已存在就直接失败，交给下面的 catch 读回别人的结果。
    await fs.writeFile(file, payload, { flag: 'wx' })
    return generated
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const raced = await readDeviceFile(file)
      if (raced) return raced
      // 文件在但内容不合法（被手工改坏、或从别的设备拷来的坏值）：
      // 覆盖修复。不修的话每次启动都会生成新 id，标注的「谁改的」就全乱了。
      try {
        await fs.writeFile(file, payload, { flag: 'w' })
        return generated
      } catch (repairError) {
        console.warn('[dsh-reading] 设备标识文件无法修复，本次使用临时标识：', String(repairError && repairError.message))
        return generated
      }
    }
    // 落盘失败（只读盘、权限不足）：用临时 id 让当前进程跑完，下次启动会再试。
    console.warn('[dsh-reading] 无法保存设备标识，本次使用临时标识：', String(error && error.message))
    return generated
  }
}

/** 读 device.json；不存在或内容不合法返回 null（不抛错，调用方会重新生成）。 */
async function readDeviceFile(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    // 文件不存在（首次启动）或不可读：都当成「还没有 id」，交给调用方生成。
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    const id = parsed && typeof parsed.deviceId === 'string' ? parsed.deviceId : ''
    return DEVICE_ID_PATTERN.test(id) ? id : null
  } catch {
    // 内容坏了（手工改过、或从别的设备拷来）：返回 null 让调用方重新生成。
    return null
  }
}

/**
 * 本机主机名，仅用于日志排查，**不写进任何数据文件**。
 * 单独导出是为了让「谁在跑」的问题有个答案，同时把读写面收紧。
 */
export function debugHostLabel() {
  try {
    return `${osPrefix()}/${hostname()}`
  } catch {
    // hostname() 在极少数受限环境会抛：退化成只有平台前缀，够用来分辨机器大类。
    return osPrefix()
  }
}

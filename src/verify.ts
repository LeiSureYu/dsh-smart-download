/**
 * 落盘校验：下载「退出码 0」之后，确认落盘文件真的等于远端资源长度。
 *
 * 为什么需要这一层（与 0.6.0 的续传 bug 同一类静默失败）：
 * aria2 / curl 的退出码 0 只代表「它自己认为完成了」，不代表字节数对。
 * 实测可复现的错字节场景至少有：
 *   - 服务器提前断开但没报错（连接被代理掐掉）；
 *   - 续传时 Range 起点算错，写入了错位的数据；
 *   - 磁盘写满 / 配额限制，最后一段静默丢弃；
 *   - 镜像站返回了一个「成功」的 HTML 错误页（200 + 短 body）。
 * 这几种都不会有非零退出码，用户只会拿到一个坏文件。
 *
 * 判定规则（保守优先）：
 * 1. 远端长度未知 → 跳过（无法校验总比乱报好）；
 * 2. 服务器实际返回了非 identity 的 Content-Encoding → 跳过，因为探测到的
 *    `contentLength` 是压缩后长度，与 curl / aria2 落盘的未压缩字节数不可比。
 *    0.7.0 实测：fetch 默认带 `accept-encoding: gzip, deflate`，5000 B 的
 *    body 会报 41 B；而 curl / aria2 默认不声明压缩，落盘 5000 B。
 *    （探测侧已强制 `identity`，这一条是对无视该请求头的服务器的兜底。）
 * 3. 本地文件读不到 → 失败（退出码 0 却没文件，本身就是异常）；
 * 4. 字节数不等 → 失败，明确报错，绝不返回 success。
 */
import type { ProbeResult } from './types.js'

/**
 * 规范化 `Content-Encoding` 响应头。
 *
 * 缺失 / 空 / 只含 `identity`（可能是 `identity, identity` —— 实测 Node 24 的
 * undici 在带 `Range` 的请求里会这么发，RFC 语义上仍等于未压缩）都返回
 * undefined；其余返回压缩编码名（如 `gzip`、`br`、`gzip, identity` 归为 `gzip`）。
 */
export function normalizeContentEncoding(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined) return undefined
  const tokens = header
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '' && t !== 'identity')
  if (tokens.length === 0) return undefined
  return tokens.join(', ')
}

/** 校验结论 */
export type VerifyOutcome =
  /** 字节数一致，或本次不具备校验条件（跳过） */
  | { kind: 'ok'; actual?: number }
  /** 字节数不一致 / 文件缺失，必须判为失败 */
  | { kind: 'mismatch'; expected: number; actual: number | null }

/**
 * 纯函数：比较实际落盘字节数与远端声明长度。
 * 不碰文件系统，便于单元测试。
 *
 * @param actual 实际落盘字节数；null 表示文件不存在 / 不可读
 * @param expected 远端声明的长度；undefined 表示未知
 * @param contentEncoding 探测到的 Content-Encoding（已规范化，identity 视为无）
 */
export function verifySize(
  actual: number | null,
  expected: number | undefined,
  contentEncoding?: string,
): VerifyOutcome {
  // 1. 远端长度未知：无法校验
  if (expected === undefined) return { kind: 'ok' }

  // 2. 实际返回了压缩编码：探测长度与落盘字节数不可比，跳过而不是误判
  if (normalizeContentEncoding(contentEncoding)) return { kind: 'ok' }

  // 3. 文件缺失
  if (actual === null) return { kind: 'mismatch', expected, actual: null }

  // 4. 字节数比对
  if (actual !== expected) return { kind: 'mismatch', expected, actual }
  return { kind: 'ok', actual }
}

/** 从探测结果里取出校验所需的期望值与编码信息 */
export function expectedFromProbe(probe: ProbeResult): {
  expected: number | undefined
  contentEncoding: string | undefined
} {
  return { expected: probe.contentLength, contentEncoding: probe.contentEncoding }
}

/** 把校验失败翻译成给人看的错误信息 */
export function describeMismatch(outcome: Extract<VerifyOutcome, { kind: 'mismatch' }>): string {
  const actualText = outcome.actual === null ? '文件不存在' : `${outcome.actual} 字节`
  return `下载完整性校验失败：落盘 ${actualText}，远端声明 ${outcome.expected} 字节`
}

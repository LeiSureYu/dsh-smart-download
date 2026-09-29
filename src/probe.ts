/**
 * URL 探测逻辑：
 * 1. 优先发 HEAD 请求；
 * 2. 若 HEAD 返回 405 或缺少 Content-Length，改用 GET + Range: bytes=0-0；
 * 3. 根据 Accept-Ranges / 206 状态码与文件大小判定是否值得多线程；
 * 4. 任何探测失败都返回“不支持多线程”，触发 curl 回退。
 *
 * ⚠️ Accept-Encoding（0.7.0 实测，改动前务必先读）：
 * Node 的 `fetch` 默认带 `accept-encoding: gzip, deflate`，于是探测拿到的
 * `Content-Length` 可能是**压缩后**的长度。而真正负责下载的工具
 * —— curl（默认）与 aria2（默认）—— 不声明 / 声明空的 Accept-Encoding，
 * 服务器返回**未压缩**的字节流。实测（真实 body 5000 B、gzip 后 41 B）：
 *   fetch 默认 HEAD -> 41；fetch `identity` -> 5000；curl 默认 -I -> 5000；
 *   curl --compressed -> 41；aria2 默认落盘 -> 5000 B。
 * 因此探测**必须**强制 `accept-encoding: identity`，否则任何支持 gzip 的
 * 服务器都会让 0.7.0 的大小校验 100% 误报（把正确的下载判成损坏）。
 */
import type { ProbeOptions, ProbeResult } from './types.js'
import { normalizeContentEncoding } from './verify.js'

/** 单次请求默认超时 5 秒 */
const DEFAULT_TIMEOUT_MS = 5000
/** 默认多线程阈值：1MB */
const DEFAULT_THRESHOLD = 1024 * 1024

/**
 * 探测请求强制声明的 Accept-Encoding。
 * 必须与实际下载工具（curl / aria2 默认行为）保持一致，才能拿到可比的 Content-Length。
 */
const PROBE_ACCEPT_ENCODING = 'identity'

/** 判定函数入参 */
export interface EvaluateInput {
  /** 响应状态码 */
  status: number
  /** Accept-Ranges 头 */
  acceptRanges?: string | null
  /** Content-Length 头解析出的长度 */
  contentLength?: number
  /** Content-Range 头（Range GET 返回 206 时携带） */
  contentRange?: string | null
  /** 多线程大小阈值 */
  threshold: number
}

/** 判定函数结果 */
export interface EvaluateResult {
  supported: boolean
  /** 资源总大小 */
  size?: number
  reason?: string
}

/**
 * 远端资源的「内容指纹」。
 *
 * 续传安全校验用它判断「远端资源有没有变」。只用长度是不够的：
 * 实测（0.6.0）远端从 400 字节变成另一个 400 字节时，curl -C - 与 aria2 -c
 * 都是退出码 0，而落盘文件保留着旧内容。
 */
export interface RemoteFingerprint {
  /** ETag（含引号）；最强的内容信号 */
  etag?: string
  /** Last-Modified；服务器不发 ETag 时的次优信号 */
  lastModified?: string
}

/**
 * 解析 Content-Range 头中的资源总大小。
 * 形如 "bytes 0-0/5242880" -> 5242880；"bytes 0-0/*" -> undefined。
 */
export function parseContentRangeTotal(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(header)
  if (!match) return undefined
  const total = Number(match[1])
  return Number.isFinite(total) && total >= 0 ? total : undefined
}

/** 将响应头中的 Content-Length 解析为非负整数 */
export function parseContentLength(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined || header === '') return undefined
  const n = Number(header)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * 纯判定函数：根据响应状态码与响应头判断是否值得多线程。
 * 单独抽出便于单元测试，不依赖网络。
 */
export function evaluateRangeSupport(input: EvaluateInput): EvaluateResult {
  const { status, acceptRanges, contentLength, contentRange, threshold } = input

  // 总大小优先取 Content-Range 中的完整长度（206 时 Content-Length 仅为分片长度）
  const size = parseContentRangeTotal(contentRange) ?? contentLength

  // 206 是服务器明确支持 Range 的最强信号；否则回退到 Accept-Ranges 头判断
  const honorsRange =
    status === 206 || (!!acceptRanges && /bytes/i.test(acceptRanges))

  if (size === undefined) {
    return { supported: false, reason: '无法获取 Content-Length / Content-Range' }
  }
  if (!honorsRange) {
    return { supported: false, size, reason: '服务器不支持 Range（无 bytes Accept-Ranges 且无 206）' }
  }
  if (size <= threshold) {
    return { supported: false, size, reason: `文件过小（${size} 字节 <= 阈值 ${threshold}）` }
  }
  return { supported: true, size }
}

/** 取错误信息字符串 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 读取并规范化 `Content-Encoding` 响应头。
 * 缺失 / 空 / `identity` 都返回 undefined —— 它们都代表“未压缩”，
 * 与 curl、aria2 的落盘字节数可比。其余值（gzip / br / deflate …）原样小写返回。
 */
function readContentEncoding(res: Response): string | undefined {
  return normalizeContentEncoding(res.headers.get('content-encoding'))
}

/**
 * 组合外部取消信号与内部超时信号。
 * Node 22 支持 AbortSignal.any / AbortSignal.timeout。
 */
function mergeSignal(external: AbortSignal | undefined, timeout: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout)
  if (!external) return timeoutSignal
  return AbortSignal.any([external, timeoutSignal])
}

/** 组装一个“不支持多线程”的结果 */
function notSupported(reason: string): ProbeResult {
  return { supportsMultiThread: false, reason }
}

/** 将判定结果映射为 ProbeResult */
function toProbeResult(
  decision: EvaluateResult,
  contentType?: string,
  acceptRanges?: string,
  etag?: string,
  lastModified?: string,
  contentEncoding?: string,
): ProbeResult {
  return {
    supportsMultiThread: decision.supported,
    contentLength: decision.size,
    acceptRanges,
    contentType,
    reason: decision.reason,
    etag,
    lastModified,
    contentEncoding,
  }
}

/**
 * 探测目标 URL 是否支持多线程下载。
 * 任何异常（超时、网络错误、无法获取大小）都安全地返回不支持，由调用方回退 curl。
 */
export async function probeUrl(
  url: string,
  externalSignal?: AbortSignal,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
  const threshold = options.threshold ?? DEFAULT_THRESHOLD

  // 1. 先尝试 HEAD
  let head: Response
  try {
    head = await fetch(url, {
      method: 'HEAD',
      headers: { 'accept-encoding': PROBE_ACCEPT_ENCODING },
      redirect: 'follow',
      signal: mergeSignal(externalSignal, timeout),
    })
  } catch (err) {
    return notSupported(`HEAD 请求失败: ${describeError(err)}`)
  }

  const headLength = parseContentLength(head.headers.get('content-length'))
  const headAcceptRanges = head.headers.get('accept-ranges')
  const headContentType = head.headers.get('content-type') ?? undefined
  const headEtag = head.headers.get('etag') ?? undefined
  const headLastModified = head.headers.get('last-modified') ?? undefined
  const headContentEncoding = readContentEncoding(head)

  // 2. HEAD 为 405 或缺少 Content-Length 时，改用 Range GET
  if (head.status === 405 || headLength === undefined) {
    let get: Response
    try {
      get = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0', 'accept-encoding': PROBE_ACCEPT_ENCODING },
        redirect: 'follow',
        signal: mergeSignal(externalSignal, timeout),
      })
    } catch (err) {
      return notSupported(`Range GET 请求失败: ${describeError(err)}`)
    }

    const contentRange = get.headers.get('content-range')
    const getLength = parseContentLength(get.headers.get('content-length'))
    const acceptRanges = get.headers.get('accept-ranges') ?? headAcceptRanges
    const contentType = get.headers.get('content-type') ?? headContentType
    // Range GET 的指纹优先（它才是真正会被下载的那次请求的响应头），
    // 缺失时回落到 HEAD 拿到的。
    const etag = get.headers.get('etag') ?? headEtag
    const lastModified = get.headers.get('last-modified') ?? headLastModified
    const contentEncoding = readContentEncoding(get) ?? headContentEncoding

    // 不消费响应体，主动取消以释放连接
    get.body?.cancel().catch(() => {})

    const decision = evaluateRangeSupport({
      status: get.status,
      acceptRanges,
      contentLength: getLength,
      contentRange,
      threshold,
    })
    return toProbeResult(
      decision,
      contentType ?? undefined,
      acceptRanges ?? undefined,
      etag,
      lastModified,
      contentEncoding,
    )
  }

  // 3. HEAD 信息足够，直接判定
  const decision = evaluateRangeSupport({
    status: head.status,
    acceptRanges: headAcceptRanges,
    contentLength: headLength,
    contentRange: null,
    threshold,
  })
  return toProbeResult(
    decision,
    headContentType,
    headAcceptRanges ?? undefined,
    headEtag,
    headLastModified,
    headContentEncoding,
  )
}

/**
 * URL 探测逻辑：
 * 1. 优先发 HEAD 请求；
 * 2. 若 HEAD 返回 405 或缺少 Content-Length，改用 GET + Range: bytes=0-0；
 * 3. 根据 Accept-Ranges / 206 状态码与文件大小判定是否值得多线程；
 * 4. 任何探测失败都返回“不支持多线程”，触发 curl 回退。
 */
import type { ProbeOptions, ProbeResult } from './types.js'

/** 单次请求默认超时 5 秒 */
const DEFAULT_TIMEOUT_MS = 5000
/** 默认多线程阈值：1MB */
const DEFAULT_THRESHOLD = 1024 * 1024

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
): ProbeResult {
  return {
    supportsMultiThread: decision.supported,
    contentLength: decision.size,
    acceptRanges,
    contentType,
    reason: decision.reason,
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
      redirect: 'follow',
      signal: mergeSignal(externalSignal, timeout),
    })
  } catch (err) {
    return notSupported(`HEAD 请求失败: ${describeError(err)}`)
  }

  const headLength = parseContentLength(head.headers.get('content-length'))
  const headAcceptRanges = head.headers.get('accept-ranges')
  const headContentType = head.headers.get('content-type') ?? undefined

  // 2. HEAD 为 405 或缺少 Content-Length 时，改用 Range GET
  if (head.status === 405 || headLength === undefined) {
    let get: Response
    try {
      get = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
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

    // 不消费响应体，主动取消以释放连接
    get.body?.cancel().catch(() => {})

    const decision = evaluateRangeSupport({
      status: get.status,
      acceptRanges,
      contentLength: getLength,
      contentRange,
      threshold,
    })
    return toProbeResult(decision, contentType, acceptRanges ?? undefined)
  }

  // 3. HEAD 信息足够，直接判定
  const decision = evaluateRangeSupport({
    status: head.status,
    acceptRanges: headAcceptRanges,
    contentLength: headLength,
    contentRange: null,
    threshold,
  })
  return toProbeResult(decision, headContentType, headAcceptRanges ?? undefined)
}

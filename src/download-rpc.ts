/**
 * RPC 下载路径：经常驻 daemon 的 addUri → tellStatus 轮询 → 完成。
 * （1.9.0 引入但从未接线——见 rpc-daemon.ts 文件头的勘误；2.0.0 起真正接线。）
 *
 * 与 1.8 的 spawn 路径（downloadWithAria2）**同契约**：
 * - 入参一致（url / outputPath / concurrency / signal / reporter / resume /
 *   headers / 限速 / 代理）；
 * - 完成返回 Aria2Observation（吞吐缓存写入侧不变）；
 * - 失败抛错（调用方的 aria2 → curl 回退不变）；
 * - 信号暂停（PAUSE_ABORT_REASON）→ aria2.pause 原地挂起 → reporter.paused →
 *   DownloadPausedError；信号取消 → aria2.remove → reporter.cancel →
 *   DownloadCancelledError；
 * - daemon 不可用（起不来 / 失联）→ DaemonUnavailableError——调用方（index.ts
 *   的 runAria2）在 auto 模式下降级到 spawn 路径。
 *
 * 2.0.0 修复的完成竞态（审计隐患 ③）：pause / remove 打在**已经完成**的 gid 上
 * 会得到 JSON-RPC 错误——1.9.0 的实现把它当成 daemon 异常，给已完成的下载盖上
 * cancelled 终态。现在先 tellStatus 核对：status === 'complete' 一律按真实完成
 * 收尾（reporter.done + 正常返回观测），竞态经 RpcCompletedRace 穿出主循环。
 */
import path from 'node:path'
import { rpcCall, ensureDaemon, DaemonUnavailableError } from './rpc-daemon.js'
import type { Aria2Observation } from './downloader.js'
import type { ProgressReporter } from './progress.js'
import type { RequestHeaders } from './types.js'
import { PAUSE_ABORT_REASON } from './tasks.js'
import { DownloadCancelledError, DownloadPausedError } from './tasks.js'

export type Aria2RpcObservation = Aria2Observation

/** 完成竞态的载体：handleAbort 发现下载其实已经完成时，带着观测穿出主循环。 */
class RpcCompletedRace extends Error {
  constructor(public readonly observation: Aria2Observation | undefined) {
    super('下载在暂停/取消请求到达前已完成')
  }
}

interface Aria2Status {
  status: string
  totalLength: string
  completedLength: string
  downloadSpeed: string
  connections?: string
  errorCode?: string
  errorMessage?: string
}

const STATUS_KEYS = [
  'status',
  'totalLength',
  'completedLength',
  'downloadSpeed',
  'connections',
  'errorCode',
  'errorMessage',
]

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(1) + 'MiB/s'
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + 'KiB/s'
  return bytesPerSec.toFixed(0) + 'B/s'
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m${s}s` : `${s}s`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 把插件头表转成 aria2 RPC 的 header 选项（可重复项用数组表达）。 */
function headersToRpcOption(headers: RequestHeaders | undefined): string[] | undefined {
  if (!headers) return undefined
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
}

export async function downloadWithAria2Rpc(opts: {
  url: string
  outputPath: string
  concurrency: number
  signal: AbortSignal
  reporter?: ProgressReporter
  resume: boolean
  headers?: RequestHeaders
  maxDownloadLimitBytes?: number
  proxy?: string
}): Promise<Aria2Observation | undefined> {
  const { url, outputPath, concurrency, signal, reporter, resume, headers, maxDownloadLimitBytes, proxy } =
    opts
  const dir = path.dirname(outputPath)
  const out = path.basename(outputPath)

  // daemon 不可用 → 直接抛给调用方降级，不在这层静默换路径
  await ensureDaemon()

  const rpcOptions: Record<string, string | string[]> = {
    dir,
    out,
    // 断点续传：aria2 自己的 .aria2 控制文件 + 调用方已做过的 planResume 同源核对
    'continue': resume ? 'true' : 'false',
    'max-connection-per-server': String(concurrency),
    'split': String(concurrency),
    'min-split-size': '1M',
    'max-download-limit': maxDownloadLimitBytes === undefined ? '0' : String(maxDownloadLimitBytes),
    'allow-overwrite': 'true',
    'auto-file-renaming': 'false',
    'file-allocation': 'none',
  }
  const headerList = headersToRpcOption(headers)
  if (headerList && headerList.length > 0) rpcOptions['header'] = headerList
  if (proxy) rpcOptions['all-proxy'] = proxy

  const gid = (await rpcCall('aria2.addUri', [[url], rpcOptions])) as unknown as string

  let lastThroughput = 0
  let lastCn = 0

  /** 与 spawn 路径的观测语义一致：没有可靠吞吐就不编造 */
  const observationFrom = (): Aria2Observation | undefined =>
    lastThroughput > 0
      ? { throughput: lastThroughput, concurrency, cn: Math.max(1, lastCn) }
      : undefined

  /** daemon 还活着时的状态核对；失联返回 null（调用方按既有语义收口） */
  const statusIfAvailable = async (): Promise<Aria2Status | null> => {
    try {
      return (await rpcCall('aria2.tellStatus', [gid, STATUS_KEYS])) as Aria2Status
    } catch (err) {
      if (err instanceof DaemonUnavailableError) throw err
      return null
    }
  }

  /** 信号中止的动作：暂停 → 原地挂起；取消/超时 → 移除。恒以 throw 结束。 */
  const handleAbort = async (): Promise<never> => {
    if (signal.reason !== PAUSE_ABORT_REASON) {
      // 取消 / 超时：移除任务（半包保留，.aria2 控制文件由 aria2 管理）
      try {
        await rpcCall('aria2.remove', [gid])
      } catch (err) {
        if (err instanceof DaemonUnavailableError) throw err
        /* 已结束或 daemon 已死：无所谓，产物状态以磁盘为准 */
      }
      // 完成竞态：取消到达前下载已经完成 —— 按真实完成收尾，不能把已完成的
      // 下载盖成已取消（审计隐患 ③ 的 cancel 面）
      const finished = await statusIfAvailable()
      if (finished?.status === 'complete') {
        reporter?.done()
        await reporter?.awaitFlush()
        throw new RpcCompletedRace(observationFrom())
      }
      reporter?.cancel()
      await reporter?.awaitFlush()
      throw new DownloadCancelledError('已取消：下载被用户中止')
    }

    // 暂停：原地挂起。gid 恰好已结束（完成竞态）时 pause 的 JSON-RPC 会报错
    // —— 不再当成 daemon 异常（审计隐患 ③），交由下面的状态核对定夺。
    try {
      await rpcCall('aria2.pause', [gid])
    } catch (err) {
      if (err instanceof DaemonUnavailableError) throw err
      /* gid 可能已结束（完成竞态）—— 状态核对决定走向 */
    }
    for (;;) {
      let st: Aria2Status
      try {
        st = (await rpcCall('aria2.tellStatus', [gid, STATUS_KEYS])) as Aria2Status
      } catch (err) {
        if (err instanceof DaemonUnavailableError) throw err
        // RPC 暂停后的核对失败（daemon 恰好死了）：按取消处理，半包与指纹照常保留
        reporter?.cancel('已暂停（daemon 异常）：重试将从断点继续')
        await reporter?.awaitFlush()
        throw new DownloadCancelledError('已暂停：daemon 异常中断')
      }
      if (st.status === 'paused') {
        // 原地挂起成功。从 daemon 队列移除：.aria2 控制文件在盘上，重试（无论
        // RPC 还是 spawn）据此续传；不 remove 的话 paused gid 会在 daemon 内存
        // 里永远滞留（1.9.0 实现的泄漏）。
        try {
          await rpcCall('aria2.remove', [gid])
        } catch (err) {
          if (err instanceof DaemonUnavailableError) throw err
          /* 移除失败不影响暂停语义 */
        }
        reporter?.paused('已暂停：可从下载管理器继续')
        await reporter?.awaitFlush()
        throw new DownloadPausedError('已暂停：下载被用户暂停')
      }
      if (st.status === 'complete') {
        // 完成竞态：暂停请求到达前下载已经完成 —— 按真实完成收尾
        reporter?.done()
        await reporter?.awaitFlush()
        throw new RpcCompletedRace(observationFrom())
      }
      if (st.status === 'error' || st.status === 'removed') {
        // 挂起期间任务以错误/被移除告终：交回调用方的既有失败路径
        const code = st.errorCode ? `aria2 错误码 ${st.errorCode}` : '未知错误'
        throw new Error(`${code}${st.errorMessage ? '：' + st.errorMessage : ''}`)
      }
      await sleep(30)
    }
  }

  let lastReported = -1
  try {
    for (;;) {
      if (signal.aborted) await handleAbort()

      let st: Aria2Status
      try {
        st = (await rpcCall('aria2.tellStatus', [gid, STATUS_KEYS])) as Aria2Status
      } catch (err) {
        // daemon 失联（已作废状态并清理）→ 原样抛出，调用方在 auto 模式下会用
        // spawn 路径从 .aria2 控制文件续传 —— daemon 死亡不再意味着下载失败
        // （1.9.0 的实现会永远对着死端口失败，审计隐患 ①）。
        if (err instanceof DaemonUnavailableError) throw err
        // 其余（JSON-RPC 层错误等）：转成普通失败，调用方按既有路径回退 curl
        const message = err instanceof Error ? err.message : String(err)
        reporter?.note('aria2 RPC 通信失败，准备回退：' + message)
        await reporter?.awaitFlush()
        throw new Error('aria2 RPC 通信失败：' + message)
      }

      const total = Number(st.totalLength) || 0
      const done = Number(st.completedLength) || 0
      const speed = Number(st.downloadSpeed) || 0
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

      if (st.status === 'complete') {
        reporter?.report(100, '下载完成', undefined, undefined, 'done')
        await reporter?.awaitFlush()
        // 吞吐观测：最后已知速度与连接数（与 spawn 路径的 Aria2Observation 同构）
        return observationFrom()
      }
      if (st.status === 'error') {
        const code = st.errorCode ? `aria2 错误码 ${st.errorCode}` : '未知错误'
        const detail = st.errorMessage ? `：${st.errorMessage}` : ''
        throw new Error(`${code}${detail}`)
      }
      if (st.status === 'removed') {
        // 由 handleAbort 的 remove 调用触达；正常路径不应到这里
        reporter?.cancel()
        await reporter?.awaitFlush()
        throw new DownloadCancelledError('已取消：下载被用户中止')
      }

      // 进度上报：与 spawn 路径同一 reporter 契约
      if (total > 0 && pct !== lastReported) {
        lastReported = pct
        const spd = speed > 0 ? formatSpeed(speed) : undefined
        const etaSec = speed > 0 && total > done ? (total - done) / speed : undefined
        const eta = etaSec !== undefined ? formatEta(etaSec) : undefined
        reporter?.report(pct, '下载中（aria2）', spd, eta)
      }
      if (speed > 0) lastThroughput = speed
      const cn = Number(st.connections) || 0
      // cn 取**峰值**而非最后一次：aria2 收尾排空时 connections 会掉到 1，最后
      // 一次轮询会把中段的 CN:8 冲掉（与 spawn 路径摘要解析的同一教训，见
      // downloader.ts 的 Aria2Observation.cn 注释——抬档门槛答的是「这台主机
      // 上次给了几条连接」，只有峰值答得了）。
      if (cn > 0) lastCn = Math.max(lastCn, cn)

      await sleep(500)
    }
  } catch (err) {
    // 完成竞态：handleAbort 发现下载其实已经完成 —— 转成正常返回，让外层的
    // 成功收尾（assertIntegrity 等）照常执行
    if (err instanceof RpcCompletedRace) return err.observation
    throw err
  }
}

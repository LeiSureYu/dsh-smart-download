/**
 * 下载决策层：根据探测结果与 aria2 可用性，决定用哪种方式、开多少并发。
 *
 * 这是本插件与 dsh-download-progress / dsh-download-guard 的核心差异：
 * - dsh-download-progress 无脑开 16 连接；
 * - dsh-download-guard 无脑拦截所有下载命令；
 * - 本插件先探测，再按文件大小分档决定并发，条件不满足就回退 curl。
 */
import type { ConcurrencyLevel, Decision, ProbeResult } from './types.js'

/** 低于该大小不走 aria2（建连/分片开销大于收益） */
export const SIZE_THRESHOLD = 1 * 1024 * 1024 // 1MB

/** 达到该大小用 8 连接，否则用 4 连接 */
export const LARGE_FILE = 50 * 1024 * 1024 // 50MB

/**
 * 根据文件大小决定并发档位。
 * 不引入 16 连接：保守起见 8 已是上限，避免触发服务器按 IP 限并发。
 */
export function decideConcurrency(size: number): ConcurrencyLevel {
  if (size >= LARGE_FILE) return 8
  return 4
}

/**
 * 决策函数的可选环境描述。
 *
 * `decide()` 此前是**唯一**直接读 `process.platform` / `process.arch` 的分支
 * （「aria2 不可用」的提示文案里带上了当前平台），这让它在别的平台上无法被
 * 单测覆盖 —— 测试跑在哪个平台就只能断言哪个平台。0.6.0 把它抽成入参，
 * 缺省时才回落真实环境，行为不变。
 */
export interface DecideEnv {
  /** 平台标识，对应 `process.platform` */
  platform?: string
  /** 架构标识，对应 `process.arch` */
  arch?: string
}

/**
 * 决策函数：除「aria2 缺失」分支的提示文案会带上当前平台外，不依赖外部状态，便于单测。
 *
 * @param probe 探测结果
 * @param aria2Available 随包 aria2c 是否可定位
 * @param env 环境描述，缺省时取 `process.platform` / `process.arch`
 */
export function decide(
  probe: ProbeResult,
  aria2Available: boolean,
  env: DecideEnv = {},
): Decision {
  // 1. 不支持多线程 —— 直接 curl
  if (!probe.supportsMultiThread) {
    return {
      method: 'curl',
      concurrency: 1,
      fellback: true,
      reason: probe.reason ?? '探测判定不支持多线程',
    }
  }

  // 2. 拿不到文件大小 —— 保守走 curl
  if (probe.contentLength === undefined) {
    return {
      method: 'curl',
      concurrency: 1,
      fellback: true,
      reason: '无法获取文件大小，保守使用 curl',
    }
  }

  // 3. 文件过小 —— 多线程无收益
  if (probe.contentLength < SIZE_THRESHOLD) {
    const kb = (probe.contentLength / 1024).toFixed(0)
    return {
      method: 'curl',
      concurrency: 1,
      fellback: true,
      reason: `文件仅 ${kb}KB，多线程无收益`,
    }
  }

  // 4. aria2 不可用 —— 回退 curl
  if (!aria2Available) {
    const platform = env.platform ?? process.platform
    const arch = env.arch ?? process.arch
    return {
      method: 'curl',
      concurrency: 1,
      fellback: true,
      reason: `未找到 aria2 二进制（当前平台 ${platform}-${arch} 不受支持或子包未安装）`,
    }
  }

  // 5. 支持多线程且 aria2 可用 —— 走 aria2，按大小分档
  const concurrency = decideConcurrency(probe.contentLength)
  const mb = (probe.contentLength / 1024 / 1024).toFixed(1)
  return {
    method: 'aria2',
    concurrency,
    fellback: false,
    reason: `支持 Range，文件 ${mb}MB，使用 ${concurrency} 连接`,
  }
}

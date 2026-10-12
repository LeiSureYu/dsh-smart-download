/**
 * 下载决策层：根据探测结果与 aria2 可用性，决定用哪种方式、开多少并发。
 *
 * 这是本插件与 dsh-download-progress / dsh-download-guard 的核心差异：
 * - dsh-download-progress 无脑开 16 连接；
 * - dsh-download-guard 无脑拦截所有下载命令；
 * - 本插件先探测，再按文件大小分档决定并发，条件不满足就回退 curl。
 */
import type { ConcurrencyLevel, Decision, ProbeResult } from './types.js'
import { readThroughput } from './throughput-cache.js'

/**
 * 插件的并发上限。
 *
 * 为什么是 8 而不是实测更快的 16：32/64MB 下 x=16 确实还能再快一倍（23~24 MB/s），
 * 但保守起见维持 8，避免触发服务器按 IP 限并发（见 `decideConcurrency` 的注释）。
 * 这个常量是「历史抬档」也不得越过的那条线 —— 抬档的收益有界，越过它就是另一个取舍了。
 */
export const MAX_CONCURRENCY = 8

/**
 * 抬档要求「上次实际开了这么多条连接」。
 *
 * 为什么要看实际有效连接数（`CN`）而不是只看请求的 `-x`：`-x` 是我们**请求**的并发，
 * `CN` 才是 aria2 实际用起来的（见 src/progress-parse.ts 的字段注释）。服务器限并发、
 * 分片不够、镜像不给 Range 时，`-x 8` 实际可能只跑 1 条 —— 那种主机的历史不能证明
 * 「多开连接有用」。4 是「至少开出了一半的上限」这个下限，不取更高是因为文件小、
 * 分片少时 `CN` 天然低，而那种文件本来也不在抬档的考虑范围里（见 raiseFromHistory）。
 */
export const RAISE_MIN_EFFECTIVE_CONNECTIONS = 4

/**
 * 抬档文案的固定前缀。
 *
 * 做成常量而不是就地拼串：调用方与测试靠它区分「按大小分档」与「按历史抬档」，
 * 两处各写一份必然漂移（并且会让「无法区分」的返回值悄悄回到代码里）。
 */
export const HISTORY_RAISE_REASON = '依据历史吞吐抬档'

/**
 * 低于该大小不走 aria2（建连/分片开销大于收益）。
 *
 * 依据 0.7.0 受控实测（每连接限速 2MB/s、3 轮取中位数）：
 * 2MB 文件 curl=1.74 MB/s，而 aria2 x=2 就有 3.26 MB/s —— 收益从 1MB 起就很明确。
 * 1MB 以下未测（分片会被 `-k 1M` 的下限截断，本来也开不出多连接），保守维持。
 */
export const SIZE_THRESHOLD = 1 * 1024 * 1024 // 1MB

/**
 * 达到该大小用满 8 连接。
 *
 * 0.7.0 把这一档从 50MB 下调到 8MB，依据是实测：
 *   8MB  x=4 -> 6.26 MB/s   x=8 -> 11.99 MB/s   （差近一倍）
 *   32MB x=4 -> 6.22 MB/s   x=8 -> 12.21 MB/s
 * 也就是说 8~50MB 这一整段长年被压在 4 连接上，白白损失一半速度。
 *
 * 下限定在 8MB 而不是更低：有效并发数受 `-k 1M`（最小分片 1MB）约束，
 * 实测 2MB 文件在 x=2 就到顶（3.26），x=4/8/16 反而略降到 3.1x ——
 * 分片数与文件太小，多出来的连接只剩建连开销。
 */
export const LARGE_FILE = 8 * 1024 * 1024 // 8MB

/**
 * 根据文件大小决定并发档位。
 *
 * 注意 `-k 1M`（见 `buildAria2Args`）是这里的前提：aria2 默认
 * `min-split-size=20M`，小于 20MB 的文件会完全不分片，`-x/-s` 直接失效。
 * 删掉 `-k 1M` 会让下面所有档位静默退化成单连接，务必保留。
 *
 * 不引入 16 连接：实测 32/64MB 下 x=16 确实还能再快一倍（23~24 MB/s），
 * 但保守起见维持 8 上限，避免触发服务器按 IP 限并发。
 */
export function decideConcurrency(size: number): ConcurrencyLevel {
  if (size >= LARGE_FILE) return MAX_CONCURRENCY
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
 * 历史抬档的入参（P1-2 读侧）。
 *
 * 只给 URL 就够：缓存按「主机 + 端口」分桶，密钥从 URL 现算（见 throughput-cache.ts）。
 */
export interface ThroughputHistoryInput {
  /** 原始 URL（取主机 + 端口查历史） */
  url: string
  /** 覆盖缓存目录（测试注入；生产走 `DSH_SMARTDL_THROUGHPUT_DIR` 或默认目录） */
  dir?: string
  /** 注入的「现在」（毫秒），TTL 判定用；缺省取 `Date.now()` */
  now?: number
}

/**
 * 用历史吞吐尝试抬档；任何一条不成立都返回 `null`（= 完全按今天的分档走）。
 *
 * **只抬不降**是这里唯一的行为不变量：函数只在「按大小算出来的档位低于上限」时才可能
 * 返回结果，历史再难看也不会把 8 降成 4、把 4 降成 1。理由是两类误差不对称 ——
 * 历史慢不足以证明这次慢（可能是临时拥塞），而历史快最多把并发提到既有上限 8，
 * 风险有界（与 PLAN-P1-CONCURRENCY §3.2 的结论一致）。
 *
 * 抬档要两条证据同时成立：
 *   1. 历史那次用的就是上限档（`concurrency >= MAX_CONCURRENCY`）—— 说明这台主机上次
 *      真的开过那么多连接；
 *   2. 当时实际有效连接数 `cn >= RAISE_MIN_EFFECTIVE_CONNECTIONS` —— 说明服务器确实
 *      放行了多条并行连接，而不是我们一厢情愿地请求了 8 条。
 *
 * 为什么不对吞吐中位数再设一个阈值：并发只影响连接数、不影响正确性，上限之内
 * 「上次真的开满 8 且服务器放行了 ≥4 条」已经是手上最强的证据；再编一个速度阈值
 * 等于凭空造数据。中位数的用途是**写进文案**（让调用方能核对抬档依据），不是门槛。
 */
function raiseFromHistory(
  size: number,
  bySize: ConcurrencyLevel,
  history: ThroughputHistoryInput | undefined,
): { concurrency: ConcurrencyLevel; reason: string } | null {
  // 没有历史入参、或者本来就已经在上限档（≥8MB 的文件）→ 无事可做
  if (history === undefined || bySize >= MAX_CONCURRENCY) return null
  const hit = readThroughput(history.url, { dir: history.dir, now: history.now })
  if (hit === null) return null
  const { key, record } = hit
  if (record.concurrency < MAX_CONCURRENCY) return null
  if (record.cn < RAISE_MIN_EFFECTIVE_CONNECTIONS) return null

  const fileMb = (size / 1024 / 1024).toFixed(1)
  const speedMb = (record.medianThroughput / 1024 / 1024).toFixed(2)
  return {
    concurrency: MAX_CONCURRENCY,
    reason:
      `${HISTORY_RAISE_REASON}：主机 ${key.hostHash}（端口 ${key.port}）上次以 ` +
      `${record.concurrency} 连接实测实际有效 ${record.cn} 条、吞吐中位数 ${speedMb}MB/s；` +
      `本次文件 ${fileMb}MB 按大小只给 ${bySize}，` +
      // 明写「插件并发上限」：历史里的并发数原样引用（它是当时的观测事实），必须让读者
      // 一眼看出最终用的是上限档，而不是把那个数字当成本次的并发
      `按历史提到 ${MAX_CONCURRENCY}（插件并发上限）`,
  }
}

/**
 * 决策函数：除「aria2 缺失」分支的提示文案会带上当前平台外，只有在**显式给了**
 * `history` 时才会碰磁盘（读吞吐缓存），因此仍然便于单测。
 *
 * @param probe 探测结果
 * @param aria2Available 随包 aria2c 是否可定位
 * @param env 环境描述，缺省时取 `process.platform` / `process.arch`
 * @param history 可选的历史吞吐入参；**不给就与今天逐字段相同**（不读盘、不抬档）。
 *   注意缓存目前**还没有写入者**：写入点接在下载结束时（src/index.ts / src/downloader.ts），
 *   是紧随本项之后的独立任务。所以现在传了历史也只会命中「手工/测试写入的记录」。
 */
export function decide(
  probe: ProbeResult,
  aria2Available: boolean,
  env: DecideEnv = {},
  history?: ThroughputHistoryInput,
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

  // 5. 支持多线程且 aria2 可用 —— 走 aria2，按大小分档；有可信历史时只做「抬档」
  const bySize = decideConcurrency(probe.contentLength)
  const raised = raiseFromHistory(probe.contentLength, bySize, history)
  if (raised) {
    return {
      method: 'aria2',
      concurrency: raised.concurrency,
      fellback: false,
      reason: raised.reason,
    }
  }
  const mb = (probe.contentLength / 1024 / 1024).toFixed(1)
  return {
    method: 'aria2',
    concurrency: bySize,
    fellback: false,
    reason: `支持 Range，文件 ${mb}MB，使用 ${bySize} 连接`,
  }
}

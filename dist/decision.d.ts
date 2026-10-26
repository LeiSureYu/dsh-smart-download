/**
 * 下载决策层：根据探测结果与 aria2 可用性，决定用哪种方式、开多少并发。
 *
 * 这是本插件与 dsh-download-progress / dsh-download-guard 的核心差异：
 * - dsh-download-progress 无脑开 16 连接；
 * - dsh-download-guard 无脑拦截所有下载命令；
 * - 本插件先探测，再按文件大小分档决定并发，条件不满足就回退 curl。
 */
import type { ConcurrencyLevel, Decision, ProbeResult } from './types.js';
import { MIN_CONNECTIONS, MAX_CONNECTIONS } from './types.js';
/**
 * 插件的并发上限。
 *
 * 为什么是 8 而不是实测更快的 16：32/64MB 下 x=16 确实还能再快一倍（23~24 MB/s），
 * 但保守起见维持 8，避免触发服务器按 IP 限并发（见 `decideConcurrency` 的注释）。
 * 这个常量是「历史抬档」也不得越过的那条线 —— 抬档的收益有界，越过它就是另一个取舍了。
 */
export declare const MAX_CONCURRENCY = 8;
/**
 * 抬档要求「上次实际开了这么多条连接」。
 *
 * 为什么要看实际有效连接数（`CN`）而不是只看请求的 `-x`：`-x` 是我们**请求**的并发，
 * `CN` 才是 aria2 实际用起来的（见 src/progress-parse.ts 的字段注释）。服务器限并发、
 * 分片不够、镜像不给 Range 时，`-x 8` 实际可能只跑 1 条 —— 那种主机的历史不能证明
 * 「多开连接有用」。4 是「至少开出了一半的上限」这个下限，不取更高是因为文件小、
 * 分片少时 `CN` 天然低，而那种文件本来也不在抬档的考虑范围里（见 raiseFromHistory）。
 */
export declare const RAISE_MIN_EFFECTIVE_CONNECTIONS = 4;
/**
 * 抬档文案的固定前缀。
 *
 * 做成常量而不是就地拼串：调用方与测试靠它区分「按大小分档」与「按历史抬档」，
 * 两处各写一份必然漂移（并且会让「无法区分」的返回值悄悄回到代码里）。
 */
export declare const HISTORY_RAISE_REASON = "\u4F9D\u636E\u5386\u53F2\u541E\u5410\u62AC\u6863";
/**
 * 低于该大小不走 aria2（建连/分片开销大于收益）。
 *
 * 依据 0.7.0 受控实测（每连接限速 2MB/s、3 轮取中位数）：
 * 2MB 文件 curl=1.74 MB/s，而 aria2 x=2 就有 3.26 MB/s —— 收益从 1MB 起就很明确。
 * 1MB 以下未测（分片会被 `-k 1M` 的下限截断，本来也开不出多连接），保守维持。
 */
export declare const SIZE_THRESHOLD: number;
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
export declare const LARGE_FILE: number;
/**
 * 用户可点名的连接数范围：1..16 的**任意整数**（`connections` 参数与界面偏好共用）。
 *
 * 早先的草案只提供 1/4/8/16 四档，理由是相邻整数之间的收益差在实测里被噪声淹没。
 * 改成连续区间是因为**选择权在用户**：固定几个档位等于替用户决定了「哪些数字值得试」，
 * 而真正被服务器限并发的主机往往只有特定几个值有意义（常见的就是 2~6 这种小区间），
 * 四档反而够不着。代价只是多出几个「填了也不会更快」的数 —— 那不是错误，是用户的实验。
 *
 * **为什么上限是 16 而不是更大**：aria2 自己的 `-x/--max-connection-per-server`
 * 取值范围是 1..16（已实测：传 32 时 aria2c 以 errorCode=28 直接退出，
 * 「must be between 1 and 16」）。`-s` 没有这个限制，但 `-x` 才是「对同一个服务器
 * 最多开几条」的那一条，越过 16 在 aria2 这一层根本表达不出来。给一个注定失败的
 * 选项，比不给更糟 —— 用户会以为自己在用 32 连接。
 *
 * 注意 `MAX_CONCURRENCY = 8` 仍是 **auto 模式**的上限：自动分档与历史抬档都不会越过它。
 * 点名的数字由选择它的人承担风险，插件不再二次缩水。
 */
export { MIN_CONNECTIONS, MAX_CONNECTIONS };
/** 供界面与 schema 复用的候选值：1..16 全部整数。 */
export declare const CONNECTION_CHOICES: readonly string[];
/**
 * `connections` 参数 / 偏好的解析结果。
 *
 * 三种状态必须能区分（调用方据此在**发请求之前**拒绝非法值，而不是悄悄回落成 auto）：
 * - `undefined`：没传 —— 与 1.6.0 的行为逐字段相同；
 * - `'auto'`：显式要自动分档；
 * - 数字：用户点名的连接数，一定在 `MIN_CONNECTIONS`..`MAX_CONNECTIONS` 区间内。
 */
export type ParsedConnections = number | 'auto' | undefined;
/**
 * 解析 `connections` 参数。
 *
 * schema 层已经限定了取值范围，这一层仍独立校验：重试元数据来自磁盘、
 * 偏好文件可能被手工改过，不能信任它们一定合法。
 *
 * @param raw 原始入参（字符串或数字）
 * @returns 解析结果；非法时返回 `null`（与「没传」的 `undefined` 严格区分）
 */
export declare function parseConnections(raw: unknown): ParsedConnections | null;
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
export declare function decideConcurrency(size: number): ConcurrencyLevel;
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
    platform?: string;
    /** 架构标识，对应 `process.arch` */
    arch?: string;
}
/**
 * 历史抬档的入参（P1-2 读侧）。
 *
 * 只给 URL 就够：缓存按「主机 + 端口」分桶，密钥从 URL 现算（见 throughput-cache.ts）。
 */
export interface ThroughputHistoryInput {
    /** 原始 URL（取主机 + 端口查历史） */
    url: string;
    /** 覆盖缓存目录（测试注入；生产走 `DSH_SMARTDL_THROUGHPUT_DIR` 或默认目录） */
    dir?: string;
    /** 注入的「现在」（毫秒），TTL 判定用；缺省取 `Date.now()` */
    now?: number;
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
 * @param requested 调用方点名的连接数（`connections` 解析后的数字）；缺省 / `auto`
 *   表示按既有规则自动分档。点名时**只覆盖并发数**：其它回退条件（不支持 Range、
 *   大小未知、文件过小、aria2 缺失）依然成立 —— 那些是「做不到多线程」，
 *   不是「想开几条」的偏好问题。
 */
export declare function decide(probe: ProbeResult, aria2Available: boolean, env?: DecideEnv, history?: ThroughputHistoryInput, requested?: ParsedConnections): Decision;

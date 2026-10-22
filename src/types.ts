/**
 * smart_download 工具的参数与返回结果类型定义
 */

/** 请求头表：头名 -> 头值（头名已归一化为 `X-Foo-Bar` 形式） */
export type RequestHeaders = Record<string, string>

/**
 * 批量下载里的一个条目。
 *
 * 字段与单条目调用**同构**（`url` 必填，`output` / `sha256` 可选），这样模型把
 * 单条调用的写法直接塞进数组即可，不需要记第二套参数名。其余单条目参数
 * （mirror / userAgent / referer / headers / maxBandwidth）是**整批共享**的，
 * 因此不在这里重复声明 —— 每条一个镜像会立刻变成「同一次调用里两种真相」。
 */
export interface DownloadTarget {
  /** 待下载文件的 URL */
  url: string
  /** 该条目的输出文件路径，可选；缺省时按 URL 推导 */
  output?: string
  /** 该条目的期望 SHA-256，可选；逐条独立校验 */
  sha256?: string
  /**
   * 该条目的期望摘要，可选；支持 sha256 / sha512 / sha1 / md5。
   * 与 `sha256` 同时给出会被拒绝（两种真相）。
   */
  checksum?: string
  /**
   * 该条目的同名文件策略，可选；缺省沿用单条目默认值 `overwrite`。
   * 逐条独立生效，因为同一批里「覆盖安装包」与「保留已有报告」完全可能同时存在。
   */
  ifExists?: IfExistsPolicy
}

/** 工具入参 */
export interface SmartDownloadArgs {
  /**
   * 待下载文件的 URL。
   *
   * 与 `targets` **二选一**：单条目走这一条（行为与 1.2.0 逐字段相同），
   * 批量走 `targets`。两者同时给出会被拒绝，而不是「以某一个为准」——
   * 静默忽略其中一边会让调用方以为两边都下了。
   */
  url?: string
  /** 输出文件路径，可选；缺省时根据 URL 自动推导文件名 */
  output?: string
  /**
   * 一次调用内批量下载的条目列表，可选；与 `url` 二选一。
   *
   * 为什么是数组而不是多次调用：DSH 的 `smart_download` 未声明
   * `isConcurrencySafe`，执行模式是 exclusive —— 同一时刻只有一个调用在跑，
   * 分多次调用只能串行等待。批量让多条在同一批内并行（批内并发窗口见
   * `batchWindow()`），且共享一份入参校验与进度上报。
   */
  targets?: DownloadTarget[]
  /**
   * 整批共享的总带宽上限，可选。接受正整数 + 可选单位后缀
   * （`K` / `M` / `G`，按 1024 进制），例如 `"2M"`、`"500K"`、`"1500000"`。
   *
   * 语义是**一批内所有任务合计**的上限：分给批内并发跑的每个条目一份
   * （总量 ÷ 批内并发数），因此一批的总吞吐不会超过它。单条目调用时就是那一条
   * 的上限。非法值在任何请求发出之前直接抛错。
   */
  maxBandwidth?: string
  /**
   * 每个条目的超时（毫秒），可选；缺省表示**不设超时**。
   *
   * 取值范围 `1000`..`1800000`（下限挡「把正常下载误杀」，上限是保守取值，见下）。
   * 为什么需要它：路线 A 是同步调用，一个卡死的条目会让整批一直不返回。
   * 为什么上限放在 30 分钟：足够覆盖常见的大文件（1GB @ 1MB/s ≈ 17 分钟），而更长的
   * 等待说明应当改用「先返回、后台继续」的形态 —— 那个形态明确不做；同时也不设更激进的
   * 默认值，否则会把「慢但正常」的大文件判死。
   *
   * 超时只终止它自己这一条：批量里其余条目继续跑，已完成条目的结果不会被改判，
   * 且超时记 `failed` 而不是 `cancelled`（用户并没有按取消）。非法值在任何请求
   * 发出之前抛错；解释器见 src/index.ts 的 parseTimeoutMs / finishAborted。
   */
  timeoutMs?: number
  /**
   * 镜像前缀，可选；提供后把原始 URL 拼到该前缀后面再下载。
   * 例如 `https://gh-proxy.com/` + 原始 GitHub 下载地址。
   * 传字面量 `auto` 时改为自动模式：从内置候选表里挑一个**经证实与原地址
   * 同源**的镜像（见 src/auto-mirror.ts），仅对 GitHub 地址生效。
   */
  mirror?: string
  /**
   * 期望的 SHA-256 摘要，可选；下载完成后逐字节核对。
   *
   * 用法就是「把官方文档里写着的那个摘要粘进来」，接受裸十六进制、
   * `sha256:<hex>` / `SHA256(<hex>)` 前缀写法，以及 SRI 的 `sha256-<base64>`。
   * 长度校验只能证明字节数对，证明不了内容是同一份；传了摘要才挡得住
   * 「等长但内容不同」。摘要不合法会在下载开始前直接拒绝。
   */
  sha256?: string
  /**
   * 通用摘要，可选；接受 `sha512:<hex>` / `md5:<hex>` / `sha1:<hex>`，
   * 也接受裸十六进制（按长度识别算法）。与 `sha256` 二选一。
   */
  checksum?: string
  /**
   * 目标文件已存在时的策略，可选，默认 `overwrite`。
   * - `overwrite`：覆盖（沿用 aria2 --allow-overwrite / curl -o）
   * - `skip`：不下载，返回 skipped: true（已有文件若带摘要仍会校验）
   * - `rename`：另存为 `name (1).ext`，绝不覆盖已有文件
   */
  ifExists?: IfExistsPolicy
  /** `User-Agent`，可选；探测与下载使用同一个值 */
  userAgent?: string
  /** `Referer`，可选；部分站点/镜像按它放行 */
  referer?: string
  /**
   * 任意附加请求头，可选；键为头名、值为字符串。
   * 与 `userAgent` / `referer` 同源合并，命名参数优先。
   * `Range` / `Accept-Encoding` / `Host` 等由插件自身管理的头不允许覆盖。
   */
  headers?: Record<string, unknown>
}

/** 下载使用的底层方式 */
export type DownloadMethod = 'aria2' | 'curl'

/** 同名冲突策略 */
export type IfExistsPolicy = 'overwrite' | 'skip' | 'rename'

/** 工具返回结果 */
export interface SmartDownloadResult {
  /** 是否下载成功 */
  success: boolean
  /** 最终落盘的文件路径 */
  path: string
  /** 实际使用的下载方式 */
  method?: DownloadMethod
  /** 文件大小（字节），探测到时返回 */
  size?: number
  /** 是否发生了回退（aria2 -> curl） */
  fellback: boolean
  /** 回退或不支持多线程的原因 */
  reason?: string
  /**
   * 本次**没有**做落盘字节数校验的说明（跳过校验时出现）。
   *
   * 为什么单独开一个字段而不是复用 `reason`：`reason` 讲的是「为什么选了这种
   * 下载方式」，这里讲的是「为什么这次没验完整性」，两件事会被同时看到时就
   * 互相顶掉了。跳过校验的两种情形见 `src/verify.ts` 的 `VerifySkipReason`。
   *
   * 传了 `sha256` 且校验通过时该字段**不出现** —— 内容哈希是比长度更强的
   * 证明，此时再报「未做字节数校验」只会误导。证明本身由 `sha256` 承载。
   */
  verifySkipped?: string
  /**
   * 实际算出的 SHA-256 摘要（小写十六进制）。
   * 仅在调用方传了 `sha256` 且校验通过时出现 —— 它的存在就是「内容已核对」。
   */
  sha256?: string
  /** 实际算出的摘要（通用校验时出现） */
  checksum?: string
  /** 实际摘要所用算法：md5 / sha1 / sha256 / sha512 */
  checksumAlgorithm?: string
  /** 因目标已存在且 ifExists=skip 而未下载（此时 success 仍为 true） */
  skipped?: boolean
  /**
   * 本次**没有**做磁盘空间预检的说明（仅在远端声明了大小、但 `statfs` 查询失败时出现）。
   * 远端大小未知时该字段不出现：那种情况下 `verifySkipped` 已经说明校验受限。
   */
  diskCheckSkipped?: string
  /** 实际请求的地址（启用镜像时为「镜像前缀 + 原始 URL」，否则等于原始 URL） */
  requestedUrl: string
  /** 是否走了镜像加速 */
  mirrored: boolean
  /** 实际使用的镜像前缀（`mirrored` 为真时出现） */
  mirror?: string
  /**
   * 本次**没有**使用镜像的说明（请求了自动镜像但未启用时出现）。
   * 与 `verifySkipped` 同理：自动镜像静默失效时，调用方必须能看见原因。
   */
  mirrorSkipped?: string
}

/**
 * 批量下载里**单个条目**的结果。
 *
 * 为什么单独一套字段而不是直接复用 `SmartDownloadResult`：批量必须能表达
 * 「这条没下成」和「这条被取消」，而 `SmartDownloadResult` 里 `success: false`
 * 只覆盖「失败」一种终态，取消与失败混在一起会让用户以为下载坏了（这正是
 * 1.0.0 在单条目路径上修过的那个坑，批量不能把它带回来）。
 *
 * 字段是**扁平**的：output schema 用 `additionalProperties: false` 校验，嵌套
 * 对象只会让「哪条缺了什么」更难核对。
 */
export interface BatchItemResult {
  /** 该条目请求的原始 URL（逐条可辨认） */
  url: string
  /** 该条目最终的目标路径（按 output 或 URL 推导，失败时也能看出本该落到哪） */
  output: string
  /** 该条目是否下载成功 */
  success: boolean
  /** 是否因整批取消而未完成（与失败区分；成功条目不会带上它） */
  cancelled?: boolean
  /** 失败 / 取消原因（逐条可见，失败条目必有） */
  error?: string
  /** 实际使用的下载方式（有结论时出现） */
  method?: DownloadMethod
  /** 落盘路径（成功时与 output 相同，显式给出便于逐条核对） */
  path?: string
  /** 文件大小（探测到时出现） */
  size?: number
  /** 是否发生了 aria2 → curl 回退 */
  fellback?: boolean
  /** 回退或不支持多线程的原因 */
  reason?: string
  /** 未做字节数校验的说明（跳过校验时出现） */
  verifySkipped?: string
  /** 校验通过的 SHA-256（传了 sha256 且通过时出现） */
  sha256?: string
  /** 实际算出的摘要（通用校验时出现） */
  checksum?: string
  /** 实际摘要所用算法 */
  checksumAlgorithm?: string
  /** 因目标已存在且 ifExists=skip 而未下载 */
  skipped?: boolean
  /** 未做磁盘空间预检的说明（仅在 statfs 查询失败时出现） */
  diskCheckSkipped?: string
  /** 实际请求的地址（启用镜像时与 url 不同） */
  requestedUrl?: string
  /** 是否走了镜像 */
  mirrored?: boolean
  /** 实际使用的镜像前缀 */
  mirror?: string
  /** 未使用自动镜像的说明 */
  mirrorSkipped?: string
}

/**
 * 批量下载的返回值：逐条结果 + 汇总计数。
 *
 * 为什么**不**在部分失败时抛错（用户决策 D4=②）：抛错会把已成功条目的结果
 * 一起吞掉，而调用方最需要的恰恰是「哪几条成了、哪几条没成」。因此批量路径
 * 永远正常返回，成败由 `results` 与计数表达；只有「入参本身不合法」（url 与
 * targets 同时给出、超过批量上限、带宽值非法…）才在发起请求之前抛错。
 */
export interface BatchDownloadResult {
  /** 本批次的批次 ID（与两条进度轨道里写的是同一个值） */
  batch: string
  /** 逐条结果，顺序与入参 `targets` 一致 */
  results: BatchItemResult[]
  /** 成功条数 */
  succeeded: number
  /** 失败条数（不含取消） */
  failed: number
  /** 取消条数（整批取消时未完成的那些条目） */
  cancelled: number
}

/** URL 探测结果 */
export interface ProbeResult {
  /** 是否支持多线程下载 */
  supportsMultiThread: boolean
  /** 资源总大小（字节） */
  contentLength?: number
  /** Accept-Ranges 响应头原始值 */
  acceptRanges?: string
  /** Content-Type 响应头 */
  contentType?: string
  /**
   * `Content-Disposition` 响应头原始值。
   *
   * 很多下载站（尤其是 GitHub release / 对象存储）的 URL 末段没有真实文件名，
   * 真名只在这个头里。调用方据此推导落盘文件名，避免所有下载都叫 `download`。
   */
  contentDisposition?: string
  /** 不支持多线程 / 回退的原因 */
  reason?: string
  /**
   * `ETag` 响应头原始值（含引号）。
   * 0.6.0 起用于续传前的一致性校验：它是「远端资源有没有变」的最强信号。
   */
  etag?: string
  /**
   * `Last-Modified` 响应头原始值。
   * 服务器不发 ETag 时的次优内容指纹，比仅比对长度可靠得多。
   */
  lastModified?: string
  /**
   * `Content-Encoding` 响应头原始值（小写后）。
   * 0.7.0 起用于大小校验的“可信度判定”：探测已强制 `accept-encoding: identity`，
   * 但仍有服务器无视该请求头返回 gzip/br。此时 `contentLength` 是压缩后长度，
   * 与 curl/aria2 实际落盘的未压缩字节数不可比 —— 校验必须跳过而不是误判。
   */
  contentEncoding?: string
}

/** 探测可选项 */
export interface ProbeOptions {
  /** 判定为“值得多线程”的最小文件阈值（字节），默认 1MB */
  threshold?: number
  /** 单次 HTTP 请求超时时间（毫秒），默认 5000ms */
  timeout?: number
  /**
   * 附加请求头（UA / Referer / 自定义），与下载时使用**同一套**。
   * 见 src/headers.ts 文件头：两边不一致会让探测结论与真实下载错位。
   * 探测自身强制的 `accept-encoding: identity` 永远最后合并，覆盖不掉。
   */
  headers?: RequestHeaders
}

/**
 * DSH 工具执行上下文。
 *
 * execute 的第二参是 `@deepseek-ai/dsh-tools` 的 `ToolRunContext`，它带
 * `signal` 与 `agent`（`readonly agent?: Agent`）。这里只声明本插件真正读到的
 * 结构化子集：不 import `@deepseek-ai/dsh-agent` / `dsh-session`，避免把
 * 它们写进 peerDependencies —— 我们只按形状取用，缺字段时自行降级。
 *
 * 为什么需要 session：dsh-task-progress 的读取端按 session 过滤
 * （`snapshot(now, sessionId)`），写入端必须把进度文件放进
 * `<session.cwd>/.dsh-progress/<session.id>/`，否则那条轨道永远不会被面板读到。
 */
export interface ToolExecutionContext {
  /** 模型 / 宿主取消本次调用时触发的信号 */
  signal: AbortSignal
  /** 发起本次调用的 agent（由 agent loop 注入），缺省时拿不到 session */
  readonly agent?: {
    readonly session?: {
      readonly header?: {
        /** 会话 ID，同时也是进度目录名 */
        readonly id?: string
        /** 会话创建时的工作目录 */
        readonly cwd?: string
      }
    }
  }
}

/** download_status 工具入参 */
export interface DownloadStatusArgs {
  /** 指定任务 ID；缺省时列出最近的任务 */
  taskId?: string
  /** 最多返回多少条 */
  limit?: number
}

/** 并发档位：1（curl）/ 4 / 8（aria2） */
export type ConcurrencyLevel = 1 | 4 | 8

/** 决策结果 */
export interface Decision {
  /** 最终采用的下载方式 */
  method: DownloadMethod
  /** 并发连接数 */
  concurrency: ConcurrencyLevel
  /** 是否发生了回退（true 表示未用 aria2） */
  fellback: boolean
  /** 决策依据，会原样写入返回结果的 reason 字段 */
  reason: string
}

/** 进度记录（dsh-task-progress JSONL 格式） */
export interface ProgressRecord {
  /** schema 版本，固定 1 */
  v: 1
  /** 任务 ID */
  task: string
  /** 进度百分比 0-100 的整数 */
  pct: number
  /** 简短说明 */
  msg: string
  /**
   * 任务状态。dsh-task-progress 的 `parseEvent()` **只认这个字段**：
   * 缺失时一律按 `running` 处理，因此 0.5.0 之前写的轨道一记录即使
   * `pct` 已经是 100、`msg` 写着「下载完成」，面板也永远显示「下载中」。
   * 取值：`running` | `done` | `failed` | `cancelled`。
   */
  state?: ProgressState
  /**
   * 人类可读的任务名（通常是输出文件名）。
   * 独立于 `msg`：`msg` 承载状态文案（"下载中（aria2）"），
   * 面板要展示的是文件名，两者不能互相顶掉。
   */
  name?: string
  /** 速度字符串，如 "8.2MB/s" */
  spd?: string
  /** 剩余时间字符串，如 "4m51s" */
  eta?: string
  /**
   * 批次 ID，可选（1.3.0 新增）：同一次 `smart_download` 调用里的所有条目共享
   * 同一个值，单条目调用也会有一个**唯一**的值。
   *
   * 为什么必须有这个字段：批量调用会一次产生多条进度记录，而读取端（面板 /
   * `download_status`）只能按时间倒序看到一堆散点，无法判断「这几条是同一次
   * 调用」——分组信息只存在调用方的上下文里，落盘时丢掉就再也补不回来。
   *
   * 它**只是分组标签**：不参与任何执行/并发/去重决策，读取端拿不到它时行为与
   * 之前完全相同（老进度文件缺该字段是正常情况，不是损坏）。
   */
  batch?: string
  /**
   * 输出文件的**绝对路径**，可选（1.4.0 新增）。
   *
   * 为什么必须有：下载管理器要能「在文件管理器中显示」与「删除本地文件」，
   * 而这两件事都要求知道文件落在哪里。`name` 顶不了这个位置 —— 它是标签
   * （`ProgressReporter` 的 `label`），调用方可能传文件名、也可能传别的字符串。
   *
   * 隐私：这是本机绝对路径（通常含用户名），只写进本机进度文件、不随任何请求外发；
   * 口径见 `docs/SECURITY.md`。删除规则要求它是绝对值，因此写入方必须传
   * `path.resolve(...)` 的结果（相对路径在删除时会被拒绝，见 rpc.ts 的 R3）。
   */
  outPath?: string
  /**
   * 下载结束时的字节数，可选（1.4.0 新增，只在**终态**记录里写）。
   *
   * 用途：判断「文件还在不在原位置」时，光看「路径存在」不够 —— 原文件被移走后
   * 另一个文件占用了同一个名字时，只看存在性会删错东西。尺寸是那条判据的落点。
   */
  size?: number
  /** 下载结束时的 mtime（毫秒），可选（1.4.0 新增，只在**终态**记录里写）。 */
  fileMtimeMs?: number
}

/** 进度状态，取值与 dsh-task-progress 的协议一致 */
export type ProgressState = 'running' | 'done' | 'failed' | 'cancelled'

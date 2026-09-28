/**
 * smart_download 工具的参数与返回结果类型定义
 */

/** 工具入参 */
export interface SmartDownloadArgs {
  /** 待下载文件的 URL */
  url: string
  /** 输出文件路径，可选；缺省时根据 URL 自动推导文件名 */
  output?: string
  /**
   * 镜像前缀，可选；提供后把原始 URL 拼到该前缀后面再下载。
   * 例如 `https://gh-proxy.com/` + 原始 GitHub 下载地址。
   */
  mirror?: string
}

/** 下载使用的底层方式 */
export type DownloadMethod = 'aria2' | 'curl'

/** 工具返回结果 */
export interface SmartDownloadResult {
  /** 是否下载成功 */
  success: boolean
  /** 最终落盘的文件路径 */
  path: string
  /** 实际使用的下载方式 */
  method: DownloadMethod
  /** 文件大小（字节），探测到时返回 */
  size?: number
  /** 是否发生了回退（aria2 -> curl） */
  fellback: boolean
  /** 回退或不支持多线程的原因 */
  reason?: string
  /** 实际请求的地址（启用镜像时为「镜像前缀 + 原始 URL」，否则等于原始 URL） */
  requestedUrl: string
  /** 是否走了镜像加速 */
  mirrored: boolean
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
}

/** 探测可选项 */
export interface ProbeOptions {
  /** 判定为“值得多线程”的最小文件阈值（字节），默认 1MB */
  threshold?: number
  /** 单次 HTTP 请求超时时间（毫秒），默认 5000ms */
  timeout?: number
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
}

/** 进度状态，取值与 dsh-task-progress 的协议一致 */
export type ProgressState = 'running' | 'done' | 'failed' | 'cancelled'

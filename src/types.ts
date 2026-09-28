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
 * 假设：DSH 0.1.0-rc.5 的 execute 第二参会透传一个含 AbortSignal 的对象，
 * 这里只声明本插件实际使用到的字段。
 */
export interface ToolExecutionContext {
  /** 模型 / 宿主取消本次调用时触发的信号 */
  signal: AbortSignal
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

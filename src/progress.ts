/**
 * 进度上报：写两条轨道，任一轨道不可写都静默容错。
 *
 * 轨道一 —— dsh-task-progress 的 JSONL 协议（append-only）
 *   路径：<session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl
 *         （设置了 $DSH_PROGRESS_DIR 时优先使用该目录）
 *   两个关键点（0.5.0 实测确认的读取端行为）：
 *   1. 读取端 `snapshot(now, sessionId)` 会按 session 过滤，写错目录等于没写。
 *      因此没有会话上下文时本插件**不写**轨道一，而不是写进一个永远不会被
 *      读到的目录（0.5.0 之前写的是 `<cwd>/.dsh-progress/default`）。
 *   2. 读取端 `parseEvent()` 只认 `state` 字段判定状态，缺失时一律当 `running`，
 *      所以「pct=100 + msg=下载完成」在面板上仍然显示「下载中」。
 *
 * 轨道二 —— 本插件自己的任务快照（JSON，整体覆盖写）
 *   路径：$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json
 *         缺省 <DSH_HOME>/downloads/tasks/<taskId>.json（DSH_HOME 缺省 ~/.dsh）
 *   供 `download_status` 与浏览器端进度面板读取。早期版本按 dsh-download-progress
 *   的格式设计，但该包并未发布到 npm（0.5.0 实测 registry 返回 404），因此这里
 *   如实称其为本插件自有格式。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ProgressRecord, ProgressState } from './types.js'

/** dsh-task-progress 的目录名规则（对应其 `SESSION_SEGMENT_RE`）。 */
const SESSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** 当前会话的定位信息，来自 `exec.agent.session.header`。 */
export interface ProgressSession {
  /** 会话 ID，同时也是进度目录名 */
  id?: string
  /** 会话创建时的工作目录，进度根目录 */
  cwd?: string
}

/** 展开 `~` / `~/x` / `~\x`（与 @deepseek-ai/dsh-home-paths 的行为一致）。 */
function expandHomePath(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

/**
 * 解析 DSH home 目录。
 *
 * 优先级与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 保持一致：
 * 显式配置（本插件不读配置，故略过） → `$DSH_HOME`（空 / 纯空白视为未设置）
 * → `~/.dsh`。
 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return path.resolve(expandHomePath(fromEnv))
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * 解析轨道一的目录。
 *
 * 优先级：`$DSH_PROGRESS_DIR`（显式覆盖，测试与特殊部署用） → 当前会话目录
 * → `null`（表示「没有可靠的落点，不写轨道一」）。
 *
 * @param session 当前会话；缺省或字段不合法时返回 null
 */
export function resolveTaskProgressDir(session?: ProgressSession): string | null {
  if (process.env.DSH_PROGRESS_DIR) return process.env.DSH_PROGRESS_DIR
  const id = session?.id
  const cwd = session?.cwd
  if (
    typeof id === 'string' &&
    SESSION_SEGMENT_RE.test(id) &&
    typeof cwd === 'string' &&
    cwd.length > 0
  ) {
    return path.join(cwd, '.dsh-progress', id)
  }
  return null
}

/**
 * 解析轨道二（任务快照 JSON）的目录。
 * 设置了 `$DSH_DOWNLOAD_PROGRESS_DIR` 时优先使用，否则为 `<DSH_HOME>/downloads/tasks`。
 */
export function resolveDownloadProgressDir(): string {
  if (process.env.DSH_DOWNLOAD_PROGRESS_DIR) {
    return process.env.DSH_DOWNLOAD_PROGRESS_DIR
  }
  return path.join(resolveDshHome(), 'downloads', 'tasks')
}

/** 确保目录存在，失败时返回 null（不抛异常） */
function ensureDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/** 轨道二任务文件的运行态结构（本插件自有格式） */
interface DownloadTaskFile {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  speed?: string
  eta?: string
  updatedAt: number
}

/**
 * 从状态文案兜底推断终态。
 *
 * 只在调用方没有显式给 `state` 时使用，属于对老调用点的兼容垫片：
 * 显式 `state` 永远优先。
 */
function inferStateFromMessage(msg: string): ProgressState {
  if (msg.includes('失败')) return 'failed'
  if (msg.includes('完成')) return 'done'
  return 'running'
}

export class ProgressReporter {
  private readonly taskId: string
  private readonly label: string | undefined
  private taskProgressFile: string | null = null
  private downloadProgressFile: string | null = null
  private lastPct = -1
  /** 上一次写入的去重键；内容完全一致时不重复落盘 */
  private lastKey = ''

  /**
   * @param taskId 任务 ID，用于文件名与状态查询
   * @param label 人类可读的任务名（通常是输出文件名），会写入两条轨道供 UI 展示
   * @param session 当前会话；用于把轨道一写进该会话的进度目录，缺省则不写轨道一
   */
  constructor(taskId: string, label?: string, session?: ProgressSession) {
    this.taskId = taskId
    this.label = label

    const taskDir = resolveTaskProgressDir(session)
    if (taskDir) {
      const ready = ensureDir(taskDir)
      if (ready) this.taskProgressFile = path.join(ready, `${taskId}.jsonl`)
    }

    const dlDir = ensureDir(resolveDownloadProgressDir())
    if (dlDir) {
      this.downloadProgressFile = path.join(dlDir, `${taskId}.json`)
    }
  }

  /**
   * 上报进度。
   * @param pct 0-100 的进度（会四舍五入为整数）
   * @param msg 简短说明，如“下载中”、“探测中”
   * @param spd 速度字符串，如 "8.2MB/s"
   * @param eta 剩余时间字符串，如 "4m51s"
   * @param state 任务状态，缺省按 `running`；终态记录必须显式传入
   */
  report(
    pct: number,
    msg: string,
    spd?: string,
    eta?: string,
    state: ProgressState = 'running',
  ): void {
    const rounded = Math.max(0, Math.min(100, Math.round(pct)))
    // 显式 state 优先；未给 state 时用文案兜底推断（兼容老调用点）
    const effectiveState: ProgressState =
      state !== 'running' ? state : inferStateFromMessage(msg)

    // 去重：内容完全一致（含状态、速度、ETA）时不重复落盘。
    // 任一字段变化都写，因此面板能看到实时的速度 / 剩余时间。
    const key = `${rounded}|${effectiveState}|${msg}|${spd ?? ''}|${eta ?? ''}`
    if (key === this.lastKey) return
    this.lastKey = key
    this.lastPct = rounded

    // 轨道一：JSONL append
    if (this.taskProgressFile) {
      const rec: ProgressRecord = {
        v: 1,
        task: this.taskId,
        state: effectiveState,
        pct: rounded,
        msg,
      }
      if (this.label) rec.name = this.label
      if (spd) rec.spd = spd
      if (eta) rec.eta = eta
      try {
        fs.appendFileSync(this.taskProgressFile, JSON.stringify(rec) + '\n', 'utf-8')
      } catch {
        /* 目录被删 / 权限变化，静默忽略 */
      }
    }

    // 轨道二：JSON 覆盖写
    if (this.downloadProgressFile) {
      const status: DownloadTaskFile['status'] =
        effectiveState === 'done'
          ? 'completed'
          : effectiveState === 'failed'
            ? 'failed'
            : effectiveState === 'cancelled'
              ? 'cancelled'
              : 'running'
      const task: DownloadTaskFile = {
        id: this.taskId,
        name: this.label ?? this.taskId,
        status,
        progress: rounded / 100,
        updatedAt: Date.now(),
      }
      if (spd) task.speed = spd
      if (eta) task.eta = eta
      try {
        fs.writeFileSync(this.downloadProgressFile, JSON.stringify(task, null, 2), 'utf-8')
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 标记完成 */
  done(msg = '下载完成'): void {
    this.report(100, msg, undefined, undefined, 'done')
  }

  /** 标记失败 */
  fail(msg: string): void {
    const pct = this.lastPct >= 0 ? this.lastPct : 0
    this.report(pct, `失败: ${msg}`, undefined, undefined, 'failed')
  }

  /** 标记取消（AbortSignal 触发时使用，与「失败」区分开） */
  cancel(msg = '已取消'): void {
    const pct = this.lastPct >= 0 ? this.lastPct : 0
    this.report(pct, msg, undefined, undefined, 'cancelled')
  }

  /**
   * 删除本任务的两条进度文件。
   *
   * 刻意**不**在下载结束时自动调用：面板依赖这些文件渲染「已完成 / 失败」回执，
   * 立刻删除会让回执永远看不到（`readDownloadStatus` 与 dsh-task-progress 都是
   * 按文件扫描的）。它是给「明确想清理磁盘」的调用方准备的显式接口。
   */
  cleanup(): void {
    if (this.taskProgressFile) {
      try {
        fs.unlinkSync(this.taskProgressFile)
      } catch {
        /* 忽略 */
      }
    }
    if (this.downloadProgressFile) {
      try {
        fs.unlinkSync(this.downloadProgressFile)
      } catch {
        /* 忽略 */
      }
    }
  }
}

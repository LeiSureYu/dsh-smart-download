/**
 * 进度上报：同时写两条轨道，兼容两个进度插件。
 *
 * 轨道一：dsh-task-progress 的 JSONL 格式
 *   路径：$DSH_PROGRESS_DIR/<taskId>.jsonl
 *   每行一个 JSON 对象，append-only，UI 只读末尾 256KiB。
 *
 * 轨道二：dsh-download-progress 的任务文件格式
 *   路径：$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json 或
 *         ~/.dsh/downloads/tasks/<taskId>.json
 *   整体覆盖写，每个任务一个文件。
 *
 * 两条轨道任一目录不可写都不报错，插件始终可独立运行。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ProgressRecord } from './types.js'

/** 从环境变量或默认位置解析任务进度目录（轨道一） */
function resolveTaskProgressDir(): string {
  if (process.env.DSH_PROGRESS_DIR) return process.env.DSH_PROGRESS_DIR
  return path.join(process.cwd(), '.dsh-progress', 'default')
}

/** 从环境变量或默认位置解析下载进度目录（轨道二） */
function resolveDownloadProgressDir(): string {
  if (process.env.DSH_DOWNLOAD_PROGRESS_DIR) {
    return process.env.DSH_DOWNLOAD_PROGRESS_DIR
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
  return path.join(home, '.dsh', 'downloads', 'tasks')
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

/** 轨道二任务文件的运行态结构（dsh-download-progress 格式） */
interface DownloadTaskFile {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: number
  speed?: string
  eta?: string
  updatedAt: number
}

export class ProgressReporter {
  private readonly taskId: string
  private taskProgressFile: string | null = null
  private downloadProgressFile: string | null = null
  private lastPct = -1

  constructor(taskId: string) {
    this.taskId = taskId

    const taskDir = ensureDir(resolveTaskProgressDir())
    if (taskDir) {
      this.taskProgressFile = path.join(taskDir, `${taskId}.jsonl`)
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
   */
  report(pct: number, msg: string, spd?: string, eta?: string): void {
    const rounded = Math.max(0, Math.min(100, Math.round(pct)))

    // 终态判定：完成 / 失败需要穿透 pct 去重
    const isTerminal = msg.includes('完成') || msg.includes('失败')
    // 去重：pct 没变且不是终态时跳过
    if (rounded === this.lastPct && !isTerminal) return
    this.lastPct = rounded

    // 轨道一：JSONL append
    if (this.taskProgressFile) {
      const rec: ProgressRecord = {
        v: 1,
        task: this.taskId,
        pct: rounded,
        msg,
      }
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
      const task: DownloadTaskFile = {
        id: this.taskId,
        name: this.taskId,
        status: rounded >= 100 ? 'completed' : 'running',
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
    this.report(100, msg)
  }

  /** 标记失败 */
  fail(msg: string): void {
    const pct = this.lastPct >= 0 ? this.lastPct : 0
    this.report(pct, `失败: ${msg}`)
  }

  /** 清理进度文件（可选） */
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

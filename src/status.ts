/**
 * download_status：读取本插件写下的进度文件，给出任务快照。
 *
 * 只读两条既有轨道（与 ProgressReporter 写的目录完全一致）：
 * - 轨道一：$DSH_PROGRESS_DIR/<taskId>.jsonl，缺省
 *           <session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl
 *           （dsh-task-progress 格式，append-only）
 * - 轨道二：$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json 或
 *           <DSH_HOME>/downloads/tasks/<taskId>.json（本插件自有格式，整体覆盖写）
 *
 * 设计约束：
 * - 纯只读，绝不写文件、绝不联网；
 * - 任何读取失败（目录不存在 / 权限 / 内容损坏）都退化为“该任务不出现在结果里”，
 *   整个调用仍然成功返回，只是任务列表更短；
 * - 任务按 updatedAt 倒序，最新的排在最前。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  resolveDownloadProgressDir,
  resolveTaskProgressDir,
} from './progress.js'
import type { ProgressSession } from './progress.js'
import type { ProgressRecord } from './types.js'

/** 单个任务的进度快照 */
export interface TaskStatus {
  /** 任务 ID */
  id: string
  /**
   * 人类可读的任务名（通常是输出文件名），来自进度记录的 `name` 字段。
   * 老版本进度文件没有该字段时为 `''`，调用方需自行回退到 id。
   */
  name: string
  /** 进度百分比 0-100 的整数 */
  pct: number
  /** 最近一条状态说明 */
  msg: string
  /** 任务状态；`cancelled` 只在进度记录显式声明 `state: 'cancelled'` 时出现 */
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** 速度字符串，如 "8.2MB/s" */
  spd: string
  /** 剩余时间字符串，如 "4m51s" */
  eta: string
  /** 最近更新时间戳（毫秒） */
  updatedAt: number
}

/** download_status 的返回结构 */
export interface DownloadStatusSnapshot {
  /** 是否读取成功（目录不可读时为 false，tasks 为空数组） */
  ok: boolean
  /** 轨道一目录（JSONL）；无法定位时为 `''`（工具 schema 要求 string） */
  taskDir: string
  /** 轨道二目录（JSON） */
  downloadDir: string
  /** 任务总数（未经 limit 截断） */
  total: number
  /** 任务快照，按 updatedAt 倒序 */
  tasks: TaskStatus[]
}

/** 默认返回条数 */
export const DEFAULT_STATUS_LIMIT = 10

/** 兜底字符串：schema 要求 string 类型，缺省时不能写 undefined */
const EMPTY = ''

/** 只保留受支持的字符串字段，且必须返回 string（不能是 undefined / null） */
function str(value: unknown): string {
  return typeof value === 'string' ? value : EMPTY
}

/** 解析 JSONL 的最后一行有效记录 */
function readLastJsonlLine(file: string): ProgressRecord | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object') return parsed as ProgressRecord
    } catch {
      // 半截行 / 损坏行：继续往上一行找
      continue
    }
  }
  return null
}

/**
 * 判定任务状态。
 *
 * 优先读进度记录里显式的 `state` 字段（dsh-task-progress 的协议字段，
 * `running` / `done` / `failed` / `cancelled`）；老版本进度文件没有该字段，
 * 此时回退到按文案与百分比推断，保证向后兼容。
 */
function statusFrom(pct: number, msg: string, state?: unknown): TaskStatus['status'] {
  if (state === 'done') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'cancelled'
  if (state === 'running') return 'running'
  // 无 state（0.5.0 之前的进度文件）：按文案与百分比兜底
  if (msg.includes('失败')) return 'failed'
  if (msg.includes('完成') || pct >= 100) return 'completed'
  return 'running'
}

/** 收集一个目录下的任务快照（.jsonl 或 .json） */
function collectFromDir(dir: string, ext: '.jsonl' | '.json'): Map<string, TaskStatus> {
  const out = new Map<string, TaskStatus>()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return out
  }

  for (const name of entries) {
    if (!name.endsWith(ext)) continue
    const id = name.slice(0, -ext.length)
    if (!id) continue
    const file = path.join(dir, name)

    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      // 拿不到 mtime 就用 0，仍会排在最末
    }

    if (ext === '.jsonl') {
      const rec = readLastJsonlLine(file)
      if (!rec) continue
      const pct = Number.isFinite(rec.pct) ? Math.max(0, Math.min(100, rec.pct)) : 0
      const msg = str(rec.msg)
      out.set(id, {
        id,
        name: str(rec.name),
        pct,
        msg,
        status: statusFrom(pct, msg, rec.state),
        spd: str(rec.spd),
        eta: str(rec.eta),
        updatedAt: mtimeMs,
      })
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const rec = parsed as Record<string, unknown>
    const rawProgress = Number(rec.progress)
    const pct = Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(100, Math.round(rawProgress * 100)))
      : 0
    const statusRaw = rec.status
    const status: TaskStatus['status'] =
      statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'cancelled'
        ? statusRaw
        : 'running'
    const updatedRaw = Number(rec.updatedAt)
    out.set(id, {
      id,
      name: str(rec.name),
      pct,
      // 轨道二没有独立的状态文案，沿用旧行为用任务名兜底
      msg: str(rec.name),
      status,
      spd: str(rec.speed),
      eta: str(rec.eta),
      updatedAt: Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : mtimeMs,
    })
  }

  return out
}

/**
 * 读取下载任务进度快照。
 *
 * 只做只读扫描；两条轨道任一不可用都跳过，整体仍返回 ok=true（只要扫到任意任务）。
 *
 * @param limit 最多返回多少个任务，默认 10
 * @param taskId 指定任务 ID 时只返回该任务
 * @param session 当前会话；用于定位轨道一的目录（缺省时轨道一目录为 null）
 */
export function readDownloadStatus(
  limit: number = DEFAULT_STATUS_LIMIT,
  taskId?: string,
  session?: ProgressSession,
): DownloadStatusSnapshot {
  const taskDir = resolveTaskProgressDir(session)
  const downloadDir = resolveDownloadProgressDir()

  const merged = new Map<string, TaskStatus>()
  // 先铺轨道二（JSON，含明确的 status/updatedAt），再用轨道一（JSONL，含 msg/spd/eta）覆盖补充
  for (const [id, task] of collectFromDir(downloadDir, '.json')) merged.set(id, task)
  if (taskDir) {
    for (const [id, task] of collectFromDir(taskDir, '.jsonl')) {
      const existing = merged.get(id)
      // 轨道一的 name 可能为空（老版本进度文件），此时保留轨道二给出的名字
      merged.set(
        id,
        existing ? { ...existing, ...task, name: task.name || existing.name } : task,
      )
    }
  }

  let tasks = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  if (taskId) tasks = tasks.filter((t) => t.id === taskId)

  const total = tasks.length
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_STATUS_LIMIT
  tasks = tasks.slice(0, cap)

  // taskDir 可能是 null（没有会话上下文且未设 DSH_PROGRESS_DIR）；schema 要求
  // string，因此统一收敛成空串，避免 download_status 因类型不合法而报错。
  return { ok: true, taskDir: taskDir ?? '', downloadDir, total, tasks }
}

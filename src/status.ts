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
  /**
   * 批次 ID（1.3.0 新增）。同一次 `smart_download` 调用产生的条目共享同一个值，
   * 读取端据此把散点还原成「一次调用」。
   *
   * 老进度文件没有该字段时收敛成**空串**，而不是让整条记录读不出来：升级前的
   * 历史记录必须照常可读，这也是「可选字段」这条硬回归项的落点。空串同时是
   * schema 允许的值（`type: string`），不会让 download_status 的返回校验失败。
   */
  batch: string
  /**
   * 输出文件的绝对路径（1.4.0 新增），来自记录的 `outPath`。
   *
   * 老记录没有该字段时收敛成**空串**（与 `batch` 完全同一套手法）：1.4.0 之前
   * 写下的记录必须照常可读，面板据此把「在文件管理器中显示」与「删除本地文件」
   * 置灰，只留下「删除记录」。空串同时是 schema 允许的值（`type: string`）。
   */
  outPath: string
  /**
   * 记录里的字节数（1.4.0 新增）；`0` 表示**没有记录**（不是「零字节文件」）。
   *
   * 为什么用 0 而不是可选字段：`download_status` 的 tasks 项是
   * `additionalProperties: false`，字段清单要么逐个声明、要么整个不写；这里照
   * `batch` 的先例声明成必填并给哨兵值，读取端（管理端点）把 0 当作「无法核对
   * 尺寸」——那只是少一道核对，不会让它更宽松地删东西。
   */
  size: number
  /** 记录里的 mtime（毫秒，1.4.0 新增）；`0` 表示没有记录。 */
  fileMtimeMs: number
  /** 最近更新时间戳（毫秒） */
  updatedAt: number
}

/** download_status 的返回结构 */
export interface DownloadStatusSnapshot {
  /**
   * 是否至少有一个目录被成功扫描。
   *
   * 语义收紧（1.3.0）：此前恒为 `true`，于是「目录读不到」与「确实没有任务」
   * 在返回结构里**完全同形** —— 一次读不到任何东西的查询看起来和一次干净的
   * 空查询一模一样。现在只有**两个目录都读不到**时才为 `false`。
   *
   * 为什么不是「任一目录读不到就 false」：没有会话上下文时轨道一目录本就
   * 定位不到（`resolveTaskProgressDir` 返回 `null`），那是**正常的**
   * 单轨模式而不是故障，报 false 会把正常调用判成失败。
   */
  ok: boolean
  /** 轨道一目录（JSONL）；无法定位时为 `''`（工具 schema 要求 string） */
  taskDir: string
  /** 轨道二目录（JSON） */
  downloadDir: string
  /** 任务总数（未经 limit 截断） */
  total: number
  /** 任务快照，按 updatedAt 倒序 */
  tasks: TaskStatus[]
  /**
   * 扫描失败的目录路径列表；**只在真的有目录读不到时出现**。
   *
   * 为什么做成可选字段而不是恒在的空数组：`tasks: []` 本身无法区分
   * 「读不到」与「确实没有任务」，而两者对用户的意义完全相反 —— 前者是插件
   * 出问题，后者是一切正常。字段的**存在与否**就是那个区分信号，所以正常路径
   * 上它必须整个不出现（也让老读取端拿到逐字段相同的结构）。
   */
  scanFailedDirs?: string[]
}

/** 默认返回条数 */
export const DEFAULT_STATUS_LIMIT = 10

/**
 * 上限条数。
 *
 * 与 `DEFAULT_STATUS_LIMIT` 放在一起，是因为两者原本分散在两个文件里
 * （默认值在 `status.ts`，「夹到 50」硬编码在 `rpc.ts` 的 `readPayload`），
 * 改了一个忘了另一个就会出现「RPC 认为上限是 50、工具认为不是」的偏差。
 * 两个调用方（`readPayload` 与 `readDownloadStatus`）现在共用这一个常量。
 */
export const MAX_STATUS_LIMIT = 50

/** 兜底字符串：schema 要求 string 类型，缺省时不能写 undefined */
const EMPTY = ''

/** 只保留受支持的字符串字段，且必须返回 string（不能是 undefined / null） */
function str(value: unknown): string {
  return typeof value === 'string' ? value : EMPTY
}

/**
 * 只保留**正**的有限数字，其余收敛成 0（0 = 没有记录）。
 *
 * 刻意**不做字符串强制转换**（`Number(value)`）：与旁边的 `str()` 保持同一种
 * 严格口径。`size: "12"` 这种类型错乱的记录只会来自手改或损坏，而尺寸正是删除
 * 前的核对依据 —— 「几乎对」的字符串被悄悄转成 12 会让那道核对看起来通过。
 *
 * 与 `str()` 同一个理由：`download_status` 的 tasks 项是
 * `additionalProperties: false`，字段的**类型**必须在任何输入下都成立。
 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
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

/**
 * 收集一个目录下的任务快照（.jsonl 或 .json）。
 *
 * @param dir 待扫描目录
 * @param ext 该目录下的进度文件后缀
 * @param onScanError 目录读不到时回调（收到目录路径）。**必须由调用方透出**：
 *   此前这里静默 `return out`，于是「权限不足 / 路径不存在 / 磁盘故障」与
 *   「目录里确实没有任务」产出同一个空 Map —— 一次失败的查询看起来和一次干净的
 *   空查询完全一样，正是本项目反复出问题的静默失败形态。
 */
function collectFromDir(
  dir: string,
  ext: '.jsonl' | '.json',
  onScanError?: (dir: string) => void,
): Map<string, TaskStatus> {
  const out = new Map<string, TaskStatus>()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    onScanError?.(dir)
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
        // 老记录没有 batch：`str()` 收敛成空串，解析结果与 1.2.0 逐字段相同
        batch: str(rec.batch),
        // 1.4.0：老记录没有 outPath / size / fileMtimeMs 时分别收敛成 '' / 0 / 0，
        // 与 1.3.0 的记录逐字段相同（这条硬回归项的落点）
        outPath: str(rec.outPath),
        size: num(rec.size),
        fileMtimeMs: num(rec.fileMtimeMs),
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
      // 与轨道一同理：老任务文件没有 batch 时为 ''
      batch: str(rec.batch),
      // 1.4.0：轨道二的输出路径与产物指纹，缺失时收敛（老任务文件逐字段不受影响）
      outPath: str(rec.outPath),
      size: num(rec.size),
      fileMtimeMs: num(rec.fileMtimeMs),
      updatedAt: Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : mtimeMs,
    })
  }

  return out
}

/**
 * 读取下载任务进度快照。
 *
 * 只做只读扫描；两条轨道任一不可用都跳过，**但跳过不再静默** ——
 * 读不到的目录会被收进 `scanFailedDirs`，两个都读不到时 `ok` 为 `false`。
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

  const scanFailedDirs: string[] = []
  const noteScanError = (dir: string): void => {
    scanFailedDirs.push(dir)
  }

  const merged = new Map<string, TaskStatus>()
  // 先铺轨道二（JSON，含明确的 status/updatedAt），再用轨道一（JSONL，含 msg/spd/eta）覆盖补充
  for (const [id, task] of collectFromDir(downloadDir, '.json', noteScanError)) {
    merged.set(id, task)
  }
  if (taskDir) {
    for (const [id, task] of collectFromDir(taskDir, '.jsonl', noteScanError)) {
      const existing = merged.get(id)
      // 轨道一的 name / batch 可能为空（老版本进度文件没有这些字段），此时保留
      // 轨道二给出的值：与 name 完全同一个理由 —— 让「老文件 + 新文件」合并后
      // 仍然拿得到较新的那个轨道已经写下来的信息。
      // 1.4.0 的 outPath / size / fileMtimeMs 同理：任一轨道缺就在另一条里找，
      // 否则「轨道一先写、轨道二还没写」的瞬间会让管理端点误判成「没记录路径」。
      merged.set(
        id,
        existing
          ? {
              ...existing,
              ...task,
              name: task.name || existing.name,
              batch: task.batch || existing.batch,
              outPath: task.outPath || existing.outPath,
              size: task.size || existing.size,
              fileMtimeMs: task.fileMtimeMs || existing.fileMtimeMs,
            }
          : task,
      )
    }
  }

  let tasks = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  if (taskId) tasks = tasks.filter((t) => t.id === taskId)

  const total = tasks.length
  const cap =
    Number.isFinite(limit) && limit > 0
      ? Math.min(MAX_STATUS_LIMIT, Math.floor(limit))
      : DEFAULT_STATUS_LIMIT
  tasks = tasks.slice(0, cap)

  // 只有「两个目录都读不到」才判失败：那时调用方拿到的空列表是**无信息**的，
  // 必须能与「扫过了、确实没有任务」区分开。没有会话上下文时 taskDir 为 null
  // （轨道一压根不参与扫描），因此不构成失败 —— 那是正常的单轨模式。
  const scannedDirs = taskDir ? 2 : 1
  const ok = scanFailedDirs.length < scannedDirs

  // taskDir 可能是 null（没有会话上下文且未设 DSH_PROGRESS_DIR）；schema 要求
  // string，因此统一收敛成空串，避免 download_status 因类型不合法而报错。
  // scanFailedDirs 只在有失败时出现：正常路径上返回结构与收紧前逐字段相同。
  return {
    ok,
    taskDir: taskDir ?? '',
    downloadDir,
    total,
    tasks,
    ...(scanFailedDirs.length > 0 ? { scanFailedDirs } : {}),
  }
}

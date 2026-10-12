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
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ProgressRecord, ProgressState } from './types.js'

/** dsh-task-progress 的目录名规则（对应其 `SESSION_SEGMENT_RE`）。 */
const SESSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/**
 * 建一个「会在 ms 后自行结束」的计时器，返回它的 promise 与取消函数。
 *
 * 为什么不用 `node:timers/promises` 的 `setTimeout`（1.0.0 修正）：
 * 它建的计时器**不会 unref**。用它做 `awaitFlush` 的超时哨兵时，即使写盘早就
 * 完成、`Promise.race` 立刻返回，那个还没到点的计时器仍然挂在事件循环上 ——
 * 实测（`node -e` 打印 exit 时间）进程会一直活到超时结束：
 *
 *   race resolved in 0 ms, winner is timeout? false
 *   process exit after 2003 ms
 *
 * 也就是说 CLI 下每次下载结束都要多卡约 2 秒才退出。这里改成原生 `setTimeout`
 * 并 `unref()`：等待期间不阻止进程退出；正常路径上再用 `cancel()` 把句柄清掉，
 * 返回后不留残留计时器（`test/progress.test.ts` 断言句柄数回到基线）。
 */
function timeoutAfter(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
    },
  }
}

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
  /**
   * 批次 ID，可选（1.3.0 新增）：与轨道一同名同值，见 `ProgressRecord.batch`。
   * 两条轨道都写，读取端无论走哪条都能还原「这几次是同一次调用」。
   */
  batch?: string
  /** 输出文件绝对路径，可选（1.4.0 新增）；见 `ProgressRecord.outPath`。 */
  outPath?: string
  /** 终态时的字节数，可选（1.4.0 新增）；见 `ProgressRecord.size`。 */
  size?: number
  /** 终态时的 mtime（毫秒），可选（1.4.0 新增）；见 `ProgressRecord.fileMtimeMs`。 */
  fileMtimeMs?: number
}

/**
 * 任务 ID 的白名单：只允许文件名安全字符，且必须以字母/数字开头。
 *
 * 为什么需要它：`taskId` 会被拼进文件名（`<taskId>.json` / `<taskId>.jsonl`）。
 * 一个带 `/`、`\`、`..` 或驱动器号的 id 能让 `path.join` 指到记录目录之外 ——
 * 删除记录与删除本地文件都是不可逆操作，那里必须先过这道闸。这里与
 * 轨道一目录名的规则（`SESSION_SEGMENT_RE`）一致：都是「能被当作单个文件名」。
 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 判定一个 taskId 是否可以安全地拼进文件名。 */
export function isSafeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && TASK_ID_RE.test(taskId)
}

/**
 * 本插件为某个 taskId 写的两条进度文件路径（轨道一 JSONL + 轨道二 JSON）。
 *
 * 只返回**确实存在且是普通文件**的那些（`lstat`，不跟进符号链接）：调用方
 * 拿到的路径要么能删，要么干脆不在列表里，不需要再各自判一遍。
 *
 * 为什么用 `lstat` 而不是 `stat`：符号链接要按链接本身判断。跟进目标会让
 * 「删除本插件记录的进度文件」变成「删除链接指向的任意文件」。
 *
 * @param taskId 任务 ID；不在白名单内时返回空数组（不抛错）
 * @param session 当前会话；用于定位轨道一目录，缺省时只考虑轨道二
 */
export function taskRecordFiles(taskId: string, session?: ProgressSession): string[] {
  if (!isSafeTaskId(taskId)) return []
  const candidates: string[] = []
  const dlDir = resolveDownloadProgressDir()
  candidates.push(path.join(dlDir, `${taskId}.json`))
  const taskDir = resolveTaskProgressDir(session)
  if (taskDir) candidates.push(path.join(taskDir, `${taskId}.jsonl`))

  const found: string[] = []
  for (const file of candidates) {
    try {
      if (fs.lstatSync(file).isFile()) found.push(file)
    } catch {
      // 不存在 / 读不到：不进列表（调用方据此如实报告「没删到」）
    }
  }
  return found
}

/**
 * 删除本插件为某个 taskId 写的两条进度文件，返回**真正删掉**的路径。
 *
 * 与 `ProgressReporter.cleanup()` 的区别：那个删的是「这个实例自己刚写的两条」，
 * 路径在构造时就定了；这个按 `taskId` 重新解析路径，供管理端点（`smartdl.manage`
 * 的 `forget` / `delete`）在没有 reporter 实例的情况下使用。两者共用同一套
 * 目录规则（`resolveDownloadProgressDir` / `resolveTaskProgressDir`）。
 *
 * 删不掉的（占用 / 权限）如实**不进**返回列表：调用方必须能区分「删了」与
 * 「以为删了」。
 */
export function removeTaskRecords(taskId: string, session?: ProgressSession): string[] {
  const removed: string[] = []
  for (const file of taskRecordFiles(taskId, session)) {
    try {
      fs.unlinkSync(file)
      removed.push(file)
    } catch {
      // 删不掉就跳过：一个文件失败不该让整次操作失败，但也不能计入成功
    }
  }
  return removed
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
  /**
   * 批次 ID：同一次调用（单条目或批量）里所有条目共用。
   * 只做分组标签，任何执行/并发决策都不看它。
   */
  private readonly batch: string | undefined
  /**
   * 输出文件的**绝对路径**（1.4.0 新增），缺省为 undefined。
   *
   * 只有绝对路径才会被记录：删除规则（见 rpc.ts）要求绝对路径，记一个相对路径
   * 只会让管理端点拿到一个必然被拒绝的值 —— 那不如不记，让 `inspect` 如实报
   * `unknown`（UI 据此只允许「删除记录」）。
   */
  private readonly outPath: string | undefined
  private taskProgressFile: string | null = null
  private downloadProgressFile: string | null = null
  private lastPct = -1
  /** 上一次写入的去重键；内容完全一致时不重复落盘 */
  private lastKey = ''
  /**
   * 待落盘的记录队列。
   *
   * 为什么不再同步写盘：`report()` 挂在 aria2 每秒一次的摘要回调与 curl 的进度
   * 行回调上，`appendFileSync` / `writeFileSync` 会把整个事件循环卡住一次磁盘
   * I/O —— 下载越快、回调越密，卡得越久，而这些卡顿与下载本身毫无关系。
   * 改为「微任务批量落盘」：同一 tick 内的多条记录一次写出，顺序保持不变，
   * 写盘本身交给 `fs.promises`，不再阻塞。
   *
   * 注意不能像「只保留最后一条」那样合并：轨道一是 append-only 的 JSONL，
   * 读取端（`dsh-task-progress`）按最后一行判定状态，但进度历史本身也有意义；
   * 压掉中间记录会让「10% → 20% → 30%」变成只有 30%。
   */
  private pending: ProgressRecord[] = []
  private flushScheduled = false
  /**
   * 终态必须落盘：调用方在 `done()` / `fail()` / `cancel()` 之后通常立刻返回，
   * 若这条记录还留在 `pending` 里，面板会永远停在「下载中」。
   * `awaitFlush()` 供调用点等待落盘完成。
   */
  private pendingWrite: Promise<void> = Promise.resolve()

  /**
   * @param taskId 任务 ID，用于文件名与状态查询
   * @param label 人类可读的任务名（通常是输出文件名），会写入两条轨道供 UI 展示
   * @param session 当前会话；用于把轨道一写进该会话的进度目录，缺省则不写轨道一
   * @param batch 批次 ID，可选；同一次调用产生的所有条目共用一个值。
   *   缺省时不写该字段（老行为逐字节相同），而不是写一个空串 —— 空串会占着
   *   字段位，让读取端以为「有批次但不知道是哪批」。
   * @param outPath 输出文件的绝对路径，可选（1.4.0 新增）。调用方**必须**传
   *   `path.resolve(...)` 的结果：子进程没有指定 cwd，相对路径的含义取决于
   *   进程 cwd，记下来也无法安全地用于删除。相对路径会被忽略（不记录）。
   */
  constructor(
    taskId: string,
    label?: string,
    session?: ProgressSession,
    batch?: string,
    outPath?: string,
  ) {
    this.taskId = taskId
    this.label = label
    this.batch = batch
    this.outPath =
      typeof outPath === 'string' && outPath.length > 0 && path.isAbsolute(outPath)
        ? outPath
        : undefined

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
    // 批次 ID 只在真的有时才写：缺省路径上轨道一记录与 1.2.0 逐字节相同
    if (this.batch) rec.batch = this.batch
    // 输出路径同理：只在调用方给了绝对路径时写，老记录与缺省路径逐字节不受影响
    if (this.outPath) rec.outPath = this.outPath
    // 尺寸与 mtime **只在终态那一条**记录上写：进行中的尺寸是中间值，写下来会
    // 让「文件是否还是当初那一个」的判定拿着一个永远对不上的数字。
    // 只 stat 一次（终态一条记录一次系统调用），且必须是普通文件 —— 目录/链接
    // 不该被当作「我们下载出来的产物」。
    if (effectiveState !== 'running' && this.outPath) {
      try {
        const st = fs.lstatSync(this.outPath)
        if (st.isFile()) {
          rec.size = st.size
          rec.fileMtimeMs = st.mtimeMs
        }
      } catch {
        // 已经不在（被移走/删掉）就只记路径：管理端点据此报 missing，
        // 而不是让这里抛错把下载收尾流程带崩。
      }
    }

    this.pending.push(rec)
    this.scheduleFlush()
  }

  /** 安排一次异步落盘（同 tick 合并） */
  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      const batch = this.pending
      this.pending = []
      if (batch.length > 0) void this.writeNow(batch)
    })
  }

  /** 真正落盘（异步，不阻塞事件循环），保持记录顺序 */
  private writeNow(batch: ProgressRecord[]): Promise<void> {
    const jobs: Array<Promise<unknown>> = []

    // 轨道一：JSONL append
    if (this.taskProgressFile) {
      // 一次拼接后单次 append：多条记录仍按原顺序写在同一文件里
      const chunk = batch.map((rec) => JSON.stringify(rec) + '\n').join('')
      const file = this.taskProgressFile
      jobs.push(fsp.appendFile(file, chunk, 'utf-8').catch(() => {}))
    }

    // 轨道二：JSON 覆盖写
    if (this.downloadProgressFile) {
      // 轨道二是整体覆盖写，只有最后一条有意义
      const rec = batch[batch.length - 1]!
      const effectiveState = rec.state ?? 'running'
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
        progress: rec.pct / 100,
        updatedAt: Date.now(),
      }
      if (rec.spd) task.speed = rec.spd
      if (rec.eta) task.eta = rec.eta
      // 与轨道一同理：缺省不写，老读取端拿到的 JSON 与 1.2.0 逐字节相同
      if (this.batch) task.batch = this.batch
      // 输出路径 / 尺寸 / mtime 同样从本批最后一条记录透传，两条轨道保持一致：
      // 任一轨道单独存活时（会话缺失、或只写了轨道二）都还能定位到产物。
      if (rec.outPath) task.outPath = rec.outPath
      if (rec.size !== undefined) task.size = rec.size
      if (rec.fileMtimeMs !== undefined) task.fileMtimeMs = rec.fileMtimeMs
      const file = this.downloadProgressFile
      jobs.push(fsp.writeFile(file, JSON.stringify(task, null, 2), 'utf-8').catch(() => {}))
    }

    const done = Promise.all(jobs).then(
      () => undefined,
      () => undefined,
    )
    // 串行化：后一次写入必须发生在前一次之后，避免 append 顺序错乱
    this.pendingWrite = this.pendingWrite.then(() => done)
    return this.pendingWrite
  }

  /**
   * 等待所有已排队的写入落盘。
   *
   * 终态（`done` / `fail` / `cancel`）之后调用方通常立刻 return，此时必须等一下，
   * 否则「已完成」这条记录还在队列里，面板会永远停在「下载中」。
   * 带 2 秒上限：磁盘异常时不至于把工具调用挂死。
   *
   * 超时计时器必须 unref 且可取消（1.0.0 修正）：0.9.0 之后用的
   * `node:timers/promises` 超时哨兵不会 unref，导致每次等待都要把事件循环多留住
   * 整个超时时长（CLI 下约 2 秒才退出）。现在见 `timeoutAfter()`。
   *
   * 超时不许静默（1.0.0 修正）：0.9.0 之前这里超时后直接返回，既没有日志也没有
   * 异常 —— 「进度没写进去」这件事在用户侧只表现为面板卡住，排查不到原因。
   * 现在超时会发出 `process.emitWarning`：仍不阻断调用（磁盘满时让工具调用挂死
   * 更糟），但留下一条可搜索的线索。
   *
   * @param timeoutMs 上限毫秒数，默认 2000；只有测试需要改，正常调用不传
   */
  async awaitFlush(timeoutMs = 2000): Promise<void> {
    // 若还有未 flush 的 pending（微任务尚未跑），先手动补一次
    if (this.pending.length > 0) {
      const batch = this.pending
      this.pending = []
      this.flushScheduled = false
      await this.writeNow(batch)
    }
    // 用哨兵对象而非 Promise.race 的返回值判断是谁先完成：超时必须能被识别出来。
    const TIMEOUT = Symbol('timeout')
    const timeout = timeoutAfter(timeoutMs)
    let winner: symbol | void
    try {
      winner = await Promise.race([this.pendingWrite, timeout.promise.then(() => TIMEOUT)])
    } finally {
      // 正常路径（写盘先完成）与超时路径都要清掉句柄，返回后不留计时器。
      timeout.cancel()
    }
    if (winner === TIMEOUT) {
      process.emitWarning(
        `dsh-smart-dl 进度写盘超过 ${timeoutMs}ms 未完成（任务 ${this.taskId}），` +
          '面板与 download_status 可能看不到最新状态',
        { code: 'DSH_SMARTDL_PROGRESS_FLUSH_TIMEOUT' },
      )
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

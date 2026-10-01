import type { ProgressState } from './types.js';
/** 当前会话的定位信息，来自 `exec.agent.session.header`。 */
export interface ProgressSession {
    /** 会话 ID，同时也是进度目录名 */
    id?: string;
    /** 会话创建时的工作目录，进度根目录 */
    cwd?: string;
}
/**
 * 解析 DSH home 目录。
 *
 * 优先级与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 保持一致：
 * 显式配置（本插件不读配置，故略过） → `$DSH_HOME`（空 / 纯空白视为未设置）
 * → `~/.dsh`。
 */
export declare function resolveDshHome(): string;
/**
 * 解析轨道一的目录。
 *
 * 优先级：`$DSH_PROGRESS_DIR`（显式覆盖，测试与特殊部署用） → 当前会话目录
 * → `null`（表示「没有可靠的落点，不写轨道一」）。
 *
 * @param session 当前会话；缺省或字段不合法时返回 null
 */
export declare function resolveTaskProgressDir(session?: ProgressSession): string | null;
/**
 * 解析轨道二（任务快照 JSON）的目录。
 * 设置了 `$DSH_DOWNLOAD_PROGRESS_DIR` 时优先使用，否则为 `<DSH_HOME>/downloads/tasks`。
 */
export declare function resolveDownloadProgressDir(): string;
export declare class ProgressReporter {
    private readonly taskId;
    private readonly label;
    private taskProgressFile;
    private downloadProgressFile;
    private lastPct;
    /** 上一次写入的去重键；内容完全一致时不重复落盘 */
    private lastKey;
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
    private pending;
    private flushScheduled;
    /**
     * 终态必须落盘：调用方在 `done()` / `fail()` / `cancel()` 之后通常立刻返回，
     * 若这条记录还留在 `pending` 里，面板会永远停在「下载中」。
     * `awaitFlush()` 供调用点等待落盘完成。
     */
    private pendingWrite;
    /**
     * @param taskId 任务 ID，用于文件名与状态查询
     * @param label 人类可读的任务名（通常是输出文件名），会写入两条轨道供 UI 展示
     * @param session 当前会话；用于把轨道一写进该会话的进度目录，缺省则不写轨道一
     */
    constructor(taskId: string, label?: string, session?: ProgressSession);
    /**
     * 上报进度。
     * @param pct 0-100 的进度（会四舍五入为整数）
     * @param msg 简短说明，如“下载中”、“探测中”
     * @param spd 速度字符串，如 "8.2MB/s"
     * @param eta 剩余时间字符串，如 "4m51s"
     * @param state 任务状态，缺省按 `running`；终态记录必须显式传入
     */
    report(pct: number, msg: string, spd?: string, eta?: string, state?: ProgressState): void;
    /** 安排一次异步落盘（同 tick 合并） */
    private scheduleFlush;
    /** 真正落盘（异步，不阻塞事件循环），保持记录顺序 */
    private writeNow;
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
    awaitFlush(timeoutMs?: number): Promise<void>;
    /** 标记完成 */
    done(msg?: string): void;
    /** 标记失败 */
    fail(msg: string): void;
    /** 标记取消（AbortSignal 触发时使用，与「失败」区分开） */
    cancel(msg?: string): void;
    /**
     * 删除本任务的两条进度文件。
     *
     * 刻意**不**在下载结束时自动调用：面板依赖这些文件渲染「已完成 / 失败」回执，
     * 立刻删除会让回执永远看不到（`readDownloadStatus` 与 dsh-task-progress 都是
     * 按文件扫描的）。它是给「明确想清理磁盘」的调用方准备的显式接口。
     */
    cleanup(): void;
}

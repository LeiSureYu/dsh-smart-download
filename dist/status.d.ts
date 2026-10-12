import type { ProgressSession } from './progress.js';
/** 单个任务的进度快照 */
export interface TaskStatus {
    /** 任务 ID */
    id: string;
    /**
     * 人类可读的任务名（通常是输出文件名），来自进度记录的 `name` 字段。
     * 老版本进度文件没有该字段时为 `''`，调用方需自行回退到 id。
     */
    name: string;
    /** 进度百分比 0-100 的整数 */
    pct: number;
    /** 最近一条状态说明 */
    msg: string;
    /** 任务状态；`cancelled` 只在进度记录显式声明 `state: 'cancelled'` 时出现 */
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    /** 速度字符串，如 "8.2MB/s" */
    spd: string;
    /** 剩余时间字符串，如 "4m51s" */
    eta: string;
    /**
     * 批次 ID（1.3.0 新增）。同一次 `smart_download` 调用产生的条目共享同一个值，
     * 读取端据此把散点还原成「一次调用」。
     *
     * 老进度文件没有该字段时收敛成**空串**，而不是让整条记录读不出来：升级前的
     * 历史记录必须照常可读，这也是「可选字段」这条硬回归项的落点。空串同时是
     * schema 允许的值（`type: string`），不会让 download_status 的返回校验失败。
     */
    batch: string;
    /** 最近更新时间戳（毫秒） */
    updatedAt: number;
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
    ok: boolean;
    /** 轨道一目录（JSONL）；无法定位时为 `''`（工具 schema 要求 string） */
    taskDir: string;
    /** 轨道二目录（JSON） */
    downloadDir: string;
    /** 任务总数（未经 limit 截断） */
    total: number;
    /** 任务快照，按 updatedAt 倒序 */
    tasks: TaskStatus[];
    /**
     * 扫描失败的目录路径列表；**只在真的有目录读不到时出现**。
     *
     * 为什么做成可选字段而不是恒在的空数组：`tasks: []` 本身无法区分
     * 「读不到」与「确实没有任务」，而两者对用户的意义完全相反 —— 前者是插件
     * 出问题，后者是一切正常。字段的**存在与否**就是那个区分信号，所以正常路径
     * 上它必须整个不出现（也让老读取端拿到逐字段相同的结构）。
     */
    scanFailedDirs?: string[];
}
/** 默认返回条数 */
export declare const DEFAULT_STATUS_LIMIT = 10;
/**
 * 上限条数。
 *
 * 与 `DEFAULT_STATUS_LIMIT` 放在一起，是因为两者原本分散在两个文件里
 * （默认值在 `status.ts`，「夹到 50」硬编码在 `rpc.ts` 的 `readPayload`），
 * 改了一个忘了另一个就会出现「RPC 认为上限是 50、工具认为不是」的偏差。
 * 两个调用方（`readPayload` 与 `readDownloadStatus`）现在共用这一个常量。
 */
export declare const MAX_STATUS_LIMIT = 50;
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
export declare function readDownloadStatus(limit?: number, taskId?: string, session?: ProgressSession): DownloadStatusSnapshot;

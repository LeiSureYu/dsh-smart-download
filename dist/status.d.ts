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
    /** 最近更新时间戳（毫秒） */
    updatedAt: number;
}
/** download_status 的返回结构 */
export interface DownloadStatusSnapshot {
    /** 是否读取成功（目录不可读时为 false，tasks 为空数组） */
    ok: boolean;
    /** 轨道一目录（JSONL）；无法定位时为 `''`（工具 schema 要求 string） */
    taskDir: string;
    /** 轨道二目录（JSON） */
    downloadDir: string;
    /** 任务总数（未经 limit 截断） */
    total: number;
    /** 任务快照，按 updatedAt 倒序 */
    tasks: TaskStatus[];
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
 * 只做只读扫描；两条轨道任一不可用都跳过，整体仍返回 ok=true（只要扫到任意任务）。
 *
 * @param limit 最多返回多少个任务，默认 10
 * @param taskId 指定任务 ID 时只返回该任务
 * @param session 当前会话；用于定位轨道一的目录（缺省时轨道一目录为 null）
 */
export declare function readDownloadStatus(limit?: number, taskId?: string, session?: ProgressSession): DownloadStatusSnapshot;

/** 重试一条任务所需的最小请求信息（不含请求头）。 */
export interface RetryRequest {
    /** 原始下载地址 */
    url: string;
    /**
     * 显式输出路径（绝对路径）。没有显式 output 的条目在这里缺省，
     * 重试时改用记录里的 `outPath`，从而保住 Content-Disposition 推导出的文件名。
     */
    output?: string;
    sha256?: string;
    checksum?: string;
    ifExists?: 'overwrite' | 'skip' | 'rename';
    /** 镜像前缀（含 `auto`） */
    mirror?: string;
    /** 该条目当时的带宽上限（批量里是均分后的份额） */
    maxBandwidthBytes?: number;
    timeoutMs?: number;
    /** 原批次 ID，仅作分组标签 */
    batchId?: string;
}
/** 已登记的一次运行。 */
export interface RunningTask {
    taskId: string;
    controller: AbortController;
    startedAt: number;
    request?: RetryRequest;
}
/** `cancelRunningTask` 的结果。`unknown` 由调用方结合进度记录判定。 */
export type CancelOutcome = 'cancelled' | 'not-running';
/** 重试入口的返回形状（与浏览器端钉死的契约）。 */
export interface RetryStartResult {
    started: boolean;
    taskId: string;
    reason?: 'running' | 'unknown' | 'not-retryable' | 'no-request' | 'unavailable';
    /** 面向用户的补充说明（可选，客户端可以忽略） */
    message?: string;
}
/** 由插件入口注入的重试实现。rpc.ts 不直接 import index.ts（会成环）。 */
export type RetryHandler = (taskId: string, session?: {
    id?: string;
    cwd?: string;
}) => RetryStartResult | Promise<RetryStartResult>;
/**
 * 登记一次运行。
 *
 * @returns 是否登记成功；false 表示已到防御上限（调用方仍可继续下载）
 */
export declare function registerRunningTask(taskId: string, controller: AbortController, request?: RetryRequest): boolean;
/** 注销一次运行（幂等；在 finally 里调用）。 */
export declare function unregisterRunningTask(taskId: string): void;
/** 这一条现在是否真的在跑。 */
export declare function isRunning(taskId: string): boolean;
/**
 * 请求取消一条正在跑的任务。
 *
 * 幂等：重复调用只会再次 abort 同一个 controller（AbortController 的 abort
 * 本身是幂等的）。没登记过时返回 `not-running`，由调用方结合进度记录决定
 * 是「已经结束」还是「根本没这条任务」。
 */
export declare function cancelRunningTask(taskId: string): CancelOutcome;
/** 这个 taskId 是否在本进程里出现过（用于区分 unknown）。 */
export declare function isKnownTask(taskId: string): boolean;
/** 当前运行中的 taskId（诊断 / 测试用）。 */
export declare function runningTaskIds(): string[];
/** 安装重试实现（插件 apply 时调用一次）。 */
export declare function setRetryHandler(handler: RetryHandler | null): void;
/** 读取当前的重试实现。 */
export declare function getRetryHandler(): RetryHandler | null;
/** 清空全部状态（只给测试用）。 */
export declare function resetTaskRegistry(): void;
/**
 * 校验并归一化一条**从磁盘读回**的重试元数据。
 *
 * 进度文件是普通 JSON，用户、备份工具或旧版本都可能把它写成任何形状。这里
 * 只接受确实能重新发起下载的字段，其余一律丢弃；返回 undefined 表示这条记录
 * 没有可用的重试信息（UI 据此提示「无法重试」），而不是拿半个请求去猜。
 *
 * @param raw 记录里的 `request` 字段
 * @param outPath 记录里的 `outPath`，作为缺省输出路径
 */
export declare function parseRetryRequest(raw: unknown, outPath?: string): RetryRequest | undefined;

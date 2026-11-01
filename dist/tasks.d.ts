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
    /** 调用方声明的期望文件大小（字节）；重试时同样参与字节数校验 */
    expectedSize?: number;
    /** 镜像前缀（含 `auto`） */
    mirror?: string;
    /**
     * 调用方显式传入的代理地址（1.7.0）。不是凭证（它本来就是明文配置），
     * 与 mirror 同级落盘：不带上的话，走显式代理的任务重试时会静默变直连。
     * 环境变量派生的代理**不**在这里 —— 重试时按当时的 env 重新解析。
     */
    proxy?: string;
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
 * 暂停专用中止原因（1.8.0）。
 *
 * 为什么用 abort(reason)：暂停与取消是**同一个物理动作**（终止子进程），差别
 * 只在终态落点。`AbortSignal.any` 会把 reason 原样传播给合并信号，
 * `finishAborted`（src/index.ts）据此把终态写成 paused 而不是 cancelled ——
 * 不需要第二条信号通道。哨兵串保持唯一：reason 的其它取值（AbortError /
 * TimeoutError 一类 DOMException）绝不能撞上它。
 */
/**
 * 暂停专用的错误类型（1.8.0）：runBatch 与 RPC 下载路径（1.9.0）据此把
 * 「用户暂停」标成 paused（不是取消也不是失败）。本体放在 tasks.ts 以避免
 * download-rpc.ts → index.ts 的循环依赖。
 */
export declare class DownloadPausedError extends Error {
}
/**
 * 取消专用的错误类型（1.6.0 / 1.9.0 共用）：与暂停同理，取消在面板上是
 * 与「失败」不同的状态。
 */
export declare class DownloadCancelledError extends Error {
}
export declare const PAUSE_ABORT_REASON = "dsh-smart-dl:paused";
/**
 * 请求暂停一条正在跑的任务。
 *
 * 与 cancelRunningTask 是同一个物理动作；差别只在 reason —— 进度终态会写成
 * paused（半包与旁车指纹照常保留，重试/继续时由既有指纹核对兜底）。
 */
export declare function pauseRunningTask(taskId: string): 'paused' | 'not-running';
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

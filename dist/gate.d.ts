/**
 * 进程内连接预算：与批内窗口的推导一致（单条目最高档 × 2）。
 * 见 src/index.ts 的 batchWindow 注释 —— 两者必须是同一个数，因此共用这一处推导。
 */
export declare const CONNECTION_BUDGET: number;
/**
 * 闸门容量 = 同时开跑的条目数上限。
 * 预算 ÷ 单条目可能占用的最高连接数（每条 ≤ 8 连接）→ 最坏情况全局连接数仍是
 * 预算的 16，与 1.3.0 的批量峰值完全相同。
 */
export declare const GATE_CAPACITY: number;
/**
 * FIFO 异步闸门。
 *
 * 为什么自己写而不用现成信号量：依赖面已经刻意很小，而这里需要的语义非常小
 * （容量固定、FIFO 唤醒、release 幂等），几十行就够，且可以精确单测。
 */
export declare class DownloadGate {
    readonly capacity: number;
    private active;
    private readonly waiters;
    constructor(capacity: number);
    /** 当前占用的槽位数（诊断 / 测试用）。 */
    get activeCount(): number;
    /** 正在等待槽位的条目数（诊断 / 测试用）。 */
    get pendingCount(): number;
    /**
     * 获取一个槽位，返回释放函数。
     * 有空闲槽位时立即返回（不经过事件循环，调用方可以直接继续）；满时按先到
     * 先得排队。
     */
    acquire(): Promise<() => void>;
    /** 释放一个槽位；队首有等待者时把槽位**直接转交**（不经过空档期）。 */
    private release;
    /** 清空状态（只给测试用）。 */
    reset(): void;
}
/** 进程级单例：所有条目（前台 / 后台 / 重试）共用的同一个闸门。 */
export declare const downloadGate: DownloadGate;

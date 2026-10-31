/**
 * 全局下载闸门：把「同时开跑的条目数」压在批内并发窗口的同一约束下。
 *
 * 为什么必须有（1.7.0，改动前务必先读）：
 * 「单文件上限压在 8 连接」的既定取舍（src/decision.ts）只约束**一个**子进程；
 * 1.3.0 的批量窗口（批内连接预算 = 单条目最高档 × 2 = 16）只约束**一批**。这两道
 * 约束都在**同一次工具调用**内成立。1.7.0 引入后台模式后，「一次调用」不再等于
 * 「全部在跑的任务」—— 一个后台下载可以与前台批量并存，两条路径各自 16 连接的
 * 峰值就是 32，既定取舍被静默击穿。
 *
 * 解法是把这个上限从「批内」升级为「进程内」：所有条目（单条目、批量条目、后台
 * 任务、重试）开工前都必须先拿到一个闸门槽位。容量从与批量窗口**同一个公式**推导
 * （见 GATE_CAPACITY），因此「没有后台任务时行为与 1.6.0 完全相同」——前台批量
 * 的窗口宽度本来就等于这个数。
 *
 * 刻意**不**做的事：
 * - 不感知单条目的实际连接数（那要逐条探测才知道，批量的推导同样按最高档保守
 *   计算 —— 沿用同一取舍）；
 * - 不做优先级 / 抢占：前台不比后台高贵，先到先得。被占满时前台条目排队等待，
 *   迟到但不丢失。
 */
import { decideConcurrency, LARGE_FILE } from './decision.js';
/**
 * 进程内连接预算：与批内窗口的推导一致（单条目最高档 × 2）。
 * 见 src/index.ts 的 batchWindow 注释 —— 两者必须是同一个数，因此共用这一处推导。
 */
export const CONNECTION_BUDGET = decideConcurrency(LARGE_FILE) * 2;
/**
 * 闸门容量 = 同时开跑的条目数上限。
 * 预算 ÷ 单条目可能占用的最高连接数（每条 ≤ 8 连接）→ 最坏情况全局连接数仍是
 * 预算的 16，与 1.3.0 的批量峰值完全相同。
 */
export const GATE_CAPACITY = Math.max(1, Math.floor(CONNECTION_BUDGET / decideConcurrency(LARGE_FILE)));
/**
 * FIFO 异步闸门。
 *
 * 为什么自己写而不用现成信号量：依赖面已经刻意很小，而这里需要的语义非常小
 * （容量固定、FIFO 唤醒、release 幂等），几十行就够，且可以精确单测。
 */
export class DownloadGate {
    capacity;
    active = 0;
    waiters = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    /** 当前占用的槽位数（诊断 / 测试用）。 */
    get activeCount() {
        return this.active;
    }
    /** 正在等待槽位的条目数（诊断 / 测试用）。 */
    get pendingCount() {
        return this.waiters.length;
    }
    /**
     * 获取一个槽位，返回释放函数。
     * 有空闲槽位时立即返回（不经过事件循环，调用方可以直接继续）；满时按先到
     * 先得排队。
     */
    async acquire() {
        if (this.active < this.capacity) {
            this.active += 1;
            return this.release.bind(this);
        }
        await new Promise((resolve) => {
            this.waiters.push(resolve);
        });
        // 被唤醒即已占用一个槽位（release 负责把槽位转交给队首，见下）
        return this.release.bind(this);
    }
    /** 释放一个槽位；队首有等待者时把槽位**直接转交**（不经过空档期）。 */
    release() {
        const next = this.waiters.shift();
        if (next) {
            // 槽位转交：active 计数不变，唤醒队首即可
            next();
            return;
        }
        // reset() 之后旧的释放函数仍可能被调用：夹在 0，不让计数变负
        if (this.active > 0)
            this.active -= 1;
    }
    /** 清空状态（只给测试用）。 */
    reset() {
        for (const resolve of this.waiters.splice(0))
            resolve();
        this.active = 0;
        this.waiters.length = 0;
    }
}
/** 进程级单例：所有条目（前台 / 后台 / 重试）共用的同一个闸门。 */
export const downloadGate = new DownloadGate(GATE_CAPACITY);

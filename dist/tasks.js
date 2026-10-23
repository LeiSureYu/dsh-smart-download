/**
 * 进程内任务注册表：把「正在跑的下载」与它的取消手柄、重试元数据放在一起。
 *
 * 为什么必须是进程内状态：`AbortController` 只在创建它的进程里有效，而
 * `smartdl.manage` 的 cancel / retry 来自浏览器端，走的是同一个 Host 进程。
 * 把 controller 写进磁盘毫无意义（重启后那个进程已经没了），所以这里只存
 * 内存，并且**不**持久化任何东西。
 *
 * 与进度记录的分工：
 * - 本模块回答「这一条现在还在跑吗、能不能叫停」；
 * - 进度记录（`progress.ts`）回答「它跑成什么样了、原来请求的是什么」。
 *
 * 重试元数据（URL / 输出路径 / 摘要 / 镜像…）会随进度记录落盘，但
 * **请求头永不落盘**：`Authorization` / Cookie 这类凭据写进
 * `~/.dsh/downloads/tasks/*.json` 等于把秘密留在磁盘上。代价是重试不会
 * 携带原请求的自定义头，这一点必须在文档与 UI 里说清楚。
 */
import * as path from 'node:path';
/**
 * 同时跟踪的运行数上限。
 *
 * 正常路径上运行数受 Host 的并发限制约束，这个上限只是防御性的：万一某个
 * 调用方绕过了工具队列，也不能让一个 Map 无限增长。超过上限时**不登记**
 * （下载照常进行），代价只是这一条不能从面板取消 —— 比静默丢弃一个已有
 * 任务的 controller 安全。
 */
const MAX_RUNNING = 512;
/** 记住多少个已结束的 taskId，用于区分「没在跑」与「从没见过」。 */
const MAX_KNOWN = 1024;
const running = new Map();
const known = new Set();
let retryHandler = null;
/**
 * 登记一次运行。
 *
 * @returns 是否登记成功；false 表示已到防御上限（调用方仍可继续下载）
 */
export function registerRunningTask(taskId, controller, request) {
    if (typeof taskId !== 'string' || taskId === '')
        return false;
    if (running.size >= MAX_RUNNING && !running.has(taskId))
        return false;
    running.set(taskId, { taskId, controller, startedAt: Date.now(), request });
    known.add(taskId);
    if (known.size > MAX_KNOWN) {
        // Set 的迭代顺序就是插入顺序：淘汰最老的 id 即可。
        const oldest = known.values().next();
        if (!oldest.done)
            known.delete(oldest.value);
    }
    return true;
}
/** 注销一次运行（幂等；在 finally 里调用）。 */
export function unregisterRunningTask(taskId) {
    running.delete(taskId);
}
/** 这一条现在是否真的在跑。 */
export function isRunning(taskId) {
    return running.has(taskId);
}
/**
 * 请求取消一条正在跑的任务。
 *
 * 幂等：重复调用只会再次 abort 同一个 controller（AbortController 的 abort
 * 本身是幂等的）。没登记过时返回 `not-running`，由调用方结合进度记录决定
 * 是「已经结束」还是「根本没这条任务」。
 */
export function cancelRunningTask(taskId) {
    const entry = running.get(taskId);
    if (!entry)
        return 'not-running';
    entry.controller.abort();
    return 'cancelled';
}
/** 这个 taskId 是否在本进程里出现过（用于区分 unknown）。 */
export function isKnownTask(taskId) {
    return known.has(taskId);
}
/** 当前运行中的 taskId（诊断 / 测试用）。 */
export function runningTaskIds() {
    return [...running.keys()];
}
/** 安装重试实现（插件 apply 时调用一次）。 */
export function setRetryHandler(handler) {
    retryHandler = handler;
}
/** 读取当前的重试实现。 */
export function getRetryHandler() {
    return retryHandler;
}
/** 清空全部状态（只给测试用）。 */
export function resetTaskRegistry() {
    for (const entry of running.values())
        entry.controller.abort();
    running.clear();
    known.clear();
    retryHandler = null;
}
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
export function parseRetryRequest(raw, outPath) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const body = raw;
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (url === '')
        return undefined;
    const explicitOutput = typeof body.output === 'string' && path.isAbsolute(body.output) ? body.output : undefined;
    const recordedOutput = typeof outPath === 'string' && path.isAbsolute(outPath) ? outPath : undefined;
    const output = explicitOutput ?? recordedOutput;
    const text = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    const positive = (value, max) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max
        ? value
        : undefined;
    const ifExistsRaw = body.ifExists;
    const ifExists = ifExistsRaw === 'overwrite' || ifExistsRaw === 'skip' || ifExistsRaw === 'rename'
        ? ifExistsRaw
        : undefined;
    const sha256 = text(body.sha256);
    const checksum = text(body.checksum);
    // sha256 与 checksum 二选一：两条都有时宁可不重试，也不要替用户选一个。
    if (sha256 !== undefined && checksum !== undefined)
        return undefined;
    // timeoutMs 存在但越界时整条拒绝，而不是把字段悄悄丢掉：丢掉等于把
    // 「这条任务有超时」变成「无限等待」，与用户原来的意图相反。下限与
    // index.ts 的 MIN_TIMEOUT_MS 一致，上限与 MAX_TIMEOUT_MS 一致。
    const timeoutMs = body.timeoutMs === undefined
        ? undefined
        : positive(body.timeoutMs, 30 * 60 * 1000);
    if (body.timeoutMs !== undefined && (timeoutMs === undefined || timeoutMs < 1_000)) {
        return undefined;
    }
    return {
        url,
        ...(output === undefined ? {} : { output }),
        ...(sha256 === undefined ? {} : { sha256 }),
        ...(checksum === undefined ? {} : { checksum }),
        ...(ifExists === undefined ? {} : { ifExists }),
        ...(text(body.mirror) === undefined ? {} : { mirror: text(body.mirror) }),
        ...(positive(body.maxBandwidthBytes, Number.MAX_SAFE_INTEGER) === undefined
            ? {}
            : { maxBandwidthBytes: positive(body.maxBandwidthBytes, Number.MAX_SAFE_INTEGER) }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(text(body.batchId) === undefined ? {} : { batchId: text(body.batchId) }),
    };
}

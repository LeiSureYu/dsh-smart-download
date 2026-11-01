/**
 * RPC 下载路径（1.9.0）：经常驻 daemon 的 addUri → tellStatus 轮询 → 完成。
 *
 * 与 1.8 的 spawn 路径（downloadWithAria2）**同契约**：
 * - 入参一致（url / outputPath / concurrency / signal / reporter / resume /
 *   headers / 限速 / 代理）；
 * - 完成返回 Aria2Observation（吞吐缓存写入侧不变）；
 * - 失败抛错（调用方的 aria2 → curl 回退不变）；
 * - 信号暂停（PAUSE_ABORT_REASON）→ aria2.pause 原地挂起 → reporter.paused →
 *   DownloadPausedError；信号取消 → aria2.remove → reporter.cancel →
 *   DownloadCancelledError。
 *
 * daemon 不可用时抛 DaemonUnavailableError——调用方（src/index.ts）据此降级到
 * spawn 路径（1.8 的 downloadWithAria2）。
 */
import path from 'node:path';
import { rpcCall, ensureDaemon } from './rpc-daemon.js';
import { PAUSE_ABORT_REASON } from './tasks.js';
import { DownloadCancelledError, DownloadPausedError } from './tasks.js';
function formatSpeed(bytesPerSec) {
    if (bytesPerSec >= 1024 * 1024)
        return (bytesPerSec / 1024 / 1024).toFixed(1) + 'MiB/s';
    if (bytesPerSec >= 1024)
        return (bytesPerSec / 1024).toFixed(0) + 'KiB/s';
    return bytesPerSec.toFixed(0) + 'B/s';
}
function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0)
        return '';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m}m${s}s` : `${s}s`;
}
/** 把插件头表转成 aria2 RPC 的 header 选项（可重复项用数组表达）。 */
function headersToRpcOption(headers) {
    if (!headers)
        return undefined;
    return Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}
export async function downloadWithAria2Rpc(opts) {
    const { url, outputPath, concurrency, signal, reporter, resume, headers, maxDownloadLimitBytes, proxy } = opts;
    const dir = path.dirname(outputPath);
    const out = path.basename(outputPath);
    // daemon 不可用 → 直接抛给调用方降级，不在这层静默换路径
    await ensureDaemon();
    const rpcOptions = {
        dir,
        out,
        // 断点续传：aria2 自己的 .aria2 控制文件 + 调用方已做过的 planResume 同源核对
        'continue': resume ? 'true' : 'false',
        'max-connection-per-server': String(concurrency),
        'split': String(concurrency),
        'min-split-size': '1M',
        'max-download-limit': maxDownloadLimitBytes === undefined ? '0' : String(maxDownloadLimitBytes),
        'allow-overwrite': 'true',
        'auto-file-renaming': 'false',
        'file-allocation': 'none',
    };
    const headerList = headersToRpcOption(headers);
    if (headerList && headerList.length > 0)
        rpcOptions['header'] = headerList;
    if (proxy)
        rpcOptions['all-proxy'] = proxy;
    const gid = (await rpcCall('aria2.addUri', [[url], rpcOptions]));
    let lastThroughput = 0;
    let lastCn = 0;
    let sawThroughput = false;
    /** 信号中止的动作：暂停 → 原地挂起；取消/超时 → 移除。 */
    const handleAbort = async () => {
        if (signal.reason === PAUSE_ABORT_REASON) {
            try {
                await rpcCall('aria2.pause', [gid]);
                // 等状态真的到 paused（立即生效，实测 ~23ms）
                for (;;) {
                    const st = (await rpcCall('aria2.tellStatus', [
                        gid,
                        ['status', 'completedLength'],
                    ]));
                    if (st.status === 'paused') {
                        const pct = Math.round((Number(st.completedLength) / 1) || 0);
                        void pct;
                        break;
                    }
                    if (st.status === 'complete' || st.status === 'error')
                        break;
                    await sleep(30);
                }
                reporter?.paused('已暂停：可从下载管理器继续');
                await reporter?.awaitFlush();
                throw new DownloadPausedError('已暂停：下载被用户暂停');
            }
            catch (err) {
                if (err instanceof DownloadPausedError)
                    throw err;
                // RPC 暂停失败（daemon 恰好死了）：按取消处理，半包与指纹照常保留
                reporter?.cancel('已暂停（daemon 异常）：重试将从断点继续');
                await reporter?.awaitFlush();
                throw new DownloadCancelledError('已暂停：daemon 异常中断');
            }
        }
        // 取消 / 超时：移除任务（半包保留，.aria2 控制文件由 aria2 管理）
        try {
            await rpcCall('aria2.remove', [gid]);
        }
        catch {
            /* 已结束或 daemon 已死：无所谓，产物状态以磁盘为准 */
        }
        reporter?.cancel();
        await reporter?.awaitFlush();
        throw new DownloadCancelledError('已取消：下载被用户中止');
    };
    let lastReported = -1;
    for (;;) {
        if (signal.aborted)
            return await handleAbort();
        let st;
        try {
            st = (await rpcCall('aria2.tellStatus', [
                gid,
                ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'errorCode', 'errorMessage'],
            ]));
        }
        catch (err) {
            // daemon 意外死亡（RPC 调不通）→ 转成普通失败，调用方按既有路径回退 curl
            const message = err instanceof Error ? err.message : String(err);
            reporter?.fail('aria2 RPC 通信失败：' + message);
            await reporter?.awaitFlush();
            throw new Error('aria2 RPC 通信失败：' + message);
        }
        const total = Number(st.totalLength) || 0;
        const done = Number(st.completedLength) || 0;
        const speed = Number(st.downloadSpeed) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        if (st.status === 'complete') {
            reporter?.report(100, '下载完成', undefined, undefined, 'done');
            await reporter?.awaitFlush();
            // 吞吐观测：最后已知速度与连接数（与 spawn 路径的 Aria2Observation 同构）
            if (lastThroughput > 0) {
                return { throughput: lastThroughput, concurrency, cn: Math.max(1, lastCn) };
            }
            return undefined;
        }
        if (st.status === 'error') {
            const code = st.errorCode ? `aria2 错误码 ${st.errorCode}` : '未知错误';
            const detail = st.errorMessage ? `：${st.errorMessage}` : '';
            throw new Error(`${code}${detail}`);
        }
        if (st.status === 'removed') {
            // 由 handleAbort 的 remove 调用触达；正常路径不应到这里
            reporter?.cancel();
            await reporter?.awaitFlush();
            throw new DownloadCancelledError('已取消：下载被用户中止');
        }
        // 进度上报：与 spawn 路径同一 reporter 契约
        if (total > 0 && pct !== lastReported) {
            lastReported = pct;
            const spd = speed > 0 ? formatSpeed(speed) : undefined;
            const etaSec = speed > 0 && total > done ? (total - done) / speed : undefined;
            const eta = etaSec !== undefined ? formatEta(etaSec) : undefined;
            reporter?.report(pct, '下载中（aria2）', spd, eta);
        }
        if (speed > 0) {
            lastThroughput = speed;
            sawThroughput = true;
        }
        const cn = Number(st.connections) || 0;
        if (cn > 0)
            lastCn = cn;
        await sleep(500);
    }
    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
    // 观测语义与 spawn 路径一致：没有可靠吞吐就不编造
    void sawThroughput;
}

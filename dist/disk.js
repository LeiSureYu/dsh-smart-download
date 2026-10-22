/**
 * 下载前的磁盘空间预检。
 *
 * 为什么值得单独一层：磁盘写满时 aria2 / curl 不一定给出非零退出码，而落盘
 * 文件会是一个截断的产物 —— 这正是「报告成功、文件损坏」的静默失败。预检
 * 能在发出任何请求之前拒绝，比下到一半再失败更省时间，也更不容易留下半包。
 *
 * 预留空间不是「多余」：文件系统本身、下载期间的临时文件、以及用户同时在做的
 * 其它写入都需要余量。预留取 `max(64MB, 5% × 文件大小)`：小文件不会被 5% 的
 * 零头卡住，大文件则有与体积相称的余量。
 */
import { statfs } from 'node:fs/promises';
/** 固定预留空间：64MB */
export const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;
/** 按文件大小预留的比例：5% */
export const DISK_HEADROOM_RATIO = 0.05;
/** 下载一个 `size` 字节的文件所需的可用空间（含预留） */
export function requiredFreeBytes(size) {
    if (!Number.isFinite(size) || size < 0)
        return DISK_HEADROOM_BYTES;
    return Math.ceil(size + Math.max(DISK_HEADROOM_BYTES, size * DISK_HEADROOM_RATIO));
}
/**
 * 纯函数：比较可用空间与所需空间。
 *
 * @param free 目标目录所在文件系统的可用字节数
 * @param size 远端声明的文件大小；未知时返回 checked:false
 */
export function evaluateDiskSpace(free, size) {
    if (size === undefined) {
        return { checked: false, reason: '远端未声明文件大小，无法预检磁盘空间' };
    }
    const required = requiredFreeBytes(size);
    return free >= required
        ? { checked: true, ok: true, free, required }
        : { checked: true, ok: false, free, required };
}
/**
 * 查询目标目录所在文件系统的可用空间并判定。
 *
 * 只读取 `dir` 本身（调用方必须先确保它存在）。`statfs` 在个别文件系统 /
 * 容器上可能不可用：此时返回 `checked:false` 而不是抛错 —— 预检是保护，不是
 * 下载的前置条件；但调用方**必须**把 `checked:false` 的说明透传出去，不能
 * 让它看起来像「检查过且通过」。
 */
export async function checkDiskSpace(dir, size) {
    try {
        const stats = await statfs(dir);
        return evaluateDiskSpace(stats.bavail * stats.bsize, size);
    }
    catch (err) {
        return {
            checked: false,
            reason: `无法查询磁盘可用空间（${err instanceof Error ? err.message : String(err)}）`,
        };
    }
}
/** 低空间时的固定错误文案 */
export function describeInsufficientSpace(free, required) {
    return (`拒绝下载：磁盘可用空间不足（可用 ${free} 字节，需要 ${required} 字节，含预留空间）\n` +
        '下一步：清理磁盘或改用另一个 output 路径后重试');
}

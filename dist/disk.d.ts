/** 固定预留空间：64MB */
export declare const DISK_HEADROOM_BYTES: number;
/** 按文件大小预留的比例：5% */
export declare const DISK_HEADROOM_RATIO = 0.05;
/** 下载一个 `size` 字节的文件所需的可用空间（含预留） */
export declare function requiredFreeBytes(size: number): number;
/** 纯判定：可用空间是否足够；`size` 未知时不做判断（返回 checked:false） */
export type DiskSpaceVerdict = {
    checked: true;
    ok: true;
    free: number;
    required: number;
} | {
    checked: true;
    ok: false;
    free: number;
    required: number;
} | {
    checked: false;
    reason: string;
};
/**
 * 纯函数：比较可用空间与所需空间。
 *
 * @param free 目标目录所在文件系统的可用字节数
 * @param size 远端声明的文件大小；未知时返回 checked:false
 */
export declare function evaluateDiskSpace(free: number, size: number | undefined): DiskSpaceVerdict;
/**
 * 查询目标目录所在文件系统的可用空间并判定。
 *
 * 只读取 `dir` 本身（调用方必须先确保它存在）。`statfs` 在个别文件系统 /
 * 容器上可能不可用：此时返回 `checked:false` 而不是抛错 —— 预检是保护，不是
 * 下载的前置条件；但调用方**必须**把 `checked:false` 的说明透传出去，不能
 * 让它看起来像「检查过且通过」。
 */
export declare function checkDiskSpace(dir: string, size: number | undefined): Promise<DiskSpaceVerdict>;
/** 低空间时的固定错误文案 */
export declare function describeInsufficientSpace(free: number, required: number): string;

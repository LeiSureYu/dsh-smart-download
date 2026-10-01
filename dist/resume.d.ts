import type { ProbeResult } from './types.js';
/** 续传计划 */
export interface ResumePlan {
    /** 是否续传 */
    resume: boolean;
    /** 决策依据（写进 reason，便于排查） */
    reason: string;
    /** 是否删掉了本地文件 */
    discarded: boolean;
}
/** 取本地文件大小；不存在或不可读时返回 null */
export declare function localFileSize(outputPath: string): number | null;
/** 写入旁车指纹；失败时静默忽略 */
export declare function writeMarker(outputPath: string, probe: ProbeResult): void;
/** 删除旁车文件（下载成功 / 失败后调用，避免留下过时指纹） */
export declare function clearMarker(outputPath: string): void;
/** 归一化 ETag 以便比较：去掉弱校验前缀 W/ 与可能的 -gzip 后缀 */
export declare function normalizeEtag(etag: string): string;
/**
 * 判定本地半包能否续传，不能续传时直接删掉。
 *
 * 判定顺序：
 * 1. 没有本地文件 → 从头下，无风险；
 * 2. 远端长度未知 → 无法比对，删掉重下（宁可重下也不冒险拼接）；
 * 3. 本地比远端还长 → 资源一定变过，删掉重下；
 * 4. 有旁车指纹且 ETag / Last-Modified 与本次不一致 → 内容变了，删掉重下；
 * 5. 有旁车指纹且远端长度与旁车不一致 → 资源变了，删掉重下；
 * 6. 其余 → 按长度续传。
 *
 * @param outputPath 本地输出文件路径
 * @param probe 探测结果（含远端长度与指纹）
 * @param rangeSupported 服务器是否支持 Range（不支持时根本不该续传）
 */
export declare function planResume(outputPath: string, probe: ProbeResult, rangeSupported: boolean): ResumePlan;

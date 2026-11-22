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
/**
 * 判定磁盘上的半包是否由 aria2 分片写入（1.9.3，Issue #21 的相邻隐患）。
 *
 * 判据是 `.aria2` 控制文件的存在性：aria2 一旦开始写分片就会创建控制文件
 * （完成时才删除）。这个判定是 curl 接手 aria2 残局前的**安全闸** —— 详见
 * `discardAria2Partial` 的注释。
 *
 * 为什么用 `lstat` 不跟进符号链接：与进度文件的读取端（progress.ts）同一套
 * 纪律 —— 一个指向别处的同名符号链接不该被当成「aria2 的半包」。
 */
export declare function hasAria2ControlFile(outputPath: string): boolean;
/**
 * 丢弃 aria2 分片半包：删本地文件与 `.aria2` 控制文件，**保留**旁车指纹。
 *
 * 为什么需要它（2026-11-23 随包 aria2 1.37.0 实测坐实，勿凭直觉改回去）：
 * aria2 分片写入 —— 各连接把自己负责的分片写到最终偏移，未完成分片之间是
 * 零字节空洞，**文件长度只反映写得最远的那个分片**。实测：64MB、8 连接、
 * `--file-allocation=none`，中途硬杀后落盘 61,865,984 字节（92%），
 * 但内部有 36,700,160 字节的空洞（第一个空洞在 3MB 处）。
 *
 * 而 curl 的 `-C -` 只看文件长度：接着这种半包「续传」会把后续字节接在空洞
 * 后面，拼出一个**长度正确、内容错误**的文件 —— 与 0.6.0 的续传教训（远端
 * 变化时退出码 0 但文件是错的）同一类静默损坏，且字节数校验拦不住它
 * （长度恰好对），只有调用方给了摘要才可能被发现。
 *
 * 因此 aria2 失败回退 curl 时，只要控制文件在（= aria2 真的写过分片），
 * 就必须整体丢弃半包、curl 全量重下。只有 aria2 自己能按分片续这种半包，
 * 而走到 curl 回退恰恰说明 aria2 这条路刚刚失败过。丢弃是刻意的，与
 * `planResume` 的哲学一致：宁可重下，不拿坏文件。
 *
 * 旁车指纹**保留**：它描述的是远端资源（长度 / ETag），与本地半包无关；
 * 半包删掉之后 `planResume` 会走「本地无文件，从头下载」，指纹不参与判定，
 * 下次 `writeMarker` 会重写同一份。
 */
export declare function discardAria2Partial(outputPath: string): void;
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

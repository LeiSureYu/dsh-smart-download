/**
 * 解析 aria2c --summary-interval=1 输出的进度摘要行。
 * 实测（aria2 1.37.0，--show-console-readout=false）形如：
 *   [#de8d33 11MiB/40MiB(27%) CN:4 DL:10MiB ETA:2s]
 * 其中 # 后为十六进制 GID，速度字段为 DL（单位本身即 /s）。
 * 同时兼容旧 readout 的 SIZE: 前缀与 SPD: 字段。
 *
 * 本文件同时提供“逐行切分”与 curl 进度解析，供生产代码与测试共用，
 * 避免测试用自己复刻的切分逻辑而绕过真实实现。
 */
/** 解析出的 aria2 摘要信息 */
export interface ParsedSummary {
    /** 进度百分比 0-100 */
    pct: number;
    /**
     * 实际有效连接数（摘要行里的 `CN:`）。
     *
     * 为什么值得单独取出来（1.3.0 新增，纯观测）：`-x/-s` 是**请求**的并发数，
     * `CN` 才是 aria2 **实际**用起来的连接数。两者不等时，说明瓶颈不在本插件的
     * 并发档位（分片数不够、服务器限并发、镜像不给 Range 等）——这是「为什么这次
     * 没跑满」唯一可观测的答案。此前正则已经匹配并消费了 `CN:\d+`，却没有捕获组，
     * 于是这个数字每次都被丢掉：数据一直是免费的，只是没留下。
     *
     * 1.3.0 只做观测：调用方（`src/downloader.ts` 的进度回调）不消费它，
     * 因此不影响任何下载行为。
     */
    cn: number;
    /** 速度字符串，规范化为如 "10MiB/s" */
    spd: string;
    /** 剩余时间字符串，如 "2s"、"4m51s"；临近完成 aria2 可能省略，故可选 */
    eta?: string;
}
/**
 * 按 \r\n / \r / \n 切分原始文本。
 * 末尾无终止符的半截内容会作为最后一个元素返回（由调用方决定是否保留）。
 */
export declare function splitIntoLines(raw: string): string[];
/** 解析单行 aria2 摘要；非摘要行（日志、分隔线、空行）返回 null。 */
export declare function parseAria2Summary(line: string): ParsedSummary | null;
/**
 * 解析 curl --progress-bar 单行中的百分比。
 * 形如 "##########  31.2%" -> 31.2；非进度行返回 null。
 */
export declare function parseCurlProgress(line: string): number | null;

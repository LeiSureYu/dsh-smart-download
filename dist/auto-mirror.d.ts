import type { MirrorCandidate } from './mirror.js';
/**
 * 覆盖内置候选镜像表的环境变量。
 *
 * 为什么要留这个口子：内置候选是三个**公开第三方**服务，能不能连上完全取决于
 * 调用方所处的网络；企业内网 / 自建代理的场景下它们一个都用不了，而调用方
 * 除了手填 `mirror` 前缀没有别的办法。与 `DSH_PROGRESS_DIR` /
 * `DSH_DOWNLOAD_PROGRESS_DIR` / `DSH_HOME` 同属「显式覆盖」一类。
 *
 * 取值：逗号分隔的前缀表，按顺序即为候选优先级。空 / 纯空白视为未设置。
 */
export declare const MIRRORS_ENV = "DSH_SMARTDL_MIRRORS";
/**
 * 解析本次生效的候选镜像表：环境变量优先，否则用内置表。
 *
 * 每次调用都重新读环境变量（不在模块加载时固化），否则测试与运行期改配置
 * 都不会生效。
 */
export declare function resolveMirrorPrefixes(): readonly string[];
/** 原始地址的指纹：候选镜像必须与它一致才被采用 */
export interface MirrorFingerprint {
    /** 原始地址探测到的文件长度；未知时自动镜像不启用 */
    contentLength?: number;
    /** 原始地址的 ETag（含引号，原样） */
    etag?: string;
}
/** 一次候选探测的结果 */
export interface MirrorProbeOutcome {
    /** 是否拿到了可用的响应（有 Content-Length 才算） */
    ok: boolean;
    /** 响应声明的文件长度 */
    contentLength?: number;
    /** 响应的 ETag（原样） */
    etag?: string;
}
/** 探测一个候选地址；实现方负责超时与取消，失败时返回 `ok: false` */
export type MirrorProbe = (url: string) => Promise<MirrorProbeOutcome>;
/** 选中的镜像与判定依据 */
export interface AutoMirrorPick {
    candidate: MirrorCandidate;
    /** 写进返回结果说明的判定依据 */
    reason: string;
}
/**
 * 按候选表顺序挑第一个与原地址同源的镜像。
 *
 * 所有候选**并行**探测（串行会让最坏耗时随候选数线性增长），随后按候选表
 * 顺序取第一个通过校验的 —— 顺序仍然由候选表决定，结果可预期。
 *
 * @param url 原始下载地址
 * @param expected 原始地址的指纹；`contentLength` 未知时直接返回 null
 * @param probe 探测函数（调用方注入，通常包一层 `probeUrl`）
 * @param prefixes 候选前缀表，缺省用 `RECOMMENDED_MIRRORS`
 * @returns 选中的候选与依据；没有可用候选时返回 null
 */
export declare function pickMirrorServingSameFile(url: string, expected: MirrorFingerprint, probe: MirrorProbe, prefixes?: readonly string[]): Promise<AutoMirrorPick | null>;
/** 目标不是 GitHub：自动镜像没有意义 */
export declare const AUTO_MIRROR_SKIP_NOT_GITHUB = "\u672A\u4F7F\u7528\u81EA\u52A8\u955C\u50CF\uFF1A\u53EA\u6709 GitHub \u5730\u5740\u652F\u6301";
/** 拿不到原始长度：没有比对基准，无从证实同源 */
export declare const AUTO_MIRROR_SKIP_NO_LENGTH = "\u672A\u4F7F\u7528\u81EA\u52A8\u955C\u50CF\uFF1A\u65E0\u6CD5\u4ECE\u539F\u59CB\u5730\u5740\u53D6\u5F97\u6587\u4EF6\u957F\u5EA6\uFF0C\u65E0\u4ECE\u8BC1\u5B9E\u955C\u50CF\u8FD4\u56DE\u7684\u662F\u540C\u4E00\u4E2A\u6587\u4EF6";
/** 候选表全部落空 */
export declare const AUTO_MIRROR_SKIP_NO_CANDIDATE = "\u672A\u4F7F\u7528\u81EA\u52A8\u955C\u50CF\uFF1A\u5185\u7F6E\u955C\u50CF\u5747\u4E0D\u53EF\u8FBE\uFF0C\u6216\u8FD4\u56DE\u7684\u6587\u4EF6\u4E0E\u539F\u59CB\u5730\u5740\u4E0D\u4E00\u81F4";
/** 自动镜像的解析结果 */
export interface AutoMirrorResolution {
    /** 实际应当请求的地址（未启用镜像时等于原始地址） */
    url: string;
    /** 是否走了镜像 */
    mirrored: boolean;
    /** 采用的镜像前缀（`mirrored` 为真时出现） */
    mirror?: string;
    /** 采用镜像时的判定依据，用于写进度文案 */
    reason?: string;
    /** 未启用镜像时的说明；调用方必须把它透出给用户，不得静默 */
    skipped?: string;
}
/**
 * 解析 `mirror: "auto"`：决定这次到底用不用镜像、用哪一个。
 *
 * 这个函数把「什么时候不启用」的三条路径全部收在这里，而不是散在
 * `smart_download.execute()` 里 —— 那三行如果留在执行函数里就无法被单测
 * 覆盖（要覆盖「选中镜像」那条还得有真实可达的 GitHub 与镜像）。
 *
 * @param url 原始下载地址
 * @param expected 原始地址的指纹（来自探测）
 * @param probe 候选探测函数（调用方注入）
 * @param prefixes 候选前缀表，缺省用 `RECOMMENDED_MIRRORS`
 */
export declare function resolveAutoMirror(url: string, expected: MirrorFingerprint, probe: MirrorProbe, prefixes?: readonly string[]): Promise<AutoMirrorResolution>;

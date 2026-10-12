/** 缓存目录的环境变量覆盖（沿用 DSH_DOWNLOAD_PROGRESS_DIR / DSH_HOME 的既有惯例） */
export declare const THROUGHPUT_DIR_ENV = "DSH_SMARTDL_THROUGHPUT_DIR";
/**
 * 历史有效期：超过就当作「没下过这台主机」，并顺手把那条淘汰。
 *
 * 为什么是 24 小时：一小时内的网络状况都可能变（机房调度、CDN 换节点、本地带宽被占），
 * 但按主机记的吞吐本来就是粗粒度信号，太短等于永远没有历史可用（下载本身就是低频动作）。
 */
export declare const THROUGHPUT_TTL_MS: number;
/**
 * 每条记录保留的最近样本数。
 *
 * 为什么取中位数而不是均值、为什么样本这么少：一次网络抖动就能把均值拉飞，
 * 而中位数对单个离群值不敏感；5 次已经足够看出「这台主机大概多快」。
 */
export declare const THROUGHPUT_SAMPLES = 5;
/** 缓存键：主机名的 sha256 前缀 + 端口（**不含**明文主机名） */
export interface ThroughputKey {
    /** 主机名的 sha256（前 32 个十六进制字符） */
    hostHash: string;
    /** 端口；URL 未显式给出时按协议补 80 / 443 */
    port: string;
}
/** 一条历史记录（本插件自有格式，v1） */
export interface ThroughputRecord {
    /** 缓存键的哈希部分；与文件名前缀一致，便于人工核对「这条是谁的」 */
    hostHash: string;
    /** 缓存键的端口部分 */
    port: string;
    /** 最近 N 次观测到的吞吐（字节/秒），最旧的在前 */
    samples: number[];
    /**
     * `samples` 的中位数（字节/秒）。
     *
     * 为什么存一份冗余字段：决策只信**由 samples 重算出来**的值（单一算法口径，见
     * `parseRecord`），这个字段只是让缓存文件自解释 —— 人工查看时不必自己算中位数。
     */
    medianThroughput: number;
    /** 观测时的**请求**并发数（插件交给 aria2 的 `-x/-s`） */
    concurrency: number;
    /**
     * 本次下载**实际用起来的连接数峰值**（跨本次的多条 aria2 摘要取最大 `CN:`）
     *
     * 为什么是峰值而不是最后一条：收尾排空会让末尾几条摘要的 `CN` 掉到 1（实测 8MB/8 连接
     * 是 `[{60%, CN:8}, {96%, CN:1}]`），那只反映排空阶段、不代表这台主机能给出的并发能力，
     * 而抬档门槛（`RAISE_MIN_EFFECTIVE_CONNECTIONS`）正是拿这个字段去比的。
     * 解析见 src/progress-parse.ts，取峰值处见 src/downloader.ts。
     */
    cn: number;
    /** 最后一次更新的时间戳（毫秒）；TTL 以它为准 */
    updatedAt: number;
}
/** 命中结果：记录本身 + 它的缓存键（调用方要拿主机标识写文案，不该自己再解析一遍 URL） */
export interface ThroughputHit {
    key: ThroughputKey;
    record: ThroughputRecord;
}
/**
 * 解析缓存目录：环境变量优先，缺省为 `<DSH_HOME>/downloads/throughput`（与轨道二并列）。
 *
 * 为什么复用 `resolveDshHome()` 而不是自己再解析一遍 DSH_HOME：那套「环境变量优先、
 * 支持 ~ 展开、缺省 ~/.dsh」的规则只能有一份，抄第二份就是两份真相（改一处漏一处）。
 */
export declare function resolveThroughputDir(): string;
/**
 * 从 URL 取「主机 + 端口」的缓存键。
 *
 * URL 不合法或协议非 http(s) 时返回 `null`：那些地址在下载前就会被拒绝
 * （`checkDownloadUrl`），在这里给它们建桶没有意义。调用方按「无历史」处理。
 */
export declare function throughputKey(url: string): ThroughputKey | null;
/**
 * 中位数（偶数个取中间两个的平均值）。
 *
 * 空数组返回 0：调用方必须自己先判断「有没有样本」（见 `parseRecord` 的校验），
 * 0 在这里只是「没有东西可算」的占位，不会被当成一个观测值使用。
 */
export declare function median(values: readonly number[]): number;
/**
 * 读取某个 URL 对应主机的历史；不存在 / 读不到 / 损坏 / 过期一律返回 `null`（= 无历史）。
 *
 * 只读：不会创建目录、不会抛异常。过期条目会被顺手淘汰（删除失败同样静默）。
 *
 * @param url 原始 URL（只取主机 + 端口建桶）
 * @param options `dir` 覆盖缓存目录，`now` 注入「现在」（TTL 判定用，便于单测）
 */
export declare function readThroughput(url: string, options?: {
    dir?: string;
    now?: number;
}): ThroughputHit | null;
/**
 * 追加一次观测（下载结束时调用）。
 *
 * 任何失败都静默忽略：写不进去只是「下次没有历史」，绝不该让已经成功的下载变成失败。
 * 目录不存在会尝试创建；目录/文件不可写（只读、路径被文件占住）时直接放弃。
 *
 * @param sample 本次观测：URL、吞吐（字节/秒）、请求并发数、实际有效连接数
 * @param options `dir` 覆盖缓存目录，`now` 注入「现在」（写入时间与 TTL 判定用）
 */
export declare function recordThroughput(sample: {
    url: string;
    throughput: number;
    concurrency: number;
    cn: number;
}, options?: {
    dir?: string;
    now?: number;
}): void;

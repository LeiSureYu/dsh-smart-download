/**
 * 按「主机 + 端口」分桶的吞吐缓存（P1-2 方案 B 的存储层）。
 *
 * 为什么记历史而不是下载中动态调并发：t2 的受控实测证明调整**不可行也不划算**
 * （x1→x8 全程 19.5s，而直接固定 x8 只要 17.35s；x8→x1 回退 2/2 失败）。所以这里
 * 只做「把上一次真观测到的数字留给下一次」——这些数据是下载本身免费产生的，
 * 不需要任何额外的探测请求。
 *
 * 为什么键是「主机 + 端口」而不是完整 URL：同一站点的不同路径共享带宽，
 * 按路径分桶等于永远命中不了。
 *
 * 为什么默认只存主机名的 sha256：缓存一旦落盘，就意味着「这台机器下过哪些主机」
 * 被持久化了。而决策只需要「同一个主机再次出现时能对上」，所以默认只留哈希 ——
 * 缓存文件即使被读到也不会直接给出域名清单（PLAN-P1-CONCURRENCY §3.2 的隐私口径）。
 *
 * 为什么所有读写失败一律静默：缓存是**优化**，不是功能。任何异常都退回「无历史」，
 * 让下载照常按大小分档进行 —— 与 `writeMarker()` 处理旁车指纹失败的方式一致
 * （src/resume.ts:95-108）。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDshHome } from './progress.js';
/** 缓存目录的环境变量覆盖（沿用 DSH_DOWNLOAD_PROGRESS_DIR / DSH_HOME 的既有惯例） */
export const THROUGHPUT_DIR_ENV = 'DSH_SMARTDL_THROUGHPUT_DIR';
/**
 * 历史有效期：超过就当作「没下过这台主机」，并顺手把那条淘汰。
 *
 * 为什么是 24 小时：一小时内的网络状况都可能变（机房调度、CDN 换节点、本地带宽被占），
 * 但按主机记的吞吐本来就是粗粒度信号，太短等于永远没有历史可用（下载本身就是低频动作）。
 */
export const THROUGHPUT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 每条记录保留的最近样本数。
 *
 * 为什么取中位数而不是均值、为什么样本这么少：一次网络抖动就能把均值拉飞，
 * 而中位数对单个离群值不敏感；5 次已经足够看出「这台主机大概多快」。
 */
export const THROUGHPUT_SAMPLES = 5;
/**
 * 主机名哈希保留的十六进制字符数（= sha256 前 16 字节）。
 *
 * 本用途只需要「同一个主机能对上」，不需要抗碰撞强度；截短只是让文件名短一点。
 * 完整 sha256 与截短前三者的碰撞概率差异在这个场景里没有意义。
 */
const HOST_HASH_CHARS = 32;
/**
 * 解析缓存目录：环境变量优先，缺省为 `<DSH_HOME>/downloads/throughput`（与轨道二并列）。
 *
 * 为什么复用 `resolveDshHome()` 而不是自己再解析一遍 DSH_HOME：那套「环境变量优先、
 * 支持 ~ 展开、缺省 ~/.dsh」的规则只能有一份，抄第二份就是两份真相（改一处漏一处）。
 */
export function resolveThroughputDir() {
    const fromEnv = process.env[THROUGHPUT_DIR_ENV];
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0)
        return fromEnv;
    return path.join(resolveDshHome(), 'downloads', 'throughput');
}
/**
 * 从 URL 取「主机 + 端口」的缓存键。
 *
 * URL 不合法或协议非 http(s) 时返回 `null`：那些地址在下载前就会被拒绝
 * （`checkDownloadUrl`），在这里给它们建桶没有意义。调用方按「无历史」处理。
 */
export function throughputKey(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    const host = parsed.hostname;
    if (!host)
        return null;
    // 显式端口优先；没写就按协议补默认端口 —— 否则 `https://a/x` 与 `https://a:443/y`
    // 会落进两个桶，而它们是同一个站点。
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    if (!port)
        return null;
    const hostHash = createHash('sha256').update(host).digest('hex').slice(0, HOST_HASH_CHARS);
    return { hostHash, port };
}
/**
 * 中位数（偶数个取中间两个的平均值）。
 *
 * 空数组返回 0：调用方必须自己先判断「有没有样本」（见 `parseRecord` 的校验），
 * 0 在这里只是「没有东西可算」的占位，不会被当成一个观测值使用。
 */
export function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1)
        return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}
/** 记录文件路径：`<dir>/<hostHash>-<port>.json` */
function recordPath(dir, key) {
    return path.join(dir, `${key.hostHash}-${key.port}.json`);
}
/**
 * 解析并校验一条记录；任何字段不对都返回 `null`（= 损坏 = 无历史）。
 *
 * 为什么校验得这么死：缓存的内容参与「提并发」这个决策，半信半疑地用一份被手工改过、
 * 或被别的版本写过的文件，等于让不确定的数据进入下载路径。宁可当作没有历史。
 */
function parseRecord(text, key) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (raw === null || typeof raw !== 'object')
        return null;
    const candidate = raw;
    if (candidate.hostHash !== key.hostHash || candidate.port !== key.port)
        return null;
    const samples = candidate.samples;
    if (!Array.isArray(samples) || samples.length === 0 || samples.length > THROUGHPUT_SAMPLES) {
        return null;
    }
    if (!samples.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0))
        return null;
    const concurrency = candidate.concurrency;
    if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency <= 0) {
        return null;
    }
    const cn = candidate.cn;
    if (typeof cn !== 'number' || !Number.isInteger(cn) || cn < 0)
        return null;
    const updatedAt = candidate.updatedAt;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0)
        return null;
    // medianThroughput 刻意**不**参与校验：它是冗余字段，中位数一律按 samples 重算。
    return {
        hostHash: candidate.hostHash,
        port: candidate.port,
        samples: [...samples],
        medianThroughput: median(samples),
        concurrency,
        cn,
        updatedAt,
    };
}
/**
 * 读取某个 URL 对应主机的历史；不存在 / 读不到 / 损坏 / 过期一律返回 `null`（= 无历史）。
 *
 * 只读：不会创建目录、不会抛异常。过期条目会被顺手淘汰（删除失败同样静默）。
 *
 * @param url 原始 URL（只取主机 + 端口建桶）
 * @param options `dir` 覆盖缓存目录，`now` 注入「现在」（TTL 判定用，便于单测）
 */
export function readThroughput(url, options = {}) {
    const key = throughputKey(url);
    if (key === null)
        return null;
    const dir = options.dir ?? resolveThroughputDir();
    const now = options.now ?? Date.now();
    let text;
    try {
        text = fs.readFileSync(recordPath(dir, key), 'utf-8');
    }
    catch {
        // 不存在、权限不足、路径是个目录 —— 全都是「没有历史」
        return null;
    }
    const record = parseRecord(text, key);
    if (record === null)
        return null;
    if (now - record.updatedAt >= THROUGHPUT_TTL_MS) {
        // 过期就是「没下过」：顺手淘汰，否则缓存会一直留着再也不会被用的死条目
        try {
            fs.unlinkSync(recordPath(dir, key));
        }
        catch {
            /* 淘汰失败不影响「当作无历史」这个结论 */
        }
        return null;
    }
    return { key, record };
}
/**
 * 追加一次观测（下载结束时调用）。
 *
 * 任何失败都静默忽略：写不进去只是「下次没有历史」，绝不该让已经成功的下载变成失败。
 * 目录不存在会尝试创建；目录/文件不可写（只读、路径被文件占住）时直接放弃。
 *
 * @param sample 本次观测：URL、吞吐（字节/秒）、请求并发数、实际有效连接数
 * @param options `dir` 覆盖缓存目录，`now` 注入「现在」（写入时间与 TTL 判定用）
 */
export function recordThroughput(sample, options = {}) {
    const key = throughputKey(sample.url);
    if (key === null || !Number.isFinite(sample.throughput) || sample.throughput <= 0)
        return;
    const dir = options.dir ?? resolveThroughputDir();
    const now = options.now ?? Date.now();
    // 过期的旧记录不参与累加（readThroughput 会顺手删掉它），因此 TTL 之后样本重新开始
    const previous = readThroughput(sample.url, { dir, now });
    const samples = [...(previous?.record.samples ?? []), sample.throughput].slice(-THROUGHPUT_SAMPLES);
    const record = {
        hostHash: key.hostHash,
        port: key.port,
        samples,
        medianThroughput: median(samples),
        concurrency: sample.concurrency,
        cn: sample.cn,
        updatedAt: now,
    };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(recordPath(dir, key), JSON.stringify(record), 'utf-8');
    }
    catch {
        /* 缓存是优化：写失败只意味着下次没有历史（见文件头） */
    }
}

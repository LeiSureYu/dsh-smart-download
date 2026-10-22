/**
 * 内容哈希校验：调用方按官方文档给出 SHA-256，下载后逐字节核对。
 *
 * 为什么要在「落盘字节数校验」（src/verify.ts）之外再加一层：
 * 长度校验只能证明「字节数对」，证明不了「内容是同一份」。以下两种情形长度
 * 完全一致而内容不同，长度校验一定放行：
 *   - 第三方镜像返回了另一个版本的同名文件（等长）；
 *   - 官方文档声明了摘要、而站点/CDN 被投毒或返回了错误内容。
 * 这两种正是「报告成功、产物错误」的静默失败，只有内容哈希能拦下。
 *
 * 为什么是**调用方传入**而不是远端取回：
 * 远端不保证提供摘要（没有 `Digest` / `X-Checksum-Sha256` 这类头），
 * 因此插件不去猜、也不去联网取；官方文档里写着的那个摘要由调用方传进来。
 * 这也让本模块完全不依赖网络，纯函数 + 一次本地流式读取，便于单测。
 *
 * 与 `verifySize` 的关系：两者独立。长度校验失败仍然一律判失败；长度校验
 * 「跳过」（远端没声明长度 / 声明了压缩编码）时，哈希校验依然能给出确定性
 * 结论 —— 它不需要任何远端信息。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
/** 默认摘要算法：sha256 简写与 SRI 走这一种 */
export const HASH_ALGORITHM = 'sha256';
/** 算法 → 十六进制摘要长度 */
export const CHECKSUM_HEX_LENGTHS = Object.freeze({
    md5: 32,
    sha1: 40,
    sha256: 64,
    sha512: 128,
});
/** 算法 → 人类可读标签（用于文案，避免在用户面前出现 `sha1` 这种裸名） */
export const CHECKSUM_LABELS = Object.freeze({
    md5: 'MD5',
    sha1: 'SHA-1',
    sha256: 'SHA-256',
    sha512: 'SHA-512',
});
/** 按十六进制长度识别裸摘要的算法 */
function algorithmForHexLength(length) {
    for (const [algorithm, expected] of Object.entries(CHECKSUM_HEX_LENGTHS)) {
        if (expected === length)
            return algorithm;
    }
    return null;
}
/**
 * 把各种写法的摘要归一化成 `{ algorithm, digest }`。
 *
 * 支持：
 *   - 裸十六进制：按长度识别 MD5(32) / SHA-1(40) / SHA-256(64) / SHA-512(128)；
 *   - 带算法前缀：`sha512:<hex>` / `md5=<hex>` / `SHA1(<hex>)`；
 *   - SRI：`sha256-<base64>` / `sha512-<base64>`。
 *
 * 裸摘要按长度识别是**唯一**不歧义的规则：四种长度互不相同。带前缀时仍然校验
 * 长度与算法匹配，例如 `md5:<64位>` 会被拒绝，而不是悄悄按 SHA-256 算。
 */
export function normalizeChecksum(input) {
    if (typeof input !== 'string')
        return null;
    const raw = input.trim();
    if (!raw)
        return null;
    // SRI：<algorithm>-<base64>
    const sri = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/i.exec(raw);
    if (sri) {
        const algorithm = sri[1].toLowerCase();
        const decoded = Buffer.from(sri[2], 'base64');
        if (decoded.length !== CHECKSUM_HEX_LENGTHS[algorithm] / 2)
            return null;
        return { algorithm, digest: decoded.toString('hex') };
    }
    // 带算法前缀：sha512:xxx / md5=xxx / SHA1(xxx)
    const prefixed = /^(md5|sha1|sha256|sha512)\s*[:=(]\s*(.*?)\s*\)?$/i.exec(raw);
    if (prefixed) {
        const algorithm = prefixed[1].toLowerCase();
        const digest = prefixed[2];
        if (digest.length !== CHECKSUM_HEX_LENGTHS[algorithm])
            return null;
        return /^[0-9a-f]+$/i.test(digest)
            ? { algorithm, digest: digest.toLowerCase() }
            : null;
    }
    if (!/^[0-9a-f]+$/i.test(raw))
        return null;
    const algorithm = algorithmForHexLength(raw.length);
    return algorithm ? { algorithm, digest: raw.toLowerCase() } : null;
}
/**
 * 把官方文档里各种写法的 SHA-256 归一化成 64 位小写十六进制。
 *
 * 官方文档的摘要写法五花八门，实测常见这几种，全部接受：
 *   - 裸十六进制：`9f86d081...`（大小写均可）
 *   - 带算法前缀：`sha256:9f86d081...` / `sha256=9f86d081...` / `SHA256(9f86d081...)`
 *   - 子资源完整性（SRI）：`sha256-<base64>`（网页 `<script integrity>` 里的形式）
 *
 * @param input 调用方给出的摘要字符串
 * @returns 归一化后的 64 位小写十六进制；无法识别时返回 null
 */
export function normalizeSha256(input) {
    const spec = normalizeChecksum(input);
    return spec?.algorithm === 'sha256' ? spec.digest : null;
}
/**
 * 流式计算文件 SHA-256。
 *
 * 用流而不是 `readFileSync`：官方文档里的东西经常是几百 MB 的安装包 /
 * 模型权重，整份读进内存既慢又可能直接 OOM。
 *
 * @param path 待校验文件路径
 * @returns 小写十六进制摘要；文件不存在 / 读不了时返回 null
 */
export function sha256File(path) {
    return hashFile(path, HASH_ALGORITHM);
}
/**
 * 流式计算任意受支持算法的文件摘要。
 *
 * 与 `sha256File` 同一套实现：只把 `createHash` 的算法名参数化，避免两套流式
 * 读取逻辑各自演化（其中一套漏了 error 处理就是「校验静默跳过」）。
 *
 * @param path 待校验文件路径
 * @param algorithm 摘要算法，默认 sha256
 * @returns 小写十六进制摘要；文件不存在 / 读不了时返回 null
 */
export function hashFile(path, algorithm = HASH_ALGORITHM) {
    return new Promise((resolve) => {
        const hash = createHash(algorithm);
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        const stream = createReadStream(path);
        stream.on('error', () => finish(null));
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => finish(hash.digest('hex')));
    });
}
/**
 * 纯函数：比较期望摘要与实际摘要。不碰文件系统，便于单元测试。
 *
 * @param expected 已归一化的期望摘要（64 位小写十六进制）
 * @param actual 实际算出的摘要；null 表示文件读不到
 */
export function verifySha256(expected, actual) {
    return verifyChecksum({ algorithm: 'sha256', digest: expected }, actual);
}
/**
 * 纯函数：比较期望摘要与实际摘要（任意受支持算法）。
 */
export function verifyChecksum(expected, actual) {
    if (actual === null)
        return { kind: 'unreadable', algorithm: expected.algorithm };
    return actual === expected.digest
        ? { kind: 'ok', digest: actual }
        : { kind: 'mismatch', expected: expected.digest, actual, algorithm: expected.algorithm };
}
/**
 * 文件读不到时的固定文案。
 *
 * 定成常量而不是就地拼字符串，理由与 `verify.ts` 里的跳过文案相同：
 * 让「这条路径只能输出这一个值」成为可断言的事实。
 *
 * 为什么带「下一步」：这条路径意味着「下载器说成功了，但产物读不出来」，
 * 用户能做的只有「重跑一次」和「去看路径」两件事，必须写明。
 */
export function checksumUnreadableMessage(algorithm = HASH_ALGORITHM) {
    return (`下载完整性校验失败：无法读取落盘文件以计算 ${CHECKSUM_LABELS[algorithm]}\n` +
        '下一步：确认输出路径与磁盘可读，然后重跑一次（产物与旁车指纹均已保留）');
}
/**
 * SHA-256 路径的固定文案。
 *
 * 保留这个常量而不是让所有调用点改用函数：`sha256` 是 1.2.0 起的公开入参，
 * 它的错误文案已经被测试逐字锁定。函数版本只用于通用 `checksum` 的其它算法。
 */
export const HASH_UNREADABLE_MESSAGE = checksumUnreadableMessage(HASH_ALGORITHM);
/**
 * 摘要不匹配时「下一步做什么」的固定文案。
 *
 * 为什么单列：两个摘要都只说明「不一样」，不说明「谁对」。而摘要不符有两种完全
 * 不同的原因 —— 下载内容被换掉，或调用方给的期望摘要本身写错了（官方文档也可能
 * 印错）。用户必须同时被提示这两条，否则会一直重下同一个坏内容。
 */
export const HASH_MISMATCH_NEXT_STEP = '下一步：产物、半包与旁车指纹均已保留，可直接重跑一次；若重跑后仍不匹配，请核对期望摘要是否抄错';
/**
 * 把哈希不一致翻译成给人看的错误信息。
 *
 * 为什么两个摘要**分行**而不是并排一行：两者都是 64 位十六进制，并排放在同一行
 * 时人眼无法定位到底哪一段不同（这恰恰是排查时唯一要看的东西）。分行后每一行
 * 只有一个摘要，可逐行对比，也便于把整行复制去比对。
 */
export function describeHashMismatch(outcome) {
    const label = outcome.algorithm ? CHECKSUM_LABELS[outcome.algorithm] : 'SHA-256';
    return (`下载完整性校验失败：${label} 不匹配\n` +
        `期望摘要：${outcome.expected}\n` +
        `实际摘要：${outcome.actual}\n` +
        HASH_MISMATCH_NEXT_STEP);
}
/**
 * 把任何「非 ok」的哈希结论翻译成给用户看的错误信息。
 *
 * 为什么把这段映射放在这里而不是留在 `smart_download.execute()` 里：留在执行
 * 函数里，`unreadable` 那条分支就永远测不到 —— 要构造「下载退出码 0 但文件
 * 读不了」得制造一个竞态。放进本模块后，它与 `verify.ts` 的 `describeSkip` /
 * `describeMismatch` 一样是可单测的纯函数，两条分支都有正向断言。调用方只剩
 * `if (kind !== 'ok') throw new IntegrityError(describeHashFailure(outcome))`，
 * 没有自己的分支。
 */
export function describeHashFailure(outcome) {
    return outcome.kind === 'unreadable'
        ? outcome.algorithm
            ? checksumUnreadableMessage(outcome.algorithm)
            : HASH_UNREADABLE_MESSAGE
        : describeHashMismatch(outcome);
}
/** 哈希校验通过时写进进度终态与工具返回的固定文案 */
export const HASH_VERIFIED_MESSAGE = 'SHA-256 已校验';
/** 任意算法校验通过时的固定文案 */
export function checksumVerifiedMessage(spec) {
    return `${CHECKSUM_LABELS[spec.algorithm]} 已校验`;
}

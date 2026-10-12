/** 本插件支持的摘要算法（固定 SHA-256，不接受调用方指定算法） */
export declare const HASH_ALGORITHM = "sha256";
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
export declare function normalizeSha256(input: string): string | null;
/**
 * 流式计算文件 SHA-256。
 *
 * 用流而不是 `readFileSync`：官方文档里的东西经常是几百 MB 的安装包 /
 * 模型权重，整份读进内存既慢又可能直接 OOM。
 *
 * @param path 待校验文件路径
 * @returns 小写十六进制摘要；文件不存在 / 读不了时返回 null
 */
export declare function sha256File(path: string): Promise<string | null>;
/** 哈希校验结论 */
export type HashOutcome = 
/** 内容一致：`digest` 是实际算出的摘要，等于调用方给的期望值 */
{
    kind: 'ok';
    digest: string;
}
/** 内容不一致，必须判为失败 */
 | {
    kind: 'mismatch';
    expected: string;
    actual: string;
}
/** 文件读不到，无法计算 —— 退出码 0 却没有可读文件，本身就是异常 */
 | {
    kind: 'unreadable';
};
/**
 * 纯函数：比较期望摘要与实际摘要。不碰文件系统，便于单元测试。
 *
 * @param expected 已归一化的期望摘要（64 位小写十六进制）
 * @param actual 实际算出的摘要；null 表示文件读不到
 */
export declare function verifySha256(expected: string, actual: string | null): HashOutcome;
/**
 * 文件读不到时的固定文案。
 *
 * 定成常量而不是就地拼字符串，理由与 `verify.ts` 里的跳过文案相同：
 * 让「这条路径只能输出这一个值」成为可断言的事实。
 *
 * 为什么带「下一步」：这条路径意味着「下载器说成功了，但产物读不出来」，
 * 用户能做的只有「重跑一次」和「去看路径」两件事，必须写明。
 */
export declare const HASH_UNREADABLE_MESSAGE: string;
/**
 * 摘要不匹配时「下一步做什么」的固定文案。
 *
 * 为什么单列：两个摘要都只说明「不一样」，不说明「谁对」。而摘要不符有两种完全
 * 不同的原因 —— 下载内容被换掉，或调用方给的期望摘要本身写错了（官方文档也可能
 * 印错）。用户必须同时被提示这两条，否则会一直重下同一个坏内容。
 */
export declare const HASH_MISMATCH_NEXT_STEP = "\u4E0B\u4E00\u6B65\uFF1A\u4EA7\u7269\u3001\u534A\u5305\u4E0E\u65C1\u8F66\u6307\u7EB9\u5747\u5DF2\u4FDD\u7559\uFF0C\u53EF\u76F4\u63A5\u91CD\u8DD1\u4E00\u6B21\uFF1B\u82E5\u91CD\u8DD1\u540E\u4ECD\u4E0D\u5339\u914D\uFF0C\u8BF7\u6838\u5BF9\u671F\u671B\u6458\u8981\u662F\u5426\u6284\u9519";
/**
 * 把哈希不一致翻译成给人看的错误信息。
 *
 * 为什么两个摘要**分行**而不是并排一行：两者都是 64 位十六进制，并排放在同一行
 * 时人眼无法定位到底哪一段不同（这恰恰是排查时唯一要看的东西）。分行后每一行
 * 只有一个摘要，可逐行对比，也便于把整行复制去比对。
 */
export declare function describeHashMismatch(outcome: Extract<HashOutcome, {
    kind: 'mismatch';
}>): string;
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
export declare function describeHashFailure(outcome: Exclude<HashOutcome, {
    kind: 'ok';
}>): string;
/** 哈希校验通过时写进进度终态与工具返回的固定文案 */
export declare const HASH_VERIFIED_MESSAGE = "SHA-256 \u5DF2\u6821\u9A8C";

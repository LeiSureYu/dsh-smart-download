/**
 * 落盘校验：下载「退出码 0」之后，确认落盘文件真的等于远端资源长度。
 *
 * 为什么需要这一层（与 0.6.0 的续传 bug 同一类静默失败）：
 * aria2 / curl 的退出码 0 只代表「它自己认为完成了」，不代表字节数对。
 * 实测可复现的错字节场景至少有：
 *   - 服务器提前断开但没报错（连接被代理掐掉）；
 *   - 续传时 Range 起点算错，写入了错位的数据；
 *   - 磁盘写满 / 配额限制，最后一段静默丢弃；
 *   - 镜像站返回了一个「成功」的 HTML 错误页（200 + 短 body）。
 * 这几种都不会有非零退出码，用户只会拿到一个坏文件。
 *
 * 判定规则（保守优先）：
 * 1. 远端长度未知 → 跳过（无法校验总比乱报好）；
 * 2. 服务器实际返回了非 identity 的 Content-Encoding → 跳过，因为探测到的
 *    `contentLength` 是压缩后长度，与 curl / aria2 落盘的未压缩字节数不可比。
 *    0.7.0 实测：fetch 默认带 `accept-encoding: gzip, deflate`，5000 B 的
 *    body 会报 41 B；而 curl / aria2 默认不声明压缩，落盘 5000 B。
 *    （探测侧已强制 `identity`，这一条是对无视该请求头的服务器的兜底。）
 * 3. 本地文件读不到 → 失败（退出码 0 却没文件，本身就是异常）；
 * 4. 字节数不等 → 失败，明确报错，绝不返回 success。
 *
 * 「跳过」为什么必须与「一致」分开（1.0.0 修正）：
 * 0.9.0 之前两者共用 `{ kind: 'ok' }`，调用方无法区分「真的比过字节数」与
 * 「压根没比」。这正是本项目反复出问题的静默失败形态 —— 一个未经测量的下载
 * 看起来和校验通过的下载一模一样。现在跳过是独立分支，带上机器可读的原因
 * （`reason`）与给人看的一句话（`detail`），调用方必须把它写进用户可见的
 * 进度文案里，不允许悄悄放行。
 */
import type { ProbeResult } from './types.js';
/**
 * 规范化 `Content-Encoding` 响应头。
 *
 * 缺失 / 空 / 只含 `identity`（可能是 `identity, identity` —— 实测 Node 24 的
 * undici 在带 `Range` 的请求里会这么发，RFC 语义上仍等于未压缩）都返回
 * undefined；其余返回压缩编码名（如 `gzip`、`br`、`gzip, identity` 归为 `gzip`）。
 */
export declare function normalizeContentEncoding(header: string | null | undefined): string | undefined;
/**
 * 跳过校验的原因（机器可读）。
 * - `remote-length-unknown`：远端没有声明长度，没有基准可比；
 * - `content-encoded`：远端声明了压缩编码，压缩后长度与落盘字节数不可比。
 */
export type VerifySkipReason = 'remote-length-unknown' | 'content-encoded';
/** 校验结论 */
export type VerifyOutcome = 
/** 字节数一致：`actual` 与 `expected` 必然都存在且相等 */
{
    kind: 'ok';
    actual: number;
    expected: number;
}
/**
 * 本次不具备校验条件，未做任何比较。
 * 不是「通过」，也不是「失败」，调用方必须把 `detail` 显式告知用户。
 */
 | {
    kind: 'skipped';
    reason: VerifySkipReason;
    encoding?: string;
}
/** 字节数不一致 / 文件缺失，必须判为失败 */
 | {
    kind: 'mismatch';
    expected: number;
    actual: number | null;
};
/**
 * 跳过校验时回给调用方的一句话（固定文案）。
 *
 * 定成常量而不是就地拼字符串，是为了让「跳过路径只能输出这两个值」成为可断言
 * 的事实：`smart_download` 的 `verifySkipped` 字段与 render 文案都从这里取，
 * 测试断言的也是这两个字面量，改动会被用例拦下。
 */
export declare const VERIFY_SKIP_LENGTH_UNKNOWN = "\u672A\u505A\u5B57\u8282\u6570\u6821\u9A8C\uFF1A\u8FDC\u7AEF\u672A\u58F0\u660E\u6587\u4EF6\u957F\u5EA6";
export declare const VERIFY_SKIP_CONTENT_ENCODED = "\u672A\u505A\u5B57\u8282\u6570\u6821\u9A8C\uFF1A\u8FDC\u7AEF\u58F0\u660E\u4E86\u538B\u7F29\u7F16\u7801";
/** 把跳过原因映射成回给调用方的固定文案 */
export declare function describeSkip(outcome: Extract<VerifyOutcome, {
    kind: 'skipped';
}>): string;
/**
 * 纯函数：比较实际落盘字节数与远端声明长度。
 * 不碰文件系统，便于单元测试。
 *
 * @param actual 实际落盘字节数；null 表示文件不存在 / 不可读
 * @param expected 远端声明的长度；undefined 表示未知
 * @param contentEncoding 探测到的 Content-Encoding（已规范化，identity 视为无）
 */
export declare function verifySize(actual: number | null, expected: number | undefined, contentEncoding?: string): VerifyOutcome;
/** 从探测结果里取出校验所需的期望值与编码信息 */
export declare function expectedFromProbe(probe: ProbeResult): {
    expected: number | undefined;
    contentEncoding: string | undefined;
};
/** 把校验失败翻译成给人看的错误信息 */
export declare function describeMismatch(outcome: Extract<VerifyOutcome, {
    kind: 'mismatch';
}>): string;

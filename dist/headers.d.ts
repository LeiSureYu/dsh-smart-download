/**
 * 自定义请求头：User-Agent / Referer / 任意头，统一喂给探测与下载两条链路。
 *
 * 为什么需要：官方文档里的下载地址经常不是「直接 GET 就能拿到」的。
 * 本仓库自己就记录过一次实测 —— aliyun 镜像对 aria2 的 UA 直接返回 403
 * （README「并发阈值是实测的」一节）。同类情形还有：HuggingFace 门控仓库
 * 需要 `Authorization`、部分 CDN 需要 `Referer`、部分站点对非浏览器 UA 返回
 * 一个 200 的 HTML 错误页。没有出口时这些地址只能失败。
 *
 * 为什么探测与下载必须用**同一套**头（改动前务必先读）：
 * 探测决定了「要不要多线程」与「期望字节数」，而下载是另一个进程
 * （aria2 / curl）发出的真实请求。两边头不一致时会出现两种静默错位：
 *   - 站点按 UA 分流：探测用 Node 默认 UA 拿到 200 + 长度，下载用 aria2 的
 *     UA 拿到 403 —— 决策基于一个下载时根本不成立的响应；
 *   - 站点按 UA 返回不同体积的响应（移动版 / 桌面版页面），期望长度与实际
 *     落盘字节数不等，完整性校验 100% 误报，把正确的下载判成损坏。
 * 因此 `buildRequestHeaders()` 只产出一份头，探测与下载都从它取。
 *
 * 安全边界（这些头**不允许**被调用方覆盖，否则会破坏既有语义）：
 *   - `Range`：续传与分片的判定基础，被覆盖会让 `-C -` 从错误位置续；
 *   - `Accept-Encoding`：探测强制 `identity` 才能拿到与 curl/aria2 可比的
 *     长度（见 src/probe.ts 文件头实测），被改成 gzip 会让校验误报；
 *   - `Content-Length` / `Host` / 连接级头（`Connection` / `Transfer-Encoding`
 *     等）：由传输层决定，调用方覆盖只会产出畸形请求。
 * 命名参数（`userAgent` / `referer`）优先于 `headers` 里的同名项。
 *
 * 值里出现 CR / LF / NUL 一律拒绝：那是**请求头注入**，可以让调用方凭空
 * 往请求里塞新头甚至新请求。
 */
import type { RequestHeaders } from './types.js';
/**
 * 不允许被调用方覆盖的请求头（小写）。
 * 见文件头「安全边界」：它们各自承载着探测 / 续传 / 校验的既有语义。
 */
export declare const RESERVED_HEADERS: readonly string[];
/** 自定义头数量上限（够覆盖真实场景，同时挡住把整个头表塞进来） */
export declare const MAX_HEADER_COUNT = 32;
/** 单个头名长度上限 */
export declare const MAX_HEADER_NAME_LENGTH = 128;
/** 单个头值长度上限（Cookie / Authorization 可能很长，留足余量） */
export declare const MAX_HEADER_VALUE_LENGTH = 8192;
/**
 * 归一化头名成 `X-Foo-Bar` 形式。
 * 只为输出好看与去重稳定；比较一律走 `headerKey()`（小写）。
 */
export declare function normalizeHeaderName(name: string): string;
/** 头名的比较键（小写、去空白） */
export declare function headerKey(name: string): string;
/** 构造请求头的入参 */
export interface RequestHeaderInput {
    /** `User-Agent`；优先于 `headers` 里的同名项 */
    userAgent?: string;
    /** `Referer`；优先于 `headers` 里的同名项 */
    referer?: string;
    /** 任意附加头 */
    headers?: Record<string, unknown> | null;
}
/** 构造结果：成功时给出可直接使用的头表，失败时给出可回给模型的 reason */
export type RequestHeaderResult = {
    ok: true;
    headers: RequestHeaders;
} | {
    ok: false;
    reason: string;
};
/**
 * 把三个入参合成一份请求头。
 *
 * 合并顺序：`headers` 先落，随后 `userAgent` / `referer` 覆盖同名项
 * （命名参数更具体，意图更明确）。同名头只保留一条，避免 curl / aria2 收到
 * 两个 `User-Agent` 时行为随实现而变。
 *
 * @param input 调用方给出的三个入参
 */
export declare function buildRequestHeaders(input: RequestHeaderInput): RequestHeaderResult;
/**
 * 转成 curl 参数：每个头一条 `-H 'Name: value'`。
 *
 * 统一用 `-H` 而不是 `-A` / `-e`：`-A` 与 `-H 'User-Agent: …'` 同时出现时的
 * 优先级由 curl 版本决定，统一成一种写法就不存在这个不确定性。
 */
export declare function headersToCurlArgs(headers: RequestHeaders | undefined): string[];
/**
 * 转成 aria2 参数：每个头一条 `--header=Name: value`。
 * aria2 的 `--header` 可重复，重复项会原样发给服务器。
 */
export declare function headersToAria2Args(headers: RequestHeaders | undefined): string[];
/**
 * 转成 `fetch` 的 headers 入参（探测用）。
 * 探测强制 `accept-encoding: identity`，这里最后合并，确保调用方覆盖不了。
 */
export declare function headersToFetchInit(headers: RequestHeaders | undefined, acceptEncoding: string): Record<string, string>;

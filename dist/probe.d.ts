/**
 * URL 探测逻辑：
 * 1. 优先发 HEAD 请求；
 * 2. 若 HEAD 返回 405 或缺少 Content-Length，改用 GET + Range: bytes=0-0；
 * 3. 根据 Accept-Ranges / 206 状态码与文件大小判定是否值得多线程；
 * 4. 任何探测失败都返回“不支持多线程”，触发 curl 回退。
 *
 * ⚠️ Accept-Encoding（0.7.0 实测，改动前务必先读）：
 * Node 的 `fetch` 默认带 `accept-encoding: gzip, deflate`，于是探测拿到的
 * `Content-Length` 可能是**压缩后**的长度。而真正负责下载的工具
 * —— curl（默认）与 aria2（默认）—— 不声明 / 声明空的 Accept-Encoding，
 * 服务器返回**未压缩**的字节流。实测（真实 body 5000 B、gzip 后 41 B）：
 *   fetch 默认 HEAD -> 41；fetch `identity` -> 5000；curl 默认 -I -> 5000；
 *   curl --compressed -> 41；aria2 默认落盘 -> 5000 B。
 * 因此探测**必须**强制 `accept-encoding: identity`，否则任何支持 gzip 的
 * 服务器都会让 0.7.0 的大小校验 100% 误报（把正确的下载判成损坏）。
 */
import type { ProbeOptions, ProbeResult } from './types.js';
/** 判定函数入参 */
export interface EvaluateInput {
    /** 响应状态码 */
    status: number;
    /** Accept-Ranges 头 */
    acceptRanges?: string | null;
    /** Content-Length 头解析出的长度 */
    contentLength?: number;
    /** Content-Range 头（Range GET 返回 206 时携带） */
    contentRange?: string | null;
    /** 多线程大小阈值 */
    threshold: number;
}
/** 判定函数结果 */
export interface EvaluateResult {
    supported: boolean;
    /** 资源总大小 */
    size?: number;
    reason?: string;
}
/**
 * 远端资源的「内容指纹」。
 *
 * 续传安全校验用它判断「远端资源有没有变」。只用长度是不够的：
 * 实测（0.6.0）远端从 400 字节变成另一个 400 字节时，curl -C - 与 aria2 -c
 * 都是退出码 0，而落盘文件保留着旧内容。
 */
export interface RemoteFingerprint {
    /** ETag（含引号）；最强的内容信号 */
    etag?: string;
    /** Last-Modified；服务器不发 ETag 时的次优信号 */
    lastModified?: string;
}
/**
 * 解析 Content-Range 头中的资源总大小。
 * 形如 "bytes 0-0/5242880" -> 5242880；"bytes 0-0/*" -> undefined。
 */
export declare function parseContentRangeTotal(header: string | null | undefined): number | undefined;
/** 将响应头中的 Content-Length 解析为非负整数 */
export declare function parseContentLength(header: string | null | undefined): number | undefined;
/**
 * 纯判定函数：根据响应状态码与响应头判断是否值得多线程。
 * 单独抽出便于单元测试，不依赖网络。
 */
export declare function evaluateRangeSupport(input: EvaluateInput): EvaluateResult;
/**
 * 探测目标 URL 是否支持多线程下载。
 * 任何异常（超时、网络错误、无法获取大小）都安全地返回不支持，由调用方回退 curl。
 */
export declare function probeUrl(url: string, externalSignal?: AbortSignal, options?: ProbeOptions): Promise<ProbeResult>;

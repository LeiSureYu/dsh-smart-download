/**
 * URL 与输出文件名的安全处理。
 *
 * 为什么单独成模块：`smart_download` 的 URL 常常来自模型读到的网页 / issue /
 * release 页面，属于**不可信输入**。两条攻击面必须在这里堵死：
 *
 * 1. 协议白名单：只允许 http / https。实测（0.4.1）`file:///C:/Windows/win.ini`
 *    会被 curl 接受并成功复制到目标路径 —— 探测阶段失败后回退 curl 的路径
 *    恰好放行了本地文件读取。
 * 2. 文件名净化：`deriveFilenameFromUrl` 直接对 pathname 末段做 URI 解码，
 *    实测（0.4.1）`http://host/..%2F..%2F..%2Fescaped.txt` 解出
 *    `../../../escaped.txt`，最终写到**工作目录之外**。
 *
 * 两个函数都是纯函数，不碰文件系统，便于单测。
 */
/** 允许下载的协议（小写，含冒号，与 URL.protocol 一致）。 */
export declare const SUPPORTED_PROTOCOLS: readonly string[];
/**
 * 文件名最大长度（按 UTF-16 code unit 计）。
 * 取 200：主流文件系统的单段上限是 255 字节，留出空间给扩展名与可能的
 * `name (1)` 之类的去重后缀，同时避免超出路径总长度限制。
 */
export declare const MAX_FILENAME_LENGTH = 200;
/** 推导失败时的兜底文件名。 */
export declare const FALLBACK_FILENAME = "download";
/** 判断 URL 协议是否受支持。 */
export declare function isSupportedProtocol(protocol: string): boolean;
/**
 * 校验待下载 URL：能解析成 URL 且协议在允许列表内。
 *
 * @param rawUrl 调用方传入的原始地址
 * @returns 成功时给出解析后的 URL；失败时给出可直接回给模型的 reason
 */
export declare function checkDownloadUrl(rawUrl: string): {
    ok: true;
    url: URL;
} | {
    ok: false;
    reason: string;
};
/**
 * 把任意字符串净化成**单个路径段**的文件名。
 *
 * 依次处理：路径分隔符与 Windows 非法字符 → 控制字符 → 首尾空白与点 →
 * 保留设备名 → 长度上限。任何一步后结果为空都回退 `download`。
 *
 * @param name 候选文件名（可以是 URI 解码后的原始片段）
 * @returns 保证非空、不含分隔符、不是 `.` / `..` 的单段文件名
 */
export declare function sanitizeFilename(name: string): string;
/**
 * 从 URL 推导本地文件名：
 * 取 pathname 最后一段，做 URI 解码后**再按分隔符切一次**（解码可能把
 * `%2F` 还原成 `/`，从而凭空造出目录层级），最后交给 `sanitizeFilename` 净化。
 * 无法推导时回退为 `download`。
 *
 * @param rawUrl 原始下载地址
 */
export declare function deriveFilenameFromUrl(rawUrl: string): string;

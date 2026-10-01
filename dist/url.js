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
export const SUPPORTED_PROTOCOLS = Object.freeze(['http:', 'https:']);
/**
 * 文件名最大长度（按 UTF-16 code unit 计）。
 * 取 200：主流文件系统的单段上限是 255 字节，留出空间给扩展名与可能的
 * `name (1)` 之类的去重后缀，同时避免超出路径总长度限制。
 */
export const MAX_FILENAME_LENGTH = 200;
/** 推导失败时的兜底文件名。 */
export const FALLBACK_FILENAME = 'download';
/**
 * Windows 保留设备名（不区分大小写，带任意扩展名也算保留）。
 * 在这些名字上创建文件会失败或落到设备上，因此统一加前缀规避。
 */
const RESERVED_WINDOWS_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
/** 控制字符（C0 与 DEL）。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
/**
 * 在 Windows 上非法的文件名字符。
 * 即便当前跑在 Linux 上，也一并替换：同一个 URL 推导出的名字在两个平台上
 * 应当一致，否则「先解析、后落盘」的调用方会看到不同的路径。
 */
const ILLEGAL_CHARS_RE = /[<>:"|?*\\/]/g;
/** 判断 URL 协议是否受支持。 */
export function isSupportedProtocol(protocol) {
    return SUPPORTED_PROTOCOLS.includes(protocol.toLowerCase());
}
/**
 * 校验待下载 URL：能解析成 URL 且协议在允许列表内。
 *
 * @param rawUrl 调用方传入的原始地址
 * @returns 成功时给出解析后的 URL；失败时给出可直接回给模型的 reason
 */
export function checkDownloadUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return { ok: false, reason: `无法解析为 URL：${JSON.stringify(rawUrl)}` };
    }
    if (!isSupportedProtocol(url.protocol)) {
        const allowed = SUPPORTED_PROTOCOLS.map((p) => p.replace(':', '')).join(' / ');
        return {
            ok: false,
            reason: `不支持的协议 ${url.protocol}（仅允许 ${allowed}）`,
        };
    }
    return { ok: true, url };
}
/**
 * 把任意字符串净化成**单个路径段**的文件名。
 *
 * 依次处理：路径分隔符与 Windows 非法字符 → 控制字符 → 首尾空白与点 →
 * 保留设备名 → 长度上限。任何一步后结果为空都回退 `download`。
 *
 * @param name 候选文件名（可以是 URI 解码后的原始片段）
 * @returns 保证非空、不含分隔符、不是 `.` / `..` 的单段文件名
 */
export function sanitizeFilename(name) {
    let out = name
        .replace(ILLEGAL_CHARS_RE, '_')
        .replace(CONTROL_CHARS_RE, '');
    // 去掉首尾的空白与点：Windows 会静默丢弃尾部的点/空格，
    // 前导点会让文件在 Unix 上变成隐藏文件。
    out = out.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
    if (out === '')
        return FALLBACK_FILENAME;
    // 保留设备名：加下划线前缀，保留可读性
    const dotIndex = out.indexOf('.');
    const stem = dotIndex === -1 ? out : out.slice(0, dotIndex);
    if (RESERVED_WINDOWS_NAMES.has(stem.toUpperCase())) {
        out = `_${out}`;
    }
    if (out.length > MAX_FILENAME_LENGTH) {
        out = truncatePreservingExtension(out, MAX_FILENAME_LENGTH);
    }
    return out === '' ? FALLBACK_FILENAME : out;
}
/** 按长度上限截断，尽量保住扩展名（截断后扩展名不能长过整体）。 */
function truncatePreservingExtension(name, limit) {
    const dotIndex = name.lastIndexOf('.');
    // 没有扩展名，或扩展名本身占掉大半（点开头的隐藏文件等），直接硬截断
    if (dotIndex <= 0 || name.length - dotIndex > 20) {
        return name.slice(0, limit);
    }
    const ext = name.slice(dotIndex); // 含前导点
    const keep = limit - ext.length;
    if (keep <= 0)
        return name.slice(0, limit);
    return name.slice(0, keep) + ext;
}
/**
 * 从 URL 推导本地文件名：
 * 取 pathname 最后一段，做 URI 解码后**再按分隔符切一次**（解码可能把
 * `%2F` 还原成 `/`，从而凭空造出目录层级），最后交给 `sanitizeFilename` 净化。
 * 无法推导时回退为 `download`。
 *
 * @param rawUrl 原始下载地址
 */
export function deriveFilenameFromUrl(rawUrl) {
    let last;
    try {
        const u = new URL(rawUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        last = segments[segments.length - 1];
    }
    catch {
        return FALLBACK_FILENAME;
    }
    if (!last)
        return FALLBACK_FILENAME;
    let decoded;
    try {
        decoded = decodeURIComponent(last);
    }
    catch {
        // 非法百分号编码：用原始片段，交给净化处理
        decoded = last;
    }
    // 解码后再切分：`..%2F..%2F..%2Fescaped.txt` 解码成 `../../../escaped.txt`，
    // 此时必须丢掉前面的目录部分，只取最后一段。
    const pieces = decoded.split(/[\\/]+/).filter(Boolean);
    const leaf = pieces[pieces.length - 1];
    if (!leaf)
        return FALLBACK_FILENAME;
    return sanitizeFilename(leaf);
}

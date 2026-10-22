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
 * 为同名冲突生成 `name (1).ext` 形式的候选名。
 *
 * 保留扩展名（下载下来的安装包/压缩包失去扩展名会直接影响使用），并在加上
 * 后缀后仍不超过 `MAX_FILENAME_LENGTH`。纯函数，便于单测。
 *
 * @param name 已净化的文件名
 * @param index 冲突序号，从 1 开始
 */
export function withConflictSuffix(name, index) {
    if (!Number.isInteger(index) || index < 1)
        return name;
    const suffix = ` (${index})`;
    const dotIndex = name.lastIndexOf('.');
    const hasExtension = dotIndex > 0 && name.length - dotIndex <= 20;
    const ext = hasExtension ? name.slice(dotIndex) : '';
    const stem = hasExtension ? name.slice(0, dotIndex) : name;
    const budget = Math.max(1, MAX_FILENAME_LENGTH - suffix.length - ext.length);
    return `${stem.slice(0, budget)}${suffix}${ext}`;
}
/**
 * 从 URL 推导本地文件名：
 * 取 pathname 最后一段，做 URI 解码后**再按分隔符切一次**（解码可能把
 * `%2F` 还原成 `/`，从而凭空造出目录层级），最后交给 `sanitizeFilename` 净化。
 * 无法推导时回退为 `download`。
 *
 * 1.5.0 起优先看 `?filename=` / `?file=` 查询参数：大量下载站（尤其是 PHP 的
 * `download.php?id=1&filename=foo.zip`）把真实文件名放在查询串里，pathname
 * 只有一个 `download.php`。查询参数同样是**不可信输入**，必须走同一个
 * `sanitizeFilename`（路径穿越、保留设备名、长度上限一个都不能少）。
 *
 * @param rawUrl 原始下载地址
 */
export function deriveFilenameFromUrl(rawUrl) {
    let last;
    let queryName = null;
    try {
        const u = new URL(rawUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        last = segments[segments.length - 1];
        // 只认这两个最常见的键；`?name=` 之类太泛，容易把参数值当文件名
        queryName = u.searchParams.get('filename') ?? u.searchParams.get('file');
    }
    catch {
        return FALLBACK_FILENAME;
    }
    // 查询参数优先：`download.php?filename=a.zip` 的 pathname 末段是无意义的
    if (queryName !== null && queryName.trim() !== '') {
        const fromQuery = leafOf(queryName);
        if (fromQuery)
            return sanitizeFilename(fromQuery);
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
    const leaf = leafOf(decoded);
    return leaf ? sanitizeFilename(leaf) : FALLBACK_FILENAME;
}
/**
 * 取一段候选文本的最后一个路径段（解码后的分隔符也要切）。
 * 纯函数，返回 undefined 表示这一段是空的。
 */
function leafOf(text) {
    // 解码后再切分：`..%2F..%2F..%2Fescaped.txt` 解码成 `../../../escaped.txt`，
    // 此时必须丢掉前面的目录部分，只取最后一段。
    const pieces = text.split(/[\\/]+/).filter(Boolean);
    return pieces[pieces.length - 1];
}
/**
 * 从 `Content-Disposition` 响应头里解析文件名。
 *
 * 支持三种现实写法（按优先级）：
 *   1. RFC 5987 / 6266 的 `filename*=UTF-8''%E4%B8%AD%E6%96%87.zip`（带字符集）；
 *   2. 老式 `filename="中文.zip"`（很多服务器直接塞 UTF-8 字节）；
 *   3. 无引号的 `filename=foo.zip`。
 *
 * 为什么值得单独一层：GitHub release 的下载地址形如
 * `…/releases/download/v1.0/`（末段为空）或 `…/download`（无扩展名），
 * 只看 pathname 会得到 `download` 这种既难认又容易互相覆盖的名字，而服务器
 * 其实在 `Content-Disposition` 里给了真名。
 *
 * ⚠️ 返回值**未净化**：调用方必须交给 `sanitizeFilename`。这个头完全由服务器
 * 控制，历史上出现过 `filename="../../etc/passwd"` 这类载荷。
 *
 * @param header 响应头原始值；缺失 / 解析不出时返回 undefined
 */
export function filenameFromContentDisposition(header) {
    if (!header)
        return undefined;
    // 1. RFC 5987：filename*=charset'lang'percent-encoded
    const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
    if (extended) {
        const value = extended[1].trim().replace(/^"(.*)"$/, '$1');
        const parts = /^([^']*)'([^']*)'(.*)$/.exec(value);
        if (parts) {
            const charset = parts[1].trim().toLowerCase();
            const encoded = parts[3];
            try {
                // 只有 UTF-8 与 ISO-8859-1 是现实里见得到的；其它字符集按 UTF-8 试，
                // 解不出来就退回原始串（让 sanitize 去处理），绝不抛错。
                const decoded = decodeURIComponent(encoded);
                if (charset === '' || charset === 'utf-8' || charset === 'iso-8859-1') {
                    const leaf = leafOf(decoded);
                    if (leaf)
                        return leaf;
                }
            }
            catch {
                const leaf = leafOf(encoded);
                if (leaf)
                    return leaf;
            }
        }
    }
    // 2. 普通 filename=，可能带引号
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    if (plain) {
        const raw = (plain[1] ?? plain[2] ?? '').trim();
        if (raw !== '') {
            // 引号内的转义（\" \\）还原；非法百分号编码时保留原样
            const unescaped = raw.replace(/\\(.)/g, '$1');
            let decoded = unescaped;
            try {
                decoded = decodeURIComponent(unescaped);
            }
            catch {
                decoded = unescaped;
            }
            const leaf = leafOf(decoded);
            if (leaf)
                return leaf;
        }
    }
    return undefined;
}

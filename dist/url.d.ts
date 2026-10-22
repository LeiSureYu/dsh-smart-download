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
 * 为同名冲突生成 `name (1).ext` 形式的候选名。
 *
 * 保留扩展名（下载下来的安装包/压缩包失去扩展名会直接影响使用），并在加上
 * 后缀后仍不超过 `MAX_FILENAME_LENGTH`。纯函数，便于单测。
 *
 * @param name 已净化的文件名
 * @param index 冲突序号，从 1 开始
 */
export declare function withConflictSuffix(name: string, index: number): string;
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
export declare function deriveFilenameFromUrl(rawUrl: string): string;
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
export declare function filenameFromContentDisposition(header: string | null | undefined): string | undefined;

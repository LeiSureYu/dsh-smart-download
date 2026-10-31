/**
 * 不允许被调用方覆盖的请求头（小写）。
 * 见文件头「安全边界」：它们各自承载着探测 / 续传 / 校验的既有语义。
 */
export const RESERVED_HEADERS = Object.freeze([
    'range',
    'accept-encoding',
    'content-length',
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authorization',
    'proxy-connection',
]);
/** 自定义头数量上限（够覆盖真实场景，同时挡住把整个头表塞进来） */
export const MAX_HEADER_COUNT = 32;
/** 单个头名长度上限 */
export const MAX_HEADER_NAME_LENGTH = 128;
/** 单个头值长度上限（Cookie / Authorization 可能很长，留足余量） */
export const MAX_HEADER_VALUE_LENGTH = 8192;
/** RFC 7230 的 field-name 字符集（token） */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * 头值里不允许出现的字符：CR / LF / NUL 与其余 C0 控制字符（制表符除外，
 * 它在头值里合法且常见）。
 */
const INVALID_VALUE_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
/**
 * 归一化头名成 `X-Foo-Bar` 形式。
 * 只为输出好看与去重稳定；比较一律走 `headerKey()`（小写）。
 */
export function normalizeHeaderName(name) {
    return name
        .trim()
        .toLowerCase()
        .split('-')
        .map((segment) => (segment ? segment[0].toUpperCase() + segment.slice(1) : segment))
        .join('-');
}
/** 头名的比较键（小写、去空白） */
export function headerKey(name) {
    return name.trim().toLowerCase();
}
/**
 * 校验单个头名。
 * @returns 通过时返回归一化后的名字，否则返回拒绝原因
 */
function checkName(rawName) {
    const trimmed = rawName.trim();
    if (!trimmed)
        return { ok: false, reason: '请求头名不能为空' };
    if (trimmed.length > MAX_HEADER_NAME_LENGTH) {
        return { ok: false, reason: `请求头名过长（上限 ${MAX_HEADER_NAME_LENGTH} 字符）：${trimmed.slice(0, 40)}…` };
    }
    if (!TOKEN_RE.test(trimmed)) {
        return { ok: false, reason: `请求头名含非法字符：${JSON.stringify(trimmed)}` };
    }
    const key = headerKey(trimmed);
    if (RESERVED_HEADERS.includes(key)) {
        return {
            ok: false,
            reason: `请求头 ${normalizeHeaderName(trimmed)} 由插件自身管理，不允许覆盖（会破坏探测 / 续传 / 完整性校验）`,
        };
    }
    return { ok: true, name: normalizeHeaderName(trimmed) };
}
/**
 * 校验单个头值。
 * @returns 通过时返回原值，否则返回拒绝原因
 */
function checkValue(rawValue) {
    if (rawValue.length > MAX_HEADER_VALUE_LENGTH) {
        return { ok: false, reason: `请求头值过长（上限 ${MAX_HEADER_VALUE_LENGTH} 字符）` };
    }
    if (INVALID_VALUE_RE.test(rawValue)) {
        return {
            ok: false,
            reason: '请求头值含换行或控制字符（属于请求头注入，已拒绝）',
        };
    }
    return { ok: true, value: rawValue };
}
/**
 * 把三个入参合成一份请求头。
 *
 * 合并顺序：`headers` 先落，随后 `userAgent` / `referer` 覆盖同名项
 * （命名参数更具体，意图更明确）。同名头只保留一条，避免 curl / aria2 收到
 * 两个 `User-Agent` 时行为随实现而变。
 *
 * @param input 调用方给出的三个入参
 */
export function buildRequestHeaders(input) {
    /** key -> { name, value }，保序 */
    const merged = new Map();
    const put = (rawName, rawValue) => {
        const name = checkName(rawName);
        if (!name.ok)
            return name.reason;
        const value = checkValue(rawValue);
        if (!value.ok)
            return value.reason;
        merged.set(headerKey(name.name), { name: name.name, value: value.value });
        return null;
    };
    const extra = input.headers;
    if (extra !== null && extra !== undefined) {
        if (typeof extra !== 'object' || Array.isArray(extra)) {
            return { ok: false, reason: 'headers 必须是一个「头名 -> 头值」的对象' };
        }
        const entries = Object.entries(extra);
        if (entries.length > MAX_HEADER_COUNT) {
            return { ok: false, reason: `自定义请求头过多（上限 ${MAX_HEADER_COUNT} 条）` };
        }
        for (const [rawName, rawValue] of entries) {
            if (typeof rawValue !== 'string') {
                return { ok: false, reason: `请求头 ${rawName} 的值必须是字符串` };
            }
            const reason = put(rawName, rawValue);
            if (reason)
                return { ok: false, reason };
        }
    }
    // 命名参数覆盖同名项：更具体的意图优先
    if (typeof input.userAgent === 'string' && input.userAgent.trim()) {
        const reason = put('User-Agent', input.userAgent);
        if (reason)
            return { ok: false, reason };
    }
    if (typeof input.referer === 'string' && input.referer.trim()) {
        const reason = put('Referer', input.referer);
        if (reason)
            return { ok: false, reason };
    }
    return { ok: true, headers: Object.fromEntries([...merged.values()].map((e) => [e.name, e.value])) };
}
/**
 * 转成 curl 参数：每个头一条 `-H 'Name: value'`。
 *
 * 统一用 `-H` 而不是 `-A` / `-e`：`-A` 与 `-H 'User-Agent: …'` 同时出现时的
 * 优先级由 curl 版本决定，统一成一种写法就不存在这个不确定性。
 */
export function headersToCurlArgs(headers) {
    if (!headers)
        return [];
    const args = [];
    for (const [name, value] of Object.entries(headers)) {
        args.push('-H', `${name}: ${value}`);
    }
    return args;
}
/**
 * 转成 aria2 参数：每个头一条 `--header=Name: value`。
 * aria2 的 `--header` 可重复，重复项会原样发给服务器。
 */
export function headersToAria2Args(headers) {
    if (!headers)
        return [];
    const args = [];
    for (const [name, value] of Object.entries(headers)) {
        args.push(`--header=${name}: ${value}`);
    }
    return args;
}
/**
 * 是否携带了调用方自定义的头。
 *
 * 判定收口成一个函数：`downloader.ts` 靠它决定「头走 argv（旧行为）还是
 * stdin（1.7.0 起）」。没有自定义头时两条链路的命令行必须与 1.6.0 **逐字节
 * 相同**（既有回归项），因此「没有头」的分支必须精确到「头表为空对象也算没有」。
 */
export function hasCustomHeaders(headers) {
    return headers !== undefined && Object.keys(headers).length > 0;
}
/**
 * 转成 curl `-K -`（从 stdin 读配置）的配置文本。
 *
 * 为什么存在（1.7.0）：`-H 'Authorization: …'` 会把头值放进**进程命令行**，
 * 同一台机器上的任何进程（任务管理器 / `wmic process get commandline` /
 * `ps -ef`）都能读走。改走 stdin 后，凭证只经过管道，不落盘、不进 argv ——
 * README 里「不要把长期凭证写进 headers」的告警由此解除。
 *
 * 格式与转义规则（curl 配置文件语法）：
 *   - 每条头一行：`header = "Name: value"`（等价于命令行的 `-H 'Name: value'`）；
 *   - 双引号内的 `\` 与 `"` 必须转义；头名受 TOKEN_RE 约束不可能含这两类字符，
 *     因此对整段 `Name: value` 统一转义即可；
 *   - CR / LF / NUL 已在 `buildRequestHeaders()` 拒绝，值必然是单行的 ——
 *     这是「一行一头」结构成立的前提，两边必须一起守住。
 */
export function headersToCurlConfig(headers) {
    if (!headers)
        return '';
    const lines = [];
    for (const [name, value] of Object.entries(headers)) {
        const escaped = `${name}: ${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`header = "${escaped}"`);
    }
    return lines.join('\n') + '\n';
}
/**
 * 转成 aria2 `--input-file=-`（从 stdin 读下载列表与 per-download 选项）的文本。
 *
 * 与 curl 同一个动机：`--header` 的值会出现在进程命令行里。aria2 的头是
 * **per-download** 选项，只能挂在 input file 的 URI 条目下 —— 因此 URI 本身
 * 也要搬进 stdin（argv 里不再有 URL，也不再有 `-o`：`out` 作为 input file
 * 的选项与 URI 写在一起，避免「argv 的 -o 与 input file 条目是否配对」这类
 * 由实现细节决定的语义）。
 *
 * 格式（aria2 input file 语法）：
 *   - 第一行：URI，**顶格**（带缩进的行会被当成上一行的选项）；
 *   - 之后每行一个选项，**必须以空白开头**：`out=<文件名>`、`header=<Name>: <value>`。
 *
 * 头值里不能出现换行 —— 与 curl 一样由 `buildRequestHeaders()` 的注入拒绝保证；
 * 头值里出现 `=` 没有问题（aria2 按第一个 `=` 切分名字与值）。
 */
export function headersToAria2InputFile(url, headers, outputName) {
    const lines = [url, `  out=${outputName}`];
    if (headers) {
        for (const [name, value] of Object.entries(headers)) {
            lines.push(`  header=${name}: ${value}`);
        }
    }
    return lines.join('\n') + '\n';
}
/**
 * 转成 `fetch` 的 headers 入参（探测用）。
 * 探测强制 `accept-encoding: identity`，这里最后合并，确保调用方覆盖不了。
 */
export function headersToFetchInit(headers, acceptEncoding) {
    return { ...(headers ?? {}), 'accept-encoding': acceptEncoding };
}

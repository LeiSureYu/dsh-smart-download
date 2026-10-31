/**
 * 代理解析：把「调用方显式传入的 proxy 参数」与「环境变量里的代理」归一成
 * **一个**结果，供探测（probe）与下载（aria2 / curl）三条链路共用。
 *
 * 为什么必须有这一层（1.7.0，改动前务必先读）：
 * 此前本插件对代理完全没有处理，而三个环节各自对代理环境变量的态度**不一致**：
 *   - 探测：Node 的 `fetch`（undici）**不读** HTTP(S)_PROXY —— 企业内网 / 走代理的
 *     环境里探测必然失败，白等一个探测超时；
 *   - aria2：**从不读**代理环境变量（官方手册明示），也不受其影响；
 *   - curl：**会读** http_proxy / https_proxy —— 子进程继承了宿主环境。
 * 三者不一致的净效果是：代理用户的环境里探测失败 → aria2 失败 → curl 靠环境变量
 * 侥幸成功，于是**静默降级到单线程**，且探测结论与真实下载走的是两条网络路径 ——
 * 与「探测与下载必须同构」（src/headers.ts）是同一类错位，只是发生在网络层。
 * 本模块把「用不用代理、用哪个代理」收敛成**一次**解析、三条链路共用同一结果。
 *
 * 取值优先级：
 *   1. 调用方显式传入的 `proxy` 参数（在 preflight 阶段校验，非法直接拒绝）；
 *   2. 环境变量：https 目标查 `HTTPS_PROXY` / `https_proxy`，http 目标查
 *      `HTTP_PROXY` / `http_proxy`，两者都缺时回落 `ALL_PROXY` / `all_proxy`；
 *   3. 都没有 → 直连。
 *
 * `NO_PROXY` / `no_proxy` 始终生效（对显式参数也是）：与 curl 的语义一致 ——
 * `-x` 显式给代理时 `no_proxy` 命中的主机仍然直连。匹配规则见 hostMatchesNoProxy。
 *
 * 两个刻意的边界：
 *   - **只支持 http(s) 代理**。`socks5://` 一类 scheme 对三者的支持参差
 *     （aria2 不支持 SOCKS、undici 需要额外的 SOCKS dispatcher），放行等于把
 *     「三层一致」这个目标重新打破。环境变量里出现不支持的 scheme 时**忽略**
 *     （环境变量是用户的自留地，一个写错的全局变量不该让所有下载直接失败）；
 *     而 `proxy` 参数是调用方的明确意图，非法值在发起任何请求之前抛错。
 *   - 环境变量在**解析时**读取、每条目解析一次：批内各条目可能落在 NO_PROXY 的
 *     不同主机上，逐条解析才能保证每条只走它该走的路径。
 */
/**
 * 校验一个代理值：必须是合法的 http(s) URL 且带主机名。
 * 返回 trim 后的原串 —— 端口缺省时的补全交给消费方（undici / curl / aria2
 * 各自的默认端口语义），这里不做改写。
 */
export function validateProxyValue(raw) {
    const text = raw.trim();
    if (text === '') {
        return { ok: false, reason: '代理地址不能为空' };
    }
    let parsed;
    try {
        parsed = new URL(text);
    }
    catch {
        return { ok: false, reason: `代理地址不是合法的 URL（${JSON.stringify(text)}）` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
            ok: false,
            reason: `代理地址只支持 http(s)（收到 ${JSON.stringify(parsed.protocol)}）` +
                '；SOCKS 等其它代理协议不受支持 —— aria2 / undici 对它们的支持参差，放行会重新打破探测与下载的一致性',
        };
    }
    if (parsed.hostname === '') {
        return { ok: false, reason: `代理地址缺少主机名（${JSON.stringify(text)}）` };
    }
    return { ok: true, url: text };
}
/**
 * `proxy` 参数的 preflight 校验：非法值在发起任何请求之前抛错级别的拒绝。
 * 与 validateProxyValue 的差别只在返回形状（方便 preflight 直接产出文案）。
 */
export function checkProxyParam(raw) {
    const outcome = validateProxyValue(raw);
    if (outcome.ok)
        return outcome;
    return { ok: false, reason: `proxy 参数不合法：${outcome.reason}` };
}
/**
 * 从环境变量里取一个合法的 http(s) 代理地址。
 * 大写与小写变体都查（惯例上大写用于 HTTP 流量、小写两者通吃，这里不做区分）；
 * 取到但校验不过时**忽略**该来源（返回 null），而不是让一个写错的环境变量
 * 打断所有下载。
 */
function proxyFromEnv(names, env) {
    for (const name of names) {
        const value = env[name];
        if (typeof value !== 'string')
            continue;
        const text = value.trim();
        if (text === '')
            continue;
        const outcome = validateProxyValue(text);
        if (outcome.ok)
            return outcome.url;
        // 该环境变量存在但不合法：忽略它，继续看下一个候选（最后可能直连）
    }
    return null;
}
/**
 * 判断目标主机是否命中 NO_PROXY 名单。
 *
 * 规则（与 curl 的 no_proxy 语义对齐，取其常用子集）：
 *   - 名单按逗号分隔、大小写不敏感、空项跳过；
 *   - `*` 命中一切主机；
 *   - 条目可写 `host:port`：此时端口也要相等才命中；不带端口的条目只比主机；
 *   - 前导 `.`（`.example.com`）与裸域名（`example.com`）都做**后缀匹配**：
 *     `example.com` 同时命中 `example.com` 与 `foo.example.com`，不命中
 *     `evilexample.com`；
 *   - 其余按字面比较（含 IP 地址）。IPv6 的 `[::1]` 方括号在比较前剥掉，
 *     名单里的条目同样剥。
 */
export function hostMatchesNoProxy(targetHost, targetPort, list) {
    if (list === undefined)
        return false;
    const host = targetHost.toLowerCase().replace(/^\[|\]$/g, '');
    const port = targetPort.toLowerCase();
    for (const rawEntry of list.split(',')) {
        const entry = rawEntry.trim().toLowerCase().replace(/^\[|\]$/g, '');
        if (entry === '')
            continue;
        if (entry === '*')
            return true;
        // 条目自带端口：主机与端口都要相等（不做后缀匹配 —— 带端口通常就是
        // 想精确指到某一个服务）。判定「是 host:port」必须同时满足：最后一个
        // 冒号之前**不含**冒号（裸 IPv6 如 `::1` 有多个冒号但不是 host:port）、
        // 冒号之后是纯数字。
        const colon = entry.lastIndexOf(':');
        if (colon !== -1 &&
            !entry.slice(0, colon).includes(':') &&
            /^\d+$/.test(entry.slice(colon + 1))) {
            const entryHost = entry.slice(0, colon);
            const entryPort = entry.slice(colon + 1);
            if (host === entryHost && port === entryPort)
                return true;
            continue;
        }
        const bare = entry.startsWith('.') ? entry.slice(1) : entry;
        if (bare === '')
            continue;
        if (host === bare || host.endsWith(`.${bare}`))
            return true;
    }
    return false;
}
/** 各 scheme 对应的环境变量候选（按优先级） */
const ENV_CANDIDATES = {
    https: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'],
    http: ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
};
/**
 * 解析一条下载的生效代理。
 *
 * @param url 本条目的**原始** URL（镜像解析前）——代理由原始主机决定，
 *   镜像主机沿用同一个代理（显式镜像本身就是「另一个入口的同一资源」，
 *   不为它单独解析是刻意简化，行为也更好预测）。
 * @param explicit `proxy` 参数（调用方已在 preflight 校验过，这里直接采用）
 * @param env 环境变量来源（测试注入；生产取 process.env）
 */
export function resolveProxy(url, explicit, env = process.env) {
    let host = '';
    let port = '';
    let isHttps = false;
    try {
        const parsed = new URL(url);
        host = parsed.hostname;
        port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
        isHttps = parsed.protocol === 'https:';
    }
    catch {
        // URL 合法性由 checkDownloadUrl 负责；走到这里的 URL 一定是调用方已校验的
        // http(s) 地址。解析不出来时按直连处理，不在这里抛第二遍。
        return { proxyUrl: null, source: 'none' };
    }
    // NO_PROXY 命中 → 直连。对显式参数同样生效：与 curl 的 -x + no_proxy 语义一致。
    const noProxy = env['no_proxy'] ?? env['NO_PROXY'];
    if (hostMatchesNoProxy(host, port, noProxy)) {
        return { proxyUrl: null, source: 'none' };
    }
    if (explicit !== undefined) {
        return { proxyUrl: explicit, source: 'param' };
    }
    const fromEnv = proxyFromEnv(isHttps ? ENV_CANDIDATES.https : ENV_CANDIDATES.http, env);
    if (fromEnv !== null) {
        return { proxyUrl: fromEnv, source: 'env' };
    }
    return { proxyUrl: null, source: 'none' };
}

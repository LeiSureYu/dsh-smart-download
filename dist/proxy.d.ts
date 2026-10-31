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
/** 一次解析的结果：proxyUrl 为 null 表示直连。 */
export interface ProxyResolution {
    /** 本条目实际使用的代理 URL（原样字符串，如 "http://127.0.0.1:7890"）；直连时为 null */
    proxyUrl: string | null;
    /** 代理来源：显式参数 / 环境变量 / 无（直连） */
    source: 'param' | 'env' | 'none';
}
/** 校验单个代理值（`proxy` 参数与环境变量共用同一套规则）。 */
export type ProxyValidation = {
    ok: true;
    url: string;
} | {
    ok: false;
    reason: string;
};
/**
 * 校验一个代理值：必须是合法的 http(s) URL 且带主机名。
 * 返回 trim 后的原串 —— 端口缺省时的补全交给消费方（undici / curl / aria2
 * 各自的默认端口语义），这里不做改写。
 */
export declare function validateProxyValue(raw: string): ProxyValidation;
/**
 * `proxy` 参数的 preflight 校验：非法值在发起任何请求之前抛错级别的拒绝。
 * 与 validateProxyValue 的差别只在返回形状（方便 preflight 直接产出文案）。
 */
export declare function checkProxyParam(raw: string): {
    ok: true;
    url: string;
} | {
    ok: false;
    reason: string;
};
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
export declare function hostMatchesNoProxy(targetHost: string, targetPort: string, list: string | undefined): boolean;
/**
 * 解析一条下载的生效代理。
 *
 * @param url 本条目的**原始** URL（镜像解析前）——代理由原始主机决定，
 *   镜像主机沿用同一个代理（显式镜像本身就是「另一个入口的同一资源」，
 *   不为它单独解析是刻意简化，行为也更好预测）。
 * @param explicit `proxy` 参数（调用方已在 preflight 校验过，这里直接采用）
 * @param env 环境变量来源（测试注入；生产取 process.env）
 */
export declare function resolveProxy(url: string, explicit: string | undefined, env?: NodeJS.ProcessEnv): ProxyResolution;

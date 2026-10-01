/**
 * 低于该大小不走 aria2（建连/分片开销大于收益）。
 *
 * 依据 0.7.0 受控实测（每连接限速 2MB/s、3 轮取中位数）：
 * 2MB 文件 curl=1.74 MB/s，而 aria2 x=2 就有 3.26 MB/s —— 收益从 1MB 起就很明确。
 * 1MB 以下未测（分片会被 `-k 1M` 的下限截断，本来也开不出多连接），保守维持。
 */
export const SIZE_THRESHOLD = 1 * 1024 * 1024; // 1MB
/**
 * 达到该大小用满 8 连接。
 *
 * 0.7.0 把这一档从 50MB 下调到 8MB，依据是实测：
 *   8MB  x=4 -> 6.26 MB/s   x=8 -> 11.99 MB/s   （差近一倍）
 *   32MB x=4 -> 6.22 MB/s   x=8 -> 12.21 MB/s
 * 也就是说 8~50MB 这一整段长年被压在 4 连接上，白白损失一半速度。
 *
 * 下限定在 8MB 而不是更低：有效并发数受 `-k 1M`（最小分片 1MB）约束，
 * 实测 2MB 文件在 x=2 就到顶（3.26），x=4/8/16 反而略降到 3.1x ——
 * 分片数与文件太小，多出来的连接只剩建连开销。
 */
export const LARGE_FILE = 8 * 1024 * 1024; // 8MB
/**
 * 根据文件大小决定并发档位。
 *
 * 注意 `-k 1M`（见 `buildAria2Args`）是这里的前提：aria2 默认
 * `min-split-size=20M`，小于 20MB 的文件会完全不分片，`-x/-s` 直接失效。
 * 删掉 `-k 1M` 会让下面所有档位静默退化成单连接，务必保留。
 *
 * 不引入 16 连接：实测 32/64MB 下 x=16 确实还能再快一倍（23~24 MB/s），
 * 但保守起见维持 8 上限，避免触发服务器按 IP 限并发。
 */
export function decideConcurrency(size) {
    if (size >= LARGE_FILE)
        return 8;
    return 4;
}
/**
 * 决策函数：除「aria2 缺失」分支的提示文案会带上当前平台外，不依赖外部状态，便于单测。
 *
 * @param probe 探测结果
 * @param aria2Available 随包 aria2c 是否可定位
 * @param env 环境描述，缺省时取 `process.platform` / `process.arch`
 */
export function decide(probe, aria2Available, env = {}) {
    // 1. 不支持多线程 —— 直接 curl
    if (!probe.supportsMultiThread) {
        return {
            method: 'curl',
            concurrency: 1,
            fellback: true,
            reason: probe.reason ?? '探测判定不支持多线程',
        };
    }
    // 2. 拿不到文件大小 —— 保守走 curl
    if (probe.contentLength === undefined) {
        return {
            method: 'curl',
            concurrency: 1,
            fellback: true,
            reason: '无法获取文件大小，保守使用 curl',
        };
    }
    // 3. 文件过小 —— 多线程无收益
    if (probe.contentLength < SIZE_THRESHOLD) {
        const kb = (probe.contentLength / 1024).toFixed(0);
        return {
            method: 'curl',
            concurrency: 1,
            fellback: true,
            reason: `文件仅 ${kb}KB，多线程无收益`,
        };
    }
    // 4. aria2 不可用 —— 回退 curl
    if (!aria2Available) {
        const platform = env.platform ?? process.platform;
        const arch = env.arch ?? process.arch;
        return {
            method: 'curl',
            concurrency: 1,
            fellback: true,
            reason: `未找到 aria2 二进制（当前平台 ${platform}-${arch} 不受支持或子包未安装）`,
        };
    }
    // 5. 支持多线程且 aria2 可用 —— 走 aria2，按大小分档
    const concurrency = decideConcurrency(probe.contentLength);
    const mb = (probe.contentLength / 1024 / 1024).toFixed(1);
    return {
        method: 'aria2',
        concurrency,
        fellback: false,
        reason: `支持 Range，文件 ${mb}MB，使用 ${concurrency} 连接`,
    };
}

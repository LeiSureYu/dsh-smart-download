/**
 * 用户偏好（目前只有「默认下载连接数」一项）。
 *
 * 为什么单独存一份文件而不是塞进进度目录：进度记录按会话/任务分桶且会被 cleanup 扫掉，
 * 偏好是**跨会话、跨任务**的长期设置，生命周期完全不同。放在 `<DSH_HOME>/smart-dl-prefs.json`
 * （与吞吐缓存的落点同级），升级插件不会被覆盖，清理下载历史也不会把它带走。
 *
 * 设计上的两条硬约束：
 *   1. **读失败绝不影响下载**。文件不存在、被写坏、权限不对 —— 一律当作「没设置」返回 auto。
 *      一个可选的加速偏好没有资格让下载失败。
 *   2. **写失败必须如实报告**。界面点选是用户明确表达的动作，静默丢失会让人以为设好了、
 *      下次却按别的数字下载。所以 writePrefs() 返回 ok/message，由调用方决定怎么显示。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseConnections, MIN_CONNECTIONS, MAX_CONNECTIONS } from './decision.js';
/** 偏好文件的落点：`$DSH_HOME/smart-dl-prefs.json`（`DSH_HOME` 缺省为 `~/.dsh`）。 */
export function prefsPath() {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
    return join(home, 'smart-dl-prefs.json');
}
/** 空偏好：字段全缺省，等价于插件 1.6.0 的行为。 */
export function emptyPrefs() {
    return { connections: 'auto' };
}
/**
 * 把磁盘上的原始对象规整成合法偏好。
 *
 * 越界的 connections **丢弃而不是整份拒绝**：偏好文件是「锦上添花」的东西，
 * 用户手改错一个数字不该让整份偏好失效（其它字段将来还会有）。
 *
 * @param raw JSON.parse() 的结果（任意形状）
 */
export function normalizePrefs(raw) {
    const prefs = emptyPrefs();
    if (!raw || typeof raw !== 'object')
        return prefs;
    const parsed = parseConnections(raw.connections);
    if (parsed === 'auto' || typeof parsed === 'number')
        prefs.connections = parsed;
    return prefs;
}
/**
 * 读磁盘上的**原始**对象，不做字段投影。
 *
 * 只有 writePrefs 用它：写回时必须保留自己不认识的字段，否则「降级到旧版本再
 * 升级回来」会静默丢掉新版本写下的配置（1.6.0 → 1.7.0 时真的发生过一次：
 * 注释写着「保留其它字段」，实现却基于投影后的快照展开，未知字段全被擦掉）。
 */
function readRaw(file) {
    try {
        if (!existsSync(file))
            return {};
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
/** 读偏好。任何异常都归为「没设置」——见文件头第 1 条约束。 */
export function readPrefs(file = prefsPath()) {
    return normalizePrefs(readRaw(file));
}
/**
 * 写偏好（只覆盖已知字段，保留文件里其它字段）。
 *
 * @param patch 要改的字段，目前只认 `connections`
 * @param file 覆盖落点（测试注入）
 */
export function writePrefs(patch, file = prefsPath()) {
    // 回带（以及失败时的 current）必须是**投影后**的已知字段，调用方只认这些；
    // 而落盘基底用原始对象，未知字段因此得以保留 —— 两者是不同用途，不能合成一份。
    const current = readPrefs(file);
    const next = { ...readRaw(file) };
    if (patch && 'connections' in patch) {
        const parsed = parseConnections(patch.connections);
        if (parsed === null) {
            return {
                ok: false,
                prefs: current,
                error: `连接数必须是 ${MIN_CONNECTIONS}~${MAX_CONNECTIONS} 之间的整数，或 auto；` +
                    `收到 ${JSON.stringify(patch.connections)}`,
            };
        }
        // `undefined`（= 传了字段但没给值）按 auto 处理：界面清空下拉时就是这个形状
        next.connections = parsed ?? 'auto';
    }
    try {
        mkdirSync(dirname(file), { recursive: true });
        // 先写临时文件再 rename：宿主进程被强杀时不会留下半截 JSON
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        renameSync(tmp, file);
        return { ok: true, prefs: normalizePrefs(next) };
    }
    catch (error) {
        return {
            ok: false,
            prefs: current,
            error: `偏好写入失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 生效的连接数：显式入参 > 用户偏好 > auto。
 *
 * 这个优先级是「临时指令压过默认值」的全部实现：用户在对话里说「这次用 4」就走第一个分支，
 * 什么都没说才回落到界面里选的那个数。
 *
 * @param explicit 调用方显式点名的值（`parseConnections()` 的结果）；`auto` 也算显式
 * @param file 覆盖偏好落点（测试注入）
 */
export function effectiveConnections(explicit, file) {
    // 只有 undefined（真的没传）才回落；显式的 'auto' 是用户的明确选择，不该被偏好覆盖
    if (explicit !== undefined)
        return explicit;
    const prefs = readPrefs(file);
    return prefs.connections ?? 'auto';
}

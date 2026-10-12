/**
 * download_status：读取本插件写下的进度文件，给出任务快照。
 *
 * 只读两条既有轨道（与 ProgressReporter 写的目录完全一致）：
 * - 轨道一：$DSH_PROGRESS_DIR/<taskId>.jsonl，缺省
 *           <session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl
 *           （dsh-task-progress 格式，append-only）
 * - 轨道二：$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json 或
 *           <DSH_HOME>/downloads/tasks/<taskId>.json（本插件自有格式，整体覆盖写）
 *
 * 设计约束：
 * - 纯只读，绝不写文件、绝不联网；
 * - 任何读取失败（目录不存在 / 权限 / 内容损坏）都退化为“该任务不出现在结果里”，
 *   整个调用仍然成功返回，只是任务列表更短；
 * - 任务按 updatedAt 倒序，最新的排在最前。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDownloadProgressDir, resolveTaskProgressDir, } from './progress.js';
/** 默认返回条数 */
export const DEFAULT_STATUS_LIMIT = 10;
/**
 * 上限条数。
 *
 * 与 `DEFAULT_STATUS_LIMIT` 放在一起，是因为两者原本分散在两个文件里
 * （默认值在 `status.ts`，「夹到 50」硬编码在 `rpc.ts` 的 `readPayload`），
 * 改了一个忘了另一个就会出现「RPC 认为上限是 50、工具认为不是」的偏差。
 * 两个调用方（`readPayload` 与 `readDownloadStatus`）现在共用这一个常量。
 */
export const MAX_STATUS_LIMIT = 50;
/** 兜底字符串：schema 要求 string 类型，缺省时不能写 undefined */
const EMPTY = '';
/** 只保留受支持的字符串字段，且必须返回 string（不能是 undefined / null） */
function str(value) {
    return typeof value === 'string' ? value : EMPTY;
}
/** 解析 JSONL 的最后一行有效记录 */
function readLastJsonlLine(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    }
    catch {
        return null;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object')
                return parsed;
        }
        catch {
            // 半截行 / 损坏行：继续往上一行找
            continue;
        }
    }
    return null;
}
/**
 * 判定任务状态。
 *
 * 优先读进度记录里显式的 `state` 字段（dsh-task-progress 的协议字段，
 * `running` / `done` / `failed` / `cancelled`）；老版本进度文件没有该字段，
 * 此时回退到按文案与百分比推断，保证向后兼容。
 */
function statusFrom(pct, msg, state) {
    if (state === 'done')
        return 'completed';
    if (state === 'failed')
        return 'failed';
    if (state === 'cancelled')
        return 'cancelled';
    if (state === 'running')
        return 'running';
    // 无 state（0.5.0 之前的进度文件）：按文案与百分比兜底
    if (msg.includes('失败'))
        return 'failed';
    if (msg.includes('完成') || pct >= 100)
        return 'completed';
    return 'running';
}
/**
 * 收集一个目录下的任务快照（.jsonl 或 .json）。
 *
 * @param dir 待扫描目录
 * @param ext 该目录下的进度文件后缀
 * @param onScanError 目录读不到时回调（收到目录路径）。**必须由调用方透出**：
 *   此前这里静默 `return out`，于是「权限不足 / 路径不存在 / 磁盘故障」与
 *   「目录里确实没有任务」产出同一个空 Map —— 一次失败的查询看起来和一次干净的
 *   空查询完全一样，正是本项目反复出问题的静默失败形态。
 */
function collectFromDir(dir, ext, onScanError) {
    const out = new Map();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        onScanError?.(dir);
        return out;
    }
    for (const name of entries) {
        if (!name.endsWith(ext))
            continue;
        const id = name.slice(0, -ext.length);
        if (!id)
            continue;
        const file = path.join(dir, name);
        let mtimeMs = 0;
        try {
            mtimeMs = fs.statSync(file).mtimeMs;
        }
        catch {
            // 拿不到 mtime 就用 0，仍会排在最末
        }
        if (ext === '.jsonl') {
            const rec = readLastJsonlLine(file);
            if (!rec)
                continue;
            const pct = Number.isFinite(rec.pct) ? Math.max(0, Math.min(100, rec.pct)) : 0;
            const msg = str(rec.msg);
            out.set(id, {
                id,
                name: str(rec.name),
                pct,
                msg,
                status: statusFrom(pct, msg, rec.state),
                spd: str(rec.spd),
                eta: str(rec.eta),
                // 老记录没有 batch：`str()` 收敛成空串，解析结果与 1.2.0 逐字段相同
                batch: str(rec.batch),
                updatedAt: mtimeMs,
            });
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object')
            continue;
        const rec = parsed;
        const rawProgress = Number(rec.progress);
        const pct = Number.isFinite(rawProgress)
            ? Math.max(0, Math.min(100, Math.round(rawProgress * 100)))
            : 0;
        const statusRaw = rec.status;
        const status = statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'cancelled'
            ? statusRaw
            : 'running';
        const updatedRaw = Number(rec.updatedAt);
        out.set(id, {
            id,
            name: str(rec.name),
            pct,
            // 轨道二没有独立的状态文案，沿用旧行为用任务名兜底
            msg: str(rec.name),
            status,
            spd: str(rec.speed),
            eta: str(rec.eta),
            // 与轨道一同理：老任务文件没有 batch 时为 ''
            batch: str(rec.batch),
            updatedAt: Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : mtimeMs,
        });
    }
    return out;
}
/**
 * 读取下载任务进度快照。
 *
 * 只做只读扫描；两条轨道任一不可用都跳过，**但跳过不再静默** ——
 * 读不到的目录会被收进 `scanFailedDirs`，两个都读不到时 `ok` 为 `false`。
 *
 * @param limit 最多返回多少个任务，默认 10
 * @param taskId 指定任务 ID 时只返回该任务
 * @param session 当前会话；用于定位轨道一的目录（缺省时轨道一目录为 null）
 */
export function readDownloadStatus(limit = DEFAULT_STATUS_LIMIT, taskId, session) {
    const taskDir = resolveTaskProgressDir(session);
    const downloadDir = resolveDownloadProgressDir();
    const scanFailedDirs = [];
    const noteScanError = (dir) => {
        scanFailedDirs.push(dir);
    };
    const merged = new Map();
    // 先铺轨道二（JSON，含明确的 status/updatedAt），再用轨道一（JSONL，含 msg/spd/eta）覆盖补充
    for (const [id, task] of collectFromDir(downloadDir, '.json', noteScanError)) {
        merged.set(id, task);
    }
    if (taskDir) {
        for (const [id, task] of collectFromDir(taskDir, '.jsonl', noteScanError)) {
            const existing = merged.get(id);
            // 轨道一的 name / batch 可能为空（老版本进度文件没有这些字段），此时保留
            // 轨道二给出的值：与 name 完全同一个理由 —— 让「老文件 + 新文件」合并后
            // 仍然拿得到较新的那个轨道已经写下来的信息。
            merged.set(id, existing
                ? {
                    ...existing,
                    ...task,
                    name: task.name || existing.name,
                    batch: task.batch || existing.batch,
                }
                : task);
        }
    }
    let tasks = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (taskId)
        tasks = tasks.filter((t) => t.id === taskId);
    const total = tasks.length;
    const cap = Number.isFinite(limit) && limit > 0
        ? Math.min(MAX_STATUS_LIMIT, Math.floor(limit))
        : DEFAULT_STATUS_LIMIT;
    tasks = tasks.slice(0, cap);
    // 只有「两个目录都读不到」才判失败：那时调用方拿到的空列表是**无信息**的，
    // 必须能与「扫过了、确实没有任务」区分开。没有会话上下文时 taskDir 为 null
    // （轨道一压根不参与扫描），因此不构成失败 —— 那是正常的单轨模式。
    const scannedDirs = taskDir ? 2 : 1;
    const ok = scanFailedDirs.length < scannedDirs;
    // taskDir 可能是 null（没有会话上下文且未设 DSH_PROGRESS_DIR）；schema 要求
    // string，因此统一收敛成空串，避免 download_status 因类型不合法而报错。
    // scanFailedDirs 只在有失败时出现：正常路径上返回结构与收紧前逐字段相同。
    return {
        ok,
        taskDir: taskDir ?? '',
        downloadDir,
        total,
        tasks,
        ...(scanFailedDirs.length > 0 ? { scanFailedDirs } : {}),
    };
}

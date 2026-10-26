import type { ParsedConnections } from './decision.js';
/**
 * 偏好形状。
 *
 * `connections` 用 `ParsedConnections`（含 `undefined`）而不是 `number | 'auto'`：
 * 磁盘上缺这个字段时必须能表达「没设置」这个状态，而不是被迫伪造一个 auto
 * —— 两者在 schema 层是同一个行为，但在「用户到底选过没有」这件事上不是一回事。
 */
export interface Prefs {
    /** 默认下载连接数；`undefined` 与 `'auto'` 行为一致（自动分档） */
    connections?: ParsedConnections;
}
/** 写偏好的结果。失败时一并带回当前（未被污染的）偏好，供界面回显。 */
export type WriteResult = {
    ok: true;
    prefs: Prefs;
} | {
    ok: false;
    prefs: Prefs;
    error: string;
};
/** 偏好文件的落点：`$DSH_HOME/smart-dl-prefs.json`（`DSH_HOME` 缺省为 `~/.dsh`）。 */
export declare function prefsPath(): string;
/** 空偏好：字段全缺省，等价于插件 1.6.0 的行为。 */
export declare function emptyPrefs(): Prefs;
/**
 * 把磁盘上的原始对象规整成合法偏好。
 *
 * 越界的 connections **丢弃而不是整份拒绝**：偏好文件是「锦上添花」的东西，
 * 用户手改错一个数字不该让整份偏好失效（其它字段将来还会有）。
 *
 * @param raw JSON.parse() 的结果（任意形状）
 */
export declare function normalizePrefs(raw: unknown): Prefs;
/** 读偏好。任何异常都归为「没设置」——见文件头第 1 条约束。 */
export declare function readPrefs(file?: string): Prefs;
/**
 * 写偏好（只覆盖已知字段，保留文件里其它字段）。
 *
 * @param patch 要改的字段，目前只认 `connections`
 * @param file 覆盖落点（测试注入）
 */
export declare function writePrefs(patch: Prefs, file?: string): WriteResult;
/**
 * 生效的连接数：显式入参 > 用户偏好 > auto。
 *
 * 这个优先级是「临时指令压过默认值」的全部实现：用户在对话里说「这次用 4」就走第一个分支，
 * 什么都没说才回落到界面里选的那个数。
 *
 * @param explicit 调用方显式点名的值（`parseConnections()` 的结果）；`auto` 也算显式
 * @param file 覆盖偏好落点（测试注入）
 */
export declare function effectiveConnections(explicit: ParsedConnections, file?: string): ParsedConnections;

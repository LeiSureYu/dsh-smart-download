/**
 * dsh-smart-dl — browser half.
 *
 * A frame-wide progress pill in the `shell.overlay` list slot: it polls the
 * Host RPC endpoint `smartdl.status` (registered by `src/rpc.ts`) and renders
 * the live state of the downloads started by `smart_download`.
 *
 * This file is a CLASSIC script, not an ES module: the DSH web shell loads
 * plugin bundles through `window.__ModuleLoader__.load({ id, factory })` and
 * hands the factory a `require` restricted to the shipped module whitelist
 * (react, react/jsx-runtime, ...). It is copied verbatim into `dist/` by the
 * build script — no bundler, no JSX (plain `React.createElement`).
 */
window.__ModuleLoader__.load({
	id: '@leisureyu/dsh-smart-dl',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');

		/** Dictionary namespace owned by this plugin. */
		const NS = 'smartdl';
		/** Shared API carrier path; must match `API_PATH` in src/rpc.ts. */
		const API_PATH = '/api';
		/** Endpoint owned by src/rpc.ts. */
		const STATUS_ENDPOINT = 'smartdl.status';
		/**
		 * Endpoint owned by src/rpc.ts (t31): the download manager's read/write face.
		 *
		 * One endpoint with an `op` discriminator, exactly like the design note in
		 * `docs/PLAN-DLMANAGER.md` §4.3 — a second endpoint name would buy nothing
		 * and double the route surface. Ops: `inspect` (does the file still exist,
		 * and is it still the one we downloaded), `forget` (drop the record),
		 * `delete` (drop the record and, when confirmed, the file too).
		 */
		const MANAGE_ENDPOINT = 'smartdl.manage';
		/**
		 * Sidebar entry + main-panel id.
		 *
		 * Deliberately namespaced: `plugins` / `settings` are the Host's own panel
		 * ids, and `main` is a **keyed** slot — a collision would either throw on
		 * `selectPanel` or silently replace someone else's page.
		 */
		const PANEL_ID = 'smartdl.downloads';
		/**
		 * How many tasks the pill asks for.
		 *
		 * 50 = the Host's `MAX_STATUS_LIMIT` (src/status.ts): asking for more is
		 * silently clamped there, so a larger number here would only look like it
		 * did something. A batch call (路线 A) can finish more than 5 tasks in one
		 * turn, and the point of stopping at 5 was that the panel could not show
		 * more than a handful — the panel now caps its own height and scrolls,
		 * so the request no longer has to be the thing that hides tasks.
		 */
		const STATUS_LIMIT = 50;
		/** Poll cadence while the panel is mounted. */
		const POLL_INTERVAL_MS = 2000;
		/**
		 * How long a *single* finished row stays in the compact auto view, so the
		 * user sees the outcome of a task that ended while others keep running.
		 *
		 * Kept separate from `AUTO_HIDE_DONE_MS` on purpose: this one is per row
		 * (a receipt among live rows), the other is the whole panel's lifetime
		 * after everything settled. They happen to share the value 5s because the
		 * user asked for "a few seconds after it finishes" for both, but a later
		 * tweak to one must not silently move the other — hence two names.
		 */
		const FINISHED_HOLD_MS = 5000;
		/**
		 * How long the auto layer keeps showing after **every** task settled
		 * (user decision: it used to be 30s, now 5s).
		 *
		 * Measured from the newest `updatedAt`: the reporter writes a terminal
		 * record when a task ends, so "newest update" is when the last task
		 * finished. See FINISHED_HOLD_MS for why this is not the same constant.
		 */
		const AUTO_HIDE_DONE_MS = 5000;
		/**
		 * 批量合流窗口：一批同时结束的任务只响一次。
		 *
		 * 1 秒 ≈ 半个轮询周期（POLL_INTERVAL_MS = 2000），批量下载的多条通常在
		 * 同一个 tick 里一起变成终态；窗口内再来一条不会另响一声，只把音色升级
		 * 成失败（见 createTerminalAnnouncer）。
		 */
		const SOUND_COALESCE_MS = 1000;
		/** 静音开关的存储键；值 '1' = 静音。 */
		const MUTE_STORAGE_KEY = 'dsh-smart-dl.muted';
		/**
		 * 两段合成音的参数。刻意在**四个维度**上都不像对方，隔着一台笔记本的
		 * 小喇叭也分得清：
		 *
		 *   成功（sine，上行 E5 → B5，每音 110ms，峰值 0.05）
		 *     —— 正弦最干净、上行的收尾是「松开」的感觉；短而轻，不打扰。
		 *   失败（triangle，下行 G4 → C4，每音 170ms，峰值 0.06）
		 *     —— 三角波谐波更多、音更「糙」；下行 + 每个音拖长 55% 表达
		 *        「没成，希望你来看一眼」。
		 *
		 * 只用 OscillatorNode + GainNode（各音自带包络，避免开断的咔哒声），
		 * 不引入任何音频资源：客户端插件以单个 dist/client.js 下发，加资源就得
		 * 再开一条下发通道。
		 */
		const SOUND_PROFILES = {
			success: { wave: 'sine', notes: [659.25, 987.77], noteMs: 110, peak: 0.05 },
			failure: { wave: 'triangle', notes: [392.0, 261.63], noteMs: 170, peak: 0.06 },
		};
		/**
		 * Cap on the panel body height. 50 rows would otherwise grow taller than
		 * the viewport; the cap keeps the pill a pill and lets the rows scroll.
		 */
		const PANEL_MAX_HEIGHT = 260;
		/**
		 * Failure text kept in full on one line. It is rendered in a wrapping
		 * block (not an ellipsis row), so this only guards against a runaway
		 * stderr blob pushing the progress bar off screen.
		 */
		const FAILURE_TEXT_LIMIT = 240;
		/**
		 * The status word `ProgressReporter.fail()` puts in front of the reason
		 * (`src/progress.ts`). It is stripped for display because the row already
		 * says 失败 and the two words together read as "Failed: 失败: …".
		 */
		const FAILED_MSG_PREFIX = '失败:';
		/**
		 * A task still marked `running` whose progress file has not been touched
		 * for this long is treated as dead: the DSH process that owned it is gone
		 * (crash, killed turn, machine restart), so showing it forever would leave
		 * a permanently stuck pill. The reporter writes on every whole-percent
		 * change, which even a slow transfer hits far more often than this, so a
		 * file this quiet means nothing is driving it anymore.
		 */
		const STALE_RUNNING_MS = 10 * 60 * 1000;
		/** Overlay entry id; also the React key and the CSS class suffix. */
		const ENTRY_ID = 'smartdl.progress';
		/**
		 * Header entry id. **Removed in the download-manager rework (t32)**: the
		 * session header was the wrong place — a download manager is a global,
		 * cross-session concern, and the sidebar is where the Host puts those
		 * (jobs / plugins / settings). Kept as a named constant so the removal is
		 * one line and greppable, rather than a silently vanished string.
		 */
		const ENTRY_BUTTON_ID = 'smartdl.progress-entry';

		const zh = {
			'title': '下载任务',
			'running': '下载中',
			'completed': '已完成',
			'failed': '失败',
			'cancelled': '已取消',
			'eta': '剩余 {eta}',
			'untitled': '未命名任务',
			'entry': '下载面板',
			'close': '关闭下载面板',
			'empty': '暂无下载任务',
			'sound': '完成提示音',
			/* ---- t32 下载管理器 ---- */
			'panel': '下载管理',
			'panelClose': '返回会话',
			'reveal': '在文件夹中显示',
			'revealDisabled': '文件已不在原位置',
			'revealFailed': '打不开文件夹位置（宿主未提供 remote.session，或路径已不可用）',
			'deleteRecord': '删除记录',
			'confirmTitle': '删除这条下载记录？',
			'confirmRecordOnly': '只删除记录',
			'confirmWithFile': '同时删除本地文件',
			'confirmCancel': '取消',
			'confirmIrreversible': '删除本地文件不可恢复，不进回收站。',
			'confirmPath': '路径',
			'confirmSize': '大小',
			'confirmPresenceMissing': '文件已不在原位置（可能被移动或重命名），只能删除记录。',
			'confirmPresenceChanged': '文件与下载完成时不一致（大小或修改时间已变），只能删除记录。',
			'confirmPresenceBlocked': '该路径不是普通文件（目录或符号链接），只能删除记录。',
			'confirmPresenceUnknown': '这条记录没有保存输出路径（更早版本的任务），只能删除记录。',
			'presenceMissing': '文件已移走',
			'presenceChanged': '文件已改变',
			'presenceBlocked': '路径不可删',
			'presenceUnknown': '无路径记录',
			'presencePresent': '文件在原位',
			'updatedAt': '最近更新',
			'sizeUnknown': '大小未知',
			'deleteReasonGone': '本地文件已不在原位置（记录已删除）',
			'deleteReasonBusy': '本地文件暂时无法删除（可能正被占用，或磁盘只读）',
			'deleteReasonDenied': '本地文件删除被拒绝（权限不足）',
			'deleteReasonIsDir': '该路径是目录，不能按文件删除',
			'deleteReasonIsLink': '该路径是符号链接，为安全起见不删除',
			'deleteReasonChanged': '本地文件与下载完成时不一致（可能已被替换），为安全起见不删除',
			'deleteReasonNoPath': '这条记录没有保存输出路径，只能删除记录',
			'deleteReasonRunning': '下载仍在进行，未删除',
			'actionFailed': '操作失败',
		};

		const en = {
			'title': 'Downloads',
			'running': 'Downloading',
			'completed': 'Completed',
			'failed': 'Failed',
			'cancelled': 'Cancelled',
			'eta': 'ETA {eta}',
			'untitled': 'Untitled task',
			'entry': 'Download panel',
			'close': 'Close download panel',
			'empty': 'No downloads yet',
			'sound': 'Completion sound',
			/* ---- t32 download manager ---- */
			'panel': 'Downloads',
			'panelClose': 'Back to chat',
			'reveal': 'Show in folder',
			'revealDisabled': 'File is no longer where it was downloaded',
			'revealFailed': 'Could not show it in a folder (the host has no remote.session, or the path is unusable)',
			'deleteRecord': 'Delete record',
			'confirmTitle': 'Delete this download record?',
			'confirmRecordOnly': 'Delete record only',
			'confirmWithFile': 'Also delete the local file',
			'confirmCancel': 'Cancel',
			'confirmIrreversible': 'Deleting the local file is permanent — it does not go to the recycle bin.',
			'confirmPath': 'Path',
			'confirmSize': 'Size',
			'confirmPresenceMissing': 'The file is no longer at its original location (moved or renamed); only the record can be deleted.',
			'confirmPresenceChanged': 'The file no longer matches what was downloaded (size or mtime changed); only the record can be deleted.',
			'confirmPresenceBlocked': 'That path is not a regular file (a directory or a symlink); only the record can be deleted.',
			'confirmPresenceUnknown': 'This record has no saved output path (from an earlier version); only the record can be deleted.',
			'presenceMissing': 'file moved',
			'presenceChanged': 'file changed',
			'presenceBlocked': 'path not deletable',
			'presenceUnknown': 'no path recorded',
			'presencePresent': 'file in place',
			'updatedAt': 'Last update',
			'sizeUnknown': 'size unknown',
			'deleteReasonGone': 'The local file is no longer where it was (record deleted)',
			'deleteReasonBusy': 'The local file could not be deleted right now (it may be in use, or the disk is read-only)',
			'deleteReasonDenied': 'Deleting the local file was denied (insufficient permissions)',
			'deleteReasonIsDir': 'That path is a directory and cannot be deleted as a file',
			'deleteReasonIsLink': 'That path is a symbolic link; for safety it was not deleted',
			'deleteReasonChanged': 'The local file no longer matches what was downloaded (it may have been replaced); for safety it was not deleted',
			'deleteReasonNoPath': 'This record has no saved output path; only the record could be deleted',
			'deleteReasonRunning': 'The download is still running; nothing was deleted',
			'actionFailed': 'Action failed',
		};

		/**
		 * Required services (cordis fiber inject).
		 *
		 * `remote.session` is what makes "show in folder" possible: it carries
		 * `openWorkspacePath({ path, action: 'reveal' })`, which the Host maps to
		 * `explorer.exe /select,<file>` on Windows, `open -R` on macOS and
		 * `xdg-open <dir>` on Linux. It is a **service** dependency (the same
		 * mechanism `slots` / `locale` / `connection` already use), not a module
		 * whitelist entry — several official client plugins declare it verbatim.
		 *
		 * `layout` is what opens/closes the panel (`selectPanel(id)`).
		 *
		 * Both are read defensively at the call site: a profile without them
		 * degrades to "no reveal button" / "no panel", never to a crash.
		 */
		const inject = ['slots', 'locale', 'connection', 'remote.session', 'layout'];

		/** Statuses rendered as a live bar; the rest are receipts. */
		function isLive(task, now) {
			return task.status === 'running' && now - task.updatedAt < STALE_RUNNING_MS;
		}

		/** Keep a finished task on screen briefly so the user sees the outcome. */
		function isRecentReceipt(task, now) {
			return task.status !== 'running' && now - task.updatedAt < FINISHED_HOLD_MS;
		}

		/**
		 * A task that is no longer worth watching in the auto view: terminal, or
		 * `running` but stale (its writer is gone, see STALE_RUNNING_MS).
		 */
		function isSettled(task, now) {
			return !isLive(task, now);
		}

		/** Newest `updatedAt` in the snapshot (0 when there is nothing). */
		function newestUpdate(tasks) {
			let newest = 0;
			for (const task of tasks) {
				if (task.updatedAt > newest) newest = task.updatedAt;
			}
			return newest;
		}

		/**
		 * Can the local file still be deleted *together with* the record?
		 *
		 * The rule is the user's own: "取决于下载好的东西还在不在原文件夹…
		 * 如果移走便只有删除记录". So the answer comes straight from the Host's
		 * `inspect` verdict, and only `present` earns the destructive option:
		 *
		 *   present  → both options (the file is there and it is still ours)
		 *   missing  → record only (moved / renamed / deleted)
		 *   changed  → record only (size or mtime moved: that is someone else's
		 *              file now, and deleting it would be destroying data we do
		 *              not own — the Host refuses it too, R6)
		 *   blocked  → record only (a directory or a symlink sits at that path)
		 *   unknown  → record only (an older record with no saved path)
		 *
		 * Written as a whitelist of one rather than a blacklist of four on
		 * purpose: a future sixth verdict must fail closed, and the next reader
		 * does not have to enumerate which failures were thought of.
		 *
		 * @param presence - the Host's `inspect.presence` value
		 * @returns whether "also delete the local file" may be offered
		 */
		function canDeleteLocalFile(presence) {
			return presence === 'present';
		}

		/**
		 * May the row offer "show in folder"?
		 *
		 * Needs an absolute path to reveal. `missing` still gets the button —
		 * the file may have been moved elsewhere and revealing its *recorded*
		 * path is still the best pointer we have — but a record with no path at
		 * all cannot be revealed, so that one is disabled.
		 */
		function canReveal(task, presence) {
			const outPath = typeof task.outPath === 'string' ? task.outPath : '';
			return outPath !== '' && presence !== 'unknown';
		}

		/** The one-line presence badge for a row (already localized by the caller). */
		function presenceKey(presence) {
			switch (presence) {
				case 'present':
					return 'presencePresent';
				case 'missing':
					return 'presenceMissing';
				case 'changed':
					return 'presenceChanged';
				case 'blocked':
					return 'presenceBlocked';
				default:
					return 'presenceUnknown';
			}
		}

		/** Why "also delete the local file" is unavailable, or null when it is. */
		function presenceBlockerKey(presence) {
			switch (presence) {
				case 'missing':
					return 'confirmPresenceMissing';
				case 'changed':
					return 'confirmPresenceChanged';
				case 'blocked':
					return 'confirmPresenceBlocked';
				case 'unknown':
					return 'confirmPresenceUnknown';
				default:
					return null;
			}
		}

		/**
		 * Map the Host's `delete` `reason` (the frozen contract set in
		 * `src/rpc.ts` `DeleteReason`) onto a dictionary key.
		 *
		 * Why a mapping instead of the value itself: the reason codes are
		 * Host-side snake/case words (`is-dir`, `no-path`), while the dictionary
		 * keys are camelCase product copy — the two must not be coupled by
		 * string identity, or renaming one silently breaks the other.
		 *
		 * @param reason the `reason` from `smartdl.manage` `op:'delete'`
		 * @returns dictionary key, or `null` for an unknown reason (caller falls
		 *   back to the generic "action failed" copy — an unknown reason must
		 *   never render as an empty string)
		 */
		function deleteReasonKey(reason) {
			switch (reason) {
				case 'gone': return 'deleteReasonGone';
				case 'busy': return 'deleteReasonBusy';
				case 'denied': return 'deleteReasonDenied';
				case 'is-dir': return 'deleteReasonIsDir';
				case 'is-link': return 'deleteReasonIsLink';
				case 'changed': return 'deleteReasonChanged';
				case 'no-path': return 'deleteReasonNoPath';
				case 'running': return 'deleteReasonRunning';
				default: return null;
			}
		}

		/**
		 * Human text for a handled-but-not-deleted outcome.
		 *
		 * `smartdl.manage` answers `{ ok: true, value: { fileDeleted, reason,
		 * errorCode } }` — `ok` means "the request was processed", NOT "the file
		 * is gone". When `fileDeleted` is false the row must stay and the user
		 * must be told why (PANEL-DL-1), with the specific cause (PANEL-DL-2)
		 * rather than a generic "action failed".
		 *
		 * @param value the `result.value` of a `manage` reply
		 * @param t the dictionary lookup
		 * @returns localized one-line text; empty string when there is nothing
		 *   meaningful to say
		 */
		function deleteFailureText(value, t) {
			if (!value) return '';
			const key = deleteReasonKey(value.reason);
			const base = key ? t(key) : t('actionFailed');
			const code = typeof value.errorCode === 'string' && value.errorCode !== '' ? value.errorCode : '';
			return code === '' ? base : `${base}（${code}）`;
		}

		/** Human byte size; falls back to the caller's "unknown" copy. */
		function formatBytes(bytes, unknownText) {
			const n = Number(bytes);
			if (!Number.isFinite(n) || n <= 0) return unknownText;
			if (n < 1024) return `${String(n)} B`;
			const units = ['KB', 'MB', 'GB', 'TB'];
			let value = n / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
		}

		/**
		 * Short local timestamp for a manager row (`MM-DD HH:mm`).
		 *
		 * 为什么手写而不用 `toLocaleString()`：列表每行都要一个时间，而 locale
		 * 格式随浏览器设置变（`2026/10/12 下午2:40`、`10/12/26, 2:40 PM`…），
		 * 既撑不住行宽也没法在测试里断言一个固定值。`MM-DD HH:mm` 与本仓库其它
		 * 地方的紧凑单位（`5.0 MB`、`4m51s`）同一种风格。
		 *
		 * @param ms epoch 毫秒；非法/缺省返回空串（调用方据此不渲染该 span）
		 */
		function formatShortTime(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, '0');
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/**
		 * Rows the *auto* layer shows: live tasks plus just-finished receipts.
		 * Deliberately bounded — this is the "don't interrupt, and get out of the
		 * way quickly" view (see AUTO_HIDE_DONE_MS / FINISHED_HOLD_MS).
		 */
		function autoRows(tasks, now) {
			return tasks.filter((task) => isLive(task, now) || isRecentReceipt(task, now));
		}

		/**
		 * Does the auto layer want to be on screen at all?
		 *
		 * True while something is live; after everything settled it stays up for
		 * AUTO_HIDE_DONE_MS measured from the newest update, then goes away.
		 * A snapshot with nothing in it is never auto-visible.
		 */
		function autoVisible(tasks, now) {
			if (tasks.length === 0) return false;
			if (tasks.some((task) => isLive(task, now))) return true;
			return now - newestUpdate(tasks) < AUTO_HIDE_DONE_MS;
		}

		/**
		 * Rows the *opened* panel shows: **all** tasks the Host returned (up to
		 * STATUS_LIMIT), regardless of how long ago they finished. This is the
		 * whole point of the entry button — "I downloaded it earlier, let me look
		 * at what happened" must work after the receipt window has passed.
		 * Running first, then the rest newest-first.
		 */
		function panelRows(tasks, now) {
			const running = [];
			const settled = [];
			for (const task of tasks) {
				(isLive(task, now) ? running : settled).push(task);
			}
			const byNewest = (a, b) => b.updatedAt - a.updatedAt;
			running.sort(byNewest);
			settled.sort(byNewest);
			return running.concat(settled);
		}

		/** 页面 window（测试/非浏览器环境可能没有）。 */
		function pageWindow() {
			try {
				return typeof window === 'undefined' ? null : window;
			} catch {
				return null;
			}
		}

		/** 浏览器存储；隐私模式或禁用 cookie 时 `localStorage` 取用会抛，退化成 null。 */
		function pageStorage() {
			try {
				const win = pageWindow();
				return win && win.localStorage ? win.localStorage : null;
			} catch {
				return null;
			}
		}

		/** 读静音开关。默认 **false（开着）**，理由见 README/报告。 */
		function readMuted(storage) {
			try {
				return Boolean(storage) && storage.getItem(MUTE_STORAGE_KEY) === '1';
			} catch {
				return false;
			}
		}

		/** 写静音开关；写不进去（隐私模式、配额满）只影响「记住」，开关本页仍生效。 */
		function writeMuted(storage, muted) {
			try {
				if (storage) storage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
			} catch {
				// 记不住就算了，绝不把异常抛到面板渲染路径上。
			}
		}

		const LAST_DELETE_STORAGE_KEY = 'dsh-smart-dl.last-delete';

		/**
		 * 上一次删除用的是哪个选项（`'record'` | `'file'`）。
		 *
		 * 为什么记这个：删除是高频操作，而确认框的两个按钮每次都要重新选一遍 ——
		 * 连删几条时，那一步选择是纯重复劳动。记住它并把它设为确认框的**默认焦点**
		 * （Enter 即确认），刹车仍在（对话框还在、内容仍展示），但路径从三次点击
		 * 变成两次按键。
		 */
		function readLastDelete(storage) {
			try {
				return storage && storage.getItem(LAST_DELETE_STORAGE_KEY) === 'file' ? 'file' : 'record';
			} catch {
				return 'record';
			}
		}

		function writeLastDelete(storage, value) {
			try {
				if (storage && (value === 'file' || value === 'record')) {
					storage.setItem(LAST_DELETE_STORAGE_KEY, value);
				}
			} catch {
				// 记不住就算了。
			}
		}

		/**
		 * 合成提示音播放器。
		 *
		 * 自动播放策略（硬约束）：页面在无用户交互前创建/唤醒 AudioContext 会被
		 * 挂起，非手势回调里的 `resume()` 会被拒绝。所以上下文**只在首次用户交互**
		 * （pointerdown / keydown，capture 阶段、once）时创建并 resume，之后一直复用；
		 * 每次播放新建一个上下文既浪费、也必然被拒绝。
		 *
		 * 任何一步失败都静默吞掉：声音不值得让面板报错或卡住。
		 * @param win - 页面 window；为空时整个播放器退化成 no-op。
		 */
		function createSoundPlayer(win) {
			let context = null;
			let unlocked = false;

			const ensure = () => {
				if (!win) return null;
				try {
					const Ctor = win.AudioContext || win.webkitAudioContext;
					if (typeof Ctor !== 'function') return null;
					if (context === null) context = new Ctor();
					if (context.state !== 'running' && typeof context.resume === 'function') {
						const resumed = context.resume();
						// 被策略拒绝会是一个 rejected promise：必须兜住，否则变成
						// unhandled rejection（面板没事，控制台很脏）。
						if (resumed && typeof resumed.catch === 'function') resumed.catch(() => undefined);
					}
					return context;
				} catch {
					return null;
				}
			};

			return {
				/** 首次用户交互时唤醒（一次性）。 */
				unlock() {
					if (unlocked) return;
					unlocked = true;
					ensure();
				},
				/**
				 * 播一段音。用户从未交互过（`unlocked` 为假）时什么都不做 ——
				 * 那种情况下浏览器本来也不会让我们出声。
				 */
				play(kind) {
					const profile = SOUND_PROFILES[kind];
					if (!profile || !unlocked) return;
					const ctx = ensure();
					if (!ctx || ctx.state !== 'running') return;
					try {
						const start = typeof ctx.currentTime === 'number' ? ctx.currentTime : 0;
						const gain = ctx.createGain();
						gain.connect(ctx.destination);
						let at = start;
						for (const freq of profile.notes) {
							const duration = profile.noteMs / 1000;
							const osc = ctx.createOscillator();
							osc.type = profile.wave;
							osc.frequency.setValueAtTime(freq, at);
							osc.connect(gain);
							// 每个音自己的包络：15ms 淡入 + 指数淡出。直接开断会有咔哒声。
							gain.gain.setValueAtTime(0.0001, at);
							gain.gain.linearRampToValueAtTime(profile.peak, at + 0.015);
							gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
							osc.start(at);
							osc.stop(at + duration);
							at += duration;
						}
					} catch {
						// 播放失败绝不影响面板渲染或轮询。
					}
				},
			};
		}

		/** 终态 → 音色。cancelled 不在其中：用户自己取消的，不需要提醒。 */
		function terminalSound(status) {
			if (status === 'completed') return 'success';
			if (status === 'failed') return 'failure';
			return null;
		}

		/**
		 * 终态播报器：去重 + 合流。
		 *
		 * 去重键 = `id:status`。任务 id 是每次下载新生成的（见 src/progress.ts），
		 * 所以「同一 id 再次进入同一个终态」在现实中不会发生；把终态拼进键里，
		 * 是为了万一某条任务被重试、真的又走了一遍终态流程时还能再响一次。
		 *
		 * **首屏只播种、不播报**：刷新页面后第一份快照里那些早就结束的历史任务，
		 * 一条都不该响 —— 用户没有在等它们，全播一遍是最吵的做法。
		 *
		 * 合流：窗口（SOUND_COALESCE_MS）内到达的多个终态合成一次；窗口内只要出现
		 * 失败就升级成失败音（需要被听见的是失败）。
		 * @param play - 真正发声的回调（已含静音判断）。
		 */
		function createTerminalAnnouncer(play) {
			const seen = new Set();
			let primed = false;
			let pending = null;
			let timer = null;

			const flush = () => {
				const kind = pending;
				pending = null;
				timer = null;
				if (kind !== null) play(kind);
			};

			return {
				observe(tasks) {
					const fresh = [];
					for (const task of tasks) {
						const kind = terminalSound(task.status);
						if (kind === null) continue;
						const key = String(task.id || '') + ':' + task.status;
						if (seen.has(key)) continue;
						seen.add(key);
						fresh.push(kind);
					}
					if (!primed) {
						primed = true;
						return;
					}
					if (fresh.length === 0) return;
					const kind = fresh.indexOf('failure') >= 0 ? 'failure' : 'success';
					if (timer !== null) {
						// 窗口内又来一条：不新开计时器，只把音色升级成失败。
						if (kind === 'failure') pending = 'failure';
						return;
					}
					pending = kind;
					timer = setTimeout(flush, SOUND_COALESCE_MS);
				},
				/** 卸载时清掉待响的那一声（插件被停用后不该再出声）。 */
				dispose() {
					if (timer !== null) clearTimeout(timer);
					timer = null;
					pending = null;
				},
			};
		}

		/**
		 * Cross-slot panel state.
		 *
		 * The entry button lives in `conversation.session.header.actions` while
		 * the panel lives in `shell.overlay` — two different slots, so they cannot
		 * share React state. This little store is the shared truth; both
		 * components subscribe to it (via `useState` + `useEffect`, which exist in
		 * every React the shell ships) and re-render on change.
		 *
		 * Two independent visibility semantics are kept **separate on purpose**:
		 *   - `userOpen`  : the user pressed the entry button. Wins over
		 *                   everything; only the × (or a second press) clears it.
		 *   - `autoHidden`: the user closed the *auto* panel. It suppresses the
		 *                   auto layer until something genuinely new happens (a
		 *                   task id never seen before) or the user opens it again.
		 * Collapsing these into one boolean is what makes a "close" button either
		 * useless during a download (it pops back) or permanent (a new download
		 * never appears).
		 *
		 * It also owns the mute switch: the audio side never learns about storage,
		 * and a muted session still marks terminal tasks as announced (so turning
		 * the sound back on cannot replay old completions).
		 * @param hooks - `{ play }`: 发声回调（未注入时等于静音）。
		 */
		function createPanelStore(hooks) {
			const play = hooks && hooks.play ? hooks.play : () => undefined;
			const storage = pageStorage();
			const listeners = new Set();
			let tasks = null;
			let now = Date.now();
			let userOpen = false;
			let autoHidden = false;
			let muted = readMuted(storage);
			/**
			 * Per-task Host verdicts from `smartdl.manage` `op:'inspect'`, keyed by
			 * task id: `{ presence, outPath, size }`.
			 *
			 * Why it lives in the store rather than in each row component: the
			 * sidebar entry, the overlay pill and the manager page all need the
			 * same answer to "can this row delete its file", and three copies of
			 * an `inspect` result would drift the moment one of them refreshed.
			 * Absent entry = "not inspected yet", which the UI treats as
			 * conservative (no destructive option until the Host has answered).
			 */
			/** 当前会话 { id, cwd }：由浮层 pill 写入，供 manage 定位会话隔离的轨道一。轨道一路径是 <cwd>/.dsh-progress/<session.id>/，没有 session 就解析不出来——那正是「文件删得掉、记录删不掉」的根因（status 带 session 所以看得到行，manage 不带所以只扫到轨道二）。 */
			let session = null;
			const presence = new Map();
			const seenIds = new Set();
			const announcer = createTerminalAnnouncer((kind) => {
				if (muted) return;
				play(kind);
			});

			const snapshot = () => ({ tasks, now, userOpen, autoHidden, muted, presence });
			const emit = () => {
				for (const listener of [...listeners]) listener();
			};
			const open = () => {
				userOpen = true;
				emit();
			};
			/** × / second press of the entry button. */
			const close = () => {
				userOpen = false;
				autoHidden = true;
				emit();
			};
			const setMuted = (next) => {
				muted = next === true;
				writeMuted(storage, muted);
				emit();
			};
			/** Record one `inspect` verdict (the manager page is the only writer). */
			const setPresence = (taskId, verdict) => {
				if (typeof taskId !== 'string' || taskId === '') return;
				presence.set(taskId, verdict);
				emit();
			};
			/**
			 * Drop a task's cached verdict. Called after `forget` / `delete`: the
			 * record is gone, so a stale verdict would keep answering questions
			 * about a row that no longer exists.
			 */
			const clearPresence = (taskId) => {
				if (presence.delete(taskId)) emit();
			};

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot: snapshot,
			setSession(next) {
				const id = next && next.id;
				const cwd = next && next.cwd;
				session = typeof id === 'string' && typeof cwd === 'string' && id !== '' && cwd !== '' ? { id: id, cwd: cwd } : null;
			},
			/** 给 manage 端点用：没有会话时返回 null（宿主会退回只扫轨道二）。 */
			getSession() {
				return session;
			},
				/**
				 * Feed a fresh Host snapshot in. A task id we have never seen
				 * means a new download started: that is the one event that
				 * re-arms the auto layer after the user closed it.
				 *
				 * 已知边界（PANEL-R2，t27 审查记录；**既有设计、不是缺陷**）：
				 * `seenIds` 只增不减，判据是「这个 id 有没有见过」，而不是「这条任务此刻
				 * 是否还在活动」。所以万一 task id 被复用，关掉之后的同一条任务再进终态
				 * 也不会把自动层重新武装。当前不会发生（id 里带随机段，见 src/progress.ts）；
				 * 真要改，先想清楚「新任务」到底该按什么判定 —— 按 id + 终态组合，还是按
				 * 「本轮新出现的活动任务」。
				 */
				publish(nextTasks) {
					let hasNew = false;
					for (const task of nextTasks) {
						const id = String(task.id || '');
						if (id !== '' && !seenIds.has(id)) {
							seenIds.add(id);
							hasNew = true;
						}
					}
					tasks = nextTasks;
					now = Date.now();
					if (hasNew) autoHidden = false;
					// 播报器照常记账（即使静音）：这样重新打开声音时不会把旧的
					// 完成事件补播一遍。
					announcer.observe(nextTasks);
					emit();
				},
				open: open,
				close: close,
				// 不用 `this`：调用点是 UI 事件（`onClick: () => store.toggle()`），
				// 一旦将来有人把它解构成裸函数（`const { toggle } = store`），
				// `this` 就是 undefined —— 关闭按钮会静默失效。
				toggle: () => (userOpen ? close() : open()),
				setMuted: setMuted,
				toggleMuted: () => setMuted(!muted),
				setPresence: setPresence,
				clearPresence: clearPresence,
				/** 插件卸载：清掉待响的一声。 */
				dispose: () => announcer.dispose(),
			};
		}

		/**
		 * What the panel should render right now, derived from the store.
		 * Exported shape: `{ visible, opened, rows }` — `opened` also decides the
		 * a11y role (a user-opened panel is a dialog, the auto one a status line).
		 */
		function panelView(state) {
			if (state.tasks === null) return { visible: false, opened: false, rows: [] };
			const tasks = state.tasks;
			const opened = state.userOpen;
			const visible = opened || (!state.autoHidden && autoVisible(tasks, state.now));
			if (!visible) return { visible: false, opened: opened, rows: [] };
			return {
				visible: true,
				opened: opened,
				rows: opened ? panelRows(tasks, state.now) : autoRows(tasks, state.now),
			};
		}

		/**
		 * Pick the display label: the human-readable task name when the Host has
		 * one (the output file name), else the status message, else the id.
		 * Long paths are trimmed to their basename.
		 */
		function shortLabel(task) {
			const raw = (task.name || task.msg || task.id || '').trim();
			if (raw === '') return '';
			const base = raw.split(/[\\/]/).pop() || raw;
			return base.length > 48 ? base.slice(0, 45) + '…' : base;
		}

		/**
		 * The text a hover `title` should carry: the whole untrimmed name.
		 *
		 * 返回值可能是空串 —— 那时**不挂 `title`**。空 `title` 会让浏览器弹出
		 * 一个空白气泡，看起来像界面坏了；不挂属性则完全没有提示。
		 */
		function fullLabel(task) {
			return (task.name || task.msg || task.id || '').trim();
		}

		/**
		 * 失败 / 取消原因，供面板正文显示。
		 *
		 * 为什么不再只放在 `title` 里：悬停提示在触屏上根本够不到，键盘用户也要
		 * 先聚焦才看得到，而失败原因恰恰是唯一需要立刻读到的东西。
		 *
		 * 三种情况返回空串（= 不渲染那一行），都不是「丢信息」：
		 * - 状态不是 failed / cancelled：已完成的任务没有「原因」可讲；
		 * - `msg` 与行标签逐字相同：轨道二（自有 JSON 格式）没有独立的状态文案，
		 *   落到 `msg` 里的就是任务名，再显示一遍纯属重复；
		 * - `msg` 以「失败:」开头、而冒号后面的内容就是行标签：同上，这是
		 *   `ProgressReporter.fail(name)` 的形态。
		 * 因此去掉可确定的重复前缀后仍与标签相同，才算重复。
		 *
		 * @param task 一条任务快照
		 * @param label 该行已经显示的文字（shortLabel 的结果）
		 * @returns 要显示的失败原因，或空串
		 */
		function failureReason(task, label) {
			if (task.status !== 'failed' && task.status !== 'cancelled') return '';
			let text = (task.msg || '').trim();
			if (text.startsWith(FAILED_MSG_PREFIX)) {
				text = text.slice(FAILED_MSG_PREFIX.length).trim();
			}
			if (text === '' || text === label.trim()) return '';
			return text.length > FAILURE_TEXT_LIMIT
				? text.slice(0, FAILURE_TEXT_LIMIT - 1) + '…'
				: text;
		}

		const TONE = {
			running: { bar: 'var(--dsw-alias-interactive-bg-primary, #4d6bfe)', text: 'var(--dsw-alias-label-primary, #1f2329)' },
			completed: { bar: 'var(--dsw-alias-state-success-primary, #22a06b)', text: 'var(--dsw-alias-label-primary, #1f2329)' },
			failed: { bar: 'var(--dsw-alias-state-error-primary, #d92d20)', text: 'var(--dsw-alias-state-error-primary, #d92d20)' },
			cancelled: { bar: 'var(--dsw-alias-label-tertiary, #9ca3af)', text: 'var(--dsw-alias-label-tertiary, #9ca3af)' },
		};

		/** One task row: label, percentage, bar, speed/ETA. */
		function TaskRow({ task, t }) {
			const tone = TONE[task.status] || TONE.running;
			const pct = Math.max(0, Math.min(100, Math.round(task.pct || 0)));
			const label = shortLabel(task) || t('untitled');
			const title = fullLabel(task);
			const reason = failureReason(task, label);
			const meta = [];
			if (task.spd) meta.push(task.spd);
			if (task.eta && task.status === 'running') meta.push(t('eta', { eta: task.eta }));
			if (task.status === 'completed') meta.push(t('completed'));
			if (task.status === 'failed') meta.push(t('failed'));
			if (task.status === 'cancelled') meta.push(t('cancelled'));

			return react.createElement(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
				react.createElement(
					'div',
					{ style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
					react.createElement(
						'span',
						{
							// title 只挂完整名字（不挂 msg）：悬停要看的是被省略号截断的
							// 那个名字，而不是屏幕正文里已经有的那句话。
							...(title ? { title: title } : {}),
							style: {
								flex: '1 1 auto',
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
								fontSize: 12,
								lineHeight: '16px',
								color: tone.text,
							},
						},
						label,
					),
					react.createElement(
						'span',
						{
							style: {
								flex: 'none',
								fontSize: 12,
								lineHeight: '16px',
								fontVariantNumeric: 'tabular-nums',
								color: 'var(--dsw-alias-label-secondary, #6b7280)',
							},
						},
						pct + '%',
					),
				),
				react.createElement(
					'div',
					{
						role: 'progressbar',
						'aria-valuenow': pct,
						'aria-valuemin': 0,
						'aria-valuemax': 100,
						// 屏幕阅读器念进度条时把原因一起念出来：失败原因现在虽然进了
						// 正文，但那是个独立的兄弟节点，读屏不会自动把它和进度条关联。
						'aria-valuetext': reason ? pct + '% — ' + reason : pct + '%',
						'aria-label': label,
						style: {
							height: 4,
							borderRadius: 2,
							overflow: 'hidden',
							background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18))',
						},
					},
					react.createElement('div', {
						style: {
							width: pct + '%',
							height: '100%',
							borderRadius: 2,
							background: tone.bar,
							transition: 'width 240ms ease-out',
						},
					}),
				),
				meta.length > 0 &&
					react.createElement(
						'div',
						{
							style: {
								fontSize: 11,
								lineHeight: '14px',
								color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
								fontVariantNumeric: 'tabular-nums',
							},
						},
						meta.join(' · '),
					),
				// 失败原因独立成行（不进 meta 拼接、不截断成省略号）：这行的存在本身
				// 就是「为什么会失败」，用 `title` 悬停只能算把它藏起来。
				reason !== '' &&
					react.createElement(
						'div',
						{
							style: {
								fontSize: 11,
								lineHeight: '15px',
								// 用 error 色而非 tertiary：正文里这行是唯一需要被立刻看到的
								color: tone.text,
								whiteSpace: 'pre-wrap',
								overflowWrap: 'anywhere',
							},
						},
						reason,
					),
			);
		}

		/**
		 * Find the session currently occupying the main view. The Host writes
		 * task-progress records into `<session.cwd>/.dsh-progress/<session.id>/`,
		 * and only that session's panel will ever read them, so the pill must tell
		 * the Host which session it is asking about.
		 *
		 * `retainedBy.mainView` is the same signal dsh-client-ui-layout uses to
		 * pick the frame's active session (`ui-layout/lib/client.js`).
		 * @param state - the `useSessions` snapshot (`{ byId }`).
		 * @returns the session row, or undefined when no main session exists.
		 */
		function mainSession(state) {
			const byId = state && state.byId;
			if (!byId) return undefined;
			for (const id of Object.keys(byId)) {
				const row = byId[id];
				if (row && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0) return row;
			}
			return undefined;
		}

		/**
		 * Selector-hook fallback for shells that do not expose `useSessions`.
		 * It still calls exactly one React hook (`useMemo`), so the component's
		 * hook order and count are identical whether or not the shell provides
		 * the real hook — swapping between the two never breaks the Rules of
		 * Hooks.
		 * @param selector - a snapshot selector; receives `undefined` here.
		 * @returns the selector applied to an empty snapshot.
		 */
		function useNoSessions(selector) {
			return react.useMemo(() => selector(undefined), []);
		}

		/**
		 * The `shell.overlay` entry: the panel itself.
		 *
		 * It polls the Host (the one and only poller — the header button reads the
		 * same store instead of asking again) and feeds every snapshot into the
		 * shared store. Visibility is *derived* from the store, never a plain
		 * boolean: auto layer (something live, or recently finished) plus whatever
		 * the user explicitly opened.
		 * @param props - the injected status caller and store, the locale seat, and
		 *   the framework's `useSessions` hook (absent on older shells).
		 * @returns the panel, or null when no rule wants it on screen.
		 */
		function SmartDlProgressPill({ requestStatus, panelStore, t, useSessions }) {
			// `revision` only exists to re-render this component when the *other*
			// slot (the entry button) changes the store; the data itself is read
			// straight out of the store below.
			const [, setRevision] = react.useState(0);
			// Read the active session id through the framework hook. Hooks must be
			// called unconditionally, so fall back to `useNoSessions` when the
			// shell does not expose `useSessions` (older hosts): the pill then asks
			// for an unfiltered snapshot, which is exactly the previous behaviour.
			const useSessionsHook = useSessions || useNoSessions;
			const sessionId = useSessionsHook((state) => {
				const session = mainSession(state);
				return session ? session.id : undefined;
			});
			const sessionCwd = useSessionsHook((state) => {
				const session = mainSession(state);
				return session ? session.cwd : undefined;
			});

			react.useEffect(
				() => panelStore.subscribe(() => setRevision((n) => n + 1)),
				[panelStore],
			);

			react.useEffect(() => {
				let cancelled = false;
				let timer = null;
				const controller = new AbortController();
				const tick = async () => {
					try {
						const payload = { limit: STATUS_LIMIT };
						// Only send a session the Host can validate; without one the
						// Host falls back to scanning just the JSON track.
						if (sessionId && sessionCwd) payload.session = { id: sessionId, cwd: sessionCwd };
					panelStore.setSession(payload.session);
					// 无条件写：会话消失时也要清掉，否则 manage 会带着过期的 session。
						const result = await requestStatus(payload, controller.signal);
						if (cancelled) return;
						if (result && result.ok && result.value && Array.isArray(result.value.tasks)) {
							panelStore.publish(result.value.tasks);
							setRevision((n) => n + 1);
						}
					} catch {
						// Transport hiccup: keep the last snapshot instead of flickering.
					}
				};
				tick();
				timer = setInterval(tick, POLL_INTERVAL_MS);
				return () => {
					cancelled = true;
					if (timer !== null) clearInterval(timer);
					controller.abort();
				};
			}, [requestStatus, sessionId, sessionCwd]);

			const state = panelStore.getSnapshot();
			const view = panelView(state);
			if (!view.visible) return null;

			return react.createElement(
				'div',
				{
					'data-dsh-smart-dl': 'progress',
					// 用户主动打开时是「一个可以关掉的窗口」（dialog），自动浮现时
					// 只是状态播报（status）—— 两种语义在 DOM 上也应当分得开，
					// 读屏用户才知道自己面对的是哪一个。
					role: view.opened ? 'dialog' : 'status',
					...(view.opened ? { 'aria-modal': false } : {}),
					'aria-label': t('title'),
					'aria-live': 'polite',
					style: {
						position: 'fixed',
						right: 16,
						bottom: 16,
						zIndex: 30,
						width: 280,
						maxWidth: 'calc(100vw - 32px)',
						display: 'flex',
						flexDirection: 'column',
						gap: 10,
						padding: '10px 12px',
						border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
						borderRadius: 12,
						background: 'var(--dsw-alias-bg-module-platform, #ffffff)',
						boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
						pointerEvents: 'auto',
						// STATUS_LIMIT 提到 50 之后，一次批量可能同时有多行；封顶高度
						// 让面板继续是「角落里的一个 pill」，超出的行改为内部滚动。
						maxHeight: PANEL_MAX_HEIGHT,
						overflowY: 'auto',
					},
				},
				react.createElement(
					'div',
					{
						style: {
							display: 'flex',
							alignItems: 'center',
							gap: 8,
						},
					},
					react.createElement(
						'span',
						{
							style: {
								flex: '1 1 auto',
								fontSize: 11,
								lineHeight: '14px',
								fontWeight: 600,
								letterSpacing: '0.02em',
								textTransform: 'uppercase',
								color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
							},
						},
						t('title'),
					),
					// × 关闭：既关掉用户打开的那一层，也压住自动层（否则下载还在跑时
					// 关掉会被下一轮轮询立刻弹回来，按钮等于没用）。
					react.createElement(
						'button',
						{
							type: 'button',
							'data-dsh-smart-dl': 'close',
							// 只给 aria-label、不给 title：面板里 `title` 的含义已经被
							// 「行内被省略号截断的全名」占满（见 TaskRow 的注释），再加一个
							// 悬停气泡会让「哪些元素挂 title」变得说不清。
							'aria-label': t('close'),
							onClick: () => panelStore.close(),
							style: {
								flex: 'none',
								width: 20,
								height: 20,
								lineHeight: '16px',
								padding: 0,
								border: 'none',
								borderRadius: 6,
								cursor: 'pointer',
								background: 'transparent',
								color: 'var(--dsw-alias-label-secondary, #6b7280)',
								fontSize: 14,
							},
						},
						'×',
					),
				),
				view.rows.length === 0
					? react.createElement(
							'div',
							{
								style: {
									fontSize: 12,
									lineHeight: '16px',
									color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
								},
							},
							t('empty'),
						)
					: view.rows.map((task) =>
							react.createElement(TaskRow, { key: task.id, task: task, t: t }),
						),
				// 静音开关只出现在**用户打开**的面板里：自动浮现的那几秒是
				// 「播报」，不是「设置」；在浮层里塞开关会让人误触。
				view.opened
					? react.createElement(
							'label',
							{
								style: {
									display: 'flex',
									alignItems: 'center',
									gap: 6,
									fontSize: 12,
									lineHeight: '16px',
									cursor: 'pointer',
									color: 'var(--dsw-alias-label-secondary, #6b7280)',
								},
							},
							react.createElement('input', {
								type: 'checkbox',
								'data-dsh-smart-dl': 'sound-toggle',
								'aria-label': t('sound'),
								checked: !state.muted,
								onChange: () => panelStore.toggleMuted(),
								style: { margin: 0 },
							}),
							t('sound'),
						)
					: null,
			);
		}

		/**
		 * The `sidebar.panellist` glyph.
		 *
		 * Why this component is almost empty: the sidebar renders the button
		 * itself — its own `PanelRow` builds the `<button>` with the click
		 * handler, `aria-label`, `aria-current` and the active state, and hands
		 * us only `{ size, active }` to draw with (`dsh-client-ui-sidebar/lib/
		 * client.js:173-199`; the plugin manager's icon is likewise a bare
		 * `({ size }) => jsx(Icon…, { size })`). Writing our own `onClick` here
		 * would be dead code, and re-declaring the a11y attributes would fight
		 * the shell's.
		 *
		 * Inline SVG on purpose (no new dependency, no bundled asset): our
		 * client.js is a hand-written classic script whose `require` is limited
		 * to a small whitelist, and the official primitives package is not
		 * known to be in it — see PLAN-DLMANAGER §1.5.
		 *
		 * @param props - `{ size, active }` from the sidebar row.
		 * @returns the glyph.
		 */
		function SmartDlSidebarIcon({ size, active }) {
			const px = typeof size === 'number' && size > 0 ? size : 18;
			return react.createElement(
				'svg',
				{
					width: px,
					height: px,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
					focusable: false,
					// The sidebar picks the colour; we only follow `active` for the
					// one thing an icon legitimately owns — which glyph to draw.
					style: { display: 'block' },
				},
				// A download tray: the arrow into the tray is the "incoming" half,
				// the tray the "already here" half. One shape, both meanings.
				react.createElement('path', { key: 'arrow', d: 'M12 3v11' }),
				react.createElement('path', { key: 'head', d: 'M8 10l4 4 4-4' }),
				react.createElement('path', { key: 'tray', d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }),
				active === true
					? react.createElement('path', { key: 'active', d: 'M12 3v11', strokeWidth: 2.2 })
					: null,
			);
		}

		/**
		 * One manager row: what it is, where it went, and the two things you can
		 * do about it.
		 *
		 * `presence` is read from the shared store (filled by `inspect`), never
		 * computed here: the verdict needs an `lstat` on the Host, and guessing
		 * it in the browser would be exactly the kind of "looks right, isn't"
		 * this project keeps getting bitten by. With no verdict yet the row is
		 * conservative — no destructive option.
		 *
		 * @param props - the task, the locale seat, and the row's callbacks.
		 * @returns the row element.
		 */
		function SmartDlManagerRow({ task, t, presence, onReveal, onDelete }) {
			// Delete 键：焦点在本行时打开确认框（不是直接删——不可逆操作的刹车仍在）。
			const onRowKeyDown = (event) => {
				if (event.key !== 'Delete') return;
				event.preventDefault();
				onDelete(task);
			};
			void onRowKeyDown;			const label = shortLabel(task) || t('untitled');
			const state = panelStore_PresenceOf(presence, task.id);
			const deletable = canDeleteLocalFile(state.presence);
			const revealable = canReveal(task, state.presence);
			const blocker = presenceBlockerKey(state.presence);
			// 行内「时间」：没有可展示的时间戳时整个 span 不渲染（不留一个空位）
			const when = formatShortTime(task.updatedAt);

			return react.createElement(
				'div',
				{
					'data-dsh-smart-dl': 'manager-row',
					'data-task-id': task.id,
				tabIndex: 0,
				onKeyDown: onRowKeyDown,
					style: {
						display: 'flex',
						flexDirection: 'column',
						gap: 6,
						padding: '10px 12px',
						border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
						borderRadius: 10,
					},
				},
				react.createElement(
					'div',
					{ style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
					react.createElement(
						'span',
						{
							style: { flex: '1 1 auto', fontWeight: 600, fontSize: 13, wordBreak: 'break-all' },
							title: fullLabel(task) || undefined,
						},
						label,
					),
					react.createElement(
						'span',
						{ style: { flex: 'none', fontSize: 11, opacity: 0.75 } },
						`${String(task.pct ?? 0)}%`,
					),
				),
				react.createElement(
					'div',
					{ style: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, opacity: 0.8 } },
					react.createElement('span', null, t(task.status === 'completed' ? 'completed' : task.status)),
					state.size !== undefined && state.size !== null
						? react.createElement('span', { key: 'size' }, formatBytes(state.size, t('sizeUnknown')))
						: null,
					when !== ''
						? react.createElement(
								'span',
								{ key: 'time', 'data-dsh-smart-dl': 'updated-at', title: t('updatedAt') },
								when,
							)
						: null,
					react.createElement(
						'span',
						{ key: 'presence', 'data-dsh-smart-dl': 'presence' },
						t(presenceKey(state.presence)),
					),
				),
				react.createElement(
					'div',
					{ style: { display: 'flex', gap: 8 } },
					react.createElement(
						'button',
						{
							type: 'button',
							'data-dsh-smart-dl': 'reveal',
							'aria-label': t('reveal'),
							disabled: !revealable,
							title: revealable ? t('reveal') : t('revealDisabled'),
							onClick: () => onReveal(task),
							style: { cursor: revealable ? 'pointer' : 'default', fontSize: 12, padding: '4px 10px' },
						},
						t('reveal'),
					),
					react.createElement(
						'button',
						{
							type: 'button',
							'data-dsh-smart-dl': 'delete',
							'aria-label': t('deleteRecord'),
							onClick: () => onDelete(task),
							style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px' },
						},
						t('deleteRecord'),
					),
				),
				// Why the destructive option is missing, when it is. Silence here
				// reads as "the button is broken"; one line reads as "by design".
				blocker === null && deletable
					? null
					: react.createElement(
							'div',
							{ style: { fontSize: 11, opacity: 0.75 } },
							blocker === null ? null : t(blocker),
						),
			);
		}

		/** Read one task's cached verdict out of the store's presence map. */
		function panelStore_PresenceOf(presence, taskId) {
			const hit = presence instanceof Map ? presence.get(String(taskId)) : undefined;
			if (!hit) return { presence: 'unknown', outPath: '', size: undefined };
			return {
				presence: typeof hit.presence === 'string' ? hit.presence : 'unknown',
				outPath: typeof hit.outPath === 'string' ? hit.outPath : '',
				size: typeof hit.size === 'number' ? hit.size : undefined,
			};
		}

		/**
		 * The delete confirmation.
		 *
		 * Two rules it exists to enforce, both from the user:
		 *   1. show the **full absolute path** and the size — a destructive
		 *      action must never be confirmed against a truncated label;
		 *   2. offer "also delete the local file" **only** when the Host says the
		 *      file is still there and still ours (`presence === 'present'`),
		 *      otherwise only the record can go ("如果移走便只有删除记录").
		 *
		 * It also states plainly that deleting the file is permanent and skips
		 * the recycle bin — there is no trash service in this runtime, so the
		 * confirmation is the only warning the user gets.
		 *
		 * @param props - the task, its verdict, the locale seat, and callbacks.
		 * @returns the dialog element.
		 */
		function SmartDlConfirmDialog({ task, t, verdict, onRecordOnly, onWithFile, onCancel, defaultAction }) {
			const deletable = canDeleteLocalFile(verdict.presence);
			const blocker = presenceBlockerKey(verdict.presence);
			const outPath = verdict.outPath !== '' ? verdict.outPath : '(no path recorded)';

			return react.createElement(
				'div',
				{
					'data-dsh-smart-dl': 'confirm',
					role: 'dialog',
					'aria-modal': true,
					'aria-label': t('confirmTitle'),
					style: {
						position: 'fixed',
						inset: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						background: 'rgba(0,0,0,0.32)',
						zIndex: 40,
					},
				},
				react.createElement(
					'div',
					{
						style: {
							width: 420,
							maxWidth: 'calc(100vw - 32px)',
							display: 'flex',
							flexDirection: 'column',
							gap: 10,
							padding: 16,
							borderRadius: 12,
							background: 'var(--dsw-alias-bg-module-platform, #ffffff)',
							boxShadow: '0 12px 32px rgba(0,0,0,0.24)',
						},
					},
					react.createElement(
						'div',
						{ style: { fontWeight: 600, fontSize: 14 } },
						t('confirmTitle'),
					),
					react.createElement(
						'div',
						{ style: { fontSize: 12, wordBreak: 'break-all' } },
						`${t('confirmPath')}: ${outPath}`,
					),
					react.createElement(
						'div',
						{ style: { fontSize: 12 } },
						`${t('confirmSize')}: ${formatBytes(verdict.size, t('sizeUnknown'))}`,
					),
					blocker === null
						? null
						: react.createElement('div', { key: 'why', style: { fontSize: 12, opacity: 0.8 } }, t(blocker)),
					react.createElement(
						'div',
						{ style: { fontSize: 12, color: 'var(--dsw-alias-label-warning, #b45309)' } },
						t('confirmIrreversible'),
					),
					react.createElement(
						'div',
						{ style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
						react.createElement(
							'button',
							{
								type: 'button',
								'data-dsh-smart-dl': 'confirm-cancel',
								onClick: onCancel,
								style: { cursor: 'pointer', fontSize: 12, padding: '6px 12px' },
							},
							t('confirmCancel'),
						),
						react.createElement(
							'button',
							{
								type: 'button',
								'data-dsh-smart-dl': 'confirm-record-only',
								onClick: onRecordOnly,
				// 默认焦点 = 上次用的选项（Enter 即确认）。file 不可用时焦点仍落在这。
				autoFocus: defaultAction === 'file' && deletable ? false : true,
								style: { cursor: 'pointer', fontSize: 12, padding: '6px 12px' },
							},
							t('confirmRecordOnly'),
						),
						deletable
							? react.createElement(
									'button',
									{
										type: 'button',
										'data-dsh-smart-dl': 'confirm-with-file',
										onClick: onWithFile,
					autoFocus: defaultAction === 'file' && deletable,
										style: { cursor: 'pointer', fontSize: 12, padding: '6px 12px' },
									},
									t('confirmWithFile'),
								)
							: null,
					),
				),
			);
		}

		/**
		 * The manager page: the whole main area, one row per download.
		 *
		 * Registered as a **keyed** `main` slot, which is what makes it a page
		 * rather than a floating card — the Host swaps the conversation out for
		 * it (`selectPanel(PANEL_ID)` opens, `selectPanel(null)` goes back).
		 * That is the plugin-manager shape, and it is what the user asked for
		 * ("占满主区的一页").
		 *
		 * It does **not** poll: the overlay pill is the single poller and feeds
		 * the shared store, so a page open for two minutes costs the same Host
		 * traffic as a pill sitting in the corner. `inspect` is called once per
		 * task when the page mounts, and again after any operation that could
		 * have changed the file.
		 *
		 * @param props - the shared store, the manage caller, and the locale seat.
		 * @returns the page element.
		 */
		function SmartDlManagerPage({ panelStore, manage, reveal, t, onClose, storage: storageProp }) {
			const [, setRevision] = react.useState(0);
			react.useEffect(
				() => panelStore.subscribe(() => setRevision((n) => n + 1)),
				[panelStore],
			);
			// 记住上次的删除选项：删除是高频操作，确认框的两个按钮每次重选是纯重复
			// 劳动。记住它并作为确认框的默认焦点（Enter 即确认），刹车仍在（对话框
			// 还在、内容仍展示），但路径从三次点击变成两次按键。
			const storage = storageProp !== undefined ? storageProp : pageStorage();
			const lastDelete = readLastDelete(storage);
			// The task awaiting confirmation, kept as local UI state: it is one
			// interaction's worth of data, not something any other slot needs.
			const [pending, setPending] = react.useState(null);
			const [notice, setNotice] = react.useState(null);

			const state = panelStore.getSnapshot();
			const tasks = state.tasks === null ? [] : state.tasks;

			/** Refresh every row's verdict. Cheap on purpose: one call per task. */
			const inspectAll = async () => {
				for (const task of tasks) {
					try {
						const result = await manage({ op: 'inspect', taskId: task.id });
						if (result && result.ok) panelStore.setPresence(task.id, result.value);
					} catch {
						// One bad row must not blank the page; the row keeps its
						// conservative "unknown" verdict and stays deletable by
						// record only.
					}
				}
			};

			react.useEffect(() => {
				void inspectAll();
				// 只在挂载时跑一次：任务列表由共享 store 驱动，行内操作后会显式再查。
				// eslint-disable-next-line no-empty-function
			}, []);

			const revealTask = async (task) => {
				const verdict = panelStore_PresenceOf(state.presence, task.id);
				const outPath = verdict.outPath !== '' ? verdict.outPath : task.outPath;
				if (typeof outPath !== 'string' || outPath === '') return;
				try {
					// `reveal` 在「宿主没有 remote.session」「调用抛错」「宿主拒绝」三种
					// 情况下都是**返回 { ok:false }** 而不是抛异常 —— 所以只靠 try/catch
					// 会让「点了没反应」变成静默失败，用户不知道发生了什么。
					const result = await reveal(outPath);
					if (result && result.ok === false) setNotice(t('revealFailed'));
				} catch {
					setNotice(t('revealFailed'));
				}
			};

			const remove = async (task, withFile) => {
				setPending(null);
				let result = null;
				try {
					// `confirm` 只在该为 true 时出现：forget 的契约里没有这个字段，
					// 多带一个 `confirm:false` 只会让服务端多一个「为什么在这里」的疑问。
					const body = withFile
						? { op: 'delete', taskId: task.id, confirm: true }
						: { op: 'forget', taskId: task.id };
					result = await manage(body);
				} catch {
					setNotice(t('actionFailed'));
					return;
				}
				// PANEL-DL-1：`ok` 的语义是「请求被处理」，不是「文件已删」——
				// busy/denied/changed/is-dir/is-link/running 这些失败也返回
				// ok:true + fileDeleted:false。所以不能再用 ok 分支「删没删」，
				// 必须看 value 里到底删了什么：记录删了才允许行消失。
				const value = result && result.ok ? result.value : null;
				const recordRemoved = value && Array.isArray(value.recordRemoved) ? value.recordRemoved : [];
				if (!value || recordRemoved.length === 0) {
					// 请求被处理了，但记录没删成（busy/denied/changed/is-dir/is-link/
					// running）：行必须留着（它还指向一个真实的产物），并把服务端
					// 给出的具体原因告诉用户，而不是一句笼统的「操作失败」。
					setNotice(deleteFailureText(value, t) || t('actionFailed'));
					return;
				}
				panelStore.clearPresence(task.id);
				// Force the shared snapshot to refresh: the record is gone,
				// and the pill's next poll may be up to 2 seconds away.
				panelStore.publish(tasks.filter((row) => row.id !== task.id));
				await inspectAll();
				// 记住这次用的是哪个选项，下次确认框默认焦点就在它上。
				writeLastDelete(storage, withFile ? 'file' : 'record');
				// PANEL-DL-2：记录已删但产物没删成时（只在 withFile 的竞态下可能，
				// 例如点击后文件被移走），也要说清楚——记录没了但文件还在磁盘上。
				if (withFile && value.fileDeleted === false) {
					setNotice(deleteFailureText(value, t));
				}
			};

			return react.createElement(
				'div',
				{
					'data-dsh-smart-dl': 'manager',
					style: {
						display: 'flex',
						flexDirection: 'column',
						gap: 12,
						height: '100%',
						padding: 16,
						boxSizing: 'border-box',
						overflowY: 'auto',
					},
				},
				react.createElement(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 8 } },
					react.createElement(
						'span',
						{ style: { flex: '1 1 auto', fontWeight: 600, fontSize: 15 } },
						t('panel'),
					),
					react.createElement(
						'button',
						{
							type: 'button',
							'data-dsh-smart-dl': 'manager-close',
							'aria-label': t('panelClose'),
							onClick: () => {
								setPending(null);
								if (typeof onClose === 'function') onClose();
							},
							style: { cursor: 'pointer', fontSize: 12, padding: '6px 12px' },
						},
						t('panelClose'),
					),
				),
				notice === null
					? null
					: react.createElement('div', { key: 'notice', style: { fontSize: 12 } }, notice),
				tasks.length === 0
					? react.createElement('div', { style: { fontSize: 13, opacity: 0.7 } }, t('empty'))
					: tasks.map((task) =>
							react.createElement(SmartDlManagerRow, {
								key: task.id,
								task: task,
								t: t,
								presence: state.presence,
								onReveal: revealTask,
								onDelete: (row) => setPending(row.id),
							}),
						),
				pending === null
					? null
					: react.createElement(SmartDlConfirmDialog, {
							task: tasks.find((row) => row.id === pending) ?? { id: pending },
							t: t,
				defaultAction: lastDelete,
							verdict: panelStore_PresenceOf(state.presence, pending),
							onCancel: () => setPending(null),
							onRecordOnly: () => {
								const row = tasks.find((item) => item.id === pending);
								if (row) void remove(row, false);
							},
							onWithFile: () => {
								const row = tasks.find((item) => item.id === pending);
								if (row) void remove(row, true);
							},
						}),
			);
		}

		/**
		 * Client plugin body: install the dictionaries, then contribute the
		 * overlay pill (progress only), the sidebar entry + main page (the
		 * download manager), sharing one `panelStore` — which is what lets a
		 * click in one slot drive a page registered in another.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				'dsh-smart-dl: dictionaries',
			);

			/** Cross-slot truth: created once per plugin instance. */
			const soundPlayer = createSoundPlayer(pageWindow());
			const panelStore = createPanelStore({
				play: (kind) => soundPlayer.play(kind),
			});

			// 首次用户交互时唤醒音频上下文（capture + once）。自动播放策略要求
			// 必须发生在手势回调里，所以这两个监听是「建上下文」的唯一入口。
			ctx.effect(() => {
				const win = pageWindow();
				const unlock = () => soundPlayer.unlock();
				const attached = Boolean(win) && typeof win.addEventListener === 'function';
				if (attached && win) {
					win.addEventListener('pointerdown', unlock, { capture: true, once: true });
					win.addEventListener('keydown', unlock, { capture: true, once: true });
				}
				return () => {
					if (attached && win && typeof win.removeEventListener === 'function') {
						win.removeEventListener('pointerdown', unlock, { capture: true });
						win.removeEventListener('keydown', unlock, { capture: true });
					}
					// 插件被停用时，不该再留一声待响的提示音。
					panelStore.dispose();
				};
			}, 'dsh-smart-dl: audio unlock');

			/** Business face of the overlay entry: the Host status caller. */
			const statusInjected = () => ({
				requestStatus: (payload, signal) =>
					ctx.connection.rpc.call(API_PATH, STATUS_ENDPOINT, payload, signal),
				panelStore: panelStore,
			});

			/** Business face of the manager page: status, manage, and reveal. */
			const manageInjected = () => ({
				requestStatus: (payload, signal) =>
					ctx.connection.rpc.call(API_PATH, STATUS_ENDPOINT, payload, signal),
				/**
				 * One `smartdl.manage` call.
				 *
				 * Returns the **Host's whole envelope** (`{ ok, value }`), not just
				 * `value`: the page distinguishes "the Host refused" from "the Host
				 * answered with something unexpected", and only the envelope carries
				 * that. Unwrapping here would collapse both into a falsy `result.ok`
				 * and silently drop every verdict — which is exactly what the first
				 * cut of this function did.
				 */
				manage: async (body) => {
				const session = panelStore.getSession();
				const payload = session ? Object.assign({}, body, { session: session }) : body;
				const result = await ctx.connection.rpc.call(API_PATH, MANAGE_ENDPOINT, payload);
				return result;
				},
				reveal: async (outPath) => {
					// Read defensively: `remote.session` is declared in `inject`, but a
					// profile without the session controller must degrade to "nothing
					// happened" rather than take the page down.
					const session = ctx.remote && ctx.remote.session;
					if (!session || typeof session.openWorkspacePath !== 'function') return { ok: false };
					try {
						return await session.openWorkspacePath({ path: outPath, action: 'reveal' });
					} catch {
						return { ok: false };
					}
				},
				panelStore: panelStore,
				onClose: () => {
					if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
						ctx.layout.selectPanel(null);
					}
				},
			});

			ctx.effect(
				() =>
					ctx.slots.inject('shell.overlay', function* () {
						yield ctx.slots.register(
							{
								name: 'shell.overlay',
								id: ENTRY_ID,
								order: 100,
								locale: NS,
								inject: statusInjected,
							},
							SmartDlProgressPill,
						);
					}),
				'dsh-smart-dl: shell.overlay progress pill',
			);

			// `main` 先注册、`sidebar.panellist` 后注册：选中一个不存在的 key 会抛错
			// 并保留当前面板（dsh-client-ui-layout 的 README），所以页面必须比入口
			// 先就位 —— 同一 apply 内保序即可。
			ctx.effect(
				() =>
					ctx.slots.inject('main', function* () {
						yield ctx.slots.register(
							{
								name: 'main',
								key: PANEL_ID,
								locale: NS,
								inject: manageInjected,
							},
							SmartDlManagerPage,
						);
					}),
				'dsh-smart-dl: main downloads page',
			);

			ctx.effect(
				() =>
					ctx.slots.inject('sidebar.panellist', () =>
						ctx.slots.register(
							{
								name: 'sidebar.panellist',
								id: PANEL_ID,
								order: 30,
								label: () => 'Downloads',
								locale: NS,
								inject: () => ({ panelStore: panelStore }),
							},
							SmartDlSidebarIcon,
						),
					),
				'dsh-smart-dl: sidebar downloads entry',
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

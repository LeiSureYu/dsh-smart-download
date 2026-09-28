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
		/** How many tasks the pill asks for. */
		const STATUS_LIMIT = 5;
		/** Poll cadence while the panel is mounted. */
		const POLL_INTERVAL_MS = 2000;
		/** How long a finished task stays on screen as a receipt. */
		const FINISHED_HOLD_MS = 30000;
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

		const zh = {
			'title': '下载任务',
			'running': '下载中',
			'completed': '已完成',
			'failed': '失败',
			'eta': '剩余 {eta}',
			'untitled': '未命名任务',
		};

		const en = {
			'title': 'Downloads',
			'running': 'Downloading',
			'completed': 'Completed',
			'failed': 'Failed',
			'eta': 'ETA {eta}',
			'untitled': 'Untitled task',
		};

		/** Required services (cordis fiber inject). */
		const inject = ['slots', 'locale', 'connection'];

		/** Statuses rendered as a live bar; the rest are receipts. */
		function isLive(task, now) {
			return task.status === 'running' && now - task.updatedAt < STALE_RUNNING_MS;
		}

		/** Keep a finished task on screen briefly so the user sees the outcome. */
		function isRecentReceipt(task, now) {
			return task.status !== 'running' && now - task.updatedAt < FINISHED_HOLD_MS;
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

		const TONE = {
			running: { bar: 'var(--dsw-alias-interactive-bg-primary, #4d6bfe)', text: 'var(--dsw-alias-label-primary, #1f2329)' },
			completed: { bar: 'var(--dsw-alias-state-success-primary, #22a06b)', text: 'var(--dsw-alias-label-primary, #1f2329)' },
			failed: { bar: 'var(--dsw-alias-state-error-primary, #d92d20)', text: 'var(--dsw-alias-state-error-primary, #d92d20)' },
		};

		/** One task row: label, percentage, bar, speed/ETA. */
		function TaskRow({ task, t }) {
			const tone = TONE[task.status] || TONE.running;
			const pct = Math.max(0, Math.min(100, Math.round(task.pct || 0)));
			const label = shortLabel(task) || t('untitled');
			const meta = [];
			if (task.spd) meta.push(task.spd);
			if (task.eta && task.status === 'running') meta.push(t('eta', { eta: task.eta }));
			if (task.status === 'completed') meta.push(t('completed'));
			if (task.status === 'failed') meta.push(t('failed'));

			return react.createElement(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
				react.createElement(
					'div',
					{ style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
					react.createElement(
						'span',
						{
							title: task.name || task.msg || task.id,
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
			);
		}

		/**
		 * The `shell.overlay` entry. Polls the Host for a status snapshot and
		 * renders nothing while there is no task worth showing, so the overlay
		 * layer stays click-through when idle.
		 * @param props - the injected status caller and the locale seat.
		 * @returns the pill, or null.
		 */
		function SmartDlProgressPill({ requestStatus, t }) {
			const [tasks, setTasks] = react.useState(null);
			const [now, setNow] = react.useState(() => Date.now());

			react.useEffect(() => {
				let cancelled = false;
				let timer = null;
				const controller = new AbortController();
				const tick = async () => {
					try {
						const result = await requestStatus({ limit: STATUS_LIMIT }, controller.signal);
						if (cancelled) return;
						if (result && result.ok && result.value && Array.isArray(result.value.tasks)) {
							setTasks(result.value.tasks);
							setNow(Date.now());
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
			}, [requestStatus]);

			if (tasks === null) return null;
			const visible = tasks.filter(
				(task) => isLive(task, now) || isRecentReceipt(task, now),
			);
			if (visible.length === 0) return null;

			return react.createElement(
				'div',
				{
					'data-dsh-smart-dl': 'progress',
					role: 'status',
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
					},
				},
				react.createElement(
					'div',
					{
						style: {
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
				visible.map((task) =>
					react.createElement(TaskRow, { key: task.id, task: task, t: t }),
				),
			);
		}

		/**
		 * Client plugin body: install the dictionaries, then contribute the pill
		 * to the frame-wide overlay once ui-layout has declared that slot.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				'dsh-smart-dl: dictionaries',
			);

			/** Business face of the overlay entry: the Host status caller. */
			const statusInjected = () => ({
				requestStatus: (payload, signal) =>
					ctx.connection.rpc.call(API_PATH, STATUS_ENDPOINT, payload, signal),
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

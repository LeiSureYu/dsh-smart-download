/**
 * aria2 常驻 RPC daemon（1.9.0）：懒启动、单例、进程生命周期绑定。
 *
 * 为什么要有这一层（1.9.0）：1.8 及之前每次下载 spawn 一个 aria2c 进程，
 * 暂停 = 杀进程，继续 = 重启 + 断点续传——亚秒级但不是原地语义。常驻 daemon
 * 之后：暂停/继续是 `aria2.pause` / `aria2.unpause` 的原地操作，队列与连接
 * 预算由 daemon 原生管理，进度从 stdout 摘要解析变成结构化 tellStatus。
 * SPIKE 实测（docs/SPIKE-1.9-RPC.md）：pause 23ms / unpause 恢复 41ms。
 *
 * 生命周期绑定（SPIKE Q1 实测）：
 * - POSIX：daemon 带 `--stop-with-pid=<插件进程 pid>`，插件死亡 daemon 跟随退出；
 * - Windows：该选项不存在，改为 stdin-EOF watchdog——插件持有 watchdog 的
 *   stdin 管道，插件死亡 → EOF → watchdog 杀 daemon 后退出。两平台都保证
 *   「daemon 绝不比插件进程活得更久」。
 *
 * 安全：`--rpc-secret` 强制（随机生成）；daemon 的 RPC 端口没有 bind-address
 * 选项、监听所有网卡——这是 aria2 的限制，1.9 立项时已记录（SPIKE 附带发现），
 * SECURITY.md 的暴露面说明需随之更新。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)

/** daemon 不可用时的专用错误：调用方据此回退 spawn / curl 路径。 */
export class DaemonUnavailableError extends Error {}

interface DaemonState {
  port: number
  secret: string
  process: ChildProcess
  /** Windows 模式下的 watchdog 子进程（POSIX 为 undefined） */
  watchdog?: ChildProcess
  /** 随包二进制路径（用于降级路径复用） */
  aria2Path: string
}

let state: DaemonState | null = null
let starting: Promise<DaemonState> | null = null

/** daemon 是否已在运行（诊断 / 测试用） */
export function isDaemonRunning(): boolean {
  return state !== null
}

/** 仅供测试：重置单例状态（不杀真实进程） */
export function resetDaemonForTest(): void {
  state = null
  starting = null
}

function aria2Path(): string {
  try {
    const target = { pkg: '', bin: '' }
    void target
    // 与 src/downloader.ts 的定位逻辑一致（随包子包 → PATH）
    const { getAria2Path } = require('./downloader.js') as {
      getAria2Path: () => string | null
    }
    const p = getAria2Path()
    if (!p) throw new Error('aria2c 不可用')
    return p
  } catch (err) {
    throw new DaemonUnavailableError(
      'aria2c 不可用：' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

/**
 * 懒启动 daemon（幂等）：已在运行就直接返回；启动失败抛 DaemonUnavailableError
 * （调用方回退 spawn / curl），绝不静默降级。
 */
export async function ensureDaemon(): Promise<DaemonState> {
  if (state) return state
  if (starting) return starting
  starting = (async () => {
    const aria2Path_ = aria2Path()
    const secret = randomBytes(16).toString('hex')

    // 端口：随机起一个，绑定失败换端口重试（最多 3 次）
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = 17800 + Math.floor(Math.random() * 1000) + attempt * 7
      const stopWithPid = process.platform !== 'win32'
      const args = [
        '--enable-rpc=true',
        '--rpc-listen-port=' + port,
        '--rpc-secret=' + secret,
        '--stop-with-pid=' + process.pid,
        '--dir=' + tmpDir(),
        '--file-allocation=none',
        '--max-connection-per-server=8',
        '--console-log-level=warn',
      ]
      if (stopWithPid) {
        // POSIX：--stop-with-pid 存在且实测可用；插件死亡 daemon 跟随退出
      } else {
        // Windows：该选项不存在（SPIKE Q1b 实测）。watchdog 模式：
        // 插件持有 watchdog 的 stdin，插件死亡 → EOF → watchdog 杀 daemon。
        args.pop() // 去掉 --stop-with-pid
      }

      let child: ChildProcess
      let watchdog: ChildProcess | undefined
      if (stopWithPid) {
        child = spawn(aria2Path_, args, { stdio: 'ignore', windowsHide: true })
      } else {
        // stdin-EOF watchdog（~15 行，内联避免 dist 多一个文件）：
        // watchdog spawn daemon 为自己的 child；插件死亡 → watchdog stdin EOF
        // → watchdog taskkill daemon 后退出。
        const wdCode = `
          const { spawn, execSync } = require('node:child_process')
          const [a2c, ...rest] = process.argv.slice(1)
          const daemon = spawn(a2c, rest, { stdio: 'ignore', windowsHide: true })
          const kill = () => { try { execSync('taskkill /PID ' + daemon.pid + ' /F', { stdio: 'ignore' }) } catch {} ; process.exit(0) }
          process.stdin.on('end', kill)
          process.stdin.on('close', kill)
          process.stdin.resume()
          setInterval(() => {}, 1000)
        `
        watchdog = spawn(
          process.execPath,
          ['-e', wdCode, aria2Path_, ...args],
          { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
        )
        child = watchdog
      }

      // RPC 就绪探测：3s 内 getVersion 成功即视为启动成功
      const ready = await pollReady(port, secret, 3000).catch(() => false)
      if (ready) {
        state = { port, secret, process: child, watchdog, aria2Path: aria2Path_ }
        return state
      }
      lastErr = new Error('RPC 未就绪 (port ' + port + ')')
      // 启动失败：清掉这次尝试的进程，换端口重试
      killTree(child.pid!)
      if (watchdog) killTree(watchdog.pid!)
    }
    throw new DaemonUnavailableError(
      'aria2 RPC daemon 启动失败（3 次尝试）：' +
        (lastErr instanceof Error ? lastErr.message : String(lastErr)),
    )
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

function tmpDir(): string {
  // daemon 的工作目录：每条下载的 dir 由 addUri 的选项各自指定，这里只是占位
  return '.'
}

async function pollReady(port: number, secret: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'boot',
          method: 'aria2.getVersion',
          params: ['token:' + secret],
        }),
        signal: AbortSignal.timeout(800),
      })
      const json = (await res.json()) as { result?: unknown; error?: unknown }
      if (json.result) return true
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 150))
  }
}

function killTree(pid: number): void {
  if (typeof pid !== 'number') return
  try { execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore' }) } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
  }
}

/** RPC 调用（token 鉴权）。 */
export async function rpcCall<T = Record<string, unknown>>(
  method: string,
  params: unknown[],
): Promise<T> {
  if (!state) throw new DaemonUnavailableError('daemon 未启动')
  const res = await fetch(`http://127.0.0.1:${state.port}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'dsh',
      method,
      params: ['token:' + state.secret, ...params],
    }),
    signal: AbortSignal.timeout(8000),
  })
  const json = (await res.json()) as { result?: T; error?: { message: string } }
  if (json.error) throw new Error('RPC ' + method + ': ' + json.error.message)
  return json.result as T
}

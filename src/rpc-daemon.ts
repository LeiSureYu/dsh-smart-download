/**
 * aria2 常驻 RPC daemon（1.9.0 引入，2.0.0 起真正接线运行）：懒启动、单例、
 * 进程生命周期绑定。
 *
 * 为什么要有这一层：1.8 及之前每次下载 spawn 一个 aria2c 进程，暂停 = 杀进程，
 * 继续 = 重启 + 断点续传——亚秒级但不是原地语义。常驻 daemon 之后：暂停/继续是
 * `aria2.pause` / `aria2.unpause` 的原地操作，进度从 stdout 摘要解析变成结构化
 * tellStatus。SPIKE 实测（docs/SPIKE-1.9-RPC.md）：pause 23ms / unpause 41ms。
 *
 * ⚠️ 1.9.0–1.9.3 勘误（2.0.0 审计确认）：这两个模块在 1.9.0–1.9.3 里**从未被
 * 任何代码 import**——「RPC 优先」只在 CHANGELOG 里存在，运行时始终走 spawn。
 * 2.0.0 完成接线（src/index.ts 的 runAria2：RPC → daemon 层失败降级 spawn →
 * curl），并在接线前修掉了审计发现的三个隐患：
 *   1. daemon 崩溃无检测：rpcCall 的**传输层**失败现在会把 daemon 状态作废并
 *      杀掉残骸，下次 ensureDaemon 自动重新拉起（aria2 返回的 JSON-RPC error
 *      是另一回事，不触发重建，见 RpcMethodError）；
 *   2. rpc-secret 下 argv：secret 走一次性 conf 文件（`--conf-path`），启动就绪
 *      后立即删除 —— argv 与磁盘上都不再有 secret（aria2 只在启动时读一次 conf）；
 *   3. pause/remove 打在已完成的 gid 上：完成竞态按**真实完成**收尾，不再把
 *      已完成的下载盖成 cancelled（见 download-rpc.ts 的 RpcCompletedRace）。
 *
 * 生命周期绑定（SPIKE Q1 实测）：
 * - POSIX：daemon 带 `--stop-with-process=<插件进程 pid>`，插件死亡 daemon 跟随退出；
 *   选项名是 `--stop-with-process`（aria2 1.36+），**不是** `--stop-with-pid`——
 *   后者不存在，aria2 会以 `unrecognized option` 直接退出，daemon 一次都起不来；
 * - Windows：该选项不存在，改为 stdin-EOF watchdog——插件持有 watchdog 的
 *   stdin 管道，插件死亡 → EOF → watchdog 杀 daemon 后退出。两平台都保证
 *   「daemon 绝不比插件进程活得更久」。
 *
 * 安全：`--rpc-secret` 强制（随机生成，经 conf 文件下发）；daemon 的 RPC 端口
 * 没有 bind-address 选项、监听所有网卡——这是 aria2 的限制，1.9 立项时已记录
 * （SPIKE 附带发现），SECURITY.md 的暴露面说明需随之更新。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const require = createRequire(import.meta.url)

/** daemon 不可用时的专用错误：调用方据此回退 spawn / curl 路径。 */
export class DaemonUnavailableError extends Error {}

/**
 * aria2 返回的 JSON-RPC 层错误（GID 不存在、状态不允许该操作等）。
 *
 * 为什么与传输层失败分开：JSON-RPC error 是 **aria2 的回答**——daemon 活得好好的，
 * 绝不能触发「daemon 状态作废 / 重新拉起」；而传输层失败（ECONNREFUSED、超时）
 * 意味着 daemon 已死，必须作废状态。1.9.0 的实现把两者混在一个 Error 里，
 * daemon 崩溃后每次下载都对着同一个死端口失败（审计隐患 ①）。
 */
export class RpcMethodError extends Error {}

interface DaemonState {
  port: number
  secret: string
  process: ChildProcess
  /** Windows 模式下的 watchdog 子进程（POSIX 为 undefined） */
  watchdog?: ChildProcess
  /** 随包二进制路径（用于降级路径复用） */
  aria2Path: string
  /** 携带 rpc-secret 的 conf 文件；启动就绪后立即删除（aria2 只在启动时读一次） */
  configFile?: string
}

let state: DaemonState | null = null
let starting: Promise<DaemonState> | null = null

/** daemon 是否已在运行（诊断 / 测试用） */
export function isDaemonRunning(): boolean {
  return state !== null
}

/**
 * 关停 daemon（杀进程树 + 作废状态 + 清 conf 残留）。测试的 after 钩子用它：
 * daemon 的 watchdog stdin 管道由本进程持有，只 reset 状态不杀进程会让
 * node:test 的事件循环永远排不空。
 */
export function shutdownDaemon(): void {
  killDaemon()
}

/** 仅供测试：重置单例状态（不杀真实进程） */
export function resetDaemonForTest(): void {
  state = null
  starting = null
}

function aria2Path(): string {
  try {
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
 * RPC 模式开关（2.0.0）。
 *
 * - `auto`（缺省）：优先 RPC；**daemon 层**失败（起不来 / 失联）自动降级 spawn
 *   路径；aria2 级下载错误与既有路径一样走 curl 回退。
 * - `on`：强制 RPC——daemon 层失败也直接按 aria2 失败处理（走 curl 回退），
 *   不再动用 spawn；调试 RPC 路径用。
 * - `off`：完全回到 spawn 路径（2.0.0 之前的行为）。
 *
 * 未知值与缺省一律按 `auto`：这是内部调优开关而非用户入参，静默回退到最安全
 * 的默认比拒绝调用更合适。
 */
export type Aria2RpcMode = 'auto' | 'on' | 'off'
export const ARIA2_RPC_MODE_ENV = 'DSH_SMARTDL_ARIA2_RPC'
export function aria2RpcMode(env: NodeJS.ProcessEnv = process.env): Aria2RpcMode {
  const raw = (env[ARIA2_RPC_MODE_ENV] ?? '').trim().toLowerCase()
  if (raw === 'on' || raw === '1' || raw === 'true') return 'on'
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  return 'auto'
}

/**
 * 把 rpc-secret 写进一次性 conf 文件而不是 argv（2.0.0，审计隐患 ②）。
 *
 * 为什么不走 argv：daemon 会活过单次下载，`--rpc-secret=<hex>` 会一直留在
 * 进程命令行上（本机任意同权限进程可读）。aria2 支持从 conf 文件读任意选项
 * （`--conf-path`），且**只在启动时读一次**——所以启动就绪后立即删除文件，
 * secret 既不在 argv、也不在磁盘上留下任何驻留副本。
 */
function writeSecretConfig(secret: string): string {
  const file = path.join(os.tmpdir(), `dsh-smartdl-aria2-${randomBytes(8).toString('hex')}.conf`)
  // mode 0o600：POSIX 上仅本用户可读（Windows 忽略该位，但 tmpdir 本就按用户隔离）
  fs.writeFileSync(file, `rpc-secret=${secret}\n`, { mode: 0o600 })
  return file
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
    const configFile = writeSecretConfig(secret)
    // 启动失败的清理要能拿到文件路径，提到循环外层
    let lastErr: unknown

    try {
      // 端口：随机起一个，绑定失败换端口重试（最多 3 次）
      for (let attempt = 0; attempt < 3; attempt++) {
        const port = 17800 + Math.floor(Math.random() * 1000) + attempt * 7
        const useStopWithProcess = process.platform !== 'win32'
        const args = [
          '--enable-rpc=true',
          '--rpc-listen-port=' + port,
          // secret 经 conf 文件下发，argv 上只有文件路径（2.0.0）
          '--conf-path=' + configFile,
          '--dir=' + tmpDir(),
          '--file-allocation=none',
          '--max-connection-per-server=8',
          '--console-log-level=warn',
        ]
        if (useStopWithProcess) {
          // POSIX：--stop-with-process=PID 存在（aria2 1.36+）；插件死亡 daemon 跟随退出。
          // 选项名不能写成 --stop-with-pid：aria2 不认识它，会立刻以
          // "unrecognized option" 退出，pollReady 三次全超时 —— 2.0.0 交付时
          // Linux/macOS 上 RPC daemon 就是这么一次都没起来过（CI 的 Test 步骤红在
          // test/rpc-daemon.test.ts 的 4 条用例）。
          args.push('--stop-with-process=' + process.pid)
        }
        // Windows：该选项不存在（SPIKE Q1b 实测）。watchdog 模式：
        // 插件持有 watchdog 的 stdin，插件死亡 → EOF → watchdog 杀 daemon。

        let child: ChildProcess
        let watchdog: ChildProcess | undefined
        if (useStopWithProcess) {
          child = spawn(aria2Path_, args, { stdio: 'ignore', windowsHide: true })
        } else {
          // stdin-EOF watchdog（~15 行，内联避免 dist 多一个文件）：
          // watchdog spawn daemon 为自己的 child；插件死亡 → watchdog stdin EOF
          // → watchdog taskkill daemon 后退出。argv 上只有 conf 路径，没有 secret。
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

        // 常驻 daemon 不能把宿主进程的事件循环钉住（2.0.0 修掉选项名之后暴露的
        // 第一个 CI 症状：用例全绿、测试文件却永不退出，check job 15 分钟被
        // timeout 取消 —— 父进程被这个 child 句柄挂着，事件循环永远排不空）。
        // unref 的语义正是需要的：daemon 该活多久活多久，「父进程能不能自然退出」
        // 不再由它决定 —— 父进程退出后，POSIX 的 --stop-with-process 与 Windows
        // 的 watchdog stdin-EOF 各自收尸，生命周期绑定不受影响。
        child.unref()
        // Windows：stdin 管道是父进程侧的真实句柄，光 unref 子进程不够。
        // unref 管道不影响 EOF 语义（父进程一退出，fd 关闭，watchdog 照常收尸）。
        const watchdogStdin = watchdog?.stdin as unknown as { unref?: () => void } | null
        watchdogStdin?.unref?.()

        // RPC 就绪探测：3s 内 getVersion 成功即视为启动成功
        const ready = await pollReady(port, secret, 3000).catch(() => false)
        if (ready) {
          state = { port, secret, process: child, watchdog, aria2Path: aria2Path_, configFile }
          // aria2 只在启动时读一次 conf：secret 的磁盘副本到此为止
          try {
            fs.rmSync(configFile, { force: true })
          } catch {
            /* 删除失败不影响运行；killDaemon 会再试一次 */
          }
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
    } finally {
      // 走到这一步意味着三次尝试全失败：conf 文件（含 secret）必须清掉。
      // 成功路径上的删除在上面的就绪分支里已经做过。
      if (state === null) {
        try {
          fs.rmSync(configFile, { force: true })
        } catch {
          /* 尽力而为 */
        }
      }
    }
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

/** 杀掉当前 daemon（进程树 + 状态作废 + conf 残留清理）。 */
function killDaemon(): void {
  const st = state
  state = null
  if (!st) return
  killTree(st.process.pid!)
  if (st.watchdog) killTree(st.watchdog.pid!)
  if (st.configFile !== undefined) {
    try {
      fs.rmSync(st.configFile, { force: true })
    } catch {
      /* 尽力而为 */
    }
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

/**
 * RPC 调用（token 鉴权）。
 *
 * 失败分两类（2.0.0，审计隐患 ①）：
 * - **传输层失败**（daemon 已死 / 端口失联 / 超时）：daemon 状态作废、残骸清掉，
 *   抛 `DaemonUnavailableError` —— 调用方（index.ts 的 runAria2）在 auto 模式下
 *   降级 spawn，下一次下载会重新拉起 daemon；
 * - **JSON-RPC 层错误**（aria2 的回答，如 GID 不存在）：daemon 活得好好的，
 *   抛 `RpcMethodError`，绝不清状态。
 *
 * 1.9.0 的实现把两类混在一个 Error 里：daemon 崩溃后状态永远指着死端口，
 * 之后每一次下载都以同样的方式失败。
 */
export async function rpcCall<T = Record<string, unknown>>(
  method: string,
  params: unknown[],
): Promise<T> {
  const st = state
  if (!st) throw new DaemonUnavailableError('daemon 未启动')
  let json: { result?: T; error?: { message: string; code?: number } }
  try {
    const res = await fetch(`http://127.0.0.1:${st.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'dsh',
        method,
        params: ['token:' + st.secret, ...params],
      }),
      signal: AbortSignal.timeout(8000),
    })
    json = (await res.json()) as typeof json
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 传输层失败：daemon 状态作废。残骸必须清掉（watchdog 只在插件死亡时兜底，
    // daemon 自身死亡时它还活着，不会主动清理）。
    killDaemon()
    throw new DaemonUnavailableError('aria2 RPC daemon 失联：' + message)
  }
  if (json.error) {
    throw new RpcMethodError('RPC ' + method + ': ' + (json.error.message ?? '未知错误'))
  }
  return json.result as T
}

/**
 * 下载执行逻辑：
 * - 支持多线程时调用随插件分发的 aria2c（按决策档位开连接）；
 * - 否则回退到系统自带的 curl；
 * - 统一处理 AbortSignal 取消、Windows 隐藏窗口、stderr 收集与进度解析。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  resolve as resolvePath,
} from 'node:path'
import {
  parseAria2Summary,
  parseCurlProgress,
  splitIntoLines,
} from './progress-parse.js'
import type { ProgressReporter } from './progress.js'

const require = createRequire(import.meta.url)

/**
 * 随包 aria2 的目标平台描述。
 * 每个受支持平台对应一个独立的 npm 子包，子包用 os/cpu 字段声明适用平台，
 * npm / pnpm 在不匹配的平台上会自动跳过安装。
 */
export interface Aria2Target {
  /** 子包名 */
  pkg: string
  /** 子包内二进制的相对路径 */
  bin: string
}

/**
 * 平台 → 子包映射表。
 * 键为 `${process.platform}-${process.arch}`，与 npm 的 os/cpu 字段语义一致。
 * 未列入的平台（如 darwin）视为不支持，getAria2Path 返回 null，由调用方回退 curl。
 */
export const ARIA2_TARGETS: Readonly<Record<string, Aria2Target>> = Object.freeze({
  'win32-x64': { pkg: '@leisureyu/dsh-aria2-win32-x64', bin: 'bin/aria2c.exe' },
  'win32-arm64': { pkg: '@leisureyu/dsh-aria2-win32-arm64', bin: 'bin/aria2c.exe' },
  'linux-x64': { pkg: '@leisureyu/dsh-aria2-linux-x64', bin: 'bin/aria2c' },
  'linux-arm64': { pkg: '@leisureyu/dsh-aria2-linux-arm64', bin: 'bin/aria2c' },
})

/** 子进程逐行回调 */
export interface ProcessLineHandlers {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

/**
 * 查询给定平台 / 架构对应的 aria2 子包描述。
 * 不支持的平台返回 null。纯函数，便于单测（无需真的跑在目标平台上）。
 */
export function aria2TargetFor(
  platform: string,
  arch: string,
): Aria2Target | null {
  return ARIA2_TARGETS[`${platform}-${arch}`] ?? null
}

/**
 * 定位随插件分发的 aria2 二进制。
 * 按当前平台 / 架构选择子包；平台不受支持或子包未安装时返回 null，
 * 由调用方回退到 curl。
 */
export function getAria2Path(): string | null {
  const target = aria2TargetFor(process.platform, process.arch)
  if (!target) return null
  try {
    return require.resolve(`${target.pkg}/${target.bin}`)
  } catch {
    return null
  }
}

/**
 * 拼接 aria2 命令行参数。
 * -x/-s 使用决策得到的并发数；
 * -c 开启断点续传（同名文件已存在时从断点继续，而不是重头再来）；
 * --allow-overwrite=true 允许覆盖已存在的同名文件；
 * --summary-interval=1 每秒输出摘要，--show-console-readout=false 关闭原地刷新，
 * 便于以“每行一条”的方式解析进度。
 * 注意：aria2 的 -o 只接受相对文件名，目录必须通过 -d 指定。
 *
 * 为什么必须显式 `--allow-overwrite=true`（0.6.0 实测）：
 * aria2 默认遇到同名文件不会覆盖，而是**另存为 `f.1.bin`**（实测：目录里同时
 * 出现 `f.bin` 400 字节旧内容与 `f.1.bin` 1000 字节新内容）。这时下载「成功」
 * 了，但调用方拿到的 `output` 路径指向的仍是那个旧文件 —— 一次静默的路径错位。
 * 加上该开关后实测落盘正确覆盖为 1000 字节。
 * 注意它与 `-c` 并不冲突：`-c` 只在能续传时生效，不能续传时该开关接管覆盖语义。
 *
 * ⚠️ 为什么 `-k 1M` 绝对不能删（0.7.0 实测）：
 * aria2 默认 `min-split-size=20M`。文件小于 20MB 时它**完全不分片** ——
 * 实测 8MB 文件在默认参数下只发出 1 个不带 Range 的 GET，`-x 16 -s 16`
 * 形同虚设，吞吐和单连接一样。带上 `-k 1M` 后同一文件立刻分成 8 片，
 * 吞吐从 1.61 MB/s 涨到 11.99 MB/s。删掉这一行会让 `decideConcurrency()`
 * 的所有档位**静默退化成单连接**，且没有任何报错。
 * 另外实测 `--min-split-size=512K` 会让 aria2 以退出码 28 直接失败，
 * 说明该值有下限，1M 是当前验证过的安全取值。
 */
export function buildAria2Args(
  url: string,
  outputPath: string,
  concurrency: number = 8,
  resume: boolean = true,
): string[] {
  const dir = dirname(outputPath)
  const base = basename(outputPath)
  const args: string[] = [
    '-x', String(concurrency), // 单服务器最大连接数
    '-s', String(concurrency), // 同时使用的连接数
    // 最小分片大小：决定并发上限，删掉会让 -x/-s 失效，详见函数上方注释
    '-k', '1M',
    // 断点续传：仅在确认安全时开启（见 src/resume.ts）
    ...(resume ? ['-c'] : []),
    '--allow-overwrite=true', // 不能续传时覆盖旧文件，而不是另存 f.1.bin
    '--file-allocation=none', // 不预分配磁盘空间，Windows 上更快
    '--console-log-level=warn',
    '--summary-interval=1', // 每秒输出一次进度摘要
    '--show-console-readout=false', // 关闭原地刷新，改用摘要行
  ]
  if (dir && dir !== '.') {
    args.push('-d', isAbsolute(dir) ? dir : resolvePath(dir))
  }
  args.push('-o', base, url)
  return args
}

/**
 * 拼接 curl 回退命令行参数。
 * --progress-bar 强制输出百分比进度（即使 stderr 不是终端）；
 * resume=true 时追加 -C - 开启断点续传；
 * 不使用 --silent，避免把进度条一并抑制，错误信息由 --show-error 输出。
 *
 * 为什么续传是条件式的（实测结论，勿改成无条件）：
 * curl -C - 在服务器**不支持** Range 且本地已有半截文件时，会以退出码 33 直接失败
 * （实测：1000 字节资源、已有 400 字节半包 -> exit 33，文件保持 400 字节不损坏）。
 * 而不带 -C - 时同一个场景能正常全量重新下载成功。
 * 因此只在探测确认支持 Range（或文件尚不存在）时才加 -C -。
 * 支持 Range 的场景实测三种情况均正确：半包续传、已完成后重跑、无文件从头下。
 */
export function buildCurlArgs(
  url: string,
  outputPath: string,
  resume: boolean = false,
): string[] {
  // 用条件展开代替 `splice(2, 0, ...)`：位置魔法意味着「在数组字面量中间插入
  // 一个元素」，一旦前面插入/删除任何开关，续传开关就会插错位置（曾经一次
  // 误插让 `-o` 与输出路径分离）。条件展开让顺序由字面量本身表达。
  return [
    '--progress-bar',
    '-L', // 跟随重定向
    // 断点续传：自动读取已下载长度并从断点继续；文件不存在时从 0 开始
    ...(resume ? ['-C', '-'] : []),
    '-o', outputPath,
    '--fail', // HTTP 错误时返回非零退出码
    '--show-error', // 输出错误信息
    url,
  ]
}

/** 确保输出文件所在目录存在 */
async function ensureOutputDir(outputPath: string): Promise<void> {
  const dir = dirname(outputPath)
  if (dir && dir !== '.') {
    await mkdir(isAbsolute(dir) ? dir : resolvePath(dir), { recursive: true })
  }
}

/** 累积流式数据并按行（兼容 \r / \n）吐出完整片段，保留半截内容 */
export class LineBuffer {
  private pending = ''
  push(chunk: string, emit: (line: string) => void): void {
    this.pending += chunk
    const parts = splitIntoLines(this.pending)
    this.pending = parts.pop() ?? ''
    for (const line of parts) {
      if (line.length > 0) emit(line)
    }
  }
  flush(emit: (line: string) => void): void {
    if (this.pending.length > 0) {
      emit(this.pending)
      this.pending = ''
    }
  }
}

/**
 * 启动子进程并等待其结束。
 * - windowsHide：隐藏黑色命令行窗口；
 * - 收集 stderr，非零退出时随错误抛出；
 * - 通过 handlers 逐行回调 stdout / stderr，用于解析进度；
 * - AbortSignal 触发时先 SIGTERM，1s 内未退出则 SIGKILL 兜底。
 *
 * 为什么 SIGKILL 兜底**不能**只在 Windows 上启用（1.0.0 修正）：
 * 0.9.0 之前的前置条件是 `process.platform === 'win32'`。而「SIGTERM 被忽略」
 * 这件事不分平台 —— POSIX 上进程同样可以装一个 SIGTERM handler 然后继续跑。
 * 一旦如此，取消下载就永远等不到 close 事件，`smart_download` 会挂在那里不返回，
 * 用户按了取消却看不出任何变化。兜底必须对所有平台生效。
 */
export function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  handlers: ProcessLineHandlers = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      const options: SpawnOptions = { windowsHide: true }
      child = spawn(command, args, options)
    } catch (err) {
      reject(err)
      return
    }

    let stderr = ''
    let exited = false
    let aborted = false

    const outBuffer = new LineBuffer()
    const errBuffer = new LineBuffer()

    child.stdout?.on('data', (chunk: Buffer | string) => {
      outBuffer.push(chunk.toString(), (line) => handlers.onStdout?.(line))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      errBuffer.push(text, (line) => handlers.onStderr?.(line))
    })

    const onAbort = () => {
      if (aborted || exited) return
      aborted = true
      try {
        child.kill('SIGTERM')
      } catch {
        // 忽略 kill 异常，继续尝试强制结束
      }
      // SIGTERM 可能不被响应（Windows 原生没有信号语义，POSIX 上进程也可以
      // 忽略它），1 秒后强制结束。所有平台都挂这个兜底，避免取消后永久挂住。
      const timer = setTimeout(() => {
        if (!exited) {
          try {
            child.kill('SIGKILL')
          } catch {
            // 忽略
          }
        }
      }, 1000)
      timer.unref?.()
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.on('error', (err) => {
      exited = true
      signal?.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(new Error(`下载已取消：${command} 被 AbortSignal 终止`))
      } else {
        reject(err)
      }
    })

    child.on('close', (code, closeSignal) => {
      exited = true
      signal?.removeEventListener('abort', onAbort)
      outBuffer.flush((line) => handlers.onStdout?.(line))
      errBuffer.flush((line) => handlers.onStderr?.(line))

      if (aborted) {
        reject(new Error(`下载已取消：${command} 被 AbortSignal 终止`))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const tail = stderr.trim()
      reject(
        new Error(
          `${command} 退出码 ${code}${closeSignal ? `（信号 ${closeSignal}）` : ''}` +
            (tail ? `\nstderr:\n${tail}` : ''),
        ),
      )
    })
  })
}

/** 使用 aria2 多线程下载，并把摘要进度透传给 reporter */
export async function downloadWithAria2(
  aria2Path: string,
  url: string,
  outputPath: string,
  concurrency: number,
  signal?: AbortSignal,
  reporter?: ProgressReporter,
  resume: boolean = true,
): Promise<void> {
  await ensureOutputDir(outputPath)
  const args = buildAria2Args(url, outputPath, concurrency, resume)
  await runProcess(aria2Path, args, signal, {
    onStdout: (line) => {
      const parsed = parseAria2Summary(line)
      if (parsed && reporter) {
        reporter.report(parsed.pct, '下载中（aria2）', parsed.spd, parsed.eta)
      }
    },
  })
}

/** 使用 curl 单线程下载（回退方案），解析进度条百分比透传给 reporter */
export async function downloadWithCurl(
  url: string,
  outputPath: string,
  signal?: AbortSignal,
  reporter?: ProgressReporter,
  resume: boolean = false,
): Promise<void> {
  await ensureOutputDir(outputPath)
  const args = buildCurlArgs(url, outputPath, resume)
  await runProcess('curl', args, signal, {
    onStderr: (line) => {
      const pct = parseCurlProgress(line)
      if (pct !== null && reporter) {
        reporter.report(pct, '下载中（curl）')
      }
    },
  })
}

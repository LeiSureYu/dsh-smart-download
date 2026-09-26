/**
 * 下载执行逻辑：
 * - 支持多线程时调用随插件分发的 aria2c.exe（按决策档位开连接）；
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

/** aria2 二进制所在子包名（发布前请把 scope 替换为你自己的 npm scope） */
export const ARIA2_PACKAGE = '@leisureyu/dsh-aria2-win32-x64'

/** 子进程逐行回调 */
export interface ProcessLineHandlers {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

/**
 * 定位随插件分发的 aria2c.exe。
 * 仅在 Windows x64 上可用；找不到时返回 null，由调用方回退 curl。
 */
export function getAria2Path(): string | null {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null
  try {
    return require.resolve(`${ARIA2_PACKAGE}/bin/aria2c.exe`)
  } catch {
    return null
  }
}

/**
 * 拼接 aria2 命令行参数。
 * -x/-s 使用决策得到的并发数；
 * --summary-interval=1 每秒输出摘要，--show-console-readout=false 关闭原地刷新，
 * 便于以“每行一条”的方式解析进度。
 * 注意：aria2 的 -o 只接受相对文件名，目录必须通过 -d 指定。
 */
export function buildAria2Args(
  url: string,
  outputPath: string,
  concurrency: number = 8,
): string[] {
  const dir = dirname(outputPath)
  const base = basename(outputPath)
  const args: string[] = [
    '-x', String(concurrency), // 单服务器最大连接数
    '-s', String(concurrency), // 同时使用的连接数
    '-k', '1M', // 最小分片大小
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
 * 不使用 --silent，避免把进度条一并抑制，错误信息由 --show-error 输出。
 */
export function buildCurlArgs(url: string, outputPath: string): string[] {
  return [
    '--progress-bar',
    '-L', // 跟随重定向
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
 * - AbortSignal 触发时先 SIGTERM，Windows 上若 1s 内未退出则强制 kill。
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
      // Windows 上 SIGTERM 可能不被响应，1 秒后强制结束
      if (process.platform === 'win32') {
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
): Promise<void> {
  await ensureOutputDir(outputPath)
  const args = buildAria2Args(url, outputPath, concurrency)
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
): Promise<void> {
  await ensureOutputDir(outputPath)
  const args = buildCurlArgs(url, outputPath)
  await runProcess('curl', args, signal, {
    onStderr: (line) => {
      const pct = parseCurlProgress(line)
      if (pct !== null && reporter) {
        reporter.report(pct, '下载中（curl）')
      }
    },
  })
}

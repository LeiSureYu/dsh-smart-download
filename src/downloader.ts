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
import { headersToAria2Args, headersToCurlArgs } from './headers.js'
import type { ProgressReporter } from './progress.js'
import type { DownloadMethod, RequestHeaders } from './types.js'

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
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
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
    // 带宽上限（可选）：一个 aria2 进程内的**合计**上限，因此批量时必须把总量
    // 按并发位分给每个进程（见 src/index.ts 的批量编排），否则一批会翻 N 倍。
    // 缺省时这一项整个不出现 —— 命令行与 1.2.0 逐字节相同（回归项）。
    ...(maxDownloadLimitBytes === undefined
      ? []
      : [`--max-overall-download-limit=${String(maxDownloadLimitBytes)}`]),
    // 自定义头（UA / Referer / …）与探测用的是同一份，见 src/headers.ts
    ...headersToAria2Args(headers),
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
 *
 * 退出码 33 的含义要按官方定义读（1.3.0 收口）：**33 = HTTP range error**，即「我们发出去的
 * Range 请求没被接受」。它既可能是服务器真的不支持 Range，也可能只是**忽略了这一次**请求带上的
 * Range —— t8 复现时 curl 自己的 stderr 就是
 * `HTTP server does not seem to support byte ranges. Cannot resume.`，
 * 注意是 does not *seem*：那是 curl 的推测，不是服务器给出的声明。
 * 因此**不能**拿 33 推断「这台服务器永久不支持续传」（那要按 **36 = bad download resume** 判）；
 * 上面那句「服务器不支持 Range」只是对那次实测场景的描述，不是对 33 的定义。
 */
export function buildCurlArgs(
  url: string,
  outputPath: string,
  resume: boolean = false,
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
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
    // 带宽上限（可选）：curl 是单连接，--limit-rate 就是这一条任务的上限；
    // 批量时由调用方按并发位分好份额再传进来（见 src/index.ts 的批量编排）。
    // 缺省时这一项整个不出现 —— 命令行与 1.2.0 逐字节相同（回归项）。
    ...(maxDownloadLimitBytes === undefined
      ? []
      : ['--limit-rate', String(maxDownloadLimitBytes)]),
    // 自定义头（UA / Referer / …）与探测用的是同一份，见 src/headers.ts
    ...headersToCurlArgs(headers),
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
 * 子进程退出码 → 中文原因 + 下一步。
 *
 * 为什么需要这一层：子进程退出码是**唯一**能区分「传输失败」与「站点拒绝」的信号，
 * 而把裸退出码与原始 stderr 直出给用户，等于让用户自己去查 curl / aria2 的手册
 * —— 那不是「可操作的错误提示」，只是把问题原样转述一遍。
 *
 * ⚠️ 改动前务必先读：**这里每一个码都必须能追到下面标注的来源**。
 * 写错映射比不翻译更糟 —— 它会让用户按错误的方向排查。查不到来源的码
 * 一律不进表（宁可不翻译，不可翻译错），由 `describeExitCode` 走未知码分支
 * 原样保留退出码与 stderr。
 *
 * 来源（两条都已在 2026-10-12 实际取回核对，不是凭记忆填的）：
 * - curl：<https://curl.se/docs/manpage.html> 的 "Exit codes" 一节。
 *   `curl --help all` 只列选项、不列退出码，因此只能引官方文档。
 * - aria2：官方手册 <https://github.com/aria2/aria2/blob/master/doc/manual-src/en/aria2c.rst>
 *   的 "EXIT STATUS" 一节。随包 aria2 的 `aria2c -h#exit-status` **不认这个 tag**
 *   （合法 tag 列表里没有它），所以也只能引官方手册。
 */
export interface ExitCodeDescription {
  /** 中文原因：这条码在说什么 */
  reason: string
  /** 下一步：用户看完知道该做什么 */
  next: string
}

/** 退出码映射表（两个下载工具各一张，来源见上方说明） */
export const EXIT_CODE_DESCRIPTIONS: Readonly<
  Record<DownloadMethod, Readonly<Record<number, ExitCodeDescription>>>
> = Object.freeze({
  curl: Object.freeze({
    18: {
      reason: '传输不完整：只收到一部分数据，连接就被对端或中间设备断开',
      next: '可重试；半包与旁车指纹已保留，下次会先核对同源再续传',
    },
    22: {
      reason: 'HTTP 错误：服务器返回了 400 及以上的状态码（本插件固定带 --fail）',
      next: '确认地址是否有效、是否已过期；需要鉴权时用 headers / referer 传凭证',
    },
    28: {
      reason: '超时：在约定的时限内没有完成传输',
      next: '可重试；若站点较慢，请检查网络或改用镜像（mirror 参数）',
    },
    33: {
      reason: 'HTTP Range 请求未被服务器接受',
      next: '本地半包已删除，重跑一次会全量重新下载',
    },
    56: {
      reason: '接收数据失败：连接被重置或对端中途关闭',
      next: '可重试；半包与旁车指纹已保留，下次会先核对同源再续传',
    },
  }),
  aria2: Object.freeze({
    1: {
      reason: '未知错误',
      next: '重试一次；仍失败请把下面的 stderr 尾部一并反馈',
    },
    3: {
      reason: '资源不存在（服务器返回 404 一类）',
      next: '确认地址是否有效、是否已过期',
    },
    9: {
      reason: '磁盘空间不足',
      next: '清理磁盘或换一个 output 路径后重试',
    },
    13: {
      reason: '文件已存在且不允许覆盖',
      next: '本插件固定带 --allow-overwrite=true，出现这条通常意味着目标路径不可写',
    },
    24: {
      reason: 'HTTP 鉴权失败',
      next: '用 headers / referer 传凭证（例如 Authorization），或确认凭证是否过期',
    },
  }),
})

/** 从命令行取可执行文件名（去掉目录与 `.exe`）：用户不需要看到绝对路径 */
function executableName(command: string): string {
  return basename(command).replace(/\.exe$/i, '')
}

/**
 * 把退出码翻译成给用户看的错误消息；退出码为 0 时返回 `null`。
 *
 * 返回 `null` 而不是空串：调用方据此决定「正常结束、不产生任何文案」，
 * 空串会让 `if (message)` 这类判断失效。
 *
 * @param command 子进程命令（可能是绝对路径，文案里只取可执行文件名）
 * @param code 退出码；被信号终止时 Node 可能给 `null`
 * @param signal 终止该进程的信号名（Windows 上恒为 `null`）
 * @param stderrTail 子进程 stderr 尾部；**任何分支都原样保留**，不得丢弃
 */
export function describeExitCode(
  command: string,
  code: number | null,
  signal: string | null,
  stderrTail: string,
): string | null {
  if (code === 0) return null

  const name = executableName(command)
  const head = `${name} 退出码 ${code ?? '未知'}${signal ? `（信号 ${signal}）` : ''}`
  const detail = stderrTail ? `\nstderr:\n${stderrTail}` : ''

  const method: DownloadMethod = /aria2/i.test(name) ? 'aria2' : 'curl'
  const known = code === null ? undefined : EXIT_CODE_DESCRIPTIONS[method][code]
  if (!known) {
    // 未知码必须原样保留退出码与 stderr：丢掉它们等于把唯一能排查的线索删了；
    // 而编一个原因更糟 —— 用户会照着一个不存在的原因去排查。
    return `${head}${detail}`
  }
  return `${head}：${known.reason}\n下一步：${known.next}${detail}`
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
        // 与退出码分支同一条不变量：用户可见文案里只出现可执行文件名，
        // 绝不出现 node_modules 里的绝对路径（1.3.0 收口，见 executableName）。
        reject(new Error(`下载已取消：${executableName(command)} 被 AbortSignal 终止`))
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
        reject(new Error(`下载已取消：${executableName(command)} 被 AbortSignal 终止`))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const tail = stderr.trim()
      // 退出码翻译与命令名收敛都收在 describeExitCode 里：这里只负责「非零退出
      // 必须有消息」这一条不变量，退出码为 0 的分支在上面已经 resolve 掉了。
      const message = describeExitCode(command, code, closeSignal, tail)
      reject(new Error(message ?? `${executableName(command)} 退出码 ${code ?? '未知'}`))
    })
  })
}

/**
 * 一次 aria2 下载观测到的吞吐（P1-2 的原始数据）。
 *
 * 为什么由 downloader 这一层返回、而不是就地写缓存：`CN` 与 `DL` 只出现在 aria2 的 stdout
 * 摘要行里，解析只有这一层做得到；而「什么时候值得记」是策略（见 `src/index.ts` 的
 * `recordObservedThroughput`）—— 解析与策略分开，两者才能各自被单测。
 */
export interface Aria2Observation {
  /** 最后一次摘要里的速度换算成字节/秒 */
  throughput: number
  /** 本次**请求**的并发数（插件交给 aria2 的 `-x/-s`） */
  concurrency: number
  /**
   * 整段观测到的**峰值**实际有效连接数（摘要里的 `CN` 的最大值，见 src/progress-parse.ts）。
   *
   * 为什么是峰值而不是最后一条：aria2 收尾时会把连接逐条关掉，最后一条摘要反映的是排空阶段
   * （实测 8MB/8 连接：`{60%, CN:8}` → `{96%, CN:1}`）。而这份记录的唯一用途是回答「这台主机
   * 上次给了我们几条连接」，那个问题只有峰值答得了 —— 尾部那个 1 会让抬档门槛被误判为不满足。
   */
  cn: number
}

/**
 * 把摘要里的速度字符串换算成字节/秒；解析不出来返回 `undefined`。
 *
 * 单位语义按国际惯例分开：带 `i` 的（KiB/MiB/GiB）是 1024 进制，不带的（KB/MB）是 1000 进制。
 * aria2 实测吐的是 `MiB` 这类二进制单位，但 `progress-parse.ts` 的正则也接受不带 `i` 的写法，
 * 所以两种都要给对。解析不出来时宁可不记 —— 一个错数字会一直躺在中位数里。
 */
export function summarySpeedBytes(spd: string): number | undefined {
  const m = /^([\d.]+)\s*([KMGTPE]?i?B)\/s$/i.exec(spd.trim())
  if (!m) return undefined
  const value = Number.parseFloat(m[1] as string)
  if (!Number.isFinite(value) || value < 0) return undefined
  const unit = (m[2] as string).toUpperCase()
  const letter = unit.replace('I', '').replace('B', '')
  // 正则已经保证前缀只可能是 '' 或 K/M/G/T/P/E，因此这里不需要再挡未知前缀
  const exponent = letter === '' ? 0 : 'KMGTPE'.indexOf(letter) + 1
  // 二进制单位写作 `MiB`：`i` 在 `B` **之前**，所以要判 `IB` 结尾而不是 `I` 结尾
  // （写成 endsWith('I') 会把 10MiB 算成 10000000 —— 单测当场抓到了这个错）
  const base = unit.endsWith('IB') ? 1024 : 1000
  return exponent === 0 ? value : value * base ** exponent
}

/**
 * 使用 aria2 多线程下载，并把摘要进度透传给 reporter。
 *
 * 返回值是**最后一次**有效摘要里的观测（调用方据此写吞吐缓存）：为什么取最后一次而不是平均
 * ——摘要是一秒一次的瞬时值，最后一次最接近结束时的真实带宽，早期样本会被建连与慢启动拉低。
 *
 * @returns 观测到的吞吐；一次摘要都没解析出来（下载太快 / 输出被改）时返回 `undefined`
 */
export async function downloadWithAria2(
  aria2Path: string,
  url: string,
  outputPath: string,
  concurrency: number,
  signal?: AbortSignal,
  reporter?: ProgressReporter,
  resume: boolean = true,
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
): Promise<Aria2Observation | undefined> {
  await ensureOutputDir(outputPath)
  const args = buildAria2Args(url, outputPath, concurrency, resume, headers, maxDownloadLimitBytes)
  let observed: Aria2Observation | undefined
  await runProcess(aria2Path, args, signal, {
    onStdout: (line) => {
      const parsed = parseAria2Summary(line)
      if (!parsed) return
      if (reporter) {
        reporter.report(parsed.pct, '下载中（aria2）', parsed.spd, parsed.eta)
      }
      const throughput = summarySpeedBytes(parsed.spd)
      // 速度为 0 或解析不出来时**跳过这一行**，而不是把 cn 单独更新：观测的两个数字必须
      // 成对（否则会留下「结束时 DL:0B 的 cn」配上一个早先的速度，两个值不是同一时刻的）。
      //
      // cn 取整段的**峰值**（而不是最后一条）：aria2 收尾时会把连接逐条关掉，最后一条摘要
      // 反映的是排空阶段 —— t24 实测 8MB/8 连接的摘要序列是 {60%, CN:8} → {96%, CN:1}，
      // 尾部那个 1 会把「这台主机上次给了我们几条连接」答错，抬档门槛（≥4）就此被错过。
      if (throughput !== undefined && throughput > 0) {
        observed = {
          throughput,
          concurrency,
          cn: Math.max(parsed.cn, observed?.cn ?? 0),
        }
      }
    },
  })
  return observed
}

/** 使用 curl 单线程下载（回退方案），解析进度条百分比透传给 reporter */
export async function downloadWithCurl(
  url: string,
  outputPath: string,
  signal?: AbortSignal,
  reporter?: ProgressReporter,
  resume: boolean = false,
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
): Promise<void> {
  await ensureOutputDir(outputPath)
  const args = buildCurlArgs(url, outputPath, resume, headers, maxDownloadLimitBytes)
  await runProcess('curl', args, signal, {
    onStderr: (line) => {
      const pct = parseCurlProgress(line)
      if (pct !== null && reporter) {
        reporter.report(pct, '下载中（curl）')
      }
    },
  })
}

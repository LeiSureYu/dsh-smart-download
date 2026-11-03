/**
 * 下载执行逻辑：
 * - 支持多线程时调用随插件分发的 aria2c（按决策档位开连接）；
 * - 否则回退到系统自带的 curl；
 * - 统一处理 AbortSignal 取消、Windows 隐藏窗口、stderr 收集与进度解析。
 */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import {
  basename,
  delimiter as pathDelimiter,
  dirname,
  isAbsolute,
  join as joinPath,
  resolve as resolvePath,
} from 'node:path'
import {
  parseAria2Summary,
  parseCurlProgress,
  splitIntoLines,
} from './progress-parse.js'
import {
  hasCustomHeaders,
  headersToAria2Args,
  headersToAria2InputFile,
  headersToCurlArgs,
  headersToCurlConfig,
} from './headers.js'
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
 * 未列入的平台视为不支持，getAria2Path 返回 null，由调用方回退 curl。
 * darwin 的两个子包（1.7.0 起）由本仓库 CI 从官方源码构建 —— aria2 官方不发
 * macOS 二进制，第三方候选过不了可信门槛，见 scripts/build-aria2-darwin.sh
 * 与 docs/COMPATIBILITY.md。
 *
 * `ohos-arm64`（1.9.1 起）：OpenHarmony / HarmonyOS 的 Node 运行时报告
 * `process.platform === 'ohos'`（npm 生态的既有先例：lightningcss、napi-rs
 * 都按这个值分发 OHOS 预编译产物；HarmonyOS NEXT 内核不是 Linux，不能复用
 * linux-arm64 的 musl 静态二进制）。映射表先落位 —— 子包一旦发布并进入
 * optionalDependencies，这段代码零改动生效；在那之前，ohos 上 require.resolve
 * 必然失败，由既有链条（PATH 上的 aria2c → curl）兜底，插件在鸿蒙上开箱可用
 * 但只有单线程。随包子包走 darwin 同款信任模型（本仓库 CI 用 OHOS SDK 从官方
 * 源码构建），构建配方落地后随后续版本发布，见 docs/COMPATIBILITY.md。
 */
export const ARIA2_TARGETS: Readonly<Record<string, Aria2Target>> = Object.freeze({
  'win32-x64': { pkg: '@leisureyu/dsh-aria2-win32-x64', bin: 'bin/aria2c.exe' },
  'win32-arm64': { pkg: '@leisureyu/dsh-aria2-win32-arm64', bin: 'bin/aria2c.exe' },
  'linux-x64': { pkg: '@leisureyu/dsh-aria2-linux-x64', bin: 'bin/aria2c' },
  'linux-arm64': { pkg: '@leisureyu/dsh-aria2-linux-arm64', bin: 'bin/aria2c' },
  'darwin-x64': { pkg: '@leisureyu/dsh-aria2-darwin-x64', bin: 'bin/aria2c' },
  'darwin-arm64': { pkg: '@leisureyu/dsh-aria2-darwin-arm64', bin: 'bin/aria2c' },
  'ohos-arm64': { pkg: '@leisureyu/dsh-aria2-ohos-arm64', bin: 'bin/aria2c' },
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
 * 显式指定的 aria2 二进制环境变量（1.9.1，鸿蒙适配）。
 *
 * 为什么需要它：随包子包覆盖不到的平台（当前的鸿蒙 ohos-arm64 就在等待
 * CI 构建配方落地），用户把自建 / 侧载的 aria2c 放上 PATH 并不总是可行
 * （OHOS 应用沙箱的 PATH 不含侧载目录），这条环境变量给出第三个来源。
 * 它也是所有平台的通用逃生门 —— 与 `DSH_SMARTDL_REVEAL_CMD` 同一套接缝风格。
 */
export const ARIA2_PATH_OVERRIDE_ENV = 'DSH_SMARTDL_ARIA2_PATH'

/**
 * 读取环境变量里显式指定的 aria2 路径（去除首尾空白；未设置 / 空串返回 null）。
 * 抽成纯函数便于单测覆盖解析语义（空白视为未设置，而不是当成相对路径）。
 */
export function aria2PathOverride(
  value: string | undefined = process.env[ARIA2_PATH_OVERRIDE_ENV],
): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 验证一个候选路径确实是能执行的 aria2：文件存在 + `--version` 退出码 0。
 * findAria2OnPath 与环境变量覆盖共用同一条判定，两处才不会漂移。
 */
function verifyAria2Binary(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
  } catch {
    return false
  }
  const check = spawnSync(candidate, ['--version'], {
    windowsHide: true,
    timeout: 5000,
    encoding: 'utf-8',
  })
  return check.status === 0
}

/**
 * 定位随插件分发的 aria2 二进制。
 * 解析顺序：显式环境变量 → 随包子包 → PATH 上的 `aria2c`。
 *
 * 为什么必须查 PATH（1.5.0）：随包子包不可用时（macOS 用户没装新子包的旧版本、
 * 或镜像源未同步），Homebrew 安装的 `aria2c` 完全可用。此前 darwin 在第一步就
 * 直接返回 null，于是 macOS 用户永远只能单线程 curl —— 明明装了 aria2 也用不上。
 *
 * 为什么查到的 PATH 二进制还要跑一次 `--version`：PATH 上可能是一个同名脚本、
 * 一个损坏的二进制，或一个不兼容的旧版本。直接把路径交给下载流程，失败会发生在
 * 「已经开始下载」之后；先验证则能在探测前就决定回退 curl，错误路径更短。
 *
 * 为什么环境变量被拒绝时不回落到子包 / PATH（1.9.1）：自动换一个来源会把
 * 配置错误静默掩盖掉 —— 用户以为在用自己指定的二进制，实际在用别的。
 * 返回 null 让调用方回退 curl，失败是显式的（decide() 的 reason 会提示
 * 检查该环境变量），而不是换一个来源悄悄继续。
 *
 * @returns 可执行的 aria2 路径；找不到或验证失败时返回 null（调用方回退 curl）
 */
export function getAria2Path(): string | null {
  const override = aria2PathOverride()
  if (override !== null) {
    return verifyAria2Binary(override) ? override : null
  }
  const target = aria2TargetFor(process.platform, process.arch)
  if (target) {
    try {
      return require.resolve(`${target.pkg}/${target.bin}`)
    } catch {
      // 子包没装：继续查 PATH，而不是直接放弃（macOS / 用户自行安装的场景）
    }
  }
  return findAria2OnPath()
}

/**
 * 在 PATH 上查找可用的 aria2c，并验证它确实能执行。
 *
 * 抽成独立函数是为了可单测：测试可以传入一个只包含临时目录的 PATH，而不必
 * 依赖开发机上是否装了 aria2。`spawnSync` 带超时与 `windowsHide`，避免探测
 * 一个坏二进制时挂住整个工具调用，或在 Windows 上闪出黑框。
 *
 * @param envPath 用于查找的 PATH 字符串；缺省读 `process.env.PATH`
 */
export function findAria2OnPath(envPath: string | undefined = process.env.PATH): string | null {
  if (!envPath) return null
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  const names = process.platform === 'win32' ? ['aria2c', 'aria2c.exe'] : ['aria2c']
  const dirs = envPath.split(pathDelimiter).filter((dir) => dir.length > 0)

  for (const dir of dirs) {
    for (const name of names) {
      const candidates =
        process.platform === 'win32' && !/\.(exe|cmd|bat|com)$/i.test(name)
          ? exts.map((ext) => joinPath(dir, name + ext.toLowerCase()))
          : [joinPath(dir, name)]
      for (const candidate of candidates) {
        if (verifyAria2Binary(candidate)) return candidate
      }
    }
  }
  return null
}

/**
 * aria2 各形态共用的开关。
 * -x/-s 使用决策得到的并发数；
 * -c 开启断点续传（同名文件已存在时从断点继续，而不是重头再来）；
 * --allow-overwrite=true 允许覆盖已存在的同名文件；
 * --summary-interval=1 每秒输出摘要，--show-console-readout=false 关闭原地刷新，
 * 便于以“每行一条”的方式解析进度。
 * 注意：aria2 的 -o 只接受相对文件名，目录必须通过 -d 指定。
 *
 * 为什么抽出来：argv 形态（`buildAria2Args`）与 stdin 形态（`buildAria2Invocation`）
 * 都必须带上同一组开关 —— aria2 对未知或缺失的参数是**静默忽略**的，任何一处漏写
 * 都不会报错，只能靠「字面量只有一份」保证两形态不漂移。
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
 *
 * `--all-proxy`（1.7.0）：本条目生效的代理地址（http(s)），与探测共用同一解析
 * 结果（src/proxy.ts），三层（探测 / aria2 / curl）才不会各走各的网络路径。
 * aria2 **不读**代理环境变量（官方手册明示），因此环境变量里配的代理必须在这里
 * 显式落到命令行上；未启用代理时这一项整个不出现。
 */
function aria2CommonArgs(
  concurrency: number,
  resume: boolean,
  maxDownloadLimitBytes?: number,
  proxy?: string,
): string[] {
  return [
    '-x', String(concurrency), // 单服务器最大连接数
    '-s', String(concurrency), // 同时使用的连接数
    // 最小分片大小：决定并发上限，删掉会让 -x/-s 失效，详见 buildAria2Args 上方注释
    '-k', '1M',
    // 断点续传：仅在确认安全时开启（见 src/resume.ts）
    ...(resume ? ['-c'] : []),
    // 重试：aria2 默认 max-tries=5，但默认 retry-wait=0，失败后立刻重试，
    // 对「临时 5xx / 连接被重置」这种瞬时故障几乎等于不重试。3 次 + 2 秒间隔
    // 是保守取值：既能跨过短抖动，又不会让一个确实不可用的地址拖太久。
    '-m', '3',
    '--retry-wait=2',
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
    // 代理（可选）：缺省时同样整个不出现，命令行与无代理时逐字节相同。
    ...(proxy === undefined ? [] : [`--all-proxy=${proxy}`]),
  ]
}

/**
 * 拼接 aria2 的 argv 形态（头随命令行、URI 与 `-o` 在 argv 末尾）。
 * 各开关的实测依据见 `aria2CommonArgs` 的注释；有自定义头时调用方应当改用
 * `buildAria2Invocation`（头走 stdin，凭证不进命令行）。
 */
export function buildAria2Args(
  url: string,
  outputPath: string,
  concurrency: number = 8,
  resume: boolean = true,
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
  proxy?: string,
): string[] {
  const dir = dirname(outputPath)
  const base = basename(outputPath)
  const args: string[] = [
    ...aria2CommonArgs(concurrency, resume, maxDownloadLimitBytes, proxy),
    // 自定义头（UA / Referer / …）与探测用的是同一份，见 src/headers.ts
    ...headersToAria2Args(headers),
  ]
  if (dir && dir !== '.') {
    args.push('-d', isAbsolute(dir) ? dir : resolvePath(dir))
  }
  args.push('-o', base, url)
  return args
}

/** 一次子进程调用的完整形态：argv + 可选的 stdin 文本（头配置等）。 */
export interface ProcessInvocation {
  args: string[]
  /** 提供给子进程 stdin 的文本；缺省表示不写 stdin（行为与 1.6.0 相同） */
  stdin?: string
}

/**
 * 一次 aria2 调用的完整形态（1.7.0）。
 *
 * 分两条路径，切换条件是「有没有调用方自定义的头」：
 * - **无自定义头**：与 `buildAria2Args` 完全同一份 argv —— 没有需要藏的东西，
 *   就不引入新的命令行形态（既有回归项：无头时命令行逐字节不变）；
 * - **有自定义头**：头值改走 stdin（`--input-file=-`），凭证不再出现在进程
 *   命令行里（任务管理器 / `ps -ef` 可读走 argv 上的 `Authorization`）。
 *   aria2 的头是 **per-download** 选项，只能挂在 input file 的 URI 条目下，
 *   因此 URI 与 `-o` 也一起搬进 stdin（`out=` 写在条目下），argv 只留全局开关、
 *   `-d` 与 `--input-file=-`。
 */
export function buildAria2Invocation(
  url: string,
  outputPath: string,
  concurrency: number = 8,
  resume: boolean = true,
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
  proxy?: string,
): ProcessInvocation {
  if (!hasCustomHeaders(headers)) {
    return {
      args: buildAria2Args(url, outputPath, concurrency, resume, headers, maxDownloadLimitBytes, proxy),
    }
  }
  const dir = dirname(outputPath)
  const args: string[] = [
    ...aria2CommonArgs(concurrency, resume, maxDownloadLimitBytes, proxy),
    '--input-file=-',
  ]
  if (dir && dir !== '.') {
    args.push('-d', isAbsolute(dir) ? dir : resolvePath(dir))
  }
  return {
    args,
    stdin: headersToAria2InputFile(url, headers, basename(outputPath)),
  }
}

/**
 * curl 各形态共用的开关（argv 形态与 stdin 形态都必须带上；`-o` 两种形态都在）。
 *
 * 为什么抽出来：与 aria2 同一条理由 —— curl 对未知或缺失的参数是**静默忽略**的，
 * 字面量只有一份才保证两形态不漂移。续传与退出码 33 的实测依据见下方
 * `buildCurlArgs` 的注释。
 *
 * `-x`（1.7.0）：本条目生效的代理地址（http(s)）。curl 自己会读代理环境变量，
 * 但探测（undici）与 aria2 不会 —— 显式落参数、三层共用同一解析结果
 * （src/proxy.ts）才能保证一致；未启用代理时这一项整个不出现。
 */
function curlCommonArgs(
  outputPath: string,
  resume: boolean,
  maxDownloadLimitBytes?: number,
  proxy?: string,
): string[] {
  return [
    '--progress-bar',
    '-L', // 跟随重定向
    // 重定向协议白名单：`=` 不能省，否则 curl 会把 "http,https" 当成文件名。
    // 只允许 http/https 跳转，避免一个 http 地址把我们带到 file:// 或 ftp://。
    '--proto-redir', '=http,https',
    // 断点续传：自动读取已下载长度并从断点继续；文件不存在时从 0 开始
    ...(resume ? ['-C', '-'] : []),
    '-o', outputPath,
    '--fail', // HTTP 错误时返回非零退出码
    '--show-error', // 输出错误信息
    // 瞬时网络故障重试：--retry-all-errors 让 5xx / 连接重置也重试，
    // 而不是只重试 curl 认为「可重试」的少数错误。2 秒间隔避免瞬间打满对端。
    '--retry', '3',
    '--retry-all-errors',
    '--retry-delay', '2',
    // 带宽上限（可选）：curl 是单连接，--limit-rate 就是这一条任务的上限；
    // 批量时由调用方按并发位分好份额再传进来（见 src/index.ts 的批量编排）。
    // 缺省时这一项整个不出现 —— 命令行与 1.2.0 逐字节相同（回归项）。
    ...(maxDownloadLimitBytes === undefined
      ? []
      : ['--limit-rate', String(maxDownloadLimitBytes)]),
    // 代理（可选）：缺省时整个不出现，命令行与无代理时逐字节相同。
    ...(proxy === undefined ? [] : ['-x', proxy]),
  ]
}

/**
 * 拼接 curl 回退命令行参数（argv 形态，头随命令行）。
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
  proxy?: string,
): string[] {
  // 用条件展开代替 `splice(2, 0, ...)`：位置魔法意味着「在数组字面量中间插入
  // 一个元素」，一旦前面插入/删除任何开关，续传开关就会插错位置（曾经一次
  // 误插让 `-o` 与输出路径分离）。条件展开让顺序由字面量本身表达。
  return [
    ...curlCommonArgs(outputPath, resume, maxDownloadLimitBytes, proxy),
    // 自定义头（UA / Referer / …）与探测用的是同一份，见 src/headers.ts
    ...headersToCurlArgs(headers),
    url,
  ]
}

/**
 * 一次 curl 调用的完整形态（1.7.0）。
 *
 * 分两条路径，切换条件与 aria2 相同 —— 有没有调用方自定义的头：
 * - **无自定义头**：与 `buildCurlArgs` 完全同一份 argv（无头时命令行逐字节不变）；
 * - **有自定义头**：头配置改走 stdin（`-K -`，从标准输入读 curl 配置），凭证
 *   不再出现在进程命令行里。URL 不含机密，保留在 argv；`-o` 与其余开关不变。
 */
export function buildCurlInvocation(
  url: string,
  outputPath: string,
  resume: boolean = false,
  headers?: RequestHeaders,
  maxDownloadLimitBytes?: number,
  proxy?: string,
): ProcessInvocation {
  if (!hasCustomHeaders(headers)) {
    return {
      args: buildCurlArgs(url, outputPath, resume, headers, maxDownloadLimitBytes, proxy),
    }
  }
  return {
    args: [...curlCommonArgs(outputPath, resume, maxDownloadLimitBytes, proxy), '-K', '-', url],
    stdin: headersToCurlConfig(headers),
  }
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
    // 36 的官方定义（man page，2026-10-30 从 man.archlinux.org 镜像核对原文）：
    // "Bad download resume. Could not continue an earlier aborted download."
    // 它与 33 不是一回事：33 是「这次发的 Range 没被接受」（可能只是服务器忽略），
    // 36 是「续传本身就续不下去」。本插件只有在 planResume() 证实同源后才会带上
    // `-C -`，因此出现 36 说明服务器在核对通过之后仍拒绝继续 —— 半包保留，
    // 删掉它全量重下是唯一确定可行的下一步。
    36: {
      reason: '无法从断点续传（bad download resume）：服务器拒绝了继续上一次中断下载的请求',
      next: '删除本地半包后重跑一次，会全量重新下载；也可在下载管理器里删除该文件后重试',
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

/**
 * 从命令行取可执行文件名（去掉目录与 `.exe`）：用户不需要看到绝对路径。
 *
 * 为什么不用 `path.basename`：**它是平台相关的**。Linux 上的 `basename` 不认
 * 反斜杠，`C:\Users\u\.dsh\runtimes\aria2c.exe` 会整串留下来 —— 绝对路径就
 * 泄漏进用户可见的文案里（CI 上就是这样挂的）。Windows 上因为认反斜杠而
 * 看不出来，于是这个 bug 只在 Linux 暴露。
 *
 * 两种分隔符都切，行为与平台无关：不论路径来自哪个平台，文案里只出现工具名。
 */
function executableName(command: string): string {
  const parts = command.split(/[\\/]/).filter((segment) => segment !== '')
  const last = parts.length > 0 ? parts[parts.length - 1] : command
  return last.replace(/\.exe$/i, '')
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
  stdin?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      const options: SpawnOptions = { windowsHide: true }
      child = spawn(command, args, options)
      if (stdin !== undefined) {
        // 1.7.0：自定义请求头经 stdin 喂给子进程（curl `-K -` / aria2
        // `--input-file=-`），凭证不再出现在进程命令行里。子进程若因参数错误
        // 立即退出，write / end 会触发 stdin 的 'error'（EPIPE）—— 这里挂空
        // 监听防未处理异常，真正的失败由 close 分支的非零退出码如实上报。
        child.stdin?.on('error', () => {})
        child.stdin?.end(stdin)
      }
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
  proxy?: string,
): Promise<Aria2Observation | undefined> {
  await ensureOutputDir(outputPath)
  // 有自定义头时头走 stdin（凭证不进命令行），无头时 argv 与 1.6.0 逐字节相同
  const { args, stdin } = buildAria2Invocation(
    url,
    outputPath,
    concurrency,
    resume,
    headers,
    maxDownloadLimitBytes,
    proxy,
  )
  let observed: Aria2Observation | undefined
  await runProcess(
    aria2Path,
    args,
    signal,
    {
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
    },
    stdin,
  )
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
  proxy?: string,
): Promise<void> {
  await ensureOutputDir(outputPath)
  // 有自定义头时头走 stdin（`-K -`，凭证不进命令行），无头时 argv 与 1.6.0 逐字节相同
  const { args, stdin } = buildCurlInvocation(
    url,
    outputPath,
    resume,
    headers,
    maxDownloadLimitBytes,
    proxy,
  )
  await runProcess(
    'curl',
    args,
    signal,
    {
      onStderr: (line) => {
        const pct = parseCurlProgress(line)
        if (pct !== null && reporter) {
          reporter.report(pct, '下载中（curl）')
        }
      },
    },
    stdin,
  )
}

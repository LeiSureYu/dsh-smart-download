import type { ProgressReporter } from './progress.js';
import type { DownloadMethod, RequestHeaders } from './types.js';
/**
 * 随包 aria2 的目标平台描述。
 * 每个受支持平台对应一个独立的 npm 子包，子包用 os/cpu 字段声明适用平台，
 * npm / pnpm 在不匹配的平台上会自动跳过安装。
 */
export interface Aria2Target {
    /** 子包名 */
    pkg: string;
    /** 子包内二进制的相对路径 */
    bin: string;
}
/**
 * 平台 → 子包映射表。
 * 键为 `${process.platform}-${process.arch}`，与 npm 的 os/cpu 字段语义一致。
 * 未列入的平台（如 darwin）视为不支持，getAria2Path 返回 null，由调用方回退 curl。
 */
export declare const ARIA2_TARGETS: Readonly<Record<string, Aria2Target>>;
/** 子进程逐行回调 */
export interface ProcessLineHandlers {
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
}
/**
 * 查询给定平台 / 架构对应的 aria2 子包描述。
 * 不支持的平台返回 null。纯函数，便于单测（无需真的跑在目标平台上）。
 */
export declare function aria2TargetFor(platform: string, arch: string): Aria2Target | null;
/**
 * 定位随插件分发的 aria2 二进制。
 * 按当前平台 / 架构选择子包；平台不受支持或子包未安装时返回 null，
 * 由调用方回退到 curl。
 */
export declare function getAria2Path(): string | null;
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
export declare function buildAria2Args(url: string, outputPath: string, concurrency?: number, resume?: boolean, headers?: RequestHeaders, maxDownloadLimitBytes?: number): string[];
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
export declare function buildCurlArgs(url: string, outputPath: string, resume?: boolean, headers?: RequestHeaders, maxDownloadLimitBytes?: number): string[];
/** 累积流式数据并按行（兼容 \r / \n）吐出完整片段，保留半截内容 */
export declare class LineBuffer {
    private pending;
    push(chunk: string, emit: (line: string) => void): void;
    flush(emit: (line: string) => void): void;
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
    reason: string;
    /** 下一步：用户看完知道该做什么 */
    next: string;
}
/** 退出码映射表（两个下载工具各一张，来源见上方说明） */
export declare const EXIT_CODE_DESCRIPTIONS: Readonly<Record<DownloadMethod, Readonly<Record<number, ExitCodeDescription>>>>;
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
export declare function describeExitCode(command: string, code: number | null, signal: string | null, stderrTail: string): string | null;
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
export declare function runProcess(command: string, args: string[], signal?: AbortSignal, handlers?: ProcessLineHandlers): Promise<void>;
/**
 * 一次 aria2 下载观测到的吞吐（P1-2 的原始数据）。
 *
 * 为什么由 downloader 这一层返回、而不是就地写缓存：`CN` 与 `DL` 只出现在 aria2 的 stdout
 * 摘要行里，解析只有这一层做得到；而「什么时候值得记」是策略（见 `src/index.ts` 的
 * `recordObservedThroughput`）—— 解析与策略分开，两者才能各自被单测。
 */
export interface Aria2Observation {
    /** 最后一次摘要里的速度换算成字节/秒 */
    throughput: number;
    /** 本次**请求**的并发数（插件交给 aria2 的 `-x/-s`） */
    concurrency: number;
    /**
     * 整段观测到的**峰值**实际有效连接数（摘要里的 `CN` 的最大值，见 src/progress-parse.ts）。
     *
     * 为什么是峰值而不是最后一条：aria2 收尾时会把连接逐条关掉，最后一条摘要反映的是排空阶段
     * （实测 8MB/8 连接：`{60%, CN:8}` → `{96%, CN:1}`）。而这份记录的唯一用途是回答「这台主机
     * 上次给了我们几条连接」，那个问题只有峰值答得了 —— 尾部那个 1 会让抬档门槛被误判为不满足。
     */
    cn: number;
}
/**
 * 把摘要里的速度字符串换算成字节/秒；解析不出来返回 `undefined`。
 *
 * 单位语义按国际惯例分开：带 `i` 的（KiB/MiB/GiB）是 1024 进制，不带的（KB/MB）是 1000 进制。
 * aria2 实测吐的是 `MiB` 这类二进制单位，但 `progress-parse.ts` 的正则也接受不带 `i` 的写法，
 * 所以两种都要给对。解析不出来时宁可不记 —— 一个错数字会一直躺在中位数里。
 */
export declare function summarySpeedBytes(spd: string): number | undefined;
/**
 * 使用 aria2 多线程下载，并把摘要进度透传给 reporter。
 *
 * 返回值是**最后一次**有效摘要里的观测（调用方据此写吞吐缓存）：为什么取最后一次而不是平均
 * ——摘要是一秒一次的瞬时值，最后一次最接近结束时的真实带宽，早期样本会被建连与慢启动拉低。
 *
 * @returns 观测到的吞吐；一次摘要都没解析出来（下载太快 / 输出被改）时返回 `undefined`
 */
export declare function downloadWithAria2(aria2Path: string, url: string, outputPath: string, concurrency: number, signal?: AbortSignal, reporter?: ProgressReporter, resume?: boolean, headers?: RequestHeaders, maxDownloadLimitBytes?: number): Promise<Aria2Observation | undefined>;
/** 使用 curl 单线程下载（回退方案），解析进度条百分比透传给 reporter */
export declare function downloadWithCurl(url: string, outputPath: string, signal?: AbortSignal, reporter?: ProgressReporter, resume?: boolean, headers?: RequestHeaders, maxDownloadLimitBytes?: number): Promise<void>;

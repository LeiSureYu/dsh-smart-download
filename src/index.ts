/**
 * dsh-smart-dl 插件入口：
 * 注册两个工具：
 * - smart_download：先探测，再按文件大小与 aria2 可用性决定 aria2（4/8 连接）或 curl
 *   回退；支持镜像加速与断点续传，并通过 ProgressReporter 双轨上报进度；
 * - download_status：只读地查询这些下载任务的进度快照。
 *
 * 另外注册浏览器端进度面板所需的 Host RPC 端点（仅 web profile 生效）。
 *
 * 假设：基于 DSH 0.1.0-rc.5 的 defineTool / ctx.tools.register API。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeUrl } from './probe.js'
import {
  downloadWithAria2,
  downloadWithCurl,
  getAria2Path,
} from './downloader.js'
import { decide } from './decision.js'
import { ProgressReporter } from './progress.js'
import type { ProgressSession } from './progress.js'
import { applyMirror } from './mirror.js'
import { checkDownloadUrl, deriveFilenameFromUrl } from './url.js'
import { registerStatusRpc } from './rpc.js'
import { DEFAULT_STATUS_LIMIT, readDownloadStatus } from './status.js'
import { clearMarker, localFileSize, planResume, writeMarker } from './resume.js'
import { describeMismatch, verifySize } from './verify.js'
import type { DownloadStatusSnapshot } from './status.js'
import type {
  DownloadStatusArgs,
  SmartDownloadArgs,
  SmartDownloadResult,
  ToolExecutionContext,
} from './types.js'

export const name = 'dsh-smart-dl'
export const inject = ['tools']

export function apply(ctx: Context): void {
  // 浏览器端进度面板的数据源；纯 CLI profile 下没有 connection 服务时静默跳过。
  registerStatusRpc(ctx)

  ctx.tools.register(
    defineTool({
      name: 'smart_download',
      description:
        'Download a file with multi-threading when possible. It probes the server, then uses bundled aria2 with 4 or 8 connections based on file size, and automatically falls back to single-threaded curl if Range is unsupported, the file is small, or aria2 is unavailable. Supports an optional mirror prefix to accelerate GitHub downloads (e.g. https://gh-proxy.com/) and resumes an interrupted download when the server supports Range.',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'The URL to download',
        },
        output: {
          type: 'string',
          description: 'Output file path (optional)',
        },
        mirror: {
          type: 'string',
          description:
            'Optional mirror prefix prepended to the URL, e.g. "https://gh-proxy.com/" or "ghfast.top". Used to accelerate GitHub release downloads. Ignored for non-http(s) URLs.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean' },
            path: { type: 'string' },
            method: { type: 'string' },
            size: { type: 'number' },
            fellback: { type: 'boolean' },
            reason: { type: 'string' },
            requestedUrl: { type: 'string' },
            mirrored: { type: 'boolean' },
          },
        },
        render: (_args: SmartDownloadArgs, value: SmartDownloadResult) => [
          {
            type: 'text',
            text: `Download ${value.success ? 'succeeded' : 'failed'} via ${value.method}${
              value.fellback && value.reason ? ` (fallback: ${value.reason})` : ''
            }${value.mirrored ? ' (via mirror)' : ''}`,
          },
        ],
      },
      async execute(
        args: SmartDownloadArgs,
        exec: ToolExecutionContext,
      ): Promise<SmartDownloadResult> {
        // 0. 协议白名单：URL 可能来自模型读到的任意页面，必须先收紧到 http(s)。
        // 实测（0.4.1）file:// 会被 curl 接受并复制本地文件到目标路径。
        const checked = checkDownloadUrl(args.url)
        if (!checked.ok) {
          throw new Error(`拒绝下载：${checked.reason}`)
        }

        // 镜像加速：只做前缀拼接，非 http(s) 或未提供镜像时原样返回
        const requestedUrl = applyMirror(args.url, args.mirror)
        const mirrored = requestedUrl !== args.url
        // 输出文件名始终按原始 URL 推导，避免把镜像域名带进文件名
        const outputPath = args.output ?? deriveFilenameFromUrl(args.url)
        const taskId = `dl-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`
        // 会话上下文：轨道一（dsh-task-progress）的目录是
        // <session.cwd>/.dsh-progress/<session.id>/，读取端按 session 过滤，
        // 拿不到 session 时不写轨道一（写错地方等于没写）。
        const header = exec.agent?.session?.header
        const session: ProgressSession = { id: header?.id, cwd: header?.cwd }
        const reporter = new ProgressReporter(taskId, outputPath, session)

        // 1. 探测目标 URL
        reporter.report(0, '探测中…')
        const probe = await probeUrl(requestedUrl, exec.signal)

        // 探测可能拿不到文件大小（HEAD 失败 / 超时 / chunked 无 Content-Length）。
        // dsh-tools 会把含 undefined 的结果判为非法 JSON 并抛 ToolOutputError，
        // 因此 size 只在有值时出现（见下方各 return 的条件展开）。
        const sizeField =
          probe.contentLength === undefined ? {} : { size: probe.contentLength }

        // 完整性校验：下载工具退出码 0 只代表「它认为完成了」，不代表字节数对
        // （服务器提前断开、镜像返回 200 的错误页、磁盘写满…都不会有非零退出码）。
        // 校验失败一律抛错，并且**不**清除旁车指纹 —— 保留它，下次才有得比。
        const assertIntegrity = async (): Promise<void> => {
          const outcome = verifySize(
            localFileSize(outputPath),
            probe.contentLength,
            probe.contentEncoding,
          )
          if (outcome.kind === 'ok') return
          const message = describeMismatch(outcome)
          reporter.fail(message)
          await reporter.awaitFlush()
          throw new Error(message)
        }

        // 是否启用断点续传（0.6.0 起前置一层安全校验）。
        // 仅凭「服务器支持 Range」就续传是不够的：curl -C - 与 aria2 -c 都只看
        // 本地文件长度，实测在「远端变小」「等长但内容变了」两种场景下都是退出码
        // 0 而文件是错的。planResume() 会比对远端长度与 ETag / Last-Modified，
        // 无法证实同源时删掉本地半包全量重下（详见 src/resume.ts）。
        const resumePlan = planResume(outputPath, probe, probe.supportsMultiThread)
        const resume = resumePlan.resume
        if (resumePlan.discarded) {
          reporter.report(0, resumePlan.reason)
        }
        // 记下本次远端资源的指纹：此后留下的任何半包都对应这个指纹，
        // 下次续传时才有得比（否则只能靠长度，挡不住「等长但内容变了」）。
        // 下载失败时刻意保留，成功完成时才清除。
        if (probe.contentLength !== undefined) writeMarker(outputPath, probe)

        // 2. 决策：按文件大小与 aria2 可用性选择方式 / 并发
        const aria2Path = getAria2Path()
        const decision = decide(probe, aria2Path !== null)
        const base = { requestedUrl, mirrored }

        // 3. aria2 路径
        if (decision.method === 'aria2' && aria2Path) {
          reporter.report(0, `启动 aria2（${decision.concurrency} 连接）…`)
          try {
            await downloadWithAria2(
              aria2Path,
              requestedUrl,
              outputPath,
              decision.concurrency,
              exec.signal,
              reporter,
            )
            reporter.done()
            // 进度写盘已异步化（src/progress.ts），终态记录必须落盘后再返回，
            // 否则 download_status / 轨道一读取方会看到上一次的中间状态。
            await reporter.awaitFlush()
            await assertIntegrity()
            clearMarker(outputPath)
            return {
              ...base,
              success: true,
              path: outputPath,
              method: 'aria2',
              ...sizeField,
              fellback: false,
              reason: decision.reason,
            }
          } catch (err) {
            const aria2Message = err instanceof Error ? err.message : String(err)
            // aria2 失败，降级到 curl
            reporter.report(0, 'aria2 失败，回退 curl…')
            try {
              await downloadWithCurl(
                requestedUrl,
                outputPath,
                exec.signal,
                reporter,
                resume,
              )
              reporter.done('下载完成（curl 回退）')
              await reporter.awaitFlush()
              await assertIntegrity()
              clearMarker(outputPath)
              return {
                ...base,
                success: true,
                path: outputPath,
                method: 'curl',
                ...sizeField,
                fellback: true,
                reason: `aria2 失败: ${aria2Message}`,
              }
            } catch (curlErr) {
              reporter.fail(aria2Message)
              await reporter.awaitFlush()
              throw curlErr
            }
          }
        }

        // 4. 决策为 curl（不支持 Range / 文件小 / aria2 缺失）
        reporter.report(0, `使用 curl：${decision.reason}`)
        try {
          await downloadWithCurl(
            requestedUrl,
            outputPath,
            exec.signal,
            reporter,
            resume,
          )
          reporter.done()
          await reporter.awaitFlush()
          await assertIntegrity()
          clearMarker(outputPath)
          return {
            ...base,
            success: true,
            path: outputPath,
            method: 'curl',
            ...sizeField,
            fellback: decision.fellback,
            reason: decision.reason,
          }
        } catch (err) {
          reporter.fail(err instanceof Error ? err.message : String(err))
          await reporter.awaitFlush()
          throw err
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'download_status',
      description:
        'Query the progress of downloads started by smart_download. Returns a read-only snapshot of recent tasks (id, percentage, status, speed, ETA) read from the plugin progress directories. Pass taskId to look up one task, or omit it to list the most recent ones.',
      parameters: {
        taskId: {
          type: 'string',
          description:
            'Optional task id returned by an earlier download; omit to list recent tasks',
        },
        limit: {
          type: 'integer',
          description: `Maximum number of tasks to return (default ${DEFAULT_STATUS_LIMIT})`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            taskDir: { type: 'string' },
            downloadDir: { type: 'string' },
            total: { type: 'integer' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  pct: { type: 'integer' },
                  msg: { type: 'string' },
                  status: { type: 'string' },
                  spd: { type: 'string' },
                  eta: { type: 'string' },
                  updatedAt: { type: 'number' },
                },
              },
            },
          },
        },
        render: (_args: DownloadStatusArgs, value: DownloadStatusSnapshot) => [
          {
            type: 'text',
            text:
              value.tasks.length === 0
                ? 'No download tasks found.'
                : value.tasks
                    .map(
                      (t) =>
                        `${t.name || t.id}: ${t.pct}% (${t.status})${t.spd ? ` ${t.spd}` : ''}${
                          t.eta ? ` eta ${t.eta}` : ''
                        }`,
                    )
                    .join('\n'),
          },
        ],
      },
      async execute(
        args: DownloadStatusArgs,
        exec: ToolExecutionContext,
      ): Promise<DownloadStatusSnapshot> {
        // 纯只读：不写文件、不联网。
        // 带上会话上下文，才能扫到本次会话写在 <cwd>/.dsh-progress/<id>/ 的轨道一；
        // 拿不到会话时退化为只扫轨道二（与 0.5.0 之前的行为一致）。
        const header = exec.agent?.session?.header
        const session: ProgressSession = { id: header?.id, cwd: header?.cwd }
        return readDownloadStatus(args.limit, args.taskId, session)
      },
    }),
  )
}


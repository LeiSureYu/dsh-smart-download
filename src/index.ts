/**
 * dsh-smart-dl 插件入口：
 * 注册两个工具：
 * - smart_download：先探测，再按文件大小与 aria2 可用性决定 aria2（4/8 连接）或 curl
 *   回退；支持镜像加速与断点续传，并通过 ProgressReporter 双轨上报进度；
 * - download_status：只读地查询这些下载任务的进度快照。
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
import { applyMirror } from './mirror.js'
import { DEFAULT_STATUS_LIMIT, readDownloadStatus } from './status.js'
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
        // 镜像加速：只做前缀拼接，非 http(s) 或未提供镜像时原样返回
        const requestedUrl = applyMirror(args.url, args.mirror)
        const mirrored = requestedUrl !== args.url
        // 输出文件名始终按原始 URL 推导，避免把镜像域名带进文件名
        const outputPath = args.output ?? deriveFilenameFromUrl(args.url)
        const taskId = `dl-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`
        const reporter = new ProgressReporter(taskId)

        // 1. 探测目标 URL
        reporter.report(0, '探测中…')
        const probe = await probeUrl(requestedUrl, exec.signal)

        // 是否启用断点续传：只有确认服务器支持 Range 时才续传。
        // 实测：curl -C - 在服务器不支持 Range 且已存在半截文件时会以退出码 33 失败，
        // 而同一场景不带 -C - 能正常全量重下。aria2 -c 则无条件安全。
        const resume = probe.supportsMultiThread

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
            return {
              ...base,
              success: true,
              path: outputPath,
              method: 'aria2',
              size: probe.contentLength,
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
              return {
                ...base,
                success: true,
                path: outputPath,
                method: 'curl',
                size: probe.contentLength,
                fellback: true,
                reason: `aria2 失败: ${aria2Message}`,
              }
            } catch (curlErr) {
              reporter.fail(aria2Message)
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
          return {
            ...base,
            success: true,
            path: outputPath,
            method: 'curl',
            size: probe.contentLength,
            fellback: decision.fellback,
            reason: decision.reason,
          }
        } catch (err) {
          reporter.fail(err instanceof Error ? err.message : String(err))
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
                        `${t.id}: ${t.pct}% (${t.status})${t.spd ? ` ${t.spd}` : ''}${
                          t.eta ? ` eta ${t.eta}` : ''
                        }`,
                    )
                    .join('\n'),
          },
        ],
      },
      async execute(args: DownloadStatusArgs): Promise<DownloadStatusSnapshot> {
        // 纯只读：不写文件、不联网
        return readDownloadStatus(args.limit, args.taskId)
      },
    }),
  )
}

/**
 * 从 URL 推导本地文件名：
 * 取 pathname 最后一段，去掉 query / hash 并做 URI 解码；
 * 无法推导时回退为 'download'。
 */
export function deriveFilenameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    const segments = u.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (last) {
      const decoded = decodeURIComponent(last)
      if (decoded && decoded !== '.' && decoded !== '..') {
        return decoded
      }
    }
    return 'download'
  } catch {
    return 'download'
  }
}

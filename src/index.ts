/**
 * dsh-smart-dl 插件入口：
 * 注册 smart_download 工具。先用 probe 探测，再用 decide 按文件大小与 aria2 可用性
 * 决定 aria2（4/8 连接）或 curl 回退，并通过 ProgressReporter 双轨上报进度。
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
import type {
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
        'Download a file with multi-threading when possible. It probes the server, then uses bundled aria2 with 4 or 8 connections based on file size, and automatically falls back to single-threaded curl if Range is unsupported, the file is small, or aria2 is unavailable.',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'The URL to download',
        },
        output: {
          type: 'string',
          required: false,
          description: 'Output file path (optional)',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            path: { type: 'string' },
            method: { type: 'string' },
            size: { type: 'number' },
            fellback: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        render: (_args: SmartDownloadArgs, value: SmartDownloadResult) => [
          {
            type: 'text',
            text: `Download ${value.success ? 'succeeded' : 'failed'} via ${value.method}${
              value.fellback && value.reason ? ` (fallback: ${value.reason})` : ''
            }`,
          },
        ],
      },
      async execute(
        args: SmartDownloadArgs,
        exec: ToolExecutionContext,
      ): Promise<SmartDownloadResult> {
        const outputPath = args.output ?? deriveFilenameFromUrl(args.url)
        const taskId = `dl-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`
        const reporter = new ProgressReporter(taskId)

        // 1. 探测目标 URL
        reporter.report(0, '探测中…')
        const probe = await probeUrl(args.url, exec.signal)

        // 2. 决策：按文件大小与 aria2 可用性选择方式 / 并发
        const aria2Path = getAria2Path()
        const decision = decide(probe, aria2Path !== null)

        // 3. aria2 路径
        if (decision.method === 'aria2' && aria2Path) {
          reporter.report(0, `启动 aria2（${decision.concurrency} 连接）…`)
          try {
            await downloadWithAria2(
              aria2Path,
              args.url,
              outputPath,
              decision.concurrency,
              exec.signal,
              reporter,
            )
            reporter.done()
            return {
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
              await downloadWithCurl(args.url, outputPath, exec.signal, reporter)
              reporter.done('下载完成（curl 回退）')
              return {
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
          await downloadWithCurl(args.url, outputPath, exec.signal, reporter)
          reporter.done()
          return {
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

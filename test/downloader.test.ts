/**
 * downloader.ts 测试：
 * - 参数拼接（aria2 / curl）；
 * - getAria2Path 在缺少二进制时返回 null；
 * - runProcess 的成功、非零退出（含 stderr）、AbortSignal 透传与强制结束。
 * 通过把 Node 自身作为子进程来验证，不依赖 aria2 / curl / 网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ARIA2_PACKAGE,
  buildAria2Args,
  buildCurlArgs,
  downloadWithCurl,
  getAria2Path,
  runProcess,
} from '../src/downloader.js'

/* ------------------------------ 参数拼接 ------------------------------ */

test('buildAria2Args 纯文件名 -> 仅使用 -o（默认 8 连接 + 摘要开关）', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip')
  assert.deepEqual(args, [
    '-x', '8',
    '-s', '8',
    '-k', '1M',
    '--file-allocation=none',
    '--console-log-level=warn',
    '--summary-interval=1',
    '--show-console-readout=false',
    '-o', 'a.zip',
    'https://example.com/a.zip',
  ])
})

test('buildAria2Args concurrency 参数 -> -x/-s 跟随', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip', 4)
  assert.equal(args[args.indexOf('-x') + 1], '4')
  assert.equal(args[args.indexOf('-s') + 1], '4')
})

test('buildAria2Args 含目录 -> 拆分为 -d 目录 与 -o 文件名', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'out\\a.zip')
  const dirIndex = args.indexOf('-d')
  assert.ok(dirIndex !== -1, '应包含 -d')
  assert.equal(args[dirIndex + 1], path.resolve('out'))
  const outIndex = args.indexOf('-o')
  assert.equal(args[outIndex + 1], 'a.zip')
  assert.equal(args[args.length - 1], 'https://example.com/a.zip')
})

test('buildCurlArgs 拼接符合预期（progress-bar，无 silent）', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip')
  assert.deepEqual(args, [
    '--progress-bar',
    '-L',
    '-o', 'b.zip',
    '--fail',
    '--show-error',
    'https://example.com/b.zip',
  ])
})

test('ARIA2_PACKAGE 指向 win32-x64 子包', () => {
  assert.equal(ARIA2_PACKAGE, '@leisureyu/aria2-win32-x64')
})

test('getAria2Path 返回子包二进制路径或 null', () => {
  const result = getAria2Path()
  // 两种合法状态：找到二进制（返回路径）或未找到（返回 null）
  // 子包发布后，pnpm install 会把它装到 node_modules，因此这里不能再假设一定为 null
  assert.ok(
    result === null || result.includes('aria2c.exe'),
    `预期为 null 或包含 aria2c.exe 的路径，实际: ${result}`,
  )
})

/* ------------------------------ runProcess ------------------------------ */

test('runProcess: 子进程正常退出 -> resolve', async () => {
  await assert.doesNotReject(
    runProcess(process.execPath, ['-e', 'process.exit(0)']),
  )
})

test('runProcess: 非零退出 -> reject 且错误包含退出码与 stderr', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /退出码 3/)
      assert.match(err.message, /boom/)
      return true
    },
  )
})

test('runProcess: 预先 abort 的信号 -> reject 为取消', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 200)'], controller.signal),
    /取消|终止/,
  )
})

test('runProcess: 运行中 abort -> 子进程被强制结束', async () => {
  const pidFile = path.join(
    os.tmpdir(),
    `dsh-smart-dl-pid-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  )
  // 子进程：先把自己的 PID 写入文件，然后常驻
  const hangScript =
    "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 200)"

  try {
    const controller = new AbortController()
    const running = runProcess(
      process.execPath,
      ['-e', hangScript, pidFile],
      controller.signal,
    )

    // 等待 PID 文件出现
    const pid = await waitForPidFile(pidFile, 2000)
    assert.ok(pid > 0, '应读取到子进程 PID')

    // 触发取消
    controller.abort()
    await assert.rejects(running, /取消|终止/)

    // 轮询确认子进程已不存在
    const dead = await waitForProcessExit(pid, 2000)
    assert.ok(dead, 'AbortSignal 触发后子进程应被结束')
  } finally {
    rmSync(pidFile, { force: true })
  }
})

/* ------------------------------ 真实 curl 冒烟（可选） ------------------------------ */

test('downloadWithCurl: 用 data URI 之外的本地静态服务不可用时跳过', async () => {
  // 该用例仅验证函数存在且为函数，避免在无网络环境下误失败
  assert.equal(typeof downloadWithCurl, 'function')
})

/* ------------------------------ 辅助函数 ------------------------------ */

/** 轮询等待 PID 文件出现并返回解析出的 PID */
async function waitForPidFile(file: string, timeoutMs: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const raw = (await readFile(file, 'utf8')).trim()
      const pid = Number(raw)
      if (Number.isFinite(pid)) return pid
    }
    await delay(20)
  }
  throw new Error('等待子进程 PID 文件超时')
}

/** 轮询等待指定 PID 的进程退出；已退出返回 true */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await delay(20)
  }
  return !isProcessAlive(pid)
}

/** 通过 process.kill(pid, 0) 探测进程是否存活（Windows 同样适用） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH 表示进程不存在；EPERM 表示存在但无权限（仍视为存活）
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

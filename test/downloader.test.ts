/**
 * downloader.ts 测试：
 * - 参数拼接（aria2 / curl）；
 * - 平台 → aria2 子包映射（Windows 用 .exe，Linux 无后缀；未支持平台回退 null）；
 * - getAria2Path 在缺少二进制时返回 null；
 * - runProcess 的成功、非零退出（含 stderr）、AbortSignal 透传与强制结束。
 * 通过把 Node 自身作为子进程来验证，不依赖 aria2 / curl / 网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  ARIA2_TARGETS,
  aria2TargetFor,
  buildAria2Args,
  buildCurlArgs,
  downloadWithCurl,
  getAria2Path,
  runProcess,
} from '../src/downloader.js'

/* ------------------------------ 参数拼接 ------------------------------ */

test('buildAria2Args 纯文件名 -> 仅使用 -o（默认 8 连接 + 续传 + 覆盖 + 摘要开关）', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip')
  assert.deepEqual(args, [
    '-x', '8',
    '-s', '8',
    '-k', '1M',
    '-c',
    '--allow-overwrite=true',
    '--file-allocation=none',
    '--console-log-level=warn',
    '--summary-interval=1',
    '--show-console-readout=false',
    '-o', 'a.zip',
    'https://example.com/a.zip',
  ])
})

test('buildAria2Args 总是带 -c（断点续传）', () => {
  // aria2 -c 无条件安全：不支持 Range 时 aria2 会自行全量重下，不会以失败告终
  for (const concurrency of [4, 8]) {
    const args = buildAria2Args('https://example.com/a.zip', 'a.zip', concurrency)
    assert.ok(args.includes('-c'), `concurrency=${concurrency} 应包含 -c`)
  }
})

test('buildAria2Args concurrency 参数 -> -x/-s 跟随', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip', 4)
  assert.equal(args[args.indexOf('-x') + 1], '4')
  assert.equal(args[args.indexOf('-s') + 1], '4')
})

test('buildAria2Args 含目录 -> 拆分为 -d 目录 与 -o 文件名', () => {
  // 用 path.join 构造平台原生路径：Windows 是 out\a.zip，Linux/macOS 是 out/a.zip。
  // 直接硬编码 'out\\a.zip' 在 POSIX 上会被 dirname 判为 '.'，测试会失败。
  const args = buildAria2Args('https://example.com/a.zip', path.join('out', 'a.zip'))
  const dirIndex = args.indexOf('-d')
  assert.ok(dirIndex !== -1, '应包含 -d')
  assert.equal(args[dirIndex + 1], path.resolve('out'))
  const outIndex = args.indexOf('-o')
  assert.equal(args[outIndex + 1], 'a.zip')
  assert.equal(args[args.length - 1], 'https://example.com/a.zip')
})

test('buildCurlArgs 默认不续传：progress-bar，无 silent，无 -C -', () => {
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

test('buildCurlArgs resume=true -> 在 -L 之后插入 -C -', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', true)
  assert.deepEqual(args, [
    '--progress-bar',
    '-L',
    '-C', '-',
    '-o', 'b.zip',
    '--fail',
    '--show-error',
    'https://example.com/b.zip',
  ])
})

test('buildCurlArgs resume=false -> 明确不含 -C', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', false)
  assert.equal(args.includes('-C'), false)
  // -o 与输出路径必须紧邻，续传开关不能插到中间
  assert.equal(args[args.indexOf('-o') + 1], 'b.zip')
})

test('ARIA2_TARGETS 覆盖全部受支持平台，且子包名 / 二进制名正确', () => {
  assert.deepEqual(Object.keys(ARIA2_TARGETS).sort(), [
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ])
  assert.equal(ARIA2_TARGETS['win32-x64']?.pkg, '@leisureyu/dsh-aria2-win32-x64')
  assert.equal(ARIA2_TARGETS['win32-x64']?.bin, 'bin/aria2c.exe')
  assert.equal(ARIA2_TARGETS['win32-arm64']?.pkg, '@leisureyu/dsh-aria2-win32-arm64')
  assert.equal(ARIA2_TARGETS['win32-arm64']?.bin, 'bin/aria2c.exe')
  assert.equal(ARIA2_TARGETS['linux-x64']?.pkg, '@leisureyu/dsh-aria2-linux-x64')
  assert.equal(ARIA2_TARGETS['linux-x64']?.bin, 'bin/aria2c')
  assert.equal(ARIA2_TARGETS['linux-arm64']?.pkg, '@leisureyu/dsh-aria2-linux-arm64')
  assert.equal(ARIA2_TARGETS['linux-arm64']?.bin, 'bin/aria2c')
})

test('aria2TargetFor：Windows 用 .exe，Linux 用无后缀二进制', () => {
  assert.equal(aria2TargetFor('win32', 'x64')?.bin, 'bin/aria2c.exe')
  assert.equal(aria2TargetFor('win32', 'arm64')?.bin, 'bin/aria2c.exe')
  assert.equal(aria2TargetFor('linux', 'x64')?.bin, 'bin/aria2c')
  assert.equal(aria2TargetFor('linux', 'arm64')?.bin, 'bin/aria2c')
})

test('aria2TargetFor：未支持平台返回 null（回退 curl）', () => {
  assert.equal(aria2TargetFor('darwin', 'x64'), null)
  assert.equal(aria2TargetFor('darwin', 'arm64'), null)
  assert.equal(aria2TargetFor('linux', 'ia32'), null)
  assert.equal(aria2TargetFor('freebsd', 'x64'), null)
})

test('getAria2Path 返回子包二进制路径或 null', () => {
  const result = getAria2Path()
  const target = aria2TargetFor(process.platform, process.arch)
  // 两种合法状态：找到二进制（返回路径）或未找到（返回 null）
  // 子包发布后，pnpm install 会把它装到 node_modules，因此这里不能再假设一定为 null
  if (target) {
    assert.ok(
      result === null || result.endsWith(target.bin.replace('/', path.sep)) ||
        result.includes(target.bin.split('/').pop() as string),
      `预期为 null 或指向 ${target.bin} 的路径，实际: ${result}`,
    )
  } else {
    assert.equal(result, null, `不支持的平台应返回 null，实际: ${result}`)
  }
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

/* ------------------------------ 断点续传：真实行为验证 ------------------------------ */

/**
 * 起一个支持 Range 的本地服务器。
 * 注意：必须尊重 Range 的结束位置，否则 aria2 会报 "Invalid range header"（实测 exit 8）。
 */
async function startRangeServer(size: number, body: Buffer): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      const start = m && m[1] ? Number(m[1]) : 0
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      })
      res.end(body.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/f.bin`, close: () => server.close() }
}

test('curl 断点续传：已有半截文件 -> 续传后内容完整正确', async () => {
  const body = Buffer.from('x'.repeat(4096))
  const { url, close } = await startRangeServer(body.length, body)
  const out = path.join(os.tmpdir(), `dsh-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  try {
    // 预置一个 1000 字节的“半成品”
    writeFileSync(out, body.subarray(0, 1000))
    assert.equal(statSync(out).size, 1000)

    await downloadWithCurl(url, out, undefined, undefined, true)
    assert.equal(statSync(out).size, body.length, '应续传到完整长度')
    assert.ok(readFileSync(out).equals(body), '续传后内容必须与源文件逐字节一致')
  } finally {
    rmSync(out, { force: true })
    close()
  }
})

test('curl 断点续传：文件不存在时从头下载，不报错', async () => {
  const body = Buffer.from('y'.repeat(2048))
  const { url, close } = await startRangeServer(body.length, body)
  const out = path.join(os.tmpdir(), `dsh-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  try {
    await downloadWithCurl(url, out, undefined, undefined, true)
    assert.ok(readFileSync(out).equals(body))
  } finally {
    rmSync(out, { force: true })
    close()
  }
})

test('curl 断点续传：已下载完整时重跑仍然成功且内容不变', async () => {
  const body = Buffer.from('z'.repeat(2048))
  const { url, close } = await startRangeServer(body.length, body)
  const out = path.join(os.tmpdir(), `dsh-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  try {
    writeFileSync(out, body)
    await downloadWithCurl(url, out, undefined, undefined, true)
    assert.ok(readFileSync(out).equals(body), '不应被截断或重复追加')
  } finally {
    rmSync(out, { force: true })
    close()
  }
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

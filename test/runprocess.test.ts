/**
 * runProcess 的失败与回落路径单测。
 *
 * 为什么单独成文件：`runProcess` 是 aria2 / curl 两条下载路径共用的唯一进程外壳，
 * 它的每一个 `catch` / `reject` 分支都是「静默失败」的高发位置 —— spawn 失败若被
 * 吞掉，下载工具就会「报告成功但根本没有产出」。既有用例只覆盖了「正常退出」
 * 「非零退出」「预先 abort」「运行中 abort」四种，下面补齐剩余分支：
 *
 * 1. 命令不存在（异步 error 事件）→ 必须 reject 出 ENOENT，而不是静默 resolve；
 * 2. 命令存在但不可执行（Windows 上同步抛 EFTYPE）→ 必须转成 reject；
 * 3. 未传 handlers → 不能因为 `handlers.onStdout` 不存在而抛错；
 * 4. 被信号杀死（close 带 signal）→ 错误消息必须带上信号名（仅 Linux 可复现，见下）；
 * 5. 预先 abort 且命令不存在 → 必须优先报「下载已取消」，而不是把 ENOENT 漏给调用方。
 *
 * 断言一律是正向的：必须看到「具体 reject 出什么」，而不是「反正没 resolve」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../src/downloader.js'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('runProcess: 命令不存在 -> reject ENOENT（不能静默 resolve）', async () => {
  const missing = `definitely-not-a-real-command-${Date.now()}`
  await assert.rejects(
    runProcess(missing, []),
    (err: unknown) => {
      assert.ok(err instanceof Error, '必须是 Error')
      assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT')
      assert.match(err.message, /ENOENT/)
      return true
    },
  )
})

test('runProcess: 命令存在但不可执行（spawn 同步抛错）-> 转成 reject', async (t) => {
  // Windows 上 spawn 一个非 PE 文件（如 .txt）会**同步**抛 EFTYPE，
  // 走的是 runProcess 里 `try { spawn } catch { reject(err) }` 这条早退分支。
  // POSIX 上同一场景走的是异步 'error' 事件（EACCES），不覆盖这条分支，
  // 因此这里显式跳过而不是让断言语义漂移。
  if (process.platform !== 'win32') {
    t.skip('同步 EFTYPE 仅 Windows 复现，POSIX 下走异步 error 事件')
    return
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-notpe-'))
  const notPe = path.join(dir, 'aria2c.exe.txt')
  writeFileSync(notPe, 'not a portable executable')
  try {
    await assert.rejects(
      runProcess(notPe, []),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        // 关键：同步抛出的 EFTYPE 必须被转成 reject，而不是逃逸成未捕获异常
        assert.equal((err as NodeJS.ErrnoException).code, 'EFTYPE')
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runProcess: 未传 handlers -> 正常 resolve，不因缺回调抛错', async () => {
  await assert.doesNotReject(
    runProcess(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']),
  )
})

test('runProcess: 被信号杀死（close 带 signal）-> 错误消息包含信号名', async (t) => {
  // 只测非零退出时拼接的「（信号 X）」。这个分支要求 Node 的 close 事件真的
  // 带出 signal，而 Windows 上无论怎么杀都拿不到：
  //   child.kill() / process.kill(pid) / taskkill /F / 子进程自杀
  // 四条路实测都只给出退出码（-4058 / 1 / null），closeSignal 恒为 null。
  // WSL 与 Linux 上 process.kill(pid, 'SIGKILL') 会正常带出 SIGKILL。
  // 本地 Windows 跳过，CI 的 ubuntu-latest 会实跑这条。
  if (process.platform !== 'linux') {
    t.skip('close 事件的 signal 参数仅 Linux 复现；Windows 上四种杀法实测均为 null')
    return
  }

  // 子进程先把自己的 PID 写到 stdout，父进程读到后再用外部信号杀它，
  // 这样拿到的是「被外部信号终止」，而不是子进程自己退出。
  const pidFile = path.join(os.tmpdir(), `dsh-sig-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`)
  const script = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 200)"
  const running = runProcess(process.execPath, ['-e', script, pidFile])
  try {
    const pid = await waitForNumberFile(pidFile, 2000)
    process.kill(pid, 'SIGKILL')
    await assert.rejects(running, (err: unknown) => {
      assert.ok(err instanceof Error)
      // 退出码可能为 null（被信号终止），信号名必须出现在消息里
      assert.match(err.message, /退出码/)
      assert.match(err.message, /（信号 SIGKILL）/is)
      return true
    })
  } finally {
    rmSync(pidFile, { force: true })
  }
})

test('runProcess: Windows 上用 child.kill 得不到信号名 -> 至少带出退出码', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows 专属行为')
    return
  }
  // 这条不是「测信号名」，而是把 Windows 的真实行为钉住：退出码有了就算成功
  // 传递失败信息，closeSignal 为 null 时消息里不得出现空的「（）」。
  const selfKill = "process.kill(process.pid, 'SIGKILL')"
  await assert.rejects(
    runProcess(process.execPath, ['-e', selfKill]),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /退出码/)
      assert.doesNotMatch(err.message, /（信号\s*）/, 'closeSignal 为空时不得拼出空信号段')
      return true
    },
  )
})

test('runProcess: 预先 abort 且命令不存在 -> 优先报「下载已取消」', async () => {
  const controller = new AbortController()
  controller.abort()
  const missing = `definitely-not-a-real-command-${Date.now()}`
  await assert.rejects(
    runProcess(missing, [], controller.signal),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      // 关键顺序：abort 状态必须压过底层 ENOENT，否则调用方会拿到误导性的错误
      assert.match(err.message, /下载已取消/)
      assert.match(err.message, /AbortSignal/)
      assert.equal((err as NodeJS.ErrnoException).code, undefined)
      return true
    },
  )
})

test('runProcess: close 先于 abort 完成时不误报取消', async () => {
  // 快速成功退出的进程，之后再 abort：已 exited 的进程不得被当成「被取消」
  const controller = new AbortController()
  await assert.doesNotReject(
    runProcess(process.execPath, ['-e', 'process.exit(0)'], controller.signal),
  )
  controller.abort()
  await delay(50)
})

/**
 * SIGKILL 兜底必须对所有平台生效（1.0.0 修正）。
 *
 * 0.9.0 之前这段兜底被 `if (process.platform === 'win32')` 圈住，理由是
 * 「Windows 上 SIGTERM 可能不被响应」。但忽略 SIGTERM 这件事 POSIX 上同样能做
 * （装一个空的 SIGTERM handler 即可），一旦如此，取消下载就永远等不到 close，
 * `smart_download` 卡死在那里不返回。
 *
 * 这条用例跑一个**显式忽略 SIGTERM** 的子进程，abort 之后必须仍在约 1s 后的
 * SIGKILL 下结束。修好之前它在 Linux 上会一直挂着（由 Node 的测试超时兜底）。
 * Windows 上构造不出「忽略终止」的场景（child.kill 走的是 TerminateProcess），
 * 因此跳过。
 */
test('runProcess: 子进程忽略 SIGTERM 时仍会被 SIGKILL 兜底结束', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 上 child.kill 直接终止进程，构造不出「忽略终止」的子进程')
    return
  }
  const controller = new AbortController()
  const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 200)"
  const started = Date.now()
  const running = runProcess(process.execPath, ['-e', script], controller.signal)
  // 等子进程把 handler 装上再取消，否则 SIGTERM 会在装 handler 之前就杀掉它
  await delay(300)
  controller.abort()
  await assert.rejects(running, /下载已取消/)
  const elapsed = Date.now() - started
  // 正向断言：必须在兜底窗口内真的结束（1s 兜底 + 容差），而不是永久挂住
  assert.ok(elapsed < 5000, `忽略 SIGTERM 的子进程应在兜底后结束，实际耗时 ${elapsed}ms`)
})

/** 轮询等待一个「内容是数字」的文件出现，返回该数字（Windows / Linux 通用） */
async function waitForNumberFile(file: string, timeoutMs: number): Promise<number> {
  const { existsSync, readFileSync } = await import('node:fs')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const n = Number(readFileSync(file, 'utf8').trim())
      if (Number.isFinite(n) && n > 0) return n
    }
    await delay(20)
  }
  throw new Error(`等待 PID 文件超时：${file}`)
}

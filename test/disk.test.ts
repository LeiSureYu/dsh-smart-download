/**
 * 磁盘空间预检单测。
 *
 * 这一层挡的是「下载器退出码 0、文件却因磁盘写满而截断」的静默失败。
 * 判定本身是纯函数，查询失败也必须如实返回 checked:false，不能把「没查」
 * 伪装成「查过且够」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DISK_HEADROOM_BYTES,
  checkDiskSpace,
  describeInsufficientSpace,
  evaluateDiskSpace,
  requiredFreeBytes,
} from '../src/disk.js'

const MB = 1024 * 1024

test('requiredFreeBytes：小文件预留固定 64MB', () => {
  assert.equal(requiredFreeBytes(0), DISK_HEADROOM_BYTES)
  assert.equal(requiredFreeBytes(10 * MB), 74 * MB)
  // 5% 小于 64MB 时，固定预留占主导
  assert.equal(requiredFreeBytes(100 * MB), 164 * MB)
})

test('requiredFreeBytes：大文件预留 5%，且向上取整', () => {
  const size = 2 * 1024 * MB // 2GB，5% = 102.4MB > 64MB
  assert.equal(requiredFreeBytes(size), size + Math.ceil(size * 0.05))
  assert.equal(requiredFreeBytes(size + 1), size + 1 + Math.ceil((size + 1) * 0.05))
})

test('requiredFreeBytes：负数 / NaN / Infinity 只要求固定预留', () => {
  assert.equal(requiredFreeBytes(-1), DISK_HEADROOM_BYTES)
  assert.equal(requiredFreeBytes(Number.NaN), DISK_HEADROOM_BYTES)
  assert.equal(requiredFreeBytes(Number.POSITIVE_INFINITY), DISK_HEADROOM_BYTES)
})

test('evaluateDiskSpace：足够与不足都给出可核对的数字', () => {
  const enough = evaluateDiskSpace(200 * MB, 100 * MB)
  assert.deepEqual(enough, {
    checked: true,
    ok: true,
    free: 200 * MB,
    required: 164 * MB,
  })

  const short = evaluateDiskSpace(100 * MB, 100 * MB)
  assert.deepEqual(short, {
    checked: true,
    ok: false,
    free: 100 * MB,
    required: 164 * MB,
  })
})

test('evaluateDiskSpace：大小未知时明确返回 checked:false', () => {
  const verdict = evaluateDiskSpace(200 * MB, undefined)
  assert.equal(verdict.checked, false)
  if (!verdict.checked) assert.match(verdict.reason, /未声明文件大小/)
})

test('checkDiskSpace：真实临时目录可查询，未知大小返回 checked:false', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'disk-test-'))
  try {
    const known = await checkDiskSpace(dir, 1)
    assert.equal(known.checked, true)
    if (known.checked) {
      assert.equal(known.ok, true, '1 字节文件在正常临时目录上应通过预检')
      assert.ok(known.free > 0)
      assert.equal(known.required, DISK_HEADROOM_BYTES + 1)
    }

    const unknown = await checkDiskSpace(dir, undefined)
    assert.equal(unknown.checked, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDiskSpace：目录不存在时返回 checked:false 而不是抛错', async () => {
  const dir = path.join(os.tmpdir(), `disk-missing-${process.pid}-${Date.now()}`, 'nope')
  const verdict = await checkDiskSpace(dir, 1024)
  assert.equal(verdict.checked, false)
  if (!verdict.checked) assert.match(verdict.reason, /无法查询磁盘可用空间/)
})

test('describeInsufficientSpace：带可用 / 需要字节数与下一步', () => {
  const text = describeInsufficientSpace(123, 456)
  assert.match(text, /磁盘可用空间不足/)
  assert.match(text, /123 字节/)
  assert.match(text, /456 字节/)
  assert.match(text, /下一步/)
  assert.match(text, /output/)
})

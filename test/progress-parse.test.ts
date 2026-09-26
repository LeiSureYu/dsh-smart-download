/**
 * progress-parse.ts 单测：锁定 aria2 摘要行解析（真实格式 + 兼容格式 + 非摘要行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAria2Summary } from '../src/progress-parse.js'

test('解析真实 aria2 1.37.0 摘要行（DL，十六进制 GID）', () => {
  const r = parseAria2Summary('[#de8d33 11MiB/40MiB(27%) CN:4 DL:10MiB ETA:2s]')
  assert.ok(r)
  assert.equal(r.pct, 27)
  assert.equal(r.spd, '10MiB/s')
  assert.equal(r.eta, '2s')
})

test('解析兼容格式（SIZE 前缀 + SPD，KiBs 写法）', () => {
  const r = parseAria2Summary(
    '[#1 SIZE:400.0KiB/33.2MiB(1%) CN:1 SPD:115.7KiBs ETA:4m51s]',
  )
  assert.ok(r)
  assert.equal(r.pct, 1)
  assert.equal(r.spd, '115.7KiB/s')
  assert.equal(r.eta, '4m51s')
})

test('100% 行可解析', () => {
  const r = parseAria2Summary('[#ab12 40MiB/40MiB(100%) CN:4 DL:0B ETA:0s]')
  assert.ok(r)
  assert.equal(r.pct, 100)
})

test('非摘要行返回 null', () => {
  assert.equal(parseAria2Summary('=============================================================================='), null)
  assert.equal(parseAria2Summary('FILE: C:/tmp/cap.bin'), null)
  assert.equal(parseAria2Summary('*** Download Progress Summary ***'), null)
  assert.equal(parseAria2Summary(''), null)
  assert.equal(parseAria2Summary('09/26 [NOTICE] Downloading 1 item(s)'), null)
})

/**
 * LineBuffer 单测：它是逐字符状态机，最隐蔽的边界有三类：
 * 1) 跨 chunk 的半截行；
 * 2) \r\n 与 \r（curl）混用；
 * 3) chunk 边界刚好落在 \r 与 \n 之间。
 * 直接驱动生产类 LineBuffer，确保测的是真实切分实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineBuffer } from '../src/downloader.js'

/** 收集 emit 出来的行 */
function collector() {
  const lines: string[] = []
  return { lines, emit: (line: string) => void lines.push(line) }
}

test('跨 chunk 的半截行：先缓存，遇到终止再吐出', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('hel', c.emit) // 半截，无输出
  assert.deepEqual(c.lines, [])
  lb.push('lo\nwor', c.emit) // 拼成 hello\nwor，吐出 hello
  assert.deepEqual(c.lines, ['hello'])
  lb.flush(c.emit) // 末尾无终止符的 wor
  assert.deepEqual(c.lines, ['hello', 'wor'])
})

test('\\r 作为终止符（curl 进度条）', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('a\rb\r', c.emit)
  assert.deepEqual(c.lines, ['a', 'b'])
})

test('\\r\\n 作为终止符', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('a\r\nb', c.emit)
  assert.deepEqual(c.lines, ['a'])
  lb.flush(c.emit)
  assert.deepEqual(c.lines, ['a', 'b'])
})

test('chunk 边界落在 \\r 与 \\n 之间：不重复、不漏行', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('a\r', c.emit) // 先到 \r，a 已结束
  assert.deepEqual(c.lines, ['a'])
  lb.push('\nb', c.emit) // 余下的 \n 是 \r\n 的另一半，应被当作空终止忽略
  assert.deepEqual(c.lines, ['a'])
  lb.flush(c.emit)
  assert.deepEqual(c.lines, ['a', 'b'])
})

test('\\r\\n 与 \\r 混用', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('a\r\nb\rc', c.emit)
  assert.deepEqual(c.lines, ['a', 'b'])
  lb.flush(c.emit)
  assert.deepEqual(c.lines, ['a', 'b', 'c'])
})

test('连续终止符产生的空行被丢弃', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('a\n\nb\n', c.emit)
  assert.deepEqual(c.lines, ['a', 'b'])
})

test('flush 时若没有残留则不输出', () => {
  const c = collector()
  const lb = new LineBuffer()
  lb.push('a\n', c.emit)
  lb.flush(c.emit)
  assert.deepEqual(c.lines, ['a'])
})

test('逐字符喂入含 \\r\\n 的整段文本，结果与整体切分一致', () => {
  const c = collector()
  const lb = new LineBuffer()
  const raw = 'one\r\ntwo\r\nthree'
  for (const ch of raw) lb.push(ch, c.emit)
  lb.flush(c.emit)
  assert.deepEqual(c.lines, ['one', 'two', 'three'])
})

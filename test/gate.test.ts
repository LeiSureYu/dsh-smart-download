/**
 * gate.ts 测试：全局下载闸门。
 *
 * 静默失败形态：并发上限「看起来有」但实际没拦住 —— 两个后台任务 + 一批同时
 * 开跑，全局连接数击穿预算，而没有任何报错。正向契约：
 * - 容量之外的 acquire 必须**真的等待**，而不是立刻放行；
 * - release 之后等待者必须被唤醒，且槽位是**转交**（不是先空档再占）；
 * - FIFO：先等的人先拿到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DownloadGate, GATE_CAPACITY } from '../src/gate.js'

test('GATE_CAPACITY 与批内窗口同源：恒为 2（预算 16 ÷ 单条目最高档 8）', () => {
  // 这个断言锁住「容量 = 窗口」这条不变量：一旦 decision.ts 的档位或倍数改动，
  // 这里必须同步复核 src/gate.ts 与批量编排的推导是否仍然一致。
  assert.equal(GATE_CAPACITY, 2)
})

test('容量内 acquire 立即放行；超容量必须等待', async () => {
  const gate = new DownloadGate(2)
  const releases = [await gate.acquire(), await gate.acquire()]
  assert.equal(gate.activeCount, 2)

  let thirdAcquired = false
  const third = gate.acquire().then((release) => {
    thirdAcquired = true
    return release
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(thirdAcquired, false, '容量之外的 acquire 必须等待')
  assert.equal(gate.pendingCount, 1)

  releases[0]!() // 释放一个槽位 -> 队首被唤醒
  const thirdRelease = await third
  assert.equal(gate.activeCount, 2, '槽位是转交：唤醒后 active 不变')
  assert.equal(gate.pendingCount, 0)
  thirdRelease()
  releases[1]!()
  assert.equal(gate.activeCount, 0)
})

test('FIFO：先等的先拿到', async () => {
  const gate = new DownloadGate(1)
  const first = await gate.acquire()
  const order: number[] = []
  const waiters = [1, 2, 3].map((n) =>
    gate.acquire().then((release) => {
      order.push(n)
      return release
    }),
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  first() // 释放 -> 转交给 w1
  const release1 = await waiters[0]!
  assert.deepEqual(order, [1], '唤醒顺序必须是 FIFO')
  release1() // 转交给 w2
  const release2 = await waiters[1]!
  assert.deepEqual(order, [1, 2])
  release2() // 转交给 w3
  const release3 = await waiters[2]!
  assert.deepEqual(order, [1, 2, 3])
  release3()
  assert.equal(gate.activeCount, 0)
})

test('release 幂等保护：reset 之后旧释放函数不会把计数打成负数', async () => {
  const gate = new DownloadGate(1)
  const release = await gate.acquire()
  gate.reset()
  assert.equal(gate.activeCount, 0)
  release()
  assert.equal(gate.activeCount, 0, '计数夹在 0，不得变负')
})

test('并发场景：N 个 acquire 竞争，最终恰好释放干净', async () => {
  const gate = new DownloadGate(2)
  const order: number[] = []
  await Promise.all(
    Array.from({ length: 7 }, (_, i) =>
      gate.acquire().then((release) => {
        order.push(i)
        release()
      }),
    ),
  )
  assert.equal(order.length, 7, '所有等待者最终都被唤醒且只唤醒一次')
  assert.equal(gate.activeCount, 0)
  assert.equal(gate.pendingCount, 0)
})

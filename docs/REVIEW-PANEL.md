# t26 面板改造 · 独立审查（t27）

> 审查者：impl-a（未参与 t26 的实现；t17 / t22 的文档工作与本次改动无重叠）
> 审查对象：t26 的 `src/client.js` + `test/client.test.ts`（`git diff --stat` 确认只有这两个文件：
> `src/client.js` +676、`test/client.test.ts` +792，**无第三个文件**）
> 权威依据：任务书列出的四种交互态与三条重点怀疑方向
> 方法：读实现全文 → 跑既有测试 → **自建独立探针**（仓库外，`new Function` 装载经典脚本，
> 与仓库测试的手法不同）→ **变异测试**（把实现改坏，证明断言真的会红）
> 结论：**verdict = pass**（附 2 条 low，均不阻塞）

---

## 0. 一句话结论

四种交互态**全部真实成立**，且我用「真实轮询计时器 + 变异实现」两条独立于实现者的路径复核过。
任务书最担心的那条 ——「× 关掉后被下一轮 2 秒轮询弹回、按钮形同虚设」—— **不成立**：
`autoHidden` 由 `close()` 置位、只被「出现从未见过的 task id」或「用户再次打开」清除，
变异测试证明少了这一行面板就会被弹回（即断言确实在守护它）。

---

## 1. 读过的与跑过的

### 1.1 读过的文件（逐行，不是 grep 命中即算）

| 类别 | 范围 |
| --- | --- |
| 实现 | `src/client.js` 全文 1074 行（常量区、`isLive`/`isRecentReceipt`/`isSettled`/`autoRows`/`autoVisible`/`panelRows`、`createPanelStore`、`panelView`、`TaskRow`、`SmartDlProgressPill`、`SmartDlEntryButton`、`apply`） |
| 测试 | `test/client.test.ts` 全文 1360 行（React 桩、effect 依赖比较、`mountPanel`、`installFakeTimers`、`installIntervalTracker`、25 条用例） |
| 契约面 | `src/rpc.ts` 的两条路由注册、`src/index.ts` / `src/status.ts` / `src/cleanup.ts` 的 `git diff`（**零改动**，见 §4） |

### 1.2 跑过的命令

```powershell
cd C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download
node --test --import tsx test/client.test.ts     # 25 tests / 25 pass / 0 fail / 0 skip
git diff --stat -- src/client.js test/client.test.ts src/rpc.ts src/index.ts src/status.ts src/cleanup.ts
# → 只有 src/client.js 与 test/client.test.ts，其余零改动
```

另有两份自建探针（写在仓库外 `C:\Users\Qing\AppData\Local\Temp\panel-review-probe\`，
**跑完已删**，仓库内无残留）：`probe.test.ts`（5 条正向复核）与 `falsify.test.ts`（3 条变异）。
全部用 `new Function(clientSource)()` 装载经典脚本 —— 与仓库测试同一手法，但**装配与断言
由我独立写成**，没有复用 `mountPanel`，避免「用被测代码的帮手验证被测代码」。

---

## 2. 四种交互态逐条核实

### 2.1 下载进行中 → 面板自动出现（不打扰原则保留）✅

- 实现：`panelView()` 的 `visible = userOpen || (!autoHidden && autoVisible(tasks, now))`；
  `autoVisible()` 在「有 `isLive` 任务」时为 true。
- 我的探针 P1：装配后首轮渲染 + 等 tick → `panel.renderPanel() !== null`（成立）。
- 仓库测试：`关闭：…` 用例首行 `assert.ok(panel.render(), '进行中必须自动出现')`。

### 2.2 点会话头部入口 → 打开面板，显示完整列表、不受回执期限制 ✅

- 实现：`panelView()` 里 `rows: opened ? panelRows(tasks, state.now) : autoRows(tasks, state.now)`；
  `panelRows()` 不过滤时间（只分「进行中 / 其余」再各自按 `updatedAt` 倒序），
  而 `autoRows()` 只留 `isLive || isRecentReceipt`（后者受 `FINISHED_HOLD_MS = 5000` 约束）。
  两条列表的差别就是本条交互态的全部依据。
- 仓库测试：`入口：打开后列出已完成的历史任务（超出回收期也看得到）`（:971）。
- 我的变异 M3：把 `panelRows` 换成 `autoRows` 后，一个 10 分钟前完成的任务被过滤
  （`isRecentReceipt` 只留 5 秒内）→ 「历史任务文件名可见」的断言会红。**非恒真。**

### 2.3 关闭控件 → 关闭，且不自动重开 ✅（**任务书重点怀疑方向，专项验证**）

这条我做了三层独立复核，因为它是本改动最容易出错的地方：

**第一层 · 读实现，找齐所有能把面板变可见的入口。**

`visible` 只有三个来源：`userOpen`（`open()` / `toggle()` 置位）、`autoVisible()`、
以及 `state.tasks !== null` 的前置门。`close()` 做两件事：

```js
const close = () => { userOpen = false; autoHidden = true; emit(); };
```

而 `autoHidden` 在全文件里**只被写两次**：

| 位置 | 写成什么 |
| --- | --- |
| `close()` | `true` |
| `publish()` 里 `if (hasNew) autoHidden = false` | `false` |

`hasNew` 的判据是「本轮快照里出现了 `seenIds` 中没有的 task id」。也就是说：
**关掉之后，只有「来了一个从没见过的任务」或「用户再点一次入口」能让它回来**，
轮询本身（同一批任务反复回来）不会 —— 因为 `seenIds` 已经把那些 id 记住了。

**第二层 · 我的探针 P1：走真实轮询计时器，不是 `store.publish()` 直灌。**

仓库测试 :1011 用的是 `panel.publish(live)` 直灌 store。那条路径当然也对（`publish()` 就是
轮询的回调），但它把「定时器真的在驱动可见性」这根导线短路了。我的探针改跑真实链路：
装配 → 等 tick → 点 × → **等两个真实的 2 秒 `setInterval` 跳** → 再渲染。

结果：两次 tick 后面板**都仍是 `null`**，且 `calls >= 2`（轮询确实还在跑、数据还在进 store）。
**× 没有被弹回。**

**第三层 · 变异 M1（最关键）：把 `close()` 里的 `autoHidden = true` 删掉，重跑同一探针。**

结果：`visibleAfterTick === true` —— 面板**被真实轮询弹回来了**。
这同时证明两件事：① 该怀疑方向在实现里是**真实存在的风险**（不是我想出来的）；
② 现有断言**确实在守护它**，不是恒真的空壳。

**跨 slot 一致性（探针 P2）**：入口按钮与面板分处 `conversation.session.header.actions`
与 `shell.overlay`，两者共享 `apply()` 里创建的那一个 `panelStore`。我实测：
自动出现时入口 `aria-expanded=true`；点 × 后面板消失、入口**同步**变 `false`；
再点入口面板打开、入口回 `true`。关闭状态在两处一致，没有「面板关了、入口还以为开着」的割裂。

### 2.4 全部任务终态后 5 秒 → 自动消失 ✅

- 实现：`autoVisible()` 的 `return now - newestUpdate(tasks) < AUTO_HIDE_DONE_MS`，
  `AUTO_HIDE_DONE_MS = 5000`；`newestUpdate()` 取全快照里最大的 `updatedAt`。
- 仓库测试 :1030 用**注入时钟 + 真实轮询计时器**（`Date.now` 改成 `base + 6000`，
  再等 2200ms 让真实 `setInterval` 跳一次）断言面板消失。手法正确：既控制了时间，
  又没有把「定时器驱动可见性」这根导线短路。
- 我的变异 M2：把常量改成 30000 后，`6000 < 30000` 成立 → 旧行为不会消失 → 断言会红。**非恒真。**

---

## 3. 恒真断言专项扫描（本次审查重点）

本会话已在 t13（计时器计数接错对象）与 t21（chunked 截断让负向断言恒真）栽过两次，
所以这一节我不看「断言写得好不好」，只看「**把实现改坏，它到底红不红**」。

### 3.1 实现者自称的三条反证 —— 我独立复算，三条全部成立

| # | 实现者的变异 | 实现者报的原文 | 我的独立复核 |
| --- | --- | --- | --- |
| A | `AUTO_HIDE_DONE_MS = 30000` | `全部终态 5 秒后自动层必须消失` | ✅ 复现：`6000 < 30000` 时面板不消失，断言必然红 |
| B | 打开态也走 `autoRows` | `历史任务的文件名必须可见`（actual `'title\|×\|empty'`） | ✅ 复现：10 分钟前的完成项被 `isRecentReceipt` 过滤，行列表为空 |
| C | `close()` 不置 `autoHidden` | `× 关闭后必须立刻消失` | ✅ 复现：**且我进一步证明它在真实轮询下会被弹回**（M1） |

三条都不是恒真的：每一次变异都让对应断言从绿变红，且我各自确认了「变异真的发生了」
（`assert.notEqual(mutated, ORIGINAL)`，防的是 `replace` 没匹配上、断言因为别的原因红的假象）。

### 3.2 我额外扫出的两处**潜在**恒真风险（均已排除，记录备查）

**① `liveIntervals` 计数接的对象。** t13 的真凶就是把计数包在 React 桩上，
而 `client.js` 里写的是裸 `setInterval(...)`，解析到全局。我核对了 :116-129：
`installIntervalTracker()` 换的是 **`globalThis.setInterval` / `globalThis.clearInterval`**，
与 `client.js` 的裸调用一致。且收尾用例 :1348 有**防空转**的那一条
（`intervalsCreated > 0`，否则「说明计数没接在全局 setInterval 上」）——
这一条本身就是针对 t13 复发的护栏，写法正确。

**② `useEffect` 的依赖比较。** 若桩无条件执行 effect，「settle 后再渲染一次」会多建轮询
计时器（t7 踩过：11 条用例创 18 个、跑完备 8 个）。我核对了 :183-203：桩按 React 语义
做浅比较，`changed === false` 时直接 return。配合收尾用例（`liveIntervals` 必须为空），
这条也不会静默。

### 3.3 一处**实现者没做、但我认为值得补**的扫描（判 low，不阻塞）

仓库测试里「关闭后不弹回」用的是 `store.publish()` 直灌（:1011），
**没有一条用例走「真实轮询计时器跳一次」那条链路**。我用探针 P1 补跑了这条路，结论是通过。

为什么判 low 而不判 blocker：`publish()` 正是轮询回调调用的那一个函数
（`client.js:779`），直灌在语义上等价；且 `自动消失` 用例（:1030）已经用真实计时器
证明了「定时器驱动可见性」这根导线是通的。缺的只是「关闭 + 真实 tick」这一个组合。
建议后续补一条（见 §6 R-1）。

---

## 4. 契约未破坏 ✅

### 4.1 服务端零改动

`git diff --stat` 覆盖 `src/rpc.ts` / `src/index.ts` / `src/status.ts` / `src/cleanup.ts`
**全部零命中**。`smartdl.status` 与 `smartdl.cleanup` 两条路由的注册、`readDownloadStatus()`
的返回结构、单条目 `smart_download` 的返回字段与 render 文案都不在本轮改动范围内。

我另外核对了一个容易漏的点：客户端请求的 `limit` 仍是 `STATUS_LIMIT = 50`
（`client.js:38`，与服务端 `MAX_STATUS_LIMIT` 对齐），没有被这次改造顺手改掉。

### 4.2 只有一处轮询器（跨 slot 的正确性前提）

全文件 `setInterval` **只有一处**（`client.js:787`，在 `SmartDlProgressPill` 里）；
`SmartDlEntryButton` 不注入 `requestStatus`、不请求 Host，只读同一个 store。
这一点是跨 slot 设计成立的前提：如果两个组件各自轮询，「关闭」就会和另一处的
新数据竞争，可能出现「关了又被另一处的 tick 弹回」。实现者选择了「单一 poller」，
我在 §2.3 的实测里也确认了 `calls` 只随一个计时器增长。

---

## 5. 无障碍未退 ✅

| 要求 | 实测 |
| --- | --- |
| `role="progressbar"` | 在（`TaskRow`，未改） |
| `aria-valuenow` | 在 |
| `aria-valuetext` | 在（失败行带原因文本） |
| 新增按钮有可读角色与标签 | `close` 控件有 `aria-label: t('close')`；入口按钮有 `aria-label: t('entry')` + `aria-expanded` |
| 两种可见性在语义上可分 | `role: view.opened ? 'dialog' : 'status'`，读屏用户能区分「可关闭的窗口」与「状态播报」 |

仓库测试另有四条既有信息位与无障碍属性的专项断言（:843）。

---

## 6. Findings（2 条 low，不阻塞）

| id | file | line | severity | problem | requiredFix |
| --- | --- | --- | --- | --- | --- |
| **PANEL-R1** | `test/client.test.ts` | 1000–1028 | **low** | 「关闭后不弹回」用例用 `panel.publish(live)` 直灌 store，**没有走真实轮询计时器**。语义上等价（`publish()` 就是轮询回调），但「定时器驱动可见性」这根导线在这个组合里被短路了 —— 与 t13/t21 两次恒真断言的形态同源（都是「被测链路里有一环被替身替换」） | 补一条用例：点 × 之后 `await` 一次真实 2 秒 tick，再断言仍是 `null`。我的探针 P1 已证明这条断言在当前实现下通过、在变异 C 下会红 |
| **PANEL-R2** | `src/client.js` | 476–486 | **low** | `autoHidden` 的再武装判据是「出现从未见过的 task id」。若同一个 task id 被**复用**（例如调用方自己拼的 `dl-xxx` 撞号，或旧进度文件没清、同一 id 再次出现），自动层不会重新武装 —— 用户会以为「新下载开始了，面板怎么不出来」。这是既有 `seenIds` 设计的固有边界，不是本轮引入的 | 无需改代码。建议在 `publish()` 的注释里补一句「task id 复用不会重新武装」（一行字，防后人误判为 bug） |

### 6.1 已核实**不成立**的怀疑（记录，防重复审查）

| 怀疑 | 结论 |
| --- | --- |
| 「关闭后被下一轮 2 秒轮询弹回，× 形同虚设」 | **不成立**。`autoHidden` 挡住自动层；变异测试证明少了它就会被弹回 |
| 「`FINISHED_HOLD_MS` 一个常量管两件事，语义耦合」 | **不成立**。`FINISHED_HOLD_MS`（单行回执）与 `AUTO_HIDE_DONE_MS`（整块自动隐藏）是两个独立 `const`，`isRecentReceipt` 与 `autoVisible` 各用各的（探针 P3 双向断言：前者不得引用后者、后者不得引用前者） |
| 「跨 slot 两处状态不同步」 | **不成立**。共享同一个 `panelStore`；入口 `aria-expanded` 与面板可见性在关闭/打开时同步（探针 P2） |
| 「用户主动打开的面板也会 5 秒后消失」 | **不成立**。`visible = opened \|\| (...)`，`opened` 为真时 `autoVisible` 根本不参与 |

---

## 7. 结论

### 7.1 Verdict：**pass**

1. **四种交互态全部真实成立**，每条都有「读实现 + 跑测试 + 独立探针」三重依据；
2. **任务书最担心的一条（关闭被弹回）不成立**，且我用变异测试证明了现有断言在守护它；
3. **恒真断言专项**：实现者的三条反证我全部独立复算成立，另扫两处潜在恒真风险（t13 形态的
   计时器计数、effect 依赖比较）均已排除，其中一处还有防空转护栏；
4. **契约未破坏**：服务端四个文件零改动，`limit` 仍为 50，只有一个轮询器；
5. **无障碍未退**：四项既有属性在，新增控件有标签，两种可见性有不同 role。

遗留 2 条 low（PANEL-R1 补一条走真实计时器的用例、PANEL-R2 补一行注释），
都是「让证据更完整」，不是行为缺陷。

### 7.2 审查边界声明

- 本次**未修改**任何 `src/`、`test/`、`dist/`、README、CHANGELOG、他人 docs；
  唯一产出是本文件。两份探针脚本写在仓库外 Temp 目录，**跑完已删**
  （`Test-Path` 复核为 `False`，`git status --porcelain` 无残留）。
- 验证期间**未跑** `pnpm build`（按任务书要求，dist 由 captain 统一重建）。
  我核对过 `dist/client.js` 的 mtime 早于本轮 `src/client.js`，即 dist 尚未反映 t26 ——
  这是预期的，不是缺陷。
- 本报告的结论对「t26 交付时的 `src/client.js`」成立；若后续有人再改面板，
  §2 与 §3 的探针可原样重跑。

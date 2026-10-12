# SPIKE：R2（`ctx.jobs.start()` 可用性）与 R3（跨会话并发池）

> 本文回答 [ROADMAP-1.3.md](./ROADMAP-1.3.md) §6 风险与未知表里 **R2** 与 **R3** 两条「待确证」。
> - 全文**只读分析**：未修改任何 profile 配置、未加载任何实验插件、未改动仓库任何源码或他人文档。
> - 唯一新增产物即本文件。
> - 每条结论都标注证据来源：`读代码确认`（我实际读了源码并给出 file:line）或 `推断`（由已确认的事实推出，未直接观察）。
> - 核对时间：**2026-10-12**（Asia/Hong_Kong）。
> - 读到的实现版本：DSH 安装目录 `C:\Users\Qing\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\`；
>   本机 profile：`C:\Users\Qing\.dsh-home\profiles\desktop\`。

---

## 0. 结论速览

| 问题 | 结论 | 置信度 | 依据 |
| --- | --- | --- | --- |
| **R2**：`ctx.jobs.start()` 在本机 desktop profile 下是否可用？ | **可用**（有前置条件，见 §1.4） | 高（机制由代码确定；「本 profile 至少有一个 controller」由本会话工具表 + cordis.yml 双重确认） | §1.3、§1.5 |
| **R3**：跨会话 / 多 agent 是否共用同一个并行池？ | **不共用**。每个 agent 有自己的 `AgentLoop` 实例与自己的 scope，并行池是**每 agent 每 step** 的局部结构 | 高（代码直接给出每 agent 一个 scope + 局部 `inFlight` Map） | §2.2、§2.3 |
| 由此对路线 B 的影响 | 「纯 CLI profile 下必须整体降级」这个担心**在本机 desktop profile 上不成立**；但 R2 的可用性建立在「有 controller」之上，降级逻辑仍然必须写 | — | §1.6 |
| 由此对「跨调用并发上限」的影响 | **框架不提供**这个上限，而且**不需要**为「同轮串行」而加——同轮串行已由 exclusive 保证；真正需要的是「跨会话总量」上限，理由与 ROADMAP R3 原本的措辞不同 | — | §2.5 |

---

## 1. R2：`ctx.jobs.start()` 的可用性

### 1.1 `start()` 的前置条件（读代码确认）

`start()` 的实现（`@deepseek-ai/dsh-jobs-local/lib/index.js:412-421`）：

| 顺序 | 检查 | 失败时的报错 | 行号 |
| --- | --- | --- | --- |
| 1 | `resolveOwner(spec.owner)` —— 有 owner 时必须能在 agent registry 里找到**存活的** agent | `background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)` / `session "<x>" has no live agent (background job owner must be live)` | `:413`、`:527-534` |
| 2 | `servesOwner(owner)` —— **必须有 controller 服务该 owner** | `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)` | `:414` |
| 3 | `spec.kind` / `spec.label` 非空；`outputLimitBytes` 若给出必须是正整数 | `invalid job kind: …` 等 | `:415-417` |
| 4 | 该 owner 的活动任务数未达上限 | `background job limit reached for this owner (limit: N); use job_kill …` | `:419` |

**结论**：`start()` 的两个「外部依赖」是 (a) agent registry（由 `dsh-agent` 提供）与 (b) 一个 controller（由 `dsh-tool-jobs` 提供）。

### 1.2 controller 是什么、谁挂上去的（读代码确认）

- controller 由 `dsh-tool-jobs` 在自己的 `apply()` 里挂上：`ctx.jobs.attachController("tool-jobs")`（`@deepseek-ai/dsh-tool-jobs/lib/index.js:256`）。
- 该插件声明的依赖是 `["tools", "jobs", "systemPrompt"]`（同文件 `:83-87`）——**它必须有 `jobs` 服务才能加载**，而 `jobs` 由 `dsh-jobs-local` 提供（`@deepseek-ai/dsh-jobs/lib/index.js:115-121`，抽象 `JobRegistry` 在构造时 `super(ctx, "jobs")`；加载抽象类本身会抛错）。
- `attachController` 的实现（`@deepseek-ai/dsh-jobs-local/lib/index.js:518-521`）：

  ```js
  attachController(name) {
    const token = Symbol(name);
    return this.layers.effect(this.ctx, (layer) => layer.controllers.append(token), { label: "jobs.attachController()" });
  }
  ```

  **注意它用的是 `this.ctx`（注册表自己的 context），不是调用方的 context。** 这是下面 §1.3 的关键。

### 1.3 controller 落到哪一层：global 还是 scope（读代码确认）

`servesOwner()` 的判定（`@deepseek-ai/dsh-jobs-local/lib/index.js:543-546`）：

```js
servesOwner(owner) {
  if (!this.layers.global.controllers.isEmpty()) return true;          // 全局层有 controller → 一律放行
  return this.layers.chainLayers(owner === void 0 ? void 0 : scopeOf(owner.ctx))
             .some((layer) => !layer.controllers.isEmpty());           // 否则看 owner 的 scope 链
}
```

而 `layers.effect(ctx, …)` 把注册归档到哪一层，取决于 `scopeOf(ctx)`（`@deepseek-ai/dsh-scope/lib/index.js:189-199`）：

```js
effect(ctx, action, options) {
  const scope = scopeOf(ctx);
  ...
  if (scope === void 0) layer = this.global;   // ← 无 scope 的 context 落到 global 层
  else { ... this.scoped.get(scope) ... }
}
```

`scopeOf` 读的是 context 上的 `kScope` 标记（`@deepseek-ai/dsh-scope/lib/index.js:229`、`:312-314`），
而该标记只在 `createScope()` 里写入（同文件 `:296-306`）：

```js
function createScope(ctx, key, options) {
  const fiber = ctx.plugin(scope);
  const scoped = fiber.ctx.extend({ [kScope]: key });
  ...
}
```

**因此需要确认两件事**：(a) 本机 profile 里 `jobs` 注册表挂在哪个 context；(b) 那个 context 有没有 `kScope` 标记。

**(a) `jobs` 注册表挂在根 context（读代码确认）**

- profile 顶层第 53-54 行（`cordis.yml:53-54`，缩进 0，即 profile 根级）：
  ```yaml
  - id: jobs
    name: '@deepseek-ai/dsh-jobs-local'
  ```
  无 `config`、无 `isolate`、无嵌套。
- 该插件 `apply` 时构造 `LocalJobRegistry`，`ctx` 即根级 fiber 的 context；`Service` 基类把它存成 `this.ctx`
  （`@deepseek-ai/cordis/src/service.ts:42`：`constructor(protected ctx: Context, name: string)`；`:53`：`self.ctx = ctx`）。
  也就是说 **`this.ctx` 就是 `jobs` 那一行所在的 context**，与「谁调用 `ctx.jobs.start()`」无关。

**(b) 根 context 没有 scope 标记（读代码确认 + 一条穷尽检查）**

- `Fiber` 构造自己的 context 时只 `extend({ fiber: this })`（`@deepseek-ai/cordis/src/fiber.ts:236`：`this.ctx = this.context = parent.extend({ fiber: this })`），
  `extend` 只复制传入的 own property（`@deepseek-ai/cordis/src/context.ts:99-107`）——**不会**带上 `kScope`。
  所以只有 `createScope()` 亲手 `extend({ [kScope]: key })` 出来的 context 才带 scope 标记。
- 穷尽检查：整个 DSH 安装里调用 `createScope(` 的位置只有 6 处（见 §3 复现命令 ③），
  分别是 `dsh-agent-loop`（每 agent 一个，`:778`）、`dsh-agent-preset-registry`（每 preset 一个，`:119`/`:527`/`:511`）、
  `dsh-client-connection`（`:537`）、`dsh-mcp-resources`（`:166`）。
  **没有任何一处把 profile 根 context 包进 scope。**

**推断（由 (a)+(b) 得出）**：`scopeOf(this.ctx) === undefined` → `attachController` 把 token 写进 **global 层**
→ 只要**进程里任何地方**加载了一个 `dsh-tool-jobs`，`servesOwner()` 第一行就返回 `true`。

> 与上游文档的表述差异（必须写下来）：`@deepseek-ai/dsh-jobs/README.md:70` 与
> `dsh-jobs-local/lib/index.js:535-539` 的注释把该判定描述成**owner 相对**的
> （「一个 preset 的 job controls 不该为另一个 preset 的 agent 撑开 `start()`」）。
> 按上面的代码路径，`attachController` 用的是注册表自己的 context，落点是 global 层，
> 所以这个判定实际是**进程级**的，而不是 owner 相对的。这是我对代码的读法，**不是**官方结论；
> 若要坐实，需要一次真实加载实验（§1.7）。**但无论哪种读法，对 R2 的答案都是「可用」**，理由见 §1.5。

### 1.4 本机 profile 到底加载了几个 controller（读代码确认）

`cordis.yml` 里 `dsh-tool-jobs` 共出现 **5 次**：

| 行号 | 缩进/位置 | 状态 | 说明 |
| --- | --- | --- | --- |
| `cordis.yml:300-302` | 顶层（profile 根） | **`disabled: true`** | 全局那个被显式关掉了 |
| `cordis.yml:776-777` | 在 `preset-standard` 的 `plugins:` 下（该 preset 起于 `:749`） | 启用 | 该 preset 的每个 agent 都会挂一个 controller |
| `cordis.yml:958-959` | 在 `preset-ptc` 下（起于 `:931`） | 启用 | 同上 |
| `cordis.yml:1232-1233` | 在 `preset-minimal` 下（起于 `:1119`） | 启用 | 同上 |
| `cordis.yml:1477-1478` | 在 `preset-cordis` 下（起于 `:1199`） | 启用 | 同上 |

补充事实：
- `preset-whale-elite`（`:1429`）**不含** `tool-jobs`（穷尽搜索 `jobs` 只命中上表 5 处 + `ui-jobs`），
  所以若某个 agent 用这个 preset，它自己就**没有** controller。
- 本机 profile 的 `jobs` 注册表用的是默认配置（`cordis.yml:53-54` 无 `config`），
  即 `maxConcurrentJobsPerOwner = 10`、`retainBytes = 256 KiB`、`settledRetainBytes = 16 KiB`、`pumpPollMs = 150`
  （`dsh-jobs-local/lib/index.js:339-345`）。

### 1.5 R2 的答案：**可用**（并说明为什么「哪个 preset 生效」不影响答案）

**读代码确认**的两条事实：

1. 全局那一行 `tool-jobs` 是 `disabled: true`（`cordis.yml:302`）——如果 §1.3 的读法错了、
   `attachController` 其实是 owner 相对的，那么本机仍然有 **4 个启用中的 controller**，
   分布在 4 个 preset scope 里（§1.4 表）。
2. 无论 controller 落在 global 层还是落在 preset scope：
   - **global 读法**：`servesOwner()` 第一行直接 `true`（`:544`）。
   - **scoped 读法**：`chainLayers(scopeOf(owner.ctx))` 要能走到 preset scope。
     `dsh-agent-preset-registry` 正是用 `createScope` 为每个 preset 建 scope（`:119`/`:527`），
     而 agent 的 loop 又用 `createScope(loopCtx, this)` 建自己的 scope（`dsh-agent-loop/lib/index.js:778`），
     其父链指向该 agent 所属的 preset scope。

**所以两条读法给出同一个结论：只要当前会话用的是带 `tool-jobs` 的 preset（standard / ptc / minimal / cordis 四个之一），`start()` 就能通过 controller 前置检查。**

**旁证（读代码确认，来自本会话自身）**：本会话的工具表里实际存在 `job_output` / `job_list` / `job_kill`
三个工具（`dsh-tool-jobs/lib/index.js:297-347` 注册 `job_output`、`:347` 注册 `job_list`、`:367` 注册 `job_kill`），
而它们只能由 `dsh-tool-jobs` 提供、且该插件的 `inject` 含 `jobs`（`:83-87`）。
→ **本会话确实加载了一个 `dsh-tool-jobs`**，即本会话所属的 preset 里有 controller。

### 1.6 对路线 B 的直接影响

- **ROADMAP-1.3.md §6 R2 原文**把风险写成「若不可用则路线 B 在纯 CLI profile 下必须整体降级」。
  本次分析的结论是：**在本机 desktop profile 上可用**（controller 存在），
  所以「路线 B 在本机跑不起来」这个担心可以排除。
- 但**降级逻辑仍然必须写**，理由与「本机能不能跑」无关：
  - `jobs` 是可选服务，`start()` 的报错是显式的（`:414`、`:530`）——它在**别的 profile / 别的 preset**
    （例如 `preset-whale-elite`，§1.4）下会真的抛错；
  - 这条契约写在 `@deepseek-ai/dsh-jobs/README.md:40-42`：「A producer can start work only while a controller
    that serves the owner is attached … `start()` fails with a message that names the missing controller」。
  - 所以路线 B 的正确形态是：**先探测可用性，不可用就走同步路径**，而不是「假定可用」。
- 另外三条与 R2 无关但同样决定路线 B 成本的前置条件（均为**读代码确认**，此前已在 ROADMAP 记录，此处只给行号）：
  - 进程内 registry，**不跨重启**：`@deepseek-ai/dsh-jobs/README.md:55`、`:127`。
  - 需要**存活的 agent**：`dsh-jobs-local/lib/index.js:530-532`。
  - 每 owner **最多 10 个活动 job**（默认）：`dsh-jobs-local/lib/index.js:339`、`:419`。

### 1.7 本文没有做到的：一次真实加载实验

**静态分析能确定的**：前置条件的完整清单、controller 的挂载位置与层级语义、
本机 profile 的加载清单（5 处、1 处 disabled、4 处启用）。
**静态分析不能确定的**：`scopeOf(this.ctx)` 在**运行中的进程**里到底是不是 `undefined`。
（我按 `Fiber` 构造 + `createScope` 调用点穷尽检查推出「是」，但这是**推断**，不是观察。）

要坐实需要的最小前置实验（**本轮不做，需 captain 决定是否单开隔离任务**）：
1. 在**隔离**的 DSH 环境（不碰用户 profile）里加载一个最小探针插件，`inject: ['jobs']`，
   在其 `apply(ctx)` 里调用 `ctx.jobs.start({ kind:'probe', label:'probe', run: async () => {} })`；
2. 分别在「只加载 `dsh-jobs-local`（无 controller）」与「再加载 `dsh-tool-jobs`」两种组合下调用，
   记录返回/抛错；
3. 若要在本机 profile 上验证，需**临时**启用被 disabled 的全局 `tool-jobs` 行——
   这是**修改用户 profile**，本轮明确禁止，必须由 captain 决定。

> 但请注意：**R2 的答案（可用 / 不可用）不依赖这项实验**——因为 §1.5 已证明两种读法下结论相同，
> 且本会话工具表已证明 controller 实际存在。这项实验只用于确定「`servesOwner` 是否真的是 owner 相对」
> 这个**代码质量**问题，不影响路线 B 的可行性判断。

---

## 2. R3：跨会话 / 多 agent 是否共用同一个并行池

### 2.1 单轮内的规则（读代码确认，与上游一致）

`executionMode`（`@deepseek-ai/dsh-tools/lib/index.js:3057-3065`）：

```js
executionMode(exec) {
  const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
  if (!tool?.isConcurrencySafe) return { kind: "exclusive" };        // 未声明 → exclusive（fail-closed）
  try { return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" }; }
  catch { return { kind: "exclusive" }; }
}
```

**读代码确认**：`dsh-smart-dl` 全仓 `src/` **没有**声明 `isConcurrencySafe`（也没有 `timeoutMs`、`executionMode`）。
→ `smart_download` 是 **exclusive**。

### 2.2 调度器是「每 step 一次」的局部结构（读代码确认）

`executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext)`
（`@deepseek-ai/dsh-agent-loop/lib/index.js:506-533`）：

- 它拿到的 `toolCalls` 是**这一次 assistant step 的调用列表**（`:509`：`toolCalls.map(...)`）；
- 逐个看模式：exclusive 就**单独成组**（`:524`：`mode === "parallel" ? planned.slice(next) : [first]`），
  即「一个 exclusive 调用 = 一道屏障」；
- 组内并行时用 `runGroup` 的有界滚动池：`inFlight` 是 `runGroup` 里的**局部 `Map`**
  （`:577`：`const inFlight = new Map()`），上限 `maxParallelToolCalls`（`:553`、`:619`）。

**结论**：并行池不是全局对象，而是「一次 `executeToolCalls` 调用内的局部变量」。

### 2.3 每个 agent 有自己的 loop 与自己的 scope（读代码确认 —— 这是 R3 的关键）

`AgentLoopMachine` 的构造（`@deepseek-ai/dsh-agent-loop/lib/index.js:771-789`）：

```js
constructor(loopCtx, id, options, session) {
  this.loopCtx = loopCtx;
  ...
  this.scope = createScope(loopCtx, this);   // ← :778 每个 agent 一个 scope
  this.ctx = this.scope.ctx;                 // ← :779
  ...
}
```

以及工具调度的入口传的是 **这个 agent 自己的 loop context**：
`:1154`：`await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, …)`。

配合 `ctx.agents.create()` 的语义（`@deepseek-ai/dsh-agent/lib/index.js:443-451`：
「Create and publish a new agent through the registered factory … this constructs the agent and its session」），
以及 `createScope` 的穷尽调用点（§3 命令 ③）：

**读代码确认**：每个 agent（无论主会话、subagent 还是 agent-team 成员）**各自**得到一个
`AgentLoopMachine` 实例与一个独立 scope；并行池的 `inFlight` 是该实例一次 `executeToolCalls` 的局部 Map。

**推断**：`maxParallelToolCalls` 是**共享的配置数值**（`ctx.agentLoop` 是根级单例服务，
`:1552` `super(ctx, "agentLoop")`；`:553` 读 `ctx.agentLoop.config.maxParallelToolCalls.get()`，
默认 10 见 `:1534`），但它只是一个**每池的上限读数**，**不是**信号量——
没有任何跨 agent 的 acquire/release。我按「跨 agent 门闸」关键词穷尽搜索过
（`Semaphore|semaphore|globalLimit|processWide|acquire|maxConcurrentAgents`，见 §3 命令 ⑤），
唯一命中是 `:1872` 的注释「Prepare one Agent around an acquired Session」，与并发门闸无关。

### 2.4 R3 的答案

> **跨会话 / 多 agent 同时下载时，不共用同一个并行池。**
> 每个 agent 有自己的 `AgentLoop` 实例与 scope，exclusive 屏障与并行池都只在**该 agent 的那一次 step** 内生效。
> 因此：**同一轮内的多个 `smart_download` 串行**（由 exclusive 保证，且是**每 agent 各自**串行）；
> **不同会话 / 不同 agent 之间的 `smart_download` 没有任何框架级互斥**——两个会话可以同时各起一个 aria2。

置信度说明：
- 「不共用池」= **高**（`createScope` 每 agent 一次 + `inFlight` 是函数局部变量，两处代码直接支撑）。
- 「没有任何跨 agent 门闸」= **高**（穷尽关键词搜索无命中；`agentLoop.config` 只被读取、不被当作许可）。
- **未确证**的一点：agent-team 成员是否与「普通 subagent」走**同一条** `ctx.agents.create()` 路径。
  本轮只确认了 `dsh-subagent-spawn-in-process` 存在 `prepareContinuable()`（`lib/index.js:37`）
  与 `dsh-agent` 的 factory 委派（`dsh-agent/lib/index.js:443-451`），**没有**逐行追完 agent-team 的创建链路。
  这不影响结论方向（无论走哪条路径，每个 agent 都会拿到自己的 loop 与 scope），
  但如果要写进实现文档，建议补一次针对 `dsh-agent-teams` 的定点核对。

### 2.5 对「跨调用并发上限」的必要性判断（这是 R3 的落点）

ROADMAP-1.3.md 原本把 R3 的目的写成「决定『跨调用并发上限』是否真的必要」。按上面的证据，**必要性成立，但理由要改写**：

| 说法 | 是否成立 | 依据 |
| --- | --- | --- |
| 「因为跨会话可能共用并行池，所以需要一个跨调用上限」 | ❌ **不成立**（前提是假的） | §2.3、§2.4 |
| 「同一轮内多个下载会并行，所以需要一个批内上限」 | ❌ **不成立**（未声明即 exclusive，天然串行） | §2.1、§2.2 |
| 「跨会话总量无框架上限，多个 agent 可以同时各起一个 8 连接 aria2，所以需要一个**进程级/全局**上限」 | ✅ **成立** | §2.3、§2.4 + `src/decision.ts:44-47`（单次可开 8 连接） |

**给 t6 的结论**：
1. 批量并发上限（**批内**）仍然是必要的——但理由是「批内多条目并发要有界」，**不是**「跨会话共用池」。
   它与框架的 exclusive 语义**不冲突**（exclusive 只管跨调用，不管调用内部）。
2. 一个**跨调用/跨会话**的上限（例如限制同时活动的 aria2 数量）在框架里**不存在**，
   若要做必须由插件自己实现，且**需要跨进程内共享状态**（`src/progress.ts` 那两条进度轨道是文件，天然跨调用可见，
   但那是「事后可见」而不是「事前互斥」）。这属于**新增能力**，不属于本轮 P0 的「批量」范围。
3. 因此 t6 **不需要**为「跨会话共用池」做任何设计；把批内上限做对即可。

---

## 3. 复现命令（全部只读）

```powershell
$APP = "C:\Users\Qing\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai"
$PROFILE = "C:\Users\Qing\.dsh-home\profiles\desktop\cordis.yml"

# ① jobs 注册表与本机加载清单（5 处，1 处 disabled）
Select-String -Path $PROFILE -Pattern 'jobs|tool-jobs' | ForEach-Object { "$($_.LineNumber): $($_.Line)" }
Select-String -Path $PROFILE -Pattern '^- id: preset-'

# ② start() 的前置条件与 servesOwner
Select-String -Path "$APP\dsh-jobs-local\lib\index.js" -Pattern 'start\(spec\)|servesOwner|attachController|resolveOwner'

# ③ createScope 的穷尽调用点（判断哪些 context 带 scope 标记）
Get-ChildItem $APP -Directory | ForEach-Object {
  Get-ChildItem $_.FullName -Recurse -File -Include '*.js' -ErrorAction SilentlyContinue |
    Select-String -Pattern 'createScope\(' -ErrorAction SilentlyContinue
} | ForEach-Object { "$($_.Path): $($_.LineNumber)" }

# ④ 每 agent 一个 scope + 局部 inFlight
Select-String -Path "$APP\dsh-agent-loop\lib\index.js" -Pattern 'createScope|inFlight = |maxParallelToolCalls|executeToolCalls\('

# ⑤ 跨 agent 门闸的否定证据（应只命中一条无关注释）
Select-String -Path "$APP\dsh-agent-loop\lib\index.js" -Pattern 'Semaphore|semaphore|globalLimit|processWide|acquire|maxConcurrentAgents'

# ⑥ exclusive 规则与 smart_download 的声明（后者应无命中）
Select-String -Path "$APP\dsh-tools\lib\index.js" -Pattern 'executionMode\(exec\)|isConcurrencySafe'
$R = "C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download\src"
Select-String -Path "$R\*.ts","$R\*.js" -Pattern 'isConcurrencySafe|timeoutMs|executionMode'
```

---

## 4. 本文引用的文件清单（均为安装目录/profile，非仓库源码）

| 文件 | 用到的行 | 用途 |
| --- | --- | --- |
| `…\@deepseek-ai\dsh-jobs-local\lib\index.js` | `:339-345`、`:412-421`、`:518-521`、`:527-534`、`:543-546` | `start()` 前置条件、controller 挂载与判定 |
| `…\@deepseek-ai\dsh-jobs\lib\index.js` | `:115-121` | 抽象 `JobRegistry` 服务名与「加载抽象类会抛错」 |
| `…\@deepseek-ai\dsh-jobs\README.md` | `:40-42`、`:55`、`:70`、`:127` | controller 契约、进程内生命周期、owner 相对的表述 |
| `…\@deepseek-ai\dsh-tool-jobs\lib\index.js` | `:83-87`、`:256`、`:297`/`:347`/`:367` | `inject`、`attachController`、三个 job 工具 |
| `…\@deepseek-ai\dsh-scope\lib\index.js` | `:189-199`、`:229`、`:296-306`、`:312-314` | `ScopedLayers.effect` 的 global/scoped 分派、`kScope`、`createScope`、`scopeOf` |
| `…\@deepseek-ai\dsh-scope\README.md` | `:101` | 「只有 scope-aware 的 API 才隔离状态」 |
| `…\@deepseek-ai\cordis\src\service.ts` | `:42`、`:53` | `this.ctx` 就是注册时的 context |
| `…\@deepseek-ai\cordis\src\context.ts` | `:99-107` | `extend()` 只复制 own property（不继承 `kScope`） |
| `…\@deepseek-ai\cordis\src\fiber.ts` | `:236` | `this.ctx = parent.extend({ fiber: this })` |
| `…\@deepseek-ai\dsh-agent-loop\lib\index.js` | `:506-533`、`:551-553`、`:577`、`:619`、`:771-789`、`:1154`、`:1534`、`:1552` | 每 step 调度、`inFlight`、每 agent 一个 scope、`maxParallelToolCalls` 默认值 |
| `…\@deepseek-ai\dsh-tools\lib\index.js` | `:3057-3065` | `executionMode` 的 fail-closed 规则 |
| `…\@deepseek-ai\dsh-agent\lib\index.js` | `:443-451` | `ctx.agents.create()` 委派给 factory（每 agent 新建） |
| `…\profiles\desktop\cordis.yml` | `:53-54`、`:300-302`、`:749`、`:776-777`、`:931`、`:958-959`、`:1119`、`:1232-1233`、`:1199`、`:1477-1478`、`:1429` | `jobs` 与 5 处 `tool-jobs` 的加载状态、preset 边界 |

---

## 5. 未决 / 未覆盖（不得当作已成立）

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | `scopeOf(this.ctx)` 在运行进程中的实际取值（决定 `servesOwner` 是进程级还是 owner 相对） | **静态分析不足以定论**；需要 §1.7 的隔离加载实验。**不影响 R2 的答案** |
| 2 | agent-team 成员的创建链路是否与普通 subagent 完全同一条 | 未逐行追完（见 §2.4）；不影响 R3 的方向 |
| 3 | `preset-whale-elite` 会话下 `start()` 会真的抛错（应为「会」，但未实测） | **推断**（该 preset 不含 `tool-jobs`，§1.4） |
| 4 | 路线 B 若实施，`ctx.jobs` 的 output ring 与现有两条进度轨道如何取舍 | 属设计决策，见 ROADMAP-1.3.md §5 D1，本轮不涉及 |

**本轮未修改任何 profile 配置、未加载任何实验插件、未改动仓库任何源码或他人文档。**

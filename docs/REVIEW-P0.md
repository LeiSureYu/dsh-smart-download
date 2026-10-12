# P0 累计改动独立审查（t5 + t6 + t7）

> 审查者：reviewer（未参与 t5 / t6 / t7 中任何一项的实现）
> 审查对象：工作区 `dsh-smart-download` 中 P0 三项实现任务的**累计**改动
> 权威规格：`docs/ROADMAP-1.3.md`（§1.3 验收标准、§4「不做」清单、§5 已拍板决策、§0.2 六处纠正）
> **round 1 结论：needs_revision** —— 五条验收口径全部有结论，四条「做」的部分都成立；但有两条必须在本轮修掉（P0R-01 入参 schema 松动、P0R-02 清理端点静默回落），另有 6 条应随本轮一并收口。
> **round 2 结论（t15，2026-10-12 09:2x）：needs_revision** —— 见文末 **§5 round 2 追加审查**。8 条 findings 在**源码层**已全部处理（7 条彻底解决），但**已构建产物 `dist/` 没有重建**，两条 blocker 在真正被安装的那份代码里**仍然存在**（P0R2-01）。

---

## 1. 审查范围与方式

### 1.1 读过的文件（全部逐行读过，不是 grep 命中即算）

| 类别 | 文件 |
| --- | --- |
| 规格 | `docs/ROADMAP-1.3.md`（全文 533 行）、`README.md`（契约表 419–495、续传 335–351、进度上报 393–403） |
| t5 | `src/downloader.ts`（退出码段 216–328、runProcess 343–434）、`src/status.ts`（全文 321 行）、`src/index.ts`（`scanDiagnostic` 83–98、`download_status` 372–454） |
| t6 | `src/types.ts`（全文 334 行）、`src/index.ts`（全文 973 行）、`src/progress.ts`（全文 418 行） |
| t7 | `src/client.js`（全文 459 行）、`src/rpc.ts`（全文 259 行）、`src/cleanup.ts`（全文 263 行） |
| 测试 | `test/execute.test.ts`（1–140、1080–1456）、`test/tool-schema.test.ts`（全文）、`test/rpc.test.ts`（555–700 及路由桩 19–135）、`test/client.test.ts`（1–120） |
| 宿主 | `@deepseek-ai/dsh-tools` 的 `defineTool` / `parameterSchemaSpecToJsonSchema` / `lib/types/json-schema.js`；`@deepseek-ai/dsh-client-connection/lib/client.js`（`createWebConnectionRpc`、`installConnection`）；`@deepseek-ai/dsh-host-webserver/lib/index.js`（绑定地址） |

### 1.2 跑过的命令（全部只读或仅产出本文档）

```powershell
cd C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download
pnpm test        # 406 tests / 404 pass / 0 fail / 2 skipped（2026-10-12 09:0x 实测，与 t6 报告一致）
pnpm check       # tsc --noEmit + tsc -p tsconfig.test.json，均 0 错误
git diff --stat -- src test dist docs README.md package.json
git diff -U0 -- test | Select-String '^-\s*assert\.'   # 逐文件统计「被删掉的断言」
```

另有三条**临时脚本**（写在仓库根、跑完即删，未留残余；写 findings 时又补了一条验证修法可行性的脚本，共四条）用宿主自己的实现独立复核，不接受实现者的一面之词：

1. 用**真实的 `defineTool`** 包住 `src/index.ts` 注册的 `smart_download`，再喂 `{}` / `{url}` / `{targets:[{url}]}` / `{targets:[]}` / `{bogus:1}` 五种入参，观察宿主校验是否放行；
2. 用宿主 `lib/types/json-schema.js` 的 `validateJsonSchemaValue` 把单条目与批量两种返回值各跑一遍，并直接打印 `readCleanupQuery({olderThanMs:-1})` 等非法输入的实际返回；
3. 对**已构建产物 `dist/index.js`** 重跑第 1、2 步（安装方拿到的就是这一份，不是 `src/`）；
4. （写 findings 时补做）把 P0R-01 建议的 `oneOf` 入参 schema 直接喂给宿主校验器，验证 `{}` / `{url}` / `{targets}` / `{url+targets}` / `{bogus}` 五种形态都判得对 —— 免得给出一条宿主根本不支持的修法。

### 1.3 冻结快照（本文结论只对这个快照成立）

审查期间工作区**在动**：`dist/` 于 09:00:28 被重建过一次（我在 08:59 首次查看时 `dist/index.js` 还没有 `targets`，随后消失）。因此本文所有结论以以下快照为准，合并前请确认没有新改动：

| 文件 | mtime | sha256 前 12 位 |
| --- | --- | --- |
| `src/index.ts` | 08:58:21 | `AAE62DB9765C` |
| `src/types.ts` | 08:57:21 | `F00CADC2B421` |
| `src/status.ts` | 08:53:41 | `8CE35A3716C4` |
| `src/progress.ts` | 08:45:28 | `9590D75F6639` |
| `src/downloader.ts` | 08:49:22 | `DDAA65C754B5` |
| `src/rpc.ts` | 07:43:30 | `CFF9FC9A693D` |
| `src/cleanup.ts` | 07:42:33 | `4A8217F62EBF` |
| `src/client.js` | 07:57:44 | `8273210FA1BE` |
| `dist/index.js` | 09:00:28 | `581F5F7090ED` |
| `dist/client.js` | 07:57:44 | `8273210FA1BE` |

**构建产物同步性**：`dist/client.js` 与 `src/client.js` 哈希相同（`8273210FA1BE…`）；`dist/index.js` 已包含 `targets` / `maxBandwidth` / `batchConcurrency` / `readDownloadStatus(limit, taskId, session)`。**已构建产物这一层是好的** —— 我用 `dist/index.js` 独立跑通了批量返回与 `describeExitCode`（见 §2.5）。

---

## 2. 逐项结论

### 2.1 ① 静默失败 —— **有 2 条新路径属于「返回默认值却不告知」**（不通过）

先把「不是问题」的部分说清楚，再说问题：

**判定为不是静默失败（有正向断言或本身是显式信号）**

| 路径 | 依据 |
| --- | --- |
| 退出码 0 | `src/downloader.ts:314` `if (code === 0) return null`，`runProcess:425-427` 仍 `resolve()`，不产生任何文案。我用 `dist/index.js` 实测：`{}` 入参走到 `resolveTargets` 抛错、`{url}` 走 curl 退出码 6 → 文案为 `curl 退出码 6\nstderr:\ncurl: (6) Could not resolve host…`，**stderr 原样保留**、命令名收敛为 `curl`、绝对路径不出现 |
| 未知退出码 | `src/downloader.ts:322-326` 走 `!known` 分支，原样保留退出码 + stderr 且不编造下一步。上面那次实测命中的就是这条分支 |
| 批量失败逐条 | `runBatch`（`src/index.ts:942-972`）逐条 `toFailedItem`，`renderBatch`（141-153）把 `[failed] <url>: <原因>` 打进模型可见文案；`test/execute.test.ts:1274-1310` 断言「成功条目结果不丢 + 失败条目带原因」 |
| 取消 vs 失败 | 未开工条目走 `cancelTarget`（925-931）并**各写一条进度记录**；已开工沿用三处 `exec.signal.aborted` 判定；`test/execute.test.ts:1312-1359` 断言 `failed===0` 且轨道一/轨道二各新增 3 个文件 |
| 目录读不到 | `scanFailedDirs` 只在真有失败时出现（`src/status.ts:319`），`src/index.ts:83-98` 把它渲染进模型可见回执，并在两个目录都失败时否定「空列表」结论 |
| 进度写盘超时 | `ProgressReporter.awaitFlush` 超时发 `process.emitWarning`（`src/progress.ts:369-375`） |

**判定为静默失败（findings）**

- **P0R-02（blocker）**：`readCleanupQuery` 对**所有**非法清理参数一律静默回落默认值。实测（宿主校验器同一次脚本）：

  ```
  readCleanupQuery {"olderThanMs":-1}   -> {"olderThanMs":86400000}
  readCleanupQuery {"olderThanMs":"abc"}-> {"olderThanMs":86400000}
  readCleanupQuery {"limit":0}          -> {"limit":200}
  ```

  调用方传 `olderThanMs: -1` 或 `"abc"` 时，**没有任何字段告诉它参数被改写了**（`CleanupResult` 里没有「回落过」的标记），而删除是**不可逆**的。这与本仓库自己的约定正面冲突：同类的 `registerStatusRpc` handler 在 README 契约表里被明确要求「非法 `limit` 必须回落到 `DEFAULT_STATUS_LIMIT`（10）」——**但那条是「回落到已知值并写在契约表里」，这里既没进契约表，也没在任何用户可见处说明**。对比 t6 对 `maxBandwidth` 的处理（非法值在任何请求之前**抛错**，`src/index.ts:857-875`），同一轮里两个新入参采用了相反的哲学。

- **P0R-03（medium）**：`cleanupHistory` 的 `session` 参数在生产路径上**永远是 `undefined`**。全仓只有一处调用（`src/rpc.ts:256`：`cleanupHistory(readCleanupQuery(payload))`），而它不传 session；`cleanup.ts` 自己的文档注释（191 行）却写「@param session 当前会话；用于定位轨道一目录」。后果：通过 HTTP 端点触发的清理**只会扫轨道二（`.json`）**，轨道一（`.jsonl`）只在 `DSH_PROGRESS_DIR` 被显式设置时才参与 —— 而那是测试环境。`test/rpc.test.ts:585-618` 里「`oldTask`（`.jsonl`）必须被删」之所以成立，正是靠 `withDirs` 预设了 `DSH_PROGRESS_DIR`，**这条用例在生产形态下不成立**。既有的 `download_status` 走的是另一条路：客户端会把 `{id, cwd}` 传上来（`src/client.js:343-346`），而 cleanup 端点完全没读 `payload.session`。

### 2.2 ② 测试是否被弱化 —— **没有**（通过，但有一处是「靠测试兜住 schema 的漏洞」）

逐文件的「被删断言」统计（`git diff -U0 -- test`）：

| 文件 | 删除的 `assert.` | 新增的 `assert.` |
| --- | --- | --- |
| `test/downloader.test.ts` | 0 | 19 |
| `test/runprocess.test.ts` | 0 | 28 |
| `test/status.test.ts` | 1 | 34 |
| `test/progress.test.ts` | 0 | 6 |
| `test/verify.test.ts` | 0 | 4 |
| `test/tool-schema.test.ts` | 1 | 39 |
| `test/execute.test.ts` | 0 | 106 |
| `test/rpc.test.ts` | 6 | 30 |

- 删除的 8 条**全部**是被更严格的断言**替换**，不是被删掉：`status.test.ts` 的 `assert.equal(snap.ok, true)`（旧标题「目录不存在 -> 静默跳过，仍返回 ok=true」）换成 `ok === false` + `scanFailedDirs` 逐路径 deepEqual；`tool-schema.test.ts` 的 `params.required === ['url']` 换成 `required === undefined` + `items.required === ['url']`（见 P0R-01，这条替换本身有问题，但不是「弱化」）；`rpc.test.ts` 的 6 条是「恰好注册 1 条路由」→「恰好注册 2 条路由，路径与方法各自正确」。
- 新增用例没有一条是「不抛错就行」：`execute.test.ts` 的批量用例断言了 `results` 顺序与入参一致、每条真的落盘（`existsSync`）、轨道一/轨道二各新增文件数与 `batch` 值相等、`taskIds.size === 3`、`taskIds.has(batch) === false`；带宽用例断言非法值下**服务器 `hits === 0`** 且合法值 `hits > 0`；并发用例断言实测峰值 `maxActive <= limit` **且 `maxActive >= 2`**（防「串行也算通过」）。
- 新增 skip：**0 条**。现存 8 条 `t.skip` 全部是平台既有项（无随包 aria2、Windows/POSIX 差异），与 P0 无关。
- `test/meta-test-discovery.test.ts` 仍在，新增的两个测试文件（`test/client.test.ts`）会被它枚举到。

唯一需要点名的是：**P0R-01 的 schema 松动之所以没造成事故，全靠 `execute` 里的 `resolveTargets` 兜住**（`test/execute.test.ts:1094-1096` 断言 `{}` 会被拒）。测试是对的，但「宿主校验器放行非法入参」这件事本身是契约退化，见下条。

### 2.3 ③ 契约破坏 —— **一处真的破了（入参 schema）**，其余向后兼容成立

**破了的一处**

- **P0R-01（blocker）**：`url` 从必填变成可选后，**宿主侧的入参校验不再拒绝「什么都不给」的调用**。我在 `src/` 与 `dist/` 两份上都用真实 `defineTool` 实测：

  ```
  {}                      -> Error :: 拒绝下载：必须提供 url（下载单个文件）或 targets（一次下载一批）
  { targets:[{url}] }     -> execute 返回（宿主入参校验通过）
  { bogus:1 }             -> Error :: 拒绝下载：必须提供 url…
  ```

  即：`{}` 与 `{bogus:1}` 都**通过了宿主校验**，一路走到 `execute` 才被 `resolveTargets`（`src/index.ts:821-845`）拒绝。1.2.0 下同样的调用在 `defineTool` 的 `ToolArgsError` 处就被挡下（`parameters.required` 里写着 `url`）。规格对此有明确要求（`docs/ROADMAP-1.3.md:185`）：「要么 `url` 仍必填、要么明确改为『`url` 或 `targets` 二选一』**并更新断言** —— **必须二选一并写清**」。现在的实现是**第三种**：`parameters` 里**既没有 `required` 列表**、也没有在 schema 层表达「二选一」，把强制全部推给了运行期。`test/tool-schema.test.ts:79-81` 把这件事固化成了断言（`params.required === undefined`，注释写「二选一」的强制由 execute 负责），等于用测试承认了 schema 不再表达这条约束。

  影响：模型构造出空调用时，报错来自插件的中文 `Error` 而不是宿主的 `ToolArgsError`；`presentCall` / `presentResult` / `isConcurrencySafe` 这三个宿主钩子都以 `validate(args).length === 0` 为前提，入参校验松动会让它们对空入参也生效。这不影响正常调用，但属于「工具对自己接受的输入说不清楚」。

**逐项核实为向后兼容的部分**

| 契约 | 结论与依据 |
| --- | --- |
| 单条目返回结构 | `src/index.ts:644-662` 的 `successResult` 未加任何批量字段；`test/execute.test.ts:1246-1254` 断言 `Object.keys(result).sort()` 恰为 `['fellback','method','mirrored','path','reason','requestedUrl','size','success']` 且无 `batch`/`results` |
| 单条目 render 文案 | `src/index.ts:295-310` 分支一逐字保留；`test/tool-schema.test.ts:140-231` 逐条 `assert.equal`（含「无 reason 时不得拼出空括号」） |
| output schema 两形态 | 我用宿主 `validateJsonSchemaValue` 独立跑过：单条目 `[]`（无违规）、批量 `[]`（无违规），**对 `dist/` 也成立**。`oneOf` 用对了 |
| 老进度文件 | `ProgressRecord.batch?` 可选，`str()` 收敛成 `''`（`src/status.ts:203-204、237-238`）；轨道一/轨道二都在「真有值」时才写字段（`src/progress.ts:265-266、318-319`），缺省路径与 1.2.0 逐字节相同 |
| 空目录返回结构 | `test/status.test.ts` 新用例断言 `Object.hasOwn(snap,'scanFailedDirs') === false` 且键集合恰为 `['downloadDir','ok','taskDir','tasks','total']` |
| 现有 7 个参数 | 全部保留；`headers` 仍是 `additionalProperties: true` 的 object；参数总数 7 → 9（+`targets`/`maxBandwidth`），`test/tool-schema.test.ts:65-78` 逐名断言 |
| 缺省命令行 | `maxBandwidth` 缺省时 `buildAria2Args`/`buildCurlArgs` 不追加开关（`test/downloader.test.ts` 有 deepEqual 基准），单条目内部 `decide()` 未改 |
| 模型可见回执 | `download_status` 无 `scanFailedDirs` 时输出与 1.2.0 逐字节相同（`test/tool-schema.test.ts:349-362`） |

**一处文档与实现的冲突（P0R-04，low）**：`README.md:349` 与 `docs/SECURITY.md:89` 都写「服务器忽略 Range 时 curl `-C -` 以 **exit 33** 失败」，而 `src/downloader.ts:259-262` 的新文案把 33 解释为「HTTP Range 请求未被服务器接受」、下一步是「本地半包已删除，重跑一次会全量重新下载」。**同一份发行物里，同一个退出码有两种解释**。实现者已在交付说明里主动报告了这处不一致（并给出「按官方措辞、不编造语义」的理由，这个取舍我认同：curl 官方把 33 定义为 HTTP range error，而「服务器不支持续传」在 curl 文档里对应 36）。但**文档没同步**，所以用户读到的是矛盾信息 —— 要么改文档，要么改映射，不能两边都留着。

### 2.4 ④ 功能蔓延 —— **没有越界**（通过）

- **「总带宽上限」没有做成跨调用全局状态**（这是 captain 明确禁止的）。`src/index.ts:352-355` 是**纯局部计算**：`perItem = maxBandwidthBytes / workers`，`workers = min(batchConcurrency(), targets.length)`，`maxBandwidthBytes` 来自本次 `args`。我把 `src/index.ts` 的模块级声明全过了一遍：新增的只有 `NO_TASKS_TEXT`、`BATCH_LABEL_*`、`MAX_BATCH_TARGETS`（`= MAX_STATUS_LIMIT`，常量）、`BOTH_URL_AND_TARGETS`、`NEITHER_URL_NOR_TARGETS`、`BATCH_CANCELLED`，以及 `interface` / `function`。**没有任何模块级可变状态**，也没有缓存、没有定时器、没有跨调用注册表。
- 批量并发上限确实取自 `decideConcurrency(LARGE_FILE)`（`src/index.ts:794-796`），不是另立常量；单条目内部 `decide()` 未改。
- 超出 `MAX_STATUS_LIMIT` 显式拒绝（`src/index.ts:838-843`），不是静默截断。
- 对照 `docs/ROADMAP-1.3.md` §4.1「不做」清单逐条核实：后台常驻（路线 B）✗ 未做；跨进程/跨重启持久化 ✗ 未做；服务器端队列协议（aria2 RPC / `--input-file`）✗ 未做；断点续传跨任务合并 ✗ 未做；面板拖拽排序 ✗ 未做；把 `download_status` 改成可写工具 ✗ 未做（`download_status` 仍纯只读，`src/index.ts:442-452`）；面板按钮（取消/重试）✗ **未做**（`src/client.js` 里只有 `connection.rpc.call(API_PATH, STATUS_ENDPOINT, …)` 一处调用，没有任何写端点或按钮）；面板折叠/滚动 —— 路线图列为「待确证」，实现加了 `maxHeight: 260 + overflowY: auto`（`src/client.js:47、394-397`），这是**P0-4 验收标准 1「STATUS_LIMIT 提到 50」的必要配套**，不是新增交互；29 条文案没有全量重写（只动了 D1/E 类/G1）。
- P0-7（每任务限速）**没有**被实现成独立参数：`maxBandwidth` 是「整批共享 + 按并发位均分」，语义上仍是**本次调用内**的上限，符合 §5 D5 ③ 的描述（总带宽上限需要跨调用状态 —— 这里通过「一批内均分」绕开了跨调用状态，属于对已拍板决策的忠实实现）。

### 2.5 ⑤ 对 t7「D6-② 做不到」的独立可行性判断 —— **结论诚实，但有一处措辞不准**（部分通过）

我读了两侧代码，不接受一面之词：

- **客户端侧**：`@deepseek-ai/dsh-client-connection/lib/client.js` 的 `createWebConnectionRpc` 只暴露 `call(channel, endpoint, payload, signal)` 与可选的 `open(channel, endpoint, …)`；`apply` 只做 `installConnection`。**没有任何「触发宿主动作」的 API** —— 这一点实现者说的是对的。
- **宿主侧**：`/api/*` 的写方向要新端点，而**唯一能中断下载的东西**是那次 `exec` 的 `AbortSignal`（`src/index.ts:552、692、729` → `src/downloader.ts:397-403` 的 `signal.addEventListener('abort', onAbort)`）。`AbortController` 只活在 `execute()` 栈帧里，进程内没有 `taskId → AbortController` 映射 —— 这一点也是对的。
- **取消的卡点真实存在**，但措辞要改：实现者写「进程内没有任何 taskId→AbortSignal/agent 映射」，其中 **`agent` 是有的**（`exec.agent` 就是发起调用的 agent，`ToolExecutionContext.agent` 在 `src/types.ts:253-267` 有声明），只是**面板拿不到那个 agent 实例**。另外「再做一轮就是」的那句（注册 `taskId → AbortController` 表 + 在进度里落盘归属 + 授权语义）我认同，且这三件事确实都在本轮 inScope 之外。
- **重试的卡点真实存在且更硬**：进度文件里**根本没有被下载对象的标识**。`ProgressRecord`（`src/types.ts:293-331`）只有 `v/task/pct/msg/state/name/spd/eta/batch`；轨道二的 `DownloadTaskFile`（`src/progress.ts:136-149`）只有 `id/name/status/progress/speed/eta/updatedAt/batch`。没有 `url`、没有 `output`、没有 `sha256`、没有 `headers`、没有 `mirror` —— 面板无从知道「重试什么」。这一点实现者完全说对了。
- **没做死按钮**：`src/client.js` 全文没有任何 `onClick` / `button`，面板保持只读。这一点与报告一致。

因此：**「本轮做不到」的结论诚实**，我认可它没做。唯一要修正的是那句关于 agent 的措辞（见 P0R-07），它不影响结论。

### 2.6 补充核实：t7 报告里有两处与代码不符（P0R-05、P0R-06）

- **P0R-05（low）**：t7 报告称清理入口「与 status **共用一条精确路由按 method 分派**」，代码是**两条独立路由**（`src/rpc.ts:248-257` 调 `registerApiRoute` 两次，路径分别为 `/api/smartdl.status` 与 `/api/smartdl.cleanup`），测试也按两条断言（`test/rpc.test.ts:224-234`「注册两条路由」）。行为没问题（`registerApiRoute` 已经把信封校验与错误语义收成一份，这正是当初抽它的理由），但**报告与代码不符**。顺带：`src/rpc.ts:23` 的注释仍写着「只读端点名」，而 `smartdl.cleanup` 是**写**端点；同文件 238-240 行的注释又正确地说明了 cleanup 的性质。注释之间互相打架。
- **P0R-06（low）**：t7 报告称清理端点「返回逐文件 deleted/kept + truncated + scanFailedDirs」，但**没有报告**上面 P0R-03 的轨道一不可达问题。这不是谎报（代码确实这么返回），而是**没验证「生产形态下能不能清到轨道一」**——测试环境掩盖了它。

### 2.7 补充核实：新增的销毁性端点没有授权检查（P0R-08，low）

`/api/smartdl.cleanup` 只校验 content-type 与信封形状（`src/rpc.ts:170-213`），**不校验调用方身份**。DSH 的 webserver 支持绑定 `0.0.0.0`（`@deepseek-ai/dsh-host-webserver/lib/index.js` 的 `WebServer.Config.host` 只接受 `127.0.0.1 | 0.0.0.0`）。也就是说：若 profile 绑的是 `0.0.0.0`，局域网内任意主机都能 POST 这个端点删掉两条轨道里的过期进度文件。

影响面是**有界的**（只删两个进度目录下后缀为 `.json`/`.jsonl` 的**普通文件**，`lstat` 排除了目录与符号链接；保留窗口下限 60s；单次上限 500；返回里逐文件报告 deleted/kept），而且 1.2.0 起同一载体上就已经有只读的 status 端点。但「只读」变「可删」是新的一档，**至少应在 README 的权限说明里写明这个端点的存在与影响面**。我没有验证本机 profile 实际绑的是哪个地址，因此这条按 low 记，供 captain 决定是否加一道检查或只补文档。

---

## 3. Findings 清单

| id | file | line | severity | problem | requiredFix |
| --- | --- | --- | --- | --- | --- |
| **P0R-01** | `src/index.ts` | 165-172（schema）；`test/tool-schema.test.ts:79-81` | **blocker** | `url` 改为可选后 `parameters` 里**既没有 `required` 列表、也没有在 schema 层表达「url 或 targets 二选一」**。用真实 `defineTool` 实测：`{}` 与 `{bogus:1}` 都能**通过宿主入参校验**，一路走到 `execute` 才被 `resolveTargets` 拒绝。1.2.0 下这类调用在 `ToolArgsError` 处即被挡下，且 `presentCall`/`presentResult`/`isConcurrencySafe` 都以 `validate(args)` 无违规为前提。规格 `ROADMAP-1.3.md:185` 要求「必须二选一并写清」 | 让 schema 层重新表达这条约束，二者取一：(a) 在 `parameters` 上补 `required: ['url']` 并把批量改成「`targets` 存在时忽略 `url`」——但这会让 `targets`-only 调用被拒，**不可行**；(b) 把入参根节点改成 `oneOf: [{required:['url']}, {required:['targets']}]`。**这条我已用宿主的 `validateJsonSchemaValue` 验过可行性**：`{}` → `must match exactly one oneOf branch (matched 0)`、`{url,targets}` → `(matched 2)`、`{url}` 与 `{targets:[…]}` → `[]`，即三种非法/合法形态都判得对；剩下要确认的只是「这个形状能不能经 `parameters` 的 DSL 表达出来」（`parameterSchemaSpecToJsonSchema` 接收的是「属性名 → 属性 spec」的映射，根节点 `oneOf` 需要确认能否透传）；(c) 若 (b) 无法表达，则在 `test/tool-schema.test.ts` 里把「schema 不表达二选一、由 execute 兜底」写成**显式记录的设计决定**，并在 `description` 里明确写出「不提供 url 或 targets 会被拒绝」。无论选哪条，都要把 `test/tool-schema.test.ts:81` 的注释从「不该被 schema 挡下来」改成与实现一致的表述 |
| **P0R-02** | `src/cleanup.ts` | 104-141（`readCleanupQuery`）；`src/rpc.ts:253-257` | **blocker** | 非法清理参数一律**静默回落默认值**且不回告：实测 `{olderThanMs:-1}` / `{olderThanMs:"abc"}` / `{limit:0}` 分别变成 `86400000` / `86400000` / `200`，返回结构里没有任何字段说明参数被改写过。这是本仓库从 0.5.0 到 1.2.0 一直在修的「返回默认值却不告知」形态，而这里删文件是**不可逆**的。同轮 t6 对 `maxBandwidth` 采用的是「非法值在发请求前抛错」，两处哲学相反 | 二选一：(a) 非法值直接以 `ok:false` + 可操作文案拒绝（与 `maxBandwidth` 一致，推荐）；(b) 保留回落，但在 `CleanupResult` 里加机器可读的回落说明（例如 `fallback?: { field, requested, used }`）并渲染进返回，同时把这条写进 README 的静默失败契约表。无论哪条，都要补一条**正向断言**：传非法值时返回值里必须能看到「参数被改写了」，而不只是「没崩」 |
| **P0R-03** | `src/rpc.ts` | 256 | medium | `cleanupHistory(readCleanupQuery(payload))` **不传 session**，而全仓只有这一处调用 → 通过 HTTP 端点触发的清理**永远扫不到轨道一**（`.jsonl`），只有 `DSH_PROGRESS_DIR` 被显式设置时才扫 —— 那是测试环境。`test/rpc.test.ts:585-618` 的「oldTask 必须被删」正是靠这个环境变量才成立，生产形态下不成立。`cleanup.ts:191` 的 `@param session` 注释因此与生产行为不符 | 让 cleanup 端点也接受 `payload.session`（`readPayload` 已经在为 status 解析同一形状），把它传给 `cleanupHistory(query, session)`；或在 `CleanupResult` 里显式报出「轨道一未参与（没有会话上下文）」并补一条**不设 `DSH_PROGRESS_DIR`** 的用例，证明这个缺口是被如实报告的而不是静默的 |
| **P0R-04** | `README.md` 349；`docs/SECURITY.md` 89 | 349 / 89 | low | 文档把 curl 退出码 33 解释为「服务器不支持 Range 时 `-C -` 失败」，`src/downloader.ts:259-262` 的新文案解释为「HTTP Range 请求未被服务器接受」并给出「半包已删除、重跑会全量重下」的下一步。同一发行物里同一个码有两种解释。实现者已在交付说明里报告该不一致但未修 | 对齐二者：按官方定义（33 = HTTP range error；36 = bad download resume）更新 README/SECURITY 的措辞，或在文案里同时给出「这也可能意味着服务器忽略了你发的 Range」。改完补一条断言，把 33 的解释固定下来 |
| **P0R-05** | `src/rpc.ts` | 23-34、248-257 | low | t7 报告称「与 status 共用一条路由按 method 分派」，实际注册的是**两条独立路由**（`test/rpc.test.ts:224-234` 也是按两条断言的）。另：23 行注释仍写「只读端点名」，而 `smartdl.cleanup` 是写端点，与同文件 238-240 行的注释互相矛盾 | 修正报告与注释措辞（两条路由是**正确**的实现，不必改代码）；把 23 行的「只读端点名」改为「status 端点名」 |
| **P0R-06** | `test/rpc.test.ts` | 585-618 | low | 清理的「轨道一会被清」这条关键断言依赖测试夹具预设 `DSH_PROGRESS_DIR`，因此**无法暴露 P0R-03**。这属于「用例在测试环境下为真、在生产形态下为假」的盲区 | 与 P0R-03 一起修：新增一条**不设** `DSH_PROGRESS_DIR` 且**不带** `payload.session` 的用例，断言返回值如实报告轨道一未参与（或断言清理按预期拒绝） |
| **P0R-07** | `src/index.ts` | 511-521（`downloadOne` 入口） | low | t7 报告写「进程内没有任何 taskId→AbortSignal/agent 映射」。`agent` 其实拿得到（`exec.agent`，见 `src/types.ts:253-267`）；真正缺的是「面板 → 宿主」的触发通道与 `taskId → AbortController` 表。措辞不准会让人误以为 `exec.agent` 不可用 | 只需修正报告/文档措辞（例如写「面板侧没有触发宿主动作的 API，且宿主侧没有 `taskId → AbortController` 表」）。**不要**为此实现取消/重试 —— 那超出本轮 |
| **P0R-08** | `src/rpc.ts` | 253-257；`README.md` 551-566（权限说明） | low | 新增的 `/api/smartdl.cleanup` 是**销毁性**端点，除 content-type 与信封形状外**没有授权检查**；DSH webserver 允许绑 `0.0.0.0`。影响面有界（只删两个进度目录下的 `.json`/`.jsonl` 普通文件、保留窗口下限 60s、单次上限 500、逐文件回报），但「只读」变「可删」是新的一档 | 至少在 README 的「权限说明」里写明该端点的存在、删除范围与影响面；若 captain 认为需要，再加一道调用方校验（例如只接受带会话的请求）。我未验证本机 profile 的实际绑定地址，故按 low 记 |

### 3.1 建议随本轮一并收口的文档缺口（非缺陷，不阻塞）

- `README.md` 的「照着官方文档下载」一节（87-194）里**完全没有 `targets` / `maxBandwidth`** 的说明 —— P0 的核心交付（单次调用内批量）在用户可见文档里是零记载，而 README 是本仓库的对外契约。建议补一节，写清：批量语义、逐条结果、部分失败不吞成功条目（D4=②）、上限 50、总带宽上限按批内并发位均分、`url` 与 `targets` 二选一。
- README 的「设计上的静默失败防护」契约表（419-495）没有为 P0 新增的路径补行（批量逐条失败、`scanFailedDirs`、`maxBandwidth` 非法值、`describeExitCode` 未知码）。本仓库把这张表当作硬约定（「如果未来发现某条返回默认值的路径没有被正向信号断言覆盖，那是一个 bug」），新增路径应该在里面有位置。

---

## 4. Verdict

**needs_revision。**

理由，按「通过的部分」与「必须修的部分」分开说：

**通过的部分（有证据，不是「未发现问题」）**

1. **功能蔓延：没有。** 「总带宽上限」是纯局部计算（`src/index.ts:352-355`），`src/index.ts` 新增的模块级声明全是常量/函数/接口，**零跨调用可变状态**；批量上限取自 `decideConcurrency(LARGE_FILE)`；`ROADMAP §4.1` 的「不做」清单逐条核实未越界，面板保持只读、没有死按钮。
2. **测试：没有被弱化。** 8 条被删的断言全部是被更严格的断言替换（旧 `ok=true` → 新 `ok=false` + 逐路径 deepEqual 等），新增用例全是正向断言（真的落盘、真的发请求、真的并行、真的逐条带原因），新增 skip 为 0，`pnpm test` 406/404/0/2 与 t6 报告一致，`pnpm check` 0 错误。
3. **契约向后兼容：除 P0R-01 外全部成立。** 单条目返回结构与 render 文案逐字保留（有 `assert.equal`/`Object.keys` 断言）；output schema 的 `oneOf` 我**用宿主自己的 `validateJsonSchemaValue` 对 `src/` 与 `dist/` 各跑了一遍**，单条目与批量两形态都是 0 违规；老进度文件缺 `batch` 时收敛成 `''` 且键集合与 1.2.0 逐字段相同；缺省命令行不变。
4. **D6-② 的可行性结论：诚实。** 客户端连接面确实只有 `rpc.call`/`open`，没有触发宿主动作的 API；`AbortController` 确实只活在 `execute()` 栈帧里；重试所需的 `url`/`output`/`sha256` 确实**根本不在进度文件里**。结论「本轮做不到、不做死按钮」我独立核实后认同（仅措辞需修正，见 P0R-07）。
5. **已构建产物**：`dist/index.js` 包含批量与退出码翻译，`dist/client.js` 与 `src/client.js` 哈希一致 —— 安装方拿到的是同一份行为。

**必须修的部分（为什么不是 pass）**

- **P0R-01**：入参 schema 的松动是**真的契约破坏**。规格明文要求「必须二选一并写清」，实现选择了第三种（schema 不表达约束、全靠运行期兜底），我用宿主 `defineTool` 实测确认 `{}` 与 `{bogus:1}` 都能穿过宿主校验。这不是风格问题，是「工具对自己接受的输入说不清楚」。
- **P0R-02**：清理端点的**静默回落**正好踩在本仓库花 7 个版本在修的形态上，而且这个动作**不可逆**。README 的契约表里对同类回落（status 的非法 `limit`）是有明文约定的，这里既没约定也没回告。

这两条都**局限在新增路径**上，改动面小（一处 schema 表达 + 一处参数校验 + 两条用例），因此我给出的不是 `reject` 而是 `needs_revision`：修掉这两条、顺带收口 P0R-03（轨道一清理不可达，与 P0R-02 同一处代码）与 P0R-04（文档与文案对 33 的矛盾），P0 就可以进入合并。

**没有做的两件事**（按任务要求）：我**没有修改任何源码或测试**，findings 只写在本文档里；`git status` 里没有我留下的文件（三条临时探针脚本已删除）。

---

*审查者：reviewer｜round 1 审查时间：2026-10-12 09:0x–09:2x（Asia/Hong_Kong）｜快照见 §1.3*

---

## 5. round 2 追加审查（t15，审 t14 的 repair）

> 本节是**追加**内容，不改动 §1–§4 的任何结论（append-only）。round 1 的 8 条 findings 逐条复核结果与新增 findings 都在这里。

### 5.1 本次审查的快照与方式

t14 只改了 6 个文件，mtime 与哈希如下（其余文件与 §1.3 相同，未再改动）：

| 文件 | mtime | sha256 前 12 位 |
| --- | --- | --- |
| `src/index.ts` | 09:10:49 | `3D81F24F574F` |
| `src/rpc.ts` | 09:10:19 | `C9EEC42ABC53` |
| `src/cleanup.ts` | 09:10:00 | `DD807DAD4135` |
| `README.md` | 09:11:58 | `55AD36680E10` |
| `test/rpc.test.ts` | 09:13:03 | `D11D53B8B460` |
| `test/tool-schema.test.ts` | 09:12:09 | `9CA1A2F1D9F5` |
| **`dist/index.js`** | **09:00:28** | **`581F5F7090ED`（与 round 1 完全相同 —— 未重建）** |
| **`dist/cleanup.js`** | **09:00:28** | 未重建 |

跑过的命令：`pnpm test` → **410 / 408 pass / 0 fail / 2 skipped**；`pnpm check` → 0 错误；另外三条临时脚本（跑完即删）：

1. 直接调 `readCleanupQuery` 喂 6 组非法值 + `{}`；
2. 直接调 `cleanupHistory` 构造「带 session / 不带 session」两个临时目录，核对轨道一是否真被清、`taskDir` / `taskDirSkipped` 是否如实报告；
3. **走完整路由**（`registerStatusRpc` → 桩 connection → 真实 `fetch` handler）验证非法参数变成 `ok:false` 而不是 500，并核对 `description` 文案与 `defineTool` 对根级 `oneOf` 的处理。

### 5.2 逐条复核（round 1 的 8 条）

| id | round 1 severity | round 2 结论（源码层） |
| --- | --- | --- |
| **P0R-01** | blocker | ✅ **已解决**。t14 选了 (c)，并把 (b) 的不可行从「怀疑」做成了**证据**：新增用例直接调 `defineTool`，把 `oneOf` 写成 `parameters` 的键，断言它被编译进 `properties`（`test/tool-schema.test.ts:177-208`）。我自己也独立复现了这一点：`defineTool` 编译后的根节点键是 `["type","properties"]`、`oneOf` 落在 `properties` 里 —— **根级 `oneOf` 经 DSL 确实放不下**，所以我 round 1 里给的 (b) 建议不可行，t14 的结论正确。同时它做了两件我要求的显式化：`url` / `targets` 的 `description` 明写「passing both, or neither, is rejected before any request is made」（`src/index.ts:174、179`），并有断言钉住 `/neither/i`（`test/tool-schema.test.ts:124-137`）；根节点键集被断言严格等于 `['properties','type']`（`:111-115`），一旦有人把 `required` 加回来就会红。设计决定记录（`:84-104`）写清了 (a)/(b) 各自的理由 |
| **P0R-02** | blocker | ✅ **已解决**。`positiveIntInRange`（夹取）被 `requireIntInRange`（越界即抛）取代（`src/cleanup.ts:134-150`），并且**两道边界都校验**（`readCleanupQuery:166-177` 与 `cleanupHistory:238-251`）。独立实测：`-1` / `"abc"` / `0` / `59999` / `limit=0` / `limit=501` 全部抛错并点名字段与合法范围（`拒绝清理：olderThanMs 必须是 60000..31536000000 之间的整数（收到 -1）…`），而 `{}`（**没给**）仍走默认值 —— 「没给」与「给了非法值」现在真的可分。**走完整路由**也确认：非法值 → `HTTP 200` + `result.ok === false` + 可操作文案（不是 500、不是静默夹取） |
| **P0R-03** | medium | ✅ **已解决**。`rpc.ts` 抽出 `readSession()` 供两个端点共用（`src/rpc.ts:115-122`），新增 `readCleanupPayload()`（`:153-161`），cleanup 路由把 session 传下去（`:286-293`）；`CleanupResult` 新增 `taskDir`（实际扫描的轨道一目录）与 `taskDirSkipped`（固定文案常量 `TASK_DIR_SKIPPED_TEXT`，`src/cleanup.ts:111-112`）。独立实测：带 `{id,cwd}` 时轨道一的 `.jsonl` **真的被删**且 `taskDir` 报出真实路径、`taskDirSkipped` 不出现；不带 session 时 `taskDir === ''`、轨道一文件**原样保留**、`taskDirSkipped` 明说「轨道一未参与清理…要清理轨道一，请在 payload 里带上 session」 |
| **P0R-04** | low | ✅ **已解决（README 侧）**。`README.md:349-351` 按官方定义重写：33 = HTTP range error、36 = bad download resume，并保留本机实测、明写「33 也可能意味着服务器忽略了你发的 Range…不能据此推断服务器永久不支持续传」。新增文档契约用例（`test/tool-schema.test.ts:450-467`）**同时**钉住代码文案（`/Range/i`）与 README（`/HTTP range error/i`、`/\b36\b/`、`/bad download resume/i`）。`docs/SECURITY.md` 不在 t14 的 inScope 内，其第 89 行「服务器忽略 Range | exit 33（报错）」仍与新口径不完全一致 —— 但那一行的语义（「忽略 Range → 报错」）本身没错，属于措辞层面的残留 |
| **P0R-05** | low | ✅ **已解决（注释）**。`src/rpc.ts:23` 已改为「status 端点名（只读）」 |
| **P0R-06** | low | ✅ **已解决**。新增两条用例：带 `payload.session` → 轨道一过期文件被删且 `taskDir` 报出真实目录（`test/rpc.test.ts:724` 起）；不设 `DSH_PROGRESS_DIR` 且不带 session → `taskDir === ''` + `taskDirSkipped` 含「轨道一未参与」「session」，轨道二照常清理（`:765` 起）。这正是我 round 1 要求的「不设环境变量的用例」 |
| **P0R-07** | low | ✅ **已解决**。`README.md:417` 面板章节新增「面板是只读的（本轮明确不提供取消 / 重试）」，措辞已修正为「宿主侧也没有 `taskId → AbortController` 表：那次下载的 `AbortSignal` 只活在 `execute()` 的调用栈里」——不再声称 agent 拿不到。**没有**实现取消/重试，符合要求 |
| **P0R-08** | low | ✅ **已解决（文档）**。`README.md:565` 权限说明表新增「HTTP 端点（仅带 Web 界面的 profile）」一行：写明两条端点、cleanup 的删除范围（仅两条进度轨道内 `*.json`/`*.jsonl` 的普通文件、`lstat` 不碰目录与符号链接、默认 24h/下限 60s/上限 365 天、默认 200/硬上限 500、最旧优先、不递归不碰产物）、影响面、以及「**鉴权：沿用载体自身（浏览器会话 cookie + loopback / Origin 校验），没有按任务或按会话的授权**」。我独立核对了这句鉴权表述：`@deepseek-ai/dsh-client-connection/lib/index.js` 里确实有签名会话 cookie（`set-cookie` + `browserAuth.isAuthenticated`）与 `isTrustedApiRequest`（Host + Origin 同源）两道检查，且 `requestRejection()` 先 403 后 401 —— 表述与宿主实现一致，不是编的 |

**新增 / 仍存在的 findings（round 2）**

| id | file | line | severity | problem | requiredFix |
| --- | --- | --- | --- | --- | --- |
| **P0R2-01** | `dist/cleanup.js`、`dist/rpc.js`、`dist/index.js` | 全部（产物级） | **blocker** | **已构建产物没有重建，两条 blocker 在真正被安装的那份代码里仍然存在。** `dist/` 里所有文件的 mtime 仍是 **09:00:28**，而 t14 改的 `src/index.ts` / `src/rpc.ts` / `src/cleanup.ts` 是 **09:10**。我逐项核对：`dist/cleanup.js` 仍是旧的 `positiveIntInRange`（第 58/75/78/132/133 行，即**静默夹取**），没有 `taskDirSkipped`；`dist/rpc.js:157` 仍是 `ok(cleanupHistory(readCleanupQuery(payload)))` —— **不传 session**，`readSession` 也不存在；`dist/index.js:123` 的 `url` description 仍是旧文案（没有「or neither, is rejected」）。本仓库的 `dist/` 是**入库的构建产物**（`.gitignore` 明确注释「dist/ 需要入库」，因为 DSH 自带的 pnpm 会拦 git 依赖的构建脚本，从仓库地址安装不能依赖 `prepare`），`package.json` 的 `main` 指向 `dist/index.js`，所以插件在 profile 里跑的、以及从 git 安装的人拿到的，都是这份旧代码 | 合并前跑一次 `pnpm build`（`tsc && node scripts/copy-client.mjs`）并把 `dist/` 一起提交，然后**用 `dist/` 再跑一遍** P0R-02 的非法参数用例与 P0R-03 的 session 用例（我在 round 1 已经演示过这种「对产物本身复核」的做法，`dist/index.js` 当时确实跑得通）。注意 t14 报告里说 V2 只跑了 `scripts/copy-client.mjs`、**没有**跑完整 `pnpm build`，理由是 dist 不在其 inScope —— 这个理由对 t14 成立，但它把「修复未随发行物发出」这件事留给了下一手，必须有人收 |
| **P0R2-02** | `test/resume.test.ts` | 141 | low | 用例标题仍写「服务器不支持 Range -> 删掉半包全量重下（**curl -C - 会 exit 33**）」。P0R-04 刚把「33 = HTTP range error、36 = 不支持续传」这条口径在代码、README 与文档契约用例里对齐，而这个标题又把两者混为一谈 —— 正是那条文档契约想防的表述。断言本身是对的（它测的是 `planResume` 在 `rangeSupported=false` 时删半包），只是标题与 `planResume` 的 reason 文案（`/不支持 Range/`）都属于「计划层」的说法，不该借用 curl 的退出码 | 把标题改成不引用退出码的表述（例如「服务器不支持 Range -> 删掉半包全量重下（planResume 判定）」）。`test/resume.test.ts` 不在 t14 的 inScope 内，故记为 round-2 的新条目 |

### 5.3 round 2 的逐项结论（五条口径）

1. **静默失败：源码层已无新增路径**（P0R-02 用「越界即拒绝」彻底关掉了清理端点那条；其余路径与 round 1 一致，仍是显式信号或有正向断言）。**但产物层仍然存在** —— 见 P0R2-01。
2. **测试是否被弱化：没有。** 本次新增的用例全部是正向断言：非法参数用例断言 `ok:false` + 文案点名字段与范围 + **一个文件都没删**（预先摆了过期文件）；轨道一用例断言文件真的被删/真的保留 + `taskDir`/`taskDirSkipped` 的具体值；P0R-01 的证据用例断言 `defineTool` 编译结果的**结构**（根节点键集、`oneOf` 落在 `properties`）。`pnpm test` 410/408/0/2，新增 4 例、skip 仍 2。
3. **契约破坏：源码层已无。** P0R-01 走 (c) 后，schema 仍不表达「二选一」，但缺口已被**显式记录 + 文案明写 + 断言钉住**三件事覆盖，这正是我 round 1 requiredFix 里给的 (c) 分支。单条目返回结构、render 文案、老进度文件、7 个参数、output schema 的 `oneOf` 全部与 round 1 结论相同（未受影响）。
4. **功能蔓延：仍然没有。** t14 新增的模块级声明只有常量与函数（`TASK_DIR_SKIPPED_TEXT`、`requireIntInRange`、`readSession`、`readCleanupPayload`），**没有**新增 `let` / `Map` / 定时器 / 缓存；取消与重试**没有**被实现。
5. **D6-② 与 §4「不做」清单**：结论不变（诚实 / 未越界）。

### 5.4 Verdict（round 2）

**needs_revision。**

8 条 round-1 findings 在**源码层**全部得到处理（7 条彻底解决，P0R-04 只剩 `docs/SECURITY.md` 一句措辞残留），并且 t14 用**可复现的证据**推翻了我 round 1 建议里的 (b) 方案 —— 这一点我认账，它的 (c) 比我给的 (b) 更准确。

之所以仍不能给 pass，是因为**这套修复目前只存在于 `src/`，没有进入被安装的那份产物**：`dist/` 停在 09:00:28，里面仍是「静默夹取」与「不传 session」的旧实现，而 `dist/` 是本仓库入库的发行物、`main` 指向它。也就是说，用户装上插件后，P0R-02 与 P0R-03 描述的行为**一模一样**。这不是吹毛求疵：round 1 我就是靠「对 `dist/` 跑一遍」才确认当时产物是同步的，现在这一步正好反过来了。

**收口清单（按优先级）**：
1. `pnpm build` 并把 `dist/` 一起提交；用产物复跑 P0R-02 / P0R-03 的用例（P0R2-01，blocker）。
2. 顺手改 `test/resume.test.ts:141` 的标题，别让刚对齐的 33/36 口径又被一处标题带回去（P0R2-02，low）。
3. 若时间允许：`docs/SECURITY.md:89` 的措辞与 README 新口径对齐；README 补 `targets` / `maxBandwidth` 一节与契约表新增行（round 1 §3.1 的两条文档缺口，仍是非阻塞）。

**没有做的两件事**（再次确认）：本次审查**没有修改任何源码或测试**，findings 只写进本文档；三条临时脚本跑完即删，`git status` 里没有我留下的文件。

*审查者：reviewer｜round 2 审查时间：2026-10-12 09:2x（Asia/Hong_Kong）｜快照见 §5.1*

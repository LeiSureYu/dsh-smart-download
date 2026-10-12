# 下载管理器改造：可行性判定与实施方案

> **文档性质**：可行性调研 + 实施方案（**只读调研，未改任何代码**）。
> **用户需求原文**：「是放在左侧边栏的下载管理选项，然后打开之后弹出窗口显示下载列表，并且可以选择打开文件，打开文件夹，删除记录，删除记录中可以选择是否删除本地（取决于下载好的东西还在不在原文件夹），如果移走便只有删除记录」
> **已拍板的两项**（captain 转达）：
> 1. 打开一律走**文件管理器**（不要去找文件的关联应用 / 不要走 `openPath` 的 OS 默认程序路子）。
> 2. 「删本地文件」**要做**，因此 ④ 从「要不要做」变成「给出可实施的安全设计」。
>
> **调研边界**：本任务只读。没有改任何 `src/`、`test/`、`dist/`、`README`、`CHANGELOG`、`package.json`，没有改他人 docs，没有修改 profile 配置，没有加载任何实验插件，没有启动任何服务。唯一新增文件就是本文档。
> **证据标记**：文中 `[代码]` = 我读了实现代码确认；`[文档]` = 官方 README 原文；`[推断]` = 由已读代码外推、未实机验证；`[未定]` = 静态分析不足以定论，需要哪种前置实验。

---

## 0. 结论摘要（TL;DR）

| # | 问题 | 结论 | 关键依据 |
|---|---|---|---|
| ① | 侧边栏入口 + 面板怎么注册 | **入口注入 `sidebar.panellist`（只提供图标 + label），面板注册到 root 作用域 `main` 的 keyed slot（key 与入口同 id）**；开合由 `ctx.layout.selectPanel(id)` / `selectPanel(null)` 控制 | `dsh-client-ui-sidebar/README.zh.md:36-38`[文档]；`dsh-client-ui-plugin-manager/lib/client.js:3712-3754`、`:3769-3775`[代码] |
| ② | 工作区**之外**的下载文件能不能打开 / 能不能打开它所在文件夹 | **都能**。但注意：用户说的「打开文件」实际只能是「在文件管理器中**定位/选中**该文件」，而这只有 **reveal** 那条路能做；`dsh-host-open-in-app` 的 open 路由**只接受目录**，做不了文件选中。两条路都**没有工作区限制** | `dsh-fs-local/lib/index.js:792-794`、`dsh-fs-sandbox/lib/index.js:103`、`dsh-api-session-controller/lib/index.js:3062-3071`、`:3031-3043`；`dsh-host-open-in-app/lib/index.js:1353-1400`[代码] |
| ②′ | 「打开文件」与「打开文件夹」是不是同一个动作 | **基本是**。reveal 会打开所在文件夹并选中该文件 ⇒ 建议**合并成一个按钮**（「在文件夹中显示」），不做两个语义重复的重按钮 | `dsh-native-command/lib/index.js:260-288`（Windows `explorer.exe /select,`）、`:143-152`[代码] |
| ③ | 输出路径的数据模型改动 | 轨道一 `ProgressRecord` 与轨道二 `DownloadTaskFile` 各加**可选**字段 `outPath` / `size` / `fileMtimeMs`，**缺省不写**；读取端用既有的 `str()`/`num()` 收敛手法，与 1.3.0 的 `batch` 字段完全同构 | `src/types.ts:307-344`、`src/progress.ts:138-148`、`:266`、`:311`、`:319`；`src/status.ts:197-204`、`:227-239`[代码] |
| ④ | 「删本地文件」的安全设计 | **路径只能来自本插件自己的记录，绝不接受调用方传路径**；逐条拒绝目录 / 符号链接 / `..` / 尺寸不符 / 仍在跑的任务；先删文件再删记录；失败如实回告。**没有 `outPath` 的老记录直接降级为「只能删记录」** | 先例：`src/cleanup.ts:191-220`（只扫自己的目录 + `lstat` + `isFile`）、`:236-251`（越界拒绝而非夹取）、`:285-291`（失败跳过并回告）[代码] |
| ⑤ | 「文件还在不在原文件夹」怎么判 | 按记录里的 `outPath` 做一次 `lstat`：`missing` / `present`（尺寸一致）/ `changed`（尺寸或 mtime 不一致）/ `blocked`（是目录或链接）/ `unknown`（老记录没路径）。**要一起记 `size`**（字节数），不必默认记 sha256 | `src/status.ts:27-56`；终态取尺寸的现成锚点：`assertIntegrity()`（`src/index.ts:676-690`，里面就是 `localFileSize(outputPath)`）+ `src/resume.ts:52-58`[代码] |

**一句话**：①③④⑤ 都可行且有现成惯例可抄；② 可行但**必须改成「在文件管理器里显示」这一个动作**，而这件事取决于我们能不能从浏览器侧拿到 `remote.session`（官方插件正是这么用的，见 §2.2；若拿不到则退化为只用 `/open-in-app/open` 打开目录，此时才真需要两个按钮）。

---

## 1. ① 侧边栏入口 + 面板的注册方式

### 1.1 结论

- **入口**：注入 `sidebar.panellist`（root 作用域的 **list** slot）。我们**只提供「图标组件 + label + id」**，按钮本身、点击、选中态全部由侧边栏渲染与管理。
- **面板**：注册到 root 作用域的 **`main` keyed slot**，`key` 与入口的 `id` **相同**。面板会**占据主区域**（会话界面被替换），这就是 DSH 自己的「全局面板」形态。
- **开合**：`ctx.layout.selectPanel(id)` 打开；`ctx.layout.selectPanel(null)` 回到会话界面；当前是否打开由 `ctx.layout.panelInfo` 的快照/订阅给出。

### 1.2 可直接抄的注册形状（照现有惯例，未自创）

参照实现：**插件管理器页**（`@deepseek-ai/dsh-client-ui-plugin-manager`，它同时注册了侧边栏入口与全局面板）。

**入口**（`dsh-client-ui-plugin-manager/lib/client.js:3769-3775`）[代码]：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,            // 与 main 的 key 相同
  order: 0,
  label: () => t("panel"), // 字符串或 locale-aware 函数
  locale: NS
}, PluginsPanelIcon));
```

**面板**（同文件 `:3712-3754`）[代码]：

```js
ctx.slots.inject("main", function* () {
  const handle = createNavigationStore(), instance = handle.create();
  const store = { ...handle, create: () => instance };
  yield ctx.slots.register({
    name: "main",
    key: PANEL_ID,          // ← keyed slot 的 key
    locale: NS,
    store,                  // 可选的 per-registration store
    inject: () => face,     // 注入给组件的业务面
    children: { /* 该面板自己声明的子 slot，可省 */ }
  }, PluginManagerPage);
  // 观察选中态（可选，用来做「离开面板时复位」这类事）
  yield ctx.layout.panelInfo.subscribe(() => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") { /* 复位 */ }
  });
});
```

**我们的形状**（建议 `PANEL_ID = "smartdl.downloads"`，避免与官方 `plugins` 等 id 撞车）：

```js
// 我们的 client.js 里（沿用现有 t26 的 register 风格，只需要 react 白名单里的 createElement）
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 30, label: () => t("panel"), locale: NS
}, SmartDlSidebarIcon));
ctx.slots.inject("main", function* () {
  yield ctx.slots.register({
    name: "main", key: PANEL_ID, locale: NS,
    inject: () => ({ requestStatus, panelStore, /* 见 §2/§4 的额外能力 */ })
  }, SmartDlManagerPage);
});
```

`inject` 需要的服务（照 plugin-manager 的惯例，`dsh-client-ui-plugin-manager/lib/client.js:3658-3667`）[代码]：最小集合是 `"slots"`、`"locale"`，打开/关闭面板要 `"layout"`，若要调 §2.2 的 reveal 还要 `"remote.session"`。

### 1.3 侧边栏那一侧发生了什么（为什么入口只需要图标）

`dsh-client-ui-sidebar/lib/client.js:173-199`[代码] 里 `PanelRow` 自己渲染按钮：

```js
react.createElement("button", {
  type: "button",
  "aria-label": label,
  "aria-current": active ? "page" : void 0,
  onClick: () => { selectPanel(id); },
  children: [ glyph(renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })), ... ]
})
```

⇒ **点击、aria、选中态、tooltip 都是侧边栏给的**；我们提供的组件只接收 `{ size, active }`（插件管理器的图标就是 `({size}) => jsx(IconPluginPinwheelOutlineRegular, {size})`，`:3633-3635`）[代码]。所以**入口图标不需要自己写 onClick**，也不需要处理键盘可达性 —— 那是官方外壳的职责。

### 1.4 打开 / 关闭的精确语义

- `ctx.layout.selectPanel(id)` 选中已注册面板（`dsh-client-ui-layout/README.zh.md:32`[文档]）。
- **`selectPanel(null)` 回到会话界面**（同上）——这就是「关闭」。
- 选中不存在的 key 会**抛错并保留当前面板**（`dsh-client-ui-layout/README.zh.md:55`[文档]），所以面板必须比入口先注册好（同一 `apply` 内 `inject('main')` 在前更稳）。
- 当前是否打开：`ctx.layout.panelInfo`（`getSnapshot().activePanelId` / `subscribe`，plugin-manager `:3755-3756`）[代码]。
- 侧边栏**不做 toggle**：`onClick` 永远是 `selectPanel(id)`（同 id 再点一次也是「选中」，不会退回会话）[代码]。所以「关闭」要么靠点击侧边栏里的会话/工作区，要么由我们的面板自己提供一个关闭按钮（推荐：面板标题栏放「返回会话」，内部调 `selectPanel(null)`）。这是与用户「弹出窗口」直觉最接近的一处交互，**建议做**。

### 1.5 图标与依赖

- 官方插件的 client bundle **在构建期**把 `@deepseek-ai/dsh-client-ui-primitives` 打进了自己的产物（`_deepseek_ai_dsh_client_ui_primitives.IconPluginPinwheelOutlineRegular`，`:3634`）[代码]。
- 我们的 `src/client.js` 是**手写的经典脚本**（文件头注释：`window.__ModuleLoader__.load({ id, factory })`，`require` 被限制在随包下发的模块白名单里，目前只用 `react`）。`dsh-client-modules/lib/index.js:453-475` 定义了装载协议本身，但**白名单的具体内容没在本次调研里读全**`[未定]`。
- ⇒ **结论（保守）**：入口图标用 **内联 SVG + `react.createElement` 自己画**（与现有 `src/client.js` 的做法一致），**不引入任何新依赖、不依赖官方 primitives**。若以后想用官方图标，需要先做一次「`require('@deepseek-ai/dsh-client-ui-primitives')` 在白名单里吗」的实验`[未定]`。

### 1.6 与现有 t26 产物的关系（需要 captain/用户拍板的决策点）

现状（t28 之后）已经有两样东西：`shell.overlay` 里的浮层进度条（自动浮现、可关、5 秒后消失）+ 会话头部 `conversation.session.header.actions` 的入口按钮（打开同一个浮层看完整历史）。

本次改造提供第三个位置：**侧边栏入口 → 全局面板**。三者的取舍：

| 形态 | 优点 | 缺点 |
|---|---|---|
| **A. 侧边栏入口 → `main` 全局面板**（官方惯例，推荐） | 有整屏空间放列表 + 每行多个操作按钮；不会被任何容器裁剪；就是插件管理器/设置页的同款形态 | 会**替换会话界面**（不是浮在会话上的窗口）；用户要按侧边栏的会话列表回会话 |
| B. 侧边栏入口 → 复用现有 `shell.overlay` 浮窗 | 字面意义最接近「弹出窗口」，不离开会话 | 浮窗尺寸小（现有 280px / 260px 高）、无模态与遮罩、将来放「确认删除」对话框会更挤 |
| C. 两者都做 | 入口统一为侧边栏；浮窗继续只做「进行中播报」 | 维护两套列表渲染 |

**我的建议**：**A 为主**（管理器 = 全局面板），`shell.overlay` 浮层**保持只播报**（进行中 + 刚结束），删掉 t26 那个会话头部按钮（它的职能被侧边栏入口完全取代，留着会多一个「同一个东西两个入口」）。是否保留浮层的「查看完整历史」，可以简化为一个链接 → `selectPanel(PANEL_ID)`。

> ⚠️ 这条是 UX 决策，不在我的判定范围内。文档后面（§6）按 A 写实施步骤；若选 B，②③④⑤ 的结论**全部不变**，只是面板宿主的 API 从 `ctx.slots.register({name:'main', key})` 换成现有 `shell.overlay` 注册。

---

## 2. ② 打开文件 / 打开文件夹的可行性（本任务最重要的一条）

### 2.1 两条「文件管理器」机制（都不是「关联应用」）

| 机制 | 谁实现 | 调什么 | 能开文件？ | 能选中文件？ | 需要 catalog id？ | 工作区限制？ |
|---|---|---|---|---|---|---|
| **A. Session Remote reveal** | `dsh-api-session-controller` + `dsh-native-command` | `remote.session.openWorkspacePath({ path, action: 'reveal' })` | ✅（文件/目录都行） | ✅ Windows `/select,`、macOS `open -R`；Linux 只开父目录 | ❌ 不需要（主机自己选文件管理器） | ❌ **没有** |
| **B. 目录打开路由** | `dsh-host-open-in-app` | `POST /open-in-app/open { app: 'explorer', path }` | ❌ | ❌ | ✅ 必须（本机是 `explorer`） | ❌ **没有** |

两条路都**不是**「用系统默认程序打开文件」——那条路是 `openNativeAssociatedPath`（`action` 缺省的 `openWorkspacePath`，或 catalog 里除文件管理器之外的条目），按 captain 的决定**排除**。

### 2.2 机制 A：Session Remote reveal（推荐主路）

**调用形状**（官方浏览器插件就是这么写的，`dsh-client-ui-open-in-app/lib/client.js:439-451`）[代码]：

```js
// inject 列表里要有 "remote.session"（同文件 :745-750[代码]）
const result = await ctx.remote.session.openWorkspacePath({ path, action: "reveal" });
const ok = result.ok;                    // 失败时官方包装成 null / 抛错被吞掉
// 能力闸门（同文件 :471[代码]）：
const can = await ctx.remote.session.canOpenWorkspacePath();
```

**主机侧实现链**（逐层，全部 `[代码]`）：

1. `SessionController.openWorkspacePath(request, signal)`（`dsh-api-session-controller/lib/index.js:3031-3043`）
   - `request.action === "reveal"` → `this.revealPath(path, signal)`（`:3034`）
   - 否则 `request.application !== undefined` → 指定应用（**我们用不到**）；再否则 `this.openPath(...)`（`:3036`）
   - 成功后返回 `{ opened: true }`（`:3037`），失败抛 `RemoteError`（`:3039-3041`）
2. **唯一的路径校验**：`verifyDesktopPath(path, signal)`（`:3062-3071`）
   - 非空（`:3063`）
   - `resolve(path)` 归一化（`:3065`）
   - `const mapped = fs.processPathFromHostPath(hostPath)`，**`mapped === undefined` 就拒绝**（`:3067-3068`）
   - 往返一致性：`fs.processPath(await fs.resolve(mapped, {signal})) !== hostPath` 就拒绝（`:3068`）
   - **没有** `cwd`/workspace 前缀检查，**没有** `stat`（不要求文件已存在）
3. 这个 `fs` 在本部署里是 **`dsh-fs-sandbox` 的 `SandboxedFileSystem`**：
   - 它 **`extends LocalFileSystem`**（`dsh-fs-sandbox/lib/index.js:103`），所以 `processPathFromHostPath` 用的是 `dsh-fs-local` 的实现（`dsh-fs-local/lib/index.js:792-794`）：
     ```js
     processPathFromHostPath(hostPath) { return isAbsolute(hostPath) ? resolve(hostPath) : void 0; }
     ```
     ⇒ **任意绝对路径都映射成它自己**（这正是「绝对路径的工作区外文件」能通过的原因）。
   - 沙箱只管**写**（`:87-90` 注释：`read-only` 拒所有变更、`workspace-write` 只允许 workspace 根或平台临时区下的变更）——reveal 不是写，**不受影响**。
4. 真正的动作：`revealNativePath(path, signal)`（`dsh-native-command/lib/index.js:260-288`）
   - darwin：`open -R <path>`（Finder 里选中）
   - win32：`explorer.exe /select,<编码后的 file URL>`（`:280` + `runExplorer` `:143-152`；**Explorer 退出码 1 被当作「已交给桌面进程」而接受**[代码/注释]）
   - linux：`xdg-open <dirname(path)>`（只开父目录，**不选中**）
5. 能力闸门：`canOpenPath`（`dsh-api-session-controller/lib/index.js:2868`）
   ```js
   this.canOpenPath = internals.canOpenPath ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()));
   ```
   `canOpenNativePath()`（`dsh-native-command/lib/index.js:205-211`）：`darwin`/`win32` 恒真；`linux` 需要 WSL 或有 `DISPLAY`/`WAYLAND_DISPLAY`。
   **本机部署实测条件**（读 profile 配置，未改动）[代码]：`DSH_PROFILE=desktop`、`C:\Users\Qing\.dsh-home\profiles\desktop\cordis.yml:567-568` 里 `session-controller` **没有** `config.nativeOpen` 覆盖 ⇒ 落到 `canOpenNativePath()` ⇒ 本机是 `win32` ⇒ **可用**。

**结论（机制 A）**：`D:\Downloads\foo.zip` 这种**工作区之外**的文件 → **能**用 reveal 在资源管理器中选中；它所在的文件夹当然也被打开了。

### 2.3 机制 B：`POST /open-in-app/open`（目录专用）

主机侧处理器（`dsh-host-open-in-app/lib/index.js:1353-1400`）[代码]：

1. body 必须是 JSON 且 `app`、`path` 都是字符串（`:1353-1359`）
2. `app` 必须是 **catalog 里且本机已解析出启动器** 的 id，否则 400 `unknown or unavailable app`（`:1361-1369`）
3. `path` 非空且**绝对**，否则 400（`:1370-1376`）
4. **`path` 必须是已存在的目录**，否则 404 `directory does not exist`（`:1377-1389`）⇒ **文件路径打不开，也谈不上「选中文件」**
5. 启动（`:1390-1399`）：`launchResolved(...)`；失败 502

**文件管理器的 catalog id**（本机 Windows）：
- `explorer`（`dsh-host-open-in-app/lib/index.js:118-125`）：`kind: "fixed"`、`launch: { kind: "shell-open" }`、`iconPath: "${SystemRoot}/explorer.exe"`[代码]
- macOS 是 `finder`（`:110-117`）、Linux 是 `filemanager`（`xdg-open`，`:126-129`）
- 为什么「本机一定解析得到」：`explorer` 的 locator 是 `kind: "fixed"`，而代码注释写明了理由——Finder/Terminal/Explorer 是系统自带、locator 恒能解析（`dsh-host-open-in-app/lib/index.js:101-107`[代码]；文件管理器在目录白名单里的位置见 `README.zh.md:54`[文档]）。我也在本机做了只读探测：`C:\WINDOWS\explorer.exe` 存在（`Test-Path` 为 True）[本机]
- `runShellOpen` → `openNativePath(path, ...)`（`dsh-host-open-in-app/lib/index.js` 的 `runShellOpen`）[代码]：对**目录**调用 OS shell 打开 ⇒ 资源管理器窗口
- **没有**工作区检查：处理器里除了「绝对 + 已存在目录 + catalog id」之外没有别的路径约束[代码]

**浏览器侧怎么调**：官方浏览器插件就是用 `fetch` 调这三条路由的（`dsh-client-ui-open-in-app/lib/client.js:12-16` 定义 `OPEN_IN_APP_APPS_ROUTE`/`OPEN_IN_APP_OPEN_ROUTE` 等常量，`:88` 注入 `fetcher = (input, init) => fetch(input, init)`）[代码] ⇒ **同源 fetch 可行**（我们的面板 UI 与 `/open-in-app/*` 同源、已通过部署的认证与 Host/Origin 栅栏；路由自身的信任说明见 `dsh-host-open-in-app/README.zh.md:82`[文档]）。

**本部署是否挂载**：`cordis.yml:545-552` 同时挂了 `@deepseek-ai/dsh-host-open-in-app`（含 `probeTimeoutMs/iconTimeoutMs/launchWatchMs` 配置）与 `@deepseek-ai/dsh-client-ui-open-in-app`[代码] ⇒ 机制 B 可用。

**环境例外**：若进程带着 `SSH_CONNECTION`/`SSH_TTY`，应用列表为空且启动请求被拒（`dsh-host-open-in-app/README.zh.md:62`[文档]）——机制 B 会整体失效（机制 A 不受此条影响`[推断]`：A 的闸门只有 `canOpenPath` + fs 映射）。

### 2.4 明确回答 captain 的三个问题

1. **工作区之外的目录/文件能不能开？** **能。** 两条机制都只要求「绝对路径」（A 额外只要求 fs 能映射，B 额外要求「已存在的目录」），**代码里没有任何工作区前缀/白名单检查**。之前那个「疑似工作区限制」的名字 `canOpenWorkspacePath` 是个**能力位**（`canOpenWorkspacePath() { return this.canOpenPath(); }`，`dsh-api-session-controller/lib/index.js:3009-3011`[代码]），**不是**按路径判定的——名字里的 workspace 是历史包袱（它最早服务于「把会话工作区交给桌面打开」）。
2. **文件管理器对应哪个 catalog id + 本机是否探测到？** Windows 是 **`explorer`**；本机是 Windows 且该条目是 `kind: fixed`（系统自带，恒可解析），`C:\WINDOWS\explorer.exe` 实测存在。我**没有**去调 `GET /open-in-app/apps`（那需要浏览器身份 cookie，且属于运行时验证），所以「本机探测结果的确切 JSON」我**没拿到**`[未定]`——但从 `fixed` + 系统自带这两点看，`explorer` 一定在列表里。
3. **能不能「定位到该文件」？** **能**，但**只能走机制 A（reveal）**：Windows 是 `explorer.exe /select,<file URL>`、macOS 是 `open -R`；机制 B **做不到**（它只接受目录）。Linux 的 reveal 只开父目录、不选中`[代码]`。

### 2.5 「打开文件」与「打开文件夹」是否退化成一个动作

- 用户要的「打开文件」在「一律走文件管理器」的前提下，实际含义只能是**在文件管理器里定位/选中它**；这正是 `reveal`。而 `reveal(file)` 本身就会打开它**所在的文件夹**。
- ⇒ **两个按钮语义重合，建议合并为一个：`在文件夹中显示`**（reveal 该文件）。若文件已不在（§5 判定 `missing`）→ 该按钮置灰/隐藏，只剩「删除记录」（正好是用户说的「如果移走便只有删除记录」）。
- 如果最终只能用机制 B（拿不到 `remote.session`），那么它**只能开目录**，此时「打开文件」实际退化成「打开所在文件夹」——**这时才需要单独立一个「打开所在文件夹」按钮**，并且要在 README 里写明「不能选中文件」。这条**如实写出来**，因为它决定按钮个数。

### 2.6 静态分析不足以定论的部分

| 未定项 | 为什么不能定论 | 需要什么前置实验 |
|---|---|---|
| **第三方客户端插件能不能拿到 `remote.session`** | 官方插件用 `inject: [... "remote.session" ...]`（`:745-750`）[代码]，但**我们的** client bundle 是手写经典脚本，是否在白名单/服务图中暴露该服务未验证 | 10 分钟实验：临时给现有 client.js 的 `inject` 加 `"remote.session"`，看插件是否仍激活、`ctx.remote.session` 是否可调用（`canOpenWorkspacePath()` 返回 `{ok:true,value:true}`）。**失败也不阻塞**：退化为机制 B |
| `GET /open-in-app/apps` 在本机的确切返回 | 需要带认证的浏览器会话 | 打开现有「Open In…」按钮看菜单里有没有「文件资源管理器 / Explorer」即可（人肉实验，1 分钟） |
| 沙箱部署下 reveal 工作区外路径 | 代码上 fs 映射不限制、沙箱只管写`[代码]`；但「DSH 是否把 host 进程整体放进 OS 沙箱」属于运行时事实 | 在 `danger-full-access` 与 `workspace-write` 两种模式下各点一次 reveal（实现完成后顺手做） |

---

## 3. ③ 记录输出路径的数据模型改动

### 3.1 现状（为什么必须加字段）

- 轨道一 `ProgressRecord`（`src/types.ts:307-344`[代码]）：`v: 1`（`:309`）、`task`、`pct`、`msg`、`state`、`name?`（`:328`，可选）、`spd`、`eta`、`batch?`（`:344`，1.3.0 新增、可选）。**没有输出路径**。
- 轨道二 `DownloadTaskFile`（`src/progress.ts:138-148`[代码]）：`id`、`name`、`status`、`progress`、`updatedAt`、`batch?`（`:148`）。**没有输出路径**。
- 写入点：`src/progress.ts:266`（`if (this.batch) rec.batch = this.batch`）、`:311`（`name: this.label ?? this.taskId`）、`:319`（`if (this.batch) task.batch = this.batch`）、`:321`（落盘）。
- ⇒ `name` 是**标签**（`ProgressReporter` 的 `label` 参数，`src/progress.ts:206-214`[代码]），实际调用点 `src/index.ts:571` 传的恰好是输出路径，但**别的调用点**可能传别的字符串（captain 实测见过 `"x"`）。所以**不能用 `name` 兜当路径**。

### 3.2 路径是已知的，而且能算成绝对值

- `src/index.ts:567`[代码]：`const outputPath = item.output ?? deriveFilenameFromUrl(item.url)`
- `src/index.ts:571`[代码]：`new ProgressReporter(taskId, outputPath, ctx.session, ctx.batchId)`
- aria2 侧：`buildAria2Args(url, outputPath, ...)` → `'-o', outputPath`（`src/downloader.ts:182`[代码]）
- 关键坑（**必须在实现时处理**）：
  - `deriveFilenameFromUrl` 返回的是**文件名**（`src/url.ts:135` 起[代码]），即 `outputPath` 可能是**相对路径**；
  - 子进程 **没有指定 `cwd`**（`src/downloader.ts:360-361`：`const options = { windowsHide: true }; spawn(command, args, options)`[代码]）⇒ 相对路径落在 **Host 进程的 cwd**；
  - ⇒ 记录时必须写**绝对路径**：在**任务开始时**（spawn 之前）算一次 `path.resolve(outputPath)` 并把**同一个字符串**同时用于「传给 aria2 的 `-o`」与「写进记录」，避免完成后再 `resolve` 撞上 cwd 变化。

### 3.3 加什么字段（可选、缺省不写）

| 轨道 | 字段 | 类型 | 何时写 |
|---|---|---|---|
| 一 & 二 | `outPath?: string` | 绝对路径字符串 | 任务开始时已知，**每条记录都写**（终态记录必须有） |
| 一 & 二 | `size?: number` | 字节数 | **终态**写一次（下载完成、校验通过之后 `lstat` 一次） |
| 一 & 二 | `fileMtimeMs?: number` | mtime 毫秒 | 同上（用于 §5 的 `changed` 判定） |

**不写**：`sha256`。理由：算哈希要整文件读一遍，只在调用方传了 `expectedSha256` 时才有（`src/hash.ts` / `src/verify.ts`，`src/index.ts:696`[代码]）；把它变成默认记录会把「不校验的下载」也拖成两倍 I/O。若将来 UI 想显示哈希，可以在「已校验」的任务上顺带记下来（那时它本来就已算出）。

**实现落点**（给出锚点，具体行号在编码时钉）：
- 构造/写入：`ProgressReporter` 构造函数（`src/progress.ts:206-214`）增一个可选参数，或在 `done()` 路径调用 `reportOutput({path,size,mtimeMs})`；终态写盘在 `:299-321`。
- `src/index.ts`：任务开始处（`:567` 附近，spawn 之前）算绝对路径。
- **终态取尺寸的现成锚点**：`assertIntegrity()`（`src/index.ts:676-690`）——它就是下载完成后的字节数校验，已经在 `localFileSize(outputPath)`（`src/resume.ts:52-58`，`statSync` + `isFile()`）拿到了尺寸；在下游成功路径（`clearMarker(outputPath)` 那段，`:789` 附近[代码]）把 `size`/`fileMtimeMs` 写进终态记录即可，**不需要额外的 `stat`**（若铁了心只调一次，可以在 `assertIntegrity()` 里把那次 `statSync` 的结果带出来）。
  ⚠️ 但**删除前的核对必须用 `lstat`**（§4 R5），不能复用这里的 `statSync`（后者会跟进符号链接）。

### 3.4 向后兼容（复用 `batch` 的手法，**不破坏老记录可读**）

1. **写入侧**：只在有值时写字段，缺省**整个字段不出现**——与 `batch` 逐字同构（`src/progress.ts:266`、`:319` 的条件赋值）[代码]。
2. **读取侧**：`src/status.ts` 的两个读取器本来就把缺失字段收敛掉：`name: str(rec.name)`（`:197`）、`batch: str(rec.batch)`（`:204`，注释原文：「老记录没有 batch：`str()` 收敛成空串，解析结果与 1.2.0 逐字段相同」）、轨道二同理（`:227-239`，注释「与轨道一同理：老任务文件没有 batch 时为 `''`」）[代码] ⇒ 新字段照抄：`outPath: str(rec.outPath)`、`size: num(rec.size)`（缺省 `0`/`''`）。
3. **回归项**：1.3.0 的硬要求「老进度文件缺字段时照常可读」由上面两条共同保证；测试要补一条 `batch` 同款的「老记录（无 outPath）解析结果与现状逐字段相同」断言。
4. **UI 语义**：`outPath === ''` ⇒ 面板按 `[代码]`：显示「该任务没有记录输出路径（1.4.0 之前的历史记录）」，只允许「删除记录」。

### 3.5 隐私影响 + `docs/SECURITY.md` 拟稿

**影响**：`outPath` 会把**用户的本地绝对路径**（含用户名，如 `C:\Users\Qing\Downloads\…`）写进进度文件。这些文件本来就落在本机（`<DSH_HOME>/downloads/tasks` 与会话进度目录，`src/progress.ts:99-120`[代码]），**不上传**；但它们是可被 `smartdl.status` 读出来、并可能出现在会话记录/截图/分享里的数据，所以必须**显式写进 SECURITY.md**。

**拟稿**（放哪：SECURITY.md 的「本地持久化」区，与吞吐缓存那节同级；另在「权限清单」加一行；在「已知边界」加一句）：

```markdown
### 本地持久化：输出路径（`1.4.0` 起，`src/progress.ts`）

`1.4.0` 起，进度记录（轨道一 `ProgressRecord`、轨道二任务文件）会额外写入三个**可选**字段：

| 字段 | 内容 | 为什么需要 |
|---|---|---|
| `outPath` | 该次下载**输出文件的绝对路径** | 代码库要能实现「在文件管理器中显示」与「删除本地文件」，两者都必须知道文件在哪 |
| `size` | 完成时的字节数 | 判断「文件是否还是下载好的那一个」（被替换/截断时不得删除，见下） |
| `fileMtimeMs` | 完成时的修改时间 | 同上，作为尺寸之外的第二判据 |

隐私说明：`outPath` 含本机路径（通常含用户名）。这些字段只写入本机的进度文件（`<DSH_HOME>/downloads/tasks/*.json` 与会话进度目录下的 `*.jsonl`），**不随任何网络请求外发**；`smartdl.status` 会把它们返回给本机会话里的面板。
存储位置与生命周期：与既有进度记录完全一致（受 `smartdl.cleanup` 的保留窗口管辖）。
关掉方式：删除对应进度记录即删除这些字段（面板的「删除记录」）。
```

「权限清单」新增一行（照现有表格形状）：

```markdown
| 读取下载输出文件的元数据（`lstat`：存在性/类型/大小/mtime） | 判断「文件是否还在原位置」，以及在删除前核对它是否还是当初那一个 | 只读，不读取内容 |
| 删除下载输出文件（`unlink`） | 用户显式确认后的「删除记录并删除本地文件」 | **不可逆**；只针对本插件记录过的 `outPath`，逐条校验见下 |
```

「已知边界」加一句：

```markdown
- 记录输出路径意味着进度文件里出现本机绝对路径；不想要这份记录时，用面板的「删除记录」清掉，或调 `smartdl.cleanup` 按保留窗口清理。
```

> 注：SECURITY.md **不在本任务写作用域内**，上面只是可直接采用的拟稿，由持有该文件的人落笔。

---

## 4. ④ 「删除本地文件」的安全设计

### 4.1 既有先例（同一仓库已经有一套「不可逆删除」的纪律）

`src/cleanup.ts`（清理过期进度文件）已经确立了我们该照抄的四条：

1. **候选只来自自己扫描自己的目录**，从不接受调用方给的路径（`:259-264`：`collectCandidates(downloadDir, ...)` / `collectCandidates(taskDir, ...)`）[代码]
2. **`lstat` + `isFile()`**（`:211-213`，注释原文：「lstat（而非 stat）：符号链接要按链接本身判断，不能跟进目标」）⇒ 目录与符号链接都被排除[代码]
3. **越界参数拒绝而不是夹到边界**（`:236-251`，注释原文：「清理会删文件，因此任何『给了但越界』的值都必须在此止步，而不是被夹到边界后照删」）[代码]
4. **单个失败不让整次操作失败，且如实回告**（`:285-291` 跳过并计数；返回里带 `scanFailedDirs`/`taskDirSkipped`，`:294-305`）[代码]

### 4.2 规则表（每条都带理由）

| # | 规则 | 理由 |
|---|---|---|
| R1 | **删除路径只能来自本插件自己写的记录**（`outPath`）；客户端只允许发 `taskId`，**任何情况下都不接受客户端传来的路径** | 路径一旦来自调用方，「只删自己的下载」这条前提就消失了，退化成任意文件删除（被 XSS/恶意插件/误操作利用的代价不可逆） |
| R2 | `taskId` 必须**白名单化**（例如 `/^[A-Za-z0-9._-]{1,64}$/`），不允许路径分隔符、驱动器号、`..`；拼记录文件名时只用 `path.join(dir, id + ext)` | 防止用 `taskId` 做目录穿越去删别的记录文件（同 `cleanup.ts` 的「参数越界即拒绝」精神，`:236-251`） |
| R3 | `outPath` 必须**非空 + `path.isAbsolute`** | 相对路径的含义取决于进程 cwd，删的时候可能与写的时候不是同一个文件 |
| R4 | `outPath` 必须**已归一化**：`path.normalize(p) === p`，且不含 `..` 段、不含 NUL | `..\..\Windows\System32\x` 这类构造能在「看起来是自己记录过的路径」外壳下指向别处；归一化比较是最便宜的防线 |
| R5 | `lstat`（**绝不 `stat`/`realpath` 跟进**）必须成功且 `isFile()`；`isDirectory()` / `isSymbolicLink()` 一律拒绝 | 目录删除退化成递归删除（代价不可控）；符号链接会让「删记录里的那个文件」变成删链接指向的任意目标（`cleanup.ts:211-213` 同款做法） |
| R6 | 若记录了 `size`，则**必须与当前 `lstat().size` 相等**，否则拒绝 | 防「原文件被移走、另一个文件占了同一个名字」——那是别人的文件，不是我们的下载结果 |
| R7 | 记录里**没有 `outPath`（1.4.0 之前的历史记录）⇒ 只允许删记录，不允许删文件** | 没有可靠路径 = 无法证明那是我们的输出（与 captain 的耦合要求一致：③ 不到位，④ 就降级） |
| R8 | 任务**仍在运行**（终态前）时拒绝删文件 | 正在写的文件被删会造成 aria2 续传/校验的诡异状态，且用户此时的本意通常是取消而不是删除 |
| R9 | 路径**落在本插件自己的记录目录内**（`resolveDownloadProgressDir()` / `resolveTaskProgressDir()`，`src/progress.ts:99-120`）或等于其祖先目录 ⇒ 拒绝 | 那条路属于「删除记录」的职责，用「删文件」的入口去删记录/其他任务的文件是职责越界 |
| R10 | 不做**通配/递归/批量清空**：一次只删显式 `taskId` 对应的那一个文件 | 不可逆操作的最小爆炸半径原则；批量清空留给已有的 `smartdl.cleanup`（它有保留窗口语义） |
| R11 | **顺序：先删文件，成功后再删记录**；文件删除失败就**保留记录**并把失败原因回告 | 反过来（先删记录）会让用户永久失去重试的机会，而文件又还躺在那儿 |
| R12 | 失败分类回告，**绝不假装成功**：`gone`（`ENOENT`，本来就没有）/ `busy`（`EBUSY`/`EPERM`/`EACCES`，占用或权限）/ `denied`（沙箱/策略拒绝）/ `is-dir` / `is-link` / `changed`（尺寸不符）/ `no-path`（记录无路径）/ `running` | 用户要能知道「为什么没删掉」，而不是看到一个静默的成功 |
| R13 | 客户端必须**二次确认**（对话框里显示**完整绝对路径** + 大小），并且线上带 `confirm: true`；不确认时**只删记录** | 破坏性操作的默认行为必须是「保守的那一个」 |
| R14 | 不写「回收站/撤销」 | 本插件是 Node 侧宿主代码，没有找到可用的回收站服务（Electron 的 `shell.trashItem` 不在我们的运行时里）`[推断]`；因此**删除是永久的**，必须在确认文案里明说 |

### 4.3 端点设计

沿用现有 RPC 惯例（`src/rpc.ts`：所有端点挂在共享 `/api` 载体上——`STATUS_ENDPOINT = 'smartdl.status'`（`:24`）、`CLEANUP_ENDPOINT = 'smartdl.cleanup'`（`:34`）、`connection.fetch.register({ path: '/api/<endpoint>' })`（`:199-200`）、每个端点各自包在子 effect 里（`:260`）)[代码]，建议新增 **一个** 端点、用 `op` 区分动作（避免端点名爆炸）：

```
POST /api/smartdl.manage
{
  "op": "delete",                 // 第一版只做 delete
  "taskId": "dl-xxxx",
  "deleteFile": true,             // false/缺省 = 只删记录
  "confirm": true,                // deleteFile=true 时必须为 true
  "session": { "id": "...", "cwd": "..." }   // 与 status 一致，用于定位轨道一目录
}
→ 200 {
  "ok": true,
  "value": {
    "taskId": "dl-xxxx",
    "file":   { "deleted": false, "reason": "changed", "path": "D:\\Downloads\\foo.zip" },
    "record": { "deleted": true, "files": [".../downloads/tasks/dl-xxxx.json"] }
  }
}
```

- 路径来源：**服务端自己读 `.../downloads/tasks/<taskId>.json`（缺失时退回轨道一 `.jsonl`）**，取出 `outPath`/`size`；客户端传来的路径**一律忽略**（连字段都不必定义）。
- 与 `smartdl.cleanup` 的关系：`cleanup` 管「过期的进度文件」，`manage` 管「用户显式点的那一条」。两者职责不重叠，**不合并**。

### 4.4 「删除记录」自己也要安全

- 轨道二：`path.join(resolveDownloadProgressDir(), taskId + '.json')`，`lstat` 必须 `isFile()`，然后 `unlink`。
- 轨道一：`path.join(resolveTaskProgressDir(session), taskId + '.jsonl')`，同上；`resolveTaskProgressDir` 返回 `null` 时**如实跳过**并在回告里写 `taskDirSkipped`（复用 `cleanup.ts` 的文案常量 `TASK_DIR_SKIPPED_TEXT`，`:111`[代码]）。
- 删除顺序：先两条轨道都试删，任一条失败就回告（记录文件删不掉不影响「文件删除」的结果，两者分别报告）。

### 4.5 与 ③ 的耦合 / 降级规则（captain 特别问的）

| ③ 的完成度 | ④ 的能力 |
|---|---|
| `outPath` 已记录（新任务） | 「删记录」+「删记录并删本地文件」（R1–R14 全量校验） |
| 老记录（无 `outPath`） | **只能删记录**；UI 上「同时删除本地文件」勾选框置灰并写明原因（R7） |
| 路径记录但 `size` 缺失 | 仍可删文件，但**必须**在确认框里写明「无法核对大小，只做类型与链接校验」`[推断：R6 降级为「跳过尺寸核对」]` |

### 4.6 「不做」清单（④）

- 不做任意路径删除、不做目录删除、不做递归删除、不做通配删除。
- 不做回收站/撤销（无可用服务，见 R14）。
- 不做「删空整个下载目录」。
- 不做跨任务批量删除（第一版只能逐条，最多在 UI 上串行调用多次 `op: delete`）。
- 不做「删掉后自动重下」这类连带动作。

---

## 5. ⑤ 「文件还在不在原文件夹」的判定

**判据（全部基于 §3 记录 + 一次 `lstat`）**：

| `fileState` | 判定 | UI 行为 |
|---|---|---|
| `unknown` | 记录里 `outPath` 为空（1.4.0 前的历史记录） | 只显示「删除记录」；提示「该记录未保存输出路径」 |
| `missing` | `lstat` 抛 `ENOENT` | 只有「删除记录」（**正是用户说的「如果移走便只有删除记录」**）；「在文件夹中显示」置灰 |
| `present` | `isFile()` 且（若记了尺寸）`size` 相等 | 「在文件夹中显示」可用；「删除记录并删除本地文件」可用（走 §4 校验） |
| `changed` | `isFile()` 但尺寸不等（或 mtime 明显不同） | 「在文件夹中显示」可用（文件确实在那儿），**删文件默认拒绝**（R6），只允许删记录；提示「文件与记录不一致（可能被替换/续传过）」 |
| `blocked` | 存在但不是普通文件（目录 / 符号链接） | 两个删文件动作都拒绝并说明原因（R5） |

**要不要一起记 `size`？要。** 理由：没有尺寸就无法区分「还是原来那个文件」与「同名但别的文件」，而这正是 §4 R6 与上表 `present`/`changed` 的判据。**不记 hash**（§3.3）。

**放在哪里算**：**不要**放进 `smartdl.status` 的 2 秒轮询里（面板每 2 秒拉一次、最多 50 条任务，每条一次 `lstat` 是没必要的磁盘噪声，且会污染状态接口的语义）。建议：

- `smartdl.status` 只多返回 `outPath` / `size`（纯字段透传，无 I/O）；
- 新增一次性的 `op: "inspect"`（或独立端点 `smartdl.inspect`）在**用户打开管理器面板时**、以及**每行操作后**调用，返回上面那张 `fileState` 表；面板打开期间可低频（例如 5–10 秒）刷新，不用 2 秒。

**实现锚点**：`TaskStatus` 接口在 `src/status.ts:27-56`，两个读取器在 `:197-204`（轨道一）与 `:227-239`（轨道二）[代码]。

---

## 6. 实施顺序（建议，含测试点）

> 本节按 §1.6 的「A 方案：侧边栏入口 → `main` 全局面板」写。**前置门槛**：先做 §2.6 的 10 分钟实验（`remote.session` 可用性），它决定按钮是 1 个还是 2 个。

| 步骤 | 内容 | 涉及文件 | 验收/测试点 |
|---|---|---|---|
| S0 | 实验：给 client 的 `inject` 加 `"remote.session"`，点一下 reveal | `src/client.js`（临时） | 拿到 `canOpenWorkspacePath()` 的真值；决定按钮形态 |
| S1 | ③ 数据模型：`outPath`/`size`/`fileMtimeMs` 可选字段 + 绝对路径解析 + `status` 透传 | `src/types.ts`、`src/progress.ts`、`src/index.ts`、`src/status.ts` | 老记录（无字段）解析结果与现状逐字段相同（照 `batch` 的回归测试写）；新记录字段齐全 |
| S2 | ⑤ `inspect`：`fileState` 五态 | `src/status.ts`（或新 `src/manage.ts`）+ `src/rpc.ts` | 五态各一条用例（含符号链接/目录/尺寸不符三个拒绝样例） |
| S3 | ④ `smartdl.manage` 的 `delete`：R1–R14 | `src/manage.ts`（新）、`src/rpc.ts` | 每条规则一条「必须拒绝」的用例 + 一条「正常删掉」的用例；`confirm` 缺失时只删记录 |
| S4 | ① 面板：侧边栏入口 + `main` 面板 + 列表/操作按钮/确认框/空态 | `src/client.js` | 注册形状断言（两个 slot、同 id）、开合断言（`selectPanel`/`selectPanel(null)`）、按钮禁用态断言 |
| S5 | 文档：README 的「下载管理器」小节（含 **Linux 不选中文件**、**无 outPath 只能删记录**、**删除不可逆** 三条限制）+ SECURITY.md 落 §3.5 拟稿 | `README.md`、`docs/SECURITY.md`、`CHANGELOG.md` | — |

**估工（粗）**：S1 ≈ 半天（含兼容测试）；S2+S3 ≈ 一天（规则多、测试多）；S4 ≈ 一天；S5 ≈ 1–2 小时。

---

## 7. 明确「不做」（本方案的负面清单）

1. **不用 OS 关联程序打开文件**（`openNativeAssociatedPath` / `openWorkspacePath` 的 `application` 参数 / `workspacePathApplications`）——captain 已拍板走文件管理器。
2. **不做「Open In…」那种应用选择器**（编辑器/Git GUI/终端列表）。
3. **不做回收站 / 撤销**；删除不可逆（§4 R14）。
4. **不做目录删除、递归删除、通配删除、批量清空**（§4 R10）。
5. **不引入任何新依赖、不放任何资源文件**（与 t28 同一条纪律：客户端插件以单个 `dist/client.js` 下发；图标内联画）。
6. **不改服务端状态查询的既有语义**：`smartdl.status` 仍是「读进度」，不做 I/O 重的存在性检查（§5）。
7. **不把 `name` 当路径用**（那是标签，`src/progress.ts:311`）。
8. **不为了「打开文件」而去请求额外权限或新增宿主服务**；能力不足时**如实降级**（只开目录 / 只删记录）。

---

## 8. 证据索引（本次调研读过的位置）

**DSH 实现（`C:\Users\Qing\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\`）**

| 主题 | 位置 |
|---|---|
| 侧边栏入口 slot 语义 | `dsh-client-ui-sidebar/README.zh.md:30-38`、`:44`、`:68-70` |
| 侧边栏渲染入口按钮 / 点击选中 | `dsh-client-ui-sidebar/lib/client.js:173-199` |
| 全局面板语义（`main` keyed slot、`selectPanel(id\|null)`） | `dsh-client-ui-layout/README.zh.md:32`、`:55`、`:68-70` |
| 参照实现（入口 + 面板 + 选中态） | `dsh-client-ui-plugin-manager/lib/client.js:3633-3635`、`:3656-3667`、`:3712-3754`、`:3755-3764`、`:3769-3775` |
| reveal / 打开路径的客户端调用形状 | `dsh-client-ui-open-in-app/lib/client.js:439-451`、`:459-471`、`:745-750`、`:762` |
| 能力位 `canOpenWorkspacePath` | `dsh-api-session-controller/lib/index.js:3009-3011`、`:2868` |
| reveal / open 的服务端分派 | `dsh-api-session-controller/lib/index.js:3031-3043` |
| 唯一的路径校验（**无工作区限制**） | `dsh-api-session-controller/lib/index.js:3062-3071` |
| fs 映射（任意绝对路径） | `dsh-fs-local/lib/index.js:780-794` |
| 沙箱只围「写」且 `extends LocalFileSystem` | `dsh-fs-sandbox/lib/index.js:87-90`、`:103` |
| 平台能力位 | `dsh-native-command/lib/index.js:205-211` |
| reveal 的三平台实现（含 Windows `/select,`） | `dsh-native-command/lib/index.js:247-288`、`:129-152` |
| 目录打开路由（**仅目录** + catalog id） | `dsh-host-open-in-app/lib/index.js:1132`、`:1353-1400` |
| 文件管理器 catalog 条目（`explorer`/`finder`/`filemanager`） | `dsh-host-open-in-app/lib/index.js:109-129` |
| 「系统自带文件管理器恒可解析」（`explorer`/`finder`） | `dsh-host-open-in-app/lib/index.js:101-107`（代码注释）、`:118-125`（条目本体） |
| 目录白名单 + open 路由的 wire 校验 + SSH 例外 | `dsh-host-open-in-app/README.zh.md:54`、`:82`、`:62` |
| 客户端用 fetch 调这些路由 | `dsh-client-ui-open-in-app/lib/client.js:12-16`、`:88` |
| 装载协议（白名单未读全） | `dsh-client-modules/lib/index.js:453-475` |

**本机部署事实（只读）**

| 事实 | 来源 |
|---|---|
| `DSH_HOME=C:\Users\Qing\.dsh-home`、`DSH_PROFILE=desktop` | 环境变量 `DSH_*` |
| `session-controller` 未覆盖 `nativeOpen` | `C:\Users\Qing\.dsh-home\profiles\desktop\cordis.yml:567-568` |
| `dsh-host-open-in-app` + `dsh-client-ui-open-in-app` 均已挂载 | 同文件 `:545-552` |
| 侧边栏/布局已挂载 | 同文件 `:643`、`:651-664` |
| `C:\WINDOWS\explorer.exe` 存在 | `Test-Path`（read-only） |

**本仓库（`work\dsh-smart-download\`）**

| 主题 | 位置 |
|---|---|
| 进度记录字段（两条轨道） | `src/types.ts:307-344`、`src/progress.ts:138-148` |
| 可选字段先例（`batch` 的写/读手法） | `src/progress.ts:266`、`:311`、`:319`；`src/status.ts:197-204`、`:227-239` |
| 输出路径已知处 | `src/index.ts:567`、`:571`；`src/downloader.ts:182`、`:360-361`；`src/url.ts:135` |
| 清理的删除纪律（④ 的先例） | `src/cleanup.ts:99-120`、`:191-220`、`:236-251`、`:285-305` |
| RPC 端点惯例 | `src/rpc.ts:24`、`:34`、`:199-200`、`:260` |
| 安全文档结构（拟稿落点） | `docs/SECURITY.md:163`、`:183`、`:213`、`:228` |

---

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-12 | 初稿：①–⑤ 结论 + ② 的工作区限制判定 + ④ 的规则表 + ⑤ 的判据；写入本文件（唯一新增）。 |

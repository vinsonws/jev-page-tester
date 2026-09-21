# Jev Page Tester

**Muse Spark 负责探索策略，OMP 负责主循环，官方 Jev 负责局部动作选择，Playwright 负责执行和留证。**

这是探索式页面健壮性测试器：尝试异常输入、重复提交、操作顺序和状态组合，寻找逻辑疑点、未捕获异常与崩溃信号。不是并发负载生成器，也不会把「模型完成任务」等同于「页面通过测试」。

## 新增：直接操作你已经打开的页面

`existing-tab` 模式通过 **Microsoft 官方 Playwright 浏览器扩展**，让你明确选择一个现有标签页。测试器保留该页的登录、弹窗和未提交输入，不重新导航、不新建页面、不调整窗口尺寸。你切换活动标签页也不会改变已绑定的操作目标。

停止时释放控制权，不关闭你的页面或 Chrome。这是类似 Codex Chrome 扩展的使用体验，不是 Codex 的内部实现或代码。

**[完整安装与使用说明](docs/existing-tab.md)** · [工具参数](docs/tools.md) · [架构](docs/architecture.md) · [AGENTS.md](AGENTS.md)

```text
Muse Spark / OMP
  └─ qa_open / qa_explore / qa_inspect / qa_replay / qa_close
       └─ 独立 Node Worker（本地 stdio RPC）
            ├─ DOM 观察 → 官方 Jev Choice → 有边界的页面动作
            ├─ 独立异常事件 / 声明式断言 / 操作记录 / 重放
            └─ 浏览器后端
                 ├─ launch-isolated：独立测试浏览器
                 ├─ cdp-isolated：CDP 连接上的独立 context
                 └─ existing-tab：官方扩展授权的已有页面
```

MCP 只在 Worker 内用于官方扩展连接，**不会给 Muse 增加一整套浏览器工具，也没有第二个主模型循环**。

## 1. 安装或升级

需要 Node.js **22.16+**。OMP 单独安装，继续使用你已有的 Muse Spark 配置。项目不会修改 OMP 的模型提供商，也不保存 Muse 密钥。

新安装：

```bash
git clone https://github.com/vinsonws/jev-page-tester.git
cd jev-page-tester
npm ci
npm run build
cp .env.example .env
```

已有仓库：先保存本地修改，再执行 `git pull --ff-only`、`npm ci`、`npm run build`。**不要覆盖已有 `.env` 或 `qa.config.json`。** 直接与传递依赖均由已提交的 lockfile 固定。

### 用当前浏览器

在平时使用的 Chrome profile 安装 [官方 Playwright Extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)（从官方说明中的商店链接进入）。打开测试站点并登录专用测试账号。

没有配置文件时可用：

```bash
cp qa.config.existing-tab.example.json qa.config.json
```

已有配置则合并下面字段，保留并核对原有白名单：

```json
{
  "browserMode": "existing-tab",
  "allowExistingTab": true,
  "allowedOrigins": ["http://localhost:3000"],
  "resourceOrigins": [],
  "extensionConnectTimeoutMs": 120000,
  "captureArtifacts": false,
  "allowRiskyActions": false
}
```

把示例 origin 改成真正的测试站点。API/CDN 可填入 `resourceOrigins`，但它们不会因此成为允许的页面导航目标。`localhost` 与 `127.0.0.1`、不同端口都是不同 origin。

本模式**不需要**远程调试启动参数、9222 端口、专用 Chrome profile、cookie 导出或另起 MCP 服务。不要把 Playwright MCP 工具额外注册给 OMP。`PLAYWRIGHT_MCP_EXTENSION_TOKEN` 自动批准被禁用，连接必须通过用户授权。

### 保留独立浏览器

`qa.config.example.json` 默认是 `launch-isolated`，需要额外安装：

```bash
npx playwright install chromium
```

三个模式的区别：

| mode | 页面/登录态 | 结束时 |
|---|---|---|
| launch-isolated | 新浏览器、新 context，可显式加载测试 storageState | 关闭测试器启动的浏览器 |
| cdp-isolated | 连接指定 CDP Chrome，但创建独立 context；不继承原 profile 登录 | 关闭自己创建的 context，断开连接 |
| existing-tab | 用户通过官方扩展授权的已有页面，沿用当前登录和 DOM | 只释放控制权，保留页面 |

旧的 `attach:true` 仍只表示 `cdp-isolated`，**不是登录态复用**；不要与 `mode` 同时传入。CDP 地址来自操作者的 `cdpEndpoint` 或 `QA_CDP_ENDPOINT`，不能由模型任意指定。

## 2. 官方 Jev 与网络

在本地 `.env` 填写：

```dotenv
TYPESAFE_API_KEY=你的官方TypeSafe密钥
JEV_MODEL=jev-1.13.0
```

`qa.config.json.model` 优先于环境变量。Jev 请求失败不会悄悄切换成演示脚本或其他模型。

官方 Jev 可单独设置 HTTP 代理，不需要 TUN：

```dotenv
QA_JEV_PROXY=http://127.0.0.1:1080
```

它只作用于官方 SDK 的传输，不改变 Muse/OMP 或浏览器网络。代理路径仍需在你的环境验证。

`launch-isolated` 可设置 `QA_BROWSER_EXECUTABLE` 指向系统 Chrome，并可设置 `browserProxy`。`QA_STORAGE_STATE` 可向独立 context 加载专用测试账号的 Playwright 状态文件。`existing-tab` 不应用这些启动/状态选项，沿用你已有浏览器的网络与登录，不导出凭据。

`minProbability=0.65` 只是未校准的工程初始值，不是官方推荐或安全保证。删除、付款、发送等名称默认过滤；这不是完整的业务权限系统。只有隔离的测试数据环境才应手动启用 `allowRiskyActions`。

## 3. 在 OMP 中使用

构建后从仓库根目录运行：

```bash
omp
```

也可以在其他目录显式加载：

```bash
omp -e /absolute/path/to/jev-page-tester/.omp/extensions/qa.js
```

在 `/model` 选择你已配置的 Muse Spark。项目配置和产物始终以本仓库为根。给 Muse 的示例要求：

> 阅读 AGENTS.md。使用 existing-tab 模式连接我授权的页面，预期站点是 http://localhost:3000。不要重新打开或刷新。先 qa_open 和 qa_inspect，确认当前状态，再分批探索空值、空格、取消后的残留与重复提交。只用测试数据，不要改应用代码。发现异常先留证，不要把 Jev 的 done 当作页面通过。

实际工具参数：

```json
{ "url": "http://localhost:3000", "mode": "existing-tab" }
```

`url` 在此模式只检查预期 origin，不执行导航。官方扩展出现授权/选择界面时，只共享**一个**目标标签页。连接后 `qa_explore` 才开始操作，`qa_inspect` 可以继续检查现场。

```text
qa_open → qa_inspect → qa_explore → 查看证据 → 下一局部目标 → qa_close
```

输入由 Muse 提供具体合成字符串，Jev 只选择现有候选；每批最多 8 个输入案例。`inputs` 是候选输入，不是必然逐条执行的脚本。

空闲时 `qa_close` 释放会话，进行中使用 OMP 取消操作或 `/qa-stop`。existing-tab 保留页面；独立模式关闭自己拥有的浏览器/context。授权阶段取消会重启 Worker，详见 [现有标签页说明](docs/existing-tab.md)。人工接管之前先停止，不要同时操作同一页面；释放控制不会撤销已经提交的数据。

## 4. 已有能力与自检

支持点击、填写、下拉选择、Escape、滚动、显式允许的刷新/返回、小批量连续点击。保留正常可交互检查，不默认 `force`，也不自动重试超时后的浏览器修改动作。

独立收集 pageerror、renderer crash 信号、console error、HTTP 4xx/5xx 和请求失败；主模型可提供 count/text/value 检查。所有检查都有明确来源，Jev 不负责判定自己是否通过。

```bash
npx playwright install chromium
npm run check
npm run demo -- --headless
```

`check` 包含类型、单元/IPC、浏览器回归和官方 MCP API 集成测试。**MCP 集成测试用公开 contextGetter 代替手动扩展授权界面，不代表用户桌面的完整链路已验证。**

`demo` 使用标记为 `scripted-test-double` 的决策器，故障夹具故意存在重复提交；预期输出 `status: anomaly`。在另一终端运行 `npm run fixture` 可在 `http://127.0.0.1:4173` 打开夹具，手动填写一半后试验 existing-tab；不要把夹具部署到公网。

显式使用有效密钥、产生真实 API 调用的演示：

```bash
npm run demo -- --headless --live
```

它只验证 Jev/执行器，不启动 Muse。初始版本的历史验证保留在 [docs/validation.md](docs/validation.md)，本次 existing-tab 验证见 [docs/validation-existing-tab.md](docs/validation-existing-tab.md)。

## 5. 记录与重放

每会话保存到已 gitignore 的 `runs/<UUID>/`：

```text
run.json           起始 URL、请求模型、时间
browser.json       浏览器模式、实际初始 URL、DOM 指纹
snapshot.json      最近一次脱敏 DOM 摘要
mission-*.json     局部目标、测试输入和预算
actions.json       实际操作、输入、结果和时序
checkpoints.json   已执行的声明式检查位置
events.jsonl       追加式事件与模型用量
report.json/md     最近执行结论
latest.png         captureArtifacts=true 时的页面截图
trace.zip          仅隔离模式显式开启后，关闭时完成
```

重放前实际恢复后端数据及 UI 前置状态，再确认 `resetConfirmed:true`。重放不调用模型，按原模式重新连接；existing-tab 需先释放源会话并重新授权，初始 DOM 指纹不一致会阻止执行，而不是新开浏览器绕过问题。

指纹不证明认证/服务端/全部隐藏状态等价；动态页面可能被保守拒绝。旧记录缺少 `browser.json` 时拒绝猜测，请重新记录。重放尽力保持动作时间，不保证复现同一竞态；同类事件再次出现也不天然证明同一缺陷。

## 隐私与限制

existing-tab 会以当前账号权限执行；只控制一个页面也可能通过共享存储、注销或后端修改影响其他页面。只用授权测试账号和合成数据。

页面摘要会发送到官方 Jev，工具结果及按需截图会进入 Muse 提供商。文本脱敏是尽力而为；截图/trace 无可靠自动脱敏。默认不记录 cookie、鉴权头或请求/响应正文。

隔离模式禁用 Service Worker，并有 context 级请求/额外页面处理。existing-tab 只增加选中页面的新请求过滤，不改变共享 context；不能完整观测/拦截已发生的请求、Service Worker 或已有 WebSocket。不要将其称为安全沙盒。existing-tab 不生成 context-wide trace。

当前为主文档 DOM 操作，不含 iframe/Shadow DOM/canvas/复杂拖拽/上传/多标签页流程/视觉回归，不自动重置业务数据或缩减复现路径。renderer crash 监听存在，不代表实际崩溃已被每轮测试验证。

只报告证据支持的异常与局部检查，不输出整个应用的 PASS。

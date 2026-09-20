# Jev Page Tester

**Muse Spark 负责探索策略，OMP 负责主循环，官方 Jev 负责局部动作选择，Playwright 负责执行和留证。**

这是探索式页面健壮性测试的初始实现：尝试异常输入、重复提交、操作顺序和状态组合，寻找逻辑疑点、未捕获异常与崩溃信号。它不是并发负载测试器，也不会把「模型完成任务」等同于「页面通过测试」。

```text
Muse Spark / OMP
  └─ qa_open / qa_explore / qa_inspect / qa_replay / qa_close
       └─ 独立 Node Worker（本地 stdio RPC）
            ├─ DOM 观察 → 官方 Jev Choice → 有边界的页面动作
            ├─ 独立异常事件 / 声明式断言
            └─ 操作记录 / 重放 / 本地报告
```

开发与测试代理先阅读 [AGENTS.md](AGENTS.md)。架构详见 [docs/architecture.md](docs/architecture.md)，工具参数见 [docs/tools.md](docs/tools.md)。

## 当前可以做什么

- 点击、填写、选择下拉项、Escape、滚动，以及显式允许的刷新/返回。
- 小批量连续点击：由代码执行，不在每次点击之间等待模型；仍保留 Playwright 正常可交互检查，不使用 `force`。
- 一个局部任务连续运行多步；遇到不确定、重复无进展、异常或预算上限，交回主模型。
- 捕获 `pageerror`、renderer crash、console error、HTTP 4xx/5xx 和请求失败，分别分类。
- 主模型提供 count/text/value 断言；Jev 选择 `done` 后由代码检查，不让 Jev 判断自身是否通过。
- 记录真实操作、输入、定位依据、调用时序；重放不调用模型，也不静默更换目标。
- 支持取消、每会话互斥、进程隔离、精确 origin 白名单、输入/输出限额与本地脱敏。
- 截图和 Playwright trace 默认关闭，显式启用后可留证；截图可按需返回主模型。

**初始验证不是全链路认证。** 已完成的测试及环境限制见 [docs/validation.md](docs/validation.md)。在线 Muse Spark → OMP → 官方 Jev 链路仍需使用你的账号验证。

## 1. 安装

需要 Node.js **22.16+**；OMP 单独安装，继续使用你已配置好的 Muse Spark。这个项目不会修改 OMP 的模型提供商或保存 Muse 的密钥。

```bash
git clone https://github.com/vinsonws/jev-page-tester.git
cd jev-page-tester
npm install
npx playwright install chromium
cp .env.example .env
cp qa.config.example.json qa.config.json
npm run build
```

Windows PowerShell 将两条 `cp` 替换为 `Copy-Item` 即可。不要用 `sudo` 启动测试器。

初始源码中的直接依赖已固定版本。创建环境无法访问 npm，未伪造 `package-lock.json`；首次联网安装后应审阅并提交生成的锁文件。

## 2. 配置官方 Jev 和测试范围

在本地 `.env` 填写：

```dotenv
TYPESAFE_API_KEY=你的官方TypeSafe密钥
JEV_MODEL=jev-1.13.0
```

官方 API 固定为 TypeSafe；不会在失败时切换到其他模型或演示脚本。`qa.config.json` 中的 `model` 优先于 `JEV_MODEL`。

按你的应用修改 `qa.config.json`，尤其是 **origin，包括协议和端口**：

```json
{
  "allowedOrigins": ["http://localhost:3000"],
  "resourceOrigins": ["http://localhost:8080"],
  "headless": false,
  "captureArtifacts": false,
  "allowRiskyActions": false,
  "blockedSelectors": ["[data-qa-private]"],
  "maxActionsPerMission": 30,
  "maxMissionMs": 120000,
  "maxSessionActions": 200,
  "maxBurstClicks": 3,
  "minProbability": 0.65,
  "model": "jev-1.13.0"
}
```

`allowedOrigins` 允许页面导航；`resourceOrigins` 只允许资源/API 请求，不能成为导航目标。没有通配符，模型也不能通过工具参数扩展白名单。不同端口、`localhost` 与 `127.0.0.1` 是不同 origin。

`minProbability=0.65` 是未校准的工程初始值，不是官方推荐，更不是安全保证。默认拒绝名称含删除、付款、发送等字样的操作；这只是启发式过滤，不能替代账号权限。要测删除流程，只在隔离测试数据环境中手动启用 `allowRiskyActions`。

### 代理与可见 Chrome

官方 Jev 的 HTTP 代理可单独配置，不需要本项目启用 TUN：

```dotenv
QA_JEV_PROXY=http://127.0.0.1:1080
```

这通过 SDK 的自定义传输和 Undici `ProxyAgent` 实现；不会改变 Muse/OMP 的连接或浏览器代理。需要浏览器代理时，在本地配置中单独设置 `browserProxy`。代理路径尚未在线验证。

使用系统 Chrome 而不是下载的 Chromium，可设置绝对路径：

```dotenv
# macOS
QA_BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# Windows 示例（取消下一行注释时，注释上面的 macOS 行）
# QA_BROWSER_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe
```

浏览器始终是测试器拥有的独立会话，不连接日常 Chrome profile。可在有界面窗口中人工登录专用测试账号；需要新会话加载已保存的登录态时，设置 `QA_STORAGE_STATE` 为 Playwright storageState 文件绝对路径。首版不提供登录态导出工具，人工登录动作不在重放记录中。

## 3. 在 OMP 中使用

从本仓库根目录启动 OMP：

```bash
omp
```

OMP 会发现 `.omp/extensions/qa.js`。在 `/model` 中选择你已经配置好的 Muse Spark。也可从其他工作目录显式加载：

```bash
omp -e /absolute/path/to/jev-page-tester/.omp/extensions/qa.js
```

先 `npm run build` 再加载扩展。配置和产物目录始终以本仓库为根，不是被测应用的代码目录。

给 Muse 的起始指令可以直接使用 [prompts/explore.md](prompts/explore.md)，例如：

> 使用 qa 工具测试 http://localhost:3000 的日程创建与编辑。先观察页面，再每次下发一个局部探索目标。关注空值、空格、长度边界、取消后状态残留和重复提交。只使用测试数据；不要修改应用代码；发现异常先保存并查看证据，再验证复现。不要把 Jev 的 done 当作页面通过。

工具出现后，完整流程是：

```text
qa_open → qa_inspect → qa_explore → 检查证据 → 新目标或 qa_replay → qa_close
```

`qa_explore.inputs` 是具体测试字符串，`field` 用标签匹配（`*` 表示所有可编辑控件）。Jev 只选择现有操作候选，不负责生成字符串。每批最多 8 个输入，复杂组合应由 Muse 分批下发。

取消当前工具调用会中止模型请求并关闭该会话浏览器；`/qa-stop` 停止整个测试 Worker。关闭或切换 OMP 会话也会清理 Worker。取消后重新 `qa_open`，不要假定旧浏览器还能继续。

## 4. 先跑不需要密钥的自检

```bash
npm run typecheck
npm test
npm run test:browser
npm run demo -- --headless
```

`demo` 使用**明确标记的脚本决策器，不是真 Jev，也不是 Muse**。它在本地故意有缺陷的页面填写标题、连续提交，再由独立断言检测重复记录。预期输出 `status: anomaly`，这证明测试夹具中的已知问题被捕获，而非应用健康。

要手动在 OMP 中探索这个页面，另开终端：

```bash
npm run fixture
```

页面监听 `http://127.0.0.1:4173`，与默认示例配置一致。不要把这个故障夹具部署到公网。

配置有效密钥后，显式运行官方 Jev 演示（会产生实际 API 调用）：

```bash
npm run demo -- --headless --live
```

该命令只测试 Jev 和执行器，不会启动 OMP/Muse；全链路仍应在 OMP 中运行。

## 5. 查看报告与重放

每个会话生成 `runs/<UUID>/`：

```text
run.json           初始 URL、时间和请求模型
snapshot.json      最近一次脱敏后的 DOM 摘要
mission-*.json     局部目标、输入和预算
actions.json       操作意图、执行结果、输入和时序
checkpoints.json   已执行的声明式断言位置
events.jsonl      追加的异常/策略/模型调用记录
report.json/md     最近一次执行结论（inspect 不覆盖结论）
latest.png         显式启用后生成
trace.zip          显式启用后，关闭会话时完成
```

所有运行产物、`.env` 和私有配置均已 gitignore。

重放前需要先恢复业务数据和前置条件，再给 `qa_replay` 设置 `resetConfirmed: true`。系统创建新浏览器，按记录重放并重新检查已保存的断言；不会自动重置后端数据，不会自动修复选择器。相同异常再次出现仍须核对证据，不能仅凭类别相同宣布复现成功。

可查看 trace：

```bash
npx playwright show-trace runs/<UUID>/trace.zip
```

## 隐私和边界

页面数据会发往官方 Jev，工具摘要以及按需截图会进入 Muse 的提供商。请自行确认所选 Muse 渠道的数据使用政策，只使用授权环境和合成测试数据。

截图/trace 不做可靠脱敏；trace 可能保存 DOM、网络详情等敏感信息。`captureArtifacts` 默认关闭。普通文本仅做尽力脱敏，不采集 cookie、鉴权 header 或响应 body；`[data-qa-private]` 及密码类控件不进入普通页面快照/候选集。可用 `QA_REDACT_ENV` 增补需要替换的已知秘密。

首版只处理主文档中的普通 DOM 控件：**不支持 iframe、Shadow DOM、canvas、文件上传、多标签页或视觉回归**。原生对话框自动取消并记录；额外标签页关闭；Service Worker 禁用。不能据此测试 PWA 离线能力。也未实现系统化覆盖图、自动缩减复现步骤、内存泄漏检测、故障注入或并发负载发生器。

OMP 扩展和本地 Worker 不是安全沙盒。其他 OMP 工具仍可能拥有文件/终端权限；AGENTS.md 的操作约束不等于权限隔离。真实防护依靠测试账号、应用权限与隔离环境。

## 上游接口依据

- [OMP 扩展接口](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [OMP 扩展加载规则](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [TypeSafe 官方 JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe SDK 源码](https://github.com/typesafe-ai/typesafe-sdk-js)
- [Playwright 页面 API](https://playwright.dev/docs/api/class-page)

本仓库未擅自选择开源许可证，`private: true` 也用于避免意外 npm 发布。

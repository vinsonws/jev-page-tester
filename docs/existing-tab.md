# 直接操作当前浏览器标签页

这个模式提供类似 Codex Chrome 扩展的使用体验：**你先打开并登录页面，明确授权这个标签页，测试器从它当前的状态继续操作。** 实现使用 Microsoft 官方 Playwright 扩展，不使用 Codex 代码，也不改变 Muse Spark / OMP / 官方 Jev 的分工。

## 1. 安装与配置

需要 Node.js 22.16+，正常打开的 Chrome，以及安装在该浏览器 profile 中的 [Playwright Extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)。从官方说明中的 Chrome Web Store 链接安装，不要安装同名不明来源扩展。

更新仓库后运行：

```bash
npm ci
npm run build
```

将以下字段**合并到现有 `qa.config.json`**，不要覆盖原有白名单：

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

`allowedOrigins` 改成实际测试站点的精确 origin；API/CDN 放 `resourceOrigins`。`localhost` 和 `127.0.0.1` 不同。没有配置文件时可复制根目录 `qa.config.existing-tab.example.json`，再改成自己的站点。

`.env` 保留你的 `TYPESAFE_API_KEY`。Muse 仍由 OMP 管理，不在这里保存 Muse 凭据。不需要 `--remote-debugging-port`、9222 端口、专用 profile、cookie 导出或单独 MCP 服务。不要将 Playwright MCP 工具额外注册给 Muse。

本模式要求手动授权，拒绝 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 自动批准。若环境有其他 MCP 的 CDP/隔离/初始化脚本设置，会明确报错，而不是悄悄换模式。多 Chrome profile 可按官方扩展说明配置 `PLAYWRIGHT_MCP_PROFILE_DIR_NAME`。

## 2. 使用

在浏览器进入测试页面，登录测试账号，打开要测试的弹窗或保留未提交的表单。从仓库根目录启动 `omp`，选择 Muse Spark：

```text
阅读 AGENTS.md。使用 existing-tab 接管我选择的现有标签页。
预期站点是 http://localhost:3000，不要重新导航或刷新。
先 qa_open 和 qa_inspect，再提出局部探索目标。
只使用测试数据；发现异常先留证，不要修正故意无效的输入。
```

OMP 工具参数：

```json
{ "url": "http://localhost:3000", "mode": "existing-tab" }
```

`url` 在此模式仅用于检查预期 origin，**不是导航指令**。官方扩展出现授权/标签页选择界面时，选择并共享**一个**页面。不同客户端可有自己的标签组；不要将其他敏感页面加入本测试客户端的组。

连接成功返回 `browserMode: existing-tab`、标题、URL 和当前控件。不会调用 `goto()`、`newPage()`、`newContext()`，不调整尺寸。随后使用 `qa_explore`、`qa_inspect`，不会因你切换活动标签页而换目标。页面关闭、授权断开或离开允许的 origin 后拒绝继续，不寻找替代页面。

## 3. 停止与人工接管

空闲时 `qa_close` 释放控制；运行中使用 OMP 取消操作，或 `/qa-stop` 停止 Worker。也可以通过官方扩展断开该客户端。测试器不关闭借用的页面/context/Chrome，不清空 cookie。

不要自动操作和手动操作同时进行。先停止，再人工修改，之后重新授权/观察。取消阻止后续指令，但不能撤销已发送的点击、请求或数据修改；已进入浏览器的指令不保证回滚。

局部动作或时间预算耗尽会释放借用页。正常 `done` 或异常留证后保留空闲连接，便于 `qa_inspect`；调查结束调用 `qa_close`。

**授权阶段取消/超时**：上游没有公开的待授权握手取消接口，生产 Worker 会主动退出，销毁未完成的 relay；OMP 主会话不会退出，下次工具调用重新启动 Worker。这也会关闭该 Worker 拥有的独立测试浏览器；用户页面保留。残留的授权 UI 不再代表有效请求，关闭后重新连接。

## 4. 记录与重放

每次运行保存 `browser.json`：模式、实际初始页面 URL、DOM 指纹，不保存认证凭据。

重放前先 `qa_close` 释放源会话；人工恢复原页面、输入、登录和后端数据，然后调用 `qa_replay({runId, resetConfirmed:true})`。再次授权一个页面，仍不自动导航；模式来自原运行记录，不得静默换成新浏览器。

初始 DOM 指纹不同就返回 `blocked` 且不执行任何重放动作。指纹只是保守的变化检查，不证明 cookie、后端、被截断文字或隐藏状态等价；动态页面可能被保守拒绝。旧版缺少 `browser.json` 的记录不猜测模式，请重新记录。实际时序尽力保留，不保证同一竞态结果。

## 5. 影响范围和限制

- 固定 Page，不主动操作/关闭其他标签页或弹窗；无 context 级路由、弹窗关闭器或 trace。
- 仅对该页连接后的新请求做可移除的 origin 过滤。已发生请求、Service Worker、现有 WebSocket 不保证完整观测/拦截，**不是安全沙盒**。
- 不禁用已有 Service Worker/扩展，不修改原浏览器代理。`headless`、`QA_BROWSER_EXECUTABLE`、`browserProxy`、`QA_STORAGE_STATE` 不改变借用页面；`QA_JEV_PROXY` 只影响 Jev API。
- `captureArtifacts=true` 可保存页面截图，不生成 context-wide `trace.zip`。MCP 临时诊断目录仅在本地，释放连接时删除，不返回模型。
- 浏览器使用登录态，不导出给模型。DOM/截图仍可能含个人数据，脱敏不是完整 DLP；用测试账号和合成数据。
- 同 profile 共享 cookie/存储/账号权限。即使只点一个页面，注销或数据修改仍可能影响其他页面。
- 单 Worker 最多一个 existing-tab 会话；当前仍是主文档 DOM 操作，iframe/canvas/复杂拖拽等不是新增能力。

## 6. 实现与验证

`src/existing-tab.ts` 使用固定 `@playwright/mcp@0.0.82` 的公开 `createConnection` 和 `browser.initPage`，经 MCP SDK 内存传输完成一次只读 `browser_tabs` list 请求，触发官方扩展授权，取得已有的 Playwright Page。之后仍由本项目的 BrowserDriver + 官方 Jev 决策执行，不允许模型提供任意脚本。

测试分三层：配置/协议边界；真实 Chromium 的借用生命周期；实际安装的官方 MCP + initPage + CDP Page 集成。最后一层用公开 `contextGetter` 代替人工授权 UI，**不能冒充已测试用户浏览器中的手动授权完整流程**。

```bash
npx playwright install chromium
npm run check
```

人工验收：已登录页保留未提交输入 → 授权单个页面 → 确认无刷新/登录保留 → Jev 局部操作 → 停止 → 页面可人工继续。另验证拒绝授权、撤销权限、多页误授权及重放初始状态不匹配。执行证据见 [validation-existing-tab.md](validation-existing-tab.md)；历史证据见 [validation.md](validation.md)。

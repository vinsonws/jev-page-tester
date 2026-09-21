# Architecture / 实现边界

## 分层与所有权

Muse Spark 是 OMP 主模型，不是本项目启动的另一个聊天客户端。`.omp/extensions/qa.js` 只注册五个 qa 工具、转发进度/取消、返回证据。WorkerBridge 用无 shell 的 Node 子进程和有边界的 JSON-lines stdio。

Worker 内的 MCP SDK 内存传输只连接 Microsoft 官方 Playwright 扩展；不开放额外外部 MCP 端口，不把原始浏览器工具注册给 Muse，也不加入第二个 Agent 循环。官方扩展自己的本地授权/relay 由固定的上游包管理。

每个会话同一时间一个操作，独立会话有配置上限。existing-tab 每 Worker 最多一个，包含正在授权的连接。每个任务最多 100 个宏动作、180 秒，默认更低；burst 的点击次数另有限制。

## 三种浏览器模式

| 模式 | 创建或取得的页面 | 生命周期 |
|---|---|---|
| launch-isolated | 启动浏览器、新 context、新 page | 关闭拥有的浏览器 |
| cdp-isolated | 连接外部 Chrome、新隔离 context/page | 关自己的 context，再断开 CDP |
| existing-tab | 官方扩展授权的已有 Page | 只清理自己的监听/路由和连接 |

旧 `attach:true` 映射 cdp-isolated，不继承原 profile 登录。新 `mode` 和旧 `attach` 不可同时传。缺省模式取操作者配置；existing-tab 无论从何入口都需本地 `allowExistingTab=true`。

`src/existing-tab.ts` 使用公开 `createConnection` + `browser.initPage`。唯一 MCP 调用是只读的 tab list，初始化钩子接收已有 Playwright Page；这不是页面内 eval。钩子是仓库固定代码，只在独立临时目录生成，每连接一个模块，不能从模型传入脚本。

exactly-one 页面检查通过后绑定该 Page，不重新选择活动页。`qa_open.url` 在 existing-tab 只验证 origin，不导航、不 resize、不导入或导出认证。用户可从半填表单开始。授权取消/超时以专用错误退休 Worker，避免上游未完成握手被晚到的批准重新激活。

## 页面与网络范围

操作权限由操作者配置，模型只能缩小预算，不能增加 origin、危险动作或截图权限。

隔离模式使用 context 级请求/WS 路由，Service Worker 禁用，额外页面/下载/对话框按既有策略处理。CDP 隔离模式与独立启动共用这些策略；两者都可显式加载测试 storageState。

existing-tab 只监控选中 Page，安装可移除的 page 级请求路由。不会在共享 context 安装全局拦截或 popup 关闭器，也不关闭用户创建的新页。当前页离开 allowedOrigins、关闭或连接撤销后失效，不自动重定向/换页。

该模式不干预现有 Service Worker、扩展、代理、已有 WebSocket 或其他标签页。已经发生的请求不可补录，拦截不构成完整网络沙盒。page 级路由也会影响该测试页的请求处理与缓存，调查相关问题时应考虑观测影响。

只点一个标签页不等于后端隔离：共享登录、存储和业务数据仍可影响其他页面。名称过滤不是授权机制。仅用测试账号和合成数据。

## 局部决策与执行

1. 主文档最多扫描 300 个节点、保留 60 个可操作非私密控件。
2. 提供有限文本/标签/角色/类型，真实 ElementHandle 只在本地保留。
3. 将 Muse 提供的合成输入构造成完整候选，限制数量。
4. 官方 SDK 调用 Jev，严格校验返回类型、候选与概率。
5. 不确定、找不到操作或重复无进展时交回主模型；阈值不是安全授权。
6. 核对快照与真实目标身份再执行，不重用旧 ID 点击替代节点。
7. 采集独立异常，done 不等于 PASS。

精确输入由上层提供。执行器支持用户级连续点击，不保证毫秒级实时性，也不默认 force。固定观察/执行代码之外，不接受任意 eval、shell 或浏览器连接地址。

Jev 使用官方 SDK，网络失败可重试一次，但浏览器修改动作不重试。模型故障与页面异常分开，没有静默脚本降级。每会话模型调用次数上限为动作上限两倍，另有时长/事件上限；无精确美元账单预算。事件记录实际模型版本、概率与 input tokens。

## 异常和检查

pageerror 与 renderer crash 分开。5xx 是待调查信号，不自动证明前端缺陷；4xx、console 与 requestfailed 也分别保留。默认 pageerror/crash/5xx/显式检查失败时交还主模型。

检查支持元素 count、唯一元素 text 包含、允许控件 value 精确匹配，由操作者/主模型提供预期。只有 stopped 后执行的检查才有检查结果；预算耗尽或 blocked 不能算通过。

返回 stopped / budget_exhausted / anomaly / blocked / cancelled / model_error / harness_error，整体 verdict 保持 not_evaluated。

## 留证和重放

动作前先写意图，结束后补结果和已收集时序；超时可能已有副作用，不隐式补偿。JSONL 追加事件，输入/选择器记录留本地。强杀可能失去动作完成信息。

browser.json 保存模式、实际初始 URL、初始 DOM 指纹。重放使用原模式，不调用模型，目标不唯一或身份漂移时停止。旧记录无模式元数据不猜测；时间间隔尽力重放，不保证相同竞态。

existing-tab 重放必须先释放原会话，人工恢复认证、UI 与后端，再重新授权页面。不自动 goto；指纹不等则零动作 blocked。匹配也不证明所有隐藏/后端状态等价。

截图需要 captureArtifacts。隔离模式可有 trace；existing-tab 禁止 context-wide trace，避免采集其他页面。截图无可靠自动脱敏。上游临时诊断仅本地使用，释放连接后删除。

## 取消与释放

AbortSignal 经 stdio 到 Worker；取消中止模型等待和后续操作。trace 失败不允许跳过所有权清理。

- 独立启动：关闭拥有的浏览器。
- CDP 隔离：关闭自己的 context，并调用 CDP Browser.close 释放 transport；不是终止外部 Chrome。
- existing-tab：卸载自己的监听/路由，断开连接；绝不关 borrowed page/context。

existing-tab 在软动作预算、时限或 harness_error 时也释放；正常 done/anomaly 可保留 idle 连接检查现场，之后 qa_close。取消不能撤销已经发到浏览器或服务器的动作，用户应停止后再人工修改，不提供同时控制的冲突解决。

/qa-stop 和 OMP 生命周期事件停止 Worker；父进程有硬截止和强制清理。待授权时取消会退休整个 Worker，同 Worker 独立浏览器也会关闭，但用户已有页保留。下次工具调用新建 Worker。

## 未实现的扩展

跨 frame/Shadow DOM/canvas、上传/多标签页流程、视觉回归、自动后台重置、覆盖图、路径缩减、完整 Service Worker/WS 观测，以及真实 renderer crash 测试，不属于本次功能。用户桌面的完整扩展授权 + Muse/OMP/在线 Jev 必须单独记录验证，不能用注入 contextGetter 的测试冒充。

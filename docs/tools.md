# OMP 工具契约

这些是本项目工具，不是 Jev 原生 API。Worker 再次校验所有参数，本地配置不能由模型覆写。OMP 只看到以下五个 qa 工具，没有原始 MCP browser_* 工具。

## qa_open

```json
{ "url": "http://localhost:3000", "mode": "existing-tab" }
```

mode 可为 launch-isolated / cdp-isolated / existing-tab，省略使用配置默认。兼容旧 `attach:true`=cdp-isolated；不能同时传 attach 和 mode。旧 attach 从未继承原 Chrome 的登录。

existing-tab 需要本地 allowExistingTab=true，并通过官方 Playwright 扩展授权一个已有页面。url 只验证预期 origin，不执行导航；不新建页面、不改变尺寸、不拷贝认证、不自动选择当前活动页。误授权不同 origin 或多个页面直接拒绝。

返回 sessionId、browserMode、现有页面摘要、事件和本地证据目录。一个 Worker 同时只允许一个借用会话。连接成功不代表测试通过。

## qa_explore

```json
{
  "sessionId": "UUID",
  "objective": "探索空标题和取消后的状态恢复，保留错误输入，不要自动修正",
  "inputs": [{ "field": "标题", "value": "" }, { "field": "标题", "value": "   " }],
  "maxActions": 20,
  "maxDurationMs": 120000,
  "burstClicks": 1,
  "allowReload": false,
  "stopOnAnomaly": true,
  "checks": []
}
```

field 用控件标签/定位描述匹配，`*` 匹配可编辑控件。每批最多 8 个合成输入，每个最多 8000 字符。inputs 是候选，不是固定脚本；Jev 决定是否/何时选择。需要精确重放用 qa_replay。

burstClicks 为连续 Playwright 用户级点击，不是 DOM 直接派发，禁用按钮会停止；不保证固定间隔。allowReload 默认 false，避免清除现场。

```json
{
  "checks": [
    { "kind": "count", "selector": "#records li", "expected": 1, "label": "只创建一条记录" },
    { "kind": "text", "selector": "[role=alert]", "expected": "不能为空", "label": "出现空值提示" },
    { "kind": "value", "selector": "#title", "expected": "", "label": "标题为空" }
  ]
}
```

每次最多 10 项，预期须有产品规则依据。text 是包含，不是正则或语义判断；value 精确相等；只有 count 的 expected 为数字。不要在一批里混合互斥场景。

| status | 含义 |
|---|---|
| stopped | 局部让出控制权，不是 PASS |
| anomaly | 信号或显式检查需要调查 |
| blocked | 决策、定位或前置条件不可靠 |
| budget_exhausted | 达到预算；借用页释放控制 |
| cancelled | 取消；借用页保留，独立资源关闭 |
| model_error | 官方 Jev 故障，无降级 |
| harness_error | 执行器/环境问题 |

existing-tab 任务前让操作者停止同页手动操作，人工接管需先取消/释放再修改。取消不是撤销已产生的业务副作用。

## qa_inspect

```json
{ "sessionId": "UUID", "screenshot": false }
```

读取最新 DOM/事件，不覆盖原执行结论。关闭会话仅返回缓存。screenshot:true 需 captureArtifacts:true，截图会传主模型，不保证可靠脱敏。existing-tab 不启动 context 级 trace。

## qa_replay

```json
{ "runId": "原运行UUID", "resetConfirmed": true }
```

实际恢复后端与 UI 前置条件后才确认。原记录的修改操作会重复。只读取本地 runs 中的 ID，不接受任意路径。返回新 sessionId/replayOf，不调用模型。

模式取源 browser.json；缺少元数据不静默猜测。existing-tab 要先 qa_close 源会话并人工恢复初始 UI，再通过扩展授权；不自动导航。DOM 指纹不匹配则零动作 blocked，结束重放后释放控制。指纹相同不证明认证/后端状态等价。

## qa_close / qa-stop

```json
{ "sessionId": "UUID" }
```

qa_close 关闭空闲 QA 会话：launch-isolated 关闭浏览器，cdp-isolated 关自己 context 再断开，existing-tab 只释放连接，保留页面和 cookie。活动任务先取消。

OMP `/qa-stop` 停止整个 Worker；需重新打开/授权，OMP 会话本身不退出。授权阶段取消/超时也会退休 Worker，销毁未完成 relay。不要继续批准旧授权界面。

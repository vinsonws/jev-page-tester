# OMP 工具契约

这些是本仓库自定义工具，不是 Jev 的原生 API。所有参数在 Worker 再次校验；本地配置不接受模型覆写。

## qa_open

```json
{ "url": "http://localhost:3000" }
```

返回 `sessionId`、页面摘要、最近事件和本地产物目录。打开独立浏览器；默认不采集截图。浏览器已打开不代表应用通过验证。

## qa_explore

```json
{
  "sessionId": "上一步返回的UUID",
  "objective": "测试新建弹窗空标题与关闭后的状态恢复。保留异常输入，不要自动纠正。",
  "inputs": [
    { "field": "标题", "value": "" },
    { "field": "标题", "value": "   " }
  ],
  "maxActions": 20,
  "maxDurationMs": 120000,
  "burstClicks": 1,
  "allowReload": false,
  "stopOnAnomaly": true,
  "checks": []
}
```

`field` 用控件标签/定位描述匹配，`*` 可用于所有可编辑控件。字符串必须是合成测试值，每个最多 8000 字符，每次最多 8 个案例。`inputs` 不等于固定脚本；Jev 按目标选择是否和何时执行。需要严格复现时使用 `qa_replay`。

`burstClicks` 默认为 1，不能超过操作者上限。它表示连续的 Playwright 用户级点击，不是直接派发 DOM click，也不保证固定毫秒间隔；按钮禁用时会停止。宏动作总数与点击次数分别有上限。

`allowReload` 默认 false，避免 Agent 无意间擦掉故障现场；恢复/刷新测试需要显式开启。

断言示例（应当有产品规则依据）：

```json
{
  "checks": [
    { "kind": "count", "selector": "#records li", "expected": 1, "label": "本次操作只创建一条记录" },
    { "kind": "text", "selector": "[role=alert]", "expected": "不能为空", "label": "空值得到明确提示" },
    { "kind": "value", "selector": "#title", "expected": "", "label": "取消后清空标题" }
  ]
}
```

每次最多 10 项。`text` 是包含关系，不是正则或模型语义评分；`value` 是精确相等；只有 `count` 的 expected 为数字。不要把互斥场景的预期混在同一个局部任务里。

返回状态：

| status | 含义 |
|---|---|
| stopped | 局部任务让出控制权，不等于 PASS |
| anomaly | 运行信号或明确断言需要调查 |
| blocked | 定位/决策不可靠，未静默修复 |
| budget_exhausted | 达到时间、动作、模型或事件预算 |
| cancelled | 调用者取消，浏览器关闭 |
| model_error | 官方 Jev 请求/响应问题，无降级 |
| harness_error | 执行器或环境异常 |

## qa_inspect

```json
{ "sessionId": "UUID", "screenshot": false }
```

返回最近 DOM 和事件，不覆盖已有执行结论。已关闭会话返回缓存证据，并明确不是实时快照。`screenshot:true` 需要本地 `captureArtifacts:true`；图片将进入主模型上下文，不会做可靠脱敏。

## qa_replay

```json
{ "runId": "原始会话的UUID", "resetConfirmed": true }
```

先实际恢复前置条件。原记录中的创建、编辑等操作会再次执行。运行 ID 只能定位本地 runs 目录中的记录，不能传任意文件路径。返回新的 `sessionId` 和 `replayOf`；重放没有模型调用。

## qa_close / qa-stop

```json
{ "sessionId": "UUID" }
```

`qa_close` 关闭空闲会话并完成 trace。进行中的任务先取消。OMP `/qa-stop` 停止整个 Worker，之后需要重新打开浏览器。

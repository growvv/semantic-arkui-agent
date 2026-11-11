# 状态读取与续存测试

日期：2026-11-11  
目的：确认语义快照中的 `state` 是应用当前状态，而不是源码里的静态注释；分别记录同一会话内和强制停止、重新启动后的状态。

## 方法

对每个应用执行同一组操作：

1. 启动应用，调用 `haptest semantic tree` 保存初始快照。
2. 用 `haptest semantic run` 完成一个会改变状态的任务。
3. 不重启应用，再次调用 `semantic tree`，确认下一次快照已经反映修改后的状态。
4. `aa force-stop` 后重新启动应用，再取一次快照，确认状态是否被应用持久化。

测试任务：

- 自建应用：收藏“整理季度材料”（北区门店），检查 `sem.task.favorite.t1.state.favorite`。
- STUFFS_NEXT：打开添加面板、输入“阅读”、滚动并添加卡片，检查 `sem.stuffs.cards.summary.state.value/extra`。
- Rental：切换到服务页，检查 `sem.rental.tab.*.state.selected`。

## 结果

| 应用 | 初始状态 | 任务后（同一会话） | 重启后 | 结论 |
|---|---|---|---|---|
| 自建应用 | `t1.favorite=false` | `t1.favorite=true` | `t1.favorite=false` | 会话内更新；内存 `@State`，重启回种子 |
| STUFFS_NEXT | `cards.summary.value=0` | `value=1, extra=阅读` | `value=1, extra=阅读` | 会话内更新；KVStore 持久化 |
| Rental | `tab.0.selected=true` | `tab.2.selected=true` | `tab.0.selected=true` | 会话内更新；`@State` tab index，重启回首页 |

三次任务运行都成功，步数分别为 2、5、2。状态测试使用单独运行，不计入验收报告的 13 项任务；模型和 token 数也不并入原统计。

## 说明

- 语义节点不是静态 JSON。`customProperty('sem', ...)` 在组件构建时读取当前 `@State`/数据；点击由应用自己的回调改状态；组件重渲染后，桥读取新的 `FrameNode` 属性。`snapshotRevision` 随内容变化推进，`prepare` 在动作前重新确认目标。
- Agent 不维护独立状态库，也不直接写应用状态；训练轨迹只记录动作与结果，权威状态在应用侧。评测读取 `SEM_EVAL`、桥快照或数据库，不读取 Agent 摘要。
- 评测脚本在任务前 reset 或清理应用数据，因此下一项任务从已知初始态开始，而不是继承上一项修改后的状态。这是可复现性要求；应用是否跨重启持久化，是应用自身的行为。
- Rental 的状态测试是在带底部标签 `onClick` 的验证版本上完成的。该 `onClick` 是相对上游 `Tabs.onChange` 的额外逻辑，合规性见验收报告“标注边界与当前实现复核”；这不影响本测试对“当前快照会反映当前 tab index”的结论。

## 证据

- `rental/before.json`、`rental/after.json`、`rental/restart.json`
- `self/before.json`、`self/after.json`、`self/restart.json`
- `stuffs/before.json`、`stuffs/after.json`、`stuffs/restart.json`

## 复现

```sh
HDC=/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
SERIAL=$("$HDC" list targets | head -1)

# 启动应用后取初始快照
node bin/haptest semantic tree --serial "$SERIAL" \
  --bundle org.anapp.research.prototype --out evaluation/state-persistence/self/before.json

# 执行会改变状态的任务
node bin/haptest semantic run --serial "$SERIAL" \
  --bundle org.anapp.research.prototype \
  --task "收藏“整理季度材料”，项目是北区门店" \
  --out /tmp/state-self-run

# 同一会话
node bin/haptest semantic tree --serial "$SERIAL" \
  --bundle org.anapp.research.prototype --out evaluation/state-persistence/self/after.json

# 强制停止并重启
"$HDC" shell aa force-stop org.anapp.research.prototype
"$HDC" shell aa start -a EntryAbility -b org.anapp.research.prototype
node bin/haptest semantic tree --serial "$SERIAL" \
  --bundle org.anapp.research.prototype --out evaluation/state-persistence/self/restart.json
```

命令中的设备序列号来自 `hdc list targets`；测试时需要替换为当前设备。

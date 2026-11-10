# 基于 HapTest 的 ArkUI 语义标注与纯文本 Agent 设计

日期：2026-11-11  
底座：HapTest 本地 `main`，HEAD `bb3325e`，Apache-2.0  
目标分支：`feat/semantic-arkui-agent`（git worktree）  
验收时间：2026-11-11 上午

## 1. 意图

验证一条完整的应用侧语义通路：开发者在 ArkTS 源码中为常见 UI 组件声明身份、含义、状态和可执行操作；应用在运行时通过 `customProperty` 保存结构化语义，由 debug-only 的本机桥把当前挂载组件的语义、边界和状态整理成 JSON；宿主用纯文本模型读取这棵语义树并选择动作；动作仍通过 HapTest 的普通原生 UI 输入执行；任务结果由独立状态日志和截图核验。

这条通路要回答的不是“模型能不能看懂像素”，而是“应用能不能在开发阶段把 UI 的含义写清楚，并在运行时以低 token、可定位、可验证的形式交给 Agent”。验收以三个应用上的端到端任务完成为准，不以单点演示或人工标注截图代替。

## 2. 目标与非目标

目标：

1. 定义一套 ArkTS 语义标注约定：用类型化的 `SemanticSpec` 通过 `.customProperty('sem', ...)` 附着在组件上，同时保留稳定 `id` 和辅助 `accessibilityText`/`accessibilityDescription`。
2. 实现面向常见 ArkUI 组件的 AST 识别与 LLM 语义提案工具，生成可审查的源码 diff，并通过编译和运行时检查。
3. 在应用内实现 debug-only 的 `SemanticBridge`：通过公开的 `FrameNode.getCustomProperty`、`getChild`、`getParent`、`getInspectorInfo` 遍历当前挂载组件，在 `127.0.0.1` 上提供 JSON-lines 快照；宿主通过 `hdc fport` 读取。
4. 扩展 HapTest 宿主侧：增加语义桥客户端、精简语义树、按 `id` 解析和动作执行、轨迹记录；原有 `HarmonyDevice`、CLI 和观察约束保持可用。
5. 在自建 ArkTS 应用和两个开源鸿蒙应用上验证，输出源码标注、运行时树、截图、轨迹和验收报告。
6. 在 HapTest 上留下独立 commits，保持原有设备 API、CLI 和测试路径可用。

非目标：

- Android 适配、鸿蒙以外的平台、自定义绘制组件的通用识别。
- 覆盖三个应用的全部页面和全部控件；只覆盖任务相关页面与常见组件。
- 生产级权限、隐私和发布隔离；本阶段只做研究原型，语义桥只进 debug 构建。
- 统计显著的效能实验；每个任务运行一次，属于通路验收，不构成论文级对照实验。
- 通过应用私有业务接口、数据库写入或测试专用回调替 Agent 完成任务。

反目标：

- 语义树只是原生无障碍树的改名，没有业务含义。
- 标注只存在于文档或构建产物，运行时读不到。
- Agent 依赖截图坐标或手工硬编码的页面路径。
- 只在自建应用上成立，换一个应用就失效。

## 3. 约束与已确认事实

- 设备：JUY-AL50，OpenHarmony 7.0.0.111 / API 26，1080 × 2406。
- `uitest dumpLayout` 已能返回 `id`、`key`、`text`（应用写入的 `accessibilityText`）、`description`（应用写入的 `accessibilityDescription`）、`accessibilityId`、`type`、`checked`、`selected`、`enabled`、`clickable`、`longClickable`、`scrollable`、`visible`、`bounds`。HapTest 的实时控件树和动作路径直接使用这组字段。
- ArkUI 公开 API：`CommonMethod.customProperty(name: string, value: Optional<Object>)`；`FrameNode.getCustomProperty(name: string): Object | undefined`；`FrameNode.getChild`、`getChildrenCount`、`getParent`、`getInspectorInfo`；`UIContext.getFrameNodeById`；`UIContext.runScopedTask`。`customProperty` 接受普通对象，OpenHarmony 的 Inspector JSON 也会序列化它。
- 应用内 `TCPSocketServer` 可在 `127.0.0.1` 监听；宿主通过 `hdc fport tcp:<local> tcp:<device>` 连接。语义桥只读，不执行动作。
- SDK：DevEco Studio SDK 26.0.0.105，hvigor 6.26.9，ohpm 26.0.0.630；SDK 自带补丁版 TypeScript 4.9.5，支持 `ScriptKind.ETS`，可解析 `.ets` 的 UI DSL。
- 模型：本机 magpie `http://127.0.0.1:3425/v1`，模型 `auto/gpt-6-luna`，OpenAI 兼容接口；本次只发送文本，不发送截图。
- 签名：复用现有 prototype debug profile（bundle `org.anapp.research.prototype`，有效期至 2027-10）。三个验证应用顺序安装，不并行驻留。
- 底座：HapTest 已有 `HarmonyDevice`、`observe`、`tap`、`swipe`、`typeText`、`pressKey`、`launchApp`、JSON-lines 会话、观察 ID 和动作前观察约束；这些能力直接复用。
- 时间：一个通宵窗口；开源应用构建按 45 分钟限时，失败则换候选并如实记录。

## 4. 方案选择

### 4.1 运行时语义通道

考虑过三种方式：

1. 只用 `accessibilityText`/`accessibilityDescription`，由 `uitest dumpLayout` 读取。
2. 用 `customProperty` 存结构化对象，由应用内 debug-only 桥遍历 `FrameNode` 读取。
3. 用 ArkUI Inspector 的 `hdc fport ark:pid@bundle` 读取组件树和 `customProperty`。

选择第 2 种。第 1 种实现最少，但语义只能是一串文本，难以承载角色、实体、动作集合、状态字段和约束。第 3 种依赖 Inspector 通道；在当前 prototype 上 socket 能打开但没有树消息，设备上也没有对应的 `ark` unix socket，不能作为今晚的验收基础。第 2 种使用公开的 `FrameNode` API 和本机 TCP，所有读取都在应用内完成，宿主只通过 `hdc fport` 拿 JSON；语义是结构化对象，动作仍走 HapTest 的原生输入。代价是每个应用要接一个很小的 debug-only 桥文件，并且桥只覆盖 debug 构建。

`accessibilityText`/`accessibilityDescription` 仍然保留，作为辅助读屏、人工审查和桥不可用时的降级面；它们不作为主语义来源。

### 4.2 底座

用户已选定 HapTest。它提供类型化的设备 API、观察与动作之间的失效约束、选择器歧义处理、会话和真机 E2E，是本项目最适合的底座。hmdriver2 更偏底层驱动，缺少现成的观察/动作不变量；jev-mobile 没有 license；mobilerun 不支持 HarmonyOS，移植成本过高。

### 4.3 标注方式

AST 规则负责定位组件、修饰符链、参数、上下文数据绑定和源码位置；LLM 负责在源码语境中提出语义、状态表达式和动作说明；确定性 codemod 负责写入。LLM 不直接改文件，避免不可审查的批量修改。只对高置信度、常见组件应用；自定义绘制组件、语义不明的容器跳过并记录。

## 5. 系统设计

### 5.1 语义声明

对任务相关的常见组件增加三个部分：

```typescript
Button(task.completed ? '重新打开' : '标记完成')
  .id(`sem.task.complete.${task.id}`)
  .accessibilityText(`任务：${task.title}；状态：${task.completed ? '已完成' : '进行中'}`)
  .accessibilityDescription('点击切换任务的完成状态')
  .customProperty('sem', Sem.safe(() => Sem.node({
    schema: 1,
    id: `sem.task.complete.${task.id}`,
    role: 'action',
    meaning: `切换任务完成状态：${task.title}`,
    entityKind: 'task',
    entityKey: `${task.id}`,
    state: { completed: task.completed, priority: task.priority },
    actions: [{ name: 'toggle_completion', input: 'tap', label: '切换完成状态' }],
    risk: 'changes_data'
  }), Sem.fallback('sem.task.complete')))
```

`SemanticSpec` 字段：

| 字段 | 含义 |
|---|---|
| `schema` | 语义 schema 版本，首版为 1 |
| `id` | 稳定语义身份，页面内唯一；与组件 `.id()` 一致 |
| `role` | `action`、`input`、`toggle`、`list`、`list_item`、`content`、`group` 等 |
| `meaning` | 面向 Agent 的一句话含义，包含实体和当前状态 |
| `entityKind` / `entityKey` | 组件代表的业务实体类别与实体键 |
| `state` | 影响理解和操作的当前状态，扁平键值 |
| `actions` | 声明的 UI 动作：`tap`、`long_press`、`scroll`、`set_text`，附方向和标签 |
| `constraints` | 输入格式、可用条件等文字约束 |
| `risk` | `read_only`、`changes_data`、`destructive` |

约定：

- `id` 必须稳定且页面内唯一；列表项使用实体 ID 或稳定业务键，不使用随机数。`id` 同时是 HapTest 动作解析的键。
- `meaning` 包含可见标签、实体和状态；不能只写“收藏”而让 Agent 不知道收藏的是哪一项。
- 敏感字段只写“已填写/未填写”，不写具体值；密码、验证码、令牌不进入语义对象。
- 不把业务回调、数据库主键、评测用的目标 ID 写入语义对象。
- 组件类型、可点击/可长按/可滚动/可输入和实时边界由 HapTest 的运行时树提供；`customProperty` 的 `state` 提供业务状态，两者在宿主侧按 `id` 合并。
- 动态表达式用 `Sem.safe` 包裹；求值失败时返回最小占位，不让语义声明拖垮渲染。

标注形式：ArkUI 没有对任意组件调用点生效的通用装饰器。首版使用类型化 helper `Sem.node({...})` 加 `.customProperty('sem', ...)`；AST 工具也可以读取组件上方的 `// @semantic {...}` 注释，把它展开成同样的修饰符。两者最终都落到 `customProperty`，不引入第二套运行时协议。

### 5.2 标注工具

流程：

1. 用 SDK 补丁版 TypeScript 以 `ScriptKind.ETS` 解析 `.ets`，收集组件调用、修饰符链、参数、所在页面/组件、邻近注释，以及参数中标识符的声明和类型。
2. 用组件词典识别常见 ArkUI 组件：`Button`、`Text`、`Image`、`SymbolGlyph`、`TextInput`、`TextArea`、`Search`、`List`、`ListItem`、`Toggle`、`Checkbox`、`Radio`、`Slider`、`Tabs`、`TabContent`、`Swiper`、`Grid`、`GridItem`、`Scroll`、`Row`、`Column`、`Flex`、`Stack` 等。词典外的自定义组件跳过。
3. 将候选按文件或页面分批送给 `auto/gpt-6-luna`，要求返回结构化提案：是否标注、`role`、`id_template`、`meaning_template`、`entity_kind`、`entity_key_template`、`state` 表达式、`actions`、`risk`、置信度、理由。提示词只含源码语境，不含截图。
4. 确定性 codemod 写入 `.id(...)`、`.accessibilityText(...)`、`.accessibilityDescription(...)` 和 `.customProperty('sem', Sem.safe(...))`。`id_template` 与 `meaning_template` 中的 `${...}` 转成 ArkTS 模板字符串；`state` 的值转成表达式。已有 `sem` 标注时跳过，保持幂等。
5. 确保应用里有 `Sem.ets`；按文件位置插入相对 import；在任务页根容器补 `.id('sem.root')`，供桥定位遍历起点。
6. 重新解析修改后的文件；构建目标应用；构建失败则回滚该文件的修改并记录错误。
7. 安装并启动应用，用桥快照检查标注节点、`id`、`meaning`、`state`、`actions` 是否出现；记录覆盖率。

输出：

- `annotation-report.json`：候选、提案、应用/跳过、置信度、构建结果、运行时命中情况。
- 源码 diff，按文件审查。
- 关键页面的标注截图（边界框 + 语义标签）。

首版只覆盖任务相关页面中的常见组件；报告中明确实际覆盖的文件、页面和组件类型。

### 5.3 应用侧语义桥

每个验证应用增加两个小文件：

- `semantics/Sem.ets`：`SemanticSpec`、`SemanticAction` 类型，`Sem.node`、`Sem.safe`、`Sem.fallback`。
- `semantics/SemanticBridge.ets`：debug-only 的本机 TCP 服务。

桥的工作方式：

1. `SemanticBridge.start(uiContext)` 由 `EntryAbility` 在页面加载后调用；重复调用直接返回。release 构建不启动，也不应把桥打进发布包。
2. 用 `socket.constructTCPSocketServerInstance()` 监听 `127.0.0.1:18765`；应用在 `module.json5` 申请 `ohos.permission.INTERNET`。
3. 收到 `{"id":1,"op":"snapshot"}` 时，在 `uiContext.runScopedTask(...)` 里从 `uiContext.getFrameNodeById('sem.root')` 开始遍历：
   - `node.getCustomProperty('sem')` 读取结构化 spec；
   - `node.getId()`、`node.getNodeType()`、`node.isVisible()`、`node.getInspectorInfo()` 读取身份、类型、可见性和边界；
   - `node.getChildrenCount()` / `node.getChild(i)` 遍历子节点，默认不强制展开懒加载列表；
   - 有 `sem` spec 的节点进入结果，记录最近的语义祖先 `parentRef`；纯布局节点只作为遍历路径。
4. 返回 JSON-lines：

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "bundleName": "org.anapp.research.prototype",
  "pagePath": "pages/Index",
  "viewport": { "width": 1080, "height": 2406 },
  "nodes": [
    {
      "ref": "sem.task.complete.1",
      "id": "sem.task.complete.1",
      "type": "Button",
      "role": "action",
      "meaning": "切换任务完成状态：整理季度材料",
      "entityKind": "task",
      "entityKey": "1",
      "state": { "completed": false, "priority": "普通" },
      "actions": [{ "name": "toggle_completion", "input": "tap", "label": "切换完成状态" }],
      "risk": "changes_data",
      "bounds": [442, 658, 683, 778],
      "parentRef": "sem.task.list"
    }
  ]
}
```

5. 支持 `{"op":"ping"}` 与 `{"op":"prepare","ref":"..."}`。`prepare` 重新取快照并确认目标仍存在、可见；不存在时返回 `STALE_REFERENCE`。桥不提供点击、输入、业务回调或数据库写入。

边界：桥只进 debug 构建；只监听 loopback；只读；快照是当前已挂载节点的投影，不承诺离屏列表项或未挂载弹层。

### 5.4 HapTest 宿主侧

新增 `src/semantic/`：

- `types.ts`：`SemanticSpec`、`SemanticNode`、`SemanticSnapshot`、动作请求/结果。
- `bridge_client.ts`：分配本机端口，调用 HapTest `Hdc.fport` 把本地端口转发到设备 `18765`，用 Node `net` 连接，发送 JSON-lines 请求并解析响应；关闭时移除转发。
- `project.ts`：把桥快照整理成 Agent 输入的紧凑树/行格式；按 `id` 与 HapTest 实时树的节点合并，补上 `clickable`、`enabled`、`bounds` 等运行时事实；生成 `ref` 到 `id`、`bounds` 的映射。
- `agent.ts`：模型循环、动作校验、HapTest 执行、轨迹记录。
- `cli.ts` 或扩展现有 CLI：`haptest semantic tree`、`haptest semantic run`。

宿主动作路径：

1. Agent 从桥快照选择 `ref`（等于语义 `id`）。
2. 宿主调用桥 `prepare(ref)`，确认目标仍在当前快照中且可见。
3. 宿主调用 HapTest `observe()`，再用 `device.find({ id: ref })` 确认实时控件存在；若不存在或不可见，拒绝动作并让模型重新观察。
4. 按动作类型执行：
   - `tap`：`device.tap({ selector: { id: ref } })`；由 HapTest 解析实时边界并注入原生点击。
   - `set_text`：先 `tap` 聚焦，再 `device.typeText(text)`；HapTest 的敏感字段检查和唯一焦点约束继续生效。
   - `scroll`：在节点边界内 `device.swipe`；方向由声明给出，边界由 HapTest 实时树给出。
   - `long_press`：在 `HarmonyDevice` 上补充 `longPress`，边界和观察校验同上；首版可不启用。
5. 动作后重新取桥快照和 HapTest 观察；旧的 `ref`、`revision`、`observationId` 全部失效。

`Component` 仍可选地保留 `description`/`accessibilityId`，用于降级观察和人工核对；主语义来自桥，不依赖 `uitest` 是否返回 `customProperty`。

### 5.5 纯文本 Agent

输入：

- 任务文本。
- 当前桥快照整理出的语义树（节点 `ref`、`role`、`meaning`、`entity`、`state`、`actions`、`parentRef`，必要的运行时 `enabled`/`clickable`/`bounds`）。
- 最近若干步动作及结果。
- 停止条件（最大步数、重复状态、动作失败）。

输出：单步 JSON 动作：

```json
{"action":"tap","ref":"sem.task.complete.1"}
{"action":"long_press","ref":"sem.task.row.1"}
{"action":"scroll","ref":"sem.task.list","direction":"forward"}
{"action":"input","ref":"sem.task.search","text":"..."}
{"action":"press","key":"BACK"}
{"action":"launch","bundle":"..."}
{"action":"finish","summary":"..."}
```

宿主动作前校验：

- `ref` 存在于最新桥快照；`revision` 未过期。
- 桥声明了该动作；HapTest 实时节点存在、可见、启用，且动作对应的原生能力可用。
- 坐标在屏幕和节点边界内；滚动在可滚动容器内。
- 输入框非敏感字段；当前有且仅有一个确认焦点后调用 `typeText`。
- 任一校验失败都不执行，返回可读错误并让模型重新观察。

模型调用：magpie OpenAI 兼容接口，`auto/gpt-6-luna`，温度 0，JSON schema 输出，记录 prompt/completion token 和每步耗时。首版每个任务一次运行；不做统计显著性声明。

### 5.6 验证应用与任务

| 应用 | 来源 | 规模/许可 | 任务 |
|---|---|---|---|
| SemanticTasks | 本次自建 ArkTS 应用 | 新建，ArkUI 常见组件 | 8 项：收藏、完成、搜索、筛选、修改截止日期、调整优先级、切换设置、核对状态 |
| OHOTP | `OHOTP/ohtotptoken` | 约 1.9 万行 ArkTS，MIT | 4 项：添加令牌、搜索、切换隐藏码、修改设置 |
| 第三应用 | 在 `STUFFS_NEXT`、`Rental`、`Jingmo` 中按构建结果选定 | MIT / 中等规模 | 3–4 项，按实际页面设计 |

自建应用负责覆盖完整组件类型和独立 oracle：目标状态变化写入仅 evaluator 可见的 `EVAL_STATE` hilog，宿主读取日志判分，Agent 不接触该通道。开源应用以桥快照状态 + 前后截图为主；能加入目标 handler 调试日志的，补日志并注明。

每个任务有独立的初始状态、复位步骤和期望终态。每个任务运行一次，记录成功、步数、观察次数、prompt/completion token、耗时和失败原因。

### 5.7 证据与报告

- 每个应用一份 `annotation-report.json` 和源码 diff。
- 关键组件的标注前后代码片段：星标、图标按钮、列表行、输入框、开关。
- 桥快照 JSON 和可读渲染；节点数、token 估算。
- 标注截图：在真实截图上叠加边界框和语义标签。
- Agent 轨迹 JSONL 和任务前后截图。
- 中文验收报告：目标、方法、架构、标注示例、运行时通路、三个应用的任务结果、证据、限制、复现命令、commit 列表。

## 6. 验收标准

1. HapTest 在改造后 `npm run build` 通过，原有单元测试全绿。
2. 标注工具能在三个应用上运行，产出可审查 diff，应用能构建。
3. 应用启动后，debug 桥能返回当前页的语义快照；任务相关页面上的 `customProperty('sem')` 节点带有正确的 `id`、`meaning`、`state`、`actions` 和边界。
4. 纯文本 Agent 在每个应用上完成至少 3 项任务（若某应用可执行任务少于 3 项，按实际任务数验收并说明），全程不发送截图、不读取原生无障碍树。
5. 动作通过 HapTest 的普通原生 UI 输入执行，不调用应用业务接口或测试回调；桥只读。
6. 报告包含源码标注、桥快照、运行时树、截图、轨迹、指标和限制，并明确桥只进 debug 构建。
7. 改动位于 `feat/semantic-arkui-agent` 分支的独立 commits；HapTest 原工作区和上游行为不受影响。

## 7. 风险与回退

- 开源应用构建失败：每个应用限时 45 分钟；依次尝试 `STUFFS_NEXT`、`Rental`、`Jingmo`；仍失败则用第二个自建应用替代，并在报告中记录替代原因。
- 桥的线程/生命周期问题：`snapshot` 必须在 `UIContext.runScopedTask` 内遍历；桥由 `EntryAbility` 在页面加载后启动；页面切换、弹层和键盘出现时以新快照为准。若桥在某个 API 版本上不可用，降级为 `uitest` 可读的 `id` + `accessibilityText`/`accessibilityDescription` 投影，并在报告中说明降级路径。
- `FrameNode.getCustomProperty` 在目标构建上不可用：先在自建应用做最小探针；若不可用，改用 `getInspectorInfo()` 的 `customProperty` 字段或 `getFilteredInspectorTree(['isLayoutInspector'])`；仍不可用则走上面的降级投影。
- 标注质量不足：只应用高置信度提案；编译和运行时双重检查；人工审查 diff；跳过自定义组件和歧义容器。
- 中文输入不可用：尽早在真机验证 `typeText`；若只支持 ASCII，任务改用数字/英文输入，并在报告中记录实际限制。
- 签名/bundle 不匹配：复用 prototype debug profile，三个应用顺序安装；必要时统一 bundle 名或重新生成 debug profile。
- 时间不足：优先完成自建应用的端到端通路，再完成第一个开源应用，最后第二个；报告只写实际完成的内容。

## 8. 实施顺序

1. 从 HapTest `main` 创建 worktree 和 `feat/semantic-arkui-agent` 分支；跑通 `npm run build`、`npm test -- --run`、真机 E2E。
2. 在自建应用写 `Sem.ets` 和 `SemanticBridge.ets`，用最小 `customProperty` 节点验证 `FrameNode` 读取、`runScopedTask`、TCP 监听和 `hdc fport` 链路。
3. 扩展 HapTest：桥客户端、语义树整理、按 `id` 的动作执行、CLI 和单元测试。
4. 自建 SemanticTasks 应用：定义任务页、标注约定和 8 项任务；构建、安装、验证桥快照。
5. 实现 AST 候选提取、LLM 提案、codemod、构建和运行时检查；先在自建应用上跑通，再跑开源应用。
6. 实现 Agent 循环；在自建应用上完成任务，修复动作校验和提示词。
7. 构建并标注两个开源应用，加入桥文件和根 id，运行任务，采集证据。
8. 生成标注截图、桥快照、轨迹和验收报告；提交 commits，做最终构建和测试。

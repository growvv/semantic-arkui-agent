# 语义化 ArkUI Agent

在 ArkUI 源码中声明界面语义，让纯文本模型通过 HapTest 直接操作 HarmonyOS 应用。模型不接收截图，也不接收原始无障碍树全文；动作由原生 UI 框架执行。

- 项目页：<https://growvv.github.io/semantic-arkui-agent/>
- 验收报告：[docs/acceptance/2026-11-11-semantic-arkui-agent-acceptance.md](docs/acceptance/2026-11-11-semantic-arkui-agent-acceptance.md)
- 底座：[HapTest](https://github.com/SMAT-Lab/HapTest)，Apache-2.0

## 结果

| 应用 | 类型 | 任务 | 独立验证 | Agent 自行结束 | prompt tokens | completion tokens |
|---|---|---:|---:|---:|---:|---:|
| Tasks | 自建 ArkTS 应用 | 8 | 8/8 | 8/8 | 131,335 | 564 |
| STUFFS_NEXT | 开源应用，MIT | 4 | 4/4 | 3/4 | 63,195 | 495 |
| Rental | 开源应用，MIT | 1 | 1/1 | 1/1 | 8,529 | 50 |
| 合计 |  | 13 | 13/13 | 12/13 | 203,059 | 1,109 |

13 项任务共 35 步，平均 2.69 步；模型输入中的截图数量为 0。Tasks 的判分来自应用自己写入的 `SEM_EVAL` 日志；STUFFS_NEXT 和 Rental 使用应用侧桥快照与截图。Agent 的自述不作为验收依据。

## 机制

1. **源码声明。** 组件在普通 ArkUI 属性之外声明 `SemanticSpec`：稳定 `id`、`role`、`meaning`、实体、状态、可用动作和风险。`id` 同时是宿主合并实时控件的键；`accessibilityText` 与 `accessibilityDescription` 保留给读屏和降级。
2. **运行时桥。** debug 构建的应用进程内启动一个只读 TCP 服务，遍历当前挂载的 `FrameNode`，用 `getCustomProperty('sem')` 读取声明，用 `getNodeType`、`isVisible`、`getChild` 补充运行时事实。快照按 JSON-lines 返回；`prepare` 在动作前确认目标仍然存在。
3. **宿主投影。** HapTest 把语义快照和实时控件树按 `id` 合并，保留唯一命中的 live facts；执行前检查目标数量、可见、启用、声明动作与原生能力。输入框包在自定义组件里时，允许 `__Common__` 包装节点，由 HapTest 的唯一焦点检查兜底。
4. **文本决策。** 模型每步只返回一个 JSON 动作，只使用当前视图里的 ref，不接收坐标、截图或原始树全文。动作后重新观察；同一 revision 的同一动作被重复保护。动作始终走 HapTest 的 `tap`、`swipe`、`typeText`、`pressKey`，不经过语义桥。

更完整的机制图、逐任务轨迹和结果图表见项目页。

## 任务轨迹

- **Tasks / 收藏**：2 步。模型看到 `sem.task.favorite.t1` 的 `state.favorite=false` 和 `toggle_favorite/tap`，点击后用 `SEM_EVAL t1.favorite=true` 验证。
- **STUFFS_NEXT / 添加卡片**：6 步。打开添加面板、在自定义组件输入框中输入“阅读”、滚动 `WaterFlow`、点击添加。第一次滚动因坐标观察过期被宿主拒绝，重新观察后成功。
- **Rental / 切换标签**：2 步。点击 `sem.rental.tab.2`，服务页渲染，`selected=true`。

关键轨迹在 `evaluation/evidence/*-trajectory.jsonl`。

## 仓库结构

```
src/semantic/                   桥客户端、投影、动作校验、模型客户端、Agent、CLI
src/device/                     HapTest 观察与输入路径；按 bundle 过滤应用窗口
examples/semantic-tasks-app/    自建 ArkTS 应用、语义桥与组件标注
tools/annotator/                AST + LLM 标注原型
tools/annotation-audit/         标注合规审计：只允许隐藏属性
evaluation/                     任务、评测脚本、证据、标注扫描与提案
docs/                           设计、实现计划、验收报告
site/                           项目页，GitHub Pages 源目录
```

## 标注边界与审计

标注只允许增加隐藏信息：`.id`、`.accessibilityText`、`.accessibilityDescription`、`.customProperty('sem', ...)`。不得新增事件处理、布局修饰符、渲染文本或应用状态。

`tools/annotation-audit/` 把这条边界变成可执行检查：解析上游源码与标注后源码，逐文件比对修饰符、文本、状态与文件增删。

```sh
npm run audit:selftest
node tools/annotation-audit/cli.js --baseline <upstream-ets-dir> --annotated <annotated-ets-dir>
```

对真实上游基线的审计结果：Rental（82 个源文件）与 STUFFS_NEXT（5 个源文件）均 0 findings，改动文件各 2 个，新增文件各 2 个且都在 `semantics/` 下。报告在 `evaluation/annotations/*/audit.json`。

## 快速开始

环境：HarmonyOS / OpenHarmony 设备（验收设备为 API 26，1080 × 2406）、DevEco Studio 与 `hdc`、Node.js 20 及以上。SDK 与签名材料不随仓库分发。

构建与单测：

```sh
NODE_ENV=development npm install --include=dev
npm run build
npm test -- --run
```

构建自建应用：

```sh
cd examples/semantic-tasks-app
# 在 DevEco Studio 中生成自己的调试签名，替换 build-profile.json5 中的占位符。
/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw assembleHap --mode module -p product=default
hdc install entry/build/default/outputs/default/entry-default-signed.hap
```

运行语义树和 Agent：

```sh
node bin/haptest semantic tree --serial <device-serial> --out /tmp/semantic.json
node bin/haptest semantic run \
  --serial <device-serial> \
  --bundle org.anapp.research.prototype \
  --task "收藏“整理季度材料”，项目是北区门店" \
  --out /tmp/semantic-run
```

模型客户端默认连接本机 `http://127.0.0.1:3425/v1`，默认模型为 `auto/gpt-6-luna`。可通过 `MAGPIE_BASE_URL`、`MAGPIE_API_KEY`、`SEMANTIC_MODEL` 覆盖；仓库不包含任何密钥。

复现自建应用的评测：

```sh
python3 evaluation/run_self_eval.py --serial <device-serial>
```

评测脚本会重置应用、采集前后截图、运行 Agent，并读取 `SEM_EVAL` 后独立判分。任务定义中的 `<device-serial>` 需要在运行时替换或通过 `--serial` 传入。

## 第三方应用

STUFFS_NEXT 与 Rental 的完整源码不随本仓库分发。验收使用本地上游源码树，上游链接、验证基线、许可与接入点见 [THIRD-PARTY.md](THIRD-PARTY.md)。两个应用的截图与桥快照在 `evaluation/evidence/` 中；验收报告记录了具体任务和限制。

## 限制

1. Rental 只完成了本地底部标签切换；首页房源依赖远端接口，搜索、预订等业务流没有验证。
2. 语义桥只在 debug 构建中启用；release 包的隔离、签名发布和桥代码裁剪没有验证。
3. STUFFS_NEXT 的验证使用应用侧桥快照和截图，没有独立数据库 oracle；自建应用的 `SEM_EVAL` 判分强度更高。
4. 语义覆盖是局部的；自定义组件、设置面板剩余控件和卡片列表行没有全部标注；带尾随子组件块的容器需要人工确认。
5. STUFFS_NEXT 的毛玻璃任务在目标值已达到后多点了一次，被重复动作保护停止；状态验证通过，但 Agent 没有自行 finish。
6. 每个任务只运行一次，没有多种子、重复运行或对照条件；结果不构成统计显著的效能结论。
7. 模型摘要可能与实际动作不一致；动作和状态变化以轨迹、快照和日志为准。

## 许可与来源

- HapTest 以 Apache-2.0 许可发布，见 [LICENSE](LICENSE)。
- STUFFS_NEXT 与 Rental 为 MIT 许可的第三方应用；本仓库只保留上游链接、验证基线与截图证据。
- 项目页的版式参考了 [AppAgent](https://appagent-official.github.io/)、[Mobile-Agent](https://x-plug.github.io/MobileAgent/) 和 [PhoneCLI](https://github.com/HKUDS/PhoneCLI) 的项目主页结构；页面内容与图表来自本项目的验收证据。

## 仓库说明

公开仓库是本地 `feat/semantic-arkui-agent` 分支的清理快照：签名材料、设备序列号和本机路径已移除，示例应用的 `build-profile.json5` 使用占位符。完整开发分支的提交信息记录在 `evaluation/evidence/haptest-commits.txt`。

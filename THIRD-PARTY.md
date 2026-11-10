# 第三方来源

本仓库基于 HapTest 开发，并在验收中使用两个 MIT 许可的开源应用。第三方应用的完整源码不随本仓库分发；下方保留上游链接、验证基线和接入点，便于复核证据或复现实验。

## HapTest

- 上游：<https://github.com/SMAT-Lab/HapTest>
- 许可：Apache-2.0
- 本仓库基线：`bb3325e`
- 本仓库开发分支：`feat/semantic-arkui-agent`
- 关系：本仓库在 HapTest 上增加 `src/semantic/`、应用侧语义桥示例、标注工具和评测证据；HapTest 原有功能与许可保持不变。

## STUFFS_NEXT

- 上游：<https://github.com/awaLiny2333/STUFFS_NEXT>
- 许可：MIT
- 验证基线：`e35b7584aba160d9cae22509c0dae8184b5b5d86`
- 接入点：
  - 在添加/设置按钮、设置面板的毛玻璃 `Slider`、添加面板的名称/描述输入框、添加按钮和主页 `WaterFlow` 上增加 `customProperty('sem', ...)`；
  - 增加隐藏的 `sem.stuffs.cards.summary` 节点，暴露卡片数量和名称列表；
  - 在根 `RelativeContainer` 上设置 `sem.root`；
  - 在 `EntryAbility` 中启动语义桥，并申请 `ohos.permission.INTERNET`。
- 验收任务：打开设置、调大毛玻璃半径、打开添加面板、输入“阅读”并添加卡片。证据见 `evaluation/evidence/stuffs-*`。

## Rental

- 上游：<https://github.com/yongoe1024/Rental>
- 许可：MIT
- 验证基线：`8c6eb31b4d04411b1247b762e33b806b1c61e675`
- 接入点：
  - 在 `Tabs` 上设置 `sem.root`；
  - 给底部标签栏的五个 `Column` 增加 `id`、`customProperty` 和 `onClick`，用 `selected` 状态暴露当前标签；
  - 在 `EntryAbility` 中启动语义桥。
- 验收任务：切换到服务页。证据见 `evaluation/evidence/rental-*`。

## 页面版式参考

项目页的结构参考了以下研究项目主页，内容、代码和图表均为本项目所有：

- AppAgent：<https://appagent-official.github.io/>
- Mobile-Agent：<https://x-plug.github.io/MobileAgent/>
- PhoneCLI：<https://github.com/HKUDS/PhoneCLI>

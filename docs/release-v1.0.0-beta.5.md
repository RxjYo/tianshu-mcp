# v1.0.0-beta.5 — Agent 回复正文取回（lastReply）

> **面向接入方（MCP 调用方）的版本更新说明** · 2026-11-04
> 上一版本 `v1.0.0-beta.4`（2026-11-03）以来的全部功能增量；除此之外仅下载统计数据刷新，与本版接入无关。

**本版无破坏性变更，零新增入参。** 升级后所有既有调用逐字不变；新能力全部是 meta 块上的**可选新增字段**，旧的调用方忽略即可。

---

## 一、新增：zcode 任务完成时取回 Agent 的回复正文 `lastReply`

此前 MCP 对 zcode 会话只能拿到状态信号（`progressSummary: "ZCode 已完成回复"`、`endReason`、
验收报告等），**拿不到回复文本**——正文此前仅用于计算稳定性哈希。`v1.0.0-beta.5` 起，
zcode 任务在 `reply_stable`（回复稳定）判定完成时捕捉该正文并随任务暴露。

### 接入方怎么用（无需任何新参数）

任务完成后照常 `query_task`（或 `wait_task` 到停点直接返回），meta 块新增两字段：

```json
"lastReply": "已完成 typecheck 检查，修复了 src/App.vue 第 21 行的空引用问题，…",
"lastReplyFile": "D:/ai/tianshu-mcp/.tianshu/tasks/tsk_xxx/last-reply-0.md"
```

- 两者一同出现/一同省略；`lastReply` 是完整正文的**纯文本**，可直接交给 LLM 后续消费。
- `lastReplyFile` 是逐字落盘的正文文件（绝对路径），内容与 `lastReply` 相同，便于人工复核。
- 一任务多轮时（自动验收 / `manage_task(action="rework")` / `continue`）字段值是**最近一次完成回复**，文件随轮次递增（`last-reply-<round>.md`）。

`query_task` / `wait_task` 的 meta 块均携带（共用同一 metaFromTask管线）；`query_info(type="report")` 仍是验收报告，不含回复正文。

## 二、字段语义与边界（接入前必读）

| 语义 | 说明 |
|---|---|
| 仅 zcode 产出 | kimicode / minimax / codex / opendesign 不带出这两个字段（roadmap，见文末）；调用方按 agentId 区分 |
| 仅成功完成轮产出 | 任务从未有过完成回复时**两字段一同省略**；有过则保留最近一次完成轮的值（后续轮失败/等人不会清除，`lastReplyFile` 指向当轮文件） |
| 防串轮 | rework / continue 轮以「发送时界面已有正文」为基线：本轮若没有产生任何新回复，上一轮正文**不会被误标**为本轮回复（字段不更新） |
| 截断 | 正文超过 50,000 字符时截断保存，结尾附标记 `…（回复超长已截断，完整内容见界面对话）` |
| 纯文本 | 正文取自界面渲染后的 `textContent`：代码块围栏、粗体等 markdown 排版**不会保留**（格式保真是后续版本工作） |
| 不进事件流 | `lastReply` 不写入 `task.jsonl` 事件流，仅随 meta 块暴露（`docs/event-stream.md` 已同步说明） |

## 三、兼容性与升级

- **工具入参/签名：零变化**（run_task / query_task / manage_task / verify_task / query_info / wait_task 全部不变）。
- **任务协议：零破坏**——meta 新字段均为 optional；解析 meta 块的接入方无需迁移。
- **升级方式**：更新 `tianshu-mcp` 依赖到 `1.0.0-beta.5` 并重启 MCP 会话即可；无需改任何调用代码，也无需追加审批配置。

## 四、验证状态

| 门 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | 0 error |
| `npm run lint`（--max-warnings 0） | 0 warning |
| `npm test` 全量 | **1554 passed / 12 skipped**；1 个失败为测试环境「Windows 符号链接权限」（`project-dir-guard` 的 `fs.symlinkSync` EPERM，stash 对照证实为既有环境问题），与本特性无关 |
| 特性覆盖 | zcode round 0 成功路径 + resume（continue/rework）路径断言 `result.lastReply`；防串轮判据含**变异验证**的判别性测试（置空基线后判据用例准确失败）；编排层 / meta 快照 / 落盘文件三重断言 |

## 五、后续 roadmap

1. **markdown 保真**：从界面 DOM 直转 markdown（保留代码块/列表/链接），正文质量再上一档。
2. **覆盖其余 GUI agent**（kimicode / minimax / codex 同模式接入，字段语义不变）。
3. **完整会话记录**（方案 B）：读各 agent 自有会话存储——codex 已有本地 JSONL，zcode 需先做存储摸底。

---

对应 CHANGELOG：[CHANGELOG.md](../CHANGELOG.md)（中文）/ [CHANGELOG.en.md](../CHANGELOG.en.md)（英文）`## [1.0.0-beta.5]` 条目。

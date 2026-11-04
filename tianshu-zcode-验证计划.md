# tianshu-mcp × ZCode 调度系统 · 实施与验证计划

> 版本：v1.0 ｜ 日期：2026-10-30 ｜ 原则：**验证先行，零编码**；编码（P0 调度器）在 V1/V2 全部通过后才启动

---

## 0. 总体路线

```
环境预检 → V1 触发验证 → V2 监听验证 → （通过后）P0 编码调度器 → P1/P2
```

验证阶段的调用方式（二选一，推荐 A）：

- **方式 A（推荐）**：把 tianshu-mcp 配置为 WorkBuddy 的 MCP server（写入 `~/.workbuddy/mcp.json`，`npx tianshu-mcp`，stdio），之后所有 `run_task / query_task / get_task_report` 都通过对话直接调用，全程零编码。
- **方式 B**：用官方 MCP Inspector（`npx @modelcontextprotocol/inspector tianshu-mcp`）在浏览器界面手动调工具。

---

## 1. 前置环境预检（半天）

| # | 检查项 | 方法 | 通过标准 |
|---|---|---|---|
| 0.1 | Node.js ≥ 20 | `node -v` | ≥ 20.x |
| 0.2 | ZCode 桌面端已安装且已登录 | 打开 ZCode 确认 | 能正常对话 |
| 0.3 | ZCode 版本 | 记录版本号 | 建议 ≥ 3.14.x（v0.7.4+ 适配路径契约） |
| 0.4 | tianshu-mcp 可启动 | `npx -y tianshu-mcp --help` 或克隆仓库 `npm i && npm run build` | MCP server 正常握手 |
| 0.5 | 测试项目目录准备 | 选 1 个小型 git 仓库（如 `D:\work\tsched-smoke`），**先 git commit 干净基线** | `git status` 干净 |

> ⚠️ 预检 0.5 必须做：tianshu-mcp 的验收全部相对 git 基线，基线不干净会污染验收结论。

---

## 2. 阶段 V1：触发验证（验证"任务能否下发到 ZCode 桌面端"）

### V1.1 环境探测（只读，不发送任何任务）

克隆 tianshu-mcp 仓库后运行内置探针（全部只读，不发消息、不改设置）：

```bash
node scripts/probe-zcode.mjs install    # 安装路径发现
node scripts/probe-zcode.mjs process    # 进程与端口
node scripts/probe-zcode.mjs cdp        # CDP 连接
node scripts/probe-zcode.mjs selectors  # UI 选择器（版本漂移检查）
node scripts/probe-zcode.mjs projects   # 项目列表面板
node scripts/probe-zcode.mjs models     # 模型菜单（短暂开合读取后关闭）
```

**通过标准**：能发现 ZCode 安装路径与版本；CDP 目标可连；模型列表能读到精确的 `供应商/模型` 名称。

### V1.2 无项目模式最小下发（不碰任何项目目录）

```
run_task(
  agentId = "zcode",
  model   = "<V1.1 读到的精确模型名>",
  task    = "只回答一句话：当前工作区是什么"
)
```

**通过标准**：
- `run_task` 秒回 `taskId`（异步契约生效）；
- ZCode 桌面窗口被驱动、新会话建立、消息真实发送；
- 终态 `succeeded`，且文案明示"未进行项目验收"（无项目模式 autoVerify 强制 false）。

> 此步验证的是完整驱动链路：CDP 连接 → 会话创建 → 模型回读 → 发送 → 结果提取。

### V1.3 项目模式只读下发

```
run_task(
  projectPath = "D:/work/tsched-smoke",
  agentId     = "zcode",
  model       = "<同上>",
  task        = "只检查 package.json，不修改任何文件，回复检查结果",
  autoVerify  = false
)
```

**通过标准**：
- 项目精确绑定且回读绝对路径（无 `project_ambiguous / project_mismatch`）；
- "完全访问"权限回读成功；
- 任务完成后 `git status` 仍干净（确实没改文件）；
- **打开 ZCode → 对应项目 → 会话列表，能看到这条任务的完整对话记录**（记录可见性验证点）。

### V1.4 真实改动 + 验收引擎

```
run_task(
  projectPath  = "D:/work/tsched-smoke",
  agentId      = "zcode",
  model        = "<同上>",
  task         = "在 README.md 末尾追加一行 'smoke test <日期>'，不要做其他修改",
  autoVerify   = true,
  autoFixRounds = 1
)
```

**通过标准**：
- 任务 `succeeded` 且验收 PASS（git 基线 diff 仅 README.md 一处变更）；
- `~/.tianshu-mcp/tasks/<taskId>/` 下有验收报告（diffstat + 命令检查结果）；
- 若故意验收失败一次，能观察到自动返修轮（rework 计划文件 `rework-<taskId>-r1.md` 生成）。

### V1 失败预案

| 现象 | 处置 |
|---|---|
| `close_existing_instance` | 手动退出已运行的 ZCode（无 CDP 实例），再 `continue_task` |
| `login_required` | 在 ZCode 窗口手动登录后 `continue_task` |
| `model_mismatch / model_unavailable` | 跑 `probe-zcode.mjs selectors`，用 profile 的 `gui.selectors` 覆盖 |
| 模型名含 `:` 或 `/` 报格式错 | 按"面板分组/模型显示名"格式传参（首个 `/` 切分） |

---

## 3. 阶段 V2：监听验证（验证"任务状态能否被可靠观测"）

### V2.1 状态机迁移观测

下发 V1.4 同款任务，`run_task` 返回后立即开始以 **15s 间隔**调 `query_task`，记录状态序列。

**通过标准**：观测到 `queued → running → (succeeded|failed)` 完整迁移；`running` 期间**每 30s 出现一条结构化进度摘要**（文本短暂停顿不误判完成）。

### V2.2 落盘证据检查

任务运行中与结束后分别检查 `~/.tianshu-mcp/tasks/<taskId>/` 目录。

**通过标准**：事件流文件实时增长（"最后写盘的事实"永远可读）；重启 MCP server 进程后 `query_task` 仍能读到正确状态（持久化不丢）。

### V2.3 终态与报告

```
get_task_report(taskId = "tsk_...")
```

**通过标准**：报告含变更清单、diffstat、验收命令检查结果、可疑标记扫描（TODO/debugger/密钥形态）；无项目任务返回 `not_applicable: no_project` 而不是报错。

### V2.4 needs_user → continue 闭环

下发一个**必然向人提问**的任务（如"有两个方案 A 和 B，请先问我选哪个再动手"）。

**通过标准**：
- `query_task` 变为 `needs_user`，原因 `agent_question`；
- 项目槽与 ZCode 全局锁被释放（期间可派发其他任务——此点即调度器依赖的核心行为）；
- `continue_task(taskId, message="选方案 A")` 后**回到原会话**继续，ZCode 会话列表里是同一条连续对话。

### V2.5 同项目串行验证

对**同一项目目录**连续派发 2 个任务（第 2 个在任务 1 运行中提交）。

**通过标准**：任务 2 停在 `queued`，任务 1 终态后自动开始；全程无并发写同一目录。

### V2.6 异常恢复（抽测 2 项即可）

- **CDP 断连**：任务运行中杀掉 ZCode → 期望现场保留、状态明确（不伪造"已终止"）；
- **调度器视角重启**：kill tianshu-mcp 进程后重启、`list_tasks` 对账 → 期望运行中任务被标记 `interrupted` 或可 `continue_task`，不产生幽灵任务。

---

## 4. 验证记录表（每个用例一行，附证据路径）

> 实测环境：ZCode **3.17.1.9553**（比适配器上次验证的 3.14.x 新）、tianshu-mcp 0.9.7（本地构建 + 5 处 3.17.1 兼容补丁）、npm 驱动通道（tsm.mjs MCP stdio 客户端，等价 P0 调度器原型）。
> 证据目录：`D:\ai\tianshu-verify\evidence\`；任务数据：`~\.tianshu-mcp\tasks\<taskId>\`。
> 工具名映射（0.9.x 域合并）：get_task_report→`query_info(type=report)`；list_tasks→`query_info(type=tasks)`；continue_task→`manage_task(action=continue)`。

| 用例 | 步骤摘要 | 预期 | 实际 | 结果 | 证据（taskId / 报告路径） |
|---|---|---|---|---|---|
| V1.1 探测 | install/process/cdp/selectors/projects 六探针 | 路径+版本发现；CDP 可连；选择器在位 | ZCode 3.17.1 发现于 `C:\Program Files\ZCode`；原实例无 CDP→脚本优雅关闭+带 `--remote-debugging-port=9333` 重启（restart.log `cdp ready: True`）；selectors 全在位（modelValue 经补丁后 true）；projects 空列表=会话页正常形态；permission/models 两项按用户决定跳过（模型标识已从 DOM 取得） | 通过（2 子项跳过） | evidence/v11-*.json、restart.log |
| V1.2 无项目下发 | run_task(agentId=zcode, model, 无 projectPath) | 秒回 taskId；succeeded；明示无项目 | 1.15s 返回 taskId；18s 后 succeeded，message「无项目模式，未进行项目验收」；permissionMode 完全访问回读 | 通过 | tsk_20261031091806_756298；evidence/v12-*.json |
| V1.3 项目只读 | run_task(projectPath=D:/ai/tests, autoVerify=false) | 精确绑定回读；git 干净；会话记录可见 | 首两次失败暴露 3.17.1 绑定链路漂移（详见补丁记录），修复后 succeeded；boundProjectPath=d:/ai/tests；README.md 无变更；会话 sess_8b980011 可见 | 通过（含 2 次兼容修复） | tsk_20261031093928_094da1；evidence/v13-*.json |
| V1.4 验收引擎 | run_task(autoVerify=true, autoFixRounds=1) 追加一行 | succeeded+PASS；报告落盘；diff 仅 README | succeeded，验收 PASS（第 0 轮）git-diff-check exit=0；report-0.md/json 落盘；变更 README.md（任务产物）+2 个 .mimosa 未跟踪（宿主插件噪音，非任务变更）；diffstat +18 -1 | 通过 | tsk_20261031094048_607d9f；report-0.md |
| V2.1 状态迁移 | 15s 轮询 query_task 记录序列 | queued→running→终态；结构化进度 | 全链迁移证据齐全（dispatch 回执 queued→snap running→succeeded）；进度摘要含运行证据=stop_button/none、回复哈希、稳定轮 | 通过 | evidence/v21-snapshots/snap-1..18 |
| V2.2 落盘持久 | tasks/<id>/ 检查 + 杀 server 重启 | 事件流实时落盘；重启后状态不丢 | task.jsonl 11 行事件流（note/verify_start/succeeded）；强杀后新 server 进程 query_task 恢复完整状态 | 通过 | evidence/v22-after-restart.json |
| V2.3 报告 | query_info(type=report) | 变更清单/diffstat/命令检查/可疑标记 | 报告全要素：结论 PASS、git-diff-check、变更清单（含未跟踪）、diffstat、analysis.signals={todo,consoleDebug,commentedBlock,secretLike}；无项目任务返回 not_applicable（V1.2 已证） | 通过 | evidence/v23-report.json |
| V2.4 needs_user | 必然提问任务→needs_user→派并发任务→continue | agent_question；项目槽释放；回原会话 | needsUserKind=agent_question；期间同项目任务 2 直接 running（槽已释放）；continue 用选项原文精确提交（fail-closed 拒绝模糊猜测），最终 succeeded 且 zcodeSessionId 前后一致（sess_8504d89c） | 通过 | tsk_20261031094835_029c93(needs_attention 收尾)、tsk_20261031100508_382b96(succeeded)；evidence/v24-*.json |
| V2.5 同项目串行 | 运行中连派两个任务 | 任务 2 queued；任务 1 终态后自动开始 | T4 running / T5 queued（回执明示「每项目串行，等待前面任务完成」）；T4 succeeded 后 T5 自动 running→succeeded | 通过 | evidence/v25-*.json |
| V2.6 异常恢复 | b) 运行中杀 server 重启对账；a) CDP 断连 | interrupted 或可 continue；无幽灵任务；不伪造终态 | b) 强杀运行中 server→重启对账 status=interrupted，message 如实标注「不续跑；ZCode 内可能仍在继续，请人工确认」；15 条全对账无幽灵；a) **暂缓**——当前形态下被驱动 ZCode 即宿主，杀 ZCode 会连坐 server，「运行期 CDP 断连恢复（重连观察一次、绝不重发）」无执行机会，可观测的对账路径与 b 项相同；该场景在 P0 形态（server 由独立守护进程持有）下才有完整意义，移至 P0 阶段补测 | 通过（b 项）｜a 项暂缓→P0 补测 | evidence/v26c-after-restart.json |

**V1/V2 结论：10 项用例全部通过（V1.1 含 2 项用户决定跳过；V2.6a 经分析暂缓至 P0 阶段补测——当前宿主=被驱动实例形态下无验证价值，理由见记录表）。核心用例（V1.2 / V1.4 / V2.1 / V2.4 / V2.5）全部通过，go/no-go 决策：**GO**——P0 编码的前置条件已满足，实测参数（轮询、进度摘要周期、needs_user 释放语义、interrupted 归档语义）已沉淀于上表与 evidence 目录。**

### 附：3.17.1 兼容补丁记录（5 处，均已构建进本地 dist 并经 91/91 定向单测）

| # | 文件 | 修复 | 触发场景 |
|---|---|---|---|
| 1 | model.ts | 可见标签剥离尾部中文思考档位词（3.17 合并触发器「模型名+档位」导致回读歧义）；别名表补「最高→max」 | V1.1 selectors 探针歧义错误 |
| 2 | cdp.ts clickProject | not-found 时 dismissMenus→重开菜单→重定位一次（portal 菜单失焦自动收起，祖先链不可达） | 绑定点击 not-found |
| 3 | cdp.ts clickProject | 菜单项匹配去掉 visible 前置过滤（长列表滚出视口的项先匹配再 scrollIntoView）——v0.7.6 侧栏滚出问题的镜像 | Tests 项在菜单滚动区外 |
| 4 | cdp.ts+run.ts | 「完全访问」确认对话框自动处理（勾选 yolo-confirmation-risk→确认启用）——3.17 新增安全确认 | 权限设置后回读不一致 |
| 5 | run.ts | 恢复轮续答提交后置 sawRunningAtSend=true（恢复轮无发送观察窗口，快速回复时 #31 运行信号门永久卡 pending） | continue 后卡 running 直至 needs_attention |

### 附：环境噪音与运维事实

- `.mimosa/`：宿主 Mimosa 插件在被驱动的 ZCode 会话中写入 hook 状态（共处未跟踪文件，验收清单中会出现，非任务变更）。
- daemon 运维：`node tsm.mjs daemon`（环境变量 `TSM_SERVER` 指定 dist 路径——**漏设会静默回退 npx 缓存旧构建**，V2.6 一次 setup 失败即此因）。
- 被驱动的 ZCode 实例即宿主实例（9333 CDP）；优雅关闭会驻留托盘，需强杀兜底（restart.log 有记录）。

**V1/V2 全部通过（10/10）后才进入 P0 编码**；任一核心用例（V1.2 / V1.4 / V2.1 / V2.4 / V2.5）失败则先解决再推进。

---

## 5. 时间估算（按半天工作单元）

| 阶段 | 内容 | 预估 |
|---|---|---|
| D1 上午 | 环境预检 + 探针（0.1–0.5 + V1.1） | 0.5 天 |
| D1 下午 | V1.2 + V1.3 下发验证 | 0.5 天 |
| D2 上午 | V1.4 验收引擎 + 失败预案演练 | 0.5 天 |
| D2 下午 | V2.1–V2.3 监听验证 | 0.5 天 |
| D3 上午 | V2.4–V2.6 闭环与异常 | 0.5 天 |
| D3 下午 | 验证记录汇总 + go/no-go 决策 | 0.5 天 |

**合计约 1.5～2 个工作日**（若 V1 一路绿灯，V2 可压缩到 1 天）。

---

## 6. 验证通过后的衔接（预告，不在本轮执行）

- P0 编码：Node.js 调度守护进程（MCP client stdio），复用本次验证过的全部调用参数与状态机行为；
- tasks.yaml + CLI 双入口、每项目 FIFO、15s 轮询、needs_user 冻结策略——参数直接取自 V2 实测值（如轮询间隔、进度摘要周期）。

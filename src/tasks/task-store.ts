/**
 * TaskStore：每个任务一个目录 <home>/tasks/<taskId>/，
 * 维护 task.jsonl 事件流 + task.json 最新快照 + 日志/报告文件的路径约定。
 * 重启时通过快照恢复历史（只读归档，不续跑）。
 */
import path from "node:path";
import {
  type TaskEvent,
  type TaskEventName,
  type TaskMeta,
  type TaskStatus,
  type WorkspaceMode,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  type VerifyReport,
} from "./task.js";
import {
  appendLine,
  exists,
  mkdirp,
  readDirSafe,
  readJsonSafe,
  readTextSafe,
  readTextTail,
  writeJsonAtomic,
  writeTextAtomic,
} from "../util/fs.js";
import { isAgentEventName } from "../agents/agent-events.js";
import { statusToEvent, type Notifier } from "./notifier.js";
import { nowIso } from "../util/id.js";
import { Logger } from "../util/log.js";
import { reportToJsonable, reportToMd } from "../verify/report.js";
import {
  dryRunReportToJsonable,
  renderDryRunReportMd,
  type DryRunReport,
} from "../verify/dry-run.js";
import { visualHtml } from "../visual/report.js";

const STATUS_EVENT_MAP: Record<TaskStatus, TaskEventName> = {
  queued: "queued",
  running: "started",
  verify_start: "verify_start",
  fixing: "fix_start",
  succeeded: "succeeded",
  failed: "failed",
  needs_attention: "needs_attention",
  needs_user: "needs_user",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

/** 沟通记录文件头（首次写入时一次性落定；会话标题以首次记录时的值为准）。 */
export interface TranscriptHeader {
  taskId: string;
  agentId: string;
  projectPath: string;
  /** 无项目模式（default 工作区）时按「无项目（default 工作区）」渲染 */
  workspaceMode?: WorkspaceMode;
  sessionId?: string;
  sessionTitle?: string;
}

/** 沟通记录一节往来（编排器每完成一次 agent 调用追加一节）。 */
export interface TranscriptTurn {
  /** agent 轮次（0-based，与 marker r<N> 同源） */
  round: number;
  /** 本节所属派发类别：initial 派发 / rework 返修 / continue 续答 / chat 自由续聊 */
  kind: "initial" | "rework" | "continue" | "chat";
  at: string;
  /** 实际发给 Agent 的完整文本（当前由 zcode 适配器采集，含 tianshu 标记） */
  sent: string;
  /** Agent 回复正文（reply_stable 判定轮）；未取得时由 note 如实说明 */
  reply?: string;
  note?: string;
}

/** 已有文件时统计既往节数（按节标题行计数，历史文件人工编辑后仍可延续）。 */
function countTranscriptTurns(text: string | null): number {
  if (!text) return 0;
  return (text.match(/^## r/gm) ?? []).length;
}

function renderTranscriptHeader(header: TranscriptHeader): string {
  const isDefault = header.workspaceMode === "default";
  const project = isDefault ? "无项目（default 工作区）" : header.projectPath || "（未绑定）";
  const session = [header.sessionId, header.sessionTitle].filter(Boolean).join(" ｜ ") || "（本轮记录时未取得）";
  return [
    "# 任务沟通记录（transcript）",
    "",
    `- 任务：${header.taskId}`,
    `- Agent：${header.agentId}`,
    `- 项目：${project}`,
    `- 会话：${session}`,
    "",
    "以下按时间顺序记录每次发给 Agent 的完整内容与 Agent 的回复。",
    "",
  ].join("\n");
}

function transcriptSection(turn: TranscriptTurn): string {
  const parts = [
    `## r${turn.round} · ${turn.kind} · ${turn.at}`,
    "",
    "### 发给 Agent",
    "",
    turn.sent,
  ];
  if (turn.reply !== undefined) {
    parts.push("", "### Agent 回复", "", turn.reply);
  }
  if (turn.note) {
    parts.push("", `（${turn.note}）`);
  }
  parts.push("");
  return parts.join("\n") + "\n";
}

export class TaskStore {
  private readonly statusWriteTails = new Map<string, Promise<void>>();

  constructor(
    private readonly home: string,
    private readonly logger: Logger,
    /**
     * 任务终态通知器（issue #22，**可选**）。默认不传 = 与引入本能力前完全一致（测试大量
     * 直接 `new TaskStore(home, logger)`，故必须保持可选）。
     */
    private readonly notifier?: Notifier,
  ) {}

  dir(taskId: string): string {
    return path.join(this.home, "tasks", taskId);
  }
  jsonlPath(taskId: string): string {
    return path.join(this.dir(taskId), "task.jsonl");
  }
  snapshotPath(taskId: string): string {
    return path.join(this.dir(taskId), "task.json");
  }
  baselinePath(taskId: string): string {
    return path.join(this.dir(taskId), "baseline.json");
  }
  /** 第 round 次 agent 执行日志（round 从 0 起） */
  agentLogPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `agent-${round}.log`);
  }
  verifyLogPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `verify-${round}.log`);
  }
  reportMdPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `report-${round}.md`);
  }
  reportJsonPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `report-${round}.json`);
  }
  /**
   * 第 round 轮 reply_stable 时 Agent 的回复正文（仅实现该能力的适配器产生，如 zcode）。
   * 纯文本逐字落盘，不带任何包装头，便于调用方直接消费原正文。
   */
  lastReplyMdPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `last-reply-${round}.md`);
  }
  /** 落盘一轮回复正文，返回绝对路径（随 meta.lastReplyFile 登记） */
  async saveLastReply(taskId: string, round: number, text: string): Promise<string> {
    await mkdirp(this.dir(taskId));
    const file = this.lastReplyMdPath(taskId, round);
    await writeTextAtomic(file, text);
    return file;
  }
  /** 任务沟通记录文件（transcript.md）路径；未写入时文件不存在 */
  transcriptPath(taskId: string): string {
    return path.join(this.dir(taskId), "transcript.md");
  }
  async readTranscript(taskId: string): Promise<string | null> {
    return readTextSafe(this.transcriptPath(taskId));
  }

  /**
   * 追加一节任务沟通记录（发给 Agent 的内容 + Agent 回复/未取得回复说明）。
   * 文件不存在时先写头（任务 / Agent / 项目 / 会话锚点），之后每调用一次追加一节并整体
   * 原子重写；返回路径与当前累计节数供 meta.transcriptFile / transcriptTurns 登记。
   */
  async recordTranscriptTurn(
    taskId: string,
    header: TranscriptHeader,
    turn: TranscriptTurn,
  ): Promise<{ file: string; turns: number }> {
    await mkdirp(this.dir(taskId));
    const file = this.transcriptPath(taskId);
    const text = await readTextSafe(file);
    const turns = countTranscriptTurns(text);
    // 接缝：旧结尾统一收敛为单个换行，再空一行开新节——保证「## r」节标题永远在行首
    // （既避免把标题粘进上一节回复，也保证节数统计按标题行计数稳定）。
    const prior = text == null ? renderTranscriptHeader(header) : text.replace(/[\s\u00a0]+$/, "\n");
    const next = prior + "\n" + transcriptSection(turn);
    await writeTextAtomic(file, next);
    return { file, turns: turns + 1 };
  }
  /**
   * dryRun 静态分析报告（issue #21）。**刻意与 `report-<round>.*` 分开命名**：
   * 两者结论口径不同（静态分析 vs 真实命令验收），若共用文件名会让
   * `nextReportRound()` 把 dryRun 误当成一轮验收、也会污染常规报告列表。
   */
  dryRunReportMdPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `dry-run-report-${round}.md`);
  }
  dryRunReportJsonPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `dry-run-report-${round}.json`);
  }
  /** dryRun 结构化计划渲染出的 markdown（供后续正式任务作 planDoc 复用） */
  dryRunPlanMdPath(taskId: string): string {
    return path.join(this.dir(taskId), "dry-run-plan.md");
  }

  /** 供 query/get_report 读取历史：目录内是否已有产物 */
  hasTaskDir(taskId: string): Promise<boolean> {
    return exists(this.dir(taskId));
  }

  /* ---------- 事件流 ---------- */
  async appendEvent(
    taskId: string,
    event: TaskEventName,
    state: TaskStatus,
    detail?: string,
    data?: TaskEvent["data"],
  ): Promise<void> {
    const ev: TaskEvent = { ts: nowIso(), event, state, detail, data };
    await mkdirp(this.dir(taskId));
    await appendLine(this.jsonlPath(taskId), JSON.stringify(ev));
  }

  async readEvents(taskId: string): Promise<TaskEvent[]> {
    const text = await readTextSafe(this.jsonlPath(taskId));
    if (!text) return [];
    const out: TaskEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TaskEvent);
      } catch {
        // 跳过坏行
      }
    }
    return out;
  }

  /**
   * 读取最近的细粒度 agent 事件（issue #18）。
   *
   * 长任务的 task.jsonl 会无限增长，因此**只读尾部窗口**（默认 64KiB）而不是全文：
   * 内存占用与文件总大小解耦，这是 issue 提到的「避免长时间运行任务内存膨胀」的落点。
   * 返回最后 `limit` 条属于 AGENT_EVENT_NAMES 的事件（按写入顺序，即时间正序）。
   */
  async readRecentAgentEvents(
    taskId: string,
    limit: number,
    maxBytes = 64 * 1024,
  ): Promise<TaskEvent[]> {
    const text = await readTextTail(this.jsonlPath(taskId), maxBytes);
    if (!text) return [];
    const matched: TaskEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as TaskEvent;
        if (isAgentEventName(ev.event)) matched.push(ev);
      } catch {
        // 跳过坏行
      }
    }
    return matched.slice(-limit);
  }

  /* ---------- 快照 ---------- */
  async writeSnapshot(meta: TaskMeta): Promise<void> {
    await mkdirp(this.dir(meta.taskId));
    await writeJsonAtomic(this.snapshotPath(meta.taskId), meta);
  }

  async readSnapshot(taskId: string): Promise<TaskMeta | null> {
    return readJsonSafe<TaskMeta>(this.snapshotPath(taskId));
  }

  /**
   * 等待该任务最新的状态事件与快照全部落盘。
   * 查询/取消调用通过这个屏障，避免在对应 JSONL 事件追加前观察到内存终态。
   */
  async waitForStatusWrite(taskId: string): Promise<void> {
    await this.statusWriteTails.get(taskId);
  }

  async updateStatus(
    meta: TaskMeta,
    status: TaskStatus,
    detail?: string,
    eventName?: TaskEvent["event"],
  ): Promise<void> {
    const taskId = meta.taskId;
    const previousWrite = this.statusWriteTails.get(taskId);
    const write = (async () => {
      if (previousWrite) await previousWrite;
      const prev = meta.status;
      // 终态只能由显式的 continue/rework 路径重新入队；异步收尾不得把已经取消、
      // 失败或完成的任务覆盖回活动态。典型竞态是 pump 已取出 queued 任务，
      // cancel_task 先落 cancelled，而 orchestrator 稍后才尝试写 running。
      if (TERMINAL_STATUSES.includes(prev) && status !== prev) {
        this.logger.warn(`任务 ${taskId}: 忽略非法终态改写 ${prev} → ${status}`);
        return;
      }
      meta.status = status;
      meta.updatedAt = nowIso();
      if (TERMINAL_STATUSES.includes(status)) meta.finishedAt = meta.updatedAt;
      const name = eventName ?? STATUS_EVENT_MAP[status];
      await this.appendEvent(taskId, name, status, detail);
      await this.writeSnapshot(meta);
      this.logger.debug(`任务 ${taskId}: ${prev} → ${status}${detail ? ` (${detail})` : ""}`);
      // issue #22：终态通知。**在 appendEvent + writeSnapshot 成功之后**才发——先保证
      // 本地事实已落盘，再对外通知；notify 是 fire-and-forget，不阻塞状态机写入链。
      this.notifyTerminal(meta, status);
    })();
    this.statusWriteTails.set(taskId, write);
    try {
      await write;
    } finally {
      if (this.statusWriteTails.get(taskId) === write) this.statusWriteTails.delete(taskId);
    }
  }

  /** 终态跃迁的通知派发（issue #22）；未传 notifier 或非通知状态时是空操作 */
  private notifyTerminal(meta: TaskMeta, status: TaskStatus): void {
    if (!this.notifier) return;
    const event = statusToEvent(status);
    if (!event) return;
    this.notifier.notify({
      taskId: meta.taskId,
      event,
      status,
      ts: nowIso(),
      finishedAt: meta.finishedAt,
      agentId: meta.agentId,
      projectPath: meta.projectPath,
      round: meta.roundsUsed,
      reportRound: meta.reportRound,
      message: meta.lastMessage,
      reportMd: meta.reportMd,
      reportJson: meta.reportJson,
    });
  }

  async addNote(meta: TaskMeta, detail: string): Promise<void> {
    meta.updatedAt = nowIso();
    await this.appendEvent(meta.taskId, "note", meta.status, detail);
    await this.writeSnapshot(meta);
  }

  /** cancel_requested 事件 + 独立取消意图字段落盘（S1：不依赖可选 reason 判断取消来源） */
  async markCancelRequested(meta: TaskMeta, reason?: string): Promise<void> {
    meta.cancelReason = reason;
    meta.cancelRequestedAt = nowIso();
    meta.abortSource = "user";
    meta.updatedAt = meta.cancelRequestedAt;
    await this.appendEvent(
      meta.taskId,
      "cancel_requested",
      meta.status,
      reason ? `收到取消请求：${reason}` : "收到取消请求（无 reason）",
    );
    await this.writeSnapshot(meta);
  }

  /* ---------- 报告 ---------- */
  async saveReport(taskId: string, report: VerifyReport): Promise<void> {
    await mkdirp(this.dir(taskId));
    if (report.visual) {
      report.files.html = path.join(this.dir(taskId), `report-${report.round}.html`);
      await writeTextAtomic(report.files.html, visualHtml(report));
    }
    await writeTextAtomic(report.files.md, reportToMd(report));
    await writeJsonAtomic(report.files.json, reportToJsonable(report));
  }

  /**
   * 写 dryRun 静态分析报告（issue #21）。
   * **不触碰 `report-<round>.*`**：dryRun 不消耗验收轮次，两份产物互不干扰。
   */
  async saveDryRunReport(
    taskId: string,
    round: number,
    report: DryRunReport,
  ): Promise<{ md: string; json: string }> {
    await mkdirp(this.dir(taskId));
    const md = this.dryRunReportMdPath(taskId, round);
    const json = this.dryRunReportJsonPath(taskId, round);
    await writeTextAtomic(md, renderDryRunReportMd(report));
    await writeJsonAtomic(json, dryRunReportToJsonable(report));
    return { md, json };
  }

  /** 启动扫描：找出 running/interrupted/queued 遗留，供归档 */
  async scanLegacyActive(): Promise<TaskMeta[]> {
    const dirs = await readDirSafe(path.join(this.home, "tasks"));
    const metas = await Promise.all(
      dirs.filter((d) => d.startsWith("tsk_")).map((d) => this.readSnapshot(d)),
    );
    return metas.filter((m): m is TaskMeta => m !== null && ACTIVE_STATUSES.includes(m.status));
  }

  /** 列出全部任务快照 */
  async listTaskSnapshots(): Promise<TaskMeta[]> {
    const dirs = await readDirSafe(path.join(this.home, "tasks"));
    const metas = await Promise.all(
      dirs.filter((d) => d.startsWith("tsk_")).map((d) => this.readSnapshot(d)),
    );
    return metas.filter((m): m is TaskMeta => m !== null);
  }

  /**
   * 扫描全部记录快照：`tsk_*`（派单任务）与 `vfy_*`（独立路径验收记录）。
   * 仅供幂等映射损坏时的重建使用（issue #15）——故意不改动 `listTaskSnapshots()`
   * 的 `tsk_` 过滤，`list_tasks` 的既有语义与列宽保持不变。
   */
  async scanAllSnapshots(): Promise<TaskMeta[]> {
    const dirs = await readDirSafe(path.join(this.home, "tasks"));
    const metas = await Promise.all(
      dirs.filter((d) => d.startsWith("tsk_") || d.startsWith("vfy_")).map((d) => this.readSnapshot(d)),
    );
    return metas.filter((m): m is TaskMeta => m !== null);
  }
}

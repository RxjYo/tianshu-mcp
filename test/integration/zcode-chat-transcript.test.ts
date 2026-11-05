/**
 * 集成测试：action=chat（ZCode 终态任务自由续聊）+ 沟通记录（transcript.md）全链路。
 *
 * 复用 zcode-flow.test.ts 的 CDP 替身（FakeZcode / depsFor），走真实 runZcodeTask 的
 * prompt 组装、marker、sentPrompt 采集与 lastReply 防串轮——编排层（manager.chat →
 * buildResume kind=chat → fix-loop 消费/收尾 → transcript 落盘）在 TaskManager 层级贯通。
 *
 * 轮次号语义与现有编排一致：no-verify 流程里 `roundsUsed` 只在验收链递增（fix-loop 仅在
 * runVerifyOnce 之后 +1）——因此无验收任务的首个 chat 轮号 = meta.roundsUsed（通常为 0），
 * chat 收尾由本能力负责把 roundsUsed 推进到 round+1，保证后续轮次号不重置。
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../../src/agents/adapter.js";
import { ZcodeGuiAdapter } from "../../src/agents/zcode/adapter.js";
import { runZcodeTask, type ZcodeRunDeps } from "../../src/agents/zcode/run.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { DataHome } from "../../src/config/store.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { Logger } from "../../src/util/log.js";
import { gitInitAndCommit, makeTmpRoot, rmrf } from "../test-utils.js";
import { normPath } from "../../src/util/path.js";
import { depsFor, FakeZcode } from "./zcode-flow.test.js";

const logger = new Logger(null, "error");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rmrf(dir);
});

const profile = AgentProfileSchema.parse({
  displayName: "ZCode chat test",
  driver: "gui",
  adapter: "zcode-gui",
  status: "ready",
  command: process.execPath,
  gui: {
    pollIntervalMs: 1,
    stableRounds: 2,
    idleTimeoutMs: 1000,
    progressIntervalMs: 1,
    defaultPermissionMode: "完全访问",
  },
});

/** 注入 CDP 替身 deps 的 ZcodeGuiAdapter：run 链路全部走真实 runZcodeTask。 */
class FakeZcodeAdapter extends ZcodeGuiAdapter {
  constructor(
    id: string,
    private readonly fake: FakeZcode,
  ) {
    super(id);
  }
  override async run(
    ctx: TaskContext,
    resolved: ResolvedAgent,
    opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    return runZcodeTask({
      ctx,
      resolved,
      opts,
      logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      deps: depsFor(this.fake) as Partial<ZcodeRunDeps>,
    });
  }
}

/**
 * chat 全链路替身。轮次模型：`turn` = 已送达的交互次数（sendMessage 成功、或在问题卡里
 * 续答成功各算一次）；每次交互后的首个 poll 仍显示**上一轮**回复（发送前基线的真实形态），
 * 之后稳定显示本轮新回复 —— 保证 lastReply 防串轮判据（lastReplyOf(text, baseline)）
 * 在任何轮都取到「异于基线」的新正文。
 * `askOnChat=true` 时在续聊轮（第 2 次交互起）出现 ZCode 反问，模拟「chat 轮中途反问」。
 */
class ChatFlowZcode extends FakeZcode {
  readonly sentTexts: string[] = [];
  private turn = 0;
  private turnPolls = 0;
  private questionAnswered = false;
  constructor(
    project: string,
    private readonly askOnChat = false,
  ) {
    super(project);
  }
  private replyOf(interaction: number): string {
    return interaction <= 0 ? "" : interaction === 1 ? "开发完成" : `续聊回复 ${interaction - 1}`;
  }
  override async sendMessage() {
    this.sentTexts.push(this.typed);
    this.turn++;
    this.turnPolls = 0;
    await super.sendMessage();
  }
  override async selectSession(id?: string) {
    this.questionAnswered = false;
    return super.selectSession(id);
  }
  override async answerQuestion(answer: string) {
    this.questionAnswered = true;
    this.turn++;
    this.turnPolls = 0;
    return { answered: true, count: 1, available: [answer] };
  }
  override async poll() {
    if (this.turn === 0)
      return {
        stopVisible: false,
        loading: false,
        activeTool: false,
        assistantText: "",
        inputEnabled: true,
        sendEnabled: true,
      };
    this.turnPolls++;
    const asking = this.askOnChat && this.turn >= 2 && !this.questionAnswered;
    const showPrevious = this.turnPolls === 1 && this.turn >= 2;
    return {
      stopVisible: this.turnPolls === 1,
      loading: false,
      activeTool: false,
      question: asking ? "需要先说明具体改哪个页面吗？" : undefined,
      assistantText: showPrevious ? this.replyOf(this.turn - 1) : this.replyOf(this.turn),
      inputEnabled: true,
      sendEnabled: true,
    };
  }
}

/** 派发后只回报运行信号、从不产出回复：用于制造 running / 排队中的守卫拒绝场景。 */
class HangingZcode extends FakeZcode {
  private myPolls = 0;
  override async poll() {
    if (!this.sent)
      return {
        stopVisible: false,
        loading: false,
        activeTool: false,
        assistantText: "",
        inputEnabled: true,
        sendEnabled: true,
      };
    this.myPolls++;
    return {
      stopVisible: true,
      loading: true,
      activeTool: true,
      assistantText: "",
      inputEnabled: true,
      sendEnabled: true,
    };
  }
}

async function makeSetup(fake: FakeZcode) {
  const project = await makeTmpRoot("zcode-chat-project");
  cleanup.push(project);
  fs.writeFileSync(path.join(project, "README.md"), "baseline");
  await gitInitAndCommit(project);
  const home = await makeTmpRoot("zcode-chat-home");
  cleanup.push(home);
  const data = new DataHome(home, logger, { zcode: profile });
  await data.init();
  const store = new TaskStore(home, logger);
  const registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
  registry.register("zcode", new FakeZcodeAdapter("zcode", fake));
  const manager = new TaskManager(
    store,
    data,
    registry,
    new AcceptanceEngine(store, logger),
    logger,
    makeBuildCtx({ store, dataHome: data }),
  );
  await manager.initialize(1);
  fake.useProject(project);
  return { home, store, project, manager };
}

async function waitStatus(manager: TaskManager, taskId: string, status: string) {
  for (let i = 0; i < 2000; i++) {
    const meta = await manager.getMeta(taskId);
    if (meta?.status === status && manager.activeCount === 0) return meta;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务 ${taskId} 未到 ${status}`);
}

async function submitInitial(manager: TaskManager, project: string): Promise<string> {
  const task = await manager.submit({
    projectPath: normPath(project),
    displayPath: project,
    agentId: "zcode",
    task: "完成开发",
    model: "DeepSeek/deepseek-flash",
    autoVerify: false,
    autoFixRounds: 2,
    taskTimeoutMs: 10_000,
  });
  return task.taskId;
}

describe("manage_task(action=chat)：ZCode 终态任务自由续聊", () => {
  it("chat 消息进同一会话并带回回复；任务恢复 succeeded；transcript 逐节记录往来", async () => {
    const { store, project, manager } = await makeSetup(new ChatFlowZcode(""));

    const taskId = await submitInitial(manager, project);
    const finished0 = await waitStatus(manager, taskId, "succeeded");
    const baseRound = finished0.roundsUsed ?? 0;

    const meta0 = await manager.getMeta(taskId);
    expect(meta0?.lastReply).toBe("开发完成");
    expect(meta0?.transcriptFile).toBe(store.transcriptPath(taskId));
    expect(meta0?.transcriptTurns).toBe(1);

    // ChatFlowZcode 替身：makeSetup 内注册的替身本身带着逐轮互异回复逻辑
    const res = await manager.chat(taskId, "把按钮改成蓝色");
    expect(res.found).toBe(true);

    const after = await waitStatus(manager, taskId, "succeeded");
    expect(after.chatActive).toBeUndefined();
    expect(after.chatMessage).toBeUndefined();
    expect(after.chatRestoreStatus).toBeUndefined();
    expect(after.roundsUsed).toBe(baseRound + 1);
    expect(after.lastReply).toBe("续聊回复 1");

    // transcript：initial 与 chat 两节，往来逐字在卷（含逐字 marker）
    const text1 = (await store.readTranscript(taskId)) ?? "";
    expect(text1).toContain(`## r${baseRound} · initial`);
    expect(text1).toContain(`## r${baseRound} · chat`);
    expect(text1).toContain("### 发给 Agent");
    expect(text1).toContain("### Agent 回复");
    expect(text1).toContain("开发完成");
    expect(text1).toContain("把按钮改成蓝色");
    expect(text1).toMatch(
      new RegExp(`【tianshu:${taskId}:r${baseRound}:chat:[0-9a-f]{8}】`, "m"),
    );
    const meta1 = await manager.getMeta(taskId);
    expect(meta1?.transcriptTurns).toBe(2);
  }, 60_000);

  it("chat 轮 agent 反问 → needs_user；continue 应答后完成并恢复原终态，transcript 如实记「未取得回复」", async () => {
    const { store, project, manager } = await makeSetup(new ChatFlowZcode("", true));
    const taskId = await submitInitial(manager, project);
    await waitStatus(manager, taskId, "succeeded");

    const res = await manager.chat(taskId, "再优化一下交互");
    expect(res.found).toBe(true);
    const paused = await waitStatus(manager, taskId, "needs_user");
    expect(paused.pendingQuestion).toContain("改哪个页面");
    // 未完成的轮不清 chatActive；needs_user 上直接 chat 被拒（非终态）
    expect(paused.chatActive).toBe(true);
    const chatAgain = await manager.chat(taskId, "换个说法");
    expect(chatAgain.found).toBe(false);
    expect(chatAgain.reason).toContain("终态任务");

    const cont = await manager.continueTask(taskId, "不用，直接改");
    expect(cont.found).toBe(true);
    const done = await waitStatus(manager, taskId, "succeeded");
    expect(done.chatActive).toBeUndefined();
    expect(done.lastReply).toBe("续聊回复 2");
    const meta = await manager.getMeta(taskId);
    expect(meta?.transcriptTurns).toBe(3);

    const text = (await store.readTranscript(taskId)) ?? "";
    expect(text).toContain("· initial");
    expect(text).toContain("· chat");
    // chat 轮先记「未取得回复：ZCode 反问」，continue 节随后记应答与回复
    expect(text).toContain("本轮未取得回复：ZCode 等待用户处理");
    expect(text).toContain("· continue");
    expect(text).toContain("不用，直接改");
    expect(text).toContain("续聊回复 2");
  }, 60_000);

  it("守卫：非 zcode 任务 / running / queued / 空 message / 缺会话锚点 均拒绝", async () => {
    // 非 zcode：registry 不含 codex adapter，submit 会很快落 failed（agent_unresolved）→ 终态
    const { project, manager } = await makeSetup(new HangingZcode(""));
    const bogus = await manager.submit({
      projectPath: normPath(project),
      displayPath: project,
      agentId: "codex",
      task: "开发",
      autoVerify: false,
      autoFixRounds: 0,
      taskTimeoutMs: 10_000,
    });
    await waitStatus(manager, bogus.taskId, "failed");
    const resAgent = await manager.chat(bogus.taskId, "你好");
    expect(resAgent.found).toBe(false);
    expect(resAgent.reason).toContain("仅支持 zcode");

    // running / queued：HangingZcode 派发后一直回报运行信号，任务停在 running；随后任务排队
    const runningId = await submitInitial(manager, project);
    // 等到 running（HangingZcode 不给出回复，任务一直运行）
    let nowRunning = false;
    for (let i = 0; i < 500; i++) {
      const meta = await manager.getMeta(runningId);
      if (meta?.status === "running") {
        nowRunning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(nowRunning).toBe(true);
    const resRunning = await manager.chat(runningId, "插一句");
    expect(resRunning.found).toBe(false);
    expect(resRunning.reason).toContain("终态任务");

    const queued = await manager.submit({
      projectPath: normPath(project),
      displayPath: project,
      agentId: "zcode",
      task: "第二个任务（排队中）",
      model: "DeepSeek/deepseek-flash",
      autoVerify: false,
      autoFixRounds: 0,
      taskTimeoutMs: 10_000,
    });
    expect(queued.status).toBe("queued");
    const resQueued = await manager.chat(queued.taskId, "也插一句");
    expect(resQueued.found).toBe(false);
    expect(resQueued.reason).toContain("终态任务");
    await manager.cancel(queued.taskId, "测试收尾");

    // 空 message / 缺会话锚点：需要终态 zcode 任务 —— 正常替身独立构造
    const chatSetup = await makeSetup(new ChatFlowZcode(""));
    const taskId = await submitInitial(chatSetup.manager, chatSetup.project);
    await waitStatus(chatSetup.manager, taskId, "succeeded");
    const resEmpty = await chatSetup.manager.chat(taskId, "   ");
    expect(resEmpty.found).toBe(false);
    expect(resEmpty.reason).toContain("不能为空");

    const meta = (await chatSetup.manager.getMeta(taskId))!;
    delete meta.zcodeSessionId;
    delete meta.zcodeSessionTitle;
    await chatSetup.manager.persistMetaUpdate(meta);
    const resAnchor = await chatSetup.manager.chat(taskId, "接着聊");
    expect(resAnchor.found).toBe(false);
    expect(resAnchor.reason).toContain("会话定位信息缺失");

    await manager.cancel(runningId, "测试收尾");
  }, 90_000);
});

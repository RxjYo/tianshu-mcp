/**
 * 单元测试：TaskStore 沟通记录（transcript.md）的路径约定、节渲染与累计计数。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const logger = new Logger(null, "error");

describe("TaskStore.transcript", () => {
  it("首次写入生成文件头并返回 turns=1；追加节正确累计", async () => {
    const home = await makeTmpRoot("ts-transcript");
    const store = new TaskStore(home, logger);
    try {
      const header = {
        taskId: "tsk_demo",
        agentId: "zcode",
        projectPath: "D:\\proj",
        workspaceMode: "project" as const,
        sessionId: "session-1",
        sessionTitle: "任务一",
      };
      const first = await store.recordTranscriptTurn("tsk_demo", header, {
        round: 0,
        kind: "initial",
        at: "2026-11-05T10:00:00.000Z",
        sent: "【tianshu:tsk_demo:r0:initial】完成开发",
        reply: "开发完成",
      });
      expect(first.file).toBe(store.transcriptPath("tsk_demo"));
      expect(first.turns).toBe(1);
      expect(fs.existsSync(first.file)).toBe(true);

      let text = fs.readFileSync(first.file, "utf8");
      expect(text).toContain("# 任务沟通记录（transcript）");
      expect(text).toContain("- 任务：tsk_demo");
      expect(text).toContain("- Agent：zcode");
      expect(text).toContain("- 会话：session-1 ｜ 任务一");
      expect(text).toContain("## r0 · initial · 2026-11-05T10:00:00.000Z");
      expect(text).toContain("### 发给 Agent");
      expect(text).toContain("【tianshu:tsk_demo:r0:initial】完成开发");
      expect(text).toContain("### Agent 回复");
      expect(text).toContain("开发完成");

      // 追加第二节（无回复，只有说明）：unfilled turn 如实标注
      const second = await store.recordTranscriptTurn("tsk_demo", header, {
        round: 1,
        kind: "chat",
        at: "2026-11-05T10:05:00.000Z",
        sent: "【tianshu:tsk_demo:r1:chat:abcd1234】把按钮改成蓝色",
        note: "本轮未取得回复（agent 结束原因：session_lost）",
      });
      expect(second.turns).toBe(2);

      text = fs.readFileSync(second.file, "utf8");
      expect(text).toContain("## r1 · chat · 2026-11-05T10:05:00.000Z");
      expect(text).toContain("（本轮未取得回复（agent 结束原因：session_lost））");
      // r0 节不被覆盖
      expect(text).toContain("## r0 · initial");
    } finally {
      await rmrf(home).catch(() => {});
    }
  });

  it("无项目模式按 default 工作区渲染；agent 正文可包含 markdown 字符不被转义", async () => {
    const home = await makeTmpRoot("ts-transcript-default");
    const store = new TaskStore(home, logger);
    try {
      const header = {
        taskId: "tsk_dflt",
        agentId: "zcode",
        projectPath: "",
        workspaceMode: "default" as const,
      };
      const first = await store.recordTranscriptTurn("tsk_dflt", header, {
        round: 0,
        kind: "initial",
        at: "2026-11-05T10:00:00.000Z",
        sent: "帮我出方案 # 话题",
        reply: "```json\n{\"a\":1}\n```",
      });
      const turns = first.turns;
      expect(turns).toBe(1);
      const text = fs.readFileSync(first.file, "utf8");
      expect(text).toContain("- 项目：无项目（default 工作区）");
      expect(text).toContain("- 会话：（本轮记录时未取得）");
      expect(text).toContain('```json\n{"a":1}\n```');
    } finally {
      await rmrf(home).catch(() => {});
    }
  });

  it("readTranscript：未写入返回 null；写入后可读回（供 query_info(type=transcript)）", async () => {
    const home = await makeTmpRoot("ts-transcript-read");
    const store = new TaskStore(home, logger);
    try {
      expect(await store.readTranscript("tsk_none")).toBeNull();
      await store.recordTranscriptTurn(
        "tsk_none",
        { taskId: "tsk_none", agentId: "zcode", projectPath: "D:\\proj" },
        { round: 0, kind: "initial", at: "t0", sent: "s1", reply: "r1" },
      );
      const text = await store.readTranscript("tsk_none");
      expect(text).toBeTruthy();
      expect(path.dirname(store.transcriptPath("tsk_none"))).toBe(store.dir("tsk_none"));
    } finally {
      await rmrf(home).catch(() => {});
    }
  });

  it("历史文件被人工编辑后节数按标题行重算（延续不受阻）", async () => {
    const home = await makeTmpRoot("ts-transcript-manual");
    const store = new TaskStore(home, logger);
    try {
      const header = { taskId: "tsk_m", agentId: "zcode", projectPath: "D:\\proj" };
      await store.recordTranscriptTurn("tsk_m", header, {
        round: 0,
        kind: "initial",
        at: "t0",
        sent: "s0",
        reply: "r0",
      });
      // 人工多加一节标题
      const file = store.transcriptPath("tsk_m");
      fs.appendFileSync(file, "\n## r9 · chat · 人工补记\n\n### 发给 Agent\n\n手工行\n");
      const next = await store.recordTranscriptTurn("tsk_m", header, {
        round: 1,
        kind: "chat",
        at: "t1",
        sent: "s1",
        reply: "r1",
      });
      expect(next.turns).toBe(3);
    } finally {
      await rmrf(home).catch(() => {});
    }
  });
});

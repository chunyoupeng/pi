/**
 * Real AgentSession + faux provider integration tests for the goal extension.
 * Verifies single-tool registration, `agent_before_settle` continuation loop,
 * real abort suppression, and consecutive idle-round auto-pause.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/extensions/goal/index.ts";
import { loadGoalFromEntries } from "../../src/extensions/goal/state.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("goal extension with real AgentSession", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("exposes a single goal tool and runs multi-round continuation in one settled run", async () => {
		const harness = await createHarness({
			extensionFactories: [goalExtension],
		});
		harnesses.push(harness);

		const activeTools = harness.session.getActiveToolNames();
		expect(activeTools).toContain("goal");
		expect(activeTools).not.toContain("get_goal");
		expect(activeTools).not.toContain("create_goal");
		expect(activeTools).not.toContain("update_goal");

		const seenPrompts: string[] = [];
		harness.setResponses([
			// Round 1: model inspects files (work tool) so idle guard stays at 0.
			(context) => {
				seenPrompts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([fauxToolCall("ls", { path: "." })]);
			},
			fauxAssistantMessage("Checked workspace, continuing next round."),
			// Round 2: model marks the goal complete via the unified `goal` tool.
			(context) => {
				seenPrompts.push(JSON.stringify(context.messages));
				const current = loadGoalFromEntries(harness.sessionManager.getBranch());
				return fauxAssistantMessage([
					fauxToolCall("goal", { action: "complete", goalId: current!.goalId, note: "all done" }),
				]);
			},
			fauxAssistantMessage("Objective complete."),
		]);

		await harness.session.prompt("/goal Ship the refactored parser");
		await harness.session.waitForIdle();

		const finalGoal = loadGoalFromEntries(harness.sessionManager.getBranch());
		expect(finalGoal?.status).toBe("complete");
		expect(finalGoal?.note).toBe("all done");
		expect(finalGoal?.rounds).toBe(2);
		// Continuation happens inside agent_before_settle, so agent_settled fires once at the end.
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(seenPrompts).toHaveLength(2);
		// Full objective appears in round 1 start message, not duplicated verbatim in round 2 continuation message.
		const objectiveOccurrencesInRound2 = seenPrompts[1]!.split("Ship the refactored parser").length - 1;
		expect(objectiveOccurrencesInRound2).toBe(1);
	});

	it("stops auto-continuation immediately when the run is aborted", async () => {
		const harness = await createHarness({
			extensionFactories: [goalExtension],
		});
		harnesses.push(harness);

		let calls = 0;
		harness.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("aborted mid-stream", { stopReason: "aborted" });
			},
			() => {
				calls++;
				return fauxAssistantMessage("should never run");
			},
		]);

		// Trigger an abort as soon as the agent run begins.
		const unsub = harness.session.subscribe((event) => {
			if (event.type === "agent_start") {
				void harness.session.abort();
			}
		});

		await harness.session.prompt("/goal Never continue after Escape");
		await harness.session.waitForIdle();
		unsub();

		const settled = harness.eventsOfType("agent_settled");
		expect(settled).toHaveLength(1);
		expect(settled[0]?.aborted).toBe(true);
		expect(calls).toBeLessThanOrEqual(1);
		// Goal remains active (not cleared) so user can decide to /goal resume or /goal pause.
		expect(loadGoalFromEntries(harness.sessionManager.getBranch())?.status).toBe("active");
	});

	it("auto-pauses after 3 consecutive rounds with no tool activity", async () => {
		const harness = await createHarness({
			extensionFactories: [goalExtension],
		});
		harnesses.push(harness);

		let calls = 0;
		harness.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("Round 1: thinking only.");
			},
			() => {
				calls++;
				return fauxAssistantMessage("Round 2: still no tools.");
			},
			() => {
				calls++;
				return fauxAssistantMessage("Round 3: forgot to mark complete.");
			},
			() => {
				calls++;
				return fauxAssistantMessage("Round 4: must never execute.");
			},
		]);

		await harness.session.prompt("/goal Do not spin forever");
		await harness.session.waitForIdle();

		expect(calls).toBe(3);
		const goal = loadGoalFromEntries(harness.sessionManager.getBranch());
		expect(goal?.status).toBe("paused");
		expect(goal?.note).toContain("Auto-paused");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("re-injects the full objective and goalId after real session compaction without revision change", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				goalExtension,
				// Provide a deterministic compaction summary that omits the goal text.
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Compacted earlier conversation.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 100,
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		let postCompactionPayload = "";
		harness.setResponses([
			// Prompt 1: model creates goal via tool, then hits error so goal stays active at rev 1.
			() =>
				fauxAssistantMessage([fauxToolCall("goal", { action: "create", objective: "Unique objective XYZ-987" })]),
			fauxAssistantMessage("Goal created, hitting transient error.", { stopReason: "error" }),
			// Prompt 2 (before compaction): injects goal-context once (setting lastInjectedGoalKey), then errors.
			fauxAssistantMessage("Transient error after context injection.", { stopReason: "error" }),
			// Prompt 3 (after compaction, same goalId:revision:status): must re-inject goal-context.
			(context) => {
				postCompactionPayload = JSON.stringify(context.messages);
				const current = loadGoalFromEntries(harness.sessionManager.getBranch());
				return fauxAssistantMessage([
					fauxToolCall("goal", { action: "complete", goalId: current!.goalId, note: "recovered after compact" }),
				]);
			},
			fauxAssistantMessage("Completed after compaction."),
		]);

		await harness.session.prompt("Please set a goal for me.");
		await harness.session.waitForIdle();
		await harness.session.prompt("Check status before compaction.");
		await harness.session.waitForIdle();

		const beforeCompact = loadGoalFromEntries(harness.sessionManager.getBranch());
		expect(beforeCompact?.status).toBe("active");
		expect(beforeCompact?.revision).toBe(1);
		const contextMessagesBefore = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom_message" && e.customType === "goal-context").length;
		expect(contextMessagesBefore).toBe(1);

		// Compact the session (summary omits the objective text).
		await harness.session.compact();

		// Send a normal prompt without mutating goal revision; before_agent_start must re-inject objective + goalId.
		await harness.session.prompt("Continue working on the goal.");
		await harness.session.waitForIdle();

		const contextMessagesAfter = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom_message" && e.customType === "goal-context").length;
		expect(contextMessagesAfter).toBe(2);
		const finalGoal = loadGoalFromEntries(harness.sessionManager.getBranch());
		expect(finalGoal?.status).toBe("complete");
		expect(postCompactionPayload).toContain("Unique objective XYZ-987");
		expect(postCompactionPayload).toContain(finalGoal!.goalId);
	});
});

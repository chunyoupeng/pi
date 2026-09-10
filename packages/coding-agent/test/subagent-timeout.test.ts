import { Agent, type AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry, type ResolvedRequestAuth } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { type RunSubagentOptions, type RunSubagentResult, runSubagent } from "../src/core/subagent/runner.ts";
import { SubagentSessionPool } from "../src/core/subagent/session-pool.ts";
import type { SubagentProfile, SubagentToolDetails } from "../src/core/subagent/types.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createSubagentTool, createSubagentToolDefinition } from "../src/core/tools/subagent.ts";

const profile: SubagentProfile = {
	name: "worker",
	description: "Timeout fixture",
	systemPrompt: "Complete only the assigned subtask.",
	tools: ["bash"],
	thinkingLevel: "high",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Subagent timeout", () => {
	let faux: ReturnType<typeof registerFauxProvider>;
	let pool: SubagentSessionPool;
	let controllers: AbortController[];
	let releases: Array<() => void>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		faux = registerFauxProvider({ models: [{ id: "timeout-fixture", reasoning: true }] });
		pool = new SubagentSessionPool();
		controllers = [];
		releases = [];
	});

	afterEach(async () => {
		for (const controller of controllers) controller.abort();
		for (const release of releases) release();
		await vi.advanceTimersByTimeAsync(610_000);
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		faux.unregister();
	});

	function start(options: Partial<RunSubagentOptions> = {}) {
		const controller = new AbortController();
		controllers.push(controller);
		const run = {
			controller,
			settled: false,
			result: undefined as RunSubagentResult | undefined,
			error: undefined as unknown,
		};
		void runSubagent({
			profile,
			task: "Investigate authentication",
			cwd: process.cwd(),
			parentModel: faux.getModel(),
			sessionPool: pool,
			signal: controller.signal,
			...options,
		}).then(
			(result) => {
				run.result = result;
				run.settled = true;
			},
			(error: unknown) => {
				run.error = error;
				run.settled = true;
			},
		);
		return run;
	}

	function resultOf(run: ReturnType<typeof start>) {
		expect(run.settled).toBe(true);
		expect(run.error).toBeUndefined();
		return run.result!;
	}

	function blocked(cooperative = true) {
		const gate = deferred<AssistantMessage>();
		const release = () => gate.resolve(fauxAssistantMessage("Partial work"));
		releases.push(release);
		const response = vi.fn<FauxResponseFactory>((_context, options) => {
			if (cooperative) {
				if (options?.signal?.aborted) release();
				else options?.signal?.addEventListener("abort", release, { once: true });
			}
			return gate.promise;
		});
		return { response, release };
	}

	async function blockedAuth() {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const gate = deferred<ResolvedRequestAuth>();
		const release = () => gate.resolve({ ok: true, apiKey: "fixture-key" });
		releases.push(release);
		const resolveAuth = vi.spyOn(registry, "getApiKeyAndHeaders").mockReturnValue(gate.promise);
		return { registry, release, resolveAuth };
	}

	it.each([
		{ timeout: undefined, seconds: 180 },
		{ timeout: 0.5, seconds: 0.5 },
		{ timeout: 300, seconds: 300 },
		{ timeout: 570, seconds: 570 },
		{ timeout: 570.1, seconds: 570 },
		{ timeout: 600, seconds: 570 },
	])("interrupts at $seconds seconds for timeout=$timeout and summarizes", async ({ timeout, seconds }) => {
		const work = blocked();
		const summary = vi.fn<FauxResponseFactory>(() => fauxAssistantMessage("Found the cause; tests remain."));
		const update = vi.fn<AgentToolUpdateCallback<SubagentToolDetails>>();
		faux.setResponses([work.response, summary]);
		const run = start({ timeout, onUpdate: update });
		await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
		expect(run.settled).toBe(false);
		expect(work.response.mock.calls[0]![1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const result = resultOf(run);
		expect(result.details).toMatchObject({ status: "timed_out", timeout: timeout ?? 180 });
		expect(work.response.mock.calls[0]![1]?.signal?.aborted).toBe(true);
		expect(summary).toHaveBeenCalledOnce();
		expect(summary.mock.calls[0]![0].tools).toEqual([]);
		expect(summary.mock.calls[0]![1]?.reasoning).toBeUndefined();
		expect(JSON.stringify(summary.mock.calls[0]![0].messages.at(-1))).toContain("You have timed out");
		expect(result.finalText).toContain("Found the cause; tests remain.");
		expect(result.finalText).toContain(result.details.sessionId!);
		expect(update.mock.calls.some(([value]) => value.details?.status === "summarizing")).toBe(true);
		expect(pool.get(result.details.sessionId!)?.subAgent.state.tools.map((tool) => tool.name)).toEqual(["bash"]);
		expect(pool.get(result.details.sessionId!)?.subAgent.state.thinkingLevel).toBe("high");
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, -1, 600.01, Number.NaN, Infinity, -Infinity])(
		"rejects invalid timeout %s before starting",
		async (timeout) => {
			const run = start({ timeout, sessionId: "invalid" });
			await vi.advanceTimersByTimeAsync(0);
			expect(run.settled).toBe(true);
			expect(run.error).toBeInstanceOf(Error);
			expect(String(run.error)).toMatch(/timeout/i);
			expect(faux.state.callCount).toBe(0);
			expect(pool.list()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("resumes the same Agent with restored tools, history, and a fresh default budget", async () => {
		const work = blocked();
		faux.setResponses([work.response, fauxAssistantMessage("First summary")]);
		const first = start({ timeout: 1 });
		await vi.advanceTimersByTimeAsync(1000);
		const sessionId = resultOf(first).details.sessionId!;
		const agent = pool.get(sessionId)!.subAgent;
		const resumedWork = blocked();
		faux.setResponses([resumedWork.response, fauxAssistantMessage("Second summary")]);
		const second = start({ sessionId, task: "Only investigate the next step" });
		await vi.advanceTimersByTimeAsync(179_999);
		expect(second.settled).toBe(false);
		expect(JSON.stringify(resumedWork.response.mock.calls[0]![0].messages)).toContain("First summary");
		expect(resumedWork.response.mock.calls[0]![1]?.reasoning).toBe("high");
		await vi.advanceTimersByTimeAsync(1);
		expect(resultOf(second).details).toMatchObject({ sessionId, isResumed: true, timeout: 180 });
		expect(pool.get(sessionId)!.subAgent).toBe(agent);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits for cancellation to settle before the summary and permits only one summary turn", async () => {
		const prompt = vi.spyOn(Agent.prototype, "prompt");
		const work = blocked();
		const idle = deferred<void>();
		releases.push(() => idle.resolve());
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		faux.setResponses([
			work.response,
			fauxAssistantMessage([{ type: "text", text: "Summary" }, fauxToolCall("bash", { command: "must-not-run" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Must not request another turn"),
		]);
		const run = start({ timeout: 1, toolsOptions: { bash: { operations: { exec } } } });
		await vi.advanceTimersByTimeAsync(0);
		const agent = prompt.mock.contexts[0] as Agent;
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "agent_end") return idle.promise;
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(faux.state.callCount).toBe(1);
		expect(run.settled).toBe(false);
		idle.resolve();
		await vi.advanceTimersByTimeAsync(0);
		unsubscribe();
		expect(resultOf(run).details.status).toBe("timed_out");
		expect(prompt.mock.contexts[1]).toBe(agent);
		expect(exec).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(2);
	});

	it.each(["work", "summary"] as const)(
		"external abort during %s rejects without starting more work",
		async (phase) => {
			const work = blocked();
			const summary = blocked(false);
			faux.setResponses([work.response, summary.response]);
			const run = start({ timeout: 1 });
			await vi.advanceTimersByTimeAsync(phase === "work" ? 500 : 1000);
			run.controller.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(run.settled).toBe(true);
			expect(String(run.error)).toMatch(/aborted/i);
			expect(faux.state.callCount).toBe(phase === "work" ? 1 : 2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["work", "summary"] as const)(
		"bounds a hung %s and saves an independent resumable snapshot",
		async (phase) => {
			const prompt = vi.spyOn(Agent.prototype, "prompt");
			const work = blocked(phase === "summary");
			const summary = blocked(false);
			faux.setResponses([work.response, summary.response]);
			const run = start({ timeout: 600 });
			await vi.advanceTimersByTimeAsync(599_999);
			expect(run.settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const result = resultOf(run);
			expect(result.details.status).toBe("timed_out");
			expect(result.finalText).toContain("Summary unavailable");
			const sessionId = result.details.sessionId!;
			const snapshot = pool.get(sessionId)!.subAgent;
			expect(snapshot).not.toBe(prompt.mock.contexts[0]);
			expect(snapshot.state.isStreaming).toBe(false);
			faux.setResponses([fauxAssistantMessage("Resumed successfully")]);
			const resumed = start({ sessionId });
			await vi.advanceTimersByTimeAsync(0);
			expect(resultOf(resumed).details.isResumed).toBe(true);
			const messages = structuredClone(snapshot.state.messages);
			work.release();
			summary.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(snapshot.state.messages).toEqual(messages);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([false, true])(
		"blocks reuse/reset while an unsettled tool can still write (cancelled=%s)",
		async (cancelled) => {
			const gate = deferred<{ exitCode: number | null }>();
			releases.push(() => gate.resolve({ exitCode: 0 }));
			const exec = vi.fn<BashOperations["exec"]>(() => gate.promise);
			faux.setResponses([
				fauxAssistantMessage(
					[
						{ type: "text", text: "Found authentication issue" },
						fauxToolCall("bash", { command: "inspect-auth" }),
					],
					{ stopReason: "toolUse" },
				),
			]);
			const sessionId = "busy-tool";
			const run = start({ sessionId, timeout: 1, toolsOptions: { bash: { operations: { exec } } } });
			await vi.advanceTimersByTimeAsync(0);
			expect(exec).toHaveBeenCalledOnce();
			if (cancelled) run.controller.abort();
			await vi.advanceTimersByTimeAsync(cancelled ? 0 : 31_000);
			if (cancelled) expect(String(run.error)).toMatch(/aborted/i);
			else {
				expect(resultOf(run).finalText).toContain("inspect-auth");
				expect(resultOf(run).finalText).toContain("Found authentication issue");
			}
			for (const resetSession of [false, true]) {
				const another = start({ sessionId, resetSession });
				await vi.advanceTimersByTimeAsync(0);
				expect(String(another.error)).toMatch(/busy/i);
			}
			gate.resolve({ exitCode: 0 });
			await vi.advanceTimersByTimeAsync(0);
			faux.setResponses([fauxAssistantMessage("Recovered")]);
			const resumed = start({ sessionId });
			await vi.advanceTimersByTimeAsync(0);
			expect(resultOf(resumed).details.isResumed).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("counts authentication time, summarizes the unstarted task, and refreshes auth on resume", async () => {
		const auth = await blockedAuth();
		const summary = vi.fn<FauxResponseFactory>(() => fauxAssistantMessage("Authentication consumed the budget"));
		faux.setResponses([summary]);
		const run = start({ timeout: 1, modelRegistry: auth.registry, sessionId: "auth-budget" });
		await vi.advanceTimersByTimeAsync(2000);
		expect(faux.state.callCount).toBe(0);
		const conflicting = start({ sessionId: "auth-budget", resetSession: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(String(conflicting.error)).toMatch(/busy/i);
		auth.release();
		await vi.advanceTimersByTimeAsync(0);
		const first = resultOf(run);
		expect(first.details.status).toBe("timed_out");
		expect(JSON.stringify(summary.mock.calls[0]![0].messages)).toContain("No work on this task was started");
		expect(summary.mock.calls[0]![0].tools).toEqual([]);
		faux.setResponses([fauxAssistantMessage("Now authenticated")]);
		const resumed = start({ sessionId: first.details.sessionId, modelRegistry: auth.registry });
		await vi.advanceTimersByTimeAsync(0);
		expect(resultOf(resumed).details.status).toBe("completed");
		expect(auth.resolveAuth).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])(
		"bounds hung authentication and releases its session lock (cancelled=%s)",
		async (cancelled) => {
			const auth = await blockedAuth();
			const run = start({ timeout: 600, modelRegistry: auth.registry, sessionId: "hung-auth" });
			await vi.advanceTimersByTimeAsync(1);
			if (cancelled) run.controller.abort();
			await vi.advanceTimersByTimeAsync(cancelled ? 0 : 599_999);
			if (cancelled) expect(String(run.error)).toMatch(/aborted/i);
			else expect(resultOf(run).details).toMatchObject({ status: "timed_out", turnUsage: { turns: 0 } });
			expect(faux.state.callCount).toBe(0);
			auth.release();
			faux.setResponses([fauxAssistantMessage("Recovered auth")]);
			const resumed = start({ sessionId: "hung-auth", modelRegistry: auth.registry });
			await vi.advanceTimersByTimeAsync(0);
			expect(resultOf(resumed).details.status).toBe("completed");
			expect(auth.resolveAuth).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["failed", "empty"])("returns a truthful fallback for a %s summary", async (outcome) => {
		const work = blocked();
		faux.setResponses([
			work.response,
			() => {
				if (outcome === "failed") throw new Error("Summary provider failed");
				return fauxAssistantMessage("");
			},
		]);
		const run = start({ timeout: 1 });
		await vi.advanceTimersByTimeAsync(1000);
		const result = resultOf(run);
		expect(result.details.status).toBe("timed_out");
		expect(result.finalText).toContain("Summary unavailable");
		expect(result.finalText).toContain("Investigate authentication");
		if (outcome === "failed") expect(result.finalText).toContain("Summary provider failed");
		const saved = pool.get(result.details.sessionId!)!;
		expect(saved.subAgent.state.tools.map((tool) => tool.name)).toEqual(["bash"]);
		expect(JSON.stringify(saved.subAgent.state.messages.at(-1))).toContain("Summary unavailable");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases the first-call lock on setup failure", async () => {
		const failed = start({ sessionId: "setup-failure", parentModel: undefined });
		await vi.advanceTimersByTimeAsync(0);
		expect(String(failed.error)).toContain("No model available");
		faux.setResponses([fauxAssistantMessage("Retry worked")]);
		const retried = start({ sessionId: "setup-failure" });
		await vi.advanceTimersByTimeAsync(0);
		expect(resultOf(retried).details.status).toBe("completed");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears deadlines after completion and passes timeout through the public tool", async () => {
		const abort = vi.spyOn(Agent.prototype, "abort");
		faux.setResponses([fauxAssistantMessage("Done")]);
		const tool = createSubagentTool(process.cwd(), {
			agentDir: "/nonexistent-fixture-agent-dir",
			defaultModel: faux.getModel(),
			customProfiles: { fixture: { ...profile, name: "fixture" } },
		});
		const promise = tool.execute("tool-call", { agent: "fixture", task: "Small task", timeout: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect((await promise).details?.timeout).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(abort).not.toHaveBeenCalled();
	});

	it("describes default/max budgets and requires small, independently verifiable assignments", () => {
		const definition = createSubagentToolDefinition(process.cwd(), { agentDir: "/nonexistent-fixture-agent-dir" });
		expect(definition.parameters.properties.timeout).toMatchObject({
			default: 180,
			maximum: 600,
			exclusiveMinimum: 0,
		});
		for (const text of [definition.description, definition.promptGuidelines!.join(" ")]) {
			expect(text).toContain("180-300");
			expect(text).toContain("600");
			expect(text).toContain("570");
			expect(text).toContain("30 seconds");
			expect(text).toContain("independently verifiable");
			expect(text).toContain("entire large task");
			expect(text).toContain("next small subtask");
		}
	});
});

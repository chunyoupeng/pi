import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { SwarmBoardView } from "../../src/extensions/swarm/board-view.ts";
import swarmExtension, { createSwarmExtension } from "../../src/extensions/swarm/index.ts";
import { type SwarmHostContext, SwarmManager } from "../../src/extensions/swarm/manager.ts";
import {
	renderSwarmFooterStatus,
	renderSwarmNotificationMessage,
	renderThemedSwarmStatus,
} from "../../src/extensions/swarm/render.ts";
import {
	COORDINATOR_NAME,
	createEmptyUsage,
	expandPoolSpecs,
	expandSpawnSpecs,
	formatSwarmStatus,
	formatWorkerInspect,
	parseMentions,
	type SwarmBoardPost,
	type SwarmLinkEntry,
	type SwarmSnapshot,
	type SwarmWorkerIdleInfo,
	USER_AUTHOR,
	validateWorkerName,
} from "../../src/extensions/swarm/types.ts";
import type {
	SwarmWorkerFactory,
	SwarmWorkerFactoryInput,
	SwarmWorkerHandle,
} from "../../src/extensions/swarm/worker.ts";
import { defaultSwarmWorkspaceOps } from "../../src/extensions/swarm/workspace.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

interface FakeWorkerController {
	readonly input: SwarmWorkerFactoryInput;
	readonly delivered: Array<{ text: string; steer: boolean }>;
	running: boolean;
	aborted: boolean;
	disposed: boolean;
	currentModel: string;
	currentThinkingLevel: ThinkingLevel;
	finish: (override?: string | Partial<SwarmWorkerIdleInfo>) => void;
}

function createFakeWorkerFactory(): {
	factory: SwarmWorkerFactory;
	workers: Map<string, FakeWorkerController[]>;
} {
	const workers = new Map<string, FakeWorkerController[]>();

	const factory: SwarmWorkerFactory = (input) => {
		const sessionFile = input.existingSessionFile ?? join(input.sessionsDir, `${input.name}.jsonl`);
		mkdirSync(input.sessionsDir, { recursive: true });
		if (!existsSync(sessionFile)) {
			writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: input.name })}\n`, "utf-8");
		}

		const ctrl: FakeWorkerController = {
			input,
			delivered: [],
			running: false,
			aborted: false,
			disposed: false,
			currentModel: `${input.model.provider}/${input.model.id}`,
			currentThinkingLevel: input.thinkingLevel,
			finish: (override?: string | Partial<SwarmWorkerIdleInfo>) => {
				if (!ctrl.running) return;
				ctrl.running = false;
				input.onActivityChange(undefined);
				const maxTurns = input.maxTurnsPerWakeup ?? 25;
				const info: SwarmWorkerIdleInfo =
					typeof override === "string"
						? { reason: "error", turnsUsed: 1, maxTurns, error: override }
						: {
								reason: override?.reason ?? (override?.error ? "error" : "idle"),
								turnsUsed: override?.turnsUsed ?? 1,
								maxTurns: override?.maxTurns ?? maxTurns,
								lastOutput: override?.lastOutput,
								error: override?.error,
							};
				input.onIdle(info);
			},
		};
		const list = workers.get(input.name) ?? [];
		list.push(ctrl);
		workers.set(input.name, list);

		const handle: SwarmWorkerHandle = {
			name: input.name,
			sessionFile,
			isRunning: () => ctrl.running,
			deliver: async (text, opts) => {
				ctrl.delivered.push({ text, steer: opts?.steer === true });
				ctrl.running = true;
				input.onActivityChange("working");
			},
			setModel: (model, thinkingLevel) => {
				ctrl.currentModel = `${model.provider}/${model.id}`;
				if (thinkingLevel !== undefined) {
					ctrl.currentThinkingLevel = thinkingLevel;
				}
			},
			abort: () => {
				ctrl.aborted = true;
				ctrl.running = false;
			},
			dispose: () => {
				ctrl.disposed = true;
				ctrl.running = false;
			},
			getTranscript: () =>
				ctrl.delivered.map((d, i) => ({
					timestamp: 1000 + i,
					kind: "prompt" as const,
					summary: d.text.slice(0, 80),
				})),
			getUsage: () => createEmptyUsage(),
			getCurrentActivity: () => (ctrl.running ? "working" : undefined),
		};

		return handle;
	};

	return { factory, workers };
}

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("swarm types: name validation, sharding, and mention parsing", () => {
	it("validates worker roster names and rejects reserved or malformed names", () => {
		expect(validateWorkerName("parser")).toBeUndefined();
		expect(validateWorkerName("api-tests_1")).toBeUndefined();
		expect(validateWorkerName("a".repeat(24))).toBeUndefined();

		expect(validateWorkerName("")).toBeDefined();
		expect(validateWorkerName("Parser")).toBeDefined();
		expect(validateWorkerName("-leading")).toBeDefined();
		expect(validateWorkerName("a".repeat(25))).toBeDefined();
		expect(validateWorkerName("all")).toBeDefined();
		expect(validateWorkerName("coordinator")).toBeDefined();
		expect(validateWorkerName("coordinator-1")).toBeDefined();
		expect(validateWorkerName("user")).toBeDefined();
	});

	it("expands homogeneous copies (n) and sharded tasks", () => {
		expect(expandSpawnSpecs({ name: "worker", brief: "Audit module", n: 2 })).toEqual([
			{ name: "worker-1", brief: "Audit module" },
			{ name: "worker-2", brief: "Audit module" },
		]);

		const sharded = expandSpawnSpecs({
			name: "fix",
			brief: "Fix lint errors",
			tasks: ["packages/ai", "packages/tui"],
		});
		expect(sharded.map((s) => s.name)).toEqual(["fix-1", "fix-2"]);
		expect(sharded[0]!.brief).toContain("packages/ai");
		expect(sharded[1]!.brief).toContain("packages/tui");

		expect(() => expandSpawnSpecs({ name: "x", brief: "b", n: 2, tasks: ["a"] })).toThrow(/mutually exclusive/);

		const pool = expandPoolSpecs({
			name: "img",
			brief: "Layerize image",
			tasks: ["01.jpg", "02.jpg", "03.jpg", "04.jpg", "05.jpg"],
			concurrency: 2,
		});
		expect(pool.slotNames).toEqual(["img-1", "img-2"]);
		expect(pool.tasks).toHaveLength(5);
		expect(pool.tasks[0]).toEqual({ index: 1, task: "01.jpg" });
	});

	it("parses @mentions while ignoring code blocks, inline code, emails, and self-mentions", () => {
		const active = new Set(["coordinator", "parser", "verifier"]);
		const body = [
			"Contact dev@parser.io or check `@verifier` in inline code.",
			"```ts",
			"// @verifier inside fenced code block",
			"```",
			"Hey @parser and @coordinator, please review.",
		].join("\n");
		expect(parseMentions(body, active, "parser").sort()).toEqual(["coordinator"]);

		// @all expands to all active members except the author
		expect(parseMentions("@all status check", active, "coordinator").sort()).toEqual(["parser", "verifier"]);
	});
});

describe("SwarmManager orchestration, ACLs, concurrency, and revival", () => {
	const tempDirs: string[] = [];
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			harnesses.pop()!.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	async function createTestHost(): Promise<{ host: SwarmHostContext; storageRoot: string; harness: Harness }> {
		const harness = await createHarness({
			models: [
				{ id: "model-a", name: "Model Alpha", reasoning: false },
				{ id: "model-b", name: "Model Beta", reasoning: true },
				{ id: "model-c", name: "Model Gamma", reasoning: true },
			],
		});
		harnesses.push(harness);
		const storageRoot = makeTempDir("pi-swarm-store-");
		tempDirs.push(storageRoot);
		const host: SwarmHostContext = {
			cwd: harness.tempDir,
			model: harness.getModel("model-a"),
			thinkingLevel: "off",
			modelRegistry: new ModelRegistry(harness.session.modelRuntime),
		};
		return { host, storageRoot, harness };
	}

	it("routes @mentions between workers and coordinator, respects concurrency limit, and enforces ACLs", async () => {
		const { host, storageRoot } = await createTestHost();
		const { factory, workers } = createFakeWorkerFactory();
		const coordNotifs: SwarmBoardPost[][] = [];
		const persistedLinks: SwarmLinkEntry[] = [];

		const manager = new SwarmManager({
			storageRoot,
			workerFactory: factory,
			maxConcurrentTurns: 2,
			debounceMs: 0,
			onCoordinatorNotify: (posts) => coordNotifs.push(posts),
			onPersistLink: (link) => persistedLinks.push(link),
		});

		await manager.setTitle(COORDINATOR_NAME, "Auth Refactor", host);

		// Spawn 3 workers with maxConcurrentTurns=2: first 2 run immediately, 3rd queues until a slot frees.
		await manager.addWorkers(
			COORDINATOR_NAME,
			{ name: "eng", brief: "Implement module", tasks: ["mod-1", "mod-2", "mod-3"] },
			host,
		);

		expect(manager.getSnapshot()?.counts.working).toBe(2);
		expect(manager.getSnapshot()?.counts.waiting).toBe(1);
		expect(workers.get("eng-1")![0]!.running).toBe(true);
		expect(workers.get("eng-2")![0]!.running).toBe(true);
		expect(workers.get("eng-3")![0]!.running).toBe(false);

		// eng-1 posts to @eng-2 and @coordinator, then finishes -> eng-3 automatically takes the freed slot!
		manager.postMessage("eng-1", "@coordinator @eng-2 mod-1 is ready");
		await new Promise((r) => setTimeout(r, 10));
		expect(coordNotifs).toHaveLength(1);
		expect(coordNotifs[0]!.some((p) => p.body.includes("mod-1 is ready"))).toBe(true);
		// eng-2 received the follow-up while already running
		expect(workers.get("eng-2")![0]!.delivered).toHaveLength(2);

		workers.get("eng-1")![0]!.finish();
		// Allow queued microtask/promise for eng-3 to start
		await new Promise((r) => setTimeout(r, 10));
		expect(workers.get("eng-3")![0]!.running).toBe(true);
		expect(manager.getSnapshot()?.counts.working).toBe(2);

		// Finish remaining workers so all return to zero-token waiting state
		workers.get("eng-2")![0]!.finish();
		workers.get("eng-3")![0]!.finish();
		expect(manager.getSnapshot()?.counts.waiting).toBe(3);

		// Worker adds a helper: worker can switch model & kill its own helper, but NOT siblings or title.
		await manager.addWorkers("eng-1", { name: "helper", brief: "Run micro-benchmark" }, host);
		workers.get("helper")![0]!.finish();

		await expect(manager.setTitle("eng-1", "Hijack", host)).rejects.toThrow(/Only the coordinator/);
		await expect(manager.killWorker("eng-1", { name: "eng-2" }, host)).rejects.toThrow(/only kill helpers it added/);

		// Switch model on waiting helper -> updates model and wakes helper
		const switched = await manager.switchModel(
			"eng-1",
			{ name: "helper", model: "Model Beta", reason: "faster" },
			host,
		);
		expect(switched.model).toContain("model-b");
		expect(workers.get("helper")![0]!.currentModel).toContain("model-b");
		expect(workers.get("helper")![0]!.running).toBe(true);

		// Cannot switch model while worker is working
		await expect(manager.switchModel("eng-1", { name: "helper", model: "model-a" }, host)).rejects.toThrow(
			/is working/,
		);

		// Killing eng-1 (by coordinator) does NOT kill eng-1's helper
		await manager.killWorker(COORDINATOR_NAME, { name: "eng-1" }, host);
		expect(manager.getSnapshot()?.members.find((m) => m.name === "eng-1")?.state).toBe("killed");
		expect(manager.getSnapshot()?.members.find((m) => m.name === "helper")?.state).toBe("working");

		// Worker eng-1 can no longer kill helper (and coordinator can kill helper)
		workers.get("helper")![0]!.finish();
		await manager.killWorker(COORDINATOR_NAME, { name: "helper" }, host);
		expect(manager.getSnapshot()?.members.find((m) => m.name === "helper")?.state).toBe("killed");
		expect(persistedLinks.length).toBeGreaterThan(0);

		await manager.dispose();
	});

	it("marks workers stopped across restart and lazily revives them on @mention", async () => {
		const { host, storageRoot } = await createTestHost();
		const { factory: factory1, workers: workers1 } = createFakeWorkerFactory();
		let lastLink: SwarmLinkEntry | undefined;

		const manager1 = new SwarmManager({
			storageRoot,
			workerFactory: factory1,
			debounceMs: 0,
			onPersistLink: (link) => {
				lastLink = link;
			},
		});

		await manager1.addWorkers(COORDINATOR_NAME, { name: "scout", brief: "Map the codebase" }, host);
		const originalSessionFile = manager1.getSnapshot()!.members.find((m) => m.name === "scout")!.sessionFile;
		workers1.get("scout")![0]!.finish();
		await manager1.dispose();

		// New manager instance simulates Pi restart + /resume
		const { factory: factory2, workers: workers2 } = createFakeWorkerFactory();
		const manager2 = new SwarmManager({
			storageRoot,
			workerFactory: factory2,
			debounceMs: 0,
		});
		expect(manager2.restoreFromLink(lastLink!, host)).toBe(true);
		expect(manager2.getSnapshot()?.members.find((m) => m.name === "scout")?.state).toBe("stopped");
		expect(workers2.size).toBe(0); // Not eagerly loaded

		// Mentioning @scout revives it using the persisted session file and delivers the new message
		manager2.postMessage(COORDINATOR_NAME, "@scout Also check packages/tui", { immediate: true });
		await new Promise((r) => setTimeout(r, 10));
		expect(workers2.get("scout")).toHaveLength(1);
		expect(workers2.get("scout")![0]!.input.existingSessionFile).toBe(originalSessionFile);
		expect(workers2.get("scout")![0]!.running).toBe(true);
		expect(workers2.get("scout")![0]!.delivered[0]!.text).toContain("Also check packages/tui");

		await manager2.dispose();
	});

	it("configures per-worker thinkingLevel on add and model switch, supports :level suffix, and clamps to model capabilities", async () => {
		const { host, storageRoot } = await createTestHost();
		const { factory, workers } = createFakeWorkerFactory();
		const coordThinkingSwitches: ThinkingLevel[] = [];

		const manager = new SwarmManager({
			storageRoot,
			workerFactory: factory,
			debounceMs: 0,
			onCoordinatorThinkingLevelSwitch: (level) => coordThinkingSwitches.push(level),
		});

		// Explicit thinkingLevel on a reasoning model
		await manager.addWorkers(
			COORDINATOR_NAME,
			{ name: "thinker", brief: "Analyze design", model: "model-b", thinkingLevel: "high" },
			host,
		);
		expect(workers.get("thinker")![0]!.input.thinkingLevel).toBe("high");
		expect(manager.getSnapshot()?.members.find((m) => m.name === "thinker")?.thinkingLevel).toBe("high");
		expect(formatSwarmStatus(manager.getSnapshot()!)).toContain("thinking: high");
		workers.get("thinker")![0]!.finish();

		// :level suffix in model spec, and explicit thinkingLevel takes precedence over suffix
		await manager.addWorkers(COORDINATOR_NAME, { name: "suffix", brief: "Quick check", model: "model-b:low" }, host);
		expect(workers.get("suffix")![0]!.input.thinkingLevel).toBe("low");
		workers.get("suffix")![0]!.finish();

		await manager.addWorkers(
			COORDINATOR_NAME,
			{ name: "override", brief: "Deep check", model: "model-b:low", thinkingLevel: "medium" },
			host,
		);
		expect(workers.get("override")![0]!.input.thinkingLevel).toBe("medium");
		workers.get("override")![0]!.finish();

		// Clamps to 'off' on non-reasoning model (model-a)
		await manager.addWorkers(
			COORDINATOR_NAME,
			{ name: "plain", brief: "Fast scan", model: "model-a", thinkingLevel: "high" },
			host,
		);
		expect(workers.get("plain")![0]!.input.thinkingLevel).toBe("off");
		workers.get("plain")![0]!.finish();

		// Switch thinkingLevel only (omitting model) keeps current model and updates thinkingLevel
		const levelOnly = await manager.switchModel(
			COORDINATOR_NAME,
			{ name: "thinker", thinkingLevel: "low", reason: "lighter pass" },
			host,
		);
		expect(levelOnly.model).toContain("model-b");
		expect(levelOnly.thinkingLevel).toBe("low");
		expect(workers.get("thinker")![0]!.currentThinkingLevel).toBe("low");
		workers.get("thinker")![0]!.finish();

		// Switching to a non-reasoning model clamps thinkingLevel down to 'off'
		const clampedSwitch = await manager.switchModel(COORDINATOR_NAME, { name: "thinker", model: "model-a" }, host);
		expect(clampedSwitch.model).toContain("model-a");
		expect(clampedSwitch.thinkingLevel).toBe("off");
		expect(workers.get("thinker")![0]!.currentThinkingLevel).toBe("off");
		workers.get("thinker")![0]!.finish();

		// Switching coordinator model + thinkingLevel triggers coordinator callback
		const coordSwitch = await manager.switchModel(
			COORDINATOR_NAME,
			{ name: COORDINATOR_NAME, model: "model-c", thinkingLevel: "high" },
			host,
		);
		expect(coordSwitch.model).toContain("model-c");
		expect(coordSwitch.thinkingLevel).toBe("high");
		expect(coordThinkingSwitches).toEqual(["high"]);

		// Rejects when neither model nor thinkingLevel is supplied
		await expect(manager.switchModel(COORDINATOR_NAME, { name: "thinker" }, host)).rejects.toThrow(
			/At least one of 'model' or 'thinkingLevel'/,
		);

		await manager.dispose();
	});

	it("auto-notifies coordinator on max_turns and silent idle, exposes stopReason in status and inspect", async () => {
		const { host, storageRoot } = await createTestHost();
		const { factory, workers } = createFakeWorkerFactory();
		const coordNotifs: SwarmBoardPost[][] = [];

		const manager = new SwarmManager({
			storageRoot,
			workerFactory: factory,
			debounceMs: 0,
			onCoordinatorNotify: (posts) => coordNotifs.push(posts),
		});

		await manager.addWorkers(COORDINATOR_NAME, { name: "painter", brief: "Paint 3 images", maxTurns: 10 }, host);
		expect(workers.get("painter")![0]!.input.maxTurnsPerWakeup).toBe(10);

		// Worker hits max_turns without posting -> coordinator is notified with reason, turn budget, and lastOutput.
		workers.get("painter")![0]!.finish({
			reason: "max_turns",
			turnsUsed: 10,
			maxTurns: 10,
			lastOutput: "Finished image 01, generated sam.npz for 02",
		});

		expect(coordNotifs).toHaveLength(1);
		expect(coordNotifs[0]!.some((p) => p.body.includes("turn limit (10/10)"))).toBe(true);
		expect(coordNotifs[0]!.some((p) => p.body.includes("Finished image 01"))).toBe(true);

		const statusText = formatSwarmStatus(manager.getSnapshot()!);
		expect(statusText).toContain("waiting:max_turns");
		expect(statusText).toContain("Finished image 01");

		const inspected = manager.inspectWorker("painter", 10);
		expect(inspected.member.lastStopReason).toBe("max_turns");
		expect(inspected.member.lastWakeupTurns).toBe(10);
		expect(formatWorkerInspect(inspected.member, inspected.transcript)).toContain("stop_reason: max_turns");

		// Wake worker again and let it go idle silently without posting -> coordinator is notified!
		manager.postMessage(COORDINATOR_NAME, "@painter continue image 02", { immediate: true });
		await new Promise((r) => setTimeout(r, 10));
		workers.get("painter")![0]!.finish({
			reason: "idle",
			turnsUsed: 4,
			maxTurns: 10,
			lastOutput: "All done silently",
		});
		expect(coordNotifs).toHaveLength(2);
		expect(coordNotifs[1]!.some((p) => p.body.includes("without posting to the board"))).toBe(true);
		expect(coordNotifs[1]!.some((p) => p.body.includes("All done silently"))).toBe(true);

		// Wake worker again; if it posts before going idle, no redundant silent-idle alarm is emitted.
		manager.postMessage(COORDINATOR_NAME, "@painter verify output", { immediate: true });
		await new Promise((r) => setTimeout(r, 10));
		manager.postMessage("painter", "@coordinator Verified all outputs.");
		const notifCountAfterPost = coordNotifs.length;
		workers.get("painter")![0]!.finish({ reason: "idle", turnsUsed: 2, maxTurns: 10 });
		expect(coordNotifs).toHaveLength(notifCountAfterPost);

		await manager.dispose();
	});

	it("runs bounded task pools (tasks + concurrency), pulls next task on idle, pauses on max_turns, and supports batch board_post", async () => {
		const { host, storageRoot } = await createTestHost();
		const { factory, workers } = createFakeWorkerFactory();
		const coordNotifs: SwarmBoardPost[][] = [];

		const manager = new SwarmManager({
			storageRoot,
			workerFactory: factory,
			debounceMs: 0,
			onCoordinatorNotify: (posts) => coordNotifs.push(posts),
		});

		const addRes = await manager.addWorkers(
			COORDINATOR_NAME,
			{
				name: "img",
				brief: "Process assigned image",
				tasks: ["01.jpg", "02.jpg", "03.jpg", "04.jpg"],
				concurrency: 2,
			},
			host,
		);

		expect(addRes.added).toEqual(["img-1", "img-2"]);
		expect(addRes.queuedCount).toBe(2);
		expect(addRes.snapshot.taskPools).toHaveLength(1);
		expect(workers.get("img-1")![0]!.delivered[0]!.text).toContain("01.jpg");
		expect(workers.get("img-2")![0]!.delivered[0]!.text).toContain("02.jpg");

		// img-1 finishes 01.jpg cleanly -> automatically pulls 03.jpg without waking coordinator.
		workers.get("img-1")![0]!.finish({ reason: "idle", turnsUsed: 6 });
		await new Promise((r) => setTimeout(r, 10));
		expect(coordNotifs).toHaveLength(0);
		expect(workers.get("img-1")![0]!.running).toBe(true);
		expect(workers.get("img-1")![0]!.delivered[1]!.text).toContain("03.jpg");
		expect(manager.getSnapshot()!.taskPools[0]!.completed).toHaveLength(1);
		expect(manager.getSnapshot()!.taskPools[0]!.pending).toHaveLength(1);

		// img-2 hits max_turns on 02.jpg -> stays paused on 02.jpg and wakes coordinator!
		workers
			.get("img-2")![0]!
			.finish({ reason: "max_turns", turnsUsed: 25, maxTurns: 25, lastOutput: "Halfway on 02" });
		expect(coordNotifs).toHaveLength(1);
		expect(coordNotifs[0]!.some((p) => p.body.includes("task #2/4"))).toBe(true);
		expect(manager.getSnapshot()!.taskPools[0]!.inFlight["img-2"]?.task).toBe("02.jpg");

		// Coordinator uses batch board_post to resume img-2 and nudge img-1 in one call.
		const batch = manager.postBatchMessages(COORDINATOR_NAME, [
			{ to: "img-2", message: "continue 02.jpg" },
			{ to: "@img-1", message: "keep default layer names" },
		]);
		expect(batch.posts).toHaveLength(2);
		expect(batch.woken.sort()).toEqual(["img-1", "img-2"]);
		await new Promise((r) => setTimeout(r, 10));
		expect(workers.get("img-2")![0]!.running).toBe(true);

		// img-2 finishes 02.jpg -> pulls final queued task 04.jpg
		workers.get("img-2")![0]!.finish({ reason: "idle", turnsUsed: 3 });
		await new Promise((r) => setTimeout(r, 10));
		expect(workers.get("img-2")![0]!.delivered.at(-1)!.text).toContain("04.jpg");

		// Both finish -> pool completion automatically wakes coordinator!
		workers.get("img-1")![0]!.finish({ reason: "idle", turnsUsed: 5 });
		workers.get("img-2")![0]!.finish({ reason: "idle", turnsUsed: 4 });
		expect(coordNotifs).toHaveLength(2);
		expect(coordNotifs[1]!.some((p) => p.body.includes("Task pool 'img' completed: 4/4 done"))).toBe(true);
		expect(formatSwarmStatus(manager.getSnapshot()!)).toContain("4/4 done");

		await manager.dispose();
	});
});

describe("defaultSwarmWorkspaceOps git isolation", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function initGitRepo(): string {
		const repoDir = makeTempDir("pi-swarm-git-");
		tempDirs.push(repoDir);
		execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" });
		writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
		execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
		return repoDir;
	}

	it("provisions isolated git worktree (share), guards unlanded commits, and cleans up after merge", async () => {
		const repoDir = initGitRepo();
		const swarmDir = makeTempDir("pi-swarm-dir-");
		tempDirs.push(swarmDir);

		const provisioned = await defaultSwarmWorkspaceOps.provision({
			mode: "share",
			baseCwd: repoDir,
			swarmDir,
			swarmId: "sw-test",
			memberName: "parser",
		});

		expect(provisioned.gitBranch).toBe("swarm/sw-test/parser");
		expect(existsSync(join(provisioned.cwd, "README.md"))).toBe(true);
		// Initially clean: no unlanded work
		expect(await defaultSwarmWorkspaceOps.checkUnlandedWork({ mode: "share", ...provisioned })).toBeUndefined();

		// Uncommitted edit blocks kill
		writeFileSync(join(provisioned.cwd, "parser.ts"), "export const x = 1;\n", "utf-8");
		const dirtyReason = await defaultSwarmWorkspaceOps.checkUnlandedWork({ mode: "share", ...provisioned });
		expect(dirtyReason).toContain("uncommitted change");

		// Committing on branch still blocks kill until merged into host HEAD
		execFileSync("git", ["add", "parser.ts"], { cwd: provisioned.cwd, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "add parser"], { cwd: provisioned.cwd, stdio: "ignore" });
		const unmergedReason = await defaultSwarmWorkspaceOps.checkUnlandedWork({ mode: "share", ...provisioned });
		expect(unmergedReason).toContain("unmerged commit");

		// Merge branch into host repo -> now clean to kill and clean up!
		execFileSync("git", ["merge", "--ff-only", provisioned.gitBranch!], { cwd: repoDir, stdio: "ignore" });
		expect(existsSync(join(repoDir, "parser.ts"))).toBe(true);
		expect(await defaultSwarmWorkspaceOps.checkUnlandedWork({ mode: "share", ...provisioned })).toBeUndefined();

		await defaultSwarmWorkspaceOps.cleanup({ mode: "share", ...provisioned });
		expect(existsSync(provisioned.workspacePath!)).toBe(false);
	});

	it("provisions and cleans up an isolated local git clone (branch)", async () => {
		const repoDir = initGitRepo();
		const swarmDir = makeTempDir("pi-swarm-clone-");
		tempDirs.push(swarmDir);

		const provisioned = await defaultSwarmWorkspaceOps.provision({
			mode: "branch",
			baseCwd: repoDir,
			swarmDir,
			swarmId: "sw-clone",
			memberName: "exp",
		});

		expect(existsSync(join(provisioned.cwd, ".git"))).toBe(true);
		await defaultSwarmWorkspaceOps.cleanup({ mode: "branch", ...provisioned });
		expect(existsSync(provisioned.workspacePath!)).toBe(false);
	});

	it("symlinks requested untracked dependency paths into worktrees and warns when common deps are unlinked", async () => {
		const repoDir = initGitRepo();
		writeFileSync(join(repoDir, ".gitignore"), ".venv/\n", "utf-8");
		execFileSync("git", ["add", ".gitignore"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "ignore venv"], { cwd: repoDir, stdio: "ignore" });
		mkdirSync(join(repoDir, ".venv"), { recursive: true });
		writeFileSync(join(repoDir, ".venv", "marker.txt"), "host-venv\n", "utf-8");

		const swarmDir = makeTempDir("pi-swarm-symlink-");
		tempDirs.push(swarmDir);

		// Without symlinkPaths: warns that .venv exists in host repo
		const unlinked = await defaultSwarmWorkspaceOps.provision({
			mode: "share",
			baseCwd: repoDir,
			swarmDir,
			swarmId: "sw-sym",
			memberName: "w1",
		});
		expect(unlinked.warnings?.some((w) => w.includes(".venv"))).toBe(true);
		await defaultSwarmWorkspaceOps.cleanup({ mode: "share", ...unlinked });

		// With symlinkPaths: .venv is symlinked, checkUnlandedWork stays clean, and cleanup preserves host .venv!
		const linked = await defaultSwarmWorkspaceOps.provision({
			mode: "share",
			baseCwd: repoDir,
			swarmDir,
			swarmId: "sw-sym",
			memberName: "w2",
			symlinkPaths: [".venv"],
		});
		expect(linked.symlinked).toEqual([".venv"]);
		expect(readFileSync(join(linked.cwd, ".venv", "marker.txt"), "utf-8")).toBe("host-venv\n");
		expect(
			await defaultSwarmWorkspaceOps.checkUnlandedWork({
				mode: "share",
				...linked,
				symlinkPaths: linked.symlinked,
			}),
		).toBeUndefined();

		await defaultSwarmWorkspaceOps.cleanup({ mode: "share", ...linked, symlinkPaths: linked.symlinked });
		expect(existsSync(join(repoDir, ".venv", "marker.txt"))).toBe(true);
	});
});

describe("swarm built-in extension integration (faux provider + TUI board)", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const h = harnesses.pop()!;
			await emitSessionShutdownEvent(h.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			h.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	async function setup(
		options: HarnessOptions = {},
		extOpts?: Parameters<typeof createSwarmExtension>[0],
	): Promise<{ harness: Harness; storageRoot: string }> {
		const storageRoot = makeTempDir("pi-swarm-int-");
		tempDirs.push(storageRoot);
		const factory = createSwarmExtension({ storageRoot, debounceMs: 10, ...extOpts });
		const harness = await createHarness({ ...options, extensionFactories: [factory] });
		harnesses.push(harness);
		return { harness, storageRoot };
	}

	function waitForSettledCount(harness: Harness, targetCount: number, timeoutMs = 6_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (harness.eventsOfType("agent_settled").length >= targetCount && !harness.session.isStreaming) {
					cleanup();
					resolve();
				}
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(
					new Error(
						`Timed out waiting for ${targetCount} settled runs (got ${harness.eventsOfType("agent_settled").length})`,
					),
				);
			}, timeoutMs);
			const unsub = harness.session.subscribe(() => check());
			const cleanup = () => {
				clearTimeout(timer);
				unsub();
			};
			check();
		});
	}

	it("is registered in builtInExtensions as replaceable", () => {
		expect(builtInExtensions).toContainEqual({
			name: "swarm",
			factory: swarmExtension,
			replaceable: true,
			builtin: true,
		});
	});

	it("runs a real in-process Agent worker that posts to the board and wakes the idle coordinator", async () => {
		const { harness } = await setup();

		// Route responses by inspecting whether the prompt is from the coordinator or the @builder worker!
		let coordinatorStep = 0;
		let workerStep = 0;
		const router = (context: { messages: unknown[] }) => {
			const text = context.messages.map(getMessageText).join("\n");
			const isBuilder = text.includes('You are swarm worker "@builder"');
			if (isBuilder) {
				workerStep++;
				if (workerStep === 1) {
					return fauxAssistantMessage(
						[
							fauxToolCall("write", { path: "hello.txt", content: "from swarm worker\n" }),
							fauxToolCall("board_post", { message: "@coordinator Wrote hello.txt and verified." }),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Posted update to board; standing by.");
			}

			coordinatorStep++;
			if (coordinatorStep === 1) {
				return fauxAssistantMessage(
					fauxToolCall("swarm", {
						action: "add",
						name: "builder",
						brief: "Create hello.txt and post to @coordinator when done.",
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (coordinatorStep === 2) {
				return fauxAssistantMessage("Spawned @builder, waiting for its board update.");
			}
			expect(text).toContain("Wrote hello.txt and verified.");
			return fauxAssistantMessage("Coordinator received @builder completion.");
		};

		harness.setResponses([router, router, router, router, router]);

		await harness.session.prompt("Delegate hello.txt creation to a swarm worker");
		await waitForSettledCount(harness, 2);

		expect(existsSync(join(harness.tempDir, "hello.txt"))).toBe(true);
		expect(readFileSync(join(harness.tempDir, "hello.txt"), "utf-8")).toBe("from swarm worker\n");
		expect(getAssistantTexts(harness).filter(Boolean)).toEqual([
			"Spawned @builder, waiting for its board update.",
			"Coordinator received @builder completion.",
		]);
	});

	it("forks coordinator conversation history into a worker when fork='coordinator' is requested", async () => {
		const { harness } = await setup();
		let forkedWorkerSawPriorContext = false;
		let workerStep = 0;

		const router = (context: { messages: unknown[] }) => {
			const text = context.messages.map(getMessageText).join("\n");
			if (text.includes('You are swarm worker "@analyst"')) {
				workerStep++;
				if (text.includes("SECRET_DESIGN_TOKEN_42")) {
					forkedWorkerSawPriorContext = true;
				}
				if (workerStep === 1) {
					return fauxAssistantMessage(
						fauxToolCall("board_post", { message: "@coordinator Confirmed forked history." }),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Standing by.");
			}
			if (text.includes("Confirmed forked history.")) {
				return fauxAssistantMessage("Forked worker reported back.");
			}
			if (text.includes("Spawned @analyst")) {
				return fauxAssistantMessage("Waiting on @analyst.");
			}
			if (text.includes("Fork analyst now")) {
				return fauxAssistantMessage(
					fauxToolCall("swarm", {
						action: "add",
						name: "analyst",
						fork: "coordinator",
						brief: "Check prior context and report to @coordinator.",
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Noted SECRET_DESIGN_TOKEN_42.");
		};

		harness.setResponses([router, router, router, router, router, router]);
		await harness.session.prompt("Remember SECRET_DESIGN_TOKEN_42 for the team");
		await harness.session.prompt("Fork analyst now");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for coordinator to receive forked worker report")),
				5_000,
			);
			const check = () => {
				if (getAssistantTexts(harness).includes("Forked worker reported back.") && !harness.session.isStreaming) {
					clearTimeout(timer);
					unsub();
					resolve();
				}
			};
			const unsub = harness.session.subscribe(() => check());
			check();
		});

		expect(forkedWorkerSawPriorContext).toBe(true);
		expect(getAssistantTexts(harness)).toContain("Forked worker reported back.");
	});

	it("wakes coordinator automatically when a real worker hits maxTurns and allows inspecting its transcript", async () => {
		const { harness } = await setup();
		let sawMaxTurnsNotice = false;
		let sawInspectResult = false;
		let coordinatorStep = 0;

		const router = (context: { messages: unknown[] }) => {
			const text = context.messages.map(getMessageText).join("\n");
			if (text.includes('You are swarm worker "@runner"')) {
				// Return a toolCall so turn 1 finishes with finishTurn -> max_turns!
				return fauxAssistantMessage([fauxToolCall("write", { path: "partial.txt", content: "step-1\n" })], {
					stopReason: "toolUse",
				});
			}

			coordinatorStep++;
			if (coordinatorStep === 1) {
				return fauxAssistantMessage(
					fauxToolCall("swarm", {
						action: "add",
						name: "runner",
						maxTurns: 1,
						brief: "Run multi-step pipeline.",
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (coordinatorStep === 2) {
				return fauxAssistantMessage("Spawned @runner.");
			}
			if (coordinatorStep === 3) {
				if (text.includes("hit the per-wakeup turn limit (1/1)")) {
					sawMaxTurnsNotice = true;
				}
				return fauxAssistantMessage(
					fauxToolCall("swarm", {
						action: "inspect",
						name: "runner",
						limit: 10,
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (text.includes("stop_reason: max_turns") && text.includes("write: partial.txt")) {
				sawInspectResult = true;
			}
			return fauxAssistantMessage("Inspected @runner after max_turns.");
		};

		harness.setResponses([router, router, router, router, router, router]);
		await harness.session.prompt("Start runner worker with maxTurns=1");
		await waitForSettledCount(harness, 2);

		expect(sawMaxTurnsNotice).toBe(true);
		expect(sawInspectResult).toBe(true);
		expect(getAssistantTexts(harness)).toContain("Inspected @runner after max_turns.");
	});

	it("supports /swarm commands, renders board view with configurable keybindings, and renders themed status", async () => {
		initTheme("dark", false);
		const notifications: Array<{ text: string; level?: string }> = [];
		const { factory, workers } = createFakeWorkerFactory();
		const { harness } = await setup({}, { workerFactory: factory });

		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (text, level) => notifications.push({ text, level }),
			}),
		});

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("swarm", {
					action: "add",
					name: "reviewer",
					brief: "Audit auth code",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Reviewer started."),
		]);
		await harness.session.prompt("Add a reviewer worker");
		expect(workers.get("reviewer")![0]!.running).toBe(true);

		await harness.session.prompt("/swarm title Security Audit");
		expect(notifications.some((n) => n.text.includes('Swarm title set to "Security Audit"'))).toBe(true);

		await harness.session.prompt("/swarm status");
		expect(notifications.some((n) => n.text.replace(/\x1b\[[0-9;]*m/g, "").includes("Swarm: Security Audit"))).toBe(
			true,
		);

		await harness.session.prompt("/swarm stop");
		expect(workers.get("reviewer")![0]!.aborted).toBe(true);

		// Render SwarmBoardView directly and verify configurable keybinding actions
		const storageRoot = makeTempDir("pi-swarm-view-");
		tempDirs.push(storageRoot);
		const viewManager = new SwarmManager({ storageRoot, workerFactory: factory, debounceMs: 0 });
		const host: SwarmHostContext = {
			cwd: harness.tempDir,
			model: harness.getModel(),
			thinkingLevel: "off",
			modelRegistry: new ModelRegistry(harness.session.modelRuntime),
		};
		await viewManager.setTitle(COORDINATOR_NAME, "Board UI Test", host);
		await viewManager.addWorkers(COORDINATOR_NAME, { name: "parser", brief: "Build parser" }, host);
		viewManager.postMessage(USER_AUTHOR, "@parser check edge cases");

		let closed = false;
		const fakeTui = {
			terminal: { rows: 24, columns: 100 },
			requestRender: () => {},
			onTerminalFocusChange: () => () => {},
			getTerminalFocused: () => true,
			getShowHardwareCursor: () => false,
		} as unknown as TUI;
		const keybindings = new KeybindingsManager({
			"app.swarm.close": "ctrl+q",
			"app.swarm.switchPane": "tab",
		});

		const view = new SwarmBoardView({
			tui: fakeTui,
			theme,
			keybindings,
			manager: viewManager,
			onDone: () => {
				closed = true;
			},
		});

		const wideLines = view.render(100);
		const wideJoined = wideLines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(wideJoined).toContain("Board UI Test");
		expect(wideJoined).toContain("@parser");
		expect(wideJoined).toContain("[Board]");
		expect(wideJoined).toContain("check edge cases");

		// Long post folds by default and expands on click
		const longBody = Array.from({ length: 12 }, (_, idx) => `- Step ${idx + 1}: detail line`).join("\n");
		viewManager.postMessage(USER_AUTHOR, `@parser\n${longBody}`);
		const foldedRender = view
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(foldedRender).toContain("more lines");

		// Wheel over right pane is captured (prevents background scroll leak)
		const wheelResult = view.handleMouse({
			type: "wheel",
			button: "none",
			x: 60,
			y: 6,
			screenX: 60,
			screenY: 6,
			width: 100,
			height: 24,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: -3,
		});
		expect(wheelResult?.handled).toBe(true);

		// Clicking [Inspector] tab switches to Inspector mode
		const tabClick = view.handleMouse({
			type: "click",
			button: "left",
			x: 39,
			y: 1,
			screenX: 39,
			screenY: 1,
			width: 100,
			height: 24,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});
		expect(tabClick?.handled).toBe(true);
		const inspectorViaClick = view
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(inspectorViaClick).toContain("[Inspector");

		// Switch pane with Tab and toggle back/forth with Ctrl+O
		view.handleInput("\t");
		view.handleInput("\x0f"); // ctrl+o (app.tools.expand)
		const backToBoard = view
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(backToBoard).toContain("[Board]");

		// Narrow layout renders cleanly
		expect(view.render(60).length).toBeGreaterThan(0);

		// Custom close binding (ctrl+q) closes view
		view.handleInput("\x11");
		expect(closed).toBe(true);
		view.dispose();

		// Render helpers produce themed output
		const snap: SwarmSnapshot = viewManager.getSnapshot()!;
		expect(renderSwarmFooterStatus(snap, theme)).toContain("swarm:");
		expect(renderThemedSwarmStatus(snap, theme)).toContain("Board UI Test");
		const notifBox = renderSwarmNotificationMessage(
			{
				role: "custom",
				customType: "swarm-board-notification",
				content: "raw content",
				display: true,
				timestamp: Date.now(),
				details: {
					swarmId: snap.id,
					title: snap.title,
					posts: [...viewManager.getPosts()],
				},
			},
			{ expanded: true, outputPad: 1, keyText: () => "", keyHint: () => "" },
			theme,
		);
		expect(notifBox).toBeDefined();

		await viewManager.dispose();
	});
});

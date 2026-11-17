import { existsSync, readFileSync, type WriteStream } from "node:fs";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import bgTaskExtension, { createBgTaskExtension } from "../../src/extensions/bg-task/index.ts";
import { type BgProcessSpawner, BgTaskManager, type SpawnedBgProcess } from "../../src/extensions/bg-task/manager.ts";
import { renderBgFooterStatus, renderThemedTaskList } from "../../src/extensions/bg-task/render.ts";
import { type BgTaskEvent, type BgTaskSnapshot, DEFAULT_LEASE_SECONDS } from "../../src/extensions/bg-task/types.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

interface FakeProcHandle {
	pid: number;
	killed: boolean;
	stdinLog: string[];
	stdinClosed: boolean;
	emitOutput: (text: string) => void;
	finish: (exitCode: number) => void;
}

function createFakeSpawner(): {
	spawner: BgProcessSpawner;
	handles: FakeProcHandle[];
} {
	const handles: FakeProcHandle[] = [];
	let nextPid = 10_000;

	const spawner: BgProcessSpawner = async ({ onData }) => {
		let resolveExit!: (res: { exitCode: number }) => void;
		const exited = new Promise<{ exitCode: number }>((resolve) => {
			resolveExit = resolve;
		});
		let settled = false;

		const handle: FakeProcHandle = {
			pid: nextPid++,
			killed: false,
			stdinLog: [],
			stdinClosed: false,
			emitOutput: (text: string) => {
				if (!settled) {
					onData(Buffer.from(text, "utf-8"));
				}
			},
			finish: (exitCode: number) => {
				if (settled) return;
				settled = true;
				resolveExit({ exitCode });
			},
		};
		handles.push(handle);

		const proc: SpawnedBgProcess = {
			pid: handle.pid,
			writeStdin: (input: string, close?: boolean) => {
				if (handle.stdinClosed) throw new Error("stdin closed");
				if (input) handle.stdinLog.push(input);
				if (close) handle.stdinClosed = true;
			},
			kill: () => {
				handle.killed = true;
				handle.finish(137);
			},
			exited,
		};
		return proc;
	};

	return { spawner, handles };
}

function createMemoryLogStream() {
	return () => {
		const stream = new PassThrough() as unknown as WriteStream;
		return { path: `/tmp/fake-bg-${Math.random().toString(36).slice(2)}.log`, stream };
	};
}

describe("BgTaskManager state machine", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses 300s default soft lease, keeps process alive on lease_expired, and extends non-destructively", async () => {
		vi.useFakeTimers();
		let clock = 1_000_000;
		const { spawner, handles } = createFakeSpawner();
		const batches: BgTaskEvent[][] = [];

		const manager = new BgTaskManager({
			spawner,
			createLogStream: createMemoryLogStream(),
			graceSeconds: 90,
			debounceMs: 500,
			now: () => clock,
			onNotify: (events) => batches.push(events),
		});

		const started = await manager.start({
			command: "cargo build --release",
			cwd: "/tmp",
		});
		expect(started.id).toBe("bg-1");
		expect(started.status).toBe("running");
		expect(started.leaseSeconds).toBe(DEFAULT_LEASE_SECONDS);
		expect(manager.getStatusText()).toBe("bg: 1 running");

		const proc = handles[0]!;
		clock += 290_000;
		proc.emitOutput("Compiling crate 380/420\n");
		await vi.advanceTimersByTimeAsync(290_000);
		expect(manager.get("bg-1")?.status).toBe("running");
		expect(proc.killed).toBe(false);

		// Hit 300s soft lease: process must NOT be killed, status becomes lease_expired
		clock += 10_000;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(proc.killed).toBe(false);
		expect(manager.get("bg-1")?.status).toBe("lease_expired");
		expect(manager.getStatusText()).toBe("bg: 1 lease-expired");

		// Flush 500ms notification debounce
		clock += 500;
		await vi.advanceTimersByTimeAsync(500);
		expect(batches).toHaveLength(1);
		expect(batches[0]![0]!.kind).toBe("lease_expired");
		expect(batches[0]![0]!.incrementalOutput).toContain("Compiling crate 380/420");
		expect(batches[0]![0]!.task.idleSeconds).toBe(10);

		// Agent decides the build really is long and extends by 600s
		const extended = manager.extend("bg-1", 600);
		expect(extended.status).toBe("running");
		expect(extended.leaseSeconds).toBe(600);
		expect(manager.getStatusText()).toBe("bg: 1 running");

		// Advance past the old 90s grace window: process must STILL be alive!
		clock += 120_000;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(proc.killed).toBe(false);
		expect(manager.get("bg-1")?.status).toBe("running");

		// Build finishes cleanly
		proc.emitOutput("Finished release target\n");
		proc.finish(0);
		await vi.advanceTimersByTimeAsync(0);
		clock += 500;
		await vi.advanceTimersByTimeAsync(500);

		expect(batches).toHaveLength(2);
		expect(batches[1]![0]!.kind).toBe("completed");
		expect(batches[1]![0]!.task.status).toBe("completed");
		expect(batches[1]![0]!.incrementalOutput).toContain("Finished release target");
		expect(manager.getStatusText()).toBeUndefined();

		await manager.dispose();
	});

	it("terminates process and notifies timed_out when grace period expires without extension", async () => {
		vi.useFakeTimers();
		let clock = 1_000_000;
		const { spawner, handles } = createFakeSpawner();
		const batches: BgTaskEvent[][] = [];

		const manager = new BgTaskManager({
			spawner,
			createLogStream: createMemoryLogStream(),
			graceSeconds: 30,
			debounceMs: 0,
			now: () => clock,
			onNotify: (events) => batches.push(events),
		});

		await manager.start({ command: "hung-cmd", cwd: "/tmp", leaseSeconds: 10 });
		const proc = handles[0]!;

		clock += 10_000;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(proc.killed).toBe(false);
		expect(batches.map((b) => b[0]!.kind)).toEqual(["lease_expired"]);

		clock += 30_000;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(proc.killed).toBe(true);
		expect(manager.get("bg-1")?.status).toBe("timed_out");
		expect(batches.map((b) => b[0]!.kind)).toEqual(["lease_expired", "timed_out"]);

		await manager.dispose();
	});

	it("coalesces simultaneous completions and drops stale lease_expired events extended within debounce", async () => {
		vi.useFakeTimers();
		let clock = 1_000_000;
		const { spawner, handles } = createFakeSpawner();
		const batches: BgTaskEvent[][] = [];

		const manager = new BgTaskManager({
			spawner,
			createLogStream: createMemoryLogStream(),
			graceSeconds: 60,
			debounceMs: 500,
			now: () => clock,
			onNotify: (events) => batches.push(events),
		});

		await manager.start({ command: "job-1", cwd: "/tmp", leaseSeconds: 60 });
		await manager.start({ command: "job-2", cwd: "/tmp", leaseSeconds: 60 });
		await manager.start({ command: "job-3", cwd: "/tmp", leaseSeconds: 10 });

		// At t=10s: job-1 & job-2 finish within 100ms, job-3 hits lease_expired then gets immediately extended
		clock += 10_000;
		await vi.advanceTimersByTimeAsync(10_000);
		handles[0]!.finish(0);
		handles[1]!.finish(2);
		await vi.advanceTimersByTimeAsync(0);
		manager.extend("bg-3", 120);

		clock += 500;
		await vi.advanceTimersByTimeAsync(500);

		expect(batches).toHaveLength(1);
		expect(batches[0]!.map((ev) => `${ev.task.id}:${ev.kind}`)).toEqual(["bg-1:completed", "bg-2:failed"]);

		await manager.dispose();
	});

	it("supports delayed, recurring command tasks, notify_on filtering, pure timers, and send_input", async () => {
		vi.useFakeTimers();
		let clock = 1_000_000;
		const { spawner, handles } = createFakeSpawner();
		const batches: BgTaskEvent[][] = [];

		const manager = new BgTaskManager({
			spawner,
			createLogStream: createMemoryLogStream(),
			debounceMs: 0,
			now: () => clock,
			onNotify: (events) => batches.push(events),
		});

		// Recurring watchdog notifying only on failure
		const watchdog = await manager.start({
			command: "check-health",
			cwd: "/tmp",
			intervalSeconds: 20,
			notifyOn: "failure",
		});
		expect(watchdog.status).toBe("scheduled");

		// Pure one-shot timer reminder without a shell command
		const reminder = await manager.start({
			label: "Check deployment status",
			cwd: "/tmp",
			delaySeconds: 15,
		});
		expect(reminder.status).toBe("scheduled");

		// At t=15s: pure timer triggers
		clock += 15_000;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(batches).toHaveLength(1);
		expect(batches[0]![0]!.kind).toBe("timer_triggered");
		expect(manager.get(reminder.id)?.status).toBe("completed");

		// At t=20s: watchdog run #1 starts and succeeds -> silent because notifyOn="failure"
		clock += 5_000;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(handles).toHaveLength(1);
		manager.sendInput(watchdog.id, "ping\n", true);
		expect(handles[0]!.stdinLog).toEqual(["ping\n"]);
		expect(handles[0]!.stdinClosed).toBe(true);
		handles[0]!.finish(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(batches).toHaveLength(1);
		expect(manager.get(watchdog.id)?.status).toBe("scheduled");

		// Next interval (+20s): watchdog run #2 fails -> notifies!
		clock += 20_000;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(handles).toHaveLength(2);
		handles[1]!.emitOutput("502 Bad Gateway\n");
		handles[1]!.finish(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(batches).toHaveLength(2);
		expect(batches[1]![0]!.kind).toBe("failed");
		expect(batches[1]![0]!.task.runCount).toBe(2);

		const cleared = manager.clearFinished();
		expect(cleared).toBe(1); // reminder cleared, watchdog still scheduled

		await manager.kill(watchdog.id);
		expect(manager.get(watchdog.id)?.status).toBe("cancelled");

		await manager.dispose();
	});
});

describe("bg-task built-in extension integration", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const h = harnesses.pop()!;
			await emitSessionShutdownEvent(h.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			h.cleanup();
		}
	});

	async function setup(
		options: HarnessOptions = {},
		extOpts?: Parameters<typeof createBgTaskExtension>[0],
	): Promise<Harness> {
		const factory = extOpts ? createBgTaskExtension(extOpts) : bgTaskExtension;
		const harness = await createHarness({ ...options, extensionFactories: [factory] });
		harnesses.push(harness);
		return harness;
	}

	function waitForIdleTurnCount(harness: Harness, targetCount: number, timeoutMs = 5_000): Promise<void> {
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
			name: "bg-task",
			factory: bgTaskExtension,
			replaceable: true,
			builtin: true,
		});
	});

	it("wakes an idle agent when a background shell task finishes and persists log output", async () => {
		const harness = await setup({}, { debounceMs: 20 });

		let capturedLogPath: string | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bg_task", {
					action: "start",
					label: "Echo build",
					command: 'printf "step-1\\nstep-2-done\\n"',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Started in background, waiting for completion."),
			(context) => {
				const allText = context.messages.map(getMessageText).join("\n");
				expect(allText).toContain("[Background task completed: bg-1]");
				expect(allText).toContain("step-2-done");
				const match = /Full log: ([^\n]+)/.exec(allText);
				capturedLogPath = match?.[1]?.trim();
				return fauxAssistantMessage("Background build finished with step-2-done.");
			},
		]);

		await harness.session.prompt("Run echo build in background");
		await waitForIdleTurnCount(harness, 2);

		expect(getAssistantTexts(harness).filter(Boolean)).toEqual([
			"Started in background, waiting for completion.",
			"Background build finished with step-2-done.",
		]);
		expect(capturedLogPath).toBeDefined();
		expect(existsSync(capturedLogPath!)).toBe(true);
		expect(readFileSync(capturedLogPath!, "utf-8")).toContain("step-2-done");
	});

	it("lets the AI extend a task on lease_expired without interrupting the running process", async () => {
		const harness = await setup({}, { debounceMs: 10, graceSeconds: 10 });

		harness.setResponses([
			// Turn 1: start a ~0.45s command with a short 0.15s initial lease
			fauxAssistantMessage(
				fauxToolCall("bg_task", {
					action: "start",
					label: "Multi-stage job",
					command:
						'node -e \'process.stdout.write("stage-1\\n"); setTimeout(() => { process.stdout.write("stage-2-complete\\n"); }, 450);\'',
					lease_seconds: 0.15,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Job started."),
			// Turn 2 (triggered by lease_expired): inspect stage-1 and extend lease to 5s
			(context) => {
				const allText = context.messages.map(getMessageText).join("\n");
				expect(allText).toContain("[Background task lease expired: bg-1 - still running]");
				expect(allText).toContain("stage-1");
				return fauxAssistantMessage(
					fauxToolCall("bg_task", {
						action: "extend",
						id: "bg-1",
						lease_seconds: 5,
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Extended lease since stage-1 is progressing."),
			// Turn 3 (triggered by completion): sees stage-2-complete!
			(context) => {
				const allText = context.messages.map(getMessageText).join("\n");
				expect(allText).toContain("[Background task completed: bg-1]");
				expect(allText).toContain("stage-2-complete");
				return fauxAssistantMessage("Multi-stage job completed.");
			},
		]);

		await harness.session.prompt("Run multi-stage job");
		await waitForIdleTurnCount(harness, 3);

		expect(getAssistantTexts(harness).filter(Boolean)).toEqual([
			"Job started.",
			"Extended lease since stage-1 is progressing.",
			"Multi-stage job completed.",
		]);
	});

	it("queues background notifications via followUp without steering/aborting an active foreground tool turn", async () => {
		let finishSlowTool!: () => void;
		let markSlowEntered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			markSlowEntered = resolve;
		});
		const releasePromise = new Promise<void>((resolve) => {
			finishSlowTool = resolve;
		});

		const executionOrder: string[] = [];
		const harness = await setup(
			{
				tools: [
					{
						name: "slow_fg",
						label: "slow_fg",
						description: "Slow foreground tool",
						executionMode: "sequential",
						parameters: Type.Object({}),
						execute: async () => {
							executionOrder.push("slow_fg:start");
							markSlowEntered();
							await releasePromise;
							executionOrder.push("slow_fg:end");
							return { content: [{ type: "text", text: "slow_fg done" }], details: {} };
						},
					},
					{
						name: "second_fg",
						label: "second_fg",
						description: "Second foreground tool in the same turn",
						executionMode: "sequential",
						parameters: Type.Object({}),
						execute: async () => {
							executionOrder.push("second_fg:ran");
							return { content: [{ type: "text", text: "second_fg done" }], details: {} };
						},
					},
				],
			},
			{ debounceMs: 5 },
		);

		harness.setResponses([
			// Start a fast background timer (20ms), then call two sequential foreground tools
			fauxAssistantMessage(
				[
					fauxToolCall("bg_task", {
						action: "start",
						label: "Quick reminder",
						delay_seconds: 0.02,
					}),
					fauxToolCall("slow_fg", {}),
					fauxToolCall("second_fg", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Foreground tools finished."),
			(context) => {
				const allText = context.messages.map(getMessageText).join("\n");
				expect(allText).toContain("[Scheduled timer triggered: bg-1 (run #1)]");
				return fauxAssistantMessage("Handled queued timer after foreground turn.");
			},
		]);

		const promptPromise = harness.session.prompt("Start timer and run foreground tools");
		await enteredPromise;
		// Wait long enough for the 20ms background timer + 5ms debounce to fire while slow_fg is running
		await new Promise((r) => setTimeout(r, 60));
		finishSlowTool();
		await promptPromise;
		await waitForIdleTurnCount(harness, 1);

		// Because deliverAs: "followUp" was used instead of default "steer", second_fg was NOT skipped!
		expect(executionOrder).toEqual(["slow_fg:start", "slow_fg:end", "second_fg:ran"]);
		expect(getAssistantTexts(harness)).toContain("Handled queued timer after foreground turn.");
	});

	it("supports /bg commands and cleans up active processes on session_shutdown", async () => {
		const notifications: Array<{ text: string; level?: string }> = [];
		const { spawner, handles } = createFakeSpawner();
		const harness = await setup({}, { spawner, debounceMs: 0 });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (text, level) => notifications.push({ text, level }),
			}),
		});

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bg_task", {
					action: "start",
					label: "Long server",
					command: "node server.js",
					lease_seconds: 120,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Server running."),
		]);
		await harness.session.prompt("Start server");
		expect(handles).toHaveLength(1);
		expect(handles[0]!.killed).toBe(false);

		await harness.session.prompt("/bg extend bg-1 900");
		expect(
			notifications.some((n) => n.text.replace(/\x1b\[[0-9;]*m/g, "").includes("Extended [bg-1] lease by 900s")),
		).toBe(true);

		await harness.session.prompt("/bg status bg-1");
		expect(
			notifications.some((n) =>
				n.text.replace(/\x1b\[[0-9;]*m/g, "").includes("Task [bg-1] (running): Long server"),
			),
		).toBe(true);

		// Emitting session_shutdown (as AgentSessionRuntime.dispose / reload does) kills active child processes
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		expect(handles[0]!.killed).toBe(true);
	});

	it("renders completed tasks in dim gray and active tasks in distinct colors", () => {
		initTheme("dark", false);
		const base: Omit<BgTaskSnapshot, "id" | "label" | "status"> = {
			cwd: "/tmp",
			createdAt: 1000,
			elapsedMs: 8000,
			leaseSeconds: 300,
			runCount: 1,
			totalBytes: 0,
			notifyOn: "all",
			tailOutput: "",
		};
		const doneTask: BgTaskSnapshot = {
			...base,
			id: "bg-1",
			label: "Finished build",
			status: "completed",
			exitCode: 0,
		};
		const runningTask: BgTaskSnapshot = {
			...base,
			id: "bg-2",
			label: "Running tests",
			status: "running",
			leaseRemainingSeconds: 240,
		};
		const scheduledTask: BgTaskSnapshot = {
			...base,
			id: "bg-3",
			label: "Drink water",
			status: "scheduled",
			nextRunRemainingSeconds: 6,
		};

		const listOut = renderThemedTaskList([doneTask, runningTask, scheduledTask], theme);
		const lines = listOut.split("\n");
		// Completed row is purely theme.fg("dim", ...)
		expect(lines[1]).toBe(theme.fg("dim", "  ✓ [bg-1] (completed, elapsed 8s, exit 0) Finished build"));
		// Running row resets outer dim and uses success color, not full-line dim
		expect(lines[2]).toContain("\x1b[22;39m");
		expect(lines[2]).toContain(theme.style("● [bg-2]", { fg: "success", bold: true }));
		expect(lines[2]).toContain(theme.fg("text", "Running tests"));
		// Scheduled row uses accent color
		expect(lines[3]).toContain(theme.style("○ [bg-3]", { fg: "accent", bold: true }));
		expect(lines[3]).toContain(theme.fg("text", "Drink water"));

		const footer = renderBgFooterStatus([doneTask, runningTask, scheduledTask], theme);
		expect(footer).toContain(theme.fg("success", "● 1 running"));
		expect(footer).toContain(theme.fg("accent", "○ 1 scheduled"));
	});
});

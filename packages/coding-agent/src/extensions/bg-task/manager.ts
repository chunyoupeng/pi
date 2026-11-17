import { constants, type WriteStream } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { TextDecoder } from "node:util";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { createOutputFileStream } from "../../utils/output-files.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import {
	type BgNotifyMode,
	type BgTaskEvent,
	type BgTaskSnapshot,
	type BgTaskStatus,
	DEFAULT_GRACE_SECONDS,
	DEFAULT_LEASE_SECONDS,
	extractTail,
	isActiveTaskStatus,
	MAX_TIMEOUT_SECONDS,
	NOTIFY_DEBOUNCE_MS,
	RING_BUFFER_MAX_CHARS,
} from "./types.ts";

export interface SpawnedBgProcess {
	readonly pid: number | undefined;
	writeStdin: (input: string, close?: boolean) => void;
	kill: () => void;
	readonly exited: Promise<{ exitCode: number }>;
}

export type BgProcessSpawner = (options: {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	onData: (chunk: Buffer) => void;
}) => Promise<SpawnedBgProcess>;

export interface StartBgTaskInput {
	command?: string;
	label?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	leaseSeconds?: number;
	delaySeconds?: number;
	intervalSeconds?: number;
	notifyOn?: BgNotifyMode;
}

export interface BgTaskManagerOptions {
	onNotify: (events: BgTaskEvent[]) => void;
	onPersist?: (snapshot: BgTaskSnapshot) => void;
	onStateChange?: () => void;
	spawner?: BgProcessSpawner;
	createLogStream?: () => { path: string; stream: WriteStream };
	graceSeconds?: number;
	debounceMs?: number;
	now?: () => number;
}

interface InternalTask {
	id: string;
	label: string;
	command: string | undefined;
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
	status: BgTaskStatus;
	pid: number | undefined;
	createdAt: number;
	startedAt: number | undefined;
	endedAt: number | undefined;
	lastRunElapsedMs: number | undefined;
	leaseSeconds: number;
	leaseExpiresAt: number | undefined;
	graceExpiresAt: number | undefined;
	delaySeconds: number | undefined;
	intervalSeconds: number | undefined;
	nextRunAt: number | undefined;
	runCount: number;
	exitCode: number | null | undefined;
	lastOutputAt: number | undefined;
	totalBytes: number;
	logPath: string | undefined;
	logStream: WriteStream | undefined;
	notifyOn: BgNotifyMode;
	ringBuffer: string;
	unreportedBuffer: string;
	activeProcess: SpawnedBgProcess | undefined;
	scheduleTimer: NodeJS.Timeout | undefined;
	leaseTimer: NodeJS.Timeout | undefined;
	graceTimer: NodeJS.Timeout | undefined;
	cancelled: boolean;
	timedOutByGrace: boolean;
	generation: number;
}

function validatePositiveSeconds(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${name}: must be a positive number of seconds`);
	}
	if (value > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid ${name}: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return value;
}

function validateNonNegativeSeconds(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${name}: must be a non-negative number of seconds`);
	}
	if (value > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid ${name}: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return value;
}

function deriveLabelFromCommand(command: string): string {
	const firstLine = command.trim().split(/\r?\n/)[0]?.trim() ?? command.trim();
	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function appendBounded(existing: string, addition: string, maxChars: number): string {
	const combined = existing + addition;
	return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

export const defaultBgProcessSpawner: BgProcessSpawner = async ({ command, cwd, env, onData }) => {
	const shellConfig = getShellConfig();
	const commandFromStdin = shellConfig.commandTransport === "stdin";
	const child = spawnProcess(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
		cwd,
		detached: process.platform !== "win32",
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	let stdinClosed = false;
	child.stdin?.on("error", () => {});
	if (commandFromStdin) {
		child.stdin?.end(command);
		stdinClosed = true;
	}

	if (child.pid) {
		trackDetachedChildPid(child.pid);
	}

	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	const exited = (async (): Promise<{ exitCode: number }> => {
		try {
			const code = await waitForChildProcess(child);
			const signalCode = child.signalCode;
			const resolved = code ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
			return { exitCode: resolved };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onData(Buffer.from(`\nProcess error: ${msg}\n`, "utf-8"));
			return { exitCode: 1 };
		} finally {
			if (child.pid) {
				untrackDetachedChildPid(child.pid);
			}
		}
	})();

	return {
		pid: child.pid,
		writeStdin: (input: string, close?: boolean) => {
			if (stdinClosed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
				throw new Error("Task stdin is closed or not writable");
			}
			if (input.length > 0) {
				child.stdin.write(input);
			}
			if (close) {
				child.stdin.end();
				stdinClosed = true;
			}
		},
		kill: () => {
			stdinClosed = true;
			if (child.pid) {
				killProcessTree(child.pid);
			} else {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already dead.
				}
			}
		},
		exited,
	};
};

export function buildTaskShellEnv(sessionMeta?: {
	sessionId?: string;
	sessionFile?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
}): NodeJS.ProcessEnv {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (sessionMeta) {
		if (sessionMeta.sessionId) env.PI_SESSION_ID = sessionMeta.sessionId;
		if (sessionMeta.sessionFile) env.PI_SESSION_FILE = sessionMeta.sessionFile;
		if (sessionMeta.provider) env.PI_PROVIDER = sessionMeta.provider;
		if (sessionMeta.modelId) env.PI_MODEL = sessionMeta.modelId;
		if (sessionMeta.thinkingLevel) env.PI_REASONING_LEVEL = sessionMeta.thinkingLevel;
	}
	return env;
}

export class BgTaskManager {
	private readonly tasks = new Map<string, InternalTask>();
	private nextSeq = 1;
	private disposed = false;
	private pendingEvents: BgTaskEvent[] = [];
	private debounceTimer: NodeJS.Timeout | undefined;

	private readonly onNotify: BgTaskManagerOptions["onNotify"];
	private readonly onPersist: BgTaskManagerOptions["onPersist"];
	private readonly onStateChange: BgTaskManagerOptions["onStateChange"];
	private readonly spawner: BgProcessSpawner;
	private readonly createLogStream: () => { path: string; stream: WriteStream };
	private readonly graceSeconds: number;
	private readonly debounceMs: number;
	private readonly now: () => number;
	private readonly checkCwdExists: boolean;

	constructor(options: BgTaskManagerOptions) {
		this.onNotify = options.onNotify;
		this.onPersist = options.onPersist;
		this.onStateChange = options.onStateChange;
		this.spawner = options.spawner ?? defaultBgProcessSpawner;
		this.checkCwdExists = options.spawner === undefined;
		this.createLogStream = options.createLogStream ?? (() => createOutputFileStream("pi-bg-task", ".log"));
		this.graceSeconds =
			options.graceSeconds !== undefined
				? validatePositiveSeconds(options.graceSeconds, "grace_seconds")
				: DEFAULT_GRACE_SECONDS;
		this.debounceMs = options.debounceMs ?? NOTIFY_DEBOUNCE_MS;
		this.now = options.now ?? (() => Date.now());
	}

	async start(input: StartBgTaskInput): Promise<BgTaskSnapshot> {
		if (this.disposed) {
			throw new Error("Background task manager is disposed");
		}

		const trimmedCommand = input.command?.trim() || undefined;
		const trimmedLabel = input.label?.trim() || undefined;
		const delaySeconds =
			input.delaySeconds !== undefined ? validateNonNegativeSeconds(input.delaySeconds, "delay_seconds") : undefined;
		const intervalSeconds =
			input.intervalSeconds !== undefined
				? validatePositiveSeconds(input.intervalSeconds, "interval_seconds")
				: undefined;
		const leaseSeconds =
			input.leaseSeconds !== undefined
				? validatePositiveSeconds(input.leaseSeconds, "lease_seconds")
				: DEFAULT_LEASE_SECONDS;

		if (!trimmedCommand) {
			if (!trimmedLabel) {
				throw new Error(
					"Provide 'command' to run a background command, or 'label' with 'delay_seconds'/'interval_seconds' for a scheduled timer",
				);
			}
			if ((delaySeconds === undefined || delaySeconds === 0) && intervalSeconds === undefined) {
				throw new Error("Timer task without 'command' requires a positive 'delay_seconds' or 'interval_seconds'");
			}
		} else if (this.checkCwdExists) {
			try {
				await fsAccess(input.cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${input.cwd}`);
			}
		}

		const id = `bg-${this.nextSeq++}`;
		const now = this.now();
		const label = trimmedLabel ?? deriveLabelFromCommand(trimmedCommand!);
		const initialDelaySeconds = delaySeconds !== undefined ? delaySeconds : intervalSeconds;

		const task: InternalTask = {
			id,
			label,
			command: trimmedCommand,
			cwd: input.cwd,
			env: input.env,
			status: initialDelaySeconds && initialDelaySeconds > 0 ? "scheduled" : "running",
			pid: undefined,
			createdAt: now,
			startedAt: undefined,
			endedAt: undefined,
			lastRunElapsedMs: undefined,
			leaseSeconds,
			leaseExpiresAt: undefined,
			graceExpiresAt: undefined,
			delaySeconds,
			intervalSeconds,
			nextRunAt: undefined,
			runCount: 0,
			exitCode: undefined,
			lastOutputAt: undefined,
			totalBytes: 0,
			logPath: undefined,
			logStream: undefined,
			notifyOn: input.notifyOn ?? "all",
			ringBuffer: "",
			unreportedBuffer: "",
			activeProcess: undefined,
			scheduleTimer: undefined,
			leaseTimer: undefined,
			graceTimer: undefined,
			cancelled: false,
			timedOutByGrace: false,
			generation: 0,
		};

		this.tasks.set(id, task);

		if (initialDelaySeconds && initialDelaySeconds > 0) {
			this.armSchedule(task, initialDelaySeconds);
			const snap = this.snapshot(task);
			this.commit(snap);
			return snap;
		}

		await this.launchTaskRun(task);
		return this.snapshot(task);
	}

	extend(id: string, extraLeaseSeconds?: number): BgTaskSnapshot {
		const task = this.requireTask(id);
		if (task.status !== "running" && task.status !== "lease_expired") {
			throw new Error(
				`Cannot extend task ${id}: current status is '${task.status}' (must be 'running' or 'lease_expired')`,
			);
		}

		const resolvedSeconds =
			extraLeaseSeconds !== undefined
				? validatePositiveSeconds(extraLeaseSeconds, "lease_seconds")
				: task.leaseSeconds;
		const now = this.now();

		this.clearRunTimers(task);
		task.status = "running";
		task.leaseSeconds = resolvedSeconds;
		task.graceExpiresAt = undefined;
		task.leaseExpiresAt = now + resolvedSeconds * 1000;
		this.dropPendingLeaseExpiredEvent(id);
		this.armLeaseTimer(task, task.generation, resolvedSeconds * 1000);

		const snap = this.snapshot(task, now);
		this.commit(snap);
		return snap;
	}

	sendInput(id: string, input: string, closeStdin?: boolean): BgTaskSnapshot {
		const task = this.requireTask(id);
		if ((task.status !== "running" && task.status !== "lease_expired") || !task.activeProcess) {
			throw new Error(`Cannot send input to task ${id}: current status is '${task.status}'`);
		}
		task.activeProcess.writeStdin(input, closeStdin);
		return this.snapshot(task);
	}

	async kill(id: string): Promise<BgTaskSnapshot> {
		const task = this.requireTask(id);
		if (!isActiveTaskStatus(task.status)) {
			return this.snapshot(task);
		}

		const now = this.now();
		if (task.startedAt !== undefined && (task.status === "running" || task.status === "lease_expired")) {
			task.lastRunElapsedMs = Math.max(0, now - task.startedAt);
		}
		task.cancelled = true;
		task.generation++;
		task.status = "cancelled";
		task.endedAt = now;
		task.nextRunAt = undefined;
		task.leaseExpiresAt = undefined;
		task.graceExpiresAt = undefined;
		this.clearAllTaskTimers(task);
		this.dropPendingLeaseExpiredEvent(id);

		const proc = task.activeProcess;
		task.activeProcess = undefined;
		task.pid = undefined;
		proc?.kill();

		await this.closeLogStream(task);
		const snap = this.snapshot(task, now);
		this.commit(snap);
		return snap;
	}

	get(id: string): BgTaskSnapshot | undefined {
		const task = this.tasks.get(id);
		return task ? this.snapshot(task) : undefined;
	}

	list(): BgTaskSnapshot[] {
		const now = this.now();
		const result: BgTaskSnapshot[] = [];
		for (const task of this.tasks.values()) {
			result.push(this.snapshot(task, now));
		}
		return result;
	}

	clearFinished(): number {
		let cleared = 0;
		for (const [id, task] of this.tasks.entries()) {
			if (!isActiveTaskStatus(task.status)) {
				this.tasks.delete(id);
				cleared++;
			}
		}
		if (cleared > 0) {
			this.onStateChange?.();
		}
		return cleared;
	}

	getStatusText(): string | undefined {
		let running = 0;
		let leaseExpired = 0;
		let scheduled = 0;
		for (const task of this.tasks.values()) {
			if (task.status === "running") running++;
			else if (task.status === "lease_expired") leaseExpired++;
			else if (task.status === "scheduled") scheduled++;
		}
		if (running === 0 && leaseExpired === 0 && scheduled === 0) {
			return undefined;
		}
		const parts: string[] = [];
		if (leaseExpired > 0) parts.push(`${leaseExpired} lease-expired`);
		if (running > 0) parts.push(`${running} running`);
		if (scheduled > 0) parts.push(`${scheduled} scheduled`);
		return `bg: ${parts.join(", ")}`;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		this.pendingEvents = [];

		const closingStreams: Promise<void>[] = [];
		for (const task of this.tasks.values()) {
			task.cancelled = true;
			task.generation++;
			this.clearAllTaskTimers(task);
			const proc = task.activeProcess;
			task.activeProcess = undefined;
			task.pid = undefined;
			proc?.kill();
			closingStreams.push(this.closeLogStream(task));
		}
		await Promise.allSettled(closingStreams);
	}

	private requireTask(id: string): InternalTask {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`Background task '${id}' not found`);
		}
		return task;
	}

	private armSchedule(task: InternalTask, seconds: number): void {
		this.clearScheduleTimer(task);
		const now = this.now();
		const delayMs = seconds * 1000;
		task.status = "scheduled";
		task.nextRunAt = now + delayMs;
		const gen = ++task.generation;
		task.scheduleTimer = setTimeout(() => {
			task.scheduleTimer = undefined;
			if (this.disposed || task.cancelled || task.generation !== gen) return;
			task.nextRunAt = undefined;
			void this.launchTaskRun(task);
		}, delayMs);
	}

	private async launchTaskRun(task: InternalTask): Promise<void> {
		if (this.disposed || task.cancelled) return;

		if (!task.command) {
			this.firePureTimerRun(task);
			return;
		}

		const gen = ++task.generation;
		const now = this.now();
		task.runCount++;
		task.status = "running";
		task.startedAt = now;
		task.endedAt = undefined;
		task.exitCode = undefined;
		task.timedOutByGrace = false;
		task.unreportedBuffer = "";
		task.leaseExpiresAt = now + task.leaseSeconds * 1000;
		task.graceExpiresAt = undefined;

		this.ensureLogStream(task);
		if (task.runCount > 1 && task.logStream) {
			const header = `\n=== Run #${task.runCount} (${new Date(now).toISOString()}) ===\n`;
			task.logStream.write(header);
			task.ringBuffer = appendBounded(task.ringBuffer, header, RING_BUFFER_MAX_CHARS);
		}

		const decoder = new TextDecoder("utf-8");
		const appendDecoded = (text: string) => {
			if (!text) return;
			const clean = sanitizeBinaryOutput(text);
			if (!clean) return;
			task.ringBuffer = appendBounded(task.ringBuffer, clean, RING_BUFFER_MAX_CHARS);
			task.unreportedBuffer = appendBounded(task.unreportedBuffer, clean, RING_BUFFER_MAX_CHARS);
		};

		const env = task.env ?? buildTaskShellEnv();
		let proc: SpawnedBgProcess;
		try {
			proc = await this.spawner({
				command: task.command,
				cwd: task.cwd,
				env,
				onData: (chunk: Buffer) => {
					if (this.disposed || task.generation !== gen) return;
					task.totalBytes += chunk.length;
					task.lastOutputAt = this.now();
					task.logStream?.write(chunk);
					appendDecoded(decoder.decode(chunk, { stream: true }));
				},
			});
		} catch (err) {
			if (this.disposed || task.cancelled || task.generation !== gen) return;
			const msg = err instanceof Error ? err.message : String(err);
			appendDecoded(`Failed to spawn command: ${msg}\n`);
			task.logStream?.write(`Failed to spawn command: ${msg}\n`);
			await this.handleProcessExit(task, gen, 1, decoder, appendDecoded);
			return;
		}

		if (this.disposed || task.cancelled || task.generation !== gen) {
			proc.kill();
			return;
		}

		task.activeProcess = proc;
		task.pid = proc.pid;
		this.armLeaseTimer(task, gen, task.leaseSeconds * 1000);
		this.commit(this.snapshot(task));

		void proc.exited.then(async ({ exitCode }) => {
			await this.handleProcessExit(task, gen, exitCode, decoder, appendDecoded);
		});
	}

	private firePureTimerRun(task: InternalTask): void {
		const now = this.now();
		task.runCount++;
		task.startedAt = now;
		task.lastRunElapsedMs = 0;

		if (task.intervalSeconds !== undefined) {
			this.armSchedule(task, task.intervalSeconds);
		} else {
			task.status = "completed";
			task.endedAt = now;
			task.nextRunAt = undefined;
		}

		const snap = this.snapshot(task, now);
		this.commit(snap);
		this.enqueueEvent({
			kind: "timer_triggered",
			task: snap,
			incrementalOutput: "",
			timestamp: now,
		});
	}

	private armLeaseTimer(task: InternalTask, gen: number, durationMs: number): void {
		this.clearRunTimers(task);
		task.leaseTimer = setTimeout(() => {
			task.leaseTimer = undefined;
			if (this.disposed || task.cancelled || task.generation !== gen || task.status !== "running") {
				return;
			}
			const now = this.now();
			task.status = "lease_expired";
			task.leaseExpiresAt = undefined;
			task.graceExpiresAt = now + this.graceSeconds * 1000;

			const incremental = task.unreportedBuffer;
			task.unreportedBuffer = "";

			task.graceTimer = setTimeout(() => {
				task.graceTimer = undefined;
				if (this.disposed || task.cancelled || task.generation !== gen || task.status !== "lease_expired") {
					return;
				}
				task.timedOutByGrace = true;
				task.activeProcess?.kill();
			}, this.graceSeconds * 1000);

			const snap = this.snapshot(task, now);
			this.commit(snap);
			this.enqueueEvent({
				kind: "lease_expired",
				task: snap,
				incrementalOutput: incremental,
				timestamp: now,
			});
		}, durationMs);
	}

	private async handleProcessExit(
		task: InternalTask,
		gen: number,
		exitCode: number,
		decoder: TextDecoder,
		appendDecoded: (text: string) => void,
	): Promise<void> {
		if (this.disposed || task.cancelled || task.generation !== gen) {
			return;
		}

		appendDecoded(decoder.decode());
		this.clearRunTimers(task);
		task.activeProcess = undefined;
		task.pid = undefined;
		task.leaseExpiresAt = undefined;
		task.graceExpiresAt = undefined;

		const now = this.now();
		if (task.startedAt !== undefined) {
			task.lastRunElapsedMs = Math.max(0, now - task.startedAt);
		}
		task.exitCode = exitCode;

		const incremental = task.unreportedBuffer || task.ringBuffer;
		task.unreportedBuffer = "";
		this.dropPendingLeaseExpiredEvent(task.id);

		if (task.timedOutByGrace) {
			task.timedOutByGrace = false;
			task.status = "timed_out";
			task.endedAt = now;
			task.nextRunAt = undefined;
			await this.closeLogStream(task);
			if (this.disposed || task.cancelled) return;

			const snap = this.snapshot(task, now);
			this.commit(snap);
			this.enqueueEvent({
				kind: "timed_out",
				task: snap,
				incrementalOutput: incremental,
				timestamp: now,
			});
			return;
		}

		const succeeded = exitCode === 0;
		const shouldNotify =
			task.notifyOn === "all" ||
			(task.notifyOn === "success" && succeeded) ||
			(task.notifyOn === "failure" && !succeeded);

		if (task.intervalSeconds !== undefined) {
			task.endedAt = now;
			this.armSchedule(task, task.intervalSeconds);
			const snap = this.snapshot(task, now);
			this.commit(snap);
			if (shouldNotify) {
				this.enqueueEvent({
					kind: succeeded ? "completed" : "failed",
					task: snap,
					incrementalOutput: incremental,
					timestamp: now,
				});
			}
			return;
		}

		task.status = succeeded ? "completed" : "failed";
		task.endedAt = now;
		await this.closeLogStream(task);
		if (this.disposed || task.cancelled) return;

		const snap = this.snapshot(task, now);
		this.commit(snap);
		if (shouldNotify) {
			this.enqueueEvent({
				kind: succeeded ? "completed" : "failed",
				task: snap,
				incrementalOutput: incremental,
				timestamp: now,
			});
		}
	}

	private ensureLogStream(task: InternalTask): void {
		if (task.logStream) return;
		const { path, stream } = this.createLogStream();
		stream.on("error", () => {});
		task.logPath = path;
		task.logStream = stream;
	}

	private closeLogStream(task: InternalTask): Promise<void> {
		const stream = task.logStream;
		if (!stream) return Promise.resolve();
		task.logStream = undefined;
		return new Promise((resolve) => {
			if (stream.closed || stream.destroyed) {
				resolve();
				return;
			}
			stream.end(() => resolve());
		});
	}

	private clearScheduleTimer(task: InternalTask): void {
		if (task.scheduleTimer) {
			clearTimeout(task.scheduleTimer);
			task.scheduleTimer = undefined;
		}
	}

	private clearRunTimers(task: InternalTask): void {
		if (task.leaseTimer) {
			clearTimeout(task.leaseTimer);
			task.leaseTimer = undefined;
		}
		if (task.graceTimer) {
			clearTimeout(task.graceTimer);
			task.graceTimer = undefined;
		}
	}

	private clearAllTaskTimers(task: InternalTask): void {
		this.clearScheduleTimer(task);
		this.clearRunTimers(task);
	}

	private dropPendingLeaseExpiredEvent(taskId: string): void {
		if (this.pendingEvents.length === 0) return;
		this.pendingEvents = this.pendingEvents.filter((ev) => !(ev.kind === "lease_expired" && ev.task.id === taskId));
	}

	private enqueueEvent(event: BgTaskEvent): void {
		if (this.disposed) return;
		this.pendingEvents.push(event);
		if (this.debounceMs <= 0) {
			this.flushEvents();
			return;
		}
		if (!this.debounceTimer) {
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = undefined;
				this.flushEvents();
			}, this.debounceMs);
		}
	}

	private flushEvents(): void {
		if (this.disposed || this.pendingEvents.length === 0) return;
		const batch = this.pendingEvents.filter((ev) => {
			if (ev.kind !== "lease_expired") return true;
			const live = this.tasks.get(ev.task.id);
			return live?.status === "lease_expired";
		});
		this.pendingEvents = [];
		if (batch.length > 0) {
			this.onNotify(batch);
		}
	}

	private commit(snapshot: BgTaskSnapshot): void {
		this.onPersist?.(snapshot);
		this.onStateChange?.();
	}

	private snapshot(task: InternalTask, now: number = this.now()): BgTaskSnapshot {
		const isRunningNow = task.status === "running" || task.status === "lease_expired";
		const elapsedMs =
			isRunningNow && task.startedAt !== undefined
				? Math.max(0, now - task.startedAt)
				: (task.lastRunElapsedMs ?? 0);

		const leaseRemainingSeconds =
			task.status === "running" && task.leaseExpiresAt !== undefined
				? Math.max(0, Math.ceil((task.leaseExpiresAt - now) / 1000))
				: undefined;
		const graceRemainingSeconds =
			task.status === "lease_expired" && task.graceExpiresAt !== undefined
				? Math.max(0, Math.ceil((task.graceExpiresAt - now) / 1000))
				: undefined;
		const nextRunRemainingSeconds =
			task.status === "scheduled" && task.nextRunAt !== undefined
				? Math.max(0, Math.ceil((task.nextRunAt - now) / 1000))
				: undefined;
		const idleSeconds =
			isRunningNow && task.lastOutputAt !== undefined
				? Math.max(0, Math.floor((now - task.lastOutputAt) / 1000))
				: undefined;

		return {
			id: task.id,
			label: task.label,
			command: task.command,
			cwd: task.cwd,
			status: task.status,
			pid: task.pid,
			createdAt: task.createdAt,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
			elapsedMs,
			leaseSeconds: task.leaseSeconds,
			leaseRemainingSeconds,
			graceRemainingSeconds,
			delaySeconds: task.delaySeconds,
			intervalSeconds: task.intervalSeconds,
			nextRunRemainingSeconds,
			runCount: task.runCount,
			exitCode: task.exitCode,
			idleSeconds,
			totalBytes: task.totalBytes,
			logPath: task.logPath,
			notifyOn: task.notifyOn,
			tailOutput: extractTail(task.ringBuffer),
		};
	}
}

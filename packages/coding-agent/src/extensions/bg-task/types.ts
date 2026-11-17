export const BG_TASK_ENTRY_TYPE = "bg-task";
export const BG_TASK_NOTIFICATION_TYPE = "bg-task-notification";
export const BG_TASK_STATUS_KEY = "bg-task";

/** Default soft lease before waking the agent to inspect progress (5 minutes). */
export const DEFAULT_LEASE_SECONDS = 300;
/** Grace window after `lease_expired` before hard process termination if unextended. */
export const DEFAULT_GRACE_SECONDS = 90;
/** Window to coalesce near-simultaneous background notifications into one wakeup turn. */
export const NOTIFY_DEBOUNCE_MS = 500;
/** Maximum timeout accepted by Node timers (~24.8 days). */
export const MAX_TIMEOUT_SECONDS = 2_147_483;

export const TAIL_MAX_LINES = 30;
export const TAIL_MAX_CHARS = 4_000;
export const RING_BUFFER_MAX_CHARS = 32_768;

export const BG_TASK_ACTIONS = ["start", "status", "list", "extend", "send_input", "kill", "clear"] as const;
export type BgTaskAction = (typeof BG_TASK_ACTIONS)[number];

export const BG_NOTIFY_MODES = ["all", "failure", "success"] as const;
export type BgNotifyMode = (typeof BG_NOTIFY_MODES)[number];

export type BgTaskStatus =
	| "scheduled"
	| "running"
	| "lease_expired"
	| "completed"
	| "failed"
	| "timed_out"
	| "cancelled";

export type BgTaskEventKind = "completed" | "failed" | "lease_expired" | "timed_out" | "timer_triggered";

export interface BgTaskSnapshot {
	id: string;
	label: string;
	command?: string;
	cwd: string;
	status: BgTaskStatus;
	pid?: number;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	elapsedMs: number;
	leaseSeconds: number;
	leaseRemainingSeconds?: number;
	graceRemainingSeconds?: number;
	delaySeconds?: number;
	intervalSeconds?: number;
	nextRunRemainingSeconds?: number;
	runCount: number;
	exitCode?: number | null;
	idleSeconds?: number;
	totalBytes: number;
	logPath?: string;
	notifyOn: BgNotifyMode;
	tailOutput: string;
}

export interface BgTaskEvent {
	kind: BgTaskEventKind;
	task: BgTaskSnapshot;
	incrementalOutput: string;
	timestamp: number;
}

export interface BgNotificationDetails {
	events: BgTaskEvent[];
}

export interface BgTaskToolDetails {
	action: BgTaskAction;
	task?: BgTaskSnapshot;
	tasks?: BgTaskSnapshot[];
	clearedCount?: number;
	error?: string;
}

export function isActiveTaskStatus(status: BgTaskStatus): boolean {
	return status === "scheduled" || status === "running" || status === "lease_expired";
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function formatByteCount(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extractTail(text: string, maxLines = TAIL_MAX_LINES, maxChars = TAIL_MAX_CHARS): string {
	if (!text) return "";
	const sliced = text.length > maxChars ? text.slice(-maxChars) : text;
	const lines = sliced.split("\n");
	// Drop trailing empty element from a final newline when counting lines, then preserve trimEnd.
	const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
	const bodyLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
	return bodyLines.slice(-maxLines).join("\n");
}

export function formatSingleTaskReport(task: BgTaskSnapshot): string {
	const lines: string[] = [`Task [${task.id}] (${task.status}): ${task.label}`];
	if (task.command) lines.push(`Command: ${task.command}`);
	lines.push(`Working directory: ${task.cwd}`);
	if (task.pid !== undefined) lines.push(`PID: ${task.pid}`);
	lines.push(`Runs: ${task.runCount} | Elapsed: ${formatDuration(task.elapsedMs)} | Lease: ${task.leaseSeconds}s`);
	if (task.leaseRemainingSeconds !== undefined) {
		lines.push(`Lease remaining: ${formatDuration(task.leaseRemainingSeconds * 1000)}`);
	}
	if (task.graceRemainingSeconds !== undefined) {
		lines.push(`Grace period remaining: ${formatDuration(task.graceRemainingSeconds * 1000)}`);
	}
	if (task.nextRunRemainingSeconds !== undefined) {
		lines.push(
			`Next scheduled run in: ${formatDuration(task.nextRunRemainingSeconds * 1000)}${task.intervalSeconds ? ` (interval ${task.intervalSeconds}s)` : ""}`,
		);
	}
	if (task.exitCode !== undefined && task.exitCode !== null) {
		lines.push(`Exit code: ${task.exitCode}`);
	}
	if (task.idleSeconds !== undefined) {
		lines.push(
			`Last output: ${formatDuration(task.idleSeconds * 1000)} ago | Output size: ${formatByteCount(task.totalBytes)}`,
		);
	} else if (task.totalBytes > 0) {
		lines.push(`Output size: ${formatByteCount(task.totalBytes)}`);
	}
	if (task.logPath) lines.push(`Full log: ${task.logPath}`);
	if (task.tailOutput) {
		lines.push("", `Recent output (up to ${TAIL_MAX_LINES} lines):`, "```", task.tailOutput, "```");
	}
	return lines.join("\n");
}

export function formatTaskListReport(tasks: readonly BgTaskSnapshot[]): string {
	if (tasks.length === 0) return "No background tasks.";
	const lines = [`${tasks.length} background task${tasks.length === 1 ? "" : "s"}:`];
	for (const task of tasks) {
		const extras: string[] = [task.status];
		if (task.status === "running" && task.leaseRemainingSeconds !== undefined) {
			extras.push(
				`elapsed ${formatDuration(task.elapsedMs)}, lease ${formatDuration(task.leaseRemainingSeconds * 1000)} left`,
			);
		} else if (task.status === "lease_expired" && task.graceRemainingSeconds !== undefined) {
			extras.push(
				`elapsed ${formatDuration(task.elapsedMs)}, grace ${formatDuration(task.graceRemainingSeconds * 1000)} left`,
			);
		} else if (task.status === "scheduled" && task.nextRunRemainingSeconds !== undefined) {
			extras.push(`next in ${formatDuration(task.nextRunRemainingSeconds * 1000)}`);
		} else {
			extras.push(`elapsed ${formatDuration(task.elapsedMs)}`);
			if (task.exitCode !== undefined && task.exitCode !== null) extras.push(`exit ${task.exitCode}`);
		}
		lines.push(`- [${task.id}] (${extras.join(", ")}) ${task.label}${task.logPath ? ` -> ${task.logPath}` : ""}`);
	}
	return lines.join("\n");
}

function formatSingleNotificationEvent(event: BgTaskEvent): string {
	const { task, kind } = event;
	const snippet = extractTail(event.incrementalOutput || task.tailOutput);
	const lines: string[] = [];

	switch (kind) {
		case "completed": {
			lines.push(`[Background task completed: ${task.id}]`);
			lines.push(`Label: ${task.label}`);
			if (task.command) lines.push(`Command: ${task.command}`);
			lines.push(
				`Status: ${task.status} (exit code ${task.exitCode ?? 0}, elapsed ${formatDuration(task.elapsedMs)}, run #${task.runCount})`,
			);
			if (task.nextRunRemainingSeconds !== undefined) {
				lines.push(`Next scheduled run in: ${formatDuration(task.nextRunRemainingSeconds * 1000)}`);
			}
			if (task.logPath) lines.push(`Full log: ${task.logPath}`);
			if (snippet) lines.push("", "Recent output:", "```", snippet, "```");
			break;
		}
		case "failed": {
			lines.push(`[Background task failed: ${task.id}]`);
			lines.push(`Label: ${task.label}`);
			if (task.command) lines.push(`Command: ${task.command}`);
			lines.push(
				`Status: ${task.status} (exit code ${task.exitCode ?? 1}, elapsed ${formatDuration(task.elapsedMs)}, run #${task.runCount})`,
			);
			if (task.nextRunRemainingSeconds !== undefined) {
				lines.push(`Next scheduled run in: ${formatDuration(task.nextRunRemainingSeconds * 1000)}`);
			}
			if (task.logPath) lines.push(`Full log: ${task.logPath}`);
			if (snippet) lines.push("", "Recent output:", "```", snippet, "```");
			break;
		}
		case "lease_expired": {
			lines.push(`[Background task lease expired: ${task.id} - still running]`);
			lines.push(`Label: ${task.label}`);
			if (task.command) lines.push(`Command: ${task.command}`);
			const idlePart =
				task.idleSeconds !== undefined
					? `Last output: ${formatDuration(task.idleSeconds * 1000)} ago`
					: "No output yet";
			lines.push(
				`Elapsed: ${formatDuration(task.elapsedMs)} | ${idlePart} | Total output: ${formatByteCount(task.totalBytes)}`,
			);
			if (task.graceRemainingSeconds !== undefined) {
				lines.push(
					`Grace period: ${formatDuration(task.graceRemainingSeconds * 1000)} remaining before automatic termination`,
				);
			}
			if (task.logPath) lines.push(`Full log: ${task.logPath}`);
			if (snippet) {
				lines.push("", "Output since last check:", "```", snippet, "```");
			}
			lines.push(
				"",
				"Action required:",
				`- If making real progress and more time is needed, call bg_task with {"action": "extend", "id": "${task.id}", "lease_seconds": ${task.leaseSeconds}} (adjust lease_seconds to fit remaining work).`,
				`- If waiting on interactive stdin, call bg_task with {"action": "send_input", "id": "${task.id}", "input": "..."}.`,
				`- If stuck or no longer needed, call bg_task with {"action": "kill", "id": "${task.id}"}.`,
			);
			break;
		}
		case "timed_out": {
			lines.push(`[Background task timed out and was terminated: ${task.id}]`);
			lines.push(`Label: ${task.label}`);
			if (task.command) lines.push(`Command: ${task.command}`);
			lines.push(
				`Elapsed: ${formatDuration(task.elapsedMs)} (soft lease and grace period elapsed without extension)`,
			);
			if (task.logPath) lines.push(`Full log: ${task.logPath}`);
			if (snippet) lines.push("", "Last output before termination:", "```", snippet, "```");
			break;
		}
		case "timer_triggered": {
			lines.push(`[Scheduled timer triggered: ${task.id} (run #${task.runCount})]`);
			lines.push(`Task: ${task.label}`);
			if (task.nextRunRemainingSeconds !== undefined) {
				lines.push(
					`Schedule: repeats every ${formatDuration((task.intervalSeconds ?? 0) * 1000)} (next run in ${formatDuration(task.nextRunRemainingSeconds * 1000)})`,
				);
			} else {
				lines.push("Schedule: one-shot timer completed");
			}
			break;
		}
	}

	return lines.join("\n");
}

export function formatNotificationMessage(events: readonly BgTaskEvent[]): string {
	return events.map(formatSingleNotificationEvent).join("\n\n");
}

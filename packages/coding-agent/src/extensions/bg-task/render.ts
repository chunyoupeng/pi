import type { TextContent } from "@earendil-works/pi-ai";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import {
	type BgNotificationDetails,
	type BgTaskSnapshot,
	type BgTaskStatus,
	type BgTaskToolDetails,
	formatByteCount,
	formatDuration,
	formatSingleTaskReport,
	TAIL_MAX_LINES,
} from "./types.ts";

/** Reset outer faint/foreground SGR when rendered inside status notifications (`theme.fg("dim", ...)`). */
const SGR_NORMAL_RESET = "\x1b[22;39m";

export function isFinishedGrayStatus(status: BgTaskStatus): boolean {
	return status === "completed" || status === "cancelled";
}

export function activeStatusColor(status: BgTaskStatus): ThemeColor {
	switch (status) {
		case "running":
			return "success";
		case "scheduled":
			return "accent";
		case "lease_expired":
			return "warning";
		case "failed":
		case "timed_out":
			return "error";
		case "completed":
		case "cancelled":
			return "dim";
	}
}

function taskMarker(status: BgTaskStatus): string {
	switch (status) {
		case "running":
			return "●";
		case "scheduled":
			return "○";
		case "lease_expired":
			return "!";
		case "completed":
			return "✓";
		case "failed":
		case "timed_out":
			return "✗";
		case "cancelled":
			return "-";
	}
}

function formatStatusDetail(task: BgTaskSnapshot): string {
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
		if (task.exitCode !== undefined && task.exitCode !== null) {
			extras.push(`exit ${task.exitCode}`);
		}
	}
	return `(${extras.join(", ")})`;
}

export function renderTaskRow(task: BgTaskSnapshot, theme: Theme, includeLogPath: boolean): string {
	const marker = taskMarker(task.status);
	const detail = formatStatusDetail(task);
	const logSuffix = includeLogPath && task.logPath ? ` -> ${task.logPath}` : "";

	if (isFinishedGrayStatus(task.status)) {
		return theme.fg("dim", `  ${marker} [${task.id}] ${detail} ${task.label}${logSuffix}`);
	}

	const color = activeStatusColor(task.status);
	return (
		`${SGR_NORMAL_RESET}  ` +
		`${theme.style(`${marker} [${task.id}]`, { fg: color, bold: true })} ` +
		`${theme.fg(color, detail)} ` +
		`${theme.fg("text", task.label)}` +
		(logSuffix ? theme.fg("dim", logSuffix) : "")
	);
}

export function renderThemedTaskList(tasks: readonly BgTaskSnapshot[], theme: Theme): string {
	if (tasks.length === 0) {
		return theme.fg("dim", "No background tasks.");
	}
	const lines = [
		`${SGR_NORMAL_RESET}${theme.fg("muted", `${tasks.length} background task${tasks.length === 1 ? "" : "s"}:`)}`,
	];
	for (const task of tasks) {
		lines.push(renderTaskRow(task, theme, true));
	}
	return lines.join("\n");
}

export function renderThemedSingleTask(task: BgTaskSnapshot, theme: Theme): string {
	if (isFinishedGrayStatus(task.status)) {
		return theme.fg("dim", formatSingleTaskReport(task));
	}

	const color = activeStatusColor(task.status);
	const marker = taskMarker(task.status);
	const lines: string[] = [
		`${SGR_NORMAL_RESET}${theme.style(`${marker} Task [${task.id}] (${task.status}):`, { fg: color, bold: true })} ${theme.fg("text", task.label)}`,
	];
	if (task.command) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", "Command:")} ${theme.fg("text", task.command)}`);
	}
	lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", "Working directory:")} ${theme.fg("dim", task.cwd)}`);
	if (task.pid !== undefined) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", "PID:")} ${theme.fg("text", String(task.pid))}`);
	}
	lines.push(
		`${SGR_NORMAL_RESET}${theme.fg("muted", `Runs: ${task.runCount} | Elapsed: ${formatDuration(task.elapsedMs)} | Lease: ${task.leaseSeconds}s`)}`,
	);
	if (task.leaseRemainingSeconds !== undefined) {
		lines.push(
			`${SGR_NORMAL_RESET}${theme.fg("muted", "Lease remaining:")} ${theme.fg(color, formatDuration(task.leaseRemainingSeconds * 1000))}`,
		);
	}
	if (task.graceRemainingSeconds !== undefined) {
		lines.push(
			`${SGR_NORMAL_RESET}${theme.fg("muted", "Grace period remaining:")} ${theme.fg(color, formatDuration(task.graceRemainingSeconds * 1000))}`,
		);
	}
	if (task.nextRunRemainingSeconds !== undefined) {
		lines.push(
			`${SGR_NORMAL_RESET}${theme.fg("muted", "Next scheduled run in:")} ${theme.fg(color, `${formatDuration(task.nextRunRemainingSeconds * 1000)}${task.intervalSeconds ? ` (interval ${task.intervalSeconds}s)` : ""}`)}`,
		);
	}
	if (task.exitCode !== undefined && task.exitCode !== null) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", "Exit code:")} ${theme.fg(color, String(task.exitCode))}`);
	}
	if (task.idleSeconds !== undefined) {
		lines.push(
			`${SGR_NORMAL_RESET}${theme.fg("muted", `Last output: ${formatDuration(task.idleSeconds * 1000)} ago | Output size: ${formatByteCount(task.totalBytes)}`)}`,
		);
	} else if (task.totalBytes > 0) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", `Output size: ${formatByteCount(task.totalBytes)}`)}`);
	}
	if (task.logPath) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", "Full log:")} ${theme.fg("dim", task.logPath)}`);
	}
	if (task.tailOutput) {
		lines.push(
			"",
			`${SGR_NORMAL_RESET}${theme.fg("muted", `Recent output (up to ${TAIL_MAX_LINES} lines):`)}`,
			`${SGR_NORMAL_RESET}${theme.fg("dim", task.tailOutput)}`,
		);
	}
	return lines.join("\n");
}

export function renderBgFooterStatus(tasks: readonly BgTaskSnapshot[], theme: Theme): string | undefined {
	let running = 0;
	let leaseExpired = 0;
	let scheduled = 0;
	for (const task of tasks) {
		if (task.status === "running") running++;
		else if (task.status === "lease_expired") leaseExpired++;
		else if (task.status === "scheduled") scheduled++;
	}
	if (running === 0 && leaseExpired === 0 && scheduled === 0) {
		return undefined;
	}
	const parts: string[] = [];
	if (leaseExpired > 0) parts.push(theme.fg("warning", `! ${leaseExpired} lease-expired`));
	if (running > 0) parts.push(theme.fg("success", `● ${running} running`));
	if (scheduled > 0) parts.push(theme.fg("accent", `○ ${scheduled} scheduled`));
	return `${theme.fg("muted", "bg:")} ${parts.join(theme.fg("dim", " · "))}`;
}

export function renderBgToolCall(
	args: {
		action?: string;
		id?: string;
		label?: string;
		command?: string;
		lease_seconds?: number;
		delay_seconds?: number;
		interval_seconds?: number;
	},
	theme: Theme,
): Text {
	let text = theme.fg("toolTitle", theme.bold("bg_task ")) + theme.fg("muted", String(args.action ?? ""));
	if (args.id) text += ` ${theme.fg("accent", `[${args.id}]`)}`;
	const title = args.label || args.command;
	if (title) {
		const compact = title.replace(/\s+/g, " ").trim();
		const display = compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
		text += ` ${theme.fg("dim", `"${display}"`)}`;
	}
	const meta: string[] = [];
	if (args.lease_seconds !== undefined) meta.push(`lease=${args.lease_seconds}s`);
	if (args.delay_seconds !== undefined) meta.push(`delay=${args.delay_seconds}s`);
	if (args.interval_seconds !== undefined) meta.push(`every=${args.interval_seconds}s`);
	if (meta.length > 0) text += ` ${theme.fg("dim", `(${meta.join(", ")})`)}`;
	return new Text(text, 0, 0);
}

export function renderBgToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: BgTaskToolDetails },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	if (!details) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "", 0, 0);
	}

	if (details.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const renderList = (list: readonly BgTaskSnapshot[]): Text => {
		if (list.length === 0) {
			return new Text(theme.fg("dim", "No background tasks"), 0, 0);
		}
		const shown = options.expanded ? list : list.slice(0, 8);
		const lines = [theme.fg("muted", `${list.length} background task${list.length === 1 ? "" : "s"}:`)];
		for (const item of shown) {
			lines.push(renderTaskRow(item, theme, false));
		}
		if (!options.expanded && list.length > 8) {
			lines.push(theme.fg("dim", `  ... ${list.length - 8} more`));
		}
		return new Text(lines.join("\n"), 0, 0);
	};

	switch (details.action) {
		case "start":
		case "extend":
		case "send_input":
		case "kill":
		case "status": {
			if (details.tasks) {
				return renderList(details.tasks);
			}

			const task = details.task;
			if (!task) {
				const first = result.content[0];
				return new Text(first?.type === "text" && first.text ? first.text : "", 0, 0);
			}

			let header = renderTaskRow(task, theme, false).trimStart();
			if (options.expanded && task.tailOutput) {
				header += `\n${theme.fg("dim", task.tailOutput)}`;
			}
			return new Text(header, 0, 0);
		}
		case "list": {
			return renderList(details.tasks ?? []);
		}
		case "clear": {
			const count = details.clearedCount ?? 0;
			return new Text(theme.fg("dim", `Cleared ${count} finished task${count === 1 ? "" : "s"}`), 0, 0);
		}
	}
}

export function renderBgNotificationMessage(
	message: CustomMessage<BgNotificationDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const events = message.details?.events;
	if (!events || events.length === 0) return undefined;

	const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
	const summaryLines: string[] = [];

	for (const ev of events) {
		const { task, kind } = ev;
		switch (kind) {
			case "completed": {
				if (isFinishedGrayStatus(task.status)) {
					summaryLines.push(
						theme.fg(
							"dim",
							`✓ [bg-task] [${task.id}] completed ${task.label} (${formatDuration(task.elapsedMs)})`,
						),
					);
				} else {
					const nextPart =
						task.nextRunRemainingSeconds !== undefined
							? ` ${theme.fg("accent", `(next in ${formatDuration(task.nextRunRemainingSeconds * 1000)})`)}`
							: "";
					summaryLines.push(
						`${theme.style(`○ [bg-task] [${task.id}]`, { fg: "accent", bold: true })} ${theme.fg("success", `run #${task.runCount} completed`)} ${theme.fg("text", task.label)}${nextPart}`,
					);
				}
				break;
			}
			case "timer_triggered": {
				if (isFinishedGrayStatus(task.status)) {
					summaryLines.push(
						theme.fg("dim", `✓ [bg-task] [${task.id}] timer triggered (#${task.runCount}) ${task.label}`),
					);
				} else {
					const nextPart =
						task.nextRunRemainingSeconds !== undefined
							? ` ${theme.fg("accent", `(next in ${formatDuration(task.nextRunRemainingSeconds * 1000)})`)}`
							: "";
					summaryLines.push(
						`${theme.style(`○ [bg-task] [${task.id}]`, { fg: "accent", bold: true })} ${theme.fg("accent", `timer triggered (#${task.runCount})`)} ${theme.fg("text", task.label)}${nextPart}`,
					);
				}
				break;
			}
			case "lease_expired": {
				summaryLines.push(
					`${theme.style(`! [bg-task] [${task.id}]`, { fg: "warning", bold: true })} ${theme.fg("warning", "lease expired - still running")} ${theme.fg("text", task.label)} ${theme.fg("muted", `(${formatDuration(task.elapsedMs)})`)}`,
				);
				break;
			}
			case "failed":
			case "timed_out": {
				const reason = kind === "timed_out" ? "timed out" : `failed (exit ${task.exitCode ?? 1})`;
				summaryLines.push(
					`${theme.style(`✗ [bg-task] [${task.id}]`, { fg: "error", bold: true })} ${theme.fg("error", reason)} ${theme.fg("text", task.label)} ${theme.fg("dim", `(${formatDuration(task.elapsedMs)})`)}`,
				);
				break;
			}
		}
	}

	if (options.expanded) {
		const rawText =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is TextContent => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		summaryLines.push("", theme.fg("dim", rawText));
	}

	box.addChild(new Text(summaryLines.join("\n"), 0, 0));
	return box;
}

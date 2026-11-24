/**
 * Goal extension - TUI renderers for footer status, summary card, tool calls/results,
 * and continuation banners.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import {
	formatDuration,
	type GoalContinuationDetails,
	type GoalState,
	type GoalStatus,
	type GoalToolDetails,
} from "./state.ts";

/** Reset outer faint/foreground SGR when rendered inside status notifications (`theme.fg("dim", ...)`). */
const SGR_NORMAL_RESET = "\x1b[22;39m";

const FOOTER_OBJECTIVE_MAX_CHARS = 38;
const CALL_PREVIEW_MAX_CHARS = 60;
const CONTINUATION_OBJECTIVE_MAX_CHARS = 56;

export function goalStatusColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "active":
			return "success";
		case "paused":
			return "warning";
		case "blocked":
			return "error";
		case "complete":
			return "dim";
	}
}

export function goalStatusMarker(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "●";
		case "paused":
			return "‖";
		case "blocked":
			return "!";
		case "complete":
			return "✓";
	}
}

export function compactText(text: string, maxChars: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Plain-text single-line footer status fallback when theme is not initialized. */
export function formatGoalFooterStatus(state: GoalState | null, elapsedMs: number): string | undefined {
	if (!state) return undefined;
	const marker = goalStatusMarker(state.status);
	const preview = compactText(state.objective, FOOTER_OBJECTIVE_MAX_CHARS);
	const metaParts = [formatDuration(elapsedMs)];
	if (state.rounds > 0) metaParts.push(`r${state.rounds}`);
	return `goal: ${marker} ${state.status} · ${metaParts.join(" · ")} · ${preview}`;
}

/** Compact single-line footer status matching sibling extensions (`bg:`, etc.). */
export function renderGoalFooterStatus(state: GoalState | null, elapsedMs: number, theme: Theme): string | undefined {
	if (!state) return undefined;

	const marker = goalStatusMarker(state.status);
	const preview = compactText(state.objective, FOOTER_OBJECTIVE_MAX_CHARS);
	const metaParts = [formatDuration(elapsedMs)];
	if (state.rounds > 0) metaParts.push(`r${state.rounds}`);
	const meta = metaParts.join(" · ");

	if (state.status === "complete") {
		return (
			`${theme.fg("muted", "goal:")} ` +
			`${theme.fg("success", marker)} ` +
			`${theme.fg("dim", `complete · ${meta} · ${preview}`)}`
		);
	}

	const color = goalStatusColor(state.status);
	return (
		`${theme.fg("muted", "goal:")} ` +
		`${theme.style(`${marker} ${state.status}`, { fg: color, bold: true })} ` +
		`${theme.fg("dim", `· ${meta} ·`)} ` +
		`${theme.fg("text", preview)}`
	);
}

/** Plain-text goal summary for print mode and logs. */
export function formatGoalSummary(state: GoalState | null, elapsedMs: number): string {
	if (!state) {
		return "No goal is set. Create one with /goal <objective>.";
	}
	const lines = [
		`Goal: ${state.objective}`,
		`Goal ID: ${state.goalId} (revision ${state.revision})`,
		`Status: ${state.status}`,
		`Rounds: ${state.rounds}`,
		`Time used: ${formatDuration(elapsedMs)}`,
		`Created: ${new Date(state.createdAt).toLocaleString()}`,
		`Updated: ${new Date(state.updatedAt).toLocaleString()}`,
	];
	if (state.completedAtMs !== undefined) {
		lines.push(`Completed: ${new Date(state.completedAtMs).toLocaleString()}`);
	}
	if (state.note) lines.push(`Note: ${state.note}`);
	if (state.blockedReason) lines.push(`Blocked reason: ${state.blockedReason}`);
	return lines.join("\n");
}

/** Themed goal detail card rendered via `/goal` in interactive TUI mode. */
export function renderGoalSummary(state: GoalState | null, elapsedMs: number, theme: Theme): string {
	if (!state) {
		return (
			`${SGR_NORMAL_RESET}${theme.fg("muted", "No goal is set.")} ` +
			`${theme.fg("dim", "Create one with /goal <objective>.")}`
		);
	}

	const marker = goalStatusMarker(state.status);
	const color = state.status === "complete" ? "success" : goalStatusColor(state.status);
	const sep = theme.fg("dim", " · ");
	const lines: string[] = [
		`${SGR_NORMAL_RESET}${theme.style(`${marker} Goal [${state.goalId}] (${state.status})`, { fg: color, bold: true })}`,
	];

	for (const objectiveLine of state.objective.split("\n")) {
		lines.push(`${SGR_NORMAL_RESET}  ${theme.fg(state.status === "complete" ? "dim" : "text", objectiveLine)}`);
	}

	lines.push(
		`${SGR_NORMAL_RESET}${theme.fg("muted", "Time:")} ${theme.fg("text", formatDuration(elapsedMs))}` +
			`${sep}${theme.fg("muted", "Rounds:")} ${theme.fg("text", String(state.rounds))}` +
			`${sep}${theme.fg("muted", "Rev:")} ${theme.fg("dim", String(state.revision))}`,
	);

	const timestamps = [
		`${theme.fg("muted", "Created:")} ${theme.fg("dim", new Date(state.createdAt).toLocaleString())}`,
		`${theme.fg("muted", "Updated:")} ${theme.fg("dim", new Date(state.updatedAt).toLocaleString())}`,
	];
	if (state.completedAtMs !== undefined) {
		timestamps.push(
			`${theme.fg("muted", "Completed:")} ${theme.fg("dim", new Date(state.completedAtMs).toLocaleString())}`,
		);
	}
	lines.push(`${SGR_NORMAL_RESET}${timestamps.join(sep)}`);

	if (state.note) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", "Note:")} ${theme.fg("text", state.note)}`);
	}
	if (state.blockedReason) {
		lines.push(`${SGR_NORMAL_RESET}${theme.fg("error", "Blocked:")} ${theme.fg("text", state.blockedReason)}`);
	}

	const commands =
		state.status === "active"
			? "/goal pause · /goal edit · /goal clear"
			: state.status === "complete"
				? "/goal <new objective> · /goal clear"
				: "/goal resume · /goal edit · /goal clear";
	lines.push(`${SGR_NORMAL_RESET}${theme.fg("dim", commands)}`);

	return lines.join("\n");
}

export function renderGoalToolCall(
	args: {
		action?: string;
		objective?: string;
		overwrite?: boolean;
		goalId?: string;
		note?: string;
	},
	theme: Theme,
): Text {
	let text = theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("muted", String(args.action ?? ""));
	if (args.goalId) text += ` ${theme.fg("accent", `[${args.goalId}]`)}`;
	const previewSource = args.objective ?? args.note;
	if (previewSource) {
		text += ` ${theme.fg("dim", `"${compactText(previewSource, CALL_PREVIEW_MAX_CHARS)}"`)}`;
	}
	if (args.overwrite) {
		text += ` ${theme.fg("dim", "(overwrite)")}`;
	}
	return new Text(text, 0, 0);
}

export function renderGoalToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails },
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

	const goal = details.goal;
	if (!goal) {
		return new Text(theme.fg("dim", "No goal is currently set"), 0, 0);
	}

	const marker = goalStatusMarker(goal.status);
	const color = goal.status === "complete" ? "success" : goalStatusColor(goal.status);
	const meta = `${formatDuration(goal.timeUsedMs)}${goal.rounds > 0 ? `, ${goal.rounds} ${goal.rounds === 1 ? "round" : "rounds"}` : ""}`;

	if (details.unchanged) {
		return new Text(theme.fg("dim", `${marker} Goal [${goal.goalId}] is already ${goal.status} (${meta})`), 0, 0);
	}

	switch (details.action) {
		case "get": {
			const lines = [
				`${theme.style(`${marker} [${goal.goalId}]`, { fg: color, bold: true })} ` +
					`${theme.fg(color, `(${goal.status})`)} ` +
					`${theme.fg("dim", meta)} ` +
					`${theme.fg("text", options.expanded ? "" : compactText(goal.objective, CALL_PREVIEW_MAX_CHARS))}`.trimEnd(),
			];
			if (options.expanded) {
				lines.push(theme.fg("text", goal.objective));
				if (goal.note) lines.push(`${theme.fg("muted", "Note:")} ${theme.fg("dim", goal.note)}`);
				if (goal.blockedReason)
					lines.push(`${theme.fg("error", "Blocked:")} ${theme.fg("dim", goal.blockedReason)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		}
		case "create": {
			const lines = [
				`${theme.fg("success", "✓ Created")} ${theme.fg("accent", `[${goal.goalId}]`)} ` +
					`${theme.fg("text", options.expanded ? "" : compactText(goal.objective, CALL_PREVIEW_MAX_CHARS))}`.trimEnd(),
			];
			if (options.expanded) {
				lines.push(theme.fg("dim", goal.objective));
			}
			return new Text(lines.join("\n"), 0, 0);
		}
		case "complete": {
			let out =
				`${theme.style("✓ Goal complete", { fg: "success", bold: true })} ` +
				`${theme.fg("accent", `[${goal.goalId}]`)} ${theme.fg("dim", `(${meta})`)}`;
			if (goal.note) {
				out += `\n${theme.fg("dim", options.expanded ? goal.note : compactText(goal.note, 80))}`;
			}
			return new Text(out, 0, 0);
		}
		case "blocked": {
			let out =
				`${theme.style("! Goal blocked", { fg: "error", bold: true })} ` +
				`${theme.fg("accent", `[${goal.goalId}]`)} ${theme.fg("dim", `(${meta})`)}`;
			if (goal.blockedReason) {
				out += `\n${theme.fg("warning", options.expanded ? goal.blockedReason : compactText(goal.blockedReason, 80))}`;
			}
			return new Text(out, 0, 0);
		}
	}
}

/** Compact banner shown in the transcript when a goal starts or auto-continues. */
export function renderGoalContinuationMessage(
	message: CustomMessage<GoalContinuationDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details;
	if (!details) return undefined;

	const box = new Box(options.outputPad, 0, (t) => theme.bg("customMessageBg", t));
	const label = details.kind === "start" ? `started (round #${details.round})` : `round #${details.round}`;
	const elapsed = details.timeUsedMs > 0 ? ` · ${formatDuration(details.timeUsedMs)}` : "";
	const preview = compactText(details.objective, CONTINUATION_OBJECTIVE_MAX_CHARS);
	const summaryLine =
		`${theme.style("● goal", { fg: "success", bold: true })} ` +
		`${theme.fg("muted", `${label}${elapsed}`)} ` +
		`${theme.fg("dim", "·")} ${theme.fg("text", preview)}`;

	const lines = [summaryLine];
	if (options.expanded) {
		const rawText =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is TextContent => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		lines.push("", theme.fg("dim", rawText));
	}

	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}

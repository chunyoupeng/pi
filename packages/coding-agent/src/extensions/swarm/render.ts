import type { TextContent } from "@earendil-works/pi-ai";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import {
	type BoardPostToolDetails,
	type BoardReadToolDetails,
	COORDINATOR_NAME,
	DEFAULT_MAX_TURNS_PER_WAKEUP,
	formatCost,
	formatPostTimestamp,
	formatTokenCount,
	formatWorkerInspect,
	type SwarmMemberSnapshot,
	type SwarmMemberState,
	type SwarmNotificationDetails,
	type SwarmSnapshot,
	type SwarmToolDetails,
} from "./types.ts";

/** Reset outer faint/foreground SGR when rendered inside status notifications (`theme.fg("dim", ...)`). */
const SGR_NORMAL_RESET = "\x1b[22;39m";

export function memberStateColor(state: SwarmMemberState): ThemeColor {
	switch (state) {
		case "working":
			return "success";
		case "waiting":
			return "accent";
		case "stopped":
			return "warning";
		case "killed":
			return "dim";
	}
}

export function memberStateMarker(state: SwarmMemberState): string {
	switch (state) {
		case "working":
			return "●";
		case "waiting":
			return "○";
		case "stopped":
			return "◌";
		case "killed":
			return "✗";
	}
}

export function renderSwarmFooterStatus(snapshot: SwarmSnapshot | undefined, theme: Theme): string | undefined {
	if (!snapshot) return undefined;
	const liveCount = snapshot.counts.working + snapshot.counts.waiting + snapshot.counts.stopped;
	if (!snapshot.active && liveCount === 0) return undefined;

	const parts: string[] = [];
	if (snapshot.counts.working > 0) parts.push(theme.fg("success", `● ${snapshot.counts.working} working`));
	if (snapshot.counts.waiting > 0) parts.push(theme.fg("accent", `○ ${snapshot.counts.waiting} waiting`));
	if (snapshot.counts.stopped > 0) parts.push(theme.fg("warning", `◌ ${snapshot.counts.stopped} stopped`));
	if (parts.length === 0) parts.push(theme.fg("dim", "idle"));

	const postsPart = theme.fg("muted", `${snapshot.postCount} post${snapshot.postCount === 1 ? "" : "s"}`);
	const costPart =
		snapshot.totalUsage.cost > 0
			? `${theme.fg("dim", " · ")}${theme.fg("dim", formatCost(snapshot.totalUsage.cost))}`
			: "";
	const hint = theme.fg("dim", "(alt+s)");
	return `${theme.fg("muted", "swarm:")} ${parts.join(theme.fg("dim", " · "))}${theme.fg("dim", " · ")}${postsPart}${costPart} ${hint}`;
}

export function renderMemberRow(member: SwarmMemberSnapshot, theme: Theme): string {
	const marker = memberStateMarker(member.state);
	if (member.state === "killed") {
		return theme.fg("dim", `  ${marker} @${member.name} (killed · ${member.model})`);
	}

	const color = memberStateColor(member.state);
	const stateText =
		member.state !== "working" && member.lastStopReason ? `${member.state}:${member.lastStopReason}` : member.state;
	const meta: string[] = [stateText, member.model];
	if (member.thinkingLevel && member.thinkingLevel !== "off") {
		meta.push(`thinking: ${member.thinkingLevel}`);
	}
	if (member.role === "worker") {
		meta.push(member.workspace);
		if (member.gitBranch) meta.push(member.gitBranch);
		if (member.addedBy !== COORDINATOR_NAME) meta.push(`by @${member.addedBy}`);
		if (member.usage.turns > 0) {
			const wakeupPart =
				member.lastWakeupTurns !== undefined && member.state !== "working"
					? ` (${member.lastWakeupTurns}/${member.maxTurnsPerWakeup ?? DEFAULT_MAX_TURNS_PER_WAKEUP})`
					: "";
			meta.push(`${member.usage.turns}t${wakeupPart}`);
		}
		if (member.currentTask) {
			meta.push(`task #${member.currentTask.index}`);
		}
	}
	const activity = member.currentActivity ? ` — ${member.currentActivity}` : "";
	const error = !member.currentActivity && member.lastError ? ` — error: ${member.lastError}` : "";
	const lastOut =
		!member.currentActivity && !error && member.lastStopReason === "max_turns" && member.lastOutput
			? ` — ${member.lastOutput.replace(/\s+/g, " ").trim().slice(0, 80)}`
			: "";

	return (
		`${SGR_NORMAL_RESET}  ` +
		`${theme.style(`${marker} @${member.name}`, { fg: color, bold: true })} ` +
		`${theme.fg("muted", `(${meta.join(" · ")})`)}` +
		(activity ? theme.fg("text", activity) : "") +
		(error ? theme.fg("error", error) : "") +
		(lastOut ? theme.fg("warning", lastOut) : "")
	);
}

export function renderThemedSwarmStatus(snapshot: SwarmSnapshot | undefined, theme: Theme): string {
	if (!snapshot) {
		return theme.fg("dim", "No active swarm. Run /swarm <task> or call the swarm tool to start one.");
	}
	const lines: string[] = [
		`${SGR_NORMAL_RESET}${theme.style(`Swarm: ${snapshot.title || snapshot.id}`, { fg: "accent", bold: true })} ${theme.fg("dim", `(${snapshot.id})`)}`,
	];
	const usageParts: string[] = [`${snapshot.postCount} posts`];
	const totalTokens = snapshot.totalUsage.input + snapshot.totalUsage.output;
	if (totalTokens > 0 || snapshot.totalUsage.cost > 0) {
		usageParts.push(
			`${snapshot.totalUsage.turns} turns`,
			`in ${formatTokenCount(snapshot.totalUsage.input)}`,
			`out ${formatTokenCount(snapshot.totalUsage.output)}`,
			formatCost(snapshot.totalUsage.cost),
		);
	}
	lines.push(`${SGR_NORMAL_RESET}${theme.fg("muted", usageParts.join(" · "))}`);
	for (const pool of snapshot.taskPools) {
		const activeCount = Object.keys(pool.inFlight).length;
		const failPart = pool.failed.length > 0 ? ` · ${pool.failed.length} failed` : "";
		lines.push(
			`${SGR_NORMAL_RESET}  ${theme.fg("accent", `pool:${pool.baseName}`)} ${theme.fg("muted", `${pool.completed.length}/${pool.totalTasks} done · ${activeCount} active · ${pool.pending.length} queued${failPart}`)}`,
		);
	}
	for (const member of snapshot.members) {
		lines.push(renderMemberRow(member, theme));
	}
	return lines.join("\n");
}

export function renderSwarmToolCall(
	args: {
		action?: string;
		name?: string;
		title?: string;
		model?: string;
		thinkingLevel?: string;
		workspace?: string;
		n?: number;
		tasks?: string[];
		concurrency?: number;
		maxTurns?: number;
		symlinkPaths?: string[];
		limit?: number;
	},
	theme: Theme,
): Text {
	let text = theme.fg("toolTitle", theme.bold("swarm ")) + theme.fg("muted", String(args.action ?? ""));
	if (args.name) text += ` ${theme.fg("accent", `@${args.name}`)}`;
	if (args.title) text += ` ${theme.fg("text", `"${args.title}"`)}`;
	const meta: string[] = [];
	if (args.model) meta.push(`model=${args.model}`);
	if (args.thinkingLevel) meta.push(`thinking=${args.thinkingLevel}`);
	if (args.workspace) meta.push(`workspace=${args.workspace}`);
	if (args.n !== undefined && args.n > 1) meta.push(`n=${args.n}`);
	if (args.tasks && args.tasks.length > 0) meta.push(`tasks=${args.tasks.length}`);
	if (args.concurrency !== undefined) meta.push(`concurrency=${args.concurrency}`);
	if (args.maxTurns !== undefined) meta.push(`maxTurns=${args.maxTurns}`);
	if (args.symlinkPaths && args.symlinkPaths.length > 0) meta.push(`symlink=${args.symlinkPaths.join(",")}`);
	if (args.limit !== undefined) meta.push(`limit=${args.limit}`);
	if (meta.length > 0) text += ` ${theme.fg("dim", `(${meta.join(", ")})`)}`;
	return new Text(text, 0, 0);
}

export function renderSwarmToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SwarmToolDetails },
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
	switch (details.action) {
		case "add": {
			const names = (details.added ?? []).map((n) => theme.fg("accent", `@${n}`)).join(", ");
			const extras: string[] = [];
			if (details.queuedCount && details.queuedCount > 0) {
				extras.push(`${details.queuedCount} queued`);
			}
			if (details.symlinked && details.symlinked.length > 0) {
				extras.push(`symlinked ${details.symlinked.join(", ")}`);
			}
			const suffix = extras.length > 0 ? ` ${theme.fg("dim", `(${extras.join(" · ")})`)}` : "";
			const warningLine =
				details.warnings && details.warnings.length > 0
					? `\n${theme.fg("warning", `⚠ ${details.warnings.join("; ")}`)}`
					: "";
			return new Text(`${theme.fg("success", "● Added")} ${names}${suffix}${warningLine}`, 0, 0);
		}
		case "kill": {
			return new Text(theme.fg("dim", `✗ Killed @${details.target ?? ""}`), 0, 0);
		}
		case "model": {
			const thinkingSuffix = details.thinkingLevel ? ` (thinking=${details.thinkingLevel})` : "";
			return new Text(
				`${theme.fg("accent", "○ Switched")} ${theme.fg("text", `@${details.target ?? ""}`)} ${theme.fg("dim", `-> ${details.model ?? ""}${thinkingSuffix}`)}`,
				0,
				0,
			);
		}
		case "title": {
			return new Text(`${theme.fg("accent", "Swarm title:")} ${theme.fg("text", details.title ?? "")}`, 0, 0);
		}
		case "status": {
			if (details.snapshot) {
				return new Text(renderThemedSwarmStatus(details.snapshot, theme), 0, 0);
			}
			return new Text(theme.fg("dim", "No active swarm"), 0, 0);
		}
		case "inspect": {
			if (!details.inspect) {
				const first = result.content[0];
				return new Text(first?.type === "text" && first.text ? first.text : "", 0, 0);
			}
			const { member, transcript, pool } = details.inspect;
			if (!options.expanded) {
				const stopPart = member.lastStopReason ? `:${member.lastStopReason}` : "";
				const head = `${theme.style(`@${member.name}`, { fg: memberStateColor(member.state), bold: true })} ${theme.fg("muted", `(${member.state}${stopPart} · ${member.usage.turns} turns · ${transcript.length} items)`)}`;
				const tail = transcript.slice(-3).map((item) => {
					const tagColor = item.kind === "error" ? "error" : item.kind === "tool" ? "accent" : "dim";
					return `  ${theme.fg(tagColor, `[${item.kind}]`)} ${theme.fg("text", item.summary.replace(/\s+/g, " ").slice(0, 90))}`;
				});
				return new Text([head, ...tail].join("\n"), 0, 0);
			}
			return new Text(theme.fg("dim", formatWorkerInspect(member, transcript, pool)), 0, 0);
		}
		case "models": {
			const raw = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
			const lines = raw.split("\n");
			if (!options.expanded && lines.length > 8) {
				return new Text(
					`${lines.slice(0, 8).join("\n")}\n${theme.fg("dim", `... ${lines.length - 8} more`)}`,
					0,
					0,
				);
			}
			return new Text(theme.fg("dim", raw), 0, 0);
		}
	}
}

export function renderBoardPostToolCall(
	args: { message?: string; messages?: Array<{ to?: string; message?: string }> },
	theme: Theme,
): Text {
	if (args.messages && args.messages.length > 0) {
		const targets = args.messages
			.map((m) => `@${(m.to ?? "").replace(/^@/, "")}`)
			.filter((t) => t.length > 1)
			.join(", ");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("board_post"))} ${theme.fg("dim", `batch(${args.messages.length}): ${targets}`)}`,
			0,
			0,
		);
	}
	const compact = (args.message ?? "").replace(/\s+/g, " ").trim();
	const preview = compact.length > 70 ? `${compact.slice(0, 67)}...` : compact;
	return new Text(`${theme.fg("toolTitle", theme.bold("board_post"))} ${theme.fg("dim", `"${preview}"`)}`, 0, 0);
}

export function renderBoardPostToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: BoardPostToolDetails },
	_options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}
	if (details?.posts && details.posts.length > 1) {
		const woke = details.woken?.length
			? ` ${theme.fg("muted", "->")} ${details.woken.map((w) => theme.fg("accent", `@${w}`)).join(" ")}`
			: "";
		return new Text(`${theme.fg("success", `✓ Posted ${details.posts.length} messages`)}${woke}`, 0, 0);
	}
	if (!details?.post) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "", 0, 0);
	}
	const woke = details.woken?.length
		? ` ${theme.fg("muted", "->")} ${details.woken.map((w) => theme.fg("accent", `@${w}`)).join(" ")}`
		: "";
	return new Text(`${theme.fg("success", `✓ Posted #${details.post.seq}`)}${woke}`, 0, 0);
}

export function renderBoardReadToolCall(args: { since_seq?: number; limit?: number }, theme: Theme): Text {
	const parts: string[] = [];
	if (args.since_seq !== undefined) parts.push(`since=#${args.since_seq}`);
	if (args.limit !== undefined) parts.push(`limit=${args.limit}`);
	const suffix = parts.length > 0 ? ` ${theme.fg("dim", `(${parts.join(", ")})`)}` : "";
	return new Text(`${theme.fg("toolTitle", theme.bold("board_read"))}${suffix}`, 0, 0);
}

export function renderBoardReadToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: BoardReadToolDetails },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}
	if (!details) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "", 0, 0);
	}
	if (details.posts.length === 0) {
		return new Text(theme.fg("dim", "No board posts"), 0, 0);
	}
	if (!options.expanded) {
		return new Text(
			theme.fg(
				"muted",
				`${details.posts.length} of ${details.totalPosts} board post${details.totalPosts === 1 ? "" : "s"}`,
			),
			0,
			0,
		);
	}
	const first = result.content[0];
	return new Text(theme.fg("dim", first?.type === "text" && first.text ? first.text : ""), 0, 0);
}

export function renderSwarmNotificationMessage(
	message: CustomMessage<SwarmNotificationDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details;
	if (!details || details.posts.length === 0) return undefined;

	const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
	const lines: string[] = [
		`${theme.style("[swarm board]", { fg: "accent", bold: true })} ${theme.fg("muted", `${details.posts.length} new message${details.posts.length === 1 ? "" : "s"}`)}`,
	];

	for (const post of details.posts) {
		const ts = formatPostTimestamp(post.timestamp);
		const mentions =
			post.mentions.length > 0
				? ` ${theme.fg("dim", "->")} ${post.mentions.map((m) => theme.fg("accent", `@${m}`)).join(" ")}`
				: "";
		const firstLine = post.body.split("\n")[0] ?? "";
		const preview = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
		lines.push(
			`  ${theme.fg("dim", `#${post.seq} [${ts}]`)} ${theme.style(`@${post.author}`, { fg: "success", bold: true })}${mentions}: ${theme.fg("text", preview)}`,
		);
	}

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

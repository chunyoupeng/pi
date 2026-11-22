import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SWARM_ENTRY_TYPE = "swarm-state";
export const SWARM_NOTIFICATION_TYPE = "swarm-board-notification";
export const SWARM_CONTEXT_TYPE = "swarm-coordinator-context";
export const SWARM_STATUS_KEY = "swarm";

export const COORDINATOR_NAME = "coordinator";
export const USER_AUTHOR = "user";

export const DEFAULT_MAX_CONCURRENT_TURNS = 4;
export const DEFAULT_NOTIFY_DEBOUNCE_MS = 250;
export const DEFAULT_MAX_TURNS_PER_WAKEUP = 25;
export const MAX_WORKER_NAME_LENGTH = 24;
export const MAX_SHARD_COUNT = 16;
export const MAX_POOL_TASKS = 64;

export const SWARM_ACTIONS = ["status", "models", "add", "model", "kill", "title", "inspect"] as const;
export type SwarmAction = (typeof SWARM_ACTIONS)[number];

export const SWARM_WORKSPACES = ["inherit", "share", "branch"] as const;
export type SwarmWorkspaceMode = (typeof SWARM_WORKSPACES)[number];

export type SwarmMemberState = "working" | "waiting" | "stopped" | "killed";

export type SwarmStopReason = "idle" | "max_turns" | "error" | "aborted";

export type SwarmBoardPostKind = "post" | "brief" | "system";

export interface SwarmWorkerIdleInfo {
	reason: SwarmStopReason;
	turnsUsed: number;
	maxTurns: number;
	lastOutput?: string;
	error?: string;
}

export interface SwarmTaskItem {
	index: number;
	task: string;
}

export interface SwarmTaskPool {
	id: string;
	baseName: string;
	addedBy: string;
	brief: string;
	concurrency: number;
	totalTasks: number;
	pending: SwarmTaskItem[];
	inFlight: Record<string, SwarmTaskItem>;
	completed: Array<{ index: number; task: string; worker: string }>;
	failed: Array<{ index: number; task: string; worker: string; reason: string }>;
}

export interface SwarmBoardPost {
	seq: number;
	timestamp: number;
	author: string;
	mentions: string[];
	body: string;
	kind: SwarmBoardPostKind;
}

export interface SwarmMemberUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SwarmTranscriptItem {
	timestamp: number;
	kind: "prompt" | "text" | "tool" | "error";
	summary: string;
}

export interface SwarmMemberRecord {
	name: string;
	role: "coordinator" | "worker";
	addedBy: string;
	state: SwarmMemberState;
	model: string;
	thinkingLevel: ThinkingLevel;
	workspace: SwarmWorkspaceMode;
	cwd: string;
	workspacePath?: string;
	repoRoot?: string;
	gitBranch?: string;
	sessionFile?: string;
	lastReadSeq: number;
	brief: string;
	createdAt: number;
	updatedAt: number;
	usage: SwarmMemberUsage;
	maxTurnsPerWakeup?: number;
	lastStopReason?: SwarmStopReason;
	lastWakeupTurns?: number;
	lastOutput?: string;
	lastError?: string;
	poolId?: string;
	currentTask?: SwarmTaskItem;
	symlinkPaths?: string[];
}

export interface SwarmMemberSnapshot extends SwarmMemberRecord {
	currentActivity?: string;
	unreadCount: number;
}

export interface SwarmManifest {
	id: string;
	title: string;
	repoRoot?: string;
	baseCwd: string;
	swarmDir: string;
	active: boolean;
	revision: number;
	createdAt: number;
	updatedAt: number;
	nextSeq: number;
	members: Record<string, SwarmMemberRecord>;
	taskPools?: Record<string, SwarmTaskPool>;
}

export interface SwarmSnapshot {
	id: string;
	title: string;
	active: boolean;
	revision: number;
	swarmDir: string;
	baseCwd: string;
	repoRoot?: string;
	postCount: number;
	members: SwarmMemberSnapshot[];
	taskPools: SwarmTaskPool[];
	totalUsage: SwarmMemberUsage;
	counts: {
		working: number;
		waiting: number;
		stopped: number;
		killed: number;
	};
}

export interface SwarmLinkEntry {
	swarmId: string;
	swarmDir: string;
	title: string;
	active: boolean;
	updatedAt: number;
}

export interface SwarmNotificationDetails {
	swarmId: string;
	title: string;
	posts: SwarmBoardPost[];
}

export interface SwarmToolDetails {
	action: SwarmAction;
	actor: string;
	title?: string;
	added?: string[];
	poolId?: string;
	queuedCount?: number;
	symlinked?: string[];
	warnings?: string[];
	target?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	snapshot?: SwarmSnapshot;
	inspect?: {
		member: SwarmMemberSnapshot;
		transcript: SwarmTranscriptItem[];
		pool?: SwarmTaskPool;
	};
	error?: string;
}

export interface BoardPostToolDetails {
	post?: SwarmBoardPost;
	posts?: SwarmBoardPost[];
	woken?: string[];
	error?: string;
}

export interface BoardReadToolDetails {
	posts: SwarmBoardPost[];
	totalPosts: number;
	error?: string;
}

const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function createEmptyUsage(): SwarmMemberUsage {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(base: SwarmMemberUsage, delta: Partial<SwarmMemberUsage>): SwarmMemberUsage {
	return {
		turns: base.turns + (delta.turns ?? 0),
		input: base.input + (delta.input ?? 0),
		output: base.output + (delta.output ?? 0),
		cacheRead: base.cacheRead + (delta.cacheRead ?? 0),
		cacheWrite: base.cacheWrite + (delta.cacheWrite ?? 0),
		cost: base.cost + (delta.cost ?? 0),
	};
}

/** Validate a swarm worker roster name. Returns an error message when invalid. */
export function validateWorkerName(name: string): string | undefined {
	if (!name) return "Worker name is required";
	if (name.length > MAX_WORKER_NAME_LENGTH) {
		return `Worker name '${name}' exceeds ${MAX_WORKER_NAME_LENGTH} characters`;
	}
	if (!WORKER_NAME_PATTERN.test(name)) {
		return `Invalid worker name '${name}': must be lowercase, start with a letter or digit, and use only a-z, 0-9, -, _`;
	}
	if (name === "all" || name === COORDINATOR_NAME || name.startsWith(`${COORDINATOR_NAME}-`) || name === USER_AUTHOR) {
		return `Worker name '${name}' is reserved`;
	}
	return undefined;
}

/** Expand single, homogeneous (`n`), or sharded (`tasks`) spawn inputs into concrete worker specs. */
export function expandSpawnSpecs(input: {
	name: string;
	brief: string;
	n?: number;
	tasks?: readonly string[];
}): Array<{ name: string; brief: string }> {
	const baseName = input.name.trim();
	const brief = input.brief.trim();
	if (!brief) {
		throw new Error("Parameter 'brief' is required for action 'add'");
	}
	if (input.n !== undefined && input.tasks !== undefined && input.tasks.length > 0) {
		throw new Error("Parameters 'n' and 'tasks' are mutually exclusive");
	}

	if (input.tasks !== undefined && input.tasks.length > 0) {
		if (input.tasks.length > MAX_SHARD_COUNT) {
			throw new Error(`Cannot spawn more than ${MAX_SHARD_COUNT} sharded workers at once`);
		}
		const specs: Array<{ name: string; brief: string }> = [];
		for (let i = 0; i < input.tasks.length; i++) {
			const shardName = `${baseName}-${i + 1}`;
			const err = validateWorkerName(shardName);
			if (err) throw new Error(err);
			const slice = input.tasks[i]!.trim();
			specs.push({
				name: shardName,
				brief: slice ? `${brief}\n\nYour assigned slice:\n${slice}` : brief,
			});
		}
		return specs;
	}

	if (input.n !== undefined) {
		if (!Number.isInteger(input.n) || input.n < 1 || input.n > MAX_SHARD_COUNT) {
			throw new Error(`Parameter 'n' must be an integer between 1 and ${MAX_SHARD_COUNT}`);
		}
		if (input.n > 1) {
			const specs: Array<{ name: string; brief: string }> = [];
			for (let i = 1; i <= input.n; i++) {
				const copyName = `${baseName}-${i}`;
				const err = validateWorkerName(copyName);
				if (err) throw new Error(err);
				specs.push({ name: copyName, brief });
			}
			return specs;
		}
	}

	const err = validateWorkerName(baseName);
	if (err) throw new Error(err);
	return [{ name: baseName, brief }];
}

/** Validate and expand a queued task pool (`tasks` with `concurrency < tasks.length`). */
export function expandPoolSpecs(input: {
	name: string;
	brief: string;
	tasks: readonly string[];
	concurrency: number;
}): { slotNames: string[]; tasks: SwarmTaskItem[] } {
	const baseName = input.name.trim();
	const brief = input.brief.trim();
	if (!brief) {
		throw new Error("Parameter 'brief' is required for action 'add'");
	}
	if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > MAX_SHARD_COUNT) {
		throw new Error(`Parameter 'concurrency' must be an integer between 1 and ${MAX_SHARD_COUNT}`);
	}
	if (input.tasks.length === 0) {
		throw new Error("Parameter 'concurrency' requires a non-empty 'tasks' array");
	}
	if (input.tasks.length > MAX_POOL_TASKS) {
		throw new Error(`Cannot queue more than ${MAX_POOL_TASKS} tasks in a single pool`);
	}

	const slotCount = Math.min(input.concurrency, input.tasks.length);
	const slotNames: string[] = [];
	if (slotCount === 1) {
		const err = validateWorkerName(baseName);
		if (err) throw new Error(err);
		slotNames.push(baseName);
	} else {
		for (let i = 1; i <= slotCount; i++) {
			const slotName = `${baseName}-${i}`;
			const err = validateWorkerName(slotName);
			if (err) throw new Error(err);
			slotNames.push(slotName);
		}
	}

	const tasks: SwarmTaskItem[] = input.tasks.map((raw, idx) => ({
		index: idx + 1,
		task: raw.trim(),
	}));
	return { slotNames, tasks };
}

/**
 * Extract valid `@mentions` from a board post body.
 * Ignores fenced code blocks, inline code, emails, and self-mentions.
 * Expands `@all` to all active members except the author.
 */
export function parseMentions(body: string, activeMembers: ReadonlySet<string>, author: string): string[] {
	// Strip fenced code blocks and inline code so code samples do not accidentally wake workers.
	const stripped = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
	const mentionRegex = /(?:^|[\s([{"',;:])@([a-z0-9][a-z0-9_-]{0,23})(?![a-z0-9_@.-])/gi;
	const found = new Set<string>();
	let sawAll = false;

	for (const match of stripped.matchAll(mentionRegex)) {
		const raw = match[1]?.toLowerCase();
		if (!raw) continue;
		if (raw === "all") {
			sawAll = true;
			continue;
		}
		if (raw === author) continue;
		if (activeMembers.has(raw)) {
			found.add(raw);
		}
	}

	if (sawAll) {
		for (const member of activeMembers) {
			if (member !== author) {
				found.add(member);
			}
		}
	}

	return [...found];
}

export function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
	if (cost <= 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatPostTimestamp(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export function formatSwarmStatus(snapshot: SwarmSnapshot): string {
	const lines: string[] = [
		`Swarm: ${snapshot.title || snapshot.id} (${snapshot.active ? "active" : "inactive"})`,
		`ID: ${snapshot.id} | Board posts: ${snapshot.postCount} | Working: ${snapshot.counts.working} | Waiting: ${snapshot.counts.waiting} | Stopped: ${snapshot.counts.stopped} | Killed: ${snapshot.counts.killed}`,
	];
	const totalTokens = snapshot.totalUsage.input + snapshot.totalUsage.output;
	if (totalTokens > 0 || snapshot.totalUsage.cost > 0) {
		lines.push(
			`Usage: ${snapshot.totalUsage.turns} turns | in ${formatTokenCount(snapshot.totalUsage.input)} | out ${formatTokenCount(snapshot.totalUsage.output)} | ${formatCost(snapshot.totalUsage.cost)}`,
		);
	}
	if (snapshot.taskPools.length > 0) {
		lines.push("", "Task pools:");
		for (const pool of snapshot.taskPools) {
			const activeCount = Object.keys(pool.inFlight).length;
			const parts = [
				`${pool.completed.length}/${pool.totalTasks} done`,
				`${activeCount} active`,
				`${pool.pending.length} queued`,
			];
			if (pool.failed.length > 0) parts.push(`${pool.failed.length} failed`);
			lines.push(`- ${pool.baseName} (concurrency ${pool.concurrency}): ${parts.join(", ")}`);
		}
	}
	if (snapshot.members.length === 0) {
		lines.push("Members: none");
		return lines.join("\n");
	}
	lines.push("", "Members:");
	for (const member of snapshot.members) {
		const stateLabel =
			member.state !== "working" && member.lastStopReason
				? `${member.state}:${member.lastStopReason}`
				: member.state;
		const parts: string[] = [stateLabel, member.model];
		if (member.thinkingLevel && member.thinkingLevel !== "off") {
			parts.push(`thinking: ${member.thinkingLevel}`);
		}
		if (member.role === "worker") {
			parts.push(member.workspace);
			if (member.gitBranch) parts.push(`branch ${member.gitBranch}`);
			if (member.addedBy !== COORDINATOR_NAME) parts.push(`by @${member.addedBy}`);
			if (member.usage.turns > 0) {
				const wakeupTurns =
					member.lastWakeupTurns !== undefined && member.state !== "working"
						? ` (last: ${member.lastWakeupTurns}/${member.maxTurnsPerWakeup ?? DEFAULT_MAX_TURNS_PER_WAKEUP})`
						: "";
				parts.push(`${member.usage.turns} turns${wakeupTurns}`);
			}
			if (member.currentTask) {
				const taskPreview = member.currentTask.task.replace(/\s+/g, " ");
				const shortTask = taskPreview.length > 40 ? `${taskPreview.slice(0, 37)}...` : taskPreview;
				parts.push(`task #${member.currentTask.index}: ${shortTask}`);
			}
		}
		if (member.currentActivity) {
			parts.push(member.currentActivity);
		}
		if (member.lastError && member.state !== "working") {
			parts.push(`error: ${member.lastError}`);
		} else if (member.lastOutput && member.state !== "working" && member.lastStopReason === "max_turns") {
			const compact = member.lastOutput.replace(/\s+/g, " ").trim();
			parts.push(`last: "${compact.length > 100 ? `${compact.slice(0, 97)}...` : compact}"`);
		}
		lines.push(`- @${member.name} (${parts.join(" | ")})`);
	}
	return lines.join("\n");
}

export function formatWorkerInspect(
	member: SwarmMemberSnapshot,
	transcript: readonly SwarmTranscriptItem[],
	pool?: SwarmTaskPool,
): string {
	const stateLabel =
		member.state !== "working" && member.lastStopReason
			? `${member.state} (stop_reason: ${member.lastStopReason})`
			: member.state;
	const lines: string[] = [
		`Worker @${member.name} — ${stateLabel}`,
		`Model: ${member.model} | Thinking: ${member.thinkingLevel} | Workspace: ${member.workspace}${member.gitBranch ? ` (${member.gitBranch})` : ""}`,
		`CWD: ${member.cwd}`,
		`Usage: ${member.usage.turns} total turns${member.lastWakeupTurns !== undefined ? ` (last wakeup: ${member.lastWakeupTurns}/${member.maxTurnsPerWakeup ?? DEFAULT_MAX_TURNS_PER_WAKEUP})` : ""} | in ${formatTokenCount(member.usage.input)} | out ${formatTokenCount(member.usage.output)} | ${formatCost(member.usage.cost)}`,
	];
	if (member.currentActivity) {
		lines.push(`Activity: ${member.currentActivity}`);
	}
	if (member.currentTask) {
		const totalLabel = pool ? `/${pool.totalTasks}` : "";
		lines.push(`Current task: #${member.currentTask.index}${totalLabel} — ${member.currentTask.task}`);
	}
	if (pool) {
		lines.push(
			`Pool '${pool.baseName}': ${pool.completed.length}/${pool.totalTasks} done, ${Object.keys(pool.inFlight).length} active, ${pool.pending.length} queued, ${pool.failed.length} failed`,
		);
	}
	if (member.lastError) {
		lines.push(`Last error: ${member.lastError}`);
	}
	if (member.lastOutput) {
		lines.push(`Last output: ${member.lastOutput}`);
	}
	lines.push("", `Recent transcript (${transcript.length} items):`);
	if (transcript.length === 0) {
		lines.push("  (no transcript items recorded)");
	} else {
		for (const item of transcript) {
			lines.push(`  [${formatPostTimestamp(item.timestamp)}] [${item.kind}] ${item.summary}`);
		}
	}
	return lines.join("\n");
}

export function formatBoardPosts(posts: readonly SwarmBoardPost[]): string {
	if (posts.length === 0) return "No board messages.";
	return posts
		.map((post) => {
			const mentionTag = post.mentions.length > 0 ? ` -> ${post.mentions.map((m) => `@${m}`).join(" ")}` : "";
			const kindTag = post.kind === "post" ? "" : ` [${post.kind}]`;
			return `#${post.seq} [${formatPostTimestamp(post.timestamp)}] @${post.author}${mentionTag}${kindTag}:\n${post.body}`;
		})
		.join("\n\n");
}

export function formatCoordinatorNotification(posts: readonly SwarmBoardPost[], snapshot: SwarmSnapshot): string {
	const header = `[Swarm board update: ${snapshot.title || snapshot.id} (${snapshot.counts.working} working, ${snapshot.counts.waiting} waiting)]`;
	return `${header}\n\n${formatBoardPosts(posts)}`;
}

export function formatWorkerBoardDelivery(posts: readonly SwarmBoardPost[], workerName: string): string {
	const header = `[Swarm board messages for @${workerName}]`;
	const body = formatBoardPosts(posts);
	const footer =
		"Respond using the `board_post` tool with `@mentions` when you have updates, questions, or handoffs. Do not post empty acknowledgements or thanks.";
	return `${header}\n\n${body}\n\n${footer}`;
}

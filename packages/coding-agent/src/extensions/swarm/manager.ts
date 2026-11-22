import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { FileEntry } from "../../core/session-manager.ts";
import { SwarmStore } from "./store.ts";
import {
	COORDINATOR_NAME,
	createEmptyUsage,
	DEFAULT_MAX_CONCURRENT_TURNS,
	DEFAULT_MAX_TURNS_PER_WAKEUP,
	DEFAULT_NOTIFY_DEBOUNCE_MS,
	expandPoolSpecs,
	expandSpawnSpecs,
	formatBoardPosts,
	formatSwarmStatus,
	formatWorkerBoardDelivery,
	formatWorkerInspect,
	parseMentions,
	SWARM_ACTIONS,
	SWARM_WORKSPACES,
	type SwarmBoardPost,
	type SwarmBoardPostKind,
	type SwarmLinkEntry,
	type SwarmManifest,
	type SwarmMemberRecord,
	type SwarmMemberSnapshot,
	type SwarmSnapshot,
	type SwarmTaskItem,
	type SwarmTaskPool,
	type SwarmTranscriptItem,
	type SwarmWorkerIdleInfo,
	type SwarmWorkspaceMode,
	USER_AUTHOR,
} from "./types.ts";
import {
	createPiSwarmWorker,
	readSessionTranscriptTail,
	type SwarmForkSource,
	type SwarmWorkerFactory,
	type SwarmWorkerHandle,
} from "./worker.ts";
import { defaultSwarmWorkspaceOps, type SwarmWorkspaceOps } from "./workspace.ts";

export interface SwarmHostContext {
	cwd: string;
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	modelRegistry: ModelRegistry;
	sessionFile?: string;
	getSessionEntries?: () => readonly FileEntry[];
}

export interface SwarmAddInput {
	name: string;
	brief: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	fork?: string;
	workspace?: SwarmWorkspaceMode;
	n?: number;
	tasks?: string[];
	concurrency?: number;
	maxTurns?: number;
	symlinkPaths?: string[];
}

export interface SwarmAddResult {
	added: string[];
	snapshot: SwarmSnapshot;
	poolId?: string;
	queuedCount?: number;
	symlinked?: string[];
	warnings?: string[];
}

export interface SwarmBatchMessageItem {
	to: string;
	message: string;
}

export interface SwarmInspectResult {
	member: SwarmMemberSnapshot;
	transcript: SwarmTranscriptItem[];
	pool?: SwarmTaskPool;
}

export interface SwarmModelSwitchInput {
	name?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	reason?: string;
}

export interface SwarmKillInput {
	name: string;
	force?: boolean;
}

export interface SwarmManagerOptions {
	storageRoot?: string;
	workspaceOps?: SwarmWorkspaceOps;
	workerFactory?: SwarmWorkerFactory;
	maxConcurrentTurns?: number;
	debounceMs?: number;
	maxTurnsPerWakeup?: number;
	now?: () => number;
	onPersistLink?: (entry: SwarmLinkEntry) => void;
	onCoordinatorNotify?: (posts: SwarmBoardPost[], snapshot: SwarmSnapshot) => void;
	onCoordinatorModelSwitch?: (model: Model<Api>) => Promise<boolean>;
	onCoordinatorThinkingLevelSwitch?: (level: ThinkingLevel) => void;
	onStateChange?: () => void;
}

interface PendingWakeup {
	timer: NodeJS.Timeout | undefined;
	steer: boolean;
}

function modelLabel(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown";
}

function isValidThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVEL_OPTIONS as readonly string[]).includes(value);
}

function validateThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
	if (level === undefined) return undefined;
	const normalized = level.trim().toLowerCase();
	if (!isValidThinkingLevel(normalized)) {
		throw new Error(`Invalid thinkingLevel '${level}'. Valid values: ${THINKING_LEVEL_OPTIONS.join(", ")}.`);
	}
	return normalized;
}

function findModelBySpec(spec: string, modelRegistry: ModelRegistry): Model<Api> | undefined {
	const slash = spec.indexOf("/");
	if (slash !== -1) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const exact = modelRegistry.find(provider, id);
		if (exact) return exact;
	}

	const lower = spec.toLowerCase();
	const candidates = [...modelRegistry.getAvailable(), ...modelRegistry.getAll()];
	const byId = candidates.find((m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (byId) return byId;
	return candidates.find((m) => m.name.toLowerCase() === lower);
}

function resolveModelSpec(
	spec: string | undefined,
	modelRegistry: ModelRegistry,
	fallback: Model<Api> | undefined,
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } {
	if (!spec || !spec.trim()) {
		if (!fallback) {
			throw new Error("No model available for swarm worker; specify 'model' or select a model first");
		}
		return { model: fallback };
	}
	const trimmed = spec.trim();
	const direct = findModelBySpec(trimmed, modelRegistry);
	if (direct) return { model: direct };

	const colonIdx = trimmed.lastIndexOf(":");
	if (colonIdx > 0) {
		const suffix = trimmed.slice(colonIdx + 1).toLowerCase();
		if (isValidThinkingLevel(suffix)) {
			const base = trimmed.slice(0, colonIdx).trim();
			const baseModel = base ? findModelBySpec(base, modelRegistry) : undefined;
			if (baseModel) {
				return { model: baseModel, thinkingLevel: suffix };
			}
		}
	}

	throw new Error(`Model '${spec}' not found. Run swarm with action='models' to see available models.`);
}

export function createHostContextFromExtension(ctx: ExtensionContext): SwarmHostContext {
	return {
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel ?? "off",
		modelRegistry: ctx.modelRegistry,
		sessionFile: ctx.sessionManager.getSessionFile(),
		getSessionEntries: () => ctx.sessionManager.getEntries(),
	};
}

export class SwarmManager {
	private readonly store: SwarmStore;
	private readonly workspaceOps: SwarmWorkspaceOps;
	private readonly workerFactory: SwarmWorkerFactory;
	private readonly maxConcurrentTurns: number;
	private readonly debounceMs: number;
	private readonly maxTurnsPerWakeup: number;
	private readonly now: () => number;
	private readonly onPersistLink?: (entry: SwarmLinkEntry) => void;
	private readonly onCoordinatorNotify?: (posts: SwarmBoardPost[], snapshot: SwarmSnapshot) => void;
	private readonly onCoordinatorModelSwitch?: (model: Model<Api>) => Promise<boolean>;
	private readonly onCoordinatorThinkingLevelSwitch?: (level: ThinkingLevel) => void;
	private readonly onStateChange?: () => void;

	private manifest: SwarmManifest | undefined;
	private posts: SwarmBoardPost[] = [];
	private hostContext: SwarmHostContext | undefined;
	private readonly liveWorkers = new Map<string, SwarmWorkerHandle>();
	private readonly activities = new Map<string, string>();
	private readonly postedThisWakeup = new Set<string>();
	private readonly pendingWakeups = new Map<string, PendingWakeup>();
	private coordinatorTimer: NodeJS.Timeout | undefined;
	private readonly slotQueue: Array<{ name: string; steer: boolean }> = [];
	private readonly changeListeners = new Set<() => void>();
	private disposed = false;

	constructor(options: SwarmManagerOptions = {}) {
		this.store = new SwarmStore(options.storageRoot);
		this.workspaceOps = options.workspaceOps ?? defaultSwarmWorkspaceOps;
		this.workerFactory = options.workerFactory ?? createPiSwarmWorker;
		this.maxConcurrentTurns = Math.max(1, options.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS);
		this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_NOTIFY_DEBOUNCE_MS);
		this.maxTurnsPerWakeup = Math.max(1, options.maxTurnsPerWakeup ?? DEFAULT_MAX_TURNS_PER_WAKEUP);
		this.now = options.now ?? (() => Date.now());
		this.onPersistLink = options.onPersistLink;
		this.onCoordinatorNotify = options.onCoordinatorNotify;
		this.onCoordinatorModelSwitch = options.onCoordinatorModelSwitch;
		this.onCoordinatorThinkingLevelSwitch = options.onCoordinatorThinkingLevelSwitch;
		this.onStateChange = options.onStateChange;
	}

	subscribe(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	setHostContext(host: SwarmHostContext): void {
		this.hostContext = host;
		if (this.manifest) {
			const coord = this.manifest.members[COORDINATOR_NAME];
			if (coord) {
				coord.cwd = host.cwd;
				coord.model = modelLabel(host.model);
				coord.thinkingLevel = host.thinkingLevel;
				coord.sessionFile = host.sessionFile;
			}
		}
	}

	hasSwarm(): boolean {
		return this.manifest !== undefined;
	}

	isActive(): boolean {
		return this.manifest?.active === true;
	}

	getRevision(): number {
		return this.manifest?.revision ?? 0;
	}

	getPosts(): readonly SwarmBoardPost[] {
		return this.posts;
	}

	getWorkerTranscript(name: string, limit?: number): readonly SwarmTranscriptItem[] {
		const cleanName = name.trim().replace(/^@/, "");
		const live = this.liveWorkers.get(cleanName)?.getTranscript();
		if (live && live.length > 0) {
			return limit !== undefined && limit > 0 && live.length > limit ? live.slice(-limit) : live;
		}
		const sessionFile = this.manifest?.members[cleanName]?.sessionFile;
		return readSessionTranscriptTail(sessionFile, limit ?? 40);
	}

	inspectWorker(name: string, limit = 20): SwarmInspectResult {
		const snap = this.getSnapshot();
		if (!snap) {
			throw new Error("No active swarm.");
		}
		const cleanName = name.trim().replace(/^@/, "");
		if (!cleanName) {
			throw new Error("Parameter 'name' is required for action 'inspect'");
		}
		const member = snap.members.find((m) => m.name === cleanName);
		if (!member) {
			throw new Error(`Unknown swarm member '@${cleanName}'`);
		}
		const effectiveLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 80) : 20;
		const transcript = [...this.getWorkerTranscript(cleanName, effectiveLimit)];
		const pool = member.poolId ? snap.taskPools.find((p) => p.id === member.poolId) : undefined;
		return { member, transcript, pool };
	}

	getSnapshot(): SwarmSnapshot | undefined {
		if (!this.manifest) return undefined;
		const counts = { working: 0, waiting: 0, stopped: 0, killed: 0 };
		let totalUsage = createEmptyUsage();
		const members: SwarmMemberSnapshot[] = [];
		const latestSeq = this.posts.length > 0 ? this.posts[this.posts.length - 1]!.seq : 0;

		const orderedNames = [
			COORDINATOR_NAME,
			...Object.keys(this.manifest.members)
				.filter((name) => name !== COORDINATOR_NAME)
				.sort(),
		];

		for (const name of orderedNames) {
			const record = this.manifest.members[name];
			if (!record) continue;
			if (record.role === "worker") {
				counts[record.state]++;
			}
			totalUsage = {
				turns: totalUsage.turns + record.usage.turns,
				input: totalUsage.input + record.usage.input,
				output: totalUsage.output + record.usage.output,
				cacheRead: totalUsage.cacheRead + record.usage.cacheRead,
				cacheWrite: totalUsage.cacheWrite + record.usage.cacheWrite,
				cost: totalUsage.cost + record.usage.cost,
			};
			const unreadCount = Math.max(0, latestSeq - record.lastReadSeq);
			members.push({
				...record,
				usage: { ...record.usage },
				currentTask: record.currentTask ? { ...record.currentTask } : undefined,
				symlinkPaths: record.symlinkPaths ? [...record.symlinkPaths] : undefined,
				currentActivity: this.activities.get(name),
				unreadCount,
			});
		}

		const taskPools: SwarmTaskPool[] = Object.values(this.manifest.taskPools ?? {}).map((pool) => ({
			...pool,
			pending: pool.pending.map((item) => ({ ...item })),
			inFlight: Object.fromEntries(Object.entries(pool.inFlight).map(([k, v]) => [k, { ...v }])),
			completed: pool.completed.map((item) => ({ ...item })),
			failed: pool.failed.map((item) => ({ ...item })),
		}));

		return {
			id: this.manifest.id,
			title: this.manifest.title,
			active: this.manifest.active,
			revision: this.manifest.revision,
			swarmDir: this.manifest.swarmDir,
			baseCwd: this.manifest.baseCwd,
			repoRoot: this.manifest.repoRoot,
			postCount: this.posts.length,
			members,
			taskPools,
			totalUsage,
			counts,
		};
	}

	getStatusText(): string | undefined {
		const snap = this.getSnapshot();
		if (!snap) return undefined;
		const workerCount = snap.counts.working + snap.counts.waiting + snap.counts.stopped;
		if (!snap.active && workerCount === 0) return undefined;
		const parts: string[] = [];
		if (snap.counts.working > 0) parts.push(`${snap.counts.working} working`);
		if (snap.counts.waiting > 0) parts.push(`${snap.counts.waiting} waiting`);
		if (snap.counts.stopped > 0) parts.push(`${snap.counts.stopped} stopped`);
		if (parts.length === 0) parts.push("idle");
		parts.push(`${snap.postCount} post${snap.postCount === 1 ? "" : "s"}`);
		return `swarm: ${parts.join(", ")}`;
	}

	async ensureSwarm(host: SwarmHostContext, title?: string): Promise<SwarmSnapshot> {
		this.setHostContext(host);
		if (this.manifest) {
			if (!this.manifest.active) {
				this.manifest.active = true;
				this.manifest.revision++;
				this.manifest.updatedAt = this.now();
				this.saveManifestAndLink();
				this.notifyChange();
			}
			return this.getSnapshot()!;
		}

		const now = this.now();
		const id = `sw-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const swarmDir = this.store.ensureSwarmDir(id);
		const repoRoot = await this.workspaceOps.resolveGitRoot(host.cwd);

		const coordinator: SwarmMemberRecord = {
			name: COORDINATOR_NAME,
			role: "coordinator",
			addedBy: USER_AUTHOR,
			state: "waiting",
			model: modelLabel(host.model),
			thinkingLevel: host.thinkingLevel,
			workspace: "inherit",
			cwd: host.cwd,
			repoRoot,
			sessionFile: host.sessionFile,
			lastReadSeq: 0,
			brief: "Swarm coordinator",
			createdAt: now,
			updatedAt: now,
			usage: createEmptyUsage(),
		};

		this.manifest = {
			id,
			title: title?.trim() || "Swarm",
			repoRoot,
			baseCwd: host.cwd,
			swarmDir,
			active: true,
			revision: 1,
			createdAt: now,
			updatedAt: now,
			nextSeq: 1,
			members: {
				[COORDINATOR_NAME]: coordinator,
			},
		};
		this.posts = [];
		this.saveManifestAndLink();
		this.notifyChange();
		return this.getSnapshot()!;
	}

	/** Restore a previously linked swarm from disk; non-killed workers start as `stopped` until woken. */
	restoreFromLink(link: SwarmLinkEntry, host: SwarmHostContext): boolean {
		this.setHostContext(host);
		const loaded = this.store.loadManifest(link.swarmDir);
		if (!loaded) return false;

		this.resetRuntimeState();
		for (const member of Object.values(loaded.members)) {
			if (member.role === "worker" && (member.state === "working" || member.state === "waiting")) {
				member.state = "stopped";
			}
		}
		if (loaded.members[COORDINATOR_NAME]) {
			loaded.members[COORDINATOR_NAME]!.cwd = host.cwd;
			loaded.members[COORDINATOR_NAME]!.model = modelLabel(host.model);
			loaded.members[COORDINATOR_NAME]!.thinkingLevel = host.thinkingLevel;
			loaded.members[COORDINATOR_NAME]!.sessionFile = host.sessionFile;
		}
		loaded.active = link.active;
		this.manifest = loaded;
		this.posts = this.store.loadPosts(link.swarmDir);
		this.store.saveManifest(loaded);
		this.notifyChange();
		return true;
	}

	async setTitle(actor: string, title: string, host: SwarmHostContext): Promise<SwarmSnapshot> {
		if (actor !== COORDINATOR_NAME) {
			throw new Error("Only the coordinator can set the swarm title");
		}
		const trimmed = title.trim();
		if (!trimmed) {
			throw new Error("Parameter 'title' is required for action 'title'");
		}
		await this.ensureSwarm(host, trimmed);
		this.manifest!.title = trimmed;
		this.manifest!.revision++;
		this.manifest!.updatedAt = this.now();
		this.saveManifestAndLink();
		this.notifyChange();
		return this.getSnapshot()!;
	}

	listModels(modelRegistry: ModelRegistry, all = false): string {
		const models = all ? modelRegistry.getAll() : modelRegistry.getAvailable();
		if (models.length === 0) {
			return all
				? "No models found in catalog."
				: "No models with configured credentials. Pass all=true to inspect the full catalog.";
		}
		const limit = 150;
		const lines = models.slice(0, limit).map((m) => `${m.provider}/${m.id} (${m.name})`);
		if (models.length > limit) {
			lines.push(`... and ${models.length - limit} more models`);
		}
		return lines.join("\n");
	}

	async addWorkers(actor: string, input: SwarmAddInput, host: SwarmHostContext): Promise<SwarmAddResult> {
		await this.ensureSwarm(host);
		const manifest = this.manifest!;
		const actorRecord = manifest.members[actor];
		if (!actorRecord || actorRecord.state === "killed") {
			throw new Error(`Unknown or killed actor '${actor}'`);
		}

		if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1)) {
			throw new Error("Parameter 'maxTurns' must be a positive integer");
		}
		if (input.concurrency !== undefined && (!input.tasks || input.tasks.length === 0)) {
			throw new Error("Parameter 'concurrency' requires a non-empty 'tasks' array");
		}

		const isPoolMode =
			input.tasks !== undefined &&
			input.tasks.length > 0 &&
			input.concurrency !== undefined &&
			input.concurrency < input.tasks.length;

		let poolId: string | undefined;
		let pool: SwarmTaskPool | undefined;
		let specs: Array<{ name: string; brief: string; initialTask?: SwarmTaskItem }>;

		if (isPoolMode) {
			const expanded = expandPoolSpecs({
				name: input.name,
				brief: input.brief,
				tasks: input.tasks!,
				concurrency: input.concurrency!,
			});
			poolId = `pool-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			const initialTasks = expanded.tasks.slice(0, expanded.slotNames.length);
			const remainingTasks = expanded.tasks.slice(expanded.slotNames.length);
			const inFlight: Record<string, SwarmTaskItem> = {};
			specs = expanded.slotNames.map((slotName, idx) => {
				const task = initialTasks[idx]!;
				inFlight[slotName] = task;
				return { name: slotName, brief: input.brief.trim(), initialTask: task };
			});
			pool = {
				id: poolId,
				baseName: input.name.trim(),
				addedBy: actor,
				brief: input.brief.trim(),
				concurrency: expanded.slotNames.length,
				totalTasks: expanded.tasks.length,
				pending: remainingTasks,
				inFlight,
				completed: [],
				failed: [],
			};
		} else {
			if (input.concurrency !== undefined) {
				if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
					throw new Error("Parameter 'concurrency' must be a positive integer");
				}
			}
			specs = expandSpawnSpecs({
				name: input.name,
				brief: input.brief,
				n: input.n,
				tasks: input.tasks,
			});
		}

		for (const spec of specs) {
			const existing = manifest.members[spec.name];
			if (existing) {
				throw new Error(`Member '@${spec.name}' already exists (state: ${existing.state})`);
			}
		}

		const workspaceMode: SwarmWorkspaceMode = input.workspace ?? "inherit";
		const fallbackModel = this.resolveActorModel(actorRecord, host);
		const resolvedSpec = resolveModelSpec(input.model, host.modelRegistry, fallbackModel);
		const targetModel = resolvedSpec.model;
		const explicitThinking = validateThinkingLevel(input.thinkingLevel) ?? resolvedSpec.thinkingLevel;
		const requestedThinking = explicitThinking ?? actorRecord.thinkingLevel ?? host.thinkingLevel;
		const targetThinking = clampThinkingLevel(targetModel, requestedThinking) as ThinkingLevel;
		const effectiveMaxTurns = input.maxTurns ?? this.maxTurnsPerWakeup;

		let forkSource: SwarmForkSource | undefined;
		if (input.fork) {
			const forkTarget = input.fork.trim().replace(/^@/, "");
			const sourceRecord = manifest.members[forkTarget];
			if (!sourceRecord) {
				throw new Error(`Cannot fork from unknown member '${forkTarget}'`);
			}
			if (forkTarget === COORDINATOR_NAME) {
				forkSource = {
					sessionFile: host.sessionFile,
					entries: host.getSessionEntries?.(),
				};
			} else {
				forkSource = {
					sessionFile: sourceRecord.sessionFile,
				};
			}
		}

		const baseCwd = actorRecord.cwd;
		const added: string[] = [];
		const symlinkedSet = new Set<string>();
		const warningSet = new Set<string>();

		for (const spec of specs) {
			const provisioned = await this.workspaceOps.provision({
				mode: workspaceMode,
				baseCwd,
				swarmDir: manifest.swarmDir,
				swarmId: manifest.id,
				memberName: spec.name,
				symlinkPaths: input.symlinkPaths,
			});
			for (const p of provisioned.symlinked ?? []) symlinkedSet.add(p);
			for (const w of provisioned.warnings ?? []) warningSet.add(w);

			const now = this.now();
			const record: SwarmMemberRecord = {
				name: spec.name,
				role: "worker",
				addedBy: actor,
				state: "waiting",
				model: modelLabel(targetModel),
				thinkingLevel: targetThinking,
				workspace: workspaceMode,
				cwd: provisioned.cwd,
				workspacePath: provisioned.workspacePath,
				repoRoot: provisioned.repoRoot ?? manifest.repoRoot,
				gitBranch: provisioned.gitBranch,
				lastReadSeq: 0,
				brief: spec.brief,
				createdAt: now,
				updatedAt: now,
				usage: createEmptyUsage(),
				maxTurnsPerWakeup: effectiveMaxTurns,
				poolId,
				currentTask: spec.initialTask,
				symlinkPaths: provisioned.symlinked,
			};
			manifest.members[spec.name] = record;

			try {
				const handle = await this.instantiateWorker(record, targetModel, host, forkSource);
				record.sessionFile = handle.sessionFile;
			} catch (err) {
				delete manifest.members[spec.name];
				await this.workspaceOps.cleanup({
					mode: workspaceMode,
					workspacePath: provisioned.workspacePath,
					repoRoot: provisioned.repoRoot,
					gitBranch: provisioned.gitBranch,
					symlinkPaths: provisioned.symlinked,
				});
				throw err;
			}

			added.push(spec.name);
		}

		if (pool) {
			manifest.taskPools = manifest.taskPools ?? {};
			manifest.taskPools[pool.id] = pool;
		}

		manifest.revision++;
		manifest.updatedAt = this.now();
		this.saveManifestAndLink();

		if (pool) {
			// Post one shared brief for the pool, then concise per-slot initial task assignments.
			this.postMessage(
				actor,
				`[Task Pool '${pool.baseName}': ${pool.totalTasks} tasks, concurrency ${pool.concurrency}]\n\n${pool.brief}`,
				{ kind: "brief", explicitMentions: [] },
			);
			for (const spec of specs) {
				const task = spec.initialTask!;
				const slotBody = [
					`@${spec.name} Assigned task ${task.index}/${pool.totalTasks} (pool '${pool.baseName}'):`,
					task.task,
					"",
					"Follow the shared pool brief above. When you finish this task, end your turn cleanly (optionally posting a short summary without waking @coordinator) and the next queued task will be assigned automatically with a fresh turn budget.",
				].join("\n");
				this.postMessage(actor, slotBody, {
					kind: "brief",
					explicitMentions: [spec.name],
					immediate: true,
				});
			}
		} else {
			// Post public assignment briefs on the shared board mentioning each spawned worker so everyone sees them.
			for (const spec of specs) {
				const briefBody = `@${spec.name} ${spec.brief}`;
				this.postMessage(actor, briefBody, {
					kind: "brief",
					explicitMentions: [spec.name],
					immediate: true,
				});
			}
		}

		this.notifyChange();
		const symlinked = [...symlinkedSet];
		const warnings = [...warningSet];
		return {
			added,
			snapshot: this.getSnapshot()!,
			poolId,
			queuedCount: pool?.pending.length,
			symlinked: symlinked.length > 0 ? symlinked : undefined,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	async switchModel(
		actor: string,
		input: SwarmModelSwitchInput,
		host: SwarmHostContext,
	): Promise<{ target: string; model: string; thinkingLevel: ThinkingLevel; snapshot: SwarmSnapshot }> {
		await this.ensureSwarm(host);
		const manifest = this.manifest!;
		const targetName = (input.name?.trim() || actor).replace(/^@/, "");
		const target = manifest.members[targetName];
		if (!target) {
			throw new Error(`Unknown swarm member '@${targetName}'`);
		}

		if (actor !== COORDINATOR_NAME && targetName !== actor && target.addedBy !== actor) {
			throw new Error(`Worker '@${actor}' may only switch the model of itself or workers it added`);
		}

		const hasModelSpec = Boolean(input.model?.trim());
		const explicitThinking = validateThinkingLevel(input.thinkingLevel);
		if (!hasModelSpec && explicitThinking === undefined) {
			throw new Error("At least one of 'model' or 'thinkingLevel' is required for action 'model'");
		}

		const fallbackModel = this.resolveActorModel(target, host);
		const resolvedSpec = resolveModelSpec(input.model, host.modelRegistry, fallbackModel);
		const resolvedModel = resolvedSpec.model;
		const label = modelLabel(resolvedModel);
		const hasExplicitThinking = explicitThinking !== undefined || resolvedSpec.thinkingLevel !== undefined;
		const requestedThinking = explicitThinking ?? resolvedSpec.thinkingLevel ?? target.thinkingLevel;
		const effectiveThinking = clampThinkingLevel(resolvedModel, requestedThinking) as ThinkingLevel;

		if (targetName === COORDINATOR_NAME) {
			if (hasModelSpec && this.onCoordinatorModelSwitch) {
				const ok = await this.onCoordinatorModelSwitch(resolvedModel);
				if (!ok) {
					throw new Error(`Failed to switch coordinator model to ${label}: credentials may not be configured`);
				}
			}
			if (hasExplicitThinking && this.onCoordinatorThinkingLevelSwitch) {
				this.onCoordinatorThinkingLevelSwitch(effectiveThinking);
			}
			target.model = label;
			target.thinkingLevel = effectiveThinking;
			target.updatedAt = this.now();
			manifest.updatedAt = target.updatedAt;
			this.store.saveManifest(manifest);
			this.postMessage(
				actor,
				`Switched @${COORDINATOR_NAME} model to ${label} (thinking: ${effectiveThinking})${input.reason ? ` (${input.reason})` : ""}.`,
				{ kind: "system", explicitMentions: [] },
			);
			this.notifyChange();
			return { target: targetName, model: label, thinkingLevel: effectiveThinking, snapshot: this.getSnapshot()! };
		}

		if (target.state === "killed") {
			throw new Error(`Cannot switch model for killed worker '@${targetName}'`);
		}
		if (target.state === "working") {
			throw new Error(`Cannot switch model while '@${targetName}' is working; wait until it is waiting`);
		}

		const handle = await this.ensureWorkerLoaded(targetName, host, resolvedModel);
		handle.setModel(resolvedModel, effectiveThinking);
		target.model = label;
		target.thinkingLevel = effectiveThinking;
		target.state = "waiting";
		target.updatedAt = this.now();
		manifest.updatedAt = target.updatedAt;
		this.store.saveManifest(manifest);

		const reasonPart = input.reason ? ` Reason: ${input.reason}.` : "";
		this.postMessage(
			actor,
			`@${targetName} Your model was switched to ${label} (thinking: ${effectiveThinking}).${reasonPart} Resume any unfinished work on this model.`,
			{ kind: "system", explicitMentions: [targetName], immediate: true },
		);
		this.notifyChange();
		return { target: targetName, model: label, thinkingLevel: effectiveThinking, snapshot: this.getSnapshot()! };
	}

	async killWorker(
		actor: string,
		input: SwarmKillInput,
		host: SwarmHostContext,
	): Promise<{ target: string; snapshot: SwarmSnapshot }> {
		await this.ensureSwarm(host);
		const manifest = this.manifest!;
		const targetName = input.name.trim().replace(/^@/, "");
		if (!targetName || targetName === COORDINATOR_NAME) {
			throw new Error("Cannot kill the coordinator");
		}
		const target = manifest.members[targetName];
		if (!target) {
			throw new Error(`Unknown swarm worker '@${targetName}'`);
		}
		if (actor !== COORDINATOR_NAME && target.addedBy !== actor) {
			throw new Error(`Worker '@${actor}' may only kill helpers it added`);
		}
		if (target.state === "killed") {
			return { target: targetName, snapshot: this.getSnapshot()! };
		}

		if (!input.force) {
			const unlanded = await this.workspaceOps.checkUnlandedWork({
				mode: target.workspace,
				workspacePath: target.workspacePath,
				repoRoot: target.repoRoot,
				gitBranch: target.gitBranch,
				symlinkPaths: target.symlinkPaths,
			});
			if (unlanded) {
				throw new Error(unlanded);
			}
		}

		this.cancelPendingWakeup(targetName);
		this.removeFromSlotQueue(targetName);
		this.postedThisWakeup.delete(targetName);

		const live = this.liveWorkers.get(targetName);
		if (live) {
			this.liveWorkers.delete(targetName);
			live.dispose();
		}
		this.activities.delete(targetName);

		if (target.poolId && manifest.taskPools?.[target.poolId]) {
			const pool = manifest.taskPools[target.poolId]!;
			const inFlightTask = pool.inFlight[targetName];
			if (inFlightTask) {
				delete pool.inFlight[targetName];
				pool.failed.push({ ...inFlightTask, worker: targetName, reason: "killed" });
			}
			target.currentTask = undefined;
		}

		await this.workspaceOps.cleanup({
			mode: target.workspace,
			workspacePath: target.workspacePath,
			repoRoot: target.repoRoot,
			gitBranch: target.gitBranch,
			symlinkPaths: target.symlinkPaths,
		});

		target.state = "killed";
		target.updatedAt = this.now();
		manifest.revision++;
		manifest.updatedAt = target.updatedAt;
		this.saveManifestAndLink();

		this.postMessage(actor, `Killed worker @${targetName} permanently.`, {
			kind: "system",
			explicitMentions: [],
		});
		this.drainSlotQueue();
		this.notifyChange();
		return { target: targetName, snapshot: this.getSnapshot()! };
	}

	postMessage(
		author: string,
		body: string,
		options?: {
			kind?: SwarmBoardPostKind;
			explicitMentions?: string[];
			steer?: boolean;
			immediate?: boolean;
		},
	): { post: SwarmBoardPost; woken: string[] } {
		if (!this.manifest) {
			throw new Error("No active swarm. Add a worker or run /swarm first.");
		}
		const trimmed = body.trim();
		if (!trimmed) {
			throw new Error("Board message cannot be empty");
		}

		const activeMembers = new Set<string>();
		for (const member of Object.values(this.manifest.members)) {
			if (member.state !== "killed") {
				activeMembers.add(member.name);
			}
		}

		const mentions =
			options?.explicitMentions !== undefined
				? options.explicitMentions.filter((m) => activeMembers.has(m) && m !== author)
				: parseMentions(trimmed, activeMembers, author);

		const post: SwarmBoardPost = {
			seq: this.manifest.nextSeq++,
			timestamp: this.now(),
			author,
			mentions,
			body: trimmed,
			kind: options?.kind ?? "post",
		};
		this.posts.push(post);
		this.store.appendPost(this.manifest.swarmDir, post);

		const authorRecord = this.manifest.members[author];
		if (authorRecord) {
			authorRecord.lastReadSeq = Math.max(authorRecord.lastReadSeq, post.seq);
			authorRecord.updatedAt = post.timestamp;
			if (post.kind === "post") {
				this.postedThisWakeup.add(author);
			}
		}
		this.manifest.updatedAt = post.timestamp;
		this.store.saveManifest(this.manifest);

		const woken: string[] = [];
		for (const recipient of mentions) {
			const target = this.manifest.members[recipient];
			if (!target || target.state === "killed") continue;
			woken.push(recipient);
			if (recipient === COORDINATOR_NAME) {
				this.scheduleCoordinatorNotification(options?.immediate === true);
			} else {
				this.scheduleWorkerWakeup(recipient, options?.steer === true, options?.immediate === true);
			}
		}

		this.notifyChange();
		return { post, woken };
	}

	/** Post tailored messages to multiple swarm members in a single call. */
	postBatchMessages(
		author: string,
		items: readonly SwarmBatchMessageItem[],
	): { posts: SwarmBoardPost[]; woken: string[] } {
		if (!this.manifest) {
			throw new Error("No active swarm. Add a worker or run /swarm first.");
		}
		if (items.length === 0) {
			throw new Error("Parameter 'messages' must contain at least one entry");
		}

		const normalized: Array<{ to: string; body: string }> = [];
		for (const item of items) {
			const to = item.to.trim().replace(/^@/, "").toLowerCase();
			const msg = item.message.trim();
			if (!to || !msg) {
				throw new Error("Each batch message requires non-empty 'to' and 'message'");
			}
			const target = this.manifest.members[to];
			if (!target || target.state === "killed") {
				throw new Error(`Unknown or killed recipient '@${to}' in batch messages`);
			}
			const hasMention = new RegExp(`(?:^|\\s)@${to}(?![a-z0-9_@.-])`, "i").test(msg);
			normalized.push({ to, body: hasMention ? msg : `@${to} ${msg}` });
		}

		const posts: SwarmBoardPost[] = [];
		const wokenSet = new Set<string>();
		for (const entry of normalized) {
			const { post, woken } = this.postMessage(author, entry.body);
			posts.push(post);
			for (const w of woken) wokenSet.add(w);
		}
		return { posts, woken: [...wokenSet] };
	}

	readBoard(sinceSeq = 0, limit = 50): { posts: SwarmBoardPost[]; totalPosts: number } {
		const filtered = this.posts.filter((post) => post.seq > sinceSeq);
		const sliced = limit > 0 && filtered.length > limit ? filtered.slice(-limit) : filtered;
		return { posts: sliced, totalPosts: this.posts.length };
	}

	stopAllWorkers(): number {
		if (!this.manifest) return 0;
		this.slotQueue.length = 0;
		for (const name of [...this.pendingWakeups.keys()]) {
			this.cancelPendingWakeup(name);
		}
		let stopped = 0;
		for (const [name, handle] of this.liveWorkers.entries()) {
			const record = this.manifest.members[name];
			if (record && record.state === "working") {
				handle.abort();
				record.state = "waiting";
				record.lastStopReason = "aborted";
				record.updatedAt = this.now();
				this.activities.delete(name);
				this.postedThisWakeup.delete(name);
				stopped++;
			}
		}
		if (stopped > 0) {
			this.manifest.updatedAt = this.now();
			this.store.saveManifest(this.manifest);
			this.notifyChange();
		}
		return stopped;
	}

	endCoordinatorMode(): void {
		if (!this.manifest) return;
		this.stopAllWorkers();
		this.manifest.active = false;
		this.manifest.revision++;
		this.manifest.updatedAt = this.now();
		this.saveManifestAndLink();
		this.notifyChange();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.resetRuntimeState();
		if (this.manifest) {
			for (const member of Object.values(this.manifest.members)) {
				if (member.role === "worker" && (member.state === "working" || member.state === "waiting")) {
					member.state = "stopped";
				}
			}
			this.manifest.updatedAt = this.now();
			this.store.saveManifest(this.manifest);
		}
	}

	/** Reset runtime timers and handles (used on dispose or switching/restoring a branch). */
	resetRuntimeState(): void {
		if (this.coordinatorTimer) {
			clearTimeout(this.coordinatorTimer);
			this.coordinatorTimer = undefined;
		}
		for (const pending of this.pendingWakeups.values()) {
			if (pending.timer) clearTimeout(pending.timer);
		}
		this.pendingWakeups.clear();
		this.slotQueue.length = 0;
		for (const handle of this.liveWorkers.values()) {
			handle.dispose();
		}
		this.liveWorkers.clear();
		this.activities.clear();
		this.postedThisWakeup.clear();
	}

	private resolveActorModel(actorRecord: SwarmMemberRecord, host: SwarmHostContext): Model<Api> | undefined {
		const slash = actorRecord.model.indexOf("/");
		if (slash !== -1) {
			const found = host.modelRegistry.find(actorRecord.model.slice(0, slash), actorRecord.model.slice(slash + 1));
			if (found) return found;
		}
		return host.model;
	}

	private activeRunningWorkerCount(): number {
		if (!this.manifest) return 0;
		let count = 0;
		for (const member of Object.values(this.manifest.members)) {
			if (member.role === "worker" && member.state === "working") {
				count++;
			}
		}
		return count;
	}

	private scheduleCoordinatorNotification(immediate: boolean): void {
		if (this.disposed) return;
		if (immediate || this.debounceMs <= 0) {
			if (this.coordinatorTimer) {
				clearTimeout(this.coordinatorTimer);
				this.coordinatorTimer = undefined;
			}
			this.flushCoordinatorNotifications();
			return;
		}
		if (!this.coordinatorTimer) {
			this.coordinatorTimer = setTimeout(() => {
				this.coordinatorTimer = undefined;
				this.flushCoordinatorNotifications();
			}, this.debounceMs);
		}
	}

	private flushCoordinatorNotifications(): void {
		if (this.disposed || !this.manifest) return;
		const coord = this.manifest.members[COORDINATOR_NAME];
		if (!coord) return;
		const unread = this.posts.filter((p) => p.seq > coord.lastReadSeq);
		if (unread.length === 0) return;
		coord.lastReadSeq = unread[unread.length - 1]!.seq;
		coord.updatedAt = this.now();
		this.store.saveManifest(this.manifest);
		const snapshot = this.getSnapshot();
		if (snapshot) {
			this.onCoordinatorNotify?.(unread, snapshot);
		}
		this.notifyChange();
	}

	private scheduleWorkerWakeup(name: string, steer: boolean, immediate: boolean): void {
		if (this.disposed) return;
		const existing = this.pendingWakeups.get(name);
		if (immediate || this.debounceMs <= 0) {
			if (existing?.timer) clearTimeout(existing.timer);
			this.pendingWakeups.delete(name);
			void this.deliverToWorker(name, steer || existing?.steer === true);
			return;
		}
		if (existing) {
			existing.steer = existing.steer || steer;
			return;
		}
		const entry: PendingWakeup = {
			steer,
			timer: setTimeout(() => {
				this.pendingWakeups.delete(name);
				void this.deliverToWorker(name, entry.steer);
			}, this.debounceMs),
		};
		this.pendingWakeups.set(name, entry);
	}

	private cancelPendingWakeup(name: string): void {
		const pending = this.pendingWakeups.get(name);
		if (pending?.timer) clearTimeout(pending.timer);
		this.pendingWakeups.delete(name);
	}

	private removeFromSlotQueue(name: string): void {
		const idx = this.slotQueue.findIndex((item) => item.name === name);
		if (idx !== -1) this.slotQueue.splice(idx, 1);
	}

	private drainSlotQueue(): void {
		if (this.disposed || !this.manifest) return;
		while (this.slotQueue.length > 0 && this.activeRunningWorkerCount() < this.maxConcurrentTurns) {
			const next = this.slotQueue.shift()!;
			const record = this.manifest.members[next.name];
			if (!record || record.state === "killed") continue;
			void this.deliverToWorker(next.name, next.steer);
		}
	}

	private async deliverToWorker(name: string, steer: boolean): Promise<void> {
		if (this.disposed || !this.manifest || !this.hostContext) return;
		const record = this.manifest.members[name];
		if (!record || record.state === "killed") return;

		const unread = this.posts.filter((p) => p.seq > record.lastReadSeq);
		if (unread.length === 0) return;

		// Claim a concurrency slot synchronously before any async load so simultaneous
		// wakeups (e.g. sharded spawns or @all) cannot overshoot maxConcurrentTurns.
		if (record.state !== "working") {
			if (this.activeRunningWorkerCount() >= this.maxConcurrentTurns) {
				const queued = this.slotQueue.find((item) => item.name === name);
				if (queued) {
					queued.steer = queued.steer || steer;
				} else {
					this.slotQueue.push({ name, steer });
				}
				return;
			}
			record.state = "working";
		}

		let handle: SwarmWorkerHandle;
		try {
			handle = await this.ensureWorkerLoaded(name, this.hostContext);
		} catch (err) {
			record.lastError = err instanceof Error ? err.message : String(err);
			record.state = "stopped";
			record.updatedAt = this.now();
			this.store.saveManifest(this.manifest);
			this.drainSlotQueue();
			this.notifyChange();
			return;
		}

		// Re-read member from manifest after awaiting hydration in case the worker was killed meanwhile.
		const current = this.manifest?.members[name];
		if (this.disposed || !this.manifest || !current || current.state === "killed") return;
		const freshUnread = this.posts.filter((p) => p.seq > current.lastReadSeq);
		if (freshUnread.length === 0) {
			if (!handle.isRunning()) {
				current.state = "waiting";
				this.drainSlotQueue();
				this.notifyChange();
			}
			return;
		}

		current.lastReadSeq = freshUnread[freshUnread.length - 1]!.seq;
		current.lastError = undefined;
		current.updatedAt = this.now();
		this.store.saveManifest(this.manifest);
		this.notifyChange();

		if (!handle.isRunning()) {
			this.postedThisWakeup.delete(name);
		}
		const promptText = formatWorkerBoardDelivery(freshUnread, name);
		await handle.deliver(promptText, { steer });
	}

	private async ensureWorkerLoaded(
		name: string,
		host: SwarmHostContext,
		overrideModel?: Model<Api>,
	): Promise<SwarmWorkerHandle> {
		const existing = this.liveWorkers.get(name);
		if (existing) return existing;

		const record = this.manifest?.members[name];
		if (!record || record.role !== "worker") {
			throw new Error(`Unknown swarm worker '@${name}'`);
		}
		const model = overrideModel ?? resolveModelSpec(record.model, host.modelRegistry, host.model).model;
		const handle = await this.instantiateWorker(record, model, host, undefined);
		record.sessionFile = handle.sessionFile;
		return handle;
	}

	private async instantiateWorker(
		record: SwarmMemberRecord,
		model: Model<Api>,
		host: SwarmHostContext,
		forkSource: SwarmForkSource | undefined,
	): Promise<SwarmWorkerHandle> {
		const manifest = this.manifest!;
		const sessionsDir = this.store.getSessionsDir(manifest.swarmDir);
		const swarmTools = this.createWorkerSwarmTools(record.name);

		const handle = await this.workerFactory({
			name: record.name,
			addedBy: record.addedBy,
			cwd: record.cwd,
			workspace: record.workspace,
			gitBranch: record.gitBranch,
			brief: record.brief,
			model,
			thinkingLevel: record.thinkingLevel,
			modelRegistry: host.modelRegistry,
			sessionsDir,
			existingSessionFile: record.sessionFile,
			forkSource,
			initialUsage: record.usage,
			swarmTools,
			maxTurnsPerWakeup: record.maxTurnsPerWakeup ?? this.maxTurnsPerWakeup,
			onActivityChange: (activity) => {
				if (activity) {
					this.activities.set(record.name, activity);
				} else {
					this.activities.delete(record.name);
				}
				this.notifyChange();
			},
			onUsageChange: (usage) => {
				const liveRecord = this.manifest?.members[record.name];
				if (!liveRecord) return;
				liveRecord.usage = { ...usage };
				liveRecord.updatedAt = this.now();
				this.store.saveManifest(this.manifest!);
				this.notifyChange();
			},
			onIdle: (info) => {
				this.handleWorkerIdle(record.name, info);
			},
		});

		this.liveWorkers.set(record.name, handle);
		return handle;
	}

	private handleWorkerIdle(workerName: string, info: SwarmWorkerIdleInfo): void {
		if (this.disposed || !this.manifest) return;
		const liveRecord = this.manifest.members[workerName];
		if (!liveRecord || liveRecord.state === "killed") return;

		const didPost = this.postedThisWakeup.delete(workerName);
		liveRecord.state = "waiting";
		liveRecord.lastStopReason = info.reason;
		liveRecord.lastWakeupTurns = info.turnsUsed;
		liveRecord.lastOutput = info.lastOutput;
		liveRecord.lastError = info.error;
		liveRecord.updatedAt = this.now();
		this.activities.delete(workerName);

		const outputSummary = info.lastOutput
			? ` Last output: "${info.lastOutput.replace(/\s+/g, " ").trim().slice(0, 180)}"`
			: "";

		// Handle queued task pool progression when this worker holds an in-flight task.
		const pool = liveRecord.poolId ? this.manifest.taskPools?.[liveRecord.poolId] : undefined;
		const inFlightTask = pool?.inFlight[workerName];

		if (pool && inFlightTask) {
			if (info.reason === "idle") {
				delete pool.inFlight[workerName];
				pool.completed.push({ ...inFlightTask, worker: workerName });
				liveRecord.currentTask = undefined;

				if (pool.pending.length > 0) {
					const nextTask = pool.pending.shift()!;
					pool.inFlight[workerName] = nextTask;
					liveRecord.currentTask = nextTask;
					this.store.saveManifest(this.manifest);
					const nextBody = [
						`@${workerName} Next queued task (${nextTask.index}/${pool.totalTasks}) from pool '${pool.baseName}':`,
						nextTask.task,
						"",
						"Follow the shared pool brief. When done, end your turn cleanly to pull the next task automatically.",
					].join("\n");
					this.postMessage(pool.addedBy, nextBody, {
						kind: "brief",
						explicitMentions: [workerName],
						immediate: true,
					});
					return;
				}

				this.store.saveManifest(this.manifest);
				if (Object.keys(pool.inFlight).length === 0) {
					const failedPart = pool.failed.length > 0 ? `, ${pool.failed.length} failed` : "";
					this.postMessage(
						workerName,
						`@${pool.addedBy} Task pool '${pool.baseName}' completed: ${pool.completed.length}/${pool.totalTasks} done${failedPart}.`,
						{ kind: "system", explicitMentions: [pool.addedBy] },
					);
				}
				this.drainSlotQueue();
				this.notifyChange();
				return;
			}

			if (info.reason === "max_turns") {
				this.store.saveManifest(this.manifest);
				this.postMessage(
					workerName,
					`@${liveRecord.addedBy} Worker @${workerName} hit the per-wakeup turn limit (${info.turnsUsed}/${info.maxTurns}) on task #${inFlightTask.index}/${pool.totalTasks} and paused in waiting.${outputSummary} Use swarm(action="inspect", name="${workerName}") to check progress or reply @${workerName} to continue.`,
					{ kind: "system", explicitMentions: [liveRecord.addedBy] },
				);
				this.drainSlotQueue();
				this.notifyChange();
				return;
			}

			if (info.reason === "error") {
				delete pool.inFlight[workerName];
				pool.failed.push({ ...inFlightTask, worker: workerName, reason: info.error ?? "error" });
				liveRecord.currentTask = undefined;
				this.store.saveManifest(this.manifest);
				this.postMessage(
					workerName,
					`@${liveRecord.addedBy} Worker @${workerName} failed task #${inFlightTask.index}/${pool.totalTasks} (${info.turnsUsed} turns): ${info.error ?? "Unknown error"}.${outputSummary}`,
					{ kind: "system", explicitMentions: [liveRecord.addedBy] },
				);
				this.drainSlotQueue();
				this.notifyChange();
				return;
			}

			// aborted: keep task paused without spamming coordinator
			this.store.saveManifest(this.manifest);
			this.drainSlotQueue();
			this.notifyChange();
			return;
		}

		// Standard (non-pool) worker stop notifications
		this.store.saveManifest(this.manifest);
		if (info.reason === "error") {
			this.postMessage(
				workerName,
				`@${liveRecord.addedBy} Worker @${workerName} stopped with error (${info.turnsUsed} turns): ${info.error ?? "Unknown error"}.${outputSummary}`,
				{ kind: "system", explicitMentions: [liveRecord.addedBy] },
			);
		} else if (info.reason === "max_turns") {
			this.postMessage(
				workerName,
				`@${liveRecord.addedBy} Worker @${workerName} hit the per-wakeup turn limit (${info.turnsUsed}/${info.maxTurns}) and paused in waiting.${outputSummary} Use swarm(action="inspect", name="${workerName}") to check progress or reply @${workerName} to continue.`,
				{ kind: "system", explicitMentions: [liveRecord.addedBy] },
			);
		} else if (info.reason === "idle" && !didPost) {
			this.postMessage(
				workerName,
				`@${liveRecord.addedBy} Worker @${workerName} returned to waiting without posting to the board (reason: idle, ${info.turnsUsed} turns).${outputSummary}`,
				{ kind: "system", explicitMentions: [liveRecord.addedBy] },
			);
		}

		this.drainSlotQueue();
		this.notifyChange();
	}

	/** Build worker-scoped `swarm`, `board_post`, and `board_read` AgentTools bound to `workerName`. */
	private createWorkerSwarmTools(workerName: string): AgentTool[] {
		const boardPostSchema = Type.Object({
			message: Type.Optional(
				Type.String({
					description:
						"Message to post to the shared swarm board. Use @name (e.g. @coordinator, @peer, @all) to wake recipients.",
				}),
			),
			messages: Type.Optional(
				Type.Array(
					Type.Object({
						to: Type.String({ description: "Target member name (without @)." }),
						message: Type.String({ description: "Message directed to this member." }),
					}),
					{ description: "Batch dispatch tailored messages to multiple members in one call." },
				),
			),
		});
		const boardReadSchema = Type.Object({
			since_seq: Type.Optional(Type.Number({ description: "Only return posts with seq > since_seq (default 0)." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of recent posts to return (default 50)." })),
		});
		const workerSwarmSchema = Type.Object({
			action: StringEnum(SWARM_ACTIONS, {
				description: "Action: status, inspect, models, add, model, or kill (helpers you added only)",
			}),
			name: Type.Optional(Type.String({ description: "Target worker name (or base name for add)." })),
			brief: Type.Optional(Type.String({ description: "Assignment brief for add." })),
			model: Type.Optional(
				Type.String({
					description: "Model spec for add or model switch (optional ':level' thinking suffix supported).",
				}),
			),
			thinkingLevel: Type.Optional(
				StringEnum(THINKING_LEVEL_OPTIONS, {
					description:
						"Optional thinking level ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max') for add or model switch.",
				}),
			),
			fork: Type.Optional(Type.String({ description: "Optional member name to fork conversation history from." })),
			workspace: Type.Optional(StringEnum(SWARM_WORKSPACES, { description: "inherit, share, or branch" })),
			n: Type.Optional(Type.Number({ description: "Spawn n copies (<name>-1..<name>-<n>)." })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: "Per-worker slice targets for add." })),
			concurrency: Type.Optional(
				Type.Number({
					description: "Max concurrent worker slots when paired with tasks (runs remaining tasks as a queue).",
				}),
			),
			maxTurns: Type.Optional(Type.Number({ description: "Override per-wakeup turn limit (default 25)." })),
			symlinkPaths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Relative paths from repo root to symlink into isolated share/branch worktrees.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "For inspect: max transcript items to return (default 20)." }),
			),
			all: Type.Optional(Type.Boolean({ description: "For models: include full catalog." })),
			reason: Type.Optional(Type.String({ description: "Reason for model switch." })),
			force: Type.Optional(Type.Boolean({ description: "Force kill even with unlanded changes." })),
		});

		const boardPostTool: AgentTool = {
			name: "board_post",
			label: "Board Post",
			description:
				"Post a public message (or batch of per-recipient messages) to the shared swarm message board. Mention @coordinator, another @worker, or @all to wake them. Never post empty acknowledgements or thanks.",
			parameters: boardPostSchema,
			execute: async (_id, params) => {
				try {
					const input = params as { message?: string; messages?: SwarmBatchMessageItem[] };
					if (input.messages && input.messages.length > 0) {
						const { posts, woken } = this.postBatchMessages(workerName, input.messages);
						const wokeText = woken.length > 0 ? ` (woke: ${woken.map((w) => `@${w}`).join(", ")})` : "";
						return {
							content: [{ type: "text", text: `Posted ${posts.length} messages to swarm board${wokeText}.` }],
							details: { posts, post: posts[posts.length - 1], woken },
						};
					}
					if (!input.message) {
						throw new Error("Either 'message' or non-empty 'messages' is required");
					}
					const { post, woken } = this.postMessage(workerName, input.message);
					const wokeText = woken.length > 0 ? ` (woke: ${woken.map((w) => `@${w}`).join(", ")})` : "";
					return {
						content: [{ type: "text", text: `Posted #${post.seq} to swarm board${wokeText}.` }],
						details: { post, woken },
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { content: [{ type: "text", text: msg }], details: { error: msg } };
				}
			},
		};

		const boardReadTool: AgentTool = {
			name: "board_read",
			label: "Board Read",
			description: "Read messages from the shared swarm board.",
			parameters: boardReadSchema,
			execute: async (_id, params) => {
				const input = params as { since_seq?: number; limit?: number };
				const { posts, totalPosts } = this.readBoard(input.since_seq ?? 0, input.limit ?? 50);
				return {
					content: [{ type: "text", text: formatBoardPosts(posts) }],
					details: { posts, totalPosts },
				};
			},
		};

		const workerSwarmTool: AgentTool = {
			name: "swarm",
			label: "Swarm",
			description:
				"Inspect swarm status/models, add helper workers for your own task, switch your or your helpers' model, or kill helpers you added.",
			parameters: workerSwarmSchema,
			execute: async (_id, params) => {
				const input = params as {
					action: (typeof SWARM_ACTIONS)[number];
					name?: string;
					brief?: string;
					model?: string;
					thinkingLevel?: ThinkingLevel;
					fork?: string;
					workspace?: SwarmWorkspaceMode;
					n?: number;
					tasks?: string[];
					concurrency?: number;
					maxTurns?: number;
					symlinkPaths?: string[];
					limit?: number;
					all?: boolean;
					reason?: string;
					force?: boolean;
				};
				if (!this.hostContext) {
					return { content: [{ type: "text", text: "Swarm host context unavailable." }], details: {} };
				}
				try {
					switch (input.action) {
						case "status": {
							const snap = this.getSnapshot();
							return {
								content: [{ type: "text", text: snap ? formatSwarmStatus(snap) : "No active swarm." }],
								details: { action: "status", actor: workerName, snapshot: snap },
							};
						}
						case "inspect": {
							if (!input.name) {
								throw new Error("Parameter 'name' is required for action 'inspect'");
							}
							const inspected = this.inspectWorker(input.name, input.limit);
							return {
								content: [
									{
										type: "text",
										text: formatWorkerInspect(inspected.member, inspected.transcript, inspected.pool),
									},
								],
								details: {
									action: "inspect",
									actor: workerName,
									target: inspected.member.name,
									inspect: inspected,
								},
							};
						}
						case "models": {
							return {
								content: [
									{ type: "text", text: this.listModels(this.hostContext.modelRegistry, input.all === true) },
								],
								details: { action: "models", actor: workerName },
							};
						}
						case "add": {
							if (!input.name || !input.brief) {
								throw new Error("Parameters 'name' and 'brief' are required for action 'add'");
							}
							const res = await this.addWorkers(
								workerName,
								{
									name: input.name,
									brief: input.brief,
									model: input.model,
									thinkingLevel: input.thinkingLevel,
									fork: input.fork,
									workspace: input.workspace,
									n: input.n,
									tasks: input.tasks,
									concurrency: input.concurrency,
									maxTurns: input.maxTurns,
									symlinkPaths: input.symlinkPaths,
								},
								this.hostContext,
							);
							const queueNote = res.queuedCount ? ` (${res.queuedCount} queued in pool)` : "";
							return {
								content: [
									{
										type: "text",
										text: `Added helper${res.added.length === 1 ? "" : "s"}: ${res.added.map((n) => `@${n}`).join(", ")}${queueNote}. Brief posted on board.`,
									},
								],
								details: {
									action: "add",
									actor: workerName,
									added: res.added,
									poolId: res.poolId,
									queuedCount: res.queuedCount,
									symlinked: res.symlinked,
									warnings: res.warnings,
									snapshot: res.snapshot,
								},
							};
						}
						case "model": {
							if (!input.model && !input.thinkingLevel) {
								throw new Error("At least one of 'model' or 'thinkingLevel' is required for action 'model'");
							}
							const res = await this.switchModel(
								workerName,
								{
									name: input.name,
									model: input.model,
									thinkingLevel: input.thinkingLevel,
									reason: input.reason,
								},
								this.hostContext,
							);
							return {
								content: [
									{
										type: "text",
										text: `Switched @${res.target} to ${res.model} (thinking: ${res.thinkingLevel}).`,
									},
								],
								details: {
									action: "model",
									actor: workerName,
									target: res.target,
									model: res.model,
									thinkingLevel: res.thinkingLevel,
								},
							};
						}
						case "kill": {
							if (!input.name) {
								throw new Error("Parameter 'name' is required for action 'kill'");
							}
							const res = await this.killWorker(
								workerName,
								{ name: input.name, force: input.force },
								this.hostContext,
							);
							return {
								content: [{ type: "text", text: `Killed helper @${res.target}.` }],
								details: { action: "kill", actor: workerName, target: res.target },
							};
						}
						case "title": {
							throw new Error("Only the coordinator can set the swarm title");
						}
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
				}
			},
		};

		return [workerSwarmTool, boardPostTool, boardReadTool];
	}

	private saveManifestAndLink(): void {
		if (!this.manifest) return;
		this.store.saveManifest(this.manifest);
		this.onPersistLink?.({
			swarmId: this.manifest.id,
			swarmDir: this.manifest.swarmDir,
			title: this.manifest.title,
			active: this.manifest.active,
			updatedAt: this.manifest.updatedAt,
		});
	}

	private notifyChange(): void {
		this.onStateChange?.();
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch {
				// UI listeners should not break orchestration state updates.
			}
		}
	}
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { type ReadonlySessionManager, SessionManager } from "../src/core/session-manager.ts";
import {
	DEFAULT_DREAM_IDLE_MS,
	MEMORY_DREAM_CUSTOM_TYPE,
	type MemoryDreamMessageDetails,
} from "../src/extensions/memory/dream.ts";
import memoryExtension, { createMemoryExtension, type MemoryExtensionOptions } from "../src/extensions/memory/index.ts";
import {
	MemoryListComponent,
	renderDreamMessage,
	renderPromptSection,
	renderToolCall,
	renderToolResult,
} from "../src/extensions/memory/render.ts";
import {
	ARCHIVE_SCORE_THRESHOLD,
	computeDecayScore,
	MemoryStateLedger,
	MIN_SESSIONS_BEFORE_ARCHIVE,
} from "../src/extensions/memory/state.ts";
import { MemoryStore, resolveMemoryDir } from "../src/extensions/memory/store.ts";
import { GLOBAL_MEMORY_DIR_NAME, type MemoryEntry, type MemoryToolDetails } from "../src/extensions/memory/types.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const TEST_DREAM_MODEL: Model<Api> = {
	id: "ext-dream-model",
	name: "Ext Dream Model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 512_000,
	maxTokens: 16_384,
};

function makeTestAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: TEST_DREAM_MODEL.api,
		provider: TEST_DREAM_MODEL.provider,
		model: TEST_DREAM_MODEL.id,
		usage: {
			input: 50,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 60,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: MemoryToolDetails };
type MemoryTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
};

function entry(id: string, title: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id,
		title,
		category: "fact",
		pinned: false,
		created: "2026-01-01T00:00:00.000Z",
		updated: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

let tmpDir: string;
let agentDir: string;
let projectDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-")));
	agentDir = path.join(tmpDir, "agent");
	projectDir = path.join(tmpDir, "project");
	fs.mkdirSync(projectDir);
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("renderPromptSection", () => {
	it("keeps every title visible when a recent entry has a large body", () => {
		const entries = [
			entry("m-new", "Recent gotcha", { body: "x".repeat(6000) }),
			...Array.from({ length: 30 }, (_, i) => entry(`m-old${i}`, `Old convention ${i}`)),
		];
		const section = renderPromptSection("/repo", entries);
		expect(section).not.toContain("xxxx");
		for (let i = 0; i < 30; i++) expect(section).toContain(`[m-old${i}]`);
		expect(section).not.toContain("more entries");
	});

	it("includes pinned bodies only", () => {
		const section = renderPromptSection("/repo", [
			entry("m-pin", "Pinned rule", { pinned: true, body: "pinned detail" }),
			entry("m-plain", "Plain rule", { body: "plain detail" }),
		]);
		expect(section).toContain("pinned detail");
		expect(section).not.toContain("plain detail");
	});

	it("counts titles that do not fit the budget", () => {
		const entries = Array.from({ length: 200 }, (_, i) => entry(`m-e${i}`, `Entry ${i} ${"t".repeat(40)}`));
		const section = renderPromptSection("/repo", entries, 2000);
		expect(section.length).toBeLessThanOrEqual(2000);
		expect(section).toMatch(/\.\.\. \d+ more entries/);
	});

	it("renders dual global + project sections with pinned bodies and independent budget caps", () => {
		// Case 1: Titles fit with room left -> pinned bodies render in both scopes, unpinned bodies stay hidden.
		const normalSection = renderPromptSection(
			"/repo",
			[
				entry("p-pin", "Use vitest for unit tests", {
					scope: "project",
					pinned: true,
					body: "Run npx vitest run on changed test files.",
				}),
				entry("p-plain", "Plain project note", {
					scope: "project",
					body: "unpinned project body should not appear",
				}),
			],
			8000,
			[
				entry("g-pin", "Always run targeted tests", {
					scope: "global",
					pinned: true,
					body: "Never run full rebuild in swarm worktrees.",
				}),
				entry("g-plain", "Prefer concise diffs", {
					scope: "global",
					body: "unpinned global body should not appear",
				}),
			],
			3000,
		);
		const splitMarker = "\n\nProject: /repo";
		const normalSplit = normalSection.indexOf(splitMarker);
		expect(normalSplit).toBeGreaterThan(0);

		const normalGlobal = normalSection.slice(0, normalSplit);
		const normalProject = normalSection.slice(normalSplit + 2);
		expect(normalGlobal).toContain('Global memory (cross-project, scope="global"):');
		expect(normalGlobal).toContain("[g-pin]");
		expect(normalGlobal).toContain("Never run full rebuild in swarm worktrees.");
		expect(normalGlobal).toContain("[g-plain]");
		expect(normalGlobal).not.toContain("unpinned global body should not appear");

		expect(normalProject).toContain("Project: /repo");
		expect(normalProject).toContain("[p-pin]");
		expect(normalProject).toContain("Run npx vitest run on changed test files.");
		expect(normalProject).not.toContain("unpinned project body should not appear");

		// Case 2: Independent tight budget caps enforce globalCharBudget and charBudget separately.
		const manyGlobal = Array.from({ length: 40 }, (_, i) =>
			entry(`g-extra-${i}`, `Global convention ${i} ${"g".repeat(30)}`, { scope: "global" }),
		);
		const manyProject = Array.from({ length: 40 }, (_, i) =>
			entry(`p-extra-${i}`, `Project rule ${i} ${"p".repeat(30)}`, { scope: "project" }),
		);
		const cappedSection = renderPromptSection("/repo", manyProject, 1200, manyGlobal, 600);
		const cappedSplit = cappedSection.indexOf(splitMarker);
		expect(cappedSplit).toBeGreaterThan(0);

		const cappedGlobal = cappedSection.slice(0, cappedSplit);
		const cappedProject = cappedSection.slice(cappedSplit + 2);
		expect(cappedGlobal.length).toBeLessThanOrEqual(600);
		expect(cappedGlobal).toMatch(/\.\.\. \d+ more entries/);
		expect(cappedProject.length).toBeLessThanOrEqual(1200);
		expect(cappedProject).toMatch(/\.\.\. \d+ more entries/);
	});

	it("omits global header when globalEntries is empty", () => {
		const section = renderPromptSection("/repo", [entry("p1", "Only project")], 8000, []);
		expect(section.startsWith("Project: /repo")).toBe(true);
		expect(section).not.toContain("Global memory");
	});
});

describe("MemoryStateLedger and decay scoring", () => {
	it("computes exponential decay scores with hit-amplified half-life", () => {
		expect(computeDecayScore(undefined, 20)).toBe(1);
		expect(computeDecayScore({ hitCount: 0, lastHitSessionSeq: 0, createdSessionSeq: 0 }, 15)).toBeCloseTo(
			ARCHIVE_SCORE_THRESHOLD,
			6,
		);
		expect(computeDecayScore({ hitCount: 0, lastHitSessionSeq: 0, createdSessionSeq: 0 }, 16)).toBeLessThan(
			ARCHIVE_SCORE_THRESHOLD,
		);
		expect(computeDecayScore({ hitCount: 1, lastHitSessionSeq: 0, createdSessionSeq: 0 }, 16)).toBeGreaterThan(
			ARCHIVE_SCORE_THRESHOLD,
		);
		expect(computeDecayScore({ hitCount: 1, lastHitSessionSeq: 0, createdSessionSeq: 0 }, 31)).toBeLessThan(
			ARCHIVE_SCORE_THRESHOLD,
		);
		// Hit count cap at 6 => half-life = 5 * 2^6 = 320.
		const scoreAt6 = computeDecayScore({ hitCount: 6, lastHitSessionSeq: 0, createdSessionSeq: 0 }, 320);
		const scoreAt99 = computeDecayScore({ hitCount: 99, lastHitSessionSeq: 0, createdSessionSeq: 0 }, 320);
		expect(scoreAt6).toBeCloseTo(0.5, 6);
		expect(scoreAt99).toBeCloseTo(0.5, 6);
	});

	it("tracks unique sessions with a 500-item ring and hit counts without premature writes", async () => {
		const memDir = path.join(agentDir, "memory", "ledger-test");
		const ledger = new MemoryStateLedger(memDir);

		const initial = await ledger.read();
		expect(initial.sessionSeq).toBe(0);
		expect(fs.existsSync(ledger.statePath)).toBe(false);

		// removeEntry is a no-op when state.json does not exist.
		await ledger.removeEntry("nonexistent");
		expect(fs.existsSync(ledger.statePath)).toBe(false);

		// Empty session IDs are ignored.
		await ledger.recordSession("   ");
		expect(fs.existsSync(ledger.statePath)).toBe(false);

		// Unique session increments once; duplicates do not.
		await ledger.recordSession("s-1");
		await ledger.recordSession("s-1");
		const afterDup = await ledger.read();
		expect(afterDup.sessionSeq).toBe(1);
		expect(afterDup.seenSessionIds).toEqual(["s-1"]);

		// Entry create + hit tracking.
		await ledger.recordEntryCreate("note-a");
		await ledger.recordHits(["note-a", "note-a", "note-b"], "s-2");
		const afterHits = await ledger.read();
		expect(afterHits.sessionSeq).toBe(2);
		expect(afterHits.entries["note-a"]).toEqual({ hitCount: 1, lastHitSessionSeq: 2, createdSessionSeq: 1 });
		expect(afterHits.entries["note-b"]).toEqual({ hitCount: 1, lastHitSessionSeq: 2, createdSessionSeq: 2 });

		// Ring cap at 500 seenSessionIds.
		await ledger.mutate((state) => {
			for (let i = 0; i < 520; i++) {
				state.seenSessionIds.push(`bulk-${i}`);
			}
		});
		await ledger.recordSession("final-session");
		const afterCap = await ledger.read();
		expect(afterCap.seenSessionIds.length).toBe(500);
		expect(afterCap.seenSessionIds[afterCap.seenSessionIds.length - 1]).toBe("final-session");

		await ledger.removeEntry("note-a");
		const afterRemove = await ledger.read();
		expect(afterRemove.entries["note-a"]).toBeUndefined();
		expect(afterRemove.entries["note-b"]).toBeDefined();
	});
});

describe("MemoryStore", () => {
	it("creates no directories until the first write", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		expect(await store.listEntries()).toEqual([]);
		expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(false);

		await store.addEntry({ title: "First" });
		expect(fs.existsSync(store.entriesDir)).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(store.memoryDir, "project.json"), "utf8")).root).toBe(projectDir);
	});

	it("matches each search term separately and ranks title hits first", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		const bodyHit = await store.addEntry({ title: "Before commit", body: "run `npm run check`" });
		const titleHit = await store.addEntry({ title: "npm check is slow", body: "about a minute" });
		await store.addEntry({ title: "Unrelated" });

		expect((await store.searchEntries("check npm")).map((e) => e.id)).toEqual([titleHit.id, bodyHit.id]);
	});

	it("rejects ids that would leave the entries directory", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		await expect(store.getEntry("../../project")).rejects.toThrow("Invalid memory id");
		await expect(store.updateEntry("../x", { title: "y" })).rejects.toThrow("Invalid memory id");
		await expect(store.deleteEntry("../x")).rejects.toThrow("Invalid memory id");
	});

	it("names entries by slug and rejects taken or malformed ids", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		expect((await store.addEntry({ title: "npm run check skips tests" })).id).toBe("npm-run-check-skips-tests");
		expect((await store.addEntry({ title: "只用中文" })).id).toMatch(/^note-[a-z0-9]+$/);
		await expect(store.addEntry({ id: "npm-run-check-skips-tests", title: "Other" })).rejects.toThrow(
			"already exists",
		);
		await expect(store.addEntry({ id: "Bad_Id", title: "Other" })).rejects.toThrow("Invalid memory id");
	});

	it("finds links one hop in both directions", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		await store.addEntry({ id: "run-tests", title: "Run tests with ./test.sh", body: "see [[e2e-env]]" });
		const check = await store.addEntry({ id: "check", title: "check", body: "[[run-tests]] and [[gone]]" });
		await store.addEntry({ id: "commit", title: "Commit after check", body: "needs [[check]]" });

		const links = await store.findLinks(check);
		expect(links.linked.map((e) => e.id)).toEqual(["run-tests"]);
		expect(links.missing).toEqual(["gone"]);
		expect(links.linkedFrom.map((e) => e.id)).toEqual(["commit"]);
	});

	it("keeps both fields when one entry is updated in parallel", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		const created = await store.addEntry({ title: "Old title", body: "old body" });
		await Promise.all([
			store.updateEntry(created.id, { title: "New title" }),
			store.updateEntry(created.id, { body: "new body" }),
		]);
		const stored = await store.getEntry(created.id);
		expect(stored?.title).toBe("New title");
		expect(stored?.body).toBe("new body");
	});

	it("gives roots with the same readable dir name separate directories", async () => {
		const first = path.join(tmpDir, "a", "b-c");
		const second = path.join(tmpDir, "a-b", "c");
		await new MemoryStore(first, agentDir).addEntry({ title: "First" });

		const secondStore = new MemoryStore(second, agentDir);
		expect(secondStore.memoryDir).not.toBe(resolveMemoryDir(agentDir, first));
		expect(await secondStore.listEntries()).toEqual([]);
		expect(resolveMemoryDir(agentDir, first)).toBe(new MemoryStore(first, agentDir).memoryDir);
	});

	it("supports global memory store with --global-- directory and lazy creation", async () => {
		const globalStore = MemoryStore.global(agentDir);
		expect(globalStore.scope).toBe("global");
		expect(globalStore.projectRoot).toBe(GLOBAL_MEMORY_DIR_NAME);
		expect(globalStore.memoryDir).toBe(path.join(agentDir, "memory", GLOBAL_MEMORY_DIR_NAME));

		expect(await globalStore.listEntries()).toEqual([]);
		await globalStore.recordSessionActivity("s-1");
		expect(await globalStore.runDecay()).toEqual({ archivedIds: [], sessionSeq: 0 });
		expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(false);

		const created = await globalStore.addEntry({ id: "prefer-concise", title: "Prefer concise summaries" });
		expect(created.scope).toBe("global");
		expect(JSON.parse(fs.readFileSync(path.join(globalStore.memoryDir, "project.json"), "utf8"))).toMatchObject({
			root: GLOBAL_MEMORY_DIR_NAME,
			scope: "global",
		});
		expect((await globalStore.listEntries())[0]?.scope).toBe("global");
	});

	it("resolves cross-scope [[id]] links and prefers same-scope on ID collisions", async () => {
		const projectStore = new MemoryStore(projectDir, agentDir);
		const globalStore = MemoryStore.global(agentDir);

		const gShared = await globalStore.addEntry({ id: "shared-id", title: "Global shared note" });
		const gOnly = await globalStore.addEntry({
			id: "global-rule",
			title: "Global rule",
			body: "see [[proj-note]]",
		});
		const pShared = await projectStore.addEntry({ id: "shared-id", title: "Project shared note" });
		const pNote = await projectStore.addEntry({
			id: "proj-note",
			title: "Project note",
			body: "uses [[global-rule]] and [[shared-id]]",
		});

		const projLinks = await projectStore.findLinks(pNote, await globalStore.listEntries());
		expect(projLinks.linked.map((e) => `${e.scope}:${e.id}`)).toEqual(["global:global-rule", "project:shared-id"]);
		expect(projLinks.linkedFrom.map((e) => `${e.scope}:${e.id}`)).toEqual(["global:global-rule"]);
		expect(projLinks.linked[1]?.title).toBe(pShared.title);

		const globLinks = await globalStore.findLinks(gOnly, await projectStore.listEntries());
		expect(globLinks.linked.map((e) => `${e.scope}:${e.id}`)).toEqual(["project:proj-note"]);
		expect(globLinks.linkedFrom.map((e) => `${e.scope}:${e.id}`)).toEqual(["project:proj-note"]);
		expect(gShared.scope).toBe("global");
	});

	it("archives, searches with discount, rejects duplicate archived IDs, restores, and deletes archived entries", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		await store.addEntry({ id: "active-deploy", title: "Deploy service checklist" });
		await store.addEntry({ id: "archived-deploy", title: "Deploy service checklist" });
		const archived = await store.archiveEntry("archived-deploy");

		expect(archived.archived).toBe(true);
		expect(fs.existsSync(path.join(store.entriesDir, "archived-deploy.md"))).toBe(false);
		expect(fs.existsSync(path.join(store.archiveDir, "archived-deploy.md"))).toBe(true);

		expect((await store.listEntries()).map((e) => e.id)).toEqual(["active-deploy"]);
		expect((await store.listArchivedEntries()).map((e) => e.id)).toEqual(["archived-deploy"]);
		expect(await store.getEntry("archived-deploy")).toBeNull();
		expect((await store.getEntry("archived-deploy", { includeArchived: true }))?.archived).toBe(true);

		await expect(store.addEntry({ id: "archived-deploy", title: "Duplicate" })).rejects.toThrow("already exists");

		// Active ranks above equal archived match; includeArchived: false omits archived.
		const combined = await store.searchEntries("deploy service");
		expect(combined.map((e) => `${e.id}:${Boolean(e.archived)}`)).toEqual([
			"active-deploy:false",
			"archived-deploy:true",
		]);
		const activeOnly = await store.searchEntries("deploy service", { includeArchived: false });
		expect(activeOnly.map((e) => e.id)).toEqual(["active-deploy"]);

		// Restore resets lastHitSessionSeq to current sessionSeq.
		await store.recordSessionActivity("s-restore");
		const restored = await store.restoreEntry("archived-deploy");
		expect(restored.archived).toBe(false);
		expect(fs.existsSync(path.join(store.entriesDir, "archived-deploy.md"))).toBe(true);
		expect(fs.existsSync(path.join(store.archiveDir, "archived-deploy.md"))).toBe(false);
		const stateAfterRestore = await store.ledger.read();
		expect(stateAfterRestore.entries["archived-deploy"]?.lastHitSessionSeq).toBe(stateAfterRestore.sessionSeq);

		// Deleting an archived entry moves it to .trash and cleans ledger.
		await store.archiveEntry("archived-deploy");
		const deleted = await store.deleteEntry("archived-deploy");
		expect(deleted.archived).toBe(true);
		expect(await store.listArchivedEntries()).toEqual([]);
		expect((await store.ledger.read()).entries["archived-deploy"]).toBeUndefined();
	});

	it("decays unpinned unlinked stale entries into .archive/ while exempting pinned, linked, and hit entries", async () => {
		const store = new MemoryStore(projectDir, agentDir);
		await store.addEntry({ id: "stale-orphan", title: "Forgotten note" });
		await store.addEntry({ id: "pinned-rule", title: "Never archive me", pinned: true });
		await store.addEntry({ id: "linked-target", title: "Referenced architecture note" });
		await store.addEntry({
			id: "linker-pinned",
			title: "Pinned index linking target",
			pinned: true,
			body: "Depends on [[linked-target]]",
		});
		await store.addEntry({ id: "frequently-hit", title: "Useful command" });
		await store.ledger.recordHits(["frequently-hit"]);

		// Advance MIN_SESSIONS_BEFORE_ARCHIVE + 1 (= 16) unique sessions so 0-hit score < 0.125.
		for (let i = 1; i <= MIN_SESSIONS_BEFORE_ARCHIVE + 1; i++) {
			await store.recordSessionActivity(`session-${i}`);
		}

		const result = await store.runDecay();
		expect(result.sessionSeq).toBe(MIN_SESSIONS_BEFORE_ARCHIVE + 1);
		expect(result.archivedIds).toEqual(["stale-orphan"]);

		// Repeat decay at same sessionSeq is an early no-op.
		expect(await store.runDecay()).toEqual({ archivedIds: [], sessionSeq: MIN_SESSIONS_BEFORE_ARCHIVE + 1 });

		const activeIds = (await store.listEntries()).map((e) => e.id).sort();
		expect(activeIds).toEqual(["frequently-hit", "linked-target", "linker-pinned", "pinned-rule"]);
		expect((await store.listArchivedEntries()).map((e) => e.id)).toEqual(["stale-orphan"]);
	});
});

describe("memory extension", () => {
	function setup(options?: {
		initialSessionId?: string;
		extensionOptions?: MemoryExtensionOptions;
		model?: Model<Api>;
		sessionManager?: ReadonlySessionManager;
	}) {
		const handlers = new Map<string, Handler>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const sent: Array<{
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
		}> = [];
		let tool: MemoryTool | undefined;
		let currentSessionId = options?.initialSessionId;
		let isIdleFlag = true;
		let hasPendingFlag = false;

		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerTool: (def: MemoryTool) => {
				tool = def;
			},
			registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
				commands.set(name, def),
			registerMessageRenderer: vi.fn(),
			sendMessage: (
				message: { customType: string; content: string; display: boolean; details?: unknown },
				sendOptions?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
			) => sent.push({ ...message, options: sendOptions }),
		} as unknown as ExtensionAPI;
		if (options?.extensionOptions) {
			createMemoryExtension(options.extensionOptions)(pi);
		} else {
			memoryExtension(pi);
		}

		const transcriptSection = "<project_memory>\nstale transcript section\n</project_memory>";
		const notify = vi.fn();
		const defaultSessionManager = {
			...(currentSessionId !== undefined ? { getSessionId: () => currentSessionId ?? "" } : {}),
			buildSessionProjection: () => ({
				messages: [{ role: "system", content: "", sections: { project_memory: transcriptSection }, timestamp: 1 }],
			}),
		};
		const ctx = {
			cwd: projectDir,
			hasUI: false,
			mode: "print",
			model: options?.model,
			ui: { notify },
			isIdle: () => isIdleFlag,
			hasPendingMessages: () => hasPendingFlag,
			sessionManager: options?.sessionManager ?? defaultSessionManager,
		} as unknown as ExtensionContext;

		const setSessionId = (id: string): void => {
			currentSessionId = id;
			(ctx.sessionManager as unknown as { getSessionId?: () => string }).getSessionId = () => currentSessionId ?? "";
		};
		const setIdle = (idle: boolean): void => {
			isIdleFlag = idle;
		};
		const setHasPending = (pending: boolean): void => {
			hasPendingFlag = pending;
		};

		const promptSection = async (): Promise<string> => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await handlers.get("before_agent_start")?.(event, ctx);
			return event.systemPromptOptions.sections.project_memory;
		};
		const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
		const runResult = async (params: Record<string, unknown>): Promise<ToolResult> => {
			const result = await tool?.execute("call", params, undefined, undefined, ctx);
			if (!result) throw new Error("Tool not registered");
			return result;
		};
		const run = async (params: Record<string, unknown>): Promise<string> => {
			const result = await runResult(params);
			return result.content[0]?.text ?? "";
		};
		return {
			commands,
			sent,
			ctx,
			notify,
			setSessionId,
			setIdle,
			setHasPending,
			promptSection,
			emit,
			run,
			runResult,
		};
	}

	it("re-renders from the store on resume and after compaction, but reuses the transcript on reload", async () => {
		const { promptSection, emit } = setup();
		await new MemoryStore(projectDir).addEntry({ title: "Stored rule" });

		await emit("session_start", { type: "session_start", reason: "resume" });
		expect(await promptSection()).toContain("Stored rule");

		await emit("session_start", { type: "session_start", reason: "reload" });
		expect(await promptSection()).toBe("stale transcript section");

		await new MemoryStore(projectDir).addEntry({ title: "Added mid-session" });
		expect(await promptSection()).toBe("stale transcript section");
		await emit("session_compact", { type: "session_compact" });
		expect(await promptSection()).toContain("Added mid-session");
	});

	it("tells the agent about /memory add and rm", async () => {
		const { commands, sent, ctx } = setup();
		const command = commands.get("memory");
		await command?.handler("add use pnpm", ctx);
		const [added] = await new MemoryStore(projectDir).listEntries();
		await command?.handler(`rm ${added.id}`, ctx);

		expect(sent.map((m) => m.display)).toEqual([false, false]);
		expect(sent[0].content).toContain(`added [${added.id}]`);
		expect(sent[1].content).toContain(`deleted [${added.id}]`);
	});

	it("returns linked bodies on get and reports dangling links on delete", async () => {
		const { run } = setup();
		await run({ action: "add", id: "run-tests", title: "Run tests with ./test.sh", body: "skips e2e" });
		await run({ action: "add", id: "check", title: "Run npm run check", body: "then [[run-tests]]" });

		const got = await run({ action: "get", id: "check" });
		expect(got).toContain("Linked entries:\n\n[run-tests] (fact) Run tests with ./test.sh\nskips e2e");
		expect(await run({ action: "get", id: "run-tests" })).toContain(
			"Linked from:\n- [check] (fact) Run npm run check",
		);
		expect(await run({ action: "search", query: "npm" })).toContain(
			"[check] (fact) Run npm run check -> [[run-tests]]",
		);
		expect(await run({ action: "delete", id: "run-tests" })).toContain("Still linked from [check]");
	});

	it("does not create a memory directory on session start", async () => {
		const { promptSection, emit } = setup({ initialSessionId: "startup-no-dir" });
		await emit("session_start", { type: "session_start", reason: "startup" });
		await promptSection();
		expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(false);
	});

	it("supports global memory CRUD, rejects scope='all' on writes, and injects both global and project prompts", async () => {
		const { run, runResult, emit, promptSection } = setup({ initialSessionId: "sess-global-crud" });

		await expect(run({ action: "add", scope: "all", title: "Bad scope" })).rejects.toThrow("not supported");
		await expect(run({ action: "update", scope: "all", id: "x", title: "Bad" })).rejects.toThrow("not supported");
		await expect(run({ action: "delete", scope: "all", id: "x" })).rejects.toThrow("not supported");

		const addOut = await run({
			action: "add",
			scope: "global",
			id: "no-force-push",
			title: "Never force push main",
			body: "Always preserve git history on main.",
			category: "convention",
			pinned: true,
		});
		expect(addOut).toContain("Recorded global memory [no-force-push]");

		await run({
			action: "add",
			scope: "project",
			id: "proj-lint",
			title: "Run biome check before PR",
			category: "convention",
		});

		const updated = await run({
			action: "update",
			scope: "global",
			id: "no-force-push",
			title: "Never force push protected branches",
		});
		expect(updated).toContain("Updated global memory [no-force-push]");

		// Combined list (default scope="all") prefixes global entries with [global].
		const listRes = await runResult({ action: "list" });
		expect(listRes.content[0]?.text).toContain("[global] [no-force-push]");
		expect(listRes.content[0]?.text).toContain("[proj-lint]");
		expect(listRes.details?.globalEntries?.map((e) => e.id)).toEqual(["no-force-push"]);

		// before_agent_start renders both Global memory and Project sections.
		await emit("session_start", { type: "session_start", reason: "startup" });
		const prompt = await promptSection();
		expect(prompt).toContain('Global memory (cross-project, scope="global"):');
		expect(prompt).toContain("Never force push protected branches");
		expect(prompt).toContain("Always preserve git history on main.");
		expect(prompt).toContain(`Project: ${projectDir}`);
		expect(prompt).toContain("[proj-lint]");

		// Delete global memory.
		const delOut = await run({ action: "delete", scope: "global", id: "no-force-push" });
		expect(delOut).toContain("Deleted global memory [no-force-push]");
		expect(await MemoryStore.global(agentDir).listEntries()).toEqual([]);
	});

	it("tracks hits in state.json across cross-scope [[id]] links without mutating .md files", async () => {
		const { run } = setup({ initialSessionId: "sess-hits" });

		await run({
			action: "add",
			scope: "global",
			id: "global-ts-rule",
			title: "Avoid any in TypeScript",
			body: "Use strict types and type guards.",
		});
		await run({
			action: "add",
			scope: "project",
			id: "memory-types",
			title: "Memory engine type contract",
			body: "Follow [[global-ts-rule]] for all memory modules.",
		});

		const projectStore = new MemoryStore(projectDir, agentDir);
		const globalStore = MemoryStore.global(agentDir);
		const projMdPath = path.join(projectStore.entriesDir, "memory-types.md");
		const globMdPath = path.join(globalStore.entriesDir, "global-ts-rule.md");

		const projBeforeContent = fs.readFileSync(projMdPath, "utf8");
		const globBeforeContent = fs.readFileSync(globMdPath, "utf8");
		// Set deterministic older mtimes so any inadvertent write is detected immediately.
		const oldTime = new Date("2025-01-01T00:00:00.000Z");
		fs.utimesSync(projMdPath, oldTime, oldTime);
		fs.utimesSync(globMdPath, oldTime, oldTime);
		const projBeforeMtime = fs.statSync(projMdPath).mtimeMs;
		const globBeforeMtime = fs.statSync(globMdPath).mtimeMs;

		// get on project note resolves cross-scope link and records hits in BOTH ledgers.
		const got = await run({ action: "get", id: "memory-types" });
		expect(got).toContain("Linked entries:\n\n[global] [global-ts-rule] (fact) Avoid any in TypeScript");

		// get without scope falls back from project to global.
		const gotGlobal = await run({ action: "get", id: "global-ts-rule" });
		expect(gotGlobal).toContain("Memory [global] [global-ts-rule]");
		expect(gotGlobal).toContain("Linked from:\n- [memory-types] (fact) Memory engine type contract");

		// Neither .md file was touched!
		expect(fs.readFileSync(projMdPath, "utf8")).toBe(projBeforeContent);
		expect(fs.readFileSync(globMdPath, "utf8")).toBe(globBeforeContent);
		expect(fs.statSync(projMdPath).mtimeMs).toBe(projBeforeMtime);
		expect(fs.statSync(globMdPath).mtimeMs).toBe(globBeforeMtime);

		// state.json tracked hits accurately on both stores.
		const projState = await projectStore.ledger.read();
		const globState = await globalStore.ledger.read();
		expect(projState.entries["memory-types"]?.hitCount).toBe(1);
		expect(globState.entries["global-ts-rule"]?.hitCount).toBe(2); // 1 via cross-scope link + 1 direct get

		// Deleting global entry reports dangling cross-scope link from project.
		const delGlobal = await run({ action: "delete", scope: "global", id: "global-ts-rule" });
		expect(delGlobal).toContain("Still linked from [memory-types]");
	});

	it("runs session-driven decay on session_start, discovers archived entries via search, and restores on get", async () => {
		const { run, emit, setSessionId } = setup({ initialSessionId: "s-0" });

		await run({
			action: "add",
			id: "old-gotcha",
			title: "Legacy webpack proxy flag",
			body: "Use --legacy-proxy when running dev server.",
		});
		await run({
			action: "add",
			id: "pinned-redline",
			title: "Never commit credentials",
			pinned: true,
		});
		await run({
			action: "add",
			id: "linked-child",
			title: "Target kept alive by link",
		});
		await run({
			action: "add",
			id: "pinned-parent",
			title: "Parent linking child",
			pinned: true,
			body: "See [[linked-child]]",
		});

		// Reload and fork must NOT advance sessionSeq or run decay.
		setSessionId("reload-should-ignore");
		await emit("session_start", { type: "session_start", reason: "reload" });
		setSessionId("fork-should-ignore");
		await emit("session_start", { type: "session_start", reason: "fork" });

		const projectStore = new MemoryStore(projectDir, agentDir);
		expect((await projectStore.ledger.read()).sessionSeq).toBe(0);

		// Advance 16 startup sessions so old-gotcha decays below 0.125 and moves to .archive/.
		for (let i = 1; i <= MIN_SESSIONS_BEFORE_ARCHIVE + 1; i++) {
			setSessionId(`startup-${i}`);
			await emit("session_start", { type: "session_start", reason: "startup" });
		}

		expect((await projectStore.listArchivedEntries()).map((e) => e.id)).toEqual(["old-gotcha"]);
		expect((await projectStore.listEntries()).map((e) => e.id).sort()).toEqual([
			"linked-child",
			"pinned-parent",
			"pinned-redline",
		]);

		// search still finds archived entry prefixed with [archived].
		const searchOut = await run({ action: "search", query: "webpack proxy" });
		expect(searchOut).toContain("[archived] [old-gotcha]");

		// get automatically restores archived entry and notes reconsolidation.
		setSessionId("startup-restore");
		const getOut = await run({ action: "get", id: "old-gotcha" });
		expect(getOut).toContain("(restored from archive)");
		expect(getOut).toContain("Use --legacy-proxy when running dev server.");

		expect(await projectStore.listArchivedEntries()).toEqual([]);
		expect((await projectStore.listEntries()).some((e) => e.id === "old-gotcha")).toBe(true);
		const restoredUsage = (await projectStore.ledger.read()).entries["old-gotcha"];
		expect(restoredUsage?.hitCount).toBe(1);
		expect(restoredUsage?.lastHitSessionSeq).toBe(MIN_SESSIONS_BEFORE_ARCHIVE + 2);
	});

	it("handles /memory global add, global rm, decay, and path commands", async () => {
		const { commands, sent, ctx, notify } = setup({ initialSessionId: "cmd-sess" });
		const command = commands.get("memory");

		await command?.handler("global add always use strict types", ctx);
		const [addedGlobal] = await MemoryStore.global(agentDir).listEntries();
		expect(addedGlobal?.scope).toBe("global");
		expect(sent[0]?.content).toContain(`added global [${addedGlobal.id}]`);

		await command?.handler("path", ctx);
		const pathNotice = notify.mock.calls.at(-1)?.[0] as string;
		expect(pathNotice).toContain(GLOBAL_MEMORY_DIR_NAME);

		await command?.handler("decay", ctx);
		const decayNotice = notify.mock.calls.at(-1)?.[0] as string;
		expect(decayNotice).toContain("Memory decay");

		await command?.handler(`global rm ${addedGlobal.id}`, ctx);
		expect(await MemoryStore.global(agentDir).listEntries()).toEqual([]);
		expect(sent[1]?.content).toContain(`deleted global [${addedGlobal.id}]`);
	});

	it("handles /memory dream status, manual triggerTurn dispatch, missing model, busy followUp, and preserves frozen prompt section", async () => {
		const sessionMgr = SessionManager.inMemory(projectDir);

		// 1) Missing model warns cleanly without sending a turn
		const noModelSetup = setup({
			sessionManager: sessionMgr,
			extensionOptions: { enableIdleDream: false },
		});
		await noModelSetup.commands.get("memory")?.handler("dream", noModelSetup.ctx);
		expect(noModelSetup.notify.mock.calls.at(-1)?.[0]).toContain("requires an active model");
		expect(noModelSetup.notify.mock.calls.at(-1)?.[1]).toBe("warning");
		expect(noModelSetup.sent).toHaveLength(0);

		const { commands, sent, ctx, notify, setIdle, promptSection, emit } = setup({
			model: TEST_DREAM_MODEL,
			sessionManager: sessionMgr,
			extensionOptions: { enableIdleDream: false },
		});
		const command = commands.get("memory");

		// 2) Invalid dream flag warns with usage
		await command?.handler("dream --bogus", ctx);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Usage: /memory dream [status]");
		expect(notify.mock.calls.at(-1)?.[1]).toBe("warning");

		// 3) /memory dream status leaves memory/ untouched when empty
		await command?.handler("dream status", ctx);
		const statusText = notify.mock.calls.at(-1)?.[0] as string;
		expect(statusText).toContain("Dream status");
		expect(statusText).toContain("test-provider/ext-dream-model");
		expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(false);

		// Seed a note with a broken [[id]] link and freeze <project_memory>
		await new MemoryStore(projectDir, agentDir).addEntry({
			id: "existing-rule",
			title: "Existing rule",
			body: "Depends on [[missing-target]]",
		});
		await emit("session_start", { type: "session_start", reason: "startup" });
		const frozenBefore = await promptSection();
		expect(frozenBefore).toContain("Existing rule");

		// 4) /memory dream triggers an in-session consolidation turn with diagnostics
		await command?.handler("dream", ctx);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe(MEMORY_DREAM_CUSTOM_TYPE);
		expect(sent[0]?.display).toBe(true);
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.content).toContain("Manual memory consolidation (dream)");
		expect(sent[0]?.content).toContain("[project:existing-rule] -> [[missing-target]]");
		expect(sent[0]?.details).toEqual({
			trigger: "manual",
			projectRoot: projectDir,
			decayedCount: 0,
			brokenLinkCount: 1,
		});

		// Adding a new entry during the dream turn must NOT invalidate the frozen prompt section
		await new MemoryStore(projectDir, agentDir).addEntry({ id: "during-dream", title: "Added during dream" });
		await emit("agent_end", {
			type: "agent_end",
			messages: [makeTestAssistant([{ type: "text", text: "Consolidated." }], "stop")],
		});
		expect(await promptSection()).toBe(frozenBefore);

		// 5) Manual /memory dream while agent is busy queues as followUp
		setIdle(false);
		await command?.handler("dream", ctx);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("schedules unref'd 3-hour idle dream triggerTurn, prevents self-loop, skips duplicate leafId, and cancels on user activity", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const unrefSpy = vi.fn();
		const realSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => {
			const handle = realSetTimeout(fn, delay, ...args);
			const origUnref = handle.unref?.bind(handle);
			handle.unref = () => {
				unrefSpy();
				return origUnref ? origUnref() : handle;
			};
			return handle;
		}) as typeof globalThis.setTimeout);

		try {
			const sessionMgr = SessionManager.inMemory(projectDir);
			sessionMgr.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Remember to run biome check." }],
				timestamp: Date.now() - 5000,
			});
			const stopAssistant = makeTestAssistant([{ type: "text", text: "Verified npx biome check." }], "stop");
			sessionMgr.appendMessage(stopAssistant);

			const { emit, sent, setIdle, setHasPending } = setup({
				model: TEST_DREAM_MODEL,
				sessionManager: sessionMgr,
				extensionOptions: {
					idleDreamMs: DEFAULT_DREAM_IDLE_MS,
					jitterMs: 0,
				},
			});

			await emit("session_start", { type: "session_start", reason: "startup" });

			// Clean agent_end arms an unref'd 3-hour timer
			await emit("agent_end", { type: "agent_end", messages: [stopAssistant] });
			expect(unrefSpy).toHaveBeenCalled();

			// Not yet fired at 2h 59m 59s
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS - 1000);
			expect(sent).toHaveLength(0);

			// Fires right at 3h by injecting a memory-dream triggerTurn into the active session
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => {
				expect(sent).toHaveLength(1);
			});
			expect(sent[0]?.customType).toBe(MEMORY_DREAM_CUSTOM_TYPE);
			expect(sent[0]?.options).toEqual({ triggerTurn: true });
			expect(sent[0]?.content).toContain("Idle memory consolidation (dream)");

			// Completing the dream turn advances leafId and must NOT re-arm the idle timer (no self-loop)
			const dreamReply = makeTestAssistant([{ type: "text", text: "Updated project memory." }], "stop");
			sessionMgr.appendMessage(dreamReply);
			await emit("agent_end", { type: "agent_end", messages: [dreamReply] });
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS * 2);
			expect(sent).toHaveLength(1);

			// Emitting agent_end again at the SAME leafId must NOT re-arm
			await emit("agent_end", { type: "agent_end", messages: [dreamReply] });
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS * 2);
			expect(sent).toHaveLength(1);

			// Advance leafId with a new user turn, arm timer, then cancel via `input` before 3h elapses
			sessionMgr.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Second topic" }],
				timestamp: Date.now(),
			});
			const secondAssistant = makeTestAssistant([{ type: "text", text: "Second reply" }], "stop");
			sessionMgr.appendMessage(secondAssistant);
			await emit("agent_end", { type: "agent_end", messages: [secondAssistant] });
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
			await emit("input", { type: "input", text: "user is back", source: "interactive" });
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS * 2);
			expect(sent).toHaveLength(1);

			// Busy session or pending messages skip idle dream dispatch
			await emit("agent_end", { type: "agent_end", messages: [secondAssistant] });
			setIdle(false);
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS);
			expect(sent).toHaveLength(1);

			setIdle(true);
			setHasPending(true);
			await emit("agent_end", { type: "agent_end", messages: [secondAssistant] });
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS);
			expect(sent).toHaveLength(1);
			setHasPending(false);

			// session_before_compact and session_shutdown cleanly cancel any armed timer
			await emit("agent_end", { type: "agent_end", messages: [secondAssistant] });
			await emit("session_before_compact", { type: "session_before_compact" });
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS * 2);
			expect(sent).toHaveLength(1);

			await emit("agent_end", { type: "agent_end", messages: [secondAssistant] });
			await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			await vi.advanceTimersByTimeAsync(DEFAULT_DREAM_IDLE_MS * 2);
			expect(sent).toHaveLength(1);
		} finally {
			setTimeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("memory render helpers", () => {
	const mockTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	const mockKeybindings = {
		matches: () => false,
	} as unknown as KeybindingsManager;

	it("renders memory-dream custom messages cleanly in collapsed and expanded views", () => {
		const message: CustomMessage<MemoryDreamMessageDetails> = {
			role: "custom",
			customType: MEMORY_DREAM_CUSTOM_TYPE,
			content: "[Manual memory consolidation (dream)]\nConsolidate durable notes.",
			display: true,
			details: {
				trigger: "manual",
				projectRoot: "/repo",
				decayedCount: 2,
				brokenLinkCount: 1,
			},
			timestamp: Date.now(),
		};

		const baseRenderOpts = {
			outputPad: 1,
			keyText: () => "",
			keyHint: () => "",
		};

		const collapsed = renderDreamMessage(message, { ...baseRenderOpts, expanded: false }, mockTheme)
			?.render(120)
			.join("\n");
		expect(collapsed).toContain("memory dream");
		expect(collapsed).toContain("manual");
		expect(collapsed).toContain("decayed 2");
		expect(collapsed).toContain("1 broken link(s)");
		expect(collapsed).not.toContain("Consolidate durable notes.");

		const expanded = renderDreamMessage(message, { ...baseRenderOpts, expanded: true }, mockTheme)
			?.render(120)
			.join("\n");
		expect(expanded).toContain("Consolidate durable notes.");
	});

	it("displays [global] and [archived] tags in renderToolCall, renderToolResult, and MemoryListComponent", () => {
		const callText = renderToolCall({ action: "add", scope: "global", title: "Rule" }, mockTheme)
			.render(100)
			.join("\n");
		expect(callText).toContain("[global]");

		const archivedGlobalEntry = entry("old-global", "Archived global rule", {
			scope: "global",
			archived: true,
			body: "details",
		});
		const searchRes = renderToolResult(
			{
				content: [],
				details: { action: "search", scope: "all", entries: [archivedGlobalEntry], archivedCount: 1 },
			},
			{ expanded: true },
			mockTheme,
		)
			.render(120)
			.join("\n");
		expect(searchRes).toContain("[global]");
		expect(searchRes).toContain("[archived]");

		const comp = new MemoryListComponent(
			[entry("p1", "Project entry", { scope: "project" })],
			"/repo",
			mockTheme,
			mockKeybindings,
			() => undefined,
			[entry("g1", "Global entry", { scope: "global", pinned: true })],
		);
		const rendered = comp.render(100).join("\n");
		expect(rendered).toContain("Global Memory");
		expect(rendered).toContain("Project Memory");
		expect(rendered).toContain("[global]");
		expect(rendered).toContain("[g1]");
		expect(rendered).toContain("[p1]");
	});
});

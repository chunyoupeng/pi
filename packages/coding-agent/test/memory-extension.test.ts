import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import memoryExtension from "../src/extensions/memory/index.ts";
import { renderPromptSection } from "../src/extensions/memory/render.ts";
import { MemoryStore, resolveMemoryDir } from "../src/extensions/memory/store.ts";
import type { MemoryEntry } from "../src/extensions/memory/types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

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
});

describe("memory extension", () => {
	function setup() {
		const handlers = new Map<string, Handler>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const sent: Array<{ customType: string; content: string; display: boolean }> = [];
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
				commands.set(name, def),
			sendMessage: (message: { customType: string; content: string; display: boolean }) => sent.push(message),
		} as unknown as ExtensionAPI;
		memoryExtension(pi);

		const transcriptSection = "<project_memory>\nstale transcript section\n</project_memory>";
		const ctx = {
			cwd: projectDir,
			hasUI: false,
			mode: "print",
			ui: { notify: vi.fn() },
			sessionManager: {
				buildSessionProjection: () => ({
					messages: [
						{ role: "system", content: "", sections: { project_memory: transcriptSection }, timestamp: 1 },
					],
				}),
			},
		} as unknown as ExtensionContext;

		const promptSection = async (): Promise<string> => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await handlers.get("before_agent_start")?.(event, ctx);
			return event.systemPromptOptions.sections.project_memory;
		};
		const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
		return { commands, sent, ctx, promptSection, emit };
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

	it("does not create a memory directory on session start", async () => {
		const { promptSection, emit } = setup();
		await emit("session_start", { type: "session_start", reason: "startup" });
		await promptSection();
		expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(false);
	});
});

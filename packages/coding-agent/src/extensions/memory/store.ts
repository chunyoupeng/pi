import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import type { MemoryCategory, MemoryEntry } from "./types.ts";

const execFileAsync = promisify(execFile);

const SECRET_PATTERNS: RegExp[] = [
	/\b(sk-[a-zA-Z0-9_-]{20,})\b/,
	/\b(ghp_[a-zA-Z0-9]{20,})\b/,
	/\b(github_pat_[a-zA-Z0-9_]{22,})\b/,
	/\b(AKIA[0-9A-Z]{16})\b/,
	/\b(AIza[0-9A-Za-z-_]{35})\b/,
	/-----BEGIN [A-Z ]+PRIVATE KEY-----/,
];

export function assertNoSecrets(text: string): void {
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			throw new Error("Memory entry rejected: content appears to contain an API key, credential, or private key.");
		}
	}
}

export function generateMemoryId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 6);
	return `m-${timestamp}${random}`;
}

export function computeSafeDirName(dirPath: string): string {
	const resolved = path.resolve(dirPath);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function parseEntryFile(content: string): MemoryEntry | null {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) return null;
	const secondIndex = trimmed.indexOf("\n---", 3);
	if (secondIndex === -1) return null;

	const fmBlock = trimmed.slice(3, secondIndex).trim();
	const body = trimmed.slice(secondIndex + 4).trim();

	const fields: Record<string, string> = {};
	for (const line of fmBlock.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		let val = line.slice(colonIndex + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		fields[key] = val;
	}

	if (!fields.id || !fields.title) return null;
	const validCategories: MemoryCategory[] = ["fact", "decision", "convention", "gotcha"];
	const rawCategory = fields.category as MemoryCategory;
	const category: MemoryCategory = validCategories.includes(rawCategory) ? rawCategory : "fact";
	const pinned = fields.pinned === "true";
	const created = fields.created || new Date().toISOString();
	const updated = fields.updated || created;

	return {
		id: fields.id,
		title: fields.title,
		body: body || undefined,
		category,
		pinned,
		created,
		updated,
	};
}

export function serializeEntry(entry: MemoryEntry): string {
	const lines = [
		"---",
		`id: ${entry.id}`,
		`title: ${entry.title.replace(/\r?\n/g, " ")}`,
		`category: ${entry.category}`,
		`pinned: ${entry.pinned ? "true" : "false"}`,
		`created: ${entry.created}`,
		`updated: ${entry.updated}`,
		"---",
		"",
	];
	if (entry.body?.trim()) {
		lines.push(entry.body.trim(), "");
	}
	return lines.join("\n");
}

export async function resolveProjectRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
		if (stdout.trim()) {
			return path.resolve(stdout.trim());
		}
	} catch {
		// Git command failed or not a git repository, fallback to cwd
	}
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

const MEMORY_ID_PATTERN = /^m-[a-z0-9]+$/;

function readStoredProjectRoot(memoryDir: string): string | undefined {
	try {
		const info = JSON.parse(fs.readFileSync(path.join(memoryDir, "project.json"), "utf8")) as { root?: unknown };
		return typeof info.root === "string" ? info.root : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The readable dir name is lossy (`/a/b-c` and `/a-b/c` share one), so a dir already
 * claimed by another root falls back to a name suffixed with a hash of this root.
 */
export function resolveMemoryDir(agentDir: string, projectRoot: string): string {
	const readableDir = path.join(agentDir, "memory", computeSafeDirName(projectRoot));
	const claimedRoot = readStoredProjectRoot(readableDir);
	if (claimedRoot === undefined || claimedRoot === projectRoot) return readableDir;
	return `${readableDir}${createHash("sha256").update(projectRoot).digest("hex").slice(0, 8)}`;
}

function scoreEntry(entry: MemoryEntry, terms: string[]): number {
	const title = entry.title.toLowerCase();
	const body = entry.body?.toLowerCase() ?? "";
	let score = 0;
	for (const term of terms) {
		if (title.includes(term)) score += 2;
		else if (body.includes(term)) score += 1;
	}
	return score;
}

export class MemoryStore {
	readonly projectRoot: string;
	readonly memoryDir: string;
	readonly entriesDir: string;
	readonly trashDir: string;

	constructor(projectRoot: string, agentDir: string = getAgentDir()) {
		this.projectRoot = path.resolve(projectRoot);
		this.memoryDir = resolveMemoryDir(agentDir, this.projectRoot);
		this.entriesDir = path.join(this.memoryDir, "entries");
		this.trashDir = path.join(this.memoryDir, ".trash");
	}

	async listEntries(): Promise<MemoryEntry[]> {
		if (!fs.existsSync(this.entriesDir)) return [];
		const files = await fs.promises.readdir(this.entriesDir);
		const entries: MemoryEntry[] = [];
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const entry = await this.readEntry(path.join(this.entriesDir, file));
			if (entry) entries.push(entry);
		}

		entries.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return b.updated.localeCompare(a.updated);
		});
		return entries;
	}

	async getEntry(id: string): Promise<MemoryEntry | null> {
		return this.readEntry(this.entryPath(id));
	}

	async addEntry(params: {
		title: string;
		body?: string;
		category?: MemoryCategory;
		pinned?: boolean;
	}): Promise<MemoryEntry> {
		if (!params.title?.trim()) {
			throw new Error("Title is required for memory add");
		}
		assertNoSecrets(params.title);
		if (params.body) assertNoSecrets(params.body);

		const now = new Date().toISOString();
		const entry: MemoryEntry = {
			id: generateMemoryId(),
			title: params.title.trim(),
			body: params.body?.trim() || undefined,
			category: params.category || "fact",
			pinned: Boolean(params.pinned),
			created: now,
			updated: now,
		};

		const filePath = this.entryPath(entry.id);
		await withFileMutationQueue(filePath, async () => {
			await this.ensureDirs();
			await this.atomicWrite(filePath, serializeEntry(entry));
		});
		return entry;
	}

	async updateEntry(
		id: string,
		params: {
			title?: string;
			body?: string;
			category?: MemoryCategory;
			pinned?: boolean;
		},
	): Promise<MemoryEntry> {
		const filePath = this.entryPath(id);
		if (params.title) assertNoSecrets(params.title);
		if (params.body) assertNoSecrets(params.body);

		// Read inside the queue so parallel updates of one entry each see the previous write.
		return withFileMutationQueue(filePath, async () => {
			const current = await this.readExistingEntry(id, filePath);
			const updated: MemoryEntry = {
				...current,
				title: params.title !== undefined ? params.title.trim() : current.title,
				body: params.body !== undefined ? params.body.trim() || undefined : current.body,
				category: params.category ?? current.category,
				pinned: params.pinned ?? current.pinned,
				updated: new Date().toISOString(),
			};
			await this.atomicWrite(filePath, serializeEntry(updated));
			return updated;
		});
	}

	async deleteEntry(id: string): Promise<MemoryEntry> {
		const filePath = this.entryPath(id);
		return withFileMutationQueue(filePath, async () => {
			const current = await this.readExistingEntry(id, filePath);
			await fs.promises.mkdir(this.trashDir, { recursive: true });
			await fs.promises.rename(filePath, path.join(this.trashDir, `${id}.${Date.now()}.md`));
			return current;
		});
	}

	async searchEntries(query: string): Promise<MemoryEntry[]> {
		const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
		if (terms.length === 0) return [];
		const scored = (await this.listEntries())
			.map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
			.filter(({ score }) => score > 0);
		scored.sort((a, b) => b.score - a.score);
		return scored.map(({ entry }) => entry);
	}

	private entryPath(id: string): string {
		if (!MEMORY_ID_PATTERN.test(id)) {
			throw new Error(`Invalid memory id '${id}'`);
		}
		return path.join(this.entriesDir, `${id}.md`);
	}

	private async readEntry(filePath: string): Promise<MemoryEntry | null> {
		try {
			return parseEntryFile(await fs.promises.readFile(filePath, "utf8"));
		} catch {
			return null;
		}
	}

	private async readExistingEntry(id: string, filePath: string): Promise<MemoryEntry> {
		if (!fs.existsSync(filePath)) {
			throw new Error(`Memory entry with id '${id}' not found`);
		}
		const entry = await this.readEntry(filePath);
		if (!entry) {
			throw new Error(`Memory entry with id '${id}' could not be parsed`);
		}
		return entry;
	}

	// Directories are created on first write so merely starting pi in a directory leaves nothing behind.
	private async ensureDirs(): Promise<void> {
		await fs.promises.mkdir(this.entriesDir, { recursive: true });
		const projectInfoPath = path.join(this.memoryDir, "project.json");
		if (!fs.existsSync(projectInfoPath)) {
			await fs.promises.writeFile(
				projectInfoPath,
				JSON.stringify({ root: this.projectRoot, created: new Date().toISOString() }, null, 2),
				"utf8",
			);
		}
	}

	private async atomicWrite(filePath: string, content: string): Promise<void> {
		const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
		await fs.promises.writeFile(tmp, content, "utf8");
		await fs.promises.rename(tmp, filePath);
	}
}

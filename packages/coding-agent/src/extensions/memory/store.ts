import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getAgentDir as getDefaultAgentDir } from "../../config.ts";
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

export function getAgentDir(): string {
	const envDir = process.env.PI_AGENT_DIR;
	if (envDir) return path.resolve(envDir);
	return getDefaultAgentDir();
}

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath);
	try {
		return await fs.promises.realpath(resolvedPath);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error) {
			const code = (error as { code: string }).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				return resolvedPath;
			}
		}
		throw error;
	}
}

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
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

export class MemoryStore {
	readonly projectRoot: string;
	readonly memoryDir: string;
	readonly entriesDir: string;
	readonly trashDir: string;

	constructor(projectRoot: string, agentDir: string = getAgentDir()) {
		this.projectRoot = path.resolve(projectRoot);
		const safeName = computeSafeDirName(this.projectRoot);
		this.memoryDir = path.join(agentDir, "memory", safeName);
		this.entriesDir = path.join(this.memoryDir, "entries");
		this.trashDir = path.join(this.memoryDir, ".trash");
	}

	init(): void {
		fs.mkdirSync(this.entriesDir, { recursive: true });
		fs.mkdirSync(this.trashDir, { recursive: true });
		const projectInfoPath = path.join(this.memoryDir, "project.json");
		if (!fs.existsSync(projectInfoPath)) {
			fs.writeFileSync(
				projectInfoPath,
				JSON.stringify({ root: this.projectRoot, created: new Date().toISOString() }, null, 2),
				"utf8",
			);
		}
	}

	async listEntries(): Promise<MemoryEntry[]> {
		if (!fs.existsSync(this.entriesDir)) return [];
		const files = await fs.promises.readdir(this.entriesDir);
		const entries: MemoryEntry[] = [];
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const filePath = path.join(this.entriesDir, file);
			try {
				const content = await fs.promises.readFile(filePath, "utf8");
				const entry = parseEntryFile(content);
				if (entry) {
					entries.push(entry);
				}
			} catch {
				// Ignore unreadable files
			}
		}

		entries.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return b.updated.localeCompare(a.updated);
		});
		return entries;
	}

	async getEntry(id: string): Promise<MemoryEntry | null> {
		const filePath = path.join(this.entriesDir, `${id}.md`);
		if (!fs.existsSync(filePath)) return null;
		try {
			const content = await fs.promises.readFile(filePath, "utf8");
			return parseEntryFile(content);
		} catch {
			return null;
		}
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
		const id = generateMemoryId();
		const entry: MemoryEntry = {
			id,
			title: params.title.trim(),
			body: params.body?.trim() || undefined,
			category: params.category || "fact",
			pinned: Boolean(params.pinned),
			created: now,
			updated: now,
		};

		const filePath = path.join(this.entriesDir, `${id}.md`);
		const serialized = serializeEntry(entry);
		await this.atomicWrite(filePath, serialized);
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
		const filePath = path.join(this.entriesDir, `${id}.md`);
		if (!fs.existsSync(filePath)) {
			throw new Error(`Memory entry with id '${id}' not found`);
		}
		if (params.title) assertNoSecrets(params.title);
		if (params.body) assertNoSecrets(params.body);

		const current = await this.getEntry(id);
		if (!current) {
			throw new Error(`Memory entry with id '${id}' could not be parsed`);
		}

		const updated: MemoryEntry = {
			...current,
			title: params.title !== undefined ? params.title.trim() : current.title,
			body: params.body !== undefined ? params.body.trim() || undefined : current.body,
			category: params.category ?? current.category,
			pinned: params.pinned ?? current.pinned,
			updated: new Date().toISOString(),
		};

		const serialized = serializeEntry(updated);
		await this.atomicWrite(filePath, serialized);
		return updated;
	}

	async deleteEntry(id: string): Promise<MemoryEntry> {
		const filePath = path.join(this.entriesDir, `${id}.md`);
		if (!fs.existsSync(filePath)) {
			throw new Error(`Memory entry with id '${id}' not found`);
		}
		const current = await this.getEntry(id);
		if (!current) {
			throw new Error(`Memory entry with id '${id}' could not be parsed`);
		}

		const trashPath = path.join(this.trashDir, `${id}.${Date.now()}.md`);
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.rename(filePath, trashPath);
		});
		return current;
	}

	async searchEntries(query: string): Promise<MemoryEntry[]> {
		const lowerQuery = query.toLowerCase().trim();
		if (!lowerQuery) return [];
		const all = await this.listEntries();
		return all.filter((entry) => {
			const inTitle = entry.title.toLowerCase().includes(lowerQuery);
			const inBody = entry.body ? entry.body.toLowerCase().includes(lowerQuery) : false;
			return inTitle || inBody;
		});
	}

	private async atomicWrite(filePath: string, content: string): Promise<void> {
		await withFileMutationQueue(filePath, async () => {
			const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
			await fs.promises.writeFile(tmp, content, "utf8");
			await fs.promises.rename(tmp, filePath);
		});
	}
}

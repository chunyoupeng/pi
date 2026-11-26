import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { ARCHIVE_SCORE_THRESHOLD, computeDecayScore, MemoryStateLedger, MIN_SESSIONS_BEFORE_ARCHIVE } from "./state.ts";
import {
	GLOBAL_MEMORY_DIR_NAME,
	type MemoryCategory,
	type MemoryEntry,
	type MemoryLinks,
	type MemoryScope,
} from "./types.ts";

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

/** Ids are slugs like `npm-check-skips-tests` so a `[[id]]` link reads on its own. */
export function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 48)
		.replace(/^-+|-+$/g, "");
	return slug || `note-${Date.now().toString(36)}`;
}

const LINK_PATTERN = /\[\[([a-z0-9-]+)\]\]/g;

export function parseLinks(body: string | undefined): string[] {
	if (!body) return [];
	return [...new Set(Array.from(body.matchAll(LINK_PATTERN), (match) => match[1]))];
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
	if (!fs.existsSync(cwd)) {
		return path.resolve(cwd);
	}
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

export const MEMORY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MEMORY_ID_MAX_LENGTH = 64;

export function isValidMemoryId(id: string): boolean {
	return id.length > 0 && id.length <= MEMORY_ID_MAX_LENGTH && MEMORY_ID_PATTERN.test(id);
}

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

export function scoreEntry(entry: MemoryEntry, terms: readonly string[]): number {
	const title = entry.title.toLowerCase();
	const body = entry.body?.toLowerCase() ?? "";
	let score = 0;
	for (const term of terms) {
		if (title.includes(term)) score += 2;
		else if (body.includes(term)) score += 1;
	}
	return score;
}

function sortEntries(entries: MemoryEntry[]): MemoryEntry[] {
	entries.sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return b.updated.localeCompare(a.updated);
	});
	return entries;
}

export class MemoryStore {
	readonly scope: MemoryScope;
	readonly projectRoot: string;
	readonly memoryDir: string;
	readonly entriesDir: string;
	readonly archiveDir: string;
	readonly trashDir: string;
	readonly ledger: MemoryStateLedger;

	constructor(projectRoot: string, agentDir: string = getAgentDir(), options?: { scope?: MemoryScope }) {
		const scope: MemoryScope = options?.scope ?? "project";
		this.scope = scope;
		if (scope === "global") {
			this.projectRoot = GLOBAL_MEMORY_DIR_NAME;
			this.memoryDir = path.join(agentDir, "memory", GLOBAL_MEMORY_DIR_NAME);
		} else {
			this.projectRoot = path.resolve(projectRoot);
			this.memoryDir = resolveMemoryDir(agentDir, this.projectRoot);
		}
		this.entriesDir = path.join(this.memoryDir, "entries");
		this.archiveDir = path.join(this.memoryDir, ".archive");
		this.trashDir = path.join(this.memoryDir, ".trash");
		this.ledger = new MemoryStateLedger(this.memoryDir);
	}

	static global(agentDir: string = getAgentDir()): MemoryStore {
		return new MemoryStore(GLOBAL_MEMORY_DIR_NAME, agentDir, { scope: "global" });
	}

	async listEntries(): Promise<MemoryEntry[]> {
		return this.readEntriesFromDir(this.entriesDir, false);
	}

	async listArchivedEntries(): Promise<MemoryEntry[]> {
		return this.readEntriesFromDir(this.archiveDir, true);
	}

	async getEntry(id: string, options?: { includeArchived?: boolean }): Promise<MemoryEntry | null> {
		const active = await this.readEntry(this.entryPath(id), false);
		if (active) return active;
		if (options?.includeArchived) {
			return this.readEntry(this.archivePath(id), true);
		}
		return null;
	}

	async addEntry(params: {
		id?: string;
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
			id: params.id?.trim() || slugifyTitle(params.title),
			title: params.title.trim(),
			body: params.body?.trim() || undefined,
			category: params.category || "fact",
			pinned: Boolean(params.pinned),
			created: now,
			updated: now,
			scope: this.scope,
		};

		const filePath = this.entryPath(entry.id);
		const archivedFilePath = this.archivePath(entry.id);
		await withFileMutationQueue(filePath, async () => {
			if (fs.existsSync(filePath)) {
				throw new Error(`Memory entry '${entry.id}' already exists; update it or choose another id`);
			}
			if (fs.existsSync(archivedFilePath)) {
				throw new Error(
					`Memory entry '${entry.id}' already exists in archive; get it to restore or choose another id`,
				);
			}
			await this.ensureDirs();
			await this.atomicWrite(filePath, serializeEntry(entry));
		});
		await this.ledger.recordEntryCreate(entry.id);
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
			const current = await this.readExistingEntry(id, filePath, false);
			const updated: MemoryEntry = {
				...current,
				title: params.title !== undefined ? params.title.trim() : current.title,
				body: params.body !== undefined ? params.body.trim() || undefined : current.body,
				category: params.category ?? current.category,
				pinned: params.pinned ?? current.pinned,
				updated: new Date().toISOString(),
				scope: this.scope,
			};
			await this.atomicWrite(filePath, serializeEntry(updated));
			return updated;
		});
	}

	async archiveEntry(id: string): Promise<MemoryEntry> {
		const filePath = this.entryPath(id);
		const archivedFilePath = this.archivePath(id);
		return withFileMutationQueue(filePath, async () => {
			const current = await this.readExistingEntry(id, filePath, false);
			await fs.promises.mkdir(this.archiveDir, { recursive: true });
			await fs.promises.rename(filePath, archivedFilePath);
			return { ...current, scope: this.scope, archived: true };
		});
	}

	async restoreEntry(id: string): Promise<MemoryEntry> {
		const filePath = this.entryPath(id);
		const archivedFilePath = this.archivePath(id);
		const restored = await withFileMutationQueue(filePath, async () => {
			if (fs.existsSync(filePath)) {
				throw new Error(`Active memory entry '${id}' already exists; cannot restore archived copy`);
			}
			const current = await this.readExistingEntry(id, archivedFilePath, true);
			await this.ensureDirs();
			await fs.promises.rename(archivedFilePath, filePath);
			return { ...current, scope: this.scope, archived: false };
		});
		await this.ledger.mutate((state) => {
			const existing = state.entries[id];
			if (existing) {
				existing.lastHitSessionSeq = state.sessionSeq;
			} else {
				state.entries[id] = {
					hitCount: 0,
					lastHitSessionSeq: state.sessionSeq,
					createdSessionSeq: state.sessionSeq,
				};
			}
		});
		return restored;
	}

	async deleteEntry(id: string): Promise<MemoryEntry> {
		const filePath = this.entryPath(id);
		const archivedFilePath = this.archivePath(id);
		const deleted = await withFileMutationQueue(filePath, async () => {
			let sourcePath = filePath;
			let isArchived = false;
			if (!fs.existsSync(filePath) && fs.existsSync(archivedFilePath)) {
				sourcePath = archivedFilePath;
				isArchived = true;
			}
			const current = await this.readExistingEntry(id, sourcePath, isArchived);
			await fs.promises.mkdir(this.trashDir, { recursive: true });
			await fs.promises.rename(sourcePath, path.join(this.trashDir, `${id}.${Date.now()}.md`));
			return current;
		});
		await this.ledger.removeEntry(id);
		return deleted;
	}

	async searchEntries(query: string, options?: { includeArchived?: boolean }): Promise<MemoryEntry[]> {
		const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
		if (terms.length === 0) return [];
		const includeArchived = options?.includeArchived ?? true;

		const [activeEntries, archivedEntries] = await Promise.all([
			this.listEntries(),
			includeArchived ? this.listArchivedEntries() : Promise.resolve<MemoryEntry[]>([]),
		]);

		const scored: Array<{ entry: MemoryEntry; score: number }> = [];
		for (const entry of activeEntries) {
			const score = scoreEntry(entry, terms);
			if (score > 0) scored.push({ entry, score });
		}
		for (const entry of archivedEntries) {
			const score = scoreEntry(entry, terms);
			if (score > 0) scored.push({ entry, score: score * 0.5 });
		}

		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const aArchived = Boolean(a.entry.archived);
			const bArchived = Boolean(b.entry.archived);
			if (aArchived !== bArchived) return aArchived ? 1 : -1;
			return b.entry.updated.localeCompare(a.entry.updated);
		});
		return scored.map(({ entry }) => entry);
	}

	/** One hop in both directions: entries this one links to, and entries that link to it (including companion scope). */
	async findLinks(entry: MemoryEntry, companionEntries: readonly MemoryEntry[] = []): Promise<MemoryLinks> {
		const localEntries = await this.listEntries();
		const entryScope = entry.scope ?? this.scope;

		const byId = new Map<string, MemoryEntry>();
		for (const companion of companionEntries) {
			byId.set(companion.id, companion);
		}
		for (const local of localEntries) {
			const localScope = local.scope ?? this.scope;
			if (localScope === entryScope || !byId.has(local.id)) {
				byId.set(local.id, local);
			}
		}

		const links: MemoryLinks = { linked: [], missing: [], linkedFrom: [] };
		for (const id of parseLinks(entry.body)) {
			if (id === entry.id) continue;
			const target = byId.get(id);
			if (target) links.linked.push(target);
			else links.missing.push(id);
		}

		const seenLinkers = new Set<string>();
		for (const candidate of [...localEntries, ...companionEntries]) {
			const candidateScope = candidate.scope ?? this.scope;
			if (candidate.id === entry.id && candidateScope === entryScope) continue;
			const key = `${candidateScope}:${candidate.id}`;
			if (seenLinkers.has(key)) continue;
			if (parseLinks(candidate.body).includes(entry.id)) {
				seenLinkers.add(key);
				links.linkedFrom.push(candidate);
			}
		}
		return links;
	}

	async recordSessionActivity(sessionId: string): Promise<void> {
		if (!fs.existsSync(this.entriesDir)) return;
		await this.ledger.recordSession(sessionId);
	}

	async runDecay(options?: {
		force?: boolean;
		companionEntries?: readonly MemoryEntry[];
	}): Promise<{ archivedIds: string[]; sessionSeq: number }> {
		if (!fs.existsSync(this.entriesDir)) {
			return { archivedIds: [], sessionSeq: 0 };
		}
		const state = await this.ledger.read();
		if (!options?.force && state.sessionSeq <= state.lastDecaySessionSeq) {
			return { archivedIds: [], sessionSeq: state.sessionSeq };
		}

		const entries = await this.listEntries();
		const companionEntries = options?.companionEntries ?? [];
		const incomingLinkCounts = new Map<string, number>();
		for (const source of [...entries, ...companionEntries]) {
			for (const targetId of parseLinks(source.body)) {
				if (targetId === source.id) continue;
				incomingLinkCounts.set(targetId, (incomingLinkCounts.get(targetId) ?? 0) + 1);
			}
		}

		const archivedIds: string[] = [];
		const untrackedIds: string[] = [];
		for (const entry of entries) {
			const usage = state.entries[entry.id];
			if (!usage) {
				untrackedIds.push(entry.id);
				continue;
			}
			if (entry.pinned) continue;
			if ((incomingLinkCounts.get(entry.id) ?? 0) > 0) continue;

			const anchorSeq = Math.max(usage.lastHitSessionSeq, usage.createdSessionSeq);
			if (state.sessionSeq - anchorSeq < MIN_SESSIONS_BEFORE_ARCHIVE) continue;

			const score = computeDecayScore(usage, state.sessionSeq);
			if (score < ARCHIVE_SCORE_THRESHOLD) {
				await this.archiveEntry(entry.id);
				archivedIds.push(entry.id);
			}
		}

		const finalSessionSeq = await this.ledger.mutate((mutable) => {
			for (const id of untrackedIds) {
				if (!mutable.entries[id]) {
					mutable.entries[id] = {
						hitCount: 0,
						lastHitSessionSeq: mutable.sessionSeq,
						createdSessionSeq: mutable.sessionSeq,
					};
				}
			}
			mutable.lastDecaySessionSeq = Math.max(mutable.lastDecaySessionSeq, state.sessionSeq);
			return mutable.sessionSeq;
		});

		return { archivedIds, sessionSeq: finalSessionSeq };
	}

	private validateId(id: string): void {
		if (!isValidMemoryId(id)) {
			throw new Error(`Invalid memory id '${id}': use a lowercase kebab-case slug such as npm-check-skips-tests`);
		}
	}

	private entryPath(id: string): string {
		this.validateId(id);
		return path.join(this.entriesDir, `${id}.md`);
	}

	private archivePath(id: string): string {
		this.validateId(id);
		return path.join(this.archiveDir, `${id}.md`);
	}

	private async readEntriesFromDir(dir: string, archived: boolean): Promise<MemoryEntry[]> {
		if (!fs.existsSync(dir)) return [];
		const files = await fs.promises.readdir(dir);
		const entries: MemoryEntry[] = [];
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const entry = await this.readEntry(path.join(dir, file), archived);
			if (entry) entries.push(entry);
		}
		return sortEntries(entries);
	}

	private async readEntry(filePath: string, archived: boolean): Promise<MemoryEntry | null> {
		try {
			const parsed = parseEntryFile(await fs.promises.readFile(filePath, "utf8"));
			if (!parsed) return null;
			return archived ? { ...parsed, scope: this.scope, archived: true } : { ...parsed, scope: this.scope };
		} catch {
			return null;
		}
	}

	private async readExistingEntry(id: string, filePath: string, archived: boolean): Promise<MemoryEntry> {
		if (!fs.existsSync(filePath)) {
			throw new Error(`Memory entry with id '${id}' not found`);
		}
		const entry = await this.readEntry(filePath, archived);
		if (!entry) {
			throw new Error(`Memory entry with id '${id}' could not be parsed`);
		}
		return entry;
	}

	async ensureProjectMetadata(): Promise<void> {
		await fs.promises.mkdir(this.memoryDir, { recursive: true });
		const projectInfoPath = path.join(this.memoryDir, "project.json");
		if (fs.existsSync(projectInfoPath)) return;
		await withFileMutationQueue(projectInfoPath, async () => {
			if (!fs.existsSync(projectInfoPath)) {
				await this.atomicWrite(
					projectInfoPath,
					`${JSON.stringify({ root: this.projectRoot, scope: this.scope, created: new Date().toISOString() }, null, 2)}\n`,
				);
			}
		});
	}

	// Directories are created on first write so merely starting pi in a directory leaves nothing behind.
	private async ensureDirs(): Promise<void> {
		await fs.promises.mkdir(this.entriesDir, { recursive: true });
		await this.ensureProjectMetadata();
	}

	private async atomicWrite(filePath: string, content: string): Promise<void> {
		const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		try {
			await fs.promises.writeFile(tmp, content, "utf8");
			await fs.promises.rename(tmp, filePath);
		} catch (error) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw error;
		}
	}
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { SwarmBoardPost, SwarmManifest } from "./types.ts";

const MANIFEST_FILE = "manifest.json";
const BOARD_FILE = "board.jsonl";
const SESSIONS_DIR = "sessions";

export class SwarmStore {
	private readonly storageRoot: string;

	constructor(storageRoot?: string) {
		this.storageRoot = storageRoot ?? join(getAgentDir(), "swarms");
	}

	getSwarmDir(swarmId: string): string {
		return join(this.storageRoot, swarmId);
	}

	getSessionsDir(swarmDir: string): string {
		return join(swarmDir, SESSIONS_DIR);
	}

	ensureSwarmDir(swarmId: string): string {
		const dir = this.getSwarmDir(swarmId);
		mkdirSync(join(dir, SESSIONS_DIR), { recursive: true });
		return dir;
	}

	saveManifest(manifest: SwarmManifest): void {
		mkdirSync(manifest.swarmDir, { recursive: true });
		const target = join(manifest.swarmDir, MANIFEST_FILE);
		const tmp = `${target}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
		renameSync(tmp, target);
	}

	loadManifest(swarmDir: string): SwarmManifest | undefined {
		const target = join(swarmDir, MANIFEST_FILE);
		if (!existsSync(target)) return undefined;
		try {
			return JSON.parse(readFileSync(target, "utf-8")) as SwarmManifest;
		} catch {
			return undefined;
		}
	}

	appendPost(swarmDir: string, post: SwarmBoardPost): void {
		mkdirSync(swarmDir, { recursive: true });
		appendFileSync(join(swarmDir, BOARD_FILE), `${JSON.stringify(post)}\n`, "utf-8");
	}

	loadPosts(swarmDir: string): SwarmBoardPost[] {
		const target = join(swarmDir, BOARD_FILE);
		if (!existsSync(target)) return [];
		try {
			const raw = readFileSync(target, "utf-8");
			const posts: SwarmBoardPost[] = [];
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					posts.push(JSON.parse(trimmed) as SwarmBoardPost);
				} catch {
					// Ignore partial/corrupt trailing line after an abrupt crash.
				}
			}
			return posts;
		} catch {
			return [];
		}
	}
}

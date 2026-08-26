import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { SubagentProfile } from "./types.ts";

export const BUILTIN_SUBAGENT_PROFILES: Record<string, SubagentProfile> = {
	scout: {
		name: "scout",
		description: "Fast read-only recon agent for exploring code structure, finding files, and summarizing findings.",
		systemPrompt:
			"You are a code reconnaissance agent. Search and read files to answer the query directly and concisely. Do not attempt to modify files. In multi-turn sessions, leverage previous findings without repeating full scans.",
		tools: ["read", "grep", "find", "ls"],
		source: "built-in",
	},
	planner: {
		name: "planner",
		description: "Planning agent for designing architecture, migrations, and step-by-step implementation plans.",
		systemPrompt:
			"You are a software architect and planning agent. Analyze code structure and produce clear, actionable, step-by-step implementation plans without mutating files. In multi-turn sessions, build incrementally on previous plans.",
		tools: ["read", "grep", "find", "ls"],
		source: "built-in",
	},
	reviewer: {
		name: "reviewer",
		description: "Code review agent for analyzing diffs, edge cases, and code quality.",
		systemPrompt:
			"You are a senior code reviewer. Inspect files and diffs for bugs, performance issues, security flaws, and style consistency. Point out concrete line references. In multi-turn sessions, focus on newly changed lines or requested review areas.",
		tools: ["read", "grep"],
		source: "built-in",
	},
	worker: {
		name: "worker",
		description: "General-purpose agent with full capabilities to inspect, edit, and run commands.",
		systemPrompt:
			"You are an autonomous coding worker. Complete the assigned subtask concisely and verify your changes. In multi-turn sessions, continue from previous state without re-executing completed work.",
		tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
		source: "built-in",
	},
};

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinkingLevel?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function loadCustomProfilesFromDir(dir: string, source: "user" | "project"): SubagentProfile[] {
	const profiles: SubagentProfile[] = [];
	if (!fs.existsSync(dir)) {
		return profiles;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return profiles;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		const defaultName = path.basename(entry.name, ".md");
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : defaultName;
		const description =
			typeof frontmatter.description === "string" ? frontmatter.description.trim() : `Custom subagent (${name})`;

		profiles.push({
			name,
			description,
			systemPrompt: body || description,
			tools: parseToolList(frontmatter.tools) ?? ["read", "grep", "find", "ls"],
			modelId: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinkingLevel:
				typeof frontmatter.thinkingLevel === "string" ? (frontmatter.thinkingLevel as ThinkingLevel) : undefined,
			source,
		});
	}

	return profiles;
}

export function resolveSubagentProfiles(cwd: string, agentDir?: string): Record<string, SubagentProfile> {
	const result: Record<string, SubagentProfile> = { ...BUILTIN_SUBAGENT_PROFILES };

	// 1. User-level agents: ~/.pi/agent/agents/*.md
	const effectiveAgentDir = agentDir ?? getAgentDir();
	const userAgentsDir = path.join(effectiveAgentDir, "agents");
	for (const profile of loadCustomProfilesFromDir(userAgentsDir, "user")) {
		result[profile.name] = profile;
	}

	// 2. Project-level agents: <cwd>/.pi/agents/*.md
	const projectAgentsDir = path.join(cwd, CONFIG_DIR_NAME, "agents");
	for (const profile of loadCustomProfilesFromDir(projectAgentsDir, "project")) {
		result[profile.name] = profile;
	}

	return result;
}

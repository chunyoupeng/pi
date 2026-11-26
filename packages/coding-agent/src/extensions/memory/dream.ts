import { type MemoryStore, parseLinks } from "./store.ts";
import { GLOBAL_CHAR_BUDGET, type MemoryEntry, PROJECT_CHAR_BUDGET } from "./types.ts";

export const DEFAULT_DREAM_IDLE_MS = 3 * 60 * 60 * 1000; // 3 hours
export const DEFAULT_DREAM_JITTER_MS = 5 * 60 * 1000; // 0..5 min jitter
export const MEMORY_DREAM_CUSTOM_TYPE = "memory-dream";

export type DreamTriggerKind = "manual" | "idle";

export interface MemoryDreamMessageDetails {
	trigger: DreamTriggerKind;
	projectRoot: string;
	decayedCount: number;
	brokenLinkCount: number;
}

export interface DreamDiagnostics {
	projectActiveCount: number;
	projectArchivedCount: number;
	globalActiveCount: number;
	globalArchivedCount: number;
	brokenLinks: Array<{ scope: "project" | "global"; entryId: string; targetId: string }>;
}

function collectBrokenLinks(
	scope: "project" | "global",
	entries: readonly MemoryEntry[],
	allActiveIds: ReadonlySet<string>,
): Array<{ scope: "project" | "global"; entryId: string; targetId: string }> {
	const broken: Array<{ scope: "project" | "global"; entryId: string; targetId: string }> = [];
	for (const entry of entries) {
		for (const targetId of parseLinks(entry.body)) {
			if (targetId === entry.id) continue;
			if (!allActiveIds.has(targetId)) {
				broken.push({ scope, entryId: entry.id, targetId });
			}
		}
	}
	return broken;
}

/** Collect lightweight active/archived counts and dangling `[[id]]` links across both scopes. */
export async function collectDreamDiagnostics(
	projectStore: MemoryStore,
	globalStore: MemoryStore,
): Promise<DreamDiagnostics> {
	const [projectActive, projectArchived, globalActive, globalArchived] = await Promise.all([
		projectStore.listEntries(),
		projectStore.listArchivedEntries(),
		globalStore.listEntries(),
		globalStore.listArchivedEntries(),
	]);

	const allActiveIds = new Set<string>([...projectActive.map((e) => e.id), ...globalActive.map((e) => e.id)]);
	return {
		projectActiveCount: projectActive.length,
		projectArchivedCount: projectArchived.length,
		globalActiveCount: globalActive.length,
		globalArchivedCount: globalArchived.length,
		brokenLinks: [
			...collectBrokenLinks("global", globalActive, allActiveIds),
			...collectBrokenLinks("project", projectActive, allActiveIds),
		],
	};
}

/** Build the in-session consolidation prompt instructing the agent to update memory via the `memory` tool. */
export function buildDreamPrompt(input: {
	projectRoot: string;
	trigger: DreamTriggerKind;
	diagnostics: DreamDiagnostics;
	decayedProjectIds: readonly string[];
	decayedGlobalIds: readonly string[];
}): string {
	const { projectRoot, trigger, diagnostics, decayedProjectIds, decayedGlobalIds } = input;
	const triggerLabel = trigger === "idle" ? "Idle memory consolidation" : "Manual memory consolidation";

	const statusLines: string[] = [
		`- Project (${projectRoot}): ${diagnostics.projectActiveCount} active, ${diagnostics.projectArchivedCount} archived (budget ${PROJECT_CHAR_BUDGET} chars)`,
		`- Global: ${diagnostics.globalActiveCount} active, ${diagnostics.globalArchivedCount} archived (budget ${GLOBAL_CHAR_BUDGET} chars)`,
	];
	if (decayedProjectIds.length > 0) {
		statusLines.push(`- Auto-archived by decay (project): ${decayedProjectIds.join(", ")}`);
	}
	if (decayedGlobalIds.length > 0) {
		statusLines.push(`- Auto-archived by decay (global): ${decayedGlobalIds.join(", ")}`);
	}
	if (diagnostics.brokenLinks.length > 0) {
		const formatted = diagnostics.brokenLinks
			.map((item) => `[${item.scope}:${item.entryId}] -> [[${item.targetId}]]`)
			.join(", ");
		statusLines.push(`- Broken [[id]] links: ${formatted}`);
	}

	return [
		`[${triggerLabel} (dream)]`,
		"Review what happened in this session and consolidate durable knowledge using the `memory` tool (`list`, `get`, `add`, `update`, `delete`).",
		"1. Record verified commands, root-cause gotchas, architectural decisions, and user preferences or corrections that future sessions will need.",
		"2. Check existing notes against what you actually observed: update stale or contradicted entries (reusing existing IDs instead of duplicating), repair broken `[[id]]` links, and delete entries proven false.",
		`3. Scope discipline: use \`scope="project"\` for repo-specific knowledge; use \`scope="global"\` ONLY for durable cross-project preferences and invariants. Keep notes lean (project <= ${PROJECT_CHAR_BUDGET} chars, global <= ${GLOBAL_CHAR_BUDGET} chars), reserve \`pinned=true\` for high-impact redlines, and never store secrets or transient task chatter.`,
		"4. If nothing durable needs to be added or changed, briefly say so without making edits. Otherwise, finish with a short summary of the changes applied.",
		"",
		"Current memory snapshot:",
		...statusLines,
	].join("\n");
}

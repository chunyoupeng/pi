import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { findGitPaths } from "../../core/footer-data-provider.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { Settings, WorkspaceSwitchPolicy } from "../../core/settings-manager.ts";
import { canonicalizePath, isPathWithin, resolvePath } from "../../utils/paths.ts";

export type SwitchDecision = { kind: "allow" } | { kind: "confirm"; reason: string } | { kind: "deny"; reason: string };

export interface EvaluateSwitchOptions {
	policy: WorkspaceSwitchPolicy;
	targetCwd: string;
	initialCwd: string;
	allowedWorkspaces: readonly string[];
}

export function getWorkspaceSwitchPolicy(settings: Settings): WorkspaceSwitchPolicy {
	const value = settings.workspaceSwitchPolicy;
	return value === "off" || value === "workspace" || value === "ask" || value === "allow"
		? value
		: SETTINGS_DEFAULTS.workspaceSwitchPolicy;
}

export function getAllowedWorkspaces(settings: Settings): string[] {
	return settings.allowedWorkspaces ? [...settings.allowedWorkspaces] : [];
}

/**
 * Resolve a user- or model-supplied directory path against `currentCwd` and verify it exists and is a directory.
 */
export function resolveWorkspaceTarget(inputPath: string, currentCwd: string): string {
	const trimmed = inputPath.trim();
	if (!trimmed) {
		throw new Error("Target directory path must not be empty.");
	}
	const resolved = resolvePath(trimmed, currentCwd);
	if (!existsSync(resolved)) {
		throw new Error(`Directory does not exist: ${resolved}`);
	}
	if (!statSync(resolved).isDirectory()) {
		throw new Error(`Path is not a directory: ${resolved}`);
	}
	return resolved;
}

/**
 * Decide whether an agent-initiated switch to `targetCwd` is allowed, requires confirmation, or is denied.
 * Uses canonicalized paths so symlink escapes cannot bypass workspace containment.
 */
export function evaluateSwitchDecision(options: EvaluateSwitchOptions): SwitchDecision {
	switch (options.policy) {
		case "off":
			return {
				kind: "deny",
				reason:
					'Agent workspace switching is disabled (workspaceSwitchPolicy: "off"). Ask the user to run /cd <path> instead.',
			};
		case "allow":
			return { kind: "allow" };
		case "ask":
			return {
				kind: "confirm",
				reason: 'Workspace switch requires user confirmation (workspaceSwitchPolicy: "ask").',
			};
		case "workspace": {
			const canonicalTarget = canonicalizePath(resolvePath(options.targetCwd));
			const roots = [options.initialCwd, ...options.allowedWorkspaces]
				.map((root) => root.trim())
				.filter(Boolean)
				.map((root) => canonicalizePath(resolvePath(root)));
			if (roots.some((root) => isPathWithin(root, canonicalTarget))) {
				return { kind: "allow" };
			}
			return {
				kind: "confirm",
				reason: "Target directory is outside the initial workspace.",
			};
		}
	}
}

/** Lightweight git branch lookup without spawning a subprocess. */
export function detectGitBranch(cwd: string): string | null {
	try {
		const gitPaths = findGitPaths(cwd);
		if (!gitPaths) return null;
		const content = readFileSync(gitPaths.headPath, "utf8").trim();
		if (content.startsWith("ref: refs/heads/")) {
			const branch = content.slice(16);
			return branch === ".invalid" ? "detached" : branch;
		}
		return "detached";
	} catch {
		return null;
	}
}

/** List matching subdirectory completions for `/cd <prefix>`. */
export function completeDirectoryPrefix(prefix: string, currentCwd: string): Array<{ value: string; label: string }> {
	const trimmed = prefix.trimStart();
	const endsWithSep = trimmed.endsWith("/") || trimmed.endsWith(sep);
	const baseInput = endsWithSep ? trimmed : trimmed.includes("/") || trimmed.includes(sep) ? dirname(trimmed) : ".";
	const partialName = endsWithSep ? "" : (trimmed.split(/[\\/]/).pop() ?? "");
	const resolvedBase = resolvePath(baseInput, currentCwd);

	if (!existsSync(resolvedBase)) return [];
	try {
		if (!statSync(resolvedBase).isDirectory()) return [];
		const entries = readdirSync(resolvedBase, { withFileTypes: true });
		const lowerPartial = partialName.toLowerCase();
		const displayPrefix = endsWithSep
			? trimmed
			: baseInput === "." && !trimmed.startsWith(".")
				? ""
				: `${baseInput}/`;
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(lowerPartial))
			.filter((entry) => partialName.startsWith(".") || !entry.name.startsWith("."))
			.slice(0, 20)
			.map((entry) => {
				const value = `${displayPrefix}${entry.name}`;
				return { value, label: `${entry.name}/` };
			});
	} catch {
		return [];
	}
}

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SwarmWorkspaceMode } from "./types.ts";

const execFileAsync = promisify(execFile);
const COMMON_UNTRACKED_DEP_DIRS = [".venv", "venv", "node_modules"] as const;

export interface ProvisionWorkspaceInput {
	mode: SwarmWorkspaceMode;
	baseCwd: string;
	swarmDir: string;
	swarmId: string;
	memberName: string;
	symlinkPaths?: readonly string[];
}

export interface ProvisionedWorkspace {
	cwd: string;
	workspacePath?: string;
	repoRoot?: string;
	gitBranch?: string;
	symlinked?: string[];
	warnings?: string[];
}

export interface WorkspaceCheckInput {
	mode: SwarmWorkspaceMode;
	workspacePath?: string;
	repoRoot?: string;
	gitBranch?: string;
	symlinkPaths?: readonly string[];
}

export interface SwarmWorkspaceOps {
	resolveGitRoot(cwd: string): Promise<string | undefined>;
	provision(input: ProvisionWorkspaceInput): Promise<ProvisionedWorkspace>;
	checkUnlandedWork(input: WorkspaceCheckInput): Promise<string | undefined>;
	cleanup(input: WorkspaceCheckInput): Promise<void>;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 10 * 1024 * 1024,
	});
	return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitTry(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await runGit(cwd, args);
		return stdout;
	} catch {
		return undefined;
	}
}

function buildBranchName(swarmId: string, memberName: string): string {
	const safeId = swarmId.replace(/[^a-zA-Z0-9_-]/g, "-");
	const safeName = memberName.replace(/[^a-zA-Z0-9_-]/g, "-");
	return `swarm/${safeId}/${safeName}`;
}

function normalizeRelativeSubpath(raw: string): string {
	const cleaned = raw.trim().replace(/^\/+|\/+$/g, "");
	if (!cleaned || isAbsolute(raw)) {
		throw new Error(`symlinkPaths entry '${raw}' must be a relative path inside the repository`);
	}
	const parts = cleaned.split(/[\\/]+/);
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		throw new Error(`symlinkPaths entry '${raw}' must not contain '.' or '..' segments`);
	}
	return parts.join(sep);
}

function isInsideDir(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function applyWorkspaceSymlinks(
	repoRoot: string,
	workspaceRoot: string,
	symlinkPaths: readonly string[] | undefined,
): { symlinked: string[]; warnings: string[] } {
	const symlinked: string[] = [];
	const warnings: string[] = [];
	const linkedSet = new Set<string>();

	if (symlinkPaths && symlinkPaths.length > 0) {
		for (const raw of symlinkPaths) {
			const rel = normalizeRelativeSubpath(raw);
			const sourcePath = resolve(repoRoot, rel);
			const targetPath = resolve(workspaceRoot, rel);
			if (!isInsideDir(repoRoot, sourcePath) || !isInsideDir(workspaceRoot, targetPath)) {
				throw new Error(`symlinkPaths entry '${raw}' escapes the repository root`);
			}
			if (!existsSync(sourcePath)) {
				warnings.push(`symlinkPaths entry '${rel}' does not exist in host repo (${repoRoot})`);
				continue;
			}
			if (existsSync(targetPath)) {
				warnings.push(`symlinkPaths entry '${rel}' already exists in workspace; skipped symlink`);
				continue;
			}
			mkdirSync(dirname(targetPath), { recursive: true });
			const isDir = statSync(sourcePath).isDirectory();
			symlinkSync(sourcePath, targetPath, isDir ? "dir" : "file");
			symlinked.push(rel);
			linkedSet.add(rel);
		}
	}

	for (const depDir of COMMON_UNTRACKED_DEP_DIRS) {
		if (linkedSet.has(depDir)) continue;
		const hostPath = join(repoRoot, depDir);
		const worktreePath = join(workspaceRoot, depDir);
		if (existsSync(hostPath) && !existsSync(worktreePath)) {
			warnings.push(
				`Host repo has '${depDir}' which is absent in isolated worktree; pass symlinkPaths: ["${depDir}"] if workers need it`,
			);
		}
	}

	return { symlinked, warnings };
}

function removeManagedSymlinks(workspaceRoot: string, symlinkPaths: readonly string[] | undefined): void {
	if (!symlinkPaths || symlinkPaths.length === 0) return;
	for (const raw of symlinkPaths) {
		try {
			const rel = normalizeRelativeSubpath(raw);
			const targetPath = resolve(workspaceRoot, rel);
			if (!isInsideDir(workspaceRoot, targetPath)) continue;
			if (lstatSync(targetPath).isSymbolicLink()) {
				unlinkSync(targetPath);
			}
		} catch {
			// Best-effort cleanup; ignore missing or non-symlink paths.
		}
	}
}

export const defaultSwarmWorkspaceOps: SwarmWorkspaceOps = {
	async resolveGitRoot(cwd: string): Promise<string | undefined> {
		const root = await gitTry(cwd, ["rev-parse", "--show-toplevel"]);
		return root ? resolve(root) : undefined;
	},

	async provision(input: ProvisionWorkspaceInput): Promise<ProvisionedWorkspace> {
		const resolvedBase = resolve(input.baseCwd);
		if (input.mode === "inherit") {
			return { cwd: resolvedBase };
		}

		const repoRoot = await this.resolveGitRoot(resolvedBase);
		if (!repoRoot) {
			throw new Error(
				`Workspace mode '${input.mode}' requires a git repository, but '${resolvedBase}' is not inside one. Use workspace='inherit' instead.`,
			);
		}

		const relSubdir = relative(repoRoot, resolvedBase);
		const gitBranch = buildBranchName(input.swarmId, input.memberName);

		if (input.mode === "share") {
			const worktreesParent = join(input.swarmDir, "worktrees");
			mkdirSync(worktreesParent, { recursive: true });
			const worktreePath = join(worktreesParent, input.memberName);
			if (existsSync(worktreePath)) {
				rmSync(worktreePath, { recursive: true, force: true });
			}
			// Drop any stale branch with the same name from a previous failed attempt.
			await gitTry(repoRoot, ["branch", "-D", gitBranch]);
			await runGit(repoRoot, ["worktree", "add", "-b", gitBranch, worktreePath, "HEAD"]);
			const { symlinked, warnings } = applyWorkspaceSymlinks(repoRoot, worktreePath, input.symlinkPaths);
			const subPath = relSubdir && !relSubdir.startsWith("..") ? join(worktreePath, relSubdir) : worktreePath;
			const cwd = existsSync(subPath) ? subPath : worktreePath;
			return {
				cwd,
				workspacePath: worktreePath,
				repoRoot,
				gitBranch,
				symlinked: symlinked.length > 0 ? symlinked : undefined,
				warnings: warnings.length > 0 ? warnings : undefined,
			};
		}

		// mode === "branch": isolated local git clone
		const clonesParent = join(input.swarmDir, "clones");
		mkdirSync(clonesParent, { recursive: true });
		const clonePath = join(clonesParent, input.memberName);
		if (existsSync(clonePath)) {
			rmSync(clonePath, { recursive: true, force: true });
		}
		await runGit(repoRoot, ["clone", "--local", "--no-hardlinks", repoRoot, clonePath]);
		await runGit(clonePath, ["checkout", "-b", gitBranch]);
		const { symlinked, warnings } = applyWorkspaceSymlinks(repoRoot, clonePath, input.symlinkPaths);
		const subPath = relSubdir && !relSubdir.startsWith("..") ? join(clonePath, relSubdir) : clonePath;
		const cwd = existsSync(subPath) ? subPath : clonePath;
		return {
			cwd,
			workspacePath: clonePath,
			repoRoot,
			gitBranch,
			symlinked: symlinked.length > 0 ? symlinked : undefined,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	},

	async checkUnlandedWork(input: WorkspaceCheckInput): Promise<string | undefined> {
		if (input.mode === "inherit" || !input.workspacePath || !existsSync(input.workspacePath)) {
			return undefined;
		}

		const issues: string[] = [];
		const statusOut = await gitTry(input.workspacePath, ["status", "--porcelain"]);
		if (statusOut) {
			const ignoredLinks = new Set(
				(input.symlinkPaths ?? []).map((p) =>
					p
						.trim()
						.replace(/^\/+|\/+$/g, "")
						.replace(/\\/g, "/"),
				),
			);
			const dirtyLines = statusOut
				.split("\n")
				.filter(Boolean)
				.filter((line) => {
					const pathPart = line.slice(3).trim().replace(/\/+$/, "");
					return !ignoredLinks.has(pathPart);
				});
			const dirtyCount = dirtyLines.length;
			if (dirtyCount > 0) {
				issues.push(`${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"}`);
			}
		}

		if (input.mode === "share" && input.repoRoot && input.gitBranch) {
			const unmerged = await gitTry(input.repoRoot, ["rev-list", "--count", input.gitBranch, "--not", "HEAD"]);
			const commitCount = unmerged ? Number.parseInt(unmerged, 10) : 0;
			if (Number.isFinite(commitCount) && commitCount > 0) {
				issues.push(`${commitCount} unmerged commit${commitCount === 1 ? "" : "s"} on branch ${input.gitBranch}`);
			}
		} else if (input.mode === "branch") {
			const unmerged = await gitTry(input.workspacePath, ["rev-list", "--count", "HEAD", "--not", "origin/HEAD"]);
			const commitCount = unmerged ? Number.parseInt(unmerged, 10) : 0;
			if (Number.isFinite(commitCount) && commitCount > 0) {
				issues.push(`${commitCount} unmerged commit${commitCount === 1 ? "" : "s"} in isolated clone`);
			}
		}

		if (issues.length === 0) return undefined;
		return `Worker workspace (${input.workspacePath}) has unlanded work: ${issues.join(" and ")}. Land/merge its changes first, or pass force=true to discard them.`;
	},

	async cleanup(input: WorkspaceCheckInput): Promise<void> {
		if (input.mode === "inherit" || !input.workspacePath) return;

		if (existsSync(input.workspacePath)) {
			removeManagedSymlinks(input.workspacePath, input.symlinkPaths);
		}

		if (input.mode === "share") {
			if (input.repoRoot && existsSync(input.repoRoot)) {
				const removed = await gitTry(input.repoRoot, ["worktree", "remove", "--force", input.workspacePath]);
				if (removed === undefined) {
					if (existsSync(input.workspacePath)) {
						rmSync(input.workspacePath, { recursive: true, force: true });
					}
					await gitTry(input.repoRoot, ["worktree", "prune"]);
				}
				if (input.gitBranch) {
					await gitTry(input.repoRoot, ["branch", "-D", input.gitBranch]);
				}
			} else if (existsSync(input.workspacePath)) {
				rmSync(input.workspacePath, { recursive: true, force: true });
			}
			return;
		}

		if (existsSync(input.workspacePath)) {
			rmSync(input.workspacePath, { recursive: true, force: true });
		}
	},
};

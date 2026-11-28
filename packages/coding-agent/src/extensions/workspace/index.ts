import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionFactory } from "../../core/extensions/types.ts";
import { pathsEqual, shortenHomePath } from "../../utils/paths.ts";
import {
	completeDirectoryPrefix,
	detectGitBranch,
	evaluateSwitchDecision,
	getAllowedWorkspaces,
	getWorkspaceSwitchPolicy,
	resolveWorkspaceTarget,
} from "./policy.ts";
import { renderSwitchCall, renderSwitchResult, type WorkspaceToolDetails } from "./render.ts";

const SwitchWorkspaceParams = Type.Object({
	path: Type.String({
		description:
			"Target directory path to switch to (absolute, ~/..., or relative to the current working directory).",
	}),
	reason: Type.Optional(
		Type.String({
			description: "Brief explanation of why switching to this folder or project is helpful.",
		}),
	),
});

function formatSwitchToolText(details: WorkspaceToolDetails): string {
	const lines: string[] = [];
	if (details.changed) {
		lines.push(`Switched working directory: ${details.previousCwd} -> ${details.cwd}`);
	} else {
		lines.push(`Already in working directory: ${details.cwd}`);
	}
	if (details.gitBranch) {
		lines.push(`Git branch: ${details.gitBranch}`);
	}
	if (details.contextFiles.length > 0) {
		lines.push(`Loaded project instructions: ${details.contextFiles.join(", ")}`);
	}
	if (details.hasTrustRequiringResources) {
		if (details.projectTrusted) {
			lines.push(
				"Note: Target directory contains project .pi/ resources. Declarative context (AGENTS.md, skills, prompts) has been reloaded; run /reload if project extensions or MCP servers are also needed.",
			);
		} else {
			lines.push(
				"Note: Target directory contains untrusted project .pi/ resources (extensions/MCP/settings), which were not loaded. File and shell tools work normally.",
			);
		}
	}
	return lines.join("\n");
}

export function createWorkspaceExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let initialCwd = "";
		let currentCwd = "";
		let previousCwd: string | undefined;

		pi.on("session_start", async (_event, ctx) => {
			initialCwd = ctx.cwd;
			currentCwd = ctx.cwd;
			previousCwd = undefined;
		});

		pi.on("cwd_changed", async (event) => {
			currentCwd = event.cwd;
			if (!pathsEqual(event.previousCwd, event.cwd)) {
				previousCwd = event.previousCwd;
			}
		});

		pi.registerTool(
			defineTool<typeof SwitchWorkspaceParams, WorkspaceToolDetails>({
				name: "switch_workspace",
				label: "Switch Workspace",
				description:
					"Switch the active working directory to another folder, project, or workspace. Updates all file and shell tools, reloads project instructions (AGENTS.md/CLAUDE.md), project skills, and project memory for the new directory, and persists the change in the session.",
				promptSnippet: "Switch the active working directory to another folder, project, or workspace",
				promptGuidelines: [
					"Use switch_workspace when operating inside a different folder or project is more convenient (for example, when started in a parent workspace directory or the wrong project folder).",
				],
				executionMode: "sequential",
				parameters: SwitchWorkspaceParams,
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					const targetCwd = resolveWorkspaceTarget(params.path, ctx.cwd);
					const baseInitialCwd = initialCwd || ctx.cwd;

					if (pathsEqual(targetCwd, ctx.cwd)) {
						const details: WorkspaceToolDetails = {
							previousCwd: ctx.cwd,
							cwd: ctx.cwd,
							changed: false,
							gitBranch: detectGitBranch(ctx.cwd),
							contextFiles: [],
							hasTrustRequiringResources: false,
							projectTrusted: ctx.isProjectTrusted(),
							reason: params.reason,
						};
						return {
							content: [{ type: "text", text: formatSwitchToolText(details) }],
							details,
						};
					}

					const settings = pi.getSettings();
					const decision = evaluateSwitchDecision({
						policy: getWorkspaceSwitchPolicy(settings),
						targetCwd,
						initialCwd: baseInitialCwd,
						allowedWorkspaces: getAllowedWorkspaces(settings),
					});

					if (decision.kind === "deny") {
						throw new Error(decision.reason);
					}

					if (decision.kind === "confirm") {
						if (!ctx.hasUI) {
							throw new Error(
								`Cannot switch workspace to ${targetCwd} in non-interactive mode: ${decision.reason} Configure workspaceSwitchPolicy: "allow" or add the root to allowedWorkspaces to allow this switch.`,
							);
						}
						const reasonLine = params.reason ? `\nReason: ${params.reason}` : "";
						const confirmed = await ctx.ui.confirm(
							"Switch workspace?",
							`${shortenHomePath(ctx.cwd)} -> ${shortenHomePath(targetCwd)}\n${decision.reason}${reasonLine}`,
							{ signal },
						);
						if (!confirmed) {
							throw new Error(`User declined switching workspace to ${targetCwd}.`);
						}
					}

					const result = await pi.setCwd(targetCwd);
					const details: WorkspaceToolDetails = {
						previousCwd: result.previousCwd,
						cwd: result.cwd,
						changed: result.changed,
						gitBranch: detectGitBranch(result.cwd),
						contextFiles: result.contextFiles,
						hasTrustRequiringResources: result.hasTrustRequiringResources,
						projectTrusted: result.projectTrusted,
						reason: params.reason,
					};

					return {
						content: [{ type: "text", text: formatSwitchToolText(details) }],
						details,
					};
				},
				renderCall: (args, theme) => renderSwitchCall(args, theme),
				renderResult: (result, options, theme) => renderSwitchResult(result, options, theme),
			}),
		);

		pi.registerCommand("cd", {
			description: "Switch the active working directory (/cd <path>, /cd -, or /cd to show current)",
			getArgumentCompletions: (prefix) => {
				const baseCwd = currentCwd || initialCwd || process.cwd();
				return completeDirectoryPrefix(prefix, baseCwd);
			},
			handler: async (args, ctx) => {
				const raw = args.trim();
				if (!raw) {
					const current = shortenHomePath(ctx.cwd);
					const initialSuffix =
						initialCwd && !pathsEqual(initialCwd, ctx.cwd) ? ` (initial: ${shortenHomePath(initialCwd)})` : "";
					ctx.ui.notify(`Current workspace: ${current}${initialSuffix}`, "info");
					return;
				}

				const targetInput = raw === "-" ? previousCwd : raw;
				if (!targetInput) {
					ctx.ui.notify("No previous working directory.", "warning");
					return;
				}

				try {
					const targetCwd = resolveWorkspaceTarget(targetInput, ctx.cwd);
					const result = await pi.setCwd(targetCwd);
					const shortNext = shortenHomePath(result.cwd);
					const branch = detectGitBranch(result.cwd);
					const suffix = branch ? ` (${branch})` : "";
					if (result.changed) {
						ctx.ui.notify(`Switched workspace to ${shortNext}${suffix}`, "info");
					} else {
						ctx.ui.notify(`Already in ${shortNext}${suffix}`, "info");
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}

const workspaceExtension: ExtensionFactory = createWorkspaceExtension();

export default workspaceExtension;

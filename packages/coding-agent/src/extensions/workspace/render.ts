import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { shortenHomePath } from "../../utils/paths.ts";

export interface WorkspaceToolDetails {
	previousCwd: string;
	cwd: string;
	changed: boolean;
	gitBranch: string | null;
	contextFiles: string[];
	hasTrustRequiringResources: boolean;
	projectTrusted: boolean;
	reason?: string;
}

export function renderSwitchCall(args: { path?: string; reason?: string } | undefined, theme: Theme): Text {
	const target = args?.path ? shortenHomePath(args.path) : ".";
	let line = `${theme.style("switch_workspace", { fg: "toolTitle", bold: true })} ${theme.fg("accent", target)}`;
	if (args?.reason) {
		line += ` ${theme.fg("dim", `(${args.reason})`)}`;
	}
	return new Text(line, 0, 0);
}

export function renderSwitchResult(
	result: AgentToolResult<WorkspaceToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (!details) {
		const first = result.content[0];
		const text = first?.type === "text" ? first.text : "";
		return new Text(theme.fg("dim", text), 0, 0);
	}

	const nextShort = shortenHomePath(details.cwd);
	const branchSuffix = details.gitBranch ? ` ${theme.fg("muted", `(${details.gitBranch})`)}` : "";
	const header = details.changed
		? `${theme.fg("success", "✓")} ${theme.fg("text", nextShort)}${branchSuffix}`
		: `${theme.fg("dim", "·")} ${theme.fg("muted", `already in ${nextShort}`)}${branchSuffix}`;

	const lines = [header];
	if (options.expanded) {
		if (details.changed) {
			lines.push(theme.fg("dim", `  from: ${shortenHomePath(details.previousCwd)}`));
		}
		if (details.contextFiles.length > 0) {
			const files = details.contextFiles.map((file) => shortenHomePath(file)).join(", ");
			lines.push(theme.fg("dim", `  context: ${files}`));
		}
		if (details.hasTrustRequiringResources && !details.projectTrusted) {
			lines.push(
				theme.fg(
					"warning",
					"  project .pi/ extensions/MCP/settings were not loaded (untrusted project); run /reload after trusting if needed",
				),
			);
		}
	}
	return new Text(lines.join("\n"), 0, 0);
}

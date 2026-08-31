import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface StartupPanelOptions {
	appName: string;
	version: string;
	getModel: () => string;
	getProject: () => string;
	getSession: () => string;
	getBranch: () => string | null;
	getResourceSummary: () => string;
	getResourceDetails: (width: number) => string[];
	getCompactHints: () => string;
	getExpandedHints: () => string[];
	getOnboarding: () => string;
}

const WIDE_PANEL_MIN_WIDTH = 64;
const PANEL_MAX_WIDTH = 64;
const LOGO = ["██████╗ ██╗", "██╔══██╗██║", "██████╔╝██║", "██╔═══╝ ██║", "██║     ██║", "╚═╝     ╚═╝"];

/** Responsive welcome card shown above the interactive transcript. */
export class StartupPanel implements Component {
	private readonly options: StartupPanelOptions;
	private expanded: boolean;
	constructor(options: StartupPanelOptions, expanded = false) {
		this.options = options;
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
	}

	invalidate(): void {
		// The panel reads all display values during render.
	}

	render(width: number): string[] {
		return width < WIDE_PANEL_MIN_WIDTH ? this.renderCompact(width) : this.renderWide(width);
	}

	private renderCompact(width: number): string[] {
		const model = this.options.getModel();
		const project = this.options.getProject();
		const text = `${theme.bold(theme.fg("accent", "PI"))} ${theme.fg("dim", `v${this.options.version}`)} ${theme.fg("muted", "·")} ${theme.fg("text", model)} ${theme.fg("muted", "·")} ${theme.fg("dim", project)}`;
		return [truncateToWidth(text, width, "")];
	}

	private renderWide(width: number): string[] {
		const panelWidth = Math.min(PANEL_MAX_WIDTH, width);
		const innerWidth = panelWidth - 4;
		const branch = this.options.getBranch();
		const session = this.options.getSession();
		const rows = [
			this.infoRow("Model", this.options.getModel(), innerWidth),
			this.infoRow("Project", this.options.getProject(), innerWidth),
			this.infoRow("Session", session, innerWidth),
			...(branch ? [this.infoRow("Branch", branch, innerWidth)] : []),
		];
		const hints = this.expanded ? this.options.getExpandedHints() : [this.options.getCompactHints()];
		const resourceDetails = this.expanded ? this.options.getResourceDetails(innerWidth) : [];
		const content = [
			"",
			...LOGO.map((line) => this.center(theme.bold(theme.fg("accent", line)), innerWidth)),
			this.center(theme.fg("dim", `v${this.options.version}`), innerWidth),
			"",
			this.center(theme.fg("muted", "A minimal coding agent for your terminal"), innerWidth),
			"",
			...rows,
			"",
			this.center(theme.fg("muted", this.options.getResourceSummary()), innerWidth),
			...(resourceDetails.length > 0
				? ["", ...resourceDetails.map((line) => truncateToWidth(line, innerWidth, ""))]
				: []),
			"",
			...hints.map((hint) => truncateToWidth(hint, innerWidth, "")),
			"",
			this.center(this.options.getOnboarding(), innerWidth),
		];

		const title = ` ${this.options.appName} `;
		const topFill = Math.max(0, panelWidth - visibleWidth(title) - 3);
		const top = theme.fg("borderAccent", `╭─${title}${"─".repeat(topFill)}╮`);
		const bottom = theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, panelWidth - 2))}╯`);
		const rendered = [top, ...content.map((line) => this.frameLine(line, innerWidth)), bottom];
		return rendered.map((line) => this.center(line, width));
	}

	private infoRow(label: string, value: string, width: number): string {
		const labelText = theme.fg("dim", `${label.padEnd(8)} `);
		const available = Math.max(1, width - visibleWidth(labelText));
		return labelText + theme.fg("text", truncateToWidth(value, available, ""));
	}

	private frameLine(content: string, innerWidth: number): string {
		const safeContent = truncateToWidth(content, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(safeContent)));
		return `${theme.fg("borderAccent", "│")} ${safeContent}${padding} ${theme.fg("borderAccent", "│")}`;
	}

	private center(text: string, width: number): string {
		const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
		return " ".repeat(left) + text;
	}
}

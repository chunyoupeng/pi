/**
 * Fullscreen interactive Swarm Board overlay (`Alt+S` or `/swarm board`).
 *
 * Displays:
 * - Header bar with swarm title, active/waiting/stopped counts, task pool progress, post count, and cost
 * - Members roster with live state badges, stop reasons, turn counts, current task/tool activity (clickable)
 * - Right pane with clickable [Board] / [Inspector] tabs, Markdown-rendered collapsible posts, and scroll indicator
 * - Native mouse wheel & click handling (no wheel leak-through to background transcript; drag-select preserved)
 * - Bottom multiline editor to post directly onto the board as `user` (with @mention steering)
 * - Configurable keybindings via KeybindingsManager (no hardcoded key checks)
 */

import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type Focusable,
	type Keybinding,
	type KeybindingsManager,
	Markdown,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatKeyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getEditorTheme, getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { SwarmManager } from "./manager.ts";
import { memberStateColor, memberStateMarker } from "./render.ts";
import {
	COORDINATOR_NAME,
	DEFAULT_MAX_TURNS_PER_WAKEUP,
	formatCost,
	formatPostTimestamp,
	formatTokenCount,
	type SwarmBoardPost,
	type SwarmMemberSnapshot,
	type SwarmSnapshot,
	type SwarmTaskPool,
	USER_AUTHOR,
} from "./types.ts";

export interface SwarmBoardViewOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	manager: SwarmManager;
	onDone: () => void;
}

type FocusPane = "input" | "members" | "feed";
type RightMode = "board" | "inspector";

interface MemberRowHit {
	startRow: number;
	endRow: number;
	memberIdx: number;
}

interface PostRowHit {
	startLine: number;
	endLine: number;
	postSeq: number;
	collapsible: boolean;
}

interface SpanHit {
	x1: number;
	x2: number;
	row: number;
}

interface RenderedLayoutMetrics {
	splitLayout: boolean;
	width: number;
	leftWidth: number;
	rightStartX: number;
	bodyStartRow: number;
	bodyHeight: number;
	rightBodyStartRow: number;
	rightScrollHeight: number;
	maxScroll: number;
	editorStartRow: number;
	editorHeight: number;
	memberHits: MemberRowHit[];
	postHits: PostRowHit[];
	boardTabHit?: SpanHit;
	inspectorTabHit?: SpanHit;
	expandAllHit?: SpanHit;
	followHit?: SpanHit;
}

const COLLAPSE_THRESHOLD_POST = 7;
const COLLAPSE_THRESHOLD_BRIEF = 5;
const COLLAPSE_PREVIEW_LINES = 4;

function padRight(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	return `${text}${" ".repeat(width - vis)}`;
}

function hitSpan(hit: SpanHit | undefined, x: number, y: number): boolean {
	return hit !== undefined && y === hit.row && x >= hit.x1 && x < hit.x2;
}

export class SwarmBoardView implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly manager: SwarmManager;
	private readonly onDone: () => void;
	private readonly editor: Editor;
	private readonly unsubscribe: () => void;
	private readonly markdownCache = new Map<number, { body: string; md: Markdown }>();
	private readonly expandedPosts = new Set<number>();

	private focusPane: FocusPane = "input";
	private rightMode: RightMode = "board";
	private expandAllPosts = false;
	private selectedMemberIdx = 0;
	private memberScrollOffset = 0;
	private scrollOffset = 0;
	private autoScroll = true;
	private lastRightHeight = 12;
	private lastLayout: RenderedLayoutMetrics | undefined;
	private statusNotice: string | undefined;
	private disposed = false;

	constructor(options: SwarmBoardViewOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.manager = options.manager;
		this.onDone = options.onDone;

		this.editor = new Editor(this.tui, getEditorTheme(), {
			promptPrefix: "@ ",
			paddingX: 1,
		});
		this.editor.focused = true;
		this.editor.onSubmit = (text) => {
			this.handlePostSubmit(text);
		};

		this.unsubscribe = this.manager.subscribe(() => {
			if (!this.disposed) {
				this.tui.requestRender();
			}
		});
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value && this.focusPane === "input";
	}

	invalidate(): void {
		this.editor.invalidate();
		for (const entry of this.markdownCache.values()) {
			entry.md.invalidate();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.markdownCache.clear();
		this.editor.dispose();
	}

	private matchesClose(data: string): boolean {
		if (this.keybindings.matches(data, "app.swarm.close")) return true;
		if (this.keybindings.getDefinition?.("app.swarm.close") === undefined) {
			return this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "tui.select.cancel");
		}
		return false;
	}

	private matchesSwitchPane(data: string): boolean {
		if (this.keybindings.matches(data, "app.swarm.switchPane")) return true;
		if (this.keybindings.getDefinition?.("app.swarm.switchPane") === undefined) {
			return this.keybindings.matches(data, "tui.input.tab");
		}
		return false;
	}

	private matchesStopAll(data: string): boolean {
		if (this.keybindings.matches(data, "app.swarm.stopAll")) return true;
		if (this.keybindings.getDefinition?.("app.swarm.stopAll") === undefined) {
			return this.keybindings.matches(data, "app.clear");
		}
		return false;
	}

	private matchesInspectToggle(data: string): boolean {
		return this.keybindings.matches(data, "app.tools.expand");
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const layout = this.lastLayout;
		if (!layout) {
			return event.type === "wheel" ? { handled: true } : undefined;
		}

		// Always capture wheel events inside this fullscreen overlay so scrolling never leaks
		// through to the underlying main transcript.
		if (event.type === "wheel" && event.wheelDelta) {
			const overLeftMembers =
				layout.splitLayout &&
				event.x < layout.leftWidth &&
				event.y >= layout.bodyStartRow &&
				event.y < layout.bodyStartRow + layout.bodyHeight;

			if (overLeftMembers) {
				const members = this.manager.getSnapshot()?.members ?? [];
				if (members.length > 0) {
					const step = event.wheelDelta < 0 ? -1 : 1;
					const nextIdx = Math.max(0, Math.min(members.length - 1, this.selectedMemberIdx + step));
					if (nextIdx !== this.selectedMemberIdx) {
						this.selectedMemberIdx = nextIdx;
						if (this.rightMode === "inspector") {
							this.autoScroll = true;
						}
						return { handled: true, render: true };
					}
				}
				return { handled: true };
			}

			this.scrollBy(event.wheelDelta);
			return { handled: true, render: true };
		}

		// Preserve press/drag/release unhandled on body text so fullscreen text selection works.
		if (event.type !== "click" || event.button !== "left") {
			return undefined;
		}

		// Click on bottom editor region: focus editor and position cursor.
		if (event.y >= layout.editorStartRow && event.y < layout.editorStartRow + layout.editorHeight) {
			this.focusPane = "input";
			this.editor.focused = true;
			const editorResult = this.editor.handleMouse({
				...event,
				y: event.y - layout.editorStartRow,
				height: layout.editorHeight,
			});
			return { handled: true, render: true, focus: editorResult?.focus ?? true };
		}

		// Click on right header tabs / controls.
		if (hitSpan(layout.boardTabHit, event.x, event.y)) {
			if (this.rightMode !== "board") {
				this.rightMode = "board";
				this.autoScroll = true;
				return { handled: true, render: true };
			}
			return { handled: true };
		}
		if (hitSpan(layout.inspectorTabHit, event.x, event.y)) {
			if (this.rightMode !== "inspector") {
				this.rightMode = "inspector";
				this.autoScroll = true;
				return { handled: true, render: true };
			}
			return { handled: true };
		}
		if (hitSpan(layout.expandAllHit, event.x, event.y)) {
			this.expandAllPosts = !this.expandAllPosts;
			this.expandedPosts.clear();
			return { handled: true, render: true };
		}
		if (hitSpan(layout.followHit, event.x, event.y)) {
			this.autoScroll = true;
			this.scrollOffset = layout.maxScroll;
			return { handled: true, render: true };
		}

		// Click on left members roster.
		if (layout.splitLayout && event.x < layout.leftWidth) {
			const relRow = event.y - layout.bodyStartRow;
			const hit = layout.memberHits.find((m) => relRow >= m.startRow && relRow < m.endRow);
			if (hit) {
				const sameMember = this.selectedMemberIdx === hit.memberIdx;
				this.selectedMemberIdx = hit.memberIdx;
				this.focusPane = "members";
				this.editor.focused = false;
				if (sameMember || (event.clickCount ?? 1) >= 2) {
					this.rightMode =
						this.rightMode === "inspector" && sameMember && (event.clickCount ?? 1) < 2 ? "board" : "inspector";
					this.autoScroll = true;
				}
				return { handled: true, render: true };
			}
			return undefined;
		}

		// Click on collapsible post in right Board Feed.
		if (
			this.rightMode === "board" &&
			event.x >= layout.rightStartX &&
			event.y >= layout.rightBodyStartRow &&
			event.y < layout.rightBodyStartRow + layout.rightScrollHeight
		) {
			const bodyLineIdx = this.scrollOffset + (event.y - layout.rightBodyStartRow);
			const postHit = layout.postHits.find((p) => bodyLineIdx >= p.startLine && bodyLineIdx < p.endLine);
			if (postHit?.collapsible) {
				this.togglePostExpanded(postHit.postSeq);
				return { handled: true, render: true };
			}
		}

		return undefined;
	}

	handleInput(data: string): void {
		this.statusNotice = undefined;

		if (this.matchesClose(data)) {
			this.onDone();
			return;
		}

		if (this.matchesStopAll(data)) {
			if (this.focusPane === "input" && this.editor.getText().length > 0) {
				this.editor.setText("");
			} else {
				const stopped = this.manager.stopAllWorkers();
				this.statusNotice =
					stopped > 0
						? `Stopped ${stopped} active worker${stopped === 1 ? "" : "s"}`
						: "No active workers running";
			}
			this.tui.requestRender();
			return;
		}

		if (this.matchesSwitchPane(data)) {
			const order: FocusPane[] = ["input", "members", "feed"];
			const next = order[(order.indexOf(this.focusPane) + 1) % order.length]!;
			this.focusPane = next;
			this.editor.focused = this.focusPane === "input";
			this.tui.requestRender();
			return;
		}

		if (this.matchesInspectToggle(data)) {
			this.rightMode = this.rightMode === "board" ? "inspector" : "board";
			this.autoScroll = true;
			this.tui.requestRender();
			return;
		}

		if (
			this.keybindings.matches(data, "tui.altScreen.pageUp") ||
			this.keybindings.matches(data, "tui.select.pageUp")
		) {
			this.scrollBy(-Math.max(1, this.lastRightHeight - 2));
			return;
		}
		if (
			this.keybindings.matches(data, "tui.altScreen.pageDown") ||
			this.keybindings.matches(data, "tui.select.pageDown")
		) {
			this.scrollBy(Math.max(1, this.lastRightHeight - 2));
			return;
		}
		if (this.keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			this.scrollBy(-Math.max(1, Math.floor(this.lastRightHeight / 2)));
			return;
		}
		if (this.keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			this.scrollBy(Math.max(1, Math.floor(this.lastRightHeight / 2)));
			return;
		}
		if (this.keybindings.matches(data, "tui.altScreen.top")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.altScreen.bottom")) {
			this.autoScroll = true;
			this.scrollOffset = this.lastLayout?.maxScroll ?? 0;
			this.tui.requestRender();
			return;
		}

		if (this.focusPane === "members") {
			const members = this.manager.getSnapshot()?.members ?? [];
			if (this.keybindings.matches(data, "tui.select.up")) {
				this.selectedMemberIdx = Math.max(0, this.selectedMemberIdx - 1);
				this.autoScroll = true;
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down")) {
				this.selectedMemberIdx = Math.min(Math.max(0, members.length - 1), this.selectedMemberIdx + 1);
				this.autoScroll = true;
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.rightMode = this.rightMode === "board" ? "inspector" : "board";
				this.autoScroll = true;
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (this.focusPane === "feed") {
			if (
				this.keybindings.matches(data, "tui.select.up") ||
				this.keybindings.matches(data, "tui.altScreen.lineUp")
			) {
				this.scrollBy(-1);
				return;
			}
			if (
				this.keybindings.matches(data, "tui.select.down") ||
				this.keybindings.matches(data, "tui.altScreen.lineDown")
			) {
				this.scrollBy(1);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm") && this.rightMode === "board") {
				this.expandAllPosts = !this.expandAllPosts;
				this.expandedPosts.clear();
				this.tui.requestRender();
				return;
			}
			return;
		}

		this.editor.handleInput(data);
	}

	private togglePostExpanded(postSeq: number): void {
		if (this.expandAllPosts) {
			// Switching out of expand-all keeps every other post expanded except this one.
			this.expandAllPosts = false;
			this.expandedPosts.clear();
			for (const post of this.manager.getPosts()) {
				if (post.seq !== postSeq) this.expandedPosts.add(post.seq);
			}
			return;
		}
		if (this.expandedPosts.has(postSeq)) {
			this.expandedPosts.delete(postSeq);
		} else {
			this.expandedPosts.add(postSeq);
		}
	}

	private isPostExpanded(postSeq: number): boolean {
		return this.expandAllPosts || this.expandedPosts.has(postSeq);
	}

	private handlePostSubmit(raw: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		this.editor.setText("");

		if (!this.manager.hasSwarm()) {
			this.statusNotice = "No active swarm yet. Run /swarm <task> first.";
			this.tui.requestRender();
			return;
		}

		try {
			// If user typed no @mention, direct it to the currently selected member (or coordinator).
			const hasAt = /(?:^|\s)@[a-z0-9]/i.test(trimmed);
			const snap = this.manager.getSnapshot();
			const selected = snap?.members[this.selectedMemberIdx];
			const defaultTarget = selected && selected.state !== "killed" ? selected.name : COORDINATOR_NAME;
			const body = hasAt ? trimmed : `@${defaultTarget} ${trimmed}`;

			const { post, woken } = this.manager.postMessage(USER_AUTHOR, body, { steer: true, immediate: true });
			this.rightMode = "board";
			this.autoScroll = true;
			this.statusNotice =
				woken.length > 0 ? `Posted #${post.seq} -> ${woken.map((w) => `@${w}`).join(", ")}` : `Posted #${post.seq}`;
		} catch (err) {
			this.statusNotice = err instanceof Error ? err.message : String(err);
		}
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		const maxScroll = this.lastLayout?.maxScroll ?? Number.MAX_SAFE_INTEGER;
		const next = Math.max(0, Math.min(maxScroll, this.scrollOffset + delta));
		this.scrollOffset = next;
		this.autoScroll = next >= maxScroll && delta > 0;
		this.tui.requestRender();
	}

	private formatHint(action: Keybinding, label: string): string {
		const keys = this.keybindings.getKeys(action);
		const keyStr = keys.length > 0 ? formatKeyText(keys.join("/")) : "";
		if (!keyStr) return "";
		return this.theme.fg("dim", keyStr) + this.theme.fg("muted", ` ${label}`);
	}

	private renderMarkdownBody(post: SwarmBoardPost, bodyWidth: number): readonly string[] {
		let cached = this.markdownCache.get(post.seq);
		if (!cached || cached.body !== post.body) {
			cached = {
				body: post.body,
				md: new Markdown(post.body, 0, 0, getMarkdownTheme()),
			};
			this.markdownCache.set(post.seq, cached);
		}
		const rendered = cached.md.render(bodyWidth);
		return rendered.length > 0 ? rendered : [""];
	}

	private buildHeader(snapshot: SwarmSnapshot | undefined, width: number): string {
		const title = snapshot ? snapshot.title || snapshot.id : "Swarm Board";
		const left = `${this.theme.fg("border", "── ")}${this.theme.style("swarm", { fg: "accent", bold: true })}${this.theme.fg("dim", " ─ ")}${this.theme.fg("text", title)}`;

		const badges: string[] = [];
		if (snapshot) {
			if (snapshot.counts.working > 0) badges.push(this.theme.fg("success", `● ${snapshot.counts.working} working`));
			if (snapshot.counts.waiting > 0) badges.push(this.theme.fg("accent", `○ ${snapshot.counts.waiting} waiting`));
			if (snapshot.counts.stopped > 0) badges.push(this.theme.fg("warning", `◌ ${snapshot.counts.stopped} stopped`));
			for (const pool of snapshot.taskPools) {
				badges.push(this.theme.fg("accent", `pool ${pool.completed.length}/${pool.totalTasks}`));
			}
			badges.push(this.theme.fg("muted", `${snapshot.postCount} posts`));
			if (snapshot.totalUsage.cost > 0) {
				badges.push(this.theme.fg("dim", formatCost(snapshot.totalUsage.cost)));
			}
		} else {
			badges.push(this.theme.fg("dim", "inactive"));
		}

		const badgeStr = badges.join(this.theme.fg("dim", " · "));
		const rightPart = ` ${badgeStr} ${this.theme.fg("border", "─")}`;
		const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(rightPart) - 1);
		return truncateToWidth(`${left} ${this.theme.fg("border", "─".repeat(fill))}${rightPart}`, width);
	}

	private buildFooter(width: number): string {
		const paneHint = this.formatHint("app.swarm.switchPane", `pane(${this.focusPane})`);
		const inspectHint = this.formatHint(
			"app.tools.expand",
			this.rightMode === "board" ? "inspect worker" : "show board",
		);
		const stopHint = this.formatHint("app.swarm.stopAll", "stop/clear");
		const closeHint = this.formatHint("app.swarm.close", "close");
		const mouseHint = this.theme.fg("dim", "click/wheel") + this.theme.fg("muted", " navigate");
		const sep = this.theme.fg("muted", " · ");

		const base =
			width >= 96
				? [paneHint, inspectHint, stopHint, closeHint, mouseHint].filter(Boolean).join(sep)
				: width >= 72
					? [paneHint, inspectHint, closeHint].filter(Boolean).join(sep)
					: [paneHint, closeHint].filter(Boolean).join(sep);

		const notice = this.statusNotice ? `${sep}${this.theme.fg("accent", this.statusNotice)}` : "";
		return truncateToWidth(` ${base}${notice}`, width);
	}

	private buildMemberPane(
		members: readonly SwarmMemberSnapshot[],
		pools: readonly SwarmTaskPool[],
		colWidth: number,
		bodyHeight: number,
	): { lines: string[]; hits: MemberRowHit[] } {
		const headerLines: string[] = [];
		const headingColor = this.focusPane === "members" ? "accent" : "muted";
		headerLines.push(padRight(this.theme.style(" MEMBERS", { fg: headingColor, bold: true }), colWidth));
		headerLines.push(this.theme.fg("border", "─".repeat(colWidth)));

		if (members.length === 0) {
			return {
				lines: [...headerLines, padRight(this.theme.fg("dim", " (no swarm active)"), colWidth)],
				hits: [],
			};
		}

		if (this.selectedMemberIdx >= members.length) {
			this.selectedMemberIdx = Math.max(0, members.length - 1);
		}

		const itemLines: string[] = [];
		const rawRanges: Array<{ start: number; end: number; memberIdx: number }> = [];

		for (let i = 0; i < members.length; i++) {
			const m = members[i]!;
			const start = itemLines.length;
			const isSelected = i === this.selectedMemberIdx;
			const pointer = isSelected ? this.theme.fg("accent", "▸") : " ";
			const marker = memberStateMarker(m.state);
			const color = memberStateColor(m.state);
			const nameStyle = isSelected
				? this.theme.style(`@${m.name}`, { fg: color, bold: true })
				: this.theme.fg(color, `@${m.name}`);

			let badge: string;
			if (m.state !== "working" && m.lastStopReason === "max_turns") {
				badge = this.theme.fg("warning", "max_turns");
			} else if (m.state !== "working" && m.lastStopReason === "error") {
				badge = this.theme.fg("error", "error");
			} else {
				const turnTag = m.role === "worker" && m.usage.turns > 0 ? ` ${m.usage.turns}t` : "";
				badge = this.theme.fg("dim", `${m.state}${turnTag}`);
			}
			itemLines.push(padRight(`${pointer}${this.theme.fg(color, marker)} ${nameStyle} ${badge}`, colWidth));

			if (m.currentActivity) {
				itemLines.push(padRight(this.theme.fg("muted", `   └ ${m.currentActivity}`), colWidth));
			} else if (m.currentTask) {
				const pool = m.poolId ? pools.find((p) => p.id === m.poolId) : undefined;
				const suffix = pool ? `/${pool.totalTasks}` : "";
				itemLines.push(padRight(this.theme.fg("accent", `   └ task #${m.currentTask.index}${suffix}`), colWidth));
			} else if (m.lastError && m.state !== "working") {
				itemLines.push(padRight(this.theme.fg("error", `   └ ${m.lastError}`), colWidth));
			} else if (m.gitBranch) {
				itemLines.push(padRight(this.theme.fg("dim", `   └ ${m.gitBranch}`), colWidth));
			} else if (m.role === "worker") {
				itemLines.push(padRight(this.theme.fg("dim", `   └ ${m.workspace}`), colWidth));
			}

			rawRanges.push({ start, end: itemLines.length, memberIdx: i });
		}

		// Keep selected member visible inside the left pane height.
		const listHeight = Math.max(1, bodyHeight - headerLines.length);
		const selectedRange = rawRanges[this.selectedMemberIdx];
		if (selectedRange) {
			if (selectedRange.start < this.memberScrollOffset) {
				this.memberScrollOffset = selectedRange.start;
			} else if (selectedRange.end > this.memberScrollOffset + listHeight) {
				this.memberScrollOffset = Math.max(0, selectedRange.end - listHeight);
			}
		}
		const maxMemberScroll = Math.max(0, itemLines.length - listHeight);
		this.memberScrollOffset = Math.max(0, Math.min(this.memberScrollOffset, maxMemberScroll));

		const visibleItems = itemLines.slice(this.memberScrollOffset, this.memberScrollOffset + listHeight);
		const hits: MemberRowHit[] = [];
		for (const range of rawRanges) {
			const visStart = Math.max(0, range.start - this.memberScrollOffset);
			const visEnd = Math.min(listHeight, range.end - this.memberScrollOffset);
			if (visEnd > visStart) {
				hits.push({
					startRow: headerLines.length + visStart,
					endRow: headerLines.length + visEnd,
					memberIdx: range.memberIdx,
				});
			}
		}

		return { lines: [...headerLines, ...visibleItems], hits };
	}

	private buildRightHeader(
		member: SwarmMemberSnapshot | undefined,
		colWidth: number,
		rightStartX: number,
		headerRow: number,
		scrollOffset: number,
		maxScroll: number,
	): {
		lines: string[];
		boardTabHit: SpanHit;
		inspectorTabHit: SpanHit;
		expandAllHit?: SpanHit;
		followHit?: SpanHit;
	} {
		const boardLabel = this.rightMode === "board" ? "[Board]" : " Board ";
		const inspectorTarget = member ? ` @${member.name}` : "";
		const inspectorLabel = this.rightMode === "inspector" ? `[Inspector${inspectorTarget}]` : " Inspector ";

		const boardStyled =
			this.rightMode === "board"
				? this.theme.style(boardLabel, { fg: this.focusPane === "feed" ? "accent" : "text", bold: true })
				: this.theme.fg("muted", boardLabel);
		const inspectorStyled =
			this.rightMode === "inspector"
				? this.theme.style(inspectorLabel, { fg: this.focusPane === "feed" ? "accent" : "text", bold: true })
				: this.theme.fg("muted", inspectorLabel);

		let cursorX = 1;
		const boardTabHit: SpanHit = {
			x1: rightStartX + cursorX,
			x2: rightStartX + cursorX + visibleWidth(boardLabel),
			row: headerRow,
		};
		cursorX += visibleWidth(boardLabel) + 1;
		const inspectorTabHit: SpanHit = {
			x1: rightStartX + cursorX,
			x2: rightStartX + cursorX + visibleWidth(inspectorLabel),
			row: headerRow,
		};
		cursorX += visibleWidth(inspectorLabel);

		let leftPart = ` ${boardStyled} ${inspectorStyled}`;
		let expandAllHit: SpanHit | undefined;
		if (this.rightMode === "board") {
			const toggleLabel = this.expandAllPosts ? "[Fold]" : "[Expand]";
			const toggleX = cursorX + 2;
			if (toggleX + visibleWidth(toggleLabel) + 10 < colWidth) {
				leftPart += `  ${this.theme.fg("dim", toggleLabel)}`;
				expandAllHit = {
					x1: rightStartX + toggleX,
					x2: rightStartX + toggleX + visibleWidth(toggleLabel),
					row: headerRow,
				};
			}
		}

		let scrollLabel = "";
		let followHit: SpanHit | undefined;
		if (maxScroll > 0) {
			if (this.autoScroll || scrollOffset >= maxScroll) {
				scrollLabel = this.theme.fg("success", "LIVE");
			} else {
				const pct = Math.round((scrollOffset / maxScroll) * 100);
				scrollLabel = this.theme.fg("accent", `↓ ${pct}%`);
			}
		}
		const scrollWidth = visibleWidth(scrollLabel);
		const leftWidth = visibleWidth(leftPart);
		let headerLine: string;
		if (scrollWidth > 0 && leftWidth + scrollWidth + 2 <= colWidth) {
			const gap = colWidth - leftWidth - scrollWidth - 1;
			headerLine = `${leftPart}${" ".repeat(gap)}${scrollLabel} `;
			if (!this.autoScroll && scrollOffset < maxScroll) {
				followHit = {
					x1: rightStartX + leftWidth + gap,
					x2: rightStartX + colWidth - 1,
					row: headerRow,
				};
			}
		} else {
			headerLine = padRight(leftPart, colWidth);
		}

		return {
			lines: [truncateToWidth(headerLine, colWidth), this.theme.fg("border", "─".repeat(colWidth))],
			boardTabHit,
			inspectorTabHit,
			expandAllHit,
			followHit,
		};
	}

	private buildBoardFeedBody(
		posts: readonly SwarmBoardPost[],
		colWidth: number,
	): { lines: string[]; postHits: PostRowHit[] } {
		const lines: string[] = [];
		const postHits: PostRowHit[] = [];

		if (posts.length === 0) {
			lines.push(padRight(this.theme.fg("dim", " No messages on the board yet."), colWidth));
			lines.push(
				padRight(this.theme.fg("dim", " Start a swarm with /swarm <task> or post below with @name."), colWidth),
			);
			return { lines, postHits };
		}

		const bodyWidth = Math.max(12, colWidth - 4);
		for (const post of posts) {
			const startLine = lines.length;
			const ts = formatPostTimestamp(post.timestamp);
			const authorColor =
				post.author === USER_AUTHOR ? "accent" : post.author === COORDINATOR_NAME ? "warning" : "success";
			const mentionsStr =
				post.mentions.length > 0
					? ` ${this.theme.fg("dim", "->")} ${post.mentions.map((m) => this.theme.fg("accent", `@${m}`)).join(" ")}`
					: "";
			const kindBadge = post.kind === "post" ? "" : ` ${this.theme.fg("dim", `[${post.kind}]`)}`;

			const renderedBody = this.renderMarkdownBody(post, bodyWidth);
			const threshold = post.kind === "brief" ? COLLAPSE_THRESHOLD_BRIEF : COLLAPSE_THRESHOLD_POST;
			const collapsible = renderedBody.length > threshold;
			const expanded = !collapsible || this.isPostExpanded(post.seq);
			const foldMarker = collapsible
				? expanded
					? ` ${this.theme.fg("dim", "▾")}`
					: ` ${this.theme.fg("accent", "▸")}`
				: "";

			const header = ` ${this.theme.fg("dim", `#${post.seq} [${ts}]`)} ${this.theme.style(`@${post.author}`, { fg: authorColor, bold: true })}${mentionsStr}${kindBadge}${foldMarker}`;
			lines.push(padRight(header, colWidth));

			const visibleBody = expanded ? renderedBody : renderedBody.slice(0, COLLAPSE_PREVIEW_LINES);
			for (const bLine of visibleBody) {
				lines.push(padRight(`   ${bLine}`, colWidth));
			}

			if (collapsible && !expanded) {
				const hiddenCount = renderedBody.length - COLLAPSE_PREVIEW_LINES;
				lines.push(
					padRight(
						`   ${this.theme.fg("accent", `▸ +${hiddenCount} more lines`)} ${this.theme.fg("dim", "(click to expand)")}`,
						colWidth,
					),
				);
			}

			postHits.push({ startLine, endLine: lines.length, postSeq: post.seq, collapsible });
			lines.push(this.theme.fg("border", ` ${"·".repeat(Math.max(1, Math.min(24, colWidth - 2)))}`));
		}

		return { lines, postHits };
	}

	private buildInspectorBody(
		member: SwarmMemberSnapshot | undefined,
		pools: readonly SwarmTaskPool[],
		colWidth: number,
	): string[] {
		const lines: string[] = [];
		if (!member) {
			lines.push(padRight(this.theme.fg("dim", " No member selected."), colWidth));
			return lines;
		}

		const color = memberStateColor(member.state);
		const stopSuffix =
			member.state !== "working" && member.lastStopReason
				? ` ${this.theme.fg(member.lastStopReason === "error" ? "error" : "warning", `(${member.lastStopReason})`)}`
				: "";
		lines.push(
			padRight(
				` ${this.theme.fg("muted", "State:")} ${this.theme.fg(color, member.state)}${stopSuffix}  ${this.theme.fg("muted", "Model:")} ${this.theme.fg("text", member.model)}  ${this.theme.fg("muted", "Thinking:")} ${this.theme.fg("text", member.thinkingLevel)}`,
				colWidth,
			),
		);
		lines.push(
			padRight(
				` ${this.theme.fg("muted", "Workspace:")} ${this.theme.fg("text", member.workspace)}${member.gitBranch ? ` (${member.gitBranch})` : ""}`,
				colWidth,
			),
		);
		lines.push(padRight(` ${this.theme.fg("muted", "CWD:")} ${this.theme.fg("dim", member.cwd)}`, colWidth));
		const wakeupMeta =
			member.lastWakeupTurns !== undefined
				? ` (last wakeup ${member.lastWakeupTurns}/${member.maxTurnsPerWakeup ?? DEFAULT_MAX_TURNS_PER_WAKEUP})`
				: "";
		lines.push(
			padRight(
				` ${this.theme.fg("muted", "Usage:")} ${member.usage.turns} turns${wakeupMeta} · in ${formatTokenCount(member.usage.input)} · out ${formatTokenCount(member.usage.output)} · ${formatCost(member.usage.cost)}`,
				colWidth,
			),
		);

		const pool = member.poolId ? pools.find((p) => p.id === member.poolId) : undefined;
		if (member.currentTask) {
			const totalLabel = pool ? `/${pool.totalTasks}` : "";
			lines.push(
				padRight(
					` ${this.theme.fg("muted", "Task:")} ${this.theme.fg("accent", `#${member.currentTask.index}${totalLabel}`)} ${this.theme.fg("text", member.currentTask.task)}`,
					colWidth,
				),
			);
		}
		if (pool) {
			lines.push(
				padRight(
					` ${this.theme.fg("muted", "Pool:")} ${pool.baseName} (${pool.completed.length}/${pool.totalTasks} done · ${Object.keys(pool.inFlight).length} active · ${pool.pending.length} queued${pool.failed.length > 0 ? ` · ${pool.failed.length} failed` : ""})`,
					colWidth,
				),
			);
		}
		if (member.lastError) {
			lines.push(padRight(` ${this.theme.fg("error", `Error: ${member.lastError}`)}`, colWidth));
		}

		const bodyWidth = Math.max(10, colWidth - 3);
		if (member.lastOutput) {
			lines.push("", padRight(this.theme.fg("muted", " Last output:"), colWidth));
			for (const wLine of wrapTextWithAnsi(member.lastOutput, bodyWidth)) {
				lines.push(padRight(`   ${this.theme.fg("text", wLine)}`, colWidth));
			}
		}

		lines.push("", padRight(this.theme.fg("muted", " Brief:"), colWidth));
		for (const wLine of wrapTextWithAnsi(member.brief, bodyWidth)) {
			lines.push(padRight(`   ${this.theme.fg("dim", wLine)}`, colWidth));
		}

		lines.push("", padRight(this.theme.fg("muted", " Recent activity:"), colWidth));
		const items = this.manager.getWorkerTranscript(member.name, 40);
		if (items.length === 0) {
			lines.push(
				padRight(
					this.theme.fg(
						"dim",
						member.role === "coordinator"
							? "   (Coordinator transcript is in the main conversation view)"
							: "   (No transcript events recorded yet)",
					),
					colWidth,
				),
			);
			return lines;
		}

		for (const item of items) {
			const ts = formatPostTimestamp(item.timestamp);
			const tagColor = item.kind === "error" ? "error" : item.kind === "tool" ? "accent" : "muted";
			const prefix = ` ${this.theme.fg("dim", `[${ts}]`)} ${this.theme.fg(tagColor, `[${item.kind}]`)} `;
			const firstWrap = wrapTextWithAnsi(item.summary, Math.max(10, bodyWidth - 16));
			lines.push(padRight(`${prefix}${this.theme.fg("text", firstWrap[0] ?? "")}`, colWidth));
			for (let i = 1; i < firstWrap.length; i++) {
				lines.push(padRight(`   ${this.theme.fg("text", firstWrap[i]!)}`, colWidth));
			}
		}

		return lines;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const terminalRows = Math.max(1, this.tui.terminal?.rows ?? 24);
		const snapshot = this.manager.getSnapshot();

		if (terminalRows <= 3) {
			this.lastLayout = undefined;
			return [this.buildHeader(snapshot, width), this.buildFooter(width)].slice(0, terminalRows);
		}

		const headerLine = this.buildHeader(snapshot, width);
		const footerLine = this.buildFooter(width);

		const maxEditorLines = Math.max(1, Math.min(3, Math.floor(terminalRows * 0.2)));
		this.editor.setMaxVisibleLines(maxEditorLines);
		const rawEditor = this.editor.render(width);
		const topBorder = rawEditor[0] ?? "";
		const bottomBorder = rawEditor.length > 1 ? rawEditor[rawEditor.length - 1] : "";
		const contentLines = rawEditor.length > 2 ? rawEditor.slice(1, -1) : rawEditor.slice(1);
		let cursorIdx = contentLines.findIndex((line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"));
		if (cursorIdx === -1) cursorIdx = 0;
		const visibleEditorCount = Math.max(1, Math.min(contentLines.length, maxEditorLines));
		const start = Math.max(0, Math.min(cursorIdx, contentLines.length - visibleEditorCount));
		const editorLines: string[] = [
			truncateToWidth(topBorder, width),
			...contentLines.slice(start, start + visibleEditorCount).map((l) => truncateToWidth(l, width)),
			...(terminalRows >= 6 ? [truncateToWidth(bottomBorder, width)] : []),
		];

		const bodyStartRow = 1;
		const bodyHeight = Math.max(1, terminalRows - 2 - editorLines.length);
		const editorStartRow = bodyStartRow + bodyHeight;
		this.lastRightHeight = Math.max(1, bodyHeight - 2);

		const members = snapshot?.members ?? [];
		const pools = snapshot?.taskPools ?? [];
		if (this.selectedMemberIdx >= members.length) {
			this.selectedMemberIdx = Math.max(0, members.length - 1);
		}
		const selectedMember = members[this.selectedMemberIdx];
		const posts = this.manager.getPosts();

		const bodyLines: string[] = [];
		const splitLayout = width >= 88;

		if (splitLayout) {
			const leftWidth = Math.min(32, Math.max(24, Math.floor(width * 0.28)));
			const rightStartX = leftWidth + 1;
			const rightWidth = Math.max(20, width - rightStartX);
			const leftPane = this.buildMemberPane(members, pools, leftWidth, bodyHeight);

			const rightFeed =
				this.rightMode === "board"
					? this.buildBoardFeedBody(posts, rightWidth)
					: { lines: this.buildInspectorBody(selectedMember, pools, rightWidth), postHits: [] };

			const rightScrollHeight = Math.max(1, bodyHeight - 2);
			const maxScroll = Math.max(0, rightFeed.lines.length - rightScrollHeight);
			this.scrollOffset = this.autoScroll ? maxScroll : Math.max(0, Math.min(this.scrollOffset, maxScroll));

			const rightHeader = this.buildRightHeader(
				selectedMember,
				rightWidth,
				rightStartX,
				bodyStartRow,
				this.scrollOffset,
				maxScroll,
			);
			const visibleRight = [
				...rightHeader.lines,
				...rightFeed.lines.slice(this.scrollOffset, this.scrollOffset + rightScrollHeight),
			];

			const divider = this.theme.fg("border", "│");
			for (let row = 0; row < bodyHeight; row++) {
				const l = padRight(leftPane.lines[row] ?? "", leftWidth);
				const r = padRight(visibleRight[row] ?? "", rightWidth);
				bodyLines.push(truncateToWidth(`${l}${divider}${r}`, width));
			}

			this.lastLayout = {
				splitLayout: true,
				width,
				leftWidth,
				rightStartX,
				bodyStartRow,
				bodyHeight,
				rightBodyStartRow: bodyStartRow + rightHeader.lines.length,
				rightScrollHeight,
				maxScroll,
				editorStartRow,
				editorHeight: editorLines.length,
				memberHits: leftPane.hits,
				postHits: rightFeed.postHits,
				boardTabHit: rightHeader.boardTabHit,
				inspectorTabHit: rightHeader.inspectorTabHit,
				expandAllHit: rightHeader.expandAllHit,
				followHit: rightHeader.followHit,
			};
		} else {
			// Compact single-column layout for narrow terminals.
			const summaryRow =
				members.length > 0
					? members
							.map((m) => this.theme.fg(memberStateColor(m.state), `${memberStateMarker(m.state)}@${m.name}`))
							.join(" ")
					: this.theme.fg("dim", "(no members)");
			bodyLines.push(truncateToWidth(` ${summaryRow}`, width));

			const rightFeed =
				this.rightMode === "board"
					? this.buildBoardFeedBody(posts, width)
					: { lines: this.buildInspectorBody(selectedMember, pools, width), postHits: [] };

			const rightScrollHeight = Math.max(1, bodyHeight - 3);
			const maxScroll = Math.max(0, rightFeed.lines.length - rightScrollHeight);
			this.scrollOffset = this.autoScroll ? maxScroll : Math.max(0, Math.min(this.scrollOffset, maxScroll));

			const rightHeader = this.buildRightHeader(
				selectedMember,
				width,
				0,
				bodyStartRow + 1,
				this.scrollOffset,
				maxScroll,
			);
			const visible = [
				...rightHeader.lines,
				...rightFeed.lines.slice(this.scrollOffset, this.scrollOffset + rightScrollHeight),
			];
			for (const line of visible) {
				bodyLines.push(truncateToWidth(line, width));
			}
			while (bodyLines.length < bodyHeight) {
				bodyLines.push("");
			}

			this.lastLayout = {
				splitLayout: false,
				width,
				leftWidth: 0,
				rightStartX: 0,
				bodyStartRow,
				bodyHeight,
				rightBodyStartRow: bodyStartRow + 1 + rightHeader.lines.length,
				rightScrollHeight,
				maxScroll,
				editorStartRow,
				editorHeight: editorLines.length,
				memberHits: [],
				postHits: rightFeed.postHits,
				boardTabHit: rightHeader.boardTabHit,
				inspectorTabHit: rightHeader.inspectorTabHit,
				expandAllHit: rightHeader.expandAllHit,
				followHit: rightHeader.followHit,
			};
		}

		return [headerLine, ...bodyLines, ...editorLines, footerLine].slice(0, terminalRows);
	}
}

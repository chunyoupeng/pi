import { Input } from "./components/input.ts";
import type { Component, Focusable } from "./tui.ts";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	textStart: number;
	textEnd: number;
	row: number;
	startCol: number;
	endCol: number;
	linearColumns: boolean;
}

interface SearchCorpus {
	text: string;
	spans: SearchSourceSpan[];
}

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	const chunks: string[] = [];
	const spans: SearchSourceSpan[] = [];
	let textLength = 0;
	let pendingSeparator = false;

	const appendSeparator = (): void => {
		if (!pendingSeparator) return;
		chunks.push(" ");
		textLength += 1;
		pendingSeparator = false;
	};

	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		let column = 0;

		// Rendered transcripts are overwhelmingly ASCII. Index complete non-space
		// runs at once instead of segmenting and allocating one mapping per cell.
		if (PRINTABLE_ASCII.test(line)) {
			let index = 0;
			while (index < line.length) {
				if (line.charCodeAt(index) === 0x20) {
					if (textLength > 0) pendingSeparator = true;
					column += 1;
					index += 1;
					continue;
				}
				let end = index + 1;
				while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
				appendSeparator();
				const text = line.slice(index, end);
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + text.length,
					linearColumns: true,
				});
				textLength += text.length;
				column += text.length;
				index = end;
			}
		} else {
			for (const grapheme of segmenter.segment(line)) {
				const text = grapheme.segment;
				const width = visibleWidth(text);
				if (/^\s+$/u.test(text)) {
					if (textLength > 0) pendingSeparator = true;
					column += width;
					continue;
				}
				appendSeparator();
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + width,
					linearColumns: false,
				});
				textLength += text.length;
				column += width;
			}
		}
		if (textLength > 0) pendingSeparator = true;
	}

	return { text: chunks.join(""), spans };
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSearchCorpusMatches(corpus: SearchCorpus, normalizedQuery: string): AltScreenSearchMatch[] {
	if (!normalizedQuery) return [];
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: AltScreenSearchMatch[] = [];
	let spanIndex = 0;

	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= start) spanIndex += 1;

		const segments: AltScreenSearchSegment[] = [];
		for (let index = spanIndex; index < corpus.spans.length; index++) {
			const span = corpus.spans[index]!;
			if (span.textStart >= end) break;
			if (span.textEnd <= start) continue;
			const startCol = span.linearColumns
				? span.startCol + Math.max(start, span.textStart) - span.textStart
				: span.startCol;
			const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, endCol);
			} else {
				segments.push({ row: span.row, startCol, endCol });
			}
		}
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= end) spanIndex += 1;
		if (segments.length > 0) matches.push({ segments });
	}

	return matches;
}

export interface AltScreenSearchResult {
	matches: AltScreenSearchMatch[];
	changed: boolean;
}

/** Cache the searchable corpus and matches while rendered transcript lines remain unchanged. */
export class AltScreenSearchIndex {
	private sourceLines: string[] | undefined;
	private corpus: SearchCorpus | undefined;
	private normalizedQuery: string | undefined;
	private matches: AltScreenSearchMatch[] = [];

	search(lines: readonly string[], query: string): AltScreenSearchResult {
		let sourceChanged = this.sourceLines?.length !== lines.length;
		if (!sourceChanged && this.sourceLines) {
			for (let index = 0; index < lines.length; index++) {
				if (this.sourceLines[index] === lines[index]) continue;
				sourceChanged = true;
				break;
			}
		}
		if (sourceChanged || !this.corpus) {
			this.sourceLines = Array.from(lines);
			this.corpus = buildSearchCorpus(lines);
		}

		const normalizedQuery = normalizeQuery(query);
		const changed = sourceChanged || normalizedQuery !== this.normalizedQuery;
		if (changed) {
			this.normalizedQuery = normalizedQuery;
			this.matches = findSearchCorpusMatches(this.corpus, normalizedQuery);
		}
		return { matches: this.matches, changed };
	}
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	return normalizedQuery ? findSearchCorpusMatches(buildSearchCorpus(lines), normalizedQuery) : [];
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export class AltScreenSearchComponent implements Component, Focusable {
	private readonly input = new Input();
	private readonly onQueryChange: (query: string) => void;
	private resultCount = 0;
	private resultIndex = -1;
	private _focused = false;

	constructor(onQueryChange: (query: string) => void) {
		this.onQueryChange = onQueryChange;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	setResult(index: number, count: number): void {
		this.resultIndex = index;
		this.resultCount = count;
	}

	handleInput(data: string): void {
		const previous = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query !== previous) this.onQueryChange(query);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const label = " Find transcript";
		const query = this.input.getValue();
		const status = !query
			? ""
			: this.resultCount === 0
				? "No matches "
				: `${this.resultIndex + 1}/${this.resultCount} `;
		const labelWidth = visibleWidth(label);
		const statusWidth = visibleWidth(status);
		const gap = " ".repeat(Math.max(1, safeWidth - labelWidth - statusWidth));
		const title = truncateToWidth(`${label}${gap}${status}`, safeWidth, "");
		const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(title)));
		return [`\x1b[7m${title}${padding}\x1b[27m`, ...this.input.render(safeWidth)];
	}
}

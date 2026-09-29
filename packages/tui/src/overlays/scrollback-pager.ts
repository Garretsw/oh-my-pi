/**
 * Fullscreen scrollback pager (`less` for the conversation).
 *
 * Fork feature for `PI_TUI_ALT_SCREEN=1`: the alternate screen has no native
 * scrollback, so this overlay shows the whole rendered conversation in a
 * scrollable view. It is mounted as a `fullscreen` overlay over the same
 * buffer; closing it repaints the live screen pinned to the bottom.
 *
 * The host supplies the full conversation rows (`ChatContainer.render`) and the
 * row where each block starts. Rendering the conversation is expensive on long
 * sessions, so the pager caches the rows and refreshes them at most every
 * {@link REFRESH_MS}, or immediately when the width changes.
 */
import { matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { TranscriptBrowser, type TranscriptBrowserFrame } from "../chat/transcript-browser";
import { theme } from "../theme/theme";
import type { Component } from "../tui";

/** Full conversation as rendered rows, with the first row of every block. */
export interface ScrollbackSnapshot {
	lines: readonly string[];
	/** Ascending start rows of the conversation's blocks. */
	blockStarts: readonly number[];
}

export interface ScrollbackPagerDeps {
	/** Render the whole conversation at `width`. Called at most every {@link REFRESH_MS} per width. */
	snapshot: (width: number) => ScrollbackSnapshot;
	getHeight: () => number;
	requestRender: () => void;
	/** Leave the pager and return to the live screen. */
	onClose: () => void;
	/** A printable key closed the pager: hand it to the editor. */
	onForwardKey: (data: string) => void;
	now?: () => number;
}

/** Minimum time between conversation re-renders while the pager is open. */
export const REFRESH_MS = 100;
/** Rows moved per mouse wheel event (momentum already multiplies events). */
export const WHEEL_STEP = 3;
/** Header + footer rows plus the three border rows drawn by the browser. */
const CHROME_ROWS = 5;

const NO_SNAPSHOT: ScrollbackSnapshot = { lines: [], blockStarts: [] };

function isPrintable(data: string): boolean {
	if (data.length === 0 || data.startsWith("\x1b")) return false;
	for (const char of data) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export class ScrollbackPager implements Component {
	readonly #deps: ScrollbackPagerDeps;
	readonly #browser: TranscriptBrowser;
	#snapshot: ScrollbackSnapshot = NO_SNAPSHOT;
	#snapshotWidth = -1;
	#snapshotAt = 0;
	#refreshTimer: NodeJS.Timeout | undefined;
	// Row count when the reader left the tail; new rows since then are counted in the header.
	#pausedTotal = 0;
	#disposed = false;

	constructor(deps: ScrollbackPagerDeps) {
		this.#deps = deps;
		this.#browser = new TranscriptBrowser({
			getHeight: deps.getHeight,
			frame: context => this.#frame(context.contentWidth),
			followBottom: true,
		});
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
	}

	invalidate(): void {
		this.#snapshotWidth = -1;
		this.#browser.invalidate();
	}

	render(width: number): readonly string[] {
		let lines = this.#browser.render(width);
		if (this.#pendingScroll !== 0) {
			const delta = this.#pendingScroll;
			this.#pendingScroll = 0;
			this.#scrollBy(delta);
			lines = this.#browser.render(width);
		}
		const top = this.#pendingTop;
		if (top === undefined) return lines;
		// The browser has now laid out the new-width rows: move to the remapped
		// top row and paint again so the stale offset is never shown.
		this.#pendingTop = undefined;
		this.#browser.setScrollOffset(top);
		return this.#browser.render(width);
	}

	/**
	 * Scroll by rows, e.g. the wheel step that opened the pager. Before the
	 * first paint there are no rows to scroll, so the step waits for them.
	 */
	scroll(delta: number): void {
		if (this.#snapshotWidth < 0) {
			this.#pendingScroll += delta;
			return;
		}
		this.#scrollBy(delta);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel === 1) this.#wheelDown();
				else if (event.wheel === -1) this.#scrollBy(-WHEEL_STEP);
				return true;
			});
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.#deps.onClose();
			return;
		}
		if (data === "g" || matchesKey(data, "home")) {
			this.#browser.scrollToTop();
			this.#afterScroll();
			return;
		}
		if (data === "G" || matchesKey(data, "end")) {
			this.#browser.scrollToBottom();
			this.#afterScroll();
			return;
		}
		if (this.#browser.handleScrollKey(data)) {
			this.#afterScroll();
			return;
		}
		if (isPrintable(data)) {
			this.#deps.onClose();
			this.#deps.onForwardKey(data);
		}
	}

	#wheelDown(): void {
		if (this.#browser.getScrollState().following) {
			this.#deps.onClose();
			return;
		}
		this.#scrollBy(WHEEL_STEP);
	}

	#scrollBy(delta: number): void {
		this.#browser.scroll(delta);
		this.#afterScroll();
	}

	#afterScroll(): void {
		const state = this.#browser.getScrollState();
		if (!state.following && this.#pausedTotal === 0) this.#pausedTotal = this.#snapshot.lines.length;
		if (state.following) this.#pausedTotal = 0;
		this.#deps.requestRender();
	}

	#bodyHeight(): number {
		return Math.max(3, this.#deps.getHeight() - CHROME_ROWS);
	}

	/** Refresh the cached conversation rows when the width changed or the cache is stale. */
	#refresh(width: number): void {
		const now = (this.#deps.now ?? Date.now)();
		const widthChanged = width !== this.#snapshotWidth;
		if (!widthChanged && now - this.#snapshotAt < REFRESH_MS) {
			this.#scheduleRefresh(REFRESH_MS - (now - this.#snapshotAt));
			return;
		}
		const previous = this.#snapshot;
		const state = this.#browser.getScrollState();
		const next = this.#deps.snapshot(width);
		this.#snapshot = next;
		this.#snapshotWidth = width;
		this.#snapshotAt = now;
		// Keep the top visible block on a width change; a same-width refresh only
		// appends at the tail, so the absolute offset already holds the view.
		if (widthChanged && !state.following && previous.blockStarts.length > 0) {
			this.#pendingTop = this.#remapTop(previous, next, state.offset);
		}
	}

	#pendingTop: number | undefined;
	#pendingScroll = 0;

	#remapTop(previous: ScrollbackSnapshot, next: ScrollbackSnapshot, topRow: number): number {
		let block = 0;
		for (let index = 0; index < previous.blockStarts.length; index++) {
			if (previous.blockStarts[index]! <= topRow) block = index;
			else break;
		}
		const withinBlock = topRow - previous.blockStarts[block]!;
		const start = next.blockStarts[block];
		return start === undefined ? topRow : start + withinBlock;
	}

	#scheduleRefresh(delayMs: number): void {
		if (this.#refreshTimer || this.#disposed) return;
		this.#refreshTimer = setTimeout(
			() => {
				this.#refreshTimer = undefined;
				if (!this.#disposed) this.#deps.requestRender();
			},
			Math.max(1, delayMs),
		);
		this.#refreshTimer.unref?.();
	}

	#frame(contentWidth: number): TranscriptBrowserFrame {
		this.#refresh(contentWidth);
		const lines = this.#snapshot.lines;
		const state = this.#browser.getScrollState();
		const total = lines.length;
		const height = this.#bodyHeight();
		const max = Math.max(0, total - height);
		const top = state.following ? max : Math.min(state.offset, max);
		const end = Math.min(total, top + height);
		const mode = state.following ? "following" : "paused";
		const fresh = !state.following && this.#pausedTotal > 0 ? Math.max(0, total - this.#pausedTotal) : 0;
		const position = total === 0 ? "empty" : `line ${top + 1}–${end} of ${total}`;
		const header = theme.fg(
			"accent",
			`Scrollback ${theme.sep.dot} ${position} ${theme.sep.dot} ${mode}${fresh > 0 ? ` ${theme.sep.dot} ↓ ${fresh} new` : ""}`,
		);
		const footer = theme.fg("dim", "↑↓/wheel scroll · PgUp/PgDn page · g/G top/bottom · Esc back");
		return { header: [header], footer: [footer], body: { lines } };
	}
}

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	type OverlayHandle,
	TUI,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ScrollbackPager, type ScrollbackSnapshot } from "../src/overlays/scrollback-pager";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// The pager only exists for PI_TUI_ALT_SCREEN=1: it is the app's own scrollback
// on a screen that has none, driven by the SGR wheel events a phone swipe sends.

const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

class LiveScreen implements TerminalFrameProvider {
	readonly committed = Array.from({ length: 12 }, (_value, index) => `answer-${index}`);
	readonly live = ["live-editor", "live-status"];
	#history: { id: number; rows: string[] } | undefined = { id: 1, rows: this.committed };
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return { history: this.#history, viewport: this.live.slice(-viewport.rows) };
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return [...this.committed, ...this.live].slice(-viewport.rows);
	}
	acknowledgeHistory(): void {
		this.#history = undefined;
	}
}

class FocusTerminal extends VirtualTerminal {
	#focusCallbacks: Array<(focused: boolean) => void> = [];
	onFocusChange(callback: (focused: boolean) => void): () => void {
		this.#focusCallbacks.push(callback);
		return () => {
			this.#focusCallbacks = this.#focusCallbacks.filter(entry => entry !== callback);
		};
	}
	reportFocus(focused: boolean): void {
		for (const callback of this.#focusCallbacks) callback(focused);
	}
}

const painted = (terminal: VirtualTerminal) => terminal.getViewport().map(row => row.trimEnd());
/** Body rows currently shown, in order, ignoring chrome and the scrollbar column. */
const bodyRows = (terminal: VirtualTerminal, pattern: RegExp) =>
	painted(terminal)
		.map(row => pattern.exec(row)?.[0])
		.filter((row): row is string => row !== undefined);

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	tui: TUI;
	pager: ScrollbackPager;
	closed: () => number;
	forwarded: string[];
	setClock: (ms: number) => void;
	settle: () => Promise<void>;
}

async function open(
	snapshot: (width: number) => ScrollbackSnapshot,
	size: { cols: number; rows: number } = { cols: 30, rows: 12 },
	makeTerminal: (cols: number, rows: number) => VirtualTerminal = (cols, rows) => new VirtualTerminal(cols, rows),
): Promise<Harness> {
	const terminal = makeTerminal(size.cols, size.rows);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setFrameProvider(new LiveScreen());
	tui.start();
	await scheduler.settle(terminal);
	let clock = 0;
	let closes = 0;
	const forwarded: string[] = [];
	const overlay: { handle?: OverlayHandle } = {};
	const pager = new ScrollbackPager({
		snapshot,
		getHeight: () => terminal.rows,
		requestRender: () => tui.requestRender(),
		onClose: () => {
			closes++;
			overlay.handle?.hide();
			tui.requestRender();
		},
		onForwardKey: data => forwarded.push(data),
		now: () => clock,
	});
	overlay.handle = tui.showOverlay(pager, { fullscreen: true, mouseTracking: true });
	tui.setFocus(pager);
	await scheduler.settle(terminal);
	return {
		terminal,
		scheduler,
		tui,
		pager,
		closed: () => closes,
		forwarded,
		setClock: ms => {
			clock = ms;
		},
		settle: () => scheduler.settle(terminal),
	};
}

const rowsOf = (count: number) => (): ScrollbackSnapshot => ({
	lines: Array.from({ length: count }, (_value, index) => `row-${index}`),
	blockStarts: [0],
});

describe("scrollback pager (PI_TUI_ALT_SCREEN)", () => {
	let previous: string | undefined;
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});
	beforeEach(() => {
		previous = Bun.env.PI_TUI_ALT_SCREEN;
		Bun.env.PI_TUI_ALT_SCREEN = "1";
	});
	afterEach(() => {
		if (previous === undefined) delete Bun.env.PI_TUI_ALT_SCREEN;
		else Bun.env.PI_TUI_ALT_SCREEN = previous;
	});

	it("opens on the last rows of the full conversation", async () => {
		const h = await open(rowsOf(100));
		// 12 rows minus header, footer and three borders leaves a 7-row body.
		expect(bodyRows(h.terminal, /row-\d+/)).toEqual(Array.from({ length: 7 }, (_v, i) => `row-${93 + i}`));
		h.pager.dispose();
		h.tui.stop();
	});

	it("scrolls back exactly three rows per wheel-up and returns with wheel-down", async () => {
		const h = await open(rowsOf(100));
		h.terminal.sendInput(WHEEL_UP);
		await h.settle();
		expect(bodyRows(h.terminal, /row-\d+/).at(-1)).toBe("row-96");
		h.terminal.sendInput(WHEEL_DOWN);
		await h.settle();
		expect(bodyRows(h.terminal, /row-\d+/).at(-1)).toBe("row-99");
		expect(h.closed()).toBe(0);
		h.pager.dispose();
		h.tui.stop();
	});

	it("holds a scrolled-up view while output streams in and G resumes following", async () => {
		let count = 100;
		const h = await open(() => rowsOf(count)(), { cols: 70, rows: 12 });
		h.terminal.sendInput(WHEEL_UP);
		await h.settle();
		const before = bodyRows(h.terminal, /row-\d+/);

		count = 120;
		h.setClock(500);
		h.tui.requestRender();
		await h.settle();
		expect(bodyRows(h.terminal, /row-\d+/)).toEqual(before);
		expect(painted(h.terminal).join("\n")).toContain("↓ 20 new");

		h.terminal.sendInput("G");
		await h.settle();
		expect(bodyRows(h.terminal, /row-\d+/).at(-1)).toBe("row-119");
		h.pager.dispose();
		h.tui.stop();
	});

	it("closes on wheel-down at the tail and pins the live screen to the bottom", async () => {
		const h = await open(rowsOf(100), { cols: 30, rows: 5 });
		h.terminal.sendInput(WHEEL_DOWN);
		await h.settle();
		expect(h.closed()).toBe(1);
		expect(painted(h.terminal)).toEqual(["answer-9", "answer-10", "answer-11", "live-editor", "live-status"]);
		expect(painted(h.terminal).join("\n")).not.toContain("Scrollback");
		h.pager.dispose();
		h.tui.stop();
	});

	it("closes on a printable key and hands the character to the editor", async () => {
		const h = await open(rowsOf(100));
		h.terminal.sendInput("x");
		await h.settle();
		expect(h.closed()).toBe(1);
		expect(h.forwarded).toEqual(["x"]);
		h.pager.dispose();
		h.tui.stop();
	});

	it("keeps the top visible block when the width changes", async () => {
		// Every block wraps to twice as many rows once the width drops below 30.
		const blocks = 30;
		const snapshot = (width: number): ScrollbackSnapshot => {
			const per = width >= 29 ? 4 : 8;
			const lines: string[] = [];
			const blockStarts: number[] = [];
			for (let block = 0; block < blocks; block++) {
				blockStarts.push(lines.length);
				for (let row = 0; row < per; row++) lines.push(`b${block}-r${row}`);
			}
			return { lines, blockStarts };
		};
		const h = await open(snapshot);
		// Scroll to the very top, then down 34 rows: block 8, row 2 at width 30.
		h.terminal.sendInput("g");
		for (let step = 0; step < 34; step++) h.terminal.sendInput("\x1b[B");
		await h.settle();
		expect(bodyRows(h.terminal, /b\d+-r\d+/)[0]).toBe("b8-r2");

		h.terminal.resize(20, 12);
		await h.scheduler.advance(h.terminal, 2000);
		expect(bodyRows(h.terminal, /b\d+-r\d+/)[0]).toBe("b8-r2");
		h.pager.dispose();
		h.tui.stop();
	});

	it("scrolls without re-rendering the whole conversation on every frame", async () => {
		let renders = 0;
		const h = await open(() => {
			renders++;
			return rowsOf(500)();
		});
		const opened = renders;
		for (let step = 0; step < 10; step++) {
			h.terminal.sendInput(WHEEL_UP);
			await h.settle();
		}
		// The clock never advanced: a 20k-row session must not be re-rendered per frame.
		expect(renders).toBe(opened);
		h.pager.dispose();
		h.tui.stop();
	});

	it("repaints the whole pager on focus-in after a reattached client blanked the pane", async () => {
		const h = await open(rowsOf(100), undefined, (cols, rows) => new FocusTerminal(cols, rows));
		const before = painted(h.terminal);
		// A control-mode client rebuilt the pane blank: nothing in the app changed.
		h.terminal.write("\x1b[H\x1b[2J");
		await h.settle();
		expect(painted(h.terminal).every(row => row === "")).toBe(true);

		(h.terminal as FocusTerminal).reportFocus(true);
		await h.settle();
		expect(painted(h.terminal)).toEqual(before);
		h.pager.dispose();
		h.tui.stop();
	});
});

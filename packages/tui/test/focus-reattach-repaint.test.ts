import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	ImageProtocol,
	setTerminalImageProtocol,
	TERMINAL,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "./virtual-terminal";

// tmux control-mode clients (iTerm2, Shellfish) rebuild a pane from their own
// snapshot on attach, and an idle app writes nothing, so a same-size reattach
// could stay blank until a resize forced a repaint. tmux reports focus-in to
// the pane on every client attach; omp subscribes to DEC 1004 inside tmux and
// repaints the viewport on focus-in.

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal DEC 1004 focus reporting", () => {
	let terminal: ProcessTerminal | undefined;
	let previousHeadless = false;
	let previousTmux: string | undefined;
	let spies: Array<{ mockRestore(): void }> = [];
	const input: string[] = [];
	const output: string[] = [];

	function setup(tmux: string | undefined): void {
		previousTmux = Bun.env.TMUX;
		if (tmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = tmux;
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		input.length = 0;
		output.length = 0;
		spies = [
			vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
				output.push(String(chunk));
				return true;
			}),
			vi.spyOn(process, "kill").mockImplementation(() => true),
		];
		terminal = new ProcessTerminal();
		terminal.start(
			data => input.push(data),
			() => {},
		);
	}

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		for (const spy of spies) spy.mockRestore();
		spies = [];
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process.stdout, "columns", stdoutColumnsDescriptor);
		restoreProperty(process.stdout, "rows", stdoutRowsDescriptor);
		setTerminalHeadless(previousHeadless);
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
	});

	it("inside tmux, reports focus changes to subscribers without typing them into input, and disables on stop", () => {
		setup("/tmp/tmux-1000/default,1,0");
		expect(output.join("")).toContain("\x1b[?1004h");
		const focus: boolean[] = [];
		terminal!.onFocusChange(focused => focus.push(focused));

		process.stdin.emit("data", "\x1b[O");
		process.stdin.emit("data", "\x1b[I");

		expect(focus).toEqual([false, true]);
		expect(input.join("")).toBe("");

		output.length = 0;
		terminal!.stop();
		terminal = undefined;
		expect(output.join("")).toContain("\x1b[?1004l");
	});

	it("outside tmux, leaves focus reporting off and still swallows a stray report", () => {
		setup(undefined);
		expect(output.join("")).not.toContain("\x1b[?1004h");

		process.stdin.emit("data", "\x1b[I");

		expect(input.join("")).toBe("");
	});
});

class TranscriptProvider implements TerminalFrameProvider {
	readonly committed = ["answer-line-1", "answer-line-2", "answer-line-3"];
	readonly live = ["editor", "status-line"];
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

const immediateScheduler = {
	now: () => 0,
	scheduleImmediate: (callback: () => void) => callback(),
	scheduleRender: (callback: () => void) => {
		callback();
		return { cancel: () => {} };
	},
};

function restoreAfterBlankedClient(): { before: string[]; blanked: string[]; after: string[] } {
	const terminal = new FocusTerminal(30, 5);
	const tui = new TUI(terminal, undefined, { renderScheduler: immediateScheduler });
	tui.setFrameProvider(new TranscriptProvider());
	tui.start();
	const painted = () => terminal.getViewport().map(row => row.trimEnd());
	const before = painted();
	// A reattached control-mode client rebuilt the pane blank: nothing in the
	// app's model changed, so an ordinary render writes no rows.
	terminal.write("\x1b[H\x1b[2J");
	tui.requestRender();
	const blanked = painted();
	terminal.reportFocus(true);
	const after = painted();
	tui.stop();
	return { before, blanked, after };
}

describe("TUI focus-in repaint", () => {
	const expected = ["answer-line-1", "answer-line-2", "answer-line-3", "editor", "status-line"];

	it("restores committed rows above the viewport as well as the viewport, where an ordinary render diffs both away", () => {
		const { before, blanked, after } = restoreAfterBlankedClient();
		expect(before).toEqual(expected);
		expect(blanked).toEqual(["", "", "", "", ""]);
		expect(after).toEqual(expected);
	});

	it("restores the full screen with an image protocol active, as tmux sessions default to Kitty", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			expect(restoreAfterBlankedClient().after).toEqual(expected);
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
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

class StaticFrameProvider implements TerminalFrameProvider {
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return { viewport: ["transcript-row", "editor", "status-line"].slice(-viewport.rows) };
	}
	acknowledgeHistory(): void {}
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

describe("TUI focus-in repaint", () => {
	it("repaints a viewport the host lost when focus returns, where an ordinary render diffs it away", () => {
		const terminal = new FocusTerminal(30, 6);
		const tui = new TUI(terminal, undefined, { renderScheduler: immediateScheduler });
		tui.setFrameProvider(new StaticFrameProvider());
		tui.start();
		const painted = () => terminal.getViewport().map(row => row.trimEnd());
		expect(painted()).toContain("editor");

		// A reattached control-mode client rebuilt the pane blank: nothing in
		// the app's model changed, so an ordinary render writes no rows.
		terminal.write("\x1b[H\x1b[2J");
		tui.requestRender();
		expect(painted()).not.toContain("editor");

		terminal.reportFocus(true);

		expect(painted()).toEqual(expect.arrayContaining(["transcript-row", "editor", "status-line"]));
		tui.stop();
	});
});

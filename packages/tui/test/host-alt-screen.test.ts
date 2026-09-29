import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// PI_TUI_ALT_SCREEN=1 hosts the UI on the alternate screen, like a fullscreen
// TUI, so tmux control-mode clients (Shellfish, iTerm2) have no native
// scrollback to rebuild or scroll position to misplace on reattach.

class TranscriptProvider implements TerminalFrameProvider {
	readonly committed = Array.from({ length: 12 }, (_value, index) => `answer-${index}`);
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

class FullscreenModal implements Component {
	render(): string[] {
		return ["model picker"];
	}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const tail = (provider: TranscriptProvider, rows: number) => [...provider.committed, ...provider.live].slice(-rows);
const painted = (terminal: VirtualTerminal) => terminal.getViewport().map(row => row.trimEnd());
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("PI_TUI_ALT_SCREEN host alternate screen", () => {
	let previous: string | undefined;
	beforeEach(() => {
		previous = Bun.env.PI_TUI_ALT_SCREEN;
		Bun.env.PI_TUI_ALT_SCREEN = "1";
	});
	afterEach(() => {
		if (previous === undefined) delete Bun.env.PI_TUI_ALT_SCREEN;
		else Bun.env.PI_TUI_ALT_SCREEN = previous;
	});

	it("keeps the conversation pinned to the bottom row after the window grows", async () => {
		const terminal = new RecordingTerminal(30, 5);
		const provider = new TranscriptProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);
		expect(painted(terminal)).toEqual(tail(provider, 5));

		// The alternate screen has no scrollback to pull down on a grow: without
		// pinning, the chrome stays put and blank rows open up beneath it.
		terminal.resize(30, 9);
		await renderScheduler.advance(terminal, 2000);

		expect(painted(terminal)).toEqual(tail(provider, 9));
		tui.stop();
	});

	it("paints a fullscreen modal over the same screen and restores the conversation when it closes", async () => {
		const terminal = new RecordingTerminal(30, 5);
		const provider = new TranscriptProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		const modal = tui.showOverlay(new FullscreenModal(), { fullscreen: true });
		await renderScheduler.settle(terminal);
		expect(painted(terminal)).toContain("model picker");
		modal.hide();
		await renderScheduler.settle(terminal);

		expect(painted(terminal)).toEqual(tail(provider, 5));
		tui.stop();
		// One switch in at start, one out at stop: a modal that toggled the
		// buffer would drop the session onto the empty normal screen.
		const output = terminal.writes.join("");
		expect(count(output, "\x1b[?1049h")).toBe(1);
		expect(count(output, "\x1b[?1049l")).toBe(1);
		expect(output.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(output.lastIndexOf("model picker"));
	});
});

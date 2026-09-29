import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Fork feature: with PI_TUI_ALT_SCREEN=1 a phone swipe (SGR wheel report) must
// open the scrollback pager over the real conversation, and must never reach
// the editor as prompt-history navigation or typed text.

const WHEEL_UP = "\x1b[<64;5;3M";
const WHEEL_DOWN = "\x1b[<65;5;3M";
const TAP = ["\x1b[<0;5;3M", "\x1b[<3;5;3m"];

const plainRows = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row).trimEnd());

describe("scrollback pager wiring (PI_TUI_ALT_SCREEN)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let previousAlt: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		previousAlt = Bun.env.PI_TUI_ALT_SCREEN;
		Bun.env.PI_TUI_ALT_SCREEN = "1";
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-scrollback-wiring-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		if (previousAlt === undefined) delete Bun.env.PI_TUI_ALT_SCREEN;
		else Bun.env.PI_TUI_ALT_SCREEN = previousAlt;
	});

	async function start(): Promise<void> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		for (let index = 0; index < 200; index++) mode.chatContainer.addChild(new Text(`history-line-${index}`, 1, 0));
		mode.ui.requestRender();
		await term.waitForRender();
	}

	const shows = (text: string) => plainRows(term.getViewport()).some(row => row.includes(text));

	it("opens the pager on wheel-up at the end of the real conversation and leaves it on a typed key", async () => {
		await start();
		term.sendInput(WHEEL_UP);
		await term.waitForRender(() => shows("Scrollback"));
		// Opened on the last conversation rows, then moved back three.
		expect(shows("history-line-196")).toBe(true);
		expect(shows("history-line-199")).toBe(false);

		term.sendInput("x");
		await term.waitForRender(() => !shows("Scrollback"));
		expect(mode.editor.getText()).toBe("x");
	});

	it("swallows swipes and taps without opening anything when tui.scrollback is off", async () => {
		settings.set("tui.scrollback", "off");
		await start();
		for (const report of [WHEEL_UP, WHEEL_DOWN, ...TAP]) term.sendInput(report);
		await term.waitForRender();
		expect(shows("Scrollback")).toBe(false);
		expect(mode.editor.getText()).toBe("");
	});

	it("opens on PageUp from an empty editor but leaves PageUp to a multi-line draft", async () => {
		await start();
		mode.editor.setText("line one\nline two");
		term.sendInput("\x1b[5~");
		await term.waitForRender();
		expect(shows("Scrollback")).toBe(false);

		mode.editor.setText("");
		term.sendInput("\x1b[5~");
		await term.waitForRender(() => shows("Scrollback"));
		expect(shows("history-line-199")).toBe(true);
	});
});

describe("inline scrollback wiring (PI_TUI_ALT_SCREEN, tui.scrollback: inline)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let previousAlt: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		previousAlt = Bun.env.PI_TUI_ALT_SCREEN;
		Bun.env.PI_TUI_ALT_SCREEN = "1";
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-scrollback-inline-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		settings.set("tui.scrollback", "inline");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		for (let index = 0; index < 200; index++) mode.chatContainer.addChild(new Text(`history-line-${index}`, 1, 0));
		mode.ui.requestRender();
		await term.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		if (previousAlt === undefined) delete Bun.env.PI_TUI_ALT_SCREEN;
		else Bun.env.PI_TUI_ALT_SCREEN = previousAlt;
	});

	const shows = (text: string) => plainRows(term.getViewport()).some(row => row.includes(text));
	const lastHistoryLine = () => {
		const numbers = plainRows(term.getViewport())
			.map(row => /history-line-(\d+)/.exec(row)?.[1])
			.filter((value): value is string => value !== undefined)
			.map(Number);
		return numbers.at(-1);
	};

	it("scrolls the live screen in place, keeps typing in the editor, and returns to the tail", async () => {
		expect(lastHistoryLine()).toBe(199);
		term.sendInput(WHEEL_UP);
		await term.waitForRender(() => shows("scrolled back"));
		const scrolledTo = lastHistoryLine();
		expect(scrolledTo).toBeLessThan(199);
		// No pager: this is the live screen with the editor still on it.
		expect(shows("Scrollback")).toBe(false);

		term.sendInput("x");
		await term.waitForRender();
		expect(mode.editor.getText()).toBe("x");
		expect(lastHistoryLine()).toBe(scrolledTo);

		term.sendInput(WHEEL_DOWN);
		await term.waitForRender(() => !shows("scrolled back"));
		expect(lastHistoryLine()).toBe(199);
		expect(mode.editor.getText()).toBe("x");
	});

	it("pages with PageUp and returns to the tail with End", async () => {
		term.sendInput("\x1b[5~");
		await term.waitForRender(() => shows("scrolled back"));
		const paged = lastHistoryLine()!;
		expect(199 - paged).toBeGreaterThan(8);

		term.sendInput("\x1b[6~");
		await term.waitForRender(() => !shows("scrolled back"));
		expect(lastHistoryLine()).toBe(199);

		term.sendInput("\x1b[5~");
		await term.waitForRender(() => shows("scrolled back"));
		term.sendInput("\x1b[F");
		await term.waitForRender(() => !shows("scrolled back"));
		expect(lastHistoryLine()).toBe(199);
	});

	it("holds the view while output streams in and counts the new lines", async () => {
		term.sendInput(WHEEL_UP);
		await term.waitForRender(() => shows("scrolled back"));
		const scrolledTo = lastHistoryLine();

		for (let index = 200; index < 212; index++) mode.chatContainer.addChild(new Text(`history-line-${index}`, 1, 0));
		await Bun.sleep(150);
		mode.ui.requestRender();
		await term.waitForRender(() => shows("24 new lines"));
		expect(shows("24 new lines")).toBe(true);
		expect(lastHistoryLine()).toBe(scrolledTo);
	});
});

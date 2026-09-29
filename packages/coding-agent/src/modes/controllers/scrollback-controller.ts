import { ScrollbackPager, type ScrollbackSnapshot, WHEEL_STEP } from "@oh-my-pi/pi-tui/overlays/scrollback-pager";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { settings } from "../../config/settings";
import type { InteractiveModeContext } from "../types";

/**
 * Fork feature (`PI_TUI_ALT_SCREEN=1`): opens the scrollback pager over the
 * live screen. The alternate screen has no native scrollback, so wheel-up
 * (a phone swipe) or the `app.scrollback.open` key shows the whole
 * conversation instead of it scrolling off the top.
 */
export class ScrollbackController {
	#pager: ScrollbackPager | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** Active scrollback mode: off outside host-alt mode or when `tui.scrollback` is off. */
	get mode(): "off" | "pager" | "inline" {
		return this.ctx.ui.isHostAltScreen() ? settings.get("tui.scrollback") : "off";
	}

	/** Whether the pager may open (pager and inline modes). */
	get enabled(): boolean {
		return this.mode !== "off";
	}

	/**
	 * Wheel on the live screen. Pager mode opens the pager on wheel-up; inline
	 * mode scrolls the live screen in place. Returns true when consumed.
	 */
	handleWheel(direction: -1 | 1): boolean {
		if (this.ctx.ui.hasOverlay()) return false;
		switch (this.mode) {
			case "pager":
				if (direction !== -1) return false;
				this.open(-WHEEL_STEP);
				return true;
			case "inline":
				this.ctx.composer.scrollBy(direction * WHEEL_STEP);
				return true;
			default:
				return false;
		}
	}

	/** Keys that drive scrollback from the editor; yields to the editor when it owns them. */
	handleKey(data: string): boolean {
		const mode = this.mode;
		if (mode === "off" || this.ctx.ui.hasOverlay()) return false;
		if (this.ctx.ui.getFocused() !== this.ctx.editor) return false;
		const keys = this.ctx.keybindings;
		if (keys.matches(data, "app.scrollback.pager") && this.editorYields()) {
			this.open(0);
			return true;
		}
		if (mode === "pager") {
			if (!keys.matches(data, "app.scrollback.open") || !this.editorYields()) return false;
			this.open(0);
			return true;
		}
		const composer = this.ctx.composer;
		if (matchesKey(data, "pageUp") && this.editorYields()) {
			composer.scrollPage(-1);
			return true;
		}
		if (composer.scrolledBack) {
			if (matchesKey(data, "pageDown") && this.editorYields()) {
				composer.scrollPage(1);
				return true;
			}
			if (matchesKey(data, "end")) {
				composer.scrollToTail();
				return true;
			}
			// Sending the prompt returns to the live tail; the key still reaches the editor.
			if (matchesKey(data, "enter")) composer.scrollToTail();
		}
		return false;
	}

	/** A multi-line draft (or an open completion list) pages with PageUp/PageDown itself. */
	editorYields(): boolean {
		return !this.ctx.editor.getText().includes("\n") && !this.ctx.editor.isShowingAutocomplete();
	}

	open(initialScroll: number): void {
		if (this.#pager) return;
		const chat = this.ctx.chatContainer;
		const snapshot = (width: number): ScrollbackSnapshot => {
			const lines = chat.render(width);
			const blockStarts: number[] = [];
			for (const child of chat.children) {
				const start = chat.getChildStartRow(child);
				if (start !== undefined) blockStarts.push(start);
			}
			return { lines, blockStarts: blockStarts.sort((a, b) => a - b) };
		};
		const close = () => {
			overlay.hide();
			pager.dispose();
			this.#pager = undefined;
			this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const pager = new ScrollbackPager({
			snapshot,
			getHeight: () => this.ctx.ui.terminal.rows,
			requestRender: () => this.ctx.ui.requestRender(),
			onClose: close,
			onForwardKey: data => this.ctx.editor.handleInput(data),
		});
		const overlay = this.ctx.ui.showOverlay(pager, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: true,
		});
		this.#pager = pager;
		if (initialScroll !== 0) pager.scroll(initialScroll);
		this.ctx.ui.setFocus(pager);
		this.ctx.ui.requestRender();
	}
}

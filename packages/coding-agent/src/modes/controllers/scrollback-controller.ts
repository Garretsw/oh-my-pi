import { ScrollbackPager, type ScrollbackSnapshot, WHEEL_STEP } from "@oh-my-pi/pi-tui/overlays/scrollback-pager";
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

	/** Whether the pager may open: host-alt mode and `tui.scrollback` = pager. */
	get enabled(): boolean {
		return this.ctx.ui.isHostAltScreen() && settings.get("tui.scrollback") === "pager";
	}

	/** Wheel-up on the live screen opens the pager and applies that first step. */
	openOnWheelUp(): boolean {
		if (!this.enabled || this.ctx.ui.hasOverlay()) return false;
		this.open(-WHEEL_STEP);
		return true;
	}

	/** The `app.scrollback.open` key; yields to the editor when it owns PageUp. */
	openOnKey(data: string): boolean {
		if (!this.enabled || this.ctx.ui.hasOverlay()) return false;
		if (this.ctx.ui.getFocused() !== this.ctx.editor) return false;
		if (!this.ctx.keybindings.matches(data, "app.scrollback.open")) return false;
		// A multi-line draft (or an open completion list) pages with PageUp.
		if (this.ctx.editor.getText().includes("\n") || this.ctx.editor.isShowingAutocomplete()) return false;
		this.open(0);
		return true;
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

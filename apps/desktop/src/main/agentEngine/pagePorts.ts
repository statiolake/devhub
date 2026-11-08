/**
 * Each page's `MessagePort` to the conversation engine: one per page per
 * engine, made when an attach first needs it, one end handed to the engine
 * and the other to the page (`CONVERSATION_CHANNELS.port`).
 */

import type { WebContents } from "electron";
import { CONVERSATION_CHANNELS } from "../../ipc/conversation.js";
import { electron } from "../electron.js";
import type { PagePorts } from "../shell/conversationIpc.js";
import type { EngineClient } from "./client.js";

export function enginePagePorts(engine: EngineClient): PagePorts {
	const handed = new WeakMap<
		WebContents,
		{ readonly generation: number; readonly page: number }
	>();
	return {
		portFor(page) {
			const known = handed.get(page);
			if (known?.generation === engine.generation) return known.generation;
			if (known !== undefined) engine.pageGone(known.page);
			const { port1, port2 } = new electron.MessageChannelMain();
			const id = engine.attachPage(port1);
			// After `attachPage`, which starts an engine if there was none.
			const generation = engine.generation;
			page.postMessage(CONVERSATION_CHANNELS.port, { generation }, [port2]);
			handed.set(page, { generation, page: id });
			return generation;
		},
		gone(page) {
			const known = handed.get(page);
			if (known === undefined) return;
			handed.delete(page);
			engine.pageGone(known.page);
		},
		onReplaced(listener) {
			engine.onRestarted(listener);
			engine.onGaveUp(listener);
		},
	};
}

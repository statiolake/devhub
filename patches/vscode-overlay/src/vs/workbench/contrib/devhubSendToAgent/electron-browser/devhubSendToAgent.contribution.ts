/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: "Send to Agent…" in the app — the command (../browser/
// devhubSendToAgent.ts) and the one place its payload leaves the workbench:
// `vscode:devhubSendToAgent` to DevHub's main process
// (apps/desktop/src/main/shell/sendToAgent.ts), which knows which Workspace
// this workbench is and asks the rest.

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDevhubAgentSink, SendToAgentAction } from '../browser/devhubSendToAgent.js';
import { SEND_TO_AGENT_CHANNEL, SendToAgentPayload } from '../common/sendToAgentPayload.js';

class DevhubAgentSink implements IDevhubAgentSink {
	declare readonly _serviceBrand: undefined;

	send(payload: SendToAgentPayload): void {
		ipcRenderer.send(SEND_TO_AGENT_CHANNEL, payload);
	}
}

registerSingleton(IDevhubAgentSink, DevhubAgentSink, InstantiationType.Delayed);
registerAction2(SendToAgentAction);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: no secondary side bar — what lands there is moved to the primary
// side bar, as a person's move is.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { DevhubNoAuxiliaryBar, moveAuxiliaryBarToSidebar, NO_AUXILIARY_BAR_MOVE_REASON } from '../../browser/devhubNoAuxiliaryBar.contribution.js';

type Move = { id: string; location: ViewContainerLocation; index: number | undefined; reason: string | undefined };

class FakeViewDescriptorService extends mock<IViewDescriptorService>() {
	readonly locations = new Map<string, ViewContainerLocation>();
	readonly moves: Move[] = [];
	readonly containersChanged = new Emitter<{ added: ReadonlyArray<{ container: ViewContainer; location: ViewContainerLocation }>; removed: ReadonlyArray<{ container: ViewContainer; location: ViewContainerLocation }> }>();
	readonly containerLocationChanged = new Emitter<{ viewContainer: ViewContainer; from: ViewContainerLocation; to: ViewContainerLocation }>();
	override readonly onDidChangeViewContainers = this.containersChanged.event;
	override readonly onDidChangeContainerLocation = this.containerLocationChanged.event;

	constructor(private readonly containers: ViewContainer[]) {
		super();
	}

	/** Put a container somewhere the way a move from elsewhere does, and say so. */
	place(container: ViewContainer, to: ViewContainerLocation): void {
		const from = this.locationOf(container);
		this.locations.set(container.id, to);
		this.containerLocationChanged.fire({ viewContainer: container, from, to });
	}

	register(container: ViewContainer, location: ViewContainerLocation): void {
		this.containers.push(container);
		this.locations.set(container.id, location);
		this.containersChanged.fire({ added: [{ container, location }], removed: [] });
	}

	private locationOf(container: ViewContainer): ViewContainerLocation {
		return this.locations.get(container.id) ?? ViewContainerLocation.Sidebar;
	}

	override getViewContainersByLocation(location: ViewContainerLocation): ViewContainer[] {
		return this.containers.filter(container => this.locationOf(container) === location);
	}

	override moveViewContainerToLocation(viewContainer: ViewContainer, location: ViewContainerLocation, requestedIndex?: number, reason?: string): void {
		this.moves.push({ id: viewContainer.id, location, index: requestedIndex, reason });
		this.locations.set(viewContainer.id, location);
	}

	dispose(): void {
		this.containersChanged.dispose();
		this.containerLocationChanged.dispose();
	}
}

function container(id: string): ViewContainer {
	return { id } as ViewContainer;
}

const microtask = () => new Promise<void>(resolve => queueMicrotask(resolve));

suite('DevHub: no secondary side bar', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('moves every container in the secondary side bar to the primary side bar, in order, and nothing else', () => {
		const explorer = container('explorer'), chat = container('chat'), generated = container('generated'), terminal = container('terminal');
		const service = new FakeViewDescriptorService([explorer, chat, generated, terminal]);
		service.locations.set(chat.id, ViewContainerLocation.AuxiliaryBar);
		service.locations.set(generated.id, ViewContainerLocation.AuxiliaryBar);
		service.locations.set(terminal.id, ViewContainerLocation.Panel);

		assert.deepStrictEqual(moveAuxiliaryBarToSidebar(service).map(({ id }) => id), ['chat', 'generated']);
		assert.deepStrictEqual(service.moves, [
			{ id: 'chat', location: ViewContainerLocation.Sidebar, index: undefined, reason: NO_AUXILIARY_BAR_MOVE_REASON },
			{ id: 'generated', location: ViewContainerLocation.Sidebar, index: undefined, reason: NO_AUXILIARY_BAR_MOVE_REASON },
		]);
		assert.deepStrictEqual(service.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar), []);
		assert.deepStrictEqual(service.getViewContainersByLocation(ViewContainerLocation.Panel), [terminal]);
		service.dispose();
	});

	test('on startup, and then a microtask after a container is registered in or moved to the secondary side bar', async () => {
		const restored = container('restored'), late = container('late'), moved = container('moved'), panel = container('panel');
		const service = new FakeViewDescriptorService([restored, moved]);
		service.locations.set(restored.id, ViewContainerLocation.AuxiliaryBar);
		const contribution = disposables.add(new DevhubNoAuxiliaryBar(service));
		assert.deepStrictEqual(service.moves.map(({ id }) => id), ['restored']);

		service.register(late, ViewContainerLocation.AuxiliaryBar);
		service.place(moved, ViewContainerLocation.AuxiliaryBar);
		service.register(panel, ViewContainerLocation.Panel);
		assert.deepStrictEqual(service.moves.map(({ id }) => id), ['restored'], 'not while the event that put them there is still being delivered');
		await microtask();
		assert.deepStrictEqual(service.moves.map(({ id }) => id), ['restored', 'moved', 'late'], 'one pass for both, in the order the service lists them');
		assert.deepStrictEqual(service.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar), []);

		service.place(moved, ViewContainerLocation.Panel);
		await microtask();
		assert.deepStrictEqual(service.moves.map(({ id }) => id), ['restored', 'moved', 'late'], 'a move anywhere else is left alone');

		contribution.dispose();
		service.place(moved, ViewContainerLocation.AuxiliaryBar);
		await microtask();
		assert.deepStrictEqual(service.moves.map(({ id }) => id), ['restored', 'moved', 'late'], 'nothing after it is disposed');
		service.dispose();
	});
});

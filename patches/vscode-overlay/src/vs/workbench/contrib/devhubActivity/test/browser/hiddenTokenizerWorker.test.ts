/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { HiddenTokenizerWorker, IDLE_MS, PageVisibility, TokenizerWorker } from '../../browser/hiddenTokenizerWorker.js';

class FakePage implements PageVisibility {
	private readonly emitter = new Emitter<void>();
	readonly onDidChange = this.emitter.event;
	constructor(public hidden: boolean) { }
	set(hidden: boolean): void {
		this.hidden = hidden;
		this.emitter.fire();
	}
	dispose(): void {
		this.emitter.dispose();
	}
}

/** A worker that is there until released, and busy when told. */
class FakeWorker implements TokenizerWorker {
	readonly calls: string[] = [];
	present = true;
	busy = false;
	releaseTokenizerWorker(idleForMs: number): boolean {
		const released = this.present && (idleForMs === 0 || !this.busy);
		this.calls.push(`release(${idleForMs})${released ? '' : ' kept'}`);
		this.present &&= !released;
		return released;
	}
	resumeTokenizerWorker(): void {
		this.calls.push('resume');
	}
}

suite('DevHub: a hidden workbench gives back its TextMate worker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: sinon.SinonFakeTimers;

	setup(() => clock = sinon.useFakeTimers());
	teardown(() => clock.restore());

	function start(hidden: boolean) {
		const page = store.add(new FakePage(hidden));
		const worker = new FakeWorker();
		const policy = store.add(new HiddenTokenizerWorker(worker, page));
		return { page, worker, policy };
	}

	test('nothing while shown: no timer, and the probe does nothing', () => {
		const { worker, policy } = start(false);
		assert.strictEqual(policy.beforeFreeze(), false);
		clock.tick(10 * IDLE_MS);
		assert.deepStrictEqual(worker.calls, []);
	});

	test('hidden: released before the freeze, once per hiding; resumed when shown', () => {
		const { page, worker, policy } = start(false);
		page.set(true);
		clock.tick(3_000);
		assert.strictEqual(policy.beforeFreeze(), true);
		assert.strictEqual(policy.beforeFreeze(), false, 'a busy workbench is probed again: once is enough');
		assert.deepStrictEqual(worker.calls, ['release(0)']);

		page.set(false);
		assert.deepStrictEqual(worker.calls, ['release(0)', 'resume']);
		clock.tick(10 * IDLE_MS);
		assert.deepStrictEqual(worker.calls, ['release(0)', 'resume'], 'shown: nothing more');

		// The next hiding is a new one.
		worker.present = true;
		page.set(true);
		assert.strictEqual(policy.beforeFreeze(), true);
	});

	test('hidden and not frozen: released once the worker has been idle; again after an edit restarted it', () => {
		const { page, worker } = start(false);
		page.set(true);
		worker.busy = true;
		clock.tick(IDLE_MS - 1);
		assert.deepStrictEqual(worker.calls, []);
		clock.tick(1);
		assert.deepStrictEqual(worker.calls, [`release(${IDLE_MS}) kept`]);
		worker.busy = false;
		clock.tick(IDLE_MS);
		assert.deepStrictEqual(worker.calls, [`release(${IDLE_MS}) kept`, `release(${IDLE_MS})`]);

		worker.present = true; // an agent's edit, on disk, started a new one
		clock.tick(IDLE_MS);
		assert.deepStrictEqual(worker.calls.slice(2), [`release(${IDLE_MS})`]);
		assert.strictEqual(worker.present, false);
	});

	test('a short hiding does nothing, and showing again stops the timer', () => {
		const { page, worker } = start(false);
		for (let i = 0; i < 5; i++) {
			page.set(true);
			clock.tick(IDLE_MS / 2);
			page.set(false);
			clock.tick(IDLE_MS / 2);
		}
		assert.deepStrictEqual(worker.calls, [], 'no release and no resume');
	});

	test('a workbench started hidden is looked after from the start', () => {
		const { page, worker } = start(true);
		clock.tick(IDLE_MS);
		assert.deepStrictEqual(worker.calls, [`release(${IDLE_MS})`]);
		page.set(false);
		assert.deepStrictEqual(worker.calls, [`release(${IDLE_MS})`, 'resume']);
	});
});

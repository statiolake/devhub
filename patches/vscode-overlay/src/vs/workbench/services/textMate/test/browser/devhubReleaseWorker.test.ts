/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the TextMate worker can be ended and a new one takes over
// (patches/vscode/0015-textmate-worker-can-be-released.patch). The worker here
// is the real TextMateTokenizationWorker with real Oniguruma, run in this
// thread behind an asynchronous proxy, so what crosses the boundary — and when
// — is what crosses it to the real worker.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IWebWorkerClient, IWebWorkerServer } from '../../../../../base/common/worker/webWorker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EncodedTokenizationResult, IBackgroundTokenizationStore, IBackgroundTokenizer, IState, ITokenizationSupport, TokenizationRegistry } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { NullState } from '../../../../../editor/common/languages/nullTokenize.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { BackgroundTokenizationState } from '../../../../../editor/common/tokenizationTextModelPart.js';
import { StandardTokenType } from '../../../../../editor/common/encodedTokenAttributes.js';
import { createModelServices, instantiateTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IWebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerService.js';
import { ThreadedBackgroundTokenizerFactory } from '../../browser/backgroundTokenization/threadedBackgroundTokenizerFactory.js';
import { create, TextMateTokenizationWorker } from '../../browser/backgroundTokenization/worker/textMateTokenizationWorker.worker.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';

const LANGUAGE = 'devhubReleaseWorker';
const GRAMMAR = URI.file('/devhub-test/devhubReleaseWorker.tmLanguage.json');
const GRAMMAR_JSON = JSON.stringify({
	scopeName: 'source.devhubReleaseWorker',
	patterns: [
		{ begin: '/\\*', end: '\\*/', name: 'comment.block.test' },
		{ match: '"[^"]*"', name: 'string.quoted.test' },
	],
});

/** Every call after the ones before it, never in the caller's turn: as postMessage. */
function asyncProxy<T extends object>(target: () => T | undefined): T {
	let queue: Promise<unknown> = Promise.resolve();
	return new Proxy({}, {
		// Not a thenable: an async function returns the proxy itself.
		get: (_, name) => name === 'then' ? undefined : (...args: unknown[]) => {
			const call = queue.then(() => new Promise(resolve => setTimeout(resolve, 0))).then(() => {
				const object = target() as Record<string | symbol, (...a: unknown[]) => unknown> | undefined;
				if (!object) {
					return new Promise(() => { }); // ended: no answer, as from a terminated worker
				}
				return object[name](...args);
			});
			queue = call.catch(() => undefined);
			return call;
		},
	}) as T;
}

/**
 * A terminated worker takes everything it holds with it, so the worker never
 * disposes some of it; one in this thread has to be cleared by hand.
 */
function terminate(worker: TextMateTokenizationWorker, grammarFactory: IDisposable | null): void {
	type Support = IDisposable & { _actual?: IDisposable };
	type Model = IDisposable & { _tokenizerWithStateStore?: { tokenizationSupport: Support } | null };
	const held = worker as unknown as { _models: Map<number, Model> };
	for (const model of held._models.values()) {
		const support = model._tokenizerWithStateStore?.tokenizationSupport;
		support?._actual?.dispose();
		support?.dispose();
		model.dispose();
	}
	held._models.clear();
	grammarFactory?.dispose();
}

/** Workers that run in this thread; `live` is how many have not been ended. */
class InThreadWorkerService implements IWebWorkerService {
	declare readonly _serviceBrand: undefined;
	created = 0;
	live = 0;

	createWorkerClient<T extends object>(): IWebWorkerClient<T> {
		this.created++;
		this.live++;
		const hostChannels = new Map<string, object>();
		let worker: TextMateTokenizationWorker | undefined;
		const server: IWebWorkerServer = {
			setChannel: () => { },
			getChannel: <C extends object>(name: string) => asyncProxy<C>(() => worker && hostChannels.get(name) as C | undefined) as never,
		};
		worker = create(server);
		const held = worker as unknown as { _grammarFactory: Promise<IDisposable | null> };
		let grammarFactory: IDisposable | null = null;
		const init = worker.$init.bind(worker);
		worker.$init = async createData => {
			await init(createData);
			held._grammarFactory.then(factory => grammarFactory = factory, () => { });
		};
		const service = this;
		return {
			proxy: asyncProxy(() => worker) as never,
			setChannel: (name, handler) => { hostChannels.set(name, handler); },
			getChannel: () => { throw new Error('not used'); },
			dispose() {
				if (worker) {
					terminate(worker, grammarFactory);
					worker = undefined;
					service.live--;
				}
			},
		};
	}

	getWorkerUrl(): string {
		return '';
	}
}

/** The main thread's half: no tokens of its own, the worker's in the background. */
class BackgroundOnlySupport implements ITokenizationSupport {
	constructor(private readonly factory: ThreadedBackgroundTokenizerFactory) { }
	getInitialState(): IState { return NullState; }
	tokenize(): never { throw new Error('not used'); }
	tokenizeEncoded(_line: string, _hasEOL: boolean, state: IState): EncodedTokenizationResult {
		return new EncodedTokenizationResult(new Uint32Array(0), [], state);
	}
	createBackgroundTokenizer(textModel: ITextModel, store: IBackgroundTokenizationStore): IBackgroundTokenizer | undefined {
		return this.factory.createBackgroundTokenizer(textModel, store, constObservable(20_000));
	}
}

type Kind = 'c' | 's' | '-';

/** One line's token kinds: comment, string or other. */
function kindsOf(model: ITextModel, line: number): string {
	const tokens = model.tokenization.getLineTokens(line);
	let kinds = '';
	for (let i = 0; i < tokens.getCount(); i++) {
		const type = tokens.getStandardTokenType(i);
		const kind: Kind = type === StandardTokenType.Comment ? 'c' : type === StandardTokenType.String ? 's' : '-';
		kinds += kind;
	}
	return kinds;
}

/** Each line's token kinds. */
function kinds(model: ITextModel): string[] {
	return Array.from({ length: model.getLineCount() }, (_, i) => kindsOf(model, i + 1));
}

async function until(what: string, condition: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) {
			assert.fail(`timed out waiting for ${what}`);
		}
		await timeout(5);
	}
}

/** Nothing more is coming: every queued call has run. */
function settle(): Promise<void> {
	return timeout(50);
}

suite('DevHub: the TextMate worker can be released', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;
	let workers: InThreadWorkerService;
	let factory: ThreadedBackgroundTokenizerFactory;

	setup(() => {
		disposables = store.add(new DisposableStore());
		workers = new InThreadWorkerService();
		instantiationService = createModelServices(disposables, [
			[IEnvironmentService, new class extends mock<IEnvironmentService>() {
				override isBuilt = false;
			}],
			[IExtensionResourceLoaderService, new class extends mock<IExtensionResourceLoaderService>() {
				override async readExtensionResource(uri: URI): Promise<string> {
					assert.strictEqual(uri.toString(), GRAMMAR.toString());
					return GRAMMAR_JSON;
				}
			}],
			[ITelemetryService, NullTelemetryService],
			[IWebWorkerService, workers],
		]);
		disposables.add(instantiationService.get(ILanguageService).registerLanguage({ id: LANGUAGE }));
		factory = instantiationService.createInstance(ThreadedBackgroundTokenizerFactory, () => { }, () => true);
		disposables.add(factory);
		factory.setGrammarDefinitions([{
			location: GRAMMAR,
			language: LANGUAGE,
			scopeName: 'source.devhubReleaseWorker',
			embeddedLanguages: {},
			tokenTypes: {},
			balancedBracketSelectors: ['*'],
			unbalancedBracketSelectors: [],
		}]);
		disposables.add(TokenizationRegistry.register(LANGUAGE, new BackgroundOnlySupport(factory)));
	});

	function openInEditor(text: string): ITextModel {
		const model = instantiateTextModel(instantiationService, text, LANGUAGE);
		const view = model.onBeforeAttached();
		disposables.add(toDisposable(() => {
			model.onBeforeDetached(view);
			model.dispose();
		}));
		return model;
	}

	test('an edit after a release is tokenized by a new worker, to the last line', async function () {
		this.timeout(60_000);
		const model = openInEditor('a\n"s"\nb\nc');
		await until('the first tokens', () => kinds(model).join('|') === '-|s|-|-');
		assert.strictEqual(workers.created, 1);

		assert.strictEqual(factory.releaseWorker(0), true);
		assert.strictEqual(workers.live, 0);
		assert.deepStrictEqual(kinds(model), ['-', 's', '-', '-'], 'the tokens it has stay');
		await settle();
		assert.strictEqual(workers.created, 1, 'nothing starts a worker by itself');

		// Opening a block comment on the first line turns every line after it.
		model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '/*' }]);
		await until('the comment to reach the last line', () => kinds(model).join('|') === 'c|c|c|c');
		assert.strictEqual(workers.created, 2);
		assert.strictEqual(workers.live, 1);

		// And the new worker follows later edits like the first one did.
		model.applyEdits([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: '*/' }]);
		await until('the comment to close', () => kinds(model).join('|') === 'c|cs|-|-');
		assert.strictEqual(workers.created, 2);
	});

	test('a model no worker finished is bound again when resumed; a finished one waits', async function () {
		this.timeout(60_000);
		const finished = openInEditor('"a"\nb');
		await until('the small model', () => finished.tokenization.backgroundTokenizationState === BackgroundTokenizationState.Completed);

		// Big enough that the worker sends it in many batches.
		const lines = Array.from({ length: 20_000 }, (_, i) => i === 0 ? '/*' : `line ${i} "x"`);
		const big = openInEditor(lines.join('\n'));
		await until('the first batch', () => kindsOf(big, 2) === 'c');
		assert.notStrictEqual(big.tokenization.backgroundTokenizationState, BackgroundTokenizationState.Completed);

		assert.strictEqual(factory.releaseWorker(0), true);
		await settle();
		assert.notStrictEqual(big.tokenization.backgroundTokenizationState, BackgroundTokenizationState.Completed, 'released before the end');
		const created = workers.created;

		factory.resumeWorker();
		await until('the big model to finish on a new worker', () => big.tokenization.backgroundTokenizationState === BackgroundTokenizationState.Completed, 60_000);
		assert.strictEqual(workers.created, created + 1);
		assert.strictEqual(kindsOf(big, big.getLineCount()), 'c');

		assert.strictEqual(factory.releaseWorker(0), true);
		factory.resumeWorker();
		await settle();
		assert.strictEqual(workers.created, created + 1, 'both finished: resuming starts nothing');
	});

	test('a model no editor shows needs no worker; opening it in one starts it', async function () {
		this.timeout(60_000);
		const model = disposables.add(instantiateTextModel(instantiationService, '"a"', LANGUAGE));
		await settle();
		assert.strictEqual(workers.created, 0);

		const view = model.onBeforeAttached();
		await until('its tokens', () => kinds(model)[0] === 's');
		assert.strictEqual(workers.created, 1);

		assert.strictEqual(factory.releaseWorker(0), true);
		model.onBeforeDetached(view);
		model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '/*' }]);
		await settle();
		assert.strictEqual(workers.created, 1, 'an edit of a model no editor shows starts nothing');

		const again = model.onBeforeAttached();
		await until('the edit to be tokenized', () => kinds(model)[0] === 'c');
		assert.strictEqual(workers.created, 2);
		model.onBeforeDetached(again);
	});

	test('a worker that sent something recently is kept', async function () {
		this.timeout(60_000);
		const model = openInEditor('"a"');
		await until('its tokens', () => kinds(model)[0] === 's');
		assert.strictEqual(factory.releaseWorker(60_000), false);
		assert.strictEqual(workers.live, 1);
		assert.strictEqual(factory.releaseWorker(0), true);
		assert.strictEqual(factory.releaseWorker(0), false, 'no worker, nothing to release');
	});
});

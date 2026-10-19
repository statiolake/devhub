/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// The parts of DevHub's init.ts that do not need VS Code: where the file is,
// turning it into JavaScript (TypeScript's transpileModule, with a source
// map), running it with `vscode` and `devhub` to import, and mapping a stack
// back to init.ts. extension.js wires them to the extension host.
//
// init.ts may only define commands: the one thing the `devhub` module has is
// defineCommand(id, handler, { title }). The ids are `user.<name>`. A run
// collects them and nothing is registered until the whole file has run, so a
// file that throws halfway changes nothing (the previous commands stay).

const path = require('path');
const vm = require('vm');
const Module = require('module');

const FILE_NAME = 'init.ts';
const COMMAND_ID = /^user\.[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * `<configDirectory>/init.ts`, DevHub's model/profile.ts configDirectory:
 * DevHub's main process puts it in DEVHUB_CONFIG_DIR (the extension host
 * inherits it); without that (VS Code run on its own) the same rule:
 * `$XDG_CONFIG_HOME` (when absolute) or `~/.config`, then `devhub`, or
 * `devhub-<profile>` for a DEVHUB_PROFILE other than `default`.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} home
 */
function configDirectory(env, home) {
	const explicit = env['DEVHUB_CONFIG_DIR'];
	if (explicit && path.isAbsolute(explicit)) {
		return explicit;
	}
	const xdg = env['XDG_CONFIG_HOME'];
	const root = xdg && xdg.startsWith('/') ? xdg : path.join(home, '.config');
	const profile = env['DEVHUB_PROFILE'];
	return path.join(root, !profile || profile === 'default' ? 'devhub' : `devhub-${profile}`);
}

class InitError extends Error { }

/**
 * TypeScript to CommonJS, as TypeScript's transpileModule does it (no type
 * check: only syntax errors stop it, the editor shows the type errors).
 *
 * @param {any} ts the typescript module
 * @param {string} source
 * @param {string} fileName the absolute path of init.ts
 * @returns {{ code: string; map: string }}
 */
function transpile(ts, source, fileName) {
	const out = ts.transpileModule(source, {
		fileName,
		reportDiagnostics: true,
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			sourceMap: true,
			strict: true,
		},
	});
	const errors = (out.diagnostics ?? []).filter((/** @type {any} */ d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) {
		const lines = errors.map((/** @type {any} */ d) => {
			const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
			if (d.file && d.start !== undefined) {
				const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
				return `${fileName}:${line + 1}:${character + 1}: ${text}`;
			}
			return `${fileName}: ${text}`;
		});
		const error = new InitError(lines[0] + (lines.length > 1 ? ` (and ${lines.length - 1} more)` : ''));
		error.stack = lines.join('\n');
		throw error;
	}
	return { code: out.outputText.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'), map: out.sourceMapText ?? '' };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * A source map's `mappings`, decoded: for each generated line (0-based), its
 * segments `[generatedColumn, sourceLine, sourceColumn]` (0-based).
 *
 * @param {string} map the source map's JSON
 * @returns {number[][][]}
 */
function decodeMappings(map) {
	/** @type {string} */
	let mappings = '';
	try {
		mappings = JSON.parse(map).mappings ?? '';
	} catch {
		return [];
	}
	/** @type {number[][][]} */
	const lines = [];
	let sourceLine = 0, sourceColumn = 0;
	for (const lineText of mappings.split(';')) {
		/** @type {number[][]} */
		const segments = [];
		let generatedColumn = 0;
		for (const segment of lineText.split(',')) {
			if (!segment) {
				continue;
			}
			/** @type {number[]} */
			const values = [];
			let value = 0, shift = 0;
			for (const ch of segment) {
				const digit = BASE64.indexOf(ch);
				value += (digit & 31) << shift;
				if (digit & 32) {
					shift += 5;
				} else {
					values.push(value & 1 ? -(value >>> 1) : value >>> 1);
					value = 0;
					shift = 0;
				}
			}
			generatedColumn += values[0];
			if (values.length >= 4) {
				sourceLine += values[2];
				sourceColumn += values[3];
				segments.push([generatedColumn, sourceLine, sourceColumn]);
			}
		}
		lines.push(segments);
	}
	return lines;
}

/**
 * Where generated `line:column` (1-based, as a stack has them) came from in
 * init.ts (1-based), or undefined.
 *
 * @param {number[][][]} decoded
 * @param {number} line
 * @param {number} column
 */
function originalPosition(decoded, line, column) {
	const segments = decoded[line - 1];
	if (!segments || !segments.length) {
		return undefined;
	}
	let best = segments[0];
	for (const s of segments) {
		if (s[0] <= column - 1) {
			best = s;
		} else {
			break;
		}
	}
	return { line: best[1] + 1, column: best[2] + 1 };
}

// The CommonJS wrapper, on the generated code's first line so that line
// numbers stay as they are (columns on that line move by its length).
const WRAPPER = '(function (exports, require, module, __filename, __dirname) {';

/**
 * A stack's `init.ts:line:column` (the generated code's) as init.ts's own.
 *
 * @param {string} stack
 * @param {string} fileName
 * @param {number[][][]} decoded
 */
function mapStack(stack, fileName, decoded) {
	const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return stack.replace(new RegExp(`${escaped}:(\\d+):(\\d+)`, 'g'), (whole, l, c) => {
		const line = Number(l);
		const column = Number(c) - (line === 1 ? WRAPPER.length : 0);
		const p = originalPosition(decoded, line, column);
		return p ? `${fileName}:${p.line}:${p.column}` : whole;
	});
}

/** @param {unknown} e */
function errorText(e) {
	return e instanceof Error ? e.message : String(e);
}

/**
 * @typedef {{ id: string; title?: string; handler: (...args: any[]) => unknown }} UserCommand
 */

/**
 * Runs init.ts's JavaScript: `import ... from "vscode"` is the given API,
 * `"devhub"` the defineCommand helper; anything else is Node's require from
 * the config directory. Returns the commands it defined. Throws (with the
 * stack mapped to init.ts) when it throws or defines a command wrongly.
 * `mapStack` maps a later error's stack (a command's) the same way.
 *
 * @param {{ code: string; map: string }} compiled
 * @param {string} fileName
 * @param {unknown} vscodeApi
 * @returns {{ commands: UserCommand[]; mapStack: (stack: string) => string }}
 */
function runInit(compiled, fileName, vscodeApi) {
	const decoded = decodeMappings(compiled.map);
	/** @type {Map<string, UserCommand>} */
	const commands = new Map();
	let running = true;
	const devhub = Object.freeze({
		/**
		 * @param {string} id
		 * @param {(...args: any[]) => unknown} handler
		 * @param {{ title?: string }} [options]
		 */
		defineCommand(id, handler, options) {
			if (!running) {
				throw new InitError('defineCommand: commands are defined while init.ts runs, not later');
			}
			if (typeof id !== 'string' || !COMMAND_ID.test(id)) {
				throw new InitError(`defineCommand: ${JSON.stringify(id)} is not a user command id: it is user.<name> (letters, digits, _ . -)`);
			}
			if (typeof handler !== 'function') {
				throw new InitError(`defineCommand: ${id}: the handler is not a function`);
			}
			if (commands.has(id)) {
				throw new InitError(`defineCommand: ${id} is defined twice`);
			}
			const title = options && typeof options.title === 'string' && options.title ? options.title : undefined;
			commands.set(id, { id, title, handler });
		},
	});
	const nodeRequire = Module.createRequire(fileName);
	/** @param {string} id */
	const requireFn = (id) => {
		if (id === 'vscode') {
			return vscodeApi;
		}
		if (id === 'devhub') {
			return devhub;
		}
		return nodeRequire(id);
	};
	const module = { exports: {} };
	try {
		const fn = vm.runInThisContext(`${WRAPPER}${compiled.code}\n})`, { filename: fileName });
		fn.call(module.exports, module.exports, requireFn, module, fileName, path.dirname(fileName));
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e));
		if (error.stack) {
			error.stack = mapStack(error.stack, fileName, decoded);
		}
		throw error;
	} finally {
		running = false;
	}
	return { commands: [...commands.values()], mapStack: stack => mapStack(stack, fileName, decoded) };
}

module.exports = { FILE_NAME, COMMAND_ID, InitError, configDirectory, transpile, decodeMappings, originalPosition, mapStack, runInit, errorText, WRAPPER };

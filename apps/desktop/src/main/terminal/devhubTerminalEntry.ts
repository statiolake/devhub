/**
 * The terminal launcher's asking program, as a thing that is run.
 *
 * This file is the entry point of `out/main/terminal/devhub-terminal.bundle.js`
 * and of the compiled `out/main/terminal/devhubTerminalEntry.js` the local
 * launcher names, and it exists so that "is this module the entry point?" is
 * not a question anything has to answer at run time. See `../entryPoint.ts`.
 */

import { runEntry } from "../entryPoint.js";
import { main } from "./devhubTerminal.js";

void runEntry("devhub-terminal", main);

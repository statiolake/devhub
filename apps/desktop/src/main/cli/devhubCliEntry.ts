/**
 * The `devhub` command, as a thing that is run.
 *
 * This file is the entry point of `out/main/cli/devhub-cli.bundle.js` and of
 * the compiled `out/main/cli/devhubCliEntry.js` the local launcher names, and
 * it exists so that "is this module the entry point?" is not a question
 * anything has to answer at run time. See `../entryPoint.ts`.
 */

import { runEntry } from "../entryPoint.js";
import { main } from "./devhubCli.js";

void runEntry("devhub", () => main(process.argv.slice(2)));

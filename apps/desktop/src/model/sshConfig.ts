/**
 * The hosts a person has already written down.
 *
 * Somebody who works on a machine over SSH has named it once, in
 * `~/.ssh/config`, and typing `deploy@build.example.com` into a picker to reach
 * a machine they already call `build` is asking them to say it twice. So the
 * picker offers what the file says, and the alias — not the hostname behind it
 * — is what travels: `ssh` resolves the alias, and DevHub resolving it too
 * would be a second answer that can disagree the first time somebody edits a
 * `ProxyJump` or a `HostName`.
 *
 * This reads the file's *shape*, not its meaning. `Host` and `Include` are the
 * only two keywords it knows; everything else is a line it steps over. That is
 * deliberate: OpenSSH's grammar is large, its precedence rules are subtle, and
 * a parser that half-understood `Match` would be a parser that quietly offered
 * the wrong machine. Offering a name that turns out not to work is a mistake
 * the person can see and correct; offering the wrong machine is not.
 *
 * Nothing here touches the filesystem. `Include` is resolved by the caller,
 * which hands the contents back in, so the rule about what a config file means
 * is testable without one.
 */

/**
 * A destination the picker can offer.
 *
 * The alias, and the `HostName` behind it when the file names one — shown as
 * the row's second line, so a person with six aliases can tell which is which
 * without opening the file. It is never sent anywhere: the alias is what
 * `ssh` is given.
 */
export interface SshConfigHost {
  readonly alias: string;
  readonly hostName?: string;
  /** The `User` the file names, if it names one. Shown, never sent. */
  readonly user?: string;
}

/** What one `Include` line asks for, before anything has looked for it. */
export interface SshConfigInclude {
  readonly pattern: string;
}

export interface SshConfigContents {
  readonly hosts: readonly SshConfigHost[];
  readonly includes: readonly SshConfigInclude[];
}

/**
 * A `Host` line's patterns, or an `Include`'s, split the way OpenSSH splits
 * them: on whitespace, with double quotes grouping.
 *
 * Quoting matters for `Include` far more than for `Host` — a path with a space
 * in it is written `Include "~/.ssh/my configs/*"` — and one splitter for both
 * is one rule rather than two that agree until they do not.
 */
function splitArguments(rest: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const character of rest) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) values.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) values.push(current);
  return values;
}

/**
 * The keyword and the rest of a line, or nothing for a line that is neither.
 *
 * OpenSSH accepts `Host foo`, `Host=foo` and `Host = foo` alike, and its
 * keywords are case-insensitive. A comment is a line whose first non-blank
 * character is `#`; OpenSSH does not treat `#` in the middle of a line as one,
 * and neither does this — a hostname with a `#` in it is not a comment.
 */
function keywordOf(
  line: string,
): { keyword: string; rest: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  const match = /^([A-Za-z][A-Za-z0-9-]*)\s*=?\s*(.*)$/.exec(trimmed);
  if (!match) return undefined;
  return { keyword: match[1]!.toLowerCase(), rest: match[2] ?? "" };
}

/**
 * A pattern, rather than the name of one machine.
 *
 * `Host *` is settings for everything, and `Host *.example.com` is settings for
 * a family — neither is a machine anybody can connect to, so neither is a row.
 * A negation (`!build`) is a subtraction from a pattern and is not a name
 * either.
 */
function isPattern(alias: string): boolean {
  return alias.includes("*") || alias.includes("?") || alias.startsWith("!");
}

/**
 * What one config file says, as text.
 *
 * A `Host` line opens a block, and `HostName` and `User` inside it belong to
 * every alias that line named — which is OpenSSH's own rule, and the reason
 * `Host a b` produces two rows with the same hostname rather than one row
 * called `a b`.
 */
export function parseSshConfig(text: string): SshConfigContents {
  const hosts: SshConfigHost[] = [];
  const includes: SshConfigInclude[] = [];
  // The rows the current `Host` block opened, so a later `HostName` in the
  // same block can be attached to all of them.
  let open: { alias: string; hostName?: string; user?: string }[] = [];

  for (const line of text.split(/\r?\n/)) {
    const parsed = keywordOf(line);
    if (!parsed) continue;
    if (parsed.keyword === "host") {
      open = [];
      for (const alias of splitArguments(parsed.rest)) {
        if (isPattern(alias)) continue;
        const entry = { alias };
        open.push(entry);
        hosts.push(entry);
      }
      continue;
    }
    if (parsed.keyword === "include") {
      for (const pattern of splitArguments(parsed.rest)) {
        includes.push({ pattern });
      }
      continue;
    }
    if (parsed.keyword === "hostname" || parsed.keyword === "user") {
      const value = splitArguments(parsed.rest)[0];
      if (value === undefined) continue;
      for (const entry of open) {
        // The first one wins, which is OpenSSH's rule for every keyword.
        if (parsed.keyword === "hostname") entry.hostName ??= value;
        else entry.user ??= value;
      }
    }
  }

  return { hosts, includes };
}

/**
 * Every host across a config file and the files it includes, in the order they
 * were read, with the first mention of an alias winning.
 *
 * First-wins because that is OpenSSH's own precedence, and because a person
 * scanning a picker for `build` should find the `build` their `ssh build` would
 * reach. `Include` is usually the *first* line of a config for exactly that
 * reason, so the included file's `build` is the one that wins — which is what
 * reading in order gives.
 */
export function collectSshHosts(
  files: readonly SshConfigContents[],
): readonly SshConfigHost[] {
  const byAlias = new Map<string, SshConfigHost>();
  for (const file of files) {
    for (const host of file.hosts) {
      if (!byAlias.has(host.alias)) byAlias.set(host.alias, host);
    }
  }
  return [...byAlias.values()];
}

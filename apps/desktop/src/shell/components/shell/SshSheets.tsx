/**
 * The two questions an SSH Workspace needs: which machine, and which folder.
 *
 * Both are pickers, for the reason the project sheets are: a question with
 * nothing to list is still a question, and a person should not have to notice
 * which sort of sheet they are looking at to know what Return and Escape do.
 *
 * Neither sheet connects to anything. DevHub does not resolve the alias, does
 * not check the machine is reachable and does not list the remote folder —
 * every one of those needs the connection that opening the Workspace is *for*,
 * and doing them here would mean asking the person to wait for a connection
 * before they have said where they are going. Connecting, authenticating and
 * failing are Open Remote - SSH's, inside that Workspace's pane, which is also
 * the only place a password prompt belongs: a person paging through workspaces
 * must be able to move on from one that is asking for a passphrase.
 */

import { useEffect, useState } from "react";
import type { SshHostWire } from "../../client";
import { useAppShell } from "../../useAppShell";
import { Picker, type PickerItem } from "./Picker";

/** The row that means "the destination typed above". */
const CONNECT_TYPED = "devhub:ssh-connect-typed";
/** The row that means "the folder typed above". */
const OPEN_TYPED = "devhub:ssh-open-typed";

/** A row for one machine out of `~/.ssh/config`. Its id carries the alias. */
export const SSH_HOST_PREFIX = "devhub:ssh-host:";

export function sshHostRowId(alias: string): string {
  return `${SSH_HOST_PREFIX}${alias}`;
}

export function aliasFromRowId(id: string): string | undefined {
  return id.startsWith(SSH_HOST_PREFIX)
    ? id.slice(SSH_HOST_PREFIX.length)
    : undefined;
}

function HostGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.4 3.4h11.2a1 1 0 0 1 1 1v3.2a1 1 0 0 1-1 1H2.4a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z" />
      <path d="M2.4 10.4h11.2a1 1 0 0 1 1 1v0.2a1 1 0 0 1-1 1H2.4a1 1 0 0 1-1-1v-0.2a1 1 0 0 1 1-1z" />
      <path d="M4 6h0.01" />
    </svg>
  );
}

/**
 * What one machine's row says under its name.
 *
 * The alias is what `ssh` is given, so the alias is the label. The hostname and
 * user behind it are the second line, because six aliases in a list are six
 * words that mean nothing without them — and they are shown, never sent.
 */
function hostDetail(host: SshHostWire): string | undefined {
  const behind = [host.user, host.hostName].filter(Boolean).join("@");
  return behind.length > 0 ? behind : undefined;
}

/** The rows for the machines `~/.ssh/config` names. */
export function sshHostItems(
  hosts: readonly SshHostWire[],
): readonly PickerItem[] {
  return hosts.map((host) => ({
    id: sshHostRowId(host.alias),
    label: `SSH: ${host.alias}`,
    searchText: `ssh ${host.alias} ${hostDetail(host) ?? ""}`,
    detail: hostDetail(host),
    glyph: <HostGlyph />,
  }));
}

/**
 * The machines `~/.ssh/config` names, read once when a sheet opens.
 *
 * Read at that moment rather than pushed with the snapshot, so a host added
 * five minutes ago is in the list. A machine with no config answers with an
 * empty list, which is no rows — not a failure.
 */
export function useSshHosts(): readonly SshHostWire[] {
  const { listSshHosts, reportFailure } = useAppShell();
  const [hosts, setHosts] = useState<readonly SshHostWire[]>([]);
  useEffect(() => {
    let live = true;
    void listSshHosts().then((answer) => {
      if (live) setHosts(answer);
    }, reportFailure);
    return () => {
      live = false;
    };
  }, [listSshHosts, reportFailure]);
  return hosts;
}

/**
 * A typed destination, split the way `scp` writes one: `user@host:/path`.
 *
 * The path half is optional, and when it is there the folder question has
 * already been answered — somebody who typed the whole thing has said where
 * they are going, and asking again would be asking twice.
 *
 * The colon that separates them is the *last* one, because `host:2222` is a
 * port and `[::1]` is an address: both put colons in the half before the path,
 * and a path is the only half that can contain a `/`.
 */
export function splitDestination(typed: string): {
  readonly host: string;
  readonly path?: string;
} {
  const trimmed = typed.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return { host: trimmed };
  const after = trimmed.slice(colon + 1);
  // `host:2222` is a port, and a port is part of the destination.
  if (after.length > 0 && /^[0-9]+$/.test(after)) return { host: trimmed };
  if (!after.startsWith("/")) return { host: trimmed };
  return { host: trimmed.slice(0, colon), path: after };
}

/**
 * Where the folder field starts.
 *
 * `~` is not it, however much it looks like the right default: the path
 * travels into `vscode-remote://ssh-remote+<host>/<path>` and is resolved on
 * the far side literally, so a stored `~` would name a directory *called* `~`.
 * The remote home is a fact only the machine knows, and DevHub has not
 * connected to it yet — so the field starts at the best guess it can make
 * honestly, which is a home directory under the user the destination names,
 * and `/` when it names none.
 */
export function defaultRemoteFolder(host: SshHostWire | undefined): string {
  const user = host?.user;
  return user === undefined || user.length === 0 ? "/" : `/home/${user}/`;
}

export interface SshDestinationSheetProps {
  readonly step?: number;
  readonly onChoose: (host: string, path: string | undefined) => void;
  readonly onCancel: () => void;
}

/**
 * Which machine — for somebody whose machine is not in `~/.ssh/config`, or who
 * would rather type it.
 */
export function SshDestinationSheet({
  step,
  onChoose,
  onCancel,
}: SshDestinationSheetProps) {
  const hosts = useSshHosts();
  return (
    <Picker
      title="Connect over SSH"
      question="Which machine? Type user@host, or pick one your SSH config already names."
      step={step}
      items={sshHostItems(hosts)}
      pinned={[
        {
          id: CONNECT_TYPED,
          label: "Connect to this destination",
          detail: "user@host, or user@host:/path/to/folder",
          needsQuery: true,
        },
      ]}
      emptyNoItems="Your SSH config names no machines. Type user@host above."
      emptyNoMatch="No machine in your SSH config matches."
      onChoose={(choice) => {
        const alias = aliasFromRowId(choice.id);
        if (alias !== undefined) {
          onChoose(alias, undefined);
          return;
        }
        const { host, path } = splitDestination(choice.query);
        onChoose(host, path);
      }}
      onCancel={onCancel}
    />
  );
}

export interface SshFolderSheetProps {
  readonly host: string;
  /** What `~/.ssh/config` says about it, when it is a machine from there. */
  readonly configured?: SshHostWire;
  readonly step?: number;
  readonly onChoose: (path: string) => void;
  readonly onCancel: () => void;
}

/**
 * Which folder on that machine.
 *
 * Typed, not browsed. Listing the remote's directories needs the connection
 * this is on the way to making, and a picker that spent ten seconds connecting
 * before it could show a row would be a worse question than a field. Once the
 * Workspace is open its own workbench browses the machine properly, with the
 * remote explorer and File ▸ Open Folder, which is where that belongs.
 */
export function SshFolderSheet({
  host,
  configured,
  step,
  onChoose,
  onCancel,
}: SshFolderSheetProps) {
  return (
    <Picker
      title={`Open on ${host}`}
      question={`Which folder on ${host}? Type its absolute path — it is read on ${host}, not here.`}
      step={step}
      initialQuery={defaultRemoteFolder(configured)}
      items={[]}
      pinned={[
        {
          id: OPEN_TYPED,
          label: "Open this folder as a workspace",
          needsQuery: true,
        },
      ]}
      onChoose={(choice) => {
        onChoose(choice.query.trim());
      }}
      onCancel={onCancel}
    />
  );
}

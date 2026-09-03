/**
 * Which DevHub this process is: the one switch, and every place it decides.
 *
 * A packaged DevHub and a `pnpm dev` DevHub are two applications that happen
 * to share a name. Left alone they also share everything a running DevHub
 * owns — the editor's user-data directory (which VS Code makes single-instance
 * per directory, so the second one simply does not start), the extensions
 * directory, `~/.config/devhub`, the tmux socket the terminals and Agents live
 * on, the control socket the `devhub` CLI talks to, and the bundle macOS
 * activates. Somebody who develops DevHub inside DevHub needs both at once, so
 * one of them has to be somewhere else.
 *
 * `DEVHUB_PROFILE` names which. Unset — every packaged run, and any source run
 * that does not ask — is the default profile, and the default profile's
 * locations are byte for byte what DevHub has always used: nothing moves for
 * anybody who is not asking for a second DevHub. Any other name derives a
 * complete, disjoint set of locations from that one name.
 *
 * The derivation lives here, in one function, rather than at each of the eight
 * places that needs a location. The alternative — a caller-side `if` per
 * location — is how a profile ends up separated in seven places and sharing
 * the eighth, which is the failure that is invisible until two DevHubs are
 * fighting over one tmux socket.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The profile every DevHub runs under unless something says otherwise. */
export const DEFAULT_PROFILE = "default";

/** The environment variable that names the profile. */
export const PROFILE_ENVIRONMENT_VARIABLE = "DEVHUB_PROFILE";

/**
 * A profile name is a path component, a socket name and part of a bundle
 * identifier at once, so it is held to what all three accept.
 */
const PROFILE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Everything a profile decides. One object, so nothing can be half-applied. */
export interface ProfileLocations {
  readonly profile: string;
  readonly isDefault: boolean;
  /** What Electron and JavaScript call the app. */
  readonly applicationName: string;
  /** The bundle `open -b` activates, for the `devhub` CLI's cold start. */
  readonly bundleIdentifier: string;
  /** The launcher's file name in a PATH directory. */
  readonly cliCommandName: string;
  /** Everything this DevHub owns on disk, under Application Support. */
  readonly dataDirectory: string;
  /** VS Code's user-data directory — the single-instance boundary. */
  readonly userDataDirectory: string;
  readonly extensionsDirectory: string;
  /** Where `settings.toml` and `settings.local.toml` are read from. */
  readonly configDirectory: string;
  /** The tmux server the terminals and Agents live on. */
  readonly tmuxSocketName: string;
}

/**
 * The profile this process runs under.
 *
 * An unusable name is a startup failure rather than a silent fall back to the
 * default: falling back would put a development DevHub on the production
 * locations, which is the one outcome this module exists to prevent.
 */
export function resolveProfileName(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = environment[PROFILE_ENVIRONMENT_VARIABLE];
  if (raw === undefined || raw === "") {
    return DEFAULT_PROFILE;
  }
  if (raw !== DEFAULT_PROFILE && !PROFILE_PATTERN.test(raw)) {
    throw new Error(
      `${PROFILE_ENVIRONMENT_VARIABLE}=${raw} is not a usable profile name: lower-case letters, digits and dashes, starting with a letter.`,
    );
  }
  return raw;
}

/** "dev" -> "Dev", "my-dev" -> "My Dev". For the parts humans read. */
function titleCase(profile: string): string {
  return profile
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Where a profile keeps everything.
 *
 * `home` and the environment are arguments rather than looked up here so that
 * the tests can pin the whole derivation, including that the default profile's
 * paths have not moved.
 */
export function profileLocations(
  profile: string,
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProfileLocations {
  const isDefault = profile === DEFAULT_PROFILE;
  const dataDirectory = join(
    home,
    "Library",
    "Application Support",
    isDefault ? "DevHub" : `DevHub ${titleCase(profile)}`,
  );
  // The convention for everything else under `~/.config`, and what lets a
  // test or a second instance be pointed somewhere else without moving HOME
  // and taking the Keychain, the caches and the app's whole identity with it.
  const xdg = environment["XDG_CONFIG_HOME"];
  const configRoot =
    xdg !== undefined && xdg.startsWith("/") ? xdg : join(home, ".config");
  const suffix = isDefault ? "" : `-${profile}`;
  return {
    profile,
    isDefault,
    applicationName: isDefault ? "DevHub" : `DevHub ${titleCase(profile)}`,
    bundleIdentifier: isDefault
      ? "dev.devhub.app"
      : `dev.devhub.app.${profile}`,
    cliCommandName: `devhub${suffix}`,
    dataDirectory,
    userDataDirectory: join(dataDirectory, "editor"),
    extensionsDirectory: join(dataDirectory, "extensions"),
    configDirectory: join(configRoot, `devhub${suffix}`),
    tmuxSocketName: `devhub${suffix}`,
  };
}

/** The profile named by the environment, resolved against `home`. */
export function currentProfile(
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProfileLocations {
  return profileLocations(resolveProfileName(environment), home, environment);
}

/**
 * The profile this process runs under, resolved once.
 *
 * Once, because the answer is a fact about the process and every caller must
 * get the same one: a second resolution that disagreed — an environment
 * variable changed underneath, a different `home` passed by mistake — would
 * put one half of DevHub on one profile's locations and the other half on
 * another's, which is worse than either profile alone.
 */
let active: ProfileLocations | undefined;

export function activeProfile(): ProfileLocations {
  active ??= currentProfile(homedir());
  return active;
}

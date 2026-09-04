import { describe, expect, it } from "vitest";
import { defaultConfigPaths, withProfileRuntimes } from "./config.js";
import {
  currentProfile,
  DEFAULT_PROFILE,
  profileLocations,
  resolveProfileName,
} from "./profile.js";

const HOME = "/home/tester";

describe("the default profile", () => {
  /**
   * The point of the whole module: somebody who never asks for a second
   * DevHub must not have one thing move. These are the paths DevHub used
   * before profiles existed, spelled out rather than derived, so a change to
   * the derivation cannot quietly take the packaged app's data with it.
   */
  it("keeps every location it had before profiles existed", () => {
    const locations = profileLocations(DEFAULT_PROFILE, HOME, {});
    expect(locations).toEqual({
      profile: "default",
      isDefault: true,
      applicationName: "DevHub",
      bundleIdentifier: "net.statiolake.devhub",
      cliCommandName: "devhub",
      dataDirectory: "/home/tester/Library/Application Support/DevHub",
      userDataDirectory:
        "/home/tester/Library/Application Support/DevHub/editor",
      extensionsDirectory:
        "/home/tester/Library/Application Support/DevHub/extensions",
      configDirectory: "/home/tester/.config/devhub",
      tmuxSocketName: "devhub",
    });
  });

  it("is what an unset, or empty, DEVHUB_PROFILE means", () => {
    expect(resolveProfileName({})).toBe(DEFAULT_PROFILE);
    expect(resolveProfileName({ DEVHUB_PROFILE: "" })).toBe(DEFAULT_PROFILE);
    expect(currentProfile(HOME, {}).configDirectory).toBe(
      "/home/tester/.config/devhub",
    );
  });

  it("still reads the settings from the directory it always did", () => {
    expect(defaultConfigPaths(HOME, {})).toEqual({
      file: "/home/tester/.config/devhub/settings.toml",
      local: "/home/tester/.config/devhub/settings.local.toml",
      legacy: "/home/tester/.config/devhub/config.toml",
    });
  });

  it("follows XDG_CONFIG_HOME where it always did", () => {
    expect(defaultConfigPaths(HOME, { XDG_CONFIG_HOME: "/xdg" }).file).toBe(
      "/xdg/devhub/settings.toml",
    );
  });
});

describe("a second profile", () => {
  const dev = profileLocations("dev", HOME, {});

  it("shares no location with the default one", () => {
    const production = profileLocations(DEFAULT_PROFILE, HOME, {});
    const keys = [
      "applicationName",
      "bundleIdentifier",
      "cliCommandName",
      "dataDirectory",
      "userDataDirectory",
      "extensionsDirectory",
      "configDirectory",
      "tmuxSocketName",
    ] as const;
    for (const key of keys) {
      expect(dev[key], key).not.toBe(production[key]);
    }
  });

  it("derives every one of them from the profile name", () => {
    expect(dev).toEqual({
      profile: "dev",
      isDefault: false,
      applicationName: "DevHub Dev",
      bundleIdentifier: "net.statiolake.devhub.dev",
      cliCommandName: "devhub-dev",
      dataDirectory: "/home/tester/Library/Application Support/DevHub Dev",
      userDataDirectory:
        "/home/tester/Library/Application Support/DevHub Dev/editor",
      extensionsDirectory:
        "/home/tester/Library/Application Support/DevHub Dev/extensions",
      configDirectory: "/home/tester/.config/devhub-dev",
      tmuxSocketName: "devhub-dev",
    });
  });

  it("refuses a name that is not usable as a path, a socket and an identifier", () => {
    for (const name of ["../escape", "Dev", "dev profile", "-dev", "dev/"]) {
      expect(() => resolveProfileName({ DEVHUB_PROFILE: name })).toThrow(
        /not a usable profile name/,
      );
    }
  });
});

describe("the tmux socket a profile runs on", () => {
  const base = {
    version: 1,
    general: {},
    runtimes: {
      shell: "/bin/zsh",
      git: "git",
      tmux: "tmux",
      tmux_socket_name: "devhub",
      tmux_args: [],
    },
  } as unknown as Parameters<typeof withProfileRuntimes>[0];

  it("is the profile's, whatever the settings copied from production say", () => {
    const applied = withProfileRuntimes(
      base,
      profileLocations("dev", HOME, {}),
    );
    expect(applied.config.runtimes.tmux_socket_name).toBe("devhub-dev");
    expect(applied.overriddenSocketName).toBe("devhub");
  });

  it("says nothing, and changes nothing, on the default profile", () => {
    const applied = withProfileRuntimes(
      base,
      profileLocations(DEFAULT_PROFILE, HOME, {}),
    );
    expect(applied.config).toBe(base);
    expect(applied.overriddenSocketName).toBeUndefined();
  });
});

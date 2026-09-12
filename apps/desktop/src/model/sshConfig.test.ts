import { describe, expect, it } from "vitest";
import {
  collectSshHosts,
  parseSshConfig,
  type SshConfigContents,
} from "./sshConfig.js";

const aliases = (contents: SshConfigContents) =>
  contents.hosts.map((host) => host.alias);

describe("the hosts a config file names", () => {
  it("reads a plain block", () => {
    const contents = parseSshConfig(`
Host build
  HostName build.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
`);
    expect(contents.hosts).toEqual([
      { alias: "build", hostName: "build.example.com", user: "deploy" },
    ]);
  });

  it("gives every alias on one Host line the block's settings", () => {
    // OpenSSH's own rule, and the reason this is two rows rather than one row
    // called "build staging".
    const contents = parseSshConfig(`
Host build staging
  HostName shared.example.com
`);
    expect(contents.hosts).toEqual([
      { alias: "build", hostName: "shared.example.com" },
      { alias: "staging", hostName: "shared.example.com" },
    ]);
  });

  it("leaves out patterns, which are settings rather than machines", () => {
    // `Host *` is settings for everything and `!build` is a subtraction from a
    // pattern. Neither is somewhere a person can connect to.
    expect(
      aliases(
        parseSshConfig(`
Host *
  ServerAliveInterval 60
Host *.example.com
  User deploy
Host !build *.internal
  User root
Host api.example.com
`),
      ),
    ).toEqual(["api.example.com"]);
  });

  it("accepts the three spellings OpenSSH accepts, and any case", () => {
    expect(
      aliases(
        parseSshConfig(`
host one
HOST=two
  hostname two.example.com
Host   =   three
`),
      ),
    ).toEqual(["one", "two", "three"]);
  });

  it("steps over comments and blank lines, and only whole-line comments", () => {
    const contents = parseSshConfig(`
# the build machine
   # indented comment

Host build
  HostName build.example.com # this is not a comment to OpenSSH
`);
    expect(contents.hosts).toEqual([
      { alias: "build", hostName: "build.example.com" },
    ]);
  });

  it("keeps the first value, because OpenSSH does", () => {
    const contents = parseSshConfig(`
Host build
  HostName first.example.com
  HostName second.example.com
`);
    expect(contents.hosts[0]?.hostName).toBe("first.example.com");
  });

  it("does not attribute a later block's settings to an earlier one", () => {
    const contents = parseSshConfig(`
Host build
  HostName build.example.com
Host staging
  HostName staging.example.com
`);
    expect(contents.hosts).toEqual([
      { alias: "build", hostName: "build.example.com" },
      { alias: "staging", hostName: "staging.example.com" },
    ]);
  });

  it("collects Include patterns without looking for them", () => {
    // Resolving them is the caller's, which is what keeps this a rule about a
    // string rather than a rule about a disk.
    const contents = parseSshConfig(`
Include ~/.ssh/config.d/*.conf work/hosts
Include "~/.ssh/my configs/*"
Host build
`);
    expect(contents.includes).toEqual([
      { pattern: "~/.ssh/config.d/*.conf" },
      { pattern: "work/hosts" },
      { pattern: "~/.ssh/my configs/*" },
    ]);
  });

  it("ignores every keyword it does not need", () => {
    // Half-understanding `Match` would mean quietly offering the wrong
    // machine, which is worse than offering a name that turns out not to work.
    const contents = parseSshConfig(`
Match host build exec "true"
  User root
Host api
  ProxyJump bastion.example.com
`);
    expect(aliases(contents)).toEqual(["api"]);
  });

  it("says nothing about an empty file", () => {
    expect(parseSshConfig("")).toEqual({ hosts: [], includes: [] });
  });
});

describe("hosts across a config and everything it includes", () => {
  it("reads in order, and the first mention of an alias wins", () => {
    // OpenSSH's precedence, and the reason an `Include` at the top of a config
    // beats what follows it — which is where people put it.
    const included = parseSshConfig(`
Host build
  HostName included.example.com
`);
    const main = parseSshConfig(`
Host build
  HostName main.example.com
Host api
  HostName api.example.com
`);
    expect(collectSshHosts([included, main])).toEqual([
      { alias: "build", hostName: "included.example.com" },
      { alias: "api", hostName: "api.example.com" },
    ]);
  });

  it("is empty when there is nothing to read", () => {
    expect(collectSshHosts([])).toEqual([]);
  });
});

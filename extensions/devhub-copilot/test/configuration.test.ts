import assert from "node:assert/strict";
import test from "node:test";
import {
  getConfigurationSection,
  toCopilotClientConfiguration,
} from "../src/configuration";

test("maps VS Code network settings to the Copilot configuration shape", () => {
  const configuration = toCopilotClientConfiguration({
    proxy: "https://proxy.example",
    proxyStrictSSL: false,
    proxyKerberosServicePrincipal: "HTTP/proxy.example",
    telemetryLevel: "error",
    githubEnterpriseUri: "https://github.example",
  });

  assert.deepEqual(configuration, {
    http: {
      proxy: "https://proxy.example",
      proxyStrictSSL: false,
      proxyKerberosServicePrincipal: "HTTP/proxy.example",
    },
    telemetry: { telemetryLevel: "error" },
    "github-enterprise": { uri: "https://github.example" },
  });
  assert.equal(
    getConfigurationSection<string>(configuration, "http.proxy"),
    "https://proxy.example",
  );
  assert.equal(
    getConfigurationSection<string>(configuration, "github-enterprise.uri"),
    "https://github.example",
  );
});

test("does not invent empty configuration sections", () => {
  assert.deepEqual(toCopilotClientConfiguration({}), {});
  assert.equal(getConfigurationSection<unknown>({}, "http.proxy"), undefined);
});

test("returns the Copilot configuration section with dotted internal keys", () => {
  const configuration = {
    github: {
      copilot: {
        "nextEditSuggestions.enabled": true,
      },
    },
  };

  assert.deepEqual(getConfigurationSection(configuration, "github.copilot"), {
    "nextEditSuggestions.enabled": true,
  });
});

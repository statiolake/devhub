import type { CopilotClientConfiguration } from "./copilotClient";

export interface ServerConfigurationInput {
  proxy?: string | null;
  proxyStrictSSL?: boolean | null;
  proxyKerberosServicePrincipal?: string | null;
  telemetryLevel?: string | null;
  githubEnterpriseUri?: string | null;
}

export function toCopilotClientConfiguration(
  input: ServerConfigurationInput,
): CopilotClientConfiguration {
  const configuration: CopilotClientConfiguration = {};

  if (
    input.proxy !== undefined ||
    input.proxyStrictSSL !== undefined ||
    input.proxyKerberosServicePrincipal !== undefined
  ) {
    configuration.http = {};
    if (input.proxy != null) {
      configuration.http.proxy = input.proxy;
    }
    if (input.proxyStrictSSL != null) {
      configuration.http.proxyStrictSSL = input.proxyStrictSSL;
    }
    if (input.proxyKerberosServicePrincipal != null) {
      configuration.http.proxyKerberosServicePrincipal =
        input.proxyKerberosServicePrincipal;
    }
  }

  if (input.telemetryLevel != null) {
    configuration.telemetry = { telemetryLevel: input.telemetryLevel };
  }

  if (input.githubEnterpriseUri != null) {
    configuration["github-enterprise"] = { uri: input.githubEnterpriseUri };
  }

  return configuration;
}

export function getConfigurationSection<T>(
  configuration: CopilotClientConfiguration,
  section: string | undefined,
): T | undefined {
  if (section === undefined || section.length === 0) {
    return configuration as T;
  }

  // LSP clients may provide either an exact dotted setting key or a nested
  // object. Prefer the exact key before walking the dotted path.
  if (Object.prototype.hasOwnProperty.call(configuration, section)) {
    return configuration[section] as T;
  }

  const parts = section.split(".");
  let current: unknown = configuration;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as T | undefined;
}

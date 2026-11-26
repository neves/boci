// Service endpoint resolution, ported from oci.regions + oci.base_client.BaseClient as the
// CLI builds clients (explicit realm-specific / dual-stack booleans; see build_client).

import type { Env } from "../lib/io.ts";

export type RegionsSpec = {
  regions: string[];
  shortNames: Record<string, string>;
  regionRealms: Record<string, string>;
  realms: Record<string, string>;
  serviceEndpoints: Record<string, string>;
  domainFormat: string;
};

export type RegionMetadata = {
  realmKey: string;
  realmDomainComponent: string;
  regionKey: string;
  regionIdentifier: string;
};

export type ClientInfo = {
  basePath?: string;
  endpointTemplate?: string;
  endpointServiceName?: string;
  endpointTemplatePerRealm?: Record<string, string>;
  regionalClient?: boolean;
  dualStackByDefault?: boolean;
  serviceName?: string;
};

export class MissingEndpointForNonRegionalServiceClient extends Error {}

export type EndpointOptions = {
  region?: string | null;
  /** --endpoint (or config endpoint): used as the endpoint, base path appended if missing. */
  endpoint?: string | null;
  realmSpecific: boolean;
  dualStack?: boolean;
  env?: Record<string, string | undefined>;
  regionMetadata?: RegionMetadata;
  /** Path/query values used by placeholders in realm-specific endpoint templates. */
  serviceParams?: Record<string, string>;
};

/** Loads OCI's external region metadata sources, in their documented priority order. */
export async function loadExternalRegionMetadata(
  region: string,
  regions: RegionsSpec,
  env: Env,
): Promise<RegionMetadata | undefined> {
  const name = region.toLowerCase();
  if (regions.regions.includes(name) || name in regions.shortNames)
    return undefined;

  const home = env.HOME;
  if (home) {
    const file = Bun.file(`${home}/.oci/regions-config.json`);
    if (await file.exists()) {
      try {
        const entries: unknown = await file.json();
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const metadata = parseRegionMetadata(entry);
            if (metadata && matchesRegion(metadata, name)) return metadata;
          }
        }
      } catch {
        // Invalid or unreadable configuration falls through to the environment source.
      }
    }
  }

  if (env.OCI_REGION_METADATA) {
    try {
      const metadata = parseRegionMetadata(
        JSON.parse(env.OCI_REGION_METADATA) as unknown,
      );
      if (metadata && matchesRegion(metadata, name)) return metadata;
    } catch {
      // Invalid metadata falls through to the normal OC1 fallback.
    }
  }
  return undefined;
}

function parseRegionMetadata(value: unknown): RegionMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const fields = [
    "realmKey",
    "realmDomainComponent",
    "regionKey",
    "regionIdentifier",
  ] as const;
  if (
    !fields.every(
      (field) =>
        field in record &&
        typeof record[field] === "string" &&
        record[field].length > 0,
    )
  )
    return undefined;
  return Object.fromEntries(
    fields.map((field) => [field, (record[field] as string).toLowerCase()]),
  ) as RegionMetadata;
}

function matchesRegion(metadata: RegionMetadata, region: string): boolean {
  return metadata.regionIdentifier === region || metadata.regionKey === region;
}

/** Returns the endpoint as stored by the SDK client and with endpoint options resolved. */
export function resolveEndpoint(
  client: ClientInfo,
  regions: RegionsSpec,
  opts: EndpointOptions,
): { stored: string; resolved: string } {
  const env = opts.env ?? {};
  const effectiveRegions = opts.regionMetadata
    ? withRegionMetadata(regions, opts.regionMetadata)
    : regions;
  let stored: string;
  if (client.regionalClient === false || opts.endpoint) {
    if (!opts.endpoint) {
      throw new MissingEndpointForNonRegionalServiceClient(
        "An endpoint must be provided for a non-regional service client",
      );
    }
    stored = withBasePath(opts.endpoint, client.basePath);
  } else {
    const region = opts.region?.toLowerCase() ?? null;
    if (!region) throw new Error("Must supply either a region or an endpoint.");
    const template = templateFor(
      client,
      effectiveRegions,
      region,
      opts.realmSpecific,
    );
    stored = withBasePath(
      endpointFor(client, effectiveRegions, region, template, env),
      client.basePath,
    );
  }
  const dualStack =
    opts.dualStack !== undefined
      ? opts.dualStack
      : env.OCI_DUAL_STACK_ENDPOINT_ENABLED !== undefined
        ? env.OCI_DUAL_STACK_ENDPOINT_ENABLED.toLowerCase() === "true"
        : Boolean(client.dualStackByDefault);
  return {
    stored,
    resolved: applyServiceParams(
      applyEndpointOptions(stored, dualStack),
      opts.serviceParams,
    ),
  };
}

function applyServiceParams(
  endpoint: string,
  params: Record<string, string> = {},
): string {
  return endpoint.replace(
    /\{([A-Za-z][A-Za-z0-9]*)(\+Dot)?\}/g,
    (_token, name: string, dot: string | undefined) => {
      const value = params[name];
      if (value === undefined) return "";
      return dot ? `${value}.` : value;
    },
  );
}

function withRegionMetadata(
  regions: RegionsSpec,
  metadata: RegionMetadata,
): RegionsSpec {
  const shortNames = { ...regions.shortNames };
  const regionRealms = { ...regions.regionRealms };
  const realms = { ...regions.realms };
  if (!(metadata.regionKey in shortNames))
    shortNames[metadata.regionKey] = metadata.regionIdentifier;
  if (!(metadata.regionIdentifier in regionRealms))
    regionRealms[metadata.regionIdentifier] = metadata.realmKey;
  if (!(metadata.realmKey in realms))
    realms[metadata.realmKey] = metadata.realmDomainComponent;
  return {
    ...regions,
    regions: regions.regions.includes(metadata.regionIdentifier)
      ? regions.regions
      : [...regions.regions, metadata.regionIdentifier],
    shortNames,
    regionRealms,
    realms,
  };
}

/** BaseClient.handle_service_endpoint_template */
function templateFor(
  client: ClientInfo,
  regions: RegionsSpec,
  region: string,
  realmSpecific: boolean,
) {
  if (realmSpecific && region in regions.regionRealms) {
    const realm = regions.regionRealms[region] as string;
    const perRealm = client.endpointTemplatePerRealm ?? {};
    if (realm in perRealm) return perRealm[realm];
  }
  return client.endpointTemplate;
}

/** oci.regions.endpoint_for / _endpoint_for / _endpoint (no external region sources yet). */
function endpointFor(
  client: ClientInfo,
  regions: RegionsSpec,
  regionIn: string,
  template: string | undefined,
  env: Record<string, string | undefined>,
): string {
  let region = regionIn.toLowerCase();
  if (region in regions.shortNames)
    region = regions.shortNames[region] as string;
  if (region.includes(".")) {
    if (client.endpointServiceName)
      return `https://${client.endpointServiceName}.${region}`;
    return formatEndpoint(client, regions, region, template);
  }
  const sld = secondLevelDomain(regions, region, env);
  if (template)
    return template
      .replaceAll("{region}", region)
      .replaceAll("{secondLevelDomain}", sld);
  return formatEndpoint(
    client,
    regions,
    regions.domainFormat
      .replace("{region}", region)
      .replace("{secondLevelDomain}", sld),
    undefined,
  );
}

/** oci.regions._second_level_domain: the region's realm, OCI_DEFAULT_REALM, else oc1. */
function secondLevelDomain(
  regions: RegionsSpec,
  region: string,
  env: Record<string, string | undefined>,
) {
  const realm = regions.regionRealms[region];
  if (realm) return regions.realms[realm] as string;
  if (env.OCI_DEFAULT_REALM) return env.OCI_DEFAULT_REALM;
  return regions.realms.oc1 as string;
}

/** oci.regions._format_endpoint */
function formatEndpoint(
  client: ClientInfo,
  regions: RegionsSpec,
  domain: string,
  template: string | undefined,
) {
  const service = (client.serviceName ?? "").toLowerCase();
  let format: string | undefined = regions.serviceEndpoints[service];
  if (!format) {
    if (template === undefined) {
      if (!client.endpointServiceName)
        throw new Error(`Unknown service '${service}'`);
      format = `https://${client.endpointServiceName}.{domain}`;
    } else {
      const pos = template.indexOf("{region}");
      if (pos !== -1) format = `${template.slice(0, pos)}{domain}`;
    }
  }
  if (!format)
    throw new Error(
      `Unable to format endpoint for service, ${service} , and service_endpoint_template, ${template}`,
    );
  return format.replace("{domain}", domain);
}

/** BaseClient.endpoint setter */
function withBasePath(endpoint: string, basePath: string | undefined): string {
  if (basePath === "/") return endpoint;
  if (
    basePath &&
    !(endpoint.endsWith(basePath) || endpoint.endsWith(`${basePath}/`))
  )
    return `${endpoint}${basePath}`;
  return endpoint;
}

/** BaseClient.update_endpoint_template_for_options: resolve `{dualStack?on:off}` blocks. */
export function applyEndpointOptions(
  endpoint: string,
  dualStack: boolean,
): string {
  const segments: string[] = [];
  let last = 0;
  for (const m of endpoint.matchAll(/\{([^}]+)\}/g)) {
    const option = m[0];
    const start = m.index ?? 0;
    const end = start + option.length;
    segments.push(endpoint.slice(last, start));
    if (!(option.includes("?") && option.includes(":"))) {
      segments.push(option);
      last = end;
      continue;
    }
    if (!option.includes("{dualStack") || /\s/.test(option)) {
      last = end;
      continue;
    }
    const on = option.slice(option.indexOf("?") + 1, option.indexOf(":"));
    const off = option.slice(option.indexOf(":") + 1, -1);
    const valid = (s: string) => s === "" || /^[\p{L}\p{N}]/u.test(s);
    if (!(valid(on) && valid(off))) {
      last = end;
      continue;
    }
    let replacement = dualStack ? on : off;
    if (
      replacement.startsWith(".") &&
      segments.length &&
      (segments[segments.length - 1] as string).endsWith(".")
    ) {
      replacement = replacement.slice(1);
    }
    if (
      replacement.endsWith(".") &&
      end < endpoint.length &&
      endpoint[end] === "."
    )
      last = end + 1;
    segments.push(replacement);
    last = Math.max(last, end);
  }
  segments.push(endpoint.slice(last));
  return segments.join("");
}

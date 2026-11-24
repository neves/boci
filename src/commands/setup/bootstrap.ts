import { expandUser } from "../../core/config.ts";
import {
  sendServiceRequest,
  type ServiceClient,
} from "../../core/operation.ts";
import { formatServiceError } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { loadService } from "../../core/spec.ts";
import { Exit } from "../../lib/io.ts";
import { openUrlInBrowser } from "../../utils/openUrlInBrowser.ts";
import { createBrowserUserSession, persistUserSession } from "../session.ts";
import {
  createStdinReader,
  promptClick,
  serializePublicKey,
  setupRegion,
} from "../setup.ts";

export async function runSetupBootstrap(
  ctx: CustomCommandContext,
): Promise<void> {
  const { io, index, values } = ctx;
  const stdin = createStdinReader(io);
  const sessionSpec = await loadService("session");
  const regionHelp = sessionSpec.commands.authenticate?.helpDoc.records.find(
    ([option]) => option.startsWith("--region"),
  )?.[1];
  const session = await createBrowserUserSession(io, stdin, {
    region: setupRegion(ctx, "bootstrap") ?? "",
    enableDualStack: false,
    regions: index.regions,
    regionDisplayOrder:
      regionHelp?.split(",").filter(Boolean) ?? index.regions.regions,
    port: 8181,
    openBrowserFn: openUrlInBrowser,
  });
  if (!session.privateKey)
    throw new Error("Browser session has no private key");

  const identity = (await loadService("iam")).clients["identity.identity"]!;
  const client: ServiceClient = {
    client: identity,
    targetService: identity.serviceName,
    index,
    rootValues: {},
    keyId: `ST$${session.token}`,
    privateKey: session.privateKey,
    region: session.region,
    realmSpecific: false,
    dualStack: false,
    readTimeout: 60,
    maxAttempts: 8,
  };
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const check = (
    result: Awaited<ReturnType<typeof sendServiceRequest>>,
    http: string,
    method: string,
  ) => {
    if (result.response.ok) return;
    io.err(
      formatServiceError(
        { http, method },
        result.url,
        result.response,
        result.raw,
        client.targetService,
      ),
    );
    throw new Exit(1);
  };

  const subscriptions = await sendServiceRequest(io, client, {
    method: "GET",
    pathTemplate: "/tenancies/{tenancyId}/regionSubscriptions",
    pathParams: { tenancyId: session.tenancyOcid },
    headers,
  });
  check(subscriptions, "GET", "list_region_subscriptions");
  const regions = JSON.parse(subscriptions.raw) as {
    isHomeRegion?: boolean;
    regionName: string;
  }[];
  const home = regions.find((region) => region.isHomeRegion);
  if (!home) {
    io.err(
      "UnboundLocalError: cannot access local variable 'home_region' where it is not associated with a value\n",
    );
    throw new Exit(1);
  }
  client.region = home.regionName;
  const keyPath = "/users/{userId}/apiKeys";
  const pathParams = { userId: session.userOcid };
  const body = JSON.stringify({ key: serializePublicKey(session.publicKey) });
  const upload = () =>
    sendServiceRequest(io, client, {
      method: "POST",
      pathTemplate: keyPath,
      pathParams,
      headers: { ...headers, "opc-retry-token": crypto.randomUUID() },
      body,
    });
  let uploaded = await upload();
  if (
    uploaded.response.status === 409 &&
    (await new Response(uploaded.raw).json().then(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ApiKeyLimitExceeded",
      () => false,
    ))
  ) {
    const listed = await sendServiceRequest(io, client, {
      method: "GET",
      pathTemplate: keyPath,
      pathParams,
      headers,
    });
    check(listed, "GET", "list_api_keys");
    io.out("ApiKey limit has been reached for this user account.\n");
    io.out("The following API keys are currently enabled for this account:\n");
    const keys = JSON.parse(listed.raw) as {
      fingerprint: string;
      timeCreated?: string;
    }[];
    for (const [index, key] of keys.entries()) {
      const time =
        key.timeCreated?.replace("T", " ").replace(/Z$/, "+00:00") ?? "None";
      io.err(
        `\tKey [${index + 1}]: Fingerprint: ${key.fingerprint}, Time Created: ${time}\n`,
      );
    }
    const question =
      "Enter the fingerprint of the API key to delete to make space for the new key (leave empty to skip deletion and exit command)";
    let fingerprint: string;
    while (true) {
      fingerprint = await promptClick(io, stdin, question, {
        wrapExceptions: true,
      });
      const confirmation = await promptClick(
        io,
        stdin,
        "Repeat for confirmation",
        { wrapExceptions: true },
      );
      if (fingerprint === confirmation) break;
      io.out("Error: The two entered values do not match.\n");
    }
    const deleted = await sendServiceRequest(io, client, {
      method: "DELETE",
      pathTemplate: `${keyPath}/{fingerprint}`,
      pathParams: { ...pathParams, fingerprint },
      headers,
    });
    check(deleted, "DELETE", "delete_api_key");
    io.out(`Deleted Api key with fingerprint: ${fingerprint}\n`);
    uploaded = await upload();
  }
  check(uploaded, "POST", "upload_api_key");
  io.out(`Uploaded new API key with fingerprint: ${session.fingerprint}\n`);

  const config =
    typeof values.config_location === "string" && values.config_location;
  const { profileName, configLocation } = await persistUserSession(
    io,
    stdin,
    session,
    {
      profileName:
        typeof values.profile_name === "string"
          ? values.profile_name
          : undefined,
      configLocation: config ? expandUser(config, io.env) : undefined,
      usePassphrase: false,
      bootstrap: true,
    },
  );
  io.out(
    `Config written to: ${configLocation}\n\n    Try out your newly registered credentials with the following example command:\n\n    oci iam region list --config-file ${configLocation} --profile ${profileName}\n\n`,
  );
}

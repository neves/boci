import { mkdir, open } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { expandUser } from "../../core/config.ts";
import { callOperation } from "../../core/operation.ts";
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  decodeSecurityToken,
  SecurityTokenDecodeError,
} from "../../core/security-token.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { outputOptions, sdkCommand } from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";
import { setPosixMode } from "../../lib/posixMode.ts";
import { generateRsaKeyPair } from "../../utils/generateRsaKeyPair.ts";
import { formatLocalTimestamp } from "../session.ts";

const operation: OperationSpec = {
  client: "identity_data_plane.dataplane",
  method: "generate_scoped_access_token",
  http: "POST",
  path: "/actions/generateScopedAccessToken",
  pathParams: {},
  queryParams: {},
  headerParams: {
    accept: { value: "application/json" },
    "content-type": { value: "application/json" },
  },
  body: "details",
  responseType: "SecurityToken",
};

async function writePrivateFile(path: string, value: string) {
  const file = await open(path, "w", 0o600);
  try {
    setPosixMode(path, 0o600);
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}

export async function runIamDbTokenGet(
  ctx: CustomCommandContext,
): Promise<void> {
  const { io, values, spec } = ctx;
  const scope = (values.scope ?? "urn:oracle:db::id::*") as string;
  if (scope && !scope.includes("urn:oracle:db:")) {
    io.out("scope must be a db scope i.e --scope 'urn:oracle:db::id::*'\n");
    io.err("Exit: 1\n");
    throw new Exit(1);
  }

  const { privateKey, publicKey } = generateRsaKeyPair();
  const directory = normalize(
    expandUser(String(values.db_token_location ?? "~/.oci/db-token"), io.env),
  );
  await mkdir(resolve(io.cwd, directory), { recursive: true });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  await writePrivateFile(
    resolve(io.cwd, directory, "oci_db_key_public.pem"),
    publicPem,
  );
  const result = await callOperation(io, {
    ...ctx,
    spec: {
      ...spec,
      clients: {
        ...spec.clients,
        [operation.client]: {
          serviceName: "dataplane",
          basePath: "/v1",
          endpointTemplate: "https://auth.{region}.{secondLevelDomain}",
        },
      },
    },
    command: sdkCommand(ctx, "db-token get", operation),
    values: { details: { scope, publicKey: publicPem } },
  });
  if (!result.response.ok) printResult(io, result, outputOptions(ctx));

  const privatePath = join(directory, "oci_db_key.pem");
  const privatePem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  await writePrivateFile(resolve(io.cwd, privatePath), privatePem);
  io.out(`Private key written at ${privatePath}\n`);

  const token = JSON.parse(result.raw).token;
  if (typeof token !== "string") {
    io.err("KeyError: 'token'\n");
    throw new Exit(1);
  }
  const tokenPath = join(directory, "token");
  await writePrivateFile(resolve(io.cwd, tokenPath), token);
  io.out(`db-token written at: ${tokenPath}\n`);

  try {
    const { exp } = decodeSecurityToken(token);
    if (exp === undefined) {
      io.err("KeyError: 'exp'\n");
      throw new Exit(1);
    }
    io.err(
      `db-token is valid until ${formatLocalTimestamp(Number(exp), io.env.TZ)}\n`,
    );
  } catch (error) {
    if (!(error instanceof SecurityTokenDecodeError)) throw error;
    io.err(`${error.name}: ${error.message}\n`);
    throw new Exit(1);
  }
}

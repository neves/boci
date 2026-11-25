import { Exit } from "../../lib/io.ts";
import { callCommand, outputOptions } from "../../lib/custom-command.ts";
import type { CustomCommandContext } from "../../core/registry.ts";

const INTERMEDIATE_HOST =
  /instance-console\.[a-z0-9-]+\.(?:oraclecloud|oracleiaas)\.com/;

export async function runComputeInstanceConsolePlink(
  ctx: CustomCommandContext,
): Promise<void> {
  const connectionId = ctx.values.instance_console_connection_id;
  if (typeof connectionId === "string" && connectionId.trim() === "") {
    ctx.io.err(
      "UsageError: Parameter --instance-console-connection-id cannot be whitespace or empty string\n",
    );
    throw new Exit(1);
  }

  const result = await callCommand(
    ctx,
    ctx.spec.service,
    "instance-console-connection get",
    { instance_console_connection_id: connectionId },
  );
  if (!result.response.ok) {
    const { printResult } = await import("../../core/output.ts");
    printResult(ctx.io, result, outputOptions(ctx));
  }

  const connection = JSON.parse(result.raw) as {
    connectionString?: string | null;
    instanceId?: string | null;
    id?: string | null;
  };
  if (connection.connectionString == null) {
    ctx.io.err(
      "TypeError: expected string or bytes-like object, got 'NoneType'\n",
    );
    throw new Exit(1);
  }
  const host = INTERMEDIATE_HOST.exec(connection.connectionString)?.[0];
  if (!host) {
    ctx.io.err("AttributeError: 'NoneType' object has no attribute 'group'\n");
    throw new Exit(1);
  }

  const keyFile = ctx.values.private_key_file;
  const localPort = ctx.values.local_vnc_port ?? 5900;
  const proxyPort = ctx.values.ssh_proxy_port ?? 5905;
  ctx.io.out(
    `Start-Job {echo N | plink -ssh -N -i "${keyFile}" -P 443 -l ${connection.id} ${host} -L ${proxyPort}:${connection.instanceId}:${proxyPort}}; sleep 5 ; plink -L ${localPort}:localhost:5900 localhost -P ${proxyPort} -N -i "${keyFile}" -l ${connection.id}\n`,
  );
}

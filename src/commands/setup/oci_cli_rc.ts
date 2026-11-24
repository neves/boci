import { mkdir, open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { osErrorReason } from "../../core/click-file.ts";
import { expandUser } from "../../core/config.ts";
import { pyRepr } from "../../core/convert.ts";
import { RC_DEFAULT_LOCATION } from "../../core/rc.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  cannedQueries,
  commandAliases,
  parameterAliases,
} from "../../lib/default-cli-rc.ts";
import { Exit } from "../../lib/io.ts";

const sections = [
  [
    "OCI_CLI_CANNED_QUERIES",
    "Predefined queries",
    "these queries",
    cannedQueries,
  ],
  [
    "OCI_CLI_COMMAND_ALIASES",
    "Command aliases",
    "command aliases",
    commandAliases,
  ],
  [
    "OCI_CLI_PARAM_ALIASES",
    "Parameter aliases",
    "parameter aliases",
    parameterAliases,
  ],
] as const;

export async function runSetupOciCliRc({ io, values }: CustomCommandContext) {
  const path =
    typeof values.file === "string"
      ? values.file
      : expandUser(RC_DEFAULT_LOCATION, io.env);
  const absolute = resolve(io.cwd, path);
  const parent = dirname(path);
  const exists = await stat(absolute).then(
    () => true,
    () => false,
  );
  if (path === "-" || (!exists && parent === "." && !path.startsWith("./"))) {
    // The Reference CLI calls makedirs('') on a new filename with no directory.
    io.err("FileNotFoundError: [Errno 2] No such file or directory: ''\n");
    throw new Exit(1);
  }

  try {
    if (!exists) await mkdir(resolve(io.cwd, parent), { recursive: true });
    // Read before appending so checks are against the original contents. Open in
    // append mode to preserve the existing bytes and avoid truncating the file.
    await using file = await open(absolute, "a+");
    const data = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.readFile(),
    );
    const added = sections.filter(([name]) => !data.includes(name));
    if (added.length)
      await file.writeFile(added.map(([, , , text]) => `\n\n${text}`).join(""));
    for (const [name, label, description] of sections) {
      if (data.includes(name))
        io.err(
          `${label} will not be written as the specified file already contains a section for ${description}\n`,
        );
      else io.out(`${label} written under section ${name}\n`);
    }
  } catch (error) {
    io.err(
      `Error: Could not open file ${pyRepr(path)}: ${osErrorReason(error)}\n`,
    );
    throw new Exit(1);
  }
}

import { readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { expandUser } from "../../core/config.ts";
import { wrapText } from "../../core/help/formatter.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { Exit, type Invocation } from "../../lib/io.ts";

async function shell(io: Invocation, command: string) {
  const args =
    process.platform === "win32"
      ? [io.env.ComSpec ?? "cmd.exe", "/c", command]
      : ["/bin/sh", "-c", command];
  const child = Bun.spawn(args, {
    env: io.env,
    cwd: io.cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([child.stdout.text(), child.exited]);
  return { stdout, code };
}

async function findExecutables(
  cwd: string,
  path: string,
  name: string,
  matches: string[],
) {
  const entries = await readdir(resolve(cwd, path), {
    withFileTypes: true,
  }).catch(() => []);
  const prefix = path && !path.endsWith(sep) ? path + sep : path;
  if (entries.some((entry) => entry.name === name)) matches.push(prefix + name);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = prefix + entry.name;
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await stat(resolve(cwd, child)).then(
          (target) => target.isDirectory(),
          () => false,
        )))
    ) {
      await findExecutables(cwd, child, name, matches);
    }
  }
}

export async function runFindInstallations({ io }: CustomCommandContext) {
  const packages: string[] = [];
  const executables: string[] = [];
  io.out("Checking for CLI installer script default installation...\n");
  const installer = expandUser("~/lib/oracle-cli", io.env);
  if (
    await stat(resolve(io.cwd, installer)).then(
      () => true,
      () => false,
    )
  )
    packages.push(`CLI Installer Script: ${installer}`);

  io.out("Checking for Homebrew installation...\n");
  const brew = await shell(io, "brew list");
  if (brew.code === 0 && brew.stdout.includes("oci-cli")) {
    const cellar = await shell(io, "brew --cellar oci-cli");
    const prefix = await shell(io, "brew --prefix oci-cli");
    packages.push(`Homebrew: ${cellar.stdout.trim()}, ${prefix.stdout.trim()}`);
  }

  const fail = () => {
    io.err("IndexError: list index out of range\n");
    throw new Exit(1);
  };
  io.out("Checking for yum installation...\n");
  const yum = await shell(io, "yum list installed");
  if (yum.code === 0 && yum.stdout.includes("oci-cli")) {
    const version = /python([0-9]+)-oci-cli/.exec(yum.stdout)?.[1] ?? fail();
    packages.push(
      `yum: /usr/lib/python${[...version].join(".")}/site-packages/oci_cli`,
    );
  }

  io.out("Checking for pip installation...\n");
  const pip = await shell(io, "pip3 show oci-cli");
  if (pip.code === 0) {
    const location =
      /Location: [^\n]*\n/.exec(pip.stdout)?.[0].trim().split(/\s+/)[1] ??
      fail();
    packages.push(`pip3: ${join(location, "oci_cli")}`);
  }

  io.out("Searching for CLI executables on your $PATH...\n");
  const path = io.env.PATH;
  if (path === undefined) {
    io.out("No PATH variable found in your environment\n");
  } else {
    io.out(`Your current $PATH is ${path}\n`);
    const name = process.platform === "win32" ? "oci.exe" : "oci";
    for (const dir of path.split(delimiter))
      await findExecutables(io.cwd, dir, name, executables);
  }

  io.out("\n");
  if (packages.length) {
    io.out("The following OCI CLI package installations were found:\n\n");
    packages.forEach((item, i) => io.out(`\t[${i + 1}] ${item}\n`));
  } else {
    io.out("No OCI CLI package installations were found\n");
  }
  io.out("\n");
  if (executables.length) {
    io.out("The following OCI CLI executables were found on your $PATH:\n\n");
    executables.forEach((item, i) => io.out(`\t[${i + 1}] ${item}\n`));
  } else {
    io.out("No OCI CLI executables were found on your $PATH\n");
  }
  io.out("\n");
  io.out(
    wrapText(
      "Visit https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliuninstall.htm to uninstall OCI-CLI",
    ) + "\n",
  );
  io.out(
    wrapText(
      "PLEASE NOTE: This command lists CLI installations in default locations and CLI executables on your $PATH. There may be additional (unlisted) CLI installations at other non-default locations or CLI executables that are not on your current $PATH.",
    ) + "\n",
  );
  // The Reference CLI's wrapped ctx.exit() is reported as an Exit exception.
  io.err("Exit: 0\n");
  throw new Exit(1);
}

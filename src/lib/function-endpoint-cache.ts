import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandUser } from "../core/config.ts";
import { expandVars } from "../core/rc.ts";
import type { Invocation } from "./io.ts";

const filename = "functions-invoke-endpoint-cache.json";
type Entry = {
  key: Record<string, string>;
  endpoint: string;
  cached_at: string;
};

export function functionEndpointCache(
  io: Invocation,
  context: Record<string, unknown>,
  functionId: unknown,
) {
  const configFile = context.config_file
    ? resolve(
        io.cwd,
        expandVars(expandUser(String(context.config_file), io.env), io.env),
      )
    : "";
  const dir = configFile
    ? dirname(configFile)
    : join(expandUser("~", io.env), ".oci");
  const file = join(dir, filename);
  const toText = (value: unknown) =>
    value == null
      ? ""
      : value === true
        ? "True"
        : value === false
          ? "False"
          : String(value);
  const key = {
    auth: toText(context.auth),
    config_file: configFile,
    enable_dual_stack: toText(context.enable_dual_stack),
    endpoint: toText(context.endpoint),
    function_id: toText(functionId),
    profile: toText(context.profile),
    region: toText(context.region),
  };
  // Python json.dumps uses spaces and ASCII escapes by default.
  const jsonKey = `{${Object.entries(key)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")}}`.replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const hash = Bun.CryptoHasher.hash("sha256", jsonKey, "hex");

  function read(): Record<string, Entry> {
    try {
      const { version, entries } = JSON.parse(readFileSync(file, "utf8"));
      if (
        version === 1 &&
        entries &&
        typeof entries === "object" &&
        !Array.isArray(entries)
      )
        return entries;
    } catch {
      // The Reference CLI treats unreadable cache files as empty.
    }
    return {};
  }

  function write(entries: Record<string, Entry>) {
    const tmp = join(dir, `.${filename}.${Bun.randomUUIDv7()}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        tmp,
        `${JSON.stringify({ entries, version: 1 }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(tmp, file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* Best effort. */
      }
    }
  }

  return {
    get(ttl: number) {
      if (ttl <= 0) return undefined;
      const entry = read()[hash];
      const date = Date.parse(entry?.cached_at ?? "");
      if (
        typeof entry?.endpoint === "string" &&
        Date.now() - date <= ttl * 1000
      )
        return entry.endpoint || undefined;
    },
    put(endpoint: string) {
      const entries = read();
      entries[hash] = {
        key,
        endpoint,
        cached_at: new Date().toISOString().replace("Z", "000Z"),
      };
      write(entries);
    },
    delete() {
      const entries = read();
      if (!Object.hasOwn(entries, hash)) return;
      delete entries[hash];
      write(entries);
    },
  };
}

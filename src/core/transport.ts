import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "../lib/io.ts";
import { isNoProxyHost } from "../utils/isNoProxyHost.ts";
import { expandUser } from "./config.ts";

/** Resolve proxy URL and custom CA bundle from invocation env (mirrors Python requests). */
export function fetchTransportFromEnv(
  url: string,
  env: Env,
  cwd: string,
): { proxy?: string; tls?: { ca: string } } {
  const parsed = new URL(url);
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  let proxy: string | undefined;
  if (!isNoProxyHost(parsed.hostname, noProxy)) {
    const raw =
      parsed.protocol === "https:"
        ? (env.HTTPS_PROXY ?? env.https_proxy)
        : (env.HTTP_PROXY ?? env.http_proxy);
    if (raw) proxy = raw;
  }
  const caPath = env.REQUESTS_CA_BUNDLE ?? env.CURL_CA_BUNDLE;
  let tls: { ca: string } | undefined;
  if (caPath) {
    const resolvedCa = resolve(cwd, expandUser(caPath, env));
    if (existsSync(resolvedCa)) {
      tls = { ca: readFileSync(resolvedCa, "utf8") };
    }
  }
  return {
    ...(proxy ? { proxy } : {}),
    ...(tls ? { tls } : {}),
  };
}

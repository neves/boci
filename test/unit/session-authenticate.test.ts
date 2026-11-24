import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import type { Rc } from "../../src/core/rc.ts";
import {
  getConsoleAuthUrl,
  openBrowser,
  runSessionAuthenticate,
  toJwk,
} from "../../src/commands/session.ts";
import {
  PRIVATE_KEY_LABEL,
  generateKey,
  publicKeyToFingerprint,
} from "../../src/commands/setup.ts";
import {
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
} from "../../src/core/signer.ts";
import { loadIndex, loadService } from "../../src/core/spec.ts";
import { getPosixMode, setPosixMode } from "../../src/lib/posixMode.ts";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";
import { FAKE, FAKE_KEY_PEM } from "../harness/sandbox.ts";

const EMPTY_RC: Rc = {
  path: "",
  parsed: null,
  settings: {},
  cannedQueries: {},
  globalCommandAliases: {},
  commandSequenceAliases: {},
  parameterAliases: {},
};

const SAMPLE_JWT = [
  Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
    "base64url",
  ),
  Buffer.from(
    JSON.stringify({
      sub: "ocid1.user.oc1..unituser",
      tenant: "ocid1.tenancy.oc1..unittenancy",
      exp: 4102444800,
    }),
  ).toString("base64url"),
  "sig",
].join(".");

describe("session authenticate helpers", () => {
  test("toJwk formats RSA public key matching oci_cli.cli_util.to_jwk", () => {
    const { publicKey } = generateKey(2048);
    const jwkText = toJwk(publicKey);
    expect(jwkText).toMatch(
      /^\{"kty": "RSA", "n": "[A-Za-z0-9_-]+", "e": "AQAB", "kid": "Ignored"\}$/,
    );
    const parsed = JSON.parse(jwkText) as Record<string, string>;
    expect(parsed.kty).toBe("RSA");
    expect(parsed.e).toBe("AQAB");
    expect(parsed.kid).toBe("Ignored");
  });

  test("getConsoleAuthUrl handles OC1, non-OC1, dual-stack, and external realms", async () => {
    const index = await loadIndex();
    expect(getConsoleAuthUrl("us-phoenix-1", index.regions, false)).toBe(
      "https://login.us-phoenix-1.oraclecloud.com/v1/oauth2/authorize",
    );
    expect(getConsoleAuthUrl("us-phoenix-1", index.regions, true)).toBe(
      "https://login.us-phoenix-1.ds.oci.oraclecloud.com/v1/oauth2/authorize",
    );
    // Non-OC1 realm does not use dual-stack login endpoint.
    expect(getConsoleAuthUrl("us-langley-1", index.regions, true)).toBe(
      "https://login.us-langley-1.oraclegovcloud.com/v1/oauth2/authorize",
    );
    expect(
      getConsoleAuthUrl("ap-custom-1", index.regions, false, {
        realmKey: "oc99",
        realmDomainComponent: "example-oci.com",
      }),
    ).toBe("https://login.ap-custom-1.example-oci.com/v1/oauth2/authorize");
  });

  test("openBrowser returns false when BROWSER is empty or headless without DISPLAY", () => {
    expect(openBrowser("https://example.com", { BROWSER: "" })).toBe(false);
    if (process.platform === "linux") {
      expect(openBrowser("https://example.com", { PATH: "/usr/bin" })).toBe(
        false,
      );
    }
  });
});

describe("session authenticate browser flow", () => {
  test("serves OAuth callback, writes keys/token/config, and validates JWK & URL params", async () => {
    const home = (
      await mkdtemp(join(tmpdir(), "boci-auth-browser-"))
    ).replaceAll("\\", "/");
    const index = await loadIndex();
    const spec = await loadService("session");
    // Reserve an ephemeral free port, release it, and pass to runSessionAuthenticate.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    probe.stop(true);

    try {
      await mkdir(join(home, ".oci"), { mode: 0o700 });
      let stdout = "";
      let stderr = "";
      let openedUrl = "";

      const authPromise = runSessionAuthenticate(
        {
          argv: ["session", "authenticate"],
          env: { HOME: home, LC_ALL: "C.UTF-8" },
          cwd: home,
          out: (s) => {
            stdout += s;
          },
          err: (s) => {
            stderr += s;
          },
          isTTY: () => false,
          columns: () => undefined,
        },
        {
          values: {
            profile_name: "BROWSER_SESS",
            tenancy_name: "mytenant",
            identity_provider_name: "myidp",
          },
          rootValues: {
            region: "phx",
            enable_dual_stack: true,
          },
          settings: {
            configFile: "~/.oci/config",
            profile: "DEFAULT",
            auth: null,
          },
          rc: EMPTY_RC,
          index,
          spec,
          browserPort: port,
          openBrowserFn: (url) => {
            openedUrl = url;
            return true;
          },
        },
      );

      // Wait briefly for the callback server to listen and invoke openBrowserFn.
      for (let i = 0; i < 50 && !openedUrl; i++) {
        await Bun.sleep(10);
      }
      expect(openedUrl).not.toBe("");

      const parsedUrl = new URL(openedUrl);
      expect(parsedUrl.origin).toBe(
        "https://login.us-phoenix-1.ds.oci.oraclecloud.com",
      );
      expect(parsedUrl.pathname).toBe("/v1/oauth2/authorize");
      expect(parsedUrl.searchParams.get("action")).toBe("login");
      expect(parsedUrl.searchParams.get("client_id")).toBe("iaas_console");
      expect(parsedUrl.searchParams.get("response_type")).toBe(
        "token id_token",
      );
      expect(parsedUrl.searchParams.get("scope")).toBe("openid");
      expect(parsedUrl.searchParams.get("redirect_uri")).toBe(
        `http://localhost:${port}`,
      );
      expect(parsedUrl.searchParams.get("tenant")).toBe("mytenant");
      expect(parsedUrl.searchParams.get("provider")).toBe("myidp");
      expect(parsedUrl.searchParams.get("nonce")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Step 1: browser lands on GET / and receives the JS hash-forwarding page.
      const rootResp = await fetch(`http://127.0.0.1:${port}/`);
      expect(rootResp.status).toBe(200);
      const html = await rootResp.text();
      expect(html).toContain("Authorization completed!");
      expect(html).toContain('oReq.open("GET", "/token?" + hash)');

      // Step 2: browser JS forwards the security_token to /token?security_token=...
      const tokenResp = await fetch(
        `http://127.0.0.1:${port}/token?security_token=${encodeURIComponent(SAMPLE_JWT)}`,
      );
      expect(tokenResp.status).toBe(200);

      await authPromise;
      expect(stderr).toBe("");
      expect(stdout).toContain(
        "    Please switch to newly opened browser window to log in!\n",
      );
      expect(stdout).toContain(
        "    Completed browser authentication process!\n",
      );
      expect(stdout).toContain(`Config written to: ${home}/.oci/config\n`);

      const sessDir = `${home}/.oci/sessions/BROWSER_SESS`;
      const pubPem = await readFile(
        `${sessDir}/oci_api_key_public.pem`,
        "utf8",
      );
      const privPem = await readFile(`${sessDir}/oci_api_key.pem`, "utf8");
      const tokenText = await readFile(`${sessDir}/token`, "utf8");
      const configText = await readFile(`${home}/.oci/config`, "utf8");

      expect(tokenText).toBe(SAMPLE_JWT);
      expect(privPem.endsWith(PRIVATE_KEY_LABEL)).toBe(true);
      const privObj = loadPrivateKey(privPem, null);
      const pubObj = createPublicKey(pubPem);
      const fp = publicKeyToFingerprint(pubObj);
      expect(publicKeyToFingerprint(createPublicKey(privObj))).toBe(fp);

      // Verify public_key query param decodes to the JWK of the persisted public key.
      const encodedJwk = parsedUrl.searchParams.get("public_key")!;
      const decodedJwk = Buffer.from(
        encodedJwk.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8");
      expect(decodedJwk).toBe(toJwk(pubObj));

      expect(configText).toContain("[BROWSER_SESS]\n");
      expect(configText).toContain(`fingerprint=${fp}\n`);
      expect(configText).toContain(`key_file=${sessDir}/oci_api_key.pem\n`);
      expect(configText).toContain("tenancy=ocid1.tenancy.oc1..unittenancy\n");
      expect(configText).toContain("region=us-phoenix-1\n");
      expect(configText).toContain(`security_token_file=${sessDir}/token\n`);
      expect(configText).not.toContain("user=");

      expect(getPosixMode(sessDir)).toBe(0o700);
      expect(getPosixMode(`${sessDir}/oci_api_key.pem`)).toBe(0o600);
      expect(getPosixMode(`${sessDir}/oci_api_key_public.pem`)).toBe(0o600);
      expect(getPosixMode(`${sessDir}/token`)).toBe(0o600);
      expect(getPosixMode(`${home}/.oci/config`)).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails cleanly when callback port is already in use", async () => {
    const home = await mkdtemp(join(tmpdir(), "boci-auth-inuse-"));
    const index = await loadIndex();
    const spec = await loadService("session");
    const blocker = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    const busyPort = blocker.port!;

    try {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        await runSessionAuthenticate(
          {
            argv: ["session", "authenticate"],
            env: { HOME: home, LC_ALL: "C.UTF-8" },
            cwd: home,
            out: (s) => {
              stdout += s;
            },
            err: (s) => {
              stderr += s;
            },
            isTTY: () => false,
            columns: () => undefined,
          },
          {
            values: { profile_name: "BUSY" },
            rootValues: { region: "us-phoenix-1" },
            settings: {
              configFile: "~/.oci/config",
              profile: "DEFAULT",
              auth: null,
            },
            rc: EMPTY_RC,
            index,
            spec,
            browserPort: busyPort,
            openBrowserFn: () => false,
          },
        );
      } catch (e) {
        exitCode = (e as { code?: number }).code ?? 1;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(stdout).toBe(
        `Could not complete bootstrap process because port ${busyPort} is already in use.\n`,
      );
    } finally {
      blocker.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("session authenticate --no-browser generated keypair", () => {
  test("generates an encrypted RSA keypair, sends public key, and persists session", async () => {
    const home = (
      await mkdtemp(join(tmpdir(), "boci-auth-genkey-"))
    ).replaceAll("\\", "/");
    using fake = startFakeEndpoint({
      status: 200,
      body: { token: SAMPLE_JWT },
    });
    try {
      const ociDir = `${home}/.oci`;
      await mkdir(ociDir, { mode: 0o700 });
      setPosixMode(ociDir, 0o700);
      const keyPath = `${ociDir}/key.pem`;
      await Bun.write(keyPath, `${FAKE_KEY_PEM.trimEnd()}\nOCI_API_KEY\n`);
      setPosixMode(keyPath, 0o600);
      const authFp = publicKeyToFingerprint(
        createPublicKey(loadPrivateKey(FAKE_KEY_PEM, null)),
      );
      await Bun.write(
        `${ociDir}/config`,
        [
          "[DEFAULT]",
          `user=${FAKE.user}`,
          `fingerprint=${authFp}`,
          `tenancy=${FAKE.tenancy}`,
          "region=us-phoenix-1",
          `key_file=${keyPath}`,
          "",
        ].join("\n"),
      );
      setPosixMode(`${ociDir}/config`, 0o600);

      let stdout = "";
      let stderr = "";
      const exitCode = await run({
        argv: [
          "session",
          "authenticate",
          "--region",
          "us-phoenix-1",
          "--no-browser",
          "--profile-name",
          "GENKEY",
          "--use-passphrase",
          "--config-location",
          `${ociDir}/gen_config`,
          "--endpoint",
          fake.url,
        ],
        env: { HOME: home, LC_ALL: "C.UTF-8" },
        cwd: home,
        stdin: "s3cr3t\ns3cr3t\nn\n",
        out: (s) => {
          stdout += s;
        },
        err: (s) => {
          stderr += s;
        },
        isTTY: () => false,
        columns: () => undefined,
      });

      expect(exitCode).toBe(0);
      expect(fake.requests).toHaveLength(1);
      const reqBody = JSON.parse(fake.requests[0]!.body) as {
        publicKey: string;
        sessionExpirationInMinutes: string;
      };
      expect(reqBody.sessionExpirationInMinutes).toBe("60");

      const sessDir = `${ociDir}/sessions/GENKEY`;
      const pubPem = await readFile(
        `${sessDir}/oci_api_key_public.pem`,
        "utf8",
      );
      const privPem = await readFile(`${sessDir}/oci_api_key.pem`, "utf8");
      expect(reqBody.publicKey).toBe(pubPem);
      expect(privPem.endsWith(PRIVATE_KEY_LABEL)).toBe(true);
      expect(() => loadPrivateKey(privPem, null)).toThrow(
        MissingPrivateKeyPassphrase,
      );
      const decrypted = loadPrivateKey(privPem, "s3cr3t");
      const fp = publicKeyToFingerprint(createPublicKey(decrypted));
      expect(publicKeyToFingerprint(createPublicKey(pubPem))).toBe(fp);

      const genConfig = await readFile(`${ociDir}/gen_config`, "utf8");
      expect(genConfig).toContain("[GENKEY]\n");
      expect(genConfig).toContain(`fingerprint=${fp}\n`);
      expect(genConfig).toContain(`key_file=${sessDir}/oci_api_key.pem\n`);
      expect(genConfig).not.toContain("pass_phrase=");
      expect(stdout).toContain(`Config written to: ${ociDir}/gen_config\n`);
      expect(stderr).toContain("Warning: Password input may be echoed.");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

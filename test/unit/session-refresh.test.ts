import { describe, expect, test } from "bun:test";
import { fetchTransportFromEnv, isNoProxyHost } from "../../src/session.ts";
import { FAKE_HTTPS_CERT_PATH } from "../harness/fake-https-proxy.ts";

describe("session refresh transport helpers", () => {
  test("isNoProxyHost matches exact, suffix, leading dot, port, and wildcard", () => {
    expect(isNoProxyHost("127.0.0.1", "127.0.0.1,localhost")).toBe(true);
    expect(isNoProxyHost("localhost", "127.0.0.1,localhost")).toBe(true);
    expect(
      isNoProxyHost("auth.us-ashburn-1.oraclecloud.com", "127.0.0.1,localhost"),
    ).toBe(false);
    expect(
      isNoProxyHost("auth.us-ashburn-1.oraclecloud.com", ".oraclecloud.com"),
    ).toBe(true);
    expect(
      isNoProxyHost("auth.us-ashburn-1.oraclecloud.com", "oraclecloud.com:443"),
    ).toBe(true);
    expect(isNoProxyHost("anything.example.com", "*")).toBe(true);
    expect(isNoProxyHost("example.com", "")).toBe(false);
  });

  test("fetchTransportFromEnv selects HTTPS_PROXY and REQUESTS_CA_BUNDLE", () => {
    const transport = fetchTransportFromEnv(
      "https://auth.us-ashburn-1.oraclecloud.com/v1/authentication/refresh",
      {
        HTTPS_PROXY: "http://127.0.0.1:8080",
        NO_PROXY: "127.0.0.1,localhost",
        REQUESTS_CA_BUNDLE: FAKE_HTTPS_CERT_PATH,
      },
      process.cwd(),
    );
    expect(transport.proxy).toBe("http://127.0.0.1:8080");
    expect(transport.tls?.ca).toContain("BEGIN CERTIFICATE");
  });

  test("fetchTransportFromEnv honors NO_PROXY bypass", () => {
    const transport = fetchTransportFromEnv(
      "https://auth.us-ashburn-1.oraclecloud.com/v1/authentication/refresh",
      {
        HTTPS_PROXY: "http://127.0.0.1:8080",
        NO_PROXY: "oraclecloud.com",
      },
      process.cwd(),
    );
    expect(transport.proxy).toBeUndefined();
    expect(transport.tls).toBeUndefined();
  });
});

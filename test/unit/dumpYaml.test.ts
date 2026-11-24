import { describe, expect, test } from "bun:test";
import { dumpYaml } from "../../src/utils/dumpYaml.ts";

describe("dumpYaml", () => {
  test("serializes kubeconfig with PyYAML block layout and sorted keys", () => {
    const kubeconfig = {
      kind: "Config",
      apiVersion: "v1",
      clusters: [
        {
          name: "cluster-c1",
          cluster: {
            server: "https://1.2.3.4:6443",
            "certificate-authority-data": "LS0tLS1CRUdJTi==",
          },
        },
      ],
      contexts: [
        {
          name: "context-c1",
          context: { user: "user-c1", cluster: "cluster-c1" },
        },
      ],
      "current-context": "context-c1",
      preferences: {},
      users: [
        {
          name: "user-c1",
          user: {
            exec: {
              command: "oci",
              apiVersion: "client.authentication.k8s.io/v1beta1",
              args: [
                "ce",
                "cluster",
                "generate-token",
                "--cluster-id",
                "ocid1.cluster.oc1..test",
              ],
              env: [],
            },
          },
        },
      ],
    };

    expect(dumpYaml(kubeconfig)).toBe(
      [
        "apiVersion: v1",
        "clusters:",
        "- cluster:",
        "    certificate-authority-data: LS0tLS1CRUdJTi==",
        "    server: https://1.2.3.4:6443",
        "  name: cluster-c1",
        "contexts:",
        "- context:",
        "    cluster: cluster-c1",
        "    user: user-c1",
        "  name: context-c1",
        "current-context: context-c1",
        "kind: Config",
        "preferences: {}",
        "users:",
        "- name: user-c1",
        "  user:",
        "    exec:",
        "      apiVersion: client.authentication.k8s.io/v1beta1",
        "      args:",
        "      - ce",
        "      - cluster",
        "      - generate-token",
        "      - --cluster-id",
        "      - ocid1.cluster.oc1..test",
        "      command: oci",
        "      env: []",
        "",
      ].join("\n"),
    );
  });

  test("matches PyYAML for root scalars, empty collections, nested sequences, and quoting", () => {
    expect(dumpYaml(null)).toBe("null\n...\n");
    expect(dumpYaml(true)).toBe("true\n...\n");
    expect(dumpYaml(42)).toBe("42\n...\n");
    expect(dumpYaml("hello")).toBe("hello\n...\n");
    expect(dumpYaml({})).toBe("{}\n");
    expect(dumpYaml([])).toBe("[]\n");
    expect(
      dumpYaml([
        [1, 2],
        [3, 4],
      ]),
    ).toBe("- - 1\n  - 2\n- - 3\n  - 4\n");
    expect(dumpYaml({ a: "café" })).toBe('a: "caf\\xE9"\n');
    expect(
      dumpYaml({
        boolStr: "yes",
        empty: "",
        flag: "--cluster-id",
        numStr: "123",
        spacedColon: "a: b",
        ver: "2.0.0",
      }),
    ).toBe(
      [
        "boolStr: 'yes'",
        "empty: ''",
        "flag: --cluster-id",
        "numStr: '123'",
        "spacedColon: 'a: b'",
        "ver: 2.0.0",
        "",
      ].join("\n"),
    );
  });
});

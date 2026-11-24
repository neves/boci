import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function setupFakeBin(ghScript: string): { binDir: string; logFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "boci-ci-installs-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  rmSync(binDir, { recursive: true, force: true });
  const fs = require("node:fs");
  fs.mkdirSync(binDir);

  const logFile = join(dir, "gh.log");
  writeFileSync(logFile, "");

  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\nset -euo pipefail\necho "$*" >> "${logFile}"\n${ghScript}\n`,
  );
  chmodSync(ghPath, 0o755);

  const sleepPath = join(binDir, "sleep");
  writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(sleepPath, 0o755);

  return { binDir, logFile };
}

function runCiInstalls(binDir: string) {
  const scriptPath = join(import.meta.dir, "../../tasks/ci-installs");
  return Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const testPosix = test.skipIf(process.platform === "win32");

testPosix(
  "ci-installs waits until GitHub registers the new run ID before watching it",
  () => {
    const stateDir = mkdtempSync(join(tmpdir(), "boci-ci-state-"));
    tempDirs.push(stateDir);
    const counterFile = join(stateDir, "attempts");
    writeFileSync(counterFile, "0");

    const { binDir, logFile } = setupFakeBin(`
    if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
      echo "https://github.com/neves/boci/actions/runs/987654321"
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "view" ]; then
      for arg in "$@"; do
        if [ "$arg" = "--log" ]; then
          echo "workflow logs"
          exit 0
        fi
      done
      count=$(cat "${counterFile}")
      count=$((count + 1))
      echo "$count" > "${counterFile}"
      if [ "$count" -lt 3 ]; then
        echo "HTTP 404: Not Found (https://api.github.com/repos/neves/boci/actions/runs/987654321)" >&2
        exit 1
      fi
      echo '{"databaseId":987654321}'
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "watch" ]; then
      count=$(cat "${counterFile}")
      if [ "$count" -lt 3 ]; then
        echo "HTTP 404: Not Found (https://api.github.com/repos/neves/boci/actions/runs/987654321)" >&2
        exit 1
      fi
      exit 0
    fi
    exit 1
  `);

    const result = runCiInstalls(binDir);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const calls = readFileSync(logFile, "utf8").trim().split("\n");

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain(
      "https://github.com/neves/boci/actions/runs/987654321",
    );
    expect(stdout).toContain("workflow logs");
    expect(stderr).not.toContain("HTTP 404");
    expect(
      calls.some((line) =>
        line.startsWith("run watch 987654321 --exit-status"),
      ),
    ).toBe(true);
  },
);

testPosix(
  "ci-installs falls back to polling gh run list when workflow run output omits the ID",
  () => {
    const stateDir = mkdtempSync(join(tmpdir(), "boci-ci-state-"));
    tempDirs.push(stateDir);
    const listCounter = join(stateDir, "list-attempts");
    writeFileSync(listCounter, "0");

    const { binDir, logFile } = setupFakeBin(`
    if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
      echo "✓ Created workflow_dispatch event for test-installs.yml at main"
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "list" ]; then
      count=$(cat "${listCounter}")
      count=$((count + 1))
      echo "$count" > "${listCounter}"
      if [ "$count" -lt 2 ]; then
        exit 0
      fi
      echo "112233445"
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "view" ]; then
      for arg in "$@"; do
        if [ "$arg" = "--log" ]; then
          echo "fallback logs"
          exit 0
        fi
      done
      echo '{"databaseId":112233445}'
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "watch" ]; then
      exit 0
    fi
    exit 1
  `);

    const result = runCiInstalls(binDir);
    const calls = readFileSync(logFile, "utf8").trim().split("\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("fallback logs");
    expect(
      calls.some((line) =>
        line.startsWith("run watch 112233445 --exit-status"),
      ),
    ).toBe(true);
  },
);

testPosix(
  "ci-installs propagates non-zero exit when gh run watch fails",
  () => {
    const { binDir } = setupFakeBin(`
    if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
      echo "https://github.com/neves/boci/actions/runs/555666777"
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "view" ]; then
      echo '{"databaseId":555666777}'
      exit 0
    fi
    if [ "$1" = "run" ] && [ "$2" = "watch" ]; then
      echo "Run 555666777 failed" >&2
      exit 1
    fi
    exit 1
  `);

    const result = runCiInstalls(binDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Run 555666777 failed");
  },
);

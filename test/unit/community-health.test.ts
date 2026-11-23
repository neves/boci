import { expect, test } from "bun:test";

const root = `${import.meta.dir}/../..`;

test("package.json includes required npm discovery metadata", async () => {
  const pkg = await Bun.file(`${root}/package.json`).json();

  expect(pkg.license).toBe("MIT");
  expect(pkg.repository).toEqual({
    type: "git",
    url: "git+https://github.com/neves/boci.git",
  });
  expect(pkg.homepage).toBe("https://github.com/neves/boci#readme");
  expect(pkg.bugs).toEqual({
    url: "https://github.com/neves/boci/issues",
  });
  expect(Array.isArray(pkg.keywords)).toBe(true);
  expect(pkg.keywords.length).toBeGreaterThan(0);
});

test("SECURITY.md documents security and credential-handling vulnerability reporting", async () => {
  const file = Bun.file(`${root}/SECURITY.md`);
  expect(await file.exists()).toBe(true);

  const text = await file.text();
  expect(text.toLowerCase()).toContain("security");
  expect(text).toContain("github.com/neves/boci/security/advisories");
  expect(text.toLowerCase()).toContain("credential");
});

test("CONTRIBUTING.md documents verification checks, parity cases, and sensitive recordings", async () => {
  const file = Bun.file(`${root}/CONTRIBUTING.md`);
  expect(await file.exists()).toBe(true);

  const text = await file.text();
  expect(text).toContain("bun run verify");
  expect(text).toContain("test/parity/cases");
  expect(text).toContain("bun run golden");
  expect(text.toLowerCase()).toContain("recording");
  expect(text).toContain("~/.oci");
});

test("CHANGELOG.md exists and release workflow generates release notes", async () => {
  const changelog = Bun.file(`${root}/CHANGELOG.md`);
  expect(await changelog.exists()).toBe(true);

  const changelogText = await changelog.text();
  expect(changelogText).toContain("## [Unreleased]");
  expect(changelogText).toContain("## [0.0.1]");

  const releaseWorkflow = await Bun.file(
    `${root}/.github/workflows/release.yml`,
  ).text();
  expect(releaseWorkflow).toContain("generate_release_notes: true");
  expect(releaseWorkflow).toContain("CHANGELOG.md");
});

test("parity mismatch issue template prompts for oci vs boci output, exit codes, and version info", async () => {
  const templateFile = Bun.file(
    `${root}/.github/ISSUE_TEMPLATE/parity_mismatch.yml`,
  );
  expect(await templateFile.exists()).toBe(true);

  const text = await templateFile.text();
  const parsed = Bun.YAML.parse(text) as {
    name?: string;
    description?: string;
    body?: Array<{ id?: string; attributes?: { label?: string } }>;
  };

  expect(parsed.name).toBeTruthy();
  expect(parsed.description).toBeTruthy();
  expect(Array.isArray(parsed.body)).toBe(true);

  const labels = (parsed.body ?? [])
    .map((item) => item.attributes?.label?.toLowerCase() ?? "")
    .join("\n");
  expect(labels).toContain("oci");
  expect(labels).toContain("boci");
  expect(labels).toContain("exit code");
  expect(labels).toContain("version");
});

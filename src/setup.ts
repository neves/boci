import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { expandUser } from "./config.ts";
import { BadParameter } from "./convert.ts";
import { Exit, type Invocation } from "./io.ts";
import { validateClickFileForRead } from "./os.ts";

export const DEFAULT_KEY_NAME = "oci_api_key";
export const DEFAULT_DIRECTORY = "~/.oci";
export const PUBLIC_KEY_FILENAME_SUFFIX = "_public.pem";
export const PRIVATE_KEY_FILENAME_SUFFIX = ".pem";
export const NO_PASSPHRASE = "N/A";
export const PRIVATE_KEY_LABEL = "OCI_API_KEY";

const UPLOAD_PUBLIC_KEY_INSTRUCTIONS =
  "\n\n" +
  "    If you haven't already uploaded your API Signing public key through the\n" +
  "    console, follow the instructions on the page linked below in the section\n" +
  "    'How to upload the public key':\n\n" +
  "        https://docs.cloud.oracle.com/Content/API/Concepts/apisigningkey.htm#How2\n\n\n";

type StdinReader = {
  readLine(): Promise<string | null>;
  consumeAll(): Promise<string>;
  isExhausted(): boolean;
};

function createStdinReader(io: Invocation): StdinReader {
  if (io.readLine) {
    const readLineFn = io.readLine.bind(io);
    let exhausted = false;
    return {
      async readLine() {
        if (exhausted) return null;
        const line = await readLineFn();
        if (line === null) exhausted = true;
        return line;
      },
      async consumeAll() {
        if (exhausted) return "";
        if (io.isTTY(0)) {
          const line = await readLineFn();
          if (line === null) {
            exhausted = true;
            return "";
          }
          return `${line}\n`;
        }
        exhausted = true;
        try {
          return readFileSync(0, "utf8");
        } catch {
          return "";
        }
      },
      isExhausted: () => exhausted,
    };
  }
  const raw = io.stdin ?? "";
  let exhausted = raw.length === 0;
  const lines = exhausted ? [] : raw.split(/\r?\n/);
  if (!exhausted && raw.endsWith("\n")) lines.pop();
  let idx = 0;
  return {
    async readLine() {
      if (exhausted || idx >= lines.length) {
        exhausted = true;
        return null;
      }
      return lines[idx++] as string;
    },
    async consumeAll() {
      if (exhausted) return "";
      exhausted = true;
      return raw ?? "";
    },
    isExhausted: () => exhausted,
  };
}

/**
 * cli_util.apply_user_only_access_permissions (Unix): 0o600 for files, 0o700 for directories.
 */
export function applyUserOnlyAccessPermissions(path: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new Error(
      `Failed attempting to set permissions on path that does not exist: ${path}`,
    );
  }
  chmodSync(path, st.isFile() ? 0o600 : 0o700);
}

/** cli_util.create_directory: create directory tree and restrict the target dir to 0o700. */
export function createDirectory(dirname: string): void {
  mkdirSync(dirname, { recursive: true });
  applyUserOnlyAccessPermissions(dirname);
}

/** cli_util.generate_key: 2048-bit RSA key pair with public exponent 65537. */
export function generateKey(keySize = 2048): {
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  return generateKeyPairSync("rsa", {
    modulusLength: keySize,
    publicExponent: 0x10001,
  });
}

/** cli_util.serialize_key for a public key (SubjectPublicKeyInfo PEM). */
export function serializePublicKey(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** cli_util.serialize_key for a private key (PKCS#8 PEM, encrypted when passphrase is given). */
export function serializePrivateKey(
  privateKey: KeyObject,
  passphrase?: string | null,
): string {
  if (passphrase) {
    return privateKey
      .export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase,
      })
      .toString();
  }
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** cli_setup.public_key_to_fingerprint: colon-separated MD5 of SPKI DER bytes. */
export function publicKeyToFingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  const hex = createHash("md5").update(der).digest("hex");
  return hex.match(/../g)?.join(":") ?? hex;
}

/** Python os.path.join(dir, name) for POSIX paths without collapsing leading `./`. */
function pyPathJoin(dir: string, name: string): string {
  if (name.startsWith("/")) return name;
  if (dir === "") return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Python file.readline() in universal-newline text mode. */
function readFirstLine(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const nl = normalized.indexOf("\n");
  return nl === -1 ? normalized : normalized.slice(0, nl + 1);
}

/** Click `click.confirm(text, default=False, err=False)`. */
async function confirmClick(
  io: Invocation,
  stdin: StdinReader,
  text: string,
): Promise<boolean> {
  const prompt = `${text} [y/N]: `;
  while (true) {
    io.out(prompt);
    const line = await stdin.readLine();
    if (line === null) {
      io.err("Aborted!\n");
      throw new Exit(1);
    }
    const normalized = line.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no" || normalized === "")
      return false;
    io.out("Error: invalid input\n");
  }
}

/** cli_setup.prompt_for_passphrase: hidden prompt with confirmation. */
async function promptForPassphrase(
  io: Invocation,
  stdin: StdinReader,
): Promise<string | null> {
  const promptText = `Enter a passphrase for your private key ("${NO_PASSPHRASE}" for no passphrase): `;
  const confirmText = "Repeat for confirmation: ";
  const readHidden = async (prompt: string): Promise<string> => {
    if (io.promptSecret) {
      const line = await io.promptSecret(prompt);
      if (line === null) {
        io.out("\n");
        io.err("Aborted!\n");
        throw new Exit(1);
      }
      return line;
    }
    io.err(`Warning: Password input may be echoed.\n${prompt}`);
    const line = await stdin.readLine();
    if (line === null) {
      io.out("\n");
      io.err("Aborted!\n");
      throw new Exit(1);
    }
    io.err("\n");
    return line;
  };

  while (true) {
    let value = "";
    while (true) {
      value = await readHidden(promptText);
      if (value) break;
    }
    let value2 = "";
    while (true) {
      value2 = await readHidden(confirmText);
      if (value2 || (!value && !value2)) break;
    }
    if (value === value2) {
      return value === NO_PASSPHRASE ? null : value;
    }
    io.out("Error: The two entered values do not match.\n");
  }
}

async function writePublicKeyToFile(
  io: Invocation,
  stdin: StdinReader,
  displayPath: string,
  diskPath: string,
  publicKey: KeyObject,
  overwrite: boolean,
): Promise<boolean> {
  if (
    !overwrite &&
    isFileSync(diskPath) &&
    !(await confirmClick(
      io,
      stdin,
      `File ${displayPath} already exists, do you want to overwrite?`,
    ))
  ) {
    return false;
  }
  writeFileSync(diskPath, serializePublicKey(publicKey));
  applyUserOnlyAccessPermissions(diskPath);
  io.out(`Public key written to: ${displayPath}\n`);
  return true;
}

async function writePrivateKeyToFile(
  io: Invocation,
  stdin: StdinReader,
  displayPath: string,
  diskPath: string,
  privateKey: KeyObject,
  passphrase: string | null,
  overwrite: boolean,
): Promise<boolean> {
  if (
    !overwrite &&
    isFileSync(diskPath) &&
    !(await confirmClick(
      io,
      stdin,
      `File ${displayPath} already exists, do you want to overwrite?`,
    ))
  ) {
    return false;
  }
  writeFileSync(
    diskPath,
    `${serializePrivateKey(privateKey, passphrase)}${PRIVATE_KEY_LABEL}`,
  );
  applyUserOnlyAccessPermissions(diskPath);
  io.out(`Private key written to: ${displayPath}\n`);
  return true;
}

/**
 * `oci setup repair-file-permissions --file <path>` (cli_setup.repair_file_permissions).
 */
export function runSetupRepairFilePermissions(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    usageError: (message: string) => never;
  },
): void {
  const rawFile = String(opts.values.file ?? "");
  const expanded = expandUser(rawFile, io.env);
  const resolved = resolve(io.cwd, expanded);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolved);
  } catch {
    opts.usageError(`Could not find file: ${expanded}`);
  }
  if (!st.isFile()) {
    opts.usageError("This command is only supported for files.");
  }
  applyUserOnlyAccessPermissions(resolved);
}

/**
 * `oci setup keys` (cli_setup.generate_key_pair).
 */
export async function runSetupKeys(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    usageError: (message: string) => never;
  },
): Promise<void> {
  const keyName =
    typeof opts.values.key_name === "string"
      ? opts.values.key_name
      : DEFAULT_KEY_NAME;
  const rawOutputDir =
    typeof opts.values.output_dir === "string"
      ? opts.values.output_dir
      : DEFAULT_DIRECTORY;
  let passphrase: string | null =
    typeof opts.values.passphrase === "string" ? opts.values.passphrase : null;
  const passphraseFile =
    typeof opts.values.passphrase_file === "string"
      ? opts.values.passphrase_file
      : undefined;
  const overwrite = opts.values.overwrite === true;

  if (passphraseFile !== undefined) {
    try {
      validateClickFileForRead(io, passphraseFile);
    } catch (e) {
      if (e instanceof BadParameter) {
        opts.usageError(`Invalid value for '--passphrase-file': ${e.message}`);
      }
      throw e;
    }
  }

  if (passphrase && passphraseFile) {
    opts.usageError(
      "Cannot specify both passphrase and passphrase-file options",
    );
  }

  const stdin = createStdinReader(io);

  if (passphraseFile) {
    const raw =
      passphraseFile === "-"
        ? await stdin.consumeAll()
        : readFileSync(resolve(io.cwd, passphraseFile), "utf8");
    const line = readFirstLine(raw);
    if (!line || /^\s*$/.test(line)) {
      opts.usageError(
        "passphrase-file must specify a password in the first line of the file",
      );
    }
    passphrase = line;
  }

  if (!passphrase) {
    passphrase = await promptForPassphrase(io, stdin);
  }

  const outputDir = expandUser(rawOutputDir, io.env);
  const resolvedDir = resolve(io.cwd, outputDir);
  if (!existsSync(resolvedDir)) {
    createDirectory(resolvedDir);
  }

  const { privateKey, publicKey } = generateKey();
  const publicDisplayPath = pyPathJoin(
    outputDir,
    `${keyName}${PUBLIC_KEY_FILENAME_SUFFIX}`,
  );
  const privateDisplayPath = pyPathJoin(
    outputDir,
    `${keyName}${PRIVATE_KEY_FILENAME_SUFFIX}`,
  );

  await writePublicKeyToFile(
    io,
    stdin,
    publicDisplayPath,
    resolve(io.cwd, publicDisplayPath),
    publicKey,
    overwrite,
  );
  await writePrivateKeyToFile(
    io,
    stdin,
    privateDisplayPath,
    resolve(io.cwd, privateDisplayPath),
    privateKey,
    passphrase,
    overwrite,
  );

  const fingerprint = publicKeyToFingerprint(publicKey);
  io.out(`Public key fingerprint: ${fingerprint}\n`);
  io.out(UPLOAD_PUBLIC_KEY_INSTRUCTIONS);
}

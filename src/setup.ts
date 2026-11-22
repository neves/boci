import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { expandUser } from "./config.ts";
import { ConfigParserError, parseConfig } from "./configparser.ts";
import { BadParameter, pyRepr } from "./convert.ts";
import { loadExternalRegionMetadata, type RegionsSpec } from "./endpoint.ts";
import { Exit, type Invocation } from "./io.ts";
import { validateClickFileForRead } from "./os.ts";
import { loadPrivateKey, MissingPrivateKeyPassphrase } from "./signer.ts";

export const DEFAULT_KEY_NAME = "oci_api_key";
export const DEFAULT_DIRECTORY = "~/.oci";
export const DEFAULT_PROFILE_NAME = "DEFAULT";
export const PUBLIC_KEY_FILENAME_SUFFIX = "_public.pem";
export const PRIVATE_KEY_FILENAME_SUFFIX = ".pem";
export const NO_PASSPHRASE = "N/A";
export const PRIVATE_KEY_LABEL = "OCI_API_KEY";

const CONFIG_GENERATION_CANCELED_MESSAGE = "Config creation canceled.";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._\-@]+$/;
const OCID_PATTERN =
  /^([0-9a-zA-Z_-]+[.:])([0-9a-zA-Z_-]*[.:]){3,}([0-9a-zA-Z_-]+)$/;
const HIDDEN_INPUT_MASK = "***";

const GENERATE_OCI_CONFIG_INSTRUCTIONS =
  "    This command provides a walkthrough of creating a valid CLI config file.\n\n" +
  "    The following links explain where to find the information required by this\n" +
  "    script:\n\n" +
  "    User API Signing Key, OCID and Tenancy OCID:\n\n" +
  "        https://docs.cloud.oracle.com/Content/API/Concepts/apisigningkey.htm#Other\n\n" +
  "    Region:\n\n" +
  "        https://docs.cloud.oracle.com/Content/General/Concepts/regions.htm\n\n" +
  "    General config documentation:\n\n" +
  "        https://docs.cloud.oracle.com/Content/API/Concepts/sdkconfig.htm\n\n\n";

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

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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

/** Click `click.confirm(text, default=defaultValue, err=False)`. */
async function confirmClick(
  io: Invocation,
  stdin: StdinReader,
  text: string,
  defaultValue = false,
): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]: " : "[y/N]: ";
  const prompt = `${text} ${suffix}`;
  while (true) {
    io.out(prompt);
    const line = await stdin.readLine();
    if (line === null) {
      io.err("Aborted!\n");
      throw new Exit(1);
    }
    const normalized = line.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    if (normalized === "") return defaultValue;
    io.out("Error: invalid input\n");
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Click `click.termui._mask_hidden_input`. */
function maskHiddenInput(message: string, value: string): string {
  let out = message.replaceAll(pyRepr(value), HIDDEN_INPUT_MASK);
  if (value) {
    out = out.replace(
      new RegExp(`(?<!\\w)${escapeRegExp(value)}(?!\\w)`, "g"),
      HIDDEN_INPUT_MASK,
    );
  }
  return out;
}

async function readHiddenLine(
  io: Invocation,
  stdin: StdinReader,
  prompt: string,
): Promise<string> {
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
}

/** Click `click.prompt` subset used by `cli_setup`. */
async function promptClick<T = string>(
  io: Invocation,
  stdin: StdinReader,
  text: string,
  opts: {
    default?: string;
    hideInput?: boolean;
    valueProc?: (value: string) => T | Promise<T>;
  } = {},
): Promise<T> {
  const prompt =
    opts.default !== undefined ? `${text} [${opts.default}]: ` : `${text}: `;
  const hideInput = opts.hideInput === true;

  while (true) {
    let value = "";
    while (true) {
      if (hideInput) {
        value = await readHiddenLine(io, stdin, prompt);
      } else {
        io.out(prompt);
        const line = await stdin.readLine();
        if (line === null) {
          io.err("Aborted!\n");
          throw new Exit(1);
        }
        value = line;
      }
      if (value) break;
      if (opts.default !== undefined) {
        value = opts.default;
        break;
      }
    }
    if (!opts.valueProc) return value as unknown as T;
    try {
      return await opts.valueProc(value);
    } catch (e) {
      if (e instanceof BadParameter) {
        const message = hideInput
          ? maskHiddenInput(e.message, value)
          : e.message;
        io.out(`Error: ${message}\n`);
        continue;
      }
      throw e;
    }
  }
}

/** cli_setup.prompt_for_passphrase: hidden prompt with confirmation. */
async function promptForPassphrase(
  io: Invocation,
  stdin: StdinReader,
): Promise<string | null> {
  const promptText = `Enter a passphrase for your private key ("${NO_PASSPHRASE}" for no passphrase): `;
  const confirmText = "Repeat for confirmation: ";

  while (true) {
    let value = "";
    while (true) {
      value = await readHiddenLine(io, stdin, promptText);
      if (value) break;
    }
    let value2 = "";
    while (true) {
      value2 = await readHiddenLine(io, stdin, confirmText);
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

function validateProfileName(
  profileName: string,
  usageError: (message: string) => never,
): void {
  if (!profileName) {
    usageError("Profile name must be a non-empty string.");
  }
  if (!PROFILE_NAME_PATTERN.test(profileName)) {
    usageError(
      `Invalid profile name '${profileName}'. Profile names may only contain letters, numbers, '.', '_', '-', or '@'.`,
    );
  }
  if (profileName === "." || profileName === "..") {
    usageError(
      `Invalid profile name '${profileName}': Profile name cannot be '.' or '..'.`,
    );
  }
}

function validateOcid(ocid: string): string {
  if (!OCID_PATTERN.test(ocid)) {
    throw new BadParameter(
      "Invalid OCID format. Instructions to find OCIDs: https://docs.cloud.oracle.com/Content/API/Concepts/apisigningkey.htm#Other",
    );
  }
  return ocid;
}

function validatePrivateKeyFile(
  io: Invocation,
  filename: string,
): { filename: string; hasPassphrase: boolean; privateKey: KeyObject | null } {
  const expanded = expandUser(filename, io.env);
  const diskPath = resolve(io.cwd, expanded);
  if (!isFileSync(diskPath)) {
    throw new BadParameter(`No file found at: ${expanded}`);
  }
  const pem = readFileSync(diskPath, "utf8");
  try {
    const privateKey = loadPrivateKey(pem, null);
    return { filename: expanded, hasPassphrase: false, privateKey };
  } catch (e) {
    if (e instanceof MissingPrivateKeyPassphrase) {
      return { filename: expanded, hasPassphrase: true, privateKey: null };
    }
    throw new BadParameter(
      `Could not load file as private key. File: ${expanded}`,
    );
  }
}

function validatePrivateKeyPassphrase(
  filename: string,
  passphrase: string,
): { passphrase: string; privateKey: KeyObject } {
  // Python cryptography encodes passphrase as ASCII; non-ASCII raises UnicodeEncodeError (ValueError).
  if (/[^\x00-\x7f]/.test(passphrase)) {
    throw new BadParameter(
      "Incorrect passphrase, could not decrypt private key",
    );
  }
  const pem = readFileSync(filename, "utf8");
  try {
    const privateKey = loadPrivateKey(pem, passphrase);
    return { passphrase, privateKey };
  } catch {
    throw new BadParameter(
      "Incorrect passphrase, could not decrypt private key",
    );
  }
}

async function promptForConfigLocation(
  io: Invocation,
  stdin: StdinReader,
  defaultDir: string,
  usageError: (message: string) => never,
): Promise<{ configLocation: string | null; profileName: string | null }> {
  const defaultConfigPath = pyPathJoin(defaultDir, "config");
  const rawLocation = await promptClick(
    io,
    stdin,
    "Enter a location for your config",
    {
      default: defaultConfigPath,
      valueProc: (filename) => {
        const expanded = expandUser(filename, io.env);
        if (isDirSync(resolve(io.cwd, expanded))) {
          throw new BadParameter(
            "Config location must be a filename not a directory",
          );
        }
        return expanded;
      },
    },
  );
  const configLocation = resolve(io.cwd, rawLocation);

  if (existsSync(configLocation)) {
    try {
      const parsed = parseConfig(
        readFileSync(configLocation, "utf8"),
        configLocation,
      );
      if (
        await confirmClick(
          io,
          stdin,
          `Config file: ${configLocation} already exists. Do you want add a profile here? (If no, you will be prompted to overwrite the file)`,
          true,
        )
      ) {
        while (true) {
          const enteredName = await promptClick(
            io,
            stdin,
            "Enter the name of the profile you would like to create",
          );
          validateProfileName(enteredName, usageError);
          const sections = [...parsed.sections.keys()].map((s) =>
            s.toUpperCase(),
          );
          if (parsed.defaults.size > 0) sections.push(DEFAULT_PROFILE_NAME);
          const enteredUpper = enteredName.toUpperCase();
          if (sections.includes(enteredUpper)) {
            io.out(
              `Profile ${enteredUpper} already exists in config. Cannot specify a profile that conflicts with any existing profile(s): ${sections.join(", ")}\n`,
            );
            continue;
          }
          return { configLocation, profileName: enteredName };
        }
      }
    } catch (e) {
      if (!(e instanceof ConfigParserError)) throw e;
    }

    if (
      !(await confirmClick(
        io,
        stdin,
        `File: ${configLocation} already exists. Do you want to overwrite (Removes existing profiles!!!)?`,
        false,
      ))
    ) {
      return { configLocation: null, profileName: null };
    }
    unlinkSync(configLocation);
  } else {
    const dir = dirname(configLocation);
    if (dir && !existsSync(dir)) {
      createDirectory(dir);
    }
  }

  return { configLocation, profileName: DEFAULT_PROFILE_NAME };
}

async function promptForRegion(
  io: Invocation,
  stdin: StdinReader,
  regions: RegionsSpec,
): Promise<string> {
  const sortedRegions = [...regions.regions].sort();
  const numeric = sortedRegions.map((r, i) => `${i + 1}: ${r}`);
  const lines: string[] = [];
  for (let i = 0; i < numeric.length; i += 5) {
    lines.push(numeric.slice(i, i + 5).join(", "));
  }
  const regionList = lines.join(",\n");
  const isValidIndex = (val: string) =>
    /^[0-9]+$/.test(val) &&
    Number(val) >= 1 &&
    Number(val) <= regions.regions.length;
  const isRecognizedRegion = async (val: string) => {
    const lower = val.toLowerCase();
    if (lower in regions.shortNames) return false;
    if (regions.regions.includes(lower)) return true;
    return (
      (await loadExternalRegionMetadata(lower, regions, io.env)) !== undefined
    );
  };

  let region: string | null = null;
  while (!region) {
    region = await promptClick<string | null>(
      io,
      stdin,
      `Enter a region by index or name(e.g.\n${regionList})`,
      {
        valueProc: async (val) => {
          if (!((await isRecognizedRegion(val)) || isValidIndex(val))) {
            io.out(
              `Unrecognized region: ${val}. Please enter a number between 1 to ${regions.regions.length}, or valid regions can be found here: https://docs.cloud.oracle.com/Content/General/Concepts/regions.htm\n`,
            );
            if (
              !(await confirmClick(
                io,
                stdin,
                "Continue with unrecognized region? (Enter 'n' to re-enter region)",
                false,
              ))
            ) {
              return null;
            }
          }
          return val;
        },
      },
    );
  }
  return isValidIndex(region)
    ? (sortedRegions[Number(region) - 1] as string)
    : region;
}

export function writeConfig(
  filename: string,
  opts: {
    userId?: string | null;
    fingerprint?: string | null;
    keyFile?: string | null;
    tenancy?: string | null;
    region?: string | null;
    passPhrase?: string | null;
    profileName?: string;
    securityTokenFile?: string | null;
    writeKeyFile?: boolean;
  },
): void {
  const existingFile = existsSync(filename);
  const profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
  const writeKeyFile = opts.writeKeyFile ?? true;
  let content = existingFile ? "\n\n" : "";
  content += `[${profileName}]\n`;
  if (opts.userId) content += `user=${opts.userId}\n`;
  if (opts.fingerprint) content += `fingerprint=${opts.fingerprint}\n`;
  if (writeKeyFile && opts.keyFile) content += `key_file=${opts.keyFile}\n`;
  content += `tenancy=${opts.tenancy ?? ""}\n`;
  content += `region=${opts.region ?? ""}\n`;
  if (opts.passPhrase) content += `pass_phrase=${opts.passPhrase}\n`;
  if (opts.securityTokenFile) {
    content += `security_token_file=${opts.securityTokenFile}\n`;
  }
  appendFileSync(filename, content);
  applyUserOnlyAccessPermissions(filename);
}

/**
 * `oci setup config` (cli_setup.generate_oci_config).
 */
export async function runSetupConfig(
  io: Invocation,
  opts: {
    regions: RegionsSpec;
    usageError: (message: string) => never;
  },
): Promise<void> {
  const stdin = createStdinReader(io);
  io.out(GENERATE_OCI_CONFIG_INSTRUCTIONS);

  const defaultDir = expandUser(DEFAULT_DIRECTORY, io.env);
  const { configLocation, profileName } = await promptForConfigLocation(
    io,
    stdin,
    defaultDir,
    opts.usageError,
  );
  if (!configLocation || !profileName) {
    io.out(`${CONFIG_GENERATION_CANCELED_MESSAGE}\n`);
    return;
  }

  const userId = await promptClick(io, stdin, "Enter a user OCID", {
    valueProc: validateOcid,
  });
  const tenantId = await promptClick(io, stdin, "Enter a tenancy OCID", {
    valueProc: validateOcid,
  });
  const region = await promptForRegion(io, stdin, opts.regions);

  let keyPassphrase: string | null = null;
  let privateKeyFile: string;
  let fingerprint: string;

  if (
    await confirmClick(
      io,
      stdin,
      "Do you want to generate a new API Signing RSA key pair? (If you decline you will be asked to supply the path to an existing key.)",
      true,
    )
  ) {
    const rawKeyDir = await promptClick(
      io,
      stdin,
      "Enter a directory for your keys to be created",
      { default: defaultDir },
    );
    const keyLocation = resolve(io.cwd, expandUser(rawKeyDir, io.env));
    if (!existsSync(keyLocation)) {
      createDirectory(keyLocation);
    }

    const { privateKey, publicKey } = generateKey();
    const keyName = await promptClick(io, stdin, "Enter a name for your key", {
      default: DEFAULT_KEY_NAME,
    });
    const publicPath = pyPathJoin(
      keyLocation,
      `${keyName}${PUBLIC_KEY_FILENAME_SUFFIX}`,
    );
    if (
      !(await writePublicKeyToFile(
        io,
        stdin,
        publicPath,
        publicPath,
        publicKey,
        false,
      ))
    ) {
      io.out(`${CONFIG_GENERATION_CANCELED_MESSAGE}\n`);
      return;
    }

    keyPassphrase = await promptForPassphrase(io, stdin);
    privateKeyFile = pyPathJoin(
      keyLocation,
      `${keyName}${PRIVATE_KEY_FILENAME_SUFFIX}`,
    );
    if (
      !(await writePrivateKeyToFile(
        io,
        stdin,
        privateKeyFile,
        privateKeyFile,
        privateKey,
        keyPassphrase,
        false,
      ))
    ) {
      io.out(`${CONFIG_GENERATION_CANCELED_MESSAGE}\n`);
      return;
    }

    fingerprint = publicKeyToFingerprint(publicKey);
    io.out(`Fingerprint: ${fingerprint}\n`);
  } else {
    const validated = await promptClick(
      io,
      stdin,
      "Enter the location of your API Signing private key file",
      {
        valueProc: (filename) => validatePrivateKeyFile(io, filename),
      },
    );
    privateKeyFile = resolve(io.cwd, validated.filename);

    if (!readFileSync(privateKeyFile, "utf8").endsWith(PRIVATE_KEY_LABEL)) {
      const warning =
        `Warning: To increase security of your API key located at ${privateKeyFile}, ` +
        "append an extra line with 'OCI_API_KEY' at the end. For more information, " +
        "refer to https://docs.oracle.com/iaas/Content/API/Concepts/apisigningkey.htm";
      io.out(io.isTTY(1) ? `\x1b[33m${warning}\x1b[0m\n` : `${warning}\n`);
    }

    let privateKey = validated.privateKey;
    if (validated.hasPassphrase) {
      const decrypted = await promptClick(
        io,
        stdin,
        "Enter the passphrase for your private key",
        {
          hideInput: true,
          valueProc: (passphrase) =>
            validatePrivateKeyPassphrase(privateKeyFile, passphrase),
        },
      );
      keyPassphrase = decrypted.passphrase;
      privateKey = decrypted.privateKey;
    }

    fingerprint = publicKeyToFingerprint(
      createPublicKey(privateKey as KeyObject),
    );
    io.out(`Fingerprint: ${fingerprint}\n`);
  }

  if (
    keyPassphrase &&
    !(await confirmClick(
      io,
      stdin,
      "Do you want to write your passphrase to the config file? (If not, you will need to enter it when prompted each time you run an oci command)",
      false,
    ))
  ) {
    keyPassphrase = null;
  }

  writeConfig(configLocation, {
    userId,
    fingerprint,
    keyFile: privateKeyFile,
    tenancy: tenantId,
    region,
    passPhrase: keyPassphrase,
    profileName,
  });

  io.out(`Config written to ${configLocation}\n`);
  io.out(UPLOAD_PUBLIC_KEY_INSTRUCTIONS);
}

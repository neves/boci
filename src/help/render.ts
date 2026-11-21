// Click's Command.format_help for one command, from its extracted HelpDoc.
import type { HelpDoc } from "../spec.ts";
import { HelpFormatter, helpWidth } from "./formatter.ts";

/** ctx.get_help(): the formatted page without trailing newlines. */
export function commandHelp(
  commandPath: string,
  doc: HelpDoc,
  width = helpWidth(),
): string {
  const f = new HelpFormatter(width);
  f.writeUsage(commandPath, doc.usage);
  if (doc.text) {
    f.writeParagraph();
    f.indentation(() => f.writeText(doc.text));
  }
  if (doc.records.length) f.section("Options", () => f.writeDl(doc.records));
  if (doc.epilog) {
    const epilog = doc.epilog;
    f.writeParagraph();
    f.indentation(() => f.writeText(epilog));
  }
  return f.getvalue().replace(/\n+$/, "");
}

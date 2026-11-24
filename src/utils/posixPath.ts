/** Convert filesystem paths to the POSIX form shown and stored by boci. */
export function normalizePosixPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

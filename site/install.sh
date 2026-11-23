#!/usr/bin/env sh
set -eu

REPO="neves/boci"
INSTALL_DIR="${BOCI_INSTALL_DIR:-$HOME/.local/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux) OS="linux" ;;
  darwin) OS="darwin" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="boci-${OS}-${ARCH}"
if [ "$OS" = "linux" ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  ASSET="${ASSET}-musl"
fi
BASE_URL="${BOCI_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
URL="${BASE_URL}/${ASSET}"
SUMS_URL="${BASE_URL}/SHA256SUMS"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "${TMP_DIR}/${ASSET}"
curl -fsSL --retry 3 --retry-delay 2 "$SUMS_URL" -o "${TMP_DIR}/SHA256SUMS"

EXPECTED="$(awk -v asset="$ASSET" '{ f = $2; sub(/^\*/, "", f); if (f == asset) { print $1; exit } }' "${TMP_DIR}/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then
  echo "Checksum for ${ASSET} not found in SHA256SUMS" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMP_DIR}/${ASSET}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "${TMP_DIR}/${ASSET}" | awk '{ print $1 }')"
else
  echo "No sha256sum or shasum found to verify checksum" >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum verification failed for ${ASSET}: expected ${EXPECTED}, got ${ACTUAL}" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
mv "${TMP_DIR}/${ASSET}" "${INSTALL_DIR}/boci"
chmod +x "${INSTALL_DIR}/boci"

echo "Installed boci to ${INSTALL_DIR}/boci"

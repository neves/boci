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
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

mkdir -p "$INSTALL_DIR"
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "${INSTALL_DIR}/boci"
chmod +x "${INSTALL_DIR}/boci"

echo "Installed boci to ${INSTALL_DIR}/boci"

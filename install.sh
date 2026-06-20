#!/bin/sh
# recube CLI installer (Linux / macOS) — "curl | sh" à la Anthropic.
#
#   curl -fsSL https://recube.gg/install.sh | sh
#
# Detects OS/arch, downloads the matching standalone binary from GitHub
# Releases (no Node required), verifies its SHA-256 against the published
# checksum, installs it on PATH, and prints a clear next-step. Idempotent:
# re-running upgrades in place.
#
# Overrides (env):
#   RECUBE_INSTALL_DIR   target dir (default: ~/.local/bin, fallback /usr/local/bin)
#   RECUBE_VERSION       tag to install (default: latest)
#   RECUBE_REPO          owner/repo (default: NationsGlory/RecubeCLI)

set -eu

REPO="${RECUBE_REPO:-NationsGlory/RecubeCLI}"
VERSION="${RECUBE_VERSION:-latest}"
BIN_NAME="recube"

# ── pretty output ───────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  V='\033[38;2;124;58;237m'; B='\033[1m'; D='\033[2m'; R='\033[0m'; G='\033[32m'
else
  V=''; B=''; D=''; R=''; G=''
fi
info()  { printf '%b\n' "${D}•${R} $1"; }
ok()    { printf '%b\n' "${G}✓${R} $1"; }
err()   { printf '%b\n' "\033[31m✖${R} $1" >&2; }
die()   { err "$1"; exit 1; }

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || \
  die "curl ou wget requis."

download() { # url out
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -qO "$2" "$1"
  fi
}
download_stdout() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

# ── detect OS / arch ────────────────────────────────────────────────────────
os="$(uname -s)"
case "$os" in
  Linux)  OS="linux" ;;
  Darwin) OS="macos" ;;
  *) die "OS non supporté : $os (utilise install.ps1 sur Windows)." ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "architecture non supportée : $arch" ;;
esac

# linux-arm64 n'est pas (encore) buildé dans les releases (runner arm64 indispo).
# macOS arm64 (Apple Silicon) l'est. Message clair plutôt qu'un 404 cryptique.
if [ "$OS" = "linux" ] && [ "$ARCH" = "arm64" ]; then
  die "linux-arm64 n'est pas encore distribué en binaire. Installe via npm (Node 20+) : npm install -g @nationsglory/cli — ou lance le CLI depuis les sources."
fi

ASSET="recube-${OS}-${ARCH}"
info "Plateforme détectée : ${B}${OS}-${ARCH}${R}"

# ── resolve version + URLs ──────────────────────────────────────────────────
if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi
BIN_URL="${BASE}/${ASSET}"
SUM_URL="${BASE}/${ASSET}.sha256"

# ── target dir on PATH ──────────────────────────────────────────────────────
if [ -n "${RECUBE_INSTALL_DIR:-}" ]; then
  DEST_DIR="$RECUBE_INSTALL_DIR"
elif [ -w "/usr/local/bin" ] 2>/dev/null; then
  DEST_DIR="/usr/local/bin"
else
  DEST_DIR="${HOME}/.local/bin"
fi
mkdir -p "$DEST_DIR"
DEST="${DEST_DIR}/${BIN_NAME}"

# ── download + verify ───────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
info "Téléchargement de ${ASSET}…"
download "$BIN_URL" "${TMP}/${BIN_NAME}" || die "échec du téléchargement : ${BIN_URL}"

if EXPECTED="$(download_stdout "$SUM_URL" 2>/dev/null | awk '{print $1}')" && [ -n "$EXPECTED" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "${TMP}/${BIN_NAME}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${TMP}/${BIN_NAME}" | awk '{print $1}')"
  else
    ACTUAL=""
  fi
  if [ -n "$ACTUAL" ]; then
    [ "$ACTUAL" = "$EXPECTED" ] || die "checksum invalide (attendu $EXPECTED, obtenu $ACTUAL)."
    ok "Checksum SHA-256 vérifié."
  else
    info "(sha256sum/shasum absent — vérification du checksum sautée)"
  fi
else
  info "(checksum non publié pour cette release — vérification sautée)"
fi

# ── install ─────────────────────────────────────────────────────────────────
chmod +x "${TMP}/${BIN_NAME}"
mv -f "${TMP}/${BIN_NAME}" "$DEST"
ok "recube installé dans ${B}${DEST}${R}"

# ── PATH hint ───────────────────────────────────────────────────────────────
case ":${PATH}:" in
  *":${DEST_DIR}:"*) ;;
  *)
    printf '%b\n' "${D}Ajoute ${DEST_DIR} à ton PATH :${R}"
    printf '%b\n' "  ${V}export PATH=\"${DEST_DIR}:\$PATH\"${R}   ${D}# ajoute à ~/.bashrc / ~/.zshrc${R}"
    ;;
esac

printf '\n'
ok "Prêt. Lance : ${V}recube --help${R}"

#!/bin/sh
# install.sh — one-line installer for git-unas.
#
#   curl -fsSL https://deftai.github.io/git-unas/install.sh | sh
#
# Safe to re-run; idempotent.
set -e

REPO_URL="https://github.com/deftai/git-unas"
RELEASES_URL="${REPO_URL}/releases/latest/download"
DATA_DIR=/data/git-unas

if [ "$(id -u)" -ne 0 ]; then
    echo "This installer must run as root." >&2
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get not found — this installer only supports Debian-based UniFi OS." >&2
    exit 1
fi

DEB_ARCH=$(dpkg --print-architecture)
case "$DEB_ARCH" in
    arm64) ;;
    *)
        echo "Unsupported architecture: $DEB_ARCH (only arm64 is supported)." >&2
        exit 1
        ;;
esac

# ---- Download and install latest .deb ----
echo "==> Fetching latest git-unas release..."
# Use GitHub API to discover the latest version tag.
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/deftai/git-unas/releases/latest" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
    echo "==> Could not determine latest release tag; trying direct download..."
    DEB_URL="${RELEASES_URL}/git-unas_arm64.deb"
else
    VER="${LATEST_TAG#v}"
    DEB_URL="${RELEASES_URL}/git-unas_${VER}_arm64.deb"
fi

echo "==> Downloading ${DEB_URL}..."
curl -fsSL -o /tmp/git-unas.deb "$DEB_URL"
echo "==> Installing (resolving dependencies)..."
apt-get update || true
# apt-get resolves runtime deps (git and its sub-deps) from the repos; fall back
# to dpkg + fix-broken if the apt local-deb path is unavailable.
apt-get install -y /tmp/git-unas.deb || {
    dpkg -i /tmp/git-unas.deb || true
    apt-get install -f -y || true
}
rm -f /tmp/git-unas.deb

# ---- Persistent recovery layer ----
# Survives UDM firmware wipes (which clear /usr/bin/ and /lib/systemd/)
# but preserve /data/ and /etc/cron.d/.
echo "==> Installing recovery layer to ${DATA_DIR}..."
mkdir -p "${DATA_DIR}/backups"

# Self-copy so boot-restore doesn't need network access to GitHub.
if [ -f "$0" ] && [ -r "$0" ]; then
    cp "$0" "${DATA_DIR}/install.sh"
else
    curl -fsSL "${REPO_URL}/raw/main/gh-pages/install.sh" \
        -o "${DATA_DIR}/install.sh"
fi
chmod 0755 "${DATA_DIR}/install.sh"

cat > "${DATA_DIR}/boot-restore.sh" <<'BOOT_RESTORE'
#!/bin/sh
# Auto-reinstall git-unas after a firmware wipe.
exec >> /var/log/git-unas-boot-restore.log 2>&1
echo "=== $(date -Is) boot-restore start ==="

# Wait for the system to settle.
sleep 60

# Normal boot: package already installed.
if dpkg -s git-unas >/dev/null 2>&1; then
    echo "package already installed; nothing to do"
    exit 0
fi

# Restore config backup before reinstalling.
BACKUP=/data/git-unas/backups/config-current.tar.gz
if [ -f "$BACKUP" ]; then
    echo "restoring config from $BACKUP"
    tar -xzf "$BACKUP" -C /
fi

# Firmware-wipe scenario: reinstall unconditionally.
if [ ! -x /usr/bin/git-unas ]; then
    echo "wipe-recovery: reinstalling"
    sh /data/git-unas/install.sh
    echo "=== $(date -Is) boot-restore done (wipe-recovery) ==="
    exit 0
fi

# Routine boot: respect the consent gate.
consent=$(cat /data/git-unas/.autoupdate-consent 2>/dev/null)
if [ "$consent" != "true" ]; then
    echo "auto-reinstall consent not granted"
    exit 0
fi

sh /data/git-unas/install.sh
echo "=== $(date -Is) boot-restore done ==="
BOOT_RESTORE
chmod 0755 "${DATA_DIR}/boot-restore.sh"

cat > "${DATA_DIR}/backup.sh" <<'BACKUP_SCRIPT'
#!/bin/sh
# Snapshot git-unas config to /data so it can be restored after a firmware wipe.
set -e
BACKUP_DIR=/data/git-unas/backups
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y-%m-%d)
WEEKLY="${BACKUP_DIR}/config-${DATE}.tar.gz"

tar -czf "${BACKUP_DIR}/config-current.tar.gz" \
    /etc/git-unas/ \
    /etc/default/git-unas 2>/dev/null || true

# Weekly snapshot on Sundays; trim to last 4.
if [ "$(date +%u)" = "7" ]; then
    cp "${BACKUP_DIR}/config-current.tar.gz" "$WEEKLY"
    ls -t "${BACKUP_DIR}/config-"[0-9]*.tar.gz 2>/dev/null | \
        tail -n +5 | xargs rm -f 2>/dev/null || true
fi
BACKUP_SCRIPT
chmod 0755 "${DATA_DIR}/backup.sh"

# Default consent to true (matches install intent).
if [ ! -f "${DATA_DIR}/.autoupdate-consent" ]; then
    echo "true" > "${DATA_DIR}/.autoupdate-consent"
fi

# Initial config backup.
sh "${DATA_DIR}/backup.sh" || true

# Cron entries.
cat > /etc/cron.d/git-unas-boot-restore <<CRON
@reboot root /data/git-unas/boot-restore.sh
CRON

cat > /etc/cron.d/git-unas-backup <<CRON
17 4 * * * root /data/git-unas/backup.sh
CRON

echo "==> git-unas installed. Admin UI: https://$(hostname)/git-unas/"

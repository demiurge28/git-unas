#!/bin/sh
# build-deb.sh — build dist/git-unas_<version>_arm64.deb
# Always runs `npm run build && npm run build:bundle` first.
# Usage: scripts/build-deb.sh [--arch arm64] [--version X.Y.Z]
set -e

# Node.js version to bundle (must match the target device's expected runtime)
NODE_VERSION="22.22.3"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH=arm64
VERSION=""

while [ $# -gt 0 ]; do
    case "$1" in
        --arch)    ARCH="$2";    shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Derive version from package.json if not supplied.
if [ -z "$VERSION" ]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version")
fi

echo "==> Building git-unas_${VERSION}_${ARCH}.deb"

# Always rebuild TypeScript + ncc bundle from source
echo "==> Compiling TypeScript..."
npm --prefix "${REPO_ROOT}" run build
echo "==> Bundling with ncc..."
npm --prefix "${REPO_ROOT}" run build:bundle

STAGE="${REPO_ROOT}/dist/deb-stage"
DEB_OUT="${REPO_ROOT}/dist/git-unas_${VERSION}_${ARCH}.deb"
BUNDLE="${REPO_ROOT}/dist/bundle/index.js"

# ---- Clean and stage ----
rm -rf "$STAGE"

# Download Node.js ARM64 Linux binary if not already cached
NODE_TARBALL="${REPO_ROOT}/dist/node-${NODE_VERSION}-linux-arm64.tar.gz"
NODE_BIN="${REPO_ROOT}/dist/node-linux-arm64"
if [ ! -f "$NODE_BIN" ]; then
    echo "==> Downloading Node.js ${NODE_VERSION} (linux-arm64)..."
    curl -fsSL -o "$NODE_TARBALL" \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz"
    tar -xzf "$NODE_TARBALL" -C "${REPO_ROOT}/dist" \
        "node-v${NODE_VERSION}-linux-arm64/bin/node"
    mv "${REPO_ROOT}/dist/node-v${NODE_VERSION}-linux-arm64/bin/node" "$NODE_BIN"
    rm -rf "${REPO_ROOT}/dist/node-v${NODE_VERSION}-linux-arm64" "$NODE_TARBALL"
fi

# /usr/lib/git-unas/ (Node.js binary + JS bundle + static files)
mkdir -p "${STAGE}/usr/lib/git-unas"
cp "$NODE_BIN" "${STAGE}/usr/lib/git-unas/node"
chmod 0755 "${STAGE}/usr/lib/git-unas/node"
cp "$BUNDLE" "${STAGE}/usr/lib/git-unas/index.js"
cp -r "${REPO_ROOT}/public" "${STAGE}/usr/lib/git-unas/public"

# /usr/bin/ (shell launcher)
mkdir -p "${STAGE}/usr/bin"
cat > "${STAGE}/usr/bin/git-unas" << 'EOF'
#!/bin/sh
exec /usr/lib/git-unas/node /usr/lib/git-unas/index.js
EOF
chmod 0755 "${STAGE}/usr/bin/git-unas"

# /lib/systemd/system/
mkdir -p "${STAGE}/lib/systemd/system"
cp "${REPO_ROOT}/debian/git-unas.service" \
   "${STAGE}/lib/systemd/system/git-unas.service"
# Self-healing nginx units: restore the proxy block whenever UniFi regenerates
# its site config (path unit) and once at boot (service).
cp "${REPO_ROOT}/debian/git-unas-nginx.service" \
   "${STAGE}/lib/systemd/system/git-unas-nginx.service"
cp "${REPO_ROOT}/debian/git-unas-nginx.path" \
   "${STAGE}/lib/systemd/system/git-unas-nginx.path"

# /etc/default/git-unas  (conffile)
mkdir -p "${STAGE}/etc/default"
cp "${REPO_ROOT}/debian/default" "${STAGE}/etc/default/git-unas"

# /usr/libexec/git-unas/  (nginx scripts + cached recovery installer)
mkdir -p "${STAGE}/usr/libexec/git-unas"
cp "${REPO_ROOT}/scripts/nginx-inject.sh" \
   "${STAGE}/usr/libexec/git-unas/nginx-inject.sh"
cp "${REPO_ROOT}/scripts/nginx-strip.sh" \
   "${STAGE}/usr/libexec/git-unas/nginx-strip.sh"
# Ship the installer so postinst can refresh the /data recovery cache with the
# current (dependency-resolving) version.
cp "${REPO_ROOT}/gh-pages/install.sh" \
   "${STAGE}/usr/libexec/git-unas/install.sh"
chmod 0755 "${STAGE}/usr/libexec/git-unas/"*.sh

# DEBIAN/ control + maintainer scripts
mkdir -p "${STAGE}/DEBIAN"

sed -e "s/@VERSION@/${VERSION}/g" \
    -e "s/@ARCH@/${ARCH}/g" \
    -e "s/@MAINTAINER_EMAIL@/noreply@github.com/g" \
    "${REPO_ROOT}/debian/control.in" > "${STAGE}/DEBIAN/control"

for script in postinst prerm postrm; do
    cp "${REPO_ROOT}/debian/${script}" "${STAGE}/DEBIAN/${script}"
    chmod 0755 "${STAGE}/DEBIAN/${script}"
done

cp "${REPO_ROOT}/debian/conffiles" "${STAGE}/DEBIAN/conffiles"

# ---- Build ----
# Force xz compression — UniFi OS ships an older dpkg that does not support
# the zst compression that Ubuntu 22.04+ dpkg-deb uses by default.
dpkg-deb -Zxz --build --root-owner-group "$STAGE" "$DEB_OUT"

echo "==> Built: $DEB_OUT ($(du -sh "$DEB_OUT" | cut -f1))"

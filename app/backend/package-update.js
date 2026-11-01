// Live Update for a .deb or .rpm install: which of a release's packages to install, and the command that installs
// them. Nothing here touches Electron, the network or the package manager, so tests/package-update.js runs it.

// The file names packaging/deb-rpm/build.sh gives the packages (nfpm's: name, version, release 1, architecture).
const FORMATS = {
  deb: {
    app: (version) => `nitrosense-linux_${version}-1_amd64.deb`,
    driver: /^linuwu-sense-gpu-mode-dkms_(.+)_all\.deb$/,
  },
  rpm: {
    app: (version) => `nitrosense-linux-${version}-1.x86_64.rpm`,
    driver: /^linuwu-sense-gpu-mode-dkms-(.+)\.noarch\.rpm$/,
  },
};

// A release's SHA256SUMS (sha256sum's "<sha256>  <file>" lines) as file -> sha256.
function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

// Whether version a is newer than b, comparing the numbers between dots and dashes ("1.0.0.10-1" > "1.0.0.9-1").
function newer(a, b) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// The release's files to install, with their sha256: the app's package, plus the driver's when the driver package is
// installed and the release has a newer one. installedDriver is its installed "version-release", or null.
function plan(format, version, sumsText, installedDriver) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown package format ${format}`);
  const sums = parseSums(sumsText);
  const app = spec.app(version);
  if (!sums.has(app)) throw new Error(`The release has no ${app}`);
  const files = [{ name: app, sha256: sums.get(app) }];
  if (installedDriver) {
    for (const [name, sha256] of sums) {
      const match = spec.driver.exec(name);
      if (match && newer(match[1], installedDriver)) files.push({ name, sha256 });
    }
  }
  return files;
}

// pkexec's arguments: apt or dnf installs the downloaded packages; apt waits a while if another update holds its lock.
function installCommand(format, paths) {
  if (format === "deb") {
    return ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-o", "DPkg::Lock::Timeout=120", ...paths];
  }
  if (format === "rpm") return ["dnf", "install", "-y", ...paths];
  throw new Error(`Unknown package format ${format}`);
}

module.exports = { FORMATS, parseSums, newer, plan, installCommand };

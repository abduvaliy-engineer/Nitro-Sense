const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { app } = require("electron");

const REPO = "abduvaliy-engineer/Nitro-Sense";
const RELEASES = `https://github.com/${REPO}/releases`;

function newer(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Live Update on Linux: compare this app's version with the latest GitHub release.
async function check(currentVersion) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "NitroSense-Linux" },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return { updates: [] };
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || "").replace(/^v/, "");
  if (!version || !newer(version, currentVersion)) return { updates: [] };
  return { updates: [{ name: release.name || `NitroSense ${version}`, version, url: release.html_url }] };
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(command)} failed: ${(stderr || stdout || error.message).trim().split("\n").pop()}`));
      else resolve();
    });
  });
}

// Running from a git checkout (./install.sh --dev or electron .): updates come through git, not here.
async function isCheckout() {
  try {
    await fs.access(path.join(app.getAppPath(), "..", ".git"));
    return true;
  } catch {
    return false;
  }
}

// One-click update: download the release's source, run its installer in update mode, then restart.
async function install(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error("Invalid version");
  if (await isCheckout()) return { checkout: true };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nitrosense-update-"));
  try {
    const response = await fetch(`https://github.com/${REPO}/archive/refs/tags/v${version}.tar.gz`, {
      headers: { "User-Agent": "NitroSense-Linux" },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const archive = path.join(dir, "source.tar.gz");
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await run("tar", ["-xzf", archive, "-C", dir], 60000);
    const [source] = (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    // Generous timeout: a new release may need NitroSense's artwork downloaded again.
    await run("bash", [path.join(dir, source.name, "install.sh"), "--update"], 30 * 60000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 500);
  return { installed: true };
}

function isReleaseUrl(url) {
  return typeof url === "string" && url.startsWith(`${RELEASES}/`);
}

module.exports = { check, install, isReleaseUrl, RELEASES };

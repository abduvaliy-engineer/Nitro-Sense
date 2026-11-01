const fs = require("fs/promises");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { createWriteStream } = require("fs");
const { once } = require("events");
const { Readable } = require("stream");
const { execFile } = require("child_process");
const { app } = require("electron");
const packageUpdate = require("./package-update");

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

// The latest release's tag, from the redirect of github.com/<repo>/releases/latest. Unlike the REST API
// (60 requests an hour per address without a login) it has no rate limit. null = no release yet.
async function latestFromRedirect() {
  const response = await fetch(`https://github.com/${REPO}/releases/latest`, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "NitroSense-Linux" },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status < 300 || response.status >= 400) throw new Error(`GitHub returned ${response.status}`);
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(response.headers.get("location") ?? "")?.[1];
  return tag ? { version: decodeURIComponent(tag).replace(/^v/, ""), url: `${RELEASES}/tag/${tag}` } : null;
}

async function latestFromApi() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "NitroSense-Linux" },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const release = await response.json();
  return { version: String(release.tag_name || "").replace(/^v/, ""), url: release.html_url, name: release.name };
}

// Live Update on Linux: compare this app's version with the latest GitHub release.
async function check(currentVersion) {
  const latest = await latestFromRedirect().catch(() => latestFromApi());
  if (!latest?.version || !newer(latest.version, currentVersion)) return { updates: [] };
  return { updates: [{ name: latest.name || `NitroSense ${latest.version}`, version: latest.version, url: latest.url }] };
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

// A package-manager install says so in app/packaged: the AUR package writes "aur", the .deb and .rpm "deb" and "rpm".
// The AUR's copy is left to the AUR helper; a .deb or .rpm installs the release's new packages (installPackages).
// null = not packaged.
async function packaged() {
  try {
    return (await fs.readFile(path.join(__dirname, "..", "packaged"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

// The driver package's installed "version-release", or null when it isn't installed.
function installedDriver(format) {
  const [command, args] = format === "deb"
    ? ["dpkg-query", ["-W", "-f=${db:Status-Status} ${Version}", "linuwu-sense-gpu-mode-dkms"]]
    : ["rpm", ["-q", "--qf", "installed %{VERSION}-%{RELEASE}", "linuwu-sense-gpu-mode-dkms"]];
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10000 }, (error, stdout) => {
      const match = !error && /^installed (\S+)$/.exec(stdout.trim());
      resolve(match ? match[1] : null);
    });
  });
}

function get(url, timeout) {
  return fetch(url, { headers: { "User-Agent": "NitroSense-Linux" }, signal: AbortSignal.timeout(timeout) }).then((response) => {
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${url.split("/").pop()}`);
    return response;
  });
}

// Streams url into file and checks the file's sha256.
async function download(url, file, sha256) {
  const response = await get(url, 15 * 60000);
  const hash = crypto.createHash("sha256");
  const out = createWriteStream(file);
  for await (const chunk of Readable.fromWeb(response.body)) {
    hash.update(chunk);
    if (!out.write(chunk)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
  if (hash.digest("hex") !== sha256) throw new Error(`${path.basename(file)} doesn't match the release's SHA256SUMS`);
}

// A .deb or .rpm install: download the release's packages for it, check them against the release's SHA256SUMS and
// install them with apt or dnf through pkexec (one password prompt).
async function installPackages(format, version, progress) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nitrosense-update-"));
  try {
    progress("downloading");
    const base = `${RELEASES}/download/v${version}`;
    const sums = await (await get(`${base}/SHA256SUMS`, 30000)).text();
    const paths = [];
    for (const file of packageUpdate.plan(format, version, sums, await installedDriver(format))) {
      paths.push(path.join(dir, file.name));
      await download(`${base}/${file.name}`, paths.at(-1), file.sha256);
    }
    // apt reads local packages as its own _apt user.
    await fs.chmod(dir, 0o755);
    progress("installing");
    await run("pkexec", packageUpdate.installCommand(format, paths), 30 * 60000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// One-click update. progress(stage): "downloading", "installing", "finished".
async function install(version, progress = () => {}) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error("Invalid version");
  const manager = await packaged();
  if (manager === "deb" || manager === "rpm") {
    await installPackages(manager, version, progress);
  } else if (manager) {
    throw new Error("This copy is updated by its package manager");
  } else {
    if (await isCheckout()) return { checkout: true };
    await installRelease(version, progress);
  }
  progress("finished");
  // Long enough for the "finished" dialog to be read.
  // The window is showing (the user asked for the update), so the new version must not start hidden.
  setTimeout(() => {
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== "--hidden") });
    app.exit(0);
  }, 2500);
  return { installed: true };
}

// An installer copy: download the release's source and run its installer in update mode.
async function installRelease(version, progress) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nitrosense-update-"));
  try {
    progress("downloading");
    const response = await fetch(`https://github.com/${REPO}/archive/refs/tags/v${version}.tar.gz`, {
      headers: { "User-Agent": "NitroSense-Linux" },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const archive = path.join(dir, "source.tar.gz");
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await run("tar", ["-xzf", archive, "-C", dir], 60000);
    progress("installing");
    const [source] = (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    // Generous timeout: a new release may need NitroSense's artwork downloaded again.
    await run("bash", [path.join(dir, source.name, "install.sh"), "--update"], 30 * 60000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function isReleaseUrl(url) {
  return typeof url === "string" && url.startsWith(`${RELEASES}/`);
}

module.exports = { check, install, isCheckout, packaged, isReleaseUrl, RELEASES };

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

function isReleaseUrl(url) {
  return typeof url === "string" && url.startsWith(`${RELEASES}/`);
}

module.exports = { check, isReleaseUrl, RELEASES };

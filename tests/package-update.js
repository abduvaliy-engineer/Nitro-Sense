// Live Update's package choice for .deb and .rpm installs, without network or package manager:
//   node tests/package-update.js app [DIST]
// With DIST (packaging/deb-rpm/build.sh's output) it also checks the file names against the packages built there.
const fs = require("fs");
const path = require("path");
const app = path.resolve(process.argv[2] ?? "app");
const update = require(path.join(app, "backend/package-update.js"));

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const throws = (name, run, pattern) => {
  let message = "nothing thrown";
  try {
    run();
  } catch (error) {
    message = error.message;
  }
  check(name, pattern.test(message), true);
};
const names = (files) => files.map((file) => file.name);

const sha = (c) => c.repeat(64);
const sums = [
  `${sha("a")}  linuwu-sense-gpu-mode-dkms_1.0.0.2-1_all.deb`,
  `${sha("b")}  nitrosense-linux_0.15.0-1_amd64.deb`,
  `${sha("c")}  linuwu-sense-gpu-mode-dkms-1.0.0.2-1.noarch.rpm`,
  `${sha("d")}  nitrosense-linux-0.15.0-1.x86_64.rpm`,
].join("\n") + "\n";

check("deb: the app alone without the driver package", names(update.plan("deb", "0.15.0", sums, null)),
  ["nitrosense-linux_0.15.0-1_amd64.deb"]);
check("deb: the driver too when the release's is newer", names(update.plan("deb", "0.15.0", sums, "1.0.0.1-1")),
  ["nitrosense-linux_0.15.0-1_amd64.deb", "linuwu-sense-gpu-mode-dkms_1.0.0.2-1_all.deb"]);
check("deb: not the driver when it's the same", names(update.plan("deb", "0.15.0", sums, "1.0.0.2-1")),
  ["nitrosense-linux_0.15.0-1_amd64.deb"]);
check("deb: never an older driver (10 > 2)", names(update.plan("deb", "0.15.0", sums, "1.0.0.10-1")),
  ["nitrosense-linux_0.15.0-1_amd64.deb"]);
check("rpm: the rpm names", names(update.plan("rpm", "0.15.0", sums, "1.0.0.1-1")),
  ["nitrosense-linux-0.15.0-1.x86_64.rpm", "linuwu-sense-gpu-mode-dkms-1.0.0.2-1.noarch.rpm"]);
check("each file keeps its sha256", update.plan("rpm", "0.15.0", sums, null)[0].sha256, sha("d"));
throws("a release without this version's package", () => update.plan("deb", "0.16.0", sums, null),
  /no nitrosense-linux_0\.16\.0-1_amd64\.deb/);
throws("an unknown format", () => update.plan("aur", "0.15.0", sums, null), /Unknown package format/);
check("sha256sum's binary marker", update.parseSums(`${sha("e")} *x.deb\n`).get("x.deb"), sha("e"));
check("apt installs the files", update.installCommand("deb", ["/tmp/u/a.deb", "/tmp/u/b.deb"]),
  ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-o", "DPkg::Lock::Timeout=120", "/tmp/u/a.deb", "/tmp/u/b.deb"]);
check("dnf installs the files", update.installCommand("rpm", ["/tmp/u/a.rpm"]), ["dnf", "install", "-y", "/tmp/u/a.rpm"]);

if (process.argv[3]) {
  const dist = path.resolve(process.argv[3]);
  const built = fs.readFileSync(path.join(dist, "SHA256SUMS"), "utf8");
  const version = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).version;
  for (const format of ["deb", "rpm"]) {
    const files = names(update.plan(format, version, built, "0-0"));
    check(`${format}: finds the app and driver packages build.sh made`, files.length, 2);
  }
}

if (fail) {
  console.log(`${fail} failed`);
  process.exit(1);
}
console.log("all passed");

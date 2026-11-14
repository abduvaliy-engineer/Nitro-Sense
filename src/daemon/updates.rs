//! Live Update: compares this app's version with the latest GitHub release and installs it.
use super::package_update;
use super::util::{parse_int, run, RunError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "abduvaliy-engineer/Nitro-Sense";
const USER_AGENT: &str = "NitroSense-Linux";

pub fn releases() -> String {
    format!("https://github.com/{REPO}/releases")
}

fn newer(a: &str, b: &str) -> bool {
    let parts = |version: &str| version.split('.').map(|n| parse_int(n).unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn agent(timeout: Duration, redirects: u32) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).redirects(redirects).user_agent(USER_AGENT).build()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%').then(|| text.get(i + 1..i + 3)).flatten().and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct Latest {
    version: String,
    url: String,
    name: Option<String>,
}

// The latest release's tag, from the redirect of github.com/<repo>/releases/latest. Unlike the REST API
// (60 requests an hour per address without a login) it has no rate limit. Ok(None) = no release yet.
fn latest_from_redirect() -> Result<Option<Latest>, String> {
    let request = agent(Duration::from_secs(10), 0).head(&format!("https://github.com/{REPO}/releases/latest"));
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => return Err(format!("GitHub returned {status}")),
        Err(error) => return Err(error.to_string()),
    };
    if !(300..400).contains(&response.status()) {
        return Err(format!("GitHub returned {}", response.status()));
    }
    let location = response.header("location").unwrap_or("");
    let tag = location.rsplit_once("/releases/tag/").map(|(_, tag)| tag).filter(|tag| !tag.is_empty() && !tag.contains(['/', '?', '#']));
    Ok(tag.map(|tag| {
        let decoded = percent_decode(tag);
        Latest { version: decoded.strip_prefix('v').unwrap_or(&decoded).to_string(), url: format!("{}/tag/{tag}", releases()), name: None }
    }))
}

fn latest_from_api() -> Result<Option<Latest>, String> {
    let request = agent(Duration::from_secs(10), 5)
        .get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .set("Accept", "application/vnd.github+json");
    let release: Value = match request.call() {
        Ok(response) => response.into_json().map_err(|error| error.to_string())?,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(ureq::Error::Status(status, _)) => return Err(format!("GitHub returned {status}")),
        Err(error) => return Err(error.to_string()),
    };
    let tag = release["tag_name"].as_str().unwrap_or("");
    Ok(Some(Latest {
        version: tag.strip_prefix('v').unwrap_or(tag).to_string(),
        url: release["html_url"].as_str().unwrap_or("").to_string(),
        name: release["name"].as_str().filter(|name| !name.is_empty()).map(str::to_string),
    }))
}

/// Live Update on Linux: compare this app's version with the latest GitHub release.
pub fn check(current_version: &str) -> Result<Value, String> {
    let latest = match latest_from_redirect() {
        Ok(latest) => latest,
        Err(_) => latest_from_api()?,
    };
    let Some(latest) = latest.filter(|latest| !latest.version.is_empty() && newer(&latest.version, current_version)) else {
        return Ok(json!({ "updates": [] }));
    };
    let name = latest.name.unwrap_or_else(|| format!("NitroSense {}", latest.version));
    Ok(json!({ "updates": [{ "name": name, "version": latest.version, "url": latest.url }] }))
}

fn run_checked(command: &str, args: &[&str], timeout: Duration) -> Result<(), String> {
    let name = super::util::basename(command);
    match run(command, args, timeout) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => {
            let text = if output.stderr.trim().is_empty() { output.stdout } else { output.stderr };
            Err(format!("{name} failed: {}", text.trim().lines().last().unwrap_or("it stopped with an error")))
        }
        Err(RunError::NotFound) => Err(format!("{name} failed: it is not installed")),
        Err(RunError::Failed(reason)) => Err(format!("{name} failed: {reason}")),
    }
}

/// Running from a git checkout (./install.sh --dev or cargo run): updates come through git, not here.
pub fn is_checkout(app_dir: &Path) -> bool {
    app_dir.join("../.git").exists()
}

/// A package-manager install says so in app/packaged: the AUR package writes "aur", the .deb and .rpm "deb" and "rpm".
/// The AUR's copy is left to the AUR helper; a .deb or .rpm installs the release's new packages (install_packages).
/// None = not packaged.
pub fn packaged(app_dir: &Path) -> Option<String> {
    super::util::read(app_dir.join("packaged")).filter(|manager| !manager.is_empty())
}

// The driver package's installed "version-release", or None when it isn't installed.
fn installed_driver(format: &str) -> Option<String> {
    let (command, args): (&str, &[&str]) = if format == "deb" {
        ("dpkg-query", &["-W", "-f=${db:Status-Status} ${Version}", "linuwu-sense-gpu-mode-dkms"])
    } else {
        ("rpm", &["-q", "--qf", "installed %{VERSION}-%{RELEASE}", "linuwu-sense-gpu-mode-dkms"])
    };
    let output = run(command, args, Duration::from_secs(10)).ok().filter(|output| output.success)?;
    let version = output.stdout.trim().strip_prefix("installed ")?;
    (!version.is_empty() && !version.contains(char::is_whitespace)).then(|| version.to_string())
}

fn get(url: &str, timeout: Duration) -> Result<ureq::Response, String> {
    match agent(timeout, 5).get(url).call() {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(status, _)) => Err(format!("GitHub returned {status} for {}", url.rsplit('/').next().unwrap_or(url))),
        Err(error) => Err(format!("Download failed: {error}")),
    }
}

// Streams url into file; when a sha256 is given the file must match it.
fn download(url: &str, file: &Path, sha256: Option<&str>, timeout: Duration) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Download failed: {error}");
    let mut body = get(url, timeout)?.into_reader();
    let mut out = std::fs::File::create(file).map_err(failed)?;
    let mut hash = Sha256::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = body.read(&mut chunk).map_err(failed)?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
        out.write_all(&chunk[..read]).map_err(failed)?;
    }
    out.flush().map_err(failed)?;
    let digest: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    match sha256 {
        Some(expected) if digest != expected => {
            Err(format!("{} doesn't match the release's SHA256SUMS", file.file_name().unwrap_or_default().to_string_lossy()))
        }
        _ => Ok(()),
    }
}

/// A fresh private folder under the temporary directory, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        let mut template = std::env::temp_dir().join("nitrosense-update-XXXXXX").into_os_string().into_encoded_bytes();
        template.push(0);
        if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
            return Err(format!("Can't create a temporary folder: {}", std::io::Error::last_os_error()));
        }
        template.pop();
        Ok(Self(PathBuf::from(String::from_utf8_lossy(&template).into_owned())))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// A .deb or .rpm install: download the release's packages for it, check them against the release's SHA256SUMS and
// install them with apt or dnf through pkexec (one password prompt).
fn install_packages(format: &str, version: &str, progress: &dyn Fn(&str)) -> Result<(), String> {
    let dir = TempDir::new()?;
    progress("downloading");
    let base = format!("{}/download/v{version}", releases());
    let sums = get(&format!("{base}/SHA256SUMS"), Duration::from_secs(30))?.into_string().map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for file in package_update::plan(format, version, &sums, installed_driver(format).as_deref())? {
        let path = dir.0.join(&file.name);
        download(&format!("{base}/{}", file.name), &path, Some(&file.sha256), Duration::from_secs(15 * 60))?;
        paths.push(path.to_string_lossy().into_owned());
    }
    // apt reads local packages as its own _apt user.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o755)).map_err(|error| error.to_string())?;
    }
    progress("installing");
    let command = package_update::install_command(format, &paths)?;
    let args: Vec<&str> = command.iter().map(String::as_str).collect();
    run_checked("pkexec", &args, Duration::from_secs(30 * 60))
}

// An installer copy: download the release's source and run its installer in update mode.
fn install_release(version: &str, progress: &dyn Fn(&str)) -> Result<(), String> {
    let dir = TempDir::new()?;
    progress("downloading");
    let archive = dir.0.join("source.tar.gz");
    let url = format!("https://github.com/{REPO}/archive/refs/tags/v{version}.tar.gz");
    download(&url, &archive, None, Duration::from_secs(120)).map_err(|error| match error.strip_suffix(&format!(" for v{version}.tar.gz")) {
        Some(status) => status.to_string(),
        None => error,
    })?;
    let folder = dir.0.to_string_lossy().into_owned();
    run_checked("tar", &["-xzf", &archive.to_string_lossy(), "-C", &folder], Duration::from_secs(60))?;
    progress("installing");
    let source = std::fs::read_dir(&dir.0)
        .map_err(|error| error.to_string())?
        .flatten()
        .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .ok_or("The release's archive is empty")?;
    // Generous timeout: a new release may need NitroSense's artwork downloaded again, and the app built.
    let installer = source.path().join("install.sh").to_string_lossy().into_owned();
    run_checked("bash", &[&installer, "--update"], Duration::from_secs(30 * 60))
}

/// One-click update. progress(stage): "downloading", "installing", "finished". When it returns { installed: true }
/// the caller restarts the app.
pub fn install(version: &str, app_dir: &Path, progress: &dyn Fn(&str)) -> Result<Value, String> {
    let mut numbers = version.split('.');
    let numeric = |part: Option<&str>| part.is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if !(numeric(numbers.next()) && numeric(numbers.next()) && numeric(numbers.next()) && numbers.next().is_none()) {
        return Err("Invalid version".to_string());
    }
    match packaged(app_dir).as_deref() {
        Some(format @ ("deb" | "rpm")) => install_packages(format, version, progress)?,
        Some(_) => return Err("This copy is updated by its package manager".to_string()),
        None => {
            if is_checkout(app_dir) {
                return Ok(json!({ "checkout": true }));
            }
            install_release(version, progress)?;
        }
    }
    progress("finished");
    Ok(json!({ "installed": true }))
}

pub fn is_release_url(url: &str) -> bool {
    url.starts_with(&format!("{}/", releases()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("0.10.0", "0.9.5"));
        assert!(newer("0.15.1", "0.15"));
        assert!(!newer("0.15.1", "0.15.1"));
        assert!(!newer("0.9.9", "0.10.0"));
        assert_eq!(percent_decode("v1.0%2Brc1"), "v1.0+rc1");
    }
}

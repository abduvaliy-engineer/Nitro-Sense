//! Live Update for a .deb or .rpm install: which of a release's packages to install, and the command that installs
//! them. Nothing here touches the network or the package manager, so the tests below run it.
use regex::Regex;

pub struct File {
    pub name: String,
    pub sha256: String,
}

// The file names 0.14's packaging/deb-rpm/build.sh gave the packages (nfpm's: name, version, release 1, architecture).
fn app_package(format: &str, version: &str) -> Option<String> {
    match format {
        "deb" => Some(format!("nitrosense-linux_{version}-1_amd64.deb")),
        "rpm" => Some(format!("nitrosense-linux-{version}-1.x86_64.rpm")),
        _ => None,
    }
}

fn driver_package(format: &str) -> Regex {
    Regex::new(match format {
        "deb" => r"^linuwu-sense-gpu-mode-dkms_(.+)_all\.deb$",
        _ => r"^linuwu-sense-gpu-mode-dkms-(.+)\.noarch\.rpm$",
    })
    .unwrap()
}

/// A release's SHA256SUMS (sha256sum's "<sha256>  <file>" lines) as (file, sha256), in the file's order.
pub fn parse_sums(text: &str) -> Vec<(String, String)> {
    let line_format = Regex::new(r"^([0-9a-f]{64}) [ *](\S+)$").unwrap();
    let mut sums: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        if let Some(found) = line_format.captures(line.trim()) {
            let (name, sha256) = (found[2].to_string(), found[1].to_string());
            match sums.iter_mut().find(|(known, _)| *known == name) {
                Some(entry) => entry.1 = sha256,
                None => sums.push((name, sha256)),
            }
        }
    }
    sums
}

/// Whether version a is newer than b, comparing the numbers between dots and dashes ("1.0.0.10-1" > "1.0.0.9-1").
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |version: &str| version.split(['.', '-']).map(|n| super::util::parse_int(n).unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// The release's files to install, with their sha256: the app's package, plus the driver's when the driver package is
/// installed and the release has a newer one. installed_driver is its installed "version-release", or None.
pub fn plan(format: &str, version: &str, sums_text: &str, installed_driver: Option<&str>) -> Result<Vec<File>, String> {
    let app = app_package(format, version).ok_or_else(|| format!("Unknown package format {format}"))?;
    let sums = parse_sums(sums_text);
    let Some((_, sha256)) = sums.iter().find(|(name, _)| *name == app) else { return Err(format!("The release has no {app}")) };
    let mut files = vec![File { name: app, sha256: sha256.clone() }];
    if let Some(installed) = installed_driver {
        let driver = driver_package(format);
        for (name, sha256) in &sums {
            if driver.captures(name).is_some_and(|found| newer(&found[1], installed)) {
                files.push(File { name: name.clone(), sha256: sha256.clone() });
            }
        }
    }
    Ok(files)
}

/// pkexec's arguments: apt or dnf installs the downloaded packages; apt waits a while if another update holds its lock.
pub fn install_command(format: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let command: &[&str] = match format {
        "deb" => &["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-o", "DPkg::Lock::Timeout=120"],
        "rpm" => &["dnf", "install", "-y"],
        _ => return Err(format!("Unknown package format {format}")),
    };
    Ok(command.iter().map(|part| part.to_string()).chain(paths.iter().cloned()).collect())
}

#[cfg(test)]
mod tests {
    //! Live Update's package choice for .deb and .rpm installs, without network or package manager. With
    //! NITROSENSE_DIST set to a folder of built packages it also checks their names.
    use super::*;

    fn sha(c: &str) -> String {
        c.repeat(64)
    }
    fn sums() -> String {
        [
            format!("{}  linuwu-sense-gpu-mode-dkms_1.0.0.2-1_all.deb", sha("a")),
            format!("{}  nitrosense-linux_0.15.0-1_amd64.deb", sha("b")),
            format!("{}  linuwu-sense-gpu-mode-dkms-1.0.0.2-1.noarch.rpm", sha("c")),
            format!("{}  nitrosense-linux-0.15.0-1.x86_64.rpm", sha("d")),
        ]
        .join("\n")
            + "\n"
    }
    fn names(format: &str, driver: Option<&str>) -> Vec<String> {
        plan(format, "0.15.0", &sums(), driver).unwrap().into_iter().map(|file| file.name).collect()
    }

    #[test]
    fn deb() {
        assert_eq!(names("deb", None), ["nitrosense-linux_0.15.0-1_amd64.deb"], "the app alone without the driver package");
        assert_eq!(
            names("deb", Some("1.0.0.1-1")),
            ["nitrosense-linux_0.15.0-1_amd64.deb", "linuwu-sense-gpu-mode-dkms_1.0.0.2-1_all.deb"],
            "the driver too when the release's is newer"
        );
        assert_eq!(names("deb", Some("1.0.0.2-1")), ["nitrosense-linux_0.15.0-1_amd64.deb"], "not the driver when it's the same");
        assert_eq!(names("deb", Some("1.0.0.10-1")), ["nitrosense-linux_0.15.0-1_amd64.deb"], "never an older driver (10 > 2)");
    }

    #[test]
    fn rpm() {
        assert_eq!(names("rpm", Some("1.0.0.1-1")), ["nitrosense-linux-0.15.0-1.x86_64.rpm", "linuwu-sense-gpu-mode-dkms-1.0.0.2-1.noarch.rpm"]);
        assert_eq!(plan("rpm", "0.15.0", &sums(), None).unwrap()[0].sha256, sha("d"), "each file keeps its sha256");
    }

    #[test]
    fn failures() {
        let missing = plan("deb", "0.16.0", &sums(), None).err().unwrap();
        assert!(missing.contains("no nitrosense-linux_0.16.0-1_amd64.deb"), "{missing}");
        assert!(plan("aur", "0.15.0", &sums(), None).err().unwrap().contains("Unknown package format"));
    }

    #[test]
    fn sums_and_commands() {
        let marked = parse_sums(&format!("{} *x.deb\n", sha("e")));
        assert_eq!(marked, [("x.deb".to_string(), sha("e"))], "sha256sum's binary marker");
        let paths = |list: &[&str]| list.iter().map(|path| path.to_string()).collect::<Vec<_>>();
        assert_eq!(
            install_command("deb", &paths(&["/tmp/u/a.deb", "/tmp/u/b.deb"])).unwrap(),
            ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-o", "DPkg::Lock::Timeout=120", "/tmp/u/a.deb", "/tmp/u/b.deb"]
        );
        assert_eq!(install_command("rpm", &paths(&["/tmp/u/a.rpm"])).unwrap(), ["dnf", "install", "-y", "/tmp/u/a.rpm"]);
    }

    #[test]
    fn built_packages_have_the_expected_names() {
        let Some(dist) = std::env::var_os("NITROSENSE_DIST") else { return };
        let built = std::fs::read_to_string(std::path::Path::new(&dist).join("SHA256SUMS")).unwrap();
        for format in ["deb", "rpm"] {
            let files = plan(format, crate::common::VERSION, &built, Some("0-0")).unwrap();
            assert_eq!(files.len(), 2, "{format}: the app and driver packages build.sh made");
        }
    }
}

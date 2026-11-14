//! What the background part (nitrosense) and the window (nitrosense-ui) share: where things are.
use std::path::{Path, PathBuf};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The socket the window and later `nitrosense` runs reach the background part on.
pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("NITROSENSE_SOCKET").filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }
    match std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => Path::new(&dir).join("nitrosense.sock"),
        None => PathBuf::from(format!("/tmp/nitrosense-{}.sock", unsafe { libc::getuid() })),
    }
}

/// The folder holding renderer/, vendor/ and assets/: next to the binaries when installed, the checkout's app/
/// when run from target/.
pub fn app_dir() -> PathBuf {
    let has_ui = |dir: &Path| dir.join("renderer/index.html").is_file();
    if let Some(dir) = std::env::var_os("NITROSENSE_APP_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    let exe = std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok());
    let mut candidates = Vec::new();
    if let Some(dir) = exe.as_deref().and_then(Path::parent) {
        candidates.push(dir.join("app"));
        candidates.push(dir.join("../../app"));
    }
    candidates.push(PathBuf::from("/usr/lib/nitrosense-linux/app"));
    for dir in &candidates {
        if has_ui(dir) {
            return dir.canonicalize().unwrap_or_else(|_| dir.clone());
        }
    }
    candidates.remove(0)
}

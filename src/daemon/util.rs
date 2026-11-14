//! Small helpers shared by the backend modules.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A file's text without surrounding whitespace, or None when it can't be read.
pub fn read(path: impl AsRef<Path>) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
}

/// The leading integer of a string, like JavaScript's parseInt(text, 10).
pub fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value: i64 = digits[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

pub fn read_int(path: impl AsRef<Path>) -> Option<i64> {
    read(path).and_then(|text| parse_int(&text))
}

pub fn exists(path: impl AsRef<Path>) -> bool {
    std::fs::metadata(path).is_ok()
}

/// access(2) with the given mode (libc::W_OK, libc::X_OK ...).
pub fn accessible(path: impl AsRef<Path>, mode: libc::c_int) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_ref().as_os_str().as_bytes()) else { return false };
    unsafe { libc::access(path.as_ptr(), mode) == 0 }
}

/// The names in a folder, sorted (empty when it can't be read).
pub fn entries(dir: impl AsRef<Path>) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|items| items.flatten().map(|item| item.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// JavaScript's Math.round: halves go up.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// The last path component, like Node's path.basename.
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
}

/// The first PATH entry holding `name` that passes access(2) with `mode`.
pub fn on_path(name: &str, mode: libc::c_int) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    path.split(':').map(|dir| Path::new(dir).join(name)).find(|file| accessible(file, mode))
}

pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub enum RunError {
    /// The program isn't installed.
    NotFound,
    Failed(String),
}

/// Runs a program to its end and collects its output; it is killed when it runs longer than `timeout`.
pub fn run(program: &str, args: &[&str], timeout: Duration) -> Result<Output, RunError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => RunError::NotFound,
            _ => RunError::Failed(error.to_string()),
        })?;
    let collect = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = collect(Box::new(child.stdout.take().expect("piped stdout")));
    let stderr = collect(Box::new(child.stderr.take().expect("piped stderr")));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break None,
        }
    };
    let output = Output {
        success: !timed_out && status.is_some_and(|status| status.success()),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    };
    Ok(output)
}

/// Starts a program on its own (new session, no terminal), like a launcher does. A program that can't start is ignored.
pub fn spawn_detached(program: &str, args: &[String]) {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    if let Ok(mut child) = command.spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

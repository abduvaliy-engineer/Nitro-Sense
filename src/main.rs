//! nitrosense: NitroSense for Linux's background part.
//!
//!   nitrosense            show the window (starting the background part when it isn't running)
//!   nitrosense --hidden   start without a window (login autostart)
//!   nitrosense --quit     stop the background part and close the window
//!   nitrosense --update   install the latest release, as Live Update's Update All does
//!   nitrosense --dev      reload the window when the files in app/ change
//!
//! Like NitroSense, the app keeps running when its window closes, so App Sync and the mode-change keyboard flash
//! keep working. The window is a separate program (nitrosense-ui) that exists only while it is open; this one
//! stays small.
mod common;
mod daemon;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    if has("--version") || has("-V") {
        println!("{}", common::VERSION);
        return;
    }
    if has("--help") || has("-h") {
        println!("NitroSense for Linux {}\n\n  nitrosense            show the window\n  nitrosense --hidden   start without a window\n  nitrosense --quit     stop NitroSense\n  nitrosense --update   install the latest release\n  nitrosense --dev      reload the window when the files in app/ change", common::VERSION);
        return;
    }
    if has("--update") || has("update") {
        std::process::exit(update());
    }
    let command = if has("--quit") { "quit" } else if has("--hidden") { "hidden" } else { "show" };

    // Like NitroSense, a second launch shows the running window instead of opening another.
    for attempt in 0..30 {
        if tell_running(command) {
            return;
        }
        if command == "quit" {
            return;
        }
        if let Some(lock) = daemon::single_instance_lock() {
            daemon::run(lock, command == "hidden", has("--dev"));
            return;
        }
        // Another copy is starting right now: give it a moment, then talk to it.
        if attempt == 29 {
            eprintln!("nitrosense: another copy is starting but doesn't answer");
            std::process::exit(1);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// `nitrosense --update`: what Live Update's Update All does, from a terminal. The new release's installer runs here,
// so its output and any password prompt show in the terminal; a running NitroSense then restarts as the new version.
fn update() -> i32 {
    use daemon::updates;
    let app_dir = common::app_dir();
    if updates::is_checkout(&app_dir) {
        eprintln!("This NitroSense runs from a git checkout: update it with git pull, then ./nitrosense.sh --dev.");
        return 1;
    }
    let latest = match updates::check(common::VERSION) {
        Ok(result) => result["updates"][0].clone(),
        Err(error) => {
            eprintln!("nitrosense: checking for updates failed: {error}");
            return 1;
        }
    };
    let Some(version) = latest["version"].as_str() else {
        println!("NitroSense {} is up to date.", common::VERSION);
        return 0;
    };
    println!("Updating NitroSense {} to {version}", common::VERSION);
    let progress = |stage: &str| {
        if stage == "downloading" {
            println!("Downloading {version}");
        }
    };
    match updates::install(version, &app_dir, &progress, updates::Output::Terminal) {
        Ok(_) if tell_running("restart") => {
            println!("NitroSense {version} is installed and running.");
            0
        }
        Ok(_) => {
            println!("NitroSense {version} is installed.");
            0
        }
        Err(error) => {
            eprintln!("nitrosense: the update failed: {error}");
            1
        }
    }
}

// Passes the command to the running background part; false when there is none.
fn tell_running(command: &str) -> bool {
    let Ok(mut stream) = UnixStream::connect(common::socket_path()) else { return false };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    if writeln!(stream, "{}", serde_json::json!({ "hello": "cli", "cmd": command })).is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok_and(|read| read > 0) || command == "quit"
}

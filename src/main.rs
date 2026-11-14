//! nitrosense: NitroSense for Linux's background part.
//!
//!   nitrosense            show the window (starting the background part when it isn't running)
//!   nitrosense --hidden   start without a window (login autostart)
//!   nitrosense --quit     stop the background part and close the window
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
        println!("NitroSense for Linux {}\n\n  nitrosense            show the window\n  nitrosense --hidden   start without a window\n  nitrosense --quit     stop NitroSense\n  nitrosense --dev      reload the window when the files in app/ change", common::VERSION);
        return;
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

//! nitrosense-ui: NitroSense for Linux's window. It shows app/renderer in a WebKitGTK web view and passes the
//! pages' calls to the background part (nitrosense) over its socket. Closing the window ends this program; the
//! background part stays.
#[allow(dead_code)]
#[path = "../common.rs"]
mod common;

use gtk::prelude::*;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::unix::{EventLoopBuilderExtUnix, WindowExtUnix};
use tao::window::WindowBuilder;
use wry::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use wry::{WebContext, WebViewBuilder, WebViewBuilderExtUnix};

const APP_ID: &str = "io.github.abduvaliy.NitroSense";
const START_PAGE: &str = "nitro://localhost/renderer/index.html";

enum UserEvent {
    /// A message from a page (bridge.js).
    Page(String),
    /// A line from the background part.
    Daemon(String),
    DaemonGone,
    /// --dev: a file under app/ changed.
    Reload,
}

fn content_type(file: &Path) -> &'static str {
    match file.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%').then(|| text.get(i + 1..i + 3)).flatten().and_then(|hex| u8::from_str_radix(hex, 16).ok());
        out.push(hex.unwrap_or(bytes[i]));
        i += if hex.is_some() { 3 } else { 1 };
    }
    String::from_utf8_lossy(&out).into_owned()
}

// nitro://localhost/<path> is <app dir>/<path>; nothing outside the app's folder is served.
fn serve(app_dir: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let respond = |status: StatusCode, kind: &str, body: Vec<u8>| {
        Response::builder().status(status).header(CONTENT_TYPE, kind).body(Cow::Owned(body)).expect("a valid response")
    };
    let path = percent_decode(request.uri().path());
    let relative = Path::new(path.trim_start_matches('/'));
    if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let file = app_dir.join(relative);
    match std::fs::read(&file) {
        Ok(body) => respond(StatusCode::OK, content_type(&file), body),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

// The newest change time of everything under dir.
fn newest_change(dir: &Path) -> Option<SystemTime> {
    let mut newest = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let changed = if meta.is_dir() { newest_change(&entry.path()) } else { meta.modified().ok() };
        newest = newest.max(changed);
    }
    newest
}

fn cache_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME").filter(|dir| !dir.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cache")).join("nitrosense")
}

fn main() {
    let dev = std::env::args().any(|arg| arg == "--dev");
    let app_dir = common::app_dir();

    let mut daemon = match UnixStream::connect(common::socket_path()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("nitrosense-ui: the background part isn't running ({error}); start NitroSense with: nitrosense");
            std::process::exit(1);
        }
    };
    let Ok(daemon_reader) = daemon.try_clone() else { std::process::exit(1) };
    if writeln!(daemon, "{}", json!({ "hello": "ui" })).is_err() {
        std::process::exit(1);
    }

    // The window's class (Wayland app id), which the desktop entry's StartupWMClass names.
    gtk::glib::set_prgname(Some(APP_ID));
    let mut builder = EventLoopBuilder::<UserEvent>::with_user_event();
    builder.with_app_id(APP_ID);
    let event_loop = builder.build();

    let window = WindowBuilder::new()
        .with_title("NitroSense")
        .with_inner_size(LogicalSize::new(1168.0, 780.0))
        .with_min_inner_size(LogicalSize::new(500.0, 670.0))
        .with_decorations(false)
        .build(&event_loop)
        .expect("the window opens");

    let mut context = WebContext::new(Some(cache_dir()));
    let page_events = event_loop.create_proxy();
    let served = app_dir.clone();
    #[allow(unused_mut)]
    let mut builder = WebViewBuilder::new_with_web_context(&mut context);
    // Development builds only: a script for driving the pages in tests.
    #[cfg(debug_assertions)]
    if let Some(script) = std::env::var_os("NITROSENSE_TEST_SCRIPT").and_then(|file| std::fs::read_to_string(file).ok()) {
        builder = builder.with_initialization_script(script);
    }
    let webview = builder
        .with_custom_protocol("nitro".to_string(), move |_id, request| serve(&served, &request))
        .with_initialization_script(include_str!("bridge.js"))
        .with_ipc_handler(move |message| {
            let _ = page_events.send_event(UserEvent::Page(message.into_body()));
        })
        // The pages never leave the app.
        .with_navigation_handler(|url| url.starts_with("nitro://"))
        .with_background_color((0x38, 0x12, 0x00, 0xff))
        .with_devtools(dev)
        .with_url(START_PAGE)
        .build_gtk(window.default_vbox().expect("the window has a content box"))
        .expect("the web view starts");

    let daemon_events = event_loop.create_proxy();
    std::thread::spawn(move || {
        for line in BufReader::new(daemon_reader).lines() {
            let Ok(line) = line else { break };
            if daemon_events.send_event(UserEvent::Daemon(line)).is_err() {
                return;
            }
        }
        let _ = daemon_events.send_event(UserEvent::DaemonGone);
    });

    if dev {
        let reload = event_loop.create_proxy();
        std::thread::spawn(move || {
            let mut last = newest_change(&app_dir);
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let now = newest_change(&app_dir);
                if now != last {
                    last = now;
                    if reload.send_event(UserEvent::Reload).is_err() {
                        return;
                    }
                }
            }
        });
    }

    // message: JSON text, which is also a JavaScript expression once its line separators are escaped.
    let to_page = |webview: &wry::WebView, message: &str| {
        let message = message.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
        let _ = webview.evaluate_script(&format!("window.__nitroReceive&&window.__nitroReceive({message})"));
    };
    let mut maximized = window.is_maximized();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => {
                if window.is_maximized() != maximized {
                    maximized = !maximized;
                    to_page(&webview, &json!({ "event": "window:maximized", "payload": maximized }).to_string());
                }
            }
            Event::UserEvent(UserEvent::Page(message)) => {
                let Ok(mut call) = serde_json::from_str::<Value>(&message) else { return };
                match call["cmd"].as_str().unwrap_or("") {
                    "window:minimize" => window.set_minimized(true),
                    "window:toggle-maximize" => window.set_maximized(!window.is_maximized()),
                    "window:close" => *control_flow = ControlFlow::Exit,
                    "window:drag" => drop(window.drag_window()),
                    #[cfg(debug_assertions)]
                    "test:log" => eprintln!("page: {}", call["args"]),
                    cmd => {
                        if cmd == "apps:pickFile" {
                            // "Cannot find app?": the file dialog is the window's; the background part does the rest.
                            let dialog = gtk::FileChooserNative::new(
                                Some("Add Apps to Link"),
                                Some(window.gtk_window()),
                                gtk::FileChooserAction::Open,
                                None,
                                None,
                            );
                            let picked = (dialog.run() == gtk::ResponseType::Accept).then(|| dialog.filename()).flatten();
                            call["args"] = json!([picked.map(|file| file.to_string_lossy().into_owned())]);
                        }
                        if writeln!(daemon, "{call}").is_err() {
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Daemon(line)) => {
                let control = serde_json::from_str::<Value>(&line).ok().and_then(|message| message["control"].as_str().map(str::to_string));
                match control.as_deref() {
                    // A second launch: bring this window to the front.
                    Some("show") => {
                        window.set_minimized(false);
                        window.set_visible(true);
                        window.set_focus();
                    }
                    Some("quit") => *control_flow = ControlFlow::Exit,
                    Some(_) => {}
                    None => to_page(&webview, &line),
                }
            }
            Event::UserEvent(UserEvent::DaemonGone) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Reload) => drop(webview.reload()),
            _ => {}
        }
    });
}

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap_or_else(|error| {
        panic!(
            "could not read embedded terminal web client directory {}: {error}",
            directory.display()
        )
    }) {
        let path = entry
            .expect("could not read terminal web client entry")
            .path();
        if path.is_dir() {
            collect_files(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("ico") => "image/x-icon",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let client = manifest.join("../../../../tools/terminal-web/dist/client");
    let index = client.join("index.html");
    if !index.is_file() {
        panic!(
            "the production terminal web client is missing at {}; run `bun run build:client` in tools/terminal-web before building TerminalConnection",
            index.display()
        );
    }

    println!("cargo:rerun-if-changed={}", client.display());
    let mut files = Vec::new();
    collect_files(&client, &mut files);
    files.sort();

    let mut generated =
        String::from("static EMBEDDED_CLIENT_ASSETS: &[EmbeddedClientAsset] = &[\n");
    for file in files {
        let relative = file
            .strip_prefix(&client)
            .expect("embedded client path left its root")
            .to_string_lossy()
            .replace('\\', "/");
        let absolute = file
            .canonicalize()
            .expect("could not resolve embedded terminal web client asset")
            .to_string_lossy()
            .into_owned();
        generated.push_str(&format!(
            "    EmbeddedClientAsset {{ path: {relative:?}, content_type: {:?}, bytes: include_bytes!({absolute:?}) }},\n",
            content_type(&file)
        ));
    }
    generated.push_str("];\n");

    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("embedded_client.rs");
    fs::write(output, generated).expect("could not generate embedded terminal web client table");
}

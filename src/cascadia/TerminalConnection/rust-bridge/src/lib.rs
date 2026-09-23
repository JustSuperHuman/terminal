mod agents;
mod file_preview;
mod host;
mod model;
mod orchestrator;
mod profiles;
mod projects;
mod prompt;
mod vt_stream;

use host::{AppState, BridgeConfig, NativeCallback};
use model::TerminalSessionSummary;
use std::ffi::c_void;
use std::path::PathBuf;
use std::slice;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;

static BRIDGE: OnceLock<AppState> = OnceLock::new();

fn from_utf16(pointer: *const u16, length: usize) -> String {
    if pointer.is_null() || length == 0 {
        return String::new();
    }
    // SAFETY: every public FFI entry point documents that pointers remain
    // valid for the duration of the call and contain `length` UTF-16 units.
    String::from_utf16_lossy(unsafe { slice::from_raw_parts(pointer, length) })
}

fn bridge() -> Option<&'static AppState> {
    BRIDGE.get()
}

fn copy_utf16(value: &str, output: *mut u16, capacity: usize) -> usize {
    let encoded: Vec<u16> = value.encode_utf16().collect();
    if !output.is_null() && capacity > 0 {
        let count = encoded.len().min(capacity.saturating_sub(1));
        // SAFETY: the caller provided a writable buffer of `capacity` units.
        unsafe {
            std::ptr::copy_nonoverlapping(encoded.as_ptr(), output, count);
            *output.add(count) = 0;
        }
    }
    encoded.len()
}

#[no_mangle]
pub extern "C" fn tbr_initialize(
    asset_root: *const u16,
    asset_root_len: usize,
    data_root: *const u16,
    data_root_len: usize,
    automatic_port: bool,
    port: u16,
    bind_address: *const u16,
    bind_address_len: usize,
    web_interface_enabled: bool,
    context: *mut c_void,
    callback: host::NativeCommandCallback,
) -> bool {
    std::panic::catch_unwind(|| {
        if BRIDGE.get().is_some() {
            return true;
        }
        let asset_root = PathBuf::from(from_utf16(asset_root, asset_root_len));
        let data_root = PathBuf::from(from_utf16(data_root, data_root_len));
        let bind_address = from_utf16(bind_address, bind_address_len);
        let state = AppState::new(
            asset_root,
            data_root,
            NativeCallback {
                context: context as usize,
                callback,
            },
            BridgeConfig {
                automatic_port,
                port: port.max(1),
                bind_address: if bind_address.is_empty() {
                    "0.0.0.0".into()
                } else {
                    bind_address
                },
                web_interface_enabled,
            },
        );
        if BRIDGE.set(state.clone()).is_err() {
            return true;
        }
        std::thread::Builder::new()
            .name("terminal-bridge-rust".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_name("terminal-bridge-worker")
                    .build();
                match runtime {
                    Ok(runtime) => {
                        if let Err(error) = runtime.block_on(host::run(state.clone())) {
                            state.status.store(host::STATUS_FAILING, Ordering::Relaxed);
                            eprintln!("terminal bridge host failed: {error}");
                        }
                    }
                    Err(error) => {
                        state.status.store(host::STATUS_FAILING, Ordering::Relaxed);
                        eprintln!("terminal bridge runtime failed: {error}");
                    }
                }
            })
            .is_ok()
    })
    .unwrap_or(false)
}

#[no_mangle]
pub extern "C" fn tbr_register_session(
    id: *const u16,
    id_len: usize,
    title: *const u16,
    title_len: usize,
    shell: *const u16,
    shell_len: usize,
    cwd: *const u16,
    cwd_len: usize,
    pid: u32,
    cols: u32,
    rows: u32,
) {
    let _ = std::panic::catch_unwind(|| {
        let Some(bridge) = bridge() else { return };
        bridge.register_native(TerminalSessionSummary::native(
            from_utf16(id, id_len),
            from_utf16(title, title_len),
            from_utf16(shell, shell_len),
            from_utf16(cwd, cwd_len),
            pid,
            cols.clamp(20, 400) as u16,
            rows.clamp(8, 200) as u16,
        ));
    });
}

#[no_mangle]
pub extern "C" fn tbr_forward_output(
    id: *const u16,
    id_len: usize,
    data: *const u16,
    data_len: usize,
) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            bridge.append_output(&from_utf16(id, id_len), from_utf16(data, data_len), false);
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_forward_title(
    id: *const u16,
    id_len: usize,
    title: *const u16,
    title_len: usize,
) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            bridge.rename(&from_utf16(id, id_len), from_utf16(title, title_len));
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_set_project(
    id: *const u16,
    id_len: usize,
    project: *const u16,
    project_len: usize,
) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            let project = from_utf16(project, project_len);
            bridge.set_project(
                &from_utf16(id, id_len),
                (!project.is_empty()).then_some(project),
            );
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_update_cwd(id: *const u16, id_len: usize, cwd: *const u16, cwd_len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            bridge.set_cwd(&from_utf16(id, id_len), from_utf16(cwd, cwd_len));
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_notify_resize(id: *const u16, id_len: usize, rows: u32, cols: u32) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            bridge.resize_from_native(
                &from_utf16(id, id_len),
                cols.clamp(20, 400) as u16,
                rows.clamp(8, 200) as u16,
            );
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_notify_exit(id: *const u16, id_len: usize, exit_code: u32) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            bridge.exit(&from_utf16(id, id_len), Some(exit_code), None);
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_unregister(id: *const u16, id_len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if let Some(bridge) = bridge() {
            bridge.unregister(&from_utf16(id, id_len));
        }
    });
}

#[no_mangle]
pub extern "C" fn tbr_status() -> u32 {
    bridge()
        .map(|bridge| bridge.status.load(Ordering::Relaxed))
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn tbr_copy_endpoint(output: *mut u16, capacity: usize) -> usize {
    bridge()
        .map(|bridge| copy_utf16(&bridge.endpoint.read(), output, capacity))
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn tbr_copy_access_token(output: *mut u16, capacity: usize) -> usize {
    bridge()
        .map(|bridge| copy_utf16(bridge.token.as_str(), output, capacity))
        .unwrap_or(0)
}

#[cfg(test)]
mod ffi_tests {
    use super::*;
    use std::ffi::c_void;
    use std::time::Duration;

    unsafe extern "C" fn callback(
        _: *mut c_void,
        _: *const u16,
        _: usize,
        _: u32,
        _: *const u16,
        _: usize,
        _: u32,
        _: u32,
    ) {
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn c_abi_starts_host_and_publishes_native_session() {
        let root = tempfile::tempdir().unwrap().keep();
        let root_wide = wide(&root.to_string_lossy());
        assert!(tbr_initialize(
            root_wide.as_ptr(),
            root_wide.len(),
            root_wide.as_ptr(),
            root_wide.len(),
            true,
            10001,
            std::ptr::null(),
            0,
            true,
            std::ptr::null_mut(),
            callback,
        ));

        for _ in 0..100 {
            if tbr_status() == host::STATUS_CONNECTED {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(tbr_status(), host::STATUS_CONNECTED);

        let mut endpoint = vec![0u16; 128];
        let endpoint_len = tbr_copy_endpoint(endpoint.as_mut_ptr(), endpoint.len());
        let endpoint = String::from_utf16(&endpoint[..endpoint_len]).unwrap();
        let id = wide("ffi-session");
        let title = wide("FFI session");
        let shell = wide("pwsh.exe");
        let cwd = wide("C:\\work");
        tbr_register_session(
            id.as_ptr(),
            id.len(),
            title.as_ptr(),
            title.len(),
            shell.as_ptr(),
            shell.len(),
            cwd.as_ptr(),
            cwd.len(),
            101,
            100,
            30,
        );
        let output = wide("ffi output\r\n");
        tbr_forward_output(id.as_ptr(), id.len(), output.as_ptr(), output.len());

        let bootstrap: serde_json::Value = reqwest::get(format!("http://{endpoint}/api/bootstrap"))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(bootstrap["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["id"] == "ffi-session"));
    }
}

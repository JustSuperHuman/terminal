use crate::model::TerminalProfile;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn candidate_settings_paths() -> Vec<PathBuf> {
    let Some(local) = env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let local = PathBuf::from(local);
    [
        "Packages/WindowsTerminalDev_8wekyb3d8bbwe/LocalState/settings.json",
        "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
        "Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
        "Packages/Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe/LocalState/settings.json",
        "Microsoft/Windows Terminal/settings.json",
    ]
    .into_iter()
    .map(|relative| local.join(relative))
    .collect()
}

pub fn resolve_settings_path() -> Option<PathBuf> {
    if let Some(configured) = env::var_os("TERMINAL_WEB_SETTINGS_PATH") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }
    candidate_settings_paths()
        .into_iter()
        .find(|path| path.is_file())
}

fn infer_agent(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for agent in ["codex", "claude", "hermes"] {
        if lower
            .split(|character: char| {
                !character.is_ascii_alphanumeric() && character != '-' && character != '_'
            })
            .any(|part| part.trim_end_matches(".exe") == agent)
        {
            return Some(agent.into());
        }
    }
    None
}

fn string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn expand_environment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remainder = value;
    while let Some(start) = remainder.find('%') {
        output.push_str(&remainder[..start]);
        let after = &remainder[start + 1..];
        let Some(end) = after.find('%') else {
            output.push_str(&remainder[start..]);
            return output;
        };
        let name = &after[..end];
        output.push_str(&env::var(name).unwrap_or_else(|_| format!("%{name}%")));
        remainder = &after[end + 1..];
    }
    output.push_str(remainder);
    output
}

fn split_windows_command_line(command_line: &str) -> Vec<String> {
    let input: Vec<char> = command_line.chars().collect();
    let mut args = Vec::new();
    let mut cursor = 0;
    while cursor < input.len() {
        while input.get(cursor).is_some_and(|value| value.is_whitespace()) {
            cursor += 1;
        }
        if cursor >= input.len() {
            break;
        }
        let mut value = String::new();
        let mut quoted = false;
        while cursor < input.len()
            && (quoted || !input.get(cursor).is_some_and(|value| value.is_whitespace()))
        {
            if input[cursor] == '\\' {
                let start = cursor;
                while input.get(cursor) == Some(&'\\') {
                    cursor += 1;
                }
                let slashes = cursor - start;
                if input.get(cursor) == Some(&'"') {
                    value.extend(std::iter::repeat_n('\\', slashes / 2));
                    if slashes % 2 == 1 {
                        value.push('"');
                    } else {
                        quoted = !quoted;
                    }
                    cursor += 1;
                } else {
                    value.extend(std::iter::repeat_n('\\', slashes));
                }
            } else if input[cursor] == '"' {
                quoted = !quoted;
                cursor += 1;
            } else {
                value.push(input[cursor]);
                cursor += 1;
            }
        }
        args.push(value);
    }
    args
}

pub fn read_profiles_from(path: &Path) -> Result<Vec<TerminalProfile>, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let root: Value = json5::from_str(&raw).map_err(|error| error.to_string())?;
    let list = root
        .pointer("/profiles/list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut profiles = Vec::new();
    for (index, item) in list.iter().enumerate() {
        if item.get("hidden").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let label = string(item.get("name")).unwrap_or_else(|| format!("Terminal {}", index + 1));
        let commandline = string(item.get("commandline"))
            .or_else(|| string(item.get("commandLine")))
            .unwrap_or_else(|| "pwsh.exe".into());
        let argv = split_windows_command_line(&expand_environment(&commandline));
        let guid = string(item.get("guid"));
        let id = guid.clone().unwrap_or_else(|| format!("profile-{index}"));
        let agent = infer_agent(&format!("{label} {commandline}"));
        profiles.push(TerminalProfile {
            id,
            label,
            shell: argv.first().cloned().unwrap_or_else(|| "pwsh.exe".into()),
            args: argv.into_iter().skip(1).collect(),
            group: if agent.is_some() {
                "agent".into()
            } else {
                "shell".into()
            },
            description: string(item.get("source")),
            agent,
            terminal_profile_guid: guid,
        });
    }
    Ok(profiles)
}

pub fn read_profiles() -> Vec<TerminalProfile> {
    resolve_settings_path()
        .and_then(|path| read_profiles_from(&path).ok())
        .filter(|profiles| !profiles.is_empty())
        .unwrap_or_else(|| {
            vec![TerminalProfile {
                id: "powershell".into(),
                label: "PowerShell".into(),
                shell: "pwsh.exe".into(),
                args: vec!["-NoLogo".into()],
                group: "shell".into(),
                description: Some("PowerShell 7".into()),
                agent: None,
                terminal_profile_guid: None,
            }]
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_jsonc_profiles_and_filters_hidden_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        fs::write(
            &path,
            r#"{
          // configured launchers
          profiles: { list: [
            { guid: "{abc}", name: "Claude", commandline: "claude.exe", },
            { guid: "{hidden}", name: "Hidden", hidden: true },
          ] },
        }"#,
        )
        .unwrap();
        let profiles = read_profiles_from(&path).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].agent.as_deref(), Some("claude"));
        assert_eq!(profiles[0].terminal_profile_guid.as_deref(), Some("{abc}"));
    }
}

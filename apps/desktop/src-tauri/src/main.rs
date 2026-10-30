#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

const CREDENTIAL_SERVICE: &str = "com.multibusinessbilling.desktop.device";

fn credential_account(server_url: &str, business_id: &str) -> String {
    format!("{server_url}|{business_id}")
}

fn validate_credential(device_id: &str, credential: &str) -> Result<(), String> {
    if device_id.len() != 36
        || !device_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        || credential.len() != 43
        || !credential
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("Device credential input is invalid.".into());
    }
    Ok(())
}

#[tauri::command]
fn save_device_credential(
    server_url: String,
    business_id: String,
    device_id: String,
    credential: String,
) -> Result<(), String> {
    validate_credential(&device_id, &credential)?;
    let account = credential_account(&server_url, &business_id);
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|_| "Windows Credential Manager is unavailable.".to_string())?;
    entry
        .set_password(&format!("{device_id}.{credential}"))
        .map_err(|_| "Windows Credential Manager could not save this device.".to_string())
}

#[tauri::command]
fn load_device_credential(server_url: String, business_id: String) -> Result<Option<String>, String> {
    let account = credential_account(&server_url, &business_id);
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|_| "Windows Credential Manager is unavailable.".to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Windows Credential Manager could not load this device.".into()),
    }
}

#[tauri::command]
fn clear_device_credential(server_url: String, business_id: String) -> Result<(), String> {
    let account = credential_account(&server_url, &business_id);
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|_| "Windows Credential Manager is unavailable.".to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Windows Credential Manager could not clear this device.".into()),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_device_credential,
            load_device_credential,
            clear_device_credential
        ])
        .run(tauri::generate_context!())
        .expect("failed to run desktop application");
}

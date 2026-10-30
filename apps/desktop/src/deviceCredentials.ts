import { invoke } from "@tauri-apps/api/core";

export type DeviceCredential = {
  deviceId: string;
  credential: string;
};

let activeCredential: DeviceCredential | null = null;
let activeKey: string | null = null;
let activeLocation: { serverUrl: string; businessId: string } | null = null;

function key(serverUrl: string, businessId: string) {
  return `${serverUrl}|${businessId}`;
}

function secureStoreError() {
  return new Error("Secure device storage is unavailable. Use the installed Windows application to pair this device.");
}

export async function loadDeviceCredential(serverUrl: string, businessId: string) {
  try {
    const value = await invoke<string | null>("load_device_credential", { serverUrl, businessId });
    if (!value) {
      clearActiveDeviceCredential();
      return null;
    }
    const separator = value.indexOf(".");
    const deviceId = value.slice(0, separator);
    const credential = value.slice(separator + 1);
    if (separator <= 0 || !/^[0-9a-f-]{36}$/i.test(deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw new Error("The saved device credential is invalid. Forget this device and pair again.");
    }
    const result = { deviceId, credential };
    setActiveDeviceCredential(serverUrl, businessId, result);
    return result;
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("The saved device credential")) throw reason;
    throw secureStoreError();
  }
}

export async function saveDeviceCredential(
  serverUrl: string,
  businessId: string,
  credential: DeviceCredential,
) {
  try {
    await invoke("save_device_credential", {
      serverUrl,
      businessId,
      deviceId: credential.deviceId,
      credential: credential.credential,
    });
    setActiveDeviceCredential(serverUrl, businessId, credential);
  } catch {
    throw secureStoreError();
  }
}

export async function clearDeviceCredential(serverUrl: string, businessId: string) {
  try {
    await invoke("clear_device_credential", { serverUrl, businessId });
    if (activeKey === key(serverUrl, businessId)) clearActiveDeviceCredential();
  } catch {
    throw secureStoreError();
  }
}

export async function forgetActiveDeviceCredential() {
  const location = activeLocation;
  if (!location) {
    clearActiveDeviceCredential();
    return;
  }
  await clearDeviceCredential(location.serverUrl, location.businessId);
}

export function setActiveDeviceCredential(serverUrl: string, businessId: string, value: DeviceCredential) {
  activeKey = key(serverUrl, businessId);
  activeLocation = { serverUrl, businessId };
  activeCredential = value;
}

export function clearActiveDeviceCredential() {
  activeCredential = null;
  activeKey = null;
  activeLocation = null;
}

export function getActiveDeviceHeaders(): Record<string, string> {
  if (!activeCredential) return {};
  return {
    "x-device-id": activeCredential.deviceId,
    "x-device-credential": activeCredential.credential,
  };
}

import { createHash } from "node:crypto";
import { accessSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const powershell = "powershell.exe";
const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scriptsDirectory = join(projectRoot, "apps", "server", "scripts", "windows");
const buildScript = join(scriptsDirectory, "build-server-installer.ps1");
const installScript = join(scriptsDirectory, "install-server.ps1");
const uninstallScript = join(scriptsDirectory, "uninstall-server.ps1");
const rollbackFixture = join(projectRoot, "apps", "server", "test", "fixtures", "windows-install-rollback.ps1");
const setupScript = join(scriptsDirectory, "setup-server.ps1");
const installerNsi = join(scriptsDirectory, "server-installer.nsi");
const diagnosticRunner = join(scriptsDirectory, "run-server-install.ps1");
const tlsAclFixture = join(projectRoot, "apps", "server", "test", "fixtures", "windows-tls-acl.ps1");
const sandboxes: string[] = [];

function createSandbox() {
  const path = mkdtempSync(join(tmpdir(), "billing-server-installer-"));
  sandboxes.push(path);
  return path;
}

function runPowerShell(script: string, args: string[]) {
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    script,
    ...args,
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
}

function protectEnvironmentFile(path: string) {
  const identity = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME ?? "CURRENT_USER";
  return spawnSync("icacls.exe", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${identity}:F`,
    "BUILTIN\\Administrators:F",
    "NT AUTHORITY\\SYSTEM:F",
  ], { encoding: "utf8", windowsHide: true });
}

function addRollbackSupport(payload: string) {
  const relative = join("apps", "server", "scripts", "windows", "install-rollback.ps1");
  const destination = join(payload, relative);
  mkdirSync(join(payload, "apps", "server", "scripts", "windows"), { recursive: true });
  const contents = readFileSync(join(scriptsDirectory, "install-rollback.ps1"));
  writeFileSync(destination, contents);
  return {
    path: relative,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Windows Server installer packaging", () => {
  it("plans a separate installer without writing output or modifying the client installer", () => {
    const output = join(createSandbox(), "candidate");
    const result = runPowerShell(buildScript, [
      "-ProjectRoot", projectRoot,
      "-OutputDirectory", output,
      "-PlanOnly",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Business Billing Server_0.1.0_x64-setup.exe");
    expect(result.stdout).toContain("OpenJS Foundation");
    expect(result.stdout).toContain("separate, operator-installed official PostgreSQL prerequisite");
    expect(result.stdout).toContain('"databaseChanges":false');
    expect(result.stdout).not.toContain("password");
  });

  it("fails packaging when the backend build entrypoint is missing", () => {
    const root = createSandbox();
    const result = runPowerShell(buildScript, [
      "-ProjectRoot", root,
      "-OutputDirectory", join(root, "candidate"),
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("apps/server/dist/src/index.js is missing");
  });

  it("preserves backend entrypoint and Windows-script directory structure in payload staging", () => {
    const source = readFileSync(buildScript, "utf8").replace(/\r\n/g, "\n");
    const distParent = source.indexOf("Join-Path $stage 'apps\\server\\dist'");
    const distCopy = source.indexOf("Join-Path $server 'dist\\src'");
    const scriptsParent = source.indexOf("Join-Path $stage 'apps\\server\\scripts'");
    const scriptsCopy = source.indexOf("Join-Path $server 'scripts\\windows'");

    expect(distParent).toBeGreaterThanOrEqual(0);
    expect(distParent).toBeLessThan(distCopy);
    expect(scriptsParent).toBeGreaterThanOrEqual(0);
    expect(scriptsParent).toBeLessThan(scriptsCopy);
    expect(source).toContain("apps\\server\\dist\\src\\index.js");
    expect(source).toContain("apps\\server\\scripts\\windows\\install-server.ps1");
  });

  it("captures installer stdout, stderr, exit status, and failing stage without logging secrets", () => {
    const root = createSandbox();
    const fakeInstaller = join(root, "fake-installer.ps1");
    const diagnosticLog = join(root, "setup.log");
    writeFileSync(fakeInstaller, [
      "$global:BillingInstallStage = 'configure-backend-startup'",
      "Write-Output 'safe installer stdout'",
      "Write-Output ([string]::Concat('connection=postgres', '://user:fixture-value@localhost/billing'))",
      "Write-Error ([string]::Concat('PASS', 'WORD=fixture-value DATABASE_URL=postgres', '://user:fixture-value@localhost/billing')) -ErrorAction Continue",
      "throw 'injected startup failure'",
    ].join("\r\n"));

    const result = runPowerShell(diagnosticRunner, [
      "-InstallerScript", fakeInstaller,
      "-DiagnosticLog", diagnosticLog,
      "-PayloadRoot", join(root, "payload"),
      "-ServerRoot", join(root, "server"),
    ]);

    const log = readFileSync(diagnosticLog, "utf8");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BILLING_INSTALL_STAGE=configure-backend-startup");
    expect(log).toContain("safe installer stdout");
    expect(log).toContain("--- stderr ---");
    expect(log).toContain("exit_code=1");
    expect(log).toContain("stage=configure-backend-startup");
    expect(log).toContain("injected startup failure");
    expect(log).not.toContain("fixture-value");
    expect(log).toContain("<redacted-connection-string>");
  });

  it("captures successful installer output and exits with code zero", () => {
    const root = createSandbox();
    const fakeInstaller = join(root, "fake-installer.ps1");
    const diagnosticLog = join(root, "setup.log");
    writeFileSync(fakeInstaller, [
      "$global:BillingInstallStage = 'configure-backend-startup'",
      "Write-Output 'installation completed'",
    ].join("\r\n"));

    const result = runPowerShell(diagnosticRunner, [
      "-InstallerScript", fakeInstaller,
      "-DiagnosticLog", diagnosticLog,
      "-PayloadRoot", join(root, "payload"),
      "-ServerRoot", join(root, "server"),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BILLING_INSTALL_STAGE=complete");
    expect(readFileSync(diagnosticLog, "utf8")).toContain("installation completed");
    expect(readFileSync(diagnosticLog, "utf8")).toContain("exit_code=0");
  });

  it("refuses installation when secure pre-created server configuration is absent", () => {
    const root = createSandbox();
    const payload = join(root, "payload");
    const serverRoot = join(root, "server");
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "server-payload-manifest.json"), JSON.stringify({
      version: 1,
      files: [{ path: "apps/server/dist/src/index.js", sha256: createHash("sha256").update("test").digest("hex") }],
    }));
    mkdirSync(serverRoot, { recursive: true });
    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("A protected server configuration file is required");
    expect(result.stderr + result.stdout).not.toContain("test-secret");
  });

  it("fails safely when the payload manifest is missing", () => {
    const root = createSandbox();
    const payload = join(root, "payload");
    const serverRoot = join(root, "server");
    mkdirSync(payload, { recursive: true });
    mkdirSync(serverRoot, { recursive: true });

    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("The server payload manifest is missing");
    expect(() => accessSync(join(serverRoot, "server-payload-manifest.json"))).toThrow();
  });

  it("fails safely when the supplied payload root is incorrect", () => {
    const root = createSandbox();
    const payload = join(root, "wrong-payload-root");
    const serverRoot = join(root, "server");
    mkdirSync(payload, { recursive: true });
    mkdirSync(serverRoot, { recursive: true });

    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("The server payload manifest is missing");
    expect(() => accessSync(join(serverRoot, "apps"))).toThrow();
  });

  it("rejects a manifest that references a missing packaged file", () => {
    const root = createSandbox();
    const payload = join(root, "payload");
    const serverRoot = join(root, "server");
    const relative = join("apps", "server", "dist", "src", "index.js");
    mkdirSync(payload, { recursive: true });
    mkdirSync(serverRoot, { recursive: true });
    writeFileSync(join(serverRoot, ".env"), "DATABASE_URL=fixture-only");
    const acl = protectEnvironmentFile(join(serverRoot, ".env"));
    expect(acl.status).toBe(0);
    const rollbackSupport = addRollbackSupport(payload);
    writeFileSync(join(payload, "server-payload-manifest.json"), JSON.stringify({
      version: 1,
      files: [
        { path: relative, sha256: createHash("sha256").update("missing-file").digest("hex") },
        rollbackSupport,
      ],
    }));

    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("A packaged server file is missing");
    expect(() => accessSync(join(serverRoot, relative))).toThrow();
    expect(readFileSync(join(serverRoot, ".env"), "utf8")).toContain("DATABASE_URL");
  });

  it("plans payload integrity without copying files or making database changes", () => {
    const root = createSandbox();
    const payload = join(root, "payload");
    const serverRoot = join(root, "server");
    const relative = join("apps", "server", "dist", "src", "index.js");
    const contents = "fixture entrypoint";
    mkdirSync(join(payload, "apps", "server", "dist", "src"), { recursive: true });
    mkdirSync(serverRoot, { recursive: true });
    writeFileSync(join(payload, relative), contents);
    const rollbackSupport = addRollbackSupport(payload);
    writeFileSync(join(payload, "server-payload-manifest.json"), JSON.stringify({
      version: 1,
      files: [
        { path: relative, sha256: createHash("sha256").update(contents).digest("hex") },
        rollbackSupport,
      ],
    }));
    writeFileSync(join(serverRoot, ".env"), "DATABASE_URL=provided-outside-installer");
    const acl = protectEnvironmentFile(join(serverRoot, ".env"));
    expect(acl.status).toBe(0);

    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"packagedFiles":2');
    expect(result.stdout).toContain('"migrations":"not applied"');
    expect(result.stdout).not.toContain("provided-outside-installer");
    expect(() => accessSync(join(serverRoot, relative))).toThrow();
  });

  it("rejects a tampered payload before copying any file", () => {
    const root = createSandbox();
    const payload = join(root, "payload");
    const serverRoot = join(root, "server");
    const relative = join("apps", "server", "dist", "src", "index.js");
    mkdirSync(join(payload, "apps", "server", "dist", "src"), { recursive: true });
    mkdirSync(serverRoot, { recursive: true });
    writeFileSync(join(payload, relative), "changed after packaging");
    const rollbackSupport = addRollbackSupport(payload);
    writeFileSync(join(payload, "server-payload-manifest.json"), JSON.stringify({
      version: 1,
      files: [{ path: relative, sha256: "0".repeat(64) }, rollbackSupport],
    }));
    writeFileSync(join(serverRoot, ".env"), "DATABASE_URL=provided-outside-installer");
    const acl = protectEnvironmentFile(join(serverRoot, ".env"));
    expect(acl.status).toBe(0);

    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("failed its integrity check");
    expect(() => accessSync(join(serverRoot, relative))).toThrow();
    expect(readFileSync(join(serverRoot, ".env"), "utf8")).toContain("DATABASE_URL");
  });

  it("initializes the NSIS plugin directory, verifies extraction, and never reports failed installation as success", () => {
    const source = readFileSync(installerNsi, "utf8").replace(/\r\n/g, "\n");
    const section = source.slice(source.indexOf('Section "Install server"'), source.indexOf('Section "Uninstall"'));

    expect(section.indexOf("InitPluginsDir")).toBeGreaterThanOrEqual(0);
    expect(section.indexOf("InitPluginsDir")).toBeLessThan(section.indexOf('SetOutPath "$PLUGINSDIR\\billing-server-payload"'));
    expect(section).toContain('File /r "${PAYLOAD_DIR}\\*.*"');
    expect(section).toContain('IfFileExists "$PLUGINSDIR\\billing-server-payload\\server-payload-manifest.json"');
    expect(section).toContain('-PayloadRoot "$PLUGINSDIR\\billing-server-payload"');
    expect(section).toContain("run-server-install.ps1");
    expect(section).toContain("nsExec::ExecToStack");
    expect(section).toContain("Pop $0");
    expect(section).toContain("Pop $1");
    expect(section).toContain("SetErrorLevel $0");
    expect(section).toContain('FileWrite $3 "stage=PowerShell script execution; exit_code=$0$');
    expect(section).toContain('FileWrite $3 "PowerShell output (stdout/stderr):$');
    expect(section).toContain("scripts are disabled");
    expect(section).toContain("trusted publisher certificate");
    expect(section).toContain("Do not disable or bypass policy");
    expect(section).toContain('GetTempFileName $2 "$TEMP"');
    expect(section).toContain('IfFileExists "$INSTDIR\\apps\\server\\dist\\src\\index.js"');
    expect(section).toContain('IfFileExists "$INSTDIR\\uninstall.exe"');
    expect(section).toContain('ReadRegStr $1 HKLM "${UNINSTALL_KEY}" "DisplayName"');
    expect(section).toContain('StrCmp $1 "Business Billing Server" installation_succeeded post_install_verification_failed');
    expect(section).toContain('StrCmp $0 "0" installation_script_succeeded');
    expect(section).toMatch(/SetErrorLevel \$0\n\s+MessageBox MB_ICONSTOP/);
    expect(section).toMatch(/post_install_verification_failed:\n\s+SetErrorLevel 1\n\s+MessageBox MB_ICONSTOP[\s\S]*?\n\s+Quit/);
    expect(section).toMatch(/extraction_failed:\n\s+SetErrorLevel 1\n\s+MessageBox MB_ICONSTOP[\s\S]*?\n\s+Quit/);
    expect(section).not.toContain("Abort");

    const failureBranches = section.split("Quit").length - 1;
    expect(failureBranches).toBe(4);
    expect(section).toContain("installation_succeeded:\nSectionEnd");
  });

  it("refuses manifests that target configuration or other data paths", () => {
    const root = createSandbox();
    const payload = join(root, "payload");
    const serverRoot = join(root, "server");
    mkdirSync(payload, { recursive: true });
    mkdirSync(serverRoot, { recursive: true });
    writeFileSync(join(serverRoot, ".env"), "DATABASE_URL=provided-outside-installer");
    const acl = protectEnvironmentFile(join(serverRoot, ".env"));
    expect(acl.status).toBe(0);
    const rollbackSupport = addRollbackSupport(payload);
    writeFileSync(join(payload, "server-payload-manifest.json"), JSON.stringify({
      version: 1,
      files: [
        rollbackSupport,
        { path: ".env", sha256: createHash("sha256").update("replacement").digest("hex") },
      ],
    }));

    const result = runPowerShell(installScript, [
      "-PayloadRoot", payload,
      "-ServerRoot", serverRoot,
      "-PlanOnly",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("outside the application-owned directories");
    expect(readFileSync(join(serverRoot, ".env"), "utf8")).toContain("provided-outside-installer");
  });

  it("limits uninstall to the payload manifest and preserves database data", () => {
    const uninstaller = readFileSync(uninstallScript, "utf8");
    expect(uninstaller).toContain("Unregister-ScheduledTask");
    expect(uninstaller).toContain("Remove-NetFirewallRule");
    expect(uninstaller).not.toMatch(/(dropdb|DROP\s+DATABASE|Remove-Item.+\\.env)/i);
    expect(uninstaller).toContain("PostgreSQL, databases, configuration, backups, logs, and user data were preserved");
  });

  it("does not bypass PowerShell execution policy in install, uninstall, task, or build commands", () => {
    const sources = [
      readFileSync(installerNsi, "utf8"),
      readFileSync(diagnosticRunner, "utf8"),
      readFileSync(installScript, "utf8"),
      readFileSync(setupScript, "utf8"),
      readFileSync(uninstallScript, "utf8"),
      readFileSync(join(scriptsDirectory, "install-rollback.ps1"), "utf8"),
      readFileSync(join(scriptsDirectory, "tls-security.ps1"), "utf8"),
      readFileSync(join(scriptsDirectory, "start-backend.ps1"), "utf8"),
      readFileSync(join(scriptsDirectory, "build-server-installer.ps1"), "utf8"),
      readFileSync(join(projectRoot, "apps", "server", "package.json"), "utf8"),
      readFileSync(join(projectRoot, "apps", "server", "test", "windowsInstaller.test.ts"), "utf8"),
      readFileSync(join(projectRoot, "apps", "server", "test", "windowsProvisioning.test.ts"), "utf8"),
    ].join("\n");
    expect(sources).not.toMatch(/"-ExecutionPolicy"\s*,\s*"Bypass"/i);
    expect(sources).not.toMatch(/-ExecutionPolicy\s+Bypass/i);
    expect(sources).toContain("have your administrator review the policy");
    expect(sources).toContain("This installer does not change policy.");
    expect(sources).toContain("This uninstaller does not change policy.");
    expect(sources).not.toMatch(/-ExecutionPolicy\s+(?:Bypass|Unrestricted)/i);
  });

  it("documents trusted signing requirements for every PowerShell execution path", () => {
    const operationsReadme = readFileSync(join(scriptsDirectory, "README.md"), "utf8");
    const normalizedReadme = operationsReadme.replace(/\s+/g, " ");
    for (const script of [
      "run-server-install.ps1",
      "install-server.ps1",
      "setup-server.ps1",
      "install-rollback.ps1",
      "tls-security.ps1",
      "start-backend.ps1",
      "uninstall-server.ps1",
    ]) {
      expect(operationsReadme).toContain(script);
    }
    expect(normalizedReadme).toContain("legitimate publisher code-signing certificate");
    expect(normalizedReadme).toContain("does not override");
    expect(normalizedReadme).toContain("Restricted");
  });

  it("restores ACLs and created directories after failure at each setup stage", () => {
    const root = createSandbox();
    const result = runPowerShell(rollbackFixture, ["-Root", root]);

    expect(result.status).toBe(0);
    for (const stage of [
      "log-directory-created",
      "root-acl-changed",
      "environment-acl-changed",
      "log-directory-acl-changed",
      "tls-key-acl-changed",
      "scheduled-task-created",
      "firewall-rule-created",
      "scheduled-task-started",
    ]) {
      expect(result.stdout).toContain(`PASS ${stage}`);
    }
    expect(result.stderr + result.stdout).toContain("injected task cleanup failure");
    expect(result.stdout).toContain("TLS_ACL_ROLLBACK_DIAGNOSTIC");
    expect(result.stdout).toContain("injected TLS ACL restore failure");

    const installerSource = readFileSync(installScript, "utf8");
    expect(installerSource).toContain("$global:BillingInstallFailureStage = [string]$global:BillingInstallStage");
    expect(installerSource).toContain("Invoke-BillingInstallRollback");
  });

  it.each([
    ["secure", "PASS secure"],
    ["broad", "PASS broad-rejected"],
    ["unresolved", "PASS unresolved-identity-rejected"],
    ["inspection-failure", "PASS inspection-failure"],
    ["service-write", "PASS service-write-rejected"],
    ["unsafe-path", "PASS unsafe-path-rejected"],
  ])("validates TLS private-key ACLs (%s)", (scenario, expected) => {
    const result = runPowerShell(tlsAclFixture, ["-Scenario", scenario]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
  });

  it("rejects invalid TLS certificate material without printing file contents", () => {
    const root = createSandbox();
    const result = runPowerShell(tlsAclFixture, ["-Scenario", "certificate-invalid", "-Root", root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS invalid-certificate-rejected");
    expect(result.stdout + result.stderr).not.toContain("not a certificate");
    expect(result.stdout + result.stderr).not.toContain("not a key");
  });
});

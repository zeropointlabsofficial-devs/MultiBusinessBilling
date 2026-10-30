import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const powershell = "powershell.exe";
const setupScript = new URL("../scripts/windows/setup-server.ps1", import.meta.url);
const databaseScript = new URL("../scripts/windows/provision-database.ps1", import.meta.url);
const backupScript = new URL("../scripts/windows/backup-database.ps1", import.meta.url);
const restoreScript = new URL("../scripts/windows/restore-database.ps1", import.meta.url);
const startBackendScript = new URL("../scripts/windows/start-backend.ps1", import.meta.url);
const sandboxes: string[] = [];

function createSandbox() {
  const path = mkdtempSync(join(tmpdir(), "billing-provisioning-"));
  sandboxes.push(path);
  return path;
}

function runPowerShell(script: URL, args: string[]) {
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    script.pathname.replace(/^\//, "").replaceAll("/", "\\"),
    ...args,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Windows provisioning safety plans", () => {
  it("plans a dedicated local-only server without querying or changing host services", () => {
    const root = createSandbox();
    mkdirSync(join(root, "apps", "server", "dist", "src"), { recursive: true });
    writeFileSync(join(root, ".env"), [
      "DATABASE_URL=postgresql://billing_app:dummy@127.0.0.1:55432/billing",
      "HOST=127.0.0.1",
      "PORT=4317",
    ].join("\n"));
    writeFileSync(join(root, "apps", "server", "dist", "src", "index.js"), "// fixture");

    const result = runPowerShell(setupScript, ["-ServerRoot", root, "-PlanOnly"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MultiBusinessBillingPostgreSQL");
    expect(result.stdout).toContain("not queried in plan mode");
    expect(result.stdout).toContain("PostgreSQL remains local-only");
    expect(result.stdout).toContain("Not applied by this script");
    expect(result.stdout).toContain("retries up to 5 times");
    expect(result.stdout).not.toContain("dummy");
  });

  it("plans least-privilege role/database creation without writing a database", () => {
    const root = createSandbox();
    const result = runPowerShell(databaseScript, [
      "-ServerRoot", root,
      "-DatabaseName", "billing_sandbox",
      "-PlanOnly",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("billing_migrator");
    expect(result.stdout).toContain("billing_app");
    expect(result.stdout).toContain('"writesDatabase":false');
    expect(result.stdout).toContain('"migrationsApplied":false');
    expect(result.stdout).not.toContain("dummy");
  });

  it("refuses LAN binding without both TLS files", () => {
    const root = createSandbox();
    mkdirSync(join(root, "apps", "server", "dist", "src"), { recursive: true });
    writeFileSync(join(root, ".env"), [
      "DATABASE_URL=postgresql://billing_app:dummy@127.0.0.1:55432/billing",
      "HOST=192.168.10.20",
      "PORT=4317",
    ].join("\n"));
    writeFileSync(join(root, "apps", "server", "dist", "src", "index.js"), "// fixture");

    const result = runPowerShell(setupScript, ["-ServerRoot", root, "-PlanOnly"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("LAN binding requires TLS_CERT_PATH and TLS_KEY_PATH");
    expect(result.stderr + result.stdout).not.toContain("dummy");
  });

  it("plans a TLS SAN name separately from a wildcard LAN bind", () => {
    const root = createSandbox();
    const certificate = join(root, "fixture.crt");
    const privateKey = join(root, "fixture.key");
    writeFileSync(certificate, "temporary certificate fixture");
    writeFileSync(privateKey, "temporary key fixture");

    const rejected = runPowerShell(databaseScript, [
      "-ServerRoot", join(root, "server"),
      "-ServerHost", "0.0.0.0",
      "-TlsCertificatePath", certificate,
      "-TlsPrivateKeyPath", privateKey,
      "-PlanOnly",
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr + rejected.stdout).toContain("TLS_SERVER_NAME must be a concrete");

    const planned = runPowerShell(databaseScript, [
      "-ServerRoot", join(root, "server"),
      "-ServerHost", "0.0.0.0",
      "-TlsCertificatePath", certificate,
      "-TlsPrivateKeyPath", privateKey,
      "-TlsServerName", "billing.example.test",
      "-PlanOnly",
    ]);
    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain('"tlsServerName":"billing.example.test"');
    expect(planned.stdout).toContain('"writesDatabase":false');
  });

  it("fails safely when backend startup has no compiled entrypoint", () => {
    const root = createSandbox();
    const result = runPowerShell(startBackendScript, ["-ServerRoot", root]);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("compiled backend entrypoint is missing");
  });

  it("plans a custom-format backup without database access or writes", () => {
    const root = createSandbox();
    const result = runPowerShell(backupScript, ["-BackupDirectory", join(root, "backups"), "-PlanOnly"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("custom-format PostgreSQL backup");
    expect(result.stdout).toContain("pg_restore --list and SHA-256 sidecar");
    expect(result.stdout).toContain('"writesDatabase":false');
  });

  it("requires a valid checksum and plans restore only into a new database", () => {
    const root = createSandbox();
    const archive = join(root, "sandbox.dump");
    const contents = "sandbox archive placeholder";
    writeFileSync(archive, contents);
    const digest = createHash("sha256").update(contents).digest("hex");
    writeFileSync(`${archive}.sha256`, `${digest}  sandbox.dump`);

    const result = runPowerShell(restoreScript, [
      "-BackupFile", archive,
      "-TargetDatabaseName", "restore_sandbox",
      "-PlanOnly",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"overwrite":false');
    expect(result.stdout).toContain('"databaseWrites":false');
    expect(result.stdout).not.toContain("DATABASE_URL");

    writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  sandbox.dump`);
    const rejected = runPowerShell(restoreScript, [
      "-BackupFile", archive,
      "-TargetDatabaseName", "restore_sandbox",
      "-PlanOnly",
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr + rejected.stdout).toContain("backup checksum is invalid");
  });
});

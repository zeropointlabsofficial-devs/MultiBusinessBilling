import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    pairingInvitation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    pairedDevice: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
      pairedDevice: { findUnique: vi.fn(), updateMany: vi.fn() },
    },
  };
});

vi.mock("../src/db.js", () => ({ prisma: mocks.prisma }));

import {
  approvePairedDevice,
  createPairingInvitation,
  pollDevicePairing,
  requestDevicePairing,
  revokePairedDevice,
  verifyPairedDevice,
} from "../src/pairing.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const credential = "A".repeat(43);
const pollToken = "B".repeat(43);
const invitationCode = "C".repeat(32);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("device pairing service", () => {
  it("creates a short-lived invitation and stores only its hash", async () => {
    mocks.tx.pairingInvitation.create.mockResolvedValue({ id: uuid });
    mocks.tx.auditLog.create.mockResolvedValue({});

    const result = await createPairingInvitation(uuid, deviceId);

    expect(result.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(result.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(mocks.tx.pairingInvitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessId: uuid,
        createdById: deviceId,
        tokenHash: digest(result.code),
      }),
      select: { id: true },
    });
    expect(JSON.stringify(mocks.tx.auditLog.create.mock.calls)).not.toContain(result.code);
  });

  it("rejects invalid and expired invitations", async () => {
    mocks.tx.pairingInvitation.findUnique.mockResolvedValue(null);
    await expect(requestDevicePairing({
      invitationCode, deviceId, deviceName: "Front desk", deviceCredential: credential, pollToken,
    })).rejects.toMatchObject({ statusCode: 400 });

    mocks.tx.pairingInvitation.findUnique.mockResolvedValue({
      id: uuid, businessId: uuid, redeemedAt: null, expiresAt: new Date(0),
    });
    await expect(requestDevicePairing({
      invitationCode, deviceId, deviceName: "Front desk", deviceCredential: credential, pollToken,
    })).rejects.toMatchObject({ statusCode: 410 });
    expect(mocks.tx.pairingInvitation.updateMany).not.toHaveBeenCalled();
  });

  it("atomically redeems a valid invitation and stores only credential hashes", async () => {
    mocks.tx.pairingInvitation.findUnique.mockResolvedValue({
      id: uuid, businessId: uuid, redeemedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.tx.pairingInvitation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.pairedDevice.create.mockResolvedValue({ deviceId, businessId: uuid, status: "PENDING" });
    mocks.tx.auditLog.create.mockResolvedValue({});

    await requestDevicePairing({
      invitationCode, deviceId, deviceName: "Front desk", deviceCredential: credential, pollToken,
    });

    expect(mocks.tx.pairingInvitation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: uuid, redeemedAt: null, expiresAt: expect.any(Object) }),
      data: { redeemedAt: expect.any(Date), redeemedDeviceId: deviceId },
    });
    expect(mocks.tx.pairedDevice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessId: uuid,
        credentialHash: digest(credential),
        pollTokenHash: digest(pollToken),
      }),
      select: { deviceId: true, businessId: true, status: true },
    });
    expect(JSON.stringify(mocks.tx.auditLog.create.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(mocks.tx.auditLog.create.mock.calls)).not.toContain(pollToken);
  });

  it("allows only exact retries after redemption and rejects reuse by another device", async () => {
    mocks.tx.pairingInvitation.findUnique.mockResolvedValue({
      id: uuid, businessId: uuid, redeemedAt: new Date(), redeemedDeviceId: deviceId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.tx.pairedDevice.findUnique.mockResolvedValue({
      deviceId, businessId: uuid, status: "PENDING",
      credentialHash: digest(credential), pollTokenHash: digest(pollToken),
    });

    await expect(requestDevicePairing({
      invitationCode, deviceId, deviceName: "Front desk", deviceCredential: credential, pollToken,
    })).resolves.toMatchObject({ deviceId, status: "PENDING" });
    await expect(requestDevicePairing({
      invitationCode, deviceId: uuid, deviceName: "Other", deviceCredential: credential, pollToken,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.tx.pairingInvitation.updateMany).not.toHaveBeenCalled();
  });

  it("does not report concurrent invitation claims as successful reuse", async () => {
    mocks.tx.pairingInvitation.findUnique.mockResolvedValue({
      id: uuid, businessId: uuid, redeemedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.tx.pairingInvitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(requestDevicePairing({
      invitationCode, deviceId, deviceName: "Front desk", deviceCredential: credential, pollToken,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not expose pairing status to a caller without the polling secret", async () => {
    mocks.prisma.pairedDevice.findUnique.mockResolvedValue({
      status: "PENDING", pollTokenHash: digest(pollToken), pairingExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(pollDevicePairing(deviceId, "D".repeat(43)))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(pollDevicePairing(deviceId, pollToken)).resolves.toEqual({ status: "pending" });
  });

  it("rejects polling and approval after the pairing window expires", async () => {
    mocks.prisma.pairedDevice.findUnique.mockResolvedValue({
      status: "PENDING", pollTokenHash: digest(pollToken), pairingExpiresAt: new Date(0),
    });
    await expect(pollDevicePairing(deviceId, pollToken))
      .rejects.toMatchObject({ statusCode: 410 });

    mocks.tx.pairedDevice.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.pairedDevice.findFirst.mockResolvedValue({
      status: "PENDING", pairingExpiresAt: new Date(0),
    });
    await expect(approvePairedDevice(deviceId, uuid, uuid))
      .rejects.toMatchObject({ statusCode: 410 });
  });

  it("approves and revokes only devices in the administrator's business", async () => {
    mocks.tx.pairedDevice.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.auditLog.create.mockResolvedValue({});
    await expect(approvePairedDevice(deviceId, uuid, uuid))
      .resolves.toEqual({ deviceId, status: "approved" });
    expect(mocks.tx.pairedDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deviceId, businessId: uuid, status: "PENDING" }),
      data: expect.objectContaining({ status: "APPROVED", approvedById: uuid }),
    }));

    mocks.tx.pairedDevice.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.pairedDevice.findFirst.mockResolvedValue(null);
    await expect(approvePairedDevice(deviceId, "00000000-0000-4000-8000-000000000003", uuid))
      .rejects.toMatchObject({ statusCode: 404 });

    mocks.tx.pairedDevice.updateMany.mockResolvedValue({ count: 1 });
    await expect(revokePairedDevice(deviceId, uuid, uuid))
      .resolves.toEqual({ deviceId, status: "revoked" });
  });

  it("requires approval, matching business scope, and an unchanged credential", async () => {
    mocks.prisma.pairedDevice.findUnique.mockResolvedValue({
      businessId: uuid, credentialHash: digest(credential), status: "APPROVED", lastSeenAt: new Date(),
    });
    await expect(verifyPairedDevice(deviceId, credential, uuid)).resolves.toBe(true);
    await expect(verifyPairedDevice(deviceId, credential, "00000000-0000-4000-8000-000000000003"))
      .resolves.toBe(false);
    mocks.prisma.pairedDevice.findUnique.mockResolvedValue({
      businessId: uuid, credentialHash: digest(credential), status: "REVOKED", lastSeenAt: new Date(),
    });
    await expect(verifyPairedDevice(deviceId, credential, uuid)).resolves.toBe(false);
  });
});

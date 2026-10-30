import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { userSession: { findUnique: vi.fn() } },
  verifyPairedDevice: vi.fn(),
}));

vi.mock("../src/db.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/pairing.js", () => ({ verifyPairedDevice: mocks.verifyPairedDevice }));

import { authenticate, requireRole, requireTrustedPairingAdministrator, Role } from "../src/auth.js";

function responseMock() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as unknown as Response & typeof response;
}

describe("pairing administration authorization", () => {
  it("denies a revoked device even when its user's session remains valid", async () => {
    const businessId = "00000000-0000-4000-8000-000000000002";
    const credential = "B".repeat(43);
    const req = {
      header: (name: string) => ({
        authorization: `Bearer ${"A".repeat(43)}`,
        "x-business-id": businessId,
        "x-device-id": "00000000-0000-4000-8000-000000000004",
        "x-device-credential": credential,
      }[name.toLowerCase()]),
    } as unknown as Request;
    const res = responseMock();
    const next = vi.fn();
    mocks.prisma.userSession.findUnique.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000003",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        isActive: true,
        memberships: [{ role: Role.BILLING_OPERATOR, business: { isActive: true } }],
      },
    });
    mocks.verifyPairedDevice.mockResolvedValue(false);

    await authenticate(req, res, next);

    expect(mocks.verifyPairedDevice).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000004",
      credential,
      businessId,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies an unpaired remote administrator from approving a client on itself", async () => {
    const req = {
      socket: { remoteAddress: "192.168.1.44" },
      header: vi.fn(() => undefined),
      auth: {
        actorId: "00000000-0000-4000-8000-000000000001",
        businessId: "00000000-0000-4000-8000-000000000002",
        role: Role.BUSINESS_ADMIN,
        sessionId: "00000000-0000-4000-8000-000000000003",
      },
    } as unknown as Request;
    const res = responseMock();
    const next = vi.fn();

    await requireTrustedPairingAdministrator(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the local server computer to administer pairing", async () => {
    const req = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      header: vi.fn(() => undefined),
      auth: {
        actorId: "00000000-0000-4000-8000-000000000001",
        businessId: "00000000-0000-4000-8000-000000000002",
        role: Role.BUSINESS_ADMIN,
        sessionId: "00000000-0000-4000-8000-000000000003",
      },
    } as unknown as Request;
    const res = responseMock();
    const next = vi.fn();

    await requireTrustedPairingAdministrator(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does not grant business-administrator permissions to viewers", () => {
    const req = { auth: { role: Role.VIEWER } } as unknown as Request;
    const res = responseMock();
    const next = vi.fn();

    requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

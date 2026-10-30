import type { Role } from "./generated/prisma/enums.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        actorId: string;
        businessId: string;
        role: Role;
        sessionId: string;
        deviceId?: string;
      };
    }
  }
}

export {};

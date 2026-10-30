import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-device-credential",
      "req.headers.x-pairing-poll-token",
      "req.body.invitationCode",
      "req.body.deviceCredential",
      "req.body.pollToken",
      "res.headers.set-cookie",
    ],
    censor: "[REDACTED]",
  },
});

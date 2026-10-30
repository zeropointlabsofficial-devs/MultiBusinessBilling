import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { ApiError } from "./errors.js";
import { logger } from "./logging.js";
import { router } from "./routes.js";

export function createApp(sessionTtlHours: number) {
  const app = express();
  app.locals.sessionTtlHours = sessionTtlHours;
  app.disable("x-powered-by");
  app.use(pinoHttp({ logger }));
  const desktopOrigins = new Set([
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
  ]);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || desktopOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Request origin is not permitted."));
    },
    methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Business-Id",
      "X-Device-Id",
      "X-Device-Credential",
      "X-Pairing-Poll-Token",
    ],
  }));
  app.use(helmet());
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/auth/login", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many login attempts. Try again later." },
  }));
  app.use("/api/pairing/request", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many pairing attempts. Try again later." },
  }));
  app.use("/api/pairing/invitations", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many invitation requests. Try again later." },
  }));
  app.use("/api", router);
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: "Request body contains invalid JSON." });
      return;
    }
    logger.error({ err: error }, "Unhandled API error");
    if (res.headersSent) return;
    res.status(500).json({ error: "An unexpected server error occurred." });
  };
  app.use(errors);
  return app;
}

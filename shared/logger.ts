/**
 * Structured logger — replaces ad-hoc console.log for lifecycle/error/request
 * logging. JSON output in production (parseable by log aggregators), pretty
 * output in dev. Level configurable via LOG_LEVEL (default "info").
 */
import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "igfxpro-apiv2" },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProd
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
});

export default logger;

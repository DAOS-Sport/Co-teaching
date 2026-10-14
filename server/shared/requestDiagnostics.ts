import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";

// Transport metadata only. Payloads, query strings, headers and resource IDs stay out.
export function createRequestDiagnostics(write: (line: string) => void): RequestHandler {
  return (req, res, next) => {
    if (!/^\/api(?:\/|$)/i.test(req.path)) { next(); return; }
    const requestId = randomUUID();
    const started = Date.now();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    res.on("finish", () => {
      const route = typeof req.route?.path === "string" ? req.route.path : "UNMATCHED_API";
      const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(req.method) ? req.method : "OTHER";
      write(JSON.stringify({ requestId, method, route, status: res.statusCode,
        durationMs: Math.max(0, Date.now() - started),
        code: res.statusCode >= 500 ? "REQUEST_FAILED" : undefined }));
    });
    next();
  };
}

export function createSafeErrorHandler(): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const candidate = error?.status || error?.statusCode;
    const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
    const requestId = res.locals.requestId || randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    res.status(status).json({
      message: status >= 500 ? "系統暫時無法完成請求" :
        typeof error?.message === "string" ? error.message : "請求無法完成",
      code: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED",
      requestId,
    });
  };
}

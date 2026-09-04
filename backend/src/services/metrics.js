import client from "prom-client";

const { Registry, Histogram, collectDefaultMetrics } = client;

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["route", "method", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry]
});

function routeLabel(req) {
  const routePath = req.route?.path;
  if (typeof routePath !== "string") return "unmatched";
  return `${req.baseUrl || ""}${routePath}` || "/";
}

export function metricsMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    httpRequestDuration.observe(
      { route: routeLabel(req), method: req.method, status_code: String(res.statusCode) },
      durationSeconds
    );
  });
  next();
}

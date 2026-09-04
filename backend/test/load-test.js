import "../src/config/env.js";
import { Agent } from "undici";

const DEFAULT_BASE_URL = process.env.LOAD_TEST_BASE_URL || process.env.BASE_URL || "http://localhost:4000";
const DEFAULT_ENDPOINT = process.env.LOAD_TEST_ENDPOINT || "/api/site/pages/tips";
const DEFAULT_CONCURRENCY = 100;
const DEFAULT_WARMUP_REQUESTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STUDENT_LIMIT = 100;
const FALLBACK_STUDENT_CODE = "A-1001";

function printHelp() {
  console.log(`
Usage: npm run test:load -- [options]

Runs a read-only HTTP benchmark. The default target is the public tips page:
GET /api/site/pages/tips

Options:
  --base-url <url>          Backend origin (default: ${DEFAULT_BASE_URL})
  --endpoint <path|url>    GET path or absolute URL (default: ${DEFAULT_ENDPOINT})
  --concurrency <number>   Measured concurrent requests (default: ${DEFAULT_CONCURRENCY})
  --warmup <number>        Warm-up requests before measurement (default: ${DEFAULT_WARMUP_REQUESTS})
  --timeout-ms <number>    Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --student-codes <codes>  Comma-separated codes for {studentCode} endpoints
  --student-limit <number> Maximum codes to load from the database (default: ${DEFAULT_STUDENT_LIMIT})
  --help                   Show this help

Environment equivalents:
  LOAD_TEST_BASE_URL, LOAD_TEST_ENDPOINT, LOAD_TEST_CONCURRENCY,
  LOAD_TEST_WARMUP, LOAD_TEST_TIMEOUT_MS, LOAD_TEST_STUDENT_CODES

Example:
  LOAD_TEST_BASE_URL=https://api.example.com npm run test:load
  npm run test:load -- --endpoint /api/students/{studentCode} --student-codes A-1001,A-1002
`);
}

function parseInteger(value, optionName, { min = 1, max = 10_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${optionName} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    endpoint: DEFAULT_ENDPOINT,
    concurrency: parseInteger(process.env.LOAD_TEST_CONCURRENCY || DEFAULT_CONCURRENCY, "LOAD_TEST_CONCURRENCY"),
    warmup: parseInteger(process.env.LOAD_TEST_WARMUP || DEFAULT_WARMUP_REQUESTS, "LOAD_TEST_WARMUP", { min: 0 }),
    timeoutMs: parseInteger(process.env.LOAD_TEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, "LOAD_TEST_TIMEOUT_MS", { max: 300_000 }),
    studentCodes: process.env.LOAD_TEST_STUDENT_CODES || "",
    studentLimit: parseInteger(process.env.LOAD_TEST_STUDENT_LIMIT || DEFAULT_STUDENT_LIMIT, "LOAD_TEST_STUDENT_LIMIT")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);

    const separatorIndex = argument.indexOf("=");
    const name = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
    const inlineValue = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);

    if (name === "--base-url") options.baseUrl = value;
    else if (name === "--endpoint") options.endpoint = value;
    else if (name === "--concurrency") options.concurrency = parseInteger(value, "--concurrency");
    else if (name === "--warmup") options.warmup = parseInteger(value, "--warmup", { min: 0 });
    else if (name === "--timeout-ms") options.timeoutMs = parseInteger(value, "--timeout-ms", { max: 300_000 });
    else if (name === "--student-codes" || name === "--student-code") options.studentCodes = value;
    else if (name === "--student-limit") options.studentLimit = parseInteger(value, "--student-limit");
    else throw new Error(`Unknown option: ${name}`);
  }

  return options;
}

function validateHttpUrl(value, optionName) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new Error(`${optionName} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${optionName} must use http:// or https://.`);
  }
  return url;
}

function resolveEndpoint(baseUrl, endpoint) {
  try {
    return validateHttpUrl(endpoint, "--endpoint");
  } catch (error) {
    if (!endpoint.startsWith("/")) throw error;
    return new URL(endpoint, baseUrl);
  }
}

function requiresStudentCode(endpoint) {
  return /:studentCode\b|:student_code\b|:code\b|\{studentCode\}|\{student_code\}|\{code\}/.test(endpoint);
}

function parseStudentCodes(value) {
  return [...new Set(String(value || "").split(",").map((code) => code.trim()).filter(Boolean))];
}

async function loadStudentCodes(limit) {
  let database;
  try {
    database = await import("../src/db/pool.js");
    const result = await database.query(
      `
        SELECT student_code
        FROM students
        WHERE student_code IS NOT NULL
          AND is_active = TRUE
          AND deleted_at IS NULL
        ORDER BY id
        LIMIT $1
      `,
      [limit]
    );
    return result.rows.map((row) => row.student_code).filter(Boolean);
  } finally {
    if (database?.pool) await database.pool.end();
  }
}

async function getStudentCodes(options, endpoint) {
  if (!requiresStudentCode(endpoint)) return [];

  const configuredCodes = parseStudentCodes(options.studentCodes);
  if (configuredCodes.length) return configuredCodes;

  try {
    const databaseCodes = await loadStudentCodes(options.studentLimit);
    if (databaseCodes.length) return databaseCodes;
    console.warn("No active student codes were found; using the seeded test code A-1001.");
  } catch (error) {
    console.warn(`Could not load student codes from the database (${error.message}); using A-1001.`);
  }
  return [FALLBACK_STUDENT_CODE];
}

function makeRequestUrl(endpoint, studentCodes, requestNumber) {
  if (!studentCodes.length) return endpoint;
  const code = encodeURIComponent(studentCodes[requestNumber % studentCodes.length]);
  return endpoint
    .replaceAll("{studentCode}", code)
    .replaceAll("{student_code}", code)
    .replaceAll("{code}", code)
    .replace(/:studentCode\b/g, code)
    .replace(/:student_code\b/g, code)
    .replace(/:code\b/g, code);
}

function createHttpClient({ concurrency, timeoutMs }) {
  const dispatcher = new Agent({
    connections: concurrency,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000
  });

  async function get(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const startedAt = performance.now();

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "abdrabo-load-test/1.0"
        },
        dispatcher,
        signal: controller.signal
      });

      await response.arrayBuffer();
      return {
        status: response.status,
        latencyMs: performance.now() - startedAt
      };
    } catch (error) {
      return {
        status: null,
        latencyMs: performance.now() - startedAt,
        error: error.name === "AbortError" ? `timeout after ${timeoutMs} ms` : error.message
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { get, close: () => dispatcher.close() };
}

function percentile(values, percentileRank) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(percentileRank * sorted.length) - 1);
  return sorted[rank];
}

function formatMs(value) {
  return value === null ? "n/a" : `${value.toFixed(2)} ms`;
}

function summarizeResponses(responses) {
  const statusCounts = new Map();
  for (const response of responses) {
    const key = response.status === null ? "network error" : String(response.status);
    statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
  }
  return {
    successful: responses.filter((response) => response.status === 200).length,
    failed: responses.filter((response) => response.status !== 200).length,
    statusCounts
  };
}

function printSummary({ options, target, warmupResponses, measuredResponses, totalDurationMs }) {
  const allResponses = [...warmupResponses, ...measuredResponses];
  const allSummary = summarizeResponses(allResponses);
  const measuredSummary = summarizeResponses(measuredResponses);
  const latencies = measuredResponses.map((response) => response.latencyMs);
  const average = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
  const statusBreakdown = [...allSummary.statusCounts.entries()].map(([status, count]) => `${status}×${count}`).join(", ");
  const measuredThroughput = totalDurationMs > 0 ? (measuredResponses.length / (totalDurationMs / 1_000)) : null;

  console.log(`
Load test complete
Target: ${target}
Scenario: ${options.warmup} warm-up requests, then ${options.concurrency} concurrent measured requests
Keep-alive connections: enabled (${options.concurrency} max connections)

Total Requests Sent: ${allResponses.length} (${options.warmup} warm-up + ${options.concurrency} measured)
Successful Responses (HTTP 200): ${allSummary.successful}
Failed Responses (HTTP 4xx/5xx or network): ${allSummary.failed}
Warm-up HTTP 200: ${warmupResponses.filter((response) => response.status === 200).length}/${warmupResponses.length}
Status Breakdown: ${statusBreakdown || "none"}

Measured Batch Metrics
Total Execution Time: ${formatMs(totalDurationMs)}
Average Response Time: ${formatMs(average)}
Minimum Latency: ${formatMs(latencies.length ? Math.min(...latencies) : null)}
Maximum Latency: ${formatMs(latencies.length ? Math.max(...latencies) : null)}
p95 Latency: ${formatMs(percentile(latencies, 0.95))}
p99 Latency: ${formatMs(percentile(latencies, 0.99))}
Throughput: ${measuredThroughput === null ? "n/a" : `${measuredThroughput.toFixed(2)} requests/sec`}
`);

  const failures = allResponses.filter((response) => response.status !== 200).slice(0, 5);
  if (failures.length) {
    console.log("Sample failures:");
    for (const failure of failures) {
      console.log(`- ${failure.status === null ? "network error" : `HTTP ${failure.status}`}${failure.error ? `: ${failure.error}` : ""}`);
    }
  }

  return measuredSummary.failed === 0 && allSummary.failed === 0;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const baseUrl = validateHttpUrl(options.baseUrl, "--base-url");
  const endpoint = resolveEndpoint(baseUrl, options.endpoint);
  const endpointTemplate = endpoint.toString();
  const studentCodes = await getStudentCodes(options, endpointTemplate);
  const client = createHttpClient(options);
  let warmupResponses = [];
  let measuredResponses = [];

  try {
    if (options.warmup > 0) {
      warmupResponses = await Promise.all(
        Array.from({ length: options.warmup }, (_, requestNumber) =>
          client.get(makeRequestUrl(endpointTemplate, studentCodes, requestNumber))
        )
      );
    }

    const startedAt = performance.now();
    measuredResponses = await Promise.all(
      Array.from({ length: options.concurrency }, (_, requestNumber) =>
        client.get(makeRequestUrl(endpointTemplate, studentCodes, requestNumber))
      )
    );
    const totalDurationMs = performance.now() - startedAt;
    const passed = printSummary({
      options,
      target: endpointTemplate,
      warmupResponses,
      measuredResponses,
      totalDurationMs
    });
    if (!passed) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`Load test failed: ${error.message}`);
  process.exitCode = 1;
});

import test from "node:test";
import assert from "node:assert/strict";
import { setFinancialCacheHeaders } from "../src/utils/cacheHeaders.js";

test("financial cache middleware disables authenticated financial response caching", () => {
  const headers = {};
  let continued = false;
  setFinancialCacheHeaders({}, { set: (value) => Object.assign(headers, value) }, () => { continued = true; });
  assert.deepEqual(headers, {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0"
  });
  assert.equal(continued, true);
});

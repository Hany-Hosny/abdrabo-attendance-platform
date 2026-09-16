export const FINANCIAL_CACHE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0"
});

export function setFinancialCacheHeaders(_req, res, next) {
  res.set(FINANCIAL_CACHE_HEADERS);
  next();
}

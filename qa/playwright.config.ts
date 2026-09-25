import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "3000";
const baseURL = `http://127.0.0.1:${port}`;
const mobile = (width: number, height: number, deviceScaleFactor = 2) => ({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor });
const desktop = (width: number, height: number) => ({ viewport: { width, height }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

const projects = [
  { name: "iphone-se-3rd-gen", use: mobile(375, 667, 2) },
  { name: "iphone-13-mini", use: mobile(375, 812, 3) },
  { name: "iphone-15", use: mobile(393, 852, 3) },
  { name: "iphone-15-pro-max", use: mobile(430, 932, 3) },
  { name: "iphone-16-pro-max-class", use: mobile(440, 956, 3) },
  { name: "samsung-galaxy-a56", use: mobile(412, 915, 2.625) },
  { name: "samsung-galaxy-s24", use: mobile(360, 780, 3) },
  { name: "google-pixel-8", use: mobile(412, 915, 2.625) },
  { name: "xiaomi-redmi-note-13", use: mobile(393, 873, 2.75) },
  { name: "oneplus-12", use: mobile(450, 1000, 2.625) },
  { name: "ipad-10th-gen", use: mobile(820, 1180, 2) },
  { name: "ipad-air-11", use: mobile(834, 1194, 2) },
  { name: "samsung-galaxy-tab-s9-s10", use: mobile(800, 1280, 2) },
  { name: "generic-narrow-320", use: mobile(320, 640, 2) },
  { name: "desktop-regression", use: desktop(1440, 900) },
  { name: "iphone-15-pro-max-landscape", use: mobile(932, 430, 3) },
  { name: "samsung-galaxy-a56-landscape", use: mobile(915, 412, 2.625) },
  { name: "ipad-10th-gen-landscape", use: mobile(1180, 820, 2) },
  { name: "samsung-galaxy-tab-s9-s10-landscape", use: mobile(1280, 800, 2) }
];

const config: PlaywrightTestConfig = {
  testDir: ".",
  testMatch: "mobile-visual.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "artifacts/report", open: "never" }]],
  use: { baseURL, colorScheme: "dark", locale: "ar-EG", screenshot: "only-on-failure", trace: "retain-on-failure", video: "off" },
  outputDir: "artifacts/test-results",
  webServer: { command: `npm run dev --workspace frontend -- --port ${port}`, cwd: "..", url: baseURL, reuseExistingServer: true, timeout: 120_000 },
  projects
};

export default defineConfig(config);

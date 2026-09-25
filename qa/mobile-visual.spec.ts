import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const publicRoutes = [
  { name: "landing", path: "/" },
  { name: "about-teacher", path: "/about-teacher" },
  { name: "contact", path: "/contact" }
] as const;

const adminPages = [
  { name: "dashboard", path: "/teacher/dashboard?tab=overview" },
  { name: "students", path: "/teacher/dashboard?tab=students" },
  { name: "groups", path: "/teacher/dashboard?tab=groups" },
  { name: "attendance", path: "/teacher/dashboard?tab=attendance" },
  { name: "scanner", path: "/teacher/dashboard?tab=scanner" },
  { name: "fees", path: "/teacher/dashboard?tab=fees" },
  { name: "reports", path: "/teacher/dashboard?tab=reports" },
  { name: "exams", path: "/teacher/dashboard?tab=exams" },
  { name: "messages", path: "/teacher/dashboard?tab=inbox" },
  { name: "users", path: "/teacher/dashboard?tab=users" },
  { name: "settings", path: "/teacher/dashboard?tab=settings" },
  { name: "notifications", path: "/notifications" }
] as const;

const ltrProjects = new Set(["iphone-se-3rd-gen", "iphone-15-pro-max", "samsung-galaxy-a56", "ipad-10th-gen", "desktop-regression"]);

type ViewportProof = {
  project: string;
  route: string;
  expected: { width: number; height: number };
  actual: { width: number; height: number };
  orientation: "portrait" | "landscape";
  language: "ar" | "en";
  direction: string;
  document: { width: number; bodyWidth: number; height: number };
  bottomNav: { present: boolean; overlap: boolean; navTop?: number; finalBottom?: number };
  clippedActions: string[];
};

type DeviceReport = {
  device: string;
  requestedViewport?: { width: number; height: number };
  actualViewport?: { width: number; height: number };
  orientation?: string;
  language?: string;
  authenticated: boolean;
  pagesTested: string[];
  skippedPages: Array<{ page: string; reason: string }>;
  horizontalOverflowFindings: string[];
  bottomNavFindings: string[];
  screenshots: string[];
  errors: string[];
  status: "PASS" | "ISSUES FOUND" | "SKIPPED";
};

function artifactDir(project: string) {
  const directory = resolve("qa/artifacts/visual", project);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function credentials() {
  const identifier = process.env.QA_ADMIN_EMAIL || process.env.QA_ADMIN_USERNAME || process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME || "";
  const password = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "";
  return identifier && password ? { identifier, password } : null;
}

function assertLocalTarget(page: Page) {
  const url = new URL(page.url());
  if (!(["127.0.0.1", "localhost"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol))) {
    throw new Error(`QA safety guard blocked non-local target: ${page.url()}`);
  }
}

async function collectViewportProof(page: Page, language: "ar" | "en"): Promise<ViewportProof> {
  const expected = page.viewportSize();
  if (!expected) throw new Error("Playwright viewport is not configured");
  const proof = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const nav = document.querySelector<HTMLElement>(".mobile-bottom-nav");
    const navVisible = Boolean(nav && visible(nav));
    const candidates = Array.from(document.querySelectorAll("main button, main a, main input, main select, main textarea, main h1, main h2, main h3, main [role='button']"))
      .filter((element) => visible(element) && !element.closest(".mobile-bottom-nav"));
    const finalElement = candidates[candidates.length - 1] as HTMLElement | undefined;
    const finalRect = finalElement?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const clippedActions = Array.from(document.querySelectorAll("main button.primary-button, main button.user-action, main a.primary-button"))
      .filter((element) => visible(element))
      .filter((element) => { const rect = (element as HTMLElement).getBoundingClientRect(); return rect.left < 0 || rect.right > window.innerWidth; })
      .map((element) => (element.textContent || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 80));
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      direction: document.documentElement.dir,
      bottomNav: {
        present: navVisible,
        overlap: Boolean(navVisible && finalRect && navRect && finalRect.bottom > navRect.top + 1),
        navTop: navRect?.top,
        finalBottom: finalRect?.bottom
      },
      clippedActions
    };
  });
  return {
    project: test.info().project.name,
    route: new URL(page.url()).pathname + new URL(page.url()).search,
    expected,
    actual: { width: proof.width, height: proof.height },
    orientation: expected.width > expected.height ? "landscape" : "portrait",
    language,
    direction: proof.direction,
    document: { width: proof.documentWidth, bodyWidth: proof.bodyWidth, height: proof.documentHeight },
    bottomNav: proof.bottomNav,
    clippedActions: proof.clippedActions
  };
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(350);
  assertLocalTarget(page);
}

async function login(page: Page) {
  const qaCredentials = credentials();
  if (!qaCredentials) throw new Error("SKIPPED: QA_ADMIN_EMAIL/QA_ADMIN_USERNAME and QA_ADMIN_PASSWORD are not configured");
  await page.goto("/teacher/login", { waitUntil: "commit" });
  await settle(page);
  await page.locator("#teacher-identifier").fill(qaCredentials.identifier);
  await page.locator("#teacher-password").fill(qaCredentials.password);
  await page.getByRole("button", { name: /دخول|Login/ }).click();
  await page.waitForURL(/\/teacher\/dashboard/, { timeout: 30_000 });
  await settle(page);
  await expect(page.locator(".admin-shell")).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = resolve(artifactDir(testInfo.project.name), `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  return path.replace(`${process.cwd()}/`, "");
}

function reportPath() { return resolve("qa/artifacts/mobile-admin-report.json"); }

function writeReport(entry: DeviceReport) {
  const path = reportPath();
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as DeviceReport[] : [];
  const next = [...current.filter((item) => item.device !== entry.device), entry].sort((a, b) => a.device.localeCompare(b.device));
  mkdirSync(resolve("qa/artifacts"), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  const markdown = ["# Mobile/Admin Visual QA", "", `Generated: ${new Date().toISOString()}`, "", "| Device | Viewport | Orientation | Authenticated | Status |", "|---|---:|---|---|---|"];
  for (const item of next) markdown.push(`| ${item.device} | ${item.requestedViewport ? `${item.requestedViewport.width}×${item.requestedViewport.height}` : "—"} | ${item.orientation || "—"} | ${item.authenticated ? "yes" : "no"} | ${item.status} |`);
  markdown.push("", "## Findings", "");
  for (const item of next) markdown.push(`### ${item.device}`, `- Pages: ${item.pagesTested.join(", ") || "none"}`, `- Skipped: ${item.skippedPages.map((skip) => `${skip.page}: ${skip.reason}`).join("; ") || "none"}`, `- Overflow: ${item.horizontalOverflowFindings.join("; ") || "none"}`, `- Bottom nav: ${item.bottomNavFindings.join("; ") || "none"}`, `- Errors: ${item.errors.join("; ") || "none"}`, "");
  writeFileSync(resolve("qa/artifacts/mobile-admin-report.md"), markdown.join("\n"));
}

test.describe("DEV-only public visual QA", () => {
  for (const route of publicRoutes) {
    test(`${route.name} has viewport proof and no page overflow`, async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("abdrabo_language", "ar"));
      await page.goto(route.path, { waitUntil: "commit" });
      await settle(page);
      const proof = await collectViewportProof(page, "ar");
      writeFileSync(resolve(artifactDir(testInfo.project.name), `${route.name}.viewport.json`), JSON.stringify(proof, null, 2));
      await testInfo.attach("viewport-proof.json", { body: JSON.stringify(proof, null, 2), contentType: "application/json" });
      expect(proof.actual).toEqual(proof.expected);
      expect(proof.document.width).toBeLessThanOrEqual(proof.actual.width);
      expect(proof.document.bodyWidth).toBeLessThanOrEqual(proof.actual.width);
      expect(proof.direction).toBe("rtl");
      await screenshot(page, testInfo, route.name);
    });
  }
});

test.describe("DEV-only authenticated admin/staff visual QA", () => {
  test("authenticated admin pages, reports, messages, permissions, and safety checks", async ({ page }, testInfo) => {
    test.skip(!credentials(), "QA_ADMIN_EMAIL/QA_ADMIN_USERNAME and QA_ADMIN_PASSWORD are not configured");
    await page.addInitScript(() => localStorage.setItem("abdrabo_language", "ar"));
    await login(page);
    const firstProof = await collectViewportProof(page, "ar");
    const report: DeviceReport = {
      device: testInfo.project.name,
      requestedViewport: firstProof.expected,
      actualViewport: firstProof.actual,
      orientation: firstProof.orientation,
      language: "ar",
      authenticated: true,
      pagesTested: [],
      skippedPages: [],
      horizontalOverflowFindings: [],
      bottomNavFindings: [],
      screenshots: [],
      errors: [],
      status: "PASS"
    };
    const visit = async (name: string, path: string) => {
      await page.goto(path, { waitUntil: "commit" });
      await settle(page);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(50);
      const proof = await collectViewportProof(page, "ar");
      expect(proof.actual).toEqual(proof.expected);
      await testInfo.attach(`${name}-viewport-proof.json`, { body: JSON.stringify(proof, null, 2), contentType: "application/json" });
      writeFileSync(resolve(artifactDir(testInfo.project.name), `${name}.viewport.json`), JSON.stringify(proof, null, 2));
      report.pagesTested.push(name);
      if (proof.document.width > proof.actual.width || proof.document.bodyWidth > proof.actual.width) report.horizontalOverflowFindings.push(`${name}: document ${proof.document.width}/${proof.document.bodyWidth}px > viewport ${proof.actual.width}px`);
      if (proof.bottomNav.overlap) report.bottomNavFindings.push(`${name}: final content bottom ${proof.bottomNav.finalBottom}px overlaps nav top ${proof.bottomNav.navTop}px`);
      if (proof.clippedActions.length) report.errors.push(`${name}: clipped actions ${proof.clippedActions.join(", ")}`);
      report.screenshots.push(await screenshot(page, testInfo, name));
      return proof;
    };

    for (const item of adminPages) await visit(item.name, item.path);

    await visit("student-login", "/student/login");
    if (process.env.QA_STUDENT_CODE) {
      await page.locator("#student-code").fill(process.env.QA_STUDENT_CODE);
      await page.getByRole("button", { name: /دخول|Enter/ }).click();
      await page.waitForURL(/\/student\/dashboard/, { timeout: 15_000 });
      await settle(page);
      await screenshot(page, testInfo, "student-portal");
      report.pagesTested.push("student-portal");
      await page.goto("/teacher/dashboard?tab=overview", { waitUntil: "commit" });
      await settle(page);
    } else report.skippedPages.push({ page: "student-portal", reason: "QA_STUDENT_CODE is not configured; no student session was created." });

    await visit("students", "/teacher/dashboard?tab=students");
    const card = page.locator(".student-card").first();
    if (await card.count()) { await card.click(); await settle(page); await screenshot(page, testInfo, "student-profile-360"); report.pagesTested.push("student-profile-360"); } else report.skippedPages.push({ page: "student-profile-360", reason: "No existing student card was returned by the local QA dataset." });

    await visit("users", "/teacher/dashboard?tab=users");
    const more = page.locator(".user-action-more:visible").first();
    if (await more.count()) { await more.click(); await expect(page.locator(".user-secondary-actions.is-open").first()).toBeVisible(); }
    const edit = page.locator(".user-row:not(.user-row-owner) .user-action-primary:visible").first();
    if (await edit.count()) {
      await edit.click();
      await page.locator(".permissions-editor").waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
      await settle(page);
      if (await page.locator(".permissions-editor").count()) { await screenshot(page, testInfo, "permissions"); report.pagesTested.push("permissions"); }
      else report.skippedPages.push({ page: "permissions", reason: "The safe non-owner edit form did not expose the permissions editor in the local QA dataset." });
    } else report.skippedPages.push({ page: "permissions", reason: "No editable non-owner user was returned by the local QA dataset." });

    await visit("reports", "/teacher/dashboard?tab=reports");
    for (const tab of ["payments", "overdue", "attendance", "absence", "special-financial"]) {
      const control = page.locator(`[data-report-tab='${tab}']`);
      if (await control.count()) {
        await control.click();
        await settle(page);
        const reportProof = await page.evaluate(() => {
          const visible = (element: Element) => { const rect = (element as HTMLElement).getBoundingClientRect(); const style = getComputedStyle(element); return style.display !== "none" && rect.width > 0 && rect.height > 0; };
          const actions = Array.from(document.querySelectorAll(".finance-reports-workspace .report-actions > button")).filter(visible).map((button) => Math.round((button as HTMLElement).getBoundingClientRect().height));
          return {
            tabs: document.querySelectorAll(".finance-report-tabs [data-report-tab]").length,
            mobileCards: document.querySelectorAll(".report-mobile-results").length,
            actionHeights: actions,
            overflow: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
          };
        });
        expect(reportProof.tabs).toBeGreaterThan(0);
        if (testInfo.project.use?.viewport?.width && testInfo.project.use.viewport.width <= 900) {
          expect(reportProof.actionHeights.every((height) => height <= 80)).toBeTruthy();
          expect(reportProof.overflow).toBeFalsy();
        }
        await testInfo.attach(`${tab}-report-proof.json`, { body: JSON.stringify(reportProof, null, 2), contentType: "application/json" });
        await screenshot(page, testInfo, `reports-${tab}`);
      } else report.skippedPages.push({ page: `reports-${tab}`, reason: "Report tab is unavailable for the authenticated account permissions." });
    }

    await visit("messages", "/teacher/dashboard?tab=inbox");
    for (const tab of await page.locator(".inbox-subnav [role='tab']").all()) { await tab.click(); await settle(page); }
    const firstThread = page.locator(".inbox-thread").first();
    if (await firstThread.count()) { await firstThread.click(); await settle(page); await screenshot(page, testInfo, "messages-conversation"); } else report.skippedPages.push({ page: "messages-conversation", reason: "No safe existing conversation was returned by the local QA dataset." });

    if (ltrProjects.has(testInfo.project.name)) {
      await page.addInitScript(() => localStorage.setItem("abdrabo_language", "en"));
      for (const smoke of ["dashboard", "users", "permissions", "messages", "reports", "settings"]) {
        const path = smoke === "permissions" ? "/teacher/dashboard?tab=users" : `/teacher/dashboard?tab=${smoke === "messages" ? "inbox" : smoke === "settings" ? "settings" : smoke}`;
        await page.goto(path, { waitUntil: "commit" }); await settle(page);
        expect(await page.locator("html").getAttribute("dir")).toBe("ltr");
      }
    }

    report.status = report.errors.length || report.horizontalOverflowFindings.length || report.bottomNavFindings.length ? "ISSUES FOUND" : "PASS";
    writeReport(report);
  });
});

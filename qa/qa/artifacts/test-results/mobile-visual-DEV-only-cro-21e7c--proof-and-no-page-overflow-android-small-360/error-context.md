# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-visual.spec.ts >> DEV-only cross-device visual QA >> about-teacher has viewport proof and no page overflow
- Location: qa/mobile-visual.spec.ts:41:9

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.reload: Test timeout of 30000ms exceeded.
Call log:
  - waiting for navigation until "networkidle"
    - navigated to "http://127.0.0.1:3000/about-teacher"

```

# Page snapshot

```yaml
- generic [ref=f1e4]:
  - banner [ref=f1e5]:
    - generic [ref=f1e6]:
      - generic [ref=f1e7]:
        - link "دخول المستر" [ref=f1e8] [cursor=pointer]:
          - /url: /teacher/login
        - generic [ref=f1e9]:
          - strong [ref=f1e10]: Mr. Ahmed Abdrabo
          - generic [ref=f1e11]: مدرس العلوم
      - navigation "التنقل" [ref=f1e12]:
        - link "الرئيسية" [ref=f1e13] [cursor=pointer]:
          - /url: /
        - link "دخول الطالب" [ref=f1e14] [cursor=pointer]:
          - /url: /login
        - link "عن المحاضر" [ref=f1e15] [cursor=pointer]:
          - /url: /about-teacher
        - link "التواصل" [ref=f1e17] [cursor=pointer]:
          - /url: /contact
      - generic [ref=f1e18]:
        - link "تحميل التطبيق" [ref=f1e19] [cursor=pointer]:
          - /url: http://localhost:4000/api/app/download
        - button "التبديل إلى الوضع الفاتح" [ref=f1e22] [cursor=pointer]
  - main [ref=f1e25]:
    - region [ref=f1e26]:
      - article [ref=f1e27]:
        - img "Mr. Ahmed Abdrabo" [ref=f1e29]
        - generic [ref=f1e30]:
          - generic [ref=f1e31]: مدرس العلوم
          - heading "Mr. Ahmed Abdrabo" [level=1] [ref=f1e32]
          - paragraph [ref=f1e33]: شرح منظم يربط المنهج بالتطبيقات العملية ويساعد الطالب على فهم الفكرة قبل حفظها.
      - generic "نتائج ومؤشرات" [ref=f1e34]:
        - article [ref=f1e35]:
          - strong [ref=f1e36]: +4 سنوات خبرة
          - generic [ref=f1e37]: سنوات من العطاء والتطوير
        - article [ref=f1e38]:
          - strong [ref=f1e39]: +1200 طالب
          - generic [ref=f1e40]: تم تدريبهم ومتابعتهم
        - article [ref=f1e41]:
          - strong [ref=f1e42]: 92% تفوق
          - generic [ref=f1e43]: نسبة تحسن في الدرجات واختبارات دورية
  - contentinfo [ref=f1e44]: © 2026 Mr. Ahmed Abdrabo · Designed & Developed by Eng. Hany Hosny
```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  | import type { Page } from "@playwright/test";
  3  | 
  4  | const routes = [
  5  |   { name: "landing", path: "/" },
  6  |   { name: "about-teacher", path: "/about-teacher" },
  7  |   { name: "contact", path: "/contact" }
  8  | ] as const;
  9  | 
  10 | type ViewportProof = {
  11 |   project: string;
  12 |   route: string;
  13 |   expected: { width: number; height: number };
  14 |   actual: { width: number; height: number };
  15 |   document: { width: number; height: number };
  16 |   direction: string;
  17 | };
  18 | 
  19 | async function collectViewportProof(page: Page): Promise<ViewportProof> {
  20 |   const proof = await page.evaluate(() => ({
  21 |     width: window.innerWidth,
  22 |     height: window.innerHeight,
  23 |     documentWidth: document.documentElement.scrollWidth,
  24 |     documentHeight: document.documentElement.scrollHeight,
  25 |     direction: document.documentElement.dir
  26 |   }));
  27 |   const expected = page.viewportSize();
  28 |   if (!expected) throw new Error("Playwright viewport is not configured");
  29 |   return {
  30 |     project: test.info().project.name,
  31 |     route: new URL(page.url()).pathname,
  32 |     expected,
  33 |     actual: { width: proof.width, height: proof.height },
  34 |     document: { width: proof.documentWidth, height: proof.documentHeight },
  35 |     direction: proof.direction
  36 |   };
  37 | }
  38 | 
  39 | test.describe("DEV-only cross-device visual QA", () => {
  40 |   for (const route of routes) {
  41 |     test(`${route.name} has viewport proof and no page overflow`, async ({ page }, testInfo) => {
  42 |       await page.goto(route.path, { waitUntil: "networkidle" });
  43 |       await page.evaluate(() => localStorage.setItem("abdrabo_language", "ar"));
> 44 |       await page.reload({ waitUntil: "networkidle" });
     |                  ^ Error: page.reload: Test timeout of 30000ms exceeded.
  45 |       await expect(page.locator("body")).toBeVisible();
  46 | 
  47 |       const proof = await collectViewportProof(page);
  48 |       await testInfo.attach("viewport-proof.json", {
  49 |         body: JSON.stringify(proof, null, 2),
  50 |         contentType: "application/json"
  51 |       });
  52 | 
  53 |       expect(proof.actual).toEqual(proof.expected);
  54 |       expect(proof.document.width).toBeLessThanOrEqual(proof.actual.width);
  55 |       expect(proof.direction).toBe("rtl");
  56 | 
  57 |       await page.screenshot({
  58 |         path: testInfo.outputPath(`${route.name}.png`),
  59 |         fullPage: true
  60 |       });
  61 |     });
  62 |   }
  63 | });
  64 | 
```
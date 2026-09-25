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
Tearing down "context" exceeded the test timeout of 30000ms.
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
        - generic "اللغة" [ref=f1e22]:
          - button "AR" [pressed] [ref=f1e23] [cursor=pointer]
          - button "EN" [ref=f1e24] [cursor=pointer]
        - button "التبديل إلى الوضع الفاتح" [ref=f1e25] [cursor=pointer]
  - main [ref=f1e28]:
    - region [ref=f1e29]:
      - article [ref=f1e30]:
        - img "Mr. Ahmed Abdrabo" [ref=f1e32]
        - generic [ref=f1e33]:
          - generic [ref=f1e34]: مدرس العلوم
          - heading "Mr. Ahmed Abdrabo" [level=1] [ref=f1e35]
          - paragraph [ref=f1e36]: شرح منظم يربط المنهج بالتطبيقات العملية ويساعد الطالب على فهم الفكرة قبل حفظها.
      - generic "نتائج ومؤشرات" [ref=f1e37]:
        - article [ref=f1e38]:
          - strong [ref=f1e39]: +4 سنوات خبرة
          - generic [ref=f1e40]: سنوات من العطاء والتطوير
        - article [ref=f1e41]:
          - strong [ref=f1e42]: +1200 طالب
          - generic [ref=f1e43]: تم تدريبهم ومتابعتهم
        - article [ref=f1e44]:
          - strong [ref=f1e45]: 92% تفوق
          - generic [ref=f1e46]: نسبة تحسن في الدرجات واختبارات دورية
  - contentinfo [ref=f1e47]: © 2026 Mr. Ahmed Abdrabo · Designed & Developed by Eng. Hany Hosny
```
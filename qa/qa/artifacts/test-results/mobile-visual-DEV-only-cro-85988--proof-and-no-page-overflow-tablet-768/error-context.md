# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-visual.spec.ts >> DEV-only cross-device visual QA >> contact has viewport proof and no page overflow
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
- generic [ref=f3e4]:
  - banner [ref=f3e5]:
    - generic [ref=f3e6]:
      - generic [ref=f3e7]:
        - link "دخول المستر" [ref=f3e8] [cursor=pointer]:
          - /url: /teacher/login
        - generic [ref=f3e9]:
          - strong [ref=f3e10]: Mr. Ahmed Abdrabo
          - generic [ref=f3e11]: مدرس العلوم
      - navigation "التنقل" [ref=f3e12]:
        - link "الرئيسية" [ref=f3e13] [cursor=pointer]:
          - /url: /
        - link "دخول الطالب" [ref=f3e14] [cursor=pointer]:
          - /url: /login
        - link "عن المحاضر" [ref=f3e15] [cursor=pointer]:
          - /url: /about-teacher
        - link "التواصل" [ref=f3e16] [cursor=pointer]:
          - /url: /contact
      - generic [ref=f3e18]:
        - link "تحميل التطبيق" [ref=f3e19] [cursor=pointer]:
          - /url: http://localhost:4000/api/app/download
        - generic "اللغة" [ref=f3e22]:
          - button "AR" [pressed] [ref=f3e23] [cursor=pointer]
          - button "EN" [ref=f3e24] [cursor=pointer]
        - button "التبديل إلى الوضع الفاتح" [ref=f3e25] [cursor=pointer]
  - main [ref=f3e28]:
    - generic [ref=f3e29]:
      - heading "التواصل" [level=1] [ref=f3e30]
      - paragraph [ref=f3e31]: للاستفسار عن المجموعات والحضور ودرجات الطلاب.
    - region "التواصل" [ref=f3e32]:
      - article [ref=f3e33]:
        - generic [ref=f3e34]:
          - generic [ref=f3e35]: تشرّفنا زيارتكم
          - heading "اعثر على السنتر بسهولة" [level=2] [ref=f3e36]
          - paragraph [ref=f3e37]: اعرف موقعنا وتوجه إلينا بسهولة.
        - iframe [ref=f3e39]:
          - generic [ref=f4e3]:
            - generic:
              - button "اختصارات لوحة المفاتيح"
            - region "الخريطة" [ref=f4e4]
            - generic [ref=f4e5]:
              - generic [ref=f4e6] [cursor=pointer]
              - iframe [aria-hidden] [ref=f4e21]
              - img "Google" [ref=f4e23]
              - generic [ref=f4e24]:
                - button "اختصارات لوحة المفاتيح" [ref=f4e30] [cursor=pointer]
                - generic [ref=f4e31]: Map data ©2026
                - link "البنود (يتم فتح الرابط في علامة تبويب جديدة)" [ref=f4e40] [cursor=pointer]:
                  - /url: https://www.google.com/intl/ar_US/help/terms_maps.html
                  - text: البنود
        - generic [ref=f3e40]:
          - generic [ref=f3e41]: الصالحيه الجديده - مجاوره 4 - امام السنترال
          - link "الاتجاهات" [ref=f3e42] [cursor=pointer]:
            - /url: https://www.google.com/maps/dir/?api=1&destination=30.6337425,31.9407791
            - generic [aria-hidden] [ref=f3e44]: ↗
      - article [ref=f3e45]:
        - heading "تواصل مباشرة" [level=2] [ref=f3e46]
        - paragraph [ref=f3e47]: اختر الطريقة المناسبة وسنسعد بالتواصل معك.
        - generic [ref=f3e48]:
          - link "تواصل معنا عبر واتساب" [ref=f3e49] [cursor=pointer]:
            - /url: https://wa.me/201010971994
            - generic [ref=f3e53]:
              - strong [ref=f3e54]: تواصل معنا عبر واتساب
              - generic [ref=f3e55]: واتساب
          - link "تابعنا على فيسبوك" [ref=f3e56] [cursor=pointer]:
            - /url: https://facebook.com/abdrabo.science
            - generic [ref=f3e59]:
              - strong [ref=f3e60]: تابعنا على فيسبوك
              - generic [ref=f3e61]: فيسبوك
          - link "تابعنا على يوتيوب" [ref=f3e62] [cursor=pointer]:
            - /url: https://youtube.com/@abdrabo-science
            - generic [ref=f3e66]:
              - strong [ref=f3e67]: تابعنا على يوتيوب
              - generic [ref=f3e68]: يوتيوب
      - article [ref=f3e69]:
        - heading "أرسل رسالة" [level=2] [ref=f3e70]
        - paragraph [ref=f3e71]: اترك بياناتك وسيتم التواصل معك.
        - generic [ref=f3e72]:
          - generic [ref=f3e73]:
            - generic [ref=f3e74]: الاسم
            - textbox "الاسم" [ref=f3e75]
          - generic [ref=f3e76]:
            - generic [ref=f3e77]: رقم الهاتف
            - textbox "رقم الهاتف" [ref=f3e78]
          - generic [ref=f3e79]:
            - generic [ref=f3e80]: رسالتك
            - textbox "رسالتك" [ref=f3e81]
          - button "إرسال" [ref=f3e82] [cursor=pointer]
  - contentinfo [ref=f3e83]: © 2026 Mr. Ahmed Abdrabo · Designed & Developed by Eng. Hany Hosny
```
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-visual.spec.ts >> DEV-only cross-device visual QA >> landing has viewport proof and no page overflow
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
      - generic [ref=f1e12]:
        - link "تحميل التطبيق" [ref=f1e13] [cursor=pointer]:
          - /url: http://localhost:4000/api/app/download
        - button "التبديل إلى الوضع الفاتح" [ref=f1e16] [cursor=pointer]
        - button "التنقل" [ref=f1e19] [cursor=pointer]:
          - generic [aria-hidden] [ref=f1e20]: ☰
  - main [ref=f1e21]:
    - region [ref=f1e22]:
      - generic [ref=f1e23]:
        - generic [ref=f1e24]: مدرس العلوم
        - heading "منصة مستر أحمد عبدربه التعليمية" [level=1] [ref=f1e27]
        - paragraph [ref=f1e28]: نظام متكامل لتعلم العلوم لكل المراحل الدراسية.
        - generic [ref=f1e29]:
          - link "دخول الطالب" [ref=f1e30] [cursor=pointer]:
            - /url: /login
            - generic [aria-hidden] [ref=f1e32]: ↗
          - button "استكشف الصفوف" [ref=f1e33] [cursor=pointer]:
            - generic [aria-hidden] [ref=f1e35]: ↓
        - generic [ref=f1e36]:
          - generic [aria-hidden] [ref=f1e37]: ✦
          - generic [ref=f1e38]: محتوى منظم، تدريب مستمر، ومتابعة تساعد كل طالب على التقدم بثقة.
      - group "المساعد الذكي لمنصة العلوم" [ref=f1e39]:
        - generic [ref=f1e40]:
          - status [ref=f1e41]:
            - text: 👋 اسأل المساعد الذكي
            - button "إغلاق التلميح" [ref=f1e42] [cursor=pointer]: ×
          - button "فتح المساعد الذكي" [ref=f1e43] [cursor=pointer]:
            - generic [ref=f1e44]: ع
        - generic [ref=f1e48]:
          - generic [ref=f1e49]: العلوم
          - generic [ref=f1e50]: تعلم بوضوح
        - generic: H₂O
        - generic: DNA
    - region [ref=f1e51]:
      - generic [ref=f1e52]:
        - generic [ref=f1e53]: مسارات تعليمية واضحة
        - heading "اختر صفك وابدأ رحلة التفوق" [level=2] [ref=f1e54]
        - paragraph [ref=f1e55]: محتوى منظم، تدريب مستمر، ومتابعة تساعد كل طالب على التقدم بثقة.
      - generic [ref=f1e56]:
        - article [ref=f1e57]:
          - generic [ref=f1e63]:
            - generic [ref=f1e64]: ابتدائي
            - heading "الصف الخامس الابتدائي" [level=3] [ref=f1e65]
          - generic [ref=f1e66]: متاح الآن
        - article [ref=f1e68]:
          - generic [ref=f1e74]:
            - generic [ref=f1e75]: ابتدائي
            - heading "الصف السادس الابتدائي" [level=3] [ref=f1e76]
          - generic [ref=f1e77]: متاح الآن
        - article [ref=f1e79]:
          - generic [ref=f1e84]:
            - generic [ref=f1e85]: إعدادي
            - heading "الصف الأول الإعدادي" [level=3] [ref=f1e86]
          - generic [ref=f1e87]: متاح الآن
        - article [ref=f1e89]:
          - generic [ref=f1e94]:
            - generic [ref=f1e95]: إعدادي
            - heading "الصف الثاني الإعدادي" [level=3] [ref=f1e96]
          - generic [ref=f1e97]: متاح الآن
        - article [ref=f1e99]:
          - generic [ref=f1e104]:
            - generic [ref=f1e105]: إعدادي
            - heading "الصف الثالث الإعدادي" [level=3] [ref=f1e106]
          - generic [ref=f1e107]: متاح الآن
        - article [ref=f1e109]:
          - generic [ref=f1e116]:
            - generic [ref=f1e117]: ثانوي
            - heading "الصف الأول الثانوي" [level=3] [ref=f1e118]
          - generic [ref=f1e119]: متاح الآن
        - article [ref=f1e121]:
          - generic [ref=f1e128]:
            - generic [ref=f1e129]: ثانوي
            - heading "الصف الثاني الثانوي" [level=3] [ref=f1e130]
          - generic [ref=f1e131]: متاح الآن
        - article:
          - generic: قريباً
          - generic:
            - generic: ثانوي
            - heading "الصف الثالث الثانوي" [level=3]
        - article [ref=f1e133]:
          - generic [ref=f1e138]:
            - generic [ref=f1e139]: دعم إضافي
            - heading "مجاميع التقوية" [level=3] [ref=f1e140]
          - generic [ref=f1e141]: ✦
    - region [ref=f1e142]:
      - generic [ref=f1e143]:
        - generic [ref=f1e144]: تجربة تعليمية أذكى
        - heading "كل ما يحتاجه الطالب في مكان واحد" [level=2] [ref=f1e145]
        - paragraph [ref=f1e146]: من أول شرح الدرس وحتى متابعة النتيجة، المنصة مصممة لتجعل التقدم واضحاً.
      - generic [ref=f1e147]:
        - article [ref=f1e148]:
          - generic [ref=f1e149]:
            - generic [ref=f1e150]: "01"
            - generic [aria-hidden] [ref=f1e151]: ◉
          - heading "إشعارات واتساب فورية" [level=3] [ref=f1e152]
          - paragraph [ref=f1e153]: متابعة درجات الاختبارات والغياب.
        - article [ref=f1e154]:
          - generic [ref=f1e155]:
            - generic [ref=f1e156]: "02"
            - generic [aria-hidden] [ref=f1e157]: ⌁
          - heading "فهم وتطبيق عملي" [level=3] [ref=f1e158]
          - paragraph [ref=f1e159]: تبسيط التجارب قبل الحفظ.
        - article [ref=f1e160]:
          - generic [ref=f1e161]:
            - generic [ref=f1e162]: "03"
            - generic [aria-hidden] [ref=f1e163]: ↗
          - heading "تقييم واختبارات دورية" [level=3] [ref=f1e164]
          - paragraph [ref=f1e165]: قياس مستوى وبنك أسئلة متجدد.
        - article [ref=f1e166]:
          - generic [ref=f1e167]:
            - generic [ref=f1e168]: "04"
            - generic [aria-hidden] [ref=f1e169]: ✦
          - heading "خطط متابعة فردية" [level=3] [ref=f1e170]
          - paragraph [ref=f1e171]: تدريب خاص لرفع مستوى الطالب.
    - region "إحصائيات المنصة" [ref=f1e172]:
      - generic [ref=f1e173]:
        - strong [ref=f1e174]: "+4"
        - generic [ref=f1e175]: سنوات خبرة
      - generic [ref=f1e176]:
        - strong [ref=f1e177]: "+1200"
        - generic [ref=f1e178]: طالب تم تدريبهم
      - generic [ref=f1e179]:
        - strong [ref=f1e180]: "8"
        - generic [ref=f1e181]: صفوف دراسية متاحة
  - contentinfo [ref=f1e182]: © 2026 Mr. Ahmed Abdrabo · Designed & Developed by Eng. Hany Hosny
```
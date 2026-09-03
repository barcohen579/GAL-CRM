import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";

// Public page — deliberately outside app/(app), the protected route
// group, and listed in lib/supabase/middleware.ts's PUBLIC_PATHS so
// unauthenticated visitors (including Meta's app-review process) are
// never redirected to /login here. No data fetching, no auth check —
// static content only.
export const metadata: Metadata = {
  title: "מדיניות פרטיות — GAL CRM",
  description: "מדיניות הפרטיות של Gal Valdman Fitness ו-GAL CRM.",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-zinc-100 pt-6 first:border-t-0 first:pt-0">
      <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-7 text-zinc-600">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <main className="flex min-h-screen flex-1 justify-center bg-zinc-50 px-4 py-10 sm:py-14">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-600 text-white shadow-sm shadow-rose-200">
            <ShieldCheck className="h-5 w-5" strokeWidth={2.25} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">
              מדיניות פרטיות
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Gal Valdman Fitness · GAL CRM
            </p>
          </div>
        </div>

        <div className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-sm leading-7 text-zinc-600">
            מדיניות זו מסבירה כיצד Gal Valdman Fitness (&quot;העסק&quot;,
            &quot;אנחנו&quot;) אוספת, שומרת ומשתמשת במידע שמתקבל מפניות
            ולידים — לרבות פניות שמתקבלות דרך טפסי לידים (Lead Ads) במטא,
            פייסבוק ואינסטגרם, וכן פניות ישירות אחרות. עודכן לאחרונה:
            ספטמבר 2026.
          </p>

          <Section title="איזה מידע אנו אוספים">
            <p>
              כאשר את/ה משאיר/ה פרטים דרך טופס ליד במטא (פייסבוק/אינסטגרם)
              או פונה/ה אלינו ישירות, אנו עשויים לקבל ולשמור מידע כגון: שם,
              מספר טלפון, כתובת אימייל, פרטי הפנייה, וכן מזהים טכניים
              הקשורים למקור הפנייה (כגון קמפיין, מודעה או טופס). בנוסף,
              אנו שומרים מידע על האינטראקציה עצמה — למשל שלב הטיפול בפנייה
              ומעקבים/תזכורות שנקבעו בעקבותיה.
            </p>
          </Section>

          <Section title="כיצד אנו משתמשים במידע">
            <p>
              אנו משתמשים במידע כדי ליצור קשר עם פונים ולידים, לנהל ולעקוב
              אחר פניות, לתאם מעקבים ותזכורות, לספק את השירותים המוצעים
              על ידי העסק, לנהל לקוחות ותשלומים, ולנתח ביצועי שיווק
              ופעילות עסקית.
            </p>
          </Section>

          <Section title="שמירת המידע וגישה אליו">
            <p>
              המידע נשמר במערכת ה-CRM של העסק ובתשתיות ובספקים התומכים
              בהפעלתה. הגישה למידע מוגבלת לגורמים מורשים בעסק ולגורמים
              הדרושים לתפעול המערכת בלבד.
            </p>
          </Section>

          <Section title="שיתוף מידע עם צדדים שלישיים">
            <p>
              איננו מוכרים מידע אישי לצדדים שלישיים. ספקי שירות רלוונטיים
              (למשל ספקי תשתית ואחסון) עשויים לעבד מידע אך ורק ככל הנדרש
              לצורך הפעלת השירות והתשתית שתומכת בו.
            </p>
          </Section>

          <Section title="עוגיות (Cookies)">
            <p>
              אתר זה עצמו אינו משתמש בעוגיות מעקב לצורכי פרסום או ניתוח
              גלישה. מערכת ה-CRM הפנימית משתמשת בעוגיית התחברות טכנית
              (session) לצורך זיהוי אנשי צוות מחוברים בלבד — עוגייה זו
              אינה רלוונטית ללידים ולפונים חיצוניים.
            </p>
          </Section>

          <Section title="מידע ממודעות לידים של מטא / פייסבוק / אינסטגרם">
            <p>
              כאשר את/ה ממלא/ת טופס ליד (Lead Ads) בפייסבוק או באינסטגרם,
              מטא עשויה להעביר אלינו את הפרטים שמסרת בטופס, לצורך קליטתם
              במערכת ה-CRM שלנו וטיפול בפנייה. פלטפורמות מטא עצמן כפופות
              למדיניות הפרטיות של מטא, שאינה בשליטתנו. מדיניות זו מתייחסת
              אך ורק לאופן שבו Gal Valdman Fitness מטפלת במידע לאחר קבלתו.
            </p>
          </Section>

          <Section title="הזכויות שלך">
            <p>
              ניתן לפנות אלינו בבקשה לעיין במידע שנשמר אודותיך, לתקן אותו
              או לבקש את מחיקתו. אנו נפעל בהתאם לבקשה ככל הניתן, בכפוף
              לדרישות חוק ולצרכים עסקיים לגיטימיים לשמירת רישומים (למשל
              רישומי תשלום).
            </p>
          </Section>

          <Section title="אבטחת מידע">
            <p>
              אנו נוקטים באמצעים סבירים להגנה על המידע הנשמר אצלנו, אך יש
              לזכור שאין מערכת שיכולה להבטיח אבטחה מוחלטת.
            </p>
          </Section>

          <Section title="עדכונים למדיניות">
            <p>
              מדיניות זו עשויה להתעדכן מעת לעת בהתאם לשינויים באופן
              הפעלת העסק או המערכת.
            </p>
          </Section>

          <Section title="יצירת קשר">
            <p>
              לבקשות בנושא פרטיות ניתן לפנות אלינו דרך ערוצי הקשר הרשמיים
              של Gal Valdman Fitness.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}

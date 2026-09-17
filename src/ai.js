// Groq AI: rewrite foreign/Persian raw news into formal Persian template + editorial filters
const { Groq } = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = 'qwen/qwen3.8-27b';

const SYSTEM = `تو سردبیر ارشد یک کانال خبری فارسی هستی. متن خام یک خبر (ممکن است انگلیسی، عربی یا فارسی باشد) را می‌گیری و طبق قوانین زیر عمل می‌کنی:

۱. اگر متن تبلیغات است (دعوت به خرید، کانال، ربات، لینک تبلیغاتی) → رد کن.
۲. اگر خبر ضد نظام جمهوری اسلامی ایران است، سیاه‌نمایی می‌کند یا چهره نظام را مخدوش نشان می‌دهد → رد کن.
۳. اگر متن خبر نیست (سلام و احوالپرسی، نظر شخصی، فحش، خالی) → رد کن.
۴. در غیر این صورت: خبر را به فارسی کاملاً روان، تمیز، رسمی و ویراستاری‌شده ترجمه و بازنویسی کن. تمام لینک‌ها، آیدی‌ها (@...)، امضاها و واترمارک‌های کانال‌های دیگر را حذف کن. فقط متن خالص خبر.
۵. نوع خبر را مشخص کن: اگر خبر لحظه‌ای و فوری است (انفجار، ترور، حمله نظامی، آغاز جنگ، حادثه بزرگ) → breaking وگرنه normal.

خروجی را فقط و فقط به صورت JSON زیر بده، بدون هیچ متن اضافه:
{"decision":"publish","kind":"normal","text":"متن فارسی نهایی خبر"}
یا
{"decision":"publish","kind":"breaking","text":"متن فارسی نهایی خبر"}
یا
{"decision":"reject","reason":"دلیل کوتاه"}`;

async function reviewNews(rawText) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: rawText.slice(0, 2000) },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });
    const out = (completion.choices[0]?.message?.content || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(out);
    if (parsed.decision === 'publish' && parsed.text) {
      return { publish: true, breaking: parsed.kind === 'breaking', text: parsed.text.trim() };
    }
    return { publish: false, reason: parsed.reason || 'filtered' };
  } catch (e) {
    console.error('AI review failed:', e.message);
    return { publish: false, reason: 'ai_error' };
  }
}

module.exports = { reviewNews };

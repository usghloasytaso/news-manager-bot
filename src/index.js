const { Bot, InlineKeyboard, InputFile } = require('grammy');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config();

const { getSetting, setSetting, queueCount } = require('./store');
const {
  beginQrLogin,
  waitQrLogin,
  resolveQrPassword,
  hasQrFlow,
  cancelQr,
  logoutSession,
} = require('./userclient');
const { setBot, scanOnce, publishTick } = require('./engine');
const { mainMenu, backMenu, HELP_TEXT } = require('./ui');

const bot = new Bot(process.env.BOT_TOKEN);
setBot(bot);

// In-memory conversation state: userId -> { step, data }
const states = new Map();
function setState(uid, step, data = {}) {
  states.set(String(uid), { step, data });
}
function getState(uid) {
  return states.get(String(uid));
}
function clearState(uid) {
  states.delete(String(uid));
}

async function isOwner(ctx) {
  if (!ctx.from || ctx.chat.type !== 'private') return false;
  const ownerId = await getSetting('owner_id');
  if (!ownerId) {
    await setSetting('owner_id', String(ctx.from.id));
    return true;
  }
  return String(ctx.from.id) === String(ownerId);
}

async function statusText() {
  const running = await getSetting('running');
  const sources = (await getSetting('sources')) || [];
  const dest = await getSetting('dest_channel');
  const sign = await getSetting('signature');
  const sendPhoto = await getSetting('send_photo');
  const sendVideo = await getSetting('send_video');
  const intervalMin = await getSetting('interval_min');
  const session = await getSetting('session');
  const pending = await queueCount();
  return `📊 وضعیت ربات:
👤 ورود اکانت: ${session ? '✅ وارد شده' : '❌ نشده'}
⚙️ رصد: ${running ? '▶️ روشن' : '⏸ متوقف'}
📡 تعداد منابع: ${sources.length}
🎯 مقصد: ${dest}
✍️ امضا: ${sign}
🖼 عکس: ${sendPhoto ? 'روشن' : 'خاموش'} | 🎬 فیلم: ${sendVideo ? 'روشن' : 'خاموش'}
⏱ فاصله انتشار: هر ${intervalMin} دقیقه
📥 خبر در صف: ${pending}`;
}

// ---------- commands (Persian, no slash needed) ----------
bot.command('start', async (ctx) => {
  if (!(await isOwner(ctx))) return ctx.reply('⛔ این ربات خصوصی است.');
  clearState(ctx.from.id);
  await ctx.reply('🤖 به ربات مدیر اخبار خوش آمدی!\nاز دکمه‌ها استفاده کن یا بنویس: راهنما', {
    reply_markup: mainMenu(),
  });
});

bot.callbackQuery('back', async (ctx) => {
  clearState(ctx.from.id);
  await ctx.editMessageText('🤖 منوی اصلی:', { reply_markup: mainMenu() });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('help', async (ctx) => {
  await ctx.reply(HELP_TEXT, { reply_markup: backMenu() });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('status', async (ctx) => {
  await ctx.reply(await statusText(), { reply_markup: backMenu() });
  await ctx.answerCallbackQuery();
});

// ---------- QR login flow (no code typing) ----------
bot.callbackQuery('login', async (ctx) => {
  cancelQr(ctx.from.id);
  clearState(ctx.from.id);
  await ctx.answerCallbackQuery();
  try {
    await ctx.reply('⏳ دارم کد QR می‌سازم...');
    const png = await beginQrLogin(ctx.from.id, async () => {
      setState(ctx.from.id, 'await_qr_password');
      try {
        await bot.api.sendMessage(
          ctx.from.id,
          '🔐 اکانتت رمز دومرحله‌ای دارد.\nرمز را همین‌جا بفرست (بعدش پیام رمز را پاک کن):'
        );
      } catch (e) {}
    });
    await ctx.replyWithPhoto(
          new InputFile(png),
      {
        caption:
          '📷 با گوشی این را اسکن کن:\nتلگرام → تنظیمات → دستگاه‌ها → اتصال دستگاه\n\nاگه منقضی شد، دوباره دکمه ورود را بزن.',
      }
    );
    // background waiter
    waitQrLogin(ctx.from.id)
      .then(async () => {
        clearState(ctx.from.id);
        await bot.api.sendMessage(ctx.from.id, '🎉 ورود موفق بود و ذخیره شد!\nحالا دکمه شروع را بزن.', {
          reply_markup: mainMenu(),
        });
      })
      .catch(async (e) => {
        if (hasQrFlow(ctx.from.id)) cancelQr(ctx.from.id);
        clearState(ctx.from.id);
        await bot.api.sendMessage(
          ctx.from.id,
          '❌ ورود کامل نشد (QR منقضی شد یا خطا). دوباره دکمه ورود را بزن.'
        );
      });
    // safety timeout: 3 minutes
    setTimeout(async () => {
      if (hasQrFlow(ctx.from.id)) {
        cancelQr(ctx.from.id);
        clearState(ctx.from.id);
        try {
          await bot.api.sendMessage(ctx.from.id, '⏰ وقت QR تمام شد. دوباره دکمه ورود را بزن.');
        } catch (e) {}
      }
    }, 180000);
  } catch (e) {
    cancelQr(ctx.from.id);
    await ctx.reply('❌ ساخت QR ناموفق بود: ' + (e.errorMessage || e.message));
  }
});

async function handleQrPasswordInput(ctx, password) {
  if (!resolveQrPassword(ctx.from.id, password)) {
    return ctx.reply('❌ جریانی فعال نیست. دوباره دکمه ورود را بزن.');
  }
  try {
    await ctx.deleteMessage();
  } catch (e) {}
  await ctx.reply('⏳ رمز را گرفتم، کمی صبر کن...');
}

// ---------- sources ----------
bot.callbackQuery('sources', async (ctx) => {
  const sources = (await getSetting('sources')) || [];
  let text = '📡 منابع فعلی:\n\n';
  sources.forEach((s, i) => {
    text += `${i + 1}. ${s}\n`;
  });
  text += '\nبرای افزودن، آیدی یا لینک را بفرست (مثل @name).\nبرای حذف بنویس: حذف ۲';
  setState(ctx.from.id, 'await_source');
  await ctx.reply(text, { reply_markup: backMenu() });
  await ctx.answerCallbackQuery();
});

async function handleSourceInput(ctx, text) {
  let sources = (await getSetting('sources')) || [];
  const norm = text.trim();
  if (/^حذف\s+\d+/.test(norm)) {
    const idx = parseInt(norm.replace(/^حذف\s+/, ''), 10) - 1;
    if (idx >= 0 && idx < sources.length) {
      const removed = sources.splice(idx, 1);
      await setSetting('sources', sources);
      clearState(ctx.from.id);
      return ctx.reply(`🗑 حذف شد: ${removed[0]}`, { reply_markup: mainMenu() });
    }
    return ctx.reply('❌ شماره درست نیست.');
  }
  if (/^@[\w_]{4,}|^https?:\/\/t\.me\/.+/.test(norm)) {
    if (sources.includes(norm)) return ctx.reply('این منبع قبلاً هست.');
    sources.push(norm);
    await setSetting('sources', sources);
    clearState(ctx.from.id);
    return ctx.reply(`✅ اضافه شد: ${norm}`, { reply_markup: mainMenu() });
  }
  return ctx.reply('❌ فرمت درست نیست. مثال: @name یا https://t.me/...');
}

// ---------- dest / sign / interval ----------
bot.callbackQuery('dest', async (ctx) => {
  setState(ctx.from.id, 'await_dest');
  await ctx.reply(`🎯 آیدی عددی کانال مقصد را بفرست (فعلی: ${await getSetting('dest_channel')}).\nمثال: -1001234567890`, {
    reply_markup: backMenu(),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('sign', async (ctx) => {
  setState(ctx.from.id, 'await_sign');
  await ctx.reply(`✍️ متن امضای پایان خبر را بفرست (فعلی: ${await getSetting('signature')})`, {
    reply_markup: backMenu(),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('interval', async (ctx) => {
  setState(ctx.from.id, 'await_interval');
  await ctx.reply(`⏱ فاصله انتشار خبرهای عادی را به دقیقه بفرست (فعلی: ${await getSetting('interval_min')}).\nمثال: 2`, {
    reply_markup: backMenu(),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('media', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('🖼 عکس روشن/خاموش', 'tg_photo').row()
    .text('🎬 فیلم روشن/خاموش', 'tg_video').row()
    .text('🔙 برگشت', 'back');
  await ctx.reply(
    `🖼 وضعیت فعلی:\nعکس: ${await getSetting('send_photo') ? 'روشن ✅' : 'خاموش ❌'}\nفیلم: ${await getSetting('send_video') ? 'روشن ✅' : 'خاموش ❌'}`,
    { reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('tg_photo', async (ctx) => {
  const cur = await getSetting('send_photo');
  await setSetting('send_photo', !cur);
  await ctx.reply(`🖼 عکس ${!cur ? 'روشن شد ✅' : 'خاموش شد ❌'}`);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('tg_video', async (ctx) => {
  const cur = await getSetting('send_video');
  await setSetting('send_video', !cur);
  await ctx.reply(`🎬 فیلم ${!cur ? 'روشن شد ✅' : 'خاموش شد ❌'}`);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('toggle', async (ctx) => {
  const cur = await getSetting('running');
  if (!cur) {
    const session = await getSetting('session');
    if (!session) {
      await ctx.reply('❌ اول باید وارد اکانت شوی (دکمه ورود به اکانت).');
      await ctx.answerCallbackQuery();
      return;
    }
  }
  await setSetting('running', !cur);
  await ctx.reply(!cur ? '▶️ رصد روشن شد. هر ۲ دقیقه منابع چک می‌شوند.' : '⏸ رصد متوقف شد.');
  await ctx.answerCallbackQuery();
});

// ---------- text router (Persian, private only, owner only) ----------
bot.on('message:text', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!(await isOwner(ctx))) return ctx.reply('⛔ این ربات خصوصی است.');
  const text = (ctx.message.text || '').trim();
  const norm = text.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').replace(/\s+/g, ' ').trim();
  const st = getState(ctx.from.id);

  if (norm === 'راهنما' || norm === 'کمک' || norm === 'دستورات') {
    clearState(ctx.from.id);
    return ctx.reply(HELP_TEXT, { reply_markup: mainMenu() });
  }
  if (norm === 'وضعیت') {
    clearState(ctx.from.id);
    return ctx.reply(await statusText(), { reply_markup: mainMenu() });
  }
  if (norm === 'شروع') {
    const session = await getSetting('session');
    if (!session) return ctx.reply('❌ اول وارد اکانت شو.');
    await setSetting('running', true);
    clearState(ctx.from.id);
    return ctx.reply('▶️ رصد روشن شد.', { reply_markup: mainMenu() });
  }
  if (norm === 'توقف') {
    await setSetting('running', false);
    clearState(ctx.from.id);
    return ctx.reply('⏸ رصد متوقف شد.', { reply_markup: mainMenu() });
  }
  if (norm === 'خروج از اکانت') {
    await logoutSession();
    await setSetting('running', false);
    clearState(ctx.from.id);
    return ctx.reply('🚪 از اکانت خارج شدی.', { reply_markup: mainMenu() });
  }

  if (!st) {
    return ctx.reply('از دکمه‌ها استفاده کن یا بنویس: راهنما', { reply_markup: mainMenu() });
  }

  if (st.step === 'await_qr_password') return handleQrPasswordInput(ctx, text);
  if (st.step === 'await_source') return handleSourceInput(ctx, text);
  if (st.step === 'await_dest') {
    if (/^-?\d+$/.test(norm)) {
      await setSetting('dest_channel', norm);
      clearState(ctx.from.id);
      return ctx.reply(`✅ مقصد ثبت شد: ${norm}`, { reply_markup: mainMenu() });
    }
    return ctx.reply('❌ آیدی عددی بفرست. مثال: -1001234567890');
  }
  if (st.step === 'await_sign') {
    await setSetting('signature', text);
    clearState(ctx.from.id);
    return ctx.reply(`✅ امضا ثبت شد: ${text}`, { reply_markup: mainMenu() });
  }
  if (st.step === 'await_interval') {
    const n = parseInt(norm.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)), 10);
    if (n >= 1 && n <= 30) {
      await setSetting('interval_min', n);
      clearState(ctx.from.id);
      return ctx.reply(`✅ فاصله انتشار: هر ${n} دقیقه`, { reply_markup: mainMenu() });
    }
    return ctx.reply('❌ عدد بین ۱ تا ۳۰ بفرست.');
  }
});

// ---------- cron: scan every 2 min, publish tick every 30s ----------
cron.schedule('*/2 * * * *', async () => {
  try {
    const r = await scanOnce();
    console.log('scan:', JSON.stringify(r));
  } catch (e) {
    console.error('scan error:', e.message);
  }
});

cron.schedule('*/30 * * * * *', async () => {
  try {
    await publishTick();
  } catch (e) {
    console.error('publish error:', e.message);
  }
});

// ---------- errors ----------
bot.catch((err) => console.error('Bot error:', err?.message || err));
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e?.message || e));

// ---------- web server + webhook ----------
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('🤖 News manager alive!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Health on ${PORT}`));

async function startBot() {
  console.log('🚀 News manager starting...');
  const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
  if (WEBHOOK_URL) {
    const { webhookCallback } = require('grammy');
    const secretPath = process.env.WEBHOOK_SECRET || 'telegram-webhook';
    app.use(`/${secretPath}`, webhookCallback(bot, 'express'));
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, '')}/${secretPath}`;
    try {
      await bot.api.setWebhook(fullUrl, { drop_pending_updates: false });
      console.log('✅ WEBHOOK mode:', fullUrl);
    } catch (e) {
      console.error('webhook failed, polling:', e.message);
      bot.start();
    }
  } else {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {}
    bot.start({ onStart: (i) => console.log(`✅ polling @${i.username}`) });
  }
}

startBot();

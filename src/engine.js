// Scan sources with user account → AI review → queue/publish with bot to channel
const crypto = require('crypto');
const { Api } = require('telegram');
const { InputFile } = require('grammy');
const { getUserClient } = require('./userclient');
const { reviewNews } = require('./ai');
const { getSetting, setSetting, hasHash, addHash, queueAdd, queueNext, queueMarkSent } = require('./store');

let botRef = null;
function setBot(bot) {
  botRef = bot;
}

function normHash(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/[@#_*"']/g, '').trim().slice(0, 300);
}
function hashOf(s) {
  return crypto.createHash('sha256').update(normHash(s)).digest('hex');
}

function isObviousAd(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  const adWords = ['تبلیغات', 'تبلیغ', 'خرید', 'فروش ویژه', 'تخفیف', 'عضویت', 'join', 'promo', 'vpn', 'فیلترشکن'];
  const hitWords = adWords.filter((w) => text.includes(w) || t.includes(w)).length;
  const hasLink = /(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(text);
  if (text.length < 30) return true;
  if (hasLink && hitWords > 0) return true;
  return false;
}

async function resolveSource(client, src) {
  const s = String(src).trim();
  if (s.startsWith('http')) {
    const m = s.match(/t\.me\/\+(.+)/);
    if (m) {
      try {
        const upd = await client.invoke(new Api.messages.ImportChatInvite({ hash: m[1] }));
        if (upd && upd.chats && upd.chats[0]) return upd.chats[0];
      } catch (e) {
        // maybe already joined
      }
    }
    return s;
  }
  return s;
}

function buildFinalText(aiText, breaking, signature) {
  const head = breaking ? '🔴 #خبر_فوری' : '🔵 #خبر';
  return `${head}\n\n${aiText}\n\n${signature}`;
}

async function scanOnce() {
  const running = await getSetting('running');
  if (!running) return { scanned: 0, queued: 0, published: 0, note: 'paused' };
  const client = await getUserClient();
  if (!client) return { scanned: 0, queued: 0, published: 0, note: 'no_session' };

  const sources = (await getSetting('sources')) || [];
  const signature = (await getSetting('signature')) || '';
  const lastScan = (await getSetting('last_scan')) || {};
  const dest = await getSetting('dest_channel');

  let scanned = 0;
  let queued = 0;
  let published = 0;
  const nowMin = Date.now() - 20 * 60 * 1000;

  for (const src of sources) {
    try {
      const entity = await resolveSource(client, src);
      const msgs = await client.getMessages(entity, { limit: 15 });
      for (const m of msgs) {
        try {
          if (!m || !m.message || typeof m.message !== 'string') continue;
          if ((m.date || 0) * 1000 < nowMin) continue;
          const key = String(src) + ':' + String(m.id);
          if (lastScan[key]) continue;
          lastScan[key] = 1;
          scanned++;

          const raw = m.message.trim();
          if (isObviousAd(raw)) continue;
          const h = hashOf(raw);
          if (await hasHash(h)) continue;

          const verdict = await reviewNews(raw);
          await addHash(h);
          if (!verdict.publish) continue;

          const finalText = buildFinalText(verdict.text, verdict.breaking, signature);
          if (verdict.breaking) {
            await publishNow(dest, finalText, m);
            published++;
          } else {
            await queueAdd(String(src), m.id, finalText);
            queued++;
          }
        } catch (e) {
          console.error('msg error:', e.message);
        }
      }
    } catch (e) {
      console.error('source error', String(src), e.message);
    }
  }

  await setSetting('last_scan', lastScan);
  return { scanned, queued, published, note: 'ok' };
}

async function publishNow(dest, text, srcMsg) {
  if (!botRef) return;
  const sendPhoto = await getSetting('send_photo');
  const sendVideo = await getSetting('send_video');
  try {
    if (srcMsg && srcMsg.media && (sendPhoto || sendVideo)) {
      const isPhoto = srcMsg.photo || (srcMsg.media && srcMsg.media.className === 'MessageMediaPhoto');
      const isVideo = srcMsg.video || (srcMsg.media && srcMsg.media.className === 'MessageMediaDocument' && srcMsg.media.document && (srcMsg.media.document.mimeType || '').startsWith('video'));
      if ((isPhoto && sendPhoto) || (isVideo && sendVideo)) {
        const client = await getUserClient();
        if (client) {
          const buf = await client.downloadMedia(srcMsg, {});
          if (buf && buf.length < 45 * 1024 * 1024) {
            if (isPhoto) {
              await botRef.api.sendPhoto(dest, { source: buf }, { caption: text });
              await setSetting('last_publish_at', Date.now());
              return;
            }
            if (isVideo) {
              await botRef.api.sendVideo(dest, { source: buf }, { caption: text });
              await setSetting('last_publish_at', Date.now());
              return;
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('media publish failed, fallback text:', e.message);
  }
  await botRef.api.sendMessage(dest, text);
  await setSetting('last_publish_at', Date.now());
}

async function publishTick() {
  const running = await getSetting('running');
  if (!running || !botRef) return null;
  const intervalMin = (await getSetting('interval_min')) || 2;
  const lastAt = (await getSetting('last_publish_at')) || 0;
  if (Date.now() - lastAt < intervalMin * 60 * 1000) return null;
  const next = await queueNext();
  if (!next) return null;
  const dest = await getSetting('dest_channel');
  const client = await getUserClient();
  let srcMsg = null;
  if (client) {
    try {
      const entity = await resolveSource(client, next.source);
      const msgs = await client.getMessages(entity, { ids: [next.msg_id] });
      if (msgs && msgs[0]) srcMsg = msgs[0];
    } catch (e) {}
  }
  await publishNow(dest, next.text, srcMsg);
  await queueMarkSent(next.id);
  return next.id;
}

module.exports = { setBot, scanOnce, publishTick };

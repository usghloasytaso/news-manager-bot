// MTProto user client (gramjs): QR login, session persist in Supabase
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { getSetting, setSetting } = require('./store');

const apiId = parseInt(process.env.API_ID || '0', 10);
const apiHash = process.env.API_HASH || '';

let userClient = null;
// In-memory login flows: userId -> { client, phone, phoneCodeHash }
const loginFlows = new Map();

async function getUserClient() {
  if (userClient) {
    try {
      if (!userClient.connected) await userClient.connect();
    } catch (e) {}
    return userClient;
  }
  const sessionStr = await getSetting('session');
  if (!sessionStr) return null;
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  userClient = client;
  return client;
}

function dropUserClient() {
  userClient = null;
}

async function startLoginFlow(userId, phone) {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  const res = await client.sendCode({ apiId, apiHash }, phone);
  loginFlows.set(String(userId), { client, phone, phoneCodeHash: res.phoneCodeHash });
  return true;
}

function getLoginFlow(userId) {
  return loginFlows.get(String(userId));
}

function clearLoginFlow(userId) {
  const f = loginFlows.get(String(userId));
  if (f) {
    try { f.client.disconnect(); } catch (e) {}
    loginFlows.delete(String(userId));
  }
}

async function confirmLoginCode(userId, code) {
  const flow = getLoginFlow(userId);
  if (!flow) throw new Error('NO_FLOW');
  try {
    await flow.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: flow.phone,
        phoneCodeHash: flow.phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (e) {
    if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') throw new Error('NEED_PASSWORD');
    throw e;
  }
  const sessionStr = flow.client.session.save();
  await setSetting('session', sessionStr);
  try { await flow.client.disconnect(); } catch (e) {}
  loginFlows.delete(String(userId));
  userClient = null;
  return true;
}

async function confirmLoginPassword(userId, password) {
  const flow = getLoginFlow(userId);
  if (!flow) throw new Error('NO_FLOW');
  const { computeCheck } = require('telegram/Password');
  const pwd = await flow.client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(pwd, password);
  await flow.client.invoke(new Api.auth.CheckPassword({ password: check }));
  const sessionStr = flow.client.session.save();
  await setSetting('session', sessionStr);
  try { await flow.client.disconnect(); } catch (e) {}
  loginFlows.delete(String(userId));
  userClient = null;
  return true;
}

async function logoutSession() {
  await setSetting('session', '');
  dropUserClient();
}

// ---------- QR login (no code typing, safe inside Telegram) ----------
const QRCode = require('qrcode');
const qrFlows = new Map(); // userId -> { client, loginPromise, passwordResolve }

async function beginQrLogin(userId, onPasswordNeeded) {
  cancelQr(userId);
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  let resolvePng;
  const pngPromise = new Promise((r) => (resolvePng = r));
  const flow = { client, loginPromise: null, passwordResolve: null };
  qrFlows.set(String(userId), flow);
  flow.loginPromise = client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async (qr) => {
        const url = 'tg://login?token=' + qr.token.toString('base64url');
        const png = await QRCode.toBuffer(url, { width: 400 });
        resolvePng(png);
      },
      password: async () => {
        return new Promise((resolve) => {
          flow.passwordResolve = resolve;
          if (onPasswordNeeded) onPasswordNeeded();
        });
      },
      onError: (e) => {
        throw e;
      },
    }
  );
  const png = await pngPromise;
  return png;
}

async function waitQrLogin(userId) {
  const flow = qrFlows.get(String(userId));
  if (!flow) throw new Error('NO_QR_FLOW');
  await flow.loginPromise;
  const sessionStr = flow.client.session.save();
  await setSetting('session', sessionStr);
  const check = await getSetting('session');
  try {
    await flow.client.disconnect();
  } catch (e) {}
  qrFlows.delete(String(userId));
  userClient = null;
  if (!check) throw new Error('SAVE_FAILED');
  return true;
}

function resolveQrPassword(userId, pw) {
  const flow = qrFlows.get(String(userId));
  if (flow && flow.passwordResolve) {
    flow.passwordResolve(pw);
    flow.passwordResolve = null;
    return true;
  }
  return false;
}

function hasQrFlow(userId) {
  return qrFlows.has(String(userId));
}

function cancelQr(userId) {
  const flow = qrFlows.get(String(userId));
  if (flow) {
    try {
      flow.client.disconnect();
    } catch (e) {}
    qrFlows.delete(String(userId));
  }
}

module.exports = {
  getUserClient,
  dropUserClient,
  startLoginFlow,
  getLoginFlow,
  clearLoginFlow,
  confirmLoginCode,
  confirmLoginPassword,
  logoutSession,
  beginQrLogin,
  waitQrLogin,
  resolveQrPassword,
  hasQrFlow,
  cancelQr,
};

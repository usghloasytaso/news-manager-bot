// MTProto user client (gramjs): login with code, session persist in Supabase
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

module.exports = {
  getUserClient,
  dropUserClient,
  startLoginFlow,
  getLoginFlow,
  clearLoginFlow,
  confirmLoginCode,
  confirmLoginPassword,
  logoutSession,
};

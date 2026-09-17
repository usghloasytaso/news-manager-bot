// Simple key-value + queue + dedupe storage on Supabase
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DEFAULTS = {
  session: '',
  owner_id: '',
  dest_channel: '-1004484817471',
  signature: '@iran_jahan_lahze',
  sources: [
    '@Middle_East_Spectator',
    '@iran_jahan_darlahze',
    '@mrtahlilgar',
    '@SepahMedia',
    '@Alibk3_fa',
    '@Naya_Press',
    '@rahbar_ir',
    '@S0nia10',
    '@iran_charshanbsoriii',
    '@Fighter_Radar',
    '@khabari_18',
    'https://t.me/+amXhpWOf3SVlZGM0'
  ],
  send_photo: true,
  send_video: false,
  interval_min: 2,
  running: false,
  last_publish_at: 0,
  last_scan: {},
};

async function getSetting(key) {
  try {
    const { data, error } = await supabase.from('nm_kv').select('value').eq('key', key).maybeSingle();
    if (!error && data) return data.value;
  } catch (e) {}
  return DEFAULTS[key];
}

async function setSetting(key, value) {
  try {
    await supabase.from('nm_kv').upsert({ key, value }, { onConflict: 'key' });
  } catch (e) {
    console.error('setSetting failed:', e.message);
  }
}

async function hasHash(hash) {
  try {
    const { data } = await supabase.from('nm_hashes').select('hash').eq('hash', hash).maybeSingle();
    return !!data;
  } catch (e) {
    return false;
  }
}

async function addHash(hash) {
  try {
    await supabase.from('nm_hashes').insert({ hash });
  } catch (e) {}
}

async function queueAdd(source, msgId, text) {
  try {
    await supabase.from('nm_queue').insert({ source, msg_id: msgId, text, status: 'pending' });
  } catch (e) {
    console.error('queueAdd failed:', e.message);
  }
}

async function queueNext() {
  try {
    const { data } = await supabase
      .from('nm_queue')
      .select('*')
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .limit(1);
    return data && data[0] ? data[0] : null;
  } catch (e) {
    return null;
  }
}

async function queueMarkSent(id) {
  try {
    await supabase.from('nm_queue').update({ status: 'sent' }).eq('id', id);
  } catch (e) {}
}

async function queueCount() {
  try {
    const { count } = await supabase.from('nm_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    return count || 0;
  } catch (e) {
    return 0;
  }
}

module.exports = {
  supabase,
  DEFAULTS,
  getSetting,
  setSetting,
  hasHash,
  addHash,
  queueAdd,
  queueNext,
  queueMarkSent,
  queueCount,
};

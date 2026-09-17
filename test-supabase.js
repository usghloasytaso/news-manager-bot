const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://fjllvlchahxvvvyszjgd.supabase.co',
  'sb_publishable_IgglrbhrtSFD-UE7cvYiXg_03YRBHIV'
);

(async () => {
  for (const t of ['nm_kv', 'nm_hashes', 'nm_queue']) {
    const { data, error } = await supabase.from(t).select('*').limit(1);
    if (error) {
      console.log(`TABLE '${t}': MISSING (${error.message})`);
    } else {
      console.log(`TABLE '${t}': OK`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('CONN_FAILED:', e.message);
  process.exit(1);
});

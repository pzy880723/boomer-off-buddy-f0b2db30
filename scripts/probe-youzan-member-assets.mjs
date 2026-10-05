import { DatabaseSync } from 'node:sqlite';
import { createReadOnlyYouzan, parsePoints, resolveMappedMember } from './youzan-member-readonly.mjs';

// Bounded, read-only production check. No customer identifiers or balances in output.
const env = process.env;
async function erp(path) {
  const base = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw Error('erp_credentials_missing');
  const response = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`erp_read_${response.status}`);
  return response.json();
}

try {
  const shops = await erp('youzan_shops?select=kdt_id,parent_kdt_id,role,status,access_token,token_expires_at&status=eq.active');
  const heads = shops.filter(s => s.role === 'hq');
  if (heads.length !== 1) throw Error('ambiguous_headquarters');
  const head = heads[0];
  if (!(Date.parse(head.token_expires_at) > Date.now() + 300000)) throw Error('token_needs_refresh');
  const db = new DatabaseSync(env.YOUZAN_MEMBER_LINK_DB || '/var/lib/boomer-off/membership-youzan-links.sqlite', { readOnly: true });
  let links;
  try { links = db.prepare('SELECT customer_id,kdt_id,yz_id FROM member_channel_links LIMIT 6').all(); }
  finally { db.close(); }
  if (!links.length || links.length > 5) throw Error('bounded_probe_requires_one_to_five_mappings');
  const read = createReadOnlyYouzan({ proxyUrl: env.YOUZAN_PROXY_URL, proxyToken: env.YOUZAN_PROXY_TOKEN, accessToken: head.access_token });
  const policy = await read('youzan.scrm.pointdecution.get', '1.0.0', {});
  const rules = await read('youzan.scrm.customer.points.rule.list', '1.0.0', {});
  let verified = 0;
  for (const link of links) {
    const who = resolveMappedMember(shops, links, Number(link.kdt_id), link.yz_id);
    if (!who || !/^[0-9a-f-]{36}$/i.test(who.customerId)) throw Error('trusted_mapping_missing');
    const customers = await erp(`commerce_customers?select=id,status&id=eq.${who.customerId}&status=eq.active`);
    if (customers.length !== 1) throw Error('active_erp_member_missing');
    parsePoints(await read('youzan.crm.customer.points.get', '1.0.0', {
      user: { account_id: who.yzOpenId, account_type: 5 }, is_do_extpoint: false, is_query_points_account_version: true,
    }));
    verified++;
  }
  console.log(JSON.stringify({ ok: true, mode: 'read_only', mappedMembersVerified: verified,
    redemptionPolicyAvailable: policy != null, earningRulesAvailable: rules != null,
    pointsWritten: 0, couponsWritten: 0, localWalletsWritten: 0 }));
} catch (error) {
  const code = String(error.message);
  console.log(JSON.stringify({ ok: false, error: /^[a-z0-9_]+$/.test(code) ? code : 'readonly_probe_failed' }));
  process.exitCode = 1;
}

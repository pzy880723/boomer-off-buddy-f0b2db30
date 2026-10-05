const READS = new Set([
  'youzan.crm.customer.points.get/1.0.0',
  'youzan.scrm.pointdecution.get/1.0.0',
  'youzan.scrm.customer.points.rule.list/1.0.0',
  'youzan.ump.voucher.query.info/1.0.0',
  'youzan.ump.voucheractivity.manage.info.search/1.0.1',
  'youzan.ump.coupon.consume.fetchlogs.get/3.0.2',
]);

export function parsePoints(data) {
  const version = data?.points_account_version;
  if (!Number.isSafeInteger(data?.point) || data.point < 0 ||
    !((typeof version === 'string' && /^\d{1,19}$/.test(version)) ||
      (Number.isSafeInteger(version) && version >= 0))) throw Error('invalid_points_snapshot');
  return { points: data.point, accountVersion: String(version) };
}

export function resolveMappedMember(shops, links, eventKdtId, yzOpenId) {
  if (!Number.isSafeInteger(eventKdtId) || typeof yzOpenId !== 'string' || !yzOpenId) return null;
  const shop = shops.find(s => Number(s.kdt_id) === eventKdtId && s.status === 'active');
  if (!shop) return null;
  const rootId = shop.role === 'hq' ? eventKdtId : Number(shop.parent_kdt_id);
  const head = shops.find(s => Number(s.kdt_id) === rootId && s.role === 'hq' && s.status === 'active');
  if (!head) return null;
  const matches = links.filter(l => [rootId, eventKdtId].includes(Number(l.kdt_id)) && l.yz_id === yzOpenId);
  if (!matches.length || new Set(matches.map(l => l.customer_id)).size !== 1 || !matches[0].customer_id) return null;
  return { customerId: matches[0].customer_id, yzOpenId, headquartersKdtId: rootId };
}

// No direct-network fallback and no mutation methods, even when invoked by a privileged worker.
export function createReadOnlyYouzan({ proxyUrl, proxyToken, accessToken, fetchImpl = fetch }) {
  if (!proxyUrl || !proxyToken) throw Error('fixed_proxy_not_configured');
  if (!accessToken) throw Error('youzan_token_missing');
  return async (method, version, params) => {
    if (!READS.has(`${method}/${version}`)) throw Error('read_method_not_allowed');
    let json;
    try {
      const response = await fetchImpl(proxyUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxyToken}` },
        body: JSON.stringify({
          url: `https://open.youzanyun.com/api/${method}/${version}?access_token=${encodeURIComponent(accessToken)}`,
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
        }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error();
      const envelope = await response.json();
      if (!Number.isInteger(envelope.status) || envelope.status < 200 || envelope.status >= 300) throw Error();
      json = JSON.parse(envelope.body ?? Buffer.from(envelope.bodyBase64 ?? '', 'base64').toString());
    } catch {
      throw Error('youzan_read_unavailable');
    }
    const remoteError = json?.gw_err_resp ?? json?.error_response;
    if (remoteError || json?.success === false || ![0, 200].includes(json?.code)) {
      const code = remoteError?.err_code ?? remoteError?.code ?? json?.code;
      throw Error(`youzan_read_rejected_${Number.isSafeInteger(code) ? code : 'unknown'}`);
    }
    if (!Object.hasOwn(json, 'data') && !Object.hasOwn(json, 'response')) throw Error('youzan_read_invalid');
    return json.data ?? json.response;
  };
}

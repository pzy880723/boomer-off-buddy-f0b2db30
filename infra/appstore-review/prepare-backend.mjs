import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = '/opt/boomer-appstore-review';
const app = '/var/www/boomer-erp/review-41182c7b';
if (existsSync(app)) {
  if (!process.argv.includes('--resume') || existsSync(`${app}/.output`)) throw new Error('Review backend directory exists; refusing replacement');
} else {
  mkdirSync(app, { recursive: true, mode: 0o755 });
  execFileSync('tar', ['-xzf', '/tmp/boomer-review-41182c7b.tar.gz', '-C', app]);
}
// Lovable tracks a frontend .env. Preserve it privately, never run the isolated
// backend with any credentials copied from the source archive.
if (existsSync(`${app}/.env`)) renameSync(`${app}/.env`, `${app}/.env.from-source`);
const env = Object.fromEntries(readFileSync(`${root}/.env`, 'utf8').split('\n').filter(x => x.includes('='))
  .map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; }));
const url = 'https://erp.boomeroff.com/review-data';
const backend = { BOOMER_REVIEW_ISOLATED: 'true', SUPABASE_URL: url,
  SUPABASE_PUBLISHABLE_KEY: env.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY,
  VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: env.ANON_KEY,
  PUBLIC_APP_ORIGIN: 'https://erp.boomeroff.com/review-runtime', STOREFRONT_PAYMENT_MODE: 'disabled',
  HANDHELD_RELEASE_WORKER_ENABLED: 'false', HANDHELD_ITEM_SYNC_WORKER_ENABLED: 'false',
  HANDHELD_LISTING_IMAGE_WORKER_ENABLED: 'false', YOUZAN_STOCK_WORKER_ENABLED: 'false',
  YOUZAN_IMAGE_REFRESH_WORKER_ENABLED: 'false', YOUZAN_ORDER_SYNC_WORKER_ENABLED: 'false',
  YOUZAN_SALE_COMPENSATION_ENABLED: 'false', CHANNEL_SYNC_WORKER_ENABLED: 'false' };
writeFileSync(`${app}/.env`, Object.entries(backend).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
execFileSync('chown', ['-R', 'ubuntu:ubuntu', app]);
console.log(JSON.stringify({ backend_prepared: true, source: '41182c7b', real_channels: 0 }));

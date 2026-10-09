import { readFileSync, renameSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = '/opt/boomer-appstore-review';
if (existsSync(`${root}/account.json`)) throw new Error('Refusing credential rotation after account creation');
renameSync(`${root}/.env`, `${root}/.env.initial-${Date.now()}`);
execFileSync(process.execPath, [`${root}/generate-env.mjs`, root], { stdio: 'ignore' });
const env = Object.fromEntries(readFileSync(`${root}/.env`, 'utf8').trim().split('\n').map(line => {
  const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)];
}));
// Only the new isolated database is targeted. Never alter migration/production roles.
const sql = `SET log_statement = 'none';
ALTER USER authenticator WITH PASSWORD '${env.POSTGRES_PASSWORD}';
ALTER USER supabase_auth_admin WITH PASSWORD '${env.POSTGRES_PASSWORD}';
ALTER USER supabase_storage_admin WITH PASSWORD '${env.POSTGRES_PASSWORD}';
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO '${env.JWT_SECRET}';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO '3600';`;
execFileSync('docker', ['exec', '-i', 'boomer-review-db-1', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, stdio: ['pipe', 'ignore', 'pipe'] });
execFileSync('docker', ['compose', '-f', 'compose.yml', 'up', '-d'], { cwd: root, stdio: 'inherit' });
console.log('Isolated initialization repaired and its initial credentials rotated.');

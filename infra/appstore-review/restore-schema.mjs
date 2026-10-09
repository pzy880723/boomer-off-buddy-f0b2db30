import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const root = '/opt/boomer-appstore-review';
const sql = statement => {
  try { return execFileSync('docker', ['exec', '-i', 'boomer-review-db-1',
    'psql', '-U', 'supabase_admin', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(String(error.stderr).split('\n').find(line => line.startsWith('ERROR:')) || 'Schema restore failed'); }
};
const count = sql("select count(*) from information_schema.tables where table_schema='public';").trim();
if (count !== '0') throw new Error('Review schema is not empty; refusing to overwrite');
if (sql('select count(*) from auth.users;').trim() !== '0') throw new Error('Review Auth is not empty');
sql('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;');
const schema = existsSync(`${root}/public-schema-only.sql`) ? readFileSync(`${root}/public-schema-only.sql`, 'utf8') : execFileSync('docker', ['exec', 'supabase-db', 'pg_dump', '-U', 'postgres',
  '--schema-only', '--schema=public', '--no-owner'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .replace(/^CREATE SCHEMA public;$/m, 'CREATE SCHEMA IF NOT EXISTS public;');
if (!existsSync(`${root}/public-schema-only.sql`)) writeFileSync(`${root}/public-schema-only.sql`, schema, { flag: 'wx', mode: 0o600 });
// pg_dump exports DDL only: no customers, accounts, inventory or scheduled jobs.
sql(`BEGIN;\n${schema}\nCOMMIT;`);
console.log(JSON.stringify({ schema_restored: true, imported_rows: 0,
  public_tables: Number(sql("select count(*) from information_schema.tables where table_schema='public';").trim()) }));

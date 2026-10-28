DO $$ BEGIN
  CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
CREATE EXTENSION pg_trgm SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, phone text, raw_user_meta_data jsonb, raw_app_meta_data jsonb, created_at timestamptz default now());
CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE TABLE storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());

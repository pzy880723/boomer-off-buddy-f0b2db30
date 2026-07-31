import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260731070000_store_development_domain.sql",
  import.meta.url,
);

const prerequisites = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULL::uuid $$;
  CREATE FUNCTION auth.role()
  RETURNS text
  LANGUAGE sql
  STABLE
  AS $$ SELECT 'service_role'::text $$;

  CREATE TYPE public.app_role AS ENUM (
    'super_admin',
    'hq_operator',
    'store_manager',
    'store_staff',
    'warehouse_staff'
  );
  CREATE TABLE public.user_roles (
    user_id uuid NOT NULL REFERENCES auth.users(id),
    role public.app_role NOT NULL,
    PRIMARY KEY (user_id, role)
  );
  CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = _role
    )
  $$;
  CREATE FUNCTION public.tg_set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END
  $$;
  CREATE TABLE public.inv_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('warehouse', 'shop')),
    name text NOT NULL,
    notes text
  );
`;

test("store-development migration applies twice and audits deletes", async () => {
  const database = new PGlite();
  const migration = await readFile(migrationUrl, "utf8");

  try {
    await database.exec(prerequisites);
    await database.exec(migration);
    await database.exec(migration);

    const inserted = await database.query(`
      INSERT INTO public.store_development_projects (
        legacy_id,
        name,
        project_kind,
        status
      ) VALUES (
        'project-test',
        '迁移测试门店',
        'formal',
        'planning'
      )
      RETURNING id
    `);
    const projectId = inserted.rows[0].id;

    await database.query(
      "DELETE FROM public.store_development_projects WHERE id = $1",
      [projectId],
    );

    const audit = await database.query(
      `SELECT action, entity_id
       FROM public.store_development_audit_logs
       WHERE entity_id = $1
       ORDER BY id`,
      [projectId],
    );

    assert.deepEqual(
      audit.rows.map((row) => row.action),
      ["INSERT", "DELETE"],
    );
    assert.equal(audit.rows[1].entity_id, projectId);
  } finally {
    await database.close();
  }
});

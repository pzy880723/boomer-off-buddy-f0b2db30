import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("stock operation migration preserves retries and separates logical requests", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE public.youzan_stock_sync_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, shop_id uuid,
        location_id uuid, target_stock integer NOT NULL DEFAULT 1,
        action text DEFAULT 'push_stock', target_is_display boolean,
        status text DEFAULT 'pending', attempts integer DEFAULT 0, last_error text,
        next_run_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE UNIQUE INDEX active_stock_request ON public.youzan_stock_sync_queue(sku_id, shop_id)
        WHERE status IN ('pending', 'failed');
      CREATE FUNCTION public.tg_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
      CREATE TRIGGER trg_youzan_stock_sync_queue_updated BEFORE UPDATE ON public.youzan_stock_sync_queue
        FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
      INSERT INTO public.youzan_stock_sync_queue DEFAULT VALUES;
    `);
    const migration = await readFile(new URL("../../supabase/migrations/20260927200000_youzan_stock_operation.sql", import.meta.url), "utf8")
      .catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    await db.exec(migration);
    const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'youzan_stock_sync_queue'");
    assert.ok(columns.rows.some((row: any) => row.column_name === "operation_id"), "migration must add operation_id");
    const row = async () => (await db.query<any>("SELECT * FROM public.youzan_stock_sync_queue")).rows[0];
    const initial = (await row()).operation_id;
    assert.match(initial, /^[a-f0-9-]{36}$/);
    for (const change of [
      "status = 'running'", "status = 'failed', attempts = 1, last_error = 'timeout'",
      "status = 'pending', next_run_at = now()", "status = 'running', attempts = 2",
      "status = 'done'",
    ]) {
      await db.exec(`UPDATE public.youzan_stock_sync_queue SET ${change}`);
      assert.equal((await row()).operation_id, initial, change);
    }
    for (const change of [
      "status = 'pending'", "target_stock = 2", "location_id = gen_random_uuid()",
      "action = 'push_is_display'", "target_is_display = true", "shop_id = gen_random_uuid()",
      "sku_id = gen_random_uuid()",
    ]) {
      const old = (await row()).operation_id;
      await db.exec(`UPDATE public.youzan_stock_sync_queue SET ${change}`);
      assert.notEqual((await row()).operation_id, old, change);
    }
    const explicit = "11111111-1111-4111-8111-111111111111";
    await db.query("UPDATE public.youzan_stock_sync_queue SET operation_id = $1, target_stock = 3", [explicit]);
    assert.equal((await row()).operation_id, explicit, "explicit enqueue ID wins even when target changes");
    await db.exec("UPDATE public.youzan_stock_sync_queue SET status = 'cancelled'");
    await db.exec("UPDATE public.youzan_stock_sync_queue SET status = 'pending'");
    assert.notEqual((await row()).operation_id, explicit);

    // Use the DB revision as an opaque string: JS Date loses PostgreSQL microseconds.
    const claim = (await db.query<any>("UPDATE public.youzan_stock_sync_queue SET status = 'running' RETURNING updated_at::text AS version")).rows[0];
    await db.exec("UPDATE public.youzan_stock_sync_queue SET status = 'pending', target_stock = 4");
    await db.exec("UPDATE public.youzan_stock_sync_queue SET status = 'running'");
    const stale = await db.query("UPDATE public.youzan_stock_sync_queue SET status = 'done' WHERE status = 'running' AND updated_at = $1 RETURNING id", [claim.version]);
    assert.equal(stale.rows.length, 0);
    const current = (await db.query<any>("SELECT updated_at::text AS version FROM public.youzan_stock_sync_queue")).rows[0];
    const acknowledged = await db.query("UPDATE public.youzan_stock_sync_queue SET status = 'done' WHERE status = 'running' AND updated_at = $1 RETURNING id", [current.version]);
    assert.equal(acknowledged.rows.length, 1);
    const op = (await row()).operation_id;
    await db.exec(migration);
    assert.equal((await row()).operation_id, op, "migration rerun does not reset operation IDs");
  } finally {
    await db.close();
  }
});

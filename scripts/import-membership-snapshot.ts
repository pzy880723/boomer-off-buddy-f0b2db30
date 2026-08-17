import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LegacyCustomer = { id: string; phone?: string | null };
type ErpCustomer = {
  id: string;
  external_subject?: string | null;
  phone?: string | null;
};
type LegacyOrder = {
  id: string;
  customer_id: string;
  amount_fen: number;
  [key: string]: unknown;
};
type LegacyConsumption = {
  id: string;
  customer_id: string;
  paid_fen: number;
  [key: string]: unknown;
};

export function planMembershipImport(input: {
  legacyCustomers: LegacyCustomer[];
  existingCustomers: ErpCustomer[];
  membershipOrders: LegacyOrder[];
  consumptionRecords: LegacyConsumption[];
}) {
  const customerMap: Record<string, string> = {};
  const quarantine: Array<{
    legacy_customer_id: string;
    reason: string;
    candidate_customer_ids: string[];
  }> = [];
  const customersToCreate: LegacyCustomer[] = [];

  for (const legacy of input.legacyCustomers) {
    const subjectMatches = input.existingCustomers.filter(
      (candidate) => candidate.external_subject === legacy.id,
    );
    const phoneMatches = legacy.phone
      ? input.existingCustomers.filter((candidate) => candidate.phone === legacy.phone)
      : [];
    const candidates = new Set([
      ...subjectMatches.map((candidate) => candidate.id),
      ...phoneMatches.map((candidate) => candidate.id),
    ]);

    if (candidates.size > 1 || subjectMatches.length > 1 || phoneMatches.length > 1) {
      quarantine.push({
        legacy_customer_id: legacy.id,
        reason: "identity_conflict",
        candidate_customer_ids: [...candidates].sort(),
      });
      continue;
    }
    const match = subjectMatches[0] ?? phoneMatches[0];
    if (match) {
      customerMap[legacy.id] = match.id;
    } else {
      customersToCreate.push(legacy);
    }
  }

  const orders = input.membershipOrders
    .filter((row) => customerMap[row.customer_id])
    .map((row) => ({
      ...row,
      customer_id: customerMap[row.customer_id],
      amount_fen: Number(row.amount_fen),
      idempotency_key: `legacy:membership_order:${row.id}`,
    }));
  const consumptionRecords = input.consumptionRecords
    .filter((row) => customerMap[row.customer_id])
    .map((row) => ({
      ...row,
      customer_id: customerMap[row.customer_id],
      paid_fen: Number(row.paid_fen),
      idempotency_key: `legacy:consumption:${row.id}`,
    }));

  return {
    customerMap,
    customersToCreate,
    quarantine,
    orders,
    consumptionRecords,
  };
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function loadMembershipSnapshot(directory: string) {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as {
    format: string;
  };
  if (manifest.format !== "boomer-membership-snapshot-v1") {
    throw new Error("Unsupported membership snapshot format");
  }
  return {
    manifest,
    legacyCustomers: (await readJsonLines(
      resolve(directory, "consumer_accounts.jsonl"),
    )) as LegacyCustomer[],
    membershipOrders: (await readJsonLines(
      resolve(directory, "membership_orders.jsonl"),
    )) as LegacyOrder[],
    consumptionRecords: (await readJsonLines(
      resolve(directory, "consumption_records.jsonl"),
    )) as LegacyConsumption[],
  };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const snapshotDirectory = process.argv[2];
  if (!snapshotDirectory) {
    throw new Error(
      "Usage: import-membership-snapshot.ts <snapshot-directory> <erp-customers.json>",
    );
  }
  const customersPath = process.argv[3];
  if (!customersPath) {
    throw new Error("Dry-run requires an ERP customer export JSON file");
  }
  const snapshot = await loadMembershipSnapshot(resolve(snapshotDirectory));
  const existingCustomers = JSON.parse(
    await readFile(resolve(customersPath), "utf8"),
  ) as ErpCustomer[];
  const plan = planMembershipImport({ ...snapshot, existingCustomers });
  process.stdout.write(`${JSON.stringify({ mode: "dry-run", ...plan }, null, 2)}\n`);
}

-- READ ONLY. Run after preflight confirms commerce_membership_plans exists.
-- No customer/wallet/transaction rows or personal identifiers are returned.
-- to_jsonb permits inspecting new column presence without assuming it is deployed.
SELECT code,tier_code,policy_version,is_active,points_redemption_cap_rate,points_multiplier,
  to_jsonb(p)->'points_redemption_enabled' AS points_redemption_enabled,
  to_jsonb(p)->'points_redemption_points_per_unit' AS points_redemption_points_per_unit,
  to_jsonb(p)->'points_redemption_unit_fen' AS points_redemption_unit_fen,
  to_jsonb(p)->'benefit_rules' AS benefit_rules,
  to_jsonb(p)->'starts_at' AS starts_at,to_jsonb(p)->'ends_at' AS ends_at
FROM public.commerce_membership_plans p ORDER BY code;

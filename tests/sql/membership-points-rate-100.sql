-- User-confirmed 2026-10-05: 100 points = 1 yuan (unit_fen is fen => 100:100), cap_rate stays 1.
-- Only the three named plans; points_redemption_enabled is intentionally untouched.
SELECT set_config('app.plan_change_reason', '用户确认积分兑换比例 100积分=1元 (2026-10-05)', true);
UPDATE public.commerce_membership_plans
SET points_redemption_points_per_unit = 100,
    points_redemption_unit_fen = 100,
    policy_version = policy_version + 1,
    updated_at = now()
WHERE code IN ('free', 'explorer_monthly', 'explorer_annual')
  AND (points_redemption_points_per_unit IS DISTINCT FROM 100
    OR points_redemption_unit_fen IS DISTINCT FROM 100);

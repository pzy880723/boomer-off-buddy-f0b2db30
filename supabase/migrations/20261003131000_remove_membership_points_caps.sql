-- A rate of 1 removes the membership percentage cap; 0 disables redemption.
-- Keep conversion, activation, wallet and minimum-payable safeguards unchanged.
UPDATE public.commerce_membership_plans
SET points_redemption_cap_rate = 1,
    policy_version = policy_version + 1,
    updated_at = now()
WHERE code IN ('free', 'explorer_monthly', 'explorer_annual')
  AND points_redemption_cap_rate IS DISTINCT FROM 1;

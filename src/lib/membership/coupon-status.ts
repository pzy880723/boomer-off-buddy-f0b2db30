// 会员券列表映射（RED 前原样抽出旧逻辑）。
export function mapMembershipCoupon(row: Record<string, unknown>, _now = Date.now()) {
  return {
    id: row.id,
    code: row.code,
    title: row.name,
    face_value_fen: Math.round(Number(row.value) * 100),
    threshold_fen: Math.round(Number(row.min_spend) * 100),
    issued_at: row.created_at,
    expires_at: row.expires_at,
    used_at:
      row.status === "used"
        ? ((row.metadata as Record<string, unknown> | null)?.used_at ?? row.created_at)
        : null,
  } as Record<string, unknown>;
}

/**
 * 门店坐标写入鉴权：仅总部管理员（user_roles.role = super_admin）。
 * 只按服务端认证得到的 userId 查受保护角色表；绝不读取 user_metadata / 客户端 role。
 * hq_operator 不等同管理员。数据库触发器 trg_youzan_shops_coord_guard 是最终防线。
 */
type RolesClient = {
  from: (table: "user_roles") => {
    select: (cols: string) => {
      eq: (col: string, v: string) => PromiseLike<{ data: { role: string }[] | null; error: unknown }>;
    };
  };
};

export const COORD_ADMIN_ROLE = "super_admin";

export function hasCoordFields(data: Record<string, unknown>): boolean {
  return ["latitude", "longitude", "coord_system"].some((k) => data[k] !== undefined);
}

export async function assertCoordWriteAllowed(client: RolesClient, userId: string): Promise<void> {
  if (!userId) throw new Error("门店坐标仅总部管理员可修改");
  const { data, error } = await client.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error("无法确认管理员身份，坐标未保存");
  if (!(data ?? []).some((r) => r.role === COORD_ADMIN_ROLE)) {
    throw new Error("门店坐标仅总部管理员可修改");
  }
}

export function assertUpdatedOneRow(rows: unknown[] | null | undefined): void {
  if (!rows || rows.length !== 1) throw new Error("未保存：门店不存在或无权修改");
}

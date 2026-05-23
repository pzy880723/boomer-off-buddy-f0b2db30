// 有赞订单状态码 -> 中文
// 文档：https://doc.youzanyun.com/
export const YZ_STATUS_TEXT: Record<string, string> = {
  WAIT_BUYER_PAY: "待付款",
  WAIT_SELLER_SEND_GOODS: "待发货",
  WAIT_BUYER_CONFIRM_GOODS: "待收货",
  TRADE_BUYER_SIGNED: "已签收",
  TRADE_SUCCESS: "已完成",
  TRADE_FINISHED: "已完成",
  TRADE_CLOSED: "已关闭",
  TRADE_CLOSED_BY_TAOBAO: "系统关闭",
  TRADE_NO_CREATE_PAY: "未创建",
  PAID: "已付款",
  REFUNDING: "退款中",
  REFUNDED: "已退款",
};

export function yzStatusText(code: string | null | undefined): string {
  if (!code) return "—";
  return YZ_STATUS_TEXT[code] ?? code;
}

// 用于状态筛选下拉
export const YZ_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "WAIT_BUYER_PAY", label: "待付款" },
  { value: "WAIT_SELLER_SEND_GOODS", label: "待发货" },
  { value: "WAIT_BUYER_CONFIRM_GOODS", label: "待收货" },
  { value: "TRADE_SUCCESS", label: "已完成" },
  { value: "TRADE_CLOSED", label: "已关闭" },
  { value: "REFUNDING", label: "退款中" },
  { value: "REFUNDED", label: "已退款" },
];

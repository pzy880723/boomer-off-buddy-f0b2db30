import { fromHeldCartSnapshot, toHeldCartSnapshot } from "@/lib/pos/held-cart";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Banknote,
  Barcode,
  Check,
  ChevronDown,
  CircleUserRound,
  CreditCard,
  History,
  Loader2,
  Minus,
  PackageOpen,
  PauseCircle,
  Percent,
  Plus,
  Printer,
  QrCode,
  ReceiptText,
  RotateCcw,
  ScanLine,
  Search,
  ShoppingBag,
  Tag,
  TicketPercent,
  Trash2,
  UserRoundSearch,
  WalletCards,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAuthSession } from "@/hooks/use-auth-session";
import {
  addScannedProduct,
  posCartLineKey,
  posCartLineLabel,
  validatePosTenders,
  type PosCartLine,
  type PosScannableProduct,
  type PosTender,
} from "@/lib/pos/pos-policy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { StandardCatalogGroup } from "@/lib/pos/standard-catalog";

export const Route = createFileRoute("/pos")({
  head: () => ({
    meta: [
      { title: "门店收银 · BOOMER OFF" },
      { name: "description", content: "BOOMER OFF 自营门店统一收银台" },
    ],
  }),
  component: PosPage,
});

type PosLocation = { id: string; name: string; kind: "warehouse" | "shop" };
type PosRegister = {
  id: string;
  location_id: string;
  code: string;
  name: string;
  receipt_prefix: string;
};
type PosShift = {
  id: string;
  location_id: string;
  register_id: string;
  operator_id: string;
  status: "open" | "closing" | "closed";
  opening_cash: number;
  opened_at: string;
  register?: { name: string; code: string } | null;
};
type BootstrapData = {
  user?: { id: string; email: string | null; roles: string[] };
  locations: PosLocation[];
  registers: PosRegister[];
  open_shifts: PosShift[];
};
type LookupProduct = PosScannableProduct & {
  sku_code: string | null;
  barcode: string | null;
  epc: string | null;
  condition_grade: string | null;
  image_url: string | null;
  location_id: string;
  sale_ownership: "owned" | "consigned" | "vendor" | "trade_in";
  discount_eligible: boolean;
};
type PosCustomer = {
  id: string;
  phone: string | null;
  nickname: string | null;
  avatar_url: string | null;
  wallet?: { points: number; store_credit: number; member_level: string };
};
type CustomerBenefits = {
  customer: PosCustomer;
  wallet: { points: number; store_credit: number; member_level: string };
  coupons: Array<{
    id: string;
    code: string;
    name: string;
    discount_type: "amount" | "percentage";
    value: number;
    min_spend: number;
  }>;
};
type PosDiscount = {
  type: "amount" | "percentage" | "final_price";
  value: number;
  reason: string;
};
type DiscountPreview = {
  subtotal: number;
  eligible_total: number;
  excluded_total: number;
  discount_total: number;
  payable_total: number;
  requires_authorization: boolean;
  authorization_rule: string | null;
};
type HeldCart = {
  id: string;
  customer_id: string | null;
  note: string | null;
  discount_snapshot: PosDiscount | Record<string, never>;
  benefit_snapshot: Record<string, unknown>;
  held_at: string;
  pos_held_cart_items: Array<{
    sku_id: string;
    quantity: number;
    price_snapshot: number;
    ownership_snapshot: LookupProduct["sale_ownership"];
    discount_eligible: boolean;
    category_code: string | null;
    category_name_snapshot: string | null;
    subcategory_code: string | null;
    subcategory_name_snapshot: string | null;
  }>;
};
type PosOrder = {
  id: string;
  order_no: string;
  total_amount: number;
  paid_at: string;
  commerce_order_items: Array<{
    id: string;
    sku_id: string;
    title_snapshot: string;
    quantity: number;
    line_total: number;
    epc: string | null;
  }>;
};
type ReceiptData = {
  order_id: string;
  order_no: string;
  receipt_no: string;
  location_name: string;
  total_amount: number;
  subtotal: number;
  discount_total: number;
  paid_at: string;
  items: Array<{
    sku_id: string;
    title_snapshot: string;
    unit_price: number;
    quantity: number;
    line_total: number;
  }>;
  payments: Array<{
    provider: PosTender["provider"];
    amount: number;
    provider_transaction_id: string | null;
  }>;
};
type CashMovementData = {
  opening_cash: number;
  balance: number;
  items: Array<{
    id: string;
    type: "opening" | "sale" | "refund" | "cash_in" | "cash_out" | "closing_adjustment";
    amount: number;
    reason: string | null;
    order_id: string | null;
    created_at: string;
  }>;
};
type ApiResponse<T> =
  | { ok: true; data: T; replayed?: boolean }
  | { ok: false; message?: string; error?: string; code?: string };

const paymentOptions: Array<{
  value: PosTender["provider"];
  label: string;
  icon: typeof Banknote;
}> = [
  { value: "cash", label: "现金", icon: Banknote },
  { value: "wechat", label: "微信", icon: QrCode },
  { value: "alipay", label: "支付宝", icon: WalletCards },
  { value: "bank_card", label: "银行卡", icon: CreditCard },
  { value: "manual", label: "其他", icon: CircleUserRound },
];

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(value);
}

async function posRequest<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { ok: false, message: `接口返回异常（HTTP ${response.status}）` };
  }
  const body = (await response.json()) as ApiResponse<T>;
  if (!response.ok && body.ok) return { ok: false, message: `请求失败（HTTP ${response.status}）` };
  return body;
}

function PosPage() {
  const { session } = useAuthSession();
  const token = session?.access_token ?? "";
  const scanRef = useRef<HTMLInputElement>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [cart, setCart] = useState<PosCartLine[]>([]);
  const [productMeta, setProductMeta] = useState<Record<string, LookupProduct>>({});
  const [scanCode, setScanCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(true);
  const [standardGroups, setStandardGroups] = useState<StandardCatalogGroup[]>([]);
  const [standardLoading, setStandardLoading] = useState(false);
  const [activeCategoryCode, setActiveCategoryCode] = useState<string | null>(null);
  const [activeSubcategory, setActiveSubcategory] = useState<{
    code: string;
    name: string;
  } | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseProducts, setBrowseProducts] = useState<LookupProduct[]>([]);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [cashDialog, setCashDialog] = useState(false);
  const [cashMode, setCashMode] = useState<"cash_out" | "cash_in">("cash_out");
  const [cashAmount, setCashAmount] = useState("");
  const [cashReason, setCashReason] = useState("");
  const [cashSummary, setCashSummary] = useState<CashMovementData | null>(null);
  const [cashLoading, setCashLoading] = useState(false);
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [tenders, setTenders] = useState<PosTender[]>([]);
  const [paying, setPaying] = useState(false);
  const [saleResult, setSaleResult] = useState<Record<string, unknown> | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [receiptDialog, setReceiptDialog] = useState(false);
  const [memberDialog, setMemberDialog] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberResults, setMemberResults] = useState<PosCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<PosCustomer | null>(null);
  const [customerBenefits, setCustomerBenefits] = useState<CustomerBenefits | null>(null);
  const [discountDialog, setDiscountDialog] = useState(false);
  const [discount, setDiscount] = useState<PosDiscount>({
    type: "amount",
    value: 0,
    reason: "",
  });
  const [discountPreview, setDiscountPreview] = useState<DiscountPreview | null>(null);
  const [discountLoading, setDiscountLoading] = useState(false);
  const [heldDialog, setHeldDialog] = useState(false);
  const [heldCarts, setHeldCarts] = useState<HeldCart[]>([]);
  const [heldLoading, setHeldLoading] = useState(false);
  const [ordersDialog, setOrdersDialog] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  async function ensureAutomaticShift(locationId: string) {
    const result = await posRequest<PosShift>("/api/public/pos/shifts/open", token, {
      method: "POST",
      body: JSON.stringify({
        location_id: locationId,
        register_code: `POS-${locationId.slice(0, 6).toUpperCase()}`,
        register_name: "门店收银机",
      }),
    });
    if (!result.ok) {
      toast.error(result.message ?? "收银台自动启用失败");
      return null;
    }
    return result.data;
  }

  async function loadBootstrap() {
    if (!token) return;
    setLoading(true);
    const result = await posRequest<BootstrapData>("/api/public/pos/bootstrap", token);
    if (!result.ok) {
      toast.error(result.message ?? result.error ?? "收银台初始化失败");
      setBootstrap(null);
      setLoading(false);
      return;
    }
    const nextLocationId =
      result.data.open_shifts[0]?.location_id ||
      (selectedLocationId &&
      result.data.locations.some((location) => location.id === selectedLocationId)
        ? selectedLocationId
        : result.data.locations[0]?.id) ||
      "";
    let nextBootstrap = result.data;
    const existingShift = result.data.open_shifts.find(
      (shift) => shift.location_id === nextLocationId && shift.status !== "closed",
    );
    if (nextLocationId && !existingShift) {
      setShiftLoading(true);
      const shift = await ensureAutomaticShift(nextLocationId);
      setShiftLoading(false);
      if (shift) {
        nextBootstrap = {
          ...result.data,
          open_shifts: [...result.data.open_shifts, shift],
        };
      }
    }
    setBootstrap(nextBootstrap);
    setSelectedLocationId(nextLocationId);
    setLoading(false);
    window.setTimeout(() => scanRef.current?.focus(), 80);
  }

  useEffect(() => {
    void loadBootstrap();
    // Bootstrap only when the authenticated session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const activeShift = useMemo(
    () =>
      bootstrap?.open_shifts.find(
        (shift) => shift.location_id === selectedLocationId && shift.status !== "closed",
      ) ?? null,
    [bootstrap, selectedLocationId],
  );
  const selectedLocation = bootstrap?.locations.find(
    (location) => location.id === selectedLocationId,
  );
  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.unit_price * line.quantity, 0),
    [cart],
  );
  const discountTotal = discountPreview?.discount_total ?? 0;
  const total = discountPreview?.payable_total ?? subtotal;
  const itemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);
  const activeGroup = useMemo(
    () => standardGroups.find((group) => group.category_code === activeCategoryCode) ?? null,
    [standardGroups, activeCategoryCode],
  );

  useEffect(() => {
    if (activeShift && selectedLocationId) {
      void loadProductBrowser();
      void loadStandardCatalog();
    }
    // Refresh the local product shelf only when the active cashier context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShift?.id, selectedLocationId]);

  function playAcceptedTone() {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.04;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.08);
    } catch {
      // Sound is an enhancement; the visual result remains authoritative.
    }
  }

  async function loadStandardCatalog() {
    if (!selectedLocationId) return;
    setStandardLoading(true);
    const result = await posRequest<{ groups: StandardCatalogGroup[] }>(
      `/api/public/pos/standard-catalog?location_id=${encodeURIComponent(selectedLocationId)}`,
      token,
    );
    setStandardLoading(false);
    if (!result.ok) {
      setStandardGroups([]);
      return;
    }
    setStandardGroups(result.data.groups);
  }

  function addStandardPrice(group: StandardCatalogGroup, price: { sku_id: string; price: number }) {
    addProduct({
      sku_id: price.sku_id,
      product_type: "standard",
      name: group.category_name,
      unit_price: price.price,
      available_qty: 9999,
      is_unlimited_stock: true,
      image_url: null,
      barcode: null,
      sku_code: null,
      sale_ownership: null,
      category_code: group.category_code,
      category_name: group.category_name,
      subcategory_code: activeSubcategory?.code ?? null,
      subcategory_name: activeSubcategory?.name ?? null,
    } as unknown as LookupProduct);
    setActiveSubcategory(null);
  }

  function addProduct(product: LookupProduct) {
    try {
      setCart((current) => addScannedProduct(current, product));
      setProductMeta((current) => ({ ...current, [product.sku_id]: product }));
      setDiscountPreview(null);
      playAcceptedTone();
      toast.success(`${product.name} 已加入购物车`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("already")) toast.warning("孤品已经在购物车中，不会重复加入");
      else if (message.includes("stock")) toast.warning("可售库存不足");
      else toast.error("商品无法加入购物车");
    }
  }

  async function scanProduct() {
    const code = scanCode.trim();
    if (!code) return;
    if (!activeShift || !selectedLocationId) {
      toast.error("收银台正在初始化，请稍候");
      return;
    }
    setScanning(true);
    const result = await posRequest<
      | { code_type: "product"; product: LookupProduct }
      | { code_type: "customer"; customer: PosCustomer }
      | {
          code_type: "coupon";
          coupon: {
            customer_id: string;
            name: string;
            discount_type: "amount" | "percentage";
            value: number;
          };
        }
    >(
      `/api/public/pos/resolve-code?code=${encodeURIComponent(code)}&location_id=${encodeURIComponent(selectedLocationId)}`,
      token,
    );
    setScanning(false);
    setScanCode("");
    scanRef.current?.focus();
    if (!result.ok) {
      toast.error(result.message ?? "未找到可售商品");
      return;
    }
    if (result.data.code_type === "product") {
      addProduct(result.data.product);
      return;
    }
    if (result.data.code_type === "customer") {
      await selectCustomer(result.data.customer);
      toast.success("会员已识别");
      return;
    }
    setDiscount({
      type: result.data.coupon.discount_type,
      value: Number(result.data.coupon.value),
      reason: `优惠券：${result.data.coupon.name}`,
    });
    setDiscountDialog(true);
    toast.success("优惠券已识别，请确认优惠");
  }

  async function searchMembers() {
    const query = memberQuery.trim();
    if (query.length < 2) {
      toast.warning("请输入至少 2 位手机号或会员名称");
      return;
    }
    setMemberLoading(true);
    const result = await posRequest<{ items: PosCustomer[] }>(
      `/api/public/pos/customers/search?q=${encodeURIComponent(query)}`,
      token,
    );
    setMemberLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "会员查询失败");
      return;
    }
    setMemberResults(result.data.items);
  }

  async function selectCustomer(customer: PosCustomer) {
    const result = await posRequest<CustomerBenefits>(
      `/api/public/pos/customers/${encodeURIComponent(customer.id)}/benefits`,
      token,
    );
    if (!result.ok) {
      toast.error(result.message ?? "会员权益读取失败");
      return;
    }
    setSelectedCustomer({ ...customer, wallet: result.data.wallet });
    setCustomerBenefits(result.data);
    setMemberDialog(false);
  }

  async function previewDiscount(nextDiscount = discount) {
    if (!selectedLocationId || cart.length === 0) return;
    if (!nextDiscount.reason.trim()) {
      toast.warning("请填写优惠原因");
      return;
    }
    setDiscountLoading(true);
    const result = await posRequest<DiscountPreview>("/api/public/pos/discounts/preview", token, {
      method: "POST",
      body: JSON.stringify({
        location_id: selectedLocationId,
        items: cart.map((line) => ({ sku_id: line.sku_id, quantity: line.quantity })),
        discount: nextDiscount,
      }),
    });
    setDiscountLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "当前优惠不可用");
      return;
    }
    if (result.data.requires_authorization) {
      toast.warning(result.data.authorization_rule ?? "该优惠需要店长授权");
    }
    setDiscountPreview(result.data);
    setDiscountDialog(false);
  }

  async function holdCart() {
    if (!activeShift || cart.length === 0) return;
    const result = await posRequest<{ id: string }>("/api/public/pos/carts/hold", token, {
      method: "POST",
      body: JSON.stringify({
        shift_id: activeShift.id,
        client_op_id: crypto.randomUUID(),
        customer_id: selectedCustomer?.id ?? null,
        items: cart.map((line) => ({
          sku_id: line.sku_id,
          quantity: line.quantity,
          ...toHeldCartSnapshot(line),
        })),
        discount_snapshot: discountPreview ? discount : {},
        benefit_snapshot: customerBenefits ?? {},
      }),
    });
    if (!result.ok) {
      toast.error(result.message ?? "挂单失败");
      return;
    }
    setCart([]);
    setProductMeta({});
    setSelectedCustomer(null);
    setCustomerBenefits(null);
    setDiscountPreview(null);
    toast.success("已挂单，可随时从挂单列表取回");
  }

  async function loadHeldCarts() {
    if (!selectedLocationId) return;
    setHeldDialog(true);
    setHeldLoading(true);
    const result = await posRequest<{ items: HeldCart[] }>(
      `/api/public/pos/carts/held?location_id=${encodeURIComponent(selectedLocationId)}`,
      token,
    );
    setHeldLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "挂单列表加载失败");
      return;
    }
    setHeldCarts(result.data.items);
  }

  async function resumeHeldCart(held: HeldCart) {
    const result = await posRequest<HeldCart>(
      `/api/public/pos/carts/${encodeURIComponent(held.id)}/resume`,
      token,
      { method: "POST", body: "{}" },
    );
    if (!result.ok) {
      toast.error(result.message ?? "取单失败");
      return;
    }
    const items = result.data.pos_held_cart_items;
    const products: LookupProduct[] = [];
    for (const item of items) {
      const lookup = await posRequest<LookupProduct>(
        `/api/public/pos/products/lookup?code=${encodeURIComponent(item.sku_id)}&location_id=${encodeURIComponent(selectedLocationId)}`,
        token,
      );
      if (lookup.ok) products.push(lookup.data);
    }
    const resumedCart = items.flatMap((heldItem) => {
      const product = products.find((item) => item.sku_id === heldItem.sku_id);
      if (!product) return [];
      return [
        {
          ...product,
          quantity: heldItem.quantity ?? 1,
          ...fromHeldCartSnapshot(heldItem, product),
        },
      ];
    });
    setCart(resumedCart);
    setProductMeta(Object.fromEntries(products.map((product) => [product.sku_id, product])));
    const heldDiscount = result.data.discount_snapshot as PosDiscount;
    if (heldDiscount?.type) {
      setDiscount(heldDiscount);
      await previewDiscount(heldDiscount);
    }
    setHeldDialog(false);
    toast.success("挂单已取回");
  }

  async function searchOrders() {
    if (!selectedLocationId) return;
    setOrdersLoading(true);
    const result = await posRequest<{ items: PosOrder[] }>(
      `/api/public/pos/orders/search?location_id=${encodeURIComponent(selectedLocationId)}&q=${encodeURIComponent(orderQuery.trim())}`,
      token,
    );
    setOrdersLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "订单查询失败");
      return;
    }
    setOrders(result.data.items);
  }

  async function returnWholeOrder(order: PosOrder) {
    if (!activeShift) return;
    const reason = window.prompt("请输入退货原因");
    if (!reason?.trim()) return;
    const result = await posRequest<Record<string, unknown>>(
      `/api/public/pos/orders/${encodeURIComponent(order.id)}/returns`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          shift_id: activeShift.id,
          client_op_id: crypto.randomUUID(),
          reason,
          items: order.commerce_order_items.map((item) => ({
            order_item_id: item.id,
            quantity: item.quantity,
          })),
        }),
      },
    );
    if (!result.ok) {
      toast.error(result.message ?? "退货失败");
      return;
    }
    toast.success("退货已登记；孤品将进入验货流程");
    await searchOrders();
  }

  async function loadProductBrowser() {
    if (!activeShift || !selectedLocationId) {
      toast.error("收银台正在初始化，请稍候");
      return;
    }
    setBrowseOpen(true);
    setBrowseLoading(true);
    const result = await posRequest<{ items: LookupProduct[] }>(
      `/api/public/pos/products?location_id=${encodeURIComponent(selectedLocationId)}&q=${encodeURIComponent(scanCode.trim())}`,
      token,
    );
    setBrowseLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "商品加载失败");
      return;
    }
    setBrowseProducts(result.data.items);
  }

  async function loadReceipt(orderId: string) {
    const result = await posRequest<ReceiptData>(
      `/api/public/pos/sales/${encodeURIComponent(orderId)}/receipt`,
      token,
    );
    if (!result.ok) {
      toast.error(result.message ?? "小票加载失败");
      return;
    }
    setReceipt(result.data);
    setReceiptDialog(true);
  }

  async function printReceipt() {
    if (!receipt) return;
    await posRequest<{ print_count: number }>(
      `/api/public/pos/sales/${encodeURIComponent(receipt.order_id)}/receipt`,
      token,
      { method: "POST", body: "{}" },
    );
    window.print();
  }

  async function shareElectronicReceipt() {
    if (!receipt) return;
    const text = [
      "BOOMER OFF 电子小票",
      receipt.location_name,
      `订单号：${receipt.order_no}`,
      `实收：${money(receipt.total_amount)}`,
      `时间：${new Date(receipt.paid_at).toLocaleString("zh-CN")}`,
    ].join("\n");
    try {
      if (navigator.share) {
        await navigator.share({ title: "BOOMER OFF 电子小票", text });
      } else {
        await navigator.clipboard.writeText(text);
        toast.success("电子小票内容已复制");
      }
    } catch {
      // The user may cancel the native share sheet.
    }
  }

  function updateQuantity(lineKey: string, nextQuantity: number) {
    setDiscountPreview(null);
    setCart((current) =>
      current.flatMap((line) => {
        if (posCartLineKey(line) !== lineKey) return [line];
        if (nextQuantity <= 0) return [];
        if (line.product_type === "custom" && nextQuantity > 1) {
          toast.warning("孤品每单只能销售 1 件");
          return [line];
        }
        if (!line.is_unlimited_stock && nextQuantity > line.available_qty) {
          toast.warning("数量不能超过当前可售库存");
          return [line];
        }
        return [{ ...line, quantity: nextQuantity }];
      }),
    );
  }

  async function switchLocation(locationId: string) {
    if (cart.length > 0) {
      toast.warning("请先清空当前购物车再切换库位");
      return;
    }
    setSelectedLocationId(locationId);
    const existing = bootstrap?.open_shifts.find(
      (shift) => shift.location_id === locationId && shift.status !== "closed",
    );
    if (existing) return;

    setShiftLoading(true);
    const shift = await ensureAutomaticShift(locationId);
    setShiftLoading(false);
    if (!shift) return;
    setBootstrap((current) =>
      current
        ? {
            ...current,
            open_shifts: [
              ...current.open_shifts.filter(
                (item) => item.location_id !== locationId || item.status === "closed",
              ),
              shift,
            ],
          }
        : current,
    );
  }

  async function loadCashDrawer() {
    if (!activeShift) {
      toast.error("收银台正在初始化，请稍候");
      return;
    }
    setCashDialog(true);
    setCashLoading(true);
    const result = await posRequest<CashMovementData>(
      `/api/public/pos/cash-movements?shift_id=${encodeURIComponent(activeShift.id)}`,
      token,
    );
    setCashLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "钱箱记录读取失败");
      return;
    }
    setCashSummary(result.data);
  }

  async function recordCashMovement() {
    if (!activeShift) return;
    const amount = Number(cashAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.warning("请输入正确的现金金额");
      return;
    }
    if (!cashReason.trim()) {
      toast.warning("请填写现金变动原因");
      return;
    }
    setCashLoading(true);
    const result = await posRequest<Record<string, unknown>>(
      "/api/public/pos/cash-movements",
      token,
      {
        method: "POST",
        body: JSON.stringify({
          shift_id: activeShift.id,
          type: cashMode,
          amount,
          reason: cashReason.trim(),
        }),
      },
    );
    setCashLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "钱箱登记失败");
      return;
    }
    toast.success(cashMode === "cash_out" ? "现金取出已记录" : "现金补入已记录");
    setCashAmount("");
    setCashReason("");
    await loadCashDrawer();
  }

  function startPayment() {
    if (!activeShift || cart.length === 0 || total <= 0) return;
    setTenders([{ provider: "cash", amount: total }]);
    setPaymentDialog(true);
  }

  function updateTender(index: number, patch: Partial<PosTender>) {
    setTenders((current) =>
      current.map((tender, tenderIndex) =>
        tenderIndex === index ? { ...tender, ...patch } : tender,
      ),
    );
  }

  function addTender() {
    const allocated = tenders.reduce((sum, tender) => sum + (Number(tender.amount) || 0), 0);
    const remaining = Math.max(0, Math.round((total - allocated) * 100) / 100);
    setTenders((current) => [...current, { provider: "cash", amount: remaining }]);
  }

  async function completeSale() {
    if (!activeShift) return;
    let checked: PosTender[];
    try {
      checked = validatePosTenders(total, tenders);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("transaction")) toast.error("非现金支付请填写渠道交易号");
      else if (message.includes("match")) toast.error("各支付方式金额合计必须等于应收金额");
      else toast.error("请检查收款信息");
      return;
    }
    setPaying(true);
    const result = await posRequest<Record<string, unknown>>("/api/public/pos/sales", token, {
      method: "POST",
      body: JSON.stringify({
        shift_id: activeShift.id,
        client_op_id: crypto.randomUUID(),
        items: cart.map((line) => ({
          sku_id: line.sku_id,
          quantity: line.quantity,
          subcategory_code: line.subcategory_code ?? null,
        })),
        tenders: checked,
        customer_id: selectedCustomer?.id,
        discount: discountPreview ? discount : undefined,
        benefit_snapshot: customerBenefits ?? undefined,
      }),
    });
    setPaying(false);
    if (!result.ok) {
      toast.error(result.message ?? "收款失败，订单未完成");
      return;
    }
    setSaleResult(result.data);
    setPaymentDialog(false);
    setCart([]);
    setProductMeta({});
    setSelectedCustomer(null);
    setCustomerBenefits(null);
    setDiscountPreview(null);
    setDiscount({ type: "amount", value: 0, reason: "" });
    toast.success("收款完成，库存与订单已同步");
    const orderId = String(result.data.order_id ?? "");
    if (orderId) await loadReceipt(orderId);
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f6f8]">
        <div className="flex items-center gap-3 text-sm text-[#667085]">
          <Loader2 className="h-5 w-5 animate-spin text-[#0a315d]" />
          正在连接收银系统
        </div>
      </div>
    );
  }

  if (!bootstrap || bootstrap.locations.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f6f8] p-6">
        <div className="max-w-md rounded-3xl bg-white p-10 text-center shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
          <PackageOpen className="mx-auto h-10 w-10 text-[#98a2b3]" />
          <h1 className="mt-5 text-xl font-semibold text-[#101828]">当前账号没有可收银库位</h1>
          <p className="mt-2 text-sm leading-6 text-[#667085]">
            请在 ERP 为该账号分配门店或仓库权限后重新进入。
          </p>
          <Button asChild className="mt-6 bg-[#0a315d] hover:bg-[#08284c]">
            <Link to="/dashboard">返回 ERP</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f6f8] text-[#101828]">
      <style>{`
        @media print {
          @page { size: 58mm auto; margin: 4mm; }
          body * { visibility: hidden !important; }
          .pos-receipt, .pos-receipt * { visibility: visible !important; }
          .pos-receipt {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            width: 50mm !important;
            border: 0 !important;
            box-shadow: none !important;
          }
          .pos-receipt-actions { display: none !important; }
        }
      `}</style>
      <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-[#e4e7ec] bg-white px-4 py-3 sm:px-5">
        <Link
          to="/dashboard"
          className="mr-4 inline-flex h-10 w-10 items-center justify-center rounded-xl text-[#344054] transition hover:bg-[#f2f4f7]"
          aria-label="返回 ERP"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-baseline gap-2 sm:gap-3">
          <span className="text-xl font-black tracking-[-0.04em] text-[#0a315d]">BOOMER ERP</span>
          <span className="hidden text-sm font-medium text-[#667085] sm:inline">门店收银</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          <Select value={selectedLocationId} onValueChange={(value) => void switchLocation(value)}>
            <SelectTrigger className="h-10 w-40 rounded-xl border-[#d0d5dd] bg-white sm:w-52">
              <SelectValue placeholder="选择门店" />
            </SelectTrigger>
            <SelectContent>
              {bootstrap.locations.map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name} · {location.kind === "shop" ? "门店" : "仓库"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge
            variant="outline"
            className={
              activeShift
                ? "hidden h-8 rounded-full border-[#abefc6] bg-[#ecfdf3] px-3 text-[#067647] md:inline-flex"
                : "hidden h-8 rounded-full border-[#fedf89] bg-[#fffaeb] px-3 text-[#b54708] md:inline-flex"
            }
          >
            {activeShift
              ? `收银可用 · ${activeShift.register?.name ?? "收银机"}`
              : shiftLoading
                ? "正在准备收银"
                : "收银暂不可用"}
          </Badge>
          <Button
            variant="outline"
            className="hidden h-10 rounded-xl border-[#d0d5dd] sm:inline-flex"
            disabled={!activeShift || shiftLoading}
            onClick={() => void loadCashDrawer()}
          >
            <Banknote className="mr-2 h-4 w-4" />
            钱箱
          </Button>
        </div>
      </header>

      <main className="grid min-h-[calc(100vh-64px)] grid-cols-1 gap-4 p-3 sm:p-4 lg:h-[calc(100vh-64px)] lg:grid-cols-[minmax(0,1fr)_clamp(420px,30vw,500px)] lg:overflow-hidden">
        <section className="flex min-h-0 min-w-0 flex-col gap-4 lg:overflow-hidden">
          <div className="flex flex-1 flex-col rounded-2xl border border-[#e4e7ec] bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <ScanLine className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#0a315d]" />
                <Input
                  ref={scanRef}
                  value={scanCode}
                  onChange={(event) => setScanCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void scanProduct();
                  }}
                  placeholder="扫描商品条码、SKU、RFID，或输入编码后回车"
                  className="h-14 rounded-xl border-[#d0d5dd] bg-[#f9fafb] pl-12 pr-12 text-base focus-visible:border-[#0a315d] focus-visible:ring-[#0a315d]/10"
                  autoComplete="off"
                  inputMode="search"
                />
                {scanning && (
                  <Loader2 className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-[#e8343a]" />
                )}
              </div>
              <Button
                onClick={() => void scanProduct()}
                disabled={scanning || !scanCode.trim()}
                className="h-12 rounded-xl bg-[#e8343a] px-7 text-base hover:bg-[#c92930] sm:h-14"
              >
                <Barcode className="mr-2 h-5 w-5" />
                扫码查询
              </Button>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-[#667085]">
              <span>孤品重复扫码不会重复加入；标准商品重复扫码自动增加数量。</span>
              <div className="flex items-center gap-3">
                <span>{selectedLocation?.name ?? "未选择库位"}</span>
                <button
                  type="button"
                  className="inline-flex items-center font-semibold text-[#0a315d] hover:text-[#e8343a]"
                  onClick={() => {
                    if (browseOpen) setBrowseOpen(false);
                    else void loadProductBrowser();
                  }}
                >
                  商品浏览
                  <ChevronDown
                    className={`ml-1 h-3.5 w-3.5 transition ${browseOpen ? "rotate-180" : ""}`}
                  />
                </button>
              </div>
            </div>
            <div className="mt-4 border-t border-[#eaecf0] pt-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">标准商品</p>
                  <p className="mt-0.5 text-xs text-[#667085]">
                    选择一级类目后直接点价格即可加入；细分类可选，不选也能结算。
                  </p>
                </div>
                {standardLoading && <Loader2 className="h-4 w-4 animate-spin text-[#0a315d]" />}
              </div>
              {standardGroups.length === 0 ? (
                <div className="flex h-20 items-center justify-center rounded-xl bg-[#f9fafb] text-sm text-[#667085]">
                  当前门店不继承标准商品目录
                </div>
              ) : activeGroup ? (
                <div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-lg px-2"
                      onClick={() => {
                        setActiveCategoryCode(null);
                        setActiveSubcategory(null);
                      }}
                    >
                      <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                      全部类目
                    </Button>
                    <span className="text-sm font-semibold">{activeGroup.category_name}</span>
                  </div>
                  {activeGroup.subcategories.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs text-[#667085]">细分类（可选）</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {activeGroup.subcategories.map((sub) => {
                          const active = activeSubcategory?.code === sub.code;
                          return (
                            <button
                              type="button"
                              key={sub.code}
                              aria-pressed={active}
                              className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                active
                                  ? "border-[#0a315d] bg-[#0a315d] text-white"
                                  : "border-[#d0d5dd] bg-white text-[#475467] hover:border-[#0a315d]"
                              }`}
                              onClick={() =>
                                setActiveSubcategory(
                                  active ? null : { code: sub.code, name: sub.name },
                                )
                              }
                            >
                              {sub.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6 xl:grid-cols-8">
                    {activeGroup.prices.map((price) => (
                      <button
                        type="button"
                        key={price.sku_id}
                        className="rounded-xl border border-[#e4e7ec] bg-white py-3 text-sm font-bold tabular-nums text-[#e8343a] transition hover:border-[#e8343a] hover:bg-[#fff1f2]"
                        onClick={() => addStandardPrice(activeGroup, price)}
                      >
                        {money(price.price)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
                  {standardGroups.map((group) => (
                    <button
                      type="button"
                      key={group.category_code}
                      className="rounded-xl border border-[#e4e7ec] bg-white px-3 py-4 text-sm font-semibold transition hover:border-[#0a315d] hover:bg-[#eef4fb]"
                      onClick={() => {
                        setActiveCategoryCode(group.category_code);
                        setActiveSubcategory(null);
                      }}
                    >
                      {group.category_name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {browseOpen && (
              <div className="mt-4 border-t border-[#eaecf0] pt-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">商品浏览</p>
                    <p className="mt-0.5 text-xs text-[#667085]">
                      显示当前库位有可售库存的商品；输入名称后重新查询可缩小范围。
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    disabled={browseLoading}
                    onClick={() => void loadProductBrowser()}
                  >
                    {browseLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    查询
                  </Button>
                </div>
                {browseLoading ? (
                  <div className="flex h-28 items-center justify-center text-sm text-[#667085]">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    正在读取当前库位库存
                  </div>
                ) : browseProducts.length === 0 ? (
                  <div className="flex h-28 items-center justify-center rounded-xl bg-[#f9fafb] text-sm text-[#667085]">
                    暂无可售商品
                  </div>
                ) : (
                  <div className="grid max-h-[calc(100vh-310px)] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 xl:grid-cols-4">
                    {browseProducts.map((product) => (
                      <button
                        type="button"
                        key={product.sku_id}
                        className="group overflow-hidden rounded-xl border border-[#e4e7ec] bg-white text-left transition hover:border-[#fda4af] hover:shadow-[0_4px_14px_rgba(15,23,42,0.07)]"
                        onClick={() => addProduct(product)}
                      >
                        <div className="aspect-[4/3] bg-[#f2f4f7]">
                          {product.image_url ? (
                            <img
                              src={product.image_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center">
                              <PackageOpen className="h-6 w-6 text-[#98a2b3]" />
                            </div>
                          )}
                        </div>
                        <div className="p-3">
                          <p className="truncate text-sm font-semibold">{product.name}</p>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="font-bold text-[#e8343a]">
                              {money(product.unit_price)}
                            </span>
                            <span className="text-[11px] text-[#667085]">
                              {product.is_unlimited_stock
                                ? "库存不限"
                                : `库存 ${product.available_qty}`}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <aside
          data-pos-checkout-panel
          className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-[#e4e7ec] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
        >
          {/* 1. header */}
          <div className="flex items-center gap-2 border-b border-[#eaecf0] px-4 py-3">
            <ShoppingBag className="h-4 w-4 shrink-0 text-[#e8343a]" />
            <p className="text-sm font-semibold">本单结算</p>
            <Badge
              variant="outline"
              className="ml-1 rounded-full border-[#d0d5dd] px-2 py-0 text-[11px] text-[#475467]"
            >
              {itemCount} 件
            </Badge>
            {cart.length > 0 && (
              <button
                type="button"
                className="ml-auto text-xs text-[#667085] hover:text-[#e8343a]"
                onClick={() => {
                  setCart([]);
                  setProductMeta({});
                  setDiscountPreview(null);
                }}
              >
                清空
              </button>
            )}
          </div>

          {/* 2. 弹性购物车：右栏唯一纵向滚动区 */}
          <div data-pos-cart-scroll className="min-h-0 overflow-y-auto bg-[#f9fafb] p-2">
            {cart.length === 0 ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 p-4 text-center">
                <ScanLine className="h-6 w-6 text-[#98a2b3]" />
                <p className="text-sm font-medium text-[#475467]">等待扫码或选择商品</p>
                {saleResult && (
                  <div className="flex w-full max-w-[280px] items-center gap-2 rounded-xl border border-[#abefc6] bg-[#ecfdf3] px-3 py-2 text-left">
                    <Check className="h-4 w-4 shrink-0 text-[#067647]" />
                    <span className="flex-1 truncate text-xs font-semibold text-[#067647]">
                      上一单已完成
                    </span>
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center text-xs font-semibold text-[#067647] underline underline-offset-4"
                      onClick={() => {
                        const orderId = String(saleResult.order_id ?? "");
                        if (orderId) void loadReceipt(orderId);
                      }}
                    >
                      <Printer className="mr-1 h-3.5 w-3.5" />
                      打印小票
                    </button>
                  </div>
                )}
              </div>
            ) : (
              cart.map((line) => {
                const meta = productMeta[line.sku_id];
                const lineKey = posCartLineKey(line);
                return (
                  <div
                    key={lineKey}
                    className="mb-2 flex min-h-[72px] items-center gap-2.5 rounded-xl bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.05)] last:mb-0"
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#f2f4f7]">
                      {meta?.image_url ? (
                        <img src={meta.image_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <PackageOpen className="h-5 w-5 text-[#98a2b3]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold leading-tight">
                        {posCartLineLabel(line)}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-[#667085]">
                        <span className="shrink-0 rounded bg-[#f2f4f7] px-1 py-px text-[10px] text-[#475467]">
                          {line.product_type === "custom"
                            ? "孤品"
                            : line.product_type === "bundle"
                              ? "组包"
                              : "标准"}
                        </span>
                        <span className="truncate font-mono">
                          {meta?.barcode || meta?.sku_code || line.sku_id}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <p className="font-bold leading-none tabular-nums text-[#e8343a]">
                        {money(line.unit_price * line.quantity)}
                      </p>
                      <div className="flex items-center">
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-l-lg border border-[#d0d5dd]"
                          onClick={() => updateQuantity(lineKey, line.quantity - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="flex h-7 w-8 items-center justify-center border-y border-[#d0d5dd] bg-white text-xs font-semibold tabular-nums">
                          {line.quantity}
                        </span>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-r-lg border border-[#d0d5dd] disabled:opacity-35"
                          disabled={
                            line.product_type === "custom" ||
                            (!line.is_unlimited_stock && line.quantity >= line.available_qty)
                          }
                          onClick={() => updateQuantity(lineKey, line.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="ml-1.5 flex h-7 w-7 items-center justify-center rounded-lg text-[#98a2b3] hover:bg-[#fff1f2] hover:text-[#e8343a]"
                          onClick={() => updateQuantity(lineKey, 0)}
                          aria-label={`删除 ${posCartLineLabel(line)}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 3. 固定紧凑结算底栏 */}
          <div
            data-pos-settlement-footer
            className="space-y-2 border-t border-[#eaecf0] bg-white p-3"
          >
            <button
              type="button"
              className="flex h-12 w-full items-center gap-2.5 rounded-xl bg-[#fff1f2] px-3 text-left transition hover:bg-[#ffe4e6]"
              onClick={() => setMemberDialog(true)}
            >
              <UserRoundSearch className="h-4 w-4 shrink-0 text-[#e8343a]" />
              {selectedCustomer ? (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold leading-tight text-[#9f1239]">
                    {selectedCustomer.nickname || "BOOMER 会员"}
                  </p>
                  <p className="truncate text-[11px] leading-tight text-[#b42318]">
                    {selectedCustomer.wallet?.member_level ?? "普通会员"} ·{" "}
                    {selectedCustomer.wallet?.points ?? 0} 积分
                  </p>
                </div>
              ) : (
                <span className="flex-1 text-sm font-semibold text-[#9f1239]">
                  识别会员
                  <span className="ml-2 text-[11px] font-normal text-[#b42318]">
                    扫码会员码或输入手机号
                  </span>
                </span>
              )}
              <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-[#b42318]" />
            </button>

            <div className="grid grid-cols-4 gap-1.5">
              <Button
                variant="outline"
                className="h-10 rounded-lg border-[#d0d5dd] px-1 text-xs"
                disabled={cart.length === 0}
                onClick={() => setDiscountDialog(true)}
              >
                <TicketPercent className="mr-1 h-3.5 w-3.5 text-[#e8343a]" />
                优惠
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-lg border-[#d0d5dd] px-1 text-xs"
                onClick={() => void loadHeldCarts()}
              >
                <History className="mr-1 h-3.5 w-3.5 text-[#0a315d]" />
                取单
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-lg border-[#d0d5dd] px-1 text-xs"
                disabled={!activeShift || cart.length === 0}
                onClick={() => void holdCart()}
              >
                <PauseCircle className="mr-1 h-3.5 w-3.5" />
                挂单
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-lg border-[#d0d5dd] px-1 text-xs"
                disabled={!activeShift}
                onClick={() => {
                  setOrdersDialog(true);
                  void searchOrders();
                }}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                退换
              </Button>
            </div>

            <div className="flex items-end justify-between gap-3 rounded-xl bg-[#fff5f5] px-3 py-2">
              <div className="min-w-0 space-y-0.5 text-[11px] leading-tight text-[#667085]">
                <p>
                  小计 <span className="tabular-nums text-[#344054]">{money(subtotal)}</span>
                </p>
                <p>
                  优惠{" "}
                  <span className="font-medium tabular-nums text-[#e8343a]">
                    {discountTotal > 0 ? `-${money(discountTotal)}` : money(0)}
                  </span>
                </p>
                {discountPreview?.excluded_total ? (
                  <p className="text-[#98a2b3]">
                    寄售/特殊不参与 {money(discountPreview.excluded_total)}
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[11px] leading-tight text-[#b42318]">应收</p>
                <p className="text-3xl font-black leading-none tracking-[-0.04em] tabular-nums text-[#e8343a]">
                  {money(total)}
                </p>
              </div>
            </div>

            <Button
              className="h-14 w-full rounded-xl bg-[#e8343a] text-base font-semibold hover:bg-[#c92930]"
              disabled={!activeShift || cart.length === 0}
              onClick={startPayment}
            >
              <Banknote className="mr-2 h-5 w-5" />
              收款 {total > 0 ? money(total) : ""}
            </Button>
          </div>
        </aside>
      </main>

      <Dialog open={cashDialog} onOpenChange={setCashDialog}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle>钱箱管理</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 pt-1">
            <div className="rounded-2xl bg-[#0a315d] p-5 text-white">
              <p className="text-xs text-white/65">{selectedLocation?.name} · 当前应有现金</p>
              <p className="mt-1 text-4xl font-black tracking-[-0.04em] tabular-nums">
                {cashLoading && !cashSummary ? "读取中" : money(cashSummary?.balance ?? 0)}
              </p>
              <p className="mt-3 text-xs leading-5 text-white/65">
                现金会连续结转到下一天，只有实际取走或补入现金时才需要登记。
              </p>
            </div>

            <div className="grid grid-cols-2 rounded-xl bg-[#f2f4f7] p-1">
              <button
                type="button"
                className={`h-10 rounded-lg text-sm font-semibold transition ${
                  cashMode === "cash_out" ? "bg-white text-[#b42318] shadow-sm" : "text-[#667085]"
                }`}
                onClick={() => setCashMode("cash_out")}
              >
                取出现金
              </button>
              <button
                type="button"
                className={`h-10 rounded-lg text-sm font-semibold transition ${
                  cashMode === "cash_in" ? "bg-white text-[#067647] shadow-sm" : "text-[#667085]"
                }`}
                onClick={() => setCashMode("cash_in")}
              >
                补入现金
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cash-amount">金额</Label>
                <Input
                  id="cash-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={cashAmount}
                  onChange={(event) => setCashAmount(event.target.value)}
                  placeholder="0.00"
                  className="h-12 rounded-xl text-lg font-semibold tabular-nums"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cash-reason">原因</Label>
                <Input
                  id="cash-reason"
                  value={cashReason}
                  onChange={(event) => setCashReason(event.target.value)}
                  placeholder={cashMode === "cash_out" ? "如：存入银行" : "如：补充找零"}
                  className="h-12 rounded-xl"
                />
              </div>
            </div>

            <Button
              className="h-12 w-full rounded-xl bg-[#0a315d] hover:bg-[#08284c]"
              disabled={cashLoading}
              onClick={() => void recordCashMovement()}
            >
              {cashLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {cashMode === "cash_out" ? "确认取出" : "确认补入"}
            </Button>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">最近钱箱记录</p>
                <span className="text-xs text-[#667085]">
                  起始结转 {money(cashSummary?.opening_cash ?? 0)}
                </span>
              </div>
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {(cashSummary?.items ?? []).slice(0, 8).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-xl bg-[#f9fafb] px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.type === "sale"
                          ? "现金销售"
                          : item.type === "refund"
                            ? "现金退款"
                            : item.type === "cash_out"
                              ? "取出现金"
                              : item.type === "cash_in"
                                ? "补入现金"
                                : "钱箱调整"}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[#667085]">
                        {item.reason || new Date(item.created_at).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <span
                      className={`ml-3 font-semibold tabular-nums ${
                        Number(item.amount) < 0 ? "text-[#b42318]" : "text-[#067647]"
                      }`}
                    >
                      {Number(item.amount) > 0 ? "+" : ""}
                      {money(Number(item.amount))}
                    </span>
                  </div>
                ))}
                {!cashLoading && (cashSummary?.items.length ?? 0) === 0 && (
                  <div className="flex h-20 items-center justify-center rounded-xl bg-[#f9fafb] text-sm text-[#667085]">
                    暂无钱箱变动
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={memberDialog} onOpenChange={setMemberDialog}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle>识别会员</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a2b3]" />
              <Input
                value={memberQuery}
                onChange={(event) => setMemberQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchMembers();
                }}
                placeholder="输入手机号或会员名称"
                className="h-11 rounded-xl pl-10"
              />
            </div>
            <Button
              className="h-11 rounded-xl bg-[#0a315d] hover:bg-[#08284c]"
              disabled={memberLoading}
              onClick={() => void searchMembers()}
            >
              {memberLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              查询
            </Button>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {memberResults.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center rounded-xl bg-[#f9fafb] text-sm text-[#667085]">
                <CircleUserRound className="mb-2 h-6 w-6 text-[#98a2b3]" />
                输入手机号查询会员，或直接扫描会员码
              </div>
            ) : (
              memberResults.map((customer) => (
                <button
                  type="button"
                  key={customer.id}
                  className="flex w-full items-center rounded-xl border border-[#e4e7ec] p-4 text-left transition hover:border-[#9db8d4] hover:bg-[#f8fbff]"
                  onClick={() => void selectCustomer(customer)}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#eef4fb] text-[#0a315d]">
                    <CircleUserRound className="h-5 w-5" />
                  </div>
                  <div className="ml-3 min-w-0 flex-1">
                    <p className="font-semibold">{customer.nickname || "BOOMER 会员"}</p>
                    <p className="mt-0.5 text-xs text-[#667085]">
                      {customer.phone || "未绑定手机"}
                    </p>
                  </div>
                  <div className="text-right text-xs text-[#667085]">
                    <p>{customer.wallet?.member_level ?? "普通会员"}</p>
                    <p className="mt-1">{customer.wallet?.points ?? 0} 积分</p>
                  </div>
                </button>
              ))
            )}
          </div>
          {selectedCustomer && (
            <Button
              variant="outline"
              className="rounded-xl"
              onClick={() => {
                setSelectedCustomer(null);
                setCustomerBenefits(null);
                setMemberDialog(false);
              }}
            >
              取消本单会员
            </Button>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={discountDialog} onOpenChange={setDiscountDialog}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle>整单优惠</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: "amount", label: "减金额", icon: Tag },
              { value: "percentage", label: "按折扣", icon: Percent },
              { value: "final_price", label: "改实收", icon: Banknote },
            ].map((option) => {
              const Icon = option.icon;
              const active = discount.type === option.value;
              return (
                <button
                  type="button"
                  key={option.value}
                  className={`flex h-20 flex-col items-center justify-center rounded-xl border transition ${
                    active
                      ? "border-[#e8343a] bg-[#fff1f2] text-[#c92930]"
                      : "border-[#e4e7ec] bg-white text-[#475467] hover:bg-[#f9fafb]"
                  }`}
                  onClick={() =>
                    setDiscount((current) => ({
                      ...current,
                      type: option.value as PosDiscount["type"],
                    }))
                  }
                >
                  <Icon className="mb-2 h-5 w-5" />
                  <span className="text-sm font-semibold">{option.label}</span>
                </button>
              );
            })}
          </div>
          <div className="space-y-2">
            <Label htmlFor="discount-value">
              {discount.type === "amount"
                ? "优惠金额"
                : discount.type === "percentage"
                  ? "折后比例（90 表示九折）"
                  : "最终实收金额"}
            </Label>
            <Input
              id="discount-value"
              type="number"
              min="0"
              max={discount.type === "percentage" ? 100 : undefined}
              step="0.01"
              value={discount.value || ""}
              onChange={(event) =>
                setDiscount((current) => ({
                  ...current,
                  value: Number(event.target.value) || 0,
                }))
              }
              className="h-12 rounded-xl text-lg font-semibold tabular-nums"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="discount-reason">优惠原因</Label>
            <Input
              id="discount-reason"
              value={discount.reason}
              onChange={(event) =>
                setDiscount((current) => ({ ...current, reason: event.target.value }))
              }
              placeholder="例如：会员活动、瑕疵补偿、店长特批"
              className="h-11 rounded-xl"
            />
          </div>
          <div className="rounded-xl bg-[#f9fafb] p-4 text-sm">
            <div className="flex justify-between text-[#667085]">
              <span>商品小计</span>
              <span>{money(subtotal)}</span>
            </div>
            {discountPreview && (
              <div className="mt-2 flex justify-between font-semibold text-[#e8343a]">
                <span>当前优惠</span>
                <span>-{money(discountPreview.discount_total)}</span>
              </div>
            )}
          </div>
          <Button
            className="h-12 rounded-xl bg-[#e8343a] hover:bg-[#c92930]"
            disabled={discountLoading || discount.value <= 0}
            onClick={() => void previewDiscount()}
          >
            {discountLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            应用优惠
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={heldDialog} onOpenChange={setHeldDialog}>
        <DialogContent className="max-w-xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>挂单与取单</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {heldLoading ? (
              <div className="flex h-40 items-center justify-center text-sm text-[#667085]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在读取挂单
              </div>
            ) : heldCarts.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center rounded-xl bg-[#f9fafb] text-sm text-[#667085]">
                <PauseCircle className="mb-2 h-6 w-6 text-[#98a2b3]" />
                当前门店暂无挂单
              </div>
            ) : (
              heldCarts.map((held) => {
                const quantity = held.pos_held_cart_items.reduce(
                  (sum, item) => sum + item.quantity,
                  0,
                );
                const amount = held.pos_held_cart_items.reduce(
                  (sum, item) => sum + Number(item.price_snapshot) * item.quantity,
                  0,
                );
                return (
                  <div
                    key={held.id}
                    className="flex items-center rounded-xl border border-[#e4e7ec] p-4"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eef4fb] text-[#0a315d]">
                      <PauseCircle className="h-5 w-5" />
                    </div>
                    <div className="ml-3 flex-1">
                      <p className="font-semibold">
                        {quantity} 件 · {money(amount)}
                      </p>
                      <p className="mt-1 text-xs text-[#667085]">
                        {new Date(held.held_at).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="rounded-lg bg-[#0a315d] hover:bg-[#08284c]"
                      onClick={() => void resumeHeldCart(held)}
                    >
                      取回
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={ordersDialog} onOpenChange={setOrdersDialog}>
        <DialogContent className="max-w-2xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>订单退换</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              value={orderQuery}
              onChange={(event) => setOrderQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void searchOrders();
              }}
              placeholder="输入订单号；留空显示最近订单"
              className="h-11 rounded-xl"
            />
            <Button
              className="h-11 rounded-xl bg-[#0a315d] hover:bg-[#08284c]"
              onClick={() => void searchOrders()}
            >
              查询
            </Button>
          </div>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {ordersLoading ? (
              <div className="flex h-40 items-center justify-center text-sm text-[#667085]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在读取订单
              </div>
            ) : orders.length === 0 ? (
              <div className="flex h-40 items-center justify-center rounded-xl bg-[#f9fafb] text-sm text-[#667085]">
                暂无可退订单
              </div>
            ) : (
              orders.map((order) => (
                <div
                  key={order.id}
                  className="flex items-center rounded-xl border border-[#e4e7ec] p-4"
                >
                  <ReceiptText className="h-5 w-5 text-[#0a315d]" />
                  <div className="ml-3 min-w-0 flex-1">
                    <p className="font-mono text-sm font-semibold">{order.order_no}</p>
                    <p className="mt-1 truncate text-xs text-[#667085]">
                      {order.commerce_order_items.map((item) => item.title_snapshot).join("、")}
                    </p>
                  </div>
                  <div className="mr-4 text-right">
                    <p className="font-bold">{money(Number(order.total_amount))}</p>
                    <p className="mt-1 text-xs text-[#667085]">
                      {new Date(order.paid_at).toLocaleDateString("zh-CN")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-lg border-[#fda4af] text-[#c92930]"
                    onClick={() => void returnWholeOrder(order)}
                  >
                    退整单
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent className="max-w-xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>组合支付</DialogTitle>
          </DialogHeader>
          <div className="rounded-2xl bg-[#0a315d] p-5 text-white">
            <p className="text-sm text-white/70">本单应收</p>
            <p className="mt-1 text-4xl font-black tracking-[-0.04em] tabular-nums">
              {money(total)}
            </p>
          </div>
          <div className="max-h-[46vh] space-y-3 overflow-y-auto py-1">
            {tenders.map((tender, index) => (
              <div key={index} className="rounded-xl border border-[#e4e7ec] p-4">
                <div className="grid grid-cols-[150px_1fr_36px] gap-3">
                  <Select
                    value={tender.provider}
                    onValueChange={(value) =>
                      updateTender(index, {
                        provider: value as PosTender["provider"],
                        provider_transaction_id:
                          value === "cash" ? undefined : tender.provider_transaction_id,
                      })
                    }
                  >
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {paymentOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={tender.amount}
                    onChange={(event) =>
                      updateTender(index, { amount: Number(event.target.value) || 0 })
                    }
                    className="h-11 rounded-xl text-right tabular-nums"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={tenders.length === 1}
                    onClick={() =>
                      setTenders((current) =>
                        current.filter((_, tenderIndex) => tenderIndex !== index),
                      )
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {tender.provider !== "cash" && (
                  <Input
                    value={tender.provider_transaction_id ?? ""}
                    onChange={(event) =>
                      updateTender(index, { provider_transaction_id: event.target.value })
                    }
                    placeholder="填写或扫码输入渠道交易号"
                    className="mt-3 h-10 rounded-xl"
                  />
                )}
              </div>
            ))}
          </div>
          <Button variant="outline" className="rounded-xl" onClick={addTender}>
            <Plus className="mr-2 h-4 w-4" />
            增加组合支付
          </Button>
          <Button
            className="h-12 rounded-xl bg-[#e8343a] hover:bg-[#c92930]"
            disabled={paying}
            onClick={() => void completeSale()}
          >
            {paying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            确认收款
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={receiptDialog} onOpenChange={setReceiptDialog}>
        <DialogContent className="pos-receipt max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-center">BOOMER OFF</DialogTitle>
          </DialogHeader>
          {receipt && (
            <div className="font-mono text-xs text-black">
              <div className="text-center">
                <p className="text-sm font-bold">{receipt.location_name}</p>
                <p className="mt-1">{receipt.receipt_no}</p>
                <p>{new Date(receipt.paid_at).toLocaleString("zh-CN")}</p>
              </div>
              <div className="my-3 border-t border-dashed border-black" />
              <div className="space-y-2">
                {receipt.items.map((item) => (
                  <div key={`${item.sku_id}-${item.title_snapshot}`}>
                    <p>{item.title_snapshot}</p>
                    <div className="mt-0.5 flex justify-between">
                      <span>
                        {money(Number(item.unit_price))} × {item.quantity}
                      </span>
                      <span>{money(Number(item.line_total))}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="my-3 border-t border-dashed border-black" />
              {receipt.discount_total > 0 && (
                <div className="mb-2 space-y-1">
                  <div className="flex justify-between">
                    <span>商品小计</span>
                    <span>{money(receipt.subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>整单优惠</span>
                    <span>-{money(receipt.discount_total)}</span>
                  </div>
                </div>
              )}
              <div className="flex justify-between text-sm font-bold">
                <span>合计</span>
                <span>{money(receipt.total_amount)}</span>
              </div>
              <div className="mt-2 space-y-1">
                {receipt.payments.map((payment, index) => (
                  <div key={`${payment.provider}-${index}`} className="flex justify-between">
                    <span>
                      {paymentOptions.find((option) => option.value === payment.provider)?.label ??
                        payment.provider}
                    </span>
                    <span>{money(Number(payment.amount))}</span>
                  </div>
                ))}
              </div>
              <div className="my-3 border-t border-dashed border-black" />
              <p className="text-center leading-5">感谢光临 BOOMER OFF</p>
              <p className="text-center text-[10px] text-black/70">订单号 {receipt.order_no}</p>
              <div className="pos-receipt-actions mt-5 grid grid-cols-3 gap-2 font-sans">
                <Button
                  variant="outline"
                  className="rounded-xl"
                  onClick={() => setReceiptDialog(false)}
                >
                  关闭
                </Button>
                <Button
                  variant="outline"
                  className="rounded-xl"
                  onClick={() => void shareElectronicReceipt()}
                >
                  <ReceiptText className="mr-1.5 h-4 w-4" />
                  电子小票
                </Button>
                <Button
                  className="rounded-xl bg-[#0a315d] hover:bg-[#08284c]"
                  onClick={() => void printReceipt()}
                >
                  <Printer className="mr-2 h-4 w-4" />
                  打印小票
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

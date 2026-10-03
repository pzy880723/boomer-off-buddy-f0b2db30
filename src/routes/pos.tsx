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

import logo from "@/assets/logo-boomeroff.png";
import { useAuthSession } from "@/hooks/use-auth-session";
import {
  addScannedProduct,
  posCartLineKey,
  posCartLineLabel,
  preparePosSaleAttempt,
  restorePosSaleAttempt,
  validatePosTenders,
  type PosCartLine,
  type PosScannableProduct,
  type PosTender,
  type PosSaleAttempt,
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
import type { StandardCatalogGroup } from "@/lib/pos/standard-catalog";
import { PosCatalog } from "@/components/pos/pos-catalog";
import { PosHidScanner } from "@/lib/pos/hid-scanner";
import type { calculatePointsRedemption } from "@/lib/pos/points-policy";
import { SaleRecoveryResult } from "@/lib/pos/sale-recovery";
import { posRequest, isConfirmedSale } from "@/lib/pos/request";
type PointsRedemption = ReturnType<typeof calculatePointsRedemption>;

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
  points_redemption?: PointsRedemption;
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
  points_redemption?: PointsRedemption;
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
  location_id: string;
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
    brand_id: string | null;
    brand_name_snapshot: string | null;
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

export function PosPage() {
  const { session } = useAuthSession();
  const token = session?.access_token ?? "";
  const scanRef = useRef<HTMLInputElement>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [cart, setCart] = useState<PosCartLine[]>([]);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const [productMeta, setProductMeta] = useState<Record<string, LookupProduct>>({});
  const [scanCode, setScanCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [catalogTab, setCatalogTab] = useState<"standard" | "custom">("standard");
  const [searchDialog, setSearchDialog] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [phoneCart, setPhoneCart] = useState(false);
  const [standardError, setStandardError] = useState("");
  const [browseError, setBrowseError] = useState("");
  const [browseNext, setBrowseNext] = useState<number | null>(null);
  const [browseLoadingMore, setBrowseLoadingMore] = useState(false);
  const locationRef = useRef(selectedLocationId);
  locationRef.current = selectedLocationId;
  const catalogRequest = useRef(0);
  const browseRequest = useRef(0);
  const heldRequest = useRef(0);
  const discountRequest = useRef(0);
  const [browseQuery, setBrowseQuery] = useState("");
  const scanQueue = useRef<Array<{ code: string; locationId: string }>>([]);
  const scanRunning = useRef(false);
  const scanHandler = useRef<(code: string) => Promise<void>>(async () => {});
  const resolveScan = useRef<(code: string) => Promise<void>>(async () => {});
  const [standardGroups, setStandardGroups] = useState<StandardCatalogGroup[]>([]);
  const [brands, setBrands] = useState<import("@/lib/pos/brand-catalog").PosBrand[]>([]);
  const [activeBrand, setActiveBrand] = useState<import("@/lib/pos/brand-catalog").PosBrand | null>(null);
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
  const saleAttempt = useRef<PosSaleAttempt | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState<PosSaleAttempt | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const pendingSaleKey = session?.user.id ? `boomer.pos.pending-sale:${session.user.id}` : null;

  useEffect(() => {
    if (!pendingSaleKey) return;
    try {
      const pending = restorePosSaleAttempt(localStorage.getItem(pendingSaleKey));
      saleAttempt.current = pending;
      setRecoveryAttempt(pending);
      setRecoveryError("");
    } catch {
      setRecoveryError("待确认收款记录无法读取，请先在 ERP 核实上一笔订单，不能直接再次收款");
    }
  }, [pendingSaleKey]);
  const [saleResult, setSaleResult] = useState<Record<string, unknown> | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [receiptDialog, setReceiptDialog] = useState(false);
  const [memberDialog, setMemberDialog] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberResults, setMemberResults] = useState<PosCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<PosCustomer | null>(null);
  const customerRef = useRef(selectedCustomer);
  customerRef.current = selectedCustomer;
  const [customerBenefits, setCustomerBenefits] = useState<CustomerBenefits | null>(null);
  const [discountDialog, setDiscountDialog] = useState(false);
  const [discount, setDiscount] = useState<PosDiscount>({
    type: "amount",
    value: 0,
    reason: "",
  });
  const [discountPreview, setDiscountPreview] = useState<DiscountPreview | null>(null);
  const [appliedDiscount, setAppliedDiscount] = useState<PosDiscount | null>(null);
  const [pointsInput, setPointsInput] = useState(0);
  const [pointsQuote, setPointsQuote] = useState<PointsRedemption | null>(null);
  const [pointsQuoteLoading, setPointsQuoteLoading] = useState(false);
  const [pointsQuoteError, setPointsQuoteError] = useState("");
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
    () =>
      cart.reduce((sum, line) => sum + Math.round(line.unit_price * 100) * line.quantity, 0) / 100,
    [cart],
  );
  const discountTotal = discountPreview?.discount_total ?? 0;
  const total = discountPreview?.payable_total ?? subtotal;
  const itemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);
  const appliedPoints = discountPreview?.points_redemption?.applied_points ?? 0;

  useEffect(() => {
    if (!discountDialog || !selectedCustomer || !cart.length) {
      setPointsQuote(null);
      setPointsQuoteLoading(false);
      setPointsQuoteError("");
      return;
    }
    let cancelled = false;
    setPointsQuote(null);
    setPointsQuoteLoading(true);
    setPointsQuoteError("");
    const timer = window.setTimeout(async () => {
      const result = await posRequest<DiscountPreview>("/api/public/pos/discounts/preview", token, {
        method: "POST",
        body: JSON.stringify({
          location_id: selectedLocationId,
          customer_id: selectedCustomer.id,
          points_to_redeem: pointsInput,
          items: cart.map((line) => ({ sku_id: line.sku_id, quantity: line.quantity })),
          discount,
        }),
      });
      if (cancelled) return;
      setPointsQuoteLoading(false);
      if (result.ok) setPointsQuote(result.data.points_redemption ?? null);
      else setPointsQuoteError(result.message ?? "积分试算失败，请重试");
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    discountDialog,
    selectedCustomer?.id,
    cart,
    selectedLocationId,
    pointsInput,
    discount.type,
    discount.value,
    token,
  ]);

  useEffect(() => {
    const scanner = new PosHidScanner();
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        document.querySelector('[role="dialog"]') ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        scanner.reset();
        return;
      }
      const code = scanner.key(event.key, event.timeStamp);
      if (code) {
        event.preventDefault();
        void scanHandler.current(code);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedLocationId]);

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
    const requestId = ++catalogRequest.current;
    const locationId = selectedLocationId;
    setStandardLoading(true);
    setStandardError("");
    const result = await posRequest<{ groups: StandardCatalogGroup[]; brands?: import("@/lib/pos/brand-catalog").PosBrand[] }>(
      `/api/public/pos/standard-catalog?location_id=${encodeURIComponent(selectedLocationId)}`,
      token,
    );
    if (requestId !== catalogRequest.current || locationRef.current !== locationId) return;
    setStandardLoading(false);
    if (!result.ok) {
      setStandardGroups([]);
      setBrands([]);
      setStandardError(result.message ?? "标准商品目录加载失败");
      return;
    }
    setStandardGroups(result.data.groups);
    setBrands(result.data.brands ?? []);
  }

  function addStandardPrice(group: StandardCatalogGroup, price: { sku_id: string; price: number }) {
    addProduct({
      sku_id: price.sku_id,
      product_type: "standard",
      name: group.category_name,
      unit_price: price.price,
      available_qty: 9999,
      is_unlimited_stock: true,
      image_url: (group as StandardCatalogGroup & { image_url?: string | null }).image_url ?? null,
      barcode: null,
      sku_code: null,
      sale_ownership: "owned",
      location_id: selectedLocationId,
      discount_eligible: true,
      category_code: group.category_code,
      category_name: group.category_name,
      subcategory_code: activeSubcategory?.code ?? null,
      subcategory_name: activeSubcategory?.name ?? null,
      brand_id: activeBrand?.id ?? null,
      brand_name: activeBrand?.name ?? null,
    } as unknown as LookupProduct);
    setActiveSubcategory(null);
    setActiveBrand(null);
  }

  function addProduct(product: LookupProduct) {
    try {
      // Validate before enqueuing a state update: React may evaluate an updater later.
      const nextCart = addScannedProduct(cartRef.current, product);
      cartRef.current = nextCart;
      setCart(nextCart);
      setProductMeta((current) => ({ ...current, [product.sku_id]: product }));
      setDiscountPreview(null);
      playAcceptedTone();
      toast.success(`${product.name} 已加入购物车`, { position: "top-center", duration: 1500 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("already"))
        toast.warning("孤品已经在购物车中，不会重复加入", { position: "top-center" });
      else if (message.includes("stock")) toast.warning("可售库存不足", { position: "top-center" });
      else toast.error("商品无法加入购物车", { position: "top-center" });
    }
  }

  async function scanProduct(rawCode = scanCode) {
    const code = rawCode.trim();
    if (!code) return;
    if (!activeShift || !selectedLocationId) {
      toast.error("收银台正在初始化，请稍候");
      return;
    }
    setScanning(true);
    const locationId = selectedLocationId;
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
    if (locationRef.current !== locationId) return;
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

  resolveScan.current = scanProduct;
  scanHandler.current = async (code: string) => {
    scanQueue.current.push({ code, locationId: selectedLocationId });
    if (scanRunning.current) return;
    scanRunning.current = true;
    try {
      while (scanQueue.current.length) {
        const next = scanQueue.current.shift()!;
        if (next.locationId === locationRef.current) await resolveScan.current(next.code);
      }
    } finally {
      scanRunning.current = false;
    }
  };

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
    setPointsInput(0);
    setPointsQuote(null);
    setDiscountPreview(null);
    setCustomerBenefits(result.data);
    setMemberDialog(false);
  }

  async function previewDiscount(nextDiscount = discount) {
    if (!selectedLocationId || cart.length === 0) return;
    if (!nextDiscount.reason.trim() && nextDiscount.value > 0) {
      toast.warning("请填写优惠原因");
      return;
    }
    setDiscountLoading(true);
    const requestId = ++discountRequest.current;
    const requestedCart = cartRef.current;
    const requestedCustomer = customerRef.current;
    const requestedLocation = selectedLocationId;
    const scope = catalogRequest.current;
    const nextAppliedDiscount = {
      ...nextDiscount,
      reason: nextDiscount.reason.trim() || (pointsInput > 0 ? "会员积分抵扣" : "取消优惠"),
    };
    const result = await posRequest<DiscountPreview>("/api/public/pos/discounts/preview", token, {
      method: "POST",
      body: JSON.stringify({
        location_id: selectedLocationId,
        customer_id: selectedCustomer?.id,
        points_to_redeem: pointsInput,
        items: cart.map((line) => ({ sku_id: line.sku_id, quantity: line.quantity })),
        discount: nextAppliedDiscount,
      }),
    });
    if (requestId === discountRequest.current) setDiscountLoading(false);
    if (
      requestId !== discountRequest.current ||
      requestedCart !== cartRef.current ||
      requestedCustomer !== customerRef.current ||
      requestedLocation !== locationRef.current ||
      scope !== catalogRequest.current
    ) {
      toast.warning("购物车或会员已变化，请重新应用优惠");
      return;
    }
    if (!result.ok) {
      toast.error(result.message ?? "当前优惠不可用");
      return;
    }
    if (
      pointsInput > 0 &&
      (!result.data.points_redemption?.enabled || result.data.points_redemption.applied_points <= 0)
    ) {
      setPointsQuote(result.data.points_redemption ?? null);
      toast.warning("积分余额或抵扣规则已变化，请重新核对后应用优惠");
      return;
    }
    if (result.data.requires_authorization) {
      toast.warning(result.data.authorization_rule ?? "该优惠需要店长授权");
      return;
    }
    setDiscountPreview(result.data);
    setAppliedDiscount(nextAppliedDiscount);
    setPointsInput(result.data.points_redemption?.applied_points ?? 0);
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
        discount_snapshot: discountPreview ? (appliedDiscount ?? {}) : {},
        benefit_snapshot: { ...(customerBenefits ?? {}), points_to_redeem: appliedPoints },
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
    setPointsInput(0);
    setDiscountPreview(null);
    toast.success("已挂单，可随时从挂单列表取回");
  }

  async function loadHeldCarts() {
    if (!selectedLocationId) return;
    const requestId = ++heldRequest.current;
    const locationId = selectedLocationId;
    setHeldDialog(true);
    setHeldLoading(true);
    const result = await posRequest<{ items: HeldCart[] }>(
      `/api/public/pos/carts/held?location_id=${encodeURIComponent(selectedLocationId)}`,
      token,
    );
    if (requestId !== heldRequest.current || locationRef.current !== locationId) return;
    setHeldLoading(false);
    if (!result.ok) {
      toast.error(result.message ?? "挂单列表加载失败");
      return;
    }
    setHeldCarts(result.data.items);
  }

  async function resumeHeldCart(held: HeldCart) {
    if (held.location_id !== selectedLocationId) {
      toast.error("挂单不属于当前门店，请切换到挂单门店再取回");
      return;
    }
    if (cart.length) {
      toast.warning("请先结算或挂起当前购物车，再取回挂单");
      return;
    }
    const locationId = selectedLocationId;
    const result = await posRequest<HeldCart>(
      `/api/public/pos/carts/${encodeURIComponent(held.id)}/resume`,
      token,
      { method: "POST", body: "{}" },
    );
    if (locationRef.current !== locationId) return;
    if (!result.ok) {
      toast.error(result.message ?? "取单失败");
      return;
    }
    if (result.data.location_id !== locationId) {
      toast.error("挂单门店不匹配，请在 ERP 核实");
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
    if (locationRef.current !== locationId) return;
    setCart(resumedCart);
    setProductMeta(Object.fromEntries(products.map((product) => [product.sku_id, product])));
    const heldDiscount = result.data.discount_snapshot as PosDiscount;
    const nextDiscount = heldDiscount?.type
      ? heldDiscount
      : { type: "amount" as const, value: 0, reason: "" };
    setDiscount(nextDiscount);
    setDiscountPreview(null);
    setAppliedDiscount(null);
    setSelectedCustomer(null);
    setCustomerBenefits(null);
    setPointsInput(0);
    let restoredCustomer: PosCustomer | null = null;
    if (result.data.customer_id) {
      const benefits = await posRequest<CustomerBenefits>(
        `/api/public/pos/customers/${encodeURIComponent(result.data.customer_id)}/benefits`,
        token,
      );
      if (locationRef.current !== locationId) return;
      if (benefits.ok) {
        restoredCustomer = { ...benefits.data.customer, wallet: benefits.data.wallet };
        setSelectedCustomer(restoredCustomer);
        setCustomerBenefits(benefits.data);
      } else toast.warning("挂单会员权益读取失败，请重新选择会员后设置优惠");
    }
    const heldPoints = Number(result.data.benefit_snapshot?.points_to_redeem ?? 0);
    if (heldPoints > 0 && !restoredCustomer) {
      setHeldDialog(false);
      setDiscountDialog(true);
      return;
    }
    const requestedPoints = restoredCustomer ? heldPoints : 0;
    if (resumedCart.length && (nextDiscount.value > 0 || requestedPoints > 0)) {
      const preview = await posRequest<DiscountPreview>(
        "/api/public/pos/discounts/preview",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            location_id: locationId,
            customer_id: restoredCustomer?.id,
            points_to_redeem: requestedPoints,
            items: resumedCart.map((line) => ({ sku_id: line.sku_id, quantity: line.quantity })),
            discount: nextDiscount,
          }),
        },
      );
      if (locationRef.current !== locationId) return;
      if (
        preview.ok &&
        !preview.data.requires_authorization &&
        (requestedPoints === 0 ||
          (preview.data.points_redemption?.enabled &&
            preview.data.points_redemption.applied_points > 0))
      ) {
        setDiscountPreview(preview.data);
        setAppliedDiscount(nextDiscount);
        setPointsInput(preview.data.points_redemption?.applied_points ?? 0);
      } else {
        toast.warning("挂单优惠或积分已失效，或需要店长授权；尚未应用，请重新设置后结算");
        setHeldDialog(false);
        setDiscountDialog(true);
        return;
      }
    }
    setHeldDialog(false);
    if (resumedCart.length !== items.length) toast.warning("部分挂单商品已不可售，请核对购物车");
    else toast.success("挂单已取回，会员优惠已重新核对");
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
    const pointsRestored = Number(result.data.points_restored ?? 0);
    toast.success(
      `退货已登记；孤品将进入验货流程${pointsRestored > 0 ? `，已退回 ${pointsRestored} 积分` : ""}`,
    );
    await searchOrders();
  }

  async function loadProductBrowser(query = browseQuery, offset = 0) {
    if (!activeShift || !selectedLocationId) {
      toast.error("收银台正在初始化，请稍候");
      return;
    }
    const requestId = ++browseRequest.current;
    const locationId = selectedLocationId;
    if (offset === 0) setBrowseLoading(true);
    else setBrowseLoadingMore(true);
    setBrowseError("");
    const result = await posRequest<{ items: LookupProduct[]; next_offset?: number | null }>(
      `/api/public/pos/products?location_id=${encodeURIComponent(selectedLocationId)}&type=custom&offset=${offset}&q=${encodeURIComponent(query.trim())}`,
      token,
    );
    if (requestId !== browseRequest.current || locationRef.current !== locationId) return;
    setBrowseLoading(false);
    setBrowseLoadingMore(false);
    if (!result.ok) {
      setBrowseProducts([]);
      setBrowseError(result.message ?? "商品加载失败");
      return;
    }
    setBrowseProducts((current) =>
      offset === 0
        ? result.data.items
        : [...new Map([...current, ...result.data.items].map((p) => [p.sku_id, p])).values()],
    );
    if (offset === 0) setBrowseQuery(query);
    setBrowseNext(result.data.next_offset ?? null);
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
    locationRef.current = locationId;
    catalogRequest.current++;
    browseRequest.current++;
    heldRequest.current++;
    discountRequest.current++;
    setHeldCarts([]);
    setHeldDialog(false);
    setHeldLoading(false);
    setStandardGroups([]);
    setBrands([]);
    setActiveBrand(null);
    setBrowseProducts([]);
    setBrowseNext(null);
    setBrowseLoadingMore(false);
    setStandardError("");
    setBrowseError("");
    setActiveCategoryCode(null);
    setActiveSubcategory(null);
    setProductQuery("");
    setBrowseQuery("");
    setSelectedCustomer(null);
    setCustomerBenefits(null);
    setDiscountPreview(null);
    setScanCode("");
    setPointsInput(0);
    setPointsQuote(null);
    scanQueue.current = [];
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
    if (!activeShift || paying || recoveryAttempt || recoveryError || !pendingSaleKey) return;
    let checked: PosTender[];
    try {
      checked = validatePosTenders(total, tenders);
      if (
        appliedPoints > 0 &&
        checked.some(
          (tender) =>
            !discountPreview?.points_redemption?.supported_tenders.includes(tender.provider),
        )
      ) {
        toast.error("当前积分抵扣仅支持现金收款，请更换支付方式或取消积分抵扣");
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("transaction")) toast.error("非现金支付请填写渠道交易号");
      else if (message.includes("match")) toast.error("各支付方式金额合计必须等于应收金额");
      else toast.error("请检查收款信息");
      return;
    }
    const saleBody = {
      shift_id: activeShift.id,
      items: cart.map((line) => ({
        sku_id: line.sku_id,
        quantity: line.quantity,
        subcategory_code: line.subcategory_code ?? null,
        brand_id: line.brand_id ?? null,
      })),
      tenders: checked,
      customer_id: selectedCustomer?.id,
      points_to_redeem: appliedPoints,
      discount: discountPreview ? (appliedDiscount ?? undefined) : undefined,
      benefit_snapshot: customerBenefits ?? undefined,
    };
    const signature = JSON.stringify(saleBody);
    // A timeout is not proof that the server rejected the sale. Retry the same operation.
    try {
      saleAttempt.current = preparePosSaleAttempt(saleAttempt.current, signature, () =>
        crypto.randomUUID(),
      );
    } catch {
      toast.error("上次收款结果尚未确认，请保留原单重试；不要修改后再次收款，请先在 ERP 核实订单");
      return;
    }
    const attempt = saleAttempt.current;
    try {
      // Persist before sending, so refreshing during the request cannot create a second sale.
      localStorage.setItem(pendingSaleKey, JSON.stringify(attempt));
    } catch {
      toast.error("无法保存收款保护记录，请检查浏览器存储后再收款");
      return;
    }
    setPaying(true);
    const result = await posRequest<Record<string, unknown>>("/api/public/pos/sales", token, {
      method: "POST",
      body: JSON.stringify({ ...saleBody, client_op_id: attempt.id }),
    }, isConfirmedSale);
    setPaying(false);
    if (!result.ok) {
      if (result.code === "result_unknown") {
        attempt.uncertain = true;
        setPaymentDialog(false);
        setRecoveryAttempt({ ...attempt });
      } else if (!attempt.uncertain && saleAttempt.current === attempt) {
        saleAttempt.current = null;
        localStorage.removeItem(pendingSaleKey);
      }
      toast.error(
        result.code === "result_unknown"
          ? "收款结果尚未确认，请保留原单重试，不要重复收取现金"
          : (result.message ?? "收款失败，请核对订单后重试"),
      );
      return;
    }
    setSaleResult(result.data);
    localStorage.removeItem(pendingSaleKey);
    saleAttempt.current = null;
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

  async function retryPendingSale() {
    if (!recoveryAttempt || !pendingSaleKey || paying) return;
    setPaying(true);
    const result = await posRequest<Record<string, unknown>>("/api/public/pos/sales", token, {
      method: "POST",
      body: JSON.stringify({
        ...JSON.parse(recoveryAttempt.signature),
        client_op_id: recoveryAttempt.id,
      }),
    }, isConfirmedSale);
    setPaying(false);
    if (!result.ok) {
      setRecoveryError(result.message ?? "仍未确认结果，请保留原单，不要重复收款");
      return;
    }
    localStorage.removeItem(pendingSaleKey);
    saleAttempt.current = null;
    setRecoveryAttempt(null);
    setRecoveryError("");
    setCart([]);
    setDiscountPreview(null);
    setSelectedCustomer(null);
    setCustomerBenefits(null);
    setSaleResult(result.data);
    toast.success("原单已确认成功，没有创建重复订单");
    const orderId = String(result.data.order_id ?? "");
    if (orderId) await loadReceipt(orderId);
  }

  async function cancelUnfinishedSale() {
    if (!recoveryAttempt || !pendingSaleKey || paying) return;
    const original = JSON.parse(recoveryAttempt.signature);
    setPaying(true);
    const result = await posRequest<unknown>("/api/public/pos/sales/recover/cancel", token, {
      method: "POST",
      body: JSON.stringify({ shift_id: original.shift_id, client_op_id: recoveryAttempt.id }),
    });
    setPaying(false);
    if (!result.ok) {
      setRecoveryError(result.message ?? "暂时无法核对原单，已保留收款保护记录");
      return;
    }
    const checked = SaleRecoveryResult.safeParse(result.data);
    if (!checked.success || checked.data.client_op_id !== recoveryAttempt.id) {
      setRecoveryError("核对结果异常，已保留收款保护记录，请稍后重试");
      return;
    }
    localStorage.removeItem(pendingSaleKey);
    saleAttempt.current = null;
    setRecoveryAttempt(null);
    setRecoveryError("");
    setDiscountPreview(null);
    setAppliedDiscount(null);
    setPointsInput(0);
    if (checked.data.status === "completed") {
      setCart([]);
      setProductMeta({});
      setSelectedCustomer(null);
      setCustomerBenefits(null);
      setSaleResult(checked.data.order);
      toast.success("原单已经成交，已恢复原订单，没有重复收款");
      await loadReceipt(checked.data.order.order_id);
    } else {
      toast.info("原单确认未成交，已安全取消。若已收现金，请核对后再结算，勿重复收取", {
        duration: 7000,
      });
    }
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
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#f7f8fa] text-[#101828]">
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
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-[#e4e7ec] bg-white px-3 py-1.5 sm:gap-3 sm:px-4">
        <Link
          to="/dashboard"
          className="inline-flex h-10 w-9 items-center justify-center rounded-xl text-[#344054] transition hover:bg-[#f2f4f7] sm:mr-4"
          aria-label="返回 ERP"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <img src={logo} alt="BOOMER OFF" className="h-7 w-auto sm:h-8" />
          <span className="hidden text-sm font-medium text-[#667085] sm:inline">门店收银</span>
        </div>
        <div className="contents sm:ml-auto sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:gap-3">
          <Select value={selectedLocationId} onValueChange={(value) => void switchLocation(value)}>
            <SelectTrigger
              disabled={scanning || paying}
              className="ml-auto h-10 w-28 rounded-xl border-[#e4e7ec] bg-white sm:ml-0 sm:w-40"
            >
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
          <Button
            variant="outline"
            size="icon"
            aria-label="搜索商品或输入条码"
            className="h-10 w-10 rounded-xl border-[#e4e7ec]"
            onClick={() => setSearchDialog(true)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <button
            type="button"
            onClick={() => setMemberDialog(true)}
            className="order-last flex min-h-11 w-full items-center gap-2 rounded-xl border border-[#e4e7ec] px-3 text-left sm:order-none sm:w-auto sm:min-w-52"
          >
            <UserRoundSearch className="h-5 w-5 shrink-0 text-[#0a315d]" />
            <span className="text-xs font-semibold">
              {selectedCustomer?.nickname || (selectedCustomer ? "会员" : "识别会员")}
            </span>
            {selectedCustomer ? (
              <>
                <span className="rounded bg-[#fbf0df] px-2 py-1 text-[10px] text-[#98713d]">
                  {selectedCustomer.wallet?.member_level || "暂无类型"}
                </span>
                <span className="ml-auto text-xs text-[#667085]">
                  {selectedCustomer.wallet?.points == null
                    ? "暂无积分"
                    : `${selectedCustomer.wallet.points} 积分`}
                </span>
              </>
            ) : (
              <span className="hidden text-xs text-[#667085] xl:inline">手机号 / 会员码</span>
            )}
          </button>
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

      <main
        className={`grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[minmax(0,1fr)_76px_clamp(340px,28vw,430px)] lg:grid-rows-1 ${phoneCart ? "grid-rows-1" : "grid-rows-[minmax(0,1fr)_auto]"}`}
      >
        <div className={`min-h-0 ${phoneCart ? "hidden lg:contents" : "contents"}`}>
          <PosCatalog
            tab={catalogTab}
            groups={standardGroups}
            products={browseProducts}
            activeCategoryCode={activeCategoryCode}
            subcategory={activeSubcategory}
            brands={brands}
            brand={activeBrand}
            onBrand={setActiveBrand}
            loading={catalogTab === "standard" ? standardLoading : browseLoading}
            error={catalogTab === "standard" ? standardError : browseError}
            onTab={setCatalogTab}
            onGroup={(code) => {
              setActiveCategoryCode(code);
              setActiveSubcategory(null);
              setActiveBrand(null);
            }}
            onSubcategory={setActiveSubcategory}
            onPrice={addStandardPrice}
            onProduct={(product) => addProduct(product as LookupProduct)}
            onRetry={() =>
              void (catalogTab === "standard" ? loadStandardCatalog() : loadProductBrowser())
            }
            hasMore={browseNext !== null}
            loadingMore={browseLoadingMore}
            onMore={() => {
              if (browseNext !== null) void loadProductBrowser(browseQuery, browseNext);
            }}
          />
        </div>
        <nav
          data-pos-action-rail
          aria-label="收银操作"
          className={`flex gap-2 rounded-2xl bg-[#edf0f4] p-2 lg:flex-col ${phoneCart ? "hidden lg:flex" : ""}`}
        >
          <button
            type="button"
            onClick={() => setDiscountDialog(true)}
            disabled={cart.length === 0}
            className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-[#f3dfe2] bg-[#fff5f6] text-xs font-semibold text-[#e8343a] disabled:opacity-40 lg:h-[72px] lg:flex-none lg:flex-col"
          >
            <TicketPercent className="h-5 w-5" />
            优惠
          </button>
          <button
            type="button"
            onClick={() => void loadHeldCarts()}
            disabled={!activeShift}
            className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-[#e4e7ec] bg-white text-xs font-semibold disabled:opacity-40 lg:h-[72px] lg:flex-none lg:flex-col"
          >
            <History className="h-5 w-5" />
            取单
          </button>
          <button
            type="button"
            onClick={() => void holdCart()}
            disabled={!activeShift || cart.length === 0}
            className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-[#e4e7ec] bg-white text-xs font-semibold disabled:opacity-40 lg:h-[72px] lg:flex-none lg:flex-col"
          >
            <PauseCircle className="h-5 w-5" />
            挂单
          </button>
          <button
            type="button"
            onClick={() => {
              setOrdersDialog(true);
              void searchOrders();
            }}
            disabled={!activeShift}
            className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-[#e4e7ec] bg-white text-xs font-semibold disabled:opacity-40 lg:h-[72px] lg:flex-none lg:flex-col"
          >
            <RotateCcw className="h-5 w-5" />
            退换
          </button>
          <div className="mt-auto hidden items-center gap-2 pb-5 pt-4 text-center text-[10px] text-[#667085] lg:flex lg:flex-col">
            {scanning ? (
              <Loader2 className="h-5 w-5 animate-spin text-[#0a315d]" />
            ) : (
              <ScanLine className="h-5 w-5 text-[#067647]" />
            )}
            {scanning ? "识别中" : "扫码即选品"}
          </div>
        </nav>
        <aside
          data-pos-checkout-panel
          className={`min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-[#e4e7ec] bg-white ${phoneCart ? "grid" : "hidden lg:grid"}`}
        >
          <div className="flex h-12 items-center gap-2 border-b border-[#eaecf0] px-4">
            <button
              type="button"
              aria-label="返回选品"
              className="mr-1 flex h-10 w-9 items-center lg:hidden"
              onClick={() => setPhoneCart(false)}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h2 className="text-base font-bold">购物车</h2>
            <p className="ml-auto text-xs text-[#667085]">
              共 <strong className="px-1 text-lg tabular-nums text-[#101828]">{itemCount}</strong>{" "}
              件
            </p>
            <button
              type="button"
              className="ml-4 min-h-10 text-xs text-[#667085] hover:text-[#e8343a]"
              disabled={cart.length === 0}
              onClick={() => {
                setCart([]);
                cartRef.current = [];
                setProductMeta({});
                setDiscountPreview(null);
              }}
            >
              清空
            </button>
          </div>
          <div data-pos-cart-scroll className="min-h-0 overflow-y-auto px-3">
            {cart.length === 0 ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-[#667085]">
                <ShoppingBag className="h-7 w-7 text-[#98a2b3]" />
                <p>等待扫码或选择商品</p>
                {saleResult && (
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-xl bg-[#ecfdf3] px-3 py-2 text-xs text-[#067647]"
                    onClick={() => {
                      const id = String(saleResult.order_id ?? "");
                      if (id) void loadReceipt(id);
                    }}
                  >
                    <Check className="h-4 w-4" />
                    上一单已完成 · 打印小票
                  </button>
                )}
              </div>
            ) : (
              cart.map((line) => {
                const meta = productMeta[line.sku_id];
                const lineKey = posCartLineKey(line);
                return (
                  <div
                    key={lineKey}
                    data-pos-cart-line
                    className="grid min-h-[72px] grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#eaecf0] py-2"
                  >
                    <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg bg-[#f2f4f7]">
                      {meta?.image_url ? (
                        <img src={meta.image_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <PackageOpen className="h-5 w-5 text-[#98a2b3]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p title={posCartLineLabel(line)} className="truncate text-xs font-semibold">
                        {posCartLineLabel(line)}
                      </p>
                      <p className="mt-2 truncate text-[10px] text-[#667085]">
                        {money(line.unit_price)}
                        {line.product_type === "standard" ? " 档" : ""} ·{" "}
                        {meta?.barcode ||
                          meta?.sku_code ||
                          (line.product_type === "standard" ? "标准商品" : "自定义商品")}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <p className="text-sm font-bold tabular-nums">
                        {money(line.unit_price * line.quantity)}
                      </p>
                      <div className="flex items-center">
                        <button
                          type="button"
                          aria-label={`减少 ${posCartLineLabel(line)}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f7f8fa]"
                          onClick={() => updateQuantity(lineKey, line.quantity - 1)}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="min-w-7 text-center text-xs tabular-nums">
                          {line.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label={`增加 ${posCartLineLabel(line)}`}
                          disabled={
                            line.product_type === "custom" ||
                            (!line.is_unlimited_stock && line.quantity >= line.available_qty)
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f7f8fa] disabled:opacity-30"
                          onClick={() => updateQuantity(lineKey, line.quantity + 1)}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${posCartLineLabel(line)}`}
                          className="ml-0.5 flex h-8 w-7 items-center justify-center text-[#98a2b3] hover:text-[#e8343a]"
                          onClick={() => updateQuantity(lineKey, 0)}
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
          <div data-pos-settlement-footer className="space-y-3 border-t border-[#eaecf0] p-4">
            <div className="flex justify-between text-xs text-[#667085]">
              <span>商品小计</span>
              <span className="tabular-nums">{money(subtotal)}</span>
            </div>
            <button
              type="button"
              className="flex w-full justify-between text-xs text-[#667085]"
              disabled={!cart.length}
              onClick={() => setDiscountDialog(true)}
            >
              <span>整单优惠</span>
              <span className="tabular-nums text-[#e8343a]">-{money(discountTotal)}</span>
            </button>
            {discountPreview?.excluded_total ? (
              <p className="text-[10px] text-[#98a2b3]">
                寄售/特殊商品 {money(discountPreview.excluded_total)} 不参与优惠
              </p>
            ) : null}
            <div className="flex items-end justify-between pt-2">
              <span className="text-sm font-semibold">应收金额</span>
              <strong className="text-3xl leading-none tabular-nums text-[#e8343a]">
                {money(total)}
              </strong>
            </div>
            <Button
              className="h-13 w-full rounded-xl bg-[#e8343a] text-base font-semibold hover:bg-[#c92930]"
              disabled={!activeShift || cart.length === 0}
              onClick={startPayment}
            >
              <Barcode className="mr-2 h-5 w-5" />
              收款
            </Button>
          </div>
        </aside>
      </main>
      {!phoneCart && (
        <div className="flex shrink-0 items-center gap-3 border-t border-[#eaecf0] bg-white px-4 py-3 lg:hidden">
          <button
            type="button"
            className="flex flex-1 items-center gap-3 text-left"
            onClick={() => setPhoneCart(true)}
          >
            <ShoppingBag className="h-6 w-6 text-[#0a315d]" />
            <span>
              <b className="text-lg tabular-nums">{money(total)}</b>
              <span className="ml-3 text-xs text-[#667085]">共 {itemCount} 件</span>
            </span>
          </button>
          <Button
            disabled={!cart.length}
            onClick={() => setPhoneCart(true)}
            className="h-11 rounded-xl bg-[#e8343a] px-6"
          >
            查看购物车
          </Button>
        </div>
      )}

      <Dialog open={Boolean(recoveryAttempt || recoveryError)}>
        <DialogContent
          className="max-w-md rounded-2xl"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>核对上一笔收款</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-6 text-[#667085]">
            上一笔提交后未确认结果。请重试原单，不要再次收取现金，也不要重新建单。刷新页面不会清除这笔记录。
          </p>
          {recoveryError && (
            <p role="alert" className="text-sm text-[#e8343a]">
              {recoveryError}
            </p>
          )}
          <Button disabled={!recoveryAttempt || paying} onClick={() => void retryPendingSale()}>
            {paying ? "正在核对原单" : "重试原单（不重复收款）"}
          </Button>
          <Button
            variant="outline"
            disabled={!recoveryAttempt || paying}
            onClick={() => void cancelUnfinishedSale()}
          >
            核对并取消未成交单
          </Button>
          <p className="text-xs leading-5 text-[#667085]">
            只有服务端确认未成交才会解除；若已成交，会恢复原订单。
          </p>
          <Button variant="outline" asChild>
            <Link to="/dashboard">返回 ERP 核实订单</Link>
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={searchDialog} onOpenChange={setSearchDialog}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle>商品搜索</DialogTitle>
          </DialogHeader>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setCatalogTab("custom");
              setPhoneCart(false);
              void loadProductBrowser(productQuery);
              setSearchDialog(false);
            }}
          >
            <Input
              autoFocus
              aria-label="商品名称"
              placeholder="输入自定义商品名称"
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
            />
            <Button type="submit" disabled={browseLoading}>
              搜索
            </Button>
          </form>
          <p className="text-xs text-[#667085]">
            标准商品请在商品名称下选择价位；扫码枪在选品页直接使用。
          </p>
          <form
            className="flex gap-2 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              void scanHandler.current(scanCode);
            }}
          >
            <Input
              ref={scanRef}
              aria-label="商品或会员条码"
              placeholder="手动输入条码 / SKU / 会员码"
              value={scanCode}
              onChange={(e) => setScanCode(e.target.value)}
              autoComplete="off"
            />
            <Button type="submit" disabled={scanning || !scanCode.trim()}>
              {scanning ? "识别中" : "识别"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

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
                setPointsInput(0);
                setPointsQuote(null);
                setDiscountPreview(null);
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
          <section
            className="rounded-xl border border-[#e4e7ec] bg-[#f9fafb] p-4"
            aria-label="积分抵扣"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">积分抵扣</h3>
              <span className="text-xs text-[#667085]">
                {selectedCustomer
                  ? `可用 ${pointsQuote?.available_points ?? selectedCustomer.wallet?.points ?? 0} 积分`
                  : "请先选择会员"}
              </span>
            </div>
            {!selectedCustomer ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setDiscountDialog(false);
                  setMemberDialog(true);
                }}
              >
                选择会员
              </Button>
            ) : (
              <>
                <div className="mt-3 flex items-center gap-2">
                  <Input
                    aria-label="抵扣积分"
                    type="number"
                    min="0"
                    step={pointsQuote?.points_per_unit ?? 1}
                    max={pointsQuote?.max_points ?? 0}
                    disabled={!pointsQuote?.enabled && !pointsQuoteLoading}
                    value={pointsInput || ""}
                    placeholder="输入积分"
                    onChange={(e) =>
                      setPointsInput(Math.max(0, Math.floor(Number(e.target.value) || 0)))
                    }
                  />
                  <Button
                    variant="outline"
                    disabled={!pointsQuote?.enabled || pointsQuoteLoading}
                    onClick={() => setPointsInput(pointsQuote?.max_points ?? 0)}
                  >
                    用满
                  </Button>
                  {pointsInput > 0 && (
                    <button
                      type="button"
                      className="shrink-0 text-xs text-[#667085]"
                      onClick={() => setPointsInput(0)}
                    >
                      不用积分
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs leading-5 text-[#667085]">
                  {pointsQuoteLoading
                    ? "正在向 ERP 试算积分…"
                    : pointsQuoteError ||
                      (!pointsQuote
                        ? "当前服务尚未开通积分抵扣"
                        : !pointsQuote.enabled
                          ? pointsQuote.reason === "membership_points_not_allowed"
                            ? "当前会员暂不享有积分抵扣权益"
                            : "积分抵扣规则尚未配置，暂不可使用"
                          : `本单最多 ${pointsQuote.max_points} 积分；本次抵扣 ${money(pointsQuote.discount_amount)}`)}
                </p>
                {pointsQuote?.enabled && (
                  <p className="text-xs leading-5 text-[#98713d]">
                    当前支持现金收款；付款成功后才扣积分。整单优惠后按会员上限计算。
                  </p>
                )}
              </>
            )}
          </section>
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
            disabled={
              discountLoading || pointsQuoteLoading || (pointsInput > 0 && !pointsQuote?.enabled)
            }
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

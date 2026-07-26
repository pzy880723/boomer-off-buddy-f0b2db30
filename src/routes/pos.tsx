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
  Loader2,
  LogOut,
  Minus,
  PackageOpen,
  Plus,
  Printer,
  QrCode,
  ScanLine,
  ShoppingBag,
  Trash2,
  WalletCards,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAuthSession } from "@/hooks/use-auth-session";
import {
  addScannedProduct,
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
};
type ReceiptData = {
  order_id: string;
  order_no: string;
  receipt_no: string;
  location_name: string;
  total_amount: number;
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
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseProducts, setBrowseProducts] = useState<LookupProduct[]>([]);
  const [openShiftDialog, setOpenShiftDialog] = useState(false);
  const [openingCash, setOpeningCash] = useState("0");
  const [registerName, setRegisterName] = useState("前台收银机");
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [tenders, setTenders] = useState<PosTender[]>([]);
  const [paying, setPaying] = useState(false);
  const [saleResult, setSaleResult] = useState<Record<string, unknown> | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [receiptDialog, setReceiptDialog] = useState(false);
  const [closeDialog, setCloseDialog] = useState(false);
  const [countedCash, setCountedCash] = useState("0");
  const [closing, setClosing] = useState(false);

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
    setBootstrap(result.data);
    const existingShift = result.data.open_shifts[0];
    const nextLocationId =
      existingShift?.location_id ||
      (selectedLocationId &&
      result.data.locations.some((location) => location.id === selectedLocationId)
        ? selectedLocationId
        : result.data.locations[0]?.id) ||
      "";
    setSelectedLocationId(nextLocationId);
    setOpenShiftDialog(Boolean(nextLocationId && !existingShift));
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
  const total = useMemo(
    () => cart.reduce((sum, line) => sum + line.unit_price * line.quantity, 0),
    [cart],
  );
  const itemCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);

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

  function addProduct(product: LookupProduct) {
    try {
      setCart((current) => addScannedProduct(current, product));
      setProductMeta((current) => ({ ...current, [product.sku_id]: product }));
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
      toast.error("请先开班，再开始扫码");
      setOpenShiftDialog(true);
      return;
    }
    setScanning(true);
    const result = await posRequest<LookupProduct>(
      `/api/public/pos/products/lookup?code=${encodeURIComponent(code)}&location_id=${encodeURIComponent(selectedLocationId)}`,
      token,
    );
    setScanning(false);
    setScanCode("");
    scanRef.current?.focus();
    if (!result.ok) {
      toast.error(result.message ?? "未找到可售商品");
      return;
    }
    addProduct(result.data);
  }

  async function loadProductBrowser() {
    if (!activeShift || !selectedLocationId) {
      toast.error("请先开班，再浏览商品");
      setOpenShiftDialog(true);
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

  function updateQuantity(skuId: string, nextQuantity: number) {
    setCart((current) =>
      current.flatMap((line) => {
        if (line.sku_id !== skuId) return [line];
        if (nextQuantity <= 0) return [];
        if (line.product_type === "custom" && nextQuantity > 1) {
          toast.warning("孤品每单只能销售 1 件");
          return [line];
        }
        if (nextQuantity > line.available_qty) {
          toast.warning("数量不能超过当前可售库存");
          return [line];
        }
        return [{ ...line, quantity: nextQuantity }];
      }),
    );
  }

  async function openShift() {
    if (!selectedLocationId) {
      toast.error("请选择门店或仓库");
      return;
    }
    const cash = Number(openingCash);
    if (!Number.isFinite(cash) || cash < 0) {
      toast.error("备用金金额不正确");
      return;
    }
    const result = await posRequest<PosShift>("/api/public/pos/shifts/open", token, {
      method: "POST",
      body: JSON.stringify({
        location_id: selectedLocationId,
        register_code: `POS-${selectedLocationId.slice(0, 6).toUpperCase()}`,
        register_name: registerName.trim() || "前台收银机",
        opening_cash: cash,
      }),
    });
    if (!result.ok) {
      toast.error(result.message ?? "开班失败");
      return;
    }
    toast.success("开班成功，可以开始收银");
    setOpenShiftDialog(false);
    await loadBootstrap();
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
        items: cart.map((line) => ({ sku_id: line.sku_id, quantity: line.quantity })),
        tenders: checked,
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
    toast.success("收款完成，库存与订单已同步");
    const orderId = String(result.data.order_id ?? "");
    if (orderId) await loadReceipt(orderId);
  }

  async function closeShift() {
    if (!activeShift) return;
    const cash = Number(countedCash);
    if (!Number.isFinite(cash) || cash < 0) {
      toast.error("实点现金金额不正确");
      return;
    }
    setClosing(true);
    const result = await posRequest<Record<string, unknown>>(
      `/api/public/pos/shifts/${activeShift.id}/close`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ counted_cash: cash }),
      },
    );
    setClosing(false);
    if (!result.ok) {
      toast.error(result.message ?? "交班失败");
      return;
    }
    toast.success("交班完成");
    setCloseDialog(false);
    setCart([]);
    await loadBootstrap();
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
          @page { size: 80mm auto; margin: 4mm; }
          body * { visibility: hidden !important; }
          .pos-receipt, .pos-receipt * { visibility: visible !important; }
          .pos-receipt {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            width: 72mm !important;
            border: 0 !important;
            box-shadow: none !important;
          }
          .pos-receipt-actions { display: none !important; }
        }
      `}</style>
      <header className="flex h-16 items-center border-b border-[#e4e7ec] bg-white px-5">
        <Link
          to="/dashboard"
          className="mr-4 inline-flex h-10 w-10 items-center justify-center rounded-xl text-[#344054] transition hover:bg-[#f2f4f7]"
          aria-label="返回 ERP"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-baseline gap-3">
          <span className="text-xl font-black tracking-[-0.04em] text-[#0a315d]">BOOMER ERP</span>
          <span className="text-sm font-medium text-[#667085]">门店收银</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Select
            value={selectedLocationId}
            onValueChange={(value) => {
              if (cart.length > 0) {
                toast.warning("请先清空当前购物车再切换库位");
                return;
              }
              setSelectedLocationId(value);
              setOpenShiftDialog(
                !bootstrap.open_shifts.some(
                  (shift) => shift.location_id === value && shift.status !== "closed",
                ),
              );
            }}
          >
            <SelectTrigger className="h-10 w-52 rounded-xl border-[#d0d5dd] bg-white">
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
                ? "h-8 rounded-full border-[#abefc6] bg-[#ecfdf3] px-3 text-[#067647]"
                : "h-8 rounded-full border-[#fedf89] bg-[#fffaeb] px-3 text-[#b54708]"
            }
          >
            {activeShift ? `已开班 · ${activeShift.register?.name ?? "收银机"}` : "未开班"}
          </Badge>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-[#d0d5dd]"
            disabled={!activeShift || cart.length > 0}
            onClick={() => setCloseDialog(true)}
          >
            <LogOut className="mr-2 h-4 w-4" />
            交班
          </Button>
        </div>
      </header>

      <main className="grid min-h-[calc(100vh-64px)] grid-cols-[minmax(0,1fr)_420px] gap-4 p-4">
        <section className="flex min-w-0 flex-col gap-4">
          <div className="rounded-2xl border border-[#e4e7ec] bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
            <div className="flex items-center gap-3">
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
                className="h-14 rounded-xl bg-[#e8343a] px-7 text-base hover:bg-[#c92930]"
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
                  <div className="grid max-h-64 grid-cols-4 gap-3 overflow-y-auto pr-1">
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
                              库存 {product.available_qty}
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

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#e4e7ec] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
            <div className="flex h-14 items-center border-b border-[#eaecf0] px-5">
              <ShoppingBag className="mr-2 h-5 w-5 text-[#0a315d]" />
              <h1 className="text-base font-semibold">购物车</h1>
              <Badge className="ml-2 rounded-full bg-[#eef4fb] text-[#0a315d] hover:bg-[#eef4fb]">
                {itemCount} 件
              </Badge>
              {cart.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-[#667085]"
                  onClick={() => {
                    setCart([]);
                    setProductMeta({});
                  }}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  清空
                </Button>
              )}
            </div>
            {cart.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#eef4fb]">
                  <ScanLine className="h-8 w-8 text-[#0a315d]" />
                </div>
                <h2 className="mt-5 text-lg font-semibold">等待扫码</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-[#667085]">
                  将光标保持在上方扫码框。扫码成功后，真实商品、价格与当前库位可售库存会显示在这里。
                </p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {cart.map((line) => {
                  const meta = productMeta[line.sku_id];
                  return (
                    <div
                      key={line.sku_id}
                      className="grid grid-cols-[72px_minmax(0,1fr)_150px_120px_44px] items-center gap-4 border-b border-[#f0f1f3] px-5 py-4 last:border-0"
                    >
                      <div className="flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-xl bg-[#f2f4f7]">
                        {meta?.image_url ? (
                          <img src={meta.image_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <PackageOpen className="h-6 w-6 text-[#98a2b3]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{line.name}</div>
                        <div className="mt-1 truncate font-mono text-xs text-[#667085]">
                          {meta?.barcode || meta?.sku_code || line.sku_id}
                        </div>
                        <div className="mt-2 flex gap-1.5">
                          <Badge variant="secondary" className="rounded-md font-normal">
                            {line.product_type === "custom"
                              ? "自定义孤品"
                              : line.product_type === "bundle"
                                ? "组包商品"
                                : "标准商品"}
                          </Badge>
                          <Badge variant="outline" className="rounded-md font-normal">
                            可售 {line.available_qty}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center justify-center">
                        <button
                          type="button"
                          className="flex h-9 w-9 items-center justify-center rounded-l-lg border border-[#d0d5dd] text-[#344054] disabled:opacity-35"
                          onClick={() => updateQuantity(line.sku_id, line.quantity - 1)}
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <div className="flex h-9 w-12 items-center justify-center border-y border-[#d0d5dd] bg-[#f9fafb] text-sm font-semibold tabular-nums">
                          {line.quantity}
                        </div>
                        <button
                          type="button"
                          className="flex h-9 w-9 items-center justify-center rounded-r-lg border border-[#d0d5dd] text-[#344054] disabled:opacity-35"
                          disabled={
                            line.product_type === "custom" || line.quantity >= line.available_qty
                          }
                          onClick={() => updateQuantity(line.sku_id, line.quantity + 1)}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-[#667085]">{money(line.unit_price)} / 件</div>
                        <div className="mt-1 text-lg font-bold tabular-nums text-[#e8343a]">
                          {money(line.unit_price * line.quantity)}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-[#98a2b3] hover:bg-[#fff1f2] hover:text-[#e8343a]"
                        onClick={() => updateQuantity(line.sku_id, 0)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col rounded-2xl border border-[#e4e7ec] bg-white p-5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">本单结算</p>
              <p className="mt-1 text-xs text-[#667085]">库存将在收款成功后扣减</p>
            </div>
            <Badge variant="outline" className="rounded-full border-[#d0d5dd] text-[#475467]">
              {itemCount} 件商品
            </Badge>
          </div>

          <div className="mt-6 space-y-4 text-sm">
            <div className="flex justify-between text-[#667085]">
              <span>商品小计</span>
              <span className="tabular-nums text-[#344054]">{money(total)}</span>
            </div>
            <div className="flex justify-between text-[#667085]">
              <span>优惠</span>
              <span className="tabular-nums text-[#344054]">{money(0)}</span>
            </div>
          </div>
          <Separator className="my-5" />
          <div className="flex items-end justify-between">
            <span className="text-sm font-medium text-[#475467]">应收金额</span>
            <span className="text-4xl font-black tracking-[-0.04em] tabular-nums text-[#101828]">
              {money(total)}
            </span>
          </div>

          <div className="mt-auto space-y-3 pt-8">
            {saleResult && (
              <div className="rounded-xl border border-[#abefc6] bg-[#ecfdf3] p-4">
                <div className="flex items-center gap-2 font-semibold text-[#067647]">
                  <Check className="h-4 w-4" />
                  上一单已完成
                </div>
                <p className="mt-1 text-xs text-[#047857]">
                  订单、支付、库存和收银班次流水已同步。
                </p>
                <button
                  type="button"
                  className="mt-3 inline-flex items-center text-xs font-semibold text-[#067647] underline underline-offset-4"
                  onClick={() => {
                    const orderId = String(saleResult.order_id ?? "");
                    if (orderId) void loadReceipt(orderId);
                  }}
                >
                  <Printer className="mr-1.5 h-3.5 w-3.5" />
                  打印小票
                </button>
              </div>
            )}
            <Button variant="outline" className="h-12 w-full rounded-xl border-[#d0d5dd]" disabled>
              <ChevronDown className="mr-2 h-4 w-4" />
              挂单功能即将接入
            </Button>
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

      <Dialog open={openShiftDialog} onOpenChange={setOpenShiftDialog}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>开始收银班次</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 pt-2">
            <div className="rounded-xl bg-[#eef4fb] p-4">
              <p className="text-sm font-semibold text-[#0a315d]">{selectedLocation?.name}</p>
              <p className="mt-1 text-xs text-[#475467]">开班后才能扫码、收款和打印小票。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="register-name">收银机名称</Label>
              <Input
                id="register-name"
                value={registerName}
                onChange={(event) => setRegisterName(event.target.value)}
                className="h-11 rounded-xl"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="opening-cash">开班备用金</Label>
              <Input
                id="opening-cash"
                type="number"
                min="0"
                step="0.01"
                value={openingCash}
                onChange={(event) => setOpeningCash(event.target.value)}
                className="h-11 rounded-xl"
              />
            </div>
            <Button
              className="h-12 w-full rounded-xl bg-[#0a315d] hover:bg-[#08284c]"
              onClick={() => void openShift()}
            >
              确认开班
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent className="max-w-xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>收款</DialogTitle>
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

      <Dialog open={closeDialog} onOpenChange={setCloseDialog}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>交班与现金对账</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 pt-2">
            <div className="rounded-xl bg-[#f2f4f7] p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-[#667085]">开班时间</span>
                <span>
                  {activeShift?.opened_at
                    ? new Date(activeShift.opened_at).toLocaleString("zh-CN")
                    : "—"}
                </span>
              </div>
              <div className="mt-3 flex justify-between">
                <span className="text-[#667085]">开班备用金</span>
                <span className="font-semibold">
                  {money(Number(activeShift?.opening_cash ?? 0))}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="counted-cash">实点现金</Label>
              <Input
                id="counted-cash"
                type="number"
                min="0"
                step="0.01"
                value={countedCash}
                onChange={(event) => setCountedCash(event.target.value)}
                className="h-12 rounded-xl text-lg font-semibold tabular-nums"
              />
              <p className="text-xs text-[#667085]">系统会计算应有现金和交班差异并永久记录。</p>
            </div>
            <Button
              className="h-12 w-full rounded-xl bg-[#0a315d] hover:bg-[#08284c]"
              disabled={closing}
              onClick={() => void closeShift()}
            >
              {closing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              确认交班
            </Button>
          </div>
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
              <div className="pos-receipt-actions mt-5 grid grid-cols-2 gap-3 font-sans">
                <Button
                  variant="outline"
                  className="rounded-xl"
                  onClick={() => setReceiptDialog(false)}
                >
                  关闭
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

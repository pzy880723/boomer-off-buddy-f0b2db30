import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { readCardPrintContext } from '@/lib/card-print.functions';
import { loadCatalog, assertQrLocation, permitted, resolveSelection, sameOriginUrl, type CardPreset, type Selection } from '@/lib/card-print/contract';
import type { QrImage } from '@/lib/card-print/qr-policy';

const categoryNames: Record<CardPreset['category'], string> = { qr: '扫码入口', store_notice: '店铺提示', ip: 'IP', brand: '品牌', category: '品类', import_origin: '进口来源', product: '商品推荐' };
export function CardPrintWorkspace() {
  const readContext = useServerFn(readCardPrintContext);
  const [locationId, setLocationId] = useState('');
  const [presets, setPresets] = useState<CardPreset[]>([]);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [orientation, setOrientation] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pages, setPages] = useState(0);
  const [printPending, setPrintPending] = useState(false);
  const context = useQuery({ queryKey: ['card-print-context', locationId], queryFn: () => readContext({ data: locationId ? { location_id: locationId } : {} }), retry: false });
  useEffect(() => { if (!locationId && context.data?.locations.length === 1) setLocationId(context.data.locations[0].id); }, [context.data, locationId]);
  useEffect(() => { void loadManifest(); }, []);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
  const clearPreview = () => { setPdfUrl(''); setPages(0); };
  const updateSelection = (next: Selection[]) => { clearPreview(); setSelection(next); };
  async function loadManifest() {
    setBusy(true); setError(''); clearPreview(); setSelection([]); setPresets([]);
    try {
      setPresets((await loadCatalog(window.location.origin)).filter(permitted));
    } catch { setError('预设清单无法读取或格式不符，未载入任何卡片。'); }
    finally { setBusy(false); }
  }
  async function preview(mode: 'preview' | 'download' | 'print' = 'preview') {
    setBusy(true); setError(''); clearPreview();
    try {
      // Always re-read authorization and active codes before every output, never reuse a saved signed URL.
      const fresh = await readContext({ data: { location_id: locationId } });
      assertQrLocation(fresh.location_id, locationId);
      const current = await loadCatalog(window.location.origin);
      const cards = resolveSelection(current, selection, locationId, fresh.channels.map(c => c.channel));
      const { createCardPdf } = await import('@/lib/card-print/pdf');
      const { packA4 } = await import('@/lib/card-print/contract');
      const bytes = await createCardPdf(cards, fresh.channels, window.location.origin);
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }));
      setPdfUrl(url); setPages(packA4(cards).length);
      if (mode === 'download') { const a = document.createElement('a'); a.href = url; a.download = 'BOOMER-OFF-A4.pdf'; a.click(); }
      setPrintPending(mode === 'print');
    } catch (e) { setError(e instanceof Error ? e.message : '打印文件生成失败'); }
    finally { setBusy(false); }
  }
  const images: QrImage[] = context.data?.channels ?? [];
  const visible = presets.filter(p => (category === 'all' || p.category === category) && (orientation === 'all' || p.orientation === orientation) && p.name.toLowerCase().includes(search.toLowerCase()) && (!p.location_id || p.location_id === locationId));
  const missingQr = (p: CardPreset) => p.category === 'qr' && !images.some(c => c.channel === p.channel);
  return <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">卡片打印</h1><p className="mt-1 text-sm text-muted-foreground">BOOMER OFF · A4 · 100%实际大小</p></div>
      {context.data?.can_switch ? <Select disabled={busy} value={locationId} onValueChange={id => { setLocationId(id); updateSelection([]); setError(''); }}><SelectTrigger className="w-56" aria-label="打印门店"><SelectValue placeholder="选择门店" /></SelectTrigger><SelectContent>{context.data.locations.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select> : <span>{context.data?.locations.find(s => s.id === locationId)?.name ?? '本店权限待核对'}</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2 border-y py-4">
      <Button variant="outline" disabled={busy} onClick={loadManifest}><RefreshCw />刷新预设</Button>
      <span className="text-sm text-muted-foreground">{presets.length ? `${presets.length} 个可用预设` : '预设原图待接入'}</span>
    </div>
    {(error || context.error) && <p role="alert" className="text-sm text-destructive">{error || '门店或二维码读取失败，请重试。'}</p>}
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="min-w-0 space-y-4" aria-label="预设选择">
        <div className="flex flex-wrap gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="搜索预设" className="pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索预设" /></div><Select value={category} onValueChange={setCategory}><SelectTrigger className="w-36" aria-label="预设类别"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部类别</SelectItem>{Object.entries(categoryNames).map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}</SelectContent></Select><Select value={orientation} onValueChange={setOrientation}><SelectTrigger className="w-28" aria-label="横竖规格"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部规格</SelectItem><SelectItem value="landscape">横版</SelectItem><SelectItem value="portrait">竖版</SelectItem></SelectContent></Select></div>
        {!visible.length && <div className="border-y py-12 text-center text-sm text-muted-foreground">{presets.length ? '暂无匹配预设' : '暂无已接入的预设原图'}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map(p => {
            const selected = selection.find(s => s.id === p.id), missing = missingQr(p);
            return <div key={p.id} className="overflow-hidden rounded-md border bg-card">
              <div className="flex h-36 items-center justify-center bg-muted p-3"><div className="relative max-h-full max-w-full" style={{ aspectRatio: `${p.width_mm}/${p.height_mm}`, height: p.width_mm >= p.height_mm ? undefined : '100%', width: p.width_mm >= p.height_mm ? '100%' : undefined }}><img src={p.thumbnail_path ?? p.image_path} alt={p.name} className="h-full w-full object-contain" />{p.qr_box && (() => { const code = images.find(c => c.channel === p.channel); return code ? <img src={code.image_url} alt="" className="absolute" style={{ left: `${p.qr_box.x_mm / p.width_mm * 100}%`, top: `${p.qr_box.y_mm / p.height_mm * 100}%`, width: `${p.qr_box.size_mm / p.width_mm * 100}%`, height: `${p.qr_box.size_mm / p.height_mm * 100}%` }} /> : null; })()}</div></div>
              <div className="space-y-2 p-3"><label className="flex items-start gap-2"><Checkbox aria-label={`选择${p.name}`} checked={!!selected} disabled={!locationId || missing || busy} onCheckedChange={checked => updateSelection(checked ? [...selection, { id: p.id, quantity: 1 }] : selection.filter(s => s.id !== p.id))} /><span className="min-w-0 break-words text-sm font-medium">{p.name}</span></label><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{p.width_mm}×{p.height_mm}mm · {p.orientation === 'landscape' ? '横版' : '竖版'}</span>{selected && <Input aria-label={`${p.name}数量`} type="number" min={1} max={100} className="h-7 w-16" value={selected.quantity} onChange={e => updateSelection(selection.map(s => s.id === p.id ? { ...s, quantity: Number(e.target.value) } : s))} />}</div>{missing && <p className="text-xs text-warning">门店缺码 / 未启用</p>}</div>
            </div>;
          })}
        </div>
      </section>
      <section className="min-w-0 space-y-3" aria-label="A4打印预览">
        <div className="flex flex-wrap items-center gap-2"><Button disabled={busy || !selection.length || !locationId} onClick={() => preview()}>{busy ? '正在生成…' : '生成 A4 预览'}</Button><span className="text-sm text-muted-foreground">{selection.reduce((sum, s) => sum + s.quantity, 0)} 张{pages ? ` · ${pages} 页` : ''}</span>
          <Button variant="outline" disabled={!pdfUrl || busy} onClick={() => preview('download')}><Download />PDF导出</Button>
          <Button variant="outline" disabled={!pdfUrl || busy} onClick={() => preview('print')}><Printer />打印</Button>
        </div>
        {pdfUrl ? <iframe id="card-print-pdf" title="A4零间距预览" src={pdfUrl} onLoad={e => { if (printPending) { setPrintPending(false); e.currentTarget.contentWindow?.focus(); e.currentTarget.contentWindow?.print(); } }} className="h-[760px] w-full rounded-md border bg-card" /> : <div className="flex aspect-[210/297] w-full items-center justify-center border bg-card text-sm text-muted-foreground">A4预览待生成</div>}
      </section>
    </div>
  </div>;
}

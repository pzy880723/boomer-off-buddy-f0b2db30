import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { createSku } from "@/lib/inventory.functions";
import { INV_CATEGORIES, PRICE_TIERS, SKU_KIND_LABEL } from "@/lib/inventory.helpers";

export function SkuFormDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const createFn = useServerFn(createSku);
  const [category, setCategory] = useState<string>("");
  const [priceTier, setPriceTier] = useState<string>("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"single" | "pack">("single");
  const [packPieces, setPackPieces] = useState<string>("");
  const [weight, setWeight] = useState<string>("");
  const [image, setImage] = useState<string>("");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setCategory("");
    setPriceTier("");
    setName("");
    setKind("single");
    setPackPieces("");
    setWeight("");
    setImage("");
    setNotes("");
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!category || !priceTier || !name.trim()) {
        throw new Error("类目 / 价格档 / 品名 必填");
      }
      if (kind === "pack" && !packPieces) {
        throw new Error("组包请填写内含件数");
      }
      return createFn({
        data: {
          category: category as never,
          price_tier: Number(priceTier),
          name: name.trim(),
          kind,
          pack_pieces: kind === "pack" ? Number(packPieces) : null,
          weight_g: weight ? Number(weight) : null,
          image_url: image.trim() || null,
          notes: notes.trim() || null,
          status: "active",
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`SKU 已创建，EPC：${res.sku.epc}`);
      onOpenChange(false);
      reset();
      onCreated?.(res.sku.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 SKU</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>类目 *</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue placeholder="选择" /></SelectTrigger>
                <SelectContent>
                  {INV_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>价格档 *</Label>
              <Select value={priceTier} onValueChange={setPriceTier}>
                <SelectTrigger><SelectValue placeholder="选择" /></SelectTrigger>
                <SelectContent>
                  {PRICE_TIERS.map((t) => (
                    <SelectItem key={t} value={String(t)}>¥{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>品名 *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：奥特曼软胶"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>类型 *</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as "single" | "pack")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">{SKU_KIND_LABEL.single}</SelectItem>
                  <SelectItem value="pack">{SKU_KIND_LABEL.pack}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === "pack" && (
              <div className="space-y-1.5">
                <Label>组包件数 *</Label>
                <Input
                  type="number"
                  value={packPieces}
                  onChange={(e) => setPackPieces(e.target.value)}
                  placeholder="如 10"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>单件重量(g)</Label>
              <Input
                type="number"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>图片 URL</Label>
              <Input
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="可选"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>备注</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : "创建并生成 EPC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

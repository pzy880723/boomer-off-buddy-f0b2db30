// 商品特色印章（单选可清空）+ 提示标签（多选，功能不确定/不可用互斥）。界面只显示中文。
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  EXCLUSIVE_NOTICE_TAGS, FEATURED_STAMPS, FEATURED_STAMP_LABELS, NOTICE_TAGS, NOTICE_TAG_LABELS,
  normalizeNoticeTags, type FeaturedStamp, type NoticeTag,
} from "@/lib/commerce/product-marks";

export function ProductMarksFields(props: {
  stamp: FeaturedStamp | null;
  tags: NoticeTag[];
  onStampChange: (v: FeaturedStamp | null) => void;
  onTagsChange: (v: NoticeTag[]) => void;
}) {
  const toggleTag = (t: NoticeTag, on: boolean) => {
    let next = props.tags.filter((x) => x !== t);
    if (on) {
      next.push(t);
      // 互斥：选中一个自动取消另一个
      if ((EXCLUSIVE_NOTICE_TAGS as readonly NoticeTag[]).includes(t)) {
        next = next.filter((x) => x === t || !(EXCLUSIVE_NOTICE_TAGS as readonly NoticeTag[]).includes(x));
      }
    }
    props.onTagsChange(normalizeNoticeTags(next));
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>特色印章（可选，单选）</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          className="flex flex-wrap justify-start"
          value={props.stamp ?? ""}
          onValueChange={(v) => props.onStampChange(v ? (v as FeaturedStamp) : null)}
        >
          {FEATURED_STAMPS.map((s) => (
            <ToggleGroupItem key={s} value={s} size="sm">{FEATURED_STAMP_LABELS[s]}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">再次点击已选印章即可清空。</p>
      </div>
      <div className="space-y-1.5">
        <Label>提示标签（可选，多选）</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {NOTICE_TAGS.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <Checkbox checked={props.tags.includes(t)} onCheckedChange={(c) => toggleTag(t, c === true)} />
              {NOTICE_TAG_LABELS[t]}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">“功能不确定”与“功能不可用”只能选一个。</p>
      </div>
    </div>
  );
}

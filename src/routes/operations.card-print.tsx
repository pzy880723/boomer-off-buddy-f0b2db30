import { createFileRoute } from '@tanstack/react-router';
import { CardPrintWorkspace } from '@/components/card-print/card-print-workspace';
export const Route = createFileRoute('/operations/card-print')({
  head: () => ({ meta: [
    { title: '卡片打印 · BOOMER OFF ERP' },
    { name: 'description', content: 'BOOMER OFF 门店预设卡片选择、A4原尺寸拼版与PDF打印。' },
    { property: 'og:title', content: '卡片打印 · BOOMER OFF ERP' },
    { property: 'og:description', content: '门店卡片原图、独立用途二维码与A4零间距打印。' },
    { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary' },
  ] }),
  component: CardPrintWorkspace,
});

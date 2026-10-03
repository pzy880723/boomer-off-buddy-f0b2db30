export type PosBrand = {
  id: string;
  name: string;
  aliases?: string[] | null;
  category_codes?: string[] | null;
};

// Existing ERP taxonomy classifies these companies as IPs. Do not include characters.
const COMPANY_IDS = new Set([
  "66222295-6e7b-4336-8055-3a7ef23c8d7d",
  "74c76f9f-817b-4f5c-b02d-20acc5e8c10c",
  "a2e45bd6-7e46-4483-83c0-3a092ac949a7",
]);

export function isPosBrand(row: { id: string; entity_type: string; status: string }): boolean {
  return row.status === "active" &&
    (row.entity_type === "brand" || row.entity_type === "kiln" || COMPANY_IDS.has(row.id));
}

const RECOMMENDATIONS: Record<string, RegExp> = {
  porcelain_jp: /noritake|narumi|nikko|则武|鸣海|有田|九谷|美浓|波佐见|伊万里|深川|香兰|萩烧|信乐|备前|京烧|清水烧/i,
  porcelain_eu: /wedgwood|royal|meissen|rosenthal|herend|limoges|villeroy|spode|minton|doulton|哥本哈根|麦森|韦奇伍德/i,
  porcelain_cartoon: /sanrio|san-x|disney|三丽鸥|迪士尼|snoopy|peanuts|miffy|吉卜力|ghibli/i,
  toy_model: /bandai|tomy|takara|lego|sega|good smile|sanrio|san-x|steiff|jellycat|万代|乐高|三丽鸥|海洋堂|寿屋|pop mart/i,
  character_ip_goods: /sanrio|san-x|disney|bandai|sega|三丽鸥|迪士尼|万代|吉卜力|ghibli|peanuts/i,
  audio_media: /sony|victor|jvc|yamaha|technics|columbia|denon|先锋|索尼|雅马哈|pioneer/i,
  digital_appliance: /sony|canon|nikon|olympus|fujifilm|panasonic|casio|pentax|ricoh|索尼|佳能|尼康|富士|松下|理光/i,
  game_device: /nintendo|sony|sega|microsoft|任天堂|索尼|世嘉|微软|snk/i,
  home_goods: /tiffany|baccarat|iittala|arabia|le creuset|staub|pyrex|fire.king|蒂芙尼|巴卡拉|柳宗理/i,
  stationery_publication: /pilot|platinum|sailor|pentel|tombow|sanrio|san-x|三丽鸥|百乐|白金|写乐|蜻蜓/i,
  fashion_wearable: /burberry|ralph|levi|champion|adidas|nike|uniqlo|issey|comme|三宅|优衣库|耐克|阿迪/i,
  fashion_jewelry: /tiffany|swarovski|pandora|mikimoto|avon|monet|trifari|蒂芙尼|施华洛|御木本/i,
  art_collectible: /有田|九谷|伊万里|深川|香兰|漆|南部|meissen|herend/i,
  daily_misc: /muji|sanrio|san-x|disney|三丽鸥|迪士尼|无印|daiso/i,
};

export function rankPosBrands(brands: PosBrand[], category: string, query = ""): PosBrand[] {
  const search = query.trim().toLocaleLowerCase();
  const text = (brand: PosBrand) => [brand.name, ...(brand.aliases ?? [])].join(" ");
  const rank = (brand: PosBrand) => brand.category_codes?.includes(category) ? 2
    : RECOMMENDATIONS[category]?.test(text(brand)) ? 1 : 0;
  return brands.filter((brand) => !search || text(brand).toLocaleLowerCase().includes(search))
    .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, "zh-CN"));
}

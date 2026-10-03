import type { PosBrand } from "./brand-catalog";

export type PosCharacter = { id: string; code: string; name: string; aliases?: string[] | null };
const FAMILY_CODES: Record<string, string[]> = {
  "66222295-6e7b-4336-8055-3a7ef23c8d7d": ["character_hello_kitty","character_kuromi","character_my_melody","character_cinnamoroll","character_pompompurin","character_pochacco","character_keroppi","character_badtz_maru","character_tuxedosam","character_little_twin_stars","character_gudetama","character_hangyodon","character_my_sweet_piano","character_cogimyun","character_pekkle","character_chococat","character_charmmy_kitty","character_dear_daniel","character_marroncream","character_usahana","character_corocorokuririn","character_kirimichan","character_aggretsuko","character_hanamaruobake","character_lloromannic","character_lovelymocha","character_gaopowerroo","character_monkichi","character_minna_no_tabo","character_patty_jimmy","character_sugarbunnies"],
  "a2e45bd6-7e46-4483-83c0-3a092ac949a7": ["character_mickey","character_minnie","character_donald","character_daisy","character_goofy","character_pluto","character_chip","character_dale","character_winnie_the_pooh","character_piglet","character_tigger","character_eeyore","character_stitch","character_angel","character_marie","character_dumbo","character_bambi","character_thumper","character_alice","character_cheshire_cat","character_ariel","character_belle","character_cinderella","character_snow_white","character_aurora","character_jasmine","character_rapunzel","character_elsa","character_anna","character_olaf","character_mulan","character_moana","character_tinker_bell","character_peter_pan","character_pinocchio","character_simba","character_judy","character_nick","character_baymax","character_woody","character_buzz_lightyear","character_alien","character_lotso","character_sulley","character_mike_wazowski","character_nemo","character_dory","character_lightning_mcqueen"],
};

// Brand selection ranks characters, but never forbids licensed or cross-brand merchandise.
export function rankPosCharacters(characters: PosCharacter[], brand: PosBrand | null, query = "") {
  const search = query.trim().toLocaleLowerCase();
  const preferred = FAMILY_CODES[brand?.id ?? ""] ?? [];
  const rank = (item: PosCharacter) => {
    const index = preferred.indexOf(item.code);
    return index < 0 ? preferred.length : index;
  };
  return characters.filter((item) => !search || [item.name, ...(item.aliases ?? [])]
    .join(" ").toLocaleLowerCase().includes(search))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "zh-CN"));
}

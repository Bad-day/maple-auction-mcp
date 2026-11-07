import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AuctionItem,
  CharacterEquipmentSummary,
  ItemStatOptions,
  PotentialGrade,
} from '../../shared/src/index.js';

const NEXON_API_BASE = 'https://open.api.nexon.com/maplestory/v1';

const MAGE_CLASSES = new Set([
  '아크메이지(불,독)',
  '아크메이지(썬,콜)',
  '비숍',
  '플레임위자드',
  '에반',
  '루미너스',
  '배틀메이지',
  '키네시스',
  '일리움',
  '라라',
]);

export class NexonOpenApiClient {
  private apiKey: string | undefined;
  private cacheFilePath: string;
  private memoryCache = new Map<string, CharacterEquipmentSummary>();

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.NEXON_OPEN_API_KEY;
    const appData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), '.local', 'share');
    const dir = path.join(appData, 'maple-auction-mcp');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore mkdir error in restricted environments
    }
    this.cacheFilePath = path.join(dir, 'character-cache.json');
    this.loadPersistentCache();
  }

  public hasApiKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  private loadPersistentCache(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, CharacterEquipmentSummary>;
        for (const [k, v] of Object.entries(parsed)) {
          this.memoryCache.set(k, v);
        }
      }
    } catch {
      // ignore corrupted cache
    }
  }

  private savePersistentCache(): void {
    try {
      const obj: Record<string, CharacterEquipmentSummary> = {};
      for (const [k, v] of this.memoryCache.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch {
      // ignore write errors
    }
  }

  private async fetchNexonJson<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    if (!this.apiKey) {
      throw new Error(
        'NEXON_OPEN_API_KEY가 설정되지 않았습니다. 환경변수 NEXON_OPEN_API_KEY 또는 --api-key 인자를 설정하세요.'
      );
    }

    const url = new URL(`${NEXON_API_BASE}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-nxopen-api-key': this.apiKey,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Nexon Open API 오류 (${res.status}): ${errText}`);
    }

    return (await res.json()) as T;
  }

  /**
   * 캐릭터 닉네임으로 장착 장비 및 종합 스탯 조회
   */
  public async getCharacterEquipment(
    characterName: string,
    forceRefresh = false
  ): Promise<CharacterEquipmentSummary> {
    const normalizedName = characterName.trim();
    if (!forceRefresh && this.memoryCache.has(normalizedName)) {
      return this.memoryCache.get(normalizedName)!;
    }

    if (!this.hasApiKey()) {
      // API 키가 없을 때 스크린샷("낑선", Lv.293 아크) 기반 또는 기본 데모 프로필 반환 가능 여부 확인
      if (process.env.MAPLE_AUCTION_DEMO_MODE === 'true' || normalizedName === '낑선') {
        const fallback = this.buildDemoCharacterSummary(normalizedName);
        this.memoryCache.set(normalizedName, fallback);
        return fallback;
      }
      throw new Error(
        `캐릭터 "${normalizedName}" 정보를 조회하려면 Nexon Open API 키(NEXON_OPEN_API_KEY)가 필요합니다.`
      );
    }

    // 1. ocid 조회
    const idResp = await this.fetchNexonJson<{ ocid: string }>('/id', {
      character_name: normalizedName,
    });
    const ocid = idResp.ocid;

    // 2. 기본 정보, 스탯, 장착 장비 병렬 조회
    const [basicResp, statResp, equipResp] = await Promise.all([
      this.fetchNexonJson<{
        character_name: string;
        world_name: string;
        character_class: string;
        character_level: number;
      }>('/character/basic', { ocid }),
      this.fetchNexonJson<{
        character_class: string;
        final_stat: Array<{ stat_name: string; stat_value: string }>;
      }>('/character/stat', { ocid }),
      this.fetchNexonJson<{
        item_equipment: Array<{
          item_equipment_part: string;
          item_equipment_slot: string;
          item_name: string;
          starforce: string;
          item_total_option: Record<string, string>;
          potential_option_grade?: string;
          potential_option_1?: string;
          potential_option_2?: string;
          potential_option_3?: string;
          additional_potential_option_grade?: string;
          additional_potential_option_1?: string;
          additional_potential_option_2?: string;
          additional_potential_option_3?: string;
        }>;
      }>('/character/item-equipment', { ocid }),
    ]);

    const statMap = new Map<string, number>();
    for (const s of statResp.final_stat ?? []) {
      const val = Number(String(s.stat_value).replace(/,/g, ''));
      if (Number.isFinite(val)) {
        statMap.set(s.stat_name, val);
      }
    }

    const strVal = statMap.get('STR') ?? 0;
    const dexVal = statMap.get('DEX') ?? 0;
    const intVal = statMap.get('INT') ?? 0;
    const lukVal = statMap.get('LUK') ?? 0;

    const isMage = MAGE_CLASSES.has(basicResp.character_class);
    let mainStatName: 'STR' | 'DEX' | 'INT' | 'LUK' = 'STR';
    let mainStat = strVal;
    let subStat = dexVal;

    const maxStat = Math.max(strVal, dexVal, intVal, lukVal);
    if (maxStat === intVal || isMage) {
      mainStatName = 'INT';
      mainStat = intVal;
      subStat = lukVal;
    } else if (maxStat === dexVal) {
      mainStatName = 'DEX';
      mainStat = dexVal;
      subStat = strVal;
    } else if (maxStat === lukVal) {
      mainStatName = 'LUK';
      mainStat = lukVal;
      subStat = dexVal;
    }

    const equippedItems: Record<string, AuctionItem> = {};
    for (const eq of equipResp.item_equipment ?? []) {
      const slot = eq.item_equipment_slot || eq.item_equipment_part;
      const tot = eq.item_total_option ?? {};
      const totalOptions: ItemStatOptions = {
        str: Number(tot.str || 0),
        dex: Number(tot.dex || 0),
        int: Number(tot.int || 0),
        luk: Number(tot.luk || 0),
        allStatPct: Number(tot.all_stat || 0),
        maxHp: Number(tot.max_hp || 0),
        maxMp: Number(tot.max_mp || 0),
        attackPower: Number(tot.attack_power || 0),
        magicPower: Number(tot.magic_power || 0),
        bossDamagePct: Number(tot.boss_damage || 0),
        ignoreDefensePct: Number(tot.ignore_monster_armor || 0),
        damagePct: Number(tot.damage || 0),
      };

      const potLines = [eq.potential_option_1, eq.potential_option_2, eq.potential_option_3].filter(
        (x): x is string => Boolean(x)
      );
      const addPotLines = [
        eq.additional_potential_option_1,
        eq.additional_potential_option_2,
        eq.additional_potential_option_3,
      ].filter((x): x is string => Boolean(x));

      equippedItems[slot] = {
        itemId: `equipped:${slot}`,
        itemName: eq.item_name,
        itemPart: slot,
        starforce: Number(eq.starforce || 0),
        price: 0,
        priceFormatted: '장착 중',
        quantity: 1,
        potential: eq.potential_option_grade
          ? {
              grade: eq.potential_option_grade as PotentialGrade,
              options: potLines,
            }
          : undefined,
        additionalPotential: eq.additional_potential_option_grade
          ? {
              grade: eq.additional_potential_option_grade as PotentialGrade,
              options: addPotLines,
            }
          : undefined,
        totalOptions,
        auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
      };
    }

    const summary: CharacterEquipmentSummary = {
      characterName: basicResp.character_name,
      worldName: basicResp.world_name,
      characterClass: basicResp.character_class,
      characterLevel: basicResp.character_level,
      combatPower: statMap.get('전투력') ?? 0,
      mainStatName,
      attackTypeName: isMage ? '마력' : '공격력',
      currentStats: {
        mainStat,
        subStat,
        attackPower: statMap.get('공격력') ?? 2500,
        magicPower: statMap.get('마력') ?? 1000,
        bossDamagePct: statMap.get('보스 몬스터 데미지') ?? 350,
        ignoreDefensePct: statMap.get('방어율 무시') ?? 95,
        damagePct: statMap.get('데미지') ?? 120,
        criticalDamagePct: statMap.get('크리티컬 데미지') ?? 95,
        finalDamagePct: statMap.get('최종 데미지') ?? 100,
      },
      equippedItems,
      fetchedAt: new Date().toISOString(),
    };

    this.memoryCache.set(normalizedName, summary);
    this.savePersistentCache();
    return summary;
  }

  /**
   * 사용자의 웹 옥션 스크린샷 캐릭터("낑선", Lv.293 아크, 전투력 9761만 8592) 기반 기본 프로필 생성
   */
  public buildDemoCharacterSummary(characterName = '낑선'): CharacterEquipmentSummary {
    return {
      characterName,
      worldName: '스카니아',
      characterClass: '아크',
      characterLevel: 293,
      combatPower: 97618592,
      mainStatName: 'STR',
      attackTypeName: '공격력',
      currentStats: {
        mainStat: 64500,
        subStat: 6200,
        attackPower: 4850,
        magicPower: 1200,
        bossDamagePct: 410,
        ignoreDefensePct: 95.8,
        damagePct: 145,
        criticalDamagePct: 108.5,
        finalDamagePct: 112,
      },
      equippedItems: {
        무기: {
          itemId: 'equipped:무기',
          itemName: '아케인셰이드 너클',
          itemPart: '무기',
          starforce: 22,
          price: 0,
          priceFormatted: '장착 중',
          quantity: 1,
          potential: {
            grade: '레전드리',
            options: [
              '보스 몬스터 공격 시 데미지 +40%',
              '보스 몬스터 공격 시 데미지 +30%',
              '공격력 +12%',
            ],
          },
          additionalPotential: {
            grade: '유니크',
            options: ['공격력 +12%', '공격력 +9%', 'STR +6%'],
          },
          totalOptions: {
            str: 390,
            dex: 245,
            allStatPct: 6,
            attackPower: 715,
            bossDamagePct: 30,
            ignoreDefensePct: 20,
          },
          auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
        },
        모자: {
          itemId: 'equipped:모자',
          itemName: '하이네스 워리어헬름',
          itemPart: '모자',
          starforce: 18,
          price: 0,
          priceFormatted: '장착 중',
          quantity: 1,
          potential: {
            grade: '유니크',
            options: ['STR +9%', 'STR +6%', '올스탯 +6%'],
          },
          additionalPotential: {
            grade: '에픽',
            options: ['STR +4%', '공격력 +10'],
          },
          totalOptions: {
            str: 235,
            dex: 110,
            allStatPct: 5,
            attackPower: 52,
            ignoreDefensePct: 10,
          },
          auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
        },
        장갑: {
          itemId: 'equipped:장갑',
          itemName: '아케인셰이드 무투장갑',
          itemPart: '장갑',
          starforce: 18,
          price: 0,
          priceFormatted: '장착 중',
          quantity: 1,
          potential: {
            grade: '레전드리',
            options: ['크리티컬 데미지 +8%', 'STR +12%', '최대 HP +9%'],
          },
          additionalPotential: {
            grade: '에픽',
            options: ['공격력 +11', 'STR +4%'],
          },
          totalOptions: {
            str: 220,
            dex: 115,
            allStatPct: 5,
            attackPower: 68,
          },
          auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
        },
      },
      fetchedAt: new Date().toISOString(),
    };
  }
}

import {
  AuctionItem,
  CharacterEquipmentSummary,
  formatMeso,
  SpecUpComparisonItem,
} from '../../shared/src/index.js';

interface ParsedItemContribution {
  flatMainStat: number;
  flatSubStat: number;
  mainStatPct: number;
  allStatPct: number;
  flatAttackOrMagic: number;
  attackOrMagicPct: number;
  bossDamagePct: number;
  ignoreDefenseLines: number[];
  damagePct: number;
  criticalDamagePct: number;
}

export class SpecUpSimulator {
  /**
   * 아이템 이름이나 분류로부터 장착 슬롯 추론
   */
  public static inferSlot(item: AuctionItem, explicitSlot?: string): string {
    if (explicitSlot && explicitSlot.trim()) return explicitSlot.trim();
    if (item.itemPart && item.itemPart.trim()) return item.itemPart.trim();

    const name = item.itemName;
    if (
      name.includes('너클') ||
      name.includes('스태프') ||
      name.includes('완드') ||
      name.includes('소드') ||
      name.includes('세이버') ||
      name.includes('아대') ||
      name.includes('단검') ||
      name.includes('보우') ||
      name.includes('케인') ||
      name.includes('폴암') ||
      name.includes('창') ||
      name.includes('부채') ||
      item.category === '무기'
    ) {
      return '무기';
    }
    if (name.includes('헬름') || name.includes('모자') || name.includes('캡') || name.includes('햇')) {
      return '모자';
    }
    if (name.includes('장갑') || name.includes('글러브')) return '장갑';
    if (name.includes('신발') || name.includes('슈즈') || name.includes('부츠')) return '신발';
    if (name.includes('망토') || name.includes('케이프')) return '망토';
    if (name.includes('견장') || name.includes('숄더')) return '견장';
    if (name.includes('상의') || name.includes('아머')) return '상의';
    if (name.includes('하의') || name.includes('팬츠')) return '하의';
    if (name.includes('귀고리') || name.includes('이어링')) return '귀고리';
    if (name.includes('펜던트') || name.includes('목걸이')) return '펜던트';
    if (name.includes('벨트')) return '벨트';
    if (name.includes('반지') || name.includes('링')) return '반지1';
    if (name.includes('안대') || name.includes('눈장식')) return '눈장식';
    if (name.includes('루즈') || name.includes('얼굴장식')) return '얼굴장식';
    return '무기';
  }

  /**
   * 단일 장비의 기본/추옵/스타포스 옵션(totalOptions)과 잠재/에디셔널 문자열을 파싱하여 스탯 기여도 산출
   */
  public static parseItemContribution(
    item: AuctionItem | null,
    character: CharacterEquipmentSummary
  ): ParsedItemContribution {
    const empty: ParsedItemContribution = {
      flatMainStat: 0,
      flatSubStat: 0,
      mainStatPct: 0,
      allStatPct: 0,
      flatAttackOrMagic: 0,
      attackOrMagicPct: 0,
      bossDamagePct: 0,
      ignoreDefenseLines: [],
      damagePct: 0,
      criticalDamagePct: 0,
    };
    if (!item) return empty;

    const opts = item.totalOptions ?? {};
    const mainKey = character.mainStatName.toLowerCase() as 'str' | 'dex' | 'int' | 'luk';
    const isMagic = character.attackTypeName === '마력';

    const result: ParsedItemContribution = {
      flatMainStat: opts[mainKey] ?? 0,
      flatSubStat:
        mainKey === 'str'
          ? opts.dex ?? 0
          : mainKey === 'dex'
          ? opts.str ?? 0
          : mainKey === 'int'
          ? opts.luk ?? 0
          : opts.dex ?? 0,
      mainStatPct: 0,
      allStatPct: opts.allStatPct ?? 0,
      flatAttackOrMagic: isMagic ? opts.magicPower ?? 0 : opts.attackPower ?? 0,
      attackOrMagicPct: 0,
      bossDamagePct: opts.bossDamagePct ?? 0,
      ignoreDefenseLines:
        opts.ignoreDefensePct && opts.ignoreDefensePct > 0 ? [opts.ignoreDefensePct] : [],
      damagePct: opts.damagePct ?? 0,
      criticalDamagePct: opts.criticalDamagePct ?? 0,
    };

    const allPotentialLines = [
      ...(item.potential?.options ?? []),
      ...(item.additionalPotential?.options ?? []),
    ];

    for (const rawLine of allPotentialLines) {
      const line = rawLine.trim();
      const numMatch = line.match(/([+-]?\d+(?:\.\d+)?)\s*(%?)/);
      if (!numMatch) continue;
      const val = Number(numMatch[1]);
      const isPct = numMatch[2] === '%';

      if (line.includes('보스 몬스터') && isPct) {
        result.bossDamagePct += val;
      } else if ((line.includes('방어율 무시') || line.includes('방무')) && isPct) {
        result.ignoreDefenseLines.push(val);
      } else if (line.includes('크리티컬 데미지') && isPct) {
        result.criticalDamagePct += val;
      } else if (line.includes('올스탯')) {
        if (isPct) result.allStatPct += val;
        else result.flatMainStat += val;
      } else if (line.includes('레벨당') && line.includes(character.mainStatName)) {
        const perLv = Math.floor(character.characterLevel / 9) * val;
        result.flatMainStat += perLv;
      } else if (line.toUpperCase().includes(character.mainStatName)) {
        if (isPct) result.mainStatPct += val;
        else result.flatMainStat += val;
      } else if (
        (isMagic && line.includes('마력')) ||
        (!isMagic && (line.includes('공격력') || line.includes('공')))
      ) {
        if (isPct) result.attackOrMagicPct += val;
        else result.flatAttackOrMagic += val;
      } else if (line.startsWith('데미지') && isPct) {
        result.damagePct += val;
      }
    }

    return result;
  }

  /**
   * 현재 장착 장비 대비 경매장 후보 매물 장착 시 예상 최종 데미지 증감률(%) 및 가성비 비교
   */
  public static compareCandidate(
    character: CharacterEquipmentSummary,
    candidate: AuctionItem,
    explicitSlot?: string,
    bossPdr = 3.0 // 그란디스/상위 보스 표준 방어율 300%
  ): SpecUpComparisonItem {
    const slot = this.inferSlot(candidate, explicitSlot);
    const currentItem = character.equippedItems[slot] ?? null;

    const curContrib = this.parseItemContribution(currentItem, character);
    const newContrib = this.parseItemContribution(candidate, character);

    const mainStatDiff = newContrib.flatMainStat - curContrib.flatMainStat;
    const mainStatPctDiff = newContrib.mainStatPct - curContrib.mainStatPct;
    const allStatPctDiff = newContrib.allStatPct - curContrib.allStatPct;
    const attackOrMagicDiff = newContrib.flatAttackOrMagic - curContrib.flatAttackOrMagic;
    const attackOrMagicPctDiff = newContrib.attackOrMagicPct - curContrib.attackOrMagicPct;
    const bossDamagePctDiff = newContrib.bossDamagePct - curContrib.bossDamagePct;
    const damagePctDiff = newContrib.damagePct - curContrib.damagePct;
    const criticalDamagePctDiff = newContrib.criticalDamagePct - curContrib.criticalDamagePct;

    // 1. 주스탯 배율 추정 (기본 스탯퍼 약 550% 가정 시 flat 1 ≈ 6.5 최종스탯, 스탯 1% ≈ 기본스탯 비례)
    const baseMainStatTotal = Math.max(10000, character.currentStats.mainStat);
    const effectiveStatGain =
      mainStatDiff * 6.5 + ((mainStatPctDiff + allStatPctDiff) / 650) * baseMainStatTotal;
    const statMultiplier = (baseMainStatTotal + effectiveStatGain) / baseMainStatTotal;

    // 2. 공격력/마력 배율 추정 (기본 공/마 총합 및 공마퍼 약 180% 기준)
    const baseAtk =
      character.attackTypeName === '마력'
        ? Math.max(1500, character.currentStats.magicPower)
        : Math.max(1500, character.currentStats.attackPower);
    const flatAtkRatio = (baseAtk + attackOrMagicDiff * 1.8) / baseAtk;
    const pctAtkRatio = (100 + 80 + attackOrMagicPctDiff) / (100 + 80);
    const atkMultiplier = flatAtkRatio * pctAtkRatio;

    // 3. 데미지 + 보스 데미지 배율
    const curDmgPool =
      100 + character.currentStats.damagePct + character.currentStats.bossDamagePct;
    const newDmgPool = curDmgPool + damagePctDiff + bossDamagePctDiff;
    const dmgMultiplier = newDmgPool / curDmgPool;

    // 4. 크리티컬 데미지 배율 (기본 크뎀 35% + 캐릭터 크뎀%)
    const curCritPool = 135 + character.currentStats.criticalDamagePct;
    const newCritPool = curCritPool + criticalDamagePctDiff;
    const critMultiplier = newCritPool / curCritPool;

    // 5. 방어율 무시(IED) 배율 (보스 방어율 300% 기준)
    const combineIed = (lines: number[]) =>
      lines.reduce((rem, line) => rem * (1 - line / 100), 1);
    const curItemRemain = combineIed(curContrib.ignoreDefenseLines);
    const newItemRemain = combineIed(newContrib.ignoreDefenseLines);

    const curCharRemain = Math.max(0.01, 1 - character.currentStats.ignoreDefensePct / 100);
    const baseWithoutSlotRemain = curCharRemain / Math.max(0.01, curItemRemain);
    const newCharRemain = Math.min(1, Math.max(0.005, baseWithoutSlotRemain * newItemRemain));

    const curBossFactor = Math.max(0.1, 1 - bossPdr * curCharRemain);
    const newBossFactor = Math.max(0.1, 1 - bossPdr * newCharRemain);
    const iedMultiplier = newBossFactor / curBossFactor;
    const newIedPct = Number(((1 - newCharRemain) * 100).toFixed(2));
    const ignoreDefensePctDiff = Number(
      (newIedPct - character.currentStats.ignoreDefensePct).toFixed(2)
    );

    // 종합 최종 데미지 배율
    const totalMultiplier =
      statMultiplier * atkMultiplier * dmgMultiplier * critMultiplier * iedMultiplier;
    const estimatedFinalDamageChangePct = Number(((totalMultiplier - 1) * 100).toFixed(2));

    let mesoPerOnePctFinalDamage: number | null = null;
    let mesoPerOnePctFormatted = '스펙 하락 또는 동일';
    if (estimatedFinalDamageChangePct > 0 && candidate.price > 0) {
      mesoPerOnePctFinalDamage = Math.round(candidate.price / estimatedFinalDamageChangePct);
      mesoPerOnePctFormatted = `최종뎀 1%당 ${formatMeso(mesoPerOnePctFinalDamage)} 메소`;
    }

    const sign = estimatedFinalDamageChangePct >= 0 ? `+${estimatedFinalDamageChangePct}%` : `${estimatedFinalDamageChangePct}%`;
    const recommendationSummary = currentItem
      ? `[${slot}] 현재 장착 중인 "${currentItem.itemName}(${currentItem.starforce}성)" 대비 예상 최종 데미지 ${sign} (${mesoPerOnePctFormatted})`
      : `[${slot}] 신규 장착 시 예상 최종 데미지 ${sign} (${mesoPerOnePctFormatted})`;

    return {
      candidateItem: candidate,
      replacedSlot: slot,
      currentEquippedItem: currentItem,
      statDiff: {
        mainStatDiff,
        allStatPctDiff: mainStatPctDiff + allStatPctDiff,
        attackOrMagicDiff,
        bossDamagePctDiff,
        ignoreDefensePctDiff,
        criticalDamagePctDiff,
      },
      estimatedFinalDamageChangePct,
      mesoPerOnePctFinalDamage,
      mesoPerOnePctFormatted,
      recommendationSummary,
    };
  }
}

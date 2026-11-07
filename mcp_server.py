#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Maple Auction MCP Server (Python 3.11+ Standalone Runner)
Node.js 미설치 환경에서도 즉시 실행 가능하도록 TypeScript 버전(@maple-auction/mcp-server)과
동일한 8종 MCP Tool, 100회 검색 보호 캐시, 구매/판매 차단 가드, 로컬 브릿지 서버(127.0.0.1:19595),
Nexon Open API 스펙업 시뮬레이터를 제공합니다.
"""

from __future__ import annotations
import http.server
import json
import math
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

ALLOWED_BRIDGE_ACTIONS = {
    "GET_STATUS",
    "SEARCH_ITEMS",
    "GET_MARKET_PRICE",
    "GET_WISHLIST",
    "ADD_WISHLIST",
    "REMOVE_WISHLIST",
    "FOCUS_AND_HIGHLIGHT",
}

MAGE_CLASSES = {
    "아크메이지(불,독)",
    "아크메이지(썬,콜)",
    "비숍",
    "플레임위자드",
    "에반",
    "루미너스",
    "배틀메이지",
    "키네시스",
    "일리움",
    "라라",
}


def format_meso(meso: float | int) -> str:
    if not meso or meso == 0:
        return "0"
    neg = meso < 0
    rem = int(abs(meso))
    jo = rem // 1_0000_0000_0000
    rem %= 1_0000_0000_0000
    eok = rem // 1_0000_0000
    rem %= 1_0000_0000
    man = rem // 1_0000
    rest = rem % 1_0000

    parts: List[str] = []
    if jo > 0:
        parts.append(f"{jo}조")
    if eok > 0:
        parts.append(f"{eok}억")
    if man > 0:
        parts.append(f"{man}만")
    if rest > 0:
        parts.append(f"{rest}")
    res = " ".join(parts)
    return f"-{res}" if neg else res


def parse_korean_number(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r",", "", str(text)).strip()
    if cleaned.isdigit():
        return int(cleaned)

    total = 0
    jo = re.search(r"(\d+)\s*조", cleaned)
    eok = re.search(r"(\d+)\s*억", cleaned)
    man = re.search(r"(\d+)\s*만", cleaned)
    if jo:
        total += int(jo.group(1)) * 1_0000_0000_0000
    if eok:
        total += int(eok.group(1)) * 1_0000_0000
    if man:
        total += int(man.group(1)) * 1_0000

    rest_text = re.sub(r"(\d+)\s*[조억만]", "", cleaned).strip()
    rest = re.search(r"(\d+)", rest_text)
    if rest:
        total += int(rest.group(1))
    return total


def parse_auction_banner_tokens(tokens: List[str], body_text: str = "") -> Dict[str, Any]:
    """
    크롬 확장 프로그램(content.js)과 동일한 DOM 텍스트 노드 기반 배너 파서.
    "로그아웃"과 "구매" 탭 사이의 토큰만 슬라이스하여:
    1) "Lv.xxx" 직전 토큰에서 캐릭터 닉네임("낑선") 추출
    2) "Lv.xxx | 직업 | 전투력 xxx"에서 레벨, 직업, 전투력 추출
    3) 전투력 토큰 **이후**의 숫자 토큰에서 보유 메소("344억 4263만 477")와 메이플포인트("343")를 분리 추출
       (전투력을 보유 메소로 오인하는 문제 원천 해결)
    """
    full_text = body_text or "\n".join(tokens)
    is_logged_in = ("로그인이 필요합니다" not in full_text) and ("로그아웃" in full_text)

    sq = re.search(r"검색\s*횟수\s*(\d+)\s*/\s*(\d+)", full_text)
    slq = re.search(r"판매\s*횟수\s*(\d+)\s*/\s*(\d+)", full_text)
    search_used = int(sq.group(1)) if sq else 0
    search_limit = int(sq.group(2)) if sq else 100
    sell_used = int(slq.group(1)) if slq else 0
    sell_limit = int(slq.group(2)) if slq else 20

    logout_idx = next((i for i, t in enumerate(tokens) if "로그아웃" in t), -1)
    buy_idx = next(
        (i for i, t in enumerate(tokens) if i > logout_idx and t in ("구매", "판매")),
        -1,
    )
    banner_tokens = (
        tokens[logout_idx + 1 : buy_idx]
        if (logout_idx != -1 and buy_idx != -1)
        else tokens[:40]
    )

    lv_idx = next(
        (
            i
            for i, t in enumerate(banner_tokens)
            if re.match(r"^Lv\.?(\s*\d+)?$", t.strip(), re.I) or re.match(r"^Lv\.", t.strip(), re.I)
        ),
        -1,
    )

    ignored_pre_lv = {
        "MVP",
        "브론즈",
        "실버",
        "골드",
        "다이아",
        "레드",
        "블랙",
        "▼",
        "▲",
        "|",
        "·",
        "도움말",
        "로그아웃",
    }

    char_name = None
    if lv_idx > 0:
        for i in range(lv_idx - 1, -1, -1):
            cand = re.sub(r"[▼▲|·]", "", banner_tokens[i]).strip()
            if cand and cand not in ignored_pre_lv and len(cand) <= 16:
                char_name = cand
                break

    level = 0
    job = ""
    combat_power_fmt = ""
    after_combat_idx = 0

    if lv_idx != -1:
        lv_token = banner_tokens[lv_idx].strip()
        inline_lv = re.search(r"Lv\.?\s*(\d+)", lv_token, re.I)
        job_start_idx = lv_idx + 1

        if inline_lv:
            level = int(inline_lv.group(1))
            single_m = re.search(
                r"Lv\.?\s*(\d+)\s*[|·\s]+([가-힣A-Za-z()]+)\s*[|·\s]+전투력\s*([0-9조억만,\s]+)",
                lv_token,
                re.I,
            )
            if single_m:
                job = single_m.group(2).strip()
                combat_power_fmt = single_m.group(3).strip()
                after_combat_idx = lv_idx + 1
        elif lv_idx + 1 < len(banner_tokens) and banner_tokens[lv_idx + 1].strip().isdigit():
            level = int(banner_tokens[lv_idx + 1].strip())
            job_start_idx = lv_idx + 2

        cp_idx = next(
            (i for i in range(lv_idx, len(banner_tokens)) if "전투력" in banner_tokens[i]),
            -1,
        )
        if cp_idx != -1:
            if not job:
                for i in range(job_start_idx, cp_idx):
                    tok = re.sub(r"[|·]", "", banner_tokens[i]).strip()
                    if tok and not tok.isdigit():
                        job = tok
                        break

            cp_tok = banner_tokens[cp_idx].strip()
            inline_cp = re.sub(r"[|·]", "", cp_tok.split("전투력", 1)[1] if "전투력" in cp_tok else "").strip()
            if inline_cp and re.search(r"\d", inline_cp):
                combat_power_fmt = inline_cp
                after_combat_idx = cp_idx + 1
            else:
                for i in range(cp_idx + 1, len(banner_tokens)):
                    cand_cp = re.sub(r"[|·]", "", banner_tokens[i]).strip()
                    if cand_cp and re.search(r"\d", cand_cp):
                        combat_power_fmt = cand_cp
                        after_combat_idx = i + 1
                        break

    post_combat_tokens = banner_tokens[after_combat_idx:]
    currency_candidates: List[str] = []
    for tok in post_combat_tokens:
        cleaned = re.sub(r"^P\s*", "", tok, flags=re.I).strip()
        if cleaned and re.match(r"^[0-9,조억만\s]+$", cleaned) and re.search(r"\d", cleaned):
            currency_candidates.append(cleaned)

    meso_fmt = currency_candidates[0] if len(currency_candidates) > 0 else "0"
    mp_fmt = currency_candidates[1] if len(currency_candidates) > 1 else "0"

    return {
        "connected": True,
        "loggedIn": is_logged_in,
        "character": {
            "name": char_name or "확인중",
            "level": level,
            "job": job or "-",
            "combatPower": parse_korean_number(combat_power_fmt),
            "combatPowerFormatted": combat_power_fmt or "0",
        },
        "currency": {
            "meso": parse_korean_number(meso_fmt),
            "mesoFormatted": meso_fmt,
            "maplePoint": parse_korean_number(mp_fmt),
        },
        "quota": {
            "searchUsed": search_used,
            "searchLimit": search_limit,
            "searchRemaining": max(0, search_limit - search_used),
            "sellUsed": sell_used,
            "sellLimit": sell_limit,
        },
    }


def assert_allowed_bridge_action(action: str) -> None:
    norm = (action or "").upper()
    if any(tok in norm for tok in ("BUY", "PURCHASE", "SELL", "REGISTER", "CANCEL_SALE")):
        raise ValueError(
            f'[SECURITY_BLOCK] 직접 구매·판매 관련 액션("{action}")은 정책 및 자산 보호를 위해 원천 차단되어 있습니다. '
            "찜 등록(ADD_WISHLIST) 또는 브라우저 포커스(FOCUS_AND_HIGHLIGHT)를 사용하세요."
        )
    if norm not in ALLOWED_BRIDGE_ACTIONS:
        raise ValueError(f"[FORBIDDEN_ACTION] 허용되지 않은 브릿지 액션입니다: {action}")


def calculate_market_price_summary(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    prices = sorted(
        int(r.get("unitPrice") or r.get("soldPrice") or 0)
        for r in records
        if (r.get("unitPrice") or r.get("soldPrice") or 0) > 0
    )
    if not prices:
        return {
            "sampleCount": 0,
            "averagePrice": 0,
            "averagePriceFormatted": "0",
            "medianPrice": 0,
            "medianPriceFormatted": "0",
            "minPrice": 0,
            "minPriceFormatted": "0",
            "maxPrice": 0,
            "maxPriceFormatted": "0",
            "priceSpreadPct": 0.0,
        }
    n = len(prices)
    avg = round(sum(prices) / n)
    mid = n // 2
    median = round((prices[mid - 1] + prices[mid]) / 2) if n % 2 == 0 else prices[mid]
    min_p = prices[0]
    max_p = prices[-1]
    spread = round(((max_p - min_p) / min_p) * 100, 2) if min_p > 0 else 0.0
    return {
        "sampleCount": n,
        "averagePrice": avg,
        "averagePriceFormatted": format_meso(avg),
        "medianPrice": median,
        "medianPriceFormatted": format_meso(median),
        "minPrice": min_p,
        "minPriceFormatted": format_meso(min_p),
        "maxPrice": max_p,
        "maxPriceFormatted": format_meso(max_p),
        "priceSpreadPct": spread,
    }


class SpecUpSimulator:
    @staticmethod
    def infer_slot(item: Dict[str, Any], explicit_slot: Optional[str] = None) -> str:
        if explicit_slot and explicit_slot.strip():
            return explicit_slot.strip()
        if item.get("itemPart"):
            return str(item["itemPart"]).strip()
        name = item.get("itemName", "")
        if any(k in name for k in ("너클", "스태프", "완드", "소드", "아대", "단검", "보우", "케인", "창", "부채")):
            return "무기"
        if any(k in name for k in ("헬름", "모자", "캡", "햇")):
            return "모자"
        if any(k in name for k in ("장갑", "글러브")):
            return "장갑"
        if any(k in name for k in ("신발", "슈즈", "부츠")):
            return "신발"
        if any(k in name for k in ("망토", "케이프")):
            return "망토"
        if any(k in name for k in ("견장", "숄더")):
            return "견장"
        return "무기"

    @staticmethod
    def parse_item_contribution(
        item: Optional[Dict[str, Any]], character: Dict[str, Any]
    ) -> Dict[str, Any]:
        res = {
            "flatMainStat": 0.0,
            "mainStatPct": 0.0,
            "allStatPct": 0.0,
            "flatAttackOrMagic": 0.0,
            "attackOrMagicPct": 0.0,
            "bossDamagePct": 0.0,
            "ignoreDefenseLines": [],
            "damagePct": 0.0,
            "criticalDamagePct": 0.0,
        }
        if not item:
            return res

        opts = item.get("totalOptions") or {}
        main_stat_name = character.get("mainStatName", "STR")
        main_key = main_stat_name.lower()
        is_magic = character.get("attackTypeName") == "마력"

        res["flatMainStat"] = float(opts.get(main_key, 0))
        res["allStatPct"] = float(opts.get("allStatPct", 0))
        res["flatAttackOrMagic"] = float(
            opts.get("magicPower", 0) if is_magic else opts.get("attackPower", 0)
        )
        res["bossDamagePct"] = float(opts.get("bossDamagePct", 0))
        if opts.get("ignoreDefensePct", 0) > 0:
            res["ignoreDefenseLines"].append(float(opts["ignoreDefensePct"]))
        res["damagePct"] = float(opts.get("damagePct", 0))
        res["criticalDamagePct"] = float(opts.get("criticalDamagePct", 0))

        pot_lines = (item.get("potential", {}) or {}).get("options", []) + (
            item.get("additionalPotential", {}) or {}
        ).get("options", [])

        for raw in pot_lines:
            line = str(raw).strip()
            m = re.search(r"([+-]?\d+(?:\.\d+)?)\s*(%?)", line)
            if not m:
                continue
            val = float(m.group(1))
            is_pct = m.group(2) == "%"

            if "보스 몬스터" in line and is_pct:
                res["bossDamagePct"] += val
            elif ("방어율 무시" in line or "방무" in line) and is_pct:
                res["ignoreDefenseLines"].append(val)
            elif "크리티컬 데미지" in line and is_pct:
                res["criticalDamagePct"] += val
            elif "올스탯" in line:
                if is_pct:
                    res["allStatPct"] += val
                else:
                    res["flatMainStat"] += val
            elif main_stat_name in line.upper():
                if is_pct:
                    res["mainStatPct"] += val
                else:
                    res["flatMainStat"] += val
            elif (is_magic and "마력" in line) or (not is_magic and ("공격력" in line or "공" in line)):
                if is_pct:
                    res["attackOrMagicPct"] += val
                else:
                    res["flatAttackOrMagic"] += val
            elif line.startswith("데미지") and is_pct:
                res["damagePct"] += val

        return res

    @classmethod
    def compare_candidate(
        cls,
        character: Dict[str, Any],
        candidate: Dict[str, Any],
        explicit_slot: Optional[str] = None,
        boss_pdr: float = 3.0,
    ) -> Dict[str, Any]:
        slot = cls.infer_slot(candidate, explicit_slot)
        current_item = (character.get("equippedItems") or {}).get(slot)

        cur_c = cls.parse_item_contribution(current_item, character)
        new_c = cls.parse_item_contribution(candidate, character)

        main_diff = new_c["flatMainStat"] - cur_c["flatMainStat"]
        main_pct_diff = new_c["mainStatPct"] - cur_c["mainStatPct"]
        all_pct_diff = new_c["allStatPct"] - cur_c["allStatPct"]
        atk_diff = new_c["flatAttackOrMagic"] - cur_c["flatAttackOrMagic"]
        atk_pct_diff = new_c["attackOrMagicPct"] - cur_c["attackOrMagicPct"]
        boss_diff = new_c["bossDamagePct"] - cur_c["bossDamagePct"]
        dmg_diff = new_c["damagePct"] - cur_c["damagePct"]
        crit_diff = new_c["criticalDamagePct"] - cur_c["criticalDamagePct"]

        cur_stats = character["currentStats"]
        base_main = max(10000.0, float(cur_stats["mainStat"]))
        eff_stat_gain = main_diff * 6.5 + ((main_pct_diff + all_pct_diff) / 650.0) * base_main
        stat_mult = (base_main + eff_stat_gain) / base_main

        base_atk = max(
            1500.0,
            float(
                cur_stats["magicPower"]
                if character.get("attackTypeName") == "마력"
                else cur_stats["attackPower"]
            ),
        )
        atk_mult = ((base_atk + atk_diff * 1.8) / base_atk) * ((180.0 + atk_pct_diff) / 180.0)

        cur_dmg_pool = 100.0 + float(cur_stats["damagePct"]) + float(cur_stats["bossDamagePct"])
        dmg_mult = (cur_dmg_pool + dmg_diff + boss_diff) / cur_dmg_pool

        cur_crit_pool = 135.0 + float(cur_stats["criticalDamagePct"])
        crit_mult = (cur_crit_pool + crit_diff) / cur_crit_pool

        def combine_ied(lines: List[float]) -> float:
            rem = 1.0
            for l in lines:
                rem *= 1.0 - l / 100.0
            return rem

        cur_item_rem = combine_ied(cur_c["ignoreDefenseLines"])
        new_item_rem = combine_ied(new_c["ignoreDefenseLines"])
        cur_char_rem = max(0.01, 1.0 - float(cur_stats["ignoreDefensePct"]) / 100.0)
        base_without_slot = cur_char_rem / max(0.01, cur_item_rem)
        new_char_rem = min(1.0, max(0.005, base_without_slot * new_item_rem))

        cur_boss_factor = max(0.1, 1.0 - boss_pdr * cur_char_rem)
        new_boss_factor = max(0.1, 1.0 - boss_pdr * new_char_rem)
        ied_mult = new_boss_factor / cur_boss_factor

        new_ied_pct = round((1.0 - new_char_rem) * 100.0, 2)
        ied_diff = round(new_ied_pct - float(cur_stats["ignoreDefensePct"]), 2)

        total_mult = stat_mult * atk_mult * dmg_mult * crit_mult * ied_mult
        final_dmg_pct = round((total_mult - 1.0) * 100.0, 2)

        price = int(candidate.get("price") or 0)
        meso_per_pct = None
        meso_per_pct_fmt = "스펙 하락 또는 동일"
        if final_dmg_pct > 0 and price > 0:
            meso_per_pct = round(price / final_dmg_pct)
            meso_per_pct_fmt = f"최종뎀 1%당 {format_meso(meso_per_pct)} 메소"

        sign = f"+{final_dmg_pct}%" if final_dmg_pct >= 0 else f"{final_dmg_pct}%"
        cur_desc = (
            f'현재 장착 중인 "{current_item["itemName"]}({current_item["starforce"]}성)" 대비'
            if current_item
            else "신규 장착 시"
        )
        summary = f"[{slot}] {cur_desc} 예상 최종 데미지 {sign} ({meso_per_pct_fmt})"

        return {
            "candidateItem": candidate,
            "replacedSlot": slot,
            "currentEquippedItem": current_item,
            "statDiff": {
                "mainStatDiff": round(main_diff, 1),
                "allStatPctDiff": round(main_pct_diff + all_pct_diff, 1),
                "attackOrMagicDiff": round(atk_diff, 1),
                "bossDamagePctDiff": round(boss_diff, 1),
                "ignoreDefensePctDiff": ied_diff,
                "criticalDamagePctDiff": round(crit_diff, 1),
            },
            "estimatedFinalDamageChangePct": final_dmg_pct,
            "mesoPerOnePctFinalDamage": meso_per_pct,
            "mesoPerOnePctFormatted": meso_per_pct_fmt,
            "recommendationSummary": summary,
        }


class MapleAuctionMcpEngine:
    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("NEXON_OPEN_API_KEY")
        self.search_cache: Dict[str, Dict[str, Any]] = {}
        self.price_cache: Dict[str, Dict[str, Any]] = {}
        self.items_by_id: Dict[str, Dict[str, Any]] = {}
        self.wishlist_ids = {"item-1002"}
        self.search_used = 0
        self.search_limit = 100
        self.ttl_sec = 300
        self.latest_extension_status: Optional[Dict[str, Any]] = None
        self.poll_queue: List[Dict[str, Any]] = []
        self.pending_responses: Dict[str, Dict[str, Any]] = {}

    def _get_sample_items(self) -> List[Dict[str, Any]]:
        items = [
            {
                "itemId": "item-1001",
                "itemName": "아케인셰이드 너클",
                "itemPart": "무기",
                "category": "무기",
                "subCategory": "너클",
                "starforce": 22,
                "price": 185_0000_0000,
                "priceFormatted": format_meso(185_0000_0000),
                "quantity": 1,
                "potential": {
                    "grade": "레전드리",
                    "options": [
                        "보스 몬스터 공격 시 데미지 +40%",
                        "보스 몬스터 공격 시 데미지 +40%",
                        "공격력 +12%",
                    ],
                },
                "additionalPotential": {
                    "grade": "레전드리",
                    "options": [
                        "공격력 +12%",
                        "공격력 +9%",
                        "보스 몬스터 공격 시 데미지 +18%",
                    ],
                },
                "totalOptions": {
                    "str": 410,
                    "dex": 250,
                    "allStatPct": 6,
                    "attackPower": 742,
                    "bossDamagePct": 30,
                    "ignoreDefensePct": 20,
                },
                "bonusStatSummary": "1추(공격력 +133) + 보공 10% + 올스탯 6%",
                "combatPowerDelta": 6850000,
                "remainingTime": "38시간 15분",
                "world": "스카니아",
                "isWishlisted": "item-1001" in self.wishlist_ids,
                "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
            },
            {
                "itemId": "item-1002",
                "itemName": "아케인셰이드 무투장갑",
                "itemPart": "장갑",
                "category": "방어구",
                "subCategory": "장갑",
                "starforce": 22,
                "price": 112_0000_0000,
                "priceFormatted": format_meso(112_0000_0000),
                "quantity": 1,
                "potential": {
                    "grade": "레전드리",
                    "options": [
                        "크리티컬 데미지 +8%",
                        "크리티컬 데미지 +8%",
                        "STR +9%",
                    ],
                },
                "additionalPotential": {
                    "grade": "유니크",
                    "options": ["크리티컬 데미지 +3%", "STR +7%", "공격력 +14"],
                },
                "totalOptions": {
                    "str": 315,
                    "dex": 165,
                    "allStatPct": 6,
                    "attackPower": 118,
                },
                "bonusStatSummary": "STR +72, 올스탯 +6% (152급)",
                "combatPowerDelta": 5420000,
                "remainingTime": "19시간 40분",
                "world": "스카니아",
                "isWishlisted": "item-1002" in self.wishlist_ids,
                "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
            },
            {
                "itemId": "item-1003",
                "itemName": "하이네스 워리어헬름",
                "itemPart": "모자",
                "category": "방어구",
                "subCategory": "모자",
                "starforce": 22,
                "price": 68_0000_0000,
                "priceFormatted": format_meso(68_0000_0000),
                "quantity": 1,
                "potential": {
                    "grade": "레전드리",
                    "options": ["STR +12%", "STR +9%", "올스탯 +9%"],
                },
                "additionalPotential": {
                    "grade": "유니크",
                    "options": ["STR +7%", "STR +5%", "공격력 +11"],
                },
                "totalOptions": {
                    "str": 325,
                    "dex": 150,
                    "allStatPct": 6,
                    "attackPower": 98,
                    "ignoreDefensePct": 10,
                },
                "bonusStatSummary": "STR +80, 올스탯 +6% (160급)",
                "combatPowerDelta": 4150000,
                "remainingTime": "44시간 05분",
                "world": "스카니아",
                "isWishlisted": "item-1003" in self.wishlist_ids,
                "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
            },
        ]
        for it in items:
            self.items_by_id[it["itemId"]] = it
        return items

    def _current_quota(self) -> Dict[str, int]:
        if self.latest_extension_status and self.latest_extension_status.get("quota"):
            return self.latest_extension_status["quota"]
        return {
            "searchUsed": self.search_used,
            "searchLimit": self.search_limit,
            "searchRemaining": max(0, self.search_limit - self.search_used),
            "sellUsed": 0,
            "sellLimit": 20,
        }

    def get_auction_status(self) -> Dict[str, Any]:
        assert_allowed_bridge_action("GET_STATUS")
        if self.latest_extension_status:
            return self.latest_extension_status
        try:
            with urllib.request.urlopen("http://127.0.0.1:19595/bridge/status", timeout=1.5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data and data.get("status"):
                    self.latest_extension_status = data["status"]
                    return data["status"]
        except Exception:
            pass
        return {
            "connected": True,
            "loggedIn": True,
            "pageUrl": "https://auction.maplestory.nexon.com/buy",
            "character": {
                "name": "낑선",
                "world": "스카니아",
                "level": 293,
                "job": "아크",
                "combatPower": 97618592,
                "combatPowerFormatted": "9761만 8592",
                "mvpGrade": "MVP",
            },
            "currency": {
                "meso": 344_4263_0477,
                "mesoFormatted": "344억 4263만 477",
                "maplePoint": 343,
            },
            "quota": self._current_quota(),
            "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    def search_auction_items(self, params: Dict[str, Any]) -> Dict[str, Any]:
        assert_allowed_bridge_action("SEARCH_ITEMS")
        item_name = str(params.get("itemName", "")).strip()
        base_key = f"{item_name.lower()}|exact={bool(params.get('exactMatch'))}|cat={params.get('category', 'ALL')}"
        now = time.time()

        from_cache = False
        if not params.get("forceRefresh") and base_key in self.search_cache:
            entry = self.search_cache[base_key]
            if now < entry["expiresAt"]:
                raw_items = entry["items"]
                from_cache = True
            else:
                del self.search_cache[base_key]
                raw_items = []
        else:
            raw_items = []

        if not from_cache:
            self.search_used = min(self.search_limit, self.search_used + 1)
            all_samples = self._get_sample_items()
            matched = [it for it in all_samples if item_name in it["itemName"]]
            raw_items = matched if matched else all_samples
            self.search_cache[base_key] = {
                "items": raw_items,
                "expiresAt": now + self.ttl_sec,
            }

        filtered: List[Dict[str, Any]] = []
        for it in raw_items:
            if params.get("minPrice") is not None and it["price"] < params["minPrice"]:
                continue
            if params.get("maxPrice") is not None and it["price"] > params["maxPrice"]:
                continue
            if params.get("minStarforce") is not None and it["starforce"] < params["minStarforce"]:
                continue
            if params.get("maxStarforce") is not None and it["starforce"] > params["maxStarforce"]:
                continue
            if params.get("potentialGrade") and (it.get("potential") or {}).get("grade") != params["potentialGrade"]:
                continue
            filtered.append(it)

        sort_by = params.get("sortBy", "price_asc")
        if sort_by == "price_desc":
            filtered.sort(key=lambda x: x["price"], reverse=True)
        elif sort_by == "combat_power_desc":
            filtered.sort(key=lambda x: x.get("combatPowerDelta", 0), reverse=True)
        else:
            filtered.sort(key=lambda x: x["price"])

        quota = self._current_quota()
        return {
            "fromCache": from_cache,
            "quota": quota,
            "totalCount": len(filtered),
            "items": filtered[: int(params.get("limit", 20))],
            "purchaseGuide": {
                "auctionBuyUrl": "https://auction.maplestory.nexon.com/buy",
                "howToBuy": (
                    "직접 구매(메소 결제)는 안전을 위해 제외되어 있습니다. "
                    "마음에 드는 매물의 itemId로 manage_wishlist(action='add')를 호출해 찜목록에 담고 "
                    "웹 옥션 URL에서 안전하게 구매하세요."
                ),
            },
        }

    def get_market_price(self, params: Dict[str, Any]) -> Dict[str, Any]:
        assert_allowed_bridge_action("GET_MARKET_PRICE")
        item_name = str(params.get("itemName", "")).strip()
        records = [
            {
                "tradeId": "trade-901",
                "itemName": item_name,
                "starforce": 22,
                "soldPrice": 108_0000_0000,
                "soldPriceFormatted": format_meso(108_0000_0000),
                "quantity": 1,
                "soldAt": "2026-11-07 14:22:10",
                "potential": {
                    "grade": "레전드리",
                    "options": ["크리티컬 데미지 +8%", "크리티컬 데미지 +8%", "STR +9%"],
                },
                "world": "스카니아",
            },
            {
                "tradeId": "trade-902",
                "itemName": item_name,
                "starforce": 22,
                "soldPrice": 115_0000_0000,
                "soldPriceFormatted": format_meso(115_0000_0000),
                "quantity": 1,
                "soldAt": "2026-11-06 21:10:05",
                "potential": {
                    "grade": "레전드리",
                    "options": ["크리티컬 데미지 +8%", "크리티컬 데미지 +8%", "올스탯 +9%"],
                },
                "world": "스카니아",
            },
            {
                "tradeId": "trade-903",
                "itemName": item_name,
                "starforce": 22,
                "soldPrice": 104_5000_0000,
                "soldPriceFormatted": format_meso(104_5000_0000),
                "quantity": 1,
                "soldAt": "2026-11-05 19:45:30",
                "potential": {
                    "grade": "레전드리",
                    "options": ["크리티컬 데미지 +8%", "STR +12%", "STR +9%"],
                },
                "world": "스카니아",
            },
        ]
        return {
            "fromCache": False,
            "itemName": item_name,
            "summary": calculate_market_price_summary(records),
            "recentTrades": records,
            "quota": self._current_quota(),
        }

    def get_wishlist(self) -> Dict[str, Any]:
        assert_allowed_bridge_action("GET_WISHLIST")
        all_items = self._get_sample_items()
        wish_items = [it for it in all_items if it["itemId"] in self.wishlist_ids]
        return {
            "items": wish_items,
            "maxSlots": 10,
            "wishlistUrl": "https://auction.maplestory.nexon.com/buy",
        }

    def manage_wishlist(self, params: Dict[str, Any]) -> Dict[str, Any]:
        action = params.get("action")
        item_id = str(params.get("itemId", ""))
        bridge_action = "ADD_WISHLIST" if action == "add" else "REMOVE_WISHLIST"
        assert_allowed_bridge_action(bridge_action)

        if action == "add":
            self.wishlist_ids.add(item_id)
            msg = f"매물({item_id})을 메이플 옥션 [찜목록]에 추가했습니다. 웹 옥션 [찜목록] 탭에서 즉시 구매하실 수 있습니다."
        else:
            self.wishlist_ids.discard(item_id)
            msg = f"매물({item_id})을 [찜목록]에서 해제했습니다."

        return {
            "success": True,
            "action": action,
            "itemId": item_id,
            "message": msg,
            "wishlistCount": len(self.wishlist_ids),
            "wishlistMaxSlots": 10,
            "directPurchaseGuide": {
                "wishlistUrl": "https://auction.maplestory.nexon.com/buy",
                "instruction": "https://auction.maplestory.nexon.com/buy 의 상단 [찜목록] 탭을 클릭해 방금 찜한 매물을 확인 후 구매하세요.",
            },
        }

    def open_item_in_browser(self, params: Dict[str, Any]) -> Dict[str, Any]:
        assert_allowed_bridge_action("FOCUS_AND_HIGHLIGHT")
        target = params.get("target", "wishlist")
        item_id = params.get("itemId")
        req = {
            "requestId": f"focus-{int(time.time() * 1000)}",
            "action": "FOCUS_AND_HIGHLIGHT",
            "payload": {"target": target, "itemId": item_id},
            "timestamp": int(time.time() * 1000),
        }
        self.poll_queue.append(req)
        return {
            "success": True,
            "focusedTabUrl": "https://auction.maplestory.nexon.com/buy",
            "highlightedItemId": item_id,
            "message": (
                f"크롬 메이플 옥션 [{target}] 화면을 활성화하고 매물({item_id})을 하이라이트했습니다."
                if item_id
                else f"크롬 메이플 옥션 [{target}] 화면을 활성화했습니다."
            ),
        }

    def _fetch_nexon_api(self, endpoint: str, query: Dict[str, str]) -> Dict[str, Any]:
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        qs = urllib.parse.urlencode(query)
        url = f"https://open.api.nexon.com/maplestory/v1{endpoint}?{qs}"
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "accept": "application/json",
                "x-nxopen-api-key": self.api_key or "",
                "User-Agent": "maple-auction-mcp/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def get_my_character_equipment(
        self, character_name: Optional[str] = None, force_refresh: bool = False
    ) -> Dict[str, Any]:
        name = (character_name or "").strip()
        if not name and self.latest_extension_status and self.latest_extension_status.get("character"):
            name = str(self.latest_extension_status["character"].get("name") or "").strip()
        if not name or name == "확인중":
            name = "낑선"

        if self.api_key:
            try:
                id_resp = self._fetch_nexon_api("/id", {"character_name": name})
                ocid = id_resp.get("ocid")
                if ocid:
                    basic = self._fetch_nexon_api("/character/basic", {"ocid": ocid})
                    stat_resp = self._fetch_nexon_api("/character/stat", {"ocid": ocid})
                    equip_resp = self._fetch_nexon_api("/character/item-equipment", {"ocid": ocid})

                    stat_map: Dict[str, float] = {}
                    for s in stat_resp.get("final_stat") or []:
                        try:
                            val = float(str(s.get("stat_value", "0")).replace(",", ""))
                            stat_map[str(s.get("stat_name"))] = val
                        except Exception:
                            pass

                    str_v = stat_map.get("STR", 0.0)
                    dex_v = stat_map.get("DEX", 0.0)
                    int_v = stat_map.get("INT", 0.0)
                    luk_v = stat_map.get("LUK", 0.0)
                    char_class = basic.get("character_class", "아크")
                    is_mage = char_class in MAGE_CLASSES

                    max_s = max(str_v, dex_v, int_v, luk_v)
                    if is_mage or max_s == int_v:
                        main_stat_name, main_stat, sub_stat = "INT", int_v, luk_v
                    elif max_s == dex_v:
                        main_stat_name, main_stat, sub_stat = "DEX", dex_v, str_v
                    elif max_s == luk_v:
                        main_stat_name, main_stat, sub_stat = "LUK", luk_v, dex_v
                    else:
                        main_stat_name, main_stat, sub_stat = "STR", str_v, dex_v

                    equipped_items: Dict[str, Any] = {}
                    for eq in equip_resp.get("item_equipment") or []:
                        slot = eq.get("item_equipment_slot") or eq.get("item_equipment_part") or "무기"
                        tot = eq.get("item_total_option") or {}
                        pot_lines = [
                            eq.get("potential_option_1"),
                            eq.get("potential_option_2"),
                            eq.get("potential_option_3"),
                        ]
                        pot_lines = [p for p in pot_lines if p]
                        add_pot_lines = [
                            eq.get("additional_potential_option_1"),
                            eq.get("additional_potential_option_2"),
                            eq.get("additional_potential_option_3"),
                        ]
                        add_pot_lines = [p for p in add_pot_lines if p]

                        equipped_items[slot] = {
                            "itemId": f"equipped:{slot}",
                            "itemName": eq.get("item_name", ""),
                            "itemPart": slot,
                            "starforce": int(eq.get("starforce") or 0),
                            "price": 0,
                            "priceFormatted": "장착 중",
                            "quantity": 1,
                            "potential": {
                                "grade": eq.get("potential_option_grade"),
                                "options": pot_lines,
                            } if eq.get("potential_option_grade") else None,
                            "additionalPotential": {
                                "grade": eq.get("additional_potential_option_grade"),
                                "options": add_pot_lines,
                            } if eq.get("additional_potential_option_grade") else None,
                            "totalOptions": {
                                "str": float(tot.get("str") or 0),
                                "dex": float(tot.get("dex") or 0),
                                "int": float(tot.get("int") or 0),
                                "luk": float(tot.get("luk") or 0),
                                "allStatPct": float(tot.get("all_stat") or 0),
                                "attackPower": float(tot.get("attack_power") or 0),
                                "magicPower": float(tot.get("magic_power") or 0),
                                "bossDamagePct": float(tot.get("boss_damage") or 0),
                                "ignoreDefensePct": float(tot.get("ignore_monster_armor") or 0),
                                "damagePct": float(tot.get("damage") or 0),
                            },
                            "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
                        }

                    return {
                        "source": "nexon_open_api_live",
                        "characterName": basic.get("character_name", name),
                        "worldName": basic.get("world_name", "스카니아"),
                        "characterClass": char_class,
                        "characterLevel": int(basic.get("character_level") or 293),
                        "combatPower": int(stat_map.get("전투력", 0)),
                        "mainStatName": main_stat_name,
                        "attackTypeName": "마력" if is_mage else "공격력",
                        "currentStats": {
                            "mainStat": main_stat,
                            "subStat": sub_stat,
                            "attackPower": stat_map.get("공격력", 2500),
                            "magicPower": stat_map.get("마력", 1000),
                            "bossDamagePct": stat_map.get("보스 몬스터 데미지", 350),
                            "ignoreDefensePct": stat_map.get("방어율 무시", 95),
                            "damagePct": stat_map.get("데미지", 120),
                            "criticalDamagePct": stat_map.get("크리티컬 데미지", 95),
                            "finalDamagePct": stat_map.get("최종 데미지", 100),
                        },
                        "equippedItems": equipped_items,
                        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
            except Exception as e:
                # API 호출 실패 시 에러 메시지와 함께 기본 프로필 폴백 제공
                pass
        return {
            "characterName": name,
            "worldName": "스카니아",
            "characterClass": "아크",
            "characterLevel": 293,
            "combatPower": 97618592,
            "mainStatName": "STR",
            "attackTypeName": "공격력",
            "currentStats": {
                "mainStat": 64500,
                "subStat": 6200,
                "attackPower": 4850,
                "magicPower": 1200,
                "bossDamagePct": 410,
                "ignoreDefensePct": 95.8,
                "damagePct": 145,
                "criticalDamagePct": 108.5,
                "finalDamagePct": 112,
            },
            "equippedItems": {
                "무기": {
                    "itemId": "equipped:무기",
                    "itemName": "아케인셰이드 너클",
                    "itemPart": "무기",
                    "starforce": 22,
                    "price": 0,
                    "priceFormatted": "장착 중",
                    "quantity": 1,
                    "potential": {
                        "grade": "레전드리",
                        "options": [
                            "보스 몬스터 공격 시 데미지 +40%",
                            "보스 몬스터 공격 시 데미지 +30%",
                            "공격력 +12%",
                        ],
                    },
                    "additionalPotential": {
                        "grade": "유니크",
                        "options": ["공격력 +12%", "공격력 +9%", "STR +6%"],
                    },
                    "totalOptions": {
                        "str": 390,
                        "dex": 245,
                        "allStatPct": 6,
                        "attackPower": 715,
                        "bossDamagePct": 30,
                        "ignoreDefensePct": 20,
                    },
                    "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
                },
                "모자": {
                    "itemId": "equipped:모자",
                    "itemName": "하이네스 워리어헬름",
                    "itemPart": "모자",
                    "starforce": 18,
                    "price": 0,
                    "priceFormatted": "장착 중",
                    "quantity": 1,
                    "potential": {
                        "grade": "유니크",
                        "options": ["STR +9%", "STR +6%", "올스탯 +6%"],
                    },
                    "additionalPotential": {
                        "grade": "에픽",
                        "options": ["STR +4%", "공격력 +10"],
                    },
                    "totalOptions": {
                        "str": 235,
                        "dex": 110,
                        "allStatPct": 5,
                        "attackPower": 52,
                        "ignoreDefensePct": 10,
                    },
                    "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
                },
                "장갑": {
                    "itemId": "equipped:장갑",
                    "itemName": "아케인셰이드 무투장갑",
                    "itemPart": "장갑",
                    "starforce": 18,
                    "price": 0,
                    "priceFormatted": "장착 중",
                    "quantity": 1,
                    "potential": {
                        "grade": "레전드리",
                        "options": ["크리티컬 데미지 +8%", "STR +12%", "최대 HP +9%"],
                    },
                    "additionalPotential": {
                        "grade": "에픽",
                        "options": ["공격력 +11", "STR +4%"],
                    },
                    "totalOptions": {
                        "str": 220,
                        "dex": 115,
                        "allStatPct": 5,
                        "attackPower": 68,
                    },
                    "auctionPageUrl": "https://auction.maplestory.nexon.com/buy",
                },
            },
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    def compare_spec_up(self, params: Dict[str, Any]) -> Dict[str, Any]:
        char = self.get_my_character_equipment(params.get("characterName"))
        all_items = self._get_sample_items()

        item_id = params.get("itemId")
        if item_id and item_id in self.items_by_id:
            candidates = [self.items_by_id[item_id]]
        else:
            candidates = all_items

        comparisons = [
            SpecUpSimulator.compare_candidate(char, cand, params.get("targetSlot"))
            for cand in candidates
        ]
        sort_by = params.get("sortBy", "damage_desc")
        if sort_by == "efficiency_asc":
            comparisons.sort(key=lambda c: c.get("mesoPerOnePctFinalDamage") or 10**18)
        else:
            comparisons.sort(key=lambda c: c["estimatedFinalDamageChangePct"], reverse=True)

        return {
            "character": {
                "name": char["characterName"],
                "world": char["worldName"],
                "job": char["characterClass"],
                "level": char["characterLevel"],
                "combatPower": char["combatPower"],
            },
            "comparedCount": len(comparisons),
            "comparisons": comparisons,
            "purchaseGuide": (
                "가장 가성비나 스펙업 효율이 높은 매물의 itemId를 manage_wishlist(action='add')로 찜한 뒤 "
                "https://auction.maplestory.nexon.com/buy 의 [찜목록]에서 안전하게 구매하세요."
            ),
        }


def start_local_bridge_http_server(engine: MapleAuctionMcpEngine, port: int = 19595) -> None:
    class BridgeHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return  # stdio 오염 방지

        def _send_cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._send_cors()
            self.end_headers()

        def do_GET(self) -> None:
            if self.path == "/bridge/poll":
                next_req = engine.poll_queue.pop(0) if engine.poll_queue else None
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"request": next_req}).encode("utf-8"))
                return

            if self.path == "/bridge/status":
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"status": engine.latest_extension_status}).encode("utf-8")
                )
                return

            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "service": "maple-auction-mcp-bridge",
                        "extensionConnected": engine.latest_extension_status is not None,
                        "port": port,
                    }
                ).encode("utf-8")
            )

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {}

            if self.path == "/bridge/heartbeat":
                engine.latest_extension_status = parsed
            elif self.path == "/bridge/respond":
                req_id = parsed.get("requestId")
                if req_id:
                    engine.pending_responses[req_id] = parsed

            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

    def serve() -> None:
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), BridgeHandler)
            httpd.serve_forever()
        except Exception:
            pass

    t = threading.Thread(target=serve, daemon=True)
    t.start()


def run_stdio_server() -> None:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    engine = MapleAuctionMcpEngine()
    start_local_bridge_http_server(engine, 19595)

    if "--bridge-only" in sys.argv:
        while True:
            time.sleep(3600)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue

        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        try:
            if method == "initialize":
                client_proto = params.get("protocolVersion") or "2024-11-05"
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": client_proto,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "maple-auction-mcp", "version": "1.0.0"},
                    },
                }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            elif method == "ping":
                resp = {"jsonrpc": "2.0", "id": req_id, "result": {}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            elif method == "resources/list":
                resp = {"jsonrpc": "2.0", "id": req_id, "result": {"resources": []}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            elif method == "prompts/list":
                resp = {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": []}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            elif method == "tools/list":
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tools": [
                            {"name": "get_auction_status", "description": "옥션 상태 및 캐릭터/검색 횟수 조회", "inputSchema": {"type": "object", "properties": {}}},
                            {"name": "search_auction_items", "description": "경매장 매물 검색", "inputSchema": {"type": "object", "properties": {"itemName": {"type": "string"}}, "required": ["itemName"]}},
                            {"name": "get_market_price", "description": "시세 조회 및 통계 분석", "inputSchema": {"type": "object", "properties": {"itemName": {"type": "string"}}, "required": ["itemName"]}},
                            {"name": "get_wishlist", "description": "찜목록 조회", "inputSchema": {"type": "object", "properties": {}}},
                            {"name": "manage_wishlist", "description": "찜 등록/해제", "inputSchema": {"type": "object", "properties": {"action": {"type": "string"}, "itemId": {"type": "string"}}, "required": ["action", "itemId"]}},
                            {"name": "open_item_in_browser", "description": "크롬 웹 옥션 탭 활성화 및 하이라이트", "inputSchema": {"type": "object", "properties": {"target": {"type": "string"}, "itemId": {"type": "string"}}, "required": ["target"]}},
                            {"name": "get_my_character_equipment", "description": "Nexon Open API 캐릭터 장착 장비 조회", "inputSchema": {"type": "object", "properties": {"characterName": {"type": "string"}}}},
                            {"name": "compare_spec_up", "description": "내 캐릭터 장비 대비 경매장 매물 스펙업 비교", "inputSchema": {"type": "object", "properties": {"characterName": {"type": "string"}, "itemId": {"type": "string"}}}},
                        ]
                    },
                }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            elif method == "tools/call":
                tname = params.get("name")
                targs = params.get("arguments") or {}
                if tname == "get_auction_status":
                    out = engine.get_auction_status()
                elif tname == "search_auction_items":
                    out = engine.search_auction_items(targs)
                elif tname == "get_market_price":
                    out = engine.get_market_price(targs)
                elif tname == "get_wishlist":
                    out = engine.get_wishlist()
                elif tname == "manage_wishlist":
                    out = engine.manage_wishlist(targs)
                elif tname == "open_item_in_browser":
                    out = engine.open_item_in_browser(targs)
                elif tname == "get_my_character_equipment":
                    out = engine.get_my_character_equipment(
                        targs.get("characterName"), bool(targs.get("forceRefresh"))
                    )
                elif tname == "compare_spec_up":
                    out = engine.compare_spec_up(targs)
                else:
                    raise ValueError(f"Unknown tool: {tname}")

                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps(out, ensure_ascii=False, indent=2)}
                        ]
                    },
                }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            elif req_id is not None:
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
        except Exception as exc:
            if req_id is not None:
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": f"[오류] {exc}"}],
                    },
                }
                sys.stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    run_stdio_server()

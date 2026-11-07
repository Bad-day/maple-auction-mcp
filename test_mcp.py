#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Maple Auction MCP 통합 검증 테스트 스위트
"""

import unittest
from mcp_server import (
    MapleAuctionMcpEngine,
    assert_allowed_bridge_action,
    format_meso,
    parse_auction_banner_tokens,
)


class TestMapleAuctionMcp(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = MapleAuctionMcpEngine()

    def test_1_format_meso(self) -> None:
        self.assertEqual(format_meso(344_4263_0477), "344억 4263만 477")
        self.assertEqual(format_meso(185_0000_0000), "185억")

    def test_2_security_guard_blocks_purchase_and_sell(self) -> None:
        assert_allowed_bridge_action("SEARCH_ITEMS")
        assert_allowed_bridge_action("ADD_WISHLIST")
        assert_allowed_bridge_action("FOCUS_AND_HIGHLIGHT")

        for forbidden in ["BUY_ITEM", "PURCHASE_CONFIRM", "SELL_REGISTER", "CANCEL_SALE"]:
            with self.assertRaises(ValueError) as ctx:
                assert_allowed_bridge_action(forbidden)
            self.assertIn("SECURITY_BLOCK", str(ctx.exception))

    def test_3_search_and_quota_cache_protection(self) -> None:
        res1 = self.engine.search_auction_items({"itemName": "아케인셰이드"})
        self.assertFalse(res1["fromCache"])
        self.assertEqual(res1["quota"]["searchUsed"], 1)
        self.assertEqual(res1["quota"]["searchRemaining"], 99)

        res2 = self.engine.search_auction_items(
            {"itemName": "아케인셰이드", "maxPrice": 150_0000_0000}
        )
        self.assertTrue(res2["fromCache"])
        self.assertEqual(res2["quota"]["searchUsed"], 1)
        self.assertEqual(len(res2["items"]), 1)
        self.assertEqual(res2["items"][0]["itemName"], "아케인셰이드 무투장갑")

    def test_4_market_price_statistics(self) -> None:
        res = self.engine.get_market_price({"itemName": "아케인셰이드 무투장갑"})
        summary = res["summary"]
        self.assertEqual(summary["sampleCount"], 3)
        self.assertEqual(summary["minPrice"], 104_5000_0000)
        self.assertEqual(summary["maxPrice"], 115_0000_0000)
        self.assertEqual(summary["medianPrice"], 108_0000_0000)

    def test_5_wishlist_and_browser_focus_workflow(self) -> None:
        add_res = self.engine.manage_wishlist({"action": "add", "itemId": "item-1001"})
        self.assertTrue(add_res["success"])
        self.assertEqual(
            add_res["directPurchaseGuide"]["wishlistUrl"],
            "https://auction.maplestory.nexon.com/buy",
        )

        wish = self.engine.get_wishlist()
        wish_ids = {it["itemId"] for it in wish["items"]}
        self.assertIn("item-1001", wish_ids)

        focus_res = self.engine.open_item_in_browser(
            {"target": "wishlist", "itemId": "item-1001"}
        )
        self.assertTrue(focus_res["success"])
        self.assertEqual(focus_res["highlightedItemId"], "item-1001")

    def test_6_nexon_api_spec_up_simulator(self) -> None:
        comp_res = self.engine.compare_spec_up(
            {"characterName": "낑선", "sortBy": "damage_desc"}
        )
        self.assertEqual(comp_res["character"]["name"], "낑선")
        self.assertEqual(comp_res["comparedCount"], 3)

        top = comp_res["comparisons"][0]
        self.assertGreater(top["estimatedFinalDamageChangePct"], 0)
        self.assertIsNotNone(top["mesoPerOnePctFinalDamage"])

    def test_7_dom_banner_parser_fixes_nickname_and_meso_vs_combat_power(self) -> None:
        # 케이스 A: 텍스트 노드가 합쳐진 형태
        tokens_a = [
            "MAPLE AUCTION",
            "검색 횟수 0 / 100 · 판매 횟수 0 / 20",
            "도움말",
            "로그아웃",
            "MVP",
            "낑선",
            "Lv.293 | 아크 | 전투력 9761만 8592",
            "344억 4263만 477",
            "343",
            "구매",
            "판매",
            "시세",
        ]
        parsed_a = parse_auction_banner_tokens(tokens_a)
        self.assertTrue(parsed_a["loggedIn"])
        self.assertEqual(parsed_a["character"]["name"], "낑선")
        self.assertEqual(parsed_a["character"]["level"], 293)
        self.assertEqual(parsed_a["character"]["job"], "아크")
        self.assertEqual(parsed_a["character"]["combatPowerFormatted"], "9761만 8592")
        self.assertEqual(parsed_a["currency"]["mesoFormatted"], "344억 4263만 477")
        self.assertEqual(parsed_a["currency"]["meso"], 344_4263_0477)
        self.assertEqual(parsed_a["currency"]["maplePoint"], 343)

        # 케이스 B: 텍스트 노드가 개별 span으로 쪼개진 형태 (삼각형 기호 없어도 닉네임 정상 인식)
        tokens_b = [
            "MAPLE AUCTION",
            "검색 횟수 0 / 100",
            "판매 횟수 0 / 20",
            "도움말",
            "로그아웃",
            "MVP",
            "낑선",
            "Lv.293",
            "|",
            "아크",
            "|",
            "전투력",
            "9761만 8592",
            "344억 4263만 477",
            "P",
            "343",
            "구매",
            "판매",
        ]
        parsed_b = parse_auction_banner_tokens(tokens_b)
        self.assertEqual(parsed_b["character"]["name"], "낑선")
        self.assertEqual(parsed_b["character"]["combatPowerFormatted"], "9761만 8592")
        self.assertEqual(parsed_b["currency"]["mesoFormatted"], "344억 4263만 477")
        self.assertEqual(parsed_b["currency"]["maplePoint"], 343)


if __name__ == "__main__":
    unittest.main(verbosity=2)

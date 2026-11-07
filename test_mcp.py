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
)


class TestMapleAuctionMcp(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = MapleAuctionMcpEngine()

    def test_1_format_meso(self) -> None:
        self.assertEqual(format_meso(344_4263_0477), "344억 4263만 477")
        self.assertEqual(format_meso(185_0000_0000), "185억")

    def test_2_security_guard_blocks_purchase_and_sell(self) -> None:
        # 허용된 액션 통과 확인
        assert_allowed_bridge_action("SEARCH_ITEMS")
        assert_allowed_bridge_action("ADD_WISHLIST")
        assert_allowed_bridge_action("FOCUS_AND_HIGHLIGHT")

        # 직접 구매/판매 관련 액션은 반드시 차단되어야 함
        for forbidden in ["BUY_ITEM", "PURCHASE_CONFIRM", "SELL_REGISTER", "CANCEL_SALE"]:
            with self.assertRaises(ValueError) as ctx:
                assert_allowed_bridge_action(forbidden)
            self.assertIn("SECURITY_BLOCK", str(ctx.exception))

    def test_3_search_and_quota_cache_protection(self) -> None:
        # 1차 검색: 캐시 미스 -> 검색 횟수 1 증가 (1/100)
        res1 = self.engine.search_auction_items({"itemName": "아케인셰이드"})
        self.assertFalse(res1["fromCache"])
        self.assertEqual(res1["quota"]["searchUsed"], 1)
        self.assertEqual(res1["quota"]["searchRemaining"], 99)

        # 2차 검색 (세부 조건 변경): 로컬 캐시 히트 -> 검색 횟수 차감 없음 (여전히 1/100)
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
        # 찜 등록
        add_res = self.engine.manage_wishlist({"action": "add", "itemId": "item-1001"})
        self.assertTrue(add_res["success"])
        self.assertEqual(
            add_res["directPurchaseGuide"]["wishlistUrl"],
            "https://auction.maplestory.nexon.com/buy",
        )

        # 찜 목록 확인
        wish = self.engine.get_wishlist()
        wish_ids = {it["itemId"] for it in wish["items"]}
        self.assertIn("item-1001", wish_ids)

        # 브라우저 포커스 및 하이라이트
        focus_res = self.engine.open_item_in_browser(
            {"target": "wishlist", "itemId": "item-1001"}
        )
        self.assertTrue(focus_res["success"])
        self.assertEqual(focus_res["highlightedItemId"], "item-1001")

    def test_6_nexon_api_spec_up_simulator(self) -> None:
        # 캐릭터 장비 대비 경매장 매물 3종 스펙업 시뮬레이션
        comp_res = self.engine.compare_spec_up(
            {"characterName": "낑선", "sortBy": "damage_desc"}
        )
        self.assertEqual(comp_res["character"]["name"], "낑선")
        self.assertEqual(comp_res["comparedCount"], 3)

        top = comp_res["comparisons"][0]
        self.assertGreater(top["estimatedFinalDamageChangePct"], 0)
        self.assertIsNotNone(top["mesoPerOnePctFinalDamage"])
        print("\n[스펙업 시뮬레이션 결과 요약]")
        for c in comp_res["comparisons"]:
            print(
                f" - {c['candidateItem']['itemName']} ({c['candidateItem']['priceFormatted']} 메소): "
                f"{c['recommendationSummary']}"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)

# Maple Auction MCP (메이플스토리 웹 옥션 MCP 서버 & 브릿지)

메이플스토리 공식 웹 옥션(`https://auction.maplestory.nexon.com/buy`)과 AI 에이전트(Claude, Cursor, Antigravity 등)를 연동하여 **매물 검색, 실거래 시세 통계 분석, 넥슨 Open API 기반 캐릭터 스펙업(최종 데미지 증감률 및 가성비) 비교, 찜목록 관리 및 구매 화면 포커스**를 수행하는 MCP 프로젝트입니다.

> **🔒 안전 설계 (Read & Wishlist Only Guard)**
> 계정 보호 및 메소 오소진 사고 방지를 위해 **직접 구매·판매(메소 결제) API 호출은 브릿지 및 인터셉터 레벨에서 원천 차단**되어 있습니다. 마음에 드는 매물은 AI가 **[찜목록]에 즉시 등록**하고 **웹 옥션 브라우저 탭을 활성화·하이라이트**하여 사용자가 클릭 한 번으로 안전하게 구매할 수 있도록 연결합니다.

---

## 1. 주요 기능 (MCP Tools 8종)

| Tool 이름 | 설명 |
| :--- | :--- |
| `get_auction_status` | 웹 옥션 연결 상태, 로그인 캐릭터 정보(레벨/직업/전투력), 보유 메소, **남은 일일 검색 횟수(`0/100`)** 조회 |
| `search_auction_items` | 조건별 매물 검색 + **5분 로컬 TTL 캐시 & 로컬 재필터링**으로 일일 검색 100회 차감 방지 |
| `get_market_price` | [시세] 탭 실거래 완료 내역 조회 및 **평균가 / 중앙값 / 최저가 / 최고가 / 편차율** 자동 계산 |
| `get_wishlist` | 현재 [찜목록]에 담긴 매물 리스트 및 상세 옵션 조회 |
| `manage_wishlist` | 마음에 드는 매물(`itemId`)을 **[찜목록]에 추가(`add`) 또는 해제(`remove`)** 후 구매 바로가기 URL 반환 |
| `open_item_in_browser` | 열려 있는 크롬 웹 옥션 탭을 포커스하고 해당 매물(또는 찜목록)을 화면 중앙에 하이라이트 |
| `get_my_character_equipment` | **Nexon Open API** 연동 — 내 캐릭터의 현재 장착 장비 및 종합 스탯 조회 (영구 캐시 지원) |
| `compare_spec_up` | **스펙업 시뮬레이터** — 현재 장착 장비 대비 경매장 매물 장착 시 **예상 최종 데미지 증감률(%)** 및 **최종뎀 1%당 소요 메소(가성비 순위)** 비교 |

---

## 2. 디렉토리 구조

```text
Maplestory/
├── package.json                 # Node.js / TypeScript 모노레포 루트
├── tsconfig.base.json           # 공통 TypeScript 설정
├── mcp_server.py                # Python 3.11+ 즉시 실행용 Standalone MCP 서버
├── test_mcp.py                  # 전체 8종 Tool 및 보안 가드/스펙업 계산 통합 테스트
├── packages/
│   ├── shared/                  # 공통 타입 및 한국어 메소 포맷터, 보안 화이트리스트 가드
│   │   └── src/
│   │       ├── types.ts
│   │       └── formatters.ts
│   ├── mcp-server/              # TypeScript MCP 서버 및 로컬 WebSocket 브릿지
│   │   └── src/
│   │       ├── index.ts         # MCP Stdio 엔트리포인트 (8종 Tool)
│   │       ├── bridge-server.ts # Chrome Extension 통신용 로컬 서버 (127.0.0.1:19595)
│   │       ├── cache.ts         # 일일 100회 검색 한도 보호 캐시 및 로컬 필터
│   │       ├── nexon-api.ts     # Nexon Open API (ocid, stat, item-equipment) 클라이언트
│   │       └── spec-simulator.ts# 최종 데미지 증감률(%) 및 1%당 메소 가성비 계산기
│   └── chrome-extension/        # 크롬 확장 프로그램 (Manifest V3)
│       ├── manifest.json
│       ├── interceptor.js       # 웹 옥션 내부 API 자동 캡처 및 결제 차단 가드
│       ├── content.js           # 웹 옥션 DOM 파서 (검색 횟수 0/100, 매물 하이라이트)
│       ├── background.js        # 로컬 MCP 서버 WebSocket 브릿지 및 탭 포커스 제어
│       └── popup.html / popup.js# 연결 상태 확인 대시보드 팝업
```

---

## 3. 설치 및 실행 가이드

### Step 1: 크롬 확장 프로그램 로드
1. 크롬 브라우저 주소창에 `chrome://extensions` 입력 후 이동합니다.
2. 우측 상단의 **개발자 모드(Developer mode)** 토글을 켭니다.
3. 좌측 상단의 **압축해제된 확장 프로그램을 로드합니다(Load unpacked)** 버튼을 클릭합니다.
4. 본 프로젝트의 `packages/chrome-extension` 폴더를 선택합니다.
5. `https://auction.maplestory.nexon.com/buy` 에 접속하여 넥슨 OTP 로그인을 완료합니다.

### Step 2: MCP 클라이언트 등록 (`mcp_config.json`)

#### 방법 A: Python으로 즉시 실행 (현재 PC에 설치된 Python 3.11 활용)
```json
{
  "mcpServers": {
    "maple-auction": {
      "command": "python",
      "args": [
        "c:/Users/BadDay/Desktop/프로젝트/Maplestory/mcp_server.py"
      ],
      "env": {
        "NEXON_OPEN_API_KEY": "발급받은_넥슨_오픈_API_키_입력(선택)"
      }
    }
  }
}
```

#### 방법 B: Node.js + TypeScript 빌드 후 실행
```bash
npm install
npm run build
```
```json
{
  "mcpServers": {
    "maple-auction": {
      "command": "node",
      "args": [
        "c:/Users/BadDay/Desktop/프로젝트/Maplestory/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "NEXON_OPEN_API_KEY": "발급받은_넥슨_오픈_API_키_입력(선택)"
      }
    }
  }
}
```

---

## 4. AI 프롬프트 사용 예시

* **매물 검색 & 시세 비교:**
  > *"아케인셰이드 무투장갑 22성 매물 검색해주고, 최근 실거래 시세 평균가랑 비교해서 지금 올라온 매물이 적정가인지 알려줘."*
* **내 캐릭터 스펙업 가성비 비교 (Nexon Open API 연동):**
  > *"내 캐릭터 '낑선' 현재 장비 기준으로 경매장 매물들 스펙업 비교(compare_spec_up) 돌려서 최종 데미지 1%당 메소 가성비가 가장 좋은 부위 추천해줘."*
* **찜 등록 및 구매 페이지 이동:**
  > *"추천해준 장갑 매물(`item-1002`) 맘에 드는데 찜목록에 등록해주고 브라우저에서 바로 구매할 수 있게 창 띄워줘."*

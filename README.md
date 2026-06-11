---
title: myStock
emoji: 📈
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# myStock — 股票追蹤儀表板

即時追蹤台股與美股的股價變化，支援建倉記錄與漲跌幅計算。

> 🌐 **線上版**：[https://ark945-mystock.hf.space](https://ark945-mystock.hf.space)

## 功能

- 🔍 **搜尋股票** — 輸入代號或公司名稱（例：`2330`、`AAPL`、`台積電`）
- 📊 **即時報價** — 每 15 秒自動更新最新股價（可自訂 5/15/30/60 秒）
- 📈 **漲跌幅計算** — 基於建倉股價自動計算損益百分比
- ✏️ **建倉管理** — 可新增、編輯、刪除追蹤的股票及建倉資料
- 💾 **Supabase 雲端儲存** — 資料存於 Supabase 資料庫，跨裝置同步
- 🌏 **雙市場支援** — 台股（TWSE/TPEx）+ 美股（Yahoo Finance）

## 截圖

| 功能 | 說明 |
|------|------|
| 深色主題儀表板 | 玻璃擬態設計，漸層背景動畫 |
| 搜尋下拉選單 | 即時搜尋，標示台股/美股 |
| 建倉對話框 | 輸入建倉日與建倉價 |
| 漲跌顯示 | 紅漲綠跌（台股慣例），閃爍動畫 |

## 技術架構

```
┌─────────────────────────────────────────┐
│        Hugging Face Spaces (Docker)     │
│                                         │
│  ┌───────────┐     ┌─────────────────┐  │
│  │  前端 UI   │────▶│  FastAPI 後端   │  │
│  │ HTML/CSS/JS│◀────│  (Python)       │  │
│  └───────────┘     └────────┬────────┘  │
│                              │           │
└──────────────────────────────┼───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │   twstock    │ │   yfinance   │ │   Supabase   │
     │  (台股即時)   │ │  (美股即時)   │ │  (資料儲存)   │
     └──────────────┘ └──────────────┘ └──────────────┘
```

- **後端**：FastAPI + yfinance + twstock + supabase-py
- **前端**：HTML + CSS（深色玻璃擬態主題）+ JavaScript
- **資料庫**：Supabase（PostgreSQL）
- **部署**：Docker on Hugging Face Spaces

## 效能與頻率限制 (Rate Limiting) 優化設計

為了解決台灣證券交易所 (TWSE) API 與 Yahoo Finance (yfinance) 嚴格的頻率限制 (Rate Limit)，本專案在 [stock_service.py](file:///d:/MyLab/myStock/stock_service.py) 與 [app.py](file:///d:/MyLab/myStock/app.py) 中採用了以下優化策略：

### 1. 採用的設計方案：多個股整併查詢 (Batching & Consolidation)
本專案採用**「多個股整併查詢」**作為主要資料獲取途徑，並結合**「智慧型快取與定時低頻更新」**，達到零延遲、不觸發阻擋的穩定運行效果。

*   **台股即時報價 (TWSE MIS API)**：
    *   將使用者追蹤清單中的所有台股代號，依上市/上櫃分類加上字尾，並使用 `|` 符號串接（例如 `tse_2330.tw|otc_5347.tw`）。
    *   發送**單一 HTTP 請求**至 `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=...`。
    *   不論使用者追蹤了 10 支還是 20 支台股，**背景更新程式每次循環僅消耗 1 次 API 請求額度**，完全避免因頻繁單獨查詢而被證交所封鎖 IP 的風險。
*   **技術指標與美股價格 (yfinance API)**：
    *   **批次初始化**：使用 `yf.Tickers(" ".join(symbols))` 一次性打包初始化所有股票代號。
    *   **輕量化查詢**：藉由 `.fast_info` 僅取得昨收價、52週低點、52週高點、50MA 與 200MA 等中長線數據，避開查詢開銷極大的完整 `.info`。

### 2. 智慧型基本面資料快取機制
本益比 (PE)、股息殖利率、Beta 係數、流動比率等基本面指標變動頻率極低，但若每次都調用 `yfinance` 完整 `.info` 接口，會耗費大量頻寬且極易被 Yahoo 封鎖 (Too Many Requests)。因此我們實作了以下快取機制：
1.  **新建倉即時同步抓取**：當使用者新增股票至追蹤清單時，後端即時同步發送一次 yfinance 請求，抓取包含基本面與技術指標的所有欄位，並寫入 Supabase 快取，確保新增後第一秒即可顯示完整體檢資料。
2.  **定時低頻背景更新**：背景更新程序 (`price_updater_loop`) 每 60 秒跑一次，**僅抓取即時價格與昨收價**。只有在滿足以下條件時，才會發送慢速 API 去更新基本面資料：
    *   系統偵測到有股票的基本面欄位為空值（`pe_ratio IS NULL`）。
    *   背景計數器達到 1440 輪（每 24 小時一次）。

## 專案結構

```
myStock/
├── README.md              # 說明文件（含 HF Spaces YAML）
├── Dockerfile             # Docker 容器設定
├── requirements.txt       # Python 依賴
├── config.json            # 本地 Supabase 設定（不入版控）
├── app.py                 # FastAPI 後端主程式
├── stock_service.py       # 股票查詢服務（twstock + yfinance）
├── supabase_init.sql      # Supabase 資料表建立 SQL
├── static/
│   ├── index.html         # 主頁面
│   ├── style.css          # 深色主題樣式
│   └── app.js             # 前端邏輯
└── .gitignore
```

## API 端點

| 路由 | 方法 | 說明 |
|------|------|------|
| `/` | GET | 主頁面 |
| `/api/search?q={keyword}` | GET | 搜尋股票代號或名稱 |
| `/api/quote?symbols={s1,s2}` | GET | 批次取得即時報價 |
| `/api/watchlist` | GET | 取得追蹤清單 |
| `/api/watchlist` | POST | 新增股票到追蹤清單 |
| `/api/watchlist/{symbol}` | PUT | 更新建倉資料 |
| `/api/watchlist/{symbol}` | DELETE | 移除追蹤的股票 |

## 快速開始

### 1. 環境準備

```bash
# 安裝 Python 依賴
pip install -r requirements.txt
```

### 2. Supabase 設定

#### 建立資料表

在 [Supabase Dashboard](https://supabase.com/dashboard) 的 SQL Editor 執行 `supabase_init.sql`：

```sql
CREATE TABLE IF NOT EXISTS watchlist (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    symbol TEXT NOT NULL,
    name TEXT DEFAULT '',
    market TEXT DEFAULT 'TW',
    entry_date TEXT DEFAULT '',
    entry_price NUMERIC(12, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(symbol)
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service_role" ON watchlist
  FOR ALL USING (true) WITH CHECK (true);

GRANT ALL ON watchlist TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON watchlist TO service_role;
```

#### 本地開發設定

建立 `config.json`（已被 `.gitignore` 排除，不會被推送）：

```json
{
    "supabase_settings": {
        "url": "https://your-project.supabase.co",
        "key": "your-service-role-key"
    }
}
```

### 3. 本地啟動

```bash
python -m uvicorn app:app --host 0.0.0.0 --port 7860 --reload
```

開啟瀏覽器訪問 http://localhost:7860

## 部署

### GitHub

```bash
# 初次推送
git init
git add .
git commit -m "Initial commit"
git branch -M main
gh repo create myStock --public --source=. --push

# 後續更新
git add .
git commit -m "your commit message"
git push origin main
```

### Hugging Face Spaces

```bash
# 1. 安裝 huggingface_hub 並登入
pip install huggingface_hub
python -c "from huggingface_hub import login; login(token='YOUR_HF_TOKEN')"

# 2. 建立 Space（首次）
python -c "
from huggingface_hub import HfApi
api = HfApi()
api.create_repo(repo_id='YOUR_USERNAME/myStock', repo_type='space', space_sdk='docker', exist_ok=True)
"

# 3. 設定 Supabase 環境變數（首次）
python -c "
from huggingface_hub import HfApi
api = HfApi()
api.add_space_secret('YOUR_USERNAME/myStock', 'SUPABASE_URL', 'https://your-project.supabase.co')
api.add_space_secret('YOUR_USERNAME/myStock', 'SUPABASE_KEY', 'your-service-role-key')
"

# 4. 加入 HF remote 並推送（首次）
git remote add hf https://huggingface.co/spaces/YOUR_USERNAME/myStock
git push hf main --force

# 5. 後續更新（先推 GitHub 再推 HF）
git add .
git commit -m "your commit message"
git push origin main
git push hf main
```

### 部署後驗證

- HF Space 建置約需 2-3 分鐘
- 建置完成後訪問：`https://YOUR_USERNAME-mystock.hf.space`
- 在 HF Space 的 **Settings** 頁面可查看建置日誌

## 注意事項

- **台股即時報價**：來自 TWSE/TPEx，交易時間外會顯示最後收盤價
- **美股報價延遲**：yfinance 資料約有 15 分鐘延遲
- **更新頻率**：建議 15 秒以上，過於頻繁可能被資料源封鎖
- **config.json**：包含 Supabase 金鑰，已加入 `.gitignore`，請勿手動提交
- **HF Spaces 環境變數**：部署時透過 `add_space_secret` 設定，不需 config.json

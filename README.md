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

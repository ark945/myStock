# myStock 部署遷移規劃書：從 Hugging Face 遷移至 GitHub 及高穩定度平台

## 1. 現況分析與痛點
- **現行架構**：
  - 後端：Python 3.11 + FastAPI + Uvicorn + yfinance + twstock + Supabase Client
  - 前端：HTML5 + 原生 JavaScript + CSS3（目前由 FastAPI 透過 `static/` 靜態路由同源託管）
  - 雲端託管：Hugging Face Spaces (`https://huggingface.co/spaces/ark945/myStock`)
- **使用者痛點**：
  - Hugging Face Spaces (HF) 伺服器位於歐美，對台灣網路線路延遲高、時常不穩定或封包中斷。
  - 免費 Space 在無人使用一段時間後會進入休眠（Sleep），喚醒需要數十秒。

---

## 2. GitHub 部署技術邊界澄清
> **重要說明**：
> GitHub 主要為**程式碼代管平台**，其提供的網頁託管服務為 **GitHub Pages**。
> - **GitHub Pages 的能力與限制**：僅能託管**純靜態檔案（HTML / CSS / JS / 圖片）**，**無法在伺服器端運行 Python（FastAPI、uvicorn、twstock 即時爬蟲、後台定時線程）**。
> - 因此，無法將整個 FastAPI 後端「直接扔在 GitHub Pages 上執行」。
> - **「部署在 GitHub」的業界最佳實踐**為：
>   以 **GitHub 為版本控制中心 (Single Source of Truth)**，每次推送（`git push origin main`）自動連動或觸發部署到具備穩定線路的現代雲端平台，或將靜態前端與後端分離。

---

## 3. 可行方案評估與對比

| 方案 | 架構方式 | 線路穩定度 / 延遲 | 成本 | 複雜度 | 優點 | 缺點 / 限制 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **方案 A<br>(強烈推薦)** | **GitHub 連動 Render.com (Docker/Python Web)** | ⭐️⭐️⭐️⭐️⭐️<br>(全球 CDN，亞太節點穩定) | 免費方案 (Free) | 低 (維持現有架構) | 1. 每次 push GitHub 自動建置<br>2. 原生支援現有 Dockerfile<br>3. 支援 HTTPS、自訂網址<br>4. 連線品質大幅優於 HF | 免費版長久未使用會有冷啟動 (但可透過 cron-job 保活) |
| **方案 B<br>(亞太最佳)** | **GitHub 連動 Zeabur (亞太節點)** | ⭐️⭐️⭐️⭐️⭐️<br>(台灣/日本節點，極低延遲) | 提供免費額度或銅板價 | 極低 | 1. 伺服器在台灣或東京，台股連線極快<br>2. 爬證交所/Yahoo 完全不被擋<br>3. 一鍵綁定 GitHub 倉庫 | 免費額度過後每月需微量用量計費 |
| **方案 C<br>(前後端分離)** | **GitHub Pages (前端) + Render/Zeabur (API 後端)** | ⭐️⭐️⭐️⭐️<br>(前端 GitHub 極速，後端依平台) | 免費 | 中 | 1. 前端擁有 `ark945.github.io` 頂級 CDN 加速<br>2. 前後端解耦 | 需要維護兩套設定與處理 CORS 跨域請求 |
| **方案 D<br>(本機常駐自建)** | **本機 NUC + Cloudflare Tunnel + GitHub 備份** | ⭐️⭐️⭐️⭐️⭐️<br>(走本機網路 + CF 邊緣加速) | 100% 免費 | 中 | 1. 100% 掌握在自己手中，絕不睡死<br>2. 爬蟲 IP 為自家網路，台股連線最穩<br>3. 免費 Cloudflare 穿透，自帶 HTTPS | 需保持本機 NUC 開機運行 |

---

## 4. 推薦實施計畫 (方案 A：GitHub + Render 免費自動部署)

### 步驟 1：調整程式碼以相容多平台環境 (已可在本地先做好)
1. **Dockerfile 彈性 PORT 支援**：
   Render 會自動注入動態環境變數 `$PORT`（通常為 10000），HF Spaces 則使用 `7860`。
   將啟動命令調整為可同時相容兩者：
   ```dockerfile
   CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}"]
   ```
2. **CORS 支援（跨域安全政策）**：
   在 `app.py` 加入 `CORSMiddleware`，讓未來無論是由同源託管還是由 GitHub Pages 呼叫都能正常通訊。

### 步驟 2：推送到 GitHub 倉庫
執行：
```powershell
git add .
git commit -m "chore: support dynamic PORT and multi-cloud deployment"
git push origin main
```

### 步驟 3：在 Render.com 設定一鍵自動部署 (3 分鐘完成)
1. 前往 [Render.com](https://render.com/) 並使用 **GitHub 帳號**登入。
2. 點選 **"New +" -> "Web Service"**。
3. 選擇 **"Build and deploy from a Git repository"**，選取 `ark945/myStock` 倉庫。
4. 設定基本資料：
   - **Name**: `mystock`（將產生 `https://mystock-xxxx.onrender.com` 網址）
   - **Region**: 建議選擇 `Singapore` 或 `Oregon`（新加坡節點對台灣連線最快最穩）
   - **Branch**: `main`
   - **Runtime**: `Docker` (系統會自動抓取目錄下的 `Dockerfile`)
   - **Instance Type**: `Free`
5. 設定環境變數 (Environment Variables)：
   - `SUPABASE_URL`: 填入您的 Supabase URL
   - `SUPABASE_KEY`: 填入您的 Supabase Key
6. 點擊 **"Create Web Service"**，Render 就會自動建置並發布。
   之後只要在本地推送 GitHub (`git push origin main`)，Render 就會自動更新部署！

---

## 5. 後續防休眠保活技巧 (Keep-Alive)
若使用 Render 免費方案，在 15 分鐘無人存取後會暫時休眠：
- 可使用免費的 [UptimeRobot](https://uptimerobot.com/) 或 [cron-job.org](https://cron-job.org/)，設定每 10 分鐘發送一次 HTTP GET 請求到 `https://您的Render網址/api/health`（或首頁），即可保持 24 小時不休眠且秒開。

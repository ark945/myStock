"""
app.py — FastAPI 主應用
提供股票搜尋、即時報價、追蹤清單 CRUD API，以及靜態前端頁面。
資料儲存於 Supabase。
"""

import os
import json
from fastapi import FastAPI, Query, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from supabase import create_client, Client
from stock_service import search_stock, get_quotes

import asyncio
from contextlib import asynccontextmanager

# ==========================================
# Supabase Config (同 wordAppOnWeb 模式)
# ==========================================
CONFIG_FILE = "config.json"

def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

IS_CLOUD = os.environ.get("SPACE_ID") is not None
local_cfg = load_config()

if IS_CLOUD:
    SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
    SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
else:
    s_cfg = local_cfg.get("supabase_settings", {})
    SUPABASE_URL = s_cfg.get("url", "")
    SUPABASE_KEY = s_cfg.get("key", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("⚠️ 警告: 缺少 Supabase 設定資訊！")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ==========================================
# Background Price Updater
# ==========================================
loop_count = 0

async def price_updater_loop():
    global loop_count
    # 延遲 5 秒啟動，讓 FastAPI 完成初始化
    await asyncio.sleep(5)
    while True:
        try:
            # A. 從 Supabase 取得目前所有正在追蹤的股票
            response = supabase.table("watchlist").select("*").execute()
            rows = response.data if response.data else []
            symbols = [row["symbol"] for row in rows]
            
            if symbols:
                # 檢查是否有任何股票的基本面欄位仍為空
                has_empty_fundamentals = any(
                    r.get("pe_ratio") is None and r.get("dividend_yield") is None and r.get("beta") is None
                    for r in rows
                )
                
                # 每 24 小時（計數器 1440 輪）或有新股未初始化時，抓取完整基本面
                do_fetch_fundamentals = (loop_count % 1440 == 0) or has_empty_fundamentals
                
                # B. 呼叫 get_quotes 批次抓取
                quotes = get_quotes(symbols, fetch_fundamentals=do_fetch_fundamentals)
                
                # C. 將更新後的價格與指標寫回 Supabase
                success_count = 0
                for q in quotes:
                    if q.get("success") and q.get("price") is not None:
                        try:
                            update_data = {
                                "current_price": q["price"],
                                "price_updated_at": "now()"
                            }
                            if q.get("prev_close") is not None:
                                update_data["yesterday_close"] = q["prev_close"]
                            if q.get("fifty_two_week_low") is not None:
                                update_data["fifty_two_week_low"] = q["fifty_two_week_low"]
                            if q.get("fifty_two_week_high") is not None:
                                update_data["fifty_two_week_high"] = q["fifty_two_week_high"]
                            if q.get("ma_50") is not None:
                                update_data["ma_50"] = q["ma_50"]
                            if q.get("ma_200") is not None:
                                update_data["ma_200"] = q["ma_200"]
                                
                            # 只有在 fetch_fundamentals 為 True 且獲取到資料時才寫入基本面
                            if do_fetch_fundamentals:
                                if q.get("pe_ratio") is not None:
                                    update_data["pe_ratio"] = q["pe_ratio"]
                                if q.get("dividend_yield") is not None:
                                    update_data["dividend_yield"] = q["dividend_yield"]
                                if q.get("beta") is not None:
                                    update_data["beta"] = q["beta"]
                                if q.get("current_ratio") is not None:
                                    update_data["current_ratio"] = q["current_ratio"]

                            supabase.table("watchlist") \
                                .update(update_data) \
                                .eq("symbol", q["symbol"]) \
                                .execute()
                            success_count += 1
                        except Exception as inner_e:
                            print(f"寫入單筆股價 {q['symbol']} 失敗: {inner_e}")
                            
                print(f"背景更新成功: 已完成 {success_count}/{len(symbols)} 檔股票更新 (基本面更新={do_fetch_fundamentals})")
                loop_count += 1
        except Exception as e:
            print(f"背景價格更新程序出錯: {e}")
            
        # 每 60 秒執行一次
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 啟動時：開始背景工作
    updater_task = asyncio.create_task(price_updater_loop())
    yield
    # 關閉時：取消背景工作
    updater_task.cancel()
    try:
        await updater_task
    except asyncio.CancelledError:
        pass


# ==========================================
# FastAPI App
# ==========================================
app = FastAPI(
    title="myStock",
    description="股票追蹤儀表板 API",
    lifespan=lifespan
)


# --- Pydantic Models ---
class WatchlistItem(BaseModel):
    symbol: str
    name: str = ""
    market: str = "TW"
    entry_date: str = ""
    entry_price: Optional[float] = None
    target_price: Optional[float] = 0.0


class WatchlistUpdate(BaseModel):
    entry_date: Optional[str] = None
    entry_price: Optional[float] = None
    target_price: Optional[float] = None


class WatchlistReorder(BaseModel):
    symbols: list[str]


# ==========================================
# Stock APIs
# ==========================================
@app.get("/api/search")
async def api_search(
    q: str = Query(..., description="搜尋關鍵字（股票代號或公司名稱）"),
    max_results: int = Query(10, ge=1, le=20),
):
    """搜尋股票代號或公司名稱"""
    results = search_stock(q, max_results=max_results)
    return {"query": q, "results": results}


@app.get("/api/quote")
async def api_quote(
    symbols: str = Query(..., description="股票代號，多個以逗號分隔"),
):
    """批次取得即時報價"""
    symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        return {"quotes": []}
    quotes = get_quotes(symbol_list)
    return {"quotes": quotes}


# ==========================================
# Watchlist CRUD APIs (Supabase)
# ==========================================
@app.get("/api/watchlist")
async def api_get_watchlist():
    """取得所有追蹤清單"""
    try:
        response = supabase.table("watchlist").select("*").order("sort_order").order("id").execute()
        return {"success": True, "data": response.data}
    except Exception as e:
        print(f"Supabase Get Watchlist Error: {e}")
        return {"success": False, "data": [], "error": str(e)}


@app.post("/api/watchlist")
async def api_add_watchlist(item: WatchlistItem):
    """加入股票到追蹤清單"""
    try:
        # 查詢當前最大 sort_order
        max_order = 0
        try:
            response = supabase.table("watchlist").select("sort_order").order("sort_order", desc=True).limit(1).execute()
            if response.data:
                max_order = response.data[0].get("sort_order") or 0
        except Exception as order_e:
            print(f"查詢 max sort_order 失敗 (欄位可能尚未建立): {order_e}")

        data = {
            "symbol": item.symbol,
            "name": item.name,
            "market": item.market,
            "entry_date": item.entry_date,
            "entry_price": item.entry_price,
            "target_price": item.target_price if item.target_price is not None else 0.0,
            "sort_order": max_order + 1,
        }

        # 新增股票時，同步抓取最新價格與技術/基本面歷史資料
        try:
            quotes = get_quotes([item.symbol], fetch_fundamentals=True)
            if quotes:
                q = quotes[0]
                if q.get("success") and q.get("price") is not None:
                    data["current_price"] = q["price"]
                    data["price_updated_at"] = "now()"
                    if q.get("prev_close") is not None:
                        data["yesterday_close"] = q["prev_close"]
                    if q.get("fifty_two_week_low") is not None:
                        data["fifty_two_week_low"] = q["fifty_two_week_low"]
                    if q.get("fifty_two_week_high") is not None:
                        data["fifty_two_week_high"] = q["fifty_two_week_high"]
                    if q.get("ma_50") is not None:
                        data["ma_50"] = q["ma_50"]
                    if q.get("ma_200") is not None:
                        data["ma_200"] = q["ma_200"]
                    if q.get("pe_ratio") is not None:
                        data["pe_ratio"] = q["pe_ratio"]
                    if q.get("dividend_yield") is not None:
                        data["dividend_yield"] = q["dividend_yield"]
                    if q.get("beta") is not None:
                        data["beta"] = q["beta"]
                    if q.get("current_ratio") is not None:
                        data["current_ratio"] = q["current_ratio"]
        except Exception as e:
            print(f"預先抓取新建倉股票 {item.symbol} 歷史與基本面指標失敗: {e}")

        supabase.table("watchlist").upsert(data, on_conflict="symbol").execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Add Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlist/reorder")
async def api_reorder_watchlist(reorder: WatchlistReorder):
    """重新排序追蹤清單"""
    try:
        for index, symbol in enumerate(reorder.symbols):
            supabase.table("watchlist") \
                .update({"sort_order": index + 1}) \
                .eq("symbol", symbol) \
                .execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Reorder Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlist/{symbol}")
async def api_update_watchlist(symbol: str, update: WatchlistUpdate):
    """更新建倉資料"""
    try:
        update_data = {}
        if update.entry_date is not None:
            update_data["entry_date"] = update.entry_date
        if update.entry_price is not None:
            update_data["entry_price"] = update.entry_price
        if update.target_price is not None:
            update_data["target_price"] = update.target_price

        if update_data:
            supabase.table("watchlist").update(update_data).eq("symbol", symbol).execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Update Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.delete("/api/watchlist/{symbol}")
async def api_delete_watchlist(symbol: str):
    """從追蹤清單移除股票"""
    try:
        supabase.table("watchlist").delete().eq("symbol", symbol).execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Delete Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


# ==========================================
# Static Files & Index
# ==========================================
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")

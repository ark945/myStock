"""
stock_service.py — 股票查詢服務
支援台股 (twstock) 與美股 (yfinance)
"""

import re
import twstock
import yfinance as yf
from typing import Optional


def _is_tw_stock(symbol: str) -> bool:
    """判斷是否為台股代號（純數字，或數字+英文如 2330、6505、00878）"""
    return bool(re.match(r"^\d{4,6}[A-Za-z]?$", symbol.strip()))


def search_stock(keyword: str, max_results: int = 10) -> list[dict]:
    """
    搜尋股票，回傳符合條件的清單。
    支援台股代號/名稱與美股代號/公司名稱。
    """
    keyword = keyword.strip()
    if not keyword:
        return []

    results = []

    # --- 台股搜尋 ---
    # 1. 精確代號搜尋
    if keyword in twstock.codes:
        info = twstock.codes[keyword]
        results.append({
            "symbol": keyword,
            "name": info.name,
            "exchange": info.market,
            "market": "TW",
            "type": info.type,
        })

    # 2. 名稱模糊搜尋（在 twstock.codes 中搜尋）
    if len(results) == 0 or not _is_tw_stock(keyword):
        for code, info in twstock.codes.items():
            if keyword.lower() in info.name.lower() or keyword.lower() in code.lower():
                # 避免重複
                if not any(r["symbol"] == code for r in results):
                    results.append({
                        "symbol": code,
                        "name": info.name,
                        "exchange": info.market,
                        "market": "TW",
                        "type": info.type,
                    })
            if len(results) >= max_results:
                break

    # --- 美股搜尋（如果台股結果不足或看起來像英文）---
    if len(results) < max_results and (
        re.match(r"^[A-Za-z]", keyword) or len(results) == 0
    ):
        try:
            search = yf.Search(keyword, max_results=max_results - len(results))
            for quote in search.quotes:
                symbol = quote.get("symbol", "")
                # 跳過已在結果中的或台股代號（避免重複）
                if any(r["symbol"] == symbol for r in results):
                    continue
                results.append({
                    "symbol": symbol,
                    "name": quote.get("shortname") or quote.get("longname", ""),
                    "exchange": quote.get("exchange", ""),
                    "market": "US",
                    "type": quote.get("quoteType", ""),
                })
        except Exception:
            pass  # yfinance 搜尋失敗時不中斷

    return results[:max_results]


def get_quotes(symbols: list[str]) -> list[dict]:
    """
    批次取得即時報價。
    回傳每支股票的最新價格與漲跌資訊。
    """
    results = []

    tw_symbols = [s for s in symbols if _is_tw_stock(s)]
    us_symbols = [s for s in symbols if not _is_tw_stock(s)]

    # --- 批次獲取台股的昨日收盤價 (從 yfinance) ---
    tw_prev_closes = {}
    if tw_symbols:
        tw_yf_symbols = []
        for sym in tw_symbols:
            if sym in twstock.codes:
                info = twstock.codes[sym]
                if info.market == '上市':
                    tw_yf_symbols.append(f"{sym}.TW")
                else:
                    tw_yf_symbols.append(f"{sym}.TWO")
            else:
                tw_yf_symbols.append(f"{sym}.TW")
        try:
            tickers = yf.Tickers(" ".join(tw_yf_symbols))
            for sym, yf_sym in zip(tw_symbols, tw_yf_symbols):
                ticker = tickers.tickers.get(yf_sym.upper())
                if ticker:
                    prev_close = ticker.fast_info.get("previousClose") or ticker.fast_info.get("previous_close")
                    if prev_close is not None:
                        tw_prev_closes[sym] = round(prev_close, 2)
        except Exception as e:
            print(f"批次取得台股昨收失敗: {e}")

    # --- 台股即時報價 ---
    for sym in tw_symbols:
        try:
            data = twstock.realtime.get(sym)
            price = None
            name = ""
            timestamp = ""
            success = False
            error = None

            if data and data.get("success"):
                info = data.get("info", {})
                realtime = data.get("realtime", {})
                name = info.get("name", "")
                timestamp = info.get("time", "")

                # 取得最新成交價
                best_bid_price = realtime.get("latest_trade_price", "")
                if not best_bid_price or best_bid_price == "-":
                    # fallback: 使用最佳買價
                    best_bid_prices = realtime.get("best_bid_price")
                    if isinstance(best_bid_prices, list) and len(best_bid_prices) > 0:
                        best_bid_price = best_bid_prices[0]
                    else:
                        best_bid_price = ""

                price = _safe_float(best_bid_price)
                if price is not None:
                    success = True
                else:
                    error = "即時成交價不可用（可能非交易時段）"
            else:
                error = data.get("rtmessage", "查詢失敗") if data else "無資料"

            # --- Fallback: 若即時價格不可用，嘗試取得歷史最後收盤價 ---
            if price is None:
                try:
                    s = twstock.Stock(sym)
                    if s and s.close and len(s.close) > 0:
                        price = _safe_float(s.close[-1])
                        if price is not None:
                            success = True
                            error = None
                            # 若 realtime 未取得名稱，試著從 twstock.codes 取得
                            if not name and sym in twstock.codes:
                                name = twstock.codes[sym].name
                except Exception as ex:
                    if not error:
                        error = f"歷史價格獲取失敗: {str(ex)}"

            results.append({
                "symbol": sym,
                "name": name,
                "price": price,
                "prev_close": tw_prev_closes.get(sym),
                "market": "TW",
                "timestamp": timestamp,
                "success": success,
                **({"error": error} if not success and error else {})
            })

        except Exception as e:
            # 發生異常，也嘗試用 Stock 作為最後的 fallback
            price = None
            name = ""
            try:
                s = twstock.Stock(sym)
                if s and s.close and len(s.close) > 0:
                    price = _safe_float(s.close[-1])
                    if sym in twstock.codes:
                        name = twstock.codes[sym].name
            except Exception:
                pass

            results.append({
                "symbol": sym,
                "name": name,
                "price": price,
                "prev_close": tw_prev_closes.get(sym),
                "market": "TW",
                "timestamp": "",
                "success": price is not None,
                **({"error": str(e)} if price is None else {})
            })

    # --- 美股即時報價 ---
    if us_symbols:
        try:
            tickers = yf.Tickers(" ".join(us_symbols))
            for sym in us_symbols:
                try:
                    ticker = tickers.tickers.get(sym.upper())
                    if ticker:
                        fast = ticker.fast_info
                        price = fast.get("lastPrice") or fast.get("last_price")
                        prev_close = fast.get("previousClose") or fast.get("previous_close")

                        results.append({
                            "symbol": sym.upper(),
                            "name": "",  # fast_info 不含名稱，前端已有快取
                            "price": round(price, 2) if price else None,
                            "prev_close": round(prev_close, 2) if prev_close else None,
                            "market": "US",
                            "timestamp": "",
                            "success": price is not None,
                        })
                    else:
                        results.append({
                            "symbol": sym.upper(),
                            "name": "",
                            "price": None,
                            "market": "US",
                            "timestamp": "",
                            "success": False,
                            "error": "Ticker not found",
                        })
                except Exception as e:
                    results.append({
                        "symbol": sym.upper(),
                        "name": "",
                        "price": None,
                        "market": "US",
                        "timestamp": "",
                        "success": False,
                        "error": str(e),
                    })
        except Exception as e:
            for sym in us_symbols:
                results.append({
                    "symbol": sym.upper(),
                    "name": "",
                    "price": None,
                    "market": "US",
                    "timestamp": "",
                    "success": False,
                    "error": str(e),
                })

    return results


def _safe_float(val) -> Optional[float]:
    """安全轉換為 float"""
    try:
        if val is None or val == "" or val == "-":
            return None
        return round(float(val), 2)
    except (ValueError, TypeError):
        return None

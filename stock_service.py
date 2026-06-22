"""
stock_service.py — 股票查詢服務
支援台股 (twstock) 與美股 (yfinance)
"""

import re
import urllib.request
import json
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


def get_quotes(symbols: list[str], fetch_fundamentals: bool = False) -> list[dict]:
    """
    批次取得即時報價。
    回傳每支股票的最新價格、技術指標與基本面欄位。
    """
    results = []

    tw_symbols = [s for s in symbols if _is_tw_stock(s)]
    us_symbols = [s for s in symbols if not _is_tw_stock(s)]

    # --- 獲取台股即時報價與昨日收盤價 (從 TWSE 官方 API) ---
    tw_realtime_data = {}
    if tw_symbols:
        ex_ch_list = []
        for sym in tw_symbols:
            market_type = "tse"
            if sym in twstock.codes:
                info_code = twstock.codes[sym]
                if info_code.market == '上櫃':
                    market_type = "otc"
            ex_ch_list.append(f"{market_type}_{sym}.tw")
        
        try:
            url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={'|'.join(ex_ch_list)}"
            req = urllib.request.Request(
                url, 
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                html = response.read().decode('utf-8')
                data = json.loads(html)
                msg = data.get("msgArray", [])
                for m in msg:
                    sym = m.get("c")
                    name = m.get("n")
                    prev_close = _safe_float(m.get("y"))
                    
                    latest_price_str = m.get("z", "")
                    if not latest_price_str or latest_price_str == "-":
                        best_bids = m.get("b", "").split("_")
                        latest_price_str = best_bids[0] if best_bids and best_bids[0] else ""
                    
                    price = _safe_float(latest_price_str)
                    timestamp = f"{m.get('d', '')} {m.get('%', '')}"
                    tw_realtime_data[sym] = {
                        "name": name,
                        "price": price,
                        "prev_close": prev_close,
                        "timestamp": timestamp,
                        "success": price is not None
                    }
        except Exception as e:
            print(f"TWSE API 批次查詢失敗: {e}")

    # --- 獲取台股的技術指標與基本面 (從 yfinance) ---
    tw_metrics = {}
    if tw_symbols:
        yf_tw_mapping = {}  # {yf_sym: sym}
        for sym in tw_symbols:
            if sym in twstock.codes:
                info = twstock.codes[sym]
                suffix = ".TW" if info.market == '上市' else ".TWO"
                yf_sym = f"{sym}{suffix}"
            else:
                yf_sym = f"{sym}.TW"
            yf_tw_mapping[yf_sym] = sym

        try:
            tickers = yf.Tickers(" ".join(yf_tw_mapping.keys()))
            for yf_sym, sym in yf_tw_mapping.items():
                try:
                    ticker = tickers.tickers.get(yf_sym.upper()) or tickers.tickers.get(yf_sym)
                    if ticker:
                        fast = ticker.fast_info
                        pe_ratio = None
                        dividend_yield = None
                        beta = None
                        current_ratio = None
                        
                        sparkline_data = None
                        if fetch_fundamentals:
                            try:
                                inf = ticker.info
                                pe_ratio = inf.get("trailingPE") or inf.get("forwardPE")
                                dividend_yield = inf.get("dividendYield")
                                beta = inf.get("beta")
                                current_ratio = inf.get("currentRatio")
                            except Exception as fe:
                                print(f"取得台股 {sym} 基本面失敗: {fe}")
                                
                            try:
                                hist = ticker.history(period="1mo")
                                if not hist.empty:
                                    prices = list(hist["Close"].round(2))
                                    sparkline_data = ",".join(map(str, prices))
                            except Exception as he:
                                print(f"取得台股 {sym} 走勢圖歷史失敗: {he}")
                                
                        tw_metrics[sym] = {
                            "prev_close": _safe_float(fast.get("previousClose") or fast.get("regularMarketPreviousClose")),
                            "fifty_two_week_low": _safe_float(fast.get("yearLow")),
                            "fifty_two_week_high": _safe_float(fast.get("yearHigh")),
                            "ma_50": _safe_float(fast.get("fiftyDayAverage")),
                            "ma_200": _safe_float(fast.get("twoHundredDayAverage")),
                            "pe_ratio": _safe_float(pe_ratio),
                            "dividend_yield": _safe_float(dividend_yield),
                            "beta": _safe_float(beta),
                            "current_ratio": _safe_float(current_ratio),
                            "sparkline_data": sparkline_data,
                        }
                except Exception as e:
                    print(f"取得台股 {sym} 技術指標/基本面失敗: {e}")
        except Exception as e:
            print(f"批次取得台股指標失敗: {e}")

    # --- 台股即時報價與 Fallback ---
    for sym in tw_symbols:
        try:
            # 優先使用 TWSE 官方 API 資料
            rt = tw_realtime_data.get(sym)
            if rt and rt.get("success"):
                price = rt["price"]
                prev_close = rt["prev_close"]
                name = rt["name"]
                timestamp = rt["timestamp"]
                success = True
                error = None
            else:
                # Fallback to twstock
                data = twstock.realtime.get(sym)
                price = None
                name = ""
                timestamp = ""
                success = False
                error = None
                prev_close = None

                if data and data.get("success"):
                    info = data.get("info", {})
                    realtime = data.get("realtime", {})
                    name = info.get("name", "")
                    timestamp = info.get("time", "")

                    best_bid_price = realtime.get("latest_trade_price", "")
                    if not best_bid_price or best_bid_price == "-":
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

                if price is None:
                    try:
                        s = twstock.Stock(sym)
                        if s and s.close and len(s.close) > 0:
                            price = _safe_float(s.close[-1])
                            if price is not None:
                                success = True
                                error = None
                                if not name and sym in twstock.codes:
                                    name = twstock.codes[sym].name
                    except Exception as ex:
                        if not error:
                            error = f"歷史價格獲取失敗: {str(ex)}"

            metrics = tw_metrics.get(sym, {})
            # 昨收優先順序：TWSE 官方 API > yfinance
            final_prev_close = prev_close if prev_close is not None else metrics.get("prev_close")

            results.append({
                "symbol": sym,
                "name": name,
                "price": price,
                "prev_close": final_prev_close,
                "fifty_two_week_low": metrics.get("fifty_two_week_low"),
                "fifty_two_week_high": metrics.get("fifty_two_week_high"),
                "ma_50": metrics.get("ma_50"),
                "ma_200": metrics.get("ma_200"),
                "pe_ratio": metrics.get("pe_ratio"),
                "dividend_yield": metrics.get("dividend_yield"),
                "beta": metrics.get("beta"),
                "current_ratio": metrics.get("current_ratio"),
                "sparkline_data": metrics.get("sparkline_data"),
                "market": "TW",
                "timestamp": timestamp,
                "success": success,
                **({"error": error} if not success and error else {})
            })

        except Exception as e:
            # 異常 Fallback
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

            metrics = tw_metrics.get(sym, {})
            final_prev_close = prev_close if prev_close is not None else metrics.get("prev_close")

            results.append({
                "symbol": sym,
                "name": name,
                "price": price,
                "prev_close": final_prev_close,
                "fifty_two_week_low": metrics.get("fifty_two_week_low"),
                "fifty_two_week_high": metrics.get("fifty_two_week_high"),
                "ma_50": metrics.get("ma_50"),
                "ma_200": metrics.get("ma_200"),
                "pe_ratio": metrics.get("pe_ratio"),
                "dividend_yield": metrics.get("dividend_yield"),
                "beta": metrics.get("beta"),
                "current_ratio": metrics.get("current_ratio"),
                "sparkline_data": metrics.get("sparkline_data"),
                "market": "TW",
                "timestamp": "",
                "success": price is not None,
                **({"error": str(e)} if price is None else {})
            })

    # --- 美股即時報價與基本面 ---
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
                        fifty_two_week_low = fast.get("yearLow")
                        fifty_two_week_high = fast.get("yearHigh")
                        ma_50 = fast.get("fiftyDayAverage")
                        ma_200 = fast.get("twoHundredDayAverage")

                        pe_ratio = None
                        dividend_yield = None
                        beta = None
                        current_ratio = None
                        sparkline_data = None
                        
                        if fetch_fundamentals:
                            try:
                                inf = ticker.info
                                pe_ratio = inf.get("trailingPE") or inf.get("forwardPE")
                                dividend_yield = inf.get("dividendYield")
                                beta = inf.get("beta")
                                current_ratio = inf.get("currentRatio")
                            except Exception as fe:
                                print(f"取得美股 {sym} 基本面失敗: {fe}")

                            try:
                                hist = ticker.history(period="1mo")
                                if not hist.empty:
                                    prices = list(hist["Close"].round(2))
                                    sparkline_data = ",".join(map(str, prices))
                            except Exception as he:
                                print(f"取得美股 {sym} 走勢圖歷史失敗: {he}")

                        results.append({
                            "symbol": sym.upper(),
                            "name": "",  # fast_info 不含名稱，前端已有快取
                            "price": round(price, 2) if price else None,
                            "prev_close": round(prev_close, 2) if prev_close else None,
                            "fifty_two_week_low": round(fifty_two_week_low, 2) if fifty_two_week_low else None,
                            "fifty_two_week_high": round(fifty_two_week_high, 2) if fifty_two_week_high else None,
                            "ma_50": round(ma_50, 2) if ma_50 else None,
                            "ma_200": round(ma_200, 2) if ma_200 else None,
                            "pe_ratio": round(pe_ratio, 2) if pe_ratio else None,
                            "dividend_yield": round(dividend_yield, 2) if dividend_yield else None,
                            "beta": round(beta, 3) if beta else None,
                            "current_ratio": round(current_ratio, 2) if current_ratio else None,
                            "sparkline_data": sparkline_data,
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

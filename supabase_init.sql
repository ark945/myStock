-- myStock 多人使用與自訂追蹤清單 資料表初始化/遷移 SQL
-- 請在 Supabase Dashboard 的 SQL Editor 中執行以下 SQL

-- =========================================================================
-- 1. 使用者設定檔表 (user_profiles)
-- =========================================================================
CREATE TABLE IF NOT EXISTS user_profiles (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    username TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 啟用 RLS 政策
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service_role" ON user_profiles;
CREATE POLICY "Allow all for service_role" ON user_profiles FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON user_profiles TO service_role;


-- =========================================================================
-- 2. 追蹤清單分類表 (watchlists)
-- =========================================================================
CREATE TABLE IF NOT EXISTS watchlists (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    name TEXT NOT NULL,
    user_id BIGINT REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- 啟用 RLS 政策
ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service_role" ON watchlists;
CREATE POLICY "Allow all for service_role" ON watchlists FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON watchlists TO service_role;


-- =========================================================================
-- 3. 追蹤個股表 (watchlist) - 升級或新建
-- =========================================================================
CREATE TABLE IF NOT EXISTS watchlist (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    watchlist_id BIGINT REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    name TEXT DEFAULT '',
    market TEXT DEFAULT 'TW',
    entry_date TEXT DEFAULT '',
    entry_price NUMERIC(12, 2),
    current_price NUMERIC(12, 2),
    yesterday_close NUMERIC(12, 2),
    fifty_two_week_low NUMERIC(12, 2),
    fifty_two_week_high NUMERIC(12, 2),
    ma_50 NUMERIC(12, 2),
    ma_200 NUMERIC(12, 2),
    pe_ratio NUMERIC(12, 2),
    dividend_yield NUMERIC(12, 2),
    beta NUMERIC(12, 2),
    current_ratio NUMERIC(12, 2),
    target_price NUMERIC(12, 2) DEFAULT 0.00,
    sparkline_data TEXT,
    price_updated_at TIMESTAMP WITH TIME ZONE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    roe NUMERIC(12, 2),
    market_cap NUMERIC(20, 2),
    volume BIGINT,
    revenue_growth NUMERIC(12, 2)
);

-- 啟用 RLS 政策
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service_role" ON watchlist;
CREATE POLICY "Allow all for service_role" ON watchlist FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON watchlist TO service_role;


-- =========================================================================
-- 4. 針對舊版資料庫結構的升級遷移腳本 (若已有 watchlist 表且有 symbol UNIQUE 約束)
-- =========================================================================
DO $$
BEGIN
    -- 1. 移除舊版 watchlist 的單一 symbol 唯一約束
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'watchlist_symbol_key' 
          AND conrelid = 'watchlist'::regclass
    ) THEN
        ALTER TABLE watchlist DROP CONSTRAINT watchlist_symbol_key;
    END IF;

    -- 2. 新增 watchlist_id 外鍵欄位 (如果不存在)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'watchlist' AND column_name = 'watchlist_id'
    ) THEN
        ALTER TABLE watchlist ADD COLUMN watchlist_id BIGINT REFERENCES watchlists(id) ON DELETE CASCADE;
    END IF;

    -- 3. 建立新的複合唯一約束 (確保每張清單內的股票 symbol 唯一)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'watchlist_watchlist_id_symbol_key' 
          AND conrelid = 'watchlist'::regclass
    ) THEN
        ALTER TABLE watchlist ADD CONSTRAINT watchlist_watchlist_id_symbol_key UNIQUE (watchlist_id, symbol);
    END IF;
END $$;

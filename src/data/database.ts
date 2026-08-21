import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * SQLite 데이터베이스 인스턴스 및 스키마 초기화 모듈
 * 네트워크 단절이나 봇 재시작 시에도 포지션 상태와 거래 이력을 100% 보존합니다.
 */
class DatabaseManager {
  private static instance: Database.Database | null = null;

  public static getDatabase(): Database.Database {
    if (!this.instance) {
      const dbDir = path.resolve(process.cwd(), 'data');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      const dbPath = path.join(dbDir, 'trading_bot.db');
      this.instance = new Database(dbPath);
      this.instance.pragma('journal_mode = WAL'); // 고성능 동시성 및 충돌 복구 활성화
      this.initializeSchema(this.instance);
    }
    return this.instance;
  }

  /**
   * 테이블 스키마 자동 마이그레이션
   */
  private static initializeSchema(db: Database.Database): void {
    // 1. 활성 포지션 관리 테이블 (하이브리드 익절 및 손절 추적)
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_positions (
        id TEXT PRIMARY KEY,
        market TEXT NOT NULL,
        entry_price REAL NOT NULL,
        initial_quantity REAL NOT NULL,
        remaining_quantity REAL NOT NULL,
        target_price_1 REAL NOT NULL,
        is_half_closed INTEGER DEFAULT 0,
        highest_price REAL NOT NULL,
        initial_stop_loss_price REAL NOT NULL,
        current_stop_loss_price REAL NOT NULL,
        is_breakeven_active INTEGER DEFAULT 0,
        buy_fee REAL NOT NULL,
        realized_pnl REAL DEFAULT 0,
        entry_time INTEGER NOT NULL
      );
    `);

    // 2. 거래 체결 이력 테이블
    db.exec(`
      CREATE TABLE IF NOT EXISTS trade_history (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        market TEXT NOT NULL,
        side TEXT NOT NULL, -- 'BUY', 'TP1_HALF', 'TP2_TRAILING', 'INITIAL_STOP', 'BREAKEVEN_STOP', 'TIMEOUT_EXIT'
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        fee REAL NOT NULL,
        pnl_krw REAL DEFAULT 0,
        pnl_percent REAL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );
    `);

    // 3. 종목별 쿨다운 관리 테이블
    db.exec(`
      CREATE TABLE IF NOT EXISTS market_cooldown (
        market TEXT PRIMARY KEY,
        cooldown_until INTEGER NOT NULL
      );
    `);

    // 4. 일일 성과 및 수수료 누적 메트릭스 테이블
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_metrics (
        date TEXT PRIMARY KEY,
        trades_count INTEGER DEFAULT 0,
        fees_paid_krw REAL DEFAULT 0,
        gross_pnl_krw REAL DEFAULT 0,
        net_pnl_krw REAL DEFAULT 0,
        win_count INTEGER DEFAULT 0,
        loss_count INTEGER DEFAULT 0
      );
    `);
  }
}

export const db = DatabaseManager.getDatabase();

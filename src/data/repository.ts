import { db } from './database';
import { HybridPosition } from './models';

export interface TradeRecord {
  id: string;
  positionId: string;
  market: string;
  side: string;
  price: number;
  quantity: number;
  fee: number;
  netPnL: number;
  pnlPercent: number;
  timestamp: number;
}

/**
 * 데이터베이스 영속성 계층 (Repository Pattern)
 * 비즈니스 로직과 데이터베이스 쿼리를 완전히 분리하여 유지보수성을 극대화합니다.
 */
export class TradeRepository {
  /**
   * 활성 포지션 전체 조회 (봇 재부팅 시 포지션 복구용)
   */
  public static getAllActivePositions(): HybridPosition[] {
    const rows = db.prepare('SELECT * FROM active_positions').all() as any[];
    return rows.map((row) => ({
      id: row.id,
      market: row.market,
      entryPrice: row.entry_price,
      currentPrice: row.entry_price, // 실시간 시세로 즉시 갱신됨
      initialQuantity: row.initial_quantity,
      remainingQuantity: row.remaining_quantity,
      targetPrice1: row.target_price_1,
      isHalfClosed: Boolean(row.is_half_closed),
      highestPrice: row.highest_price,
      initialStopLossPrice: row.initial_stop_loss_price,
      currentStopLossPrice: row.current_stop_loss_price,
      isBreakevenActive: Boolean(row.is_breakeven_active),
      buyFee: row.buy_fee,
      realizedPnL: row.realized_pnl,
      entryTime: row.entry_time
    }));
  }

  /**
   * 신규 포지션 저장
   */
  public static savePosition(position: HybridPosition): void {
    const stmt = db.prepare(`
      INSERT INTO active_positions (
        id, market, entry_price, initial_quantity, remaining_quantity,
        target_price_1, is_half_closed, highest_price, initial_stop_loss_price,
        current_stop_loss_price, is_breakeven_active, buy_fee, realized_pnl, entry_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      position.id,
      position.market,
      position.entryPrice,
      position.initialQuantity,
      position.remainingQuantity,
      position.targetPrice1,
      position.isHalfClosed ? 1 : 0,
      position.highestPrice,
      position.initialStopLossPrice,
      position.currentStopLossPrice,
      position.isBreakevenActive ? 1 : 0,
      position.buyFee,
      position.realizedPnL,
      position.entryTime
    );
  }

  /**
   * 포지션 상태 업데이트 (1차 익절, 손절선 상향, 최고가 갱신 등)
   */
  public static updatePosition(position: HybridPosition): void {
    const stmt = db.prepare(`
      UPDATE active_positions SET
        remaining_quantity = ?,
        is_half_closed = ?,
        highest_price = ?,
        current_stop_loss_price = ?,
        is_breakeven_active = ?,
        realized_pnl = ?
      WHERE id = ?
    `);

    stmt.run(
      position.remainingQuantity,
      position.isHalfClosed ? 1 : 0,
      position.highestPrice,
      position.currentStopLossPrice,
      position.isBreakevenActive ? 1 : 0,
      position.realizedPnL,
      position.id
    );
  }

  /**
   * 포지션 종료(전량 매도) 시 활성 테이블에서 삭제
   */
  public static removePosition(id: string): void {
    db.prepare('DELETE FROM active_positions WHERE id = ?').run(id);
  }

  /**
   * 거래 체결 이력 기록
   */
  public static recordTrade(
    id: string,
    positionId: string,
    market: string,
    side: string,
    price: number,
    quantity: number,
    fee: number,
    pnlKrw: number = 0,
    pnlPercent: number = 0
  ): void {
    const stmt = db.prepare(`
      INSERT INTO trade_history (
        id, position_id, market, side, price, quantity, fee, pnl_krw, pnl_percent, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, positionId, market, side, price, quantity, fee, pnlKrw, pnlPercent, Date.now());
  }

  /**
   * 당일(오늘 00:00 KST 이후) 체결된 거래 내역 조회
   */
  public static getTodayTrades(): TradeRecord[] {
    const now = new Date();
    const kstMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
    
    const rows = db.prepare('SELECT * FROM trade_history WHERE timestamp >= ?').all(kstMidnight) as any[];
    return rows.map((r) => ({
      id: r.id,
      positionId: r.position_id,
      market: r.market,
      side: r.side,
      price: r.price,
      quantity: r.quantity,
      fee: r.fee,
      netPnL: r.pnl_krw,
      pnlPercent: r.pnl_percent,
      timestamp: r.timestamp
    }));
  }

  /**
   * 종목 쿨다운 조회 (쿨다운 중이면 만료 타임스탬프 반환)
   */
  public static getMarketCooldown(market: string): number | null {
    const row = db.prepare('SELECT cooldown_until FROM market_cooldown WHERE market = ?').get(market) as any;
    return row ? row.cooldown_until : null;
  }

  /**
   * 종목 쿨다운 설정
   */
  public static setMarketCooldown(market: string, cooldownUntil: number): void {
    const stmt = db.prepare(`
      INSERT INTO market_cooldown (market, cooldown_until)
      VALUES (?, ?)
      ON CONFLICT(market) DO UPDATE SET cooldown_until = excluded.cooldown_until
    `);
    stmt.run(market, cooldownUntil);
  }
}

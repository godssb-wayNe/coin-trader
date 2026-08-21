import { HybridPosition } from '../data/models';
import { UpbitClient } from '../api/upbitClient';
import { TradeRepository } from '../data/repository';
import { StopLossManager } from './stopLossManager';
import { TRADING_CONSTANTS } from '../config/constants';
import { Logger } from '../utils/logger';

export type NotifyFunction = (type: 'BUY' | 'TP1_HALF' | 'TP2_TRAILING' | 'STOP_LOSS' | 'BREAKEVEN_STOP' | 'TIMEOUT_EXIT', market: string, price: number, pnlPercent: number) => Promise<void>;

/**
 * 🏆 스마트 매도 엔진 (Smart Dynamic Exit Manager)
 * 1차 저항선(+5.0%) 50% 분할 매도 + 본절 스탑 전환 + 2차 EMA20 추세 추종 트레일링
 */
export class HybridExitManager {
  public static async evaluateAndExecute(
    position: HybridPosition,
    currentPrice: number,
    upbitClient: UpbitClient,
    notify: NotifyFunction
  ): Promise<boolean> {
    position.currentPrice = currentPrice;

    // 1. 최고가 갱신 (트레일링 스탑용)
    if (currentPrice > position.highestPrice) {
      position.highestPrice = currentPrice;
      TradeRepository.updatePosition(position);
    }

    const pnlPercent = Number((((currentPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2));

    // ==========================================
    // [1] 1차 익절: 목표가(+5.0%) 도달 시 50% 분할 매도
    // ==========================================
    if (!position.isHalfClosed && currentPrice >= position.targetPrice1) {
      const sellQty = position.initialQuantity * 0.5;
      await upbitClient.placeSellOrder(position.market, sellQty, currentPrice);

      const realizedProfitKrw = (currentPrice - position.entryPrice) * sellQty;
      position.isHalfClosed = true;
      position.isBreakevenActive = true; // 본절 스탑 활성화
      position.remainingQuantity -= sellQty;
      position.currentStopLossPrice = Math.round(position.entryPrice * 1.001); // 손절가를 진입가(수수료 포함)로 올림
      position.realizedPnL += realizedProfitKrw;

      TradeRepository.updatePosition(position);
      TradeRepository.recordTrade(
        `tp1-${Date.now()}`,
        position.id,
        position.market,
        'TP1_HALF',
        currentPrice,
        sellQty,
        sellQty * currentPrice * TRADING_CONSTANTS.UPBIT_FEE_RATE,
        realizedProfitKrw,
        pnlPercent
      );

      Logger.success(`[1차 익절 완료] ${position.market} 50% 매도 @ ${currentPrice.toLocaleString()}원 (+${pnlPercent}%)`);
      await notify('TP1_HALF', position.market, currentPrice, pnlPercent);
      return false; // 잔여 물량 유지
    }

    // ==========================================
    // [2] 2차 트레일링 익절: 고점 대비 -2.5% 하락 시 잔량 전량 익절
    // ==========================================
    if (position.isHalfClosed) {
      const dropFromHighPercent = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
      if (dropFromHighPercent >= TRADING_CONSTANTS.TRAILING_STOP_TRIGGER_DROP_PERCENT || currentPrice <= position.currentStopLossPrice) {
        await upbitClient.placeSellOrder(position.market, position.remainingQuantity, currentPrice);

        const realizedProfitKrw = (currentPrice - position.entryPrice) * position.remainingQuantity;
        TradeRepository.recordTrade(
          `tp2-${Date.now()}`,
          position.id,
          position.market,
          'TP2_TRAILING',
          currentPrice,
          position.remainingQuantity,
          position.remainingQuantity * currentPrice * TRADING_CONSTANTS.UPBIT_FEE_RATE,
          realizedProfitKrw,
          pnlPercent
        );
        TradeRepository.removePosition(position.id);

        Logger.success(`[2차 트레일링 익절 완료] ${position.market} 전량 매도 @ ${currentPrice.toLocaleString()}원 (+${pnlPercent}%)`);
        await notify('TP2_TRAILING', position.market, currentPrice, pnlPercent);
        return true; // 포지션 완전 종료
      }
    }

    // ==========================================
    // [3] 손절 검사 (초기 손절, 본절 스탑, 타임아웃)
    // ==========================================
    const stopDecision = StopLossManager.evaluate(position, currentPrice);
    if (stopDecision.shouldExit) {
      await upbitClient.placeSellOrder(position.market, position.remainingQuantity, currentPrice);

      const realizedLossKrw = (currentPrice - position.entryPrice) * position.remainingQuantity;
      TradeRepository.recordTrade(
        `sl-${Date.now()}`,
        position.id,
        position.market,
        stopDecision.exitType,
        currentPrice,
        position.remainingQuantity,
        position.remainingQuantity * currentPrice * TRADING_CONSTANTS.UPBIT_FEE_RATE,
        realizedLossKrw,
        pnlPercent
      );
      TradeRepository.removePosition(position.id);

      Logger.warn(`[포지션 청산] ${position.market} 사유: ${stopDecision.reason}`);
      await notify(stopDecision.exitType as any, position.market, currentPrice, pnlPercent);
      return true; // 포지션 완전 종료
    }

    return false;
  }
}

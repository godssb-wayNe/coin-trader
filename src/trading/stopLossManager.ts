import { HybridPosition } from '../data/models';
import { TRADING_CONSTANTS } from '../config/constants';

export interface StopLossDecision {
  shouldExit: boolean;
  exitType: 'INITIAL_STOP' | 'BREAKEVEN_STOP' | 'TIMEOUT_EXIT' | 'NONE';
  reason: string;
}

/**
 * 4단계 입체 손절 관리자 (Stop-Loss Manager)
 */
export class StopLossManager {
  /**
   * 실시간 현재가에 따른 손절 트리거 판별
   */
  public static evaluate(position: HybridPosition, currentPrice: number): StopLossDecision {
    const now = Date.now();

    // [2단계] 본절 스탑 (1차 익절 완료 후 활성화)
    if (position.isHalfClosed && position.isBreakevenActive) {
      // 본전 기준가 = 진입가 + 왕복 수수료(0.1%)
      const breakEvenPrice = Math.round(position.entryPrice * 1.001);
      if (currentPrice <= breakEvenPrice) {
        return {
          shouldExit: true,
          exitType: 'BREAKEVEN_STOP',
          reason: '🛡️ [2단계 본절 스탑] 진입가 도달로 잔량 안전 청산 (원금 손실 0원)'
        };
      }
    }

    // [1단계] 초기 지지선 이탈 손절 (1차 익절 전)
    if (!position.isHalfClosed && currentPrice <= position.currentStopLossPrice) {
      const lossRate = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      return {
        shouldExit: true,
        exitType: 'INITIAL_STOP',
        reason: `🛑 [1단계 초기 손절] 지지선 이탈 손실률: ${lossRate.toFixed(2)}%`
      };
    }

    // [3단계] 6시간 타임아웃 미반응 횡보 (Dead Trade Exit)
    const holdingTimeMs = now - position.entryTime;
    if (holdingTimeMs >= TRADING_CONSTANTS.DEAD_TRADE_TIMEOUT_MS && !position.isHalfClosed) {
      const pnlRate = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      // ±0.5% 내에서 지지부진하게 갇혀있는 경우 자금 회수
      if (Math.abs(pnlRate) <= 0.5) {
        return {
          shouldExit: true,
          exitType: 'TIMEOUT_EXIT',
          reason: `⏳ [3단계 타임아웃] 6시간 동안 횡보로 본전 부근(${pnlRate.toFixed(2)}%) 자금 회수`
        };
      }
    }

    return {
      shouldExit: false,
      exitType: 'NONE',
      reason: '포지션 정상 유지 중'
    };
  }
}

import { UpbitClient } from '../api/upbitClient';
import { IndicatorCalculator } from './indicators';
import { Logger } from '../utils/logger';

export interface MacroCheckResult {
  allowAltTrading: boolean;
  btcPrice: number;
  btc20Ema: number;
  reason: string;
}

/**
 * 비트코인 거시 시장 상황 감시자 (Macro Market Filter)
 * 비트코인이 20 EMA 하회 중이거나 급락 중일 때 알트코인 매수 신호를 전면 차단합니다.
 */
export class MacroFilter {
  /**
   * 비트코인 1시간봉 기준 거시 건전성 평가
   */
  public static async evaluateBtcMarket(upbitClient: UpbitClient): Promise<MacroCheckResult> {
    try {
      const btcCandles = await upbitClient.getMinuteCandles('KRW-BTC', 60, 50);
      if (btcCandles.length < 20) {
        return { allowAltTrading: true, btcPrice: 0, btc20Ema: 0, reason: 'BTC 캔들 데이터 부족으로 기본 허용' };
      }

      const latestCandle = btcCandles[btcCandles.length - 1];
      const prevCandle = btcCandles[btcCandles.length - 2];
      const closes = btcCandles.map((c) => c.tradePrice);
      const btc20Ema = IndicatorCalculator.calculateEMA(closes, 20);

      // 1. 1시간 내 2.0% 이상 급락 여부 감지
      const dropRate1h = ((latestCandle.tradePrice - prevCandle.openingPrice) / prevCandle.openingPrice) * 100;
      if (dropRate1h <= -2.0) {
        return {
          allowAltTrading: false,
          btcPrice: latestCandle.tradePrice,
          btc20Ema,
          reason: `[위험] BTC 1시간 급락 발생 (${dropRate1h.toFixed(2)}%) - 알트 매수 차단`
        };
      }

      // 2. 비트코인 종가가 20 EMA 아래에 위치하는 하락 추세 감지
      if (latestCandle.tradePrice < btc20Ema) {
        return {
          allowAltTrading: false,
          btcPrice: latestCandle.tradePrice,
          btc20Ema,
          reason: `[하락장] BTC 가격(${latestCandle.tradePrice.toLocaleString()}원)이 20 EMA(${btc20Ema.toLocaleString()}원) 하회 중`
        };
      }

      return {
        allowAltTrading: true,
        btcPrice: latestCandle.tradePrice,
        btc20Ema,
        reason: 'BTC 20 EMA 상회 중 (상승/안정장)'
      };
    } catch (err) {
      Logger.error('[MacroFilter] BTC 거시 환경 조회 실패', err);
      return { allowAltTrading: true, btcPrice: 0, btc20Ema: 0, reason: '조회 실패로 기본 허용' };
    }
  }
}

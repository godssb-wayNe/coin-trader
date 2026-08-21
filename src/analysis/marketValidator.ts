import { UpbitClient } from '../api/upbitClient';
import { TRADING_CONSTANTS } from '../config/constants';
import { Logger } from '../utils/logger';

export interface MarketValidationResult {
  isValid: boolean;
  reason: string;
}

/**
 * 종목 유효성 및 호가창 유동성 검증기
 * 엽전주/작전주 및 유의종목에 잘못 진입하여 발생하는 슬리피지/상폐 위험을 차단합니다.
 */
export class MarketValidator {
  /**
   * 종목의 유의종목 여부, 호가창 두께, 스프레드 검증
   */
  public static async validateMarket(
    market: string,
    isWarning: boolean,
    upbitClient: UpbitClient
  ): Promise<MarketValidationResult> {
    // 1. 유의종목(CAUTION) 즉시 배제
    if (isWarning) {
      return { isValid: false, reason: '업비트 투자유의 종목 지정 코인 (제외)' };
    }

    try {
      // 2. 호가창(Orderbook) 유동성 검증
      const orderbook = await upbitClient.getOrderbook(market);
      if (!orderbook.orderbookUnits || orderbook.orderbookUnits.length === 0) {
        return { isValid: false, reason: '호가창 데이터 없음' };
      }

      const top5Units = orderbook.orderbookUnits.slice(0, 5);
      const totalBidKrw = top5Units.reduce((sum, u) => sum + u.bidPrice * u.bidSize, 0);
      const totalAskKrw = top5Units.reduce((sum, u) => sum + u.askPrice * u.askSize, 0);

      // 상위 5호가 내 매수/매도 총액이 각각 최소 기준(3,000만원) 이상이어야 함
      if (totalBidKrw < TRADING_CONSTANTS.MIN_ORDERBOOK_DEPTH_KRW || totalAskKrw < TRADING_CONSTANTS.MIN_ORDERBOOK_DEPTH_KRW) {
        return {
          isValid: false,
          reason: `호가창 잔량 부족 (매수잔량: ${Math.round(totalBidKrw / 10000)}만, 매도잔량: ${Math.round(totalAskKrw / 10000)}만)`
        };
      }

      // 3. 1호가 스프레드(매도1호가 - 매수1호가) 비율 검증
      const bestAsk = orderbook.orderbookUnits[0].askPrice;
      const bestBid = orderbook.orderbookUnits[0].bidPrice;
      const spreadPercent = ((bestAsk - bestBid) / bestBid) * 100;

      if (spreadPercent > TRADING_CONSTANTS.MAX_SPREAD_PERCENT) {
        return {
          isValid: false,
          reason: `호가 스프레드 과다 (${spreadPercent.toFixed(2)}% > 기준 ${TRADING_CONSTANTS.MAX_SPREAD_PERCENT}%)`
        };
      }

      return { isValid: true, reason: '유동성 및 호가 스프레드 양호' };
    } catch (err) {
      Logger.error(`[MarketValidator] ${market} 호가 검증 에러`, err);
      return { isValid: false, reason: '호가 검증 중 API 통신 에러' };
    }
  }
}

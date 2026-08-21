import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';
import { TRADING_CONSTANTS } from './config/constants';

interface BacktestTrade {
  market: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  type: 'TP1_HALF' | 'TP2_TRAILING' | 'INITIAL_STOP';
  grossPnLPercent: number;
  netPnLKrw: number;
  feePaidKrw: number;
}

interface BacktestPosition {
  id: string;
  market: string;
  entryTime: number;
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  targetPrice1: number;
  isHalfClosed: boolean;
  highestPrice: number;
  initialStopLossPrice: number;
  currentStopLossPrice: number;
  isBreakevenActive: boolean;
  investedAmountKrw: number;
}

/**
 * 1. 기본 설정 (단기 파동형: TP1 +2.3%, SL -1.3%, Trailing -1.5%)
 * 2. 추세 최적화 설정 (중기 추세추종형: TP1 +5.0%, SL -2.5%, Trailing -3.5%)
 * 두 가지 전략을 9년치(3,253일) 데이터에 동시 비교 테스트
 */
export class LongTermComparisonBacktester {
  public async runComparison(markets: string[]): Promise<void> {
    console.log(`\n======================================================`);
    console.log(`📊 [업비트 전체 역사(약 9년) 전략 비교 백테스트 가동]`);
    console.log(`======================================================`);

    const marketCandlesMap = new Map<string, Candle[]>();
    for (const m of markets) {
      const candles = await this.fetchCandles(m, 3650);
      marketCandlesMap.set(m, candles);
    }

    console.log('\n▶ [전략 A] 기본 방어형 (1차 익절 +2.3%, 손절 -1.3%, 트레일링 -1.5%)');
    this.executeBacktest(markets, marketCandlesMap, 2.3, 1.3, 1.5, '전략 A (원금 방어형)');

    console.log('\n▶ [전략 B] 중기 추세추종형 (1차 익절 +5.0%, 손절 -2.5%, 트레일링 -3.5%)');
    this.executeBacktest(markets, marketCandlesMap, 5.0, 2.5, 3.5, '전략 B (추세 극대화형)');
  }

  private async fetchCandles(market: string, maxDays: number): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let to = '';
    while (allCandles.length < maxDays) {
      const fetchCount = Math.min(200, maxDays - allCandles.length);
      const url = `https://api.upbit.com/v1/candles/days?market=${market}&count=${fetchCount}${to ? `&to=${to}` : ''}`;
      try {
        const response = await axios.get(url);
        const data = response.data;
        if (!data || data.length === 0) break;
        for (const c of data) {
          allCandles.push({
            market: c.market,
            candleDateTimeUtc: c.candle_date_time_utc,
            candleDateTimeKst: c.candle_date_time_kst,
            openingPrice: c.opening_price,
            highPrice: c.high_price,
            lowPrice: c.low_price,
            tradePrice: c.trade_price,
            timestamp: c.timestamp,
            candleAccTradeVolume: c.candle_acc_trade_volume,
            candleAccTradePrice: c.candle_acc_trade_price
          });
        }
        to = data[data.length - 1].candle_date_time_utc;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err) {
        break;
      }
    }
    return allCandles.reverse();
  }

  private executeBacktest(
    markets: string[],
    marketCandlesMap: Map<string, Candle[]>,
    tp1Percent: number,
    slPercent: number,
    trailingPercent: number,
    label: string
  ): void {
    let cash = 1000000;
    const initialCapital = 1000000;
    const trades: BacktestTrade[] = [];
    const positions: BacktestPosition[] = [];
    let peakCapital = 1000000;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();

    const btcCandles = marketCandlesMap.get('KRW-BTC') || [];

    for (let i = 30; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);

      // 포지션 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = marketCandlesMap.get(pos.market);
        const candle = candleList?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candle) continue;

        const { highPrice, lowPrice } = candle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        // 1차 익절
        if (!pos.isHalfClosed && highPrice >= pos.targetPrice1) {
          const sellPrice = pos.targetPrice1;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.isBreakevenActive = true;
          pos.remainingQuantity -= sellQty;
          pos.currentStopLossPrice = pos.entryPrice;

          trades.push({
            market: pos.market,
            entryTime: '',
            exitTime: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice: sellPrice,
            type: 'TP1_HALF',
            grossPnLPercent: tp1Percent,
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });
        }

        // 2차 트레일링 익절
        if (pos.isHalfClosed) {
          const trailingPrice = pos.highestPrice * (1 - trailingPercent / 100);
          if (lowPrice <= trailingPrice || lowPrice <= pos.currentStopLossPrice) {
            const exitPrice = Math.max(trailingPrice, pos.currentStopLossPrice);
            const sellQty = pos.remainingQuantity;
            const fee = exitPrice * sellQty * 0.001;
            const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;

            cash += (exitPrice * sellQty) - fee;
            cooldowns.set(pos.market, candle.timestamp + 24 * 60 * 60 * 1000);

            trades.push({
              market: pos.market,
              entryTime: '',
              exitTime: currentDate,
              exitPrice,
              entryPrice: pos.entryPrice,
              type: 'TP2_TRAILING',
              grossPnLPercent: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
              netPnLKrw: Math.round(netProfit),
              feePaidKrw: Math.round(fee)
            });

            positions.splice(p, 1);
            continue;
          }
        }

        // 초기 손절
        if (!pos.isHalfClosed && lowPrice <= pos.initialStopLossPrice) {
          const exitPrice = pos.initialStopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;

          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, candle.timestamp + 24 * 60 * 60 * 1000);

          trades.push({
            market: pos.market,
            entryTime: '',
            exitTime: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice,
            type: 'INITIAL_STOP',
            grossPnLPercent: -slPercent,
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });

          positions.splice(p, 1);
          continue;
        }
      }

      // 자본금 추적
      let currentCap = cash;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        currentCap += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (currentCap > peakCapital) peakCapital = currentCap;
      const dd = ((peakCapital - currentCap) / peakCapital) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      // 매수 진입 (복리 10%)
      const investAmount = Math.max(100000, Math.floor(currentCap * 0.1));
      for (const m of markets) {
        if (positions.length >= 3 || cash < investAmount) break;
        if (positions.some((p) => p.market === m)) continue;

        const candleList = marketCandlesMap.get(m);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 30) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (cooldowns.get(m) || 0)) continue;

        const indicators = IndicatorCalculator.calculateAll(candleList!.slice(0, candleIndex + 1));
        const { rsi14, macd, bollingerBands, ema5, ema20 } = indicators;

        let score = 0;
        if (rsi14 >= 30 && rsi14 <= 48) score += 25;
        if (macd.histogram > 0 || macd.macd > macd.signal) score += 25;
        if (currentCandle.lowPrice <= bollingerBands.lower * 1.01 && currentCandle.tradePrice > currentCandle.openingPrice) score += 25;
        if (ema5 > ema20) score += 25;

        if (score >= 70) {
          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          cash -= investAmount;

          positions.push({
            id: `${m}-${Date.now()}`,
            market: m,
            entryTime: currentCandle.timestamp,
            entryPrice: currentCandle.tradePrice,
            initialQuantity: volume,
            remainingQuantity: volume,
            targetPrice1: Math.round(currentCandle.tradePrice * (1 + tp1Percent / 100)),
            isHalfClosed: false,
            highestPrice: currentCandle.tradePrice,
            initialStopLossPrice: Math.round(currentCandle.tradePrice * (1 - slPercent / 100)),
            currentStopLossPrice: Math.round(currentCandle.tradePrice * (1 - slPercent / 100)),
            isBreakevenActive: false,
            investedAmountKrw: investAmount
          });
        }
      }
    }

    // 최종 자산 계산
    const lastDate = btcCandles[btcCandles.length - 1].candleDateTimeKst.substring(0, 10);
    let finalCapital = cash;
    for (const pos of positions) {
      const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    const winTrades = trades.filter((t) => t.netPnLKrw > 0);
    const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100;
    const winRate = (winTrades.length / trades.length) * 100;
    const totalFees = trades.reduce((sum, t) => sum + t.feePaidKrw, 0);

    console.log(`------------------------------------------------------`);
    console.log(`[${label} 결과 요약]`);
    console.log(`• 시작 자본금:    ${initialCapital.toLocaleString()} KRW`);
    console.log(`• 최종 평가자산:  ${Math.round(finalCapital).toLocaleString()} KRW`);
    console.log(`• 누적 수익률:    ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}% (${Math.round(finalCapital - initialCapital).toLocaleString()} KRW)`);
    console.log(`• 최대 낙폭(MDD): -${maxDrawdown.toFixed(2)}%`);
    console.log(`• 총 체결 횟수:   ${trades.length}회 (승률: ${winRate.toFixed(2)}%)`);
    console.log(`• 지불 총 수수료: ${Math.round(totalFees).toLocaleString()} KRW`);
    console.log(`------------------------------------------------------`);
  }
}

async function main() {
  const runner = new LongTermComparisonBacktester();
  await runner.runComparison(['KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
}

main().catch(console.error);

import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';
import { TRADING_CONSTANTS } from './config/constants';

interface SimulationResult {
  mode: '단리 (고정 2만원 매수)' | '진짜 복리 (가용현금 전액 비례 재투자)';
  initialCapital: number;
  finalCapital: number;
  netProfit: number;
  returnPercent: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
}

/**
 * 🔬 [단리 vs 복리 정밀 비교 검증 엔진]
 */
export class TrueCompoundComparator {
  public async fetchAllUpbitCandles(market: string): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let toDateStr = '';

    for (let loop = 0; loop < 18; loop++) {
      const url = 'https://api.upbit.com/v1/candles/days';
      const params: any = { market, count: 200 };
      if (toDateStr) params.to = toDateStr;

      try {
        const response = await axios.get(url, { params });
        const data = response.data;
        if (!data || data.length === 0) break;

        const chunk: Candle[] = data.map((c: any) => ({
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
        }));

        allCandles.unshift(...chunk.reverse());
        const oldest = data[data.length - 1].candle_date_time_utc;
        const oldestDate = new Date(oldest);
        toDateStr = new Date(oldestDate.getTime() - 1000).toISOString().replace('.000Z', 'Z');
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err) {
        break;
      }
    }

    const uniqueMap = new Map<number, Candle>();
    allCandles.forEach((c) => uniqueMap.set(c.timestamp, c));
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  public async runComparison(): Promise<void> {
    const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-SOL'];
    const marketCandlesMap = new Map<string, Candle[]>();
    for (const s of symbols) {
      const candles = await this.fetchAllUpbitCandles(s);
      marketCandlesMap.set(s, candles);
    }

    const btcCandles = marketCandlesMap.get('KRW-BTC') || [];

    // 1. 단리 시뮬레이션 (고정 2만 원)
    const fixedResult = this.simulate(symbols, marketCandlesMap, btcCandles, false);

    // 2. 진짜 복리 시뮬레이션 (현재 계좌 가용 자산의 1/N을 100% 꽉 채워 재투자)
    const compoundResult = this.simulate(symbols, marketCandlesMap, btcCandles, true);

    console.log('\n======================================================');
    console.log(`📊 [업비트 10년치 실데이터: 단리(고정투자) vs 복리(전액재투자) 비교]`);
    console.log('======================================================');
    console.log(`구분                     단리 (고정 20,000원)      진짜 복리 (잔고 100% 비례 재투자)`);
    console.log('------------------------------------------------------');
    console.log(`• 시작 원금              ${fixedResult.initialCapital.toLocaleString()}원                 ${compoundResult.initialCapital.toLocaleString()}원`);
    console.log(`• 최종 평가자산          ${Math.round(fixedResult.finalCapital).toLocaleString()}원                 ${Math.round(compoundResult.finalCapital).toLocaleString()}원 🌟`);
    console.log(`• 누적 순손익            +${Math.round(fixedResult.netProfit).toLocaleString()}원 (+${fixedResult.returnPercent.toFixed(2)}%)      +${Math.round(compoundResult.netProfit).toLocaleString()}원 (+${compoundResult.returnPercent.toFixed(2)}%) 🚀`);
    console.log(`• 최대 낙폭(MDD)         -${fixedResult.maxDrawdown.toFixed(2)}%                  -${compoundResult.maxDrawdown.toFixed(2)}%`);
    console.log(`• 총 체결 횟수           ${fixedResult.totalTrades}회                    ${compoundResult.totalTrades}회`);
    console.log('======================================================\n');
  }

  private simulate(
    symbols: string[],
    marketCandlesMap: Map<string, Candle[]>,
    btcCandles: Candle[],
    isCompound: boolean
  ): SimulationResult {
    const initialCapital = 100000;
    let cash = 100000;
    const maxPositions = 5;
    const trades: any[] = [];
    let peakCapital = 100000;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();
    const positions: any[] = [];

    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const isBtcBullMarket = btcCandles[i].tradePrice > btc200Ema;

      // 매도 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = marketCandlesMap.get(pos.market);
        if (!candleList) continue;

        const candleIndex = candleList.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (candleIndex < 0) continue;

        const currentCandle = candleList[candleIndex];
        const { highPrice, lowPrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, candleIndex + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        // 1차 익절 (+8.0% 확대)
        const gainPercent = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (!pos.isHalfClosed && gainPercent >= 8.0) {
          const sellPrice = pos.entryPrice * 1.08;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001;

          trades.push({ netProfit });
        }

        // 2차 익절 (EMA20 이탈 시 잔량 매도)
        if (pos.isHalfClosed) {
          if (lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
            const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
            const sellQty = pos.remainingQuantity;
            const fee = exitPrice * sellQty * 0.001;
            const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;

            cash += (exitPrice * sellQty) - fee;
            cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
            trades.push({ netProfit });
            positions.splice(p, 1);
            continue;
          }
        }

        // 손절 (-2.0%)
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;

          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          trades.push({ netProfit });
          positions.splice(p, 1);
          continue;
        }
      }

      // 총자산 계산
      let currentEquity = cash;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        currentEquity += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (currentEquity > peakCapital) peakCapital = currentEquity;
      const dd = ((peakCapital - currentEquity) / peakCapital) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      // 신규 매수
      if (!isBtcBullMarket) continue;

      let investAmount = 20000;
      if (isCompound) {
        // 복리: 현재 총자산 / 5개 슬롯 (남은 현금 95% 한도)
        investAmount = Math.min(Math.floor(currentEquity / maxPositions), Math.floor(cash * 0.95));
      }

      if (investAmount < 5000) continue;

      for (const s of symbols) {
        if (positions.length >= maxPositions || cash < investAmount) break;
        if (positions.some((p) => p.market === s)) continue;

        const candleList = marketCandlesMap.get(s);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 60) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, candleIndex + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          cash -= investAmount;

          positions.push({
            id: `${s}-${Date.now()}`,
            market: s,
            entryTime: currentCandle.timestamp,
            entryDate: currentDate,
            entryPrice: currentCandle.tradePrice,
            initialQuantity: volume,
            remainingQuantity: volume,
            isHalfClosed: false,
            highestPrice: currentCandle.tradePrice,
            stopLossPrice: currentCandle.tradePrice * 0.98,
            investedAmountKrw: investAmount
          });
        }
      }
    }

    const lastDate = btcCandles[btcCandles.length - 1].candleDateTimeKst.substring(0, 10);
    let finalCapital = cash;
    for (const pos of positions) {
      const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    const netProfit = finalCapital - initialCapital;
    const returnPercent = (netProfit / initialCapital) * 100;
    const winTrades = trades.filter((t) => t.netProfit > 0);

    return {
      mode: isCompound ? '진짜 복리 (가용현금 전액 비례 재투자)' : '단리 (고정 2만원 매수)',
      initialCapital,
      finalCapital,
      netProfit,
      returnPercent,
      maxDrawdown,
      totalTrades: trades.length,
      winRate: (winTrades.length / trades.length) * 100
    };
  }
}

async function main() {
  const comp = new TrueCompoundComparator();
  await comp.runComparison();
}

main().catch(console.error);

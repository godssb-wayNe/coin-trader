import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

/**
 * 🚀 3슬롯 집중 복리 vs 5슬롯 분산 복리 비교
 */
export class SlotCompoundingTest {
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
        toDateStr = new Date(new Date(oldest).getTime() - 1000).toISOString().replace('.000Z', 'Z');
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err) {
        break;
      }
    }
    const uniqueMap = new Map<number, Candle>();
    allCandles.forEach((c) => uniqueMap.set(c.timestamp, c));
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  public async run(): Promise<void> {
    const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-SOL'];
    const marketCandlesMap = new Map<string, Candle[]>();
    for (const s of symbols) {
      const candles = await this.fetchAllUpbitCandles(s);
      marketCandlesMap.set(s, candles);
    }
    const btcCandles = marketCandlesMap.get('KRW-BTC') || [];

    // 1. 5슬롯 분산 복리 (종목당 20%)
    const r5 = this.simulate(symbols, marketCandlesMap, btcCandles, 5);

    // 2. 3슬롯 집중 복리 (종목당 33.3% ➔ 복리 회전율 극대화)
    const r3 = this.simulate(symbols, marketCandlesMap, btcCandles, 3);

    console.log('\n======================================================');
    console.log(`💥 [슬롯 수(포트폴리오 집중도)에 따른 복리 폭발력 비교]`);
    console.log('======================================================');
    console.log(`구분                     5종목 분산 (종목당 20%)    3종목 집중 (종목당 33% 복리 극대화)`);
    console.log('------------------------------------------------------');
    console.log(`• 시작 원금              100,000원                 100,000원`);
    console.log(`• 최종 평가자산          ${Math.round(r5.finalCapital).toLocaleString()}원                 ${Math.round(r3.finalCapital).toLocaleString()}원 🚀`);
    console.log(`• 누적 순손익            +${Math.round(r5.netProfit).toLocaleString()}원 (+${r5.returnPercent.toFixed(2)}%)      +${Math.round(r3.netProfit).toLocaleString()}원 (+${r3.returnPercent.toFixed(2)}%) 🌟`);
    console.log(`• 최대 낙폭(MDD)         -${r5.maxDrawdown.toFixed(2)}%                  -${r3.maxDrawdown.toFixed(2)}%`);
    console.log('======================================================\n');
  }

  private simulate(symbols: string[], map: Map<string, Candle[]>, btcCandles: Candle[], maxPositions: number) {
    let cash = 100000;
    let peak = 100000;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();
    const positions: any[] = [];

    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const isBtcBull = btcCandles[i].tradePrice > btc200Ema;

      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = map.get(pos.market);
        if (!candleList) continue;
        const cIdx = candleList.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (cIdx < 0) continue;
        const currentCandle = candleList[cIdx];
        const { highPrice, lowPrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, cIdx + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        if (!pos.isHalfClosed && ((highPrice - pos.entryPrice) / pos.entryPrice) * 100 >= 8.0) {
          const sellPrice = pos.entryPrice * 1.08;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001;
        }

        if (pos.isHalfClosed && lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
          const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          continue;
        }

        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          continue;
        }
      }

      let equity = cash;
      for (const pos of positions) {
        const candle = map.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        equity += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (!isBtcBull) continue;

      const investAmount = Math.min(Math.floor(equity / maxPositions), Math.floor(cash * 0.95));
      if (investAmount < 5000) continue;

      for (const s of symbols) {
        if (positions.length >= maxPositions || cash < investAmount) break;
        if (positions.some((p) => p.market === s)) continue;

        const candleList = map.get(s);
        const cIdx = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!cIdx || cIdx < 60) continue;

        const currentCandle = candleList![cIdx];
        if (currentCandle.timestamp < (cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, cIdx + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          cash -= investAmount;

          positions.push({
            id: `${s}-${Date.now()}`,
            market: s,
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
      const candle = map.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    return {
      finalCapital,
      netProfit: finalCapital - 100000,
      returnPercent: ((finalCapital - 100000) / 100000) * 100,
      maxDrawdown
    };
  }
}

async function main() {
  const t = new SlotCompoundingTest();
  await t.run();
}

main().catch(console.error);

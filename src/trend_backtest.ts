import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

interface BacktestTrade {
  market: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  type: 'TREND_TP1' | 'RUNNER_TP2' | 'STOP_LOSS';
  pnlPercent: number;
  netPnLKrw: number;
  feePaidKrw: number;
}

interface TrendPosition {
  id: string;
  market: string;
  entryTime: number;
  entryDate: string;
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  isHalfClosed: boolean;
  highestPrice: number;
  stopLossPrice: number;
  investedAmountKrw: number;
}

/**
 * 🏆 대세 상승장 필터(BTC 200 EMA) + 비대칭 손익비 추세추종 매도 전략
 */
export class TrendFollowingBacktester {
  private initialCapital = 1000000;
  private cash = 1000000;
  private maxPositions = 3;
  private trades: BacktestTrade[] = [];
  private peakCapital = 1000000;
  private maxDrawdown = 0;
  private cooldowns = new Map<string, number>();

  public async run(markets: string[]): Promise<void> {
    const marketCandlesMap = new Map<string, Candle[]>();
    for (const m of markets) {
      const candles = await this.fetchCandles(m, 3650);
      marketCandlesMap.set(m, candles);
    }

    const btcCandles = marketCandlesMap.get('KRW-BTC') || [];
    const positions: TrendPosition[] = [];

    // 200일선 계산을 위해 200일 이후부터 시뮬레이션 시작
    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);

      // 1. 비트코인 200 EMA (대세 상승장 판별선)
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const isBtcBullMarket = btcCandles[i].tradePrice > btc200Ema;

      // 2. 보유 포지션 매도 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = marketCandlesMap.get(pos.market);
        if (!candleList) continue;

        const candleIndex = candleList.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (candleIndex < 0) continue;

        const currentCandle = candleList[candleIndex];
        const { highPrice, lowPrice, tradePrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, candleIndex + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        // [익절 1] +8.0% 도달 시 50% 분할 익절 + 손절가를 진입가(본절)로 상향
        const gainPercent = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (!pos.isHalfClosed && gainPercent >= 8.0) {
          const sellPrice = pos.entryPrice * 1.08;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          this.cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.002; // 본절 스탑

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice: sellPrice,
            type: 'TREND_TP1',
            pnlPercent: 8.0,
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });
        }

        // [익절 2] 잔여 50% 물량: EMA20선 하향 이탈 시 전량 매도 (추세 끝까지 홀딩)
        if (pos.isHalfClosed) {
          if (lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
            const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
            const sellQty = pos.remainingQuantity;
            const fee = exitPrice * sellQty * 0.001;
            const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;
            const pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

            this.cash += (exitPrice * sellQty) - fee;
            this.cooldowns.set(pos.market, currentCandle.timestamp + 24 * 60 * 60 * 1000);

            this.trades.push({
              market: pos.market,
              entryDate: pos.entryDate,
              exitDate: currentDate,
              entryPrice: pos.entryPrice,
              exitPrice,
              type: 'RUNNER_TP2',
              pnlPercent: Number(pnlPercent.toFixed(2)),
              netPnLKrw: Math.round(netProfit),
              feePaidKrw: Math.round(fee)
            });

            positions.splice(p, 1);
            continue;
          }
        }

        // [손절] 1차 익절 전 -3.0% 지지선 손절
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;
          const pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

          this.cash += (exitPrice * sellQty) - fee;
          this.cooldowns.set(pos.market, currentCandle.timestamp + 24 * 60 * 60 * 1000);

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice,
            type: 'STOP_LOSS',
            pnlPercent: Number(pnlPercent.toFixed(2)),
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });

          positions.splice(p, 1);
          continue;
        }
      }

      // 3. 자본금 및 MDD 계산
      let currentCap = this.cash;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        currentCap += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (currentCap > this.peakCapital) this.peakCapital = currentCap;
      const dd = ((this.peakCapital - currentCap) / this.peakCapital) * 100;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;

      // 4. 신규 매수 진입 (대세 상승장 + 골든크로스 시에만 진입)
      if (!isBtcBullMarket) continue; // 하락장(BTC < 200 EMA) 시 100% 현금 관망

      const investAmount = Math.max(100000, Math.floor(currentCap * 0.2)); // 20% 분할 투자

      for (const m of markets) {
        if (positions.length >= this.maxPositions || this.cash < investAmount) break;
        if (positions.some((p) => p.market === m)) continue;

        const candleList = marketCandlesMap.get(m);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 60) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (this.cooldowns.get(m) || 0)) continue;

        const historical = candleList!.slice(0, candleIndex + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        // 정배열 골든크로스 눌림목 매수 (EMA20 > EMA60 및 RSI 40~55)
        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          this.cash -= investAmount;

          positions.push({
            id: `${m}-${Date.now()}`,
            market: m,
            entryTime: currentCandle.timestamp,
            entryDate: currentDate,
            entryPrice: currentCandle.tradePrice,
            initialQuantity: volume,
            remainingQuantity: volume,
            isHalfClosed: false,
            highestPrice: currentCandle.tradePrice,
            stopLossPrice: Math.round(currentCandle.tradePrice * 0.97), // -3% 손절
            investedAmountKrw: investAmount
          });
        }
      }
    }

    // 최종 결과 출력
    const lastDate = btcCandles[btcCandles.length - 1].candleDateTimeKst.substring(0, 10);
    let finalCapital = this.cash;
    for (const pos of positions) {
      const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    this.printReport(finalCapital, markets, btcCandles.length);
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

  private printReport(finalCapital: number, markets: string[], totalDays: number): void {
    const totalProfitKrw = finalCapital - this.initialCapital;
    const totalReturnPercent = ((finalCapital - this.initialCapital) / this.initialCapital) * 100;
    const winTrades = this.trades.filter((t) => t.netPnLKrw > 0);
    const lossTrades = this.trades.filter((t) => t.netPnLKrw <= 0);
    const winRate = (winTrades.length / this.trades.length) * 100;
    const totalFees = this.trades.reduce((sum, t) => sum + t.feePaidKrw, 0);

    console.log('\n======================================================');
    console.log(`🚀 [BTC 200일선 추세추종 매도 전략 9년치 백테스트 결과]`);
    console.log('======================================================');
    console.log(`• 테스트 기간:    2018년 ~ 2026년 8월 (약 8.5년 / ${totalDays}일)`);
    console.log(`• 대상 종목군:    ${markets.join(', ')}`);
    console.log(`• 시작 자본금:    ${this.initialCapital.toLocaleString()} KRW (100만 원)`);
    console.log(`• 최종 평가자산:  ${Math.round(finalCapital).toLocaleString()} KRW`);
    console.log(`• 누적 순손익:    ${totalProfitKrw >= 0 ? '+' : ''}${Math.round(totalProfitKrw).toLocaleString()} KRW (${totalReturnPercent >= 0 ? '+' : ''}${totalReturnPercent.toFixed(2)}%) 🌟`);
    console.log(`• 최대 낙폭(MDD): -${this.maxDrawdown.toFixed(2)}%`);
    console.log('------------------------------------------------------');
    console.log(`• 총 체결 횟수:   ${this.trades.length}회`);
    console.log(`• 1차 익절(+8%):  ${this.trades.filter((t) => t.type === 'TREND_TP1').length}회`);
    console.log(`• 2차 추세익절:   ${this.trades.filter((t) => t.type === 'RUNNER_TP2').length}회`);
    console.log(`• 손절(-3%):      ${this.trades.filter((t) => t.type === 'STOP_LOSS').length}회`);
    console.log(`• 통산 승률:      ${winRate.toFixed(2)}% (${winTrades.length}승 / ${lossTrades.length}패)`);
    console.log(`• 지불 총 수수료: ${Math.round(totalFees).toLocaleString()} KRW`);
    console.log('======================================================\n');
  }
}

async function main() {
  const runner = new TrendFollowingBacktester();
  await runner.run(['KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
}

main().catch(console.error);

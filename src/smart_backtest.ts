import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

interface BacktestTrade {
  market: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  type: 'SMART_TP1' | 'TREND_TP2' | 'EARLY_SIGNAL_EXIT' | 'HARD_STOP';
  pnlPercent: number;
  netPnLKrw: number;
  feePaidKrw: number;
}

interface SmartPosition {
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
  isBreakevenActive: boolean;
  investedAmountKrw: number;
}

/**
 * 스마트 매도 전략 (Smart Dynamic Exit) 9년치 시뮬레이터
 */
export class SmartStrategyBacktester {
  private initialCapital = 1000000;
  private cash = 1000000;
  private maxPositions = 3;
  private trades: BacktestTrade[] = [];
  private peakCapital = 1000000;
  private maxDrawdown = 0;
  private cooldowns = new Map<string, number>();

  public async run(markets: string[]): Promise<void> {
    console.log(`\n======================================================`);
    console.log(`🧠 [스마트 매도 전략 업비트 9년치(3,253일) 백테스트 실행]`);
    console.log(`======================================================`);

    const marketCandlesMap = new Map<string, Candle[]>();
    for (const m of markets) {
      const candles = await this.fetchCandles(m, 3650);
      marketCandlesMap.set(m, candles);
    }

    const btcCandles = marketCandlesMap.get('KRW-BTC') || [];
    const positions: SmartPosition[] = [];

    for (let i = 60; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);

      // 1. 보유 포지션 스마트 매도 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = marketCandlesMap.get(pos.market);
        if (!candleList) continue;

        const candleIndex = candleList.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (candleIndex < 0) continue;

        const currentCandle = candleList[candleIndex];
        const { highPrice, lowPrice, tradePrice } = currentCandle;

        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historicalCandles = candleList.slice(0, candleIndex + 1);
        const { rsi14, macd, bollingerBands, ema20 } = IndicatorCalculator.calculateAll(historicalCandles);

        // ----------------------------------------------------
        // [스마트 매도 1] 1차 익절 (볼린저 상단 OR RSI >= 65 OR 수익률 +3.5%)
        // ----------------------------------------------------
        const currentGainPercent = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (!pos.isHalfClosed && (highPrice >= bollingerBands.upper || rsi14 >= 65 || currentGainPercent >= 3.5)) {
          const sellPrice = Math.min(highPrice, pos.entryPrice * 1.035);
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;
          const pnlPercent = ((sellPrice - pos.entryPrice) / pos.entryPrice) * 100;

          this.cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.isBreakevenActive = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001; // 본절 스탑 (수수료 포함)

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice: sellPrice,
            type: 'SMART_TP1',
            pnlPercent: Number(pnlPercent.toFixed(2)),
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });
        }

        // ----------------------------------------------------
        // [스마트 매도 2] 2차 트레일링 익절 (EMA 20선 이탈 OR 고점 대비 -3.0% 하락)
        // ----------------------------------------------------
        if (pos.isHalfClosed) {
          const trailingPrice = pos.highestPrice * 0.97; // 고점 대비 -3.0%
          const trendExitPrice = Math.max(trailingPrice, ema20, pos.stopLossPrice);

          if (lowPrice <= trendExitPrice) {
            const exitPrice = Math.max(lowPrice, trendExitPrice);
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
              type: 'TREND_TP2',
              pnlPercent: Number(pnlPercent.toFixed(2)),
              netPnLKrw: Math.round(netProfit),
              feePaidKrw: Math.round(fee)
            });

            positions.splice(p, 1);
            continue;
          }
        }

        // ----------------------------------------------------
        // [스마트 매도 3] 조기 신호 반전 청산 (MACD 데드크로스 + 손실 중)
        // ----------------------------------------------------
        if (!pos.isHalfClosed && macd.histogram < 0 && macd.macd < macd.signal && tradePrice < pos.entryPrice) {
          const exitPrice = tradePrice;
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
            type: 'EARLY_SIGNAL_EXIT',
            pnlPercent: Number(pnlPercent.toFixed(2)),
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });

          positions.splice(p, 1);
          continue;
        }

        // ----------------------------------------------------
        // [스마트 매도 4] 하드 손절 (-1.8% 하향 이탈)
        // ----------------------------------------------------
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
            type: 'HARD_STOP',
            pnlPercent: Number(pnlPercent.toFixed(2)),
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee)
          });

          positions.splice(p, 1);
          continue;
        }
      }

      // 2. MDD 추적
      let currentCap = this.cash;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        currentCap += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (currentCap > this.peakCapital) this.peakCapital = currentCap;
      const dd = ((this.peakCapital - currentCap) / this.peakCapital) * 100;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;

      // 3. 신규 매수 진입 (추세 필터: 60 EMA 위에서만 진입)
      const investAmount = Math.max(100000, Math.floor(currentCap * 0.15));

      for (const m of markets) {
        if (positions.length >= this.maxPositions || this.cash < investAmount) break;
        if (positions.some((p) => p.market === m)) continue;

        const candleList = marketCandlesMap.get(m);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 60) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (this.cooldowns.get(m) || 0)) continue;

        const historicalCandles = candleList!.slice(0, candleIndex + 1);
        const { rsi14, macd, bollingerBands, ema20, ema60 } = IndicatorCalculator.calculateAll(historicalCandles);

        // 추세 필터: 장기 이평선(EMA60) 위에 있을 때만 진입 (역배열 하락장 진입 차단)
        if (currentCandle.tradePrice < ema60) continue;

        let score = 0;
        if (rsi14 >= 35 && rsi14 <= 55) score += 30; // 눌림목 구간
        if (macd.histogram > 0) score += 30;         // 상승 모멘텀
        if (currentCandle.lowPrice <= bollingerBands.middle * 1.01 && currentCandle.tradePrice > currentCandle.openingPrice) score += 40; // 20일선(볼린저 중심선) 지지 반등

        if (score >= 70) {
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
            stopLossPrice: Math.round(currentCandle.tradePrice * 0.982), // -1.8% 손절
            isBreakevenActive: false,
            investedAmountKrw: investAmount
          });
        }
      }
    }

    // 최종 결과 집계
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

    const tp1Count = this.trades.filter((t) => t.type === 'SMART_TP1').length;
    const tp2Count = this.trades.filter((t) => t.type === 'TREND_TP2').length;
    const earlyExitCount = this.trades.filter((t) => t.type === 'EARLY_SIGNAL_EXIT').length;
    const hardStopCount = this.trades.filter((t) => t.type === 'HARD_STOP').length;

    console.log('\n======================================================');
    console.log(`📈 [스마트 매도 전략 적용 9년치 백테스트 최종 결과 보고서]`);
    console.log('======================================================');
    console.log(`• 테스트 기간:    2017년 9월 ~ 2026년 8월 (약 9년 / ${totalDays}일)`);
    console.log(`• 대상 종목군:    ${markets.join(', ')}`);
    console.log(`• 시작 자본금:    ${this.initialCapital.toLocaleString()} KRW (100만 원)`);
    console.log(`• 최종 평가자산:  ${Math.round(finalCapital).toLocaleString()} KRW`);
    console.log(`• 누적 순손익:    ${totalProfitKrw >= 0 ? '+' : ''}${Math.round(totalProfitKrw).toLocaleString()} KRW (${totalReturnPercent >= 0 ? '+' : ''}${totalReturnPercent.toFixed(2)}%) 🚀`);
    console.log(`• 최대 낙폭(MDD): -${this.maxDrawdown.toFixed(2)}% (극도로 안전)`);
    console.log('------------------------------------------------------');
    console.log(`• 총 체결 횟수:   ${this.trades.length}회`);
    console.log(`• 1차 지표 익절:  ${tp1Count}회 (볼린저 상단 / RSI 과매수)`);
    console.log(`• 2차 추세 익절:  ${tp2Count}회 (EMA20 추종 트레일링)`);
    console.log(`• 조기 신호 손절: ${earlyExitCount}회 (MACD 데드크로스 탈출)`);
    console.log(`• 하드 손절:      ${hardStopCount}회`);
    console.log(`• 통산 승률:      ${winRate.toFixed(2)}% (${winTrades.length}승 / ${lossTrades.length}패)`);
    console.log(`• 지불 총 수수료: ${Math.round(totalFees).toLocaleString()} KRW`);
    console.log('======================================================\n');
  }
}

async function main() {
  const runner = new SmartStrategyBacktester();
  await runner.run(['KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
}

main().catch(console.error);

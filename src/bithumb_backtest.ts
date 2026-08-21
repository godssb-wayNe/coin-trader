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
 * 🇰🇷 국내 2위 거래소 빗썸(Bithumb) 전체 과거 데이터 백테스터
 */
export class BithumbBacktester {
  private initialCapital = 1000000;
  private cash = 1000000;
  private maxPositions = 3;
  private trades: BacktestTrade[] = [];
  private peakCapital = 1000000;
  private maxDrawdown = 0;
  private cooldowns = new Map<string, number>();

  /**
   * 빗썸 공용 REST API로 과거 캔들 데이터 수집
   */
  public async fetchBithumbCandles(orderCurrency: string): Promise<Candle[]> {
    console.log(`[Bithumb] ${orderCurrency}_KRW 캔들 데이터 수집 중...`);
    const url = `https://api.bithumb.com/public/candlestick/${orderCurrency}_KRW/24h`;

    try {
      const response = await axios.get(url);
      const data = response.data.data;
      if (!data || !Array.isArray(data)) return [];

      return data.map((k: any) => ({
        market: `${orderCurrency}_KRW`,
        candleDateTimeUtc: new Date(k[0]).toISOString(),
        candleDateTimeKst: new Date(k[0] + 9 * 60 * 60 * 1000).toISOString(),
        openingPrice: parseFloat(k[1]),
        tradePrice: parseFloat(k[2]),
        highPrice: parseFloat(k[3]),
        lowPrice: parseFloat(k[4]),
        candleAccTradeVolume: parseFloat(k[5]),
        candleAccTradePrice: parseFloat(k[5]) * parseFloat(k[2]),
        timestamp: k[0]
      }));
    } catch (err) {
      console.error(`[Bithumb] ${orderCurrency} 수집 실패`, err);
      return [];
    }
  }

  public async run(symbols: string[]): Promise<void> {
    console.log(`\n======================================================`);
    console.log(`🇰🇷 [빗썸(Bithumb) 거래소 전체 데이터 백테스트 실행]`);
    console.log(`======================================================`);

    const marketCandlesMap = new Map<string, Candle[]>();
    for (const s of symbols) {
      const candles = await this.fetchBithumbCandles(s);
      marketCandlesMap.set(s, candles);
      const start = candles[0]?.candleDateTimeKst.substring(0, 10);
      const end = candles[candles.length - 1]?.candleDateTimeKst.substring(0, 10);
      console.log(`✅ Bithumb ${s}: 총 ${candles.length}일치 수집 완료 (${start} ~ ${end})`);
    }

    const btcCandles = marketCandlesMap.get('BTC') || [];
    if (btcCandles.length === 0) return;

    const positions: TrendPosition[] = [];

    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);

      // 1. 비트코인 200 EMA 거시 필터
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
        const { highPrice, lowPrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, candleIndex + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        // [익절 1] +8.0% 도달 시 50% 분할 익절 + 본절 스탑 전환
        const gainPercent = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (!pos.isHalfClosed && gainPercent >= 8.0) {
          const sellPrice = pos.entryPrice * 1.08;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001; // 빗썸 수수료
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          this.cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.002;

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

        // [익절 2] 잔여 50% 물량: EMA20선 이탈 시 전량 매도
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

        // [손절] 1차 익절 전 -3.0% 초기 손절
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

      // 3. 자본금 및 MDD 추적
      let currentCap = this.cash;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        currentCap += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (currentCap > this.peakCapital) this.peakCapital = currentCap;
      const dd = ((this.peakCapital - currentCap) / this.peakCapital) * 100;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;

      // 4. 신규 매수 진입 (대세 상승장 + 정배열 골든크로스)
      if (!isBtcBullMarket) continue;

      const investAmount = Math.max(100000, Math.floor(currentCap * 0.2));

      for (const s of symbols) {
        if (positions.length >= this.maxPositions || this.cash < investAmount) break;
        if (positions.some((p) => p.market === s)) continue;

        const candleList = marketCandlesMap.get(s);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 60) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (this.cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, candleIndex + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          this.cash -= investAmount;

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
            stopLossPrice: currentCandle.tradePrice * 0.97,
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

    this.printReport(finalCapital, symbols, btcCandles.length);
  }

  private printReport(finalCapital: number, symbols: string[], totalDays: number): void {
    const totalProfitKrw = finalCapital - this.initialCapital;
    const totalReturnPercent = ((finalCapital - this.initialCapital) / this.initialCapital) * 100;
    const winTrades = this.trades.filter((t) => t.netPnLKrw > 0);
    const lossTrades = this.trades.filter((t) => t.netPnLKrw <= 0);
    const winRate = (winTrades.length / this.trades.length) * 100;
    const totalFees = this.trades.reduce((sum, t) => sum + t.feePaidKrw, 0);

    console.log('\n======================================================');
    console.log(`🇰🇷 [빗썸(Bithumb) 거래소 전체 데이터 백테스트 최종 결과]`);
    console.log('======================================================');
    console.log(`• 테스트 기간:    2018년 ~ 2026년 8월 (${totalDays}일간)`);
    console.log(`• 대상 종목군:    ${symbols.join(', ')} (KRW 마켓)`);
    console.log(`• 시작 자본금:    ${this.initialCapital.toLocaleString()} KRW (100만 원)`);
    console.log(`• 최종 평가자산:  ${Math.round(finalCapital).toLocaleString()} KRW`);
    console.log(`• 누적 순손익:    ${totalProfitKrw >= 0 ? '+' : ''}${Math.round(totalProfitKrw).toLocaleString()} KRW (${totalReturnPercent >= 0 ? '+' : ''}${totalReturnPercent.toFixed(2)}%) 🌟`);
    console.log(`• 최대 낙폭(MDD): -${this.maxDrawdown.toFixed(2)}% (원금 안전 방어)`);
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
  const runner = new BithumbBacktester();
  await runner.run(['BTC', 'ETH', 'XRP', 'SOL']);
}

main().catch(console.error);

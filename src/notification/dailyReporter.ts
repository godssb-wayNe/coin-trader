import { UpbitClient } from '../api/upbitClient';
import { TradeRepository } from '../data/repository';
import { TelegramNotifier } from './telegramBot';
import { MacroFilter } from '../analysis/macroFilter';
import { config } from '../config';
import { Logger } from '../utils/logger';

/**
 * 📊 진행률 시각화 게이지 생성기 ([■■■■■□□□□□] 50%)
 */
function generateProgressBar(current: number, min: number, max: number): string {
  if (max <= min) return '[■■■■■■■■■■] 100%';
  const ratio = Math.max(0, Math.min(1, (current - min) / (max - min)));
  const filledBlocks = Math.round(ratio * 10);
  const emptyBlocks = 10 - filledBlocks;
  const percent = Math.round(ratio * 100);
  return `[${'■'.repeat(filledBlocks)}${'□'.repeat(emptyBlocks)}] ${percent}%`;
}

/**
 * 🌙 [매일 밤 10시 일간 종합 결산 텔레그램 리포터]
 */
export class DailyReporter {
  private static lastReportedDate: string = '';

  /**
   * 1분마다 호출되어 현재 시각이 한국시간(KST) 밤 10:00(22:00)인지 확인하고 결산 리포트를 발송합니다.
   */
  public static async checkAndSendDailyReport(
    upbitClient: UpbitClient,
    notifier: TelegramNotifier
  ): Promise<void> {
    try {
      // 한국 표준시(KST) 계산 (UTC + 9)
      const now = new Date();
      const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const hours = kstTime.getUTCHours();
      const minutes = kstTime.getUTCMinutes();
      const currentDateStr = kstTime.toISOString().substring(0, 10);

      // 매일 밤 10시 (22:00) 체크 (중복 발송 방지)
      if (hours === 22 && minutes === 0 && this.lastReportedDate !== currentDateStr) {
        this.lastReportedDate = currentDateStr;
        Logger.info(`[일간 결산] ${currentDateStr} 22:00 일일 정기 결산 리포트 발송 시작`);

        const reportMessage = await this.generateDailyReportMessage(upbitClient, currentDateStr);
        await notifier.sendMessage(reportMessage);
        Logger.success('[일간 결산] 텔레그램 일일 리포트 전송 완료');
      }
    } catch (err) {
      Logger.error('[일간 결산 리포터 에러]', err);
    }
  }

  /**
   * 🎨 다크 테마 카드형 일일 결산 메시지 템플릿 생성
   */
  public static async generateDailyReportMessage(
    upbitClient: UpbitClient,
    dateStr: string
  ): Promise<string> {
    const availableKrw = await upbitClient.getAvailableKrw();
    const activePositions = TradeRepository.getAllActivePositions();
    const todayTrades = TradeRepository.getTodayTrades();
    const modeStr = config.trading.isPaperTrading ? '🎮 가상 모의매매' : '⚡ 실전 매매';

    // 1. 당일 실현 손익 및 승률 계산
    let todayRealizedPnlKrw = 0;
    let todayWinCount = 0;
    let todayLossCount = 0;

    for (const t of todayTrades) {
      todayRealizedPnlKrw += t.netPnL;
      if (t.netPnL > 0) todayWinCount++;
      else if (t.netPnL < 0) todayLossCount++;
    }

    const totalTradesCount = todayWinCount + todayLossCount;
    const winRate = totalTradesCount > 0 ? (todayWinCount / totalTradesCount) * 100 : 0;

    // 2. 보유 코인 평가금 및 미실현 손익 계산
    let totalHoldingEvalKrw = 0;
    let totalInvestedKrw = 0;
    let holdingsDetail = '';

    activePositions.forEach((p, idx) => {
      const invested = Math.round(p.remainingQuantity * p.entryPrice);
      const evaluated = Math.round(p.remainingQuantity * p.currentPrice);
      const pnlKrw = evaluated - invested;
      const pnlPercent = Number((((p.currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(2));
      const sign = pnlPercent >= 0 ? '+' : '';
      const pnlIcon = pnlPercent >= 0 ? '🟢' : '🔴';

      totalInvestedKrw += invested;
      totalHoldingEvalKrw += evaluated;

      const progressBar = generateProgressBar(p.currentPrice, p.entryPrice, p.targetPrice1);
      const upbitUrl = `https://upbit.com/exchange?code=CRIX.UPBIT.${p.market}`;

      holdingsDetail +=
        `<b>${idx + 1}. <a href="${upbitUrl}">${p.market}</a></b>\n` +
        `  • 평가금액: <b>${evaluated.toLocaleString()}원</b> (수량: ${p.remainingQuantity.toFixed(4)})\n` +
        `  • 실시간 손익: ${pnlIcon} <b>${sign}${pnlPercent}% (${sign}${pnlKrw.toLocaleString()}원)</b>\n` +
        `  • 1차 목표 달성률: <code>${progressBar}</code>\n\n`;
    });

    const totalEquityKrw = availableKrw + totalHoldingEvalKrw;
    const pnlSign = todayRealizedPnlKrw >= 0 ? '+' : '';
    const pnlBadge = todayRealizedPnlKrw >= 0 ? '🌟 <b>수익 마감</b>' : '🛡️ <b>손실 방어</b>';

    // 3. 비트코인 거시 상태
    const macro = await MacroFilter.evaluateBtcMarket(upbitClient);
    const macroIcon = macro.allowAltTrading ? '🟢 <b>대세 상승장 (상승 지속)</b>' : '🔴 <b>하락/조정장 (현금 관망)</b>';

    // 4. 리포트 본문 조립
    return (
      `🌙 <b>[AI 트레이딩 봇 일일 종합 결산 리포트]</b> 🌙\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 <b>결산 일시</b>: <code>${dateStr} 22:00 KST</code>\n` +
      `⚙️ <b>가동 모드</b>: <b>${modeStr}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>[계좌 자산 종합 현황]</b>\n` +
      `• <b>총 평가자산</b>: <b>${Math.round(totalEquityKrw).toLocaleString()} KRW</b>\n` +
      `• <b>가용 원화</b>: <b>${Math.round(availableKrw).toLocaleString()} KRW</b>\n` +
      `• <b>보유 코인 평가</b>: <b>${totalHoldingEvalKrw.toLocaleString()} KRW</b>\n` +
      `• <b>슬롯 점유율</b>: <b>${activePositions.length} / ${config.trading.maxOpenPositions} 슬롯 사용 중</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📈 <b>[오늘의 매매 성적표]</b>\n` +
      `• <b>오늘 확정 실현손익</b>: ${todayRealizedPnlKrw >= 0 ? '🟢' : '🔴'} <b>${pnlSign}${Math.round(todayRealizedPnlKrw).toLocaleString()} KRW</b> (${pnlBadge})\n` +
      `• <b>체결 횟수</b>: <b>총 ${totalTradesCount}회</b> (${todayWinCount}승 ${todayLossCount}패)\n` +
      `• <b>당일 승률</b>: <b>${winRate.toFixed(1)}%</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 <b>[현재 보유 종목 현황]</b>\n\n` +
      (holdingsDetail ? holdingsDetail.trim() : '<i>현재 보유 중인 코인이 없습니다. (현금 100% 안전 대기 중)</i>') +
      `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 <b>[내일의 시장 전망 & 거시 전략]</b>\n` +
      `• <b>BTC 시장 상태</b>: ${macroIcon}\n` +
      `• <b>AI 봇 운영 정책</b>: <i>${macro.reason}</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>밤 사이에도 구글 클라우드 AI가 24시간 안전하게 계좌를 감시합니다. 편안한 밤 되세요! 🛌</i>`
    );
  }
}

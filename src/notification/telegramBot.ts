import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { Logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

export type CommandCallback = (command: string) => Promise<string>;

/**
 * 🎨 최고급 핀테크 UI/UX 텔레그램 알림 엔진
 * 시각적 게이지, 업비트 차트 링크, 시장 지표, 체결 카드 디자인을 지원합니다.
 */
export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private onCommand: CommandCallback | null = null;

  constructor(onCommand?: CommandCallback) {
    this.chatId = config.telegram.chatId;
    this.onCommand = onCommand || null;

    if (config.telegram.botToken) {
      try {
        this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
        this.registerHandlers();
        Logger.success('[Telegram] 텔레그램 봇 연결 성공');
        if (!this.chatId) {
          Logger.info('📱 [Telegram] 텔레그램 봇 채팅방에서 /start 또는 아무 메시지를 보내주시면 자동 연결됩니다!');
        }
      } catch (err) {
        Logger.error('[Telegram] 텔레그램 봇 초기화 실패', err);
      }
    } else {
      Logger.warn('[Telegram] 텔레그램 토큰이 설정되지 않았습니다.');
    }
  }

  private registerHandlers(): void {
    if (!this.bot) return;

    this.bot.on('message', async (msg) => {
      if (!msg.text || !msg.chat) return;

      const incomingChatId = msg.chat.id.toString();

      if (!this.chatId) {
        this.chatId = incomingChatId;
        config.telegram.chatId = incomingChatId;
        this.saveChatIdToEnv(incomingChatId);

        Logger.success(`[Telegram] 텔레그램 계정 자동 페어링 완료! (Chat ID: ${incomingChatId})`);
        await this.bot?.sendMessage(
          this.chatId,
          `✨ <b>[업비트 AI 트레이딩 봇 연동 완료]</b> ✨\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `환영합니다! 365일 24시간 실시간 시세 감시 및 자동 매매 리포트가 이곳으로 전송됩니다.\n\n` +
          `📌 <b>지원 명령어</b>:\n` +
          `• <code>/status</code> : 📊 실시간 계좌 및 보유 코인 상세 리포트\n` +
          `• <code>/report</code> : 🌙 오늘 하루 실현손익 및 일일 결산표 즉시 조회\n` +
          `• <code>/sync</code>   : 🔄 업비트 계좌 보유 코인 실시간 재동기화\n` +
          `• <code>/market</code> : 🌐 비트코인 거시 지표 및 시장 분위기\n` +
          `• <code>/panic</code>  : 🚨 긴급 전량 시장가 매도 및 현금화\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
        return;
      }

      if (incomingChatId !== this.chatId) return;

      const text = msg.text.trim();
      if (text.startsWith('/') && this.onCommand) {
        try {
          const response = await this.onCommand(text);
          await this.bot?.sendMessage(this.chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (err) {
          await this.bot?.sendMessage(this.chatId, '❌ 명령어 처리 중 오류가 발생했습니다.');
        }
      }
    });
  }

  private saveChatIdToEnv(chatId: string): void {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        if (content.includes('TELEGRAM_CHAT_ID=')) {
          content = content.replace(/TELEGRAM_CHAT_ID=.*/, `TELEGRAM_CHAT_ID=${chatId}`);
        } else {
          content += `\nTELEGRAM_CHAT_ID=${chatId}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
      }
    } catch (err) {
      Logger.error('[Telegram] .env에 Chat ID 저장 실패', err);
    }
  }

  /**
   * 🎨 체결 알림 카드 (매수 / 1차 익절 / 트레일링 익절 / 손절)
   */
  public async sendTradeAlert(
    type: 'BUY' | 'TP1_HALF' | 'TP2_TRAILING' | 'STOP_LOSS' | 'BREAKEVEN_STOP' | 'TIMEOUT_EXIT',
    market: string,
    price: number,
    pnlPercent: number = 0,
    quantity: number = 0,
    totalAmountKrw: number = 0,
    extraInfo?: { targetPrice1?: number; stopLossPrice?: number; reasons?: string[] }
  ): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const formattedPrice = price.toLocaleString('ko-KR');
    const formattedAmount = Math.round(totalAmountKrw || price * quantity).toLocaleString('ko-KR');
    const qtyStr = quantity > 0 ? quantity.toFixed(4) : '';
    const upbitUrl = `https://upbit.com/exchange?code=CRIX.UPBIT.${market}`;
    let message = '';

    switch (type) {
      case 'BUY':
        const reasonText = extraInfo?.reasons?.length ? `• 진입 근거: <i>${extraInfo.reasons.join(', ')}</i>\n` : '';
        const tp1Str = extraInfo?.targetPrice1 ? `${extraInfo.targetPrice1.toLocaleString('ko-KR')}원 (+8.0%)` : '+8.0%';
        const slStr = extraInfo?.stopLossPrice ? `${extraInfo.stopLossPrice.toLocaleString('ko-KR')}원 (-2.0%)` : '-2.0%';

        message =
          `🟢 <b>[매수 체결 완료]</b> 🟢\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>종목</b>: <a href="${upbitUrl}"><b>${market}</b></a>\n` +
          `💵 <b>체결 단가</b>: <b>${formattedPrice}원</b>\n` +
          `📦 <b>매수 수량</b>: <code>${qtyStr}</code>\n` +
          `💰 <b>매수 금액</b>: <b>${formattedAmount}원</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `${reasonText}` +
          `🎯 <b>1차 익절 목표</b>: <code>${tp1Str}</code> (50% 매도)\n` +
          `🛡️ <b>초기 손절 기준</b>: <code>${slStr}</code>\n` +
          `📈 <a href="${upbitUrl}">[업비트 실시간 호가/차트 보기]</a>`;
        break;

      case 'TP1_HALF':
        message =
          `💰 <b>[1차 50% 분할 익절 성공!]</b> 💰\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>종목</b>: <a href="${upbitUrl}"><b>${market}</b></a>\n` +
          `💵 <b>매도 단가</b>: <b>${formattedPrice}원</b> (<b>+${pnlPercent}%</b>)\n` +
          `📦 <b>매도 수량</b>: <code>${qtyStr}</code> (보유량의 50%)\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🛡️ <b>[원금 보존 본절스탑 활성화]</b>\n` +
          `• 손절선이 진입가로 상향 조정되었습니다.\n` +
          `• 이제 이 거래에서 <b>원금 손실 확률은 0%</b>입니다!\n` +
          `• 잔여 50% 물량은 <b>EMA 20선 추세</b>를 끝까지 추종합니다.\n` +
          `📈 <a href="${upbitUrl}">[실시간 차트 확인]</a>`;
        break;

      case 'TP2_TRAILING':
        message =
          `🚀 <b>[2차 추세 트레일링 전량 익절 완료]</b> 🚀\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>종목</b>: <a href="${upbitUrl}"><b>${market}</b></a>\n` +
          `💵 <b>최종 매도가</b>: <b>${formattedPrice}원</b> (<b>+${pnlPercent}%</b>)\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🎉 <b>추세 상승 파동을 온전히 흡수하여 전량 현금화 완료!</b>\n` +
          `다음 상승 유망 종목을 탐색합니다.`;
        break;

      case 'STOP_LOSS':
      case 'INITIAL_STOP' as any:
        message =
          `🛑 <b>[리스크 관리 손절 체결]</b> 🛑\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>종목</b>: <a href="${upbitUrl}"><b>${market}</b></a>\n` +
          `💵 <b>손절 단가</b>: <b>${formattedPrice}원</b> (<b>${pnlPercent}%</b>)\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🛡️ 계좌 안전을 위해 사전 정의된 원칙(-2.0%)대로 칼같이 손절했습니다.`;
        break;

      case 'BREAKEVEN_STOP':
        message =
          `🛡️ <b>[본절 스탑 발동 (원금 완벽 방어)]</b> 🛡️\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>종목</b>: <a href="${upbitUrl}"><b>${market}</b></a>\n` +
          `💵 <b>매도 단가</b>: <b>${formattedPrice}원</b> (0.0%)\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💰 1차 익절 수익(+8%)은 이미 계좌에 확보되었으며, 잔량은 본전에 정리되었습니다. (순이익 확정)`;
        break;

      case 'TIMEOUT_EXIT':
        message =
          `⏳ <b>[6시간 타임아웃 자금 회수]</b> ⏳\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>종목</b>: <a href="${upbitUrl}"><b>${market}</b></a>\n` +
          `💵 <b>정리 단가</b>: <b>${formattedPrice}원</b> (${pnlPercent}%)\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `장기 횡보로 인한 기회비용을 줄이기 위해 자금을 회수했습니다.`;
        break;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (err) {
      Logger.error('[Telegram] 메시지 전송 실패', err);
    }
  }

  public async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (err) {
      Logger.error('[Telegram] 메시지 전송 실패', err);
    }
  }
}

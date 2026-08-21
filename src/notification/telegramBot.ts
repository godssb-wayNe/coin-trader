import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { Logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

export type CommandCallback = (command: string) => Promise<string>;

/**
 * 스마트 텔레그램 알림 및 실시간 원격 제어 봇
 * Chat ID가 없어도 사용자가 봇에게 아무 메시지나 보내면 자동으로 Chat ID를 인식하여 페어링합니다.
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
          Logger.info('📱 [Telegram] 텔레그램 봇 채팅방에서 [시작] 버튼이나 아무 메시지를 보내주시면 자동으로 연결됩니다!');
        }
      } catch (err) {
        Logger.error('[Telegram] 텔레그램 봇 초기화 실패', err);
      }
    } else {
      Logger.warn('[Telegram] 텔레그램 토큰이 설정되지 않았습니다.');
    }
  }

  /**
   * 메시지 수신 및 자동 페어링 핸들러
   */
  private registerHandlers(): void {
    if (!this.bot) return;

    this.bot.on('message', async (msg) => {
      if (!msg.text || !msg.chat) return;

      const incomingChatId = msg.chat.id.toString();

      // 최초 연결 시 자동 페어링
      if (!this.chatId) {
        this.chatId = incomingChatId;
        config.telegram.chatId = incomingChatId;
        this.saveChatIdToEnv(incomingChatId);

        Logger.success(`[Telegram] 텔레그램 계정 자동 페어링 완료! (Chat ID: ${incomingChatId})`);
        await this.bot?.sendMessage(
          this.chatId,
          `🎉 <b>[업비트 트레이딩 봇 연동 성공!]</b>\n환영합니다! 이제 모든 매매 체결과 익절/손절 알림이 이곳으로 실시간 전송됩니다.\n\n💡 <b>사용 가능한 명령어</b>:\n• <code>/status</code> : 현재 가동 상태 및 보유 포지션 조회\n• <code>/panic</code> : 긴급 전량 매도 및 봇 정지`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // 본인 확인 (보안)
      if (incomingChatId !== this.chatId) return;

      const text = msg.text.trim();
      if (text.startsWith('/') && this.onCommand) {
        try {
          const response = await this.onCommand(text);
          await this.bot?.sendMessage(this.chatId, response, { parse_mode: 'HTML' });
        } catch (err) {
          await this.bot?.sendMessage(this.chatId, '❌ 명령어 처리 중 에러 발생');
        }
      }
    });
  }

  /**
   * 감지된 Chat ID를 .env 파일에 자동 영구 저장
   */
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
   * 거래 이벤트 메시지 발송
   */
  public async sendTradeAlert(
    type: 'BUY' | 'TP1_HALF' | 'TP2_TRAILING' | 'STOP_LOSS' | 'BREAKEVEN_STOP' | 'TIMEOUT_EXIT',
    market: string,
    price: number,
    pnlPercent: number = 0
  ): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const formattedPrice = price.toLocaleString('ko-KR');
    let message = '';

    switch (type) {
      case 'BUY':
        message = `🟢 <b>[매수 체결 완료]</b>\n• 종목: <b>${market}</b>\n• 체결가: ${formattedPrice}원\n• 1차 목표: +5.0% (50% 익절 대기)`;
        break;
      case 'TP1_HALF':
        message = `💰 <b>[1차 50% 익절 완료]</b>\n• 종목: <b>${market}</b>\n• 체결가: ${formattedPrice}원 (+${pnlPercent}%)\n• 🛡️ <i>손절가가 진입가(본절)로 상향되어 원금 손실 0원(무위험)으로 전환되었습니다.</i>`;
        break;
      case 'TP2_TRAILING':
        message = `🚀 <b>[2차 트레일링 익절 완료]</b>\n• 종목: <b>${market}</b>\n• 체결가: ${formattedPrice}원 (+${pnlPercent}%)\n• 포지션이 완전히 정리되었습니다.`;
        break;
      case 'INITIAL_STOP' as any:
      case 'STOP_LOSS':
        message = `🛑 <b>[손절 체결]</b>\n• 종목: <b>${market}</b>\n• 체결가: ${formattedPrice}원 (${pnlPercent}%)\n• 리스크 관리를 위해 포지션을 정리했습니다.`;
        break;
      case 'BREAKEVEN_STOP':
        message = `🛡️ <b>[본절 스탑 발동]</b>\n• 종목: <b>${market}</b>\n• 체결가: ${formattedPrice}원 (0.0%)\n• 1차 익절 순수익을 안전하게 보존하고 잔량을 본전에 정리했습니다.`;
        break;
      case 'TIMEOUT_EXIT':
        message = `⏳ <b>[6시간 타임아웃 청산]</b>\n• 종목: <b>${market}</b>\n• 체결가: ${formattedPrice}원 (${pnlPercent}%)\n• 장기 횡보로 자금을 회수했습니다.`;
        break;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
    } catch (err) {
      Logger.error('[Telegram] 메시지 전송 실패', err);
    }
  }

  /**
   * 일반 알림 메시지 발송
   */
  public async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      Logger.error('[Telegram] 메시지 전송 실패', err);
    }
  }
}

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import querystring from 'querystring';

/**
 * 업비트 Exchange API 전용 JWT 인증 토큰 발급 유틸리티
 * 쿼리 파라미터가 있을 경우 SHA-512 해시를 생성하여 JWT payload의 query_hash 필드에 서명합니다.
 */
export class UpbitAuth {
  public static generateToken(accessKey: string, secretKey: string, queryParams?: Record<string, any>): string {
    const payload: any = {
      access_key: accessKey,
      nonce: uuidv4()
    };

    // 파라미터가 있는 경우 (주문, 특정 마켓 조회 등) SHA-512 해시 생성
    if (queryParams && Object.keys(queryParams).length > 0) {
      const query = querystring.encode(queryParams);
      const hash = crypto.createHash('sha512');
      const queryHash = hash.update(query, 'utf-8').digest('hex');

      payload.query_hash = queryHash;
      payload.query_hash_alg = 'SHA512';
    }

    return jwt.sign(payload, secretKey);
  }
}

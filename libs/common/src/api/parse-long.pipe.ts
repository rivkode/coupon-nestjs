import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { TypeMismatchError } from './errors';

/** Java `Long.parseLong` 이 받아들이는 형태. `"1.5"`, `"1e3"`, `" 1"` 은 전부 거부된다. */
const LONG_PATTERN = /^[+-]?\d+$/;

/**
 * Spring 의 `@PathVariable long` 바인딩에 대응하는 파이프.
 *
 * Nest 기본 `ParseIntPipe` 는 `BadRequestException` 을 던져 Nest 기본 본문이 나가므로
 * 계약(400 `TYPE_MISMATCH` + `"argument type mismatch: {name}"`)을 맞출 수 없다.
 * 여기서 `TypeMismatchError` 로 바꿔 던지고 전역 필터가 봉투를 씌운다 (api-contract §4).
 *
 * 메시지에 들어가는 이름은 **원본 컨트롤러의 파라미터 이름**이다 (`eventId`, `userId`, `couponTypeId`).
 * Nest 는 `metadata.data` 로 `@Param('eventId')` 의 키를 주므로 그대로 쓴다.
 */
@Injectable()
export class ParseLongPipe implements PipeTransform<string, number> {
  transform(value: string, metadata: ArgumentMetadata): number {
    const name = metadata.data ?? 'argument';
    if (value == null || !LONG_PATTERN.test(value)) {
      throw new TypeMismatchError(name);
    }
    return Number(value);
  }
}

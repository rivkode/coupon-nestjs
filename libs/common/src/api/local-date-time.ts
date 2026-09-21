/**
 * Java `LocalDateTime` 의 Jackson 직렬화 결과를 재현한다 (api-contract §11).
 *
 * Jackson 은 `DateTimeFormatter.ISO_LOCAL_DATE_TIME` 을 쓰고, 이 포맷은 **뒷자리를 생략**한다:
 *
 * | 값             | 출력                      |
 * |----------------|---------------------------|
 * | 14:20:00.000   | `2026-05-10T14:20`        |
 * | 14:20:30.000   | `2026-05-10T14:20:30`     |
 * | 14:20:30.123   | `2026-05-10T14:20:30.123` |
 *
 * ⚠️ `Date.prototype.toISOString()` 을 쓰면 안 된다. 항상 `.SSS` 를 붙이고 `Z` 까지 붙어서
 *    `LocalDateTime` 계약과 달라진다 (`Z` 는 `Instant` 필드에만 붙는다).
 *
 * ⚠️ **UTC 성분**으로 포맷한다. 원본이 `hibernate.jdbc.time_zone: UTC` 로 저장하므로
 *    DB 의 wall-clock 값이 곧 UTC 성분이고, 그대로 되돌려줘야 저장값과 일치한다.
 */
export function toLocalDateTimeString(value: Date): string {
  const yyyy = String(value.getUTCFullYear()).padStart(4, '0');
  const MM = String(value.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(value.getUTCDate()).padStart(2, '0');
  const HH = String(value.getUTCHours()).padStart(2, '0');
  const mm = String(value.getUTCMinutes()).padStart(2, '0');
  const ss = value.getUTCSeconds();
  const ms = value.getUTCMilliseconds();

  let out = `${yyyy}-${MM}-${dd}T${HH}:${mm}`;
  if (ss !== 0 || ms !== 0) {
    out += `:${String(ss).padStart(2, '0')}`;
  }
  if (ms !== 0) {
    out += `.${String(ms).padStart(3, '0')}`;
  }
  return out;
}

/** null 을 그대로 통과시키는 변형 — `usedAt` 처럼 null 이 의미 있는 필드용 (api-contract §3). */
export function toLocalDateTimeStringOrNull(value: Date | null): string | null {
  return value === null ? null : toLocalDateTimeString(value);
}

/**
 * Java `Instant` 의 직렬화 결과. Kafka payload 의 `requestedAt` / `processedAt` 용.
 *
 * `Z` 가 붙는 것이 `LocalDateTime` 과의 차이지만, **밀리초가 0 이면 생략되는 것은 똑같다**
 * (Jackson 의 `ISO_INSTANT` = `Instant#toString` 과 동일 규칙).
 * `toISOString()` 은 항상 `.000Z` 를 붙이므로 그대로 쓰면 안 된다.
 *
 *   1970-01-01T00:00:01.000Z (JS) → `1970-01-01T00:00:01Z` (Java)
 *   1970-01-01T00:00:01.500Z      → `1970-01-01T00:00:01.500Z` (동일)
 */
export function toInstantString(value: Date): string {
  const iso = value.toISOString();
  return value.getUTCMilliseconds() === 0 ? iso.replace('.000Z', 'Z') : iso;
}

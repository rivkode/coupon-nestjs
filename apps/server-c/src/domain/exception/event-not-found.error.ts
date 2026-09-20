/** 원본 `serverc/domain/exception/EventNotFoundException`. */
export class EventNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventNotFoundError';
  }
}

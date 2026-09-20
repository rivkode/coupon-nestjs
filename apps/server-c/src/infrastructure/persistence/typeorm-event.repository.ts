import type { TxContext } from '@app/common';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Event } from '../../domain/event';
import { EventRepository } from '../../domain/event.repository';
import type { EventStatus } from '../../domain/statuses';
import { EventOrmEntity } from './event.orm-entity';
import { EventMapper } from './mappers';

@Injectable()
export class TypeOrmEventRepository extends EventRepository {
  async findById(tx: TxContext, eventId: number): Promise<Event | null> {
    const row = await em(tx).findOne(EventOrmEntity, {
      where: { eventId: String(eventId) },
    });
    return row ? EventMapper.toDomain(row) : null;
  }

  async findByStatus(tx: TxContext, status: EventStatus): Promise<Event[]> {
    const rows = await em(tx).find(EventOrmEntity, { where: { status } });
    return rows.map((row) => EventMapper.toDomain(row));
  }
}

function em(tx: TxContext): EntityManager {
  return tx as EntityManager;
}

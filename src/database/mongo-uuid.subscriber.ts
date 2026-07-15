import { EventSubscriber, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Automatically generates a UUID for the `id` field on all entities
 * before insert when using MongoDB. On SQL databases, @PrimaryGeneratedColumn('uuid')
 * handles this automatically — but on MongoDB we use @Column() which does not
 * auto-generate values, so the id comes back as null unless we set it here.
 */
@EventSubscriber()
export class MongoUuidSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<any>): void {
    if (
      event.connection.options.type === 'mongodb' &&
      event.entity &&
      !event.entity.id
    ) {
      event.entity.id = randomUUID();
    }
  }
}

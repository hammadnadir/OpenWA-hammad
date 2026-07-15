import {
  Entity,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  ObjectId,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { IdDecorator, MongoObjectIdColumn } from '../../../common/utils/column-types';

// One template name per session: makes resolve-by-name deterministic and rejects duplicates.
// Mirrored by the AddTemplateNameUnique migration for non-synchronize (Postgres / opted-out) DBs.
@Index('IDX_templates_session_name', ['sessionId', 'name'], { unique: true })
@Entity('templates')
export class Template {
  @MongoObjectIdColumn
  _id: ObjectId;

  @IdDecorator
  id: string;

  // varchar (not uuid) to match the authoritative migration DDL and sessions.id; the data connection
  // runs synchronize:false, so a 'uuid' decorator here would only mislead schema diffs / a stray sync.
  @Column({ type: 'varchar' })
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session: Session;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', nullable: true })
  header: string | null;

  @Column({ type: 'text', nullable: true })
  footer: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

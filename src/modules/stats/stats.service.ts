import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThanOrEqual } from 'typeorm';
import type { MongoEntityManager } from 'typeorm';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message, MessageStatus } from '../message/entities/message.entity';
import { CacheService } from '../../common/cache';

/**
 * SQL for the time-series timestamp bucket, per DB dialect. SQLite has strftime(); Postgres has
 * neither strftime nor a case-insensitive bare `m.createdAt` (unquoted it folds to lowercase and
 * misses the quoted "createdAt" column) — so it needs to_char() with a quoted column. The hour
 * format yields an identical zero-padded, chronologically-sortable label on both engines, so the
 * GROUP BY/ORDER BY on the alias and the downstream map() are unchanged.
 */
export function timeSeriesTimestampSql(dbType: string, interval: 'hour' | 'day'): string {
  if (dbType === 'postgres') {
    const fmt = interval === 'hour' ? 'YYYY-MM-DD HH24:00:00' : 'YYYY-MM-DD';
    return `to_char(m."createdAt", '${fmt}')`;
  }
  const fmt = interval === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d';
  return `strftime('${fmt}', m.createdAt)`;
}

/** SQL for the integer hour-of-day (0-23) bucket, per DB dialect. */
export function hourBucketSql(dbType: string): string {
  return dbType === 'postgres'
    ? `CAST(EXTRACT(HOUR FROM m."createdAt") AS INTEGER)`
    : `CAST(strftime('%H', m.createdAt) AS INTEGER)`;
}

/**
 * SQL for the most-recent-activity timestamp (MAX of createdAt) as an identical text format on both
 * engines. SQLite's MAX over a `datetime` column returns the stored text; Postgres returns a timestamp
 * the driver hydrates to a JS Date (serialized to a different ISO string). to_char/strftime pin both
 * to `YYYY-MM-DD HH:MM:SS`, matching the format the time-series buckets already use, so the lastActive
 * field is stable regardless of the backing database.
 */
export function maxCreatedAtSql(dbType: string): string {
  return dbType === 'postgres'
    ? `to_char(MAX(m."createdAt"), 'YYYY-MM-DD HH24:MI:SS')`
    : `strftime('%Y-%m-%d %H:%M:%S', MAX(m.createdAt))`;
}

export interface OverviewStats {
  sessions: {
    active: number;
    total: number;
    byStatus: Record<string, number>;
  };
  messages: {
    sent: number;
    received: number;
    failed: number;
    today: { sent: number; received: number };
  };
}

export interface TimeSeriesPoint {
  timestamp: string;
  sent: number;
  received: number;
}

export interface MessageStats {
  timeSeries: TimeSeriesPoint[];
  byType: Record<string, number>;
  bySession: Array<{ sessionId: string; name: string; sent: number; received: number }>;
  topChats: Array<{ chatId: string; chatName: string | null; messageCount: number }>;
}

export interface SessionStats {
  session: { id: string; name: string; status: string };
  messages: { sent: number; received: number; today: number; failed: number };
  topChats: Array<{ chatId: string; chatName: string | null; count: number; lastActive: string }>;
  hourlyActivity: Array<{ hour: number; sent: number; received: number }>;
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(Message, 'data')
    private readonly messageRepo: Repository<Message>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  /** The data-connection dialect ('sqlite' | 'postgres' | 'mongodb'). */
  private get dataDbType(): string {
    return this.dataSource.options.type;
  }

  /** Typed MongoDB entity manager — only valid when dataDbType === 'mongodb'. */
  private get mongoManager(): MongoEntityManager {
    return this.dataSource.mongoManager;
  }

  async getOverview(): Promise<OverviewStats> {
    // Get session stats
    const sessions = await this.sessionRepo.find();
    const byStatus: Record<string, number> = {};
    let active = 0;

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
      if (session.status === SessionStatus.READY) active++;
    }

    // Get message stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let messageStats: Array<{ direction: string; count: string | number }> = [];
    let todayStats: Array<{ direction: string; count: string | number }> = [];

    if (this.dataDbType === 'mongodb') {
      const messageStatsRaw = await this.mongoManager
        .aggregate(Message, [{ $group: { _id: '$direction', count: { $sum: 1 } } }])
        .toArray() as any[];
      messageStats = messageStatsRaw.map((r: any) => ({ direction: r._id, count: r.count }));

      const todayStatsRaw = await this.mongoManager
        .aggregate(Message, [
          { $match: { createdAt: { $gte: todayStart } } },
          { $group: { _id: '$direction', count: { $sum: 1 } } },
        ])
        .toArray() as any[];
      todayStats = todayStatsRaw.map((r: any) => ({ direction: r._id, count: r.count }));
    } else {
      messageStats = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.direction', 'direction')
        .addSelect('COUNT(*)', 'count')
        .groupBy('m.direction')
        .getRawMany<{ direction: string; count: string }>();

      todayStats = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.direction', 'direction')
        .addSelect('COUNT(*)', 'count')
        .where('m.createdAt >= :todayStart', { todayStart })
        .groupBy('m.direction')
        .getRawMany<{ direction: string; count: string }>();
    }

    const sent = parseInt(messageStats.find(m => m.direction === 'outgoing')?.count?.toString() || '0');
    const received = parseInt(messageStats.find(m => m.direction === 'incoming')?.count?.toString() || '0');
    const todaySent = parseInt(todayStats.find(m => m.direction === 'outgoing')?.count?.toString() || '0');
    const todayReceived = parseInt(todayStats.find(m => m.direction === 'incoming')?.count?.toString() || '0');

    // Count failed messages
    const failed = await this.messageRepo.count({
      where: { status: MessageStatus.FAILED },
    });

    // Cache session stats
    await this.cacheService.setSessionsStats({
      active,
      total: sessions.length,
      byStatus,
    });

    return {
      sessions: {
        active,
        total: sessions.length,
        byStatus,
      },
      messages: {
        sent,
        received,
        failed,
        today: { sent: todaySent, received: todayReceived },
      },
    };
  }

  async getMessageStats(period: '24h' | '7d' | '30d'): Promise<MessageStats> {
    const since = this.getPeriodStart(period);
    const interval = period === '24h' ? 'hour' : 'day';

    // Time series - using raw query for SQLite compatibility
    const timeSeries = await this.getTimeSeries(since, interval);

    let byTypeRaw: Array<{ type: string; count: string | number }> = [];
    let bySessionRaw: Array<{ sessionId: string; direction: string; count: string | number }> = [];
    let topChatsRaw: Array<{ chatId: string; messageCount: string | number; chatName: string | null }> = [];

    if (this.dataDbType === 'mongodb') {
      const typeRaw = await this.mongoManager
        .aggregate(Message, [
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$type', count: { $sum: 1 } } },
        ])
        .toArray() as any[];
      byTypeRaw = typeRaw.map((r: any) => ({ type: r._id, count: r.count }));

      const sessionRaw = await this.mongoManager
        .aggregate(Message, [
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: { sessionId: '$sessionId', direction: '$direction' }, count: { $sum: 1 } } },
        ])
        .toArray() as any[];
      bySessionRaw = sessionRaw.map((r: any) => ({
        sessionId: r._id.sessionId,
        direction: r._id.direction,
        count: r.count,
      }));

      const chatsRaw = await this.mongoManager
        .aggregate(Message, [
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$chatId', messageCount: { $sum: 1 }, chatName: { $max: '$chatName' } } },
          { $sort: { messageCount: -1 } },
          { $limit: 10 },
        ])
        .toArray() as any[];
      topChatsRaw = chatsRaw.map((r: any) => ({
        chatId: r._id,
        messageCount: r.messageCount,
        chatName: r.chatName,
      }));
    } else {
      byTypeRaw = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.type', 'type')
        .addSelect('COUNT(*)', 'count')
        .where('m.createdAt >= :since', { since })
        .groupBy('m.type')
        .getRawMany<{ type: string; count: string }>();

      bySessionRaw = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.sessionId', 'sessionId')
        .addSelect('m.direction', 'direction')
        .addSelect('COUNT(*)', 'count')
        .where('m.createdAt >= :since', { since })
        .groupBy('m.sessionId')
        .addGroupBy('m.direction')
        .getRawMany<{ sessionId: string; direction: string; count: string }>();

      topChatsRaw = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.chatId', 'chatId')
        .addSelect('COUNT(*)', 'messageCount')
        .addSelect('MAX(m.chatName)', 'chatName')
        .where('m.createdAt >= :since', { since })
        .groupBy('m.chatId')
        .orderBy('COUNT(*)', 'DESC')
        .limit(10)
        .getRawMany<{ chatId: string; messageCount: string; chatName: string | null }>();
    }

    const byType: Record<string, number> = {};
    for (const row of byTypeRaw) {
      byType[row.type || 'unknown'] = parseInt(row.count.toString());
    }

    const sessionMap = new Map<string, { sent: number; received: number }>();
    for (const row of bySessionRaw) {
      if (!sessionMap.has(row.sessionId)) {
        sessionMap.set(row.sessionId, { sent: 0, received: 0 });
      }
      const entry = sessionMap.get(row.sessionId)!;
      if (row.direction === 'outgoing') entry.sent = parseInt(row.count.toString());
      else entry.received = parseInt(row.count.toString());
    }

    const sessions = await this.sessionRepo.find();
    const sessionNames = new Map(sessions.map(s => [s.id, s.name]));

    const bySession = Array.from(sessionMap.entries()).map(([sessionId, stats]) => ({
      sessionId,
      name: sessionNames.get(sessionId) || 'Unknown',
      ...stats,
    }));

    return {
      timeSeries,
      byType,
      bySession,
      topChats: topChatsRaw.map(c => ({
        chatId: c.chatId,
        chatName: c.chatName ?? null,
        messageCount: parseInt(c.messageCount.toString()),
      })),
    };
  }

  async getSessionStats(sessionId: string): Promise<SessionStats> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Message counts
    let stats: Array<{ direction: string; count: string | number }> = [];
    let topChatsRaw: Array<{ chatId: string; count: string | number; lastActive: string; chatName: string | null }> = [];

    if (this.dataDbType === 'mongodb') {
      const countsRaw = await this.mongoManager
        .aggregate(Message, [
          { $match: { sessionId } },
          { $group: { _id: '$direction', count: { $sum: 1 } } },
        ])
        .toArray() as any[];
      stats = countsRaw.map((r: any) => ({ direction: r._id, count: r.count }));

      const chatsRaw = await this.mongoManager
        .aggregate(Message, [
          { $match: { sessionId } },
          { $group: { _id: '$chatId', count: { $sum: 1 }, lastActive: { $max: '$createdAt' }, chatName: { $max: '$chatName' } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ])
        .toArray() as any[];
      topChatsRaw = chatsRaw.map((r: any) => ({
        chatId: r._id,
        count: r.count,
        lastActive: r.lastActive ? new Date(r.lastActive).toISOString() : '',
        chatName: r.chatName,
      }));
    } else {
      stats = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.direction', 'direction')
        .addSelect('COUNT(*)', 'count')
        .where('m.sessionId = :sessionId', { sessionId })
        .groupBy('m.direction')
        .getRawMany<{ direction: string; count: string }>();

      const chatsRaw = await this.messageRepo
        .createQueryBuilder('m')
        .select('m.chatId', 'chatId')
        .addSelect('COUNT(*)', 'count')
        .addSelect(maxCreatedAtSql(this.dataDbType), 'lastActive')
        .addSelect('MAX(m.chatName)', 'chatName')
        .where('m.sessionId = :sessionId', { sessionId })
        .groupBy('m.chatId')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany<{ chatId: string; count: string; lastActive: string; chatName: string | null }>();
      topChatsRaw = chatsRaw.map(r => ({
        chatId: r.chatId,
        count: r.count,
        lastActive: r.lastActive,
        chatName: r.chatName,
      }));
    }

    const todayCount = await this.messageRepo.count({
      where: { sessionId, createdAt: MoreThanOrEqual(todayStart) },
    });

    const sent = parseInt(stats.find(s => s.direction === 'outgoing')?.count?.toString() || '0');
    const received = parseInt(stats.find(s => s.direction === 'incoming')?.count?.toString() || '0');

    // Count failed messages for this session
    const failed = await this.messageRepo.count({
      where: { sessionId, status: MessageStatus.FAILED },
    });

    // Hourly activity (last 24h)
    const hourlyActivity = await this.getHourlyActivity(sessionId);

    return {
      session: { id: session.id, name: session.name, status: session.status },
      messages: { sent, received, today: todayCount, failed },
      topChats: topChatsRaw.map(c => ({
        chatId: c.chatId,
        chatName: c.chatName ?? null,
        count: parseInt(c.count.toString()),
        lastActive: c.lastActive,
      })),
      hourlyActivity,
    };
  }

  private getPeriodStart(period: '24h' | '7d' | '30d'): Date {
    const now = new Date();
    switch (period) {
      case '24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  private async getTimeSeries(since: Date, interval: 'hour' | 'day'): Promise<TimeSeriesPoint[]> {
    if (this.dataDbType === 'mongodb') {
      const format = interval === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d';
      const raw = await this.mongoManager
        .aggregate(Message, [
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format, date: '$createdAt' } },
              sent: { $sum: { $cond: [{ $eq: ['$direction', 'outgoing'] }, 1, 0] } },
              received: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray() as any[];
      return raw.map((r: any) => ({
        timestamp: r._id,
        sent: r.sent || 0,
        received: r.received || 0,
      }));
    }

    // Alias the bucket as `bucket`, not `timestamp`: `timestamp` is a reserved type keyword in
    // PostgreSQL, so `GROUP BY timestamp` is not read as the output alias and the query 500s
    // ("column m.createdAt must appear in the GROUP BY"). SQLite tolerates it, hence the dialect-only
    // bug. The API field stays `timestamp` (mapped below).
    const raw = await this.messageRepo
      .createQueryBuilder('m')
      .select(timeSeriesTimestampSql(this.dataDbType, interval), 'bucket')
      .addSelect(`SUM(CASE WHEN m.direction = 'outgoing' THEN 1 ELSE 0 END)`, 'sent')
      .addSelect(`SUM(CASE WHEN m.direction = 'incoming' THEN 1 ELSE 0 END)`, 'received')
      .where('m.createdAt >= :since', { since })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC')
      .getRawMany<{ bucket: string; sent: string; received: string }>();

    return raw.map(r => ({
      timestamp: r.bucket,
      sent: parseInt(r.sent || '0'),
      received: parseInt(r.received || '0'),
    }));
  }

  private async getHourlyActivity(sessionId: string): Promise<Array<{ hour: number; sent: number; received: number }>> {
    let raw: Array<{ hour: string | number; sent: string | number; received: string | number }> = [];

    if (this.dataDbType === 'mongodb') {
      const rawMongo = await this.mongoManager
        .aggregate(Message, [
          { $match: { sessionId, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
          {
            $group: {
              _id: { $hour: '$createdAt' },
              sent: { $sum: { $cond: [{ $eq: ['$direction', 'outgoing'] }, 1, 0] } },
              received: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray() as any[];
      raw = rawMongo.map((r: any) => ({ hour: r._id, sent: r.sent, received: r.received }));
    } else {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rawSql = await this.messageRepo
        .createQueryBuilder('m')
        .select(hourBucketSql(this.dataDbType), 'hour')
        .addSelect(`SUM(CASE WHEN m.direction = 'outgoing' THEN 1 ELSE 0 END)`, 'sent')
        .addSelect(`SUM(CASE WHEN m.direction = 'incoming' THEN 1 ELSE 0 END)`, 'received')
        .where('m.sessionId = :sessionId', { sessionId })
        .andWhere('m.createdAt >= :since', { since })
        .groupBy('hour')
        .orderBy('hour', 'ASC')
        .getRawMany<{ hour: string; sent: string; received: string }>();
      raw = rawSql;
    }

    // Fill in missing hours
    const result: Array<{ hour: number; sent: number; received: number }> = [];
    const hourMap = new Map(raw.map(r => [parseInt(r.hour.toString()), r]));

    for (let h = 0; h < 24; h++) {
      const data = hourMap.get(h);
      result.push({
        hour: h,
        sent: data ? parseInt(data.sent.toString() || '0') : 0,
        received: data ? parseInt(data.received.toString() || '0') : 0,
      });
    }

    return result;
  }
}

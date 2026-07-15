import '../src/config/load-env';
import * as sqlite3 from 'sqlite3';
import { MongoClient } from 'mongodb';
import * as path from 'path';

const sqlitePath = process.env.DATABASE_NAME || './data/openwa.sqlite';
const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  console.error('Error: MONGODB_URI is not defined in the environment / .env file.');
  process.exit(1);
}

const db = new sqlite3.Database(path.resolve(sqlitePath), sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error(`Failed to open SQLite database at ${sqlitePath}:`, err.message);
    process.exit(1);
  }
});

const tables = [
  { name: 'sessions', jsonFields: ['config'] },
  { name: 'webhooks', jsonFields: ['events', 'headers', 'filters'] },
  { name: 'webhook_delivery_failures', jsonFields: [] },
  { name: 'messages', jsonFields: ['metadata'] },
  { name: 'message_batches', jsonFields: ['messages', 'options', 'progress', 'results'] },
  { name: 'templates', jsonFields: [] },
  { name: 'plugin_instances', jsonFields: ['config'] },
  { name: 'ingress_events', jsonFields: ['payload'] },
  { name: 'integration_delivery_failures', jsonFields: ['payload'] },
  { name: 'conversation_mappings', jsonFields: ['metadata'] },
  { name: 'baileys_stored_messages', jsonFields: [] },
  { name: 'lid_mappings', jsonFields: [] },
];

async function migrateTable(mongoDb: any, table: typeof tables[0]) {
  const { name: tableName, jsonFields } = table;
  const collection = mongoDb.collection(tableName);
  console.log(`Migrating table "${tableName}"...`);

  let offset = 0;
  const batchSize = 1000;
  let totalMigrated = 0;

  while (true) {
    const rows = await new Promise<any[]>((resolve, reject) => {
      db.all(`SELECT * FROM ${tableName} LIMIT ${batchSize} OFFSET ${offset}`, (err, rows) => {
        if (err) {
          if (err.message.includes('no such table')) {
            resolve([]);
          } else {
            reject(err);
          }
        } else {
          resolve(rows);
        }
      });
    });

    if (!rows || rows.length === 0) {
      break;
    }

    const docs = rows.map((row) => {
      const doc = { ...row };
      for (const field of jsonFields) {
        if (doc[field] && typeof doc[field] === 'string') {
          try {
            doc[field] = JSON.parse(doc[field]);
          } catch (e) {
            // Keep as string if parsing fails
          }
        }
      }
      return doc;
    });

    const operations = docs.map((doc) => {
      const filter: any = {};
      if (doc.id !== undefined) {
        filter.id = doc.id;
      } else if (doc.lid !== undefined) {
        filter.lid = doc.lid;
      } else {
        filter._id = doc._id;
      }

      return {
        updateOne: {
          filter,
          update: { $set: doc },
          upsert: true,
        },
      };
    });

    await collection.bulkWrite(operations);

    totalMigrated += rows.length;
    offset += batchSize;
  }

  console.log(`✓ Migrated ${totalMigrated} rows from "${tableName}".`);
}

async function main() {
  console.log('Starting data migration from SQLite to MongoDB...');
  console.log(`SQLite Database: ${sqlitePath}`);
  console.log(`MongoDB URI: ${mongoUri}`);

  const client = new MongoClient(mongoUri!);
  try {
    await client.connect();
    const mongoDb = client.db();
    console.log('Successfully connected to MongoDB.');

    for (const table of tables) {
      await migrateTable(mongoDb, table);
    }

    console.log('\nMigration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await client.close();
    db.close();
  }
}

void main();

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb+srv://biztekapps:kujdhs8743y6w78yhdiuasoyr@cluster0.t7is5t.mongodb.net/wa-whatsapp-manager';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();
    
    // Fix sessions
    const sessions = db.collection('sessions');
    const nullSessions = await sessions.find({ id: { $in: [null, undefined] } }).toArray();
    for (const doc of nullSessions) {
      await sessions.updateOne({ _id: doc._id }, { $set: { id: crypto.randomUUID() } });
      console.log(`Fixed session: ${doc.name || doc._id}`);
    }
    
    // Fix webhooks
    const webhooks = db.collection('webhooks');
    const nullWebhooks = await webhooks.find({ id: { $in: [null, undefined] } }).toArray();
    for (const doc of nullWebhooks) {
      await webhooks.updateOne({ _id: doc._id }, { $set: { id: crypto.randomUUID() } });
      console.log(`Fixed webhook: ${doc.url || doc._id}`);
    }
    
    console.log('Done fixing null IDs.');
  } finally {
    await client.close();
  }
}

run().catch(console.dir);

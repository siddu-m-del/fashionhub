require("dotenv").config({ quiet: true });

const { MongoClient } = require("mongodb");
const { seedProducts } = require("./server");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required. Copy .env.example to .env and configure MongoDB.");

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = process.env.MONGODB_DB_NAME
      ? client.db(process.env.MONGODB_DB_NAME)
      : client.db();
    const result = await seedProducts(db);
    if (result.inserted) {
      console.log(`Seeded ${result.inserted} products. MongoDB now contains ${result.total} products.`);
    } else {
      console.log(`Seed skipped: the products collection already contains ${result.total} products.`);
    }
  } catch (error) {
    throw new Error(`Could not seed MongoDB: ${error.message}`, { cause: error });
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

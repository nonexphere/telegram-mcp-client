import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(process.cwd(), 'db', 'bot.sqlite');

let dbInstance: Database | null = null;

export async function initDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  const dbDir = dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  try {
    const db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_configs (
        user_id INTEGER PRIMARY KEY,
        gemini_api_key TEXT, 
        prompt_system_settings TEXT, 
        general_settings TEXT 
      );

      CREATE TABLE IF NOT EXISTS mcp_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        config_json TEXT NOT NULL, 
        FOREIGN KEY (user_id) REFERENCES user_configs(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        message_index INTEGER NOT NULL, 
        role TEXT NOT NULL, 
        content_json TEXT NOT NULL, 
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, message_index) 
      );
    `);

    console.log('Database initialized successfully.');
    dbInstance = db;
    return db;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1); 
  }
}

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    return await initDb();
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
    console.log('Database connection closed.');
  }
}

typescript
import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = join(process.cwd(), 'db', 'bot.sqlite');

export function initDb(): Database {
  // Ensure db directory exists
  const dbDir = join(process.cwd(), 'db');
  require('fs').mkdirSync(dbDir, { recursive: true }); // Use sync for startup

  const db = new Database(DB_PATH, { verbose: console.log }); // verbose logs SQL queries

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_configs (
      user_id INTEGER PRIMARY KEY,
      gemini_api_key TEXT, -- Potentially encrypted
      prompt_system_settings TEXT, -- JSON string
      general_settings TEXT -- JSON string (e.g., google_search_enabled)
    );

    CREATE TABLE IF NOT EXISTS mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      config_json TEXT NOT NULL, -- JSON string of MCPConfig
      FOREIGN KEY (user_id) REFERENCES user_configs(user_id) ON DELETE CASCADE
    );

     -- Note: Conversation history structure might be more complex for efficiency
     -- Simple version:
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      message_index INTEGER NOT NULL, -- Order within the chat
      role TEXT NOT NULL, -- 'user' or 'model'
      content_json TEXT NOT NULL, -- JSON string of message content (text, parts, function calls/responses)
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, message_index) -- Ensure order is unique per chat
    );

  `);

  console.log('Database initialized.');
  return db;
}

// TODO: Add specific DB access functions in other modules (e.g., storage.ts, conversation.ts)
// This file only handles initialization and getting the DB instance.

// This module manages user conversation history using the database.

import type { Database } from 'sqlite';

interface ChatHistoryRow {
  role: string;
  content_json: string;
}

interface LastMessageRow {
  message_index: number;
}

export class ConversationManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getHistory(chatId: number): Promise<any[]> {
    try {
      const rows = await this.db.all<ChatHistoryRow[]>(
        'SELECT role, content_json FROM chat_history WHERE chat_id = ? ORDER BY message_index ASC',
        chatId,
      );
      return rows.map(row => ({
        role: row.role,
        parts: JSON.parse(row.content_json),
      }));
    } catch (error) {
      console.error(`Error loading chat history for chat ${chatId}:`, error);
      throw error;
    }
  }

  async addMessage(chatId: number, message: any): Promise<void> {
    try {
      const lastMessage = await this.db.get<LastMessageRow>(
        'SELECT message_index FROM chat_history WHERE chat_id = ? ORDER BY message_index DESC LIMIT 1',
        chatId,
      );
      const nextIndex = lastMessage ? lastMessage.message_index + 1 : 0;

      await this.db.run(
        'INSERT INTO chat_history (chat_id, message_index, role, content_json) VALUES (?, ?, ?, ?)',
        chatId,
        nextIndex,
        message.role,
        JSON.stringify(message.parts),
      );
    } catch (error) {
      console.error(`Error adding message to chat history for chat ${chatId}:`, error);
      throw error;
    }
  }

  async clearHistory(chatId: number): Promise<void> {
    try {
      await this.db.run('DELETE FROM chat_history WHERE chat_id = ?', chatId);
      console.log(`Cleared chat history for chat ${chatId}.`);
    } catch (error) {
      console.error(`Error clearing chat history for chat ${chatId}:`, error);
      throw error;
    }
  }
}

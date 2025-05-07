typescript
// This module manages user conversation history using the database.

import Database from 'better-sqlite3';
import { UserConfiguration } from './types'; // Import UserConfiguration type

export class ConversationManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    // DB initialization is done in src/db.ts
  }

  // Get conversation history for a specific chat
  async getHistory(chatId: number): Promise<any[]> {
    try {
      // Fetch messages ordered by index
      const rows = this.db.prepare('SELECT role, content_json FROM chat_history WHERE chat_id = ? ORDER BY message_index ASC').all(chatId);

      // Parse JSON content and reconstruct history format expected by Gemini
      return rows.map(row => ({
          role: row.role,
          parts: JSON.parse(row.content_json) // Assuming content_json stores the array of parts
      }));

    } catch (error) {
      console.error(`Error loading chat history for chat ${chatId}:`, error);
      throw error;
    }
  }

  // Add a message to conversation history for a specific chat
  async addMessage(chatId: number, message: any): Promise<void> {
    try {
      // Get the next message index for this chat
      const lastMessage = this.db.prepare('SELECT message_index FROM chat_history WHERE chat_id = ? ORDER BY message_index DESC LIMIT 1').get(chatId);
      const nextIndex = lastMessage ? lastMessage.message_index + 1 : 0;

      // Store the message
      this.db.prepare('INSERT INTO chat_history (chat_id, message_index, role, content_json) VALUES (?, ?, ?, ?)').run(
          chatId,
          nextIndex,
          message.role,
          JSON.stringify(message.parts) // Store parts as JSON string
      );

      // TODO: Implement history trimming based on token count or message count
      // This is crucial to avoid hitting Gemini token limits and for performance/storage
      // Trimming logic would involve deleting older messages from the DB.

    } catch (error) {
      console.error(`Error adding message to chat history for chat ${chatId}:`, error);
      throw error;
    }
  }

  // Clear conversation history for a specific chat
  async clearHistory(chatId: number): Promise<void> {
    try {
      this.db.prepare('DELETE FROM chat_history WHERE chat_id = ?').run(chatId);
      console.log(`Cleared chat history for chat ${chatId}.`);
    } catch (error) {
      console.error(`Error clearing chat history for chat ${chatId}:`, error);
      throw error;
    }
  }

    // --- User Configuration (Gemini Key, Prompt System, etc.) ---
    // These functions are now handled by McpConfigStorage, but accessed via the same DB instance
    // We keep the types here for clarity.

    // async getUserConfiguration(userId: number): Promise<UserConfiguration | null> {
    //     // This is now in McpConfigStorage
    // }

    // async saveUserConfiguration(config: UserConfiguration): Promise<void> {
    //      // This is now in McpConfigStorage
    // }

}

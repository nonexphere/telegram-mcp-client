/**
 * @file Manages user conversation history using the Prisma database client.
 */

import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * Handles reading, writing, and clearing conversation history for chats.
 * Uses Prisma for database interactions.
 */
export class ConversationManager {
  private db: PrismaClient;

  constructor(db: PrismaClient) {
    this.db = db;
  }

    /**
     * Retrieves the conversation history for a given chat ID, ordered by message index.
     * @param chatId - The ID of the chat.
     * @returns A promise resolving to an array of message objects (role, parts).
     */
    async getHistory(chatId: number): Promise<any[]> {
        try {
            const rows = await this.db.chatHistory.findMany({
                where: { chatId },
                orderBy: { messageIndex: 'asc' },
                select: { role: true, contentJson: true },
            });
            return rows.map((row) => {
                return {
                    role: row.role,
                    parts: JSON.parse(row.contentJson as string),
                };
            });
        } catch (error) {
            console.error(`Error loading chat history for chat ${chatId}:`, error);
            throw error;
        }
    }

    /**
     * Adds a new message to the conversation history for a given chat ID.
     * Automatically determines the next message index.
     * @param chatId - The ID of the chat.
     * @param message - The message object (containing role and parts).
     */
    async addMessage(chatId: number, message: any): Promise<void> {
        try {
            const lastMessage = await this.db.chatHistory.findFirst({
                where: { chatId },
                orderBy: { messageIndex: 'desc' },
                select: { messageIndex: true },
            });
            const nextIndex = lastMessage ? lastMessage.messageIndex + 1 : 0;

            await this.db.chatHistory.create({
                data: {
                    chatId,
                    messageIndex: nextIndex,
                    role: message.role,
                    contentJson: JSON.stringify(message.parts),
                },
            });
            console.log(`Added message to chat history for chat ${chatId}, index ${nextIndex}.`);
        } catch (error) {
            console.error(`Error adding message to chat history for chat ${chatId}:`, error);
            throw error;
        }
    }

    /**
     * Clears the entire conversation history for a given chat ID.
     * @param chatId - The ID of the chat to clear.
     */
    async clearHistory(chatId: number): Promise<void> {
        try {
            await this.db.chatHistory.deleteMany({ where: { chatId } });
            console.log(`Cleared chat history for chat ${chatId}.`);
        } catch (error) {
            console.error(`Error clearing chat history for chat ${chatId}:`, error);
            throw error;
        }
    }
}

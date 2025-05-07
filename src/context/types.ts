/**
 * @file Defines TypeScript interfaces for user configuration structures.
 */

/**
 * Settings related to the system prompt or instructions for Gemini.
 */
export interface PromptSystemSettings {
    systemInstruction?: string; // Gemini system instruction
    // Add other prompt-specific settings here
}

/**
 * General user settings, including Gemini model preferences, generation parameters,
 * safety settings, and feature flags.
 */
export interface GeneralUserSettings {
    geminiModel?: string; // Preferred Gemini model
    temperature?: number; // Gemini temperature
    maxOutputTokens?: number; // Gemini max output tokens
    safetySettings?: Array<{ // For Gemini safety settings
        category: string; // e.g., "HARM_CATEGORY_SEXUALLY_EXPLICIT"
        threshold: string; // e.g., "BLOCK_MEDIUM_AND_ABOVE"
    }>;
    googleSearchEnabled?: boolean; // Flag to enable Google Search tool if available
    // Add other general settings here
}

/**
 * Represents the complete configuration for a user, combining API keys,
 * prompt settings, and general settings.
 */
export interface UserConfiguration {
    userId: number;
    geminiApiKey?: string; // User's own Gemini API key (potentially encrypted)
    promptSystemSettings: PromptSystemSettings;
    generalSettings: GeneralUserSettings;
    // Note: MCP configs are stored separately but linked to the user_id in DB
}

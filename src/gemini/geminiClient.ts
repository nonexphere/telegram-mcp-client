/**
 * @file Client for interacting with the Google Gemini API.
 * Handles API key management (shared or per-user with encryption),
 * request construction, and response parsing.
 */
import {
    GoogleGenAI,
    FunctionDeclaration,
    SafetySetting,
    HarmCategory,
    GenerationConfig,
    Tool,
    Part,
    Content, // Import Content type
    GenerateContentResponse,
    GenerateContentParameters, // Import GenerateContentParameters type
    HarmBlockThreshold
} from '@google/genai/node';
import { UserConfiguration } from '../context/types.js'; // Import user config type
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;
// Controls whether encryption/decryption is attempted. Defaults to true.
const API_KEY_ENCRYPTION_ENABLED = process.env.API_KEY_ENCRYPTION_ENABLED !== 'false';

if (API_KEY_ENCRYPTION_ENABLED) {
    if (process.env.ENCRYPTION_KEY) {
        if (process.env.ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_KEY)) {
            ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        } else {
            console.error('ERROR: ENCRYPTION_KEY is set but not a 64-character hex string. API keys will not be securely decrypted.');
        }
    } else {
         console.warn('WARN: API_KEY_ENCRYPTION_ENABLED is true, but ENCRYPTION_KEY is not set. API keys will be stored in plaintext.');
    }
    if (process.env.ENCRYPTION_IV) {
        if (process.env.ENCRYPTION_IV.length === 32 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_IV)) {
            ENCRYPTION_IV = Buffer.from(process.env.ENCRYPTION_IV, 'hex');
        } else {
            console.error('ERROR: ENCRYPTION_IV is set but not a 32-character hex string. API keys will not be securely decrypted.');
        }
    } else {
        console.warn('WARN: API_KEY_ENCRYPTION_ENABLED is true, but ENCRYPTION_IV is not set. API keys will be stored in plaintext.');
    }
     if (!ENCRYPTION_KEY || !ENCRYPTION_IV) {
        console.warn('API Key encryption is enabled but keys are invalid/missing. Keys will be stored in plaintext.');
    } else {
        console.log('API Key encryption is enabled and keys are configured.');
    }
} else {
    console.log('API Key encryption is disabled. Keys will be stored in plaintext.');
}

/**
 * Decrypts text using AES-256-CBC if encryption is enabled and keys are valid.
 * Falls back to returning the original text if encryption is disabled, keys are missing,
 * or decryption fails (assuming the stored value might be plaintext).
 * @param encryptedText - The text to decrypt (expected to be hex encoded).
 * @returns The decrypted text or the original text on failure/disabled encryption.
 * @throws {Error} If encryption is enabled but decryption fails fundamentally (e.g., bad key/IV).
 */
function decrypt(encryptedText: string): string {
    if (!encryptedText) return encryptedText;

    // If encryption is disabled or keys are missing/invalid, return plaintext.
    if (!API_KEY_ENCRYPTION_ENABLED || !ENCRYPTION_KEY || !ENCRYPTION_IV) {
        // Encryption is disabled or keys are missing, assume plaintext.
        // Warning about plaintext storage is in McpConfigStorage.
        return encryptedText;
    }

    try {
        // A simple check to see if it might be hex. If not, assume plaintext.
        // This is not foolproof but helps avoid errors if a plaintext key was stored.
        if (!/^[0-9a-fA-F]+$/.test(encryptedText) || encryptedText.length < 32) { // Encrypted keys are usually longer
             console.warn("Stored API key doesn't look like hex, returning as plaintext.");
            return encryptedText; // Likely plaintext
        }
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, ENCRYPTION_IV);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        // If decryption fails when encryption is enabled and keys are present,
        // it indicates a real problem (corrupted data, wrong key/IV).
        console.error("Decryption failed! Check ENCRYPTION_KEY/IV and stored data integrity.", error);
        // Instead of returning potentially sensitive encrypted data, throw an error.
        // The caller (getGeminiInstance) should handle this.
        throw new Error(`Failed to decrypt API key. Ensure encryption settings are correct and the stored key is valid.`);
    }
}

/**
 * A client class to manage interactions with the Google Gemini API.
 * Supports both a shared API key and per-user API keys (stored encrypted).
 */
export class GeminiClient {
  private geminiShared?: GoogleGenAI; 
  private userGeminiInstances: Map<number, GoogleGenAI> = new Map(); // Cache for user-specific instances
  constructor(sharedApiKey?: string) {
    if (sharedApiKey) {
      this.geminiShared = new GoogleGenAI({ apiKey: sharedApiKey });
      console.log('GeminiClient initialized with a shared API key.');
    } else {
      console.log(
        'GeminiClient initialized without a shared API key. Per-user keys must be provided via UI.',
      );
    }
  }

  /**
   * Gets the appropriate GoogleGenAI instance for a given user configuration.
   * Uses the user's specific key if available (decrypting if necessary),
   * otherwise falls back to the shared key, or throws an error if no key is available.
   * Caches user-specific instances.
   * @param userConfig - The configuration for the specific user.
   * @returns The GoogleGenAI instance.
   * @throws {Error} If no API key can be determined or if decryption fails.
   */
  private getGeminiInstance(userConfig?: UserConfiguration | null): GoogleGenAI {
    const userId = userConfig?.userId;
    let apiKeyToUse: string | undefined = undefined;

    if (userConfig?.geminiApiKey) {
        try {
            const decryptedKey = decrypt(userConfig.geminiApiKey);
            apiKeyToUse = decryptedKey;
            console.log(`Using decrypted API key for user ${userId}`);
        } catch (decryptionError: any) {
            console.error(`Error decrypting API key for user ${userId}: ${decryptionError.message}`);
            if (this.geminiShared) {
                console.warn(`Falling back to shared API key for user ${userId} due to decryption error.`);
                return this.geminiShared;
            }
            throw new Error(`Could not use API key for user ${userId} due to decryption failure and no shared key available. Please check configuration.`);
        }
    } else if (this.geminiShared) {
        apiKeyToUse = (this.geminiShared as any)?.options?.apiKey; // Access internal options (may change)
        console.log(`Using shared API key for user ${userId ?? 'unknown'}`);
    }
    if (!apiKeyToUse) {
        throw new Error(
            `No Gemini API key available for user ${userId ?? 'unknown'}. Please configure your key in settings or provide a SHARED_GEMINI_API_KEY.`
        );
    }

    if (userConfig?.geminiApiKey && userId !== undefined && apiKeyToUse) { // Check if it was a user-specific key that was successfully processed
        const cachedInstance = this.userGeminiInstances.get(userId);
        if (!cachedInstance || (cachedInstance as any)?.options?.apiKey !== apiKeyToUse) {
            console.log(`Creating or updating Gemini instance for user ${userId}`);
            const newInstance = new GoogleGenAI({ apiKey: apiKeyToUse });
            this.userGeminiInstances.set(userId, newInstance);
            return newInstance;
        }
        return cachedInstance;
    } else if (this.geminiShared) {
        // If not a user-specific key, and a shared instance exists (apiKeyToUse would be from it)
        return this.geminiShared;
    } else {
         throw new Error("Could not determine Gemini instance.");
    }
  }


  /**
   * Generates content using the Gemini API.
   * Constructs the request based on conversation history, available tools,
   * multimodal parts for the current turn, and user-specific settings.
   * @param messages - The conversation history.
   * @param tools - Optional array of Gemini FunctionDeclarations representing available tools.
   * @param multimodalParts - Optional array of parts for the current user message (e.g., text, image, audio).
   * @param userConfig - Optional user-specific configuration (API key, model, temp, etc.).
   * @returns A promise resolving to an object containing optional functionCalls and/or text response.
   * @throws {Error} If getting the Gemini instance fails or the API call fails.
   */
  async generateContent(
    messages: Content[], // Use imported Content type
    tools?: FunctionDeclaration[], 
    userConfig?: UserConfiguration | null // Allow null
  ): Promise<{ functionCalls?: any[]; text?: string }> { 
    let geminiInstance: GoogleGenAI;
    try {
      geminiInstance = this.getGeminiInstance(userConfig); // This now handles errors better
    } catch (e) {
      console.error('Error getting Gemini instance:', e);
      throw e; 
    }

    // Determine the model name from user config or default.
    const modelName =
      userConfig?.generalSettings?.geminiModel || 'gemini-1.5-flash-latest'; // Use 1.5 as default?

    // Prepare the conversation history, potentially adding multimodal parts
    // to the last user message.
    const contents = [...messages]; // Shallow copy

    // Format tools for the Gemini API request.

    let safetySettings: SafetySetting[] | undefined = undefined;
    if (userConfig?.generalSettings?.safetySettings && Array.isArray(userConfig.generalSettings.safetySettings)) {
        safetySettings = userConfig.generalSettings.safetySettings
            .map(setting => ({
                category: setting.category as HarmCategory, // Cast, assuming valid strings from UI/DB
                threshold: setting.threshold as HarmBlockThreshold, // Cast
            }))
            .filter(setting => // Filter out potentially invalid enum values after casting
                Object.values(HarmCategory).includes(setting.category) &&
                Object.values(HarmBlockThreshold).includes(setting.threshold)
            );
         if (safetySettings.length === 0) safetySettings = undefined; // Set back to undefined if filtering removed all
    }

    // Prepare system instruction if provided.
    const systemInstruction = userConfig?.promptSystemSettings?.systemInstruction;
    const systemInstructionContent: Content | undefined = systemInstruction
        ? { role: 'system', parts: [{ text: systemInstruction }] }
        : undefined;

    const geminiTools: Tool[] | undefined = (tools && tools.length > 0)
        ? [{ functionDeclarations: tools }]
        : undefined;

    try {
      console.log(`Generating content with model: ${modelName}, tools: ${!!geminiTools}, system instruction: ${!!systemInstruction}, safety settings: ${safetySettings ? JSON.stringify(safetySettings) : 'default'}`);

      const params: GenerateContentParameters = {
        model: modelName, // Pass model name here
        contents: contents,
        temperature: userConfig?.generalSettings?.temperature ?? 0.7,
        maxOutputTokens: userConfig?.generalSettings?.maxOutputTokens,
        systemInstruction: systemInstructionContent,
        safetySettings: safetySettings,
        tools: geminiTools, // Correct placement for tools
      };

      const result: GenerateContentResponse = await geminiInstance.models.generateContent(params);
      const textResponse = result.text ? result.text() : undefined;
      const functionCallsFromResponse = result.functionCalls ? result.functionCalls() : undefined;

      return {
        functionCalls: functionCallsFromResponse && functionCallsFromResponse.length > 0 ? functionCallsFromResponse : undefined,
        text: textResponse,
      };
    } catch (error: any) {
      console.error('Error calling Gemini API:', error.message, error.stack);
        // Attempt to log response details if available
        if (error.response) {
           console.error("Gemini API Error Response Details:", JSON.stringify(error.response, null, 2));
        }
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }
}

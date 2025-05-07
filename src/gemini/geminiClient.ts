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
    HarmBlockThreshold,
    GenerationConfig,
    Tool,
} from '@google/genai/node';
import { UserConfiguration } from '../context/types.js'; // Import user config type
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;
// Controls whether encryption/decryption is attempted. Defaults to true.
const API_KEY_ENCRYPTION_ENABLED = process.env.API_KEY_ENCRYPTION_ENABLED !== 'false';

if (process.env.ENCRYPTION_KEY) {
    if (process.env.ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_KEY)) {
        ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    } else {
        console.error('ERROR: ENCRYPTION_KEY is set but not a 64-character hex string. API keys will not be securely decrypted.');
    }
}
if (process.env.ENCRYPTION_IV) {
    if (process.env.ENCRYPTION_IV.length === 32 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_IV)) {
        ENCRYPTION_IV = Buffer.from(process.env.ENCRYPTION_IV, 'hex');
    } else {
        console.error('ERROR: ENCRYPTION_IV is set but not a 32-character hex string. API keys will not be securely decrypted.');
    }
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

    // If encryption is disabled or keys are missing, return plaintext.
    if (!API_KEY_ENCRYPTION_ENABLED || !ENCRYPTION_KEY || !ENCRYPTION_IV) {
        if (!encryptedText) return encryptedText; // if text is null/undefined, return as is
        // Encryption is disabled or keys are missing, assume plaintext.
        // Warning about plaintext storage is in McpConfigStorage.
        return encryptedText;
    }

    try {
        // A simple check to see if it might be hex. If not, assume plaintext.
        // This is not foolproof but helps avoid errors if a plaintext key was stored.
        if (!/^[0-9a-fA-F]+$/.test(encryptedText) || encryptedText.length < 32) { // Encrypted keys are usually longer
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
  private userGeminiInstances: Map<number, GoogleGenAI> = new Map();

  /**
   * Initializes the GeminiClient.
   * @param sharedApiKey - An optional shared Gemini API key to use as a default.
   */
  constructor(sharedApiKey?: string) {
    if (sharedApiKey) {
      this.geminiShared = new GoogleGenAI({ apiKey: sharedApiKey });
      console.log('GeminiClient initialized with a shared API key.');
    } else {
      console.warn(
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
  private getGeminiInstance(userConfig?: UserConfiguration): GoogleGenAI {
    if (userConfig?.geminiApiKey) {
        let apiKey = userConfig.geminiApiKey;
        try {
          // Attempt decryption only if enabled and keys are available.
          if (API_KEY_ENCRYPTION_ENABLED && ENCRYPTION_KEY && ENCRYPTION_IV) {
            apiKey = decrypt(apiKey);
          } // If disabled or keys missing, apiKey is used as is (assumed plaintext).
        } catch (decryptionError: any) {
            // Handle decryption failure specifically.
            console.error(`Error decrypting API key for user ${userConfig.userId}: ${decryptionError.message}`);
            // Option 1: Fallback to shared key if available
            // if (this.geminiShared) {
            //     console.warn(`Falling back to shared API key for user ${userConfig.userId} due to decryption error.`);
            //     return this.geminiShared;
            // }
            // Option 2: Throw an error to prevent proceeding with a potentially compromised/unusable key.
            throw new Error(`Could not use API key for user ${userConfig.userId} due to decryption failure. Please check configuration.`);
        }

        if (!this.userGeminiInstances.has(userConfig.userId) || 
            (this.userGeminiInstances.get(userConfig.userId) as any)?.options?.apiKey !== apiKey) { // Check if key changed
            console.log(`Creating or updating Gemini instance for user ${userConfig.userId}`);
            this.userGeminiInstances.set(
                userConfig.userId,
                new GoogleGenAI({ apiKey }),
            );
        }
        return this.userGeminiInstances.get(userConfig.userId)!;
    } else if (this.geminiShared) {
      return this.geminiShared;
    } else {
      throw new Error(
        `No Gemini API key available. Please configure your key in settings or provide a SHARED_GEMINI_API_KEY. User ID: ${userConfig?.userId}`,
      );
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
    messages: any[], // History
    tools?: FunctionDeclaration[], 
    multimodalParts?: any[], // Current turn multimodal parts
    userConfig?: UserConfiguration // User-specific settings
  ): Promise<{ functionCalls?: any[]; text?: string }> { 
    try {
      geminiInstance = this.getGeminiInstance(userConfig);
    } catch (e) {
      console.error('Error getting Gemini instance:', e);
      throw e; 
    }

    // Determine the model name from user config or default.
    const modelName =
      userConfig?.generalSettings?.geminiModel || 'gemini-1.5-flash-latest'; 

    const model = geminiInstance.getGenerativeModel({ model: modelName });

    // Prepare the conversation history, potentially adding multimodal parts
    // to the last user message.
    const contents = [...messages];
    if (multimodalParts && multimodalParts.length > 0) {
      let lastUserMessageIndex = -1;
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i].role === 'user') {
          lastUserMessageIndex = i;
          break;
        }
      }

      if (lastUserMessageIndex !== -1) {
        if (!contents[lastUserMessageIndex].parts) {
          contents[lastUserMessageIndex].parts = [];
        }
        contents[lastUserMessageIndex].parts.push(...multimodalParts);
      } else {
        contents.push({ role: 'user', parts: multimodalParts });
      }
    }

    // Format tools for the Gemini API request.
    const geminiTools: Tool[] = [];
    if (tools && tools.length > 0) {
      geminiTools.push({
        functionDeclarations: tools,
      });
    }

    // Prepare generation configuration (temperature, max tokens).
    const generationConfig: GenerationConfig = {
      temperature: userConfig?.generalSettings?.temperature ?? 0.7,
    };
    if (userConfig?.generalSettings?.maxOutputTokens) {
        generationConfig.maxOutputTokens = userConfig.generalSettings.maxOutputTokens;
    }
    // Prepare safety settings if provided in user config.

    let safetySettings: SafetySetting[] | undefined = undefined;
    if (userConfig?.generalSettings?.safetySettings && Array.isArray(userConfig.generalSettings.safetySettings)) {
        safetySettings = userConfig.generalSettings.safetySettings.map(setting => ({
            category: setting.category as HarmCategory, // Cast, assuming valid strings from UI/DB
            threshold: setting.threshold as HarmBlockThreshold, // Cast
        }));
    }

    // Prepare system instruction if provided.
    const systemInstruction = userConfig?.promptSystemSettings?.systemInstruction;

    try {
      console.log(`Generating content with model: ${modelName}, tools: ${geminiTools.length > 0}, system instruction: ${!!systemInstruction}, safety settings: ${safetySettings ? JSON.stringify(safetySettings) : 'default'}`);

      // Make the API call to Gemini.
      const result = await model.generateContent({
        contents: contents,
        tools: geminiTools.length > 0 ? geminiTools : undefined,
        generationConfig: generationConfig,
        systemInstruction: systemInstruction
          ? { role: 'system', parts: [{ text: systemInstruction }] } 
          : undefined,
        safetySettings: safetySettings,
      });

      // Parse the response to extract function calls and/or text.
      const response = result.response;
      const functionCalls = response.candidates?.[0]?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall);
      const textResponse = response.text; 

      return {
        functionCalls: functionCalls,
        text: textResponse,
      };
    } catch (error: any) {
      console.error('Error calling Gemini API:', error.message, error.stack);
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }
}

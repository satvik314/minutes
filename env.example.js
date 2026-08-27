// Minutes — local configuration.
//
// 1. Copy this file to `env.js` (same folder).
// 2. Paste your Gemini API key from https://aistudio.google.com/apikey
//
// `env.js` is gitignored; your key never leaves this machine except in
// requests to generativelanguage.googleapis.com.

self.MINUTES_ENV = {
  GEMINI_API_KEY: "PASTE_YOUR_GEMINI_API_KEY_HERE",

  // Optional: override the live transcription model.
  MODEL: "gemini-3.5-transcribe-live",
};

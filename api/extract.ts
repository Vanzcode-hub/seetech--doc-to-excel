import type { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-001",
  "google/gemini-2.0-flash-lite-001",
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "'messages' array is required." });
  }

  const apiKey = (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) return res.status(500).json({ error: "API key not configured." });

  let lastError = "";
  for (const model of MODELS) {
    try {
      const response = await axios.post(OPENROUTER_URL, {
        model, messages, temperature: 0.1, max_tokens: 8192
      }, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": process.env.APP_URL || "https://your-app.vercel.app",
          "Content-Type": "application/json"
        },
        timeout: 55000
      });
      return res.json(response.data);
    } catch (err: any) {
      lastError = err.response?.data?.error?.message || err.message;
    }
  }
  return res.status(500).json({ error: `All models failed: ${lastError}` });
}

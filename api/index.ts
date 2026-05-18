/**
 * Vercel Serverless Entry Point
 * Wraps the Express app for Vercel deployment.
 * All /api/* requests are handled here.
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { generateAIResponse } from "../server/services/aiService.js";
import { processDocument } from "../server/pipeline/documentProcessor.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Use memory storage for Vercel (no persistent filesystem)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post("/api/extract", async (req: any, res: any) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid request: 'messages' is required." });
    }
    const result = await generateAIResponse(messages);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "AI extraction failed" });
  }
});

app.post("/api/upload", upload.single("file"), async (req: any, res: any) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    // Write buffer to /tmp (only writable dir on Vercel)
    const os = await import("os");
    const fs = await import("fs");
    const tmpPath = path.join(os.tmpdir(), `upload_${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    const result = await processDocument(tmpPath);

    // Cleanup
    try { fs.unlinkSync(tmpPath); } catch {}

    const detectedId = result?.detectedFormatId || "format-a";
    const response = result?.sheets
      ? {
          detectedFormatId: detectedId,
          sheets: result.sheets.map((s: any) => ({
            ...s,
            formatId: s.formatId || detectedId
          }))
        }
      : {
          detectedFormatId: detectedId,
          sheets: [{ name: "OCR_Extraction", rows: result?.rows || [], formatId: detectedId }]
        };

    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Processing failed" });
  }
});

app.get("/api/health", (_req: any, res: any) => {
  res.json({ status: "ok", platform: "vercel" });
});

export default app;

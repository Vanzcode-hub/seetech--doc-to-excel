/**
 * OpenRouter Vision Service
 * ──────────────────────────────────────────────────────────────────────────
 * Entry point for file-based extraction.
 * Handles PDF→image conversion, then delegates to the extractor router
 * which runs: detect format → route to isolated extractor → normalize output.
 */

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { processAllPages } from "../extractors/extractorRouter.ts";

const execAsync = promisify(exec);

/**
 * Convert a PDF to PNG images using Python/PyMuPDF.
 * Returns array of { base64, mimeType } per page.
 */
async function pdfToImages(filePath: string): Promise<{ base64: string; mimeType: string }[]> {
  const outputDir = path.join(path.dirname(filePath), `_pdf_pages_${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const scriptPath = path.join(process.cwd(), "pdf_to_images.py");
    const { stdout } = await execAsync(
      `python "${scriptPath}" "${filePath}" "${outputDir}"`,
      { timeout: 60000 }
    );

    const result = JSON.parse(stdout.trim());
    if (!result.success || !result.images?.length) {
      throw new Error(result.error || "PDF conversion returned no images");
    }

    const pages: { base64: string; mimeType: string }[] = [];
    for (const imgPath of result.images) {
      const buf = fs.readFileSync(imgPath);
      pages.push({ base64: buf.toString("base64"), mimeType: "image/png" });
      try { fs.unlinkSync(imgPath); } catch {}
    }
    return pages;
  } finally {
    try { fs.rmdirSync(outputDir); } catch {}
  }
}

/**
 * Main extraction entry point.
 * Accepts a file path (image or PDF), returns structured extraction result.
 */
export async function extractWithOpenRouter(filePath: string, _customPrompt?: string): Promise<any> {
  const apiKey = (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) {
    throw new Error("No OpenRouter API key found. Set OPENROUTER_API_KEY in .env");
  }

  const ext = path.extname(filePath).toLowerCase();
  const fileBuffer = fs.readFileSync(filePath);
  const isPDF = ext === ".pdf" || fileBuffer.slice(0, 4).toString() === "%PDF";

  let pages: { base64: string; mimeType: string }[];

  if (isPDF) {
    console.log(">>> [VISION] PDF detected — converting pages to images...");
    pages = await pdfToImages(filePath);
    console.log(`>>> [VISION] Converted ${pages.length} PDF page(s) to images.`);
  } else {
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    pages = [{ base64: fileBuffer.toString("base64"), mimeType }];
  }

  // Route through format detection → isolated extractors
  return processAllPages(pages, apiKey);
}

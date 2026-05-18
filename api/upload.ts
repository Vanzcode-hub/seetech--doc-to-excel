import type { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";
import formidable from "formidable";
import fs from "fs";

export const config = { api: { bodyParser: false } };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-001",
  "google/gemini-2.0-flash-lite-001",
];

const EXTRACTION_PROMPT = `You are an expert industrial audit document digitizer. Extract ALL tabular data from this document image with maximum accuracy.

STEP 1 — CLASSIFY the document format:
- format-a: Comprehensive Audit (motors/pumps/compressors — columns: Equipment Name, Rated Power KW, Phase R/Y/B, Measured Voltage, Measured Current, Measured kW, Measured PF)
- format-b: AHU Fan Audit (Air Handling Units — columns: AHU Fan, Design Flow CFM, Static Pressure MMWG, belt/direct driven)
- format-c: Equipment Nameplate (motor specs — columns: Equipment Name, Frame Size, Direct Mount/Pulley/Gear, VFD details)
- format-d: Pump/ETP Audit (pumps — columns: Pump Name, Design Flow m3/hr, Suction Pressure, Discharge Pressure, Throttling)

STEP 2 — EXTRACT every row and column:
- Use the EXACT column headers as they appear in the document
- Extract EVERY data row — do not skip any
- For Phase data (R, Y, B, Avg/Average), create 4 separate rows per equipment
- Preserve all numbers exactly (e.g., 415, 22.5, 1450, 0.85)
- If a cell is empty or unreadable, use "--"
- Do NOT invent or guess values

STEP 3 — Return ONLY this JSON (no markdown fences, no explanation):
{"detectedFormatId":"format-a","sheets":[{"name":"Audit_Page","grid":[["Sr. No.","Equipment Name","Phase (R/Y/B/Avg)","Measured Voltage (V)","Measured Current (A)","Measured Power (kW)","Measured PF"],["1","Main Pump","R","415","42","22","0.85"],["","","Y","412","41","21.5","0.84"],["","","B","418","43","22.5","0.86"],["","","Avg","415","42","22","0.85"]]}]}`;

function gridToRows(grid: string[][]): Record<string, string>[] {
  if (!grid || grid.length < 2) return [];
  const headers = grid[0];
  return grid.slice(1)
    .map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { if (h) obj[h] = (row[i] ?? "--").toString().trim(); });
      return obj;
    })
    .filter(obj => Object.values(obj).some(v => v !== "--" && v !== ""));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) return res.status(500).json({ error: "API key not configured on server." });

  // Parse multipart form
  const form = formidable({ maxFileSize: 50 * 1024 * 1024 });
  let filePath = "";
  let mimeType = "image/jpeg";

  try {
    await new Promise<void>((resolve, reject) => {
      form.parse(req, (err, _fields, files) => {
        if (err) return reject(err);
        const file = Array.isArray(files.file) ? files.file[0] : files.file;
        if (!file) return reject(new Error("No file uploaded"));
        filePath = file.filepath;
        mimeType = file.mimetype || "image/jpeg";
        resolve();
      });
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const base64 = fileBuffer.toString("base64");

    // For PDFs, use application/pdf mime type (Gemini supports it natively)
    const isPDF = fileBuffer.slice(0, 4).toString() === "%PDF";
    const sendMime = isPDF ? "application/pdf" : mimeType;

    let rawResult: any = null;
    let lastError = "";

    for (const model of MODELS) {
      try {
        const response = await axios.post(OPENROUTER_URL, {
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: EXTRACTION_PROMPT },
              { type: "image_url", image_url: { url: `data:${sendMime};base64,${base64}` } }
            ]
          }],
          temperature: 0.1,
          max_tokens: 8192
        }, {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": process.env.APP_URL || "https://your-app.vercel.app",
            "Content-Type": "application/json"
          },
          timeout: 55000
        });

        const content: string = response.data?.choices?.[0]?.message?.content || "";
        const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in response");

        rawResult = JSON.parse(jsonMatch[0]);
        if (!rawResult.sheets?.length) throw new Error("No sheets in response");
        break;
      } catch (err: any) {
        lastError = err.response?.data?.error?.message || err.message;
      }
    }

    if (!rawResult) {
      return res.status(500).json({ error: `Extraction failed: ${lastError}` });
    }

    // Convert grid[][] → rows[]
    const detectedId = rawResult.detectedFormatId || "format-a";
    const sheets = rawResult.sheets.map((s: any) => {
      if (s.rows) return { ...s, formatId: detectedId };
      const rows = gridToRows(s.grid || []);
      return { name: s.name, rows, formatId: detectedId };
    });

    return res.json({ detectedFormatId: detectedId, sheets });

  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

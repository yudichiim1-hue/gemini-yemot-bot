const express = require("express");
const axios = require("axios");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("edge-tts");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// יצירת תיקיית קובצי שמע אם אינה קיימת
const audioDir = path.join(__dirname, "audio");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir);
}

// הגשת קובצי שמע סטטיים עבור ימות המשיח
app.use("/audio", express.static(audioDir));

// זיכרון למניעת כפילויות והיסטוריה
const processedCalls = new Map();
const conversationHistory = new Map();

const RESET_TRIGGERS = [
  "תתחיל מחדש", "תתחילי מחדש", "אפס שיחה",
  "איפוס שיחה", "שיחה חדשה", "התחל מחדש",
  "תמחק היסטוריה", "ניקוי היסטוריה"
];

// --- 1. יצירת שמע ב-ElevenLabs ---
const generateElevenLabsTTS = async (text, filePath, apiKey) => {
  if (!apiKey) return false;
  try {
    // מזהה קול מומלץ בעברית (ניתן להחליף ב-Voice ID לפי בחירתך)
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; 
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await axios.post(
      url,
      {
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 10000
      }
    );

    await fs.promises.writeFile(filePath, Buffer.from(response.data));
    console.log("[TTS] נוצר בהצלחה באמצעות ElevenLabs!");
    return true;
  } catch (err) {
    console.warn(`[ElevenLabs Fallback] נכשל או שנגמרה המכסה: ${err.response?.status || err.message}`);
    return false;
  }
};

// --- 2. יצירת שמע ב-Edge TTS (גיבוי חינמי ללא הגבלה) ---
const generateEdgeTTS = async (text, filePath) => {
  try {
    const tts = new MsEdgeTTS();
    // קול זכר טבעי בעברית: he-IL-AvriNeural (או נקבה: he-IL-HilaNeural)
    await tts.setMetadata("he-IL-AvriNeural", OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const stream = tts.stream(text);
    const outStream = fs.createWriteStream(filePath);

    stream.pipe(outStream);

    return new Promise((resolve, reject) => {
      outStream.on("finish", () => {
        console.log("[TTS] נוצר בהצלחה באמצעות Edge TTS!");
        resolve(true);
      });
      outStream.on("error", (err) => {
        console.error("[Edge TTS Error]:", err);
        reject(false);
      });
    });
  } catch (err) {
    console.error("[Edge TTS Exception]:", err.message);
    return false;
  }
};

// --- 3. פונקציית TTS משולבת (ElevenLabs -> Edge TTS) ---
const createAudioResponse = async (text, callId, req) => {
  const filename = `speech_${callId || Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
  const filePath = path.join(audioDir, filename);
  const elevenKey = (process.env.ELEVENLABS_API_KEY || "").trim();

  // ניסיון ראשון: ElevenLabs
  let success = await generateElevenLabsTTS(text, filePath, elevenKey);

  // ניסיון שני: Edge TTS במידה ו-ElevenLabs נכשל או נגמרה המכסה
  if (!success) {
    console.log("[TTS] עובר לגיבוי Edge TTS...");
    success = await generateEdgeTTS(text, filePath);
  }

  if (success) {
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"] || process.env.RENDER_EXTERNAL_HOSTNAME;
    return `${protocol}://${host}/audio/${filename}`;
  }

  return null;
};

// פונקציית עזר לפורמט טקסט
const formatTextForYemot = (text) => {
  if (!text) return "";
  return text
    .replace(/[a-zA-Z]/g, "")
    .replace(/[\n\r\t]/g, " ")
    .replace(/[^א-ת0-9\s,.?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const callGeminiWithRetry = async (model, payload, geminiApiKey, maxRetries = 2) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await axios.post(geminiUrl, payload, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    } catch (err) {
      if (err.response?.status === 429 && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      } else {
        throw err;
      }
    }
  }
};

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const userPhone = params.ApiPhone || params.phone || "default_user";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    console.log("\n==========================================");
    console.log("--- קריאה חדשה התקבלה ---");
    console.log("Call ID:", callId);

    if (callId && processedCalls.has(callId)) {
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const groqApiKey = (process.env.GROQ_API_KEY || "").trim();
    const openRouterApiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    const geminiKeys = [
      (process.env.GEMINI_API_KEY || "").trim(),
      (process.env.GEMINI_API_KEY_1 || "").trim()
    ].filter(key => key.length > 0);

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 7000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          break;
        }
      } catch (err) {}
    }

    if (!audioBuffer) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-${formatTextForYemot("לא נמצאה הקלטה תקינה אנא הקלט שוב")}&go_to_folder=/1`);
    }

    let transcribedText = "";

    // תמלול ב-Groq
    if (groqApiKey) {
      try {
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        let formDataHeader = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhe\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nתמלל בעברית בלבד ובאותיות עבריות.\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
        const formDataFooter = `\r\n--${boundary}--\r\n`;

        const fullBuffer = Buffer.concat([
          Buffer.from(formDataHeader, "utf-8"),
          audioBuffer,
          Buffer.from(formDataFooter, "utf-8")
        ]);

        const transcriptionResponse = await axios.post(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          fullBuffer,
          { headers: { "Authorization": `Bearer ${groqApiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` }, timeout: 10000 }
        );
        transcribedText = transcriptionResponse.data?.text || "";
      } catch (err) {
        console.error("[Groq Error]:", err.message);
      }
    }

    // בדיקת איפוס שיחה
    if (RESET_TRIGGERS.some(trigger => transcribedText.trim().toLowerCase().includes(trigger))) {
      const existingSession = conversationHistory.get(userPhone);
      if (existingSession?.timer) clearTimeout(existingSession.timer);
      conversationHistory.delete(userPhone);

      res.set("Content-Type", "text/plain; charset=utf-8");
      const audioUrl = await createAudioResponse("השיחה אופסה בהצלחה במה אוכל לעזור", callId, req);
      return res.send(audioUrl ? `id_list_message=f-${audioUrl}&go_to_folder=/1` : `id_list_message=t-השיחה אופסה בהצלחה&go_to_folder=/1`);
    }

    let userSession = conversationHistory.get(userPhone) || { history: [], timer: null };
    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.timer = setTimeout(() => conversationHistory.delete(userPhone), 10 * 60 * 1000);

    let finalAnswerText = "";
    const systemInstruction = "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה בלבד, ללא רשימות, ללא מספרים, ללא נקודתיים, וללא אנגלית. עד 2 משפטים רציפים. התבסס על היסטוריית השיחה.";

    // מענה מ-OpenRouter
    if (openRouterApiKey && transcribedText.trim().length > 0) {
      try {
        const messagesPayload = [{ role: "system", content: systemInstruction }, ...userSession.history, { role: "user", content: transcribedText }];
        const openRouterCompletion = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model: "openrouter/free", messages: messagesPayload, temperature: 0.6 },
          { headers: { "Authorization": `Bearer ${openRouterApiKey}`, "Content-Type": "application/json" }, timeout: 10000 }
        );
        finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
      } catch (err) {}
    }

    // Fallback - Gemini
    if (!finalAnswerText && geminiKeys.length > 0) {
      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין, אענה בקצרה." }] }
      ];
      userSession.history.forEach(msg => geminiContents.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] }));

      if (transcribedText) {
        geminiContents.push({ role: "user", parts: [{ text: transcribedText }] });
      } else {
        geminiContents.push({ role: "user", parts: [{ text: "ענה בקצרה:" }, { inlineData: { mimeType: "audio/wav", data: audioBuffer.toString("base64") } }] });
      }

      keyLoop:
      for (const apiKey of geminiKeys) {
        for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
          try {
            const response = await callGeminiWithRetry(model, { contents: geminiContents }, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              break keyLoop;
            }
          } catch (err) {}
        }
      }
    }

    if (!finalAnswerText) throw new Error("אין תשובה מאיש ספק.");

    if (transcribedText) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: finalAnswerText });
      conversationHistory.set(userPhone, userSession);
    }

    // יצירת קובץ שמע והחזרת תשובה לימות המשיח
    const cleanAnswer = formatTextForYemot(finalAnswerText);
    const audioUrl = await createAudioResponse(cleanAnswer, callId, req);

    res.set("Content-Type", "text/plain; charset=utf-8");

    if (audioUrl) {
      console.log(`[Response] שולח נגן קובץ שמע: ${audioUrl}`);
      return res.send(`id_list_message=f-${audioUrl}&go_to_folder=/1`);
    } else {
      console.log("[Response] TTS נכשל, חוזר להקראה טקסטואלית.");
      return res.send(`id_list_message=t-${cleanAnswer}&go_to_folder=/1`);
    }

  } catch (error) {
    console.error("=== שגיאה במערכת ===", error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

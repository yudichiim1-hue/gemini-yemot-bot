const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// זיכרון מעקב קריאות למניעת כפילויות מקריאות חוזרות
const processedCalls = new Map();

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    console.log("--- התקבלה קריאה חדשה ---");
    console.log("Call ID:", callId);

    // טיפול בקריאה כפולה לאחר השמעה
    if (callId && processedCalls.has(callId)) {
      console.log(`קריאה חוזרת עבור ${callId}, מעביר להקלטה הבאה...`);
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/${secondaryFolder}`);
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const groqApiKey = process.env.GROQ_API_KEY;

    if (!geminiApiKey) {
      console.error("שגיאה: GEMINI_API_KEY אינו מוגדר ב-Render!");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-מפתח ה-API של גוגל אינו מוגדר&go_to_folder=/${secondaryFolder}`);
    }

    if (!groqApiKey) {
      console.error("שגיאה: GROQ_API_KEY אינו מוגדר ב-Render!");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-מפתח ה-API של Groq אינו מוגדר&go_to_folder=/${secondaryFolder}`);
    }

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);

    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    // הורדת השמע מימות המשיח
    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`הקובץ הורד בהצלחה מ-${cleanPath}! גודל: ${audioBuffer.length} bytes`);
          break;
        }
      } catch (err) {
        // התעלם מנתיבים שאינם קיימים
      }
    }

    if (!audioBuffer) {
      console.error("לא נמצאה הקלטה תקינה.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/${secondaryFolder}`);
    }

    // --- שלב 1: תמלול באמצעות Groq Whisper ---
    console.log("מתחיל תמלול שמע באמצעות Groq...");
    
    // בניית Multipart Form Data ידנית ללא ספריות חיצוניות נוספות
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    let formDataHeader = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`;
    formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhe\r\n`;
    formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
    const formDataFooter = `\r\n--${boundary}--\r\n`;

    const fullBuffer = Buffer.concat([
      Buffer.from(formDataHeader, "utf-8"),
      audioBuffer,
      Buffer.from(formDataFooter, "utf-8")
    ]);

    const groqResponse = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      fullBuffer,
      {
        headers: {
          "Authorization": `Bearer ${groqApiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`
        }
      }
    );

    const transcribedText = groqResponse.data?.text;
    console.log("טקסט מתומלל מ-Groq:", transcribedText);

    if (!transcribedText || transcribedText.trim().length === 0) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא הצלחתי להבין את ההקלטה אנא נסה שוב&go_to_folder=/${secondaryFolder}`);
    }

    // --- שלב 2: שליחת הטקסט הבלבד ל-Gemini ---
    console.log("שולח טקסט ל-Gemini...");

    const modelsToTry = [
      params.MODEL || "gemini-2.5-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash-8b",
      "gemini-1.5-flash"
    ];

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים רציפים). אל תשתמש באימוג'ים, מקפים או סימני פיסוק מיוחדים.\n\nהודעת המשתמש: "${transcribedText}"`
            }
          ]
        }
      ]
    };

    let responseData = null;

    for (const model of modelsToTry) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
        const response = await axios.post(geminiUrl, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: 10000
        });

        if (response.data) {
          responseData = response.data;
          break;
        }
      } catch (modelError) {
        console.warn(`המודל ${model} נכשל. עובר למודל הבא...`);
      }
    }

    if (!responseData) {
      throw new Error("כל דגמי Gemini עמוסים כרגע.");
    }

    const rawText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text || "לא התקבלה תשובה";
    
    // ניקוי יסודי של תווים שגורמים לבעיות ב-TTS
    const cleanText = rawText
      .replace(/[*_~`#\-–—]/g, " ")
      .replace(/["'\n\r&?=<>/()\\[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log("תשובת Gemini סופית:", cleanText);

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 120000);
    }

    const finalResponse = `id_list_message=t-${cleanText}&go_to_folder=/${secondaryFolder}`;

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(finalResponse);

  } catch (error) {
    console.error("שגיאה בכל תהליך העיבוד:", error.response?.data || error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const processedCalls = new Map();

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    console.log("\n==========================================");
    console.log("--- קריאה חדשה התקבלה ---");
    console.log("Call ID:", callId);

    if (callId && processedCalls.has(callId)) {
      console.log(`[Cache] קריאה כפולה זוהתה עבור ${callId}, מחזיר מעבר שקט.`);
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/${secondaryFolder}`);
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const groqApiKey = (process.env.GROQ_API_KEY || "").trim();
    const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();

    console.log("סטטוס מפתחות:");
    console.log("- GROQ_API_KEY קיים?", !!groqApiKey, groqApiKey ? `(מתחיל ב: ${groqApiKey.substring(0, 4)}...)` : "");
    console.log("- GEMINI_API_KEY קיים?", !!geminiApiKey);

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
        console.log("מנסה להוריד מנתיב:", cleanPath);
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 7000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`[הצלחה] הקובץ הורד בהצלחה! גודל: ${audioBuffer.length} bytes`);
          break;
        }
      } catch (err) {
        console.log(`[כישלון] לא נמצא קובץ בנתיב ${cleanPath}`);
      }
    }

    if (!audioBuffer) {
      console.error("[שגיאה קריטית] לא נמצאה הקלטה תקינה באף נתיב.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/${secondaryFolder}`);
    }

    let transcribedText = "";

    // --- 1. ניסיון תמלול ב-Groq ---
    if (groqApiKey) {
      try {
        console.log("[Groq] מתחיל תמלול שמע ב-Whisper...");
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

        const transcriptionResponse = await axios.post(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          fullBuffer,
          {
            headers: {
              "Authorization": `Bearer ${groqApiKey}`,
              "Content-Type": `multipart/form-data; boundary=${boundary}`
            },
            timeout: 10000
          }
        );

        transcribedText = transcriptionResponse.data?.text || "";
        console.log("[Groq] תמלול עבר בהצלחה:", transcribedText);
      } catch (err) {
        console.error("[Groq שגיאת תמלול]:", err.response?.status, err.response?.data || err.message);
      }
    }

    let finalAnswerText = "";

    // --- 2. ניסיון תשובה מ-Groq Llama ---
    if (groqApiKey && transcribedText.trim().length > 0) {
      try {
        console.log("[Groq] שולח שאלה ל-Llama 3.3...");
        const groqCompletion = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model: "llama-3.3-70b-versatile",
            messages: [
              {
                role: "system",
                content: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים רציפים). אל תשתמש באימוג'ים, מקפים או סימני פיסוק מיוחדים."
              },
              {
                role: "user",
                content: transcribedText
              }
            ],
            temperature: 0.6
          },
          {
            headers: {
              "Authorization": `Bearer ${groqApiKey}`,
              "Content-Type": "application/json"
            },
            timeout: 8000
          }
        );

        finalAnswerText = groqCompletion.data?.choices?.[0]?.message?.content || "";
        if (finalAnswerText) {
          console.log("[Groq] התקבלה תשובה מ-Llama!");
        }
      } catch (err) {
        console.error("[Groq שגיאת Llama]:", err.response?.status, err.response?.data || err.message);
      }
    }

    // --- 3. Fallback - Gemini ---
    if (!finalAnswerText && geminiApiKey) {
      console.log("[Gemini] מפעיל גיבוי מול גוגל...");
      const modelsToTry = ["gemini-2.5-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"];

      const payload = transcribedText
        ? { contents: [{ role: "user", parts: [{ text: `ענה בעברית קצרה: "${transcribedText}"` }] }] }
        : { contents: [{ role: "user", parts: [{ text: "ענה בעברית קצרה" }, { inlineData: { mimeType: "audio/wav", data: audioBuffer.toString("base64") } }] }] };

      for (const model of modelsToTry) {
        try {
          console.log(`[Gemini] מנסה דגם: ${model}...`);
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
          const response = await axios.post(geminiUrl, payload, { headers: { "Content-Type": "application/json" }, timeout: 10000 });

          if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            finalAnswerText = response.data.candidates[0].content.parts[0].text;
            console.log(`[Gemini] התקבלה תשובה מדגם ${model}!`);
            break;
          }
        } catch (err) {
          console.error(`[Gemini שגיאה בדגם ${model}]:`, err.response?.status, err.response?.data || err.message);
        }
      }
    }

    if (!finalAnswerText) {
      throw new Error("לא התקבלה תשובה מאיף ספק (Groq / Gemini).");
    }

    const cleanText = finalAnswerText
      .replace(/[*_~`#\-–—]/g, " ")
      .replace(/["'\n\r&?=<>/()\\[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log("תשובה סופית:", cleanText);

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 120000);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/${secondaryFolder}`);

  } catch (error) {
    console.error("=== שגיאה כוללת במערכת ===");
    console.error(error.stack || error.message);
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

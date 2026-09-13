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
    const groqApiKey = process.env.GROQ_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

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
        // התעלם מנתיבים שלא קיימים
      }
    }

    if (!audioBuffer) {
      console.error("לא נמצאה הקלטה תקינה.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/${secondaryFolder}`);
    }

    // --- שלב 1: תמלול באמצעות Groq Whisper ---
    let transcribedText = "";
    if (groqApiKey) {
      try {
        console.log("מתחיל תמלול שמע ב-Groq Whisper...");
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
        console.log("טקסט מתומלל מ-Groq:", transcribedText);
      } catch (transcriptionError) {
        console.warn("תמלול ב-Groq נכשל:", transcriptionError.message);
      }
    }

    let finalAnswerText = "";

    // --- שלב 2: ניסיון מענה דרך Groq (מגובה בתמלול) ---
    if (groqApiKey && transcribedText.trim().length > 0) {
      try {
        console.log("מנסה לקבל תשובה מ-Groq (Llama 3.3)...");
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
          console.log("תשובה התקבלה בהצלחה מ-Groq!");
        }
      } catch (groqError) {
        console.warn("Groq Llama נכשל או עמוס, עובר אוטומטית לגוגל Gemini...", groqError.message);
      }
    }

    // --- שלב 3: Fallback - אם Groq נכשל, עוברים לגוגל Gemini ---
    if (!finalAnswerText && geminiApiKey) {
      console.log("מפעיל Fallback: שולח לגוגל Gemini...");

      const modelsToTry = [
        params.MODEL || "gemini-2.5-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash-8b",
        "gemini-1.5-flash"
      ];

      // אם יש טקסט מתומלל שולחים טקסט, אחרת שולחים את השמע המקורי
      const payload = transcribedText
        ? {
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
          }
        : {
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים רציפים). אל תשתמש באימוג'ים, מקפים או סימני פיסוק מיוחדים."
                  },
                  {
                    inlineData: {
                      mimeType: "audio/wav",
                      data: audioBuffer.toString("base64")
                    }
                  }
                ]
              }
            ]
          };

      for (const model of modelsToTry) {
        try {
          console.log(`מנסה Gemini דגם: ${model}...`);
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
          const response = await axios.post(geminiUrl, payload, {
            headers: { "Content-Type": "application/json" },
            timeout: 10000
          });

          if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            finalAnswerText = response.data.candidates[0].content.parts[0].text;
            console.log(`תשובה התקבלה בהצלחה מ-Gemini (${model})!`);
            break;
          }
        } catch (modelError) {
          console.warn(`Gemini דגם ${model} נכשל, מנסה דגם הבא...`);
        }
      }
    }

    if (!finalAnswerText) {
      throw new Error("כל השרותים (Groq ו-Gemini) נכשלו או עמוסים.");
    }

    // ניקוי תווים מיוחדים עבור TTS של ימות המשיח
    const cleanText = finalAnswerText
      .replace(/[*_~`#\-–—]/g, " ")
      .replace(/["'\n\r&?=<>/()\\[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log("תשובה סופית לשליחה לימות:", cleanText);

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 120000);
    }

    const finalResponse = `id_list_message=t-${cleanText}&go_to_folder=/${secondaryFolder}`;

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(finalResponse);

  } catch (error) {
    console.error("שגיאה בעיבוד:", error.response?.data || error.message);
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

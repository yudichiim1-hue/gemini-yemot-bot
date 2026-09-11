const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// זיכרון זמני לשמירת התשובות עבור כל שיחה
const responses = {};

// נתיב 1: מקבל את ההקלטה משלוחה 1, מעבד ב-Gemini ומעביר לשלוחה 2
app.all("/process-audio", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("Audio request params:", params);

    const callId = params.ApiCallId;
    const voiceFileUrl = params.file || params.val_1 || params.ApiVoiceFile || params.path;

    if (!voiceFileUrl) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("go_to_folder=/2");
    }

    // הורדת השמע מההקלטה
    const audioResponse = await axios.get(voiceFileUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(audioResponse.data);

    // שליחה ל-Gemini
    const geminiResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: audioBuffer.toString("base64")
              }
            },
            {
              text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים או תתווים מיוחדים."
            }
          ]
        }
      ]
    });

    // שמירת התשובה בזיכרון לפי מזהה השיחה
    responses[callId] = geminiResponse.text.replace(/["'\n\r&]/g, " ");

    // העברה מיידית לשלוחה 2 להשמעה
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("go_to_folder=/2");

  } catch (error) {
    console.error("Error processing audio:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    responses[req.query.ApiCallId || req.body.ApiCallId] = "חלה שגיאה בעיבוד ההודעה";
    return res.send("go_to_folder=/2");
  }
});

// נתיב 2: שלוחה 2 פונה לכאן כדי לקבל ולהקריא את התשובה
app.all("/get-response", (req, res) => {
  const params = { ...req.query, ...req.body };
  const callId = params.ApiCallId;
  const replyText = responses[callId] || "לא התקבלה תשובה, אנא נסה שנית";

  // מוחקים את התשובה מהזיכרון לאחר השימוש
  delete responses[callId];

  res.set("Content-Type", "text/plain; charset=utf-8");
  // השמעת התשובה והעברה חזרה לשלוחה 1 להקלטה הבאה
  return res.send(`id_list_message=t-${replyText}&go_to_folder=/1`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

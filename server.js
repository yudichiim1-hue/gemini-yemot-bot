const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const responses = {};

app.all("/process-audio", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("Audio request params:", params);

    const callId = params.ApiCallId;
    const voiceFileUrl = params.val_1 || params.ApiVoiceFile || params.file || params.path;

    // הפעלת הקלטה קולית יציבה עם הגדרת שניות מדויקת (120 שניות מקסימום, 2 שניות שתיקה בסוף)
    if (!voiceFileUrl) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("read=t-שלום במה אוכל לעזור לך=val_1,voice,120,2,s,no,yes,no");
    }

    console.log("Processing audio file:", voiceFileUrl);

    const audioResponse = await axios.get(voiceFileUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(audioResponse.data);

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
              text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים או תווים מיוחדים."
            }
          ]
        }
      ]
    });

    responses[callId] = geminiResponse.text.replace(/["'\n\r&]/g, " ");

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("go_to_folder=/2");

  } catch (error) {
    console.error("Error processing audio:", error);
    const callId = req.query.ApiCallId || req.body.ApiCallId;
    responses[callId] = "חלה שגיאה בעיבוד ההודעה אנא נסה שנית";
    
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("go_to_folder=/2");
  }
});

app.all("/get-response", (req, res) => {
  const params = { ...req.query, ...req.body };
  const callId = params.ApiCallId;
  const replyText = responses[callId] || "לא התקבלה תשובה, אנא נסה שנית";

  delete responses[callId];

  res.set("Content-Type", "text/plain; charset=utf-8");
  return res.send(`id_list_message=t-${replyText}&go_to_folder=/1`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

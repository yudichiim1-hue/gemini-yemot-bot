const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.all("/", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("Incoming request params:", params);

    if (params.hangup === "yes") {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("");
    }

    // ימות המשיח מעבירה את נתיב הקובץ ב-val_1 כשמסיימים להקליט
    const voiceFileUrl = params.val_1 || params.ApiVoiceFile || params.ApiVoiceFileName;

    // כניסה ראשונית: השמעת הודעה + הקלטה קולית שמסתיימת זהה בשתיקה של 2 שניות
    if (!voiceFileUrl) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("read=t-שלום במה אוכל לעזור לך=val_1,voice,2,7,120,s,no,no,yes");
    }

    // הורדת קובץ הקול שבימות המשיח הקליטה
    const audioResponse = await axios.get(voiceFileUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(audioResponse.data);

    // שליחה ל-Gemini Flash 2.5
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

    const replyText = geminiResponse.text.replace(/["'\n\r&]/g, " ");

    res.set("Content-Type", "text/plain; charset=utf-8");
    // השמעת התשובה מ-Gemini ופתיחת מיקרופון מיידית לשאלה הבאה
    return res.send(`read=t-${replyText}=val_1,voice,2,7,120,s,no,no,yes`);

  } catch (error) {
    console.error("Error processing request:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("read=t-חלה שגיאה אנא נסה לומר זאת שוב=val_1,voice,2,7,120,s,no,no,yes");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

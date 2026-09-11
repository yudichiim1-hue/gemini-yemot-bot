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

    // ימות המשיח מעבירה את נתיב קובץ ההקלטה בפרמטר val_1
    const voiceFileUrl = params.val_1;

    // מקרה 1: כניסה ראשונית - הגדרת הקלטת קול (read)
    if (!voiceFileUrl) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      // הפורמט המדויק להפעלת רכיב ההקלטה הקולי של ימות המשיח
      return res.send("read_mode=record&read_max=120&read_time_out=3&id_list_message=t-שלום במה אוכל לעזור לך&val_name=val_1");
    }

    // מקרה 2: קבלת ההקלטה מהמשתמש ועיבודה
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
              text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים."
            }
          ]
        }
      ]
    });

    const replyText = geminiResponse.text.replace(/["'\n\r&]/g, " ");

    res.set("Content-Type", "text/plain; charset=utf-8");
    // השמעת תשובת Gemini ופתרון הקלטה נוספת לשאלה הבאה
    return res.send(`read_mode=record&read_max=120&read_time_out=3&id_list_message=t-${replyText}&val_name=val_1`);

  } catch (error) {
    console.error("Error processing request:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("read_mode=record&read_max=120&read_time_out=3&id_list_message=t-חלה שגיאה תקשורת אנא נסה שוב&val_name=val_1");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

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
    console.log("Received params:", params);

    // בדיקת הפרמטר של קובץ השמע מהקלטת המשתמש
    const voiceFileUrl = params.ApiVoiceFile || params.ApiVoiceFileName || params.voice_file_path;

    // 1. כניסה ראשונית - משמיע הודעה ומבקש מימות המשיח להקליט את המשתמש
    if (!voiceFileUrl) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      // id_list_message משמיע את ההודעה, וההגדרות הבאות מבצעות הקלטה עד שתיקה
      return res.send("id_list_message=t-שלום, במה אוכל לעזור לך?&read_mode=record&read_max=120&read_time_out=3");
    }

    // 2. הורדת קובץ הקלטת השמע מימות המשיח
    const audioResponse = await axios.get(voiceFileUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(audioResponse.data);

    // 3. שליחה ל-Gemini
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

    // 4. ניקוי הטקסט מהערות או תווים שבורים
    const replyText = geminiResponse.text.replace(/["'\n\r&]/g, " ");

    // 5. השמעת התשובה למשתמש ופתיחת הקלטה חדשה לשאלה הבאה
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${replyText}&read_mode=record&read_max=120&read_time_out=3`);

  } catch (error) {
    console.error("Error:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("id_list_message=t-חלה שגיאה, אנא נסה לומר זאת שוב.&read_mode=record&read_max=120&read_time_out=3");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.all("/process-audio", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("--- התקבלה קריאה חדשה ---");
    console.log("פרמטרים שהתקבלו:", params);

    const token = params.token || "WU1BUElL.apik_EaMppLHizXHkDRaJ16lEXg.TMjXFOQtCfDQyDtbePpTz2qHJrNuBwcqtTRKvTNNsbw";
    const questionsFolder = params.SHM || "2";
    const answersFolder = params.SHL || "1";

    // 1. הורדת הקובץ
    const filePath = `ivr2:/${questionsFolder}/last.wav`;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;
    console.log("מוריד את הקובץ מנתיב:", downloadUrl);

    let audioBuffer;
    try {
      const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
      audioBuffer = Buffer.from(audioResponse.data);
      console.log(`הקובץ הורד בהצלחה! גודל: ${audioBuffer.length} bytes`);
    } catch (dlError) {
      console.error("שגיאה בהורדת הקובץ מימות המשיח:", dlError.message);
      throw new Error("DownloadFailed");
    }

    // 2. פנייה ל-Gemini
    console.log("שולח את הקובץ ל-Gemini Flash 2.5...");
    let geminiResponse;
    try {
      geminiResponse = await ai.models.generateContent({
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
      console.log("תשובה התקבלה מ-Gemini בהצלחה!");
    } catch (aiError) {
      console.error("שגיאה בפנייה ל-Gemini:", aiError.message);
      throw new Error("GeminiFailed");
    }

    // 3. ניקוי הטקסט והחזרת התשובה
    const rawText = geminiResponse.text || "לא התקבלה תשובה מילולית";
    console.log("תוכן התשובה המקורי:", rawText);

    // ניקוי תווים מיוחדים שעלולים לשבור את ה-TTS של ימות המשיח
    const replyText = rawText.replace(/["'\n\r&?=<>/]/g, " ").trim();

    console.log("מחזיר לימות המשיח את הטקסט:", replyText);

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${replyText}&go_to_folder=/${questionsFolder}`);

  } catch (error) {
    console.error("שגיאה כוללת בטיפול בבקשה:", error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/2");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

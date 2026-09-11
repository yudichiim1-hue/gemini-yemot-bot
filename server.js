const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();

// מקבל שמע גולמי שנשלח בימות המשיח דרך api_000
app.use(express.raw({ type: "*/*", limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

app.all("/process-audio", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("--- התקבלה קריאה חדשה ---");
    console.log("פרמטרים:", params);

    const token = params.token || params.TOKEN;
    const questionsFolder = params.SHM || "2";
    const nextFolder = params.SHL || "1";
    const modelName = params.MODEL || "gemini-2.5-flash";
    const apiKey = process.env.GEMINI_API_KEY || params.API || params.KEY2;

    let audioBuffer = null;

    // 1. בדיקה אם השמע הגיע בלייב בגוף הבקשה (api_000)
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      console.log(`התקבל קובץ שמע בלייב בגודל: ${req.body.length} bytes`);
      audioBuffer = req.body;
    } 
    // 2. אם לא הגיע ב-Body, מנסים להוריד לפי ה-Token והשלוחה
    else if (token) {
      const filePath = `ivr2:/${questionsFolder}/last.wav`;
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;
      console.log("מוריד קובץ מנתיב:", downloadUrl);
      
      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
        audioBuffer = Buffer.from(audioResponse.data);
      } catch (dlError) {
        console.error("לא נמצא קובץ בנתיב:", dlError.message);
      }
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("NoAudioData");
    }

    // 3. פנייה ל-Gemini
    const ai = new GoogleGenAI({ apiKey: apiKey });
    console.log(`שולח ל-Gemini (${modelName})...`);

    const geminiResponse = await ai.models.generateContent({
      model: modelName,
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

    const rawText = geminiResponse.text || "לא התקבלה תשובה";
    const cleanText = rawText.replace(/["'\n\r&?=<>/]/g, " ").trim();
    console.log("תשובת Gemini:", cleanText);

    // 4. החזרת תשובה בפורמט ימות המשיח ומעבר לשלוחה הבאה
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/${nextFolder}`);

  } catch (error) {
    console.error("שגיאה בעיבוד:", error.message);
    const fallbackFolder = req.query.SHL || req.body.SHL || "2";
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/${fallbackFolder}`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

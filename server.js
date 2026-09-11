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
    console.log("Incoming params:", params);

    const token = params.token || "WU1BUElL.apik_EaMppLHizXHkDRaJ16lEXg.TMjXFOQtCfDQyDtbePpTz2qHJrNuBwcqtTRKvTNNsbw";
    const questionsFolder = params.SHM || "2"; // שלוחת השאלות (ברירת מחדל: 2)
    const answersFolder = params.SHL || "1";   // שלוחת התשובות (ברירת מחדל: 1)

    // הורדת קובץ ההקלטה שנשמר בשלוחת השאלות בשם last.wav
    const filePath = `ivr2:/${questionsFolder}/last.wav`;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;

    console.log("Downloading audio from:", downloadUrl);

    const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
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

    // הקראת התשובה וחזרה לשלוחת השאלות (שלוחה 2) להקלטה הבאה
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${replyText}&go_to_folder=/${questionsFolder}`);

  } catch (error) {
    console.error("Error processing request:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/2");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

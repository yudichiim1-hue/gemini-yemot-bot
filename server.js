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
    console.log("Incoming call params:", params);

    // איתור קובץ השמע שהוקלט בשלוחה 1
    const voiceFileUrl = params.file || params.val_1 || params.ApiVoiceFile || params.path || params.recording_url;

    if (!voiceFileUrl) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("id_list_message=t-לא התקבלה הקלטה אנא נסה שנית&go_to_folder=/1");
    }

    console.log("Processing voice file:", voiceFileUrl);

    // הורדת השמע ועיבוד ב-Gemini
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

    const replyText = geminiResponse.text.replace(/["'\n\r&]/g, " ");

    // השמעת התשובה והחזרה אוטומטית לשלוחה 1
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${replyText}&go_to_folder=/1`);

  } catch (error) {
    console.error("Error processing request:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/1");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

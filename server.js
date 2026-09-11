const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// פונקציית העיבוד הראשית
const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("--- התקבלה קריאה חדשה ---");
    console.log("פרמטרים:", params);

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const questionsFolder = params.SHM || "2";
    const nextFolder = params.SHL || "1";
    const modelName = params.MODEL || "gemini-2.5-flash";
    const apiKey = process.env.GEMINI_API_KEY || params.API || params.KEY2;

    // הורדת הקובץ last.wav משלוחת השאלות
    const filePath = `ivr2:/${questionsFolder}/last.wav`;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;
    console.log("מנסה להוריד קובץ מנתיב:", downloadUrl);

    let audioBuffer;
    try {
      const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
      audioBuffer = Buffer.from(audioResponse.data);
      console.log(`הקובץ הורד בהצלחה! גודל: ${audioBuffer.length} bytes`);
    } catch (dlError) {
      console.error("שגיאה בהורדת הקובץ:", dlError.message);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה&go_to_folder=/${nextFolder}`);
    }

    // פנייה ל-Gemini
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

    // החזרת התשובה בפורמט ימות המשיח
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/${nextFolder}`);

  } catch (error) {
    console.error("שגיאה כללית בעיבוד:", error.message);
    const fallbackFolder = req.query.SHL || req.body.SHL || "1";
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/${fallbackFolder}`);
  }
};

// תמיכה בנתיב הראשי וגם ב-/process-audio
app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

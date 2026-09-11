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

    const token = params.token || "WU1BUElL.apik_EaMppLHizXHkDRaJ16lEXg.TMjXFOQtCfDQyDtbePpTz2qHJrNuBwcqtTRKvTNNsbw";
    
    // ניסיון לחלץ את שם הקובץ/השיחה
    let fileName = params.val_1 || params.file || params.recorded_file || params.path;

    // אם ימות המשיח לא שלחה שם קובץ מפורש, השם של ההקלטה הוא ה-ApiCallId
    if (!fileName && params.ApiCallId) {
      fileName = `${params.ApiCallId}.wav`;
    }

    if (!fileName) {
      console.log("No file parameter or ApiCallId received.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("id_list_message=t-לא התקבל קובץ הקלטה אנא נסה שנית&go_to_folder=/1");
    }

    if (!fileName.endsWith(".wav")) {
      fileName += ".wav";
    }

    // הקובץ נשמר בתוך שלוחה 1 (ivr2:/1/filename.wav)
    const filePath = fileName.startsWith("ivr2:") ? fileName : `ivr2:/1/${fileName}`;
    const fileUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;

    console.log("Downloading recorded file from:", fileUrl);

    const audioResponse = await axios.get(fileUrl, { responseType: "arraybuffer" });
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
              text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים או תווים מיוחדים."
            }
          ]
        }
      ]
    });

    const replyText = geminiResponse.text.replace(/["'\n\r&]/g, " ");

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

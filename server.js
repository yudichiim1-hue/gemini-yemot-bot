const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("--- התקבלה קריאה חדשה ---");
    console.log("פרמטרים:", params);

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const primaryFolder = params.SHM || "2";
    const secondaryFolder = params.SHL || "1";
    const modelName = params.MODEL || "gemini-2.5-flash";
    const apiKey = process.env.GEMINI_API_KEY || params.API || params.KEY2;

    let audioBuffer = null;
    let downloadedPath = "";

    // רשימת נתיבים אפשריים לבדיקה
    const possiblePaths = [];
    
    // אם ימות המשיח שלחה נתיב ספציפי בפרמטר
    if (params.path || params.file) {
      possiblePaths.push(params.path || params.file);
    }
    
    // נתיבי ברירת מחדל לפי השלוחות
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);

    // ניסיון הורדה בלולאה מכל הנתיבים האפשריים
    for (const filePath of possiblePaths) {
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;
      console.log("מנסה להוריד קובץ מנתיב:", downloadUrl);

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          downloadedPath = filePath;
          console.log(`הקובץ הורד בהצלחה מ-${filePath}! גודל: ${audioBuffer.length} bytes`);
          break;
        }
      } catch (err) {
        console.log(`קובץ לא נמצא בנתיב: ${filePath}`);
      }
    }

    // אם לא נמצא קובץ באף נתיב
    if (!audioBuffer) {
      console.error("לא נמצאה הקלטה באף אחד מהנתיבים שנבדקו.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט את שאלתך ונסה שנית&go_to_folder=/${secondaryFolder}`);
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

    // החזרת תשובה קולית והעברת השיחה לשלוחה הבאה
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/${secondaryFolder}`);

  } catch (error) {
    console.error("שגיאה כללית בעיבוד:", error.message);
    const fallbackFolder = req.query.SHL || req.body.SHL || "1";
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/${fallbackFolder}`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

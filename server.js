const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("--- התקבלה קריאה חדשה ---");
    console.log("כל הפרמטרים מימות המשיח:", JSON.stringify(params, null, 2));

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const primaryFolder = params.SHM || "2";
    const secondaryFolder = params.SHL || "1";
    const modelName = params.MODEL || "gemini-1.5-flash"; // דגם נתמך ויציב
    const apiKey = process.env.GEMINI_API_KEY || params.API || params.KEY2;

    if (!apiKey) {
      console.error("שגיאה: לא הוגדר GEMINI_API_KEY");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-מפתח ה-API של ג'מיני חסר&go_to_folder=/${secondaryFolder}`);
    }

    let audioBuffer = null;
    const possiblePaths = [];

    // 1. זיהוי נתיב הקובץ שהועבר מימות המשיח
    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);
    if (params.filePath) possiblePaths.push(params.filePath);
    if (params.ApiPath) possiblePaths.push(params.ApiPath);
    if (params.ApiFile) possiblePaths.push(params.ApiFile);

    // 2. ברירות מחדל במידה ולא נשלח נתיב ישיר
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`/Transcription/last.wav`);

    // ניסיון הורדת השמע
    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;
      
      console.log("מנסה להוריד מנתיב:", cleanPath);

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`הקובץ הורד בהצלחה מ-${cleanPath}! גודל: ${audioBuffer.length} bytes`);
          break;
        }
      } catch (err) {
        console.log(`לא נמצא קובץ בנתיב: ${cleanPath}`);
      }
    }

    if (!audioBuffer) {
      console.error("לא נמצאה הקלטה באף נתיב שנבדק.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/${secondaryFolder}`);
    }

    // 3. חיבור מתוקן ל-Gemini דרך GoogleGenerativeAI
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    console.log(`שולח ל-Gemini (${modelName})...`);

    const result = await model.generateContent([
      "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים או תווים מיוחדים.",
      {
        inlineData: {
          mimeType: "audio/wav",
          data: audioBuffer.toString("base64")
        }
      }
    ]);

    const response = await result.response;
    const rawText = response.text() || "לא התקבלה תשובה";
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

const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// טיפול בבקשות שנכנסות (גם POST וגם GET, כולל קבצים מועלים)
app.all("/process-audio", upload.any(), async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("--- התקבלה קריאה חדשה מהמערכת ---");
    console.log("פרמטרים שהתקבלו:", params);

    // 1. חילוץ משתנים לפי המבנה המדויק של ext.ini
    const token = params.token || params.TOKEN;
    const questionsExt = params.SHM || "1";
    const nextExt = params.SHL || "2";
    const modelName = params.MODEL || "gemini-2.5-flash";
    
    // שימוש במפתח המוגדר ב-Render או במפתח שנשלח בפרמטר
    const apiKey = process.env.GEMINI_API_KEY || params.API || params.KEY2;

    let audioBuffer = null;

    // 2. בדיקה אם ימות המשיח שלחה את הקובץ ישירות ב-Upload (בזכות api_000)
    if (req.files && req.files.length > 0) {
      console.log("קובץ שמע התקבל ישירות ב-Upload!");
      audioBuffer = req.files[0].buffer;
    } else if (params.file || params.path) {
      // אם נשלח נתיב לקובץ, נוריד אותו ב-API של ימות המשיח
      const filePath = params.file || params.path;
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;
      console.log("מוריד את הקובץ מנתיב:", downloadUrl);
      const dlResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
      audioBuffer = Buffer.from(dlResponse.data);
    } else {
      // ברירת מחדל: הורדת הקובץ last.wav מהשלוחה הנוכחית
      const filePath = `ivr2:/${questionsExt}/last.wav`;
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${filePath}`;
      console.log("מוריד קובץ ברירת מחדל מנתיב:", downloadUrl);
      const dlResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
      audioBuffer = Buffer.from(dlResponse.data);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("לא התקבל או הורד קובץ שמע תקין");
    }

    // 3. אתחול Gemini ושליחת קובץ השמע
    const ai = new GoogleGenAI({ apiKey: apiKey });

    console.log(`שולח למודל ${modelName}...`);
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
    console.log("תשובת ג'מיני המקורית:", rawText);

    // ניקוי תווים מיוחדים שעלולים להפריע לקריינות בימות המשיח
    const cleanText = rawText.replace(/["'\n\r&?=<>/]/g, " ").trim();

    // 4. החזרת תשובה בפורמט המדויק של ימות המשיח + מעבר לשלוחה הבאה
    res.set("Content-Type", "text/plain; charset=utf-8");
    const responseString = `id_list_message=t-${cleanText}&go_to_folder=/${nextExt}`;
    console.log("שולח בחזרה לימות המשיח:", responseString);
    
    return res.send(responseString);

  } catch (error) {
    console.error("שגיאה בעיבוד הבקשה:", error.message);
    const fallbackExt = req.query.SHL || req.body.SHL || "2";
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/${fallbackExt}`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

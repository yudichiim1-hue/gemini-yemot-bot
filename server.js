const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// זיכרון היסטוריית שיחה לפי ApiCallId
const conversationHistory = new Map();
// זיכרון מעקב קריאות כפולות מיידיות
const processedCalls = new Map();

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    console.log("--- התקבלה קריאה חדשה ---");
    console.log("Call ID:", callId);

    // מניעת כפילויות של ימות המשיח מיד לאחר השמעה
    if (callId && processedCalls.has(callId)) {
      console.log(`קריאה חוזרת עבור ${callId} לאחר השמעה. מעביר להקלטה הבאה...`);
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/${secondaryFolder}`);
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("שגיאה: GEMINI_API_KEY אינו מוגדר ב-Render!");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-מפתח ה-API אינו מוגדר בשרת&go_to_folder=/${secondaryFolder}`);
    }

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);

    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    // הורדת השמע מימות המשיח
    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`הקובץ הורד בהצלחה מ-${cleanPath}! גודל: ${audioBuffer.length} bytes`);
          break;
        }
      } catch (err) {
        // לא נמצא בנתיב הנוכחי
      }
    }

    if (!audioBuffer) {
      console.error("לא נמצאה הקלטה באף נתיב שנבדק.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/${secondaryFolder}`);
    }

    // טעינת היסטוריית השיחה הקיימת עבור השיחה הזו (או יצירת חדשה)
    let history = [];
    if (callId && conversationHistory.has(callId)) {
      history = conversationHistory.get(callId);
    }

    // הוספת הודעת הדיבור החדשה של המשתמש להיסטוריה
    const currentAudioPart = {
      inlineData: {
        mimeType: "audio/wav",
        data: audioBuffer.toString("base64")
      }
    };

    const userTurn = {
      role: "user",
      parts: [
        { text: "ענה בקצרה (עד 2 משפטים), בעברית פשוטה, ללא תווים מיוחדים או סוגריים." },
        currentAudioPart
      ]
    };

    // בניית מערך ה-contents המלא כולל הזיכרון
    const contentsPayload = [...history, userTurn];

    const modelsToTry = [
      params.MODEL || "gemini-2.5-flash",
      "gemini-1.5-flash",
      "gemini-2.0-flash"
    ];

    let responseData = null;
    let usedModel = "";

    for (const model of modelsToTry) {
      try {
        console.log(`שולח ל-Gemini (${model}) עם היסטוריה של ${history.length} הודעות...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const response = await axios.post(
          geminiUrl,
          {
            contents: contentsPayload,
            systemInstruction: {
              parts: [{ text: "אתה עוזר קולי בשיחת טלפון. זכור את הֶקְשֵׁר השיחה הקודם וענה ברצף טבעי." }]
            }
          },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 15000
          }
        );

        if (response.data) {
          responseData = response.data;
          usedModel = model;
          break;
        }
      } catch (modelError) {
        console.warn(`המודל ${model} נכשל/עמוס. מנסה מודל הבא...`);
      }
    }

    if (!responseData) {
      throw new Error("כל המודלים עמוסים כרגע.");
    }

    const rawText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text || "לא התקבלה תשובה";
    
    // ניקוי תווים בעייתיים להקראה קולית
    const cleanText = rawText
      .replace(/[*_~`#\-–—]/g, " ")
      .replace(/["'\n\r&?=<>/()\\[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log(`תשובת Gemini (${usedModel}):`, cleanText);

    // שמירת התשובה של Gemini בזיכרון השיחה
    if (callId) {
      // מוסיפים את תור המשתמש (מקוצר) ואת תשובת הבוט להיסטוריה
      history.push({
        role: "user",
        parts: [{ text: "[הודעת שמע מוקלטת מהמשתמש]" }]
      });
      history.push({
        role: "model",
        parts: [{ text: cleanText }]
      });

      // שמירה במטמון ועדכון תוקף (מחיקה אוטומטית לאחר 10 דקות של חוסר פעילות)
      conversationHistory.set(callId, history);
      processedCalls.set(callId, true);

      setTimeout(() => {
        conversationHistory.delete(callId);
        processedCalls.delete(callId);
      }, 600000);
    }

    const finalResponse = `id_list_message=t-${cleanText}&go_to_folder=/${secondaryFolder}`;

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(finalResponse);

  } catch (error) {
    console.error("שגיאה בעיבוד מול Gemini:", error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
